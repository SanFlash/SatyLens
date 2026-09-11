// extension/shared/share.js
// Single entry point for "Create Share Link", used by the popup, gallery,
// editor, and recorder. Dispatches to the existing FastAPI/Supabase
// backend (shared/api.js — unchanged, still the default), Google Drive
// (shared/drive.js), or Cloudflare R2 (shared/r2.js), based on the user's
// setting in Gallery → Settings. This is additive: existing backend-
// upload behavior is untouched, Drive and R2 are opt-in second/third
// destinations.

import { CaptureStore, ConfigStore } from './storage.js';
import { uploadCapture as uploadToBackend, getApiBaseUrl, buildShareUrl } from './api.js';
import { uploadToDrive, isDriveConnected, getStoredFolder } from './drive.js';
import { uploadToR2 } from './r2.js';
import { track, getAnalyticsClientId } from './analytics.js';

export async function getUploadDestination() {
  return ConfigStore.get('uploadDestination', 'backend'); // 'backend' | 'drive' | 'r2'
}

export async function setUploadDestination(dest) {
  return ConfigStore.set('uploadDestination', dest);
}

// Mirrors backend/app/config.py's Settings.max_direct_upload_warn_bytes --
// NOTE: as of the direct-to-Supabase-storage upload flow (see api.js's
// uploadCapture), the 'backend' destination no longer has the specific
// double-network-hop + full-file-in-server-memory problem this constant
// used to warn about -- both the backend and R2 destinations now upload
// directly from the browser to storage. Kept here (unused by the
// warning below, which now always returns null) as a historical
// pointer in case a future destination reintroduces that constraint.
const LARGE_DIRECT_UPLOAD_WARN_BYTES = 200 * 1024 * 1024;

/**
 * Historically warned before a large 'backend'-destination upload,
 * since that path used to route the full file through this extension's
 * own backend server (a real bottleneck for big files). That path was
 * restructured to upload directly to storage instead (matching R2's
 * existing architecture), which removed the problem this was warning
 * about -- kept as a no-op function (always returns null) rather than
 * deleted outright, so callers don't need to be touched again if a
 * different destination ever reintroduces a similar constraint.
 */
export function getLargeUploadWarning(_capture, _destination) {
  return null;
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

/** Matches the "Screenshot_2026-08-14_14-35-22.png" naming convention. */
export function driveStyleFilename(type, mimeType, date = new Date()) {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(
    date.getHours()
  )}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
  const label = type === 'recording' ? 'ScreenRecording' : 'Screenshot';
  return `${label}_${stamp}.${ext}`;
}

/**
 * Creates (or returns an already-created) share link for a capture.
 * @param {object} capture - a full CaptureStore record (has .blob, .type, .mimeType, .id)
 * @param {(loaded:number, total:number)=>void} [onProgress]
 * @returns {Promise<{shareUrl: string, destination: 'backend'|'drive'|'r2'}>}
 */
export async function createShareLink(capture, onProgress) {
  const destination = await getUploadDestination();

  // Duplicate-upload guard: if this exact capture was already uploaded to
  // this same destination, hand back the existing link instead of
  // re-uploading it.
  if (capture.uploaded && capture.shareUrl && capture.uploadDestination === destination) {
    track('LINK_GENERATED', { feature: 'sharing', action: destination });
    return { shareUrl: capture.shareUrl, destination, reused: true };
  }

  // Warn (not block) before attempting a large upload via the direct
  // backend destination specifically -- see getLargeUploadWarning() for
  // why that destination in particular is meaningfully more likely to be
  // slow or fail outright for big files. Respects the user's choice
  // either way; this only front-loads the warning instead of letting
  // them discover it after a long, failed wait.
  const warning = getLargeUploadWarning(capture, destination);
  if (warning && !confirm(warning)) {
    const err = new Error('Upload canceled.');
    err.userCanceled = true;
    throw err;
  }

  const uploadEventType = capture.type === 'recording' ? 'SCREEN_RECORDING_UPLOADED' : 'SCREENSHOT_UPLOADED';

  if (destination === 'r2') {
    try {
      const clientId = await getAnalyticsClientId();
      const fileName = driveStyleFilename(capture.type, capture.mimeType);
      const result = await uploadToR2(
        capture.blob,
        { fileName, contentType: capture.mimeType, mediaType: capture.type, clientId },
        onProgress
      );
      await CaptureStore.update(capture.id, {
        uploaded: true,
        shareUrl: result.shareUrl,
        shareId: result.id,
        uploadDestination: 'r2'
      });
      track(uploadEventType, { feature: 'sharing', action: 'r2' });
      track('LINK_GENERATED', { feature: 'sharing', action: 'r2' });
      return { shareUrl: result.shareUrl, destination: 'r2' };
    } catch (err) {
      track(uploadEventType, { feature: 'sharing', action: 'r2', success: false, error: err.message });
      throw err;
    }
  }

  if (destination === 'drive') {
    const connected = await isDriveConnected();
    if (!connected) {
      const err = new Error('Google Drive is not connected. Open Settings to connect your account.');
      track(uploadEventType, { feature: 'sharing', action: 'drive', success: false, error: err.message });
      throw err;
    }
    try {
      const folder = await getStoredFolder();
      const filename = driveStyleFilename(capture.type, capture.mimeType);
      const file = await uploadToDrive(capture.blob, filename, folder?.id || null, onProgress);
      const shareUrl = file.webViewLink;
      await CaptureStore.update(capture.id, {
        uploaded: true,
        shareUrl,
        shareId: file.id,
        uploadDestination: 'drive'
      });
      track(uploadEventType, { feature: 'sharing', action: 'drive' });
      track('LINK_GENERATED', { feature: 'sharing', action: 'drive' });
      return { shareUrl, destination: 'drive' };
    } catch (err) {
      track(uploadEventType, { feature: 'sharing', action: 'drive', success: false, error: err.message });
      throw err;
    }
  }

  // Default: FastAPI/Supabase backend — now a direct-to-storage upload
  // (see api.js's uploadCapture for why this changed), so it no longer
  // has a meaningful size ceiling of its own.
  try {
    const clientId = await getAnalyticsClientId();
    const result = await uploadToBackend(
      capture.blob,
      {
        type: capture.type,
        name: capture.name,
        mimeType: capture.mimeType,
        clientId,
        durationSeconds: capture.duration || 0
      },
      onProgress
    );
    const base = await getApiBaseUrl();
    const shareUrl = result.share_url || buildShareUrl(base, result.id);
    await CaptureStore.update(capture.id, {
      uploaded: true,
      shareUrl,
      shareId: result.id,
      uploadDestination: 'backend'
    });
    track(uploadEventType, { feature: 'sharing', action: 'backend' });
    track('LINK_GENERATED', { feature: 'sharing', action: 'backend' });
    return { shareUrl, destination: 'backend' };
  } catch (err) {
    track(uploadEventType, { feature: 'sharing', action: 'backend', success: false, error: err.message });
    throw err;
  }
}
