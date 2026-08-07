/**
 * GET /v1/tajweed-findings/{id}/audio — the recitation a finding is about (ADR-0037).
 *
 *   NODE_API_PORTED="GET /v1/tajweed-findings/{id}/audio" \
 *     node --test tests/api-parity/audio-playback-parity.test.mjs
 *
 * The owner's rule for this route: teacher-only, within-tenant, audit every fetch, and say so when
 * the audio was discarded.
 *
 * ── Why the bytes come through platform-api ─────────────────────────────────────────────────────
 * The alternative was a short-lived signed URL from ml-inference. A URL that grants access is a
 * credential that outlives the check that produced it: it cannot be revoked when consent is
 * withdrawn mid-window, and the audit record would say a link was ISSUED, not that a recording was
 * HEARD. ADR-0037.
 *
 * ── What this file can and cannot reach ─────────────────────────────────────────────────────────
 * `audio_chunks` is written by nothing in production yet, so the 200 path is reached by SEEDING a
 * chunk row and pointing both services at a mock ml-inference. That is not pretending the feature
 * works end to end — the index write is a separate, unbuilt half, and it is recorded as such. What
 * is real here is the authorization, the consent decision, the audit, and the proxying.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { createFilesystemAudioObjectStore } from "../../server/src/storage/audio-object-store.mjs";

import {
  TENANT,
  insertDeclaredTestAcousticFinding,
  queryJson,
  request,
  startApi,
  startMockUpstream,
  startShell,
} from "./lib/harness.mjs";

/**
 * The routes this file is ABOUT, served by the shell rather than proxied to Rust.
 *
 * Taken from the `NODE_API_PORTED=…` line in the header above, which every parity file carried and
 * none of them set. A file run directly therefore got a shell that proxied everything, so its
 * "shell" side WAS Rust and a Node-only defect could not fail it — the configuration a person
 * actually uses proved the least. Only verify.sh's second pass set the variable, so the same file
 * meant two different things depending on who ran it.
 *
 * `startShell` unions this with the ambient value, so verify.sh's exhaustive pass still serves every
 * PORTABLE route.
 */
const PORTED = "GET /v1/tajweed-findings/{id}/audio";

let api;
let shell;
let mlMock;
let fixture;
let storageDir;
let objectStore;

/** A finding with a real span, its own session, and a consent record we control. */
async function seedFinding({ retention, withChunk }) {
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  const ids = {
    audit: `audit-audio-${suffix}`,
    consent: `consent-audio-${suffix}`,
    session: `session-audio-${suffix}`,
    alignment: `wa-audio-${suffix}`,
    finding: `tf-audio-${suffix}`,
    chunk: `chunk-audio-${suffix}`,
  };
  const [learner] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  const [model] = await queryJson("SELECT id FROM model_versions ORDER BY id LIMIT 1");
  const [word] = await queryJson("SELECT id FROM canonical_words WHERE ayah_id = '1:1' LIMIT 1");

  await queryJson(
    `INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
     VALUES ($1, $2, $3, 'test.seed', 'test', $1, '{}'::jsonb)`,
    [ids.audit, TENANT, learner.id],
  );
  await queryJson(
    `INSERT INTO consent_records (id, tenant_id, user_id, audio_retention, anonymized_learning,
       external_asr_processing, guardian_approved, consent_version, audit_event_id)
     VALUES ($1, $2, $3, $4, true, false, true, 'pilot-v1', $5)`,
    [ids.consent, TENANT, learner.id, retention, ids.audit],
  );
  await queryJson(
    `INSERT INTO recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        practice_plan_id, external_processing_allowed, confidence, review_status, started_at,
        latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
     VALUES ($1, $2, $3, '{}'::jsonb, 'fnv1a32:t', $4, 'guided-recite', 'p', false, 0.0, 'draft',
             now(), 0, $5, '{}'::jsonb, $6, 'ar')`,
    [ids.session, TENANT, learner.id, model.id, ids.consent, ids.audit],
  );
  await queryJson(
    `INSERT INTO word_alignments
       (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
        model_version_id, audit_event_id, transcript_source)
     VALUES ($1, $2, $3, $4, 'x', 640, 1230, 0.9, 'matched', $5, $6, 'client-reported')`,
    [ids.alignment, TENANT, ids.session, word.id, model.id, ids.audit],
  );
  await insertDeclaredTestAcousticFinding({
    id: ids.finding,
    alignmentId: ids.alignment,
    rule: "ghunnah",
    severity: "practice",
    confidence: 0.9,
    auditEventId: ids.audit,
  });
  if (withChunk) {
    await queryJson(
      `INSERT INTO audio_chunks
         (id, tenant_id, session_id, evidence_id, start_ms, end_ms, sample_rate, status, object_key,
          audit_event_id)
       VALUES ($1, $2, $3, 'ev', 600, 1400, 16000, 'aligned', $4, $5)`,
      [
        ids.chunk,
        TENANT,
        ids.session,
        `audio/v1/${TENANT}/${learner.id}/${ids.session}/${ids.chunk}.pcm`,
        ids.audit,
      ],
    );
  }
  return { ...ids, learnerId: learner.id };
}

