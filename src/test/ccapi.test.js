/**
 * CCAPI contract — spec §3 and §8 "Camera contract".
 *
 * These are recorded response shapes from a real EOS R50 (firmware 1.5.0),
 * parse-tested offline. The shapes were expensive to discover; this file is
 * the guard against a refactor quietly assuming a different one.
 */

import { describe, it, expect } from './runner.js';
import {
  resolveEndpoint,
  resolveEndpoints,
  parseAddedContents,
  parseContentsPaths,
  parseContentsNumber,
  pagesNewestFirst,
  normaliseCameraUrl,
  TRANSIENT_STATUSES,
} from '../core/ccapi.js';

/** `GET /ccapi` on the R50 — note the functions live in DIFFERENT versions. */
const API_MAP = {
  ver100: [
    { path: '/ccapi/ver100/deviceinformation', get: true },
    { path: '/ccapi/ver100/devicestatus/battery', get: true },
    { path: '/ccapi/ver100/devicestatus/storage', get: true },
    { path: '/ccapi/ver100/functions/cors/corssetting', get: true, put: true },
    { path: '/ccapi/ver100/functions/cors/origin', get: true, put: true },
    { path: '/ccapi/ver100/contents', get: true },
    { path: '/ccapi/ver100/event/polling', get: true },
  ],
  ver110: [
    { path: '/ccapi/ver110/event/polling', get: true },
    { path: '/ccapi/ver110/shooting/settings', get: true },
  ],
  ver130: [
    { path: '/ccapi/ver130/contents', get: true },
  ],
};

describe('CCAPI discovery (§3.2)', () => {
  it('resolves each function by path suffix across all versions', () => {
    expect(resolveEndpoint(API_MAP, 'deviceinformation').version).toBe('ver100');
    expect(resolveEndpoint(API_MAP, 'event/polling').version).toBe('ver110');
    expect(resolveEndpoint(API_MAP, 'contents').version).toBe('ver130');
  });

  it('returns the advertised path verbatim — never a constructed one', () => {
    // Constructing /ccapi/ver130/event/polling returns 404 on the R50.
    expect(resolveEndpoint(API_MAP, 'event/polling').path).toBe('/ccapi/ver110/event/polling');
    expect(resolveEndpoint(API_MAP, 'contents').path).toBe('/ccapi/ver130/contents');
  });

  it('matches whole segments, so `contents` does not match `addedcontents`', () => {
    const map = { ver100: [{ path: '/ccapi/ver100/event/addedcontents' }, { path: '/ccapi/ver100/contents' }] };
    expect(resolveEndpoint(map, 'contents').path).toBe('/ccapi/ver100/contents');
  });

  it('returns null for a function the camera does not advertise', () => {
    expect(resolveEndpoint(API_MAP, 'shooting/liveview')).toBeNull();
    expect(resolveEndpoint({}, 'contents')).toBeNull();
    expect(resolveEndpoint(null, 'contents')).toBeNull();
  });

  it('resolves the whole set the app needs', () => {
    const eps = resolveEndpoints(API_MAP);
    expect(eps.polling.path).toBe('/ccapi/ver110/event/polling');
    expect(eps.contents.path).toBe('/ccapi/ver130/contents');
    expect(eps.corsSetting.path).toBe('/ccapi/ver100/functions/cors/corssetting');
    expect(eps.corsOrigin.path).toBe('/ccapi/ver100/functions/cors/origin');
  });

  it('tolerates junk entries', () => {
    const map = { ver100: 'not-an-array', ver110: [null, {}, { path: 42 }, { path: '/ccapi/ver110/contents' }] };
    expect(resolveEndpoint(map, 'contents').path).toBe('/ccapi/ver110/contents');
  });
});

