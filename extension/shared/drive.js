// extension/shared/drive.js
// Google Drive integration for "Create Share Link".
//
// OAuth: uses chrome.identity.getAuthToken(), Chrome's built-in flow for
// extensions signed in with the browser's own Google account. This is the
// flow Google recommends for Chrome extensions specifically because it
// never requires (or exposes) a client secret — the manifest only ever
// holds a public OAuth client_id (see manifest.json's "oauth2" key), and
// Chrome itself brokers the token exchange. Nothing here ever touches a
// client secret, and no token is ever sent anywhere but Google's own APIs.
//
// Scope: drive.file only — this app can see/manage exclusively the files
// *it* creates, never anything else in the user's Drive. That's the
// least-privilege choice, deliberately narrower than full Drive access.

import { ConfigStore } from './storage.js';
import { track } from './analytics.js';

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

/* ============================== Token management ============================== */

function getAuthTokenRaw(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'No token returned.'));
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

/**
 * Returns a usable OAuth token, silently refreshing first and only
 * prompting the user (interactive consent) when explicitly requested —
 * e.g. the first "Connect Google Drive" click.
 */
export async function getValidToken({ interactive = false } = {}) {
  try {
    return await getAuthTokenRaw(false);
  } catch (silentErr) {
    if (!interactive) throw silentErr;
    return getAuthTokenRaw(true);
  }
}

/** Forces a fresh token after a 401, in case the cached one expired mid-session. */
async function refreshToken(staleToken) {
  await removeCachedToken(staleToken);
  return getAuthTokenRaw(true);
}

/* ============================== Connection state ============================== */

export async function isDriveConnected() {
  return ConfigStore.get('driveConnected', false);
}

export async function getDriveAccountInfo() {
  return ConfigStore.get('driveAccount', null); // {email, name} | null
}

export async function connectDrive() {
  const token = await getValidToken({ interactive: true });
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Connected, but could not read the Google account profile.');
  const profile = await res.json();
  const account = { email: profile.email, name: profile.name || profile.email };
  await ConfigStore.set('driveConnected', true);
  await ConfigStore.set('driveAccount', account);
  track('GOOGLE_DRIVE_CONNECTED', { feature: 'sharing', action: 'drive' });
  return account;
}

export async function disconnectDrive() {
  try {
    const token = await getValidToken({ interactive: false });
    await removeCachedToken(token);
    // Best-effort server-side revoke so the grant also disappears from the
    // user's Google Account permissions page, not just the local cache.
    // `no-cors` is intentional: this endpoint doesn't return CORS headers
    // for cross-origin fetches, and we don't need to read the response —
    // only that the request goes out.
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`, {
      mode: 'no-cors'
    }).catch(() => {});
  } catch (_) {
    // No cached token to revoke — fine, still clear local state below.
  }
  await ConfigStore.set('driveConnected', false);
  await ConfigStore.set('driveAccount', null);
  await ConfigStore.set('driveFolderId', null);
  await ConfigStore.set('driveFolderName', null);
}

/* ============================== Folder selection ============================== */

export async function getStoredFolder() {
  const id = await ConfigStore.get('driveFolderId', null);
  const name = await ConfigStore.get('driveFolderName', null);
  return id ? { id, name } : null;
}

export async function setStoredFolder(id, name) {
  await ConfigStore.set('driveFolderId', id);
  await ConfigStore.set('driveFolderName', name);
}

async function driveFetch(url, options = {}, isRetry = false) {
  const token = await getValidToken({ interactive: false });
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (res.status === 401 && !isRetry) {
    await refreshToken(token);
    return driveFetch(url, options, true);
  }
  return res;
}

/** Lists non-trashed folders directly under "My Drive" root, for the folder picker. */
export async function listRootFolders() {
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false");
  const res = await driveFetch(`${DRIVE_FILES_URL}?q=${q}&fields=files(id,name)&pageSize=50`);
  if (!res.ok) throw new Error(await describeError(res));
  const data = await res.json();
  return data.files || [];
}

export async function createDriveFolder(name) {
  const res = await driveFetch(DRIVE_FILES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!res.ok) throw new Error(await describeError(res));
  return res.json(); // {id, name}
}

/* ============================== Multipart upload body (pure, testable) ============================== */

/**
 * Builds the multipart/related request body Drive's upload endpoint
 * expects: a JSON metadata part followed by the raw file bytes, separated
 * by a boundary. Pulled out as a pure function (metadata + blob in,
 * {blob, boundary} out) so it can be unit tested without any network or
 * chrome.* APIs involved.
 */
export function buildMultipartBody(metadata, fileBlob, boundary = 'cf_' + Math.random().toString(36).slice(2)) {
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadataPart =
    delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata);
  const mediaHeader = delimiter + `Content-Type: ${fileBlob.type || 'application/octet-stream'}\r\n\r\n`;

  const body = new Blob([metadataPart, mediaHeader, fileBlob, closeDelimiter]);
  return { body, boundary };
}

export function buildDriveMetadata(filename, folderId) {
  const metadata = { name: filename };
  if (folderId) metadata.parents = [folderId];
  return metadata;
}

/** Maps a failed Drive API response to a short, user-facing message. */
export async function describeError(res) {
  let detail = `Google Drive request failed (${res.status}).`;
  try {
    const body = await res.json();
    if (body?.error?.message) detail = body.error.message;
  } catch (_) {
    /* non-JSON error body */
  }
  if (res.status === 401) return 'Your Google Drive session expired. Please reconnect.';
  if (res.status === 403) return 'Google Drive denied this request (permission or storage quota).';
  if (res.status === 404) return 'The selected Drive folder no longer exists.';
  if (res.status >= 500) return 'Google Drive is temporarily unavailable. Please retry.';
  return detail;
}

/* ============================== Upload (with progress) ============================== */

/**
 * Uploads a blob to Drive, makes it link-shareable, and returns
 * { id, webViewLink, webContentLink }. Uses XHR (not fetch) so upload
 * progress can be reported, matching the existing backend-upload UX.
 */
export async function uploadToDrive(blob, filename, folderId, onProgress) {
  const token = await getValidToken({ interactive: false });
  const metadata = buildDriveMetadata(filename, folderId);
  const { body, boundary } = buildMultipartBody(metadata, blob);

  const created = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', `multipart/related; boundary=${boundary}`);

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let message = `Google Drive upload failed (${xhr.status}).`;
        try {
          const parsed = JSON.parse(xhr.responseText);
          if (parsed?.error?.message) message = parsed.error.message;
        } catch (_) {
          /* ignore */
        }
        reject(new Error(xhr.status === 401 ? 'Your Google Drive session expired. Please reconnect.' : message));
      }
    };
    xhr.onerror = () => reject(new Error('Network error while uploading to Google Drive.'));
    xhr.send(body);
  });

  // Make the file viewable by anyone with the link — that's what makes
  // "Create Share Link" produce a link that works for people who don't
  // have access to the connected Drive account.
  const permRes = await driveFetch(`${DRIVE_FILES_URL}/${created.id}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });
  if (!permRes.ok) {
    throw new Error('File uploaded, but could not be made shareable: ' + (await describeError(permRes)));
  }

  const linkRes = await driveFetch(`${DRIVE_FILES_URL}/${created.id}?fields=id,webViewLink,webContentLink`);
  if (!linkRes.ok) throw new Error(await describeError(linkRes));
  return linkRes.json();
}
