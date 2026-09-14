# SatyLens 2.0 audit and delivery ledger

Baseline: main commit 584e089c34cba0fe87daf9cda30896182337273c, extension 1.23.1.
This ledger distinguishes inspected code from verified runtime behavior. This branch is not yet a 2.0 release.

## Architecture

104 tracked files. Chrome MV3 uses module scripts and vanilla CSS/JS. The service worker routes capture commands, scroll/stitch operations, area selection, and downloads. Popup visible capture initially exists only in popup memory. Area/full-page captures save through the shared CaptureStore before opening another page. The injected selector supplies viewport metrics and capture rectangles.

IndexedDB `satylens`, version 1, contains `captures` keyed by id with createdAt/type indexes. Blobs, thumbnails, tags and share references are stored together. chrome.storage.local stores small preferences and telemetry. Preserve database name, store name, IDs and binary data; metadata additions should not rewrite blobs.

The screenshot editor has a custom canvas object model, one selectedId, image-version history and a 40-entry undo cap. Existing layer ordering, rotation and shape types should be extended. Saving currently updates the capture; exporting redactions must not reuse an old cloud URL. The video editor already has trim handles, effects and presets. It exports via HTMLVideoElement/canvas/MediaRecorder; WebCodecs requires a real demux/mux pipeline, not an API-existence check.

Recorder owns display/tab streams, optional microphone, a Web Audio compressor/mixer, MediaRecorder chunks and optional microphone-only SpeechRecognition. There is existing system-audio warning handling. Long recordings retain chunks in memory.

Gallery loads all captures, filters and builds cards in memory. It owns settings, Drive configuration, tags, bulk operations, detail modal and link history. Deletion is currently permanent. Modal and object URL lifetimes need attention.

Uploads converge through shared/share.js into Supabase signed upload, R2 presigned PUT, or Drive OAuth upload. The FastAPI server keeps privileged provider credentials. Supabase and R2 share viewers converge at `/s/{share_id}`. Drive is its own sharing system. Preserve public share IDs and URLs; these are opaque text capabilities, not UUID primary keys.

Backend routers: health, upload/diagnostics, share/viewer, media/history/management, analytics/session and dashboard. Services: Supabase storage/repository, R2 storage, password/download-token signing and analytics aggregation. SQL contains captures, installations, sessions and events with RLS enabled and deny-public policies. Backend service-role access bypasses RLS, so authorization must also be enforced in API routes.

Desktop uses Electron main/preload and copied renderer modules, with contextIsolation and nodeIntegration disabled. The desktop settings shim differs from Chrome. Its capture source selection and filesystem bridge need separate verification; do not assume Chrome tests cover them.

Documentation: root README, backend README, Supabase SETUP, Drive/R2 setup and Render blueprint exist. No root SETUP, versioned SQL migration directory, automated extension tests or root test harness existed at baseline. Manifest is extension/manifest.json, not repository root.

## Findings and risks

| Priority | Finding | Evidence / next action |
|---|---|---|
| Critical | Share viewers can also mutate a share using its public ID | media revoke/expire/delete and share password/delete lack owner authorization. Introduce separate management credentials; legacy links must remain viewable and require a safe owner-recovery strategy. |
| High | Analytics reports public when dashboard token unset | Fail closed and update the old test that explicitly asserted public access. |
| High | Telemetry raw errors may include private URLs/credentials | Replace error text with a fixed error code at client and ingestion boundary. |
| High | Opt-out does not prevent an already persisted queue from flushing | Gate flush and clear pending queue on disable. |
| High | Unsafe HTML interpolation in tags, metadata and history errors | Construct text nodes in both extension and desktop gallery. |
| High | IndexedDB mutation success is reported before transaction commit | Resolve on complete, reject on abort. Protect immutable record id. |
| High | Schema creates indexes on added columns before adding those columns | Move additive column steps ahead of dependent indexes. Verify against real PostgreSQL before release. |
| High | R2 deletion ignores provider failure and deletes metadata anyway | Preserve row and expose actionable retry. |
| High | Desktop IPC trusts relative paths, filenames and external URLs | Validate paths/protocols and sender origins before desktop release. |
| Medium | Recent thumbnails load entire capture library including video blobs | Use descending createdAt cursor with a bounded result count. |
| Medium | Full-page capture lacks finally-based scroll restoration and cancellation | Restore even after slice errors; preserve partial capture and bound canvas allocation. |
| Medium | Selector reinjection adds duplicate message handlers | Add installation guard, keyboard adjustment and explicit confirm/cancel semantics. |
| Medium | Area-selection purpose only exists in worker memory | Persist by tab in session storage so suspension cannot switch recording to screenshot. |
| Medium | Service worker uses URL.createObjectURL for download | Move Blob download into a document/offscreen context supported by MV3. |
| Medium | Clearing telemetry identity changes installation history scope | Separate share-history installation identity, migrating the existing value. |
| Medium | Gallery renders all cards and retains object URLs until unload | Add bounded rendering, lazy images and early release. |
| Medium | Video export error paths retain streams/audio/interval resources | Centralize cleanup, abort handling and playback startup. Background timers can still throttle. |
| Medium | Supabase object existence lookup uses an unpaginated folder list | Find the target reliably beyond the first storage listing page. |
| Medium | Public diagnostics mutates bucket limits | Separate admin diagnostics/config changes from public health. |
| Medium | Client errors embed raw provider exception text | Return stable actionable messages; redact structured logs. |
| Medium | View/download counters use read-modify-write | Use atomic database operations; counters do not enforce download limits. |
| Medium | No authenticated ownership or synchronization | Design additive ownership, metadata sync and immutable media versions with opt-in uploads. |
| Medium | Permission scope broad | Review https host permissions, injected scripts and web-accessible pages without breaking capture or custom providers. |

## Verification baseline

All 126 existing backend tests passed (two dependency deprecation warnings). Tests mock cloud services; this is not live RLS/provider proof. Initial runtime lacked pytest; declared backend requirements were installed. No production secrets or live user data were used.

## Release gates still required

Full browser capture/editor/recorder flows, real RLS and migration execution, authenticated ownership, cross-device sync, resumable upload recovery, accessible themes/dialogs, 100–200% zoom, offline flows, performance measurements, provider integration tests, dependency security updates and a production extension build. No 2.0 version bump until these gates are satisfied.
