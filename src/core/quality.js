/**
 * Photo checks that run on the tablet before upload: is a photo sharp, is it
 * exposed well, and does the part have enough photos. Pure — works on raw
 * RGBA pixels (the worker hands it a downscaled copy of each frame), so it is
 * testable without a canvas.
 *
 * Sharpness is the variance of a Laplacian per tile, and the photo's score is
 * the 90th-percentile tile. Product shots are mostly plain backdrop, which is
 * smooth whether or not the lens focused, so a whole-frame average would call
 * every sharp photo blurry; the sharpest tiles are where the part is.
 */

/** Width the worker downscales to before measuring. */
export const MEASURE_WIDTH = 1200;

// Calibrated on 25 real R50 product shots (two drafts, Oct 2026), measured at
// MEASURE_WIDTH: sharp photos scored 200-1600; the same photos with a Gaussian
// blur of sigma 1 px at full size (not visible at eBay's 1600 px) 26-56,
// sigma 1.5 (visibly soft) 10-19, sigma 3 under 11. Normal exposure was mean
// 80-183 with at most 7% blown out; darkened copies 27-64, brightened ones
// 24-82% blown out.
export const THRESHOLDS = Object.freeze({
  /** 90th-percentile tile Laplacian variance below this = blurry. */
  blurry: 20,
  /** Mean luminance (0-255). */
  dark: 65,
  bright: 215,
  /** Fraction of blown-out pixels (>= 250) that makes a photo overexposed. */
  clipped: 0.15,
  /** eBay listings with fewer photos sell worse; 8+ is the shop's rule of thumb. */
  minPhotos: 8,
});

const GRID_X = 8;
const GRID_Y = 6;

/**
 * @param {{data:Uint8ClampedArray|Uint8Array, width:number, height:number}} img RGBA
 * @returns {{sharpness:number, brightness:number, clipped:number}}
 */
export function measure({ data, width, height }) {
  const n = width * height;
  const lum = new Float32Array(n);
  let sum = 0;
  let clipped = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    lum[i] = y;
    sum += y;
    if (y >= 250) clipped++;
  }

  // Per-tile mean and variance of the 4-neighbour Laplacian.
  const tiles = GRID_X * GRID_Y;
  const s1 = new Float64Array(tiles);
  const s2 = new Float64Array(tiles);
  const count = new Uint32Array(tiles);
  const tw = width / GRID_X;
  const th = height / GRID_Y;
  for (let y = 1; y < height - 1; y++) {
    const ty = Math.min(GRID_Y - 1, Math.floor(y / th)) * GRID_X;
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap = lum[i - 1] + lum[i + 1] + lum[i - width] + lum[i + width] - 4 * lum[i];
      const t = ty + Math.min(GRID_X - 1, Math.floor(x / tw));
      s1[t] += lap;
      s2[t] += lap * lap;
      count[t]++;
    }
  }
  const variances = [];
  for (let t = 0; t < tiles; t++) {
    if (!count[t]) continue;
    const mean = s1[t] / count[t];
    variances.push(s2[t] / count[t] - mean * mean);
  }
  variances.sort((a, b) => a - b);
  const p90 = variances.length ? variances[Math.min(variances.length - 1, Math.floor(variances.length * 0.9))] : 0;

  return {
    sharpness: Math.round(p90 * 10) / 10,
    brightness: Math.round((sum / n) * 10) / 10,
    clipped: Math.round((clipped / n) * 1000) / 1000,
  };
}

/**
 * Problems with one photo, worst first.
 * @param {{sharpness:number, brightness:number, clipped:number}|null|undefined} q
 * @returns {Array<'blurry'|'dark'|'bright'>}
 */
export function assess(q, t = THRESHOLDS) {
  if (!q) return [];
  const out = [];
  if (q.sharpness < t.blurry) out.push('blurry');
  if (q.brightness < t.dark) out.push('dark');
  else if (q.brightness > t.bright || q.clipped > t.clipped) out.push('bright');
  return out;
}

const WORDS = { blurry: 'blurry', dark: 'too dark', bright: 'too bright' };
const shortName = (p) => String(p.fileName ?? p.dcfKey ?? '').replace(/\.[^.]+$/, '');

/**
 * What to tell the operator about one part's photos. The SKU label photo is
 * not judged (it is a close-up of a sticker) and does not count toward the
 * photo total.
 *
 * @param {Array<{fileName?:string, dcfKey?:string, quality?:object|null, isLabel?:boolean}>} photos
 * @returns {string[]} e.g. ["Only 5 photos — 8+ sell better", "Blurry: IMG_7372, IMG_7375"]
 */
export function partNotes(photos, t = THRESHOLDS) {
  const product = photos.filter((p) => !p.isLabel);
  const notes = [];
  if (product.length < t.minPhotos) {
    notes.push(`Only ${product.length} photo${product.length === 1 ? '' : 's'} of the part — ${t.minPhotos}+ sell better`);
  }
  for (const kind of ['blurry', 'dark', 'bright']) {
    const bad = product.filter((p) => assess(p.quality, t).includes(kind));
    if (!bad.length) continue;
    const names = bad.slice(0, 3).map(shortName).join(', ') + (bad.length > 3 ? ` +${bad.length - 3}` : '');
    notes.push(`${WORDS[kind][0].toUpperCase()}${WORDS[kind].slice(1)}: ${names}`);
  }
  return notes;
}
