/**
 * Watermark parity — spec §2.1 and §8 "Golden-image parity (essential)".
 *
 * The golden image is produced by tools/watermark_reference.py, the Pillow
 * implementation of the contract, and saved as a lossless PNG. We compare the
 * *rendered bitmap*, before JPEG encoding, so the known 4:2:0 chroma deviation
 * does not confound the comparison. Android held max channel diff 2/255; the
 * web port is held to the same bar.
 */

import { describe, it, expect, loadFixture, imageDataOf } from './runner.js';
import {
  DEFAULTS,
  leftBarAlpha,
  bottomBarAlpha,
  watermarkPlacement,
  renderWatermark,
  encodeJpeg,
} from '../core/watermark.js';

const MAX_CHANNEL_DIFF = 2; // the bar Android achieved

describe('Watermark parameters (§2.1)', () => {
  it('matches the contract', () => {
    expect(DEFAULTS.barColor).toEqual({ r: 70, g: 90, b: 120 });
    expect(DEFAULTS.padding).toBe(125);
    expect(DEFAULTS.alphaSplit).toBe(0.8);
    expect(DEFAULTS.maxWatermarkWidthRatio).toBe(0.3);
    expect(DEFAULTS.jpegQuality).toBe(0.92);
  });
});

describe('Watermark alpha ramps (§2.1)', () => {
  it('left bar ramps 0 -> 255 over the top 80% of the height', () => {
    const h = 1000; // split at 800
    expect(leftBarAlpha(0, h)).toBe(0, 'fully transparent at the top');
    expect(leftBarAlpha(200, h)).toBe(64);
    expect(leftBarAlpha(400, h)).toBe(128);
    expect(leftBarAlpha(600, h)).toBe(191);
    expect(leftBarAlpha(799, h)).toBe(255, 'saturated by the last row of the ramp');
  });

  it('left bar alpha increases monotonically', () => {
    const h = 4000; // a real 24MP frame
    let previous = -1;
    for (let y = 0; y < h; y++) {
      const a = leftBarAlpha(y, h);
      expect(a >= previous).toBeTruthy(`alpha dropped at row ${y}`);
      previous = a;
    }
    expect(previous).toBe(255);
  });

  it('left bar is solid for the bottom 20%', () => {
    const h = 1000;
    for (const y of [800, 801, 900, 999]) expect(leftBarAlpha(y, h)).toBe(255, `row ${y}`);
  });

  it('bottom bar is solid for the left 80%', () => {
    const w = 1000; // split at 800
    for (const x of [0, 1, 400, 799]) expect(bottomBarAlpha(x, w)).toBe(255, `column ${x}`);
  });

  it('bottom bar falls 255 -> 0 across the right 20%', () => {
    const w = 1000;
    expect(bottomBarAlpha(800, w)).toBe(255);
    expect(bottomBarAlpha(900, w)).toBe(128);
    expect(bottomBarAlpha(999, w)).toBe(1);
  });

  it('degrades safely on tiny images', () => {
    expect(leftBarAlpha(0, 1)).toBe(255);
    expect(bottomBarAlpha(0, 1)).toBe(255);
  });
});

describe('Watermark placement (§2.1)', () => {
  it('pastes bottom-left at the padding inset, 1:1 when it fits', () => {
    // Production case: 796x854 watermark on a 6000x4000 photo. 30% is 1800px,
    // so the paste is 1:1.
    const p = watermarkPlacement(6000, 4000, 796, 854);
    expect(p.scaled).toBeFalsy();
    expect(p.w).toBe(796);
    expect(p.h).toBe(854);
    expect(p.x).toBe(125);
    expect(p.y).toBe(4000 - 125 - 854);
  });

  it('scales down to exactly 30% of base width, preserving aspect', () => {
    const p = watermarkPlacement(1000, 800, 600, 300);
    expect(p.scaled).toBeTruthy();
    expect(p.w).toBe(300, '30% of 1000');
    expect(p.h).toBe(150, 'aspect preserved');
  });

  it('leaves a watermark at exactly 30% alone', () => {
    expect(watermarkPlacement(1000, 800, 300, 200).scaled).toBeFalsy();
  });
});

