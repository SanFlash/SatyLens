# SatyLens

Capture. Record. Share. — a Chrome extension (Manifest V3) for screenshots
and screen recordings, with a FastAPI + Supabase backend for generating
public shareable links.

## Features

**Screenshot**
- Visible tab, full page (auto-scroll + stitch), and drag-to-select area
- Inline preview with Copy to clipboard, Download, Edit, Save to Gallery, Create Share Link

**Screenshot editor** (opens in its own tab from the popup preview or the gallery)
- Independent, editable annotation objects — not baked into pixels until export: Text, Arrow, Line, Rectangle, Rounded Rectangle, Circle, Freehand draw, Highlight (solid or transparent, rectangle or freehand), Blur, Pixelate, Crop
- Every object supports select / move / resize / rotate (where applicable) / duplicate / delete / reorder (front, back, forward, backward)
- Text styling: font family/size, bold/italic/underline, alignment, text + background color/opacity
- Shape styling: stroke color/width, fill color/opacity, corner radius, drop shadow
- Import PNG/JPG/SVG assets onto the canvas (logos, stickers, custom shapes)
- Whole-image rotate (90°) and resize dialog
- 40-step undo/redo, zoom, keyboard shortcuts (V/T/A/L/R/C/P/H/X for tools, Ctrl+Z/Shift+Z undo/redo, Ctrl+D duplicate, Delete)
- Download, Save to Gallery (updates the capture in place), or Create Share Link — reuses the existing upload pipeline

**Screen recording**
- Record current tab, a chosen window, or the entire screen
- Optional microphone + tab/system audio (mixed via Web Audio)
- Pause/resume, live timer, preview with playback

**Gallery**
- IndexedDB-backed local library (works fully offline)
- Search, filter (All / Screenshots / Recordings), sort (newest/oldest/largest/smallest)
- Per-capture Download, Copy, Share, Delete

**Sharing**
- "Create Share Link" uploads to any of three destinations, chosen in Settings:
  - The FastAPI + Supabase backend (default) — returns
    `https://your-domain.com/s/abc123xyz`, opens in any browser, no
    extension required
  - **Google Drive** — connect a Google account (OAuth via
    `chrome.identity`, no client secret ever touches the extension),
    pick a folder, and get a Drive share link instead. See
    [`GOOGLE_DRIVE_SETUP.md`](GOOGLE_DRIVE_SETUP.md).
  - **Cloudflare R2** — uploads go **directly from the browser to R2**
    via a short-lived presigned URL (the file bytes never pass through
    the backend, which matters most for large recordings), then the
    backend verifies the object actually landed in R2 — never trusting
    the browser's word alone — before the share link goes live. Served
    through the same `/s/{id}` viewer as the backend destination, with
    view/download counters and link revocation/expiration. See
    [`R2_SETUP.md`](R2_SETUP.md).
- Automatic, meaningful filenames (`Screenshot_2026-08-14_14-35-22.png`)
- Upload progress, retry-by-reclicking, and a duplicate-upload guard (an
  already-shared capture returns its existing link instead of
  re-uploading)
- Nothing uploads automatically — always an explicit "Create Share Link" click
- **Link History** (🔗 icon in the Gallery) — recent Cloudflare R2 share
  links for this installation, with Copy / Open / Revoke actions and
  view/download counts. Currently R2-only: the backend and Drive
  destinations don't yet record the anonymous installation ID needed to
  scope a history view — the Gallery itself remains the complete,
  all-destinations view of everything you've captured and shared

**Analytics** (opt-out anytime in Settings)
- Anonymous, coarse product usage analytics: which features get used, how
  often, on which extension/browser versions — never page URLs, page
  content, keystrokes, or precise location
- A random locally-generated ID stands in for identity; it's never your
  Google account, email, or IP address
- Fully asynchronous and non-blocking: if the analytics backend is slow,
  unreachable, or misconfigured, every core feature (screenshots,
  recordings, editing, sharing) keeps working exactly as before —
  failed sends are queued locally and retried, never dropped silently
  and never surfaced as an error to you
- A live **admin dashboard** (`GET /dashboard` on the backend) shows daily/
  weekly/monthly active users, feature usage, screenshot/recording/upload
  trends, error rates, version adoption, and a per-user activity timeline
- Settings includes a plain-language "what's collected" disclosure, an
  on/off toggle, and a "Clear local telemetry data" button that also
  rotates your anonymous ID

## Architecture

```
Chrome Extension (MV3, vanilla JS)
        |
        | HTTPS (only on "Create Share Link")
        v
FastAPI Backend
        |
        +------> Supabase Storage   (capture files)
        +------> Supabase Postgres  (capture metadata)
```

The Supabase **service-role key never leaves the backend** — it is not
present anywhere in the extension source, manifest, or JS bundle.
Screenshot/recording capture, the local gallery, and downloads all work
completely offline; only creating a share link requires network access.

## Project structure

```
satylens/
├── extension/            Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── background/       service worker: capture orchestration, messaging
│   ├── popup/             popup UI (visible-tab screenshot flow)
│   ├── recorder/          dedicated tab for screen recording
│   ├── selector/          content script: drag-to-select overlay
│   ├── gallery/           full gallery page
│   ├── shared/             api.js, storage.js (IndexedDB), clipboard.js, utils.js
│   └── icons/
├── backend/               FastAPI service
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── routes/        upload.py, share.py, health.py
│   │   ├── services/      storage.py (Supabase), sharing.py (share IDs)
│   │   ├── models/        capture.py (Pydantic schemas)
│   │   └── templates/     share.html (public viewer page)
│   ├── tests/              pytest suite (mocked Supabase)
│   ├── requirements.txt
│   └── .env.example
├── supabase/
│   ├── schema.sql          captures table + RLS
│   └── SETUP.md            bucket + table setup walkthrough
└── .gitignore
```

