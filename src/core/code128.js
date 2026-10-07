/**
 * Code 128 decoder — pure JS, no dependencies.
 *
 * Why hand-rolled instead of zxing-wasm (§5.3): this project has no Node/npm
 * toolchain and ships as plain ES modules off a LAN static server, so a
 * vendored wasm bundle is a liability. Code 128 is the only symbology we need
 * (§2.2, confirmed empirically against the real labels), the label is shot
 * deliberately at close range, and a line scanner is a couple hundred lines.
 * It also works offline and in every browser, which `BarcodeDetector` does not.
 *
 * The decoder is a classic run-length line scanner:
 *   binarize a scan line -> run-length encode -> match element groups against
 *   the 107-pattern table by least squares -> verify the mod-103 checksum ->
 *   decode code sets A/B/C.
 *
 * Both scan directions are supported. Note that a right-to-left read is *not*
 * a reversed run list fed back through the forward decoder — reversing flips
 * the element order inside every symbol too. The reverse path therefore
 * matches against a reversed pattern table and walks stop -> start.
 */

/**
 * The 107 Code 128 symbol patterns as element widths in modules
 * (bar, space, bar, space, bar, space), 11 modules each. Index = symbol value.
 * Value 106 is the stop pattern: seven elements, 13 modules.
 */
const PATTERN_STRINGS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];

export const PATTERNS = PATTERN_STRINGS.map((s) => Array.from(s, Number));
const DATA_PATTERNS = PATTERNS.slice(0, 106);
const STOP_PATTERN = PATTERNS[106];
const REV_DATA_PATTERNS = DATA_PATTERNS.map((p) => [...p].reverse());
const REV_STOP_PATTERN = [...STOP_PATTERN].reverse();

export const START_A = 103;
export const START_B = 104;
export const START_C = 105;
export const STOP = 106;

const CODE_C = 99;
const FNC1 = 102;

/** Max mean squared width error per element before a symbol match is rejected. */
const MATCH_TOLERANCE = 0.55;
/** Runaway guard: a Code 128 symbol stream longer than this is noise. */
const MAX_SYMBOLS = 80;

function isStartValue(v) {
  return v === START_A || v === START_B || v === START_C;
}

/**
 * Match `count` element widths beginning at `offset` against a pattern table.
 *
 * Widths are normalised so the group totals `totalModules`, then compared by
 * least squares — tolerant of ink spread and mild perspective, unlike naive
 * rounding to integer modules.
 *
 * @returns {number} symbol value, or -1 if nothing matched within tolerance
 */
function matchPattern(runs, offset, count, patterns, totalModules) {
  let total = 0;
  for (let k = 0; k < count; k++) total += runs[offset + k];
  if (total <= 0) return -1;

  const unit = total / totalModules;
  // A module narrower than ~0.6px cannot be resolved; reject rather than
  // hallucinate a symbol out of sensor noise.
  if (unit < 0.6) return -1;

  let best = -1;
  let bestErr = Infinity;
  for (let v = 0; v < patterns.length; v++) {
    const p = patterns[v];
    let err = 0;
    for (let k = 0; k < count; k++) {
      const d = runs[offset + k] / unit - p[k];
      err += d * d;
      if (err >= bestErr) break;
    }
    if (err < bestErr) {
      bestErr = err;
      best = v;
    }
  }
  if (best < 0 || bestErr / count > MATCH_TOLERANCE) return -1;
  return best;
}

/** Mod-103 checksum: start + sum(value_k * k) for 1-based k over the data symbols. */
export function checksum(startValue, dataValues) {
  let sum = startValue;
  for (let k = 0; k < dataValues.length; k++) sum += dataValues[k] * (k + 1);
  return sum % 103;
}

/**
 * Turn decoded symbol values into text, honouring code-set switches.
 * @returns {string|null} null if the stream uses something we cannot represent
 */
export function symbolsToText(startValue, values) {
  let set = startValue === START_A ? 'A' : startValue === START_B ? 'B' : 'C';
  let shifted = null;
  let out = '';

  for (const v of values) {
    const active = shifted ?? set;
    shifted = null;

    if (active === 'C') {
      if (v < 100) out += String(v).padStart(2, '0');
      else if (v === 100) set = 'B';
      else if (v === 101) set = 'A';
      else if (v === FNC1) { /* AI separator — drop */ }
      else return null;
      continue;
    }

    if (v < 96) {
      // A: 0..63 -> ASCII 32..95, 64..95 -> control 0..31.  B: 0..95 -> 32..127.
      out += String.fromCharCode(active === 'A' ? (v < 64 ? v + 32 : v - 64) : v + 32);
      continue;
    }

    switch (v) {
      case 96: // FNC3
      case 97: // FNC2
        break;
      case 98: // Shift to the other of A/B for one character
        shifted = active === 'A' ? 'B' : 'A';
        break;
      case CODE_C:
        set = 'C';
        break;
      case 100: // A: Code B.  B: FNC4.
        if (active === 'A') set = 'B';
        break;
      case 101: // A: FNC4.  B: Code A.
        if (active === 'B') set = 'A';
        break;
      case FNC1:
        break;
      default:
        return null;
    }
  }
  return out;
}

