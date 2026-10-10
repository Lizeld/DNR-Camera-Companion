/**
 * Canon CCAPI client — spec §3.
 *
 * Everything here was established empirically against a real EOS R50
 * (firmware 1.5.0); the official reference does not make most of it obvious.
 * The pure parsing helpers are exported separately so they can be tested
 * offline against recorded fixtures (§8).
 */

/**
 * Statuses to treat as an empty poll rather than a connection failure (§3.3).
 * The camera 503s while writing a burst to the card. Tearing the session down
 * on a 503 stalls the pipeline — this was a real production bug.
 */
export const TRANSIENT_STATUSES = new Set([304, 408, 429, 502, 503, 504]);

export class CcapiError extends Error {
  constructor(message, { status = 0, url = '', transient = false, body = '' } = {}) {
    super(message);
    this.name = 'CcapiError';
    this.status = status;
    this.url = url;
    this.transient = transient;
    this.body = body;
  }
}

// -------------------------------------------------------------------------
// Pure parsers — fixture-testable, no network
// -------------------------------------------------------------------------

/**
 * Resolve a function by matching its path suffix across *all* version keys.
 *
 * Do not assume a version prefix (§3.2). On the R50, `deviceinformation` is
 * ver100, `event/polling` is ver110 and `contents` is ver130; constructing
 * `/ccapi/ver130/event/polling` returns 404.
 *
 * @param {object} apiMap the body of `GET /ccapi`
 * @param {string} suffix e.g. "event/polling", "contents", "deviceinformation"
 * @returns {{path:string, version:string, descriptor:object}|null}
 */
export function resolveEndpoint(apiMap, suffix) {
  if (!apiMap || typeof apiMap !== 'object') return null;
  const want = `/${suffix.replace(/^\/+/, '')}`;

  let best = null;
  for (const [version, entries] of Object.entries(apiMap)) {
    if (!Array.isArray(entries)) continue;
    for (const descriptor of entries) {
      const path = descriptor?.path;
      if (typeof path !== 'string' || !path.endsWith(want)) continue;
      // Prefer the highest version that offers the function.
      if (!best || version > best.version) best = { path, version, descriptor };
    }
  }
  return best;
}

/** Every function suffix the app needs, resolved in one pass. */
export function resolveEndpoints(apiMap) {
  const wanted = {
    deviceInformation: 'deviceinformation',
    polling: 'event/polling',
    contents: 'contents',
    corsSetting: 'functions/cors/corssetting',
    corsOrigin: 'functions/cors/origin',
    storage: 'devicestatus/storage',
    battery: 'devicestatus/battery',
  };
  const out = {};
  for (const [name, suffix] of Object.entries(wanted)) {
    out[name] = resolveEndpoint(apiMap, suffix);
  }
  return out;
}

/**
 * Extract newly captured content paths from an `event/polling` body.
 * Idle response is `{}`; new captures arrive as `addedcontents`, an array of
 * absolute path strings.
 * @returns {string[]}
 */
export function parseAddedContents(body) {
  if (!body || typeof body !== 'object') return [];
  const added = body.addedcontents;
  if (!Array.isArray(added)) return [];
  return added.filter((p) => typeof p === 'string' && p.length > 0);
}

/**
 * Extract the `path` array from a contents listing.
 * Used for card list, folder list and file list alike — they share a shape.
 * @returns {string[]}
 */
export function parseContentsPaths(body) {
  if (!body || typeof body !== 'object') return [];
  return Array.isArray(body.path) ? body.path.filter((p) => typeof p === 'string') : [];
}

/** `?kind=number` returns `{"contentsnumber": N}`. */
export function parseContentsNumber(body) {
  const n = body?.contentsnumber;
  return Number.isInteger(n) ? n : 0;
}

/**
 * Page indices to fetch a folder newest-first (§3.4).
 *
 * Folders paginate at ~100 per page, oldest first. Paging forward from page 1
 * on a 6,000-image card returns the oldest images and looks broken; get the
 * count and page backwards instead.
 *
 * @returns {number[]} page numbers, last page first
 */
