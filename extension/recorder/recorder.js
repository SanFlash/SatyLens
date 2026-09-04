// extension/recorder/recorder.js
// Runs in a full extension tab (recorder.html), NOT the popup — MediaRecorder
// and getDisplayMedia's native picker both require a persistent document
// context, and selecting a screen/window steals focus, which would close
// a popup immediately.

import { CaptureStore } from '../shared/storage.js';
import { copyTextToClipboard } from '../shared/clipboard.js';
import { createShareLink } from '../shared/share.js';
import { track } from '../shared/analytics.js';
import {
  timestampForFilename,
  formatBytes,
  formatDuration,
  generateVideoThumbnail
} from '../shared/utils.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'screen'; // 'tab' | 'screen' | 'window' | 'area'
const sourceTabId = params.get('tabId');
const areaRect = mode === 'area'
  ? {
      x: parseFloat(params.get('rx')) || 0,
      y: parseFloat(params.get('ry')) || 0,
      w: parseFloat(params.get('rw')) || 0,
      h: parseFloat(params.get('rh')) || 0,
      dpr: parseFloat(params.get('dpr')) || 1
    }
  : null;

const STATE = {
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  PAUSED: 'PAUSED',
  STOPPING: 'STOPPING',
  COMPLETE: 'COMPLETE',
  ERROR: 'ERROR'
};

let state = STATE.IDLE;
let mediaRecorder = null;
let recordedChunks = [];
let combinedStream = null;
let displayStream = null;
let micStream = null;
let audioContext = null;
let timerInterval = null;
let startedAt = 0;
let elapsedBeforePause = 0;
let resultBlob = null;
let resultUrl = null;
let currentCaptureId = null;
let areaCropCleanup = null; // stops the hidden <video> + draw loop used for cropping in 'area' mode
let micMuteGain = null; // GainNode controlling whether the mic is actually audible in the recording

const MODE_LABELS = {
  tab: 'Recording the current tab. Audio and video are captured directly from this tab.',
  screen: 'Choose "Entire Screen" in the picker to record your whole display.',
  window: 'Choose a specific window or tab in the picker that opens next.',
  area: 'Recording just the region you selected on this tab.'
};

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.style.borderColor = isError ? '#5b2530' : '#2c3b5f';
  toast.style.color = isError ? '#ffb4b4' : '#e8ecf6';
  toast.classList.remove('cf-hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('cf-hidden'), 3200);
}

function setView(view) {
  $('#viewSetup').classList.toggle('cf-hidden', view !== 'setup');
  $('#viewRecording').classList.toggle('cf-hidden', view !== 'recording');
  $('#viewDone').classList.toggle('cf-hidden', view !== 'done');
}

/* ------------------------------ Stream acquisition ------------------------------ */

async function getVideoStream() {
  if (mode === 'tab' || mode === 'area') {
    if (!sourceTabId) throw new Error('No source tab was specified for recording.');

    // consumerTabId tells Chrome explicitly which tab will call
    // getUserMedia() with the returned stream ID. It's technically
    // optional when both calls happen in the same page (which they do
    // here), but Chrome's own official examples always set it, and
    // leaving it out relies on same-render-process heuristics that can
    // behave inconsistently across Chrome versions -- audio capture in
    // particular is documented as more restrictive than video. Being
    // explicit here removes that ambiguity entirely.
    const currentTab = await new Promise((resolve) => {
      if (chrome.tabs && chrome.tabs.getCurrent) chrome.tabs.getCurrent((tab) => resolve(tab));
      else resolve(null);
    });

    const streamId = await new Promise((resolve, reject) => {
      const opts = { targetTabId: Number(sourceTabId) };
      if (currentTab && currentTab.id != null) opts.consumerTabId = currentTab.id;
      chrome.tabCapture.getMediaStreamId(opts, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });
    const wantAudio = $('#audioToggle').checked;
    const tabStream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      audio: wantAudio
        ? {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId
            }
          }
        : false
    });

    if (mode === 'tab') return tabStream;
    return buildCroppedAreaStream(tabStream);
  }

  // 'screen' or 'window' — Chrome's native picker lets the user choose
  // Entire Screen / Window / Chrome Tab regardless of the hint below.
  //
  // Audio constraints are deliberately explicit rather than a bare
  // `true` -- echoCancellation/noiseSuppression/autoGainControl are
  // speech-processing features meant for a *microphone*. Applied to
  // system/desktop audio (music, video, notification sounds) they can
  // measurably degrade it or, on some Chrome versions, effectively mute
  // quieter audio entirely. This was very likely a real contributor to
  // "system audio doesn't get captured."
  return navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: mode === 'window' ? 'window' : 'monitor' },
    audio: $('#audioToggle').checked
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : false
  });
}

