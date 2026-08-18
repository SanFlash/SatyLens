// extension/popup/popup.js
import { CaptureStore } from '../shared/storage.js';
import { copyImageBlobToClipboard, copyTextToClipboard } from '../shared/clipboard.js';
import { createShareLink } from '../shared/share.js';
import { dataUrlToBlob, timestampForFilename, formatBytes, generateImageThumbnail } from '../shared/utils.js';

const $ = (sel) => document.querySelector(sel);

const viewHome = $('#viewHome');
const viewPreview = $('#viewPreview');
const previewImg = $('#previewImg');
const previewStatus = $('#previewStatus');
const shareResult = $('#shareResult');
const shareUrlInput = $('#shareUrlInput');

let currentCapture = null; // { blob, name, mimeType, id (once saved) }

function showToast(message, type = '') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `cf-toast ${type ? 'cf-toast-' + type : ''}`;
  toast.classList.remove('cf-hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('cf-hidden'), 2800);
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.ok === false) {
        reject(new Error((response && response.error) || 'Unknown error'));
        return;
      }
      resolve(response);
    });
  });
}

function switchView(view) {
  viewHome.classList.toggle('cf-hidden', view !== 'home');
  viewPreview.classList.toggle('cf-hidden', view !== 'preview');
}

/* ------------------------------ Recent captures ------------------------------ */

async function renderRecent() {
  const list = $('#recentList');
  const recent = await CaptureStore.getRecent(4);
  if (!recent.length) {
    list.innerHTML = '<div class="cf-empty-small">No captures yet — try a screenshot!</div>';
    return;
  }
  list.innerHTML = '';
  for (const cap of recent) {
    const div = document.createElement('div');
    div.className = 'cf-recent-thumb';
    div.title = cap.name;
    const img = document.createElement('img');
    img.src = cap.thumbnail || (cap.type === 'screenshot' ? '' : '');
    if (!cap.thumbnail) img.style.display = 'none';
    div.appendChild(img);
    const badge = document.createElement('span');
    badge.className = 'cf-badge';
    badge.textContent = cap.type === 'recording' ? '🎥' : '📸';
    div.appendChild(badge);
    div.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'OPEN_GALLERY', id: cap.id });
      window.close();
    });
    list.appendChild(div);
  }
}

/* ------------------------------ Visible tab flow ------------------------------ */

async function handleVisibleTabCapture() {
  try {
    showToast('Capturing visible tab…');
    const { dataUrl } = await sendMessage({ action: 'CAPTURE_VISIBLE_TAB' });
    const blob = dataUrlToBlob(dataUrl);
    currentCapture = {
      blob,
      name: `screenshot-${timestampForFilename()}.png`,
      mimeType: 'image/png',
      id: null
    };
    previewImg.src = dataUrl;
    previewStatus.textContent = `PNG · ${formatBytes(blob.size)}`;
    shareResult.classList.add('cf-hidden');
    switchView('preview');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleFullPageCapture() {
  try {
    showToast('Capturing full page… this may take a moment');
    await sendMessage({ action: 'CAPTURE_FULL_PAGE' });
    showToast('Full page screenshot saved ✅', 'success');
    window.close();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleSelectArea() {
  try {
    await sendMessage({ action: 'START_AREA_SELECT' });
    // The popup loses focus as soon as the user interacts with the page,
    // which is expected — the background script completes the capture
    // and opens the gallery once the user finishes their selection.
    window.close();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openRecorder(mode) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0] ? tabs[0].id : '';
    const url = chrome.runtime.getURL(`recorder/recorder.html?mode=${mode}&tabId=${tabId}`);
    chrome.tabs.create({ url });
    window.close();
  });
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
    if (!currentCapture.id) {
      // Not saved yet — download directly via a temporary anchor.
      const url = URL.createObjectURL(currentCapture.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = currentCapture.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else {
      await sendMessage({ action: 'DOWNLOAD_CAPTURE', id: currentCapture.id });
    }
    showToast('Download started ✅', 'success');
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

async function onEdit() {
  try {
    if (!currentCapture.id) await onSave();
    chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?id=${currentCapture.id}`) });
    window.close();
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
      const pct = Math.round((loaded / total) * 100);
      btn.textContent = `Uploading… ${pct}%`;
    });
    shareUrlInput.value = shareUrl;
    shareResult.classList.remove('cf-hidden');
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
      if (action === 'visible-tab') handleVisibleTabCapture();
      if (action === 'full-page') handleFullPageCapture();
      if (action === 'select-area') handleSelectArea();
      if (action === 'record-tab') openRecorder('tab');
      if (action === 'record-screen') openRecorder('screen');
      if (action === 'record-window') openRecorder('window');
    });
  });

  $('#galleryBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('gallery/gallery.html') });
    window.close();
  });
  $('#viewGalleryLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('gallery/gallery.html') });
    window.close();
  });

  $('#backFromPreview').addEventListener('click', () => {
    currentCapture = null;
    switchView('home');
  });

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
});
