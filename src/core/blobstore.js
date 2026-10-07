/**
 * Image byte store — spec §5.3/§5.4 wants OPFS.
 *
 * ⚠ Deployment interaction the spec does not call out. OPFS
 * (`navigator.storage.getDirectory`) is gated on a **secure context**, and the
 * recommended deployment (§5.1 option A: LAN-served over plain HTTP) is an
 * insecure context on every address except `localhost`. So on the tablet, OPFS
 * is simply not there.
 *
 * Fallback is a Blob in IndexedDB. §5.4 warns against "IndexedDB blobs", and
 * that warning is about *memory* — but a Blob stored in IndexedDB is backed by
 * disk in Chrome and Firefox, not held on the JS heap; the thing to avoid is
 * keeping decoded `ImageData`/`ArrayBuffer`s around, which we never do. The
 * real cost of the fallback is a copy on read/write rather than a file handle.
 *
 * Which backend is live is surfaced in Settings, because it changes the
 * failure modes worth looking for.
 */

import { openDb } from './db.js';

const ROOT_DIR = 'photos';

let backendPromise = null;

/** @returns {Promise<'opfs'|'indexeddb'>} */
export function backend() {
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return 'indexeddb';
    if (typeof isSecureContext !== 'undefined' && !isSecureContext) return 'indexeddb';
    try {
      const root = await navigator.storage.getDirectory();
      await root.getDirectoryHandle(ROOT_DIR, { create: true });
      return 'opfs';
    } catch {
      return 'indexeddb';
    }
  })();
  return backendPromise;
}

/** Human-readable backend description plus the reason, for Settings. */
export async function describeBackend() {
  const kind = await backend();
  if (kind === 'opfs') return { kind, label: 'OPFS (origin private file system)', note: '' };
  const insecure = typeof isSecureContext !== 'undefined' && !isSecureContext;
  return {
    kind,
    label: 'IndexedDB blob store',
    note: insecure
      ? 'OPFS needs a secure context; this page is served over plain HTTP (§5.1 option A).'
      : 'OPFS unavailable in this browser.',
  };
}

/** OPFS paths are flat: "100CANON/IMG_0017.JPG" -> "100CANON__IMG_0017.JPG". */
function flatten(dcfKey) {
  return dcfKey.replace(/[/\\]/g, '__');
}

async function opfsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_DIR, { create: true });
}

/**
 * Persist bytes for a photo.
 * @param {string} dcfKey
 * @param {Blob} blob
 * @returns {Promise<string>} storage path to record as `opfsPath`
 */
export async function put(dcfKey, blob) {
  const name = flatten(dcfKey);
  if ((await backend()) === 'opfs') {
    const dir = await opfsDir();
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
    } finally {
      await writable.close();
    }
    return `${ROOT_DIR}/${name}`;
  }

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['blobs'], 'readwrite');
    t.objectStore('blobs').put({ path: name, blob, size: blob.size, type: blob.type });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return `idb:${name}`;
}

/**
 * Read bytes back.
 * @returns {Promise<Blob|null>} null if the file is gone (already cleaned up)
 */
export async function get(storagePath) {
  if (!storagePath) return null;
  if (storagePath.startsWith('idb:')) {
    const db = await openDb();
    const row = await new Promise((resolve, reject) => {
      const t = db.transaction(['blobs'], 'readonly');
      const req = t.objectStore('blobs').get(storagePath.slice(4));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return row?.blob ?? null;
  }

  try {
    const dir = await opfsDir();
    const handle = await dir.getFileHandle(storagePath.split('/').pop(), { create: false });
    return await handle.getFile();
  } catch {
    return null;
  }
}

/** Delete bytes. Safe to call twice — cleanup runs after every confirmed draft. */
export async function remove(storagePath) {
  if (!storagePath) return;
  if (storagePath.startsWith('idb:')) {
    const db = await openDb();
    await new Promise((resolve) => {
      const t = db.transaction(['blobs'], 'readwrite');
      t.objectStore('blobs').delete(storagePath.slice(4));
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
      t.onabort = () => resolve();
    });
    return;
  }
  try {
    const dir = await opfsDir();
    await dir.removeEntry(storagePath.split('/').pop());
  } catch { /* already gone */ }
}

/** Best-effort storage usage, for the Settings screen. */
export async function usage() {
  try {
    const { usage: used = 0, quota = 0 } = await navigator.storage.estimate();
    return { used, quota };
  } catch {
    return { used: 0, quota: 0 };
  }
}

/**
 * Ask the browser not to evict our data under pressure. Requires a secure
 * context in some browsers, so failure is normal and non-fatal.
 */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