let localAudioPlaybackContext = null; // keeps captured audio audible through speakers during recording

async function restoreLocalAudioPlayback(stream) {
  try {
    localAudioPlaybackContext = new AudioContext();
    // The several `await`s between the button click that started this
    // (getMediaStreamId, getUserMedia, ...) can push AudioContext
    // creation outside the window Chrome still considers "a recent user
    // gesture," which starts it suspended -- silent output with no error.
    // Resuming explicitly closes that gap regardless of timing.
    await localAudioPlaybackContext.resume().catch(() => {});
    const source = localAudioPlaybackContext.createMediaStreamSource(
      new MediaStream(stream.getAudioTracks())
    );
    source.connect(localAudioPlaybackContext.destination);
  } catch (err) {
    console.warn('Could not restore live audio playback during recording (the recording itself is unaffected):', err);
  }
}

/**
 * Recording a specific region of a tab isn't something chrome.tabCapture
 * or MediaRecorder support directly -- there's no "capture just this
 * rectangle" API. Instead: play the full-tab capture into a hidden
 * <video>, continuously draw only the selected rectangle out of each
 * frame onto a correctly-sized <canvas>, and record THAT canvas's own
 * captureStream(). The tab's audio track (if requested) is passed
 * through unchanged alongside the cropped video track.
 */
