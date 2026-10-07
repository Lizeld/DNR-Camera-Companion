/**
 * Settings — spec §7 "Settings". Persisted to localStorage so they survive a
 * tab kill (§5.4), which IndexedDB would also do but with async startup.
 */

const KEY = 'dnr-watermark.settings.v1';

export const DEFAULTS = Object.freeze({
  cameraUrl: '',
  backendUrl: '',
  backendToken: '',
  /** S3 key prefix; §4's example key is `listings/IMG_0017.JPG`. */
  keyPrefix: 'listings/',
  watermarkPadding: 125,
  jpegQuality: 92,
  staleWarning: 30,
  autoEvacuate: 35,
  pollIntervalMs: 1000,
  /** §6.1 step 5: give up on a queue item after this many cycles. */
  maxQueueAttempts: 15,
  verboseErrors: false,
  keepScreenAwake: true,
  notifications: false,
  autoUpload: true,
});

let cache = null;

function coerce(raw) {
  const s = { ...DEFAULTS, ...(raw ?? {}) };
  const num = (v, d, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  s.watermarkPadding = Math.round(num(s.watermarkPadding, DEFAULTS.watermarkPadding, 0, 2000));
  s.jpegQuality = Math.round(num(s.jpegQuality, DEFAULTS.jpegQuality, 1, 100));
  s.staleWarning = Math.round(num(s.staleWarning, DEFAULTS.staleWarning, 1, 500));
  s.autoEvacuate = Math.round(num(s.autoEvacuate, DEFAULTS.autoEvacuate, 2, 1000));
  if (s.autoEvacuate <= s.staleWarning) s.autoEvacuate = s.staleWarning + 1;
  s.pollIntervalMs = Math.round(num(s.pollIntervalMs, DEFAULTS.pollIntervalMs, 250, 30000));
  s.maxQueueAttempts = Math.round(num(s.maxQueueAttempts, DEFAULTS.maxQueueAttempts, 1, 100));
  for (const k of ['verboseErrors', 'keepScreenAwake', 'notifications', 'autoUpload']) {
    s[k] = Boolean(s[k]);
  }
  for (const k of ['cameraUrl', 'backendUrl', 'backendToken', 'keyPrefix']) {
    s[k] = String(s[k] ?? '');
  }
  return s;
}

export function load() {
  if (cache) return cache;
  try {
    cache = coerce(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    cache = coerce({});
  }
  return cache;
}

/** Merge a patch, persist, and return the new settings. */
export function save(patch) {
  cache = coerce({ ...load(), ...patch });
  localStorage.setItem(KEY, JSON.stringify(cache));
  listeners.forEach((fn) => fn(cache));
  return cache;
}

export function reset() {
  localStorage.removeItem(KEY);
  cache = null;
  const s = load();
  listeners.forEach((fn) => fn(s));
  return s;
}

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Thresholds in the shape the grouping reducer wants. */
export function thresholds(s = load()) {
  return { staleWarning: s.staleWarning, autoEvacuate: s.autoEvacuate };
}

/** Watermark options in the shape the renderer wants. */
export function watermarkOptions(s = load()) {
  return { padding: s.watermarkPadding, jpegQuality: s.jpegQuality / 100 };
}

/**
 * Normalise the backend base URL, defending against both §4 traps:
 *
 *  1. Endpoints live under `/api`; the root paths are the frontend SPA and
 *     `POST /presign` returns nginx 405.
 *  2. An `http://` base 301-redirects and fetch follows it by downgrading
 *     POST to GET, which the API answers with 405. Force https.
 *
 * A path-only value (`/backend`) means the local proxy in serve.py. That is
 * same-origin, so neither trap applies — there is no scheme to force and no
 * redirect to dodge — and it is the one form that must survive verbatim.
 *
 * @returns {string} e.g. "https://inventory.example.com/api" or "/backend/api"
 */
export function backendApiBase(s = load()) {
  let value = String(s.backendUrl ?? '').trim();
  value = value.replace(/\/+$/, '');
  if (!value) return '';
  if (value.startsWith('/')) return /\/api$/i.test(value) ? value : `${value}/api`;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/^http:\/\//i, 'https://');
  if (!/\/api$/i.test(value)) value = `${value}/api`;
  return value;
}

/** Mask a token for display. */
export function maskToken(token) {
  if (!token) return '(not set)';
  if (token.length <= 8) return '•'.repeat(token.length);
  return `${token.slice(0, 3)}${'•'.repeat(Math.min(16, token.length - 6))}${token.slice(-3)}`;
}
