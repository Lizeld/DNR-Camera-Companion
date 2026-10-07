/**
 * Watermark renderer — spec §2.1. This file is the parity contract.
 *
 * Any change here must be re-validated against the golden image
 * (tools/watermark_reference.py -> tests.html "golden parity" panel).
 */

export const DEFAULTS = Object.freeze({
  /** Bar colour, rgb(70, 90, 120). */
  barColor: Object.freeze({ r: 70, g: 90, b: 120 }),
  /** Bar thickness *and* the inset used to place the watermark. */
  padding: 125,
  /** Where each bar's gradient stops ramping. */
  alphaSplit: 0.8,
  /** Watermark is scaled down if wider than this fraction of the base. */
  maxWatermarkWidthRatio: 0.3,
  /** JPEG quality 92 -> canvas 0.92. */
  jpegQuality: 0.92,
});

/**
 * Alpha ramp for the left bar: 0 -> 255 over the top `alphaSplit` of the
 * height, then solid 255 for the remainder.
 *
 * Exported for unit tests — the endpoints and the split row are the parts most
 * likely to drift.
 *
 * @param {number} y      row index
 * @param {number} height full image height
 */
export function leftBarAlpha(y, height, alphaSplit = DEFAULTS.alphaSplit) {
  const split = Math.floor(height * alphaSplit);
  if (split <= 0) return 255;
  if (y >= split) return 255;
  return Math.round((255 * y) / split);
}

/**
 * Alpha ramp for the bottom bar: solid 255 for the left `alphaSplit` of the
 * width, then 255 -> 0 across the remainder.
 *
 * @param {number} x     column index
 * @param {number} width full image width
 */
export function bottomBarAlpha(x, width, alphaSplit = DEFAULTS.alphaSplit) {
  const split = Math.floor(width * alphaSplit);
  if (x < split) return 255;
  const span = width - split;
  if (span <= 0) return 255;
  return Math.round(255 * (1 - (x - split) / span));
}

/** Build the left bar as a `padding` x `height` RGBA strip. */
export function buildLeftBarImageData(padding, height, color, alphaSplit) {
  const data = new Uint8ClampedArray(padding * height * 4);
  for (let y = 0; y < height; y++) {
    const a = leftBarAlpha(y, height, alphaSplit);
    let i = y * padding * 4;
    for (let x = 0; x < padding; x++) {
      data[i++] = color.r;
      data[i++] = color.g;
      data[i++] = color.b;
      data[i++] = a;
    }
  }
  return new ImageData(data, padding, height);
}

/** Build the bottom bar as a `width` x `padding` RGBA strip. */
export function buildBottomBarImageData(width, padding, color, alphaSplit) {
  const row = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) {
    const a = bottomBarAlpha(x, width, alphaSplit);
    const i = x * 4;
    row[i] = color.r;
    row[i + 1] = color.g;
    row[i + 2] = color.b;
    row[i + 3] = a;
  }
  const data = new Uint8ClampedArray(width * padding * 4);
  for (let y = 0; y < padding; y++) data.set(row, y * width * 4);
  return new ImageData(data, width, padding);
}

/** Allocate an OffscreenCanvas, or a DOM canvas when running on the main thread. */
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function resizeCanvas(canvas, w, h) {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return canvas;
}

/**
 * Watermark placement + scale (§2.1).
 * @returns {{x:number, y:number, w:number, h:number, scaled:boolean}}
 */
export function watermarkPlacement(baseW, baseH, wmW, wmH, opts = {}) {
  const padding = opts.padding ?? DEFAULTS.padding;
  const maxRatio = opts.maxWatermarkWidthRatio ?? DEFAULTS.maxWatermarkWidthRatio;
  const maxW = Math.floor(baseW * maxRatio);

  let w = wmW;
  let h = wmH;
  let scaled = false;
  if (wmW > maxW) {
    // Scale down to exactly 30% of base width, preserving aspect ratio.
    scaled = true;
    w = maxW;
    h = Math.round((wmH * maxW) / wmW);
  }
  return { x: padding, y: baseH - padding - h, w, h, scaled };
}

/**
 * Render bars + watermark onto `target`.
 *
 * Compositing (§2.1, the critical detail): conceptually both bars go onto one
 * transparent overlay which is composited exactly once, so the bottom-left
 * corner — where both bars are fully opaque — equals the bar colour exactly
 * rather than a darker doubled value.
 *
 * We draw the equivalent decomposition instead of allocating a second
 * full-size canvas: the two bar regions are made disjoint by clipping the left
 * bar to the rows *above* the bottom bar, and the bottom bar (drawn second,
 * source-over, and opaque throughout the corner) supplies the corner pixels.
 * Every pixel is therefore composited exactly once, which is pixel-identical
 * to the single-overlay formulation and costs ~5 MB instead of ~96 MB on a
 * 24 MP frame (§5.4).
 *
 * @param {CanvasImageSource & {width:number,height:number}} baseBitmap
 * @param {CanvasImageSource & {width:number,height:number}|null} watermarkBitmap
 * @param {object} [options]
 * @param {OffscreenCanvas|HTMLCanvasElement} [target] canvas to reuse
 * @returns {OffscreenCanvas|HTMLCanvasElement}
 */
export function renderWatermark(baseBitmap, watermarkBitmap, options = {}, target = null) {
  const opts = { ...DEFAULTS, ...options };
  const w = baseBitmap.width;
  const h = baseBitmap.height;
  const padding = Math.max(0, Math.min(opts.padding, Math.min(w, h)));

  const canvas = resizeCanvas(target ?? makeCanvas(w, h), w, h);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(baseBitmap, 0, 0);

  if (padding > 0) {
    // Left bar — full-height gradient, drawn only down to the bottom bar.
    const leftH = Math.max(0, h - padding);
    if (leftH > 0) {
      const strip = makeCanvas(padding, h);
      strip.getContext('2d').putImageData(
        buildLeftBarImageData(padding, h, opts.barColor, opts.alphaSplit),
        0,
        0,
      );
      ctx.drawImage(strip, 0, 0, padding, leftH, 0, 0, padding, leftH);
    }

    // Bottom bar — full width, owns the bottom-left corner.
    const strip = makeCanvas(w, padding);
    strip.getContext('2d').putImageData(
      buildBottomBarImageData(w, padding, opts.barColor, opts.alphaSplit),
      0,
      0,
    );
    ctx.drawImage(strip, 0, h - padding);
  }

  if (watermarkBitmap) {
    const p = watermarkPlacement(w, h, watermarkBitmap.width, watermarkBitmap.height, opts);
    ctx.drawImage(watermarkBitmap, p.x, p.y, p.w, p.h);
  }

  return canvas;
}

/**
 * Encode a rendered canvas to JPEG.
 *
 * Known deviation (§2.1): the original Python used Pillow with `subsampling=0`
 * (4:4:4). Neither Android's encoder nor the canvas API exposes chroma
 * subsampling, so this is 4:2:0. Carried over from Android deliberately.
 *
 * @returns {Promise<Blob>}
 */
export function encodeJpeg(canvas, quality = DEFAULTS.jpegQuality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
      'image/jpeg',
      quality,
    );
  });
}