## Installation

### 1. Backend

See [`backend/README.md`](backend/README.md) for full instructions.
Quick start (Windows PowerShell):

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --port 8000
```

The screenshot/recording/gallery features all work immediately, even
before you touch Supabase — only "Create Share Link" needs it configured
(see below).

### 2. Supabase

Follow [`supabase/SETUP.md`](supabase/SETUP.md) to create the `captures`
table (via `supabase/schema.sql`) and the `captures` storage bucket, then
fill in `backend/.env`.

### 3. Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Copy the generated **extension ID** and add it to
   `backend/.env` as `ALLOWED_EXTENSION_ORIGINS=chrome-extension://<id>`,
   then restart the backend.
6. Click the SatyLens icon in the toolbar.

## How to run

1. Start the backend (`uvicorn app.main:app --reload --port 8000`).
2. Load the extension unpacked (above).
3. Click the toolbar icon → try **Visible Tab** for an instant screenshot.
4. Open the **Gallery** (⧉ icon in the popup, or the "View Gallery →" link)
   to see everything you've captured.

## Permissions used (and why)

| Permission | Why SatyLens needs it |
|---|---|
| `activeTab` / `tabs` | Identify and capture the current tab |
| `scripting` | Inject the area-select overlay and page-metrics script on demand |
| `storage` | Store the small API base URL setting (not blobs — those go in IndexedDB) |
| `clipboardWrite` | Copy screenshots to the system clipboard |
| `downloads` | Save screenshots/recordings to disk via the Downloads API |
| `notifications` | Toast-style confirmations ("Screenshot captured ✅", etc.) |
| `desktopCapture` / `tabCapture` | Screen/window/tab recording via `getDisplayMedia`/`tabCapture` |
| `identity` | Google Drive OAuth via `chrome.identity.getAuthToken()` — only used when you connect Drive in Settings |
| `host_permissions` (`https://*/*`) | Needed so the content script can run the area-selector on any page you're capturing; the backend call itself only ever targets your configured `API_BASE_URL` |

No permission requests `<all_urls>` for anything beyond what the
area-selector and page-metrics content script legitimately need.

## Testing checklist

**Screenshot**
- [ ] Visible tab capture
- [ ] Selected area capture (drag overlay)
- [ ] Full page capture (scroll + stitch)
- [ ] Copy to clipboard → paste into another app
- [ ] Download
- [ ] Save to local gallery
- [ ] Upload / Create Share Link
- [ ] Open share URL in a different browser

**Recording**
- [ ] Start / Stop
- [ ] Pause / Resume
- [ ] Preview playback
- [ ] Download
- [ ] Save to local gallery
- [ ] Upload / Create Share Link
- [ ] Microphone toggle (incl. permission-denied fallback)
- [ ] Tab/system audio toggle

**Gallery**
- [ ] Search
- [ ] Filter by type
- [ ] Sort (newest/oldest/largest/smallest)
- [ ] Open detail modal
- [ ] Delete
- [ ] Download
- [ ] Copy share link

**Google Drive** (all verified with automated headless-Chrome tests — see Changelog)
- [ ] Connect Google Drive (OAuth consent)
- [ ] Account email displays correctly in Settings
- [ ] List/select an existing folder
- [ ] Create a new folder
- [ ] Upload with progress reporting
- [ ] Generated link opens and is viewable by someone without Drive access
- [ ] Re-clicking "Create Share Link" on an already-uploaded capture reuses the link (no duplicate upload)
- [ ] Disconnect clears the connection, account, and folder selection
- [ ] Token expiration mid-session triggers a silent refresh (or a clear reconnect prompt if refresh fails)

**Analytics** (all verified with automated headless-Chrome + pytest tests — see Changelog)
- [ ] Screenshot/recording/upload/edit actions produce the correct event type and feature/action labels
- [ ] Opt-out toggle makes tracking a complete no-op
- [ ] "Clear local telemetry data" wipes the queue and rotates the anonymous ID
- [ ] A failed or offline send keeps the event queued for retry (never silently lost)
- [ ] Analytics backend being unreachable never blocks or errors a core feature
- [ ] Dashboard (`/dashboard`) loads, charts render, and per-user drill-down works
- [ ] Reporting endpoints reject requests when `ANALYTICS_DASHBOARD_TOKEN` is set and no/wrong token is supplied
- [ ] Ingestion endpoints (`/api/events`, `/api/session/*`) never require a token

**Cloudflare R2** (all verified with automated headless-Chrome + pytest tests — see Changelog)
- [ ] Screenshot upload: request presigned URL → direct PUT to R2 → complete → working share link
- [ ] Recording upload: same flow, large file
- [ ] Upload progress reported during the direct-to-R2 PUT phase
- [ ] Presigned URL expiration (403 from R2) surfaces a clear, retry-able error
- [ ] `/api/media/complete` rejects an object_key mismatch
- [ ] `/api/media/complete` rejects when R2 doesn't actually have the object yet (never trusts the client's word)
- [ ] `/api/media/complete` records R2's real reported file size, not the client's claim
- [ ] Generated `/s/{id}` link works in a browser with no extension installed
- [ ] Link History panel lists R2 uploads with correct view/download counts
- [ ] Revoking a link makes `/s/{id}` show the "unavailable" state immediately
- [ ] Setting an expiration makes `/s/{id}` show the "expired" state after it passes
- [ ] Deleting a share removes both the R2 object and the database row
- [ ] R2 credentials never appear anywhere in the extension source or network requests it makes

