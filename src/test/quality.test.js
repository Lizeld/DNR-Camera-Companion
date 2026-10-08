/**
 * Photo checks (src/core/quality.js) on synthetic frames, and what the Shoot
 * tab says about a part's photos. Thresholds were calibrated on real R50
 * frames; these only pin the behaviour around them.
 */

import { describe, it, expect } from './runner.js';
import { measure, assess, partNotes, THRESHOLDS } from '../core/quality.js';
import { createDraft } from '../app/uploader.js';

const W = 240;
const H = 160;

/** RGBA frame: plain grey backdrop with a black/white checker "part" in the middle. */
function frame({ backdrop = 200, part = true, blur = 0, scale = 1 } = {}) {
  let lum = new Float32Array(W * H).fill(backdrop);
  if (part) {
    for (let y = 50; y < 110; y++) for (let x = 80; x < 160; x++) lum[y * W + x] = ((x >> 3) + (y >> 3)) % 2 ? 20 : 235;
  }
  for (let pass = 0; pass < blur; pass++) {
    const next = new Float32Array(lum.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < H && xx >= 0 && xx < W) { sum += lum[yy * W + xx]; n++; }
        }
        next[y * W + x] = sum / n;
      }
    }
    lum = next;
  }
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < lum.length; i++) {
    const v = Math.min(255, lum[i] * scale);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { data, width: W, height: H };
}

describe('Photo checks: sharpness and exposure', () => {
  it('scores a sharp part on a plain backdrop well above the blur threshold', () => {
    const q = measure(frame());
    expect(q.sharpness > THRESHOLDS.blurry * 10).toBeTruthy(`sharpness ${q.sharpness}`);
    expect(assess(q)).toEqual([]);
  });

  it('flags the same part when it is out of focus', () => {
    const q = measure(frame({ blur: 4 }));
    expect(assess(q)).toContain('blurry');
  });

  it('judges the sharpest tiles, not the backdrop that fills most of the frame', () => {
    // A plain backdrop alone has no detail at all; the part is ~12% of the frame.
    expect(measure(frame({ part: false })).sharpness).toBe(0);
    expect(measure(frame()).sharpness > 100).toBeTruthy();
  });

  it('flags dark and overexposed frames', () => {
    expect(assess(measure(frame({ scale: 0.25 })))).toContain('dark');
    expect(assess(measure(frame({ backdrop: 255 })))).toContain('bright');
  });

  it('says nothing about a photo that was never measured', () => {
    expect(assess(null)).toEqual([]);
  });
});

describe('Photo checks: notes per part', () => {
  const sharp = { sharpness: 500, brightness: 150, clipped: 0 };
  const photo = (n, quality = sharp, isLabel = false) => ({ fileName: `IMG_${n}.JPG`, quality, isLabel });
  const eight = Array.from({ length: 8 }, (_, i) => photo(7000 + i));

  it('is quiet for 8 good photos plus the label', () => {
    expect(partNotes([...eight, photo(7008, { sharpness: 1, brightness: 20, clipped: 0 }, true)])).toEqual([]);
  });

  it('asks for more photos, not counting the label shot', () => {
    expect(partNotes([photo(1), photo(2), photo(3, sharp, true)])).toEqual(['Only 2 photos of the part — 8+ sell better']);
  });

  it('names the blurry and badly exposed photos', () => {
    const notes = partNotes([
      ...eight.slice(2),
      photo(7372, { sharpness: 4, brightness: 150, clipped: 0 }),
      photo(7375, { sharpness: 300, brightness: 40, clipped: 0 }),
    ]);
    expect(notes).toEqual(['Blurry: IMG_7372', 'Too dark: IMG_7375']);
  });

  it('shortens a long list of names', () => {
    const blurry = Array.from({ length: 9 }, (_, i) => photo(100 + i, { sharpness: 1, brightness: 150, clipped: 0 }));
    expect(partNotes(blurry)).toEqual(['Blurry: IMG_100, IMG_101, IMG_102 +6']);
  });
});

describe('Donor car on the draft request', () => {
  const s = { backendUrl: 'https://inventory.example.com', backendToken: 'token' };
  async function bodyOf(...args) {
    const real = globalThis.fetch;
    let sent = null;
    globalThis.fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ draftId: '900' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      await createDraft('0000705', ['https://b/x.jpg'], s, undefined, ...args);
    } finally {
      globalThis.fetch = real;
    }
    return sent;
  }

  it('sends carId when a car was picked', async () => {
    expect(await bodyOf(null, '42')).toEqual({ sku: '0000705', images: ['https://b/x.jpg'], carId: '42' });
  });

  it('sends it on an append too', async () => {
    expect(await bodyOf('812', '42')).toEqual({ sku: '0000705', images: ['https://b/x.jpg'], draftId: '812', carId: '42' });
  });

  it('leaves it out when no car was picked', async () => {
    expect(await bodyOf()).toEqual({ sku: '0000705', images: ['https://b/x.jpg'] });
  });
});
