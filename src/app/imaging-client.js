/**
 * Main-thread handle to the imaging worker.
 *
 * Serialises jobs: exactly one photo is in flight at a time (§5.4). The
 * orchestrator overlaps *network* with imaging via prefetch, not imaging with
 * imaging.
 */

import { log } from '../core/log.js';

let worker = null;
let seq = 0;
const pending = new Map();
let watermarkLoaded = false;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../worker/imaging.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const { id, ok, result, error } = event.data ?? {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(result);
    else {
      const err = new Error(error?.message ?? 'imaging worker error');
      err.name = error?.name ?? 'Error';
      err.workerStack = error?.stack;
      entry.reject(err);
    }
  };
  worker.onerror = (event) => {
    // A worker-level error usually means the tab is about to be killed for
    // memory, or a module failed to load. Fail everything in flight loudly.
    const err = new Error(`imaging worker crashed: ${event.message ?? 'unknown'}`);
    log.error('Imaging worker crashed', `${event.filename ?? ''}:${event.lineno ?? ''} ${event.message ?? ''}`);
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
    worker = null;
    watermarkLoaded = false;
  };
  return worker;
}

function call(type, payload, transfer = []) {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload }, transfer);
  });
}

/** Serialise jobs behind a single promise chain. */
let chain = Promise.resolve();
function serialise(fn) {
  const run = chain.then(fn, fn);
  // Keep the chain alive regardless of individual failures.
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * Load the watermark PNG into the worker. Called at startup and whenever the
 * operator supplies a different asset in Settings.
 * @param {Blob|ImageBitmap|null} source
 */
export async function setWatermark(source) {
  if (!source) {
    watermarkLoaded = false;
    return call('setWatermark', { source: null });
  }
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  const info = await call('setWatermark', { source: bitmap }, [bitmap]);
  watermarkLoaded = true;
  return info;
}

export function hasWatermark() {
  return watermarkLoaded;
}

/**
 * Watermark + read the SKU from one photo.
 * @param {{blob:Blob, dcfKey:string, options:object, scanForSku?:boolean}} job
 */
export function processPhoto(job) {
  return serialise(() => call('process', job));
}

/** Read a SKU without producing an output image (manual regroup helper). */
export function scanForSku(blob, options = {}) {
  return serialise(() => call('scan', { blob, options }));
}

export function ping() {
  return call('ping', {});
}

export function terminate() {
  if (worker) worker.terminate();
  worker = null;
  watermarkLoaded = false;
  pending.clear();
}
