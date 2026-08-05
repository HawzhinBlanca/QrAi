// A stored chunk being replaced by DIFFERENT audio must be loud.
//
// ── Why this is worth a test of its own ─────────────────────────────────────────────────────────
// Re-writing a chunk id is normal and safe when it is the same audio: the ML forwarder retries a
// POST up to three times, so one whose response was lost arrives again. That path has to stay
// silent or every session would cry wolf.
//
// A conflicting write is a different event, and it used to be indistinguishable — the file was
// replaced, 200 came back, and nothing said a child's recitation had been overwritten. That silence
// is what let the reconnect chunk-id collision destroy half of a learner's session undetected for
// as long as it existed: the gateway restarted its per-connection counter, minted ids that already
// named stored audio, and storage obligingly replaced it.
//
// The gateway no longer does that, so this should never fire in practice — which is precisely why
// it must fire if it ever does. A guard for a bug that is currently fixed is the guard that catches
// its return.
//
// Spawned as a real process (like rate-limit.test.mjs) because the behaviour lives in the request
// path and the assertion is about what reaches stderr and the audit log.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8393;
const KEY = "chunk-overwrite-test-key";
const TENANT = "t-overwrite";

let child;
let storage;
let stderr = "";

const b64 = (s) => Buffer.from(s).toString("base64");

before(async () => {
  storage = mkdtempSync(join(tmpdir(), "ml-overwrite-test-"));
  child = spawn(process.execPath, [join(here, "server.mjs")], {
    env: {
      ...process.env,
      ML_INFERENCE_PORT: String(PORT),
      ML_API_KEY: KEY,
      AUDIO_STORAGE_DIR: storage,
      ALLOW_INSECURE_DEFAULTS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => (stderr += d.toString()));
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("ml-inference did not start");
});

after(() => child?.kill());

async function store({ audio, startMs, expect = 200 }) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/audio-chunks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ml-api-key": KEY },
    body: JSON.stringify({
      tenantId: TENANT,
      learnerId: "l1",
      sessionId: "s1",
      chunkId: "c1",
      sampleRate: 16000,
      startMs,
      endMs: startMs + 100,
      audioBase64: b64(audio),
    }),
  });
  assert.equal(res.status, expect, `expected ${expect}, got ${res.status}`);
  return res;
}

/** The bytes actually on disk for the fixture chunk, or null. */
function storedBytes() {
  const p = join(storage, TENANT, "l1", "c1.bin");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

const overwriteWarnings = () =>
  stderr.split("\n").filter((l) => l.includes("REFUSED: audio chunk would be overwritten")).length;

test("a retry of the SAME audio is silent — it is the normal case, not an incident", async () => {
  await store({ audio: "AAAA", startMs: 0 });
  await store({ audio: "AAAA", startMs: 0 });
  assert.equal(
    overwriteWarnings(),
    0,
    "an idempotent retry warned about an overwrite; every session would cry wolf",
  );
});

test("replacing a chunk with DIFFERENT audio is REFUSED, and nothing is written", async () => {
  assert.equal(storedBytes(), "AAAA", "precondition: the original audio is stored");

  const res = await store({ audio: "ZZZZ", startMs: 5000, expect: 409 });
  const body = await res.json();
  assert.match(body.error, /refusing to replace a stored recitation/);

  // The point of refusing rather than reporting: the learner's recitation is still there.
  assert.equal(
    storedBytes(),
    "AAAA",
    "the stored recitation was replaced anyway — the check must run BEFORE the write",
  );

  assert.equal(overwriteWarnings(), 1, "the refusal was silent");

  const line = stderr.split("\n").find((l) => l.includes("REFUSED: audio chunk would be overwritten"));
  const entry = JSON.parse(line);
  assert.equal(entry.level, "error");
  assert.equal(entry.chunkId, "c1");
  assert.equal(entry.conflict.reason, "different audio");
  // The hashes are what make the report actionable — "something changed" is not a diagnosis.
  assert.notEqual(entry.conflict.storedSha256, entry.conflict.incomingSha256);
  assert.equal(entry.conflict.storedStartMs, 0);
  assert.equal(entry.conflict.incomingStartMs, 5000);
});

test("and it lands in the tenant's durable audit log, not only in stderr", () => {
  // stderr is where an operator looks during an incident; the audit log is what survives to answer
  // "was this learner's recording ever replaced?" after the process is gone.
  const auditPath = join(storage, "audit-log", `${TENANT}.jsonl`);
  assert.ok(existsSync(auditPath), "no audit file for the tenant");
  const events = readFileSync(auditPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.action === "audio.chunk.overwrite-refused");
  assert.equal(events.length, 1, "the refusal is not in the durable audit trail");
  assert.equal(events[0].subjectId ?? events[0].subject_id ?? events[0].chunkId, "c1");
});

// ── A chunk's own span: unknown must not read as zero ─────────────────────────────────────────────
//
// `storeAudioChunk` recorded `startMs: requestBody.startMs ?? 0`. That is the same fail-open the
// alignment writers had (#360, #361) — and here it is worse, because **0 is a legitimate value**:
// the first chunk of every session genuinely starts at 0ms. So "we do not know where this chunk
// sits in the recording" and "this chunk sits at the beginning" were written identically, and no
// reader could ever tell them apart.
//
// That span is what a tajweed finding would need to locate its audio. A chunk claiming 0ms-to-0ms
// is unlocatable, and claiming it silently is how the gap stays invisible.
//
// The audio itself is still stored either way. Refusing the chunk would DISCARD a learner's
// recording that consent covers — the opposite of what this is for. Only the claim is withheld.

async function storeRaw(body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/audio-chunks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ml-api-key": KEY },
    body: JSON.stringify({ tenantId: TENANT, learnerId: "l1", sampleRate: 16000, ...body }),
  });
  return res;
}

