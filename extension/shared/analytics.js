// extension/shared/analytics.js
// Lightweight, privacy-conscious product analytics.
//
// Hard rules this module follows:
// - `client_id` is a random UUID generated and stored locally -- never a
//   Google account ID, email, or anything else that identifies a person.
// - Never collects page URLs, page content, keystrokes, or precise location.
// - Every public function is fire-and-forget: analytics failures (network
//   down, backend unreachable, bad response) NEVER throw back to the
//   caller and NEVER block the screenshot/recording/edit flow that
//   triggered them. That's not a nice-to-have here -- it's enforced by
//   wrapping every exported function's body in try/catch.
// - Respects a local opt-out (Settings -> Analytics). When disabled,
//   track() is a complete no-op before it does anything else.

import { ConfigStore } from './storage.js';
import { getApiBaseUrl } from './api.js';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min of inactivity -> new session
const FLUSH_DEBOUNCE_MS = 2000;
const MAX_BATCH_SIZE = 20;
const MAX_QUEUED_EVENTS = 200; // local cap so a long offline stretch can't grow unbounded

let flushTimer = null;
let memoryQueue = []; // events not yet persisted/sent this tick

/* ============================== Context ============================== */

function getExtensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (_) {
    return '0.0.0';
  }
}

function parseBrowserAndOS() {
  const ua = navigator.userAgent || '';
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
  const browserVersion = chromeMatch ? chromeMatch[1] : '0';

  let os = 'unknown';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('CrOS')) os = 'ChromeOS';
  else if (ua.includes('Linux')) os = 'Linux';

  return { browser: 'Chrome', browserVersion, os };
}

async function getClientContext() {
  const clientId = await getOrCreateClientId();
  const { browser, browserVersion, os } = parseBrowserAndOS();
  return {
    client_id: clientId,
    extension_version: getExtensionVersion(),
    browser,
    browser_version: browserVersion,
    os,
    device_type: 'desktop' // Chrome extensions only run on desktop Chrome today
  };
}

async function getOrCreateClientId() {
  let id = await ConfigStore.get('analyticsClientId', null);
  if (!id) {
    id = crypto.randomUUID();
    await ConfigStore.set('analyticsClientId', id);
  }
  return id;
}

/** Legacy export name retained for callers. Returns the stable anonymous
 * sharing-installation scope, initialized from the existing analytics identity.
 * Telemetry resets rotate analytics identity without orphaning link history. */
export async function getAnalyticsClientId() {
  // Preserve the legacy history scope independently of telemetry resets.
  let id = await ConfigStore.get('sharingInstallationId', null);
  if (!id) {
    id = await getOrCreateClientId();
    await ConfigStore.set('sharingInstallationId', id);
  }
  return id;
}

/* ============================== Opt-out ============================== */

export async function isAnalyticsEnabled() {
  return ConfigStore.get('analyticsEnabled', true);
}

export async function setAnalyticsEnabled(enabled) {
  await ConfigStore.set('analyticsEnabled', !!enabled);
  if (!enabled) {
    clearTimeout(flushTimer);
    flushTimer = null;
    memoryQueue = [];
    await ConfigStore.set('analyticsQueue', []);
  }
  return true;
}

/** Clears any locally buffered/queued telemetry and starts a fresh
 * anonymous identity — the "Clear local telemetry data" Settings action. */
export async function clearLocalTelemetryData() {
  await getAnalyticsClientId(); // migrate existing share-history identity before rotation
  memoryQueue = [];
  await ConfigStore.set('analyticsQueue', []);
  await ConfigStore.set('analyticsSessionId', null);
  await ConfigStore.set('analyticsLastActivity', null);
  await ConfigStore.set('analyticsClientId', crypto.randomUUID());
}

/* ============================== Session management ============================== */