async function buildCroppedAreaStream(tabStream) {
  const sourceVideo = document.createElement('video');
  sourceVideo.muted = true;
  sourceVideo.srcObject = tabStream;
  await sourceVideo.play();
  await new Promise((resolve) => {
    if (sourceVideo.videoWidth > 0) resolve();
    else sourceVideo.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });

  const cropWidth = Math.max(2, Math.round(areaRect.w * areaRect.dpr));
  const cropHeight = Math.max(2, Math.round(areaRect.h * areaRect.dpr));
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropWidth;
  cropCanvas.height = cropHeight;
  const cropCtx = cropCanvas.getContext('2d', { alpha: false });

  const sx = Math.round(areaRect.x * areaRect.dpr);
  const sy = Math.round(areaRect.y * areaRect.dpr);

  let rafId = null;
  const drawFrame = () => {
    try {
      cropCtx.drawImage(sourceVideo, sx, sy, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    } catch (_) {
      /* a frame drawn before the video is fully ready — harmless, next frame recovers */
    }
    rafId = requestAnimationFrame(drawFrame);
  };
  drawFrame();

  const originalVideoTrack = tabStream.getVideoTracks()[0];
  if (originalVideoTrack) {
    originalVideoTrack.addEventListener('ended', () => {
      // The source tab was closed/navigated away — stop the recording
      // the same way Chrome's own "Stop sharing" bar does for screen/window modes.
      if (state === STATE.RECORDING || state === STATE.PAUSED) stopRecording();
    });
  }

  areaCropCleanup = () => {
    if (rafId) cancelAnimationFrame(rafId);
    sourceVideo.pause();
    sourceVideo.srcObject = null;
    tabStream.getTracks().forEach((t) => t.stop());
  };

  const croppedVideoStream = cropCanvas.captureStream(30);
  const audioTracks = tabStream.getAudioTracks();
  return new MediaStream([...croppedVideoStream.getVideoTracks(), ...audioTracks]);
}

async function buildCombinedStream() {
  displayStream = await getVideoStream();

  // getDisplayMedia's `audio: {...}` constraint only ever *requests*
  // audio -- Chrome's own native share dialog has a separate "Share
  // system audio" / "Share tab audio" checkbox the user must also tick,
  // and on some platforms (notably: sharing a specific Window, not the
  // whole screen, and macOS entirely) Chrome cannot provide system audio
  // at all, no matter what's requested here or checked in the dialog.
  // Silently continuing with a video-only stream when the user explicitly
  // asked for system audio is exactly the "audio isn't captured" bug
  // report with no explanation -- surface it clearly instead.
  const wantSystemAudio = $('#audioToggle').checked;
  const gotSystemAudio = displayStream.getAudioTracks().length > 0;
  if (wantSystemAudio && !gotSystemAudio) {
    const message =
      mode === 'tab' || mode === 'area'
        ? 'This tab\'s audio wasn\'t included (it may not have been playing any sound, or tab audio capture was blocked). Continuing with video only unless you also enable the microphone.'
        : 'System audio wasn\'t included. Chrome only supports this when sharing "Entire Screen" (not a specific Window) and only if you also tick "Share audio" in Chrome\'s own picker. On macOS, Chrome cannot capture system audio at all — that\'s an OS limitation, not something this extension can work around.';
    showToast(message, true);
  }

  // Applies to every mode (Tab/Screen/Window/Area), not just tab-based
  // capture -- chrome.tabCapture explicitly stops a tab's own audio
  // playback for as long as it's being captured (documented behavior),
  // and reconnecting it here removes any doubt about the others too
  // instead of relying on each mode's underlying API to behave the same
  // way by default. Without this, the recording can be completely
  // correct while the user hears nothing and reasonably assumes it isn't
  // working -- being able to hear what's actually being recorded, live,
  // is also how you'd notice a real capture problem instead of finding
  // out only after the fact.
  if (wantSystemAudio && gotSystemAudio) {
    await restoreLocalAudioPlayback(displayStream);
  }

  const wantMic = $('#micToggle').checked;
  let micTrack = null;

  if (wantMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      micTrack = micStream.getAudioTracks()[0];
    } catch (err) {
      console.warn('Microphone permission denied:', err);
      showToast('Microphone access was denied. Recording will continue without microphone audio.', true);
    }
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  const displayAudioTrack = displayStream.getAudioTracks()[0];

  if (!micTrack) {
    // No mic requested/available — use the display stream as-is (video + optional system audio).
    combinedStream = displayStream;
    return;
  }

  // Mix mic audio with display/system audio (if any) into a single track
  // using Web Audio, since MediaRecorder records exactly one audio track.
  audioContext = new AudioContext();
  // Some browsers create a new AudioContext in a "suspended" state until
  // an explicit resume() — without this, the mixed track can be silent
  // even though everything else here is wired up correctly.
  await audioContext.resume().catch(() => {});
  const destination = audioContext.createMediaStreamDestination();

  // A limiter, not just a fixed gain cut, sits between the summed sources
  // and the destination. Two simultaneously loud sources (a video playing
  // system audio while you're also talking) can each be near full scale;
  // Web Audio sums connected sources with no automatic headroom
  // management, so without this the mixed track can clip audibly. Unlike
  // a static gain reduction (which either clips on loud content or
  // needlessly quiets normal content), a limiter only engages when the
  // signal actually approaches full scale.
  const limiter = audioContext.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.1;
  limiter.connect(destination);

  const micGain = audioContext.createGain();
  micGain.gain.value = 0.9;
  // A dedicated mute gain node, separate from the anti-clipping gain
  // above -- this is what "Mute My Mic" actually controls. Relying on
  // MediaStreamTrack.enabled to silence audio flowing through a
  // MediaStreamAudioSourceNode turned out not to be reliable in testing
  // (confirmed by directly measuring the mixed signal's energy before
  // and after muting -- it did not reliably drop). Setting an explicit
  // GainNode's value to 0 controls the actual signal amplitude directly,
  // which is unambiguous and doesn't depend on how a given browser
  // propagates track-level enabled/disabled state into an audio graph.
  micMuteGain = audioContext.createGain();
  micMuteGain.gain.value = 1;
  const micSource = audioContext.createMediaStreamSource(new MediaStream([micTrack]));
  micSource.connect(micGain).connect(micMuteGain).connect(limiter);

  if (displayAudioTrack) {
    const sysGain = audioContext.createGain();
    sysGain.gain.value = 0.9;
    const sysSource = audioContext.createMediaStreamSource(new MediaStream([displayAudioTrack]));
    sysSource.connect(sysGain).connect(limiter);
  }

  combinedStream = new MediaStream([videoTrack, ...destination.stream.getAudioTracks()]);
}

function pickSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  throw new Error('No supported video recording format is available in this browser.');
}

/* ------------------------------ Recording lifecycle ------------------------------ */

