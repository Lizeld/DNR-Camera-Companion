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
  /** Partial read (start + this many symbols - 1) that marks a photo as a label worth OCR. */
  ocrMinSymbols: 3,
});

/**
 * Where to crop for OCR, from the scanner's best partial read, in the scan
 * canvas's coordinates.
 *
 * A 7-digit label is ~8 symbols plus a stop, so the full bar width is
 * estimated from the symbols that did match; the digits sit under the bars,
 * within about half a barcode-width. The read direction says which way up the
 * label is: rows read forward are upright, rows read in reverse are upside
 * down, and a column read means the label is on its side. `rotate` (degrees
 * clockwise) turns the crop upright for OCR.
 *
 * @returns {{x:number, y:number, w:number, h:number, rotate:0|90|180|270, symbols:number}|null}
 */
export function ocrRegion(best, width, height, minSymbols = DEFAULTS.ocrMinSymbols) {
  if (!best || best.symbols < minSymbols) return null;
  const span = Math.max(1, best.x1 - best.x0);
  const full = Math.max(span, (span / best.symbols) * 8.3);
  const along0 = best.x0 - 0.12 * full;
  const along1 = best.x0 + 1.12 * full;
  const across0 = best.index - 0.75 * full;
  const across1 = best.index + 0.75 * full;

  const clampRect = (x0, y0, x1, y1) => {
    const x = Math.max(0, Math.floor(x0));
    const y = Math.max(0, Math.floor(y0));
    return { x, y, w: Math.min(width, Math.ceil(x1)) - x, h: Math.min(height, Math.ceil(y1)) - y };
  };

  if (best.orientation === 'row') {
    return { ...clampRect(along0, across0, along1, across1), rotate: best.reverse ? 180 : 0, symbols: best.symbols };
  }
  // Column: the read runs top to bottom. Forward means the label's left edge is
  // at the top (turned clockwise), so turn it back anticlockwise.
  return { ...clampRect(across0, along0, across1, along1), rotate: best.reverse ? 90 : 270, symbols: best.symbols };
}

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
 * @returns {Promise<{sku:string|null, method:string|null, boosted:boolean, ms:number,
 *   ocrRegion?:object|null, scanScale?:number}>} on a miss, `ocrRegion` (scan-canvas
 *   coordinates; divide by `scanScale` for the frame's) marks a likely label
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

  const probe = {};
  const done = (sku, method, boosted) => ({
    sku,
    method: sku ? method : null,
    boosted,
    ms: Math.round((typeof performance !== 'undefined' ? performance : Date).now() - t0),
    ...(sku
      ? {}
      : { ocrRegion: ocrRegion(probe.best, width, height, opts.ocrMinSymbols), scanScale: width / (bitmap.width || width) }),
  });

  const detector = await getNativeDetector();

  // Pass 1 — as shot.
  const native1 = await nativeScan(detector, canvas);
  if (native1) return done(native1, 'BarcodeDetector', false);

  const hit1 = scanCode128(grey, width, height, { stride, validate: isValidSku, probe });
  if (hit1 && isValidSku(hit1.text)) return done(hit1.text, 'code128-js', false);

  // Pass 2 — 2.5x contrast boost on greyscale (§2.2).
  const boosted = boostContrast(grey, contrastBoost);
  paintGrey(canvas, boosted, width, height);

  const native2 = await nativeScan(detector, canvas);
  if (native2) return done(native2, 'BarcodeDetector', true);

  const hit2 = scanCode128(boosted, width, height, { stride, validate: isValidSku, probe });
  if (hit2 && isValidSku(hit2.text)) return done(hit2.text, 'code128-js', true);

  return done(null, null, true);
}

/**
 * Cut the OCR region out of the full frame, turned upright and scaled so its
 * long side is at most `maxSide` — Tesseract's time grows with pixels, and
 * printed digits a few dozen pixels tall read best.
 *
 * @param {ImageBitmap|OffscreenCanvas|HTMLCanvasElement} frame full-resolution frame
 * @param {{x:number,y:number,w:number,h:number,rotate:number}} region in scan-canvas coordinates
 * @param {number} scanScale scan-canvas width / frame width (from detectSku)
 * @returns {OffscreenCanvas|HTMLCanvasElement}
 */
export function cropForOcr(frame, region, scanScale, maxSide = 1000) {
  const sx = region.x / scanScale;
  const sy = region.y / scanScale;
  const sw = region.w / scanScale;
  const sh = region.h / scanScale;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k));
  const h = Math.max(1, Math.round(sh * k));
  const sideways = region.rotate === 90 || region.rotate === 270;
  const canvas = makeCanvas(sideways ? h : w, sideways ? w : h);
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((region.rotate * Math.PI) / 180);
  ctx.drawImage(frame, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  return canvas;
}

/** Which backend will be used, for the Settings diagnostics panel. */
export async function describeBackend() {
  const detector = await getNativeDetector();
  return detector
    ? 'BarcodeDetector (native) with pure-JS Code 128 fallback'
    : 'pure-JS Code 128 (BarcodeDetector unavailable)';
}
