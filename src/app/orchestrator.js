/**
 * Orchestrator — poll loop, work queue, grouping. Spec §6, §6.1.
 *
 * The queue design is ported directly from Android; each rule below exists
 * because a real production failure required it:
 *
 *  1. Poll `event/polling` every ~1s
 *  2. Enqueue each reported photo by DCF key
 *  3. Detect sequence gaps and enqueue the missing keys too, deriving the
 *     folder from the reported path itself (never `currentdirectory`)
 *  4. Drain in IMG-sequence order. On a transient failure of the lowest item,
 *     stop draining and retry it next cycle — this is what guarantees a later
 *     SKU photo can never flush its group while an earlier frame is missing
 *  5. Give up on an item after ~15 cycles; drop 404s immediately
 *  6. Prefetch the next download while the current photo is being decoded, so
 *     the network is not idle during decode/barcode work — but never while the
 *     current photo is still transferring: the camera serves one content
 *     request at a time and 503s the loser
 */

import { CcapiClient, CcapiError } from '../core/ccapi.js';
import { dcfKey, fileNameOf, sequenceNumber, tryDcfKey } from '../core/dcf.js';
import * as grouping from '../core/grouping.js';
import * as db from '../core/db.js';
import * as blobstore from '../core/blobstore.js';
import * as settings from '../core/settings.js';
import * as imaging from './imaging-client.js';
import * as uploader from './uploader.js';
import * as ocr from './ocr.js';
import { log, fire } from '../core/log.js';

export const CONNECTION = Object.freeze({
  OFFLINE: 'offline',
  CONNECTING: 'connecting',
  ONLINE: 'online',
  ERROR: 'error',
});

/** Swap the file name in a CCAPI content path, to address a missing frame. */
function siblingPath(contentPath, fileName) {
  const cut = contentPath.lastIndexOf('/');
  return cut === -1 ? fileName : `${contentPath.slice(0, cut + 1)}${fileName}`;
}

/** Exported for the test suite; the app uses the `orchestrator` singleton. */
export class Orchestrator {
  constructor() {
    /** @type {CcapiClient|null} */
    this.client = null;
    this.running = false;
    this.connection = CONNECTION.OFFLINE;
    this.groupingState = grouping.initialState();

    /** @type {Map<string, {dcfKey:string, sourcePath:string, sequence:number|null, attempts:number, lastError:string|null}>} */
    this.queue = new Map();

    /** @type {{dcfKey:string, controller:AbortController, promise:Promise<Blob|null>}|null} */
    this.prefetch = null;

    this.stats = {
      lastPhotoAt: null,
      lastPhotoKey: null,
      lastSku: null,
      lastSkuAt: null,
      polls: 0,
      transientPolls: 0,
      processed: 0,
      lastCycleMs: null,
      lastError: null,
    };

    this.wakeLock = null;
    this.abort = null;
    this.cycleTimer = null;
  }

  // ---- lifecycle --------------------------------------------------------

  /** Rehydrate the reducer from IndexedDB so a reload does not reprocess. */
  async restore() {
    const s = settings.load();
    const [keys, lastSequence, pending] = await Promise.all([
      db.allKeys(),
      db.getMeta('lastSequence', null),
      db.getMeta('pendingGroup', []),
    ]);
    // Keep only pending keys that still exist and are still PENDING.
    const live = [];
    for (const key of pending) {
      const photo = await db.getPhoto(key);
      if (photo && photo.status === db.STATUS.PENDING) live.push(key);
    }
    this.groupingState = grouping.restoreState({
      pending: live,
      lastSequence,
      seen: keys,
      thresholds: settings.thresholds(s),
    });
    log.info(
      `Restored session: ${keys.length} photo(s) known, ${live.length} pending, last frame ${lastSequence ?? '—'}`,
    );
    fire('grouping:changed', this.snapshot());
  }