/**
 * Left-to-right decode beginning at run index `i` (must be a bar).
 *
 * The stop pattern is ambiguous: a data symbol plus the following bar can fit
 * it within tolerance (SKU 0000706: the B-set '6', 223112, then a 2-module bar
 * passes for 2331112). Ending there either fails the checksum — losing the
 * line — or, about 1 time in 103, passes it and yields a truncated code
 * (0000469 read as 000046). So a stop match is recorded as one candidate and
 * the read continues as data; every complete, checksum-valid reading comes
 * back, longest first, for the caller's validator to choose from.
 *
 * @param {{symbols:number, from:number, to:number}} [partial] best partial read
 *   so far (symbols matched incl. the start, and its run span), updated in place
 * @returns {string[]}
 */
function decodeForwardAt(runs, i, partial) {
  const startValue = matchPattern(runs, i, 6, DATA_PATTERNS, 11);
  if (!isStartValue(startValue)) return [];

  const found = [];
  const values = [];
  let p = i + 6;

  for (;;) {
    if (values.length >= 1 && p + 7 <= runs.length && matchPattern(runs, p, 7, [STOP_PATTERN], 13) === 0) {
      const data = values.slice(0, -1);
      if (values[values.length - 1] === checksum(startValue, data)) {
        const text = symbolsToText(startValue, data);
        if (text) found.push(text);
      }
    }

    if (p + 6 > runs.length || values.length >= MAX_SYMBOLS) break;
    const v = matchPattern(runs, p, 6, DATA_PATTERNS, 11);
    if (v < 0 || isStartValue(v)) break;
    values.push(v);
    p += 6;
  }
  if (partial && values.length + 1 > partial.symbols) {
    partial.symbols = values.length + 1;
    partial.from = i;
    partial.to = p;
    partial.reverse = false;
  }
  return found.reverse();
}

/**
 * Right-to-left decode beginning at run index `i` (must be a bar): the scan
 * enters through the stop pattern, so every group is matched against the
 * reversed table and the symbol stream comes out back to front.
 * @returns {string|null}
 */
function decodeReverseAt(runs, i, partial) {
  if (matchPattern(runs, i, 7, [REV_STOP_PATTERN], 13) !== 0) return null;

  const reversedStream = []; // [check, sym_n, ..., sym_1, start]
  let p = i + 7;
  const note = () => {
    if (partial && reversedStream.length + 1 > partial.symbols) {
      partial.symbols = reversedStream.length + 1;
      partial.from = i;
      partial.to = p;
      partial.reverse = true;
    }
  };

  for (;;) {
    if (p + 6 > runs.length || reversedStream.length >= MAX_SYMBOLS) return note(), null;
    const v = matchPattern(runs, p, 6, REV_DATA_PATTERNS, 11);
    if (v < 0) return note(), null;
    p += 6;

    if (isStartValue(v)) {
      if (reversedStream.length < 1) return null;
      const ordered = [...reversedStream].reverse(); // [sym_1..sym_n, check]
      const check = ordered.pop();
      if (check !== checksum(v, ordered)) return null;
      return symbolsToText(v, ordered);
    }
    reversedStream.push(v);
  }
}

/**
 * Decode a single binarized scan line.
 *
 * @param {Uint8Array|number[]} line 1 = dark, 0 = light
 * @param {object} [partial] when given and nothing decodes, receives the best
 *   partial read: `{symbols, x0, x1, reverse}` — symbols matched in a row from
 *   a start (or, for an upside-down label, a reversed stop) pattern, and the
 *   pixel span they cover. A label the
 *   decoder can't finish still shows up here, which is what the OCR fallback
 *   keys on.
 * @returns {string[]} distinct decodes found on this line
 */
export function decodeLine(line, partial) {
  if (line.length === 0) return [];

  // Run-length encode.
  const runs = [];
  let count = 1;
  for (let x = 1; x < line.length; x++) {
    if (line[x] === line[x - 1]) count++;
    else {
      runs.push(count);
      count = 1;
    }
  }
  runs.push(count);

  // runs[k] is a bar iff k % 2 === barParity.
  const barParity = line[0] === 1 ? 0 : 1;

  const span = partial ? { symbols: 0, from: 0, to: 0 } : undefined;
  const results = [];
  for (let i = barParity; i + 6 <= runs.length; i += 2) {
    for (const text of [...decodeForwardAt(runs, i, span), decodeReverseAt(runs, i, span)]) {
      if (text !== null && text !== '' && !results.includes(text)) results.push(text);
    }
  }
  if (span && span.symbols > 0) {
    let x = 0;
    for (let k = 0; k < span.from; k++) x += runs[k];
    let x1 = x;
    for (let k = span.from; k < Math.min(span.to, runs.length); k++) x1 += runs[k];
    partial.symbols = span.symbols;
    partial.x0 = x;
    partial.x1 = x1;
    partial.reverse = span.reverse;
  } else if (partial) {
    partial.symbols = 0;
  }
  return results;
}

