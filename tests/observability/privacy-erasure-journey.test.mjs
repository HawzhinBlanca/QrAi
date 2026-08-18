/**
 * @journey: privacy-erasure
 *
 * A learner asks to be erased, and BOTH halves of them actually go. (P6.1 privacy journey)
 *
 *   node --test tests/observability/privacy-erasure-journey.test.mjs
 *
 * ── Why the two existing halves are not this ────────────────────────────────────────────────────
 * `tests/api-parity/privacy-parity.test.mjs` drives platform-api against a MOCK ml-inference that
 * always reports keys deleted. It proves platform-api collects and audits what an upstream tells it.
 *
 * `tests/inference/privacy-erasure.test.mjs` drives ml-inference directly and proves the
 * recording genuinely leaves the disk.
 *
 * Neither runs one erasure request through both. That join is where this project keeps finding
 * defects — the trace crossed the ML boundary and was recorded as null on the far side; the tajweed
 * route returned findings and stored none. Both halves were individually correct in both cases.
 *
 * A learner's erasure has two halves that live in different systems: the derived records in Postgres
 * and the voice itself on the ML service's disk. The request that promises to remove both is a
 * single POST. This is the test that the promise is kept by the system rather than by each service
 * separately.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  TENANT,
  queryJson,
  request,
  reservePort,
  startApi,
  uniqueSuffix,
} from "../api-parity/lib/harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ML_ENTRY = join(root, "tests/inference/lib/worker-compatibility-harness.mjs");
const ML_KEY = "privacy-journey-ml-key";

let ml;
let mlUrl;
let mlStderr = "";
let storageDir;
let api;
let rustUrl;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "privacy-journey-"));
  const mlPort = await reservePort();
  ml = spawn(process.execPath, [ML_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      ML_INFERENCE_PORT: String(mlPort),
      AUDIO_STORAGE_DIR: storageDir,
      ML_API_KEY: ML_KEY,
      ALLOW_INSECURE_DEFAULTS: "",
      ALLOW_INSECURE_SECRETS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  ml.stderr.on("data", (d) => {
    mlStderr += `[ml] ${d}`;
  });

  mlUrl = `http://127.0.0.1:${mlPort}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${mlUrl}/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`ml-inference never came up\n${mlStderr}`);
    await sleep(50);
  }

  api = await startApi({ env: { ML_INFERENCE_URL: mlUrl, ML_API_KEY: ML_KEY } });
  rustUrl = api.upstreamUrl ?? api.baseUrl;
});

after(async () => {
  await api?.stop();
  if (ml && ml.exitCode === null) {
    ml.kill("SIGTERM");
    const hard = Date.now() + 5_000;
    while (ml.exitCode === null && Date.now() < hard) await sleep(25);
    if (ml.exitCode === null) ml.kill("SIGKILL");
  }
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
});

const audioFilesFor = (learnerId) => {
  const root = join(storageDir, "audio", "v1", TENANT, learnerId);
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir, relative = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), child);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(root);
  return files.sort();
};

/** Store one chunk the way the realtime gateway does — straight into the ML service. */
async function storeAudioFor(learnerId, sessionId) {
  const res = await fetch(`${mlUrl}/v1/audio-chunks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ml-api-key": ML_KEY },
    body: JSON.stringify({
      tenantId: TENANT,
      learnerId,
      sessionId,
      chunkId: `chunk-${sessionId}`,
      startMs: 0,
      endMs: 100,
      sampleRate: 16000,
      audioRetention: "teacher-review",
      audioBase64: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString("base64"),
    }),
  });
  assert.equal(res.status, 200, `storing audio for ${learnerId} failed: ${await res.text()}`);
}

/**
 * A learner created FOR THIS RUN, never a seeded one.
 *
 * This test erases somebody, and a privacy delete takes their sessions, progress, alignments,
 * findings, consent records, tickets and agent runs with them. Pointing it at `learner-1` would
 * destroy fixture data every other test in the repository reads — which is exactly the leak that
 * `seedQueued` had, found and fixed earlier today. A test that erases people must bring its own.
 */
async function createLearner(label) {
  const res = await request(rustUrl, "/v1/auth/register", {
    method: "POST",
    role: "admin",
    body: {
      tenantId: TENANT,
      displayName: `privacy journey ${label}`,
      role: "learner",
      language: "ckb",
      email: `privacy-journey-${label}-${uniqueSuffix()}@example.test`,
      password: "PrivacyJourney1234",
    },
  });
  assert.equal(res.status, 200, `creating a learner failed: ${res.text}`);
  const id = res.body.id ?? res.body.userId;
  assert.ok(id, `no user id in ${res.text}`);
  return id;
}

async function createSessionFor(learnerId) {
  const res = await request(rustUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    userId: learnerId,
    body: {
      learnerId,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
      sourceChecksum: "fnv1a32:privjourney",

      language: "ckb",
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent: {
        audioRetention: "teacher-review",
        anonymizedLearning: true,
        externalAsrProcessing: false,
        guardianApproved: true,
        consentVersion: "pilot-v1",
      },
    },
  });
  assert.equal(res.status, 200, `session create failed: ${res.text}`);
  return res.body.id ?? res.body.sessionId;
}

test("one erasure request clears the database records AND the recording on disk", async () => {
  const erased = await createLearner("erased");
  const kept = await createLearner("kept");

  const erasedSession = await createSessionFor(erased);
  const keptSession = await createSessionFor(kept);
  await storeAudioFor(erased, erasedSession);
  await storeAudioFor(kept, keptSession);

  // Both halves must exist BEFORE the request, or "it is gone" proves nothing about erasure.
  const sessionsBefore = await queryJson(
    "SELECT id FROM recitation_sessions WHERE learner_id = $1 AND tenant_id = $2",
    [erased, TENANT],
  );
  assert.ok(sessionsBefore.length > 0, "the learner had no database records to erase");
  assert.ok(audioFilesFor(erased).length > 0, "the learner had no recording to erase");

  const res = await request(rustUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "learner",
    userId: erased,
    body: { learnerId: erased },
  });
  assert.equal(res.status, 200, `the erasure request failed: ${res.text}`);

  // ── half one: the derived records ───────────────────────────────────────────────────────────────
  const sessionsAfter = await queryJson(
    "SELECT id FROM recitation_sessions WHERE learner_id = $1 AND tenant_id = $2",
    [erased, TENANT],
  );
  assert.deepEqual(
    sessionsAfter,
    [],
    `${sessionsAfter.length} recitation session(s) survived the erasure request`,
  );

  // ── half two: the voice ─────────────────────────────────────────────────────────────────────────
  // The half that lives in another service entirely. platform-api can only clear it by calling out,
  // and a delete that quietly skipped that call would satisfy every database assertion above.
  const remaining = audioFilesFor(erased);
  assert.deepEqual(
    remaining,
    [],
    `the database records are gone and ${JSON.stringify(remaining)} is still on disk. The learner ` +
      `was told they were erased; their voice is still here.`,
  );

  // ── and only this learner ───────────────────────────────────────────────────────────────────────
  const keptSessions = await queryJson(
    "SELECT id FROM recitation_sessions WHERE id = $1",
    [keptSession],
  );
  assert.equal(keptSessions.length, 1, "another learner's session was erased too");
  assert.ok(
    audioFilesFor(kept).length > 0,
    "another learner's recording was erased by someone else's request",
  );
});

test("an erasure request fails CLOSED when the audio service cannot be reached", async () => {
  // The failure mode that matters most. If the ML call failed OPEN, platform-api would delete the
  // database records — every trace of which learner owned which recording — while the recordings
  // themselves stayed on disk, unreferenced and unerasable. The learner would be told they were
  // erased, and the only thing actually destroyed would be the evidence needed to finish the job.
  const dead = await reservePort();
  const orphanApi = await startApi({
    env: { ML_INFERENCE_URL: `http://127.0.0.1:${dead}`, ML_API_KEY: ML_KEY },
  });
  const orphanUrl = orphanApi.upstreamUrl ?? orphanApi.baseUrl;

  try {
    // Its own learner too: if this request ever DID succeed against an unreachable audio service,
    // the assertion below would fail and the damage would be confined to a learner made for it.
    const learner = await createLearner("orphan");
    const res = await request(orphanUrl, "/v1/privacy/delete", {
      method: "POST",
      role: "learner",
      userId: learner,
      body: { learnerId: learner },
    });
    assert.notEqual(
      res.status,
      200,
      "the erasure reported success while the audio service was unreachable — the database records " +
        "would be gone and the recordings would remain, with nothing left to link them",
    );
    assert.doesNotMatch(
      res.text,
      /127\.0\.0\.1|:\d{4,5}/,
      `the failure response names the internal audio service: ${res.text}`,
    );
  } finally {
    await orphanApi.stop();
  }
});

