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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  // server.mjs captures AUDIO_STORAGE_DIR at MODULE LOAD, and several tests below import it (for
  // clampAuditLimit, runRetentionSweep). Set it HERE, before any of them: setting it inside a test
  // is too late once another test has already imported and cached the module, and the sweep then
  // runs against a different directory and asserts nothing.
  process.env.AUDIO_STORAGE_DIR = storageDir;
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

test("a learner's privacy export contains only their own audit trail, never another learner's", async () => {
  // Scope again, on the OTHER privacy right. `exportPrivacy` filtered its audit lists by tenant
  // while the export itself is per-learner, so a right-of-access packet handed to one learner
  // carried every other learner's rows in the same tenant.
  //
  // The two rows this stages are the worst case rather than a generic one: `privacy.export.requested`
  // and `privacy.delete.requested` both key subjectId to the LEARNER, so what leaked was another
  // child's identifier attached to the fact that they had asked to be erased. GDPR Art. 15(4) — a
  // copy provided under the right of access "shall not adversely affect the rights and freedoms of
  // others" — and erasure means their id should be getting rarer, not copied into someone else's file.
  const OTHER = "learner-with-their-own-privacy-history";
  const SUBJECT = "learner-requesting-an-export";

  // The other learner exercises both privacy rights, writing two audit rows that name them.
  await post("/v1/privacy/export", { tenantId: TENANT, learnerId: OTHER, traceId: "other-export" });
  await post("/v1/privacy/delete", { tenantId: TENANT, learnerId: OTHER, traceId: "other-delete" });

  const res = await post("/v1/privacy/export", {
    tenantId: TENANT,
    learnerId: SUBJECT,
    traceId: "subject-export",
  });
  // Read the body ONCE: an `await res.text()` inside an assertion message is evaluated eagerly and
  // would consume the stream before res.json() could run.
  const raw = await res.text();
  assert.equal(res.status, 200, `the export failed: ${raw}`);
  const body = JSON.parse(raw);

  // Without this the test passes on an export that returns nothing at all — "no other learner's
  // rows" is trivially true of an empty list, and would stay true if scoping were implemented by
  // dropping the audit trail entirely.
  assert.ok(
    body.auditEvents.some((e) => e.subjectId === SUBJECT || e.learnerId === SUBJECT),
    `the export carried none of the subject's OWN audit rows, so this proves nothing: ${JSON.stringify(body.auditEvents)}`,
  );

  const foreign = body.auditEvents.filter(
    (e) => e.subjectId === OTHER || e.learnerId === OTHER,
  );
  assert.deepEqual(
    foreign,
    [],
    `another learner's audit rows were disclosed in this learner's export: ${JSON.stringify(foreign, null, 2)}`,
  );

  // Belt and braces: the id must not survive anywhere in the payload, including the two derived
  // lists that were filtered the same tenant-wide way.
  assert.ok(
    !JSON.stringify(body).includes(OTHER),
    "another learner's id appears somewhere in the export payload",
  );
});

test("erasure removes a file of an unrecognised type, and reports it as neither audio nor metadata", async () => {
  // The erasure loop used to unlink only `.bin` and `.meta.json` and step silently over anything
  // else, so one file of any other name survived "delete my child's recordings". An allowlist is
  // the wrong default here: forgetting to extend it fails towards RETAINING learner data.
  const STRAY = "learner-with-an-unexpected-file";
  await storeChunk(STRAY, "chunk-stray");
  const strayDir = join(storageDir, "audio", "v1", TENANT, STRAY, "unexpected-session");
  mkdirSync(strayDir, { recursive: true });
  writeFileSync(join(strayDir, "leftover.tmp"), "not a .pcm and not a .meta.json");
  assert.ok(
    filesFor(STRAY).some((file) => file.endsWith("/leftover.tmp")),
    "the stray file was never written",
  );

  const res = await post("/v1/privacy/delete", { tenantId: TENANT, learnerId: STRAY });
  const body = JSON.parse(await res.text());

  assert.deepEqual(filesFor(STRAY), [], "a file erasure does not recognise survived the erasure");
  assert.ok(
    body.deletedOtherObjectKeys.some((k) => k.endsWith("/leftover.tmp")),
    `the stray file was deleted but not reported: ${JSON.stringify(body.deletedOtherObjectKeys)}`,
  );
  // Counted separately on purpose: an unrecognised file must not inflate either of the two counts
  // that already mean something specific.
  assert.ok(
    !JSON.stringify(body.deletedAudioObjectKeys).includes("leftover.tmp") &&
      !JSON.stringify(body.deletedMetadataObjectKeys).includes("leftover.tmp"),
    "the stray file was miscounted as audio or as metadata",
  );
  assert.equal(body.tombstonedDerivedRecords, true, "nothing was left, so this should be true");
});

