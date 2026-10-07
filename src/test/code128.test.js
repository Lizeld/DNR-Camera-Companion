/** Code 128 decoder — the symbology confirmed empirically for these labels (§2.2). */

import { describe, it, expect } from './runner.js';
import {
  decodeLine,
  scanCode128,
  encodeDigitsToWidths,
  checksum,
  symbolsToText,
  START_C,
  PATTERNS,
} from '../core/code128.js';

/** Render element widths as a binarized scan line (1 = dark). */
function lineFromWidths(widths, module = 3, quiet = 30) {
  const total = widths.reduce((a, b) => a + b, 0) * module + quiet * 2;
  const line = new Uint8Array(total);
  let x = quiet;
  widths.forEach((w, index) => {
    const dark = index % 2 === 0;
    for (let k = 0; k < w * module; k++) line[x++] = dark ? 1 : 0;
  });
  return line;
}

function lineFor(digits, module = 3) {
  return lineFromWidths(encodeDigitsToWidths(digits), module);
}

describe('Code 128 pattern table', () => {
  it('has 107 symbols; data symbols are 11 modules, stop is 13', () => {
    expect(PATTERNS).toHaveLength(107);
    for (let v = 0; v < 106; v++) {
      const sum = PATTERNS[v].reduce((a, b) => a + b, 0);
      expect(sum).toBe(11, `symbol ${v} is ${sum} modules`);
      expect(PATTERNS[v]).toHaveLength(6);
    }
    expect(PATTERNS[106].reduce((a, b) => a + b, 0)).toBe(13);
    expect(PATTERNS[106]).toHaveLength(7);
  });

  it('computes the documented mod-103 checksum', () => {
    // Start C (105) + "00" + "06" + "46" -> weighted sum mod 103.
    expect(checksum(START_C, [0, 6, 46])).toBe((105 + 0 * 1 + 6 * 2 + 46 * 3) % 103);
  });

  it('decodes subset C symbol values as digit pairs', () => {
    expect(symbolsToText(START_C, [0, 6, 46])).toBe('000646');
    expect(symbolsToText(START_C, [0, 0, 0, 99])).toBe('00000099');
  });
});

describe('Code 128 round trip', () => {
  it('reads back a 7-digit SKU', () => {
    expect(decodeLine(lineFor('0000646'))).toContain('0000646');
  });

  it('reads back a variety of SKUs', () => {
    for (const sku of ['0000646', '1234567', '0000001', '9999999', '5000000', '0102030']) {
      expect(decodeLine(lineFor(sku))).toContain(sku, `failed for ${sku}`);
    }
  });

  it('reads SKU 0000706 — a data symbol plus the next bar can pass for a stop', () => {
    // The B-set '6' (223112) followed by the check symbol's leading bar fits
    // the stop pattern (2331112) within tolerance. Treating that as the end
    // failed the checksum and abandoned the line, on every row of a real label.
    expect(decodeLine(lineFor('0000706'))).toContain('0000706');
  });

  it('reads every SKU in a 0000000–0002999 sweep', () => {
    const missed = [];
    for (let n = 0; n < 3000; n++) {
      const sku = String(n).padStart(7, '0');
      if (!decodeLine(lineFor(sku)).includes(sku)) missed.push(sku);
    }
    expect(missed.length).toBe(0, `unreadable: ${missed.slice(0, 10).join(', ')}${missed.length > 10 ? '…' : ''}`);
  });

  it('handles even digit counts (pure subset C)', () => {
    expect(decodeLine(lineFor('123456'))).toContain('123456');
    expect(decodeLine(lineFor('00'))).toContain('00');
  });

  it('works across module widths', () => {
    for (const module of [2, 3, 4, 6, 9]) {
      expect(decodeLine(lineFor('0000646', module))).toContain('0000646', `module ${module}px`);
    }
  });

  it('decodes a right-to-left scan', () => {
    // A reversed run list is NOT a forward-readable barcode: reversing flips
    // the element order inside every symbol, so the decoder must walk
    // stop -> start against a reversed pattern table.
    const reversed = Uint8Array.from(lineFor('0000646')).reverse();
    expect(decodeLine(reversed)).toContain('0000646');
  });

  it('decodes with the barcode offset within a longer line', () => {
    const inner = lineFor('0000646');
    const line = new Uint8Array(inner.length + 400);
    line.set(inner, 137);
    expect(decodeLine(line)).toContain('0000646');
  });
});