test("every object the erasure deleted is on the record a restore reads", async () => {
  // ── Why this is a journey test and not a unit test ──────────────────────────────────────────────
  // Both halves were individually right. ml-inference deletes every FILE in the learner's directory
  // and classifies what it removed into THREE lists — `.bin`, `.meta.json`, and
  // `deletedOtherObjectKeys` for anything else, added deliberately "so the two existing counts keep
  // meaning exactly what they meant". platform-api collected two of them.
  //
  // The gap only has consequences at a third place: `privacy_jobs.audio_object_keys_deleted` is the
  // column `scripts/restore-audio.sh` reads to decide which objects a volume restore must NOT put
  // back. That script is careful — it refuses to run under a role that cannot read across tenants,
  // precisely because an empty erasure list is indistinguishable from "nobody asked to be erased".
  // An INCOMPLETE list has none of those tells. It looks like a successful erasure, and the missing
  // object comes back at the next restore, against a receipt the learner already holds.
  //
  // Reproduced before the fix: a `.wav` beside a chunk's `.bin`/`.meta.json` was deleted from disk,
  // reported by ml-inference under `deletedOtherObjectKeys`, and absent from the recorded column.
  //
  // Nothing writes such a file today — the only writers use `.bin` and `.meta.json`. This asserts
  // the invariant rather than today's file naming, because the third list exists exactly for the
  // file somebody adds later, and that is the one nobody will re-check this path for.
  const learner = await createLearner("residue");
  const session = await createSessionFor(learner);
  await storeAudioFor(learner, session);

  // A file whose name is neither, sitting where the erasure will find it — a partial write, a
  // future format, a stray artefact. The erasure's own classifier has a bucket for this.
  const strayName = "chunk-residue.wav";
  const { writeFileSync } = await import("node:fs");
  // ADR-0044 versioned the object layout: keys are `audio/v1/{tenant}/{learner}/{session}/…`, and
  // `deriveAudioLearnerPrefix` sweeps `audio/v1/{tenant}/{learner}/`. Planted at the old flat path
  // the stray sat OUTSIDE the prefix the erasure walks, so the fixture proved nothing — it has to
  // sit where the erasure will actually find it. `audioFilesFor` already reads the versioned root.
  writeFileSync(
    join(storageDir, "audio", "v1", TENANT, learner, strayName),
    Buffer.from([9, 9, 9, 9]),
  );

  const before = audioFilesFor(learner);
  assert.ok(
    before.includes(strayName),
    `the fixture never planted ${strayName}; this test would then assert nothing. On disk: ${JSON.stringify(before)}`,
  );

  const res = await request(rustUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "learner",
    userId: learner,
    body: { learnerId: learner },
  });
  assert.equal(res.status, 200, `erasure failed: ${res.text}`);

  // It really is gone from live storage — otherwise "recorded as deleted" would be the wrong
  // question entirely.
  assert.deepEqual(audioFilesFor(learner), [], "the erasure left files behind");

  const [job] = await queryJson(
    "SELECT audio_object_keys_deleted AS keys FROM privacy_jobs WHERE learner_id = $1 AND kind = 'delete'",
    [learner],
  );
  assert.ok(job, "the erasure wrote no privacy_jobs row");
  const recorded = job.keys ?? [];

  // ADR-0044 made the object model explicit: a stored object is ONE key (`….pcm`), and its
  // `….pcm.meta.json` sidecar is an attribute of that object — the store's own listing records it
  // as `metadataPresent` on the object rather than as a second entry. So the receipt records two
  // keys for three files here, and comparing raw file counts would report a phantom gap.
  //
  // The guarantee this test exists for is untouched: a file that is NOT a sidecar of a recorded
  // object — the stray `.wav`, the future format, the partial write — must still appear on the
  // receipt, because `scripts/restore-audio.sh` reads that column to decide what a volume restore
  // withholds. Sidecars are attributed to their object; nothing else is excused.
  const objects = before.filter((name) => !name.endsWith(".meta.json"));
  const orphanedSidecars = before.filter(
    (name) => name.endsWith(".meta.json") && !objects.includes(name.slice(0, -".meta.json".length)),
  );
  assert.deepEqual(
    orphanedSidecars,
    [],
    "a .meta.json was deleted whose object was not, so it is nobody's attribute and needs its own " +
      `receipt entry: ${JSON.stringify(orphanedSidecars)}`,
  );
  assert.ok(
    recorded.length >= objects.length && objects.length >= 2,
    `only ${recorded.length} key(s) recorded for an erasure that removed ${objects.length} ` +
      `object(s) (${JSON.stringify(objects)}); recorded: ${JSON.stringify(recorded)}`,
  );

  const missing = objects.filter(
    (name) => !recorded.some((key) => key.endsWith(`/${name}`)),
  );
  assert.deepEqual(
    missing,
    [],
    `these objects were deleted by the erasure and are NOT in ` +
      `privacy_jobs.audio_object_keys_deleted:\n  ${missing.join("\n  ")}\n` +
      `scripts/restore-audio.sh reads that column to decide what a volume restore must withhold, ` +
      `so each of these would be silently put back — after the learner was told they were gone.`,
  );
});
