/**
 * Shoot screen — spec §7 "Status", rebuilt for an operator who has never seen
 * the app.
 *
 * Stopped: the three-step workflow, a setup checklist, one big Start button.
 * Running: the part being shot right now (count, thumbnails, what to do next).
 * Always: problems as plain banners with the one action that fixes them, the
 * recent parts with their upload state, and the old diagnostics (counters,
 * activity log) folded away under "Technical details".
 */

import { $, on, text, show, toast, ObjectUrlPool } from './dom.js';
import { orchestrator, CONNECTION } from '../app/orchestrator.js';
import * as uploader from '../app/uploader.js';
import * as inventory from '../app/inventory.js';
import * as settings from '../core/settings.js';
import * as db from '../core/db.js';
import * as blobstore from '../core/blobstore.js';
import { history, onLog, clear as clearLog, formatClock, relativeTime, formatBytes, on as onBus, log } from '../core/log.js';
import { pendingSeverity } from '../core/grouping.js';

let autoScroll = true;
let logEl;
let navigate = () => {};

const CONNECTION_LABELS = {
  [CONNECTION.OFFLINE]: 'Not shooting',
  [CONNECTION.CONNECTING]: 'Connecting to camera…',
  [CONNECTION.ONLINE]: 'Camera connected',
  [CONNECTION.ERROR]: 'Camera not reachable',
};

const STRIP_MAX = 12;
const RECENT_PARTS = 12;
const stripUrls = new ObjectUrlPool();
const partUrls = new ObjectUrlPool();
const progress = new Map(); // sku -> {done,total} while uploading
let lastFlushAt = null;
let flashTimer = null;

/**
 * Non-blocking read of a cached lookup: returns the last value (or undefined)
 * at once, and refreshes in the background when older than `ttl`, re-rendering
 * the parts list when the answer lands. Inventory lookups are decoration —
 * the list must never wait on the network.
 */
const peeked = new Map(); // key -> {at, value, loading}
function peek(key, ttl, load) {
  const hit = peeked.get(key);
  if ((!hit || Date.now() - hit.at > ttl) && !hit?.loading) {
    peeked.set(key, { at: hit?.at ?? 0, value: hit?.value, loading: true });
    load()
      .catch(() => null)
      .then((value) => {
        peeked.set(key, { at: Date.now(), value, loading: false });
        scheduleParts();
      });
  }
  return hit?.value;
}

const ANALYSIS_PENDING = new Set(['queued', 'running']);

/**
 * @param {object} opts
 * @param {(tab:string, opts?:object)=>void} opts.navigate switch tabs (from main.js)
 */
