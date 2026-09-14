// extension/shared/storage.js
// IndexedDB persistence layer for captures (screenshots + recordings).
// Never use chrome.storage.local for blobs — it is quota-limited (~10MB total)
// and not designed for binary data. IndexedDB handles large video blobs fine.

const DB_NAME = 'satylens';
const DB_VERSION = 1;
const STORE = 'captures';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open tab.'));
  });
  dbPromise = dbPromise.catch((error) => { dbPromise = null; throw error; });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

/**
 * Capture record shape:
 * {
 *   id, type ('screenshot'|'recording'), name, mimeType, blob, thumbnail,
 *   size, createdAt, duration, width, height, uploaded, shareUrl, shareId
 * }
 */
export const CaptureStore = {
  async add(capture) {
    const store = await tx(STORE, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.add(capture);
      store.transaction.oncomplete = () => resolve(capture);
      store.transaction.onabort = () => reject(store.transaction.error || new Error('Capture was not saved. Retry after freeing local storage.'));
      req.onerror = () => reject(req.error);
    });
  },

  async update(id, patch) {
    const store = await tx(STORE, 'readwrite');
    return new Promise((resolve, reject) => {
      store.transaction.onabort = () => reject(store.transaction.error || new Error('Capture update was not saved.'));
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) return reject(new Error('Capture not found: ' + id));
        const merged = { ...existing, ...patch, id: existing.id };
        const putReq = store.put(merged);
        store.transaction.oncomplete = () => resolve(merged);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  },

  async get(id) {
    const store = await tx(STORE, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async delete(id) {
    const store = await tx(STORE, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      store.transaction.oncomplete = () => resolve(true);
      store.transaction.onabort = () => reject(store.transaction.error || new Error('Local storage operation was not committed.'));
      req.onerror = () => reject(req.error);
    });
  },

  async getAll() {
    const store = await tx(STORE, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
      req.onerror = () => reject(req.error);
    });
  },

  async getRecent(limit = 4) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error('Recent capture limit must be a non-negative integer.');
    if (limit === 0) return [];
    const store = await tx(STORE, 'readonly');
    return new Promise((resolve, reject) => {
      const items = [];
      const req = store.index('createdAt').openCursor(null, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || items.length >= limit) return resolve(items);
        items.push(cursor.value);
        if (items.length === limit) resolve(items);
        else cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },

  async clear() {
    const store = await tx(STORE, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.clear();
      store.transaction.oncomplete = () => resolve(true);
      store.transaction.onabort = () => reject(store.transaction.error || new Error('Local storage operation was not committed.'));
      req.onerror = () => reject(req.error);
    });
  }
};

// Small key/value helper for non-blob config (API base URL, preferences).
// This is fine for chrome.storage.local since it's tiny text data.
export const ConfigStore = {
  async get(key, fallback = null) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(key in result ? result[key] : fallback);
      });
    });
  },
  async set(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve(true));
    });
  }
};