**Errors**
- [ ] No network during upload → "Upload failed. Your capture is safely stored locally."
- [ ] Permission denied (mic / screen share)
- [ ] File too large (`MAX_FILE_SIZE_MB`) → HTTP 413
- [ ] Restricted Chrome page (`chrome://...`) → clear in-UI error, no crash
- [ ] Backend down → clean error, capture stays local
- [ ] Invalid upload MIME type → HTTP 400

**Backend automated tests**: `cd backend && pytest -v` (14 tests, all passing —
covers health, upload validation, size limits, share ID uniqueness, share
retrieval/deletion, and the "Supabase not configured" path).

## Known Chrome limitations

- **Restricted pages**: `chrome://`, the Chrome Web Store, and other
  extension pages cannot be captured or scripted — SatyLens detects
  this up front and shows a clear error instead of failing silently.
- **Full-page capture**: relies on `captureVisibleTab`, which Chrome
  rate-limits to a couple of calls per second — full-page capture on very
  long pages takes a few seconds and briefly scrolls the page.
- **Tab/system audio while recording**: availability depends on your OS
  and what you pick in Chrome's share dialog; SatyLens never claims
  audio capture works universally and degrades gracefully when it can't
  get it.
- **Recording UI runs in its own tab**, not the popup — selecting a
  screen/window/tab in Chrome's native picker takes focus away from the
  extension, which would otherwise instantly close a popup.

## Security considerations

- The Supabase **service-role key lives only in the backend's `.env`** —
  never in the extension, and `.env` is git-ignored.
- Share IDs are generated with `secrets.token_urlsafe()` — cryptographically
  unpredictable, not sequential/guessable.
- Uploads are validated on MIME type, file extension, and size
  (`MAX_FILE_SIZE_MB`, default 100MB, returns HTTP 413 if exceeded).
- Nothing is uploaded automatically — captures stay local until the user
  explicitly clicks "Create Share Link".
- CORS is restricted to the extension's own `chrome-extension://` origin(s)
  — production deployments should never use `allow_origins=["*"]`.
