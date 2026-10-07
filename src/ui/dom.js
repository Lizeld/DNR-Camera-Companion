/** Small DOM helpers shared by the UI modules. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function on(el, event, handler, opts) {
  el?.addEventListener(event, handler, opts);
  return () => el?.removeEventListener(event, handler, opts);
}

export function text(el, value) {
  if (el && el.textContent !== String(value)) el.textContent = String(value);
}

export function show(el, visible) {
  if (el) el.hidden = !visible;
}

export function toast(message, kind = 'info', ms = 4200) {
  const host = $('#toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Render a `.result` block, colour-coded. */
export function result(el, content, ok = null) {
  if (!el) return;
  el.hidden = false;
  el.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  el.classList.toggle('is-ok', ok === true);
  el.classList.toggle('is-err', ok === false);
}

/**
 * Prompt for a 7-digit SKU using the dialog in index.html.
 * @returns {Promise<string|null>}
 */
export function askSku(count) {
  const dialog = $('#sku-dialog');
  const input = $('#sku-input');
  const error = $('#sku-error');
  const countEl = $('#sku-dialog-count');
  if (!dialog) return Promise.resolve(null);

  countEl.textContent = `${count} photo${count === 1 ? '' : 's'} will be filed under this SKU.`;
  input.value = '';
  error.dataset.hint ??= error.textContent;
  error.textContent = error.dataset.hint;
  error.classList.remove('is-error');

  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      const value = input.value.trim();
      if (dialog.returnValue === 'ok' && /^\d{7}$/.test(value)) resolve(value);
      else resolve(null);
    };
    dialog.addEventListener('close', onClose);
    // `close` fires after the form submits, so validation has to happen here.
    dialog.querySelector('form').onsubmit = (event) => {
      if (event.submitter?.value === 'ok' && !/^\d{7}$/.test(input.value.trim())) {
        event.preventDefault();
        error.textContent = 'A SKU is exactly 7 digits.';
        error.classList.add('is-error');
      }
    };
    dialog.showModal();
    input.focus();
  });
}

/** Object URLs must be revoked or a long shoot leaks hundreds of megabytes. */
export class ObjectUrlPool {
  constructor() {
    this.urls = new Map();
  }

  set(key, blob) {
    this.revoke(key);
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    return url;
  }

  get(key) {
    return this.urls.get(key) ?? null;
  }

  revoke(key) {
    const url = this.urls.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      this.urls.delete(key);
    }
  }

  /** Revoke everything not in `keep`. */
  prune(keep) {
    for (const key of [...this.urls.keys()]) {
      if (!keep.has(key)) this.revoke(key);
    }
  }

  clear() {
    for (const key of [...this.urls.keys()]) this.revoke(key);
  }
}

/**
 * Rubber-band (drag-to-select) over a grid.
 *
 * Starts only on empty grid space so a tap on a tile still means "toggle".
 *
 * @param {HTMLElement} container the grid
 * @param {string} itemSelector   selector for selectable children
 * @param {(keys:string[], additive:boolean)=>void} onSelect
 */
export function enableMarqueeSelect(container, itemSelector, onSelect) {
  let marquee = null;
  let origin = null;
  let additive = false;

  const pointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest(itemSelector)) return; // tile handles its own tap
    origin = { x: event.clientX, y: event.clientY };
    additive = event.shiftKey || event.ctrlKey || event.metaKey;
    container.setPointerCapture?.(event.pointerId);
  };

  const pointerMove = (event) => {
    if (!origin) return;
    const dx = Math.abs(event.clientX - origin.x);
    const dy = Math.abs(event.clientY - origin.y);
    if (!marquee && dx + dy < 8) return; // ignore jitter; this is a tap

    if (!marquee) {
      marquee = document.createElement('div');
      marquee.className = 'marquee';
      container.appendChild(marquee);
    }
    const rect = container.getBoundingClientRect();
    const x1 = Math.min(origin.x, event.clientX);
    const y1 = Math.min(origin.y, event.clientY);
    const x2 = Math.max(origin.x, event.clientX);
    const y2 = Math.max(origin.y, event.clientY);
    marquee.style.left = `${x1 - rect.left}px`;
    marquee.style.top = `${y1 - rect.top}px`;
    marquee.style.width = `${x2 - x1}px`;
    marquee.style.height = `${y2 - y1}px`;
    event.preventDefault();
  };

  const pointerUp = (event) => {
    if (!origin) return;
    const box = marquee?.getBoundingClientRect();
    marquee?.remove();
    marquee = null;
    origin = null;
    container.releasePointerCapture?.(event.pointerId);
    if (!box) return;

    const hits = [];
    for (const el of container.querySelectorAll(itemSelector)) {
      const r = el.getBoundingClientRect();
      const overlaps = !(r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom);
      if (overlaps && el.dataset.key) hits.push(el.dataset.key);
    }
    if (hits.length > 0) onSelect(hits, additive);
  };

  on(container, 'pointerdown', pointerDown);
  on(container, 'pointermove', pointerMove);
  on(container, 'pointerup', pointerUp);
  on(container, 'pointercancel', pointerUp);
}
