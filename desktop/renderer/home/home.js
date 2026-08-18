// desktop/renderer/home/home.js
// Desktop equivalent of the extension's popup.js. No "tabs" concept
// exists on desktop, so screenshot modes are screen/window/area instead
// of visible-tab/full-page/area, and recording sources come from
// Electron's desktopCapturer instead of chrome.tabCapture.

import { CaptureStore } from '../shared/storage.js';
import { copyImageBlobToClipboard, copyTextToClipboard } from '../shared/clipboard.js';
import { createShareLink } from '../shared/share.js';
import { timestampForFilename, formatBytes, generateImageThumbnail } from '../shared/utils.js';

const $ = (sel) => document.querySelector(sel);
const video = $('#captureVideo');
const canvas = $('#captureCanvas');

const viewHome = $('#viewHome');
const viewPreview = $('#viewPreview');
const viewPicker = $('#viewPicker');
const previewImg = $('#previewImg');
const previewStatus = $('#previewStatus');
const shareResult = $('#shareResult');
const shareUrlInput = $('#shareUrlInput');

let currentCapture = null; // { blob, name, mimeType, id (once saved) }
let pendingPickerAction = null; // 'screenshot' | 'record'

function showToast(message, type = '') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${type ? 'toast-' + type : ''}`;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2800);
}

function switchView(view) {
  viewHome.classList.toggle('hidden', view !== 'home');
  viewPreview.classList.toggle('hidden', view !== 'preview');
  viewPicker.classList.toggle('hidden', view !== 'picker');
}

/* ------------------------------ Recent captures ------------------------------ */

async function renderRecent() {
  const list = $('#recentList');
  const recent = await CaptureStore.getRecent(4);
  if (!recent.length) {
    list.innerHTML = '<div class="empty-small">No captures yet — try a screenshot!</div>';
    return;
  }
  list.innerHTML = '';
  for (const cap of recent) {
    const div = document.createElement('div');
    div.className = 'recent-thumb';
    div.title = cap.name;
    const img = document.createElement('img');
    img.src = cap.thumbnail || '';
    if (!cap.thumbnail) img.style.display = 'none';
    div.appendChild(img);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = cap.type === 'recording' ? '🎥' : '📸';
    div.appendChild(badge);
    div.addEventListener('click', () => {
      window.satylens.openWindow(`gallery/gallery.html?highlight=${cap.id}`);
    });
    list.appendChild(div);
  }
}

/* ------------------------------ Frame capture (screenshot) ------------------------------ */

async function grabFrameFromSource(sourceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId
      }
    }
  });
  video.srcObject = stream;
  await video.play();
  // A frame or two of settle time avoids grabbing a black/partial first frame.
  await new Promise((r) => setTimeout(r, 200));

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

async function showScreenshotPreview(blob) {
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
  currentCapture = {
    blob,
    name: `screenshot-${timestampForFilename()}.png`,
    mimeType: 'image/png',
    id: null
  };
  previewImg.src = dataUrl;
  previewStatus.textContent = `PNG · ${formatBytes(blob.size)}`;
  shareResult.classList.add('hidden');
  switchView('preview');
}

/* ------------------------------ Source picker ------------------------------ */

async function openPicker(types, action) {
  pendingPickerAction = action;
  $('#pickerTitle').textContent = types.includes('window') && !types.includes('screen') ? 'Choose a window' : 'Choose a screen or window';
  const grid = $('#pickerGrid');
  grid.innerHTML = '<div class="empty-small">Loading sources…</div>';
  switchView('picker');

  try {
    const sources = await window.satylens.getCaptureSources(types);
    if (!sources.length) {
      grid.innerHTML = '<div class="empty-small">No sources available.</div>';
      return;
    }
    grid.innerHTML = '';
    for (const source of sources) {
      const btn = document.createElement('button');
      btn.className = 'picker-item';
      btn.innerHTML = `
        <img src="${source.thumbnailDataUrl || ''}" alt="${source.name}" />
        <div class="picker-item-name">${source.name}</div>
      `;
      btn.addEventListener('click', () => onSourcePicked(source));
      grid.appendChild(btn);
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty-small">${err.message || 'Could not list sources.'}</div>`;
  }
}

async function onSourcePicked(source) {
  if (pendingPickerAction === 'screenshot') {
    switchView('home');
    try {
      showToast('Capturing…');
      const blob = await grabFrameFromSource(source.id);
      await showScreenshotPreview(blob);
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Capture failed.', 'error');
    }
  } else if (pendingPickerAction === 'record') {
    window.satylens.openWindow(`recorder/recorder.html?sourceId=${encodeURIComponent(source.id)}&sourceName=${encodeURIComponent(source.name)}`);
    switchView('home');
  }
}

/* ------------------------------ Select Area ------------------------------ */