const auditRowsFor = (findingId) =>
  queryJson(
    `SELECT metadata FROM audit_events
     WHERE tenant_id = $1 AND subject_id = $2 AND action = 'recitation.audio.read'`,
    [TENANT, findingId],
  );

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "qrai-playback-store-"));
  objectStore = createFilesystemAudioObjectStore({ rootDir: storageDir });
  // The mock stands in for ml-inference's /v1/audio-objects:read. Its own behaviour is tested in
  // tests/inference/chunk-overwrite.test.mjs; what matters here is that platform-api asks it
  // the right question and never asks it at all when consent says no.
  mlMock = await startMockUpstream(({ path }) =>
    path === "/v1/audio-objects:read"
      ? {
          status: 200,
          body: {
            objectKey: "k",
            audioBase64: Buffer.from("recitation-bytes").toString("base64"),
            audioSize: 16,
            sampleRate: 16000,
            startMs: 600,
            endMs: 1400,
          },
        }
      : { status: 404, body: { error: "not found" } },
  );
  api = await startApi({ env: { ML_INFERENCE_URL: mlMock.url } });
  shell = await startShell({
    upstream: api.upstreamUrl ?? api.baseUrl,
    env: {
      NODE_API_PORTED: PORTED,
      ML_INFERENCE_URL: mlMock.url,
      AUDIO_STORAGE_DIR: storageDir,
    },
  });
  fixture = {
    retained: await seedFinding({ retention: "teacher-review", withChunk: true }),
    discarded: await seedFinding({ retention: "discard", withChunk: true }),
    noChunk: await seedFinding({ retention: "teacher-review", withChunk: false }),
  };
  await objectStore.put({
    tenantId: TENANT,
    learnerId: fixture.retained.learnerId,
    sessionId: fixture.retained.session,
    chunkId: fixture.retained.chunk,
    startMs: 600,
    endMs: 1400,
    sampleRate: 16000,
    audioRetention: "teacher-review",
    audioBytes: Buffer.from("recitation-bytes"),
  });
});

after(async () => {
  await shell?.stop();
  await api?.stop();
  await mlMock?.stop();
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
});

const impls = () => [
  ["shell", shell.baseUrl],
  ["rust", api.upstreamUrl ?? api.baseUrl],
];

const audioPath = (id) => `/v1/tajweed-findings/${id}/audio`;

test("only the roles that can DECIDE about a finding may hear it", async () => {
  // Exactly `createTeacherReview`'s list. Scholar is deliberately absent even though a scholar can
  // READ the finding queue: reviewing content for religious accuracy does not require listening to a
  // particular child's voice, and this is a child's voice.
  for (const [impl, base] of impls()) {
    for (const role of ["learner", "scholar"]) {
      assert.equal(
        (await request(base, audioPath(fixture.retained.finding), { role })).status,
        403,
        `${impl}: ${role} was allowed to hear a learner's recitation`,
      );
    }
    for (const role of ["teacher", "admin", "ops"]) {
      assert.notEqual(
        (await request(base, audioPath(fixture.retained.finding), { role })).status,
        403,
        `${impl}: ${role} decides on findings and must be able to hear them`,
      );
    }
    assert.equal(
      (await request(base, audioPath(fixture.retained.finding), { tenant: TENANT })).status,
      401,
      `${impl}: an unauthenticated caller reached the audio route`,
    );
  }
});

