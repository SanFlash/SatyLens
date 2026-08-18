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
export async function uploadCapture(blob, metadata, onProgress) {
  const base = await getApiBaseUrl();
  const form = new FormData();
  form.append('file', blob, metadata.name);
  form.append('type', metadata.type);
  form.append('name', metadata.name);
  form.append('mime_type', metadata.mimeType);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/api/upload`);

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };

    xhr.onload = () => {
      let body;
      try {
        body = JSON.parse(xhr.responseText);
      } catch (e) {
        return reject(new Error('Invalid response from server.'));
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
      } else if (xhr.status === 413) {
        reject(new Error(body.detail || 'File is too large to upload.'));
      } else {
        reject(new Error(body.detail || `Upload failed (${xhr.status}).`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error. Is the backend running and reachable?'));
    xhr.ontimeout = () => reject(new Error('Upload timed out.'));
    xhr.timeout = 5 * 60 * 1000; // 5 minutes for large recordings

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
