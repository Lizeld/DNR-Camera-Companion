/**
 * App bootstrap: tabs, module init, and the lifecycle hooks that matter for a
 * foreground-only pipeline (§5.2).
 */

import { $, $$, on, toast } from './ui/dom.js';
import { initStatus } from './ui/status.js';
import { initGallery, onGalleryShown, render as renderGallery } from './ui/gallery.js';
import { initCameraBrowser, onCameraShown } from './ui/camera.js';
import { initSettings, onSettingsShown } from './ui/settings-ui.js';
import { orchestrator } from './app/orchestrator.js';
import * as imaging from './app/imaging-client.js';
import { loadWatermark } from './app/watermark-asset.js';
import * as blobstore from './core/blobstore.js';
import * as settings from './core/settings.js';
import { log } from './core/log.js';

const SHOWN = {
  gallery: onGalleryShown,
  camera: onCameraShown,
  settings: onSettingsShown,
};

function initTabs() {
  for (const tab of $$('.tab')) {
    on(tab, 'click', () => {
      const name = tab.dataset.tab;
      $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
      location.hash = name;
      void SHOWN[name]?.();
    });
  }
  const initial = location.hash.slice(1);
  if (initial && $(`.tab[data-tab="${initial}"]`)) $(`.tab[data-tab="${initial}"]`).click();
}

async function boot() {
  log.info('DNR Watermark starting');

  initTabs();
  initStatus();
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

  if (!settings.load().cameraUrl) {
    toast('Set the camera URL in Settings to begin', 'info', 8000);
  }

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
          log.warn(`Tab was backgrounded for ${seconds}s — run "Re-sync newest 60" if frames are missing`);
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
