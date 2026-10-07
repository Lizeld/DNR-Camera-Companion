/**
 * Settings screen — spec §7.
 *
 * Camera URL (with test connection and LAN auto-discovery), backend URL +
 * token (masked), watermark padding, stale thresholds, verbose errors.
 */

import { $, on, text, result, toast } from './dom.js';
import * as settings from '../core/settings.js';
import * as db from '../core/db.js';
import * as blobstore from '../core/blobstore.js';
import * as imaging from '../app/imaging-client.js';
import * as inventory from '../app/inventory.js';
import { diagnoseCamera, discoverOnLan, normaliseCameraUrl } from '../core/ccapi.js';
import { describeBackend as describeBarcodeBackend } from '../core/barcode.js';
import { loadWatermark, setCustomWatermark, clearCustomWatermark, watermarkInfo } from '../app/watermark-asset.js';
import { history, formatBytes } from '../core/log.js';

const FIELDS = [
  ['#set-camera-url', 'cameraUrl', 'value'],
  ['#set-backend-url', 'backendUrl', 'value'],
  ['#set-backend-token', 'backendToken', 'value'],
  ['#set-key-prefix', 'keyPrefix', 'value'],
  ['#set-padding', 'watermarkPadding', 'number'],
  ['#set-quality', 'jpegQuality', 'number'],
  ['#set-stale', 'staleWarning', 'number'],
  ['#set-evacuate', 'autoEvacuate', 'number'],
  ['#set-poll', 'pollIntervalMs', 'number'],
  ['#set-attempts', 'maxQueueAttempts', 'number'],
  ['#set-autoupload', 'autoUpload', 'checked'],
  ['#set-verbose', 'verboseErrors', 'checked'],
  ['#set-wakelock', 'keepScreenAwake', 'checked'],
  ['#set-notifications', 'notifications', 'checked'],
];

export function initSettings() {
  const s = settings.load();

  for (const [sel, key, kind] of FIELDS) {
    const el = $(sel);
    if (!el) continue;
    if (kind === 'checked') el.checked = Boolean(s[key]);
    else el.value = s[key];

    on(el, 'change', () => {
      const value = kind === 'checked' ? el.checked : kind === 'number' ? Number(el.value) : el.value;
      const next = settings.save({ [key]: value });
      // Coercion may clamp; write the clamped value back so the field agrees.
      if (kind === 'checked') el.checked = next[key];
      else el.value = next[key];
      reflect();
      if (key === 'notifications' && value) void requestNotificationPermission();
    });
  }

  text($('#origin-echo'), location.origin);
  text($('#origin-echo-2'), location.origin);
  text($('#cors-origin'), location.origin);
  $('#set-discover-prefix').value = guessSubnet();

  on($('#test-camera'), 'click', onTestCamera);
  on($('#test-uploads'), 'click', onTestUploads);
  on($('#discover-camera'), 'click', onDiscover);
  on($('#cors-read'), 'click', onCorsRead);
  on($('#cors-write'), 'click', onCorsWrite);

  on($('#toggle-token'), 'click', () => {
    const input = $('#set-backend-token');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    text($('#toggle-token'), showing ? 'Show' : 'Hide');
  });

  on($('#set-watermark-file'), 'change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await setCustomWatermark(file);
      await imaging.setWatermark(await loadWatermark());
      toast('Watermark updated', 'ok');
      await reflectWatermark();
    } catch (err) {
      toast(`Could not load that image: ${err.message}`, 'error');
    }
  });

  on($('#reset-watermark'), 'click', async () => {
    await clearCustomWatermark();
    await imaging.setWatermark(await loadWatermark());
    $('#set-watermark-file').value = '';
    toast('Reverted to the bundled watermark', 'ok');
    await reflectWatermark();
  });

  on($('#export-log'), 'click', exportLog);

  on($('#danger-clear'), 'click', async () => {
    if (!confirm('Erase every locally held photo, all metadata and all settings? This cannot be undone.')) return;
    await db.clearAll();
    settings.reset();
    location.reload();
  });

  reflect();
  void reflectWatermark();
  void renderDiagnostics();
}