async function startRecording() {
  hideError();
  try {
    await buildCombinedStream();
  } catch (err) {
    console.error(err);
    showError(describeStreamError(err));
    track('SCREEN_RECORDING_STARTED', { feature: 'recording', action: mode, success: false, error: err.message });
    return;
  }

  // If the user stops sharing from Chrome's own "Stop sharing" bar, treat
  // that exactly like clicking our Stop button.
  displayStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (state === STATE.RECORDING || state === STATE.PAUSED) stopRecording();
  });

  const mimeType = pickSupportedMimeType();
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(combinedStream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = onRecordingStopped;
  mediaRecorder.onerror = (e) => {
    console.error('MediaRecorder error:', e.error);
    showError('Recording failed: ' + (e.error ? e.error.message : 'unknown error'));
    cleanupStreams();
    state = STATE.ERROR;
  };

  const livePreview = $('#livePreview');
  livePreview.srcObject = combinedStream;

  mediaRecorder.start(1000); // 1s timeslice so chunks flush progressively
  state = STATE.RECORDING;
  startedAt = Date.now();
  elapsedBeforePause = 0;
  startTimer();
  setView('recording');
  $('#stateLabel').textContent = 'Recording';
  $('#pauseBtn').textContent = 'Pause';

  // The mic-mute button only makes sense (and only appears) when a
  // microphone track actually exists to mute -- there's no reliable way
  // to detect a meeting app's own internal mute button, so this is the
  // practical alternative: let the user mirror their in-meeting mute
  // state manually, instantly, without leaving this tab.
  $('#micMuteBtn').classList.toggle('cf-hidden', !micMuteGain);
  if (micMuteGain) {
    micMuteGain.gain.value = 1;
    $('#micMuteBtn').textContent = '🎙️ Mute My Mic';
    $('#micMuteBtn').classList.remove('cf-muted-active');
  }

  if ($('#transcriptToggle').checked) {
    startTranscription();
  }

  track('SCREEN_RECORDING_STARTED', { feature: 'recording', action: mode });
}

function toggleMicMute() {
  if (!micMuteGain) return;
  const isCurrentlyMuted = micMuteGain.gain.value === 0;
  micMuteGain.gain.value = isCurrentlyMuted ? 1 : 0;
  const btn = $('#micMuteBtn');
  btn.textContent = isCurrentlyMuted ? '🎙️ Mute My Mic' : '🔇 Unmute My Mic';
  btn.classList.toggle('cf-muted-active', !isCurrentlyMuted);
}

/* ------------------------------ Live transcription (optional) ------------------------------ */
// Chrome's Web Speech API (SpeechRecognition) only transcribes the
// browser's own microphone input -- there is no standard way to feed it
// an arbitrary MediaStream (tab audio, system audio, or a mix). That
// means this transcribes ONLY what the local user says into their mic,
// not other meeting participants -- labeled as such everywhere it
// appears in the UI rather than implying full-meeting coverage it can't
// actually provide. It also requests microphone access independently of
// the "Microphone" recording toggle above, so it works even if that
// toggle is off.

let recognition = null;
let transcriptFinal = '';
let transcriptInterim = '';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function updateTranscriptDisplay() {
  const el = $('#liveTranscriptText');
  el.innerHTML = escapeHtml(transcriptFinal) + (transcriptInterim ? `<span class="cf-interim">${escapeHtml(transcriptInterim)}</span>` : '');
  el.scrollTop = el.scrollHeight;
}

function startTranscription() {
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    showToast('Live transcription is not supported in this browser.', true);
    return;
  }
  transcriptFinal = '';
  transcriptInterim = '';
  recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) transcriptFinal += result[0].transcript + ' ';
      else interim += result[0].transcript;
    }
    transcriptInterim = interim;
    updateTranscriptDisplay();
  };
  recognition.onerror = (e) => {
    console.warn('Speech recognition error:', e.error);
    // 'no-speech' fires routinely during normal silence -- not worth a toast.
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      showToast('Live transcription hit an error and stopped: ' + e.error, true);
    }
  };
  recognition.onend = () => {
    // Chrome stops SpeechRecognition after periods of silence (behavior
    // varies by version) -- restart automatically while still actually
    // recording, so a longer meeting doesn't silently lose transcription
    // partway through.
    if (state === STATE.RECORDING && recognition) {
      try {
        recognition.start();
      } catch (_) {
        /* already starting/running -- ignore */
      }
    }
  };

  try {
    recognition.start();
    $('#liveTranscriptPanel').classList.remove('cf-hidden');
    updateTranscriptDisplay();
  } catch (err) {
    console.warn('Could not start live transcription:', err);
    showToast('Could not start live transcription.', true);
  }
}