test("a finding in another tenant is 404, not 403 — and never confirms it exists", async () => {
  for (const [impl, base] of impls()) {
    const res = await request(base, audioPath(fixture.retained.finding), {
      role: "teacher",
      tenant: "tenant-quran-ai",
    });
    assert.equal(res.status, 404, `${impl}: cross-tenant fetch answered ${res.status}`);
    assert.doesNotMatch(
      res.text,
      new RegExp(fixture.retained.chunk),
      `${impl}: the cross-tenant refusal named the chunk`,
    );
  }
});

test("a discarded recording is 410 with no audio, and the attempt is still audited", async () => {
  for (const [impl, base] of impls()) {
    const before = (await auditRowsFor(fixture.discarded.finding)).length;
    const res = await request(base, audioPath(fixture.discarded.finding), { role: "teacher" });

    assert.equal(
      res.status,
      410,
      `${impl}: a discarded recording answered ${res.status}. 410 says the learner asked for it to ` +
        "be destroyed and it was; 404 reads as 'we lost it' and a teacher keeps coming back.",
    );
    assert.doesNotMatch(res.text, /audioBase64|recitation-bytes/, `${impl}: the refusal carried audio`);

    // THE assertion that catches the transaction bug: in the port, the audit INSERT and the 410 both
    // used to sit inside `sql.begin`, so throwing rolled the audit row back. An audited refusal that
    // erases its own audit row is worse than no audit — it looks like nobody asked.
    const after = await auditRowsFor(fixture.discarded.finding);
    assert.equal(
      after.length,
      before + 1,
      `${impl}: a refused fetch left no audit row. Every AUTHORIZED attempt is audited, not only the ` +
        "ones that return bytes.",
    );
    assert.equal(
      after.at(-1).metadata.outcome,
      "discarded",
      `${impl}: the audit row does not record what happened, so it reads as though audio was heard`,
    );
  }
});

test("retention permitted but nothing stored is 404, and still audited", async () => {
  for (const [impl, base] of impls()) {
    const before = (await auditRowsFor(fixture.noChunk.finding)).length;
    const res = await request(base, audioPath(fixture.noChunk.finding), { role: "teacher" });
    assert.equal(res.status, 404, `${impl}: expected 404 for a retained-but-uncaptured recording`);
    assert.equal(
      (await auditRowsFor(fixture.noChunk.finding)).length,
      before + 1,
      `${impl}: the attempt was not audited`,
    );
  }
});

test("a retained recording is served, audited, and located", async () => {
  // The control. Without it every assertion above is satisfied by a handler that refuses
  // everything — which would look like a perfectly careful implementation and play nothing.
  for (const [impl, base] of impls()) {
    const res = await request(base, audioPath(fixture.retained.finding), { role: "teacher" });
    assert.equal(res.status, 200, `${impl}: ${res.text}`);
    assert.equal(
      Buffer.from(res.body.audioBase64, "base64").toString("utf8"),
      "recitation-bytes",
      `${impl}: the bytes served are not the bytes storage returned`,
    );
    // The finding's own span, so a client can seek to the word rather than play the whole chunk.
    assert.equal(res.body.findingStartMs, 640, `${impl}: the finding's span did not survive`);
    assert.equal(res.body.findingEndMs, 1230);
    assert.equal(res.body.chunksOverlappingFinding, 1);

    const rows = await auditRowsFor(fixture.retained.finding);
    assert.ok(rows.length > 0, `${impl}: a successful fetch was not audited`);
    assert.equal(rows.at(-1).metadata.outcome, "available");
    assert.equal(rows.at(-1).metadata.chunk_id, fixture.retained.chunk);
  }
});

test("the Node route reads its injected private store directly, never the ML compatibility hop", async () => {
  mlMock.received.length = 0;
  const response = await request(shell.baseUrl, audioPath(fixture.retained.finding), { role: "teacher" });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(
    mlMock.received.filter((r) => r.path === "/v1/audio-objects:read"),
    [],
    "Node delegated a production storage read back to transitional ML",
  );
});

test("storage is not asked at all when consent says no", async () => {
  // The cheapest possible leak here is asking storage for a recording the learner asked to destroy
  // and discarding the answer. The refusal must happen before the request, not after it.
  mlMock.received.length = 0;
  for (const [, base] of impls()) {
    await request(base, audioPath(fixture.discarded.finding), { role: "teacher" });
  }
  assert.deepEqual(
    mlMock.received.filter((r) => r.path === "/v1/audio-objects:read"),
    [],
    "a discarded recording was still requested from storage",
  );
});