async function handleSelectArea() {
  try {
    showToast('Capturing screen…');
    const sources = await window.satylens.getCaptureSources(['screen']);
    if (!sources.length) throw new Error('No screen source available.');
    const fullBlob = await grabFrameFromSource(sources[0].id);
    const fullBitmap = await createImageBitmap(fullBlob);

    const displayInfo = await window.satylens.getPrimaryDisplaySize();
    const rect = await window.satylens.startAreaSelect();
    if (!rect || rect.w < 4 || rect.h < 4) return; // user cancelled

    // The overlay reports the rect in logical (CSS) screen pixels; the
    // captured frame is at the source's native pixel resolution, which on
    // a HiDPI display is scaleFactor times larger. Map one to the other.
    const scale = fullBitmap.width / displayInfo.width;
    const sx = Math.round(rect.x * scale);
    const sy = Math.round(rect.y * scale);
    const sw = Math.round(rect.w * scale);
    const sh = Math.round(rect.h * scale);

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = sw;
    cropCanvas.height = sh;
    cropCanvas.getContext('2d').drawImage(fullBitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    fullBitmap.close();

    const croppedBlob = await new Promise((resolve) => cropCanvas.toBlob((b) => resolve(b), 'image/png'));
    await showScreenshotPreview(croppedBlob);
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Area capture failed.', 'error');
  }
}

/* ------------------------------ Preview actions ------------------------------ */

async function onCopy() {
  try {
    await copyImageBlobToClipboard(currentCapture.blob);
    showToast('Copied to clipboard ✅', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onDownload() {
  try {
    const savedPath = await window.satylens.saveDownload(currentCapture.blob, currentCapture.name);
    showToast(`Saved to ${savedPath}`, 'success');
  } catch (err) {
    showToast(err.message || 'Download failed.', 'error');
  }
}

async function onEdit() {
  try {
    if (!currentCapture.id) await onSave();
    window.satylens.openWindow(`editor/editor.html?id=${currentCapture.id}`);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onSave() {
  try {
    if (currentCapture.id) {
      showToast('Already saved to gallery.');
      return;
    }
    const thumbnail = await generateImageThumbnail(currentCapture.blob).catch(() => null);
    const capture = {
      id: crypto.randomUUID(),
      type: 'screenshot',
      name: currentCapture.name,
      mimeType: currentCapture.mimeType,
      blob: currentCapture.blob,
      thumbnail,
      size: currentCapture.blob.size,
      createdAt: Date.now(),
      duration: 0,
      width: 0,
      height: 0,
      uploaded: false,
      shareUrl: null,
      shareId: null
    };
    await CaptureStore.add(capture);
    currentCapture.id = capture.id;
    showToast('Saved to gallery ✅', 'success');
    renderRecent();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onShare() {
  const btn = $('#btnShare');
  try {
    if (!currentCapture.id) await onSave();
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    const capture = await CaptureStore.get(currentCapture.id);
    const { shareUrl } = await createShareLink(capture, (loaded, total) => {
      btn.textContent = `Uploading… ${Math.round((loaded / total) * 100)}%`;
    });
    shareUrlInput.value = shareUrl;
    shareResult.classList.remove('hidden');
    showToast('Share link created 🔗', 'success');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Upload failed. Your capture is safely stored locally.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Share Link';
  }
}

async function onDelete() {
  try {
    if (currentCapture.id) await CaptureStore.delete(currentCapture.id);
    currentCapture = null;
    switchView('home');
    renderRecent();
    showToast('Capture deleted.');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ------------------------------ Wire up UI ------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  renderRecent();

  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'capture-screen') openPicker(['screen'], 'screenshot');
      if (action === 'capture-window') openPicker(['window'], 'screenshot');
      if (action === 'select-area') handleSelectArea();
      if (action === 'record-screen') openPicker(['screen'], 'record');
      if (action === 'record-window') openPicker(['window'], 'record');
    });
  });

  $('#galleryBtn').addEventListener('click', () => window.satylens.openWindow('gallery/gallery.html'));
  $('#viewGalleryLink').addEventListener('click', (e) => {
    e.preventDefault();
    window.satylens.openWindow('gallery/gallery.html');
  });
  $('#backFromPreview').addEventListener('click', () => {
    currentCapture = null;
    switchView('home');
  });
  $('#backFromPicker').addEventListener('click', () => switchView('home'));

  $('#btnCopy').addEventListener('click', onCopy);
  $('#btnDownload').addEventListener('click', onDownload);
  $('#btnEdit').addEventListener('click', onEdit);
  $('#btnSave').addEventListener('click', onSave);
  $('#btnShare').addEventListener('click', onShare);
  $('#btnDelete').addEventListener('click', onDelete);
  $('#copyShareUrl').addEventListener('click', async () => {
    await copyTextToClipboard(shareUrlInput.value);
    showToast('Link copied ✅', 'success');
  });

  window.satylens.onQuickScreenshot(() => openPicker(['screen'], 'screenshot'));
});
