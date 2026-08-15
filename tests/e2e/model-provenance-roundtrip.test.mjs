import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { queryJson, request } from "../api-parity/lib/harness.mjs";
import { startRealAudioFinalizeHarness } from "./lib/real-audio-finalize-harness.mjs";

let harness;

before(async () => {
  harness = await startRealAudioFinalizeHarness("w18-model-provenance");
});

after(async () => {
  await harness?.stop();
});

test("actual inference provenance round-trips through one tenant-bound run and staff readback", async () => {
  const finalized = await request(
    harness.api.baseUrl,
    `/v1/recitation-sessions/${harness.sessionId}/finalize`,
    { method: "POST", role: "learner", body: {} },
  );
  assert.equal(finalized.status, 200, finalized.text);
  assert.equal(finalized.body.finalized, true);
  assert.equal(finalized.body.persisted, 15);
  assert.equal(harness.getAsrRequests(), 2);

  const transcriptCall = harness.mlCalls.find((call) => call.path === "/v1/session-transcript");
  const alignmentCall = harness.mlCalls.find((call) => call.path === "/v1/alignments:predict");
  assert.ok(transcriptCall, "the finalizer never obtained a server transcript");
  assert.ok(alignmentCall, "the finalizer never invoked the Quran aligner");
  assert.equal(transcriptCall.response.transcriptSource, "server-derived");
  assert.equal(transcriptCall.response.modelAttribution.primaryComponent, "asr");
  assert.deepEqual(
    alignmentCall.request.transcriptModelAttribution,
    transcriptCall.response.modelAttribution,
    "the private alignment request did not carry the exact transcript producer document",
  );

  const produced = alignmentCall.response;
  assert.equal(produced.finalizable, true);
  assert.equal(produced.modelVersion, harness.sessionModelVersion);
  assert.equal(produced.modelAttribution.primaryComponent, "quran-aligner");
  assert.deepEqual(
    produced.modelAttribution.components.map((component) => component.component),
    ["asr", "quran-aligner"],
  );
  assert.equal(
    produced.datasetVersion,
    "alquran-cloud:quran-uthmani:full-quran-2026-06-26",
    "real output was mislabeled with the smoke fixture dataset",
  );

  const [run] = await queryJson(
    `SELECT id, model_version_id, dataset_version, latency_ms, evidence_ids, consent_snapshot,
            audit_event_id, transcript_source, model_attribution
       FROM alignment_runs WHERE session_id = $1`,
    [harness.sessionId],
  );
  assert.ok(run, "finalization persisted words without their producer run");
  assert.equal(run.model_version_id, produced.modelVersion);
  assert.equal(run.dataset_version, produced.datasetVersion);
  assert.equal(Number(run.latency_ms), produced.latencyMs);
  assert.deepEqual(run.evidence_ids, [produced.evidenceId]);
  assert.equal(run.transcript_source, "server-derived");
  assert.deepEqual(run.model_attribution, produced.modelAttribution);
  assert.deepEqual(run.consent_snapshot, {
    anonymizedLearning: false,
    audioRetention: "teacher-review",
    consentVersion: "w18-model-provenance-integration-fixture",
    externalAsrProcessing: true,
    guardianApproved: true,
    recordingConsent: false,
  });

  const linked = await queryJson(
    `SELECT count(*)::int AS count, count(DISTINCT alignment_run_id)::int AS runs,
            min(alignment_run_id) AS run_id
       FROM word_alignments WHERE session_id = $1`,
    [harness.sessionId],
  );
  assert.deepEqual(linked[0], { count: 15, runs: 1, run_id: run.id });

  const path = `/v1/recitation-sessions/${harness.sessionId}/alignments`;
  const readback = await request(harness.api.baseUrl, path, { role: "teacher" });
  assert.equal(readback.status, 200, readback.text);
  assert.equal(readback.body.length, 15);
  for (const word of readback.body) {
    assert.equal(word.transcriptSource, "server-derived");
    assert.equal(word.modelVersion, produced.modelVersion);
    assert.equal(word.datasetVersion, produced.datasetVersion);
    assert.deepEqual(word.evidenceIds, [produced.evidenceId]);
    assert.deepEqual(word.modelAttribution, produced.modelAttribution);
    assert.equal(word.auditEventId, run.audit_event_id);
  }

  const learner = await request(harness.api.baseUrl, path, { role: "learner" });
  assert.equal(learner.status, 403, "learner received restricted producer internals");
  const otherTenant = await request(harness.api.baseUrl, path, {
    role: "admin",
    tenant: "tenant-with-no-access-to-hikmah",
  });
  assert.equal(otherTenant.status, 200);
  assert.deepEqual(otherTenant.body, [], "another tenant read Hikmah model provenance");
});
