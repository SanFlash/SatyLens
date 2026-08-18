// extension/gallery/gallery.js
import { CaptureStore } from '../shared/storage.js';
import { copyImageBlobToClipboard, copyTextToClipboard } from '../shared/clipboard.js';
import { getApiBaseUrl, setApiBaseUrl } from '../shared/api.js';
import { createShareLink, getUploadDestination, setUploadDestination } from '../shared/share.js';
import {
  isDriveConnected,
  getDriveAccountInfo,
  connectDrive,
  disconnectDrive,
  listRootFolders,
  createDriveFolder,
  getStoredFolder,
  setStoredFolder
} from '../shared/drive.js';
import {
  track,
  isAnalyticsEnabled,
  setAnalyticsEnabled,
  clearLocalTelemetryData,
  getAnalyticsClientId
} from '../shared/analytics.js';
import { getR2LinkHistory, revokeR2Link } from '../shared/r2.js';
import { formatDate, formatBytes, formatDuration, debounce } from '../shared/utils.js';

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const emptyState = $('#emptyState');

let allCaptures = [];
let activeFilter = 'all';
let searchTerm = '';
let sortMode = 'newest';
let activeCapture = null; // the capture shown in the detail modal
let objectUrlCache = new Map(); // id -> object URL, revoked on unload

const highlightId = new URLSearchParams(location.search).get('highlight');

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.style.borderColor = isError ? '#5b2530' : '#2c3b5f';
  toast.style.color = isError ? '#ffb4b4' : '#e8ecf6';
  toast.classList.remove('cf-hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('cf-hidden'), 3000);
}

function objectUrlFor(capture) {
  if (objectUrlCache.has(capture.id)) return objectUrlCache.get(capture.id);
  const url = URL.createObjectURL(capture.blob);
  objectUrlCache.set(capture.id, url);
  return url;
}

/* ------------------------------ Data loading ------------------------------ */

async function loadCaptures() {
  allCaptures = await CaptureStore.getAll();
  render();
}

function getFiltered() {
  let list = allCaptures;
  if (activeFilter !== 'all') list = list.filter((c) => c.type === activeFilter);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    list = list.filter((c) => c.name.toLowerCase().includes(q));
  }
  const sorted = [...list];
  switch (sortMode) {
    case 'oldest':
      sorted.sort((a, b) => a.createdAt - b.createdAt);
      break;
    case 'largest':
      sorted.sort((a, b) => b.size - a.size);
      break;
    case 'smallest':
      sorted.sort((a, b) => a.size - b.size);
      break;
    default:
      sorted.sort((a, b) => b.createdAt - a.createdAt);
  }
  return sorted;
}

/* ------------------------------ Rendering ------------------------------ */

function render() {
  const list = getFiltered();
  grid.innerHTML = '';
  emptyState.classList.toggle('cf-hidden', list.length > 0);

  for (const capture of list) {
    grid.appendChild(buildCard(capture));
  }
}

function buildCard(capture) {
  const card = document.createElement('div');
  card.className = 'cf-card';
  if (capture.id === highlightId) card.classList.add('cf-highlight');
  card.dataset.id = capture.id;

  const thumb = document.createElement('div');
  thumb.className = 'cf-card-thumb';
  if (capture.thumbnail) {
    const img = document.createElement('img');
    img.src = capture.thumbnail;
    img.alt = capture.name;
    thumb.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.className = 'cf-noimg';
    span.textContent = capture.type === 'recording' ? '🎥' : '📸';
    thumb.appendChild(span);
  }
  if (capture.type === 'recording' && capture.duration) {
    const badge = document.createElement('span');
    badge.className = 'cf-duration-badge';
    badge.textContent = formatDuration(capture.duration);
    thumb.appendChild(badge);
  }

  const body = document.createElement('div');
  body.className = 'cf-card-body';
  body.innerHTML = `
    <div class="cf-card-type">${capture.type === 'recording' ? '🎥 Recording' : '📸 Screenshot'}</div>
    <div class="cf-card-date">${formatDate(capture.createdAt)}</div>
    <div class="cf-card-footer">
      <span>${formatBytes(capture.size)}</span>
      <span>${capture.uploaded ? '🔗 Shared' : ''}</span>
    </div>
  `;

  const actions = document.createElement('div');
  actions.className = 'cf-card-actions';
  const canEdit = capture.type === 'screenshot';
  actions.innerHTML = `
    <button data-act="download">Download</button>
    ${canEdit ? '<button data-act="edit">Edit</button>' : ''}
    <button data-act="delete">Delete</button>
  `;
  actions.querySelector('[data-act="download"]').addEventListener('click', (e) => {
    e.stopPropagation();
    downloadCapture(capture);
  });
  if (canEdit) {
    actions.querySelector('[data-act="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor(capture.id);
    });
  }
  actions.querySelector('[data-act="delete"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${capture.name}"? This cannot be undone.`)) return;
    await CaptureStore.delete(capture.id);
    showToast('Capture deleted.');
    await loadCaptures();
  });

  card.appendChild(thumb);
  card.appendChild(body);
  card.appendChild(actions);
  card.addEventListener('click', () => openModal(capture));
  return card;
}