/**
 * Scan a greyscale buffer for Code 128 barcodes.
 *
 * Scans rows then columns (a label can be shot in either orientation), sweeping
 * outward from the centre because the label is normally framed centrally.
 * Binarization is the per-line midpoint between that line's min and max, which
 * is robust for a high-contrast label and costs nothing.
 *
 * Each scan line is the average of `band` adjacent lines. Bars run across the
 * band, so averaging keeps them, while speckle — toner dropout in the bars,
 * shrink-wrap glints — is uncorrelated between lines and washes out. On a real
 * wrapped label (tests/fixtures/label-wrapped-0000705.jpg) single lines decode
 * on 1 row in 1067; a 9-line band decodes on 134.
 *
 * @param {Uint8Array|Uint8ClampedArray} gray  w*h greyscale samples
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {number} [opts.stride=6]        rows/columns between scan lines
 * @param {number} [opts.band=9]         lines averaged into each scan line
 * @param {number} [opts.minContrast=40]  skip flat lines
 * @param {(text:string)=>boolean} [opts.validate] accept-first predicate
 * @param {object} [opts.probe] receives `best`: the longest partial read seen
 *   ({orientation, index, x0, x1, symbols, reverse}), for the OCR fallback
 * @returns {{text:string, orientation:'row'|'column', index:number}|null}
 */
export function scanCode128(gray, width, height, opts = {}) {
  const stride = opts.stride ?? 6;
  const band = Math.max(1, opts.band ?? 9);
  const half = band >> 1;
  const minContrast = opts.minContrast ?? 40;
  const validate = opts.validate ?? (() => true);
  const probe = opts.probe ?? null;
  const partial = probe ? {} : undefined;

  let fallback = null;

  const tryLine = (samples, orientation, index) => {
    let min = 255;
    let max = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max - min < minContrast) return null;
    const threshold = (min + max) >> 1;

    const line = new Uint8Array(samples.length);
    for (let i = 0; i < samples.length; i++) line[i] = samples[i] <= threshold ? 1 : 0;

    const texts = decodeLine(line, partial);
    for (const text of texts) {
      if (validate(text)) return { text, orientation, index };
      if (!fallback) fallback = { text, orientation, index };
    }
    if (probe && partial.symbols > (probe.best?.symbols ?? 0)) {
      probe.best = {
        orientation,
        index,
        x0: partial.x0,
        x1: partial.x1,
        symbols: partial.symbols,
        reverse: partial.reverse,
      };
    }
    return null;
  };

  const row = new Uint8Array(width);
  const rowSum = new Uint32Array(width);
  for (const y of centreOutOrder(height, stride)) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height - 1, y + half);
    rowSum.fill(0);
    for (let yy = y0; yy <= y1; yy++) {
      const base = yy * width;
      for (let x = 0; x < width; x++) rowSum[x] += gray[base + x];
    }
    const n = y1 - y0 + 1;
    for (let x = 0; x < width; x++) row[x] = rowSum[x] / n;
    const hit = tryLine(row, 'row', y);
    if (hit) return hit;
  }

  const col = new Uint8Array(height);
  for (const x of centreOutOrder(width, stride)) {
    const x0 = Math.max(0, x - half);
    const x1 = Math.min(width - 1, x + half);
    const n = x1 - x0 + 1;
    for (let y = 0; y < height; y++) {
      const base = y * width;
      let sum = 0;
      for (let xx = x0; xx <= x1; xx++) sum += gray[base + xx];
      col[y] = sum / n;
    }
    const hit = tryLine(col, 'column', x);
    if (hit) return hit;
  }

  return fallback;
}

/** Indices at `stride` spacing, ordered from the centre outward. */
export function centreOutOrder(length, stride) {
  const order = [];
  const mid = Math.floor(length / 2);
  for (let d = 0; d < length; d += stride) {
    const a = mid + d;
    const b = mid - d;
    if (a < length) order.push(a);
    if (d !== 0 && b >= 0) order.push(b);
  }
  return order;
}

// --------------------------------------------------------------------------
// Encoder — used by the test suite to generate synthetic labels. Keeping it
// beside the decoder means the pattern table has exactly one definition.
// --------------------------------------------------------------------------

/**
 * Encode digits as Code 128 (subset C, with a B-subset tail for an odd count).
 * @param {string} digits
 * @returns {number[]} element widths in modules, starting with a bar
 */
export function encodeDigitsToWidths(digits) {
  if (!/^\d+$/.test(digits)) throw new Error('encodeDigitsToWidths: digits only');

  const values = [START_C];
  let i = 0;
  while (digits.length - i >= 2) {
    values.push(parseInt(digits.substr(i, 2), 10));
    i += 2;
  }
  if (i < digits.length) {
    values.push(100); // Code C -> Code B
    values.push(digits.charCodeAt(i) - 32);
  }

  values.push(checksum(values[0], values.slice(1)));
  values.push(STOP);

  const widths = [];
  for (const v of values) widths.push(...PATTERNS[v]);
  return widths;
}