function stopTranscription() {
  if (recognition) {
    recognition.onend = null; // this is an intentional stop -- don't auto-restart
    try {
      recognition.stop();
    } catch (_) {
      /* already stopped -- ignore */
    }
    recognition = null;
  }
}

function togglePause() {
  if (!mediaRecorder) return;
  if (state === STATE.RECORDING) {
    mediaRecorder.pause();
    state = STATE.PAUSED;
    elapsedBeforePause += Date.now() - startedAt;
    stopTimer();
    $('#stateLabel').textContent = 'Paused';
    $('#pauseBtn').textContent = 'Resume';
  } else if (state === STATE.PAUSED) {
    mediaRecorder.resume();
    state = STATE.RECORDING;
    startedAt = Date.now();
    startTimer();
    $('#stateLabel').textContent = 'Recording';
    $('#pauseBtn').textContent = 'Pause';
  }
}

function stopRecording() {
  if (!mediaRecorder || state === STATE.STOPPING || state === STATE.COMPLETE) return;
  state = STATE.STOPPING;
  stopTimer();
  stopTranscription();
  try {
    mediaRecorder.stop();
  } catch (err) {
    console.error('Error stopping recorder:', err);
  }
}

function onRecordingStopped() {
  const mimeType = mediaRecorder.mimeType || 'video/webm';
  resultBlob = new Blob(recordedChunks, { type: mimeType });
  resultUrl = URL.createObjectURL(resultBlob);
  const durationSeconds = (elapsedBeforePause + (startedAt ? Date.now() - startedAt : 0)) / 1000;

  cleanupStreams();
  state = STATE.COMPLETE;

  const video = $('#resultVideo');
  video.src = resultUrl;

  $('#metaDuration').textContent = `⏱ ${formatDuration(durationSeconds)}`;
  $('#metaSize').textContent = `💾 ${formatBytes(resultBlob.size)}`;
  $('#metaFormat').textContent = `🎞 ${mimeType.split(';')[0].split('/')[1].toUpperCase()}`;

  video.dataset.duration = String(durationSeconds);
  setView('done');

  const finalTranscript = transcriptFinal.trim();
  $('#btnDownloadTranscript').classList.toggle('cf-hidden', !finalTranscript);
  $('#liveTranscriptPanel').classList.add('cf-hidden');

  track('SCREEN_RECORDING_STOPPED', { feature: 'recording', action: mode, durationMs: Math.round(durationSeconds * 1000) });
}

function cleanupStreams() {
  [displayStream, micStream, combinedStream].forEach((s) => {
    if (!s) return;
    s.getTracks().forEach((t) => t.stop());
  });
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (areaCropCleanup) {
    areaCropCleanup();
    areaCropCleanup = null;
  }
  if (localAudioPlaybackContext) {
    localAudioPlaybackContext.close().catch(() => {});
    localAudioPlaybackContext = null;
  }
  displayStream = null;
  micStream = null;
  combinedStream = null;
  micMuteGain = null;
}

/* ------------------------------ Timer ------------------------------ */

