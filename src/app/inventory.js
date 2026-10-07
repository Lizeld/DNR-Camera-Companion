/**
 * The Inventory site, seen from the companion: where it lives, deep links into
 * it, a side-effect-free check that uploads will be accepted, and the
 * read-only lookups shown to the operator (what a SKU is, a draft's state).
 *
 * Lookups are best effort: they cache, never throw, and return null when the
 * backend is unreachable or predates the endpoint — nothing in the shooting
 * flow waits on them.
 */

import * as settings from '../core/settings.js';

let proxyUpstream = null; // cached /backend/config answer: origin string, or '' if none

/**
 * Origin of the Inventory site, e.g. "https://inventory.example.com".
 *
 * Derived from the backend URL. When that is the local proxy (`/backend`),
 * the real site is only known to serve.py, so ask it once.
 *
 * @returns {Promise<string>} '' when it cannot be determined
 */
export async function siteOrigin(s = settings.load()) {
  const api = settings.backendApiBase(s);
  if (!api) return '';
  if (!api.startsWith('/')) return api.replace(/\/api$/i, '');

  if (proxyUpstream === null) {
    const prefix = api.replace(/\/api$/i, '');
    try {
      const res = await fetch(`${prefix}/config`, { cache: 'no-store' });
      const body = await res.json();
      proxyUpstream = body?.upstream ? String(body.upstream).replace(/\/api$/i, '') : '';
    } catch {
      proxyUpstream = '';
    }
  }
  return proxyUpstream;
}

settings.onChange(() => {
  proxyUpstream = null;
  skuCache.clear();
  draftCache.clear();
});

async function getJson(path, s = settings.load()) {
  const api = settings.backendApiBase(s);
  if (!api || !s.backendToken) return { status: 0, body: null };
  try {
    const res = await fetch(`${api}${path}`, {
      headers: { Authorization: `Bearer ${s.backendToken}` },
      redirect: 'error',
      cache: 'no-store',
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

const SKU_TTL_MS = 5 * 60 * 1000;
const DRAFT_TTL_MS = 20 * 1000;
const skuCache = new Map(); // sku -> {at, value|promise}
const draftCache = new Map(); // id -> {at, value|promise}

function cached(cache, key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/**
 * What Inventory knows about a SKU.
 * @returns {Promise<null|{sku:string, item:null|{title:string|null, car:string|null, status:string}, drafts:object[]}>}
 */
export function lookupSku(sku) {
  if (!/^\d{7}$/.test(String(sku))) return Promise.resolve(null);
  return cached(skuCache, sku, SKU_TTL_MS, async () => {
    const { status, body } = await getJson(`/watermark/skus/${sku}`);
    if (status !== 200) {
      skuCache.delete(sku); // don't pin a transient failure for five minutes
      return null;
    }
    return body;
  });
}

/** Best one-line description of a SKU's item, or null. */
export function describeItem(lookup) {
  const item = lookup?.item;
  if (!item) return null;
  return [item.title, item.car].filter(Boolean).join(' · ') || null;
}

/**
 * A draft's current state, incl. OpenClaw analysis.
 * @returns {Promise<null|{id:string, title:string|null, partNumber:string|null, price:number|null,
 *   imageCount:number, isDraft:boolean, analysis:null|{status:string, error:string|null}}>}
 */
export function draftInfo(draftId, { fresh = false } = {}) {
  if (!draftId) return Promise.resolve(null);
  if (fresh) draftCache.delete(draftId);
  return cached(draftCache, draftId, DRAFT_TTL_MS, async () => {
    const { status, body } = await getJson(`/watermark/drafts/${encodeURIComponent(draftId)}`);
    return status === 200 ? body : null;
  });
}

/** Link that opens a draft in the Inventory site's listing editor. */
export async function draftUrl(draftId) {
  const origin = await siteOrigin();
  return origin && draftId ? `${origin}/listings?id=${encodeURIComponent(draftId)}` : '';
}

/**
 * Check the backend URL and token without uploading anything.
 *
 * The API authenticates before it validates, so an empty presign request
 * answers 401 for a bad token and 400 for a good one — nothing is created.
 *
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function checkUploads(s = settings.load()) {
  const api = settings.backendApiBase(s);
  if (!api) return { ok: false, message: 'Enter the Inventory site address first.' };
  if (!s.backendToken) return { ok: false, message: 'Paste the upload token first.' };

  // Newer backends answer a dedicated status call; older ones 404 it and get
  // the presign probe below.
  const probe = await getJson('/watermark/status', s);
  if (probe.status === 200 && probe.body?.ok) {
    const { storage, autoAnalyze } = probe.body;
    if (!storage) return { ok: false, message: "Token accepted, but the Inventory site's photo storage isn't configured." };
    return {
      ok: true,
      message: `Connected — the Inventory site accepted the token.${autoAnalyze ? ' New drafts are analyzed automatically.' : ''}`,
    };
  }
  if (probe.status === 401) return { ok: false, message: 'The Inventory site rejected the token. Re-paste it.' };

  let response;
  try {
    response = await fetch(`${api}/presign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.backendToken}`, 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      message:
        "Couldn't reach the Inventory site. Check the address and this device's internet connection. " +
        '(If the address is right, the site may be refusing this page — use /backend; see Advanced.)',
    };
  }

  const body = await response.json().catch(() => ({}));
  if (response.status === 400 && body?.error === 'invalid_request') {
    return { ok: true, message: 'Connected — the Inventory site accepted the token.' };
  }
  if (response.status === 401) return { ok: false, message: 'The Inventory site rejected the token. Re-paste it.' };
  if (response.status === 503) {
    return { ok: false, message: `The Inventory site isn't set up for uploads yet: ${body?.message ?? 'not configured'}.` };
  }
  if (response.status === 404 || response.status === 405) {
    return { ok: false, message: "That address doesn't look like the Inventory site's upload API." };
  }
  return { ok: false, message: `Unexpected answer from the Inventory site (HTTP ${response.status}).` };
}
