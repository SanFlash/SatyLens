// extension/shared/api.js
// Central API client. All backend calls go through here so the base URL
// is configured in exactly one place (see ConfigStore / DEFAULT_API_BASE_URL).

import { ConfigStore } from './storage.js';

// Change this for your deployed backend, or override at runtime via the
// gallery Settings panel (persisted through ConfigStore -> chrome.storage.local).
export const DEFAULT_API_BASE_URL = 'https://satylens.onrender.com';

export async function getApiBaseUrl() {
  return ConfigStore.get('apiBaseUrl', DEFAULT_API_BASE_URL);
}

export async function setApiBaseUrl(url) {
  return ConfigStore.set('apiBaseUrl', url.replace(/\/+$/, ''));
}

async function parseErrorResponse(res) {
  let detail = `Request failed with status ${res.status}`;
  try {
    const body = await res.json();
    if (body && body.detail) detail = body.detail;
  } catch (_) {
    /* non-JSON error body, keep default message */
  }
  return detail;
}

export async function healthCheck() {
  const base = await getApiBaseUrl();
  const res = await fetch(`${base}/api/health`, { method: 'GET' });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

/**
 * Uploads a capture blob with metadata. Uses XHR (not fetch) so we can
 * report real upload progress for large video files.
 * @param {Blob} blob
 * @param {{type: string, name: string, mimeType: string}} metadata
 * @param {(loaded:number, total:number)=>void} onProgress
 */
/**
 * Uploads a capture via the direct-to-Supabase signed-upload flow:
 * request a signed, single-object upload URL from this backend, PUT the
 * file straight to Supabase Storage (this backend's own HTTP handlers
 * never see the file bytes at all), then confirm completion. This
 * replaced an earlier version that POSTed the full file body to this
 * backend's own /api/upload endpoint, which had two real problems for
 * large files: it made a second network hop (backend -> Supabase) on
 * top of the browser's own upload, and held the entire file in this
 * server's memory the whole time -- both of which made it genuinely
 * likely to time out or fail outright on a proxy/gateway in front of
 * the server for large recordings. This flow has neither problem: the
 * browser uploads directly to storage, exactly like the R2 destination
 * already does (see shared/r2.js).
 *
 * @param {Blob} blob
 * @param {{name: string, type: 'screenshot'|'recording', mimeType: string, clientId?: string, durationSeconds?: number}} metadata
 * @param {(loaded:number, total:number)=>void} [onProgress] - reports the direct-upload phase only
 * @returns {Promise<{success: boolean, id: string, share_url: string, file_url: string}>}
 */
export async function uploadCapture(blob, metadata, onProgress) {
  const base = await getApiBaseUrl();

  const signedRes = await fetch(`${base}/api/upload/signed-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_name: metadata.name,
      content_type: metadata.mimeType,
      media_type: metadata.type,
      client_id: metadata.clientId || null
    })
  });
  if (!signedRes.ok) throw new Error(await parseErrorResponse(signedRes));
  const signed = await signedRes.json(); // {success, id, signed_url, token, storage_path}

  await putToSignedUrl(signed.signed_url, blob, metadata.name, metadata.mimeType, onProgress);

  const completeRes = await fetch(`${base}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: signed.id, duration_seconds: metadata.durationSeconds || 0 })
  });
  if (!completeRes.ok) throw new Error(await parseErrorResponse(completeRes));
  return completeRes.json();
}

/**
 * PUTs a file directly to a Supabase Storage signed upload URL.
 * Deliberately a multipart/form-data body (a `file` field), not a raw
 * binary PUT body -- unlike R2's S3-compatible presigned URLs, Supabase
 * Storage's signed-upload-URL endpoint specifically expects the upload
 * as multipart form data (confirmed directly from the storage3 Python
 * client's own implementation of this same request, which this mirrors
 * for the browser).
 */
function putToSignedUrl(signedUrl, blob, fileName, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', blob, fileName);

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl);

    const STALL_LIMIT_MS = 60 * 1000;
    let lastProgressAt = Date.now();
    const stallWatchdog = setInterval(() => {
      if (Date.now() - lastProgressAt > STALL_LIMIT_MS) {
        clearInterval(stallWatchdog);
        xhr.abort();
        reject(new Error('Upload stalled (no progress for 60s) — check your connection and try again.'));
      }
    }, 5000);

    xhr.upload.onprogress = (e) => {
      lastProgressAt = Date.now();
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };

    xhr.onload = () => {
      clearInterval(stallWatchdog);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else if (xhr.status === 403 || xhr.status === 401) {
        reject(new Error('The upload URL expired or is invalid. Please retry.'));
      } else {
        reject(new Error(`Upload to storage failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => {
      clearInterval(stallWatchdog);
      reject(new Error('Network error while uploading to storage.'));
    };
    xhr.onabort = () => clearInterval(stallWatchdog);

    xhr.send(form);
  });
}

export async function getShareInfo(shareId) {
  const base = await getApiBaseUrl();
  const res = await fetch(`${base}/api/share/${encodeURIComponent(shareId)}`);
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export async function deleteShare(shareId) {
  const base = await getApiBaseUrl();
  const res = await fetch(`${base}/api/share/${encodeURIComponent(shareId)}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export function buildShareUrl(base, shareId) {
  return `${base.replace(/\/+$/, '')}/s/${shareId}`;
}

/**
 * Sets, changes, or removes password protection on an existing share.
 * Pass null/empty to remove protection. Works for any share regardless
 * of which upload destination created it (backend or R2) -- both are
 * rows in the same `captures` table server-side.
 */
export async function setSharePassword(shareId, password) {
  const base = await getApiBaseUrl();
  const res = await fetch(`${base}/api/share/${encodeURIComponent(shareId)}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: password || null })
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

/**
 * Sets (or clears, with hours=null) an expiration on an existing share.
 * Also works for any share regardless of destination -- this endpoint
 * lives under /api/media/ for historical reasons but the underlying
 * operation has never been R2-specific.
 */
export async function setLinkExpiration(shareId, hours) {
  const base = await getApiBaseUrl();
  const res = await fetch(`${base}/api/media/${encodeURIComponent(shareId)}/expire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hours: hours ?? null })
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}