export function pagesNewestFirst(contentsNumber, pageSize = 100) {
  if (contentsNumber <= 0) return [];
  const lastPage = Math.ceil(contentsNumber / pageSize);
  const pages = [];
  for (let p = lastPage; p >= 1; p--) pages.push(p);
  return pages;
}

/** Normalise a user-typed camera address into an origin. Defaults to HTTP. */
export function normaliseCameraUrl(input) {
  let value = String(input ?? '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;

  // `url.port` is empty for a default port, so `http://host:80` would look
  // portless and get rewritten to 8080. Detect an explicit port in the raw
  // authority instead.
  const authority = value.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
  const hasExplicitPort = /:\d+$/.test(authority);

  try {
    const url = new URL(value);
    // §3.1: default to HTTP on 8080. HTTPS costs ~30% throughput (the camera's
    // SoC is the bottleneck when encrypting) and buys nothing on a LAN against
    // a self-signed cert that is not being verified anyway.
    if (!hasExplicitPort && url.protocol === 'http:') url.port = '8080';
    return url.origin;
  } catch {
    return '';
  }
}

// -------------------------------------------------------------------------
// Client
// -------------------------------------------------------------------------

export class CcapiClient {
  /**
   * @param {string} baseUrl e.g. "http://192.168.1.55:8080"
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=8000]
   */
  constructor(baseUrl, opts = {}) {
    this.baseUrl = normaliseCameraUrl(baseUrl);
    this.timeoutMs = opts.timeoutMs ?? 8000;
    /** @type {object|null} resolved endpoint map */
    this.endpoints = null;
    this.apiMap = null;
  }

  url(path) {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /** @private */
  async request(path, { method = 'GET', accept = 'json', body, timeoutMs, signal } = {}) {
    const url = /^https?:/i.test(path) ? path : this.url(path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    let response;
    try {
      response = await fetch(url, {
        method,
        signal: controller.signal,
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      clearTimeout(timer);
      // A network-level failure here is usually reachability, CORS or mixed
      // content (§5.1) — not something a retry fixes, but the ingest loop
      // treats it as transient so a Wi-Fi blip does not kill the session.
      throw new CcapiError(`${method} ${url} failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`, {
        url,
        transient: true,
      });
    }
    clearTimeout(timer);

    if (!response.ok) {
      let text = '';
      try {
        text = (await response.text()).slice(0, 400);
      } catch { /* body may be unreadable */ }
      throw new CcapiError(`${method} ${url} -> ${response.status}`, {
        status: response.status,
        url,
        transient: TRANSIENT_STATUSES.has(response.status),
        body: text,
      });
    }

    if (accept === 'blob') return response.blob();
    if (accept === 'text') return response.text();
    if (response.status === 204) return {};
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new CcapiError(`${method} ${url}: response was not JSON`, { url, body: text.slice(0, 200) });
    }
  }

  /** `GET /ccapi` and resolve every endpoint we need (§3.2). */
  async discover(signal) {
    const apiMap = await this.request('/ccapi', { signal });
    this.apiMap = apiMap;
    this.endpoints = resolveEndpoints(apiMap);
    if (!this.endpoints.contents || !this.endpoints.polling) {
      throw new CcapiError('CCAPI discovery: camera did not advertise contents and event/polling', {
        url: this.url('/ccapi'),
      });
    }
    return this.endpoints;
  }

  async ensureDiscovered(signal) {
    if (!this.endpoints) await this.discover(signal);
    return this.endpoints;
  }

  /** Device info — the cheapest "is this actually a Canon camera" check. */
  async deviceInformation(signal) {
    const ep = (await this.ensureDiscovered(signal)).deviceInformation;
    if (!ep) throw new CcapiError('deviceinformation not advertised');
    return this.request(ep.path, { signal });
  }

  /**
   * One poll cycle (§3.3).
   *
   * Bare GET, no query parameters: `?continue=off|on` returns 400 "Illegal
   * query parameter" and `?timeout=long` streams indefinitely (it crashed the
   * Android client).
   *
   * @returns {Promise<{addedContents:string[], transient:boolean, raw:object, error?:CcapiError}>}
   */
  async poll(signal) {
    const ep = (await this.ensureDiscovered(signal)).polling;
    try {
      const body = await this.request(ep.path, { signal });
      return { addedContents: parseAddedContents(body), transient: false, raw: body };
    } catch (err) {
      if (err instanceof CcapiError && err.transient) {
        // Camera is busy writing a burst. Empty poll; keep going.
        return { addedContents: [], transient: true, raw: {}, error: err };
      }
      throw err;
    }
  }

  /** Storage names, e.g. ["card1"] — note it is `card1`, not `sd` (§3.4). */
  async listCards(signal) {
    const ep = (await this.ensureDiscovered(signal)).contents;
    const body = await this.request(ep.path, { signal });
    return parseContentsPaths(body);
  }

  /** DCF folder paths within a card. */
  async listFolders(cardPath, signal) {
    const body = await this.request(cardPath, { signal });
    return parseContentsPaths(body);
  }

  /** Number of items in a folder, via `?kind=number`. */
  async countInFolder(folderPath, signal) {
    const body = await this.request(`${folderPath}?kind=number`, { signal });
    return parseContentsNumber(body);
  }

  /** One page of a folder listing (1-based, oldest first). */
  async listFolderPage(folderPath, page, signal) {
    const body = await this.request(`${folderPath}?page=${page}`, { signal });
    return parseContentsPaths(body);
  }

  /**
   * Iterate a folder newest-first (§3.4): count, compute the last page, walk
   * backwards, reversing each page so items come out newest first.
   *
   * @param {string} folderPath
   * @param {object} [opts]
   * @param {number} [opts.limit=Infinity] stop after this many items
   * @yields {string} content paths, newest first
   */
  async *iterateFolderNewestFirst(folderPath, opts = {}) {
    const limit = opts.limit ?? Infinity;
    const signal = opts.signal;
    const total = await this.countInFolder(folderPath, signal);
    let emitted = 0;
    for (const page of pagesNewestFirst(total, opts.pageSize ?? 100)) {
      const paths = await this.listFolderPage(folderPath, page, signal);
      for (const p of paths.reverse()) {
        if (emitted >= limit) return;
        emitted++;
        yield p;
      }
      if (emitted >= limit) return;
    }
  }

  /**
   * Download a content item (§3.5).
   * @param {string} contentPath absolute CCAPI content path
   * @param {'main'|'thumbnail'} kind
   * @returns {Promise<Blob>}
   */
  async download(contentPath, kind = 'main', { signal, timeoutMs } = {}) {
    return this.request(`${contentPath}?kind=${kind}`, {
      accept: 'blob',
      signal,
      // Full-resolution frames are ~10 MB at ~2 MB/s (§3.1). Be generous.
      timeoutMs: timeoutMs ?? (kind === 'main' ? 60000 : 15000),
    });
  }

  // ---- CORS configuration (§3.6) ----------------------------------------
  // This is what makes a browser client viable at all: the camera can be told
  // to accept a specific web origin.
  //
  // Payload shapes, confirmed against an EOS R50 on firmware 1.5.0:
  //   PUT functions/cors/origin      {"origin": "http://host:port"}
  //   PUT functions/cors/corssetting {"value": "enable"}
  // GET on the same paths returns {"origin": "..."} and
  // {"value": "disable", "ability": ["disable","enable"]}. The variant list
  // below is kept as a fallback for other bodies/firmware.
  //
  // ⚠ Chicken-and-egg: these endpoints are themselves subject to CORS, so this
  // method CANNOT perform the first enable from a browser — the request is
  // blocked before it is sent. Bootstrap it out-of-band with
  // `python tools/camera_probe.py allow <camera-ip> <origin>`, or from the
  // camera menu. Once CORS is on, this can change the allowed origin.

  async readCorsConfig(signal) {
    const eps = await this.ensureDiscovered(signal);
    const out = { setting: null, origin: null, errors: [] };
    for (const [key, ep] of [['setting', eps.corsSetting], ['origin', eps.corsOrigin]]) {
      if (!ep) {
        out.errors.push(`${key}: endpoint not advertised by this camera`);
        continue;
      }
      try {
        out[key] = await this.request(ep.path, { signal });
      } catch (err) {
        out.errors.push(`${key}: ${err.message}`);
      }
    }
    return out;
  }

  /**
   * Best-effort CORS enable for `origin`. Returns a transcript of what was
   * attempted so the Settings screen can show the raw outcome.
   */
  async configureCors(origin, signal) {
    const eps = await this.ensureDiscovered(signal);
    const attempts = [];

    const tryPut = async (label, path, payloads) => {
      for (const payload of payloads) {
        try {
          const res = await this.request(path, { method: 'PUT', body: payload, signal });
          attempts.push({ label, payload, ok: true, response: res });
          return true;
        } catch (err) {
          attempts.push({ label, payload, ok: false, error: err.message, status: err.status });
        }
      }
      return false;
    };

    if (eps.corsOrigin) {
      await tryPut('origin', eps.corsOrigin.path, [{ origin }, { value: origin }]);
    } else {
      attempts.push({ label: 'origin', ok: false, error: 'endpoint not advertised' });
    }
    if (eps.corsSetting) {
      await tryPut('corssetting', eps.corsSetting.path, [{ value: 'enable' }, { corssetting: 'enable' }]);
    } else {
      attempts.push({ label: 'corssetting', ok: false, error: 'endpoint not advertised' });
    }

    return { attempts, config: await this.readCorsConfig(signal).catch(() => null) };
  }
}

/**
 * Probe a candidate address for a CCAPI camera.
 * Used by Settings "test connection" and LAN auto-discovery.
 *
 * @returns {Promise<{ok:boolean, baseUrl:string, model?:string, endpoints?:object, error?:string}>}
 */
export async function probeCamera(baseUrl, { timeoutMs = 1500, signal } = {}) {
  const normalised = normaliseCameraUrl(baseUrl);
  if (!normalised) return { ok: false, baseUrl, error: 'unparseable address' };
  const client = new CcapiClient(normalised, { timeoutMs });
  try {
    const endpoints = await client.discover(signal);
    let model;
    try {
      const info = await client.deviceInformation(signal);
      model = info?.productname || info?.modelname;
    } catch { /* discovery already proved it is CCAPI */ }
    return { ok: true, baseUrl: normalised, model, endpoints };
  } catch (err) {
    return { ok: false, baseUrl: normalised, error: err.message };
  }
}

/**
 * Ask the serving machine to (re-)enable the camera's CORS for this origin.
 *
 * The browser cannot do this itself — the CORS endpoints are subject to CORS —
 * but serve.py can, and a same-origin POST to it is not. The camera drops its
 * CORS enable on every power cycle; serve.py's keeper restores it on a timer,
 * and this closes the gap between a wake-up and the keeper's next tick.
 *
 * Never throws. `available: false` means no serve.py camera route answered
 * (static hosting, or the server was started without --camera).
 *
 * @returns {Promise<{ok:boolean, available:boolean, message:string}>}
 */
export async function requestCorsRepair(baseUrl, { timeoutMs = 8000, signal } = {}) {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) {
    return { ok: false, available: false, message: 'not served over HTTP' };
  }
  let camera = null;
  try {
    camera = new URL(baseUrl).hostname;
  } catch { /* let the server use its own camera */ }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch('/camera/cors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera }),
      cache: 'no-store',
      signal: controller.signal,
    });
    let doc = null;
    try {
      doc = await res.json();
    } catch { /* not serve.py */ }
    if (!doc || typeof doc.ok !== 'boolean') {
      return { ok: false, available: false, message: `no camera route on this server (HTTP ${res.status})` };
    }
    // no_camera: serve.py is running but was not given --camera.
    return { ok: doc.ok, available: doc.error !== 'no_camera', message: doc.message ?? '' };
  } catch (err) {
    return { ok: false, available: false, message: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

let lastRepairAt = 0;

/**
 * Fire-and-forget repair for the ingest loop: when the camera stops answering
 * readably, ask serve.py to re-apply CORS, at most once per `minGapMs`.
 */
export function nudgeCorsRepair(baseUrl, { minGapMs = 10000 } = {}) {
  const now = Date.now();
  if (now - lastRepairAt < minGapMs) return;
  lastRepairAt = now;
  void requestCorsRepair(baseUrl);
}

/**
 * Layered connection diagnosis.
 *
 * A plain `fetch()` failure is uninformative: "host unreachable" and "host
 * reachable but has not been told to allow this origin" both surface as the
 * same opaque `TypeError`. An opaque (`mode: 'no-cors'`) request separates
 * them — it completes whenever the HTTP round trip happened, regardless of
 * what CORS says about *reading* the response.
 *
 * @returns {Promise<{verdict:string, headline:string, reachable:boolean|null,
 *                    steps:string[], detail:string, probe:object}>}
 */
export async function diagnoseCamera(input, { timeoutMs = 6000 } = {}) {
  const baseUrl = normaliseCameraUrl(input);
  const probe = { baseUrl, opaque: null, cors: null, repair: null, mixedContent: false };

  if (!baseUrl) {
    return {
      verdict: 'bad-url',
      headline: 'That address could not be parsed.',
      reachable: null,
      steps: ['Enter the camera\'s IP, e.g. 192.168.1.55 (port 8080 is assumed).'],
      detail: `input: ${JSON.stringify(input)}`,
      probe,
    };
  }

  // Definitive before any network work: an https page cannot fetch http at all.
  if (typeof location !== 'undefined' && location.protocol === 'https:' && baseUrl.startsWith('http://')) {
    probe.mixedContent = true;
    return {
      verdict: 'mixed-content',
      headline: 'Blocked by mixed content — this page is HTTPS and the camera is HTTP.',
      reachable: null,
      steps: [
        `This page is served from ${location.origin}.`,
        'Browsers block an https:// page from fetching http:// outright; no camera setting fixes it.',
        'Serve the app over plain HTTP from the LAN instead (§5.1 option A): python serve.py',
        `Then open the app at http://<lan-ip>:<port>, not ${location.origin}.`,
      ],
      detail: `page ${location.origin} -> camera ${baseUrl}`,
      probe,
    };
  }

  const withTimeout = async (fn) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      await fn(controller.signal);
      return { ok: true, ms: Date.now() - startedAt };
    } catch (err) {
      return { ok: false, ms: Date.now() - startedAt, error: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  };

  // Step 1 — did the HTTP round trip happen at all?
  probe.opaque = await withTimeout((signal) =>
    fetch(`${baseUrl}/ccapi`, { mode: 'no-cors', cache: 'no-store', signal }),
  );

  // Step 2 — can we actually read the response?
  let corsResult = await probeCamera(baseUrl, { timeoutMs });
  probe.cors = corsResult;

  // Step 2b — reachable but refused: have the serving machine fix it, then
  // look again. Usually the camera just woke up and dropped its CORS enable.
  if (!corsResult.ok && probe.opaque.ok) {
    probe.repair = await requestCorsRepair(baseUrl);
    if (probe.repair.ok) {
      corsResult = await probeCamera(baseUrl, { timeoutMs });
      probe.cors = corsResult;
    }
  }

  if (corsResult.ok) {
    return {
      verdict: 'ok',
      headline: `Connected — ${corsResult.model ?? 'CCAPI camera'} at ${corsResult.baseUrl}`,
      reachable: true,
      steps: [],
      detail: Object.entries(corsResult.endpoints)
        .map(([name, ep]) => `  ${name.padEnd(18)} ${ep ? `${ep.version}  ${ep.path}` : '— not advertised'}`)
        .join('\n'),
      probe,
    };
  }

  if (probe.opaque.ok) {
    // The camera answered; the browser refused to hand us the response, and
    // the serving machine could not (or was not set up to) fix that.
    const repair = probe.repair;
    const repairStep = repair?.available
      ? `This app's server tried to enable it and failed: ${repair.message}`
      : 'Start the server with  python serve.py --camera <camera-ip>  and it will do this automatically.';
    return {
      verdict: 'cors',
      headline: 'The camera is reachable, but it has not been told to allow this origin.',
      reachable: true,
      steps: [
        `The HTTP request completed in ${probe.opaque.ms}ms, so the address and port are right.`,
        'The camera must be configured to accept this exact origin, including the port:',
        `    ${location.origin}`,
        'The CORS endpoints are themselves subject to CORS, so the button below cannot',
        'perform the first enable. Run this on the machine serving the app:',
        `    python tools/camera_probe.py allow ${new URL(baseUrl).hostname} ${location.origin}`,
        'Or set the allowed origin from the camera menu (connection setup), then reload.',
        repairStep,
      ],
      detail: `opaque probe OK in ${probe.opaque.ms}ms; CORS read failed: ${corsResult.error}`
        + (repair ? `\nserver repair: ${repair.available ? (repair.ok ? 'ok' : 'failed') : 'unavailable'} — ${repair.message}` : ''),
      probe,
    };
  }

  // Nothing answered. Timing separates "refused" from "dropped".
  const refused = probe.opaque.ms < 800 && probe.opaque.error !== 'timeout';
  return {
    verdict: 'unreachable',
    headline: refused
      ? 'Nothing is listening on that address and port.'
      : 'No response — the address is unreachable or filtered.',
    reachable: false,
    steps: [
      refused
        ? 'The connection was refused immediately, which usually means the port is wrong.'
        : `The request timed out after ${probe.opaque.ms}ms, which usually means the host is not on this network.`,
      'CCAPI serves HTTP on port 8080 and HTTPS on 443; use HTTP (§3.1).',
      'Check the camera Wi-Fi is on, connected to the same network, and not asleep.',
      'CCAPI must be enabled in the camera menu — Wi-Fi alone is not enough.',
      'Confirm from outside the browser, which is not subject to CORS:',
      `    python tools/camera_probe.py info ${new URL(baseUrl).hostname}`,
      '    python tools/camera_probe.py scan <first three octets>',
    ],
    detail: `opaque probe failed after ${probe.opaque.ms}ms: ${probe.opaque.error}\nCORS probe: ${corsResult.error}`,
    probe,
  };
}

/**
 * Sweep a /24 for a camera.
 *
 * Note the browser cannot enumerate its own interfaces; the caller supplies
 * the prefix. When the app is LAN-served (§5.1 option A) `location.hostname`
 * is already the right subnet, which is what the Settings screen defaults to.
 *
 * Only positive results are meaningful: a host that is not a CORS-enabled
 * camera fails indistinguishably from an empty address.
 *
 * @param {string} prefix e.g. "192.168.1"
 * @param {object} [opts]
 * @returns {Promise<Array<{ok:true, baseUrl:string, model?:string}>>}
 */
export async function discoverOnLan(prefix, opts = {}) {
  const ports = opts.ports ?? [8080, 80];
  const concurrency = opts.concurrency ?? 24;
  const timeoutMs = opts.timeoutMs ?? 1200;
  const onProgress = opts.onProgress ?? (() => {});
  const signal = opts.signal;

  const candidates = [];
  for (let host = 1; host <= 254; host++) {
    for (const port of ports) candidates.push(`http://${prefix}.${host}:${port}`);
  }

  const found = [];
  let index = 0;
  let done = 0;

  const worker = async () => {
    while (index < candidates.length) {
      if (signal?.aborted) return;
      if (found.length && opts.stopOnFirst !== false) return;
      const candidate = candidates[index++];
      const result = await probeCamera(candidate, { timeoutMs, signal });
      done++;
      onProgress(done, candidates.length, candidate);
      if (result.ok) found.push(result);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}
