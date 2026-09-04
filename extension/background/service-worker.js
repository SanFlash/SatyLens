// extension/background/service-worker.js
// MV3 service worker. Owns all chrome.tabs.captureVisibleTab calls, full-page
// stitching, area-select cropping, downloads, and notifications. Never relies
// on in-memory state surviving a worker restart — every operation is
// re-derivable from the message payload + IndexedDB.

import { CaptureStore } from '../shared/storage.js';
import { uuid, timestampForFilename, isRestrictedUrl, generateImageThumbnail } from '../shared/utils.js';
import { track } from '../shared/analytics.js';

const CAPTURE_THROTTLE_MS = 550; // stay under Chrome's captureVisibleTab rate limit

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      'This page is restricted by Chrome and cannot be captured by extensions.'
    );
  }
  return tab;
}

async function captureVisibleTabDataUrl(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!dataUrl) {
        reject(new Error('Screenshot capture returned no data.'));
      } else {
        resolve(dataUrl);
      }
    });
  });
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message
    });
  } catch (e) {
    console.warn('Notification failed:', e);
  }
}

async function saveCapture({ type, name, mimeType, blob, width, height, duration }) {
  const thumbnail =
    type === 'screenshot' ? await generateImageThumbnail(blob).catch(() => null) : null;
  const capture = {
    id: uuid(),
    type,
    name,
    mimeType,
    blob,
    thumbnail,
    size: blob.size,
    createdAt: Date.now(),
    duration: duration || 0,
    width: width || 0,
    height: height || 0,
    uploaded: false,
    shareUrl: null,
    shareId: null
  };
  await CaptureStore.add(capture);
  return capture;
}

function broadcastGalleryUpdate() {
  chrome.runtime.sendMessage({ action: 'GALLERY_UPDATED' }).catch(() => {
    /* no listeners open — fine */
  });
}

async function openGalleryFocusedOn(id) {
  const url = chrome.runtime.getURL(`gallery/gallery.html?highlight=${encodeURIComponent(id)}`);
  await chrome.tabs.create({ url });
}

/* ---------------------------- Visible tab -------------------------------- */

async function captureVisibleTab() {
  const tab = await getActiveTab();
  const dataUrl = await captureVisibleTabDataUrl(tab.windowId);
  return { dataUrl, tabId: tab.id };
}

/* ---------------------------- Full page ----------------------------------- */

async function captureFullPage() {
  const tab = await getActiveTab();

  // Ensure the content script is present (it's declared for http/https in the
  // manifest, but the tab may have loaded before the extension was installed).
  await chrome.scripting
    .executeScript({ target: { tabId: tab.id }, files: ['selector/selector.js'] })
    .catch(() => {});

  const metrics = await chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_METRICS' });
  const { scrollWidth, scrollHeight, viewportWidth, viewportHeight, devicePixelRatio, scrollX, scrollY } =
    metrics;

  const totalHeight = Math.max(scrollHeight, viewportHeight);
  const steps = Math.ceil(totalHeight / viewportHeight);
  const slices = [];

  for (let i = 0; i < steps; i++) {
    const y = Math.min(i * viewportHeight, totalHeight - viewportHeight);
    await chrome.tabs.sendMessage(tab.id, { action: 'SCROLL_TO', x: 0, y });
    await sleep(CAPTURE_THROTTLE_MS);
    const dataUrl = await captureVisibleTabDataUrl(tab.windowId);
    slices.push({ dataUrl, y });
  }

  // Restore original scroll position.
  await chrome.tabs.sendMessage(tab.id, { action: 'SCROLL_TO', x: scrollX, y: scrollY });

  const stitched = await stitchSlices(slices, viewportWidth, totalHeight, devicePixelRatio);
  return stitched; // Blob (image/png)
}

