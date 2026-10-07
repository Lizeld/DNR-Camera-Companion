/** Photo identity — spec §2.4 and §8 "DCF key". */

import { describe, it, expect } from './runner.js';
import { dcfKey, tryDcfKey, isDcfKey, folderOf, fileNameOf, sequenceNumber, keyForSequence } from '../core/dcf.js';

describe('DCF key (§2.4)', () => {
  it('takes the last two segments of a CCAPI path', () => {
    expect(dcfKey('/ccapi/ver130/contents/card1/100CANON/IMG_0017.JPG')).toBe('100CANON/IMG_0017.JPG');
  });

  it('produces ONE key for the same photo arriving by different routes', () => {
    // This is the whole point of the rule: the poller, the camera browser and
    // a re-sync all describe the same file differently.
    const routes = [
      '/ccapi/ver130/contents/card1/100CANON/IMG_0017.JPG',
      'http://192.168.1.55:8080/ccapi/ver130/contents/card1/100CANON/IMG_0017.JPG',
      'http://192.168.1.55:8080/ccapi/ver130/contents/card1/100CANON/IMG_0017.JPG?kind=main',
      'https://192.168.1.55/ccapi/ver100/contents/card1/100CANON/IMG_0017.JPG?kind=thumbnail',
      '100CANON/IMG_0017.JPG',
    ];
    const keys = new Set(routes.map(dcfKey));
    expect(keys.size).toBe(1, `got ${[...keys].join(' | ')}`);
    expect([...keys][0]).toBe('100CANON/IMG_0017.JPG');
  });

  it('is unaffected by the CCAPI version in the path', () => {
    expect(dcfKey('/ccapi/ver100/contents/card1/100CANON/IMG_0017.JPG'))
      .toBe(dcfKey('/ccapi/ver130/contents/card1/100CANON/IMG_0017.JPG'));
  });

  it('distinguishes the same file name in different folders', () => {
    expect(dcfKey('/x/card1/100CANON/IMG_0017.JPG')).toBe('100CANON/IMG_0017.JPG');
    expect(dcfKey('/x/card1/101CANON/IMG_0017.JPG')).toBe('101CANON/IMG_0017.JPG');
  });

  it('rejects paths with fewer than two segments', async () => {
    await expect(() => dcfKey('IMG_0017.JPG')).toThrow();
    expect(tryDcfKey('IMG_0017.JPG')).toBeNull();
    expect(tryDcfKey('')).toBeNull();
  });

  it('recognises a bare key', () => {
    expect(isDcfKey('100CANON/IMG_0017.JPG')).toBeTruthy();
    expect(isDcfKey('IMG_0017.JPG')).toBeFalsy();
    expect(isDcfKey('a/b/c')).toBeFalsy();
  });

  it('splits folder and file name', () => {
    expect(folderOf('100CANON/IMG_0017.JPG')).toBe('100CANON');
    expect(fileNameOf('100CANON/IMG_0017.JPG')).toBe('IMG_0017.JPG');
  });
});

describe('Canon frame numbers', () => {
  it('parses IMG_XXXX', () => {
    expect(sequenceNumber('100CANON/IMG_0017.JPG')).toBe(17);
    expect(sequenceNumber('IMG_9999.JPG')).toBe(9999);
    expect(sequenceNumber('100CANON/_MG_0042.CR3')).toBe(42);
  });

  it('returns null for names that are not DCF', () => {
    expect(sequenceNumber('100CANON/screenshot.png')).toBeNull();
  });

  it('rebuilds a sibling name for a missing frame', () => {
    expect(keyForSequence('100CANON/IMG_0017.JPG', 14)).toBe('100CANON/IMG_0014.JPG');
    expect(keyForSequence('100CANON/IMG_0017.JPG', 3)).toBe('100CANON/IMG_0003.JPG');
    expect(keyForSequence('101CANON/IMG_0100.CR3', 99)).toBe('101CANON/IMG_0099.CR3');
  });
});
