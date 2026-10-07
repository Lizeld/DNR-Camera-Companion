/**
 * Grouping state machine — spec §2.3. Ported from the original `scheduler.py`.
 *
 * Pure and deterministic: `reduce(state, event) -> { state, effects }`.
 * No I/O, no clock, no randomness. Everything the orchestrator must *do* comes
 * back as an effect, so this file can be unit-tested with synthetic streams.
 */

import { folderOf, keyForSequence } from './dcf.js';

export const DEFAULT_THRESHOLDS = Object.freeze({
  /** Warn the operator that the pending group is getting long. */
  staleWarning: 30,
  /** Move the pending group to the review bucket and reset. */
  autoEvacuate: 35,
  /**
   * Largest run of missing frames still treated as a gap. Anything bigger is a
   * new shooting session (card swap, new folder) and is ignored silently.
   */
  maxGap: 100,
});

/** @returns fresh reducer state. */
export function initialState(thresholds = {}) {
  return {
    /** DCF keys awaiting a SKU, in arrival order. */
    pending: [],
    /** High-water mark of Canon frame numbers. Never rewinds (§2.3). */
    lastSequence: null,
    /** Every key ever accepted — the dedup set. */
    seen: new Set(),
    /** True once the stale warning has fired for the current pending group. */
    staleWarned: false,
    thresholds: { ...DEFAULT_THRESHOLDS, ...thresholds },
  };
}

/** Rehydrate state after a reload. `seen` and `lastSequence` come from IndexedDB. */
export function restoreState({ pending = [], lastSequence = null, seen = [], thresholds = {} } = {}) {
  const s = initialState(thresholds);
  s.pending = [...pending];
  s.lastSequence = lastSequence;
  s.seen = new Set(seen);
  s.staleWarned = s.pending.length >= s.thresholds.staleWarning;
  return s;
}

/**
 * The only event this machine accepts.
 *
 * @typedef {Object} PhotoEvent
 * @property {'PHOTO'} type
 * @property {string} dcfKey            "100CANON/IMG_0017.JPG"
 * @property {number|null} [sequence]   Canon frame number, if parseable
 * @property {string|null} [sku]        7-digit SKU read from this photo, or null
 */

/**
 * Effects, in the order the orchestrator should apply them:
 *
 *  { type:'DUPLICATE',      dcfKey }                  already handled — drop it
 *  { type:'GAP',            missing:string[], from, to }
 *  { type:'SESSION_RESET',  missing:number, from, to } gap > maxGap, ignored
 *  { type:'ACCEPTED',       dcfKey }
 *  { type:'STALE_WARNING',  count }
 *  { type:'FLUSH',          sku, keys:string[] }      release group for upload
 *  { type:'EVACUATE',       keys:string[] }           move to review bucket
 */

/**
 * @param {ReturnType<initialState>} state
 * @param {PhotoEvent} event
 * @returns {{ state: typeof state, effects: object[] }}
 */
export function reduce(state, event) {
  if (event.type !== 'PHOTO') {
    throw new Error(`grouping: unknown event type ${event.type}`);
  }

  const effects = [];
  const { dcfKey, sequence = null, sku = null } = event;

  // --- Dedup (§2.3). Never reprocess a photo already handled. -------------
  if (state.seen.has(dcfKey)) {
    return { state, effects: [{ type: 'DUPLICATE', dcfKey }] };
  }

  const next = {
    ...state,
    pending: [...state.pending, dcfKey],
    seen: new Set(state.seen).add(dcfKey),
  };

  // --- Sequence gap detection (§2.3) --------------------------------------
  // Only a forward jump can be a gap. A lower number is an out-of-order
  // arrival and must never rewind the high-water mark, or a card swap floods
  // the log with false gaps.
  if (sequence !== null) {
    if (state.lastSequence !== null && sequence > state.lastSequence) {
      const missingCount = sequence - state.lastSequence - 1;
      if (missingCount >= 1 && missingCount <= state.thresholds.maxGap) {
        const missing = [];
        for (let n = state.lastSequence + 1; n < sequence; n++) {
          // Derive the folder from the reported path itself, never from
          // `currentdirectory` — that field is only present on full-state
          // polls (§3.3, §6.1 step 3).
          missing.push(keyForSequence(dcfKey, n));
        }
        effects.push({
          type: 'GAP',
          missing,
          from: state.lastSequence + 1,
          to: sequence - 1,
          folder: folderOf(dcfKey),
        });
      } else if (missingCount > state.thresholds.maxGap) {
        effects.push({
          type: 'SESSION_RESET',
          missing: missingCount,
          from: state.lastSequence + 1,
          to: sequence - 1,
        });
      }
    }
    next.lastSequence = Math.max(state.lastSequence ?? -Infinity, sequence);
    if (!Number.isFinite(next.lastSequence)) next.lastSequence = sequence;
  }

  effects.push({ type: 'ACCEPTED', dcfKey });

  // --- SKU flush (§2.3) ---------------------------------------------------
  // The entire pending group, *including* the label photo, is assigned the SKU
  // and released; the pending group resets.
  if (sku) {
    effects.push({ type: 'FLUSH', sku, keys: next.pending });
    next.pending = [];
    next.staleWarned = false;
    return { state: next, effects };
  }

  // --- Stale / evacuate thresholds ----------------------------------------
  const count = next.pending.length;
  if (count >= next.thresholds.autoEvacuate) {
    effects.push({ type: 'EVACUATE', keys: next.pending });
    next.pending = [];
    next.staleWarned = false;
    return { state: next, effects };
  }
  if (count >= next.thresholds.staleWarning && !next.staleWarned) {
    effects.push({ type: 'STALE_WARNING', count });
    next.staleWarned = true;
  }

  return { state: next, effects };
}

/**
 * Convenience for tests and re-sync: fold a whole stream.
 * @returns {{ state: object, effects: object[] }}
 */
export function reduceAll(state, events) {
  const all = [];
  let s = state;
  for (const e of events) {
    const r = reduce(s, e);
    s = r.state;
    all.push(...r.effects);
  }
  return { state: s, effects: all };
}

/** UI severity for the pending counter (§7 Status). */
export function pendingSeverity(count, thresholds = DEFAULT_THRESHOLDS) {
  if (count >= thresholds.autoEvacuate) return 'critical';
  if (count >= thresholds.staleWarning) return 'warning';
  return 'normal';
}
