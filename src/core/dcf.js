/**
 * Photo identity — spec §2.4.
 *
 * Identity must be transport-agnostic: the same photo can arrive via the event
 * poller, the camera browser, or a re-sync, and must never be processed twice.
 * The key is the DCF path `<folder>/<filename>`, e.g. "100CANON/IMG_0017.JPG".
 *
 * Never key on a CCAPI URL (carries an API version) or a PTP object handle
 * (not stable across sessions).
 */

const DCF_KEY_RE = /^[^/\\?#]+\/[^/\\?#]+$/;

/** Strip query string and fragment; a CCAPI path may arrive as `...JPG?kind=main`. */
function stripQuery(path) {
  const q = path.search(/[?#]/);
  return q === -1 ? path : path.slice(0, q);
}

/**
 * Derive the DCF key from any path or URL that ends in `<folder>/<filename>`.
 *
 * Accepts:
 *   /ccapi/ver130/contents/card1/100CANON/IMG_0017.JPG
 *   http://192.168.1.55:8080/ccapi/ver130/contents/card1/100CANON/IMG_0017.JPG?kind=main
 *   100CANON/IMG_0017.JPG
 *
 * @returns {string} "100CANON/IMG_0017.JPG"
 * @throws {Error} if fewer than two path segments are present
 */
export function dcfKey(pathOrUrl) {
  if (typeof pathOrUrl !== 'string' || pathOrUrl.length === 0) {
    throw new Error('dcfKey: empty path');
  }
  let path = stripQuery(pathOrUrl.trim());

  // Drop scheme + authority if this is a full URL.
  const schemeAt = path.indexOf('://');
  if (schemeAt !== -1) {
    const afterAuthority = path.indexOf('/', schemeAt + 3);
    path = afterAuthority === -1 ? '' : path.slice(afterAuthority);
  }

  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new Error(`dcfKey: not a DCF path: ${pathOrUrl}`);
  }
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

/** Non-throwing variant. @returns {string|null} */
export function tryDcfKey(pathOrUrl) {
  try {
    return dcfKey(pathOrUrl);
  } catch {
    return null;
  }
}

/** @returns {boolean} true if `value` already looks like a bare DCF key. */
export function isDcfKey(value) {
  return typeof value === 'string' && DCF_KEY_RE.test(value);
}

/** "100CANON/IMG_0017.JPG" -> "100CANON" */
export function folderOf(key) {
  return key.slice(0, key.indexOf('/'));
}

/** "100CANON/IMG_0017.JPG" -> "IMG_0017.JPG" */
export function fileNameOf(key) {
  return key.slice(key.indexOf('/') + 1);
}

/**
 * Canon frame number from a DCF key or file name: IMG_0017.JPG -> 17.
 * Returns null for names that do not follow the DCF `XXXX9999` convention
 * (e.g. `_MG_0017.JPG` still matches; `PANO0001.JPG` does too).
 */
export function sequenceNumber(keyOrName) {
  const name = keyOrName.includes('/') ? fileNameOf(keyOrName) : keyOrName;
  const m = /^[A-Za-z_]{1,4}(\d{4,5})\b/.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Rebuild a file name for a frame number, borrowing the prefix/extension of a
 * known sibling. Used to enqueue the frames a sequence gap says are missing.
 *
 * ("100CANON/IMG_0017.JPG", 14) -> "100CANON/IMG_0014.JPG"
 */
export function keyForSequence(siblingKey, seq) {
  const folder = folderOf(siblingKey);
  const name = fileNameOf(siblingKey);
  const m = /^([A-Za-z_]{1,4})(\d{4,5})(\..+)$/.exec(name);
  if (!m) throw new Error(`keyForSequence: unparseable sibling name: ${name}`);
  const digits = String(seq).padStart(m[2].length, '0');
  return `${folder}/${m[1]}${digits}${m[3]}`;
}
