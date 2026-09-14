# Initial hardening checkpoint — not a 2.0 release

## Implemented changes

- Analytics reports fail closed when the dashboard token is unset; token comparison uses constant-time comparison. The public dashboard shell contains no reporting data.
- Raw telemetry errors are replaced with `operation_failed` in new client events, old queued events before upload, and backend ingestion. Previously stored server events are not deleted by this change.
- Disabled telemetry clears queued events and flush checks the preference before processing. Requests already transmitted cannot be recalled; cross-context in-flight cancellation and queue concurrency still need work.
- Stable share-history identity is initialized from the existing installation ID before telemetry reset. Existing link history remains scoped to that original ID. This is history scoping, not authentication.
- Local capture mutations wait for transaction completion; transaction aborts reject. Capture IDs cannot be changed through metadata patches. Failed database opens can retry and version-change events close stale connections.
- Recent captures use a descending createdAt index cursor, rather than materializing the entire gallery. No IndexedDB version bump or binary rewrite is needed.
- Gallery tags, capture MIME metadata and history errors use text nodes instead of untrusted HTML. The metadata/history fixes also cover the desktop renderer; desktop has no tag UI.
- Malformed stored password hashes fail verification without throwing. Existing valid hashes remain compatible.
- R2 deletion failure preserves metadata and returns a retryable 502 without exposing provider exception text.
- Existing additive SQL column statements now run before indexes that depend on them. SQL has not been executed against a live database.

## Run verification

Use Python 3.12 and Node 24 (the versions used here).

```sh
npm ci
npm test
cd backend
python -m pip install -r requirements.txt
python -m pytest -q
```

| Suite | Baseline | New cases | Current total | Result |
|---|---:|---:|---:|---|
| Backend pytest | 126 | 11 | 137 | Passed |
| JavaScript persistence / telemetry / DOM | 0 | 10 | 10 | Passed |
| Total | 126 | 21 | 147 | 0 failures; 0 skipped |

The existing analytics test asserting public reports was updated to assert the newly required closed behavior; other aggregation tests now authenticate. No original tests were deleted. Cloud services are mocked. DOM tests load the real gallery modules with fake IndexedDB and assert malicious tag/MIME strings remain text; they are not browser or Electron end-to-end tests.

Warnings: backend dependencies emit two deprecation warnings. Node auto-detects the desktop renderer's ES module syntax, emitting a test warning; the desktop package remains CommonJS for Electron main/preload compatibility.

Browser verification was attempted, but no Chromium binary was installed and Playwright's Chromium download returned HTTP 502. No visual, zoom, keyboard, recording, browser-console or full offline-flow claim is made. The SQL ordering fix still requires PostgreSQL migration testing. The full 2.0 implementation remains unfinished.

## Rollout and preservation

This draft branch must not be deployed as SatyLens 2.0. Before any deployment, complete the release gates in SATYLENS_2_AUDIT.md, especially share-owner authorization. No production database, provider configuration or deployed branch was changed.

For this checkpoint, configure `ANALYTICS_DASHBOARD_TOKEN` server-side with a strong random value and supply it through the dashboard token field / `X-Analytics-Token` header. Blank means reporting disabled (503); a wrong or missing request token means 401 when reporting is configured. This token never belongs in extension source.

No new privileged credentials, extension permissions, public routes or settings overwrites were introduced. The extension key, 1.23.1 version, IndexedDB database/store names and all public share URL formats remain unchanged. A release version bump is deferred until a verified release exists. The new sharingInstallationId preference is additive; keep it on rollback so history scope can be retained by the eventual release.

Do not uninstall the extension or clear site data as an upgrade procedure. Back up captures before testing any future IndexedDB migration. Do not run the entire historical schema blindly against production: it also contains a pre-existing storage bucket size-limit update and constraint recreation. Review and stage those operations separately.

## Feature status

| Feature | Status | Implementation | Tested |
|---|---|---|---|
| Repository audit | Initial audit recorded | SATYLENS_2_AUDIT.md | Code inspection; baseline tests |
| Persistence correctness | Implemented checkpoint | Shared CaptureStore | Transaction abort + data preservation tests |
| Recent-capture reads | Implemented checkpoint | IndexedDB index cursor | Bounded-read regression test; no latency benchmark |
| Telemetry privacy | Partially hardened | Opt-out, fixed error code, stable history identity | JS and ingestion tests; concurrency pending |
| Gallery unsafe markup | Fixed inspected paths | Text-node rendering | Extension/desktop DOM tests |
| Analytics report access | Implemented checkpoint | Required server token | All six report routes tested |
| Password hash corruption | Implemented checkpoint | Fail-closed parser | Unit tests |
| R2 delete recovery | Implemented checkpoint | Preserve row on provider failure | API regression test |
| SQL upgrade ordering | Code fixed | Existing schema reordered | Not database-tested |
| Design system, themes, command palette, onboarding | Not implemented | Existing UI retained | Not tested |
| Popup/gallery redesign and inspector | Not implemented | Existing UI retained | No visual verification |
| Favorites, trash, collections, smart search | Not implemented | Pending local-first design | Not tested |
| Screenshot editor, annotations, collage | Upgrade not implemented | Existing editor retained | No browser regression run |
| Selector/full-page recovery | Upgrade not implemented | Risks documented | Not tested |
| Recorder/audio/quality controls | Upgrade not implemented | Existing recorder retained | Not tested |
| Video editor/WebCodecs | Upgrade not implemented | Existing export retained | Not tested |
| Unified Share Center/owner authorization | Not implemented | Critical risk documented | Not tested |
| Authentication/profiles/cloud sync | Not implemented | Requires additive ownership model | Not tested |
| Upload manager/resumable uploads/compression | Not implemented | Existing provider flows retained | Existing mocked tests only |
| AI/OCR/presets | Not implemented | No content sent to AI | Not tested |
| Versioned SQL/RLS/seed/API migration | Not implemented | Existing RLS retained | Live database verification pending |
| Analytics dashboard expansion/rate limiting | Not implemented | Existing dashboard retained | Existing reporting tests only |
| Full security/performance/accessibility certification | Not complete | Initial findings recorded | Browser and live-service gates pending |
| Production 2.0 build/deployment | Not complete | Version unchanged; draft branch | Not verified |
