/**
 * App bootstrap: tabs, module init, and the lifecycle hooks that matter for a
 * foreground-only pipeline (§5.2).
 */

import { $, $$, on, toast } from './ui/dom.js';
import { initStatus, reportBackgrounded } from './ui/status.js';
import { initDonor } from './ui/donor.js';
import { initGallery, onGalleryShown, setFilter as setGalleryFilter, render as renderGallery } from './ui/gallery.js';
import { initCameraBrowser, onCameraShown } from './ui/camera.js';
import { initSettings, onSettingsShown } from './ui/settings-ui.js';
import { orchestrator } from './app/orchestrator.js';
import * as imaging from './app/imaging-client.js';
import { loadWatermark } from './app/watermark-asset.js';
import * as blobstore from './core/blobstore.js';
import { log } from './core/log.js';
import * as settings from './core/settings.js';

/**
 * Settings live in this browser, per origin, so a new device (or a new URL)
 * starts blank. serve.py already knows the camera and whether it proxies
 * uploads — adopt those for any blank field. The token is never on the server.
 */
async function adoptServerDefaults() {
  const s = settings.load();
  if (s.cameraUrl && s.backendUrl) return;
  let config;
  try {
    const res = await fetch('/backend/config', { cache: 'no-store' });
    if (!res.ok) return;
    config = await res.json();
  } catch {
    return; // not served by serve.py
  }
  const patch = {};
  if (!s.cameraUrl && config?.camera) patch.cameraUrl = config.camera;
  if (!s.backendUrl && config?.proxy) patch.backendUrl = '/backend';
  if (Object.keys(patch).length === 0) return;
  settings.save(patch);
  log.info(`Filled in from the server: ${Object.keys(patch).join(', ')}`);
}

const SHOWN = {
  gallery: onGalleryShown,
  camera: onCameraShown,
  settings: onSettingsShown,
};

/**
 * Switch tabs. `focus` scrolls to and focuses a control (setup checklist
 * buttons land on the field to fill in); `filter` presets the Photos filter.
 */
function navigate(name, { focus, filter } = {}) {
  const tab = $(`.tab[data-tab="${name}"]`);
  if (!tab) return;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
  history.replaceState(null, '', `#${name}`);
  if (filter && name === 'gallery') setGalleryFilter(filter);
  void SHOWN[name]?.();

  const target = focus ? $(focus) : null;
  if (target) {
    const details = target.closest('details');
    if (details) details.open = true;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus({ preventScroll: true });
  } else {
    window.scrollTo({ top: 0 });
  }
}

function initTabs() {
  for (const tab of $$('.tab')) on(tab, 'click', () => navigate(tab.dataset.tab));
  // `#status` was the Shoot tab's old name; keep old bookmarks working.
  const initial = location.hash.slice(1).replace(/^status$/, 'shoot');
  if (initial && initial !== 'shoot') navigate(initial);
}

function initDialogs() {
  on($('#open-help'), 'click', () => $('#help-dialog').showModal());
  for (const btn of $$('[data-close-dialog]')) on(btn, 'click', () => btn.closest('dialog')?.close());
  // Tap outside a dialog's box closes it.
  for (const dialog of $$('dialog')) {
    on(dialog, 'click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
}

async function boot() {
  log.info('DNR Camera Companion starting');

  await adoptServerDefaults();
  initTabs();
  initDialogs();
  initStatus({ navigate });
  initDonor();
  initGallery();
  initCameraBrowser();
  initSettings();

  // Ask the browser not to evict our photos under pressure. Best effort:
  // it needs a secure context in some browsers, and the recommended LAN
  // deployment is not one.
  const persisted = await blobstore.requestPersistence();
  const store = await blobstore.describeBackend();
  log.info(
    `Image bytes: ${store.label}${persisted ? ' (persistent)' : ''}${store.note ? ` — ${store.note}` : ''}`,
  );

  try {
    const watermark = await loadWatermark();
    const info = await imaging.setWatermark(watermark);
    if (info) log.info(`Watermark loaded: ${info.width}x${info.height}`);
  } catch (err) {
    log.error('Failed to hand the watermark to the imaging worker', err);
  }

  await orchestrator.restore();
  await renderGallery();

  // ---- lifecycle ---------------------------------------------------------

  // Re-acquire the wake lock when the tab comes back, and tell the operator
  // plainly that nothing happened while it was away (§5.2).
  let hiddenAt = null;
  on(document, 'visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      if (orchestrator.running) {
        log.warn('Tab backgrounded — the poll loop is throttled or stopped until it is visible again');
      }
    } else {
      void orchestrator.onVisible();
      if (hiddenAt && orchestrator.running) {
        const seconds = Math.round((Date.now() - hiddenAt) / 1000);
        if (seconds > 5) {
          log.warn(`Tab was backgrounded for ${seconds}s — photos taken meanwhile may be missing`);
          reportBackgrounded(seconds);
        }
      }
      hiddenAt = null;
    }
  });

  on(window, 'beforeunload', (event) => {
    if (orchestrator.running) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  on(window, 'error', (event) => log.error('Uncaught error', event.error ?? event.message));
  on(window, 'unhandledrejection', (event) => log.error('Unhandled promise rejection', event.reason));

  log.success('Ready');
}

boot().catch((err) => {
  log.error('Startup failed', err);
  toast(`Startup failed: ${err.message}`, 'error', 12000);
});