describe('Watermark compositing (§2.1 critical detail)', () => {
  /** A flat base makes the compositing arithmetic checkable by hand. */
  function flatBase(w, h, rgb = [200, 200, 200]) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `rgb(${rgb.join(',')})`;
    ctx.fillRect(0, 0, w, h);
    return canvas;
  }

  const at = (data, w, x, y) => {
    const i = (y * w + x) * 4;
    return [data.data[i], data.data[i + 1], data.data[i + 2]];
  };

  it('the bottom-left corner equals the bar colour EXACTLY, not a doubled value', () => {
    // Both bars are fully opaque in the corner. Compositing them separately
    // onto the base would darken it; the single-overlay rule prevents that.
    const w = 600;
    const h = 400;
    const out = renderWatermark(flatBase(w, h), null, { padding: 50 });
    const data = imageDataOf(out);
    for (const [x, y] of [[0, h - 1], [49, h - 50], [25, h - 25], [0, h - 50], [49, h - 1]]) {
      expect(at(data, w, x, y)).toEqual([70, 90, 120], `corner pixel (${x},${y}) is doubled`);
    }
  });

  it('leaves the interior untouched', () => {
    const w = 600;
    const h = 400;
    const out = renderWatermark(flatBase(w, h), null, { padding: 50 });
    const data = imageDataOf(out);
    expect(at(data, w, 300, 100)).toEqual([200, 200, 200]);
    expect(at(data, w, 599, 0)).toEqual([200, 200, 200]);
  });

  it('the left bar is transparent at the top and opaque at the bottom', () => {
    const w = 600;
    const h = 400;
    const out = renderWatermark(flatBase(w, h), null, { padding: 50 });
    const data = imageDataOf(out);
    expect(at(data, w, 10, 0)).toEqual([200, 200, 200], 'alpha 0 at the top row');
    // Just above the bottom bar, the left bar is solid (h*0.8 = 320 < 350).
    expect(at(data, w, 10, h - 51)).toEqual([70, 90, 120]);
  });

  it('the bottom bar fades out to the right', () => {
    const w = 600;
    const h = 400;
    const out = renderWatermark(flatBase(w, h), null, { padding: 50 });
    const data = imageDataOf(out);
    expect(at(data, w, 400, h - 10)).toEqual([70, 90, 120], 'solid within the left 80%');
    const rightmost = at(data, w, w - 1, h - 10);
    expect(rightmost[0]).toBeCloseTo(200, 2, 'nearly transparent at the right edge');
  });

  it('a padding of 0 is a no-op', () => {
    const out = renderWatermark(flatBase(200, 200), null, { padding: 0 });
    const data = imageDataOf(out);
    expect(at(data, 200, 0, 199)).toEqual([200, 200, 200]);
  });
});

describe('Golden-image parity (§8, essential)', () => {
  it('matches the Pillow reference within 2/255 per channel', async () => {
    const [base, watermark, expected] = await Promise.all([
      loadFixture('base.png'),
      loadFixture('watermark-small.png'),
      loadFixture('expected.png'),
    ]);

    expect(base.width).toBe(expected.width);
    expect(base.height).toBe(expected.height);

    const rendered = renderWatermark(base, watermark, { padding: 125 });
    const got = imageDataOf(rendered);
    const want = imageDataOf(expected);

    let maxDiff = 0;
    let differing = 0;
    let worst = null;
    for (let i = 0; i < want.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(got.data[i + c] - want.data[i + c]);
        if (d > 0) {
          if (c === 0) differing++;
          if (d > maxDiff) {
            maxDiff = d;
            const px = i / 4;
            worst = { x: px % want.width, y: Math.floor(px / want.width), channel: c, d };
          }
        }
      }
    }

    base.close();
    watermark.close();
    expected.close();

    expect(maxDiff).toBeCloseTo(
      0,
      MAX_CHANNEL_DIFF,
      `max channel diff ${maxDiff} (${differing} px differ); worst at ${JSON.stringify(worst)}`,
    );
  });

  it('encodes JPEG at quality 92', async () => {
    const base = await loadFixture('base.png');
    const rendered = renderWatermark(base, null, { padding: 125 });
    const blob = await encodeJpeg(rendered, 0.92);
    base.close();
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size > 1000).toBeTruthy(`suspiciously small: ${blob.size} bytes`);
  });
});
