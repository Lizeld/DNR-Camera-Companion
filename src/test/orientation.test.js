/**
 * Landscape normalisation — every uploaded photo is horizontal.
 *
 * The dimension swap is the easy half; the half worth pinning is *which way*
 * the pixels go. These build a frame with a differently-coloured pixel in each
 * corner and assert where each one lands, so a sign flip in the transform
 * cannot pass.
 */

import { describe, it, expect } from './runner.js';
import {
  isPortrait,
  parseExifOrientation,
  readExifOrientation,
  rotationForLandscape,
  toLandscape,
} from '../core/orientation.js';

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

/** A `w`x`h` canvas with a distinct colour in each corner. */
function cornerCanvas(w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, w, h);
  const put = ([r, g, b], x, y) => {
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, y, 1, 1);
  };
  put(RED, 0, 0);            // top-left
  put(GREEN, w - 1, 0);      // top-right
  put(BLUE, 0, h - 1);       // bottom-left
  put(WHITE, w - 1, h - 1);  // bottom-right
  return canvas;
}

function pixelAt(canvas, x, y) {
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1);
  return [data[0], data[1], data[2]];
}

/**
 * A `w`x`h` JPEG carrying an EXIF Orientation tag — the "display me rotated"
 * flag a camera writes when it was tilted, with the pixels left landscape.
 *
 * Hand-built because there is no encoder here that writes EXIF: a minimal APP1
 * segment (big-endian TIFF header, one IFD entry, tag 0x0112) spliced in
 * directly after SOI, which is where the EXIF spec puts it.
 */
async function jpegWithOrientation(w, h, orientation) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#777';
  ctx.fillRect(0, 0, w, h);
  const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());

  const app1 = new Uint8Array([
    0xff, 0xe1, 0x00, 0x22,                            // APP1, length 34
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,                // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,    // TIFF header, IFD0 at 8
    0x00, 0x01,                                        // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,    // Orientation, SHORT, count 1
    (orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,                            // no next IFD
  ]);

  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2), 0);                     // SOI
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return new Blob([out], { type: 'image/jpeg' });
}