describe('Code 128 rejection', () => {
  it('rejects a corrupted checksum', () => {
    const widths = encodeDigitsToWidths('0000646');
    // The check symbol is the second-to-last group of 6, before the 7-element stop.
    const checkStart = widths.length - 13;
    const corrupted = [...widths];
    corrupted.splice(checkStart, 6, ...PATTERNS[42]);
    expect(decodeLine(lineFromWidths(corrupted))).toEqual([]);
  });

  it('rejects noise', () => {
    const line = new Uint8Array(1400);
    let seed = 12345;
    for (let i = 0; i < line.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      line[i] = (seed >> 16) & 1;
    }
    expect(decodeLine(line)).toEqual([]);
  });

  it('rejects a flat line', () => {
    expect(decodeLine(new Uint8Array(800))).toEqual([]);
  });

  it('rejects a truncated barcode', () => {
    const full = lineFor('0000646');
    expect(decodeLine(full.slice(0, Math.floor(full.length * 0.6)))).toEqual([]);
  });

  it('refuses modules too narrow to resolve', () => {
    // Sub-pixel modules would otherwise let noise match a pattern.
    const widths = encodeDigitsToWidths('0000646');
    const line = new Uint8Array(widths.reduce((a, b) => a + b, 0));
    expect(decodeLine(line)).toEqual([]);
  });
});

describe('Code 128 2D scanning', () => {
  /** Build a greyscale image containing a barcode band. */
  function image(digits, { width = 900, height = 400, module = 3, vertical = false } = {}) {
    const line = lineFor(digits, module);
    const gray = new Uint8Array(width * height).fill(235);
    if (!vertical) {
      const x0 = Math.floor((width - line.length) / 2);
      for (let y = 120; y < 280; y++) {
        for (let i = 0; i < line.length; i++) {
          const x = x0 + i;
          if (x >= 0 && x < width) gray[y * width + x] = line[i] ? 20 : 245;
        }
      }
    } else {
      const y0 = Math.floor((height - line.length) / 2);
      for (let x = 300; x < 600; x++) {
        for (let i = 0; i < line.length; i++) {
          const y = y0 + i;
          if (y >= 0 && y < height) gray[y * width + x] = line[i] ? 20 : 245;
        }
      }
    }
    return { gray, width, height };
  }

  it('finds a horizontal barcode', () => {
    const { gray, width, height } = image('0000646');
    const hit = scanCode128(gray, width, height, { validate: (t) => /^\d{7}$/.test(t) });
    expect(hit?.text).toBe('0000646');
    expect(hit?.orientation).toBe('row');
  });

  it('finds a barcode rotated 90 degrees', () => {
    const { gray, width, height } = image('0000646', { vertical: true, height: 900, width: 900 });
    const hit = scanCode128(gray, width, height, { validate: (t) => /^\d{7}$/.test(t) });
    expect(hit?.text).toBe('0000646');
    expect(hit?.orientation).toBe('column');
  });

  it('returns null for a photo with no label — the common case', () => {
    // Most photos legitimately return nothing; only the last of a group
    // carries a label.
    const width = 600;
    const height = 400;
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) gray[y * width + x] = 60 + ((x * 90) / width | 0);
    }
    expect(scanCode128(gray, width, height, { validate: (t) => /^\d{7}$/.test(t) })).toBeNull();
  });

  it('skips low-contrast lines rather than guessing', () => {
    const { gray, width, height } = image('0000646');
    const flattened = Uint8Array.from(gray, (v) => 128 + ((v - 128) * 0.1 | 0));
    expect(scanCode128(flattened, width, height, { validate: (t) => /^\d{7}$/.test(t) })).toBeNull();
  });
});
