/**
 * Upload backend — spec §4.
 *
 *   POST {api}/presign  { key, contentType }  -> { uploadUrl, publicUrl, key }
 *   PUT  uploadUrl      <bytes>                (presigned S3, 300s TTL)
 *   POST {api}/drafts   { sku, images[], draftId? } -> { draftId, appended? }
 *
 * Idempotent per SKU: each photo's `publicUrl` is persisted the moment its PUT
 * succeeds, and the draft is built from *all* uploaded photos for that SKU, so
 * a retry after a partial failure still produces a complete draft. Local
 * copies are deleted only after the draft is confirmed.
 *
 * A reshoot of a SKU that already has a draft sends only the new photos plus
 * that `draftId`, and the backend appends them. If the draft has since been
 * published, the backend makes a new draft from the new photos instead.
 */

import * as db from '../core/db.js';
import * as blobstore from '../core/blobstore.js';
import * as settings from '../core/settings.js';
import { log, fire } from '../core/log.js';

export class UploadError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const PRESIGN_TTL_GUARD_MS = 240000; // presigned URLs live 300s; re-presign well inside that

function authHeaders(s) {
  if (!s.backendToken) throw new UploadError('Backend token is not set (Settings)');
  return { Authorization: `Bearer ${s.backendToken}`, 'Content-Type': 'application/json' };
}