export function initStatus(opts = {}) {
  navigate = opts.navigate ?? navigate;
  logEl = $('#activity-log');

  // ---- start/stop -------------------------------------------------------
  const toggleRun = async (btn) => {
    btn.disabled = true;
    try {
      if (orchestrator.running) await orchestrator.stop();
      else if (!settings.load().cameraUrl) {
        toast('Add the camera address first', 'error');
        navigate('settings', { focus: '#set-camera-url' });
      } else await orchestrator.start();
    } finally {
      btn.disabled = false;
    }
  };
  on($('#run-toggle'), 'click', () => void toggleRun($('#run-toggle')));
  on($('#start-big'), 'click', () => void toggleRun($('#start-big')));

  const resync = async (btn) => {
    btn.disabled = true;
    try {
      const added = await orchestrator.resync(60);
      toast(added ? `Found ${added} missed photo(s) — adding them now` : 'No missed photos', added ? 'ok' : 'info');
      if (added && !orchestrator.running) await orchestrator.drainOnce();
      show($('#missed-banner'), false);
    } catch (err) {
      toast(`Couldn't check the camera: ${err.message}`, 'error');
      log.error('Re-sync failed', err);
    } finally {
      btn.disabled = false;
    }
  };
  on($('#action-resync'), 'click', () => void resync($('#action-resync')));
  on($('#missed-resync'), 'click', () => void resync($('#missed-resync')));

  on($('#action-clear-pending'), 'click', async () => {
    const n = orchestrator.snapshot().pending;
    if (n === 0) return toast('No photos in the current part', 'info');
    if (!confirm(`Set ${n} photo(s) aside? They won't be uploaded until you assign them a SKU in Photos.`)) return;
    await orchestrator.clearPending();
  });

  on($('#retry-uploads'), 'click', async () => {
    const started = await uploader.retryAllFailed();
    toast(started ? `Retrying ${started} part(s)` : 'Nothing to retry', started ? 'ok' : 'info');
    void refreshBanners();
  });

  on($('#open-review'), 'click', () => navigate('gallery', { filter: db.STATUS.REVIEW }));

  // OCR read a number Inventory doesn't know: the operator decides.
  let ocrAsk = null;
  onBus('ocr:unconfirmed', (ask) => {
    ocrAsk = ask;
    text($('#ocr-what'), ask.candidates.length > 1 ? 'either of them' : 'it');
    $('#ocr-choices').replaceChildren(
      ...ask.candidates.slice(0, 3).map((sku) => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-small btn-primary mono';
        btn.textContent = `File as ${sku}`;
        on(btn, 'click', async () => {
          if (ocrAsk !== ask) return;
          ocrAsk = null;
          show($('#ocr-banner'), false);
          const filed = await orchestrator.fileThrough(ask.dcfKey, sku);
          if (filed) toast(`${filed} photo(s) filed under SKU ${sku}`, 'ok');
          else toast('Those photos were already filed or set aside — check Photos', 'error');
        });
        return btn;
      }),
    );
    show($('#ocr-banner'), true);
  });
  on($('#ocr-reject'), 'click', () => {
    ocrAsk = null;
    show($('#ocr-banner'), false);
    toast('OK — shoot the label again, closer, or assign the SKU in Photos', 'info', 6000);
  });

  on($('#action-clear-log'), 'click', () => {
    clearLog();
    logEl.replaceChildren();
  });

  on($('#autoscroll-toggle'), 'change', (e) => {
    autoScroll = e.target.checked;
  });

  const verbose = $('#verbose-toggle');
  verbose.checked = settings.load().verboseErrors;
  on(verbose, 'change', (e) => settings.save({ verboseErrors: e.target.checked }));
  settings.onChange((s) => {
    verbose.checked = s.verboseErrors;
    renderChecklist();
  });

  for (const btn of document.querySelectorAll('[data-dismiss]')) {
    on(btn, 'click', () => {
      const target = $(`#${btn.dataset.dismiss}`);
      if (target) target.hidden = true;
    });
  }

  // ---- log --------------------------------------------------------------
  for (const entry of history()) appendLog(entry);
  onLog((entry) => {
    if (!entry) return;
    if (entry.level === 'debug' && !settings.load().verboseErrors) return;
    appendLog(entry);
  });

  // ---- live wiring ------------------------------------------------------
  onBus('connection:changed', () => {
    renderConnection();
    renderLive();
    renderChecklist();
  });
  onBus('run:changed', () => {
    renderRunButton();
    renderLive();
  });
  onBus('grouping:changed', () => {
    renderCounters();
    renderLive();
    scheduleStrip();
  });
  onBus('stats:changed', renderCounters);
  onBus('queue:changed', () => {
    renderCounters();
    renderLive();
  });
  onBus('upload:queued', () => {
    renderCounters();
    scheduleParts();
  });
  onBus('upload:started', ({ sku }) => {
    progress.set(sku, { done: 0, total: 0 });
    scheduleParts();
  });
  onBus('upload:progress', ({ sku, done, total }) => {
    progress.set(sku, { done, total });
    scheduleParts();
  });
  onBus('upload:done', ({ sku }) => {
    progress.delete(sku);
    scheduleParts();
    void refreshBanners();
  });
  onBus('upload:failed', ({ sku }) => {
    if (sku) progress.delete(sku);
    scheduleParts();
    void refreshBanners();
  });
  onBus('upload:idle', () => {
    renderCounters();
    scheduleParts();
    void refreshBanners();
  });
  onBus('photos:changed', () => {
    scheduleParts();
    scheduleStrip();
    void refreshBanners();
  });

  // Relative timestamps go stale on their own.
  setInterval(() => {
    renderCounters();
    scheduleParts();
  }, 15000);
  setInterval(() => void renderStorage(), 15000);

  renderConnection();
  renderRunButton();
  renderCounters();
  renderLive();
  renderChecklist();
  scheduleParts();
  scheduleStrip();
  void renderStorage();
  void refreshBanners();
}