export function onSettingsShown() {
  reflect();
  void renderDiagnostics();
}

function reflect() {
  const s = settings.load();
  text($('#backend-resolved'), settings.backendApiBase(s) || '—');
  text($('#token-mask'), settings.maskToken(s.backendToken));
}

/** When LAN-served (§5.1 option A) our own hostname is already the subnet. */
function guessSubnet() {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(location.hostname);
  return m ? m[1] : '192.168.1';
}

async function onTestCamera() {
  const btn = $('#test-camera');
  const out = $('#camera-test-result');
  const url = $('#set-camera-url').value.trim();
  btn.disabled = true;
  result(out, `Probing ${normaliseCameraUrl(url) || url}…`);

  try {
    // Layered: an opaque probe separates "unreachable" from "reachable but
    // this origin is not allowed", which a plain fetch cannot distinguish.
    const d = await diagnoseCamera(url, { timeoutMs: 6000 });
    const ok = d.verdict === 'ok';

    const lines = [ok ? `✓ ${d.headline}` : `✕ ${d.headline}`];
    if (ok) {
      if (settings.load().verboseErrors) {
        lines.push('', 'Resolved endpoints (matched by path suffix, not by assumed version):', d.detail);
      }
    } else {
      lines.push('', ...d.steps.map((s) => (s.startsWith('    ') ? s : `  • ${s}`)));
      if (settings.load().verboseErrors) lines.push('', '--- detail ---', d.detail);
    }
    result(out, lines.join('\n'), ok);

    if (ok) {
      settings.save({ cameraUrl: d.probe.baseUrl });
      $('#set-camera-url').value = d.probe.baseUrl;
    }
  } catch (err) {
    result(out, `FAILED: ${err.message}`, false);
  } finally {
    btn.disabled = false;
  }
}

async function onTestUploads() {
  const btn = $('#test-uploads');
  const out = $('#uploads-test-result');
  // Test what is in the fields now, even if a change event has not fired yet.
  const s = settings.save({
    backendUrl: $('#set-backend-url').value,
    backendToken: $('#set-backend-token').value,
  });
  reflect();
  btn.disabled = true;
  result(out, 'Checking…');
  try {
    const { ok, message } = await inventory.checkUploads(s);
    result(out, `${ok ? '✓' : '✕'} ${message}`, ok);
  } finally {
    btn.disabled = false;
  }
}

async function onDiscover() {
  const btn = $('#discover-camera');
  const out = $('#discover-result');
  const prefix = $('#set-discover-prefix').value.trim();
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix)) {
    result(out, 'Set "Network to search" under Advanced to the first three numbers of the address, e.g. 192.168.1', false);
    return;
  }
  btn.disabled = true;
  result(out, 'Scanning…');
  try {
    const found = await discoverOnLan(prefix, {
      onProgress: (done, total) => {
        if (done % 20 === 0) result(out, `Scanning ${prefix}.x … ${done}/${total} probed`);
      },
    });
    if (found.length === 0) {
      result(
        out,
        `No camera found on ${prefix}.x.\n` +
          "Check the camera is on with Wi-Fi connected, or type its address in. A camera that hasn't " +
          'allowed this page (Advanced → Camera CORS) is invisible to the search.',
        false,
      );
      return;
    }
    const first = found[0];
    settings.save({ cameraUrl: first.baseUrl });
    $('#set-camera-url').value = first.baseUrl;
    result(out, `✓ Found ${first.model ?? 'a Canon camera'} at ${first.baseUrl} — saved.`, true);
  } catch (err) {
    result(out, `Scan failed: ${err.message}`, false);
  } finally {
    btn.disabled = false;
  }
}

