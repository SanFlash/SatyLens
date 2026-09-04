// desktop/src/preload.js
// Exposes a chrome.*-shaped shim so the bulk of the existing extension
// code (gallery.js, editor.js, shared/storage.js, shared/analytics.js,
// shared/api.js, shared/r2.js, shared/share.js) runs on desktop with
// zero or near-zero changes -- each call is backed by a real Electron
// capability instead of a browser-extension API that doesn't exist here.
//
// Deliberately NOT implemented: chrome.identity (Google Drive OAuth).
// Rather than silently breaking or requiring gallery.js/drive.js changes,
// getAuthToken always fails with a clear, friendly error message that
// surfaces through drive.js's existing error handling as a normal toast
// -- "Google Drive is not available in the desktop app yet." Adding real
// desktop OAuth (a different Google Cloud client type entirely) is future
// work, tracked in desktop/README.md.
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const packageJson = require(path.join(__dirname, '..', 'package.json'));

const messageListeners = new Set();
ipcRenderer.on('runtime-message', (_evt, msg) => {
  for (const cb of messageListeners) cb(msg);
});

// Defined as a standalone object (not inline in the exposeInMainWorld call)
// so identityApi.getAuthToken below can close over this SAME object
// reference and mutate `lastError` on it -- contextBridge proxies nested
// object references, so a mutation here is visible to main-world code
// reading chrome.runtime.lastError afterward. Verified empirically with
// a real Electron run under Xvfb, not just assumed.
const runtimeApi = {
  lastError: null,
  getURL: (p) => p,
  getManifest: () => ({ version: packageJson.version }),
  sendMessage: (msg, cb) => {
    ipcRenderer.invoke('broadcast', 'runtime-message', msg).catch(() => {});
    if (cb) cb({ ok: true });
    return Promise.resolve({ ok: true });
  },
  onMessage: {
    addListener: (cb) => {
      messageListeners.add((msg) => cb(msg, {}, () => {}));
    }
  }
};

const identityApi = {
  getAuthToken: (_opts, cb) => {
    runtimeApi.lastError = {
      message: 'Google Drive is not available in the SatyLens desktop app yet.'
    };
    cb(undefined);
  },
  removeCachedAuthToken: (_opts, cb) => {
    if (cb) cb();
  }
};

contextBridge.exposeInMainWorld('__chromeShim', {
  runtime: runtimeApi,

  tabs: {
    create: (opts) => {
      if (opts && opts.url) ipcRenderer.invoke('open-window', opts.url);
      return Promise.resolve({});
    },
    query: (_opts, cb) => {
      if (cb) cb([]);
      return Promise.resolve([]);
    }
  },

  storage: {
    local: {
      get: (keys, cb) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        ipcRenderer.invoke('store-get', keyList).then((result) => cb(result));
      },
      set: (obj, cb) => {
        ipcRenderer.invoke('store-set', obj).then(() => cb && cb());
      }
    }
  },

  notifications: {
    create: (opts, cb) => {
      try {
        // eslint-disable-next-line no-new
        new Notification(opts.title || 'SatyLens', { body: opts.message || '' });
      } catch (_) {
        /* notifications may be unavailable/denied at the OS level -- non-fatal */
      }
      if (cb) cb('desktop-notification');
    }
  },

  identity: identityApi
});

/* ============================== Desktop-specific bridge ============================== */
// Everything below is new surface area the desktop-only renderer code
// (home.js, selector.js, recorder.js's source picker) uses directly --
// it's not part of the chrome.* shim because there's no extension
// equivalent to shim against.
contextBridge.exposeInMainWorld('satylens', {
  getCaptureSources: (types) => ipcRenderer.invoke('get-capture-sources', types),
  getPrimaryDisplaySize: () => ipcRenderer.invoke('get-primary-display-size'),
  startAreaSelect: () => ipcRenderer.invoke('start-area-select'),
  sendAreaSelectResult: (rect) => ipcRenderer.send('area-select-result', rect),
  openWindow: (url, opts) => ipcRenderer.invoke('open-window', url, opts),
  closeCurrentWindow: () => ipcRenderer.invoke('close-current-window'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onQuickScreenshot: (cb) => ipcRenderer.on('trigger-quick-screenshot', cb),
  saveDownload: async (blob, filename) => {
    const buf = await blob.arrayBuffer();
    return ipcRenderer.invoke('save-download', { buffer: Array.from(new Uint8Array(buf)), filename });
  }
});