function storedMeta(chunkId) {
  const p = join(storage, TENANT, "l1", `${chunkId}.meta.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

test("a chunk with NO timings records an unknown span, not 0 to 0", async () => {
  const res = await storeRaw({
    sessionId: "s-span",
    chunkId: "c-nospan",
    audioBase64: b64("audio-without-timings"),
  });
  assert.equal(res.status, 200, "the audio must still be stored — consent covers it either way");

  const meta = storedMeta("c-nospan");
  assert.ok(meta, "chunk metadata was not written");
  assert.equal(
    meta.startMs,
    null,
    "a chunk with no timings claims startMs 0, which is indistinguishable from the FIRST chunk of " +
      "a session — the one case where 0 is real. Unknown must be its own value.",
  );
  assert.equal(meta.endMs, null, "same for endMs");

  // And the audio really is on disk: withholding the claim must not withhold the recording.
  assert.ok(
    existsSync(join(storage, TENANT, "l1", "c-nospan.bin")),
    "the recording was dropped along with its unusable span",
  );
});

test("a chunk with a REAL span records it verbatim — the control", async () => {
  // Without this, the assertions above are satisfied by nulling every span, which would make every
  // chunk unlocatable and look like a pass.
  const res = await storeRaw({
    sessionId: "s-span",
    chunkId: "c-span",
    startMs: 640,
    endMs: 1230,
    audioBase64: b64("audio-with-timings"),
  });
  assert.equal(res.status, 200);

  const meta = storedMeta("c-span");
  assert.equal(meta.startMs, 640);
  assert.equal(meta.endMs, 1230);
});

test("startMs 0 with a real endMs is kept — 0 is a legitimate start", async () => {
  // The case the `?? 0` default made unreadable. The first chunk of a session starts at 0ms and
  // must stay 0, not become null: this is why "unknown" needed a different value rather than a
  // stricter one.
  const res = await storeRaw({
    sessionId: "s-span",
    chunkId: "c-zero-start",
    startMs: 0,
    endMs: 500,
    audioBase64: b64("first-chunk"),
  });
  assert.equal(res.status, 200);
  assert.equal(storedMeta("c-zero-start").startMs, 0, "a genuine 0ms start was discarded as unknown");
});

test("a zero-length or inverted chunk span is also unknown, not taken at face value", async () => {
  // Added because a mutation exposed the gap: loosening `chunkSpan` to drop `endMs > startMs` ran
  // GREEN against the three tests above. They probed "no timings", "a real span" and "a genuine 0ms
  // start" — none of which is a span that is PRESENT but unusable. A test that cannot fail for a
  // whole class of input is not covering it.
  for (const [label, startMs, endMs] of [
    ["zero-length", 500, 500],
    ["inverted", 900, 400],
    ["negative start", -1, 100],
    ["non-integer", "abc", 100],
    ["fractional", 1.5, 100],
  ]) {
    const chunkId = `c-bad-${label.replace(/[^a-z]/g, "")}`;
    const res = await storeRaw({
      sessionId: "s-span",
      chunkId,
      startMs,
      endMs,
      audioBase64: b64(`audio-${label}`),
    });
    assert.equal(res.status, 200, `${label}: the recording must still be stored`);

    const meta = storedMeta(chunkId);
    assert.equal(meta.startMs, null, `${label} was recorded as a real startMs (${meta.startMs})`);
    assert.equal(meta.endMs, null, `${label} was recorded as a real endMs (${meta.endMs})`);
  }
});
