/**
 * Upload backend URL handling — spec §4, "Two traps, both hit in production".
 *
 * Pure functions only; nothing here touches the network.
 */

import { describe, it, expect } from './runner.js';
import { backendApiBase, maskToken } from '../core/settings.js';
import { objectKey } from '../app/uploader.js';

const s = (backendUrl, extra = {}) => ({ backendUrl, keyPrefix: 'listings/', ...extra });

describe('Backend base URL (§4 traps)', () => {
  it('appends /api — the root paths are the SPA and return nginx 405', () => {
    expect(backendApiBase(s('https://inventory.example.com'))).toBe('https://inventory.example.com/api');
  });

  it('does not double up an /api already present', () => {
    expect(backendApiBase(s('https://inventory.example.com/api'))).toBe('https://inventory.example.com/api');
  });

  it('forces https — an http:// base 301s and downgrades POST to GET', () => {
    expect(backendApiBase(s('http://inventory.example.com'))).toBe('https://inventory.example.com/api');
  });

  it('adds a scheme when none is given', () => {
    expect(backendApiBase(s('inventory.example.com'))).toBe('https://inventory.example.com/api');
  });

  it('strips trailing slashes', () => {
    expect(backendApiBase(s('https://inventory.example.com///'))).toBe('https://inventory.example.com/api');
    expect(backendApiBase(s('https://inventory.example.com/api/'))).toBe('https://inventory.example.com/api');
  });

  it('keeps a path prefix intact', () => {
    expect(backendApiBase(s('https://example.com/dnr'))).toBe('https://example.com/dnr/api');
  });

  it('returns empty when unset', () => {
    expect(backendApiBase(s(''))).toBe('');
    expect(backendApiBase(s('   '))).toBe('');
  });
});

describe('Backend base URL — serve.py proxy', () => {
  it('keeps a path-only base same-origin: no host, no https upgrade', () => {
    expect(backendApiBase(s('/backend'))).toBe('/backend/api');
  });

  it('does not double up an /api already present', () => {
    expect(backendApiBase(s('/backend/api'))).toBe('/backend/api');
  });

  it('strips trailing slashes', () => {
    expect(backendApiBase(s('/backend/'))).toBe('/backend/api');
    expect(backendApiBase(s('/backend/api//'))).toBe('/backend/api');
  });

  it('treats a bare slash as unset rather than building https:///api', () => {
    expect(backendApiBase(s('/'))).toBe('');
  });
});

describe('S3 object keys (§4)', () => {
  const photo = { fileName: 'IMG_0017.JPG' };

  it('uses the documented listings/ prefix', () => {
    expect(objectKey(photo, { keyPrefix: 'listings/' })).toBe('listings/IMG_0017.JPG');
  });

  it('normalises a prefix with no trailing slash', () => {
    expect(objectKey(photo, { keyPrefix: 'listings' })).toBe('listings/IMG_0017.JPG');
  });

  it('strips a leading slash — S3 keys are not paths', () => {
    expect(objectKey(photo, { keyPrefix: '/listings/' })).toBe('listings/IMG_0017.JPG');
  });

  it('is stable, so a retry overwrites rather than duplicating', () => {
    expect(objectKey(photo, { keyPrefix: 'listings/' })).toBe(objectKey(photo, { keyPrefix: 'listings/' }));
  });
});

describe('Token masking (§7 Settings)', () => {
  it('never shows the middle of a token', () => {
    const masked = maskToken('sk_live_abcdefghijklmnop');
    expect(masked.includes('abcdefghij')).toBeFalsy();
    expect(masked.startsWith('sk_')).toBeTruthy();
    expect(masked.endsWith('nop')).toBeTruthy();
  });

  it('fully masks a short token', () => {
    expect(maskToken('abc123')).toBe('••••••');
  });

  it('reports an unset token', () => {
    expect(maskToken('')).toBe('(not set)');
  });
});
