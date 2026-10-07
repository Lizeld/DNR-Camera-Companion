/**
 * Imaging worker — decode, watermark, barcode, encode.
 *
 * Memory discipline (§5.4). A 24MP frame decodes to ~96 MB of RGBA, and tablet
 * browsers kill the tab under sustained pressure:
 *   - one photo at a time, never a queue of decoded frames
 *   - `createImageBitmap` -> draw -> `bitmap.close()` explicitly, in a finally
 *   - reuse a single full-size OffscreenCanvas across photos instead of
 *     allocating per image
 *   - the barcode scan works off a separate small canvas, also reused
 *   - nothing decoded is ever retained between messages
 */

import { renderWatermark, encodeJpeg, DEFAULTS as WM_DEFAULTS } from '../core/watermark.js';
import { detectSku, cropForOcr } from '../core/barcode.js';
import { readExifOrientation, toLandscape } from '../core/orientation.js';

/** Reused across every photo. Resized in place by renderWatermark. */
let frameCanvas = null;
/** Reused downscaled canvas for barcode scanning. */
let scanCanvas = null;
/** Reused canvas for turning a portrait frame landscape. Full size, so it is
 * released alongside frameCanvas after every run. */
let rotateCanvas = null;
/** The watermark, decoded once at init and kept — it is small (796x854). */
let watermarkBitmap = null;

function ensureCanvases() {
  if (!frameCanvas) frameCanvas = new OffscreenCanvas(1, 1);
  if (!scanCanvas) scanCanvas = new OffscreenCanvas(1, 1);
  if (!rotateCanvas) rotateCanvas = new OffscreenCanvas(1, 1);
}

/** Drop the big canvas backing stores after a run so they are not held idle. */
function releaseFrameCanvas() {
  for (const canvas of [frameCanvas, rotateCanvas]) {
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

async function setWatermark(source) {
  if (watermarkBitmap) {
    watermarkBitmap.close();
    watermarkBitmap = null;
  }
  if (!source) return null;
  watermarkBitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  return { width: watermarkBitmap.width, height: watermarkBitmap.height };
}

/**
 * Process one photo end to end.
 *
 * @param {{blob:Blob, dcfKey:string, options:object, scanForSku:boolean}} job
 * @returns {Promise<{jpeg:Blob, sku:string|null, width:number, height:number, timings:object}>}
 */
async function processPhoto(job) {
  ensureCanvases();
  const { blob, options = {}, scanForSku = true } = job;
  const t0 = performance.now();

  let bitmap = null;
  try {
    // Read the camera's rotate flag before decoding: no decode option
    // suppresses it, so undoing it afterwards is the only way to get the
    // sensor frame back. See src/core/orientation.js.
    const exifOrientation = await readExifOrientation(blob);
    bitmap = await createImageBitmap(blob);
    const decodedAt = performance.now();

    // Landscape before anything else touches the frame: the barcode scan and
    // the watermark must both see the final geometry, or the bars end up on
    // what are now the wrong edges.
    const oriented = toLandscape(bitmap, { target: rotateCanvas, exifOrientation });
    if (oriented.rotated) {
      // The rotated copy is the working frame now. Free the ~96 MB original
      // immediately rather than holding both until the finally block (§5.4).
      bitmap.close();
      bitmap = null;
    }
    const frame = oriented.source;
    const orientedAt = performance.now();

    // Barcode first, off a downscaled copy of the *original* frame: the bars
    // cover the left and bottom edges, and reading before compositing keeps
    // the scan independent of watermark settings.
    let detection = { sku: null, method: null, boosted: false, ms: 0 };
    if (scanForSku) {
      detection = await detectSku(frame, { scanCanvas, ...options });
    }
    // No barcode, but something that started to read as one: cut out the
    // label for the OCR fallback. Both ways up — the read direction of a
    // damaged barcode is only a guess, and upside-down digits OCR as other,
    // plausible digits (0000706 -> 9020000); Inventory picks the real one.
    const ocrCrops = [];
    if (!detection.sku && detection.ocrRegion && options.ocr) {
      for (const turn of [0, 180]) {
        const region = { ...detection.ocrRegion, rotate: (detection.ocrRegion.rotate + turn) % 360 };
        const crop = cropForOcr(frame, region, detection.scanScale);
        ocrCrops.push(await crop.convertToBlob({ type: 'image/jpeg', quality: 0.92 }));
      }
    }
    const scannedAt = performance.now();

    renderWatermark(
      frame,
      watermarkBitmap,
      {
        padding: options.padding ?? WM_DEFAULTS.padding,
        barColor: options.barColor ?? WM_DEFAULTS.barColor,
        alphaSplit: options.alphaSplit ?? WM_DEFAULTS.alphaSplit,
        maxWatermarkWidthRatio: options.maxWatermarkWidthRatio ?? WM_DEFAULTS.maxWatermarkWidthRatio,
      },
      frameCanvas,
    );
    const renderedAt = performance.now();

    const width = frameCanvas.width;
    const height = frameCanvas.height;
    const jpeg = await encodeJpeg(frameCanvas, options.jpegQuality ?? WM_DEFAULTS.jpegQuality);
    const encodedAt = performance.now();

    return {
      jpeg,
      sku: detection.sku,
      skuMethod: detection.method,
      skuBoosted: detection.boosted,
      ocrCrops,
      ocrSymbols: detection.ocrRegion?.symbols ?? 0,
      rotated: oriented.rotated,
      width,
      height,
      timings: {
        decodeMs: Math.round(decodedAt - t0),
        rotateMs: Math.round(orientedAt - decodedAt),
        barcodeMs: Math.round(scannedAt - orientedAt),
        renderMs: Math.round(renderedAt - scannedAt),
        encodeMs: Math.round(encodedAt - renderedAt),
        totalMs: Math.round(encodedAt - t0),
      },
    };
  } finally {
    // Explicit close, always — this is the single most important line in the
    // file for tab survival.
    if (bitmap) bitmap.close();
    releaseFrameCanvas();
  }
}

/** Scan an already-decoded image for a SKU without watermarking it. */
async function scanOnly(job) {
  ensureCanvases();
  let bitmap = null;
  try {
    // No landscape pass here: it costs a full-size canvas and cannot change
    // which barcode is in the frame — detectSku already retries rotated labels.
    bitmap = await createImageBitmap(job.blob);
    return await detectSku(bitmap, { scanCanvas, ...(job.options ?? {}) });
  } finally {
    if (bitmap) bitmap.close();
  }
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data ?? {};
  try {
    let result;
    switch (type) {
      case 'setWatermark':
        result = await setWatermark(payload?.source ?? null);
        break;
      case 'process':
        result = await processPhoto(payload);
        break;
      case 'scan':
        result = await scanOnly(payload);
        break;
      case 'ping':
        result = { ok: true, hasWatermark: Boolean(watermarkBitmap) };
        break;
      default:
        throw new Error(`imaging worker: unknown message ${type}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: { name: err?.name ?? 'Error', message: err?.message ?? String(err), stack: err?.stack ?? '' },
    });
  }
};