describe('CCAPI event polling (§3.3)', () => {
  it('treats the idle response {} as no new content', () => {
    expect(parseAddedContents({})).toEqual([]);
  });

  it('reads addedcontents as absolute path strings', () => {
    const body = {
      addedcontents: [
        '/ccapi/ver130/contents/card1/100CANON/IMG_0017.JPG',
        '/ccapi/ver130/contents/card1/100CANON/IMG_0018.JPG',
      ],
    };
    expect(parseAddedContents(body)).toHaveLength(2);
    expect(parseAddedContents(body)[0]).toContain('IMG_0017.JPG');
  });

  it('ignores currentdirectory — it is only present on full-state polls', () => {
    const body = {
      currentdirectory: '/ccapi/ver130/contents/card1/100CANON',
      addedcontents: ['/ccapi/ver130/contents/card1/100CANON/IMG_0019.JPG'],
    };
    expect(parseAddedContents(body)).toHaveLength(1);
  });

  it('survives a malformed body', () => {
    expect(parseAddedContents(null)).toEqual([]);
    expect(parseAddedContents({ addedcontents: 'nope' })).toEqual([]);
    expect(parseAddedContents({ addedcontents: [null, 3, ''] })).toEqual([]);
  });

  it('classifies busy-camera statuses as transient, not fatal', () => {
    // Treating a 503 as a connection failure tore down the session and stalled
    // the pipeline — a real production bug.
    for (const status of [304, 408, 429, 502, 503, 504]) {
      expect(TRANSIENT_STATUSES.has(status)).toBeTruthy(`${status} must be transient`);
    }
    for (const status of [400, 401, 404, 500]) {
      expect(TRANSIENT_STATUSES.has(status)).toBeFalsy(`${status} must not be transient`);
    }
  });
});

describe('CCAPI contents browsing (§3.4)', () => {
  it('parses the card listing — storage is card1, not sd', () => {
    const paths = parseContentsPaths({ path: ['/ccapi/ver130/contents/card1'] });
    expect(paths).toEqual(['/ccapi/ver130/contents/card1']);
    expect(paths[0].endsWith('card1')).toBeTruthy();
  });

  it('parses the folder listing', () => {
    expect(parseContentsPaths({
      path: ['/ccapi/ver130/contents/card1/100CANON', '/ccapi/ver130/contents/card1/101CANON'],
    })).toHaveLength(2);
  });

  it('parses a file listing', () => {
    const body = {
      path: [
        '/ccapi/ver130/contents/card1/100CANON/IMG_0017.JPG',
        '/ccapi/ver130/contents/card1/100CANON/IMG_0018.JPG',
        '/ccapi/ver130/contents/card1/100CANON/IMG_0019.JPG',
      ],
    };
    expect(parseContentsPaths(body)).toHaveLength(3);
  });

  it('reads the count from ?kind=number', () => {
    expect(parseContentsNumber({ contentsnumber: 5987 })).toBe(5987);
    expect(parseContentsNumber({})).toBe(0);
    expect(parseContentsNumber(null)).toBe(0);
  });

  it('pages backwards so the newest images come first', () => {
    // Paging forward from page 1 on a 6,000-image card returns the oldest
    // images and looks broken.
    expect(pagesNewestFirst(5987)).toHaveLength(60);
    expect(pagesNewestFirst(5987)[0]).toBe(60, 'must start at the LAST page');
    expect(pagesNewestFirst(5987)[59]).toBe(1);
  });

  it('handles exact page multiples and empty folders', () => {
    expect(pagesNewestFirst(100)).toEqual([1]);
    expect(pagesNewestFirst(101)).toEqual([2, 1]);
    expect(pagesNewestFirst(0)).toEqual([]);
  });
});

describe('Camera URL normalisation (§3.1)', () => {
  it('defaults to HTTP on port 8080', () => {
    // HTTPS measures ~1.5 MB/s against ~1.95 MB/s over HTTP; the camera's SoC
    // is the bottleneck when encrypting.
    expect(normaliseCameraUrl('192.168.1.55')).toBe('http://192.168.1.55:8080');
  });

  it('never overrides an explicit port with 8080', () => {
    // `url.port` is empty for a default port, so a naive check rewrites
    // http://host:80 to :8080 and the camera becomes unreachable.
    expect(normaliseCameraUrl('http://192.168.1.55:80')).toBe('http://192.168.1.55');
    expect(normaliseCameraUrl('192.168.1.55:80')).toBe('http://192.168.1.55');
    expect(normaliseCameraUrl('192.168.1.55:8080')).toBe('http://192.168.1.55:8080');
    expect(normaliseCameraUrl('http://192.168.1.55:9000')).toBe('http://192.168.1.55:9000');
  });

  it('keeps an explicit https scheme rather than silently rewriting it', () => {
    expect(normaliseCameraUrl('https://192.168.1.55')).toBe('https://192.168.1.55');
  });

  it('strips paths and trailing slashes', () => {
    expect(normaliseCameraUrl('http://192.168.1.55:8080/ccapi/')).toBe('http://192.168.1.55:8080');
  });

  it('returns empty for junk', () => {
    expect(normaliseCameraUrl('')).toBe('');
    expect(normaliseCameraUrl('   ')).toBe('');
    expect(normaliseCameraUrl(null)).toBe('');
  });
});
