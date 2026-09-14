import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';

for (const base of ['extension', 'desktop/renderer']) {
  test(`${base}: untrusted capture metadata renders as text`, async () => {
    const html = await readFile(new URL(`../${base}/gallery/gallery.html`, import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'https://extension.test/gallery/gallery.html' });
    const { window } = dom;
    globalThis.document = window.document;
    globalThis.window = window;
    globalThis.location = window.location;
    globalThis.indexedDB = new IDBFactory();
    globalThis.chrome = {
      runtime: { onMessage: { addListener() {} }, getManifest: () => ({ version: '1.23.1' }) },
      storage: { local: { get: (_, cb) => cb({ analyticsEnabled: false }), set: (_, cb) => cb() } },
      tabs: { create() {} }
    };
    const { CaptureStore } = await import(`../${base}/shared/storage.js`);
    await CaptureStore.add({ id: 'xss-test', type: 'screenshot', name: 'test.png',
      createdAt: Date.now(), size: 10, blob: new Blob(['test']),
      mimeType: '<img id="injected-mime" src="x">',
      tags: ['<img id="injected-tag" src="x">'] });
    await new Promise(resolve => setTimeout(resolve, 0));
    await import(`../${base}/gallery/gallery.js`);
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    for (let i = 0; i < 20 && !document.querySelector('.cf-card'); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const card = document.querySelector('.cf-card');
    assert.ok(card, 'real gallery module renders the persisted capture');
    card.click();
    assert.equal(document.querySelector('#injected-tag'), null);
    assert.equal(document.querySelector('#injected-mime'), null);
    if (base === 'extension') assert.match(document.querySelector('#modalTags').textContent, /<img id="injected-tag"/);
    assert.match(document.querySelector('#modalMeta').textContent, /<img id="injected-mime"/);
    if (base === 'extension') {
      document.querySelector('#modalTags button').click();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual((await CaptureStore.get('xss-test')).tags, []);
    }
    window.dispatchEvent(new window.Event('unload'));
    dom.window.close();
  });
}
