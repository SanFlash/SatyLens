import { test } from 'node:test';
import assert from 'node:assert/strict';
const data = { analyticsEnabled: false, analyticsQueue: [{ error_message: 'private URL' }] };
globalThis.chrome = {
  runtime: { lastError: null, getManifest: () => ({ version: '1.23.1' }) },
  storage: { local: {
    get(keys, callback) { callback(Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]]))); },
    set(values, callback) { Object.assign(data, values); callback(); }
  } }
};
let requests = [];
globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true }; };
const analytics = await import('../extension/shared/analytics.js');
test('opt-out prevents persisted queue uploads and clears it', async () => {
  await analytics.flush();
  assert.equal(requests.length, 0);
  assert.deepEqual(data.analyticsQueue, []);
});
test('disabling analytics clears pending errors without resetting share identity', async () => {
  data.analyticsClientId = 'legacy-sharing-identity';
  data.analyticsQueue = [{ error_message: 'secret' }];
  await analytics.setAnalyticsEnabled(false);
  assert.deepEqual(data.analyticsQueue, []);
  assert.equal(data.analyticsClientId, 'legacy-sharing-identity');
});
test('old persisted error text is stripped before sending', async () => {
  data.analyticsEnabled = true;
  data.analyticsQueue = [{ event_type: 'ERROR_OCCURRED', error_message: 'https://private.example/?token=secret' }];
  await analytics.flush();
  const payload = JSON.parse(requests.at(-1).options.body);
  assert.equal(payload.events[0].error_message, 'operation_failed');
});


test('clearing telemetry preserves the installation scope of existing share history', async () => {
  const legacyId = data.analyticsClientId;
  await analytics.clearLocalTelemetryData();
  assert.equal(await analytics.getAnalyticsClientId(), legacyId);
  assert.notEqual(data.analyticsClientId, legacyId);
});
