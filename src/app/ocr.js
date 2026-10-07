/**
 * OCR fallback for labels whose barcode won't decode.
 *
 * The imaging worker crops a photo that started to read as a barcode but
 * didn't finish; serve.py runs Tesseract on the crop (POST /ocr/sku) and
 * returns any standalone 7-digit numbers. OCR has no checksum, so a number is
 * only *confirmed* when Inventory knows that SKU; otherwise the operator is
 * asked (see the Shoot screen's banner) rather than the part being filed under
 * a misread.
 */

import * as settings from '../core/settings.js';
import * as inventory from './inventory.js';

let availability = null; // Promise<boolean>

/** Whether this server can do OCR (serve.py with Tesseract installed). */
export function available() {
  if (!settings.load().ocrFallback) return Promise.resolve(false);
  availability ??= fetch('/backend/config', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((config) => Boolean(config?.ocr))
    .catch(() => false);
  return availability;
}

/** @returns {Promise<string[]>} 7-digit candidates read off the crop */
export async function readDigits(blob, { timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('/ocr/sku', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.candidates) ? body.candidates.filter((c) => /^\d{7}$/.test(c)) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a SKU off label crops (the same label, each way up) and check the
 * numbers against Inventory.
 *
 * @param {Blob[]} blobs
 * @returns {Promise<null | {sku:string, confirmed:boolean, what:string|null, candidates:string[]}>}
 *   null when nothing 7-digit was read; `confirmed` when Inventory has the SKU.
 *   Unconfirmed, `candidates` lists every number read, best guess first.
 */
export async function identify(blobs) {
  const candidates = [];
  for (const blob of blobs) {
    for (const sku of await readDigits(blob)) if (!candidates.includes(sku)) candidates.push(sku);
  }
  if (candidates.length === 0) return null;
  for (const sku of candidates) {
    const lookup = await inventory.lookupSku(sku);
    if (lookup?.item) return { sku, confirmed: true, what: inventory.describeItem(lookup), candidates };
  }
  return { sku: candidates[0], confirmed: false, what: null, candidates };
}
