/**
 * Gallery — spec §7.
 *
 * Thumbnail grid of photos held locally, status dot per photo, tap to expand,
 * drag-to-select with manual Group (enter SKU) and Upload actions, and per-SKU
 * retry. These manual paths are the recovery mechanism when automatic grouping
 * goes wrong.
 */

import { $, $$, on, text, show, toast, askSku, ObjectUrlPool, enableMarqueeSelect } from './dom.js';
import * as db from '../core/db.js';
import * as blobstore from '../core/blobstore.js';
import * as uploader from '../app/uploader.js';
import { orchestrator } from '../app/orchestrator.js';
import { on as onBus, log, relativeTime, formatBytes } from '../core/log.js';

const selection = new Set();
const urls = new ObjectUrlPool();
let filter = 'ALL';
let photos = [];
let grid;
let dirty = true;

export function initGallery() {
  grid = $('#gallery-grid');

  for (const chip of $$('#gallery-filters .chip')) {
    on(chip, 'click', () => {
      $$('#gallery-filters .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      filter = chip.dataset.filter;
      void render();
    });
  }

  on($('#gallery-select-all'), 'click', () => {
    visible().forEach((p) => selection.add(p.dcfKey));
    syncSelectionUi();
  });
  on($('#gallery-clear-selection'), 'click', () => {
    selection.clear();
    syncSelectionUi();
  });

  on($('#gallery-group'), 'click', onGroup);
  on($('#gallery-upload'), 'click', onUpload);
  on($('#gallery-delete'), 'click', onDelete);

  enableMarqueeSelect(grid, '.thumb', (keys, additive) => {
    if (!additive) selection.clear();
    keys.forEach((k) => selection.add(k));
    syncSelectionUi();
  });

  onBus('photos:changed', () => {
    dirty = true;
    if (isVisible()) void render();
  });

  on($('#photo-dialog').querySelector('[data-close-dialog]'), 'click', () => $('#photo-dialog').close());
}

function isVisible() {
  return $('[data-panel="gallery"]').classList.contains('is-active');
}

/** Called by the tab switcher so a hidden gallery does no thumbnail work. */
export async function onGalleryShown() {
  if (dirty) await render();
}

function visible() {
  return filter === 'ALL' ? photos : photos.filter((p) => p.status === filter);
}

export async function render() {
  if (!grid) return;
  photos = (await db.allPhotos()).sort((a, b) => {
    const bySeq = (b.sequenceNumber ?? 0) - (a.sequenceNumber ?? 0);
    return bySeq !== 0 ? bySeq : b.createdAt - a.createdAt;
  });
  dirty = false;

  const rows = visible();
  show($('#gallery-empty'), rows.length === 0);
  $('#gallery-empty').textContent =
    photos.length === 0 ? 'No photos held locally yet.' : 'No photos match this filter.';

  // Drop selections for photos that no longer exist.
  const live = new Set(photos.map((p) => p.dcfKey));
  for (const key of [...selection]) if (!live.has(key)) selection.delete(key);

  const frag = document.createDocumentFragment();
  for (const photo of rows) frag.appendChild(tile(photo));
  grid.replaceChildren(frag);

  urls.prune(new Set(rows.filter((p) => p.opfsPath).map((p) => p.dcfKey)));
  syncSelectionUi();
  void loadThumbnails(rows);
}

function tile(photo) {
  const el = document.createElement('div');
  el.className = 'thumb';
  el.dataset.key = photo.dcfKey;
  el.classList.toggle('is-selected', selection.has(photo.dcfKey));

  const cached = urls.get(photo.dcfKey);
  el.innerHTML = `
    ${cached ? `<img alt="${photo.fileName}" src="${cached}">` : '<div class="thumb-placeholder">…</div>'}
    <span class="status-dot status-${photo.status}" title="${photo.status}"></span>
    <div class="thumb-caption">
      <span>${photo.fileName}</span>
      <span class="sku">${photo.sku ?? ''}</span>
    </div>`;

  on(el, 'click', (event) => {
    if (event.detail === 2) return; // let dblclick open the viewer
    if (event.shiftKey || event.ctrlKey || event.metaKey || selection.size > 0) {
      if (selection.has(photo.dcfKey)) selection.delete(photo.dcfKey);
      else selection.add(photo.dcfKey);
      syncSelectionUi();
    } else {
      void openViewer(photo);
    }
  });
  on(el, 'dblclick', () => void openViewer(photo));
  return el;
}

/** Decode thumbnails lazily and one at a time — 24MP JPEGs are not cheap. */
async function loadThumbnails(rows) {
  for (const photo of rows) {
    if (!photo.opfsPath || urls.get(photo.dcfKey)) continue;
    const el = grid.querySelector(`.thumb[data-key="${CSS.escape(photo.dcfKey)}"]`);
    if (!el) continue;
    const blob = await blobstore.get(photo.opfsPath);
    if (!blob) continue;
    const url = urls.set(photo.dcfKey, blob);
    const img = document.createElement('img');
    img.alt = photo.fileName;
    img.loading = 'lazy';
    img.src = url;
    el.querySelector('.thumb-placeholder')?.replaceWith(img);
    // Yield so a long grid does not block the poll loop.
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function openViewer(photo) {
  const dialog = $('#photo-dialog');
  const img = $('#photo-dialog-img');
  text($('#photo-dialog-title'), photo.dcfKey);

  const blob = photo.opfsPath ? await blobstore.get(photo.opfsPath) : null;
  if (blob) {
    img.src = urls.get(photo.dcfKey) ?? urls.set(photo.dcfKey, blob);
    img.hidden = false;
  } else {
    img.hidden = true;
  }

  $('#photo-dialog-meta').textContent = [
    `status      ${photo.status}`,
    `sku         ${photo.sku ?? '—'}`,
    `frame       ${photo.sequenceNumber ?? '—'}`,
    `size        ${photo.width ?? '?'}x${photo.height ?? '?'}  ${formatBytes(photo.bytes ?? 0)}`,
    `source      ${photo.sourcePath}`,
    `local bytes ${photo.opfsPath ?? '(deleted after upload)'}`,
    `publicUrl   ${photo.publicUrl ?? '—'}`,
    `created     ${new Date(photo.createdAt).toLocaleString()} (${relativeTime(photo.createdAt)})`,
    photo.error ? `error       ${photo.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  dialog.showModal();
}

function syncSelectionUi() {
  text($('#gallery-selection'), `${selection.size} selected`);
  for (const el of grid.querySelectorAll('.thumb')) {
    el.classList.toggle('is-selected', selection.has(el.dataset.key));
  }
  const none = selection.size === 0;
  $('#gallery-group').disabled = none;
  $('#gallery-upload').disabled = none;
  $('#gallery-delete').disabled = none;
}

function selected() {
  return photos.filter((p) => selection.has(p.dcfKey));
}

async function onGroup() {
  const keys = selected().map((p) => p.dcfKey);
  if (keys.length === 0) return;
  const sku = await askSku(keys.length);
  if (!sku) return;
  await orchestrator.manualGroup(keys, sku);
  selection.clear();
  toast(`${keys.length} photo(s) assigned to SKU ${sku}`, 'ok');
  await render();
}

async function onUpload() {
  const rows = selected();
  const skus = [...new Set(rows.map((p) => p.sku).filter(Boolean))];
  const ungrouped = rows.filter((p) => !p.sku);

  if (ungrouped.length > 0) {
    toast(`${ungrouped.length} selected photo(s) have no SKU — group them first`, 'error');
    if (skus.length === 0) return;
  }
  for (const sku of skus) {
    // Clear any FAILED marker so the records are eligible again (per-SKU retry).
    for (const p of rows) {
      if (p.sku === sku && p.status === db.STATUS.FAILED) {
        await db.updatePhoto(p.dcfKey, { status: db.STATUS.GROUPED, error: null });
      }
    }
    uploader.enqueueSku(sku);
  }
  toast(`Queued ${skus.length} SKU(s) for upload`, 'ok');
  selection.clear();
  await render();
}

async function onDelete() {
  const rows = selected();
  if (rows.length === 0) return;
  const notUploaded = rows.filter((p) => p.status !== db.STATUS.UPLOADED).length;
  const warning = notUploaded
    ? `\n\n${notUploaded} of these have NOT been uploaded. This cannot be undone.`
    : '';
  if (!confirm(`Delete ${rows.length} photo(s) from local storage?${warning}`)) return;

  for (const p of rows) {
    await blobstore.remove(p.opfsPath);
    await db.deletePhoto(p.dcfKey);
    urls.revoke(p.dcfKey);
  }
  log.warn(`Deleted ${rows.length} photo(s) from local storage`);
  selection.clear();
  await render();
}
