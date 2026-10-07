/**
 * Grouping reducer — spec §2.3, and the §8 checklist:
 * SKU flush, 30/35 thresholds, gap boundaries (100 missing reported, 101
 * ignored), high-water mark not rewinding, dedup.
 */

import { describe, it, expect } from './runner.js';
import { initialState, reduce, reduceAll, pendingSeverity } from '../core/grouping.js';

const key = (n) => `100CANON/IMG_${String(n).padStart(4, '0')}.JPG`;

/** Synthetic event stream: frames `from..to`, with an optional SKU on the last. */
function frames(from, to, sku = null) {
  const events = [];
  for (let n = from; n <= to; n++) {
    events.push({ type: 'PHOTO', dcfKey: key(n), sequence: n, sku: n === to ? sku : null });
  }
  return events;
}

const effectsOf = (all, type) => all.filter((e) => e.type === type);

describe('Grouping: SKU flush (§2.3)', () => {
  it('assigns the entire pending group, including the label photo', () => {
    const { state, effects } = reduceAll(initialState(), frames(1, 5, '0000646'));
    const flush = effectsOf(effects, 'FLUSH');
    expect(flush).toHaveLength(1);
    expect(flush[0].sku).toBe('0000646');
    expect(flush[0].keys).toHaveLength(5, 'the label photo is part of its own group');
    expect(flush[0].keys[4]).toBe(key(5));
    expect(state.pending).toHaveLength(0, 'pending resets after a flush');
  });

  it('starts a fresh group after a flush', () => {
    let s = initialState();
    ({ state: s } = reduceAll(s, frames(1, 3, '0000646')));
    const r = reduceAll(s, frames(4, 6, '0000647'));
    const flush = effectsOf(r.effects, 'FLUSH')[0];
    expect(flush.keys).toHaveLength(3);
    expect(flush.keys[0]).toBe(key(4));
  });

  it('flushes on the very first photo if it carries a SKU', () => {
    const { effects } = reduce(initialState(), { type: 'PHOTO', dcfKey: key(1), sequence: 1, sku: '1234567' });
    expect(effectsOf(effects, 'FLUSH')[0].keys).toEqual([key(1)]);
  });
});

describe('Grouping: stale and evacuate thresholds (§2.3)', () => {
  it('warns at exactly 30, once', () => {
    const { effects } = reduceAll(initialState(), frames(1, 34));
    const warnings = effectsOf(effects, 'STALE_WARNING');
    expect(warnings).toHaveLength(1, 'the warning must not repeat every photo');
    expect(warnings[0].count).toBe(30);
  });

  it('does not warn at 29', () => {
    const { effects } = reduceAll(initialState(), frames(1, 29));
    expect(effectsOf(effects, 'STALE_WARNING')).toHaveLength(0);
  });

  it('auto-evacuates at 35 and resets', () => {
    const { state, effects } = reduceAll(initialState(), frames(1, 35));
    const evac = effectsOf(effects, 'EVACUATE');
    expect(evac).toHaveLength(1);
    expect(evac[0].keys).toHaveLength(35);
    expect(state.pending).toHaveLength(0);
  });

  it('does not evacuate at 34', () => {
    const { state, effects } = reduceAll(initialState(), frames(1, 34));
    expect(effectsOf(effects, 'EVACUATE')).toHaveLength(0);
    expect(state.pending).toHaveLength(34);
  });

  it('re-arms the stale warning for the next group', () => {
    const { effects } = reduceAll(initialState(), [...frames(1, 35), ...frames(36, 70)]);
    expect(effectsOf(effects, 'STALE_WARNING')).toHaveLength(2);
    expect(effectsOf(effects, 'EVACUATE')).toHaveLength(2);
  });

  it('a SKU before the threshold prevents evacuation', () => {
    const { effects } = reduceAll(initialState(), frames(1, 34, '0000646'));
    expect(effectsOf(effects, 'EVACUATE')).toHaveLength(0);
    expect(effectsOf(effects, 'FLUSH')).toHaveLength(1);
  });

  it('honours custom thresholds', () => {
    const { effects } = reduceAll(initialState({ staleWarning: 3, autoEvacuate: 5 }), frames(1, 5));
    expect(effectsOf(effects, 'STALE_WARNING')[0].count).toBe(3);
    expect(effectsOf(effects, 'EVACUATE')).toHaveLength(1);
  });

  it('maps counts to UI severity', () => {
    expect(pendingSeverity(29)).toBe('normal');
    expect(pendingSeverity(30)).toBe('warning');
    expect(pendingSeverity(34)).toBe('warning');
    expect(pendingSeverity(35)).toBe('critical');
  });
});