  async persistGroupingState() {
    await db.setMeta('lastSequence', this.groupingState.lastSequence);
    await db.setMeta('pendingGroup', this.groupingState.pending);
  }

  async start() {
    if (this.running) return;
    const s = settings.load();
    const base = s.cameraUrl?.trim();
    if (!base) {
      log.error('Cannot start: camera URL is not set (Settings)');
      return;
    }

    this.running = true;
    this.abort = new AbortController();
    this.client = new CcapiClient(base);
    this.groupingState.thresholds = { ...this.groupingState.thresholds, ...settings.thresholds(s) };
    this.setConnection(CONNECTION.CONNECTING);
    log.info(`Starting ingest against ${this.client.baseUrl}`);

    await this.acquireWakeLock();

    try {
      const endpoints = await this.client.discover(this.abort.signal);
      log.success(
        'CCAPI discovered',
        Object.entries(endpoints)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v.version} ${v.path}`)
          .join('\n'),
      );
      this.setConnection(CONNECTION.ONLINE);
    } catch (err) {
      this.setConnection(CONNECTION.ERROR);
      this.stats.lastError = err.message;
      log.error('CCAPI discovery failed — check the camera URL, Wi-Fi, and CORS (§3.6/§5.1)', err.message);
      // Keep the loop running: the camera may simply be asleep.
    }

    fire('run:changed', { running: true });
    void this.loop();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    clearTimeout(this.cycleTimer);
    this.cycleTimer = null;
    this.cancelPrefetch();
    await this.releaseWakeLock();
    this.setConnection(CONNECTION.OFFLINE);
    log.info('Ingest stopped');
    fire('run:changed', { running: false });
  }

  setConnection(state) {
    if (this.connection === state) return;
    this.connection = state;
    fire('connection:changed', { connection: state });
  }

  // ---- wake lock (§5.2) -------------------------------------------------
  // A web app cannot poll while backgrounded. Keeping the display on is the
  // only mitigation available, and it needs a secure context — which the
  // recommended LAN-over-HTTP deployment is not. Failure is expected there.

  async acquireWakeLock() {
    if (!settings.load().keepScreenAwake) return;
    try {
      if (!('wakeLock' in navigator)) throw new Error('Wake Lock API unavailable');
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
      });
      log.info('Screen wake lock acquired');
    } catch (err) {
      this.wakeLock = null;
      log.warn(
        'Could not keep the screen awake — set the device screen timeout to Never for the shoot',
        err.message,
      );
    }
  }

  async releaseWakeLock() {
    try {
      await this.wakeLock?.release();
    } catch { /* already gone */ }
    this.wakeLock = null;
  }

  /** Re-acquire after the tab returns to the foreground. */
  async onVisible() {
    if (this.running && !this.wakeLock) await this.acquireWakeLock();
  }

  // ---- the loop ---------------------------------------------------------

  async loop() {
    while (this.running) {
      const started = Date.now();
      try {
        await this.cycle();
      } catch (err) {
        this.stats.lastError = err.message;
        this.setConnection(CONNECTION.ERROR);
        log.error('Ingest cycle failed', settings.load().verboseErrors ? err : err.message);
      }
      this.stats.lastCycleMs = Date.now() - started;
      fire('stats:changed', this.snapshot());

      const interval = settings.load().pollIntervalMs;
      const wait = Math.max(0, interval - (Date.now() - started));
      await new Promise((resolve) => {
        this.cycleTimer = setTimeout(resolve, wait);
      });
    }
  }

  async cycle() {
    if (!this.client) return;

    // 1. Poll.
    const poll = await this.client.poll(this.abort.signal);
    this.stats.polls++;
    if (poll.transient) {
      // Camera is busy writing a burst — an empty poll, not a failure (§3.3).
      this.stats.transientPolls++;
      log.debug('Camera busy (transient poll status)', poll.error?.message);
    } else if (this.connection !== CONNECTION.ONLINE) {
      this.setConnection(CONNECTION.ONLINE);
    }

    // 2. Enqueue reported photos.
    for (const path of poll.addedContents) {
      await this.enqueuePath(path, 'poll');
    }

    // 4. Drain in sequence order.
    await this.drain();
  }

  /**
   * Add a content path to the queue if it is not already known.
   * @returns {Promise<boolean>} true if newly enqueued
   */
  async enqueuePath(contentPath, source = 'manual') {
    const key = tryDcfKey(contentPath);
    if (!key) {
      log.warn(`Ignoring unparseable content path: ${contentPath}`);
      return false;
    }
    if (this.queue.has(key)) return false;
    if (this.groupingState.seen.has(key) || (await db.hasPhoto(key))) {
      log.debug(`Skipping ${key} — already handled (${source})`);
      return false;
    }
    this.queue.set(key, {
      dcfKey: key,
      sourcePath: contentPath,
      sequence: sequenceNumber(key),
      attempts: 0,
      lastError: null,
    });
    log.info(`Queued ${key} (${source})`);
    fire('queue:changed', { depth: this.queue.size });
    return true;
  }

  /** Queue items ordered by IMG sequence; unparseable names go last. */
  orderedQueue() {
    return [...this.queue.values()].sort(
      (a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER),
    );
  }

  async drain() {
    while (this.running && this.queue.size > 0) {
      const ordered = this.orderedQueue();
      const item = ordered[0];

      try {
        // 6. Order matters: the camera serves exactly one content request at a
        // time and answers a second with 503 "Device busy" — verified on
        // hardware (two concurrent GETs: one 200, one 503 in 0.2s). Starting
        // the prefetch before this download made them race, and the prefetch
        // won, so the head of the queue 503'd on every cycle and the ingest
        // never advanced past its first photo.
        const original = await this.takeBytes(item);

        // The link is free again, so the next download can now overlap the
        // decode/barcode/encode work below rather than this photo's transfer.
        // That is the whole point of the prefetch (§6.1 step 6).
        this.startPrefetch(ordered[1]);

        await this.processItem(item, original);
        this.queue.delete(item.dcfKey);
        fire('queue:changed', { depth: this.queue.size });
      } catch (err) {
        const dropped = this.handleItemFailure(item, err);
        if (dropped) continue;
        // 4. Stop draining. Retrying the lowest-sequence item next cycle is
        // what prevents a later SKU photo from flushing an incomplete group.
        return;
      }
    }
  }

  /** @returns {boolean} true if the item was dropped and draining may continue */
  handleItemFailure(item, err) {
    const s = settings.load();
    item.attempts++;
    item.lastError = err.message;

    const status = err instanceof CcapiError ? err.status : 0;
    if (status === 404) {
      // 5. The frame is gone from the card (deleted, or a phantom gap entry).
      this.queue.delete(item.dcfKey);
      log.warn(`Dropped ${item.dcfKey} — 404 on the camera`);
      fire('queue:changed', { depth: this.queue.size });
      return true;
    }
    if (item.attempts >= s.maxQueueAttempts) {
      this.queue.delete(item.dcfKey);
      log.error(`Giving up on ${item.dcfKey} after ${item.attempts} attempts`, err.message);
      fire('queue:changed', { depth: this.queue.size });
      return true;
    }

    // Always carry the reason: a wall of bare "Retrying" lines says nothing
    // about whether the camera is busy, asleep, or refusing the origin, and
    // that is exactly when the log is being read.
    log.warn(`Retrying ${item.dcfKey} next cycle (attempt ${item.attempts})`, err.message);
    return false;
  }

  /** Abort any in-flight prefetch. Nothing may hold the link but the caller. */
  cancelPrefetch() {
    this.prefetch?.controller.abort();
    this.prefetch = null;
  }

  startPrefetch(next) {
    if (!next) {
      this.cancelPrefetch();
      return;
    }
    if (this.prefetch?.dcfKey === next.dcfKey) return;
    this.cancelPrefetch();

    // Its own controller, so a stale prefetch can be cancelled without tearing
    // down the session; `stop()` still reaches it through the session signal.
    const controller = new AbortController();
    const onStop = () => controller.abort();
    this.abort.signal.addEventListener('abort', onStop, { once: true });

    this.prefetch = {
      dcfKey: next.dcfKey,
      controller,
      // Swallow rejection here; the real attempt re-downloads and reports.
      promise: this.client
        .download(next.sourcePath, 'main', { signal: controller.signal })
        .catch(() => null)
        .finally(() => this.abort.signal.removeEventListener('abort', onStop)),
    };
  }

  async takeBytes(item) {
    if (this.prefetch?.dcfKey === item.dcfKey) {
      const prefetched = this.prefetch;
      this.prefetch = null;
      const blob = await prefetched.promise;
      if (blob) return blob;
    } else {
      // The queue reordered under a prefetch (a gap fill, or a retry that
      // changed the head). Left running it would still be streaming when the
      // download below starts, and one of the two would 503.
      this.cancelPrefetch();
    }
    return this.client.download(item.sourcePath, 'main', { signal: this.abort.signal });
  }

  /** Watermark + read SKU -> persist -> feed the reducer. Bytes come from
   * `takeBytes`, which the caller runs first so no two camera requests overlap. */
  async processItem(item, original) {
    const s = settings.load();
    const t0 = performance.now();

    const result = await imaging.processPhoto({
      blob: original,
      dcfKey: item.dcfKey,
      options: {
        padding: s.watermarkPadding,
        jpegQuality: s.jpegQuality / 100,
        ocr: await ocr.available(),
      },
    });

    // The barcode didn't decode but the photo looks like a label: read the
    // printed number. Before the reducer sees this photo, so ordering holds.
    let sku = result.sku;
    if (!sku && result.ocrCrops?.length) {
      const startedOcr = performance.now();
      const read = await ocr.identify(result.ocrCrops);
      const ms = Math.round(performance.now() - startedOcr);
      if (read?.confirmed) {
        sku = read.sku;
        log.success(
          `${item.dcfKey}: barcode unreadable — read SKU ${sku} from the printed number`,
          `${read.what ?? 'in Inventory'} · OCR ${ms}ms`,
        );
      } else if (read) {
        log.warn(
          `${item.dcfKey}: printed number reads as ${read.candidates.join(' or ')}, which Inventory doesn't know — asking`,
          `OCR ${ms}ms`,
        );
        fire('ocr:unconfirmed', { dcfKey: item.dcfKey, candidates: read.candidates });
      } else {
        log.debug(`${item.dcfKey}: looked like a label (${result.ocrSymbols} symbols) but no number was read`, `OCR ${ms}ms`);
      }
    }

    const opfsPath = await blobstore.put(item.dcfKey, result.jpeg);

    await db.putPhoto(
      db.makePhoto({
        dcfKey: item.dcfKey,
        sourcePath: item.sourcePath,
        fileName: fileNameOf(item.dcfKey),
        sequenceNumber: item.sequence,
        sku: null, // set by the FLUSH effect, which covers the whole group
        status: db.STATUS.PENDING,
        opfsPath,
        bytes: result.jpeg.size,
        width: result.width,
        height: result.height,
        quality: result.quality ?? null,
        isLabel: Boolean(sku),
      }),
    );

    this.stats.processed++;
    this.stats.lastPhotoAt = Date.now();
    this.stats.lastPhotoKey = item.dcfKey;

    log.success(
      `Processed ${item.dcfKey}${result.sku ? ` — SKU ${result.sku}` : ''}`,
      `${result.width}x${result.height}${result.rotated ? ' (rotated to landscape)' : ''}, ` +
        `${Math.round(result.jpeg.size / 1024)} KB, ` +
        `decode ${result.timings.decodeMs}ms / barcode ${result.timings.barcodeMs}ms / ` +
        `render ${result.timings.renderMs}ms / encode ${result.timings.encodeMs}ms ` +
        `(total ${Math.round(performance.now() - t0)}ms)`,
    );

    await this.applyEvent({
      type: 'PHOTO',
      dcfKey: item.dcfKey,
      sequence: item.sequence,
      sku,
    }, item.sourcePath);

    fire('photos:changed', { reason: 'ingest', dcfKey: item.dcfKey });
  }

  /** Run the pure reducer and carry out its effects. */
  async applyEvent(event, sourcePath) {
    const { state, effects } = grouping.reduce(this.groupingState, event);
    this.groupingState = state;

    for (const effect of effects) {
      switch (effect.type) {
        case 'DUPLICATE':
          log.debug(`Duplicate ignored: ${effect.dcfKey}`);
          break;

        case 'GAP': {
          log.warn(
            `Sequence gap: ${effect.missing.length} frame(s) missing (${effect.from}–${effect.to}) in ${effect.folder}`,
          );
          for (const key of effect.missing) {
            await this.enqueuePath(siblingPath(sourcePath, fileNameOf(key)), 'gap');
          }
          break;
        }

        case 'SESSION_RESET':
          log.info(
            `Frame number jumped by ${effect.missing} — treating as a new shooting session, not a gap (§2.3)`,
          );
          break;

        case 'STALE_WARNING':
          log.warn(`${effect.count} photos pending with no SKU — check the label shot`);
          this.notify('Pending group is getting long', `${effect.count} photos with no SKU yet`);
          break;

        case 'FLUSH': {
          log.success(`SKU ${effect.sku}: grouping ${effect.keys.length} photo(s)`);
          // The donor car picked right now, not at upload time: a queued upload must not pick
          // up a car chosen for a later part.
          const carId = settings.load().donorCarId || null;
          for (const key of effect.keys) {
            await db.updatePhoto(key, { sku: effect.sku, status: db.STATUS.GROUPED, carId });
          }
          this.stats.lastSku = effect.sku;
          this.stats.lastSkuAt = Date.now();
          if (settings.load().autoUpload) uploader.enqueueSku(effect.sku);
          this.notify(`SKU ${effect.sku}`, `${effect.keys.length} photos grouped`);
          break;
        }

        case 'EVACUATE': {
          log.error(
            `Auto-evacuated ${effect.keys.length} photo(s) to review — no SKU seen before the threshold`,
          );
          for (const key of effect.keys) await db.updatePhoto(key, { status: db.STATUS.REVIEW });
          this.notify('Group evacuated to review', `${effect.keys.length} photos had no SKU`);
          break;
        }

        case 'ACCEPTED':
        default:
          break;
      }
    }

    await this.persistGroupingState();
    fire('grouping:changed', this.snapshot());
  }

  notify(title, body) {
    if (!settings.load().notifications) return;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        // Foreground only (§5.3) — good enough while the tab is the shoot UI.
        new Notification(title, { body, tag: 'dnr-watermark' });
      }
    } catch { /* notifications are best effort */ }
  }

  // ---- manual paths -----------------------------------------------------

  /**
   * Re-sync from the camera's contents listing (§5.2 recovery, and the Camera
   * browser's "download into pipeline").
   * @param {string[]} contentPaths
   */
  async ingestPaths(contentPaths) {
    let added = 0;
    for (const path of contentPaths) {
      if (await this.enqueuePath(path, 'manual')) added++;
    }
    if (added > 0 && !this.running) await this.drainOnce();
    return added;
  }

  /** Drain the queue once without the poll loop — used when stopped. */
  async drainOnce() {
    if (!this.client) {
      const s = settings.load();
      if (!s.cameraUrl) throw new Error('Camera URL is not set');
      this.client = new CcapiClient(s.cameraUrl);
      this.abort = this.abort ?? new AbortController();
      await this.client.ensureDiscovered(this.abort.signal);
    }
    const wasRunning = this.running;
    this.running = true;
    try {
      await this.drain();
    } finally {
      this.running = wasRunning;
    }
  }

  /**
   * Re-sync the newest N frames from the card, skipping anything already
   * handled. Called after a reload to recover cleanly (§5.2).
   */
  async resync(limit = 60) {
    if (!this.client) {
      this.client = new CcapiClient(settings.load().cameraUrl);
      this.abort = this.abort ?? new AbortController();
    }
    await this.client.ensureDiscovered(this.abort.signal);
    const cards = await this.client.listCards(this.abort.signal);
    if (cards.length === 0) return 0;
    const folders = await this.client.listFolders(cards[0], this.abort.signal);
    if (folders.length === 0) return 0;

    const newest = folders[folders.length - 1];
    let added = 0;
    for await (const path of this.client.iterateFolderNewestFirst(newest, {
      limit,
      signal: this.abort.signal,
    })) {
      if (await this.enqueuePath(path, 'resync')) added++;
    }
    log.info(`Re-sync from ${newest}: ${added} new frame(s) queued`);
    return added;
  }

  /**
   * Manually assign a SKU to a set of photos (Gallery recovery path, §7).
   * Removes them from the pending group so automatic grouping stays coherent.
   */
  async manualGroup(dcfKeys, sku) {
    for (const key of dcfKeys) {
      await db.updatePhoto(key, { sku, status: db.STATUS.GROUPED, error: null, carId: settings.load().donorCarId || null });
    }
    const set = new Set(dcfKeys);
    this.groupingState = {
      ...this.groupingState,
      pending: this.groupingState.pending.filter((k) => !set.has(k)),
      staleWarned: false,
      seen: new Set([...this.groupingState.seen, ...dcfKeys]),
    };
    await this.persistGroupingState();
    this.stats.lastSku = sku;
    this.stats.lastSkuAt = Date.now();
    log.success(`Manually grouped ${dcfKeys.length} photo(s) as SKU ${sku}`);
    fire('grouping:changed', this.snapshot());
    fire('photos:changed', { reason: 'manual-group', sku });
    return sku;
  }

  /**
   * File the pending photos up to and including `dcfKey` under `sku` — the
   * operator confirming a label the OCR fallback read but Inventory didn't
   * know. Photos taken after the label (the next part) stay pending.
   * @returns {number} photos filed, 0 if the label photo is no longer pending
   */
  async fileThrough(dcfKey, sku) {
    const pending = this.groupingState.pending;
    const end = pending.indexOf(dcfKey);
    if (end < 0) return 0;
    const keys = pending.slice(0, end + 1);
    await this.manualGroup(keys, sku);
    if (settings.load().autoUpload) uploader.enqueueSku(sku);
    return keys.length;
  }

  /** Clear the pending group without uploading (operator escape hatch). */
  async clearPending() {
    const keys = this.groupingState.pending;
    for (const key of keys) await db.updatePhoto(key, { status: db.STATUS.REVIEW });
    this.groupingState = { ...this.groupingState, pending: [], staleWarned: false };
    await this.persistGroupingState();
    log.warn(`Moved ${keys.length} pending photo(s) to review`);
    fire('grouping:changed', this.snapshot());
    fire('photos:changed', { reason: 'clear-pending' });
    return keys.length;
  }

  snapshot() {
    return {
      running: this.running,
      connection: this.connection,
      pending: this.groupingState.pending.length,
      pendingKeys: this.groupingState.pending,
      lastSequence: this.groupingState.lastSequence,
      queueDepth: this.queue.size,
      queue: this.orderedQueue().map((i) => ({
        dcfKey: i.dcfKey,
        attempts: i.attempts,
        lastError: i.lastError,
      })),
      thresholds: this.groupingState.thresholds,
      ...this.stats,
    };
  }
}

export const orchestrator = new Orchestrator();
export { dcfKey };