describe('Landscape normalisation', () => {
  it('recovers the sensor frame from a tagged photo, whatever the decoder does', async () => {
    // The contract, end to end and browser-independent. A decoder that applies
    // the flag hands back 40x80 and we rotate it back; one that ignores the
    // flag hands back 80x40 and nothing happens. Both must end at 80x40.
    const blob = await jpegWithOrientation(80, 40, 6);
    const exifOrientation = await readExifOrientation(blob);
    expect(exifOrientation).toBe(6, 'the tag should be readable');

    const bitmap = await createImageBitmap(blob);
    try {
      const out = toLandscape(bitmap, { exifOrientation });
      expect([out.source.width, out.source.height]).toEqual([80, 40], 'not back to the sensor frame');
      expect(isPortrait(out.source)).toBe(false);
    } finally {
      bitmap.close();
    }
  });

  it('undoes the flag rather than guessing: 6 turns back one way, 8 the other', () => {
    expect(rotationForLandscape(6)).toBe('ccw', 'the decoder turned it clockwise; undo it');
    expect(rotationForLandscape(8)).toBe('cw');
    expect(rotationForLandscape(5)).toBe('ccw', 'mirrored diagonal, same quarter turn');
    expect(rotationForLandscape(7)).toBe('cw');
  });

  it('falls back to clockwise when there is no flag to undo', () => {
    expect(rotationForLandscape(1)).toBe('cw', 'genuinely portrait pixels');
    expect(rotationForLandscape(null)).toBe('cw');
    expect(rotationForLandscape(undefined)).toBe('cw');
  });

  it('recognises portrait only when taller than wide', () => {
    expect(isPortrait({ width: 4000, height: 6000 })).toBe(true);
    expect(isPortrait({ width: 6000, height: 4000 })).toBe(false);
    expect(isPortrait({ width: 4000, height: 4000 })).toBe(false, 'square is not portrait');
  });

  it('leaves a landscape frame untouched — no pixels moved', () => {
    const canvas = cornerCanvas(8, 4);
    const out = toLandscape(canvas);
    expect(out.rotated).toBe(false);
    expect(out.source).toBe(canvas, 'the original should pass straight through');
  });

  it('leaves a square frame untouched', () => {
    const canvas = cornerCanvas(4, 4);
    expect(toLandscape(canvas).rotated).toBe(false);
  });

  it('swaps the dimensions of a portrait frame', () => {
    const out = toLandscape(cornerCanvas(4, 8));
    expect(out.rotated).toBe(true);
    expect([out.source.width, out.source.height]).toEqual([8, 4]);
  });

  it('rotates clockwise by default: the top edge ends up on the right', () => {
    const out = toLandscape(cornerCanvas(4, 8));
    const c = out.source;
    expect(out.direction).toBe('cw');
    // (x, y) -> (width - 1 - y, x) for a clockwise quarter turn.
    expect(pixelAt(c, c.width - 1, 0)).toEqual(RED, 'top-left should land top-right');
    expect(pixelAt(c, c.width - 1, c.height - 1)).toEqual(GREEN, 'top-right should land bottom-right');
    expect(pixelAt(c, 0, 0)).toEqual(BLUE, 'bottom-left should land top-left');
    expect(pixelAt(c, 0, c.height - 1)).toEqual(WHITE, 'bottom-right should land bottom-left');
  });

  it('rotates counter-clockwise to undo a flag of 6: the top edge goes left', () => {
    const out = toLandscape(cornerCanvas(4, 8), { exifOrientation: 6 });
    const c = out.source;
    expect(out.direction).toBe('ccw');
    // (x, y) -> (y, height - 1 - x) for a counter-clockwise quarter turn.
    expect(pixelAt(c, 0, c.height - 1)).toEqual(RED, 'top-left should land bottom-left');
    expect(pixelAt(c, 0, 0)).toEqual(GREEN, 'top-right should land top-left');
    expect(pixelAt(c, c.width - 1, c.height - 1)).toEqual(BLUE, 'bottom-left should land bottom-right');
    expect(pixelAt(c, c.width - 1, 0)).toEqual(WHITE, 'bottom-right should land top-right');
  });

  it('reuses the target canvas instead of allocating per photo (§5.4)', () => {
    const target = new OffscreenCanvas(1, 1);
    const out = toLandscape(cornerCanvas(4, 8), { target });
    expect(out.source).toBe(target);
    expect([target.width, target.height]).toEqual([8, 4]);

    // A second, differently-shaped frame must resize it rather than smear the
    // previous contents through — the worker reuses one canvas for every photo.
    const again = toLandscape(cornerCanvas(2, 10), { target });
    expect([again.source.width, again.source.height]).toEqual([10, 2]);
    expect(pixelAt(target, target.width - 1, 0)).toEqual(RED);
  });
});

describe('EXIF orientation parsing', () => {
  const bytes = (...values) => new DataView(new Uint8Array(values).buffer);

  it('reads the tag a Canon writes, big-endian', async () => {
    expect(await readExifOrientation(await jpegWithOrientation(8, 4, 6))).toBe(6);
    expect(await readExifOrientation(await jpegWithOrientation(8, 4, 8))).toBe(8);
    expect(await readExifOrientation(await jpegWithOrientation(8, 4, 1))).toBe(1);
  });

  it('reads a little-endian ("II") header too', () => {
    const view = bytes(
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x22,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,   // "II", 42, IFD at 8
      0x01, 0x00,                                        // one entry
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x08, 0x00, 0x00, 0x00,                            // value 8
      0x00, 0x00, 0x00, 0x00,
    );
    expect(parseExifOrientation(view)).toBe(8);
  });

  it('returns null when there is nothing to read', async () => {
    const plain = new OffscreenCanvas(4, 4);
    plain.getContext('2d').fillRect(0, 0, 4, 4);
    expect(await readExifOrientation(await plain.convertToBlob({ type: 'image/jpeg' })))
      .toBe(null, 'a JPEG with no EXIF');
    expect(await readExifOrientation(new Blob(['not an image'])))
      .toBe(null, 'not a JPEG at all');
    expect(parseExifOrientation(bytes(0xff, 0xd8))).toBe(null, 'truncated');
    expect(parseExifOrientation(bytes(0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02))).toBe(null, 'empty APP1');
  });

  it('rejects an out-of-range value rather than rotating on garbage', () => {
    const view = bytes(
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x22,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x01,
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x63, 0x00, 0x00, // 99
      0x00, 0x00, 0x00, 0x00,
    );
    expect(parseExifOrientation(view)).toBe(null);
  });
});