async function postJson(url, body, s, signal) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(s),
      body: JSON.stringify(body),
      signal,
      // Never follow a redirect: an http:// base 301s and fetch downgrades
      // POST to GET, which the API answers with 405 (§4 trap 2). We force
      // https in backendApiBase, and this makes a surprise redirect loud.
      redirect: 'error',
      cache: 'no-store',
    });
  } catch (err) {
    // A CORS block never reaches this code as a status — the browser discards
    // the response and fetch rejects with a bare "NetworkError"/"Failed to
    // fetch". Indistinguishable from the backend being down, so say both.
    const hint = /^https?:\/\//i.test(url)
      ? ' — the backend is unreachable, or it refused this origin at CORS. Serve with '
        + '`python serve.py --backend <url>` and set Backend URL to /backend to route around CORS.'
      : '';
    throw new UploadError(`POST ${url} failed: ${err.message}${hint}`, { url });
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const hint =
      response.status === 405
        ? ' (405 usually means the /api prefix is missing or an http:// base redirected POST to GET — §4)'
        : '';
    throw new UploadError(`POST ${url} -> ${response.status}${hint}`, {
      status: response.status,
      url,
      body: text.slice(0, 400),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UploadError(`POST ${url}: response was not JSON`, { url, body: text.slice(0, 200) });
  }
}

/** @returns {Promise<{uploadUrl:string, publicUrl:string, key:string}>} */
export async function presign(key, contentType, s = settings.load(), signal) {
  const api = settings.backendApiBase(s);
  if (!api) throw new UploadError('Backend URL is not set (Settings)');
  const res = await postJson(`${api}/presign`, { key, contentType }, s, signal);
  if (!res?.uploadUrl || !res?.publicUrl) {
    throw new UploadError('presign response missing uploadUrl/publicUrl', { body: JSON.stringify(res) });
  }
  return res;
}

/**
 * PUT bytes straight to S3. Bytes never transit the backend.
 * Requires bucket CORS allowing PUT from this origin with the Content-Type
 * header (§4, web-specific addition — Android did not need this).
 */
export async function putToS3(uploadUrl, blob, contentType, signal) {
  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'PUT',
      // Content-Type is bound into the presigned signature; it must match
      // exactly what was sent to /presign.
      headers: { 'Content-Type': contentType },
      body: blob,
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    throw new UploadError(
      `PUT to S3 failed: ${err.message} — if this is a CORS error, the bucket must allow PUT + Content-Type from ${location.origin}`,
      { url: uploadUrl },
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new UploadError(`PUT to S3 -> ${response.status}`, {
      status: response.status,
      url: uploadUrl,
      body: body.slice(0, 400),
    });
  }
}

/** @returns {Promise<{draftId:string}>} */
export async function createDraft(sku, images, s = settings.load(), signal, appendTo = null) {
  const api = settings.backendApiBase(s);
  const body = appendTo ? { sku, images, draftId: String(appendTo) } : { sku, images };
  const res = await postJson(`${api}/drafts`, body, s, signal);
  if (!res?.draftId) throw new UploadError('drafts response missing draftId', { body: JSON.stringify(res) });
  return res;
}

/**
 * Decide what a SKU's /drafts call sends. Photos already in a draft (an
 * earlier shoot of this SKU) aren't resent; the rest are appended to the most
 * recently updated of those drafts. With no earlier draft, everything is sent
 * and a new draft is made.
 *
 * @param {object[]} photos the SKU's photos, REVIEW excluded
 * @returns {{appendTo:string|null, sending:object[]}}
 */
export function planDraft(photos) {
  const earlier = photos
    .filter((p) => p.status === db.STATUS.UPLOADED && p.draftId)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const appendTo = earlier[0]?.draftId ?? null;
  return {
    appendTo,
    sending: appendTo ? photos.filter((p) => p.status !== db.STATUS.UPLOADED) : photos,
  };
}

/**
 * S3 object key for a photo. §4's example is `listings/IMG_0017.JPG`.
 *
 * This is a hint: the backend appends a unique suffix (Canon numbers wrap at
 * 9999, so the bare filename would overwrite an older listing's photo) and
 * returns the real key/publicUrl, which are what get stored.
 */
export function objectKey(photo, s = settings.load()) {
  const prefix = (s.keyPrefix || 'listings/').replace(/^\/+/, '');
  return `${prefix.endsWith('/') ? prefix : `${prefix}/`}${photo.fileName}`;
}

/**
 * Upload every photo of a SKU and create the draft.
 *
 * Safe to call repeatedly: photos that already carry a `publicUrl` are
 * skipped, and a re-run after a partial failure completes the set and creates
 * the draft from all of them.
 *
 * @param {string} sku
 * @param {object} [opts]
 * @param {(progress:{done:number,total:number,photo:object})=>void} [opts.onProgress]
 * @returns {Promise<{sku:string, draftId:string, uploaded:number, skipped:number}>}
 */
export async function uploadSku(sku, opts = {}) {
  const s = settings.load();
  const signal = opts.signal;
  const onProgress = opts.onProgress ?? (() => {});

  const photos = (await db.photosBySku(sku)).filter((p) => p.status !== db.STATUS.REVIEW);
  if (photos.length === 0) throw new UploadError(`No photos held for SKU ${sku}`);

  const needsUpload = photos.filter((p) => !p.publicUrl);
  log.info(`Uploading SKU ${sku}: ${needsUpload.length} of ${photos.length} photo(s) to send`);

  let done = 0;
  let uploaded = 0;
  const failures = [];

  for (const photo of needsUpload) {
    if (signal?.aborted) throw new UploadError('Upload aborted');
    try {
      const blob = await blobstore.get(photo.opfsPath);
      if (!blob) {
        throw new UploadError(`Local bytes for ${photo.dcfKey} are gone; re-download it from the camera browser`);
      }
      const contentType = blob.type || 'image/jpeg';
      const startedAt = Date.now();
      const { uploadUrl, publicUrl } = await presign(objectKey(photo, s), contentType, s, signal);
      if (Date.now() - startedAt > PRESIGN_TTL_GUARD_MS) {
        throw new UploadError('presign took too long; retrying with a fresh URL');
      }
      await putToS3(uploadUrl, blob, contentType, signal);

      // Persist immediately — this is what makes a retry idempotent.
      await db.updatePhoto(photo.dcfKey, { publicUrl, error: null, status: db.STATUS.GROUPED });
      uploaded++;
      log.debug(`Uploaded ${photo.dcfKey}`, publicUrl);
    } catch (err) {
      failures.push({ dcfKey: photo.dcfKey, error: err.message });
      await db.updatePhoto(photo.dcfKey, { status: db.STATUS.FAILED, error: err.message });
      log.error(`Upload failed for ${photo.dcfKey}`, s.verboseErrors ? err : err.message);
    } finally {
      done++;
      onProgress({ done, total: needsUpload.length, photo });
    }
  }

  // Rebuild from storage: includes photos uploaded on an earlier attempt.
  const current = (await db.photosBySku(sku)).filter((p) => p.status !== db.STATUS.REVIEW);
  const missing = current.filter((p) => !p.publicUrl);
  if (missing.length > 0) {
    fire('upload:failed', { sku, failures });
    throw new UploadError(
      `SKU ${sku}: ${missing.length} of ${current.length} photo(s) did not upload; draft not created. ` +
        `Retry to finish the set. First error: ${failures[0]?.error ?? 'unknown'}`,
    );
  }

  const { appendTo, sending } = planDraft(current);
  if (appendTo && sending.length === 0) {
    log.info(`SKU ${sku}: every photo is already in draft ${appendTo}`);
    fire('upload:done', { sku, draftId: appendTo, images: 0 });
    return { sku, draftId: appendTo, uploaded: 0, skipped: current.length };
  }

  const images = sending
    .slice()
    .sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0))
    .map((p) => p.publicUrl);

  const { draftId, appended } = await createDraft(sku, images, s, signal, appendTo);
  if (appended) log.success(`Added ${images.length} photo(s) to the existing draft for SKU ${sku}`, draftId);
  else if (appendTo) log.success(`Draft ${appendTo} for SKU ${sku} is no longer open — created a new draft (${images.length} images)`, draftId);
  else log.success(`Draft created for SKU ${sku} (${images.length} images)`, draftId);

  // Only now is it safe to drop local copies (§4).
  for (const p of sending) {
    await blobstore.remove(p.opfsPath);
    await db.updatePhoto(p.dcfKey, {
      status: db.STATUS.UPLOADED,
      opfsPath: null,
      error: null,
      draftId,
    });
  }

  await db.setMeta('lastDraft', { sku, draftId, at: Date.now(), images: images.length });
  fire('upload:done', { sku, draftId, images: images.length });
  fire('photos:changed', { reason: 'upload', sku });

  return { sku, draftId, appended: Boolean(appended), uploaded, skipped: current.length - uploaded };
}

