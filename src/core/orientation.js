/**
 * Landscape normalisation — every uploaded photo is horizontal.
 *
 * A frame arrives portrait in one of two ways, and they are not the same
 * problem:
 *
 *  1. **The camera only tagged it.** The sensor frame is landscape and the body
 *     wrote an EXIF "Orientation" flag saying to display it rotated, because it
 *     was tilted when the shot was taken. This is the common case on a bench
 *     shoot. Undoing the flag gets a landscape frame with the subject still
 *     upright, which is what we want.
 *  2. **The pixels really are taller than they are wide.** Then no choice keeps
 *     the subject upright, and we rotate 90° clockwise — the original top edge
 *     ends up on the right.
 *
 * Why the flag is undone here rather than at decode time: **there is no decode
 * option that suppresses it.** `createImageBitmap`'s `imageOrientation` used to
 * accept `'none'` for exactly this, but Chromium now applies EXIF regardless —
 * measured on the target browser, a landscape 80x40 JPEG tagged Orientation=6
 * decodes to 40x80 under `'none'`, `'from-image'`, `'flipY'` and with the
 * option omitted. So the frame is decoded however the browser likes and then
 * rotated back.
 *
 * That makes this browser-independent, which matters because the tablet is not
 * necessarily running the same engine:
 *
 *   - a decoder that applies the flag hands us a portrait frame, and we rotate
 *     it back by the inverse of what the flag asked for;
 *   - a decoder that ignores the flag hands us the landscape sensor frame
 *     already, `isPortrait` is false, and nothing happens.
 *
 * Both roads end at the sensor frame.
 *
 * Rotation happens *before* barcode scanning and watermarking so both see the
 * final geometry; otherwise the bars land on what are now the wrong edges.
 */

/** EXIF lives near the start of the file; no need to read a 25 MB frame. */
const EXIF_SCAN_BYTES = 65536;

/** @param {{width:number, height:number}} source */
export function isPortrait(source) {
  return source.height > source.width;
}

/**
 * Which way to turn a portrait frame, given the EXIF flag the camera wrote.
 *
 * 6 and 8 are the quarter turns; the decoder has already applied one, so the
 * inverse is what recovers the sensor frame. 5 and 7 are the mirrored
 * diagonals — vanishingly rare off a Canon body, but they carry the same
 * quarter turn, so the direction follows. Anything else (1, or no tag at all)
 * means the pixels are genuinely portrait and there is nothing to undo.
 *
 * @param {number|null} exifOrientation
 * @returns {'cw'|'ccw'}
 */
export function rotationForLandscape(exifOrientation) {
  if (exifOrientation === 6 || exifOrientation === 5) return 'ccw';
  if (exifOrientation === 8 || exifOrientation === 7) return 'cw';
  return 'cw';
}

/** Allocate an OffscreenCanvas, or a DOM canvas on the main thread. */
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Turn a portrait frame landscape.
 *
 * Square frames are left alone: already as landscape as they can be, and
 * rotating them would move pixels for no gain.
 *
 * @param {CanvasImageSource & {width:number, height:number}} source
 * @param {object} [opts]
 * @param {OffscreenCanvas|HTMLCanvasElement} [opts.target] canvas to reuse (§5.4)
 * @param {number|null} [opts.exifOrientation] tag from `readExifOrientation`
 * @returns {{source:CanvasImageSource & {width:number,height:number}, rotated:boolean, direction:'cw'|'ccw'|null}}
 */
export function toLandscape(source, opts = {}) {
  const { target = null, exifOrientation = null } = opts;
  if (!isPortrait(source)) return { source, rotated: false, direction: null };

  const direction = rotationForLandscape(exifOrientation);

  // Dimensions swap.
  const width = source.height;
  const height = source.width;
  const canvas = target ?? makeCanvas(width, height);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (direction === 'cw') {
    // Canvas angles run clockwise because y grows downward. Source (x, y)
    // lands at (width - y, x): the top row becomes the right column.
    ctx.translate(width, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    // Source (x, y) lands at (y, height - x): the top row becomes the left column.
    ctx.translate(0, height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  return { source: canvas, rotated: true, direction };
}

/**
 * Read the EXIF Orientation tag (0x0112) out of a JPEG.
 *
 * @param {Blob} blob
 * @returns {Promise<number|null>} 1–8, or null when absent or unreadable
 */
export async function readExifOrientation(blob) {
  try {
    const head = await blob.slice(0, EXIF_SCAN_BYTES).arrayBuffer();
    return parseExifOrientation(new DataView(head));
  } catch {
    return null; // an unreadable header is not worth failing a photo over
  }
}

/**
 * Walk JPEG segment markers to the APP1/Exif block. Exported for tests.
 * @param {DataView} view start of the file
 * @returns {number|null}
 */
export function parseExifOrientation(view) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null; // desynchronised; give up
    const marker = view.getUint8(offset + 1);
    // Start of scan: image data follows, so any EXIF would have appeared already.
    if (marker === 0xda || marker === 0xd9) return null;
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const size = view.getUint16(offset + 2);
    if (size < 2) return null;
    if (marker === 0xe1 && offset + 10 <= view.byteLength
        && view.getUint32(offset + 4) === 0x45786966      // "Exif"
        && view.getUint16(offset + 8) === 0x0000) {
      return orientationFromTiff(view, offset + 10);
    }
    offset += 2 + size;
  }
  return null;
}

/** Read tag 0x0112 out of IFD0 of the TIFF block starting at `start`. */
function orientationFromTiff(view, start) {
  if (start + 8 > view.byteLength) return null;

  const endian = view.getUint16(start);
  if (endian !== 0x4949 && endian !== 0x4d4d) return null;
  const little = endian === 0x4949; // "II" little-endian, "MM" big-endian
  if (view.getUint16(start + 2, little) !== 0x002a) return null;

  const ifd = start + view.getUint32(start + 4, little);
  if (ifd + 2 > view.byteLength || ifd < start) return null;

  const entries = view.getUint16(ifd, little);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) return null;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}
