// extension/video-editor/video-editor.js
import { CaptureStore } from '../shared/storage.js';
import { exportEditedVideo, buildCssFilterString, RESOLUTION_PRESETS, resolveTargetDimensions } from '../shared/video-export.js';
import { generateVideoThumbnail, timestampForFilename, formatBytes } from '../shared/utils.js';
import { track } from '../shared/analytics.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const captureId = params.get('id');

const video = $('#vePreviewVideo');
const track_ = $('#veTimelineTrack');
const trimRangeEl = $('#veTrimRange');
const playheadEl = $('#vePlayhead');
const startHandle = $('#veTrimStartHandle');
const endHandle = $('#veTrimEndHandle');

let capture = null;
let duration = 0;
let trimStart = 0;
let trimEnd = 0;
let isPlaying = false;
let exportedBlob = null;
let previewRafId = null;

const effects = { brightness: 1, contrast: 1, saturation: 1, grayscale: 0, sepia: 0, blur: 0 };
let activeFilterPreset = 'none';

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.style.borderColor = isError ? '#5b2530' : '#2c3b5f';
  toast.classList.remove('ve-hidden');
  setTimeout(() => toast.classList.add('ve-hidden'), 3000);
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------ Load capture ------------------------------ */

async function init() {
  if (!captureId) {
    showToast('No recording specified.', true);
    return;
  }
  capture = await CaptureStore.get(captureId);
  if (!capture) {
    showToast('Recording not found.', true);
    return;
  }
  $('#veTitle').textContent = capture.name;
  video.src = URL.createObjectURL(capture.blob);
  video.muted = false;

  await new Promise((resolve) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
  });

  // MediaRecorder-produced WebM often reports Infinity/NaN duration
  // until you seek to a huge timestamp once, which forces Chrome to
  // actually calculate and report the real duration.
  duration = await new Promise((resolve) => {
    video.addEventListener('seeked', function onSeeked() {
      video.removeEventListener('seeked', onSeeked);
      resolve(video.duration);
    });
    video.currentTime = 1e101;
  });
  video.currentTime = 0;

  trimStart = 0;
  trimEnd = duration;
  $('#veTotalTime').textContent = formatTime(duration);
  updateTimelineUI();
  updateEstimate();
}

/* ------------------------------ Timeline / trim handles ------------------------------ */

function timeToPercent(t) {
  return duration > 0 ? (t / duration) * 100 : 0;
}

function percentToTime(pct) {
  return Math.max(0, Math.min(duration, (pct / 100) * duration));
}

function updateTimelineUI() {
  const startPct = timeToPercent(trimStart);
  const endPct = timeToPercent(trimEnd);
  trimRangeEl.style.left = startPct + '%';
  trimRangeEl.style.width = (endPct - startPct) + '%';
  startHandle.style.left = startPct + '%';
  endHandle.style.left = endPct + '%';
  $('#veTrimSummary').textContent = `Trimmed length: ${formatTime(trimEnd - trimStart)} (of ${formatTime(duration)})`;
}

function updatePlayhead() {
  playheadEl.style.left = timeToPercent(video.currentTime) + '%';
  $('#veCurrentTime').textContent = formatTime(video.currentTime);
}

function setupHandleDrag(handle, isStart) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const onMove = (moveEvt) => {
      const rect = track_.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, ((moveEvt.clientX - rect.left) / rect.width) * 100));
      const t = percentToTime(pct);
      if (isStart) {
        trimStart = Math.min(t, trimEnd - 0.1);
      } else {
        trimEnd = Math.max(t, trimStart + 0.1);
      }
      updateTimelineUI();
      updateEstimate();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      video.currentTime = isStart ? trimStart : trimEnd;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

track_.addEventListener('click', (e) => {
  if (e.target === startHandle || e.target === endHandle) return;
  const rect = track_.getBoundingClientRect();
  const pct = ((e.clientX - rect.left) / rect.width) * 100;
  const t = percentToTime(pct);
  video.currentTime = Math.max(trimStart, Math.min(trimEnd, t));
});

