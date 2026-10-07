/**
 * SKU detection — spec §2.2.
 *
 * - Valid SKU is exactly 7 digits
 * - Symbology is Code 128
 * - Read from a downscaled copy, longest side ~1600px (3-4x faster and
 *   sufficient, because the label is shot deliberately at close range)
 * - On failure, retry once with a 2.5x contrast boost applied to greyscale
 * - Most photos legitimately return nothing; only the last of a group carries
 *   a label
 */

import { scanCode128 } from './code128.js';

export const SKU_PATTERN = /^\d{7}$/;

/** @returns {boolean} */
export function isValidSku(text) {
  return typeof text === 'string' && SKU_PATTERN.test(text);
}

export const DEFAULTS = Object.freeze({
  targetLongSide: 1600,
  contrastBoost: 2.5,
  scanStride: 6,
});

let detectorPromise;

/**
 * `BarcodeDetector` is Chrome/Android only and, on some builds, reports
 * support but fails at construction. Probe once and cache the answer.
 * @returns {Promise<BarcodeDetector|null>}
 */
function getNativeDetector() {
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    /* global BarcodeDetector */
    if (typeof BarcodeDetector === 'undefined') return null;
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (!formats.includes('code_128')) return null;
      return new BarcodeDetector({ formats: ['code_128'] });
    } catch {
      return null;
    }
  })();
  return detectorPromise;
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Downscale so the longest side is ~`targetLongSide`, never upscaling.
 * @returns {{canvas:(OffscreenCanvas|HTMLCanvasElement), width:number, height:number, scale:number}}
 */
export function downscaleForScan(bitmap, targetLongSide = DEFAULTS.targetLongSide, reuse = null) {
  const longSide = Math.max(bitmap.width, bitmap.height);
  const scale = longSide > targetLongSide ? targetLongSide / longSide : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = reuse ?? makeCanvas(width, height);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return { canvas, width, height, scale };
}

/** ITU-R BT.601 luma, the same weighting the reference pipeline used. */
export function toGreyscale(rgba, out = null) {
  const n = rgba.length / 4;
  const grey = out ?? new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    grey[i] = (rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114) | 0;
  }
  return grey;
}

/**
 * Linear contrast boost about mid-grey: v' = clamp((v - 128) * factor + 128).
 * Applied to greyscale, per §2.2's retry rule.
 */
export function boostContrast(grey, factor = DEFAULTS.contrastBoost, out = null) {
  const dst = out ?? new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i++) {
    const v = (grey[i] - 128) * factor + 128;
    dst[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return dst;
}

/** Write a greyscale buffer back into a canvas so the native detector can see it. */
function paintGrey(canvas, grey, width, height) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(width, height);
  for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
    img.data[j] = img.data[j + 1] = img.data[j + 2] = grey[i];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

async function nativeScan(detector, source) {
  if (!detector) return null;
  try {
    const codes = await detector.detect(source);
    for (const c of codes) {
      if (isValidSku(c.rawValue)) return c.rawValue;
    }
  } catch {
    // Detector failures are routine (unsupported source, transient GPU error).
    // Fall through to the JS scanner rather than failing the photo.
  }
  return null;
}

/**
 * Detect a 7-digit SKU in a photo.
 *
 * @param {ImageBitmap|HTMLCanvasElement|OffscreenCanvas} bitmap full-resolution frame
 * @param {object} [opts]
 * @param {OffscreenCanvas|HTMLCanvasElement} [opts.scanCanvas] canvas to reuse across photos
 * @returns {Promise<{sku:string|null, method:string|null, boosted:boolean, ms:number}>}
 */
export async function detectSku(bitmap, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const targetLongSide = opts.targetLongSide ?? DEFAULTS.targetLongSide;
  const contrastBoost = opts.contrastBoost ?? DEFAULTS.contrastBoost;
  const stride = opts.scanStride ?? DEFAULTS.scanStride;

  const { canvas, width, height } = downscaleForScan(bitmap, targetLongSide, opts.scanCanvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const grey = toGreyscale(rgba);

  const done = (sku, method, boosted) => ({
    sku,
    method: sku ? method : null,
    boosted,
    ms: Math.round((typeof performance !== 'undefined' ? performance : Date).now() - t0),
  });

  const detector = await getNativeDetector();

  // Pass 1 — as shot.
  const native1 = await nativeScan(detector, canvas);
  if (native1) return done(native1, 'BarcodeDetector', false);

  const hit1 = scanCode128(grey, width, height, { stride, validate: isValidSku });
  if (hit1 && isValidSku(hit1.text)) return done(hit1.text, 'code128-js', false);

  // Pass 2 — 2.5x contrast boost on greyscale (§2.2).
  const boosted = boostContrast(grey, contrastBoost);
  paintGrey(canvas, boosted, width, height);

  const native2 = await nativeScan(detector, canvas);
  if (native2) return done(native2, 'BarcodeDetector', true);

  const hit2 = scanCode128(boosted, width, height, { stride, validate: isValidSku });
  if (hit2 && isValidSku(hit2.text)) return done(hit2.text, 'code128-js', true);

  return done(null, null, true);
}

/** Which backend will be used, for the Settings diagnostics panel. */
export async function describeBackend() {
  const detector = await getNativeDetector();
  return detector
    ? 'BarcodeDetector (native) with pure-JS Code 128 fallback'
    : 'pure-JS Code 128 (BarcodeDetector unavailable)';
}
