/**
 * Timestamped activity log + tiny event bus (§7 Status).
 *
 * Silent failures cost a production run, so everything the pipeline does goes
 * through here and the Status screen renders it verbatim.
 */

const MAX_ENTRIES = 500;

/** @type {{id:number, at:number, level:string, message:string, detail:string|null}[]} */
const entries = [];
let nextId = 1;

const listeners = new Set();

export const LEVELS = Object.freeze(['debug', 'info', 'success', 'warn', 'error']);

function emit(entry) {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  listeners.forEach((fn) => {
    try {
      fn(entry, entries);
    } catch { /* a broken listener must not break logging */ }
  });
}

function write(level, message, detail) {
  const entry = {
    id: nextId++,
    at: Date.now(),
    level,
    message: String(message),
    detail: detail === undefined || detail === null ? null : stringifyDetail(detail),
  };
  emit(entry);
  if (level === 'error') console.error(message, detail ?? '');
  else if (level === 'warn') console.warn(message, detail ?? '');
  return entry;
}

function stringifyDetail(detail) {
  if (typeof detail === 'string') return detail;
  if (detail instanceof Error) return `${detail.name}: ${detail.message}\n${detail.stack ?? ''}`;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

export const log = {
  debug: (m, d) => write('debug', m, d),
  info: (m, d) => write('info', m, d),
  success: (m, d) => write('success', m, d),
  warn: (m, d) => write('warn', m, d),
  error: (m, d) => write('error', m, d),
};

export function history() {
  return entries.slice();
}

export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clear() {
  entries.length = 0;
  listeners.forEach((fn) => fn(null, entries));
}

/** "12s ago", "4m ago", "2h ago" — used all over the Status screen. */
export function relativeTime(timestamp, now = Date.now()) {
  if (!timestamp) return 'never';
  const s = Math.max(0, Math.round((now - timestamp) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatClock(timestamp) {
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// ---- tiny event bus, used between orchestrator and UI --------------------

const busListeners = new Map();

export function on(event, fn) {
  if (!busListeners.has(event)) busListeners.set(event, new Set());
  busListeners.get(event).add(fn);
  return () => busListeners.get(event)?.delete(fn);
}

export function fire(event, payload) {
  for (const fn of busListeners.get(event) ?? []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`listener for ${event} threw`, err);
    }
  }
}