/* ------------------------------ Download / Copy ------------------------------ */

function openEditor(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?id=${id}`) });
}

function downloadCapture(capture) {
  const url = objectUrlFor(capture);
  const a = document.createElement('a');
  a.href = url;
  a.download = capture.name;
  a.click();
  track('FILE_DOWNLOADED', { feature: 'gallery', action: capture.type });
  showToast('Download started ✅');
}

async function copyCapture(capture) {
  if (capture.type !== 'screenshot') {
    showToast('Only screenshots can be copied to the clipboard.', true);
    return;
  }
  try {
    await copyImageBlobToClipboard(capture.blob);
    showToast('Copied to clipboard ✅');
  } catch (err) {
    showToast(err.message, true);
  }
}

/* ------------------------------ Detail modal ------------------------------ */

function openModal(capture) {
  activeCapture = capture;
  const overlay = $('#modalOverlay');
  const previewWrap = $('#modalPreview');
  previewWrap.innerHTML = '';

  const url = objectUrlFor(capture);
  if (capture.type === 'screenshot') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = capture.name;
    previewWrap.appendChild(img);
  } else {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    previewWrap.appendChild(video);
  }

  $('#modalName').textContent = capture.name;
  const metaLines = [
    `Captured ${formatDate(capture.createdAt)}`,
    `${formatBytes(capture.size)} · ${capture.mimeType}`
  ];
  if (capture.type === 'recording' && capture.duration) {
    metaLines.push(`Duration: ${formatDuration(capture.duration)}`);
  }
  $('#modalMeta').innerHTML = metaLines.map((l) => `<div>${l}</div>`).join('');

  const uploadStatus = $('#modalUploadStatus');
  const shareResult = $('#mShareResult');
  if (capture.uploaded && capture.shareUrl) {
    uploadStatus.textContent = 'Uploaded ✅';
    $('#mShareUrlInput').value = capture.shareUrl;
    shareResult.classList.remove('cf-hidden');
  } else {
    uploadStatus.textContent = 'Not uploaded — private and local only.';
    shareResult.classList.add('cf-hidden');
  }

  $('#mCopy').disabled = capture.type !== 'screenshot';
  $('#mEdit').classList.toggle('cf-hidden', capture.type !== 'screenshot');
  overlay.classList.remove('cf-hidden');
}

function closeModal() {
  $('#modalOverlay').classList.add('cf-hidden');
  activeCapture = null;
}

async function onModalShare() {
  if (!activeCapture) return;
  const btn = $('#mShare');
  const progressWrap = $('#mUploadProgress');
  const progressBar = $('#mUploadProgressBar');
  try {
    btn.disabled = true;
    progressWrap.classList.remove('cf-hidden');
    const { shareUrl } = await createShareLink(activeCapture, (loaded, total) => {
      progressBar.style.width = Math.round((loaded / total) * 100) + '%';
    });
    activeCapture = await CaptureStore.get(activeCapture.id);
    $('#mShareUrlInput').value = shareUrl;
    $('#mShareResult').classList.remove('cf-hidden');
    $('#modalUploadStatus').textContent = 'Uploaded ✅';
    showToast('Share link created 🔗');
    await loadCaptures();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Upload failed. Your capture is safely stored locally.', true);
  } finally {
    btn.disabled = false;
    progressWrap.classList.add('cf-hidden');
    progressBar.style.width = '0%';
  }
}

async function onModalDelete() {
  if (!activeCapture) return;
  if (!confirm(`Delete "${activeCapture.name}"? This cannot be undone.`)) return;
  await CaptureStore.delete(activeCapture.id);
  closeModal();
  showToast('Capture deleted.');
  await loadCaptures();
}

/* ------------------------------ Settings ------------------------------ */

async function openSettings() {
  $('#apiBaseInput').value = await getApiBaseUrl();
  $('#settingsStatus').textContent = '';
  const dest = await getUploadDestination();
  document.querySelectorAll('input[name="uploadDest"]').forEach((r) => {
    r.checked = r.value === dest;
  });
  $('#analyticsToggle').checked = await isAnalyticsEnabled();
  await refreshDriveSection();
  $('#settingsOverlay').classList.remove('cf-hidden');
}

function closeSettings() {
  $('#settingsOverlay').classList.add('cf-hidden');
}

async function saveSettings() {
  const value = $('#apiBaseInput').value.trim();
  if (value) await setApiBaseUrl(value);
  const dest = document.querySelector('input[name="uploadDest"]:checked')?.value || 'backend';
  await setUploadDestination(dest);
  await setAnalyticsEnabled($('#analyticsToggle').checked);
  $('#settingsStatus').textContent = 'Saved ✅';
  setTimeout(closeSettings, 700);
}

async function onClearTelemetry() {
  if (!confirm('Clear locally stored telemetry data and start a fresh anonymous identity?')) return;
  await clearLocalTelemetryData();
  showToast('Local telemetry data cleared.');
}

/* ------------------------------ Google Drive settings ------------------------------ */

async function refreshDriveSection() {
  const connected = await isDriveConnected();
  $('#driveDisconnected').classList.toggle('cf-hidden', connected);
  $('#driveConnected').classList.toggle('cf-hidden', !connected);
  if (connected) {
    const account = await getDriveAccountInfo();
    $('#driveAccountEmail').textContent = account?.email || 'Connected';
    const folder = await getStoredFolder();
    $('#driveFolderLabel').textContent = folder ? folder.name : 'My Drive (root)';
    await populateFolderSelect(folder);
  }
}

async function populateFolderSelect(currentFolder) {
  const select = $('#driveFolderSelect');
  select.innerHTML = '<option value="">My Drive (root)</option>';
  try {
    const folders = await listRootFolders();
    for (const f of folders) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      if (currentFolder && currentFolder.id === f.id) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error('Could not list Drive folders:', err);
  }
}

async function onConnectDrive() {
  const btn = $('#connectDriveBtn');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    await connectDrive();
    await refreshDriveSection();
    showToast('Google Drive connected ✅');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not connect Google Drive.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Google Drive';
  }
}

async function onDisconnectDrive() {
  if (!confirm('Disconnect Google Drive? "Create Share Link" will fall back to the backend server.')) return;
  await disconnectDrive();
  const dest = await getUploadDestination();
  if (dest === 'drive') await setUploadDestination('backend');
  await refreshDriveSection();
  showToast('Google Drive disconnected.');
}

async function onFolderSelectChange() {
  const select = $('#driveFolderSelect');
  const id = select.value || null;
  const name = id ? select.options[select.selectedIndex].textContent : 'My Drive (root)';
  await setStoredFolder(id, name);
  $('#driveFolderLabel').textContent = name;
}

async function onCreateFolder() {
  const name = prompt('New folder name:', 'SatyLens');
  if (!name) return;
  try {
    const folder = await createDriveFolder(name);
    await setStoredFolder(folder.id, folder.name);
    await refreshDriveSection();
    showToast(`Folder "${folder.name}" created and selected.`);
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not create folder.', true);
  }
}

/* ------------------------------ Link History (Cloudflare R2) ------------------------------ */

async function openLinkHistory() {
  const list = $('#linkHistoryList');
  const empty = $('#linkHistoryEmpty');
  list.innerHTML = '';
  empty.classList.add('cf-hidden');
  $('#linkHistoryOverlay').classList.remove('cf-hidden');

  try {
    const clientId = await getAnalyticsClientId();
    const items = await getR2LinkHistory(clientId, 30);
    if (!items.length) {
      empty.classList.remove('cf-hidden');
      return;
    }
    for (const item of items) list.appendChild(buildLinkHistoryItem(item));
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="cf-empty"><p>${err.message || 'Could not load link history.'}</p></div>`;
  }
}

