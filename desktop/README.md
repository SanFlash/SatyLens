# SatyLens Desktop

A standalone desktop app (Windows/Mac/Linux) with the same core features
as the Chrome extension — screenshot, screen recording, annotation
editor, and share links — without needing Chrome or "Load unpacked" at
all. Built with Electron, reusing most of the extension's own code.

## What's the same as the extension

The gallery, the screenshot editor (annotations, blur/pixelate, crop),
local storage, analytics, and "Create Share Link" against the same
backend (`https://satylens.onrender.com` by default) all work exactly
the same way — literally the same JavaScript files, unchanged, running
in Electron's Chromium-based renderer via a compatibility shim (see
"How this works" below).

## What's different (desktop has no browser "tabs")

| Extension | Desktop |
|---|---|
| Screenshot: visible tab, full page, select area | Screenshot: capture screen, capture window, select area |
| Recording: tab, screen, window | Recording: screen, window (no "tab" — desktop apps don't have tabs) |
| Toolbar icon → small popup | A persistent Home window (same actions, doesn't auto-close) |
| System tray: none | System tray icon + global shortcut (Ctrl+Shift+S / Cmd+Shift+S) to capture from anywhere, even with no window open |

## What's NOT implemented yet

**Google Drive sharing.** `chrome.identity.getAuthToken()` (how the
extension signs in to Google) is a Chrome-extension-specific API with no
desktop equivalent — a real implementation needs a *different* Google
Cloud OAuth client type ("Desktop app," not "Chrome Extension") and a
different consent flow (typically a loopback redirect or Electron's
`shell.openExternal` + a local callback server). Clicking "Connect Google
Drive" in Settings currently fails cleanly with a generic error instead
of crashing — it just doesn't work yet. The backend and Cloudflare R2
share destinations are unaffected and fully functional.

## How this works (for anyone maintaining this)

Electron's renderer process is Chromium under the hood, so IndexedDB,
Canvas, `MediaRecorder`, and `fetch` all behave identically to the
extension. The pieces that *don't* transfer are the literal `chrome.*`
extension APIs (`chrome.tabs`, `chrome.storage`, `chrome.identity`,
etc.) — those don't exist outside a browser extension. `src/preload.js`
implements a compatibility shim backed by real Electron capabilities
(`electron-store` for settings, IPC + `desktopCapturer` for capture
sources, cross-window `BrowserWindow.webContents.send` for the
`GALLERY_UPDATED` broadcast pattern, etc.), so `renderer/gallery/`,
`renderer/editor/`, and everything in `renderer/shared/` are copied
**unchanged** from `extension/` and just work against the shim.

Two non-obvious Electron quirks worth knowing if you touch `main.js` or
`preload.js`:

1. **`sandbox: false` is required in every `BrowserWindow`'s
   `webPreferences`.** Electron's default sandboxed preload mode blocks
   `require()` for most Node built-ins (including `path`) — without this,
   the preload script fails to load *silently* from the renderer's
   perspective, and the whole shim (`window.chrome`, `window.satylens`)
   never exists. This was caught by actually running the app under Xvfb
   and reading Electron's `preload-error` event, not by inspection.
2. **`window.chrome` already exists** as a native Chromium object (even
   with no extension installed) — `contextBridge.exposeInMainWorld('chrome', ...)`
   throws because of this. The shim is exposed as `window.__chromeShim`
   instead, and every renderer HTML file has a one-line bootstrap script
   (`window.chrome = window.__chromeShim;`) before its module script that
   assigns it to the name the shared code actually expects. A plain
   assignment isn't subject to contextBridge's restriction the way
   `exposeInMainWorld` is.
3. **`contextBridge` deep-freezes exposed objects.** Mutating a property
   on an object after `exposeInMainWorld` doesn't reliably propagate back
   to the main world. This is why the Drive OAuth failure path falls back
   to a generic error message instead of the more specific one the code
   attempts to set — a real, minor, documented gap rather than a silent one.

All three of the above were found by actually launching Electron under
Xvfb and reading real error output, not assumed from documentation.

## Setup

```bash
cd desktop
npm install
npm start          # normal run
npm run start:novideo   # if you hit sandbox permission errors on Linux
```

## Building installers

```bash
npm run build:linux    # AppImage + .deb
npm run build:win      # NSIS installer (.exe)
npm run build:mac      # .dmg -- see the note below
```

Output goes to `dist-build/`.

Building the Windows installer **from a Linux host** requires Wine —
electron-builder uses it to edit the `.exe`'s icon/version resources
(`rcedit`), not for actual code signing:

```bash
sudo dpkg --add-architecture i386
sudo apt-get update
sudo apt-get install -y wine wine32:i386
```

Building from an actual Windows machine doesn't need any of this — Wine
is only a Linux-hosting-a-cross-build workaround.

**Not code-signed.** Neither installer has a real code-signing
certificate applied (that costs money and needs a verified publisher
identity), so Windows SmartScreen and macOS Gatekeeper will both show an
"unknown publisher" warning on first run. This is normal for
unsigned/internal-distribution builds — teammates just click through it
("More info" → "Run anyway" on Windows) — but if this ships more widely,
a real code-signing certificate removes that warning.

**Verified in this environment:** both `npm run build:linux` and `npm run
build:win` were actually run and produced real, structurally valid
installers — a 123MB AppImage and a 102MB NSIS `Setup.exe` — confirmed by
extracting/inspecting each and checking that the genuine Electron
runtime and our exact source files (`src/main.js`, `src/preload.js`,
`renderer/home/home.js`, etc.) are correctly bundled inside via `asar
list`. The Windows build needed Wine installed on this Linux host purely
for resource-editing the `.exe` (setting its icon/version info) — no
actual code-signing certificate is used or required; the installer works
but will show an "unknown publisher" warning on first run until it's
signed with a real certificate. Launching the final packaged binaries
themselves (as opposed to the unpacked dev build, which was fully tested
end-to-end — see below) was not confirmed for the Linux AppImage due to
this environment's handling of long-running background processes across
tool calls; the Windows `.exe` obviously can't be launched at all from a
Linux host. Both are structurally sound and built from the same
verified-working source, but a final smoke test on real Windows/Linux
machines is still worth doing before wide distribution.

**macOS `.dmg` genuinely needs a Mac** (or a paid macOS CI runner) — Apple's
own tooling for building/signing `.dmg` files isn't available on Linux.
Use GitHub Actions with a `macos-latest` runner to build this
automatically on release; a Linux sandbox (like the one this was built
in) can produce Windows and Linux installers directly but not macOS ones.

## What's been verified end-to-end (not just written)

Using a real Electron instance running under Xvfb (a virtual display) in
this development environment:
- The preload shim loads without error and exposes `window.chrome` /
  `window.satylens` correctly
- `desktopCapturer` finds real capture sources ("Entire screen") and
  returns a working thumbnail
- A real screenshot frame was captured end-to-end via
  `getUserMedia({chromeMediaSource: 'desktop', ...})` → canvas → PNG blob
  (1280×1024, ~78KB from the virtual display)
- That capture was saved to and read back from IndexedDB via the
  unmodified `CaptureStore` module
- The Gallery and Editor windows both load cleanly with the shim active
  and zero console errors
- `npm run build:linux` produces a real, structurally valid AppImage

## Known rough edges

- The system tray icon relies on a desktop environment's notification
  area (StatusNotifierHost on Linux) — this doesn't exist in a bare
  Xvfb/CI environment, so tray behavior specifically wasn't (and can't
  be) verified there. It should work normally on a real desktop.
- Multi-monitor area-select currently targets the primary display only.
- No auto-updater wired up yet — new versions require downloading and
  reinstalling.