/** Called by main.js when the tab comes back after being hidden while running. */
export function reportBackgrounded(seconds) {
  const minutes = Math.round(seconds / 60);
  text(
    $('#missed-detail'),
    `It was away for ${minutes >= 1 ? `${minutes} min` : `${seconds} s`}, so photos taken meanwhile may not have come through.`,
  );
  show($('#missed-banner'), true);
}

// ---- log ----------------------------------------------------------------

function appendLog(entry) {
  if (!logEl) return;
  const row = document.createElement('div');
  row.className = `log-entry level-${entry.level}`;
  row.innerHTML = '<span class="log-time"></span><span class="log-msg"></span>';
  row.firstChild.textContent = formatClock(entry.at);
  row.lastChild.textContent = entry.message;
  logEl.appendChild(row);

  if (entry.detail && (settings.load().verboseErrors || entry.level === 'error')) {
    const detail = document.createElement('div');
    detail.className = 'log-detail';
    detail.textContent = entry.detail;
    logEl.appendChild(detail);
  }

  while (logEl.childElementCount > 900) logEl.firstElementChild.remove();
  if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
}

// ---- top bar --------------------------------------------------------------

function renderConnection() {
  const pill = $('#connection-pill');
  const state = orchestrator.connection;
  pill.className = `pill pill-${state}`;
  text($('#connection-label'), CONNECTION_LABELS[state] ?? state);
}

function renderRunButton() {
  const btn = $('#run-toggle');
  const running = orchestrator.running;
  text(btn, running ? 'Stop' : 'Start shooting');
  btn.classList.toggle('btn-danger', running);
  btn.classList.toggle('btn-primary', !running);
}

// ---- stopped: setup checklist -----------------------------------------------

function checklistItems() {
  const s = settings.load();
  const items = [];

  if (!s.cameraUrl) {
    items.push({ state: 'todo', label: 'Add the camera address', action: ['Set up', 'settings', '#set-camera-url'] });
  } else if (orchestrator.connection === CONNECTION.ERROR) {
    items.push({
      state: 'bad',
      label: `Camera at ${hostOf(s.cameraUrl)} isn't answering — is it on, with Wi-Fi connected?`,
      action: ['Test', 'settings', '#test-camera'],
    });
  } else {
    items.push({ state: 'ok', label: `Camera: ${hostOf(s.cameraUrl)}` });
  }

  if (!s.backendUrl || !s.backendToken) {
    items.push({
      state: 'todo',
      label: !s.backendUrl ? 'Add the Inventory site address' : 'Add the upload token',
      action: ['Set up', 'settings', !s.backendUrl ? '#set-backend-url' : '#set-backend-token'],
    });
  } else if (!s.autoUpload) {
    items.push({
      state: 'warn',
      label: 'Automatic upload is off — parts will wait in Photos until you upload them',
      action: ['Change', 'settings', '#set-autoupload'],
    });
  } else {
    items.push({ state: 'ok', label: `Uploads go to ${hostOf(s.backendUrl) || 'this server’s proxy'}` });
  }

  if (s.keepScreenAwake && !('wakeLock' in navigator)) {
    items.push({ state: 'info', label: "Set this device's screen timeout to Never — this browser can't keep the screen on by itself" });
  }
  return items;
}

function renderChecklist() {
  const list = $('#checklist');
  if (!list) return;
  const items = checklistItems();
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.className = `check-${item.state}`;
      const mark = document.createElement('span');
      mark.className = 'check-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = { ok: '✓', todo: '!', bad: '✕', warn: '!', info: 'i' }[item.state];
      const label = document.createElement('span');
      label.className = 'check-label';
      label.textContent = item.label;
      li.append(mark, label);
      if (item.action) {
        const [caption, tab, focus] = item.action;
        const btn = document.createElement('button');
        btn.className = 'btn btn-small';
        btn.textContent = caption;
        on(btn, 'click', () => navigate(tab, { focus }));
        li.append(btn);
      }
      return li;
    }),
  );

  const blocked = items.some((i) => i.state === 'todo' && i.action?.[2] === '#set-camera-url');
  const incomplete = items.some((i) => i.state === 'todo');
  text($('#ready-title'), incomplete ? 'Almost ready — finish setup' : 'Ready to shoot');
  $('#start-big').disabled = blocked;
}

