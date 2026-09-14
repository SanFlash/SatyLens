import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBDatabase } from 'fake-indexeddb';
globalThis.indexedDB = indexedDB;
const { CaptureStore } = await import('../extension/shared/storage.js');

test('existing v1 capture blobs and share metadata survive open/update', async () => {
  const blob = new Blob(['original pixels'], { type: 'image/png' });
  await CaptureStore.add({ id: 'original', createdAt: 1, blob, shareUrl: 'https://example.com/s/existing' });
  await CaptureStore.update('original', { name: 'Renamed.png', id: 'wrong-id' });
  const capture = await CaptureStore.get('original');
  assert.equal(capture.id, 'original');
  assert.equal(await capture.blob.text(), 'original pixels');
  assert.equal(capture.shareUrl, 'https://example.com/s/existing');
  assert.equal(await CaptureStore.get('wrong-id'), null);
});

test('recent captures are newest first and do not use getAll', async () => {
  await CaptureStore.add({ id: 'newer', createdAt: 2 });
  await CaptureStore.add({ id: 'newest', createdAt: 3 });
  const getAll = CaptureStore.getAll;
  CaptureStore.getAll = () => { throw Error('Full gallery must not be read'); };
  try {
    assert.deepEqual((await CaptureStore.getRecent(2)).map(x => x.id), ['newest', 'newer']);
    assert.deepEqual(await CaptureStore.getRecent(0), []);
    await assert.rejects(CaptureStore.getRecent(-1));
  } finally { CaptureStore.getAll = getAll; }
});

test('request success followed by transaction abort rejects the save', async () => {
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const transaction = original.apply(this, args);
    if (args[1] === 'readwrite') {
      const objectStore = transaction.objectStore.bind(transaction);
      transaction.objectStore = (...params) => {
        const store = objectStore(...params);
        const add = store.add.bind(store);
        store.add = (...values) => {
          const req = add(...values);
          req.addEventListener('success', () => transaction.abort());
          return req;
        };
        return store;
      };
    }
    return transaction;
  };
  try {
    await assert.rejects(CaptureStore.add({ id: 'aborted', createdAt: 4 }));
    assert.equal(await CaptureStore.get('aborted'), null);
  } finally { IDBDatabase.prototype.transaction = original; }
});

test('missing capture update rejects without inserting data', async () => {
  await assert.rejects(CaptureStore.update('missing', { name: 'test' }), /not found/);
});
