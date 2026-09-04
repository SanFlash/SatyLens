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
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: Number(sourceTabId) }, (id) => {
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
  const micSource = audioContext.createMediaStreamSource(new MediaStream([micTrack]));
  micSource.connect(micGain).connect(limiter);

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
  track('SCREEN_RECORDING_STARTED', { feature: 'recording', action: mode });
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
  displayStream = null;
  micStream = null;
  combinedStream = null;
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
    shareId: null
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
  setView('setup');
  showToast('Recording discarded.');
}

/* ------------------------------ Init ------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  $('#modeLabel').textContent = MODE_LABELS[mode] || MODE_LABELS.screen;
  $('#audioHint').textContent =
    mode === 'tab' || mode === 'area'
      ? 'Captures this tab\'s own audio (e.g. a video playing in it). For sound from other apps or your microphone too, turn on the Microphone toggle as well.'
      : 'For system audio: choose "Entire Screen" (not a specific Window) in the picker, and tick "Share audio" there too — both are required by Chrome, not just this toggle. Not supported at all on macOS (a Chrome/OS limitation).';

  $('#startBtn').addEventListener('click', startRecording);
  $('#pauseBtn').addEventListener('click', togglePause);
  $('#stopBtn').addEventListener('click', stopRecording);
  $('#btnDownload').addEventListener('click', onDownload);
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
    cleanupStreams();
  });
});