function startTimer() {
  timerInterval = setInterval(() => {
    const elapsed = elapsedBeforePause + (Date.now() - startedAt);
    $('#timer').textContent = formatHMS(elapsed);
  }, 250);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function formatHMS(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

/* ------------------------------ Errors ------------------------------ */

function showError(message) {
  const el = $('#setupError');
  el.textContent = message;
  el.classList.remove('cf-hidden');
}

function hideError() {
  $('#setupError').classList.add('cf-hidden');
}

function describeStreamError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError')
    return 'Permission was denied. Chrome requires you to allow screen sharing to record.';
  if (name === 'NotFoundError') return 'No capture source was found or selected.';
  if (name === 'NotSupportedError')
    return 'Screen recording is not supported in this context.';
  return err && err.message ? err.message : 'Unable to start recording.';
}

/* ------------------------------ Save / Download / Share ------------------------------ */

async function onSave() {
  if (currentCaptureId) {
    showToast('Already saved to gallery.');
    return;
  }
  const video = $('#resultVideo');
  const duration = Number(video.dataset.duration || 0);
  const thumbnail = await generateVideoThumbnail(resultBlob).catch(() => null);

  const capture = {
    id: crypto.randomUUID(),
    type: 'recording',
    name: `recording-${timestampForFilename()}.webm`,
    mimeType: resultBlob.type || 'video/webm',
    blob: resultBlob,
    thumbnail,
    size: resultBlob.size,
    createdAt: Date.now(),
    duration,
    width: video.videoWidth || 0,
    height: video.videoHeight || 0,
    uploaded: false,
    shareUrl: null,
    shareId: null,
    transcript: transcriptFinal.trim() || null
  };
  await CaptureStore.add(capture);
  currentCaptureId = capture.id;
  chrome.runtime.sendMessage({ action: 'NOTIFY', title: 'Recording saved ✅', message: capture.name }).catch(() => {});
  showToast('Saved to gallery ✅');
}

async function onDownload() {
  const video = $('#resultVideo');
  const name = `recording-${timestampForFilename()}.webm`;
  const url = resultUrl;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  showToast('Download started ✅');
}

async function onShare() {
  const btn = $('#btnShare');
  try {
    if (!currentCaptureId) await onSave();
    btn.disabled = true;
    const progressWrap = $('#uploadProgress');
    const progressBar = $('#uploadProgressBar');
    progressWrap.classList.remove('cf-hidden');

    const capture = await CaptureStore.get(currentCaptureId);
    const { shareUrl } = await createShareLink(capture, (loaded, total) => {
      const pct = Math.round((loaded / total) * 100);
      progressBar.style.width = pct + '%';
      btn.textContent = `Uploading… ${pct}%`;
    });

    $('#shareUrlInput').value = shareUrl;
    $('#shareResult').classList.remove('cf-hidden');
    showToast('Share link created 🔗');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Upload failed. Your recording is safely stored locally.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Share Link';
    $('#uploadProgress').classList.add('cf-hidden');
    $('#uploadProgressBar').style.width = '0%';
  }
}

async function onDiscard() {
  if (currentCaptureId) await CaptureStore.delete(currentCaptureId);
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultBlob = null;
  resultUrl = null;
  currentCaptureId = null;
  transcriptFinal = '';
  transcriptInterim = '';
  $('#btnDownloadTranscript').classList.add('cf-hidden');
  setView('setup');
  showToast('Recording discarded.');
}

function onDownloadTranscript() {
  const text = transcriptFinal.trim();
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transcript-${timestampForFilename()}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast('Transcript downloaded ✅');
}

/* ------------------------------ Init ------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  $('#modeLabel').textContent = MODE_LABELS[mode] || MODE_LABELS.screen;
  $('#audioHint').textContent =
    mode === 'tab' || mode === 'area'
      ? 'Captures this tab\'s own audio (e.g. a video playing in it). For sound from other apps or your microphone too, turn on the Microphone toggle as well.'
      : 'For system audio: choose "Entire Screen" (not a specific Window) in the picker, and tick "Share audio" there too — both are required by Chrome, not just this toggle. Not supported at all on macOS (a Chrome/OS limitation).';
  $('#transcriptHint').textContent =
    'Transcribes what YOU say into your microphone, live, as you record — not other meeting participants (no browser API supports transcribing tab/system audio). Works independently of the Microphone toggle above.';

  $('#startBtn').addEventListener('click', startRecording);
  $('#pauseBtn').addEventListener('click', togglePause);
  $('#stopBtn').addEventListener('click', stopRecording);
  $('#micMuteBtn').addEventListener('click', toggleMicMute);
  $('#btnDownload').addEventListener('click', onDownload);
  $('#btnDownloadTranscript').addEventListener('click', onDownloadTranscript);
  $('#btnSave').addEventListener('click', onSave);
  $('#btnShare').addEventListener('click', onShare);
  $('#btnDelete').addEventListener('click', onDiscard);
  $('#copyShareUrl').addEventListener('click', async () => {
    await copyTextToClipboard($('#shareUrlInput').value);
    showToast('Link copied ✅');
  });
  $('#galleryLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('gallery/gallery.html') });
  });

  window.addEventListener('beforeunload', () => {
    stopTranscription();
    cleanupStreams();
  });
});