async function withCorsClient(fn, out) {
  const url = settings.load().cameraUrl;
  if (!url) return result(out, 'Set the camera URL first.', false);
  const { CcapiClient } = await import('../core/ccapi.js');
  const client = new CcapiClient(url);
  try {
    await client.ensureDiscovered();
    return await fn(client);
  } catch (err) {
    result(out, `Failed: ${err.message}`, false);
    return null;
  }
}

async function onCorsRead() {
  const out = $('#cors-result');
  result(out, 'Reading…');
  await withCorsClient(async (client) => {
    const config = await client.readCorsConfig();
    result(out, JSON.stringify(config, null, 2), config.errors.length === 0);
  }, out);
}

async function onCorsWrite() {
  const out = $('#cors-result');
  if (!confirm(`Ask the camera to allow ${location.origin}? This changes camera configuration.`)) return;
  result(out, 'Writing…');
  await withCorsClient(async (client) => {
    const transcript = await client.configureCors(location.origin);
    const ok = transcript.attempts.some((a) => a.ok);
    result(
      out,
      [
        ok
          ? 'At least one write was accepted. Verify with "Read config" and a reload.'
          : 'No write was accepted — set CORS from the camera menu instead.',
        '',
        JSON.stringify(transcript, null, 2),
      ].join('\n'),
      ok,
    );
  }, out);
}

async function requestNotificationPermission() {
  try {
    if (typeof Notification === 'undefined') throw new Error('Notifications unsupported');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Notification permission denied', 'error');
      settings.save({ notifications: false });
      $('#set-notifications').checked = false;
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function reflectWatermark() {
  const info = await watermarkInfo();
  text($('#watermark-info'), info.label);

  const canvas = $('#watermark-preview');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#465a78';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const bitmap = await loadWatermark().catch(() => null);
  if (!bitmap) return;
  const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height) * 0.9;
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

function exportLog() {
  const body = history()
    .map((e) => `${new Date(e.at).toISOString()} [${e.level}] ${e.message}${e.detail ? `\n    ${e.detail.replace(/\n/g, '\n    ')}` : ''}`)
    .join('\n');
  const blob = new Blob([body], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dnr-watermark-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function renderDiagnostics() {
  const dl = $('#diagnostics');
  if (!dl) return;

  const store = await blobstore.describeBackend();
  const { used, quota } = await blobstore.usage();
  const counts = await db.statusCounts();

  const rows = [
    ['Page origin', `${location.origin} (${isSecureContext ? 'secure context' : 'INSECURE context'})`],
    [
      'Deployment',
      isSecureContext
        ? 'Secure context: OPFS, Wake Lock and service workers are available.'
        : 'Plain HTTP on a LAN address — the recommended deployment (§5.1 option A). ' +
          'It is the only model that can reach an HTTP camera, at the cost of OPFS and Wake Lock.',
    ],
    ['Image byte store', `${store.label}${store.note ? ` — ${store.note}` : ''}`],
    ['Storage used', quota ? `${formatBytes(used)} of ${formatBytes(quota)}` : formatBytes(used)],
    ['Barcode backend', await describeBarcodeBackend()],
    ['OffscreenCanvas', typeof OffscreenCanvas === 'undefined' ? 'MISSING — imaging will not work' : 'available'],
    ['createImageBitmap', typeof createImageBitmap === 'undefined' ? 'MISSING' : 'available'],
    ['Wake Lock', 'wakeLock' in navigator ? 'available' : 'unavailable (needs a secure context)'],
    ['Notifications', typeof Notification === 'undefined' ? 'unsupported' : Notification.permission],
    ['Backend base', settings.backendApiBase() || '(not set)'],
    ['Photos held', `${counts.total} total — ${counts.PENDING} pending, ${counts.GROUPED} grouped, ${counts.REVIEW} review, ${counts.UPLOADED} uploaded, ${counts.FAILED} failed`],
    ['User agent', navigator.userAgent],
  ];

  dl.replaceChildren();
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
}
