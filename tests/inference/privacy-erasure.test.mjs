/**
 * A privacy delete must actually remove the learner's recording from disk.
 *
 *   node --test tests/inference/privacy-erasure.test.mjs
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * "Delete my child's voice recordings" is the strongest promise this product makes, and the only
 * thing testing it was a mock that always agreed. `tests/api-parity/privacy-parity.test.mjs` points
 * platform-api at a stub returning
 *
 *     { deletedAudioObjectKeys: ["a/1.wav"], deletedMetadataObjectKeys: ["a/1.json"] }
 *
 * which proves platform-api collects the keys an upstream reports — a real and separate property —
 * and says nothing about whether a byte ever left a disk. `deleteAudioObjects` (server.mjs:131) had
 * no test at all: its only reference in the repository was its own call site.
 *
 * Measured before writing this, against a real service: the audio and its metadata ARE removed. So
 * the behaviour was correct and the evidence was absent, which is the state in which a regression
 * ships silently — the mock keeps agreeing.
 *
 * ── The second learner is not decoration ────────────────────────────────────────────────────────
 * A delete that erases everyone satisfies "the recording is gone" perfectly. Scope is half the
 * property, so a second learner in the SAME tenant is stored and asserted untouched.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "lib", "worker-compatibility-harness.mjs");
const root = join(here, "..", "..");

const KEY = "privacy-erasure-test-key";
const TENANT = "tenant-privacy-erasure";
const ERASED = "learner-asked-for-erasure";
const KEPT = "learner-who-did-not";

let ml;
let port;
let storageDir;
let stderr = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "privacy-erasure-"));
  port = await freePort();
  ml = spawn(process.execPath, [ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      ML_INFERENCE_PORT: String(port),
      AUDIO_STORAGE_DIR: storageDir,
      ML_API_KEY: KEY,
      ALLOW_INSECURE_DEFAULTS: "",
      ALLOW_INSECURE_SECRETS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  ml.stderr.on("data", (d) => {
    stderr += `[ml] ${d}`;
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`ml-inference never came up\n${stderr}`);
    await sleep(50);
  }
});

after(() => {
  ml?.kill("SIGKILL");
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
});

const post = (path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ml-api-key": KEY },
    body: JSON.stringify(body),
  });

/** Store one chunk the way the realtime gateway does, and return what landed on disk. */
async function storeChunk(learnerId, chunkId) {
  const res = await post("/v1/audio-chunks", {
    tenantId: TENANT,
    learnerId,
    sessionId: `session-${learnerId}`,
    chunkId,
    startMs: 0,
    endMs: 100,
    sampleRate: 16000,
    audioRetention: "teacher-review",
    audioBase64: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString("base64"),
  });
  assert.equal(res.status, 200, `storing audio for ${learnerId} failed: ${await res.text()}`);
  return filesFor(learnerId);
}

const filesFor = (learnerId) => {
  const dir = join(storageDir, "audio", "v1", TENANT, learnerId);
  if (!existsSync(dir)) return [];
  const collect = (path, prefix = "") => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? collect(join(path, entry.name), relative) : [relative];
  });
  return collect(dir).sort();
};

test("a privacy delete removes the learner's audio from disk, and only theirs", async () => {
  const erasedBefore = await storeChunk(ERASED, "chunk-erased");
  const keptBefore = await storeChunk(KEPT, "chunk-kept");

  // Without this the whole test passes on an empty directory: "the audio is gone" is trivially true
  // of audio that was never written. This is the assertion that stops it proving nothing.
  assert.ok(
    erasedBefore.some((f) => !f.endsWith(".meta.json")),
    `no audio payload was stored to begin with: ${JSON.stringify(erasedBefore)}`,
  );
  assert.ok(
    erasedBefore.some((f) => f.endsWith(".meta.json")),
    `no chunk metadata was stored to begin with: ${JSON.stringify(erasedBefore)}`,
  );
  assert.ok(keptBefore.length > 0, "the second learner's audio was never stored");

  const res = await post("/v1/privacy/delete", {
    tenantId: TENANT,
    learnerId: ERASED,
    traceId: "privacy-erasure-test",
  });
  // Read the body ONCE. `assert.equal(res.status, 200, await res.text())` evaluates its message
  // eagerly and consumes the stream, so the `res.json()` after it threw "Body has already been
  // read" — a test failure that looks like a service failure.
  const text = await res.text();
  assert.equal(res.status, 200, `the delete failed: ${text}`);
  const body = JSON.parse(text);

  // ── the recording is gone ───────────────────────────────────────────────────────────────────────
  const erasedAfter = filesFor(ERASED);
  assert.deepEqual(
    erasedAfter,
    [],
    `the learner asked for erasure and ${JSON.stringify(erasedAfter)} is still on disk. The database ` +
      `rows are only the derived records; this is the recording itself.`,
  );

  // ── and the response says so honestly ───────────────────────────────────────────────────────────
  // A delete that erased the files and reported nothing would leave platform-api's audit line
  // claiming zero keys erased — the durable record that erasure happened (privacy.rs) would be
  // empty, and a retry could not be told apart from a first attempt.
  assert.ok(
    Array.isArray(body.deletedAudioObjectKeys) && body.deletedAudioObjectKeys.length > 0,
    `the audio is gone but the response reports no deleted audio keys: ${JSON.stringify(body)}`,
  );
  assert.deepEqual(
    body.deletedMetadataObjectKeys,
    [],
    "v1 metadata is bound to each private object and must not be reported as a second object",
  );
  for (const key of body.deletedAudioObjectKeys) {
    assert.ok(
      key.startsWith(`audio/v1/${TENANT}/${ERASED}/`),
      `the response claims to have deleted ${key}, which is not this learner's: ${JSON.stringify(body)}`,
    );
  }

  // ── and nobody else's recording went with it ────────────────────────────────────────────────────
  assert.deepEqual(
    filesFor(KEPT),
    keptBefore,
    "another learner in the same tenant lost their recording to someone else's erasure request",
  );
});

test("erasing a learner twice is a no-op, not an error", async () => {
  // platform-api's `erase_ml_audio` fails CLOSED — a non-2xx aborts the whole privacy delete. If a
  // second call errored, a retry after any transient failure downstream would be impossible: the
  // audio would already be gone and the request would never be able to complete.
  await storeChunk("learner-twice", "chunk-twice");

  const first = await post("/v1/privacy/delete", {
    tenantId: TENANT,
    learnerId: "learner-twice",
    traceId: "twice-1",
  });
  assert.equal(first.status, 200, `the first delete failed: ${await first.text()}`);

  const second = await post("/v1/privacy/delete", {
    tenantId: TENANT,
    learnerId: "learner-twice",
    traceId: "twice-2",
  });
  assert.equal(
    second.status,
    200,
    `re-deleting an already-erased learner failed with ${second.status}, so a retried privacy ` +
      `request could never complete: ${await second.text()}`,
  );
  assert.deepEqual(filesFor("learner-twice"), [], "the audio came back");
});