- The database schema enables Row Level Security with a deny-all policy as
  defense in depth (the backend's service-role key bypasses RLS by design).
- **Google Drive**: OAuth uses `chrome.identity.getAuthToken()`, the flow
  Google recommends specifically for Chrome extensions — the manifest
  holds only a public OAuth `client_id`, never a client secret, and Chrome
  itself brokers the token exchange. The requested scope
  (`drive.file`) is deliberately narrow: the app can only see files it
  creates, never the rest of your Drive. Uploaded files are marked
  "anyone with the link can view" so links work outside the connected
  account — see [`GOOGLE_DRIVE_SETUP.md`](GOOGLE_DRIVE_SETUP.md) for the
  full rationale and setup steps.
- **Analytics**: `client_id` is a random UUID generated and stored
  locally — never a Google account ID, email, or IP address. No page
  URLs, page content, keystrokes, or precise location are ever collected.
  Ingestion endpoints (`/api/events`, `/api/session/*`) are always open so
  telemetry can never block the extension; the reporting/dashboard
  endpoints (`/api/analytics/*`, `GET /dashboard`) are gated by an
  *optional* `ANALYTICS_DASHBOARD_TOKEN` — left unset they're open, but
  setting one is strongly recommended before deploying anywhere public.
  Coarse country (if resolvable at all) comes only from infrastructure
  headers at request time; raw IPs are never persisted.
- **Cloudflare R2**: `R2_SECRET_ACCESS_KEY` and `R2_ACCESS_KEY_ID` live
  only in the backend's `.env` — the extension only ever receives a
  short-lived presigned URL scoped to one specific object, never
  long-lived credentials. `POST /api/media/complete` never trusts the
  client's claim that an upload succeeded: it calls R2's `head_object`
  directly and records R2's own reported file size, not whatever the
  browser sent. Object keys are always server-generated UUIDs under a
  sanitized path (`screenshots/{client_id}/{yyyy}/{mm}/{uuid}.ext`) —
  the client never chooses an R2 path, which is what rules out path
  traversal. The bucket stays private by default; every access (viewer,
  download) goes through a short-lived presigned GET
  (`R2_PRESIGNED_DOWNLOAD_EXPIRY`, default 1 hour) rather than a public
  bucket URL. See [`R2_SETUP.md`](R2_SETUP.md) for the full CORS/bucket
  rationale.

## Future improvements

- Share link expiration/revocation now has working backend support
  (`POST /api/media/{id}/expire`, `POST /api/media/{id}/revoke`,
  enforced by every read path in `app/routes/share.py`) — currently
  exposed in the extension UI only for Cloudflare R2 links (Gallery →
  Link History). The same UI for backend/Supabase-destination shares is
  still open.
- Authenticated galleries / multi-device sync
- Video re-encoding/compression before upload for large recordings
- Configurable keyboard shortcuts UI (Chrome's `chrome://extensions/shortcuts`
  page already supports remapping the two built-in commands)
- Drag-to-reorder / bulk actions in the gallery
- Editor: rotation support for freehand/line/arrow objects (currently only
  bbox-based objects — text, shapes, images — support rotation)
- Editor: multi-select and group transforms
- Google Drive: nested-folder browsing (currently root-level folders only,
  plus create-new-folder)
- Analytics: replace the Python-side aggregation in
  `app/services/analytics.py` with Postgres materialized views/scheduled
  rollups if event volume ever gets large enough for that to matter — the
  current approach (time-windowed queries aggregated in Python) is the
  simplest thing that works at extension-analytics scale, not the most
  scalable one
- R2: true multipart/resumable upload for very large recordings (current
  flow is a single presigned PUT, which R2/S3 caps around 5GB per
  object — fine for typical screen recordings, not unlimited)
- R2/Drive: extend the anonymous `client_id` scoping that R2's Link
  History uses to the backend/Drive destinations too, so Link History
  becomes a single cross-destination view instead of R2-only
- A formal `StorageProvider` interface behind R2/Supabase/Drive, so a
  fourth destination (S3, GCS, Azure Blob) could be added without
  touching `shared/share.js`'s dispatch logic — today each destination's
  module (`r2.js`, `drive.js`, `api.js`) is independently shaped rather
  than implementing a shared interface
- Screenshot collage builder is the one remaining planned phase

## Changelog

**v1.13.0 — Fixed irregular gallery card sizing**

Found by a screenshot showing the actual problem: gallery cards with
dead space below their content, cards misaligned within the same row.
Root cause was a classic, easy-to-miss CSS Grid pitfall: grid items
default to `align-items: stretch`, so every card in a row gets force-
stretched to match the row's *tallest* card — and since `.cf-card`
(a flex column) doesn't distribute that extra height among its own
children, the difference just became blank space at the bottom of
shorter cards.

- **Fixed**: added `align-items: start` to the grid, so each card sizes
  to its own natural content height instead of stretching to match
  whichever card in its row happens to be tallest.
- **Changed**: thumbnail aspect ratio from `16:10` (landscape) to `3:4`
  (portrait) — every card, screenshot or recording, now renders at
  exactly the same fixed ratio regardless of the source capture's actual
  dimensions, so the grid looks uniform instead of driven by whatever
  shape each screenshot happened to be.
- **Changed**: thumbnail cropping now anchors to the top of the source
  image (`object-position: top`) rather than the center — for a
  screenshot, the most identifying content (a page title, a window's
  header) is almost always near the top, so this keeps "which capture is
  this" recognizable even when a wide or tall original gets cropped down
  to fit the fixed box.
- Tapping a card already opened the full, un-cropped content in a detail
  view (unchanged) — confirmed this still shows the real image/video with
  no forced aspect-ratio cropping, distinct from the grid's thumbnail.
- Verified with 5 checks against three deliberately different source
  image shapes (a very wide screenshot, a very tall one, a square one) —
  confirmed every resulting thumbnail renders at exactly 3:4 (ratio
  0.750 for all three) and the dead-space gap below card content is
  effectively zero (1px, rounding) — not just "looks right" on one lucky
  test case.

**v1.12.0 — Universal audio playback, mic mute, live transcription**

- **Fixed: couldn't hear system/tab audio while recording, in Screen and
  Window mode specifically.** The earlier fix (`restoreTabAudioPlayback`)
  only applied to Tab/Area recording — Screen and Window mode never got
  it, since Chrome silences a captured source's audio output to the user
  for as long as it's being captured. Centralized the fix
  (`restoreLocalAudioPlayback`) so all four recording modes get it.
  Verified live across Screen/Window/Tab/Area: an `AudioContext` for
  local playback is genuinely created in every mode, not just some.
- **Added: a way to actually respect mute state in meetings** (Google
  Meet, Zoom, Teams, etc.) — with an honest limitation stated plainly
  rather than glossed over. No browser or extension API can detect
  whether a meeting app's own internal mute button is active, so full
  automatic mute-syncing isn't possible. What *is* true already, with
  nothing to build: another participant's mute state is inherently
  respected, since a muted participant's audio was never rendered by the
  meeting app in the first place, and tab-audio capture only records
  what's actually rendered. What needed building: your *own* mute state,
  since our separate microphone capture has no visibility into the
  meeting app's mute button at all. Added a "Mute My Mic" button that
  appears during recording so you can mirror your in-meeting mute action
  with one click.
  - **A real bug surfaced and fixed during verification, not just
    claimed working**: the first implementation (toggling
    `MediaStreamTrack.enabled`) looked correct by every visible signal
    (button label changed, state flag flipped) but a direct audio-signal
    measurement showed recorded energy did *not* actually drop —
    `track.enabled` doesn't reliably silence output flowing through a
    `MediaStreamAudioSourceNode` in the mixing graph. Replaced with an
    explicit `GainNode` dedicated to the mute control (separate from the
    existing anti-clipping gain), which directly controls signal
    amplitude rather than depending on track-level state propagation.
    Verified with a same-`AudioContext` signal tap: energy measured
    0.58 → **exactly 0** after muting, confirmed back to full level on
    unmute.
- **Added: optional live transcription**, clearly scoped rather than
  oversold. Chrome's Web Speech API only transcribes microphone input —
  there's no standard way to feed it tab/system audio — so this
  transcribes what *you* say into your mic, live, while recording; not
  other meeting participants. Labeled that way everywhere it appears in
  the UI. Auto-restarts if Chrome's speech recognition times out during a
  longer session, so it doesn't silently stop partway through a meeting.
  Transcript is saved with the recording and downloadable as a `.txt`
  file. Verified end-to-end with a mocked recognition session: starts on
  toggle, live panel updates with transcribed text, download button
  appears after stopping with content.
- All three verified with 15 automated checks — including one real
  self-caught bug (the mute implementation above) that would have shipped
  silently broken had it only been checked by "does the button say the
  right thing," not by measuring the actual audio signal.

**v1.11.0 — Fixed the text-editing alignment bug**

Found by a screenshot you sent showing exactly the issue: while typing
text, the canvas was drawing a **second, stale selection-handle overlay**
on top of the actual textarea, misaligned from it. Root cause: `render()`
draws selection handles for whichever object is selected — but the
object being actively text-edited is *also* the selected object, so it
was getting canvas-drawn handles at the same time its real position was
being shown by the separate textarea overlay. Two bugs compounded this:
the handles were being drawn at all during editing (should never happen
— the textarea's own dashed border already shows selection), and even if
they had been suppressed correctly, they'd have gone stale anyway since
resizing the textarea updated the object's size without ever triggering
a re-render.

- **Fixed**: selection handles no longer draw on the canvas while a text
  object is being actively edited. Verified by scanning the canvas
  pixel-by-pixel for the selection outline's accent-blue color during
  active editing — confirmed completely absent (previously present).
- **Fixed**: the resize-observer sync now triggers a re-render, so if a
  code path *does* need handles drawn during a resize, they won't lag
  behind anymore either.
- **Added**: a small drag handle at the box's corner, so it can now be
  **moved while still actively being typed into** — previously only
  resizing (not moving) was possible mid-edit; you had to click away,
  switch to the Select tool, and drag. Careful implementation detail:
  the handle calls `preventDefault()` on its own `mousedown` so grabbing
  it doesn't blur (and thus prematurely commit/close) the textarea.
  Verified pixel-exact: dragging the handle by (80, 40) screen pixels
  moved the box by exactly (80, 40), with the typed text still intact
  and the editor still open afterward.
- Verified with 8 new checks (including confirming double-click re-edit
  and the earlier blur/text-wrap fixes all still work correctly
  together, not just this fix in isolation) — zero regressions.

**v1.10.0 — Tab audio, editor precision tools, compact popup**

- **Tab/system audio recording — improved, with an honest caveat.**
  Two changes to `extension/recorder/recorder.js`, both verified
  against Chrome's own current API documentation (not guessed):
  - `chrome.tabCapture.getMediaStreamId()` now explicitly passes
    `consumerTabId` (the recorder page's own tab). This was previously
    left implicit, relying on a "same render process as the caller"
    heuristic that Chrome's docs describe as version-dependent — audio
    capture is documented as more restrictive than video here, so this
    removes a real source of ambiguity. Verified via a mock test that the
    call is now made correctly and the resulting stream still carries
    both tracks.
  - Chrome silences a captured tab's own audio output to the user for as
    long as it's being captured (documented behavior, same mechanism as
    `getDisplayMedia`'s `suppressLocalAudioPlayback`) — the tab goes
    completely silent the moment recording starts. That's very easy to
    mistake for "audio isn't being captured" even when the recorded
    stream is fine. Added the officially-recommended fix: reconnect the
    captured audio through a live `AudioContext` back to the speakers, so
    the tab keeps sounding normal while it's being recorded.
  - **Honest limitation**: `chrome.tabCapture` fundamentally cannot be
    exercised in this development environment — it requires a real
    loaded extension, a real Chrome browser, and a real user-invocation
    gesture, none of which a sandboxed test script can produce. The two
    fixes above are the correct, documentation-verified changes to make,
    and passed every check that *is* possible to automate (correct API
    call shape, stream still has both tracks, no exceptions), but if tab
    audio still doesn't come through after this, that needs a real
    from-the-extension repro — which specific mode (Tab/Screen/Window/
    Area), and whether the "audio wasn't included" warning toast
    appeared — to diagnose further.
- **Editor: precision drawing tools.**
  - Arrow-key nudging for the selected object (1px per press, 10px with
    Shift) — previously the only way to fine-tune a position was to
    re-drag with the mouse.
  - Hold Shift while drawing a rectangle/circle to constrain it to a
    perfect square/circle.
  - Hold Shift while drawing a line/arrow to snap it to the nearest 45°
    increment (perfectly horizontal, vertical, or diagonal).
  - Both shift-constraints verified with pixel-exact checks: a
    Shift-drawn "square" measured 103×103 (from an unconstrained 100×40
    drag), a Shift-drawn "horizontal" line measured 3px of vertical
    drift over a 60px span (from an 8px-off-horizontal drag).
- **Popup: compacted from 480px to 320px tall** (a real, measured
  reduction — not just visually estimated) while keeping every feature
  accessible, including the "Record Selected Area" button added last
  version that had pushed the Record section to two rows. Record button
  labels shortened (`Record Tab` → `Tab`, etc., with the full label still
  available as a hover tooltip) to fit four across in one row again;
  spacing tightened throughout; recent-capture thumbnails shrunk from
  large square tiles to a compact fixed height.

**v1.9.0 — Recording audio, text editing, and area recording**

- **Fixed: recording couldn't reliably capture system/screen audio
  together with microphone audio.** Two real bugs in
  `extension/recorder/recorder.js`:
  - `getDisplayMedia`'s audio request used default speech-processing
    constraints (echo cancellation, noise suppression, auto-gain) —
    these are meant for a microphone and can measurably degrade or
    silence system/desktop audio. Now requests explicit constraints with
    those turned off for system audio, while the microphone stream keeps
    them on (correct for voice).
  - Mixing mic + system audio via Web Audio had no headroom management —
    two simultaneously loud sources could clip. Verified concretely with
    synthetic full-scale test tones (32% of samples clipping, peak 1.5x
    over full scale) before the fix; replaced a naive static gain
    reduction with a proper limiter (`DynamicsCompressorNode`) and
    re-verified: 0% clipping, healthy signal level, peak safely under 1.0.
  - Added an honest, mode-aware warning when requested audio doesn't
    actually get included (a real, common case — e.g. sharing a Window
    instead of "Entire Screen," forgetting to tick Chrome's own "Share
    audio" checkbox, or macOS's hard OS-level inability to capture system
    audio at all) instead of silently continuing with video only.
- **Fixed: text annotations couldn't be re-edited or properly resized.**
  The core gap: once a text box was committed, there was no way to fix a
  typo or add a word — you could move/resize the box but never touch the
  actual text again short of deleting and recreating it. Added
  double-click-to-re-edit on any existing text object. Also fixed a
  line-height mismatch between the live editing view and the final
  canvas render (caused by the CSS `font` shorthand silently resetting
  `line-height` to `normal`), made the textarea natively resizable with
  the resulting size synced live back to the object, and made property
  panel changes (font size, color, bold, etc.) apply to the textarea in
  real time while actively typing instead of only becoming visible after
  clicking away.
- **Changed: "Select Area" screenshots now open the editor directly**
  instead of the gallery — the capture is still saved to the gallery in
  the background either way, but drawing a precise region is almost
  always "I'm about to annotate this," so this skips the extra click.
- **Added: "Record Selected Area"** — a new recording mode alongside
  Tab/Screen/Window. Browsers have no native "record just this
  rectangle" API, so this reuses the existing screenshot area-select
  overlay to get a region, then crops a full tab capture to that region
  in real time via a hidden `<video>` + `<canvas>` pipeline
  (`canvas.captureStream()` feeds `MediaRecorder`, same as every other
  recording mode from there). Verified with a pixel-exact test: a
  synthetic tab with a precisely-positioned colored square, selected
  exactly, confirmed the recorded output is uniformly that color at both
  the center *and* corner of the frame — proving the crop offset/sizing
  math is genuinely correct, not just "runs without crashing."
- All four changes verified with real, functional tests — not just code
  review — including live audio-signal analysis via `AnalyserNode`,
  pixel-level canvas inspection, and a full page-load regression pass
  across all five extension pages (including both new recorder URL
  shapes). Two real bugs were caught *by* this testing process itself
  (not just in the app): the line-height CSS shorthand issue above, and
  an earlier version of the audio fix that needed a limiter instead of a
  fixed gain cut once synthetic full-scale test tones exposed the gain
  cut wasn't enough headroom.

**v1.8.0 — Screenshot editor: annotation fixes**

Five real bugs found by reading through the full editor implementation
and verified with pixel-level rendering tests (not just code review or
trust in the fix) — every claim below was checked against actual
`getImageData()` output from a running editor instance, and three of my
own test assumptions turned out to be wrong along the way (caught and
corrected before concluding anything about the app itself — see the
inline commit history / this session's notes for the specifics).

- **Fixed: blur annotation was distorting the image.** A canvas-sizing
  mismatch in `drawBlurRegion()` caused the blurred region to render as a
  stretched/zoomed version of the underlying content instead of a clean
  blur — a real problem for a feature people rely on to hide passwords,
  emails, and API keys. Now samples a padded region (clamped to the base
  image's bounds) and draws back only the true dimensions, eliminating
  both the stretching and the edge-darkening artifact a naive fix
  would've introduced. Verified pixel-exact: content 5px inside the blur
  box reads exactly unmodified original color, with a genuine blend only
  at the true boundary.
- **Fixed: text never wrapped.** The editing `<textarea>` overlay wraps
  naturally as you type, but the canvas renderer never wrapped at all —
  committed text could silently overflow far past its box, looking
  nothing like the editing preview. Added real word-wrap
  (`wrapTextLines()`), used consistently by both the renderer and the
  auto-height calculation. Verified: a long sentence renders across
  multiple distinct lines instead of one unbroken overflowing line.
- **Fixed: freehand strokes selected via their bounding box, not the
  actual line.** Clicking empty space near a diagonal freehand stroke
  selected it anyway, since hit-testing only checked the bbox. Added
  proper stroke-proximity hit-testing (point-to-segment distance across
  the stroke's actual path), matching how line/arrow objects already
  worked. Verified: empty bbox space now correctly misses; the real
  stroke still hits.
- **Fixed: resizing a text box didn't scale the font.** Every other
  object type visibly resizes when dragged; text just changed its
  bounding box while the glyphs stayed the same size, which read as
  broken. Height-inclusive resize handles (corners, N/S) now scale font
  size proportionally; width-only handles (E/W) still just adjust the
  wrap width without touching font size, so both are independently
  useful.
- **Fixed: the editor never returned to the Select tool after committing
  text.** Every other annotation tool (rect, line, freehand, ...)
  auto-returns to Select after you finish drawing, so your next click
  manipulates what you just made. Text was the one exception — after
  typing and clicking away, the tool silently stayed on "Text," so the
  very next click anywhere started placing *another* text box instead of
  letting you select/move/resize the one you just created. This is what
  originally made the font-scaling fix above impossible to verify
  correctly, and tracking down the real cause needed direct object-state
  inspection rather than guessing from pixel output alone.
- Verified with 10/10 new pixel-level checks on the fixes themselves,
  plus an 11/11 regression pass confirming undo/redo, duplicate, delete,
  and save-to-gallery all still work correctly — zero console errors
  across both suites.

**v1.7.0 — Desktop app**
- Added `desktop/` — a standalone Electron app (Windows/Mac/Linux) with
  the same core features as the extension (screenshot, screen recording,
  editor, share links), for teammates who want a downloadable app rather
  than loading a Chrome extension. Reuses the extension's gallery,
  editor, and all `shared/*.js` modules **unchanged** via a `chrome.*`
  compatibility shim in `desktop/src/preload.js` — see
  `desktop/README.md` for the full architecture writeup.
- **Three real bugs found and fixed by actually running Electron under
  Xvfb in this environment, not by inspection**: (1) Electron's default
  sandboxed preload mode silently blocks `require()` for Node built-ins,
  breaking the entire shim on every window until `sandbox: false` was
  added; (2) `contextBridge.exposeInMainWorld('chrome', ...)` fails
  outright because Chromium already defines a native `window.chrome`
  object — worked around with a differently-named bridge plus a plain
  inline-script assignment; (3) `contextBridge`'s deep-freezing of
  exposed objects means a planned custom error message for the
  (intentionally unimplemented) Google Drive OAuth path doesn't
  propagate — documented as a known, non-blocking gap rather than fixed
  blind or hidden.
- Screen/window screenshot capture, area-select (with HiDPI scale
  correction), recording via `desktopCapturer`, system tray, and a
  global shortcut (Ctrl+Shift+S) are all implemented.
- **Verified end-to-end with a real running Electron instance**, not
  just written: a real screenshot frame was captured from the virtual
  display, saved to and read back from IndexedDB through the unmodified
  `CaptureStore` module, and the Gallery/Editor windows both load with
  zero console errors. `npm run build:linux` was actually run and
  produced a real, structurally-valid AppImage (confirmed via `asar
  list` that the genuine Electron runtime and our exact source files are
  bundled correctly inside).
- **Not implemented**: Google Drive sharing (needs a different OAuth
  client type entirely — see `desktop/README.md`); auto-updater; macOS
  `.dmg` builds (needs a real Mac or macOS CI runner — can't be produced
  from this Linux environment, documented rather than faked).
- **Windows installer built and verified too**: `npm run build:win`
  produced a real 102MB NSIS `Setup.exe` — confirmed via the same `asar
  list` inspection that the genuine Windows Electron runtime and our
  exact source files are bundled correctly inside. Building a Windows
  installer from this Linux environment needed Wine installed
  (`rcedit`, for the `.exe`'s icon/version resources — not code signing).
  Neither the Windows nor Linux installer is code-signed, so OS-level
  "unknown publisher" warnings are expected on first run — normal for
  internal distribution, documented in `desktop/README.md`.

**v1.6.0**
- Added [`render.yaml`](render.yaml) so the backend deploys to Render as
  a one-click Blueprint (New + → Blueprint → connect repo) instead of
  manually configuring a Web Service field by field — root directory,
  build/start commands, Python version, and health check path are all
  pre-set.
- **`PUBLIC_BASE_URL` now auto-detects on Render** — added
  `Settings.effective_public_base_url` (`app/config.py`), which prefers
  Render's own `RENDER_EXTERNAL_URL` whenever `PUBLIC_BASE_URL` was left
  at its localhost default. Share links work correctly on the very first
  deploy, no more "deploy once to learn the URL, set an env var, redeploy"
  round trip. Explicitly setting `PUBLIC_BASE_URL` (e.g. for a custom
  domain) still always takes precedence.
- Root cause of "the link doesn't open on another device," for the
  record: a share link's domain comes from `PUBLIC_BASE_URL` — if that's
  still `http://localhost:8000` (the local-dev default), the link only
  ever resolves on the machine running the backend. This release doesn't
  change that fundamental fact, it just removes the friction in getting
  a real public URL configured on Render specifically.
- Backend README's Deployment section rewritten with the Blueprint flow,
  a manual-setup fallback, and a note on Render free-tier cold starts
  (~30-50s wake time after 15 min idle — matters for a share-link
  service specifically, since the first click after a quiet period will
  feel slow).
- Verified with 4 new tests covering the auto-detection logic (prefers
  Render's URL when default, defers to an explicit override, falls back
  to localhost with neither, and trailing-slash handling) plus a live
  simulation of Render's environment confirming the resolved URL is
  correct — 68/68 backend tests passing overall.
- **Fixed video uploads failing with "Unsupported MIME type:
  video/webm;codecs=vp9,opus"** on both the backend and R2 destinations.
  Root cause: `MediaRecorder` reports (and the extension correctly sends)
  the full Content-Type it actually recorded with, codec parameters
  included — but `app/routes/upload.py` and `app/services/r2_storage.py`
  both did exact-string matching against a bare `video/webm`, so every
  real recording was rejected. Screenshots never hit this because
  `image/png` never carries codec parameters, which is why it went
  unnoticed until video sharing was tested. Fixed by validating (and, for
  R2, resolving the file extension) against the base type before any
  codec parameters, while still storing/signing the full original string
  everywhere else. Along the way, found and fixed a second, related bug
  in the test suite itself: a test was mutating the shared settings
  object directly instead of through `monkeypatch`, so the change never
  got reverted and silently broke an unrelated, later-running test whenever
  the full suite ran (passed in isolation, failed in the full run) —
  fixed by using `monkeypatch.setattr` like everywhere else. 72/72
  backend tests passing (4 new, covering the codec-parameter fix
  specifically, end-to-end through both upload paths).
- Baked in the deployed Render URL (`https://satylens.onrender.com`) as
  `DEFAULT_API_BASE_URL` (`extension/shared/api.js`) so a fresh install
  of the extension works immediately — no manual Settings step needed
  before "Create Share Link" functions. Verified live: a fresh install's
  `getApiBaseUrl()` now resolves to the Render URL without any user
  action.
- Extension version bumped to 1.6.0 to match.

**v1.5.1**
- Added a "Created by Satyendra Kumar Namdeo" credit line, visible on
  every page anyone opens: all four extension pages (popup, gallery,
  editor, recorder) and both public-facing backend pages (the share
  viewer anyone with a link sees, and the analytics dashboard). Verified
  with 8 headless-Chrome checks confirming the text is not just present
  in the markup but actually rendered and visible on each page, plus a
  direct template-render check for the share viewer's error-state branch.

**v1.5.0**
- Rebranded the project from CaptureFlow to **SatyLens** throughout —
  extension name/titles/headers, backend API title, share viewer and
  analytics dashboard, all documentation, and internal identifiers
  (IndexedDB database name, downloads subfolder, content-script overlay
  DOM id). Confirmed with a full case-insensitive repo sweep: zero
  remaining "CaptureFlow" references anywhere.
- New icon set (`extension/icons/icon{16,48,128,256}.png`) generated from
  the provided logo. **Note on the source logo**: the uploaded artwork's
  wordmark text is fused into the bottom of the circular badge itself
  (not a separate element below it), so there's no clean crop that keeps
  the full ring and excludes the old "CaptureFlow" text. Rather than ship
  an icon with the wrong name baked in, the icons use just the pictorial
  mark (camera + video + cloud + swoosh, no text) cropped from the
  artwork. If you want the full circular badge treatment with a
  "SatyLens" wordmark, that needs a new logo asset — the current one
  can't be edited into that without regenerating it.
- Wired the real logo image into every page header that previously used
  a placeholder "◎" text glyph (popup, gallery, editor, recorder, plus
  the backend's share viewer and analytics dashboard, the latter two via
  a new `/static` mount in `app/main.py`).
- Bumped extension `manifest.json` to v1.5.0. The pinned `key` (and thus
  the extension's ID, `dnolljemclndkekniemfdbplhajfoifc`) is unaffected
  by any of this — renaming doesn't change it, so existing Google OAuth
  client setup from `GOOGLE_DRIVE_SETUP.md` remains valid.
- Root project folder renamed `captureflow/` → `satylens/`.
- Verified with 81 automated checks (64 backend/pytest, unaffected by a
  pure rename, plus 17 new headless-Chrome checks confirming every page's
  title/header text, that each logo `<img>` actually loads — not just
  present in markup — and that the renamed IndexedDB database and
  downloads folder work correctly) — zero failures.

**v1.4.0**
- Added Cloudflare R2 as a third "Create Share Link" destination
  (`extension/shared/r2.js`, `backend/app/services/r2_storage.py`,
  `backend/app/routes/media.py`): direct browser-to-R2 upload via
  presigned PUT URLs (file bytes never pass through the backend),
  server-side verification of the upload before the share link goes live
  (never trusts the client's word, and records R2's real file size — not
  the client's claim), link revocation/expiration, and view/download
  counters. Reused the existing `/s/{id}` viewer and `captures` table
  (extended with new columns via an idempotent migration) instead of
  building parallel share/media infrastructure. Added a Link History
  panel to the Gallery for R2 links specifically. New
  [`R2_SETUP.md`](R2_SETUP.md) walks through Cloudflare bucket/CORS/
  credentials setup. **Deviations from the original spec, noted
  explicitly**: continued extending the existing FastAPI backend rather
  than standing up Flask; reused/extended the `captures` table rather
  than the spec's separate `share_token`/`media` schema; kept the
  existing `SCREENSHOT_UPLOADED`/`SCREEN_RECORDING_UPLOADED` analytics
  event names (built and tested in v1.3.0) rather than adopting this
  spec's different `*_UPLOAD_STARTED`/`*_UPLOAD_COMPLETED` naming, to
  avoid a conflicting parallel event taxonomy. Verified with 81
  automated checks (64 backend/pytest — including new R2 validation,
  upload-flow, and viewer-state tests — plus 17 headless-Chrome checks
  covering the full direct-upload flow, progress reporting, error
  handling, and the Settings/Link History UI) — zero failures. Two real
  regressions were caught and fixed via this testing: the `share.py`
  rewrite broke two existing delete-share tests that didn't expect the
  new pre-delete `get_capture_row` check, and the shared test fake
  needed a `.delete()` method it never previously required.

**v1.3.0**
- Added centralized usage analytics (`extension/shared/analytics.js`,
  `backend/app/routes/analytics.py`, `backend/app/services/analytics.py`)
  and an admin dashboard at `GET /dashboard` (KPI cards, 7 trend charts,
  live activity feed, user table with per-user drill-down). Tracks
  install/session lifecycle, screenshot/recording/edit/upload/share/error
  events — anonymized, asynchronous, and fully non-blocking (analytics
  failures never surface to the user or affect core functionality; a
  failed or offline send is queued locally and retried, never lost).
  Settings gained an analytics on/off toggle and a "Clear local telemetry
  data" action. **Deviation from the original spec, noted explicitly**:
  extended the existing FastAPI backend rather than standing up a
  separate Flask service, to keep one backend/one deployment; and added
  an *optional* token gate on the reporting endpoints (ingestion stays
  fully open) as a safer default than leaving aggregate user data on the
  open internet. Verified with 55 automated checks across four suites
  (30 backend/pytest, 12 analytics-module, 6 service-worker integration,
  7 full-page regression) — zero failures. Two real bugs were caught and
  fixed via this testing: a thrown network error (going offline) could
  silently drop queued events instead of persisting them for retry, and
  the same "unhandled 500 instead of a clean 503 when Supabase isn't
  configured" issue from earlier phases recurred here and got the same
  fix.

**v1.2.0**
- Added Google Drive as a second "Create Share Link" destination
  (`extension/shared/drive.js`, `extension/shared/share.js`): OAuth via
  `chrome.identity`, folder picker/creation, upload with progress, and a
  duplicate-upload guard. Existing backend-upload behavior is unchanged
  and remains the default — Drive is opt-in via Settings. Extension now
  ships a pinned `key` in `manifest.json` so its ID stays stable across
  reloads (required for the OAuth client to work). Verified with 20
  automated headless-Chrome checks across three suites (Drive core logic,
  editor regression, gallery Settings UI) — zero failures, zero console
  errors. See [`GOOGLE_DRIVE_SETUP.md`](GOOGLE_DRIVE_SETUP.md).

**v1.1.0**
- Added the screenshot editor (`extension/editor/`): canvas-based annotation
  tool with an independent-object model, undo/redo, blur/pixelate redaction,
  crop, asset import, and the full styling controls listed above. Wired into
  the popup preview and gallery (card action + detail modal). Verified with
  an automated headless-Chrome test suite (13 checks: draw/commit, undo/redo,
  text editing, duplicate, delete, save round-trip, blur pixel verification,
  crop resizing, zero console errors).

**v1.0.0**
- Initial release: visible-tab/full-page/area-select screenshots, tab/
  window/screen recording, IndexedDB gallery, FastAPI + Supabase backend
  for share links.