describe('Grouping: sequence gaps (§2.3)', () => {
  it('reports a single missing frame', () => {
    let s = initialState();
    ({ state: s } = reduce(s, { type: 'PHOTO', dcfKey: key(10), sequence: 10 }));
    const { effects } = reduce(s, { type: 'PHOTO', dcfKey: key(12), sequence: 12 });
    const gap = effectsOf(effects, 'GAP')[0];
    expect(gap.missing).toEqual([key(11)]);
    expect(gap.from).toBe(11);
    expect(gap.to).toBe(11);
  });

  it('derives missing keys from the reported path, not from currentdirectory', () => {
    let s = initialState();
    ({ state: s } = reduce(s, { type: 'PHOTO', dcfKey: '101CANON/IMG_0200.JPG', sequence: 200 }));
    const { effects } = reduce(s, { type: 'PHOTO', dcfKey: '101CANON/IMG_0203.JPG', sequence: 203 });
    expect(effectsOf(effects, 'GAP')[0].missing).toEqual([
      '101CANON/IMG_0201.JPG',
      '101CANON/IMG_0202.JPG',
    ]);
  });

  it('reports a gap of exactly 100 missing frames', () => {
    let s = initialState();
    ({ state: s } = reduce(s, { type: 'PHOTO', dcfKey: key(1), sequence: 1 }));
    const { effects } = reduce(s, { type: 'PHOTO', dcfKey: key(102), sequence: 102 });
    const gap = effectsOf(effects, 'GAP')[0];
    expect(gap).toBeTruthy('100 missing is the inclusive upper bound');
    expect(gap.missing).toHaveLength(100);
  });

  it('ignores a gap of 101 as a new shooting session', () => {
    let s = initialState();
    ({ state: s } = reduce(s, { type: 'PHOTO', dcfKey: key(1), sequence: 1 }));
    const { effects } = reduce(s, { type: 'PHOTO', dcfKey: key(103), sequence: 103 });
    expect(effectsOf(effects, 'GAP')).toHaveLength(0);
    expect(effectsOf(effects, 'SESSION_RESET')[0].missing).toBe(101);
  });

  it('reports nothing for consecutive frames', () => {
    const { effects } = reduceAll(initialState(), frames(1, 10));
    expect(effectsOf(effects, 'GAP')).toHaveLength(0);
  });

  it('reports no gap on the first photo of a session', () => {
    const { effects } = reduce(initialState(), { type: 'PHOTO', dcfKey: key(5000), sequence: 5000 });
    expect(effectsOf(effects, 'GAP')).toHaveLength(0);
  });
});

