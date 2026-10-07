/**
 * Minimal in-browser test runner.
 *
 * There is no Node/npm toolchain here (§ deployment: the app ships as plain ES
 * modules off a static server), and most of what needs testing — OffscreenCanvas
 * compositing, createImageBitmap, BarcodeDetector — only exists in a browser
 * anyway. So the suite runs in the browser and reports both to the DOM and to
 * `window.__testResults`, so it can be driven headlessly.
 */

const suites = [];
let current = null;

export function describe(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

export function it(name, fn) {
  if (!current) throw new Error('it() outside describe()');
  current.tests.push({ name, fn });
}

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function fmt(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Set) return `Set(${[...value].map(fmt).join(', ')})`;
  if (Array.isArray(value)) return `[${value.map(fmt).join(', ')}]`;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function expect(actual) {
  return {
    toBe(expected, note = '') {
      if (!Object.is(actual, expected)) {
        throw new AssertionError(`expected ${fmt(expected)} but got ${fmt(actual)}${note ? ` — ${note}` : ''}`);
      }
    },
    toEqual(expected, note = '') {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) {
        throw new AssertionError(`expected ${b} but got ${a}${note ? ` — ${note}` : ''}`);
      }
    },
    toBeCloseTo(expected, tolerance = 1, note = '') {
      if (Math.abs(actual - expected) > tolerance) {
        throw new AssertionError(
          `expected ${fmt(actual)} to be within ${tolerance} of ${fmt(expected)}${note ? ` — ${note}` : ''}`,
        );
      }
    },
    toBeTruthy(note = '') {
      if (!actual) throw new AssertionError(`expected truthy, got ${fmt(actual)}${note ? ` — ${note}` : ''}`);
    },
    toBeFalsy(note = '') {
      if (actual) throw new AssertionError(`expected falsy, got ${fmt(actual)}${note ? ` — ${note}` : ''}`);
    },
    toBeNull(note = '') {
      if (actual !== null) throw new AssertionError(`expected null, got ${fmt(actual)}${note ? ` — ${note}` : ''}`);
    },
    toContain(needle, note = '') {
      const ok = Array.isArray(actual) || typeof actual === 'string'
        ? actual.includes(needle)
        : actual?.has?.(needle);
      if (!ok) throw new AssertionError(`expected ${fmt(actual)} to contain ${fmt(needle)}${note ? ` — ${note}` : ''}`);
    },
    toHaveLength(n, note = '') {
      if (actual?.length !== n) {
        throw new AssertionError(`expected length ${n}, got ${actual?.length}${note ? ` — ${note}` : ''}`);
      }
    },
    async toThrow(note = '') {
      try {
        await actual();
      } catch {
        return;
      }
      throw new AssertionError(`expected a throw${note ? ` — ${note}` : ''}`);
    },
  };
}

/** Run everything and render into `root`. */
export async function run(root) {
  const summary = { total: 0, passed: 0, failed: 0, suites: [], startedAt: Date.now() };
  root.replaceChildren();

  for (const suite of suites) {
    const suiteEl = document.createElement('section');
    suiteEl.className = 'suite';
    const head = document.createElement('h2');
    head.textContent = suite.name;
    suiteEl.appendChild(head);
    root.appendChild(suiteEl);

    const suiteResult = { name: suite.name, tests: [] };
    summary.suites.push(suiteResult);

    for (const test of suite.tests) {
      summary.total++;
      const row = document.createElement('div');
      row.className = 'test running';
      row.textContent = `… ${test.name}`;
      suiteEl.appendChild(row);
      // Let the browser paint before a potentially slow test. A hidden tab
      // clamps setTimeout to ~1s, which would stretch the suite to minutes, so
      // fall back to a microtask when nobody is watching.
      if (document.hidden) await Promise.resolve();
      else await new Promise((r) => setTimeout(r, 0));

      const startedAt = performance.now();
      try {
        await test.fn();
        const ms = Math.round(performance.now() - startedAt);
        summary.passed++;
        row.className = 'test pass';
        row.textContent = `PASS  ${test.name}  (${ms}ms)`;
        suiteResult.tests.push({ name: test.name, ok: true, ms });
      } catch (err) {
        const ms = Math.round(performance.now() - startedAt);
        summary.failed++;
        row.className = 'test fail';
        row.textContent = `FAIL  ${test.name}  (${ms}ms)`;
        const detail = document.createElement('pre');
        detail.className = 'detail';
        detail.textContent = `${err.name}: ${err.message}${err.stack ? `\n${err.stack.split('\n').slice(1, 4).join('\n')}` : ''}`;
        suiteEl.appendChild(detail);
        suiteResult.tests.push({ name: test.name, ok: false, ms, error: `${err.name}: ${err.message}` });
      }
    }
  }

  summary.durationMs = Date.now() - summary.startedAt;
  window.__testResults = summary;
  window.__testsDone = true;
  return summary;
}

/** Fetch a fixture image as an ImageBitmap. */
export async function loadFixture(name) {
  const response = await fetch(`tests/fixtures/${name}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`fixture ${name} missing (HTTP ${response.status}) — run: python tools/make_fixtures.py`);
  }
  return createImageBitmap(await response.blob());
}

export async function loadFixtureBlob(name) {
  const response = await fetch(`tests/fixtures/${name}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`fixture ${name} missing (HTTP ${response.status}) — run: python tools/make_fixtures.py`);
  }
  return response.blob();
}

/** Pull RGBA out of any image source. */
export function imageDataOf(source) {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  return ctx.getImageData(0, 0, source.width, source.height);
}
