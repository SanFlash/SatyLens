// desktop/src/main.js
// Electron main process. Owns window/tray lifecycle, the global shortcut,
// desktopCapturer source listing, key-value settings storage, and the
// area-select overlay window. Actual media capture (getUserMedia) has to
// happen in a renderer/web context -- that's a browser API, not something
// the main process can do -- so this file's job is coordination, not
// capture itself.
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, desktopCapturer, screen, shell, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store({ name: 'satylens-settings' });

let tray = null;
let homeWindow = null;
let overlayWindows = [];
const childWindows = new Map(); // url -> BrowserWindow, so "open editor for X" doesn't spawn duplicates

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

function createHomeWindow() {
  if (homeWindow && !homeWindow.isDestroyed()) {
    homeWindow.show();
    homeWindow.focus();
    return homeWindow;
  }
  homeWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 380,
    minHeight: 500,
    title: 'SatyLens',
    icon: ICON_PATH,
    backgroundColor: '#0a0e1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });
  homeWindow.setMenuBarVisibility(false);
  homeWindow.loadFile(path.join(RENDERER_DIR, 'home', 'home.html'));
  homeWindow.on('closed', () => {
    homeWindow = null;
  });
  return homeWindow;
}

function openRendererWindow(relativeUrl, { width = 1200, height = 820 } = {}) {
  const existing = childWindows.get(relativeUrl);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width,
    height,
    title: 'SatyLens',
    icon: ICON_PATH,
    backgroundColor: '#0a0e1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  const [file, query] = relativeUrl.split('?');
  win.loadFile(path.join(RENDERER_DIR, file), query ? { search: query } : undefined);
  win.on('closed', () => childWindows.delete(relativeUrl));
  childWindows.set(relativeUrl, win);
  return win;
}

/* ============================== Tray ============================== */

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip('SatyLens');
  const menu = Menu.buildFromTemplate([
    { label: 'Open SatyLens', click: () => createHomeWindow() },
    { label: 'Capture Screenshot (Ctrl+Shift+S)', click: () => triggerQuickScreenshot() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => createHomeWindow());
}

function triggerQuickScreenshot() {
  const win = createHomeWindow();
  win.webContents.once('did-finish-load', () => win.webContents.send('trigger-quick-screenshot'));
  if (!win.webContents.isLoading()) win.webContents.send('trigger-quick-screenshot');
}

/* ============================== IPC: capture sources ============================== */

ipcMain.handle('get-capture-sources', async (_evt, types = ['screen', 'window']) => {
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnailDataUrl: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
    appIconDataUrl: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
  }));
});

ipcMain.handle('get-primary-display-size', () => {
  const display = screen.getPrimaryDisplay();
  return { width: display.size.width, height: display.size.height, scaleFactor: display.scaleFactor };
});

/* ============================== IPC: area-select overlay ============================== */

ipcMain.handle('start-area-select', () => {
  return new Promise((resolve) => {
    const display = screen.getPrimaryDisplay();
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false
      }
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.loadFile(path.join(RENDERER_DIR, 'selector', 'selector.html'));
    overlayWindows.push(overlay);

    const cleanup = (result) => {
      overlayWindows = overlayWindows.filter((w) => w !== overlay);
      if (!overlay.isDestroyed()) overlay.close();
      resolve(result);
    };

    ipcMain.once('area-select-result', (_evt, rect) => cleanup(rect));
    overlay.on('closed', () => cleanup(null));
  });
});

/* ============================== IPC: window management ============================== */

ipcMain.handle('open-window', (_evt, relativeUrl, opts) => {
  openRendererWindow(relativeUrl, opts);
  return true;
});

ipcMain.handle('close-current-window', (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (win) win.close();
  return true;
});

ipcMain.handle('broadcast', (evt, channel, payload) => {
  // Mirrors the extension's chrome.runtime.sendMessage broadcast pattern
  // (e.g. "GALLERY_UPDATED") -- fan it out to every other open window.
  const senderId = evt.sender.id;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id !== senderId && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
  return true;
});

ipcMain.handle('open-external', (_evt, url) => {
  shell.openExternal(url);
  return true;
});

/* ============================== IPC: key-value settings (chrome.storage.local shim) ============================== */

ipcMain.handle('store-get', (_evt, keys) => {
  const result = {};
  for (const k of keys) {
    const v = store.get(k);
    if (v !== undefined) result[k] = v;
  }
  return result;
});

ipcMain.handle('store-set', (_evt, entries) => {
  for (const [k, v] of Object.entries(entries)) store.set(k, v);
  return true;
});

/* ============================== IPC: save file to disk ============================== */

ipcMain.handle('save-download', async (_evt, { buffer, filename }) => {
  const fs = require('fs');
  const downloadsDir = path.join(app.getPath('downloads'), 'satylens');
  fs.mkdirSync(downloadsDir, { recursive: true });
  let target = path.join(downloadsDir, filename);
  let counter = 1;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  while (fs.existsSync(target)) {
    target = path.join(downloadsDir, `${base} (${counter})${ext}`);
    counter += 1;
  }
  fs.writeFileSync(target, Buffer.from(buffer));
  return target;
});

/* ============================== App lifecycle ============================== */

app.whenReady().then(() => {
  createTray();
  createHomeWindow();

  const shortcutOk = globalShortcut.register('CommandOrControl+Shift+S', () => triggerQuickScreenshot());
  if (!shortcutOk) console.warn('Could not register global shortcut Ctrl+Shift+S (already in use by another app).');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createHomeWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in the tray on Windows/Linux; on macOS the dock icon
  // convention is to also stay running until the user explicitly quits.
  if (process.platform !== 'darwin') {
    // Intentionally do NOT quit -- the tray icon is the whole point of a
    // capture tool: it should stay available even with no window open.
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
