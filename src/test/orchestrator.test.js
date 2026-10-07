/**
 * Ingest queue draining — spec §6.1, rules 4 and 6.
 *
 * These pin one hardware fact: **the camera serves exactly one content request
 * at a time.** A second concurrent GET comes back `503 {"message":"Device
 * busy"}` in about 0.2s, verified against the real body:
 *
 *     two concurrent GETs of ?kind=main  ->  one 200 in 3.1s, one 503 in 0.2s
 *     four sequential GETs of ?kind=main ->  four 200s
 *
 * The queue used to start the next photo's prefetch *before* awaiting the
 * current photo's download. Those two raced, the prefetch usually won, and the
 * head of the queue 503'd on every cycle — ingest retried one photo forever and
 * never advanced. The prefetch was also overwritten before it could be
 * consumed, so its bytes were discarded and every photo downloaded twice.
 *
 * `drain()` drives real network calls, so the client here is a fake that
 * records concurrency; `processItem` is stubbed to isolate the transfer order
 * from the imaging worker and IndexedDB.
 */

import { describe, it, expect } from './runner.js';
import { Orchestrator } from '../app/orchestrator.js';

// Yielding by microtask, not setTimeout: a backgrounded tab clamps timers to
// ~1/second, which turned this suite into a 15-second wait. Microtasks
// interleave the in-flight downloads just as well and are not throttled.
const yieldTimes = async (n) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** A camera that 503s any request made while another is in flight. */
function fakeCamera({ failFirstDownloadOf = null } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, downloads: [], busyRejections: 0 };
  return {
    state,
    async download(sourcePath, kind, { signal } = {}) {
      state.downloads.push(sourcePath);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.inFlight > 1) {
          state.busyRejections++;
          const err = new Error('GET ... -> 503');
          err.status = 503;
          throw err;
        }
        // Stay open across several turns so a competing request would overlap.
        await yieldTimes(4);
        if (signal?.aborted) throw new Error('aborted');
        await yieldTimes(4);
        if (sourcePath === failFirstDownloadOf) {
          failFirstDownloadOf = null;
          throw new Error('GET ... -> 503');
        }
        return new Blob([sourcePath], { type: 'image/jpeg' });
      } finally {
        state.inFlight--;
      }
    },
  };
}

/** An orchestrator wired to a fake camera, with the imaging path stubbed out. */
function harness(keys, opts = {}) {
  const orch = new Orchestrator();
  const camera = fakeCamera(opts);
  orch.client = camera;
  orch.running = true;
  orch.abort = new AbortController();

  const processed = [];
  orch.processItem = async (item, original) => {
    // Simulate decode/barcode/encode: this is the window the prefetch is meant
    // to fill, and it must not be filled by this photo's own transfer.
    await yieldTimes(6);
    processed.push({ dcfKey: item.dcfKey, bytes: await original.text() });
  };

  for (const key of keys) {
    orch.queue.set(key, {
      dcfKey: key,
      sourcePath: `/ccapi/ver130/contents/card1/${key}`,
      sequence: Number(key.slice(-8, -4)),
      attempts: 0,
      lastError: null,
    });
  }
  return { orch, camera, processed };
}

const KEYS = ['100CANON/IMG_7150.JPG', '100CANON/IMG_7151.JPG', '100CANON/IMG_7152.JPG'];

describe('Ingest draining — one camera request at a time (§6.1)', () => {
  it('never has two downloads in flight', async () => {
    const { orch, camera } = harness(KEYS);
    await orch.drain();
    expect(camera.state.maxInFlight).toBe(1, 'a second concurrent request is a 503 "Device busy"');
    expect(camera.state.busyRejections).toBe(0);
  });

  it('drains the whole queue instead of stalling on the head', async () => {
    const { orch, processed } = harness(KEYS);
    await orch.drain();
    expect(processed.map((p) => p.dcfKey)).toEqual(KEYS);
    expect(orch.queue.size).toBe(0);
  });

  it('downloads each photo exactly once — the prefetch is consumed, not discarded', async () => {
    const { orch, camera } = harness(KEYS);
    await orch.drain();
    expect(camera.state.downloads.length).toBe(KEYS.length, 'a re-download means the prefetch was wasted');
  });

  it('processes the bytes it downloaded for that photo', async () => {
    const { orch, processed } = harness(KEYS);
    await orch.drain();
    for (const entry of processed) {
      expect(entry.bytes).toContain(entry.dcfKey, 'prefetched bytes went to the wrong photo');
    }
  });

  it('still serialises when the head fails and the queue is retried', async () => {
    const { orch, camera, processed } = harness(KEYS, { failFirstDownloadOf: `/ccapi/ver130/contents/card1/${KEYS[0]}` });
    await orch.drain();           // head fails; rule 4 stops the drain
    expect(processed.length).toBe(0, 'a failed head must not let later photos through');
    await orch.drain();           // next cycle retries it
    expect(camera.state.maxInFlight).toBe(1, 'the retry raced the prefetch left over from the failed cycle');
    expect(camera.state.busyRejections).toBe(0);
    expect(processed.map((p) => p.dcfKey)).toEqual(KEYS);
  });

  it('leaves nothing in flight after stop()', async () => {
    const { orch, camera } = harness(KEYS);
    await orch.drain();
    orch.abort.abort();
    orch.cancelPrefetch();
    expect(orch.prefetch).toBe(null);
    expect(camera.state.inFlight).toBe(0);
  });
});
