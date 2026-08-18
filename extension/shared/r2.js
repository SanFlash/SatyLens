// extension/shared/r2.js
// Cloudflare R2 direct-upload flow: request a presigned PUT URL from the
// backend, upload the file bytes straight to R2 (never through the
// backend — that's the whole point for large recordings), then confirm
// completion so the backend can verify the object actually landed before
// marking the share link live.
//
// R2 credentials never appear here or anywhere else in the extension —
// this module only ever handles a short-lived presigned URL the backend
// generates per upload.

import { getApiBaseUrl } from './api.js';

async function requestUploadUrl({ fileName, contentType, fileSize, mediaType, clientId }) {
  const base = await getApiBaseUrl();
  const res = await fetch(`${base}/api/media/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_name: fileName,
      content_type: contentType,
      file_size: fileSize,
      media_type: mediaType,
      client_id: clientId || null
    })
  });
  if (!res.ok) throw new Error(await describeError(res));
  return res.json(); // {success, upload_url, object_key, upload_id, expires_in}
}

function putToR2(uploadUrl, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    // Must match exactly what the presigned URL was signed for, or R2
    // rejects the upload outright.
    xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else if (xhr.status === 403) {
        reject(new Error('The upload URL expired or is invalid. Please retry.'));
      } else {
        reject(new Error(`R2 upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error while uploading to Cloudflare R2.'));
    xhr.send(blob);
  });
}

async function completeUpload({ uploadId, objectKey, mediaType, fileName, contentType, fileSize }) {
  const base = await getApiBaseUrl();
  const res = await fetch(`${base}/api/media/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_id: uploadId,
      object_key: objectKey,
      media_type: mediaType,
      file_name: fileName,
      content_type: contentType,
      file_size: fileSize
    })
  });
  if (!res.ok) throw new Error(await describeError(res));
  return res.json(); // {success, id, share_url}
}

async function describeError(res) {
  try {
    const body = await res.json();
    if (body?.detail) return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
  } catch (_) {
    /* non-JSON error body */
  }
  return `Request failed (${res.status}).`;
}

/**
 * Full end-to-end R2 upload: request URL -> direct PUT -> confirm.
 * @param {Blob} blob
 * @param {{fileName: string, contentType: string, mediaType: 'screenshot'|'recording'|'collage', clientId?: string}} meta
 * @param {(loaded:number, total:number)=>void} [onProgress] - reports the direct-upload phase only
 * @returns {Promise<{id: string, shareUrl: string}>}
 */
export async function uploadToR2(blob, meta, onProgress) {
  const session = await requestUploadUrl({
    fileName: meta.fileName,
    contentType: meta.contentType,
    fileSize: blob.size,
    mediaType: meta.mediaType,
    clientId: meta.clientId
  });

  await putToR2(session.upload_url, blob, meta.contentType, onProgress);

  const result = await completeUpload({
    uploadId: session.upload_id,
    objectKey: session.object_key,
    mediaType: meta.mediaType,
    fileName: meta.fileName,
    contentType: meta.contentType,
    fileSize: blob.size
  });

  return { id: result.id, shareUrl: result.share_url };
}

/** Recent R2-uploaded share links for this installation (see
 * shared/analytics.js's client_id) — used by the Link History panel.
 * Only covers R2 uploads: the backend/Supabase and Google Drive
 * destinations don't currently record a client_id against each capture,
 * so a single unified cross-destination history isn't available yet
 * (the Gallery itself remains the complete, all-destinations view). */
export async function getR2LinkHistory(clientId, limit = 20) {
  const base = await getApiBaseUrl();
  const res = await fetch(
    `${base}/api/media/history?client_id=${encodeURIComponent(clientId)}&limit=${limit}`
  );
  if (!res.ok) throw new Error(await describeError(res));
  return res.json();
}

export async function revokeR2Link(shareId) {
  const base = await getApiBaseUrl();
  const res = await fetch(`${base}/api/media/${encodeURIComponent(shareId)}/revoke`, { method: 'POST' });
  if (!res.ok) throw new Error(await describeError(res));
  return res.json();
}

export async function setR2LinkExpiration(shareId, hours) {
  const base = await getApiBaseUrl();
  const res = await fetch(`${base}/api/media/${encodeURIComponent(shareId)}/expire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hours: hours ?? null })
  });
  if (!res.ok) throw new Error(await describeError(res));
  return res.json();
}