// ---- serial upload queue -------------------------------------------------
// One SKU at a time: the camera link and the uploader share the same Wi-Fi,
// and parallel uploads make the ingest loop stutter.

const queue = [];
const queued = new Set();
let running = false;
let activeSku = null;

export function enqueueSku(sku) {
  if (queued.has(sku)) return false;
  queued.add(sku);
  queue.push(sku);
  fire('upload:queued', { sku, depth: queue.length });
  void drain();
  return true;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const sku = queue.shift();
      queued.delete(sku);
      activeSku = sku;
      fire('upload:started', { sku });
      try {
        await uploadSku(sku, { onProgress: (p) => fire('upload:progress', { sku, ...p }) });
      } catch (err) {
        log.error(`SKU ${sku} upload incomplete`, err.message);
        fire('upload:failed', { sku, error: err.message });
      } finally {
        activeSku = null;
      }
    }
  } finally {
    running = false;
    fire('upload:idle', {});
  }
}

export function queueDepth() {
  return queue.length + (running ? 1 : 0);
}

export function isRunning() {
  return running;
}

/** SKU being uploaded right now, or null. */
export function currentSku() {
  return activeSku;
}

export function isQueued(sku) {
  return queued.has(sku);
}

/** SKUs with at least one FAILED photo — drives the retry banner (§7). */
export async function failedSkus() {
  const failed = await db.photosByStatus(db.STATUS.FAILED);
  const bySku = new Map();
  for (const p of failed) {
    const key = p.sku ?? '(ungrouped)';
    if (!bySku.has(key)) bySku.set(key, { sku: p.sku, photos: [], lastError: null });
    const entry = bySku.get(key);
    entry.photos.push(p.dcfKey);
    if (p.error) entry.lastError = p.error;
  }
  return [...bySku.values()];
}

/** Upload (or retry) one SKU: clear its FAILED markers and queue it. */
export async function retrySku(sku) {
  for (const p of await db.photosBySku(sku)) {
    if (p.status === db.STATUS.FAILED) await db.updatePhoto(p.dcfKey, { status: db.STATUS.GROUPED, error: null });
  }
  return enqueueSku(sku);
}

/** Retry every SKU that has a failed photo. */
export async function retryAllFailed() {
  const groups = await failedSkus();
  let started = 0;
  for (const g of groups) {
    if (!g.sku) continue;
    // Clear the failed marker so the record is eligible again.
    for (const key of g.photos) await db.updatePhoto(key, { status: db.STATUS.GROUPED, error: null });
    if (enqueueSku(g.sku)) started++;
  }
  return started;
}