function hostOf(url) {
  const value = String(url ?? '').trim();
  if (!value || value.startsWith('/')) return '';
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`).host;
  } catch {
    return value;
  }
}

// ---- running: the current part ----------------------------------------------

function renderLive() {
  const running = orchestrator.running;
  show($('#ready-card'), !running);
  show($('#live-card'), running);
  if (!running) return;

  const snap = orchestrator.snapshot();
  const { staleWarning, autoEvacuate } = snap.thresholds;
  const severity = pendingSeverity(snap.pending, snap.thresholds);

  const countEl = $('#pending-count');
  text(countEl, snap.pending);
  text($('#pending-unit'), snap.pending === 1 ? 'photo' : 'photos');
  countEl.classList.toggle('is-warning', severity === 'warning');
  countEl.classList.toggle('is-critical', severity === 'critical');

  const bar = $('#pending-bar');
  bar.style.width = `${Math.min(100, (snap.pending / autoEvacuate) * 100)}%`;
  bar.classList.toggle('is-warning', severity === 'warning');
  bar.classList.toggle('is-critical', severity === 'critical');
  $('#pending-marker').style.left = `${(staleWarning / autoEvacuate) * 100}%`;

  const instruction = $('#live-instruction');
  let message;
  let tone = '';
  if (snap.connection === CONNECTION.ERROR) {
    message = "Can't reach the camera. Check it's on and its Wi-Fi is connected — half-press the shutter to wake it.";
    tone = 'is-critical';
  } else if (snap.connection === CONNECTION.CONNECTING) {
    message = 'Connecting to the camera…';
  } else if (snap.pending === 0) {
    message = 'Take the first photo of the part.';
  } else if (severity === 'critical' || severity === 'warning') {
    const left = Math.max(0, autoEvacuate - snap.pending);
    message = `No label yet after ${snap.pending} photos. Shoot the SKU label now — ${left} more and these are set aside for review.`;
    tone = severity === 'critical' ? 'is-critical' : 'is-warning';
  } else {
    message = 'Keep going. Finish this part with a close-up of its SKU label.';
  }
  text(instruction, message);
  instruction.className = `instruction ${tone}`;

  text(
    $('#queue-hint'),
    snap.queueDepth > 0 ? `Bringing in ${snap.queueDepth} photo(s) from the camera…` : '',
  );

  // A new SKU: celebrate briefly so the operator knows the label was read.
  if (snap.lastSkuAt && snap.lastSkuAt !== lastFlushAt) {
    lastFlushAt = snap.lastSkuAt;
    if (Date.now() - snap.lastSkuAt < 10000) void announceSku(snap.lastSku, snap.lastSkuAt);
  }
}

function flash(message, tone = 'ok') {
  const el = $('#live-flash');
  text(el, `${tone === 'ok' ? '✓' : '!'} ${message}`);
  el.classList.toggle('flash-warn', tone !== 'ok');
  show(el, true);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => show(el, false), tone === 'ok' ? 6000 : 12000);
}

/** Confirm a read label, then say what it is — or that Inventory doesn't know it. */
async function announceSku(sku, at) {
  flash(`Label read: SKU ${sku}. Start the next part.`);
  const lookup = await inventory.lookupSku(sku);
  if (lastFlushAt !== at || !lookup) return; // superseded, or Inventory unreachable
  const what = inventory.describeItem(lookup);
  if (lookup.item) {
    flash(`Label read: SKU ${sku}${what ? ` — ${what}` : ''}. Start the next part.`);
  } else {
    flash(
      `SKU ${sku} isn't in Inventory yet — check the label was read correctly. If it's right, a new item is created.`,
      'warn',
    );
  }
}

let stripScheduled = false;
function scheduleStrip() {
  if (stripScheduled) return;
  stripScheduled = true;
  setTimeout(() => {
    stripScheduled = false;
    void renderStrip();
  }, 150);
}

async function renderStrip() {
  const strip = $('#pending-strip');
  if (!strip) return;
  const keys = orchestrator.snapshot().pendingKeys.slice(-STRIP_MAX);
  const keep = new Set(keys);
  stripUrls.prune(keep);

  const existing = new Map([...strip.children].map((el) => [el.dataset.key, el]));
  const tiles = [];
  for (const key of keys) {
    let el = existing.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'strip-thumb';
      el.dataset.key = key;
      const photo = await db.getPhoto(key);
      const blob = photo?.opfsPath ? await blobstore.get(photo.opfsPath) : null;
      if (blob) {
        const img = document.createElement('img');
        img.alt = photo.fileName;
        img.src = stripUrls.set(key, blob);
        el.appendChild(img);
      } else {
        el.textContent = key.split('/').pop();
      }
    }
    tiles.push(el);
  }
  strip.replaceChildren(...tiles);
  strip.hidden = tiles.length === 0;
}

// ---- recent parts -----------------------------------------------------------

let partsScheduled = false;
function scheduleParts() {
  if (partsScheduled) return;
  partsScheduled = true;
  setTimeout(() => {
    partsScheduled = false;
    void renderParts();
  }, 200);
}

/** Summarise one SKU's photos into a single upload state. */
function partState(sku, photos) {
  const uploaded = photos.filter((p) => p.status === db.STATUS.UPLOADED);
  const failed = photos.filter((p) => p.status === db.STATUS.FAILED);
  if (uploader.currentSku() === sku) {
    const p = progress.get(sku);
    return { kind: 'uploading', label: p?.total ? `Uploading ${p.done} of ${p.total}` : 'Uploading…', progress: p };
  }
  if (uploader.isQueued(sku)) return { kind: 'queued', label: 'Waiting to upload' };
  if (failed.length > 0) return { kind: 'failed', label: 'Upload failed', error: failed.find((p) => p.error)?.error };
  if (uploaded.length === photos.length) return { kind: 'done', label: 'In Inventory', draftId: uploaded[0]?.draftId };
  return { kind: 'idle', label: 'Not uploaded' };
}

async function renderParts() {
  const list = $('#parts-list');
  if (!list) return;

  const bySku = new Map();
  for (const photo of await db.allPhotos()) {
    if (!photo.sku || photo.status === db.STATUS.REVIEW) continue;
    if (!bySku.has(photo.sku)) bySku.set(photo.sku, []);
    bySku.get(photo.sku).push(photo);
  }
  const parts = [...bySku.entries()]
    .map(([sku, photos]) => ({
      sku,
      photos: photos.sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0)),
      at: Math.max(...photos.map((p) => p.createdAt ?? 0)),
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_PARTS);

  show($('#parts-empty'), parts.length === 0);
  partUrls.prune(new Set(parts.map((p) => p.sku)));

  const rows = [];
  for (const part of parts) rows.push(await partRow(part));
  list.replaceChildren(...rows);
}

async function partRow({ sku, photos, at }) {
  const state = partState(sku, photos);
  const row = document.createElement('div');
  row.className = `part part-${state.kind}`;

  // Thumbnail: local bytes while held, the public S3 copy once uploaded.
  const thumb = document.createElement('div');
  thumb.className = 'part-thumb';
  const first = photos[0];
  let src = partUrls.get(sku);
  if (!src && first?.opfsPath) {
    const blob = await blobstore.get(first.opfsPath);
    if (blob) src = partUrls.set(sku, blob);
  }
  if (!src && first?.publicUrl) src = first.publicUrl;
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = src;
    thumb.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'part-body';
  const title = document.createElement('div');
  title.className = 'part-sku';
  title.textContent = sku;
  const meta = document.createElement('div');
  meta.className = 'part-meta';
  meta.textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'} · ${relativeTime(at)}`;
  body.append(title);

  const lookup = peek(`sku:${sku}`, 5 * 60 * 1000, () => inventory.lookupSku(sku));
  if (lookup) {
    const item = document.createElement('div');
    const what = inventory.describeItem(lookup);
    item.className = lookup.item ? 'part-item' : 'part-item is-unknown';
    item.textContent = lookup.item ? what ?? 'In Inventory (no title yet)' : 'Not in Inventory yet — check the SKU';
    body.append(item);
  }
  body.append(meta);
  if (state.kind === 'failed' && state.error) {
    const err = document.createElement('div');
    err.className = 'part-error';
    err.textContent = state.error;
    err.title = state.error;
    body.append(err);
  }

  const status = document.createElement('div');
  status.className = 'part-status';
  const chip = document.createElement('span');
  chip.className = `status-chip chip-${state.kind}`;
  chip.textContent = state.kind === 'done' ? `✓ ${state.label}` : state.label;
  status.append(chip);
  if (state.kind === 'done' && state.draftId) {
    const pending = (v) => v && ANALYSIS_PENDING.has(v.analysis?.status);
    const key = `draft:${state.draftId}`;
    const ttl = pending(peeked.get(key)?.value) ? 20 * 1000 : 5 * 60 * 1000;
    const draft = peek(key, ttl, () => inventory.draftInfo(state.draftId, { fresh: true }));
    const note = draftNote(draft);
    if (note) {
      const el = document.createElement('div');
      el.className = `part-note ${note.tone ?? ''}`;
      el.textContent = note.text;
      if (note.title) el.title = note.title;
      status.append(el);
    }
  }
  if (state.kind === 'uploading' && state.progress?.total) {
    const bar = document.createElement('div');
    bar.className = 'progress progress-thin';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${(state.progress.done / state.progress.total) * 100}%`;
    bar.append(fill);
    status.append(bar);
  }

  const actions = document.createElement('div');
  actions.className = 'part-actions';
  if (state.kind === 'failed' || state.kind === 'idle') {
    const btn = document.createElement('button');
    btn.className = `btn btn-small ${state.kind === 'failed' ? 'btn-danger' : 'btn-primary'}`;
    btn.textContent = state.kind === 'failed' ? 'Retry' : 'Upload';
    on(btn, 'click', async () => {
      btn.disabled = true;
      await uploader.retrySku(sku);
      scheduleParts();
      void refreshBanners();
    });
    actions.append(btn);
  }
  if (state.kind === 'done') {
    const href = await inventory.draftUrl(state.draftId);
    if (href) {
      const link = document.createElement('a');
      link.className = 'btn btn-small';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Open in Inventory ↗';
      actions.append(link);
    }
  }

  row.append(thumb, body, status, actions);
  return row;
}

/** One line on what Inventory has done with an uploaded draft since. */
function draftNote(draft) {
  if (!draft) return null;
  if (!draft.isDraft) return { text: 'Listed', tone: 'is-ok' };
  const found = [draft.partNumber && `PN ${draft.partNumber}`, draft.price != null && `$${draft.price}`]
    .filter(Boolean)
    .join(' · ');
  switch (draft.analysis?.status) {
    case 'queued':
    case 'running':
      return { text: 'Analyzing photos…' };
    case 'done':
      return { text: found ? `Analyzed · ${found}` : 'Analyzed', tone: 'is-ok' };
    case 'failed':
      return { text: 'Analysis failed', tone: 'is-warn', title: draft.analysis.error ?? '' };
    default:
      return found ? { text: found } : null;
  }
}

// ---- counters (technical details) ---------------------------------------------

function renderCounters() {
  const snap = orchestrator.snapshot();

  text($('#last-sku'), snap.lastSku ?? '—');
  text($('#last-sku-time'), relativeTime(snap.lastSkuAt));
  text($('#last-photo'), snap.lastPhotoKey ? snap.lastPhotoKey.split('/').pop() : '—');
  text($('#last-photo-time'), relativeTime(snap.lastPhotoAt));

  text($('#queue-depth'), snap.queueDepth);
  const head = snap.queue[0];
  text(
    $('#queue-detail'),
    snap.queueDepth === 0
      ? 'nothing waiting'
      : `next ${head.dcfKey.split('/').pop()}${head.attempts ? ` · ${head.attempts} attempt(s)` : ''}`,
  );

  text($('#stat-processed'), snap.processed);
  text($('#stat-polls'), snap.polls);
  text($('#stat-transient'), snap.transientPolls);
  text($('#stat-uploads'), uploader.queueDepth());
}

async function renderStorage() {
  const { used, quota } = await blobstore.usage();
  text($('#stat-storage'), quota ? `${formatBytes(used)} / ${formatBytes(quota)}` : formatBytes(used));
}

// ---- banners --------------------------------------------------------------

/** Silent upload failures cost a production run — the failure banner is load-bearing. */
export async function refreshBanners() {
  const groups = await uploader.failedSkus();
  show($('#upload-failure-banner'), groups.length > 0);
  if (groups.length > 0) {
    const skus = groups.map((g) => g.sku ?? 'unassigned').join(', ');
    text($('#upload-failure-detail'), `${groups.length === 1 ? 'Part' : 'Parts'} ${skus}.`);
  }

  const review = (await db.photosByStatus(db.STATUS.REVIEW)).length;
  show($('#review-banner'), review > 0);
  text($('#review-title'), `${review} photo${review === 1 ? '' : 's'} need${review === 1 ? 's' : ''} a SKU.`);
}
