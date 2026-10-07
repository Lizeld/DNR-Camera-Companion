/**
 * IndexedDB metadata store — spec §6.2.
 *
 * Photo bytes never live here; see blobstore.js. This holds only the small
 * per-photo record and the pipeline's meta keys.
 */

const DB_NAME = 'dnr-watermark';
const DB_VERSION = 1;

export const STATUS = Object.freeze({
  PENDING: 'PENDING',
  GROUPED: 'GROUPED',
  REVIEW: 'REVIEW',
  UPLOADED: 'UPLOADED',
  FAILED: 'FAILED',
});

let dbPromise = null;

/** @returns {Promise<IDBDatabase>} */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('photos')) {
        const photos = db.createObjectStore('photos', { keyPath: 'dcfKey' });
        photos.createIndex('status', 'status', { unique: false });
        photos.createIndex('sku', 'sku', { unique: false });
        photos.createIndex('sequenceNumber', 'sequenceNumber', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // Fallback byte store, used when OPFS is unavailable (insecure context).
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
  });
  return { t, done };
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @typedef {Object} Photo
 * @property {string} dcfKey          PRIMARY KEY — "100CANON/IMG_0017.JPG"
 * @property {string} sourcePath      provenance (CCAPI path)
 * @property {string} fileName
 * @property {number|null} sequenceNumber
 * @property {string|null} sku
 * @property {'PENDING'|'GROUPED'|'REVIEW'|'UPLOADED'|'FAILED'} status
 * @property {string|null} opfsPath   null once deleted post-upload
 * @property {string|null} publicUrl  set on upload; the draft is built from these
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string|null} [error]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [bytes]
 */

/** @returns {Photo} */
export function makePhoto(fields) {
  const now = Date.now();
  return {
    dcfKey: fields.dcfKey,
    sourcePath: fields.sourcePath ?? '',
    fileName: fields.fileName ?? fields.dcfKey.split('/').pop(),
    sequenceNumber: fields.sequenceNumber ?? null,
    sku: fields.sku ?? null,
    status: fields.status ?? STATUS.PENDING,
    opfsPath: fields.opfsPath ?? null,
    publicUrl: fields.publicUrl ?? null,
    createdAt: fields.createdAt ?? now,
    updatedAt: now,
    error: fields.error ?? null,
    width: fields.width ?? null,
    height: fields.height ?? null,
    bytes: fields.bytes ?? null,
  };
}

export async function putPhoto(photo) {
  const db = await openDb();
  const { t, done } = tx(db, ['photos'], 'readwrite');
  t.objectStore('photos').put({ ...photo, updatedAt: Date.now() });
  await done;
  return photo;
}

export async function getPhoto(dcfKey) {
  const db = await openDb();
  const { t } = tx(db, ['photos'], 'readonly');
  return wrap(t.objectStore('photos').get(dcfKey));
}

export async function hasPhoto(dcfKey) {
  const db = await openDb();
  const { t } = tx(db, ['photos'], 'readonly');
  const count = await wrap(t.objectStore('photos').count(dcfKey));
  return count > 0;
}

/** Merge a patch into an existing record. No-op if the record is gone. */
export async function updatePhoto(dcfKey, patch) {
  const db = await openDb();
  const { t, done } = tx(db, ['photos'], 'readwrite');
  const store = t.objectStore('photos');
  const existing = await wrap(store.get(dcfKey));
  if (!existing) {
    await done.catch(() => {});
    return null;
  }
  const merged = { ...existing, ...patch, updatedAt: Date.now() };
  store.put(merged);
  await done;
  return merged;
}

export async function allPhotos() {
  const db = await openDb();
  const { t } = tx(db, ['photos'], 'readonly');
  return wrap(t.objectStore('photos').getAll());
}

export async function photosByStatus(status) {
  const db = await openDb();
  const { t } = tx(db, ['photos'], 'readonly');
  return wrap(t.objectStore('photos').index('status').getAll(status));
}

export async function photosBySku(sku) {
  const db = await openDb();
  const { t } = tx(db, ['photos'], 'readonly');
  const rows = await wrap(t.objectStore('photos').index('sku').getAll(sku));
  return rows.sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0));
}

/** Every dcfKey ever recorded — the dedup set, rehydrated on startup. */
export async function allKeys() {
  const db = await openDb();
  const { t } = tx(db, ['photos'], 'readonly');
  return wrap(t.objectStore('photos').getAllKeys());
}

export async function deletePhoto(dcfKey) {
  const db = await openDb();
  const { t, done } = tx(db, ['photos'], 'readwrite');
  t.objectStore('photos').delete(dcfKey);
  await done;
}

// ---- meta ---------------------------------------------------------------

export async function getMeta(key, fallback = null) {
  const db = await openDb();
  const { t } = tx(db, ['meta'], 'readonly');
  const row = await wrap(t.objectStore('meta').get(key));
  return row === undefined ? fallback : row.value;
}

export async function setMeta(key, value) {
  const db = await openDb();
  const { t, done } = tx(db, ['meta'], 'readwrite');
  t.objectStore('meta').put({ key, value });
  await done;
  return value;
}

/** Counts by status, for the Status screen. */
export async function statusCounts() {
  const rows = await allPhotos();
  const counts = { PENDING: 0, GROUPED: 0, REVIEW: 0, UPLOADED: 0, FAILED: 0, total: rows.length };
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

/** Wipe everything. Settings only. */
export async function clearAll() {
  const db = await openDb();
  const { t, done } = tx(db, ['photos', 'meta', 'blobs'], 'readwrite');
  t.objectStore('photos').clear();
  t.objectStore('meta').clear();
  t.objectStore('blobs').clear();
  await done;
}