/* ------------------------------ Playback (constrained to trim range) ------------------------------ */

function togglePlayPause() {
  if (isPlaying) {
    video.pause();
  } else {
    if (video.currentTime < trimStart || video.currentTime >= trimEnd) video.currentTime = trimStart;
    video.play();
  }
}

video.addEventListener('play', () => {
  isPlaying = true;
  $('#vePlayPauseBtn').textContent = '⏸ Pause';
  const loop = () => {
    if (video.currentTime >= trimEnd) {
      video.pause();
      video.currentTime = trimStart;
      return;
    }
    updatePlayhead();
    previewRafId = requestAnimationFrame(loop);
  };
  loop();
});

video.addEventListener('pause', () => {
  isPlaying = false;
  $('#vePlayPauseBtn').textContent = '▶ Play';
  if (previewRafId) cancelAnimationFrame(previewRafId);
  updatePlayhead();
});

video.addEventListener('timeupdate', updatePlayhead);

/* ------------------------------ Effects (live preview via CSS filter) ------------------------------ */

function applyLiveEffectsToPreview() {
  video.style.filter = buildCssFilterString(effects);
}

function onEffectSliderChange(id, key, formatter) {
  const input = $(id);
  input.addEventListener('input', () => {
    effects[key] = parseFloat(input.value);
    $(id + 'Val').textContent = formatter(effects[key]);
    applyLiveEffectsToPreview();
    updateEstimate();
  });
}

onEffectSliderChange('#veBrightness', 'brightness', (v) => Math.round(v * 100) + '%');
onEffectSliderChange('#veContrast', 'contrast', (v) => Math.round(v * 100) + '%');
onEffectSliderChange('#veSaturation', 'saturation', (v) => Math.round(v * 100) + '%');
onEffectSliderChange('#veBlur', 'blur', (v) => v + 'px');

document.querySelectorAll('.ve-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const filter = btn.dataset.filter;
    activeFilterPreset = filter;
    effects.grayscale = filter === 'grayscale' ? 1 : 0;
    effects.sepia = filter === 'sepia' ? 1 : 0;
    document.querySelectorAll('.ve-toggle-btn').forEach((b) => b.classList.toggle('ve-toggle-active', b.dataset.filter === filter));
    applyLiveEffectsToPreview();
  });
});

$('#veResetEffectsBtn').addEventListener('click', () => {
  effects.brightness = 1;
  effects.contrast = 1;
  effects.saturation = 1;
  effects.grayscale = 0;
  effects.sepia = 0;
  effects.blur = 0;
  activeFilterPreset = 'none';
  $('#veBrightness').value = 1;
  $('#veContrast').value = 1;
  $('#veSaturation').value = 1;
  $('#veBlur').value = 0;
  $('#veBrightnessVal').textContent = '100%';
  $('#veContrastVal').textContent = '100%';
  $('#veSaturationVal').textContent = '100%';
  $('#veBlurVal').textContent = '0px';
  document.querySelectorAll('.ve-toggle-btn').forEach((b) => b.classList.toggle('ve-toggle-active', b.dataset.filter === 'none'));
  applyLiveEffectsToPreview();
});

/* ------------------------------ Speed ------------------------------ */

$('#veSpeedSelect').addEventListener('change', (e) => {
  video.playbackRate = parseFloat(e.target.value);
  updateEstimate();
});

/* ------------------------------ Resolution ------------------------------ */

function getSelectedResolutionPreset() {
  const val = $('#veResolutionSelect').value;
  if (val === 'original') return RESOLUTION_PRESETS[0];
  return { label: val + 'p', maxHeight: parseInt(val, 10) };
}

$('#veResolutionSelect').addEventListener('change', updateEstimate);