function buildLinkHistoryItem(item) {
  const el = document.createElement('div');
  el.className = 'cf-link-history-item' + (item.revoked ? ' cf-revoked' : '');

  const top = document.createElement('div');
  top.className = 'cf-link-history-top';
  const name = document.createElement('span');
  name.className = 'cf-link-history-name';
  name.textContent = `${item.media_type === 'recording' ? '🎥' : '📸'} ${item.file_name}`;
  top.appendChild(name);
  el.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'cf-link-history-meta';
  meta.innerHTML = `
    <span>${formatDate(new Date(item.created_at).getTime())}</span>
    <span>${formatBytes(item.size_bytes)}</span>
    <span>👁 ${item.view_count}</span>
    <span>⬇ ${item.download_count}</span>
    ${item.revoked ? '<span>🔒 Revoked</span>' : ''}
  `;
  el.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'cf-link-history-actions';
  actions.innerHTML = `
    <button data-act="copy">Copy</button>
    <button data-act="open">Open</button>
    ${!item.revoked ? '<button data-act="revoke" class="cf-revoke-btn">Revoke</button>' : ''}
  `;
  actions.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    await copyTextToClipboard(item.share_url);
    track('LINK_COPIED', { feature: 'sharing', action: 'r2' });
    showToast('Link copied ✅');
  });
  actions.querySelector('[data-act="open"]').addEventListener('click', () => {
    window.open(item.share_url, '_blank');
    track('LINK_OPENED', { feature: 'sharing', action: 'r2' });
  });
  const revokeBtn = actions.querySelector('[data-act="revoke"]');
  if (revokeBtn) {
    revokeBtn.addEventListener('click', async () => {
      if (!confirm('Revoke this share link? It will stop working immediately.')) return;
      try {
        await revokeR2Link(item.id);
        track('LINK_REVOKED', { feature: 'sharing', action: 'r2' });
        showToast('Link revoked.');
        openLinkHistory(); // refresh the list
      } catch (err) {
        showToast(err.message || 'Could not revoke link.', true);
      }
    });
  }
  el.appendChild(actions);
  return el;
}

