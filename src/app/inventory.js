/**
 * The Inventory site, seen from the companion: where it lives, deep links into
 * it, and a side-effect-free check that uploads will be accepted.
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
});

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
