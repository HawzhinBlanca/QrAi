// P5.4 long-audio: what does a real-length recitation cost transcribeSession?
//
// The concern is concrete: it readFileSync's every chunk and Buffer.concat's the whole session in
// one go. Both are synchronous, so the cost lands on the event loop — in a service that is also
// serving every other learner's analysis.
//
// Measured against a loopback ASR, so no torch and no model download.
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const asr = createServer((req, res) => {
  let n = 0;
  req.on("data", (c) => (n += c.length));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      words: [{ word: "x", start: 0.01, end: 0.02, probability: 1 }],
      text: "x",
      bytesReceived: n,
      modelVersion: "declared-long-audio-fixture",
      modelAttribution: {
        schemaVersion: 1,
        primaryComponent: "asr",
        components: [{
          component: "asr",
          status: "active",
          implementationId: "declared-long-audio-fixture",
          artifactDigest: `sha256:${"a".repeat(64)}`,
          datasetVersion: "declared-fixture",
          analysisBasis: "acoustic",
          calibratorId: null,
        }],
      },
    }));
  });
});
await new Promise((r) => asr.listen(0, "127.0.0.1", r));

const storage = mkdtempSync(join(tmpdir(), "longaudio-"));
process.env.AUDIO_STORAGE_DIR = storage;
process.env.ASR_SERVICE_URL = `http://127.0.0.1:${asr.address().port}`;
const { transcribeSession } = await import("../server/src/inference/runtime.mjs");

const SAMPLE_RATE = 16000;
const CHUNK_MS = 100;
const BYTES_PER_CHUNK = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000; // pcm16 mono

function seed(tenant, minutes) {
  const chunks = (minutes * 60 * 1000) / CHUNK_MS;
  const dir = join(storage, tenant, "learner-1");
  mkdirSync(dir, { recursive: true });
  const payload = Buffer.alloc(BYTES_PER_CHUNK, 0x11);
  for (let i = 0; i < chunks; i++) {
    const id = `c${String(i).padStart(6, "0")}`;
    writeFileSync(join(dir, `${id}.bin`), payload);
    writeFileSync(
      join(dir, `${id}.meta.json`),
      JSON.stringify({
        tenantId: tenant, learnerId: "learner-1", sessionId: "s1", chunkId: id,
        startMs: i * CHUNK_MS, endMs: (i + 1) * CHUNK_MS, sampleRate: SAMPLE_RATE,
      }),
    );
  }
  return chunks;
}

// A ticker that should fire every 10ms. However long it actually goes without firing is how long
// the event loop was blocked — i.e. how long every OTHER learner's request waited.
function watchEventLoop() {
  let worst = 0;
  let last = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  t.unref();
  return { stop: () => { clearInterval(t); return worst; } };
}

console.log("minutes  chunks   audioMB   elapsed   peakRSS   worst event-loop stall");
for (const minutes of [1, 5, 15]) {
  const tenant = `t-${minutes}m`;
  const chunks = seed(tenant, minutes);
  if (global.gc) global.gc();
  const rssBefore = process.memoryUsage().rss;
  const loop = watchEventLoop();
  const t0 = performance.now();
  const res = await transcribeSession({
    tenantId: tenant, learnerId: "learner-1", sessionId: "s1",
    consent: { externalAsrProcessing: true, guardianApproved: true },
  });
  const elapsed = performance.now() - t0;
  const stall = loop.stop();
  const peak = process.memoryUsage().rss;
  const mb = (chunks * BYTES_PER_CHUNK) / 1e6;
  console.log(
    `${String(minutes).padStart(5)}  ${String(chunks).padStart(7)}  ` +
    `${mb.toFixed(1).padStart(7)}  ${(elapsed / 1000).toFixed(2).padStart(7)}s  ` +
    `${((peak - rssBefore) / 1e6).toFixed(0).padStart(6)}MB  ${stall.toFixed(0).padStart(8)}ms` +
    (res.transcribed ? "" : "   [NOT TRANSCRIBED]"),
  );
}
asr.close();