function closeLinkHistory() {
  $('#linkHistoryOverlay').classList.add('cf-hidden');
}

/* ------------------------------ Init ------------------------------ */



document.addEventListener('DOMContentLoaded', () => {
  loadCaptures();

  document.querySelectorAll('.cf-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.cf-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilter = tab.dataset.filter;
      render();
    });
  });

  $('#searchInput').addEventListener(
    'input',
    debounce((e) => {
      searchTerm = e.target.value.trim();
      render();
    }, 150)
  );

  $('#sortSelect').addEventListener('change', (e) => {
    sortMode = e.target.value;
    render();
  });

  $('#modalClose').addEventListener('click', closeModal);
  $('#modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  });
  $('#mCopy').addEventListener('click', () => activeCapture && copyCapture(activeCapture));
  $('#mDownload').addEventListener('click', () => activeCapture && downloadCapture(activeCapture));
  $('#mEdit').addEventListener('click', () => activeCapture && openEditor(activeCapture.id));
  $('#mShare').addEventListener('click', onModalShare);
  $('#mDelete').addEventListener('click', onModalDelete);
  $('#mCopyShareUrl').addEventListener('click', async () => {
    await copyTextToClipboard($('#mShareUrlInput').value);
    track('LINK_COPIED', { feature: 'sharing' });
    showToast('Link copied ✅');
  });
  $('#mOpenShareUrl').addEventListener('click', () => {
    window.open($('#mShareUrlInput').value, '_blank');
    track('LINK_OPENED', { feature: 'sharing' });
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settingsOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'settingsOverlay') closeSettings();
  });
  $('#linkHistoryBtn').addEventListener('click', openLinkHistory);
  $('#linkHistoryClose').addEventListener('click', closeLinkHistory);
  $('#linkHistoryOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'linkHistoryOverlay') closeLinkHistory();
  });
  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#clearTelemetryBtn').addEventListener('click', onClearTelemetry);
  $('#privacyInfoLink').addEventListener('click', (e) => {
    e.preventDefault();
    alert(
      'What SatyLens analytics collects:\n\n' +
        '• A random anonymous ID (not your Google account or email)\n' +
        '• Which features you use and when (e.g. "screenshot captured", "recording started")\n' +
        '• Your Chrome/OS version and extension version\n' +
        '• A coarse, optional country code (never your precise location or IP address)\n\n' +
        'Never collected: page URLs, page content, keystrokes, or precise location.\n\n' +
        'You can turn this off above, or clear locally stored telemetry data at any time.'
    );
  });
  $('#connectDriveBtn').addEventListener('click', onConnectDrive);
  $('#disconnectDriveBtn').addEventListener('click', onDisconnectDrive);
  $('#driveFolderSelect').addEventListener('change', onFolderSelectChange);
  $('#createFolderBtn').addEventListener('click', onCreateFolder);

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'GALLERY_UPDATED') loadCaptures();
  });

  window.addEventListener('unload', () => {
    for (const url of objectUrlCache.values()) URL.revokeObjectURL(url);
  });

  if (highlightId) {
    setTimeout(() => {
      const el = grid.querySelector(`[data-id="${CSS.escape(highlightId)}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  }
});