describe('Grouping: high-water mark (§2.3)', () => {
  it('never rewinds on an out-of-order lower frame number', () => {
    let s = initialState();
    ({ state: s } = reduce(s, { type: 'PHOTO', dcfKey: key(500), sequence: 500 }));
    const r = reduce(s, { type: 'PHOTO', dcfKey: '101CANON/IMG_0002.JPG', sequence: 2 });
    expect(r.state.lastSequence).toBe(500, 'a card swap must not rewind the baseline');
    expect(effectsOf(r.effects, 'GAP')).toHaveLength(0, 'and must not report a false gap');
  });

  it('does not flood the log after a card swap', () => {
    // Frames 1..5 from a fresh card arriving after frame 500 of the old one.
    let s = initialState();
    ({ state: s } = reduce(s, { type: 'PHOTO', dcfKey: key(500), sequence: 500 }));
    const swap = [];
    for (let n = 1; n <= 5; n++) {
      swap.push({ type: 'PHOTO', dcfKey: `101CANON/IMG_${String(n).padStart(4, '0')}.JPG`, sequence: n });
    }
    const r = reduceAll(s, swap);
    expect(effectsOf(r.effects, 'GAP')).toHaveLength(0);
    expect(r.state.lastSequence).toBe(500);
  });

  it('advances on a higher frame number', () => {
    let s = initialState();
    ({ state: s } = reduce(s, { type: 'PHOTO', dcfKey: key(10), sequence: 10 }));
    ({ state: s } = reduce(s, { type: 'PHOTO', dcfKey: key(11), sequence: 11 }));
    expect(s.lastSequence).toBe(11);
  });

  it('tolerates photos with no parseable frame number', () => {
    let s = initialState();
    ({ state: s } = reduce(s, { type: 'PHOTO', dcfKey: '100CANON/odd.jpg', sequence: null }));
    expect(s.lastSequence).toBeNull();
    expect(s.pending).toHaveLength(1);
  });
});

describe('Grouping: dedup (§2.3)', () => {
  it('never reprocesses a photo already handled', () => {
    let s = initialState();
    ({ state: s } = reduce(s, { type: 'PHOTO', dcfKey: key(1), sequence: 1 }));
    const r = reduce(s, { type: 'PHOTO', dcfKey: key(1), sequence: 1 });
    expect(r.effects).toEqual([{ type: 'DUPLICATE', dcfKey: key(1) }]);
    expect(r.state.pending).toHaveLength(1, 'the duplicate must not join the group');
    expect(r.state).toBe(s, 'state is returned unchanged');
  });

  it('remembers photos from flushed groups', () => {
    let s = initialState();
    ({ state: s } = reduceAll(s, frames(1, 3, '0000646')));
    const r = reduce(s, { type: 'PHOTO', dcfKey: key(2), sequence: 2 });
    expect(r.effects[0].type).toBe('DUPLICATE');
  });

  it('a duplicate SKU photo does not re-flush the group', () => {
    let s = initialState();
    ({ state: s } = reduceAll(s, frames(1, 3, '0000646')));
    ({ state: s } = reduceAll(s, frames(4, 5)));
    const r = reduce(s, { type: 'PHOTO', dcfKey: key(3), sequence: 3, sku: '0000646' });
    expect(effectsOf(r.effects, 'FLUSH')).toHaveLength(0);
    expect(r.state.pending).toHaveLength(2);
  });
});

describe('Grouping: purity', () => {
  it('does not mutate the input state', () => {
    const s = initialState();
    const before = { pending: [...s.pending], lastSequence: s.lastSequence, seen: s.seen.size };
    reduce(s, { type: 'PHOTO', dcfKey: key(1), sequence: 1, sku: '1234567' });
    expect(s.pending).toEqual(before.pending);
    expect(s.lastSequence).toBe(before.lastSequence);
    expect(s.seen.size).toBe(before.seen);
  });

  it('is deterministic: the same stream yields the same effects', () => {
    const stream = [...frames(1, 12), ...frames(14, 20, '0000646')];
    const a = reduceAll(initialState(), stream);
    const b = reduceAll(initialState(), stream);
    expect(a.effects).toEqual(b.effects);
    expect(a.state.lastSequence).toBe(b.state.lastSequence);
  });

  it('rejects unknown event types', async () => {
    await expect(() => reduce(initialState(), { type: 'NOPE' })).toThrow();
  });
});