test("tombstonedDerivedRecords follows the storage post-condition instead of asserting success", async () => {
  // The real filesystem/S3 stores erase every key in the validated learner prefix. Inject the one
  // state that must still be representable: the storage authority completed its call but reports a
  // residual object. A hardcoded `true` passes every happy path and fails this negative control.
  const previousStorageDir = process.env.AUDIO_STORAGE_DIR;
  process.env.AUDIO_STORAGE_DIR = storageDir;
  try {
    const { deletePrivacy } = await import(
      `../../server/src/inference/runtime.mjs?privacy-postcondition=${Date.now()}`
    );
    const body = await deletePrivacy(
      { tenantId: TENANT, learnerId: "learner-with-residue", traceId: "partial-erasure" },
      undefined,
      {
        async deleteLearner() {
          return {
            deletedObjectKeys: ["audio/v1/tenant/learner/session/chunk.pcm"],
            deletedOtherObjectKeys: ["audio/v1/tenant/learner/session/residue.tmp"],
            fullyErased: false,
          };
        },
      },
    );
    assert.equal(body.tombstonedDerivedRecords, false);
  } finally {
    if (previousStorageDir === undefined) delete process.env.AUDIO_STORAGE_DIR;
    else process.env.AUDIO_STORAGE_DIR = previousStorageDir;
  }
});

test("GET /v1/audit-events is bounded, newest-first, and never truncates silently", async () => {
  // The route returned the whole per-tenant JSONL, which nothing rotates (ADR-0040): the response
  // and the synchronous read behind it grew without limit, on a single-threaded service where that
  // read blocks every other request. 200 mirrors platform-api's own `ORDER BY created_at DESC
  // LIMIT 200` rather than inventing a number.
  //
  // The assertion that matters is X-Truncated. A cap a caller cannot detect is how "we have the
  // audit trail" quietly becomes "we have the first page of it".
  const TENANT_BIG = "tenant-audit-paging";
  const total = 205; // over the 200 default, deliberately
  for (let i = 0; i < total; i++) {
    await post("/v1/privacy/export", { tenantId: TENANT_BIG, learnerId: `learner-${i}` });
  }

  const get = (qs) =>
    fetch(`http://127.0.0.1:${port}/v1/audit-events?tenantId=${TENANT_BIG}${qs}`, {
      headers: { "x-ml-api-key": KEY },
    });

  const first = await get("");
  const page = await first.json();
  assert.equal(page.length, 200, `default page must be bounded at 200, got ${page.length}`);
  assert.equal(first.headers.get("x-total-count"), String(total), "the true total must be reported");
  assert.equal(first.headers.get("x-truncated"), "true", "a capped response must say so");

  // Newest first: the LAST export requested must be on page one, and the first must not be.
  assert.equal(page[0].subjectId, `learner-${total - 1}`, "newest event must lead the page");
  assert.ok(
    !page.some((e) => e.subjectId === "learner-0"),
    "the oldest event cannot be on the first page of a newest-first list",
  );

  // The tail is reachable rather than lost, and the last page reports itself as complete.
  const tail = await get("&offset=200");
  const tailPage = await tail.json();
  assert.equal(tailPage.length, total - 200, "offset must reach the remainder");
  assert.equal(tail.headers.get("x-truncated"), "false", "the final page is not truncated");

  // A caller cannot re-open the unbounded read that this replaced. Asserted on the clamp itself:
  // proving it over HTTP would need >1000 seeded events, and a test that fires 1000 requests to
  // check one boundary is a slow test pretending to be a thorough one.
  const { clampAuditLimit } = await import("../../server/src/inference/runtime.mjs");
  assert.equal(clampAuditLimit("999999"), 1000, "limit must be capped at AUDIT_PAGE_MAX");
  assert.equal(clampAuditLimit("50"), 50, "a sane limit is honoured");
  assert.equal(clampAuditLimit("-1"), 200, "a nonsense limit falls back to the default, not to all");
  assert.equal(clampAuditLimit(null), 200, "an absent limit is the default, never unbounded");

  // And over HTTP the oversized limit returns everything available here (205), not an error.
  const huge = await get("&limit=999999");
  assert.equal((await huge.json()).length, total, "an oversized limit still returns a valid page");
});
