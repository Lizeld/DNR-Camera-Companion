/**
 * Status screen — spec §7.
 *
 * Connection indicator, pending count as a large figure that turns amber at
 * the stale threshold and red at the evacuate threshold with a progress bar,
 * last SKU / last photo with relative time, start/stop, failed-upload banner
 * with retry, timestamped activity log, verbose-error toggle.
 */

import { $, on, text, show, toast } from './dom.js';
import { orchestrator, CONNECTION } from '../app/orchestrator.js';
import * as uploader from '../app/uploader.js';
import * as settings from '../core/settings.js';
import * as blobstore from '../core/blobstore.js';
import { history, onLog, clear as clearLog, formatClock, relativeTime, formatBytes, on as onBus, log } from '../core/log.js';
import { pendingSeverity } from '../core/grouping.js';

let autoScroll = true;
let logEl;

const CONNECTION_LABELS = {
  [CONNECTION.OFFLINE]: 'Offline',
  [CONNECTION.CONNECTING]: 'Connecting…',
  [CONNECTION.ONLINE]: 'Connected',
  [CONNECTION.ERROR]: 'Camera error',
};

export function initStatus() {
  logEl = $('#activity-log');

  // ---- start/stop -------------------------------------------------------
  on($('#run-toggle'), 'click', async () => {
    const btn = $('#run-toggle');
    btn.disabled = true;
    try {
      if (orchestrator.running) await orchestrator.stop();
      else await orchestrator.start();
    } finally {
      btn.disabled = false;
    }
  });

  on($('#action-resync'), 'click', async () => {
    const btn = $('#action-resync');
    btn.disabled = true;
    try {
      const added = await orchestrator.resync(60);
      toast(added ? `${added} frame(s) queued` : 'Nothing new on the card', added ? 'ok' : 'info');
      if (added && !orchestrator.running) await orchestrator.drainOnce();
    } catch (err) {
      toast(`Re-sync failed: ${err.message}`, 'error');
      log.error('Re-sync failed', err);
    } finally {
      btn.disabled = false;
    }
  });

  on($('#action-clear-pending'), 'click', async () => {
    const n = orchestrator.snapshot().pending;
    if (n === 0) return toast('Nothing pending', 'info');
    if (!confirm(`Move ${n} pending photo(s) to the review bucket?`)) return;
    await orchestrator.clearPending();
  });

  on($('#retry-uploads'), 'click', async () => {
    const started = await uploader.retryAllFailed();
    toast(started ? `Retrying ${started} SKU(s)` : 'Nothing to retry', started ? 'ok' : 'info');
    await refreshFailureBanner();
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
  onBus('connection:changed', renderConnection);
  onBus('run:changed', renderRunButton);
  onBus('grouping:changed', renderCounters);
  onBus('stats:changed', renderCounters);
  onBus('queue:changed', renderCounters);
  onBus('upload:queued', renderCounters);
  onBus('upload:idle', () => {
    renderCounters();
    void refreshFailureBanner();
  });
  onBus('upload:failed', () => void refreshFailureBanner());
  onBus('upload:done', () => void refreshFailureBanner());
  onBus('photos:changed', () => void refreshFailureBanner());

  // Relative timestamps go stale on their own; nothing else needs a timer.
  setInterval(renderCounters, 1000);
  setInterval(() => void renderStorage(), 15000);

  renderConnection();
  renderRunButton();
  renderCounters();
  void renderStorage();
  void refreshFailureBanner();
  void renderWakeLockNote();
}

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

function renderConnection() {
  const pill = $('#connection-pill');
  const state = orchestrator.connection;
  pill.className = `pill pill-${state}`;
  text($('#connection-label'), CONNECTION_LABELS[state] ?? state);
}

function renderRunButton() {
  const btn = $('#run-toggle');
  const running = orchestrator.running;
  text(btn, running ? 'Stop' : 'Start');
  btn.classList.toggle('btn-danger', running);
  btn.classList.toggle('btn-primary', !running);
}

function renderCounters() {
  const snap = orchestrator.snapshot();
  const { staleWarning, autoEvacuate } = snap.thresholds;

  const severity = pendingSeverity(snap.pending, snap.thresholds);
  const countEl = $('#pending-count');
  text(countEl, snap.pending);
  countEl.classList.toggle('is-warning', severity === 'warning');
  countEl.classList.toggle('is-critical', severity === 'critical');

  const bar = $('#pending-bar');
  bar.style.width = `${Math.min(100, (snap.pending / autoEvacuate) * 100)}%`;
  bar.classList.toggle('is-warning', severity === 'warning');
  bar.classList.toggle('is-critical', severity === 'critical');
  $('#pending-marker').style.left = `${(staleWarning / autoEvacuate) * 100}%`;
  text($('#pending-hint'), `${snap.pending} of ${autoEvacuate} to auto-evacuate · warn at ${staleWarning}`);

  text($('#last-sku'), snap.lastSku ?? '—');
  text($('#last-sku-time'), relativeTime(snap.lastSkuAt));
  text($('#last-photo'), snap.lastPhotoKey ? snap.lastPhotoKey.split('/').pop() : '—');
  text($('#last-photo-time'), relativeTime(snap.lastPhotoAt));

  text($('#queue-depth'), snap.queueDepth);
  const head = snap.queue[0];
  text(
    $('#queue-hint'),
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

/** Silent upload failures cost a production run — this banner is load-bearing. */
export async function refreshFailureBanner() {
  const groups = await uploader.failedSkus();
  const banner = $('#upload-failure-banner');
  show(banner, groups.length > 0);
  if (groups.length === 0) return;

  const photos = groups.reduce((n, g) => n + g.photos.length, 0);
  const skus = groups.map((g) => g.sku ?? 'ungrouped').join(', ');
  text(
    $('#upload-failure-detail'),
    `${photos} photo(s) across ${groups.length} SKU(s): ${skus}. ${groups[0].lastError ?? ''}`,
  );
}

async function renderWakeLockNote() {
  const note = $('#wakelock-note');
  if (!note) return;
  if (!('wakeLock' in navigator)) {
    note.textContent =
      ' The Wake Lock API is unavailable here (it needs a secure context, which LAN-over-HTTP is not) — set the device screen timeout to Never.';
  }
}
