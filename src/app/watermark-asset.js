/**
 * The watermark asset.
 *
 * Production ships `assets/watermark.png` (796x854 in the reference pipeline).
 * The operator can override it from Settings; the override is stored in
 * IndexedDB so it survives a reload without needing a rebuild.
 */

import { openDb } from '../core/db.js';
import { log } from '../core/log.js';

const BUNDLED_URL = new URL('../../assets/watermark.png', import.meta.url).href;
const META_KEY = 'watermarkOverride';

let cached = null;

async function readOverride() {
  const db = await openDb();
  return new Promise((resolve) => {
    const t = db.transaction(['meta'], 'readonly');
    const req = t.objectStore('meta').get(META_KEY);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => resolve(null);
  });
}

async function writeOverride(value) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['meta'], 'readwrite');
    if (value === null) t.objectStore('meta').delete(META_KEY);
    else t.objectStore('meta').put({ key: META_KEY, value });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/**
 * @returns {Promise<ImageBitmap|null>} null if no watermark is available, in
 * which case the renderer still draws the bars — the bars are the part the
 * parity contract is strict about.
 */
export async function loadWatermark() {
  if (cached) return cached;

  const override = await readOverride();
  if (override?.blob) {
    cached = await createImageBitmap(override.blob);
    return cached;
  }

  try {
    const response = await fetch(BUNDLED_URL, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cached = await createImageBitmap(await response.blob());
    return cached;
  } catch (err) {
    log.warn(
      'No watermark asset loaded — bars will be drawn without a logo. Supply one in Settings.',
      err.message,
    );
    return null;
  }
}

export async function setCustomWatermark(file) {
  const bitmap = await createImageBitmap(file);
  bitmap.close();
  await writeOverride({ blob: file, name: file.name, size: file.size, at: Date.now() });
  cached?.close();
  cached = null;
  return loadWatermark();
}

export async function clearCustomWatermark() {
  await writeOverride(null);
  cached?.close();
  cached = null;
  return loadWatermark();
}

/** Description for the Settings screen. */
export async function watermarkInfo() {
  const override = await readOverride();
  const bitmap = await loadWatermark();
  if (!bitmap) return { label: 'none loaded', custom: false };
  const size = `${bitmap.width}x${bitmap.height}`;
  return override
    ? { label: `${override.name} (${size}, custom)`, custom: true }
    : { label: `assets/watermark.png (${size}, bundled)`, custom: false };
}