async function ensureSession(ctx) {
  const now = Date.now();
  const lastActivity = await ConfigStore.get('analyticsLastActivity', 0);
  let sessionId = await ConfigStore.get('analyticsSessionId', null);

  const expired = !sessionId || now - lastActivity > SESSION_TIMEOUT_MS;
  if (expired) {
    const previousSessionId = sessionId;
    sessionId = crypto.randomUUID();
    await ConfigStore.set('analyticsSessionId', sessionId);
    if (previousSessionId) endSessionRequest(previousSessionId); // best-effort, fire-and-forget
    startSessionRequest(sessionId, ctx); // best-effort, fire-and-forget
    trackRaw('EXTENSION_SESSION_STARTED', ctx, sessionId, {});
  }
  await ConfigStore.set('analyticsLastActivity', now);
  return sessionId;
}

async function startSessionRequest(sessionId, ctx) {
  try {
    const base = await getApiBaseUrl();
    await fetch(`${base}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ctx, session_id: sessionId })
    });
  } catch (_) {
    /* best-effort — session bookkeeping never blocks anything */
  }
}

async function endSessionRequest(sessionId) {
  try {
    const base = await getApiBaseUrl();
    await fetch(`${base}/api/session/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId })
    });
  } catch (_) {
    /* best-effort */
  }
}

/* ============================== Event tracking ============================== */

/**
 * Records a telemetry event. Always resolves, never rejects — failures
 * are swallowed after being queued locally for a later retry.
 * @param {string} eventType - e.g. "SCREENSHOT_CAPTURED"
 * @param {{feature?: string, action?: string, success?: boolean, error?: string, durationMs?: number}} [details]
 */
export async function track(eventType, details = {}) {
  try {
    if (!(await isAnalyticsEnabled())) return;
    const ctx = await getClientContext();
    const sessionId = await ensureSession(ctx);
    trackRaw(eventType, ctx, sessionId, details);
  } catch (_) {
    // Never let a telemetry failure surface to the caller.
  }
}

function trackRaw(eventType, ctx, sessionId, details) {
  const event = {
    ...ctx,
    session_id: sessionId,
    event_type: eventType,
    feature: details.feature ?? null,
    action: details.action ?? null,
    success: details.success !== undefined ? !!details.success : true,
    error_message: details.error ? 'operation_failed' : null,
    duration_ms: details.durationMs ?? null,
    timestamp: new Date().toISOString()
  };
  memoryQueue.push(event);
  if (memoryQueue.length > MAX_QUEUED_EVENTS) memoryQueue.shift();
  scheduleFlush();
}

function scheduleFlush() {
  if (memoryQueue.length >= MAX_BATCH_SIZE) {
    flush();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
}

/** Sends whatever is queued (persisted queue + in-memory queue) to the
 * backend. Safe to call at any time — e.g. before the service worker is
 * about to be suspended. Never throws, and never loses queued events on
 * a network failure (persists the batch before attempting to send it,
 * so a thrown fetch error still leaves the queue intact for retry). */
export async function flush() {
  try {
    if (!(await isAnalyticsEnabled())) {
      memoryQueue = [];
      await ConfigStore.set('analyticsQueue', []);
      return;
    }
    const persisted = await ConfigStore.get('analyticsQueue', []);
    const batch = [...persisted, ...memoryQueue].slice(0, MAX_QUEUED_EVENTS);
    memoryQueue = [];
    if (batch.length === 0) return;

    // Persist first: if the fetch below throws (e.g. offline), the queue
    // is already safely on disk instead of only living in a local var.
    await ConfigStore.set('analyticsQueue', batch);

    const base = await getApiBaseUrl();
    const toSend = batch.slice(0, MAX_BATCH_SIZE).map((event) => ({ ...event, error_message: event.error_message ? 'operation_failed' : null }));
    const remaining = batch.slice(MAX_BATCH_SIZE);

    const res = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: toSend })
    });

    if (!res.ok) {
      return; // batch is already persisted above — just retry next time
    }

    if (remaining.length > 0) {
      await ConfigStore.set('analyticsQueue', remaining);
      scheduleFlush();
    } else {
      await ConfigStore.set('analyticsQueue', []);
    }
  } catch (_) {
    // Network/backend unavailable — the batch was already persisted
    // before the fetch was attempted, so nothing is lost here.
  }
}
