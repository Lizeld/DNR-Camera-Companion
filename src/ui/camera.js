/**
 * Camera browser — spec §7.
 *
 * Browse the card newest first (§3.4), thumbnail grid, multi-select, download
 * into the pipeline.
 *
 * Paging is backwards on purpose: folders paginate at ~100/page oldest first,
 * so paging forward from page 1 on a 6,000-image card shows the oldest images
 * and looks broken.
 */

import { $, on, text, show, toast, ObjectUrlPool, enableMarqueeSelect } from './dom.js';
import { CcapiClient, pagesNewestFirst, normaliseCameraUrl } from '../core/ccapi.js';
import { tryDcfKey } from '../core/dcf.js';
import * as settings from '../core/settings.js';
import * as db from '../core/db.js';
import { orchestrator } from '../app/orchestrator.js';
import { log } from '../core/log.js';

const selection = new Set();
const urls = new ObjectUrlPool();

let grid;
let client = null;
let folders = [];
let state = { folderPath: null, total: 0, pages: [], nextPageIndex: 0, items: [] };
let loading = false;

export function initCameraBrowser() {
  grid = $('#camera-grid');

  on($('#camera-refresh'), 'click', () => void refreshFolders());
  on($('#camera-more'), 'click', () => void loadNextPage());
  on($('#camera-folder'), 'change', (e) => void selectFolder(e.target.value));
  on($('#camera-clear'), 'click', () => {
    selection.clear();
    syncSelectionUi();
  });
  on($('#camera-ingest'), 'click', onIngest);

  enableMarqueeSelect(grid, '.thumb', (keys, additive) => {
    if (!additive) selection.clear();
    keys.forEach((k) => selection.add(k));
    syncSelectionUi();
  });
}

/** Called by the tab switcher. */
export async function onCameraShown() {
  if (folders.length === 0 && settings.load().cameraUrl) await refreshFolders();
}

function ensureClient() {
  const raw = settings.load().cameraUrl;
  if (!raw) throw new Error('Camera URL is not set (Settings)');
  const base = normaliseCameraUrl(raw);
  // Reuse the orchestrator's client when it points at the same camera:
  // endpoint discovery is already done there, and every extra request
  // competes with the ingest loop for the camera's ~2 MB/s radio.
  if (orchestrator.client?.baseUrl === base) client = orchestrator.client;
  else if (client?.baseUrl !== base) client = new CcapiClient(base);
  return client;
}

async function refreshFolders() {
  const btn = $('#camera-refresh');
  btn.disabled = true;
  try {
    const c = ensureClient();
    await c.ensureDiscovered();
    const cards = await c.listCards();
    if (cards.length === 0) throw new Error('Camera reported no storage');
    // Storage is named `card1`, not `sd` (§3.4).
    folders = await c.listFolders(cards[0]);
    const select = $('#camera-folder');
    select.replaceChildren(
      ...folders.map((path) => {
        const opt = document.createElement('option');
        opt.value = path;
        opt.textContent = path.split('/').pop();
        return opt;
      }),
    );
    if (folders.length === 0) throw new Error('No DCF folders on the card');
    // Newest folder last in CCAPI's ordering.
    const newest = folders[folders.length - 1];
    select.value = newest;
    await selectFolder(newest);
  } catch (err) {
    toast(`Couldn't read the camera card: ${err.message}`, 'error');
    log.error('Camera browse failed', err.message);
  } finally {
    btn.disabled = false;
  }
}

async function selectFolder(folderPath) {
  if (!folderPath) return;
  const c = ensureClient();
  urls.clear();
  selection.clear();
  const total = await c.countInFolder(folderPath);
  state = {
    folderPath,
    total,
    pages: pagesNewestFirst(total),
    nextPageIndex: 0,
    items: [],
  };
  text($('#camera-count'), `${total} item(s) in ${folderPath.split('/').pop()}`);
  grid.replaceChildren();
  await loadNextPage();
}

async function loadNextPage() {
  if (loading || !state.folderPath) return;
  if (state.nextPageIndex >= state.pages.length) {
    toast('No older photos in this folder', 'info');
    return;
  }
  loading = true;
  const btn = $('#camera-more');
  btn.disabled = true;
  try {
    const c = ensureClient();
    const page = state.pages[state.nextPageIndex++];
    const paths = await c.listFolderPage(state.folderPath, page);
    // Each page is oldest-first within itself; reverse for newest-first.
    const known = new Set((await db.allKeys()).map(String));
    const items = paths.reverse().map((path) => ({
      path,
      key: tryDcfKey(path) ?? path,
      name: path.split('/').pop(),
      known: known.has(tryDcfKey(path) ?? ''),
    }));
    state.items.push(...items);

    const frag = document.createDocumentFragment();
    for (const item of items) frag.appendChild(tile(item));
    grid.appendChild(frag);

    show($('#camera-empty'), state.items.length === 0);
    text(
      $('#camera-count'),
      `${state.items.length} of ${state.total} shown · page ${page} of ${state.pages.length}`,
    );
    void loadThumbnails(items);
  } catch (err) {
    toast(`Couldn't load more photos: ${err.message}`, 'error');
    log.error('Camera page load failed', err.message);
  } finally {
    loading = false;
    btn.disabled = false;
  }
}

function tile(item) {
  const el = document.createElement('div');
  el.className = 'thumb';
  el.dataset.key = item.path;
  el.innerHTML = `
    <div class="thumb-placeholder">…</div>
    ${item.known ? '<span class="status-dot status-UPLOADED" title="already in the pipeline"></span>' : ''}
    <div class="thumb-caption"><span>${item.name}</span></div>`;
  on(el, 'click', () => {
    if (selection.has(item.path)) selection.delete(item.path);
    else selection.add(item.path);
    syncSelectionUi();
  });
  return el;
}

/**
 * Fetch thumbnails serially. The camera link tops out around 2 MB/s and a
 * parallel burst makes it 503 (§3.1, §3.3).
 */
async function loadThumbnails(items) {
  const c = ensureClient();
  for (const item of items) {
    if (urls.get(item.path)) continue;
    const el = grid.querySelector(`.thumb[data-key="${CSS.escape(item.path)}"]`);
    if (!el) continue;
    try {
      const blob = await c.download(item.path, 'thumbnail');
      const img = document.createElement('img');
      img.alt = item.name;
      img.src = urls.set(item.path, blob);
      el.querySelector('.thumb-placeholder')?.replaceWith(img);
    } catch (err) {
      const ph = el.querySelector('.thumb-placeholder');
      if (ph) ph.textContent = '⚠';
      log.debug(`Thumbnail failed for ${item.name}`, err.message);
    }
  }
}

function syncSelectionUi() {
  text($('#camera-selection'), `${selection.size} selected`);
  for (const el of grid.querySelectorAll('.thumb')) {
    el.classList.toggle('is-selected', selection.has(el.dataset.key));
  }
  $('#camera-ingest').disabled = selection.size === 0;
}

async function onIngest() {
  const paths = [...selection];
  if (paths.length === 0) return;
  const btn = $('#camera-ingest');
  btn.disabled = true;
  try {
    const added = await orchestrator.ingestPaths(paths);
    toast(
      added === paths.length
        ? `Adding ${added} photo(s) — they join the current part`
        : `Adding ${added} photo(s); ${paths.length - added} were already on this device`,
      'ok',
    );
    selection.clear();
    syncSelectionUi();
  } catch (err) {
    toast(`Couldn't add the photos: ${err.message}`, 'error');
    log.error('Manual ingest failed', err.message);
  } finally {
    btn.disabled = selection.size === 0;
  }
}
