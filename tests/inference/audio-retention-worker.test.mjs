import assert from "node:assert/strict";
import test from "node:test";

import { createAudioRetentionWorker } from "../../server/src/inference/audio-retention.mjs";

test("the retention worker never overlaps sweeps and reports only bounded counts", async () => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const retention = createAudioRetentionWorker({
    audioObjectStore: {},
    intervalMs: 60_000,
    sweep: async ({ signal }) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      assert.equal(signal.aborted, false);
      await blocked;
      active -= 1;
      return { scannedCount: 12, deletedCount: 3, unreadableCount: 1 };
    },
    log: () => {},
  });

  await retention.start();
  const first = retention.runNow();
  const second = retention.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(maximumActive, 1);
  release();
  assert.deepEqual(await first, { scannedCount: 12, deletedCount: 3, unreadableCount: 1 });
  assert.deepEqual(await second, { scannedCount: 12, deletedCount: 3, unreadableCount: 1 });
  assert.deepEqual(retention.lastResult, { scannedCount: 12, deletedCount: 3, unreadableCount: 1 });
  assert.equal(await retention.stop({ timeoutMs: 100 }), true);
});

test("worker shutdown aborts one active retention sweep within its bound", async () => {
  let observedAbort = false;
  const retention = createAudioRetentionWorker({
    audioObjectStore: {},
    intervalMs: 60_000,
    sweep: ({ signal }) => new Promise((resolve, reject) => {
      const abort = () => {
        observedAbort = true;
        reject(signal.reason ?? new Error("retention aborted"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
    log: () => {},
  });

  await retention.start();
  const active = retention.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await retention.stop({ timeoutMs: 100 }), true);
  await assert.rejects(active, /retention/);
  assert.equal(observedAbort, true);
  assert.equal(retention.isRunning, false);
});