function updateEstimate() {
  if (!video.videoWidth) return;
  const preset = getSelectedResolutionPreset();
  const target = resolveTargetDimensions(video.videoWidth, video.videoHeight, preset);
  const speed = parseFloat($('#veSpeedSelect').value);
  const trimmedLength = trimEnd - trimStart;
  const exportSeconds = trimmedLength / speed;
  $('#veResolutionHint').textContent = `${target.width}×${target.height}`;
  $('#veEstimate').textContent =
    `${target.width}×${target.height}, ~${formatTime(trimmedLength / speed)} long. ` +
    `Export takes about as long as that to render (~${Math.ceil(exportSeconds)}s).`;
}

/* ------------------------------ Export ------------------------------ */

async function onExport() {
  const preset = getSelectedResolutionPreset();
  const target = resolveTargetDimensions(video.videoWidth, video.videoHeight, preset);
  const speed = parseFloat($('#veSpeedSelect').value);

  $('#veExportOverlay').classList.remove('ve-hidden');
  $('#veExportTitle').textContent = 'Exporting…';
  $('#veExportStatus').textContent = 'This can take about as long as the trimmed clip\'s own length. Keep this tab open.';
  $('#veExportDoneActions').classList.add('ve-hidden');
  $('#veExportCloseBtn').classList.add('ve-hidden');
  $('#veProgressFill').style.width = '0%';

  try {
    exportedBlob = await exportEditedVideo(capture.blob, {
      trimStart,
      trimEnd,
      speed,
      effects,
      targetWidth: target.width,
      targetHeight: target.height,
      onProgress: (fraction) => {
        $('#veProgressFill').style.width = Math.round(fraction * 100) + '%';
      }
    });
    $('#veExportTitle').textContent = 'Export complete ✅';
    $('#veExportStatus').textContent = `${formatBytes(exportedBlob.size)} — ready to save or download.`;
    $('#veExportDoneActions').classList.remove('ve-hidden');
    $('#veExportCloseBtn').classList.remove('ve-hidden');
    track('VIDEO_EDITED', { feature: 'video-editor', action: 'export', success: true });
  } catch (err) {
    console.error(err);
    $('#veExportTitle').textContent = 'Export failed';
    $('#veExportStatus').textContent = err.message || 'Something went wrong while exporting.';
    $('#veExportCloseBtn').classList.remove('ve-hidden');
    track('VIDEO_EDITED', { feature: 'video-editor', action: 'export', success: false, error: err.message });
  }
}

function onDownloadExported() {
  if (!exportedBlob) return;
  const url = URL.createObjectURL(exportedBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `edited-${timestampForFilename()}.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function onSaveExportedToGallery() {
  if (!exportedBlob) return;
  const btn = $('#veSaveBtn');
  btn.disabled = true;
  try {
    const thumbnail = await generateVideoThumbnail(exportedBlob).catch(() => null);
    const newCapture = {
      id: crypto.randomUUID(),
      type: 'recording',
      name: `edited-${timestampForFilename()}.webm`,
      mimeType: exportedBlob.type || 'video/webm',
      blob: exportedBlob,
      thumbnail,
      size: exportedBlob.size,
      createdAt: Date.now(),
      duration: trimEnd - trimStart,
      width: 0,
      height: 0,
      uploaded: false,
      shareUrl: null,
      shareId: null
    };
    await CaptureStore.add(newCapture);
    chrome.runtime.sendMessage({ action: 'GALLERY_UPDATED' }).catch(() => {});
    showToast('Saved as a new recording in your Gallery ✅');
    $('#veExportOverlay').classList.add('ve-hidden');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not save to gallery.', true);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------ Init ------------------------------ */

setupHandleDrag(startHandle, true);
setupHandleDrag(endHandle, false);

$('#vePlayPauseBtn').addEventListener('click', togglePlayPause);
$('#veExportBtn').addEventListener('click', onExport);
$('#veCancelBtn').addEventListener('click', () => window.close());
$('#veDownloadBtn').addEventListener('click', onDownloadExported);
$('#veSaveBtn').addEventListener('click', onSaveExportedToGallery);
$('#veExportCloseBtn').addEventListener('click', () => $('#veExportOverlay').classList.add('ve-hidden'));

init();