async function stitchSlices(slices, viewportWidth, totalHeight, dpr) {
  const canvas = new OffscreenCanvas(
    Math.round(viewportWidth * dpr),
    Math.round(totalHeight * dpr)
  );
  const ctx = canvas.getContext('2d');

  for (const slice of slices) {
    const res = await fetch(slice.dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    ctx.drawImage(bitmap, 0, Math.round(slice.y * dpr));
    bitmap.close();
  }

  return canvas.convertToBlob({ type: 'image/png' });
}

/* ---------------------------- Area select ---------------------------------- */

async function startAreaSelect() {
  const tab = await getActiveTab();
  await chrome.scripting
    .executeScript({ target: { tabId: tab.id }, files: ['selector/selector.js'] })
    .catch(() => {});
  await chrome.tabs.sendMessage(tab.id, { action: 'ACTIVATE_AREA_SELECT' });
}

async function handleAreaSelected(message, sender) {
  try {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    const dataUrl = await captureVisibleTabDataUrl(windowId);
    const res = await fetch(dataUrl);
    const fullBlob = await res.blob();
    const bitmap = await createImageBitmap(fullBlob);

    const dpr = message.devicePixelRatio || 1;
    const sx = Math.round(message.rect.left * dpr);
    const sy = Math.round(message.rect.top * dpr);
    const sw = Math.round(message.rect.width * dpr);
    const sh = Math.round(message.rect.height * dpr);

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    bitmap.close();

    const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
    const capture = await saveCapture({
      type: 'screenshot',
      name: `screenshot-${timestampForFilename()}.png`,
      mimeType: 'image/png',
      blob: croppedBlob,
      width: sw,
      height: sh
    });

    track('SCREENSHOT_CAPTURED', { feature: 'screenshot', action: 'select_area' });
    await notify('Screenshot captured ✅', 'Your area selection was saved to SatyLens.');
    broadcastGalleryUpdate();
    await openGalleryFocusedOn(capture.id);
  } catch (err) {
    console.error('Area select capture failed:', err);
    track('ERROR_OCCURRED', { feature: 'screenshot', action: 'select_area', success: false, error: err.message });
    await notify('❌ Capture failed', err.message || 'Unable to capture the selected area.');
  }
}

/* ---------------------------- Downloads ------------------------------------ */

async function downloadCapture(capture) {
  const url = URL.createObjectURL(capture.blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `satylens/${capture.name}`,
      saveAs: false,
      conflictAction: 'uniquify'
    });
  } finally {
    // Revoke after a delay — the download API reads the blob async.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/* ---------------------------- Message router -------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'CAPTURE_VISIBLE_TAB': {
          const result = await captureVisibleTab();
          track('SCREENSHOT_CAPTURED', { feature: 'screenshot', action: 'visible_tab' });
          sendResponse({ ok: true, ...result });
          break;
        }
        case 'CAPTURE_FULL_PAGE': {
          const blob = await captureFullPage();
          const capture = await saveCapture({
            type: 'screenshot',
            name: `screenshot-full-${timestampForFilename()}.png`,
            mimeType: 'image/png',
            blob
          });
          track('SCREENSHOT_CAPTURED', { feature: 'screenshot', action: 'full_page' });
          await notify('Screenshot captured ✅', 'Full page screenshot saved to SatyLens.');
          broadcastGalleryUpdate();
          await openGalleryFocusedOn(capture.id);
          sendResponse({ ok: true, id: capture.id });
          break;
        }
        case 'START_AREA_SELECT': {
          await startAreaSelect();
          sendResponse({ ok: true });
          break;
        }
        case 'AREA_SELECTED': {
          await handleAreaSelected(message, sender);
          sendResponse({ ok: true });
          break;
        }
        case 'AREA_SELECT_CANCELLED': {
          sendResponse({ ok: true });
          break;
        }
        case 'DOWNLOAD_CAPTURE': {
          const capture = await CaptureStore.get(message.id);
          if (!capture) throw new Error('Capture not found.');
          await downloadCapture(capture);
          sendResponse({ ok: true });
          break;
        }
        case 'SAVE_CAPTURE': {
          // Used by the popup for the inline visible-tab screenshot flow.
          const capture = await saveCapture(message.capture);
          broadcastGalleryUpdate();
          sendResponse({ ok: true, id: capture.id });
          break;
        }
        case 'NOTIFY': {
          await notify(message.title, message.message);
          sendResponse({ ok: true });
          break;
        }
        case 'OPEN_GALLERY': {
          await openGalleryFocusedOn(message.id || '');
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown action: ' + message.action });
      }
    } catch (err) {
      console.error('Background handler error:', err);
      track('ERROR_OCCURRED', { feature: 'background', action: message.action, success: false, error: err.message });
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'capture-visible-tab') {
      const { dataUrl } = await captureVisibleTab();
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const capture = await saveCapture({
        type: 'screenshot',
        name: `screenshot-${timestampForFilename()}.png`,
        mimeType: 'image/png',
        blob
      });
      track('SCREENSHOT_CAPTURED', { feature: 'screenshot', action: 'keyboard_shortcut' });
      await notify('Screenshot captured ✅', 'Saved via keyboard shortcut.');
      broadcastGalleryUpdate();
      await openGalleryFocusedOn(capture.id);
    }
    if (command === 'toggle-recording') {
      const tab = await getActiveTab();
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`recorder/recorder.html?tabId=${tab.id}`)
      });
    }
  } catch (err) {
    console.error('Command failed:', err);
    track('ERROR_OCCURRED', { feature: 'background', action: command, success: false, error: err.message });
    await notify('❌ Action failed', err.message || 'Something went wrong.');
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log('SatyLens installed.');
  if (details.reason === 'install') {
    track('EXTENSION_INSTALLED', { feature: 'lifecycle' });
  }
  track('EXTENSION_STARTED', { feature: 'lifecycle' });
});

chrome.runtime.onStartup.addListener(() => {
  track('EXTENSION_STARTED', { feature: 'lifecycle' });
});
