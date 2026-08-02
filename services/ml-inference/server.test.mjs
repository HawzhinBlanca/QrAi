// Regression tests for audit-trail honesty in the ML inference handlers.
// Hermetic (no network, no DB) — run by `node --test` in the CODYSTEM gate. Importing server.mjs
// is safe: its side effects (listen(), cleanup timers, signal handlers) are gated on `isMain`, so
// importing the module here neither binds a port nor keeps the event loop alive.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The audit trail is now persisted to JSONL under AUDIO_STORAGE_DIR (see server.mjs). Point it at a
// fresh temp dir BEFORE importing the module (which reads AUDIO_STORAGE_DIR at load) so each test
// run is hermetic — no accumulation across runs, no writes into the repo's audio-storage/.
process.env.AUDIO_STORAGE_DIR = mkdtempSync(join(tmpdir(), "ml-inference-test-"));

const { predictAlignment,
  transcribeSession,
  wavFromPcm16, predictTajweed, createEvalRun, getAuditEvents, safeStorageSegment, route } =
  await import("./server.mjs");

// Minimal mock of the http.IncomingMessage/ServerResponse pair route() needs. GET requests never
// read a body here, so the mock request only needs `.url`/`.method`; the mock response just
// captures what jsonResponse()/httpError() would have written to a real socket.
function mockRequest(url, method = "GET") {
  return { url, method, headers: {} };
}
function mockResponse() {
  const res = { status: null, body: null };
  res.writeHead = (status) => {
    res.status = status;
  };
  res.end = (body) => {
    res.body = body ? JSON.parse(body) : null;
  };
  return res;
}

// These tests run in the DEFAULT (production) configuration: ML_USE_GOLDEN_FIXTURES is unset, so
// every request computes REAL alignment/tajweed even for the golden ref Al-Fatihah 1:1-7. The bug
// they pin: the audit event was appended BEFORE the compute branch using the matched golden
// fixture's values, so it recorded the fixture's numbers (0.94 confidence / 8 words / 1 finding)
// while the response returned the real computation over the 29-word canonical set. The audit trail
// — surfaced via GET /v1/audit-events and the privacy export — therefore contradicted the very
// prediction it claimed to describe. The fix appends the audit AFTER the branch with the real values.

const lastEvent = (tenantId, action) => {
  const events = getAuditEvents(tenantId).filter((e) => e.action === action);
  return events[events.length - 1];
};

test("child-profile audio without guardian consent is NOT sent to ASR (consent/child-safety gate)", async () => {
  // Regression: the transcribe call fired on `audioBase64` presence ALONE, decoupled from the
  // consent + child-safety decision it audits — so a child's raw audio was shipped to Whisper even
  // when the request was audited `external-asr.denied`. This test is hermetic (no ASR service), so a
  // wrongly-attempted transcribe would throw (transcribeAudio fetches ASR_SERVICE_URL and 502s);
  // the gate must skip it and fall through to the canonical path instead.
  const tenantId = `child-consent-gate-${Date.now()}`;
  const res = await predictAlignment({
    tenantId,
    sessionId: "s-child",
    profileKind: "child",
    externalAsrRequested: true,
    consent: { externalAsrProcessing: true, guardianApproved: false }, // guardian did NOT approve
    audioBase64: "AAAA",
    quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
  });

  // Fell back to a canonical alignment (no ASR), and is gated for teacher review.
  assert.ok(res.alignments.length > 0, "returns a canonical-fallback alignment, not an ASR error");
  assert.equal(res.alignments[0].reviewStatus, "teacher-review-required");
  // The denial is audited AND no external-asr.called event exists for this tenant.
  assert.ok(lastEvent(tenantId, "privacy.external-asr.denied"), "the ASR denial is audited");
  assert.equal(
    lastEvent(tenantId, "privacy.external-asr.called"),
    undefined,
    "external ASR was never marked called — the audio was not sent",
  );
});

test("alignment audit event records the REAL confidence and word counts, not the golden fixture's", async () => {
  const tenantId = "test-audit-alignment-honesty";
  // Default quranRef (Al-Fatihah 1:1-7) intentionally matches a golden fixture. No audio and no
  // recognizedText, so NOTHING was recognised.
  const res = await predictAlignment({ tenantId, sessionId: "s-align" });
  const ev = lastEvent(tenantId, "ml.alignment.predicted");

  assert.ok(ev, "an ml.alignment.predicted audit event was recorded");
  // The audit must describe the prediction actually returned.
  assert.equal(ev.details.confidence, res.confidence, "audit confidence must equal response confidence");
  assert.equal(
    ev.details.wordCount,
    res.alignments.length,
    "audit wordCount must equal the number of aligned words in the response",
  );
  assert.equal(ev.details.recognizedCount, 0, "nothing was recognised, and the audit must say so");

  // ── This test used to assert `res.confidence === 1` ───────────────────────────────────────────
  // Its comment read "the real path scores a perfect (canonical == recognized) recitation", which
  // was true and was the bug: with no audio and no transcript the service aligned the canonical
  // text against ITSELF and reported every word matched at confidence 1. `apps/web` persisted that
  // unconditionally, and `word_alignments` has no reviewStatus column to carry the caveat — so a
  // learner who declined ASR consent got a stored record of a flawless recitation of the Qur'an
  // that nobody had listened to.
  //
  // There is no honest alignment without recognition.
  assert.equal(res.confidence, 0, "nothing was heard, so no confidence in any match");
  assert.ok(
    res.alignments.every((a) => a.status === "needs-review"),
    "every word must be needs-review — not `matched` (a claim they said it) and not `missed` " +
      "(a claim they did not)",
  );
  assert.ok(
    res.alignments.every((a) => a.heardText === ""),
    "heardText must be empty; echoing the canonical text is what made this look like a match",
  );
  // Still the REAL 29-word set, not the fixture's 8-word abbreviation — the original point of this
  // test, and unaffected by the above.
  assert.ok(res.alignments.length > 8, `expected the real 29-word set, got ${res.alignments.length}`);
});

test("audit events are persisted DURABLY to disk (JSONL), not just held in memory", async () => {
  // Regression guard: the audit trail used to live only in a module-level array — unbounded and
  // lost entirely on restart, so a learner's privacy export could report zero external-ASR calls
  // even after their audio was sent to ASR. It must now be on disk, readable independently of the
  // process's in-memory state.
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const tenantId = `durable-audit-${Date.now()}`;

  await predictAlignment({ tenantId, sessionId: "s-durable" });

  const file = join(process.env.AUDIO_STORAGE_DIR, "audit-log", `${tenantId}.jsonl`);
  assert.ok(existsSync(file), "a per-tenant audit JSONL file is written to disk");
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "at least one audit event was persisted");
  const parsed = lines.map((l) => JSON.parse(l));
  assert.ok(
    parsed.some((e) => e.tenantId === tenantId && e.action === "ml.alignment.predicted"),
    "the alignment audit event is on disk, not just in memory",
  );
});

test("tajweed audit event records the REAL finding count, not the golden fixture's", async () => {
  const tenantId = "test-audit-tajweed-honesty";
  const res = await predictTajweed({ tenantId, sessionId: "s-tajweed" });
  const ev = lastEvent(tenantId, "ml.tajweed.predicted");

  assert.ok(ev, "an ml.tajweed.predicted audit event was recorded");
  assert.equal(
    ev.details.findingCount,
    res.findings.length,
    "audit findingCount must equal the number of findings in the response",
  );
  // The real rule-based analysis of Al-Fatihah 1:1-7 yields many findings, not the fixture's 1.
  assert.ok(res.findings.length > 1, `expected the real multi-finding analysis, got ${res.findings.length}`);
});

test("every returned alignment/finding is stamped with the audit event id it is described by", async () => {
  const tenantId = "test-audit-stamp-consistency";
  const align = await predictAlignment({ tenantId, sessionId: "s1" });
  assert.ok(align.alignments.length > 0);
  assert.ok(
    align.alignments.every((a) => a.auditEventId === align.auditEventId),
    "each alignment carries the response's auditEventId",
  );

  const tajweed = await predictTajweed({ tenantId, sessionId: "s2" });
  assert.ok(tajweed.findings.length > 0);
  assert.ok(
    tajweed.findings.every((f) => f.auditEventId === tajweed.auditEventId),
    "each finding carries the response's auditEventId",
  );
});

test("createEvalRun ignores caller-supplied metrics — they cannot forge the recorded eval or its pass", async () => {
  // A caller POSTing garbage (or perfect) metrics must not influence the recorded eval. Previously
  // `requestBody.metrics ?? fixtureMetrics` let any caller set passed:true with fabricated numbers.
  const forged = await createEvalRun({
    modelVersion: "forge-attempt",
    metrics: {
      wordAlignmentF1: 0.01,
      tajweedF1: 0.01,
      falsePositiveRate: 0.99,
      teacherAgreementRate: 0.01,
      unsourcedLearnerOutputs: 999,
      sourceBackedFindings: 0,
    },
  });

  // Accuracy metrics come from the committed offline artifact, not the caller's fabricated 0.01s.
  assert.notEqual(forged.wordAlignmentF1, 0.01);
  assert.ok(forged.wordAlignmentF1 >= forged.thresholds.wordAlignmentF1);
  assert.ok(forged.tajweedF1 >= forged.thresholds.tajweedF1);
  assert.equal(forged.metricsProvenance.accuracy, "committed-offline-eval");

  // Source-integrity is recomputed live from the committed golden findings, not taken from the
  // caller's 999 — every golden tajweed finding is sourced, so this is 0.
  assert.equal(forged.unsourcedLearnerOutputs, 0);
  assert.ok(forged.sourceBackedFindings > 0);
  assert.notEqual(forged.sourceBackedFindings, 0);
  assert.equal(forged.metricsProvenance.sourceIntegrity, "recomputed-live");

  // The fabricated caller metrics did NOT flip the gate to a false fail either — pass reflects the
  // committed artifact + the live source check.
  assert.equal(forged.passed, true);
});

// safeStorageSegment guards the audio-storage path components. Besides traversal/charset, it must
// bound the LENGTH: an over-long id used to pass validation and only fail at writeFileSync time as an
// uncaught ENAMETOOLONG — a 500 that leaked the raw filesystem path. It must reject cleanly (400).
test("safeStorageSegment rejects over-long ids with a 400, not a write-time 500", () => {
  // A valid id passes through unchanged.
  assert.equal(safeStorageSegment("tenant_abc-123", "tenantId"), "tenant_abc-123");

  // 129 chars (one over the 128 cap) — valid charset, but too long for a path component.
  const is400 = (e) => e.status === 400;
  assert.throws(() => safeStorageSegment("a".repeat(129), "chunkId"), is400, "over-long segment must be a client 400");

  // Exactly 128 is still allowed.
  assert.equal(safeStorageSegment("a".repeat(128), "chunkId").length, 128);

  // Traversal / bad charset still rejected (unchanged behaviour).
  assert.throws(() => safeStorageSegment("../etc", "tenantId"), is400);
  assert.throws(() => safeStorageSegment("a/b", "tenantId"), is400);
});

// getCanonicalWords validated ayahStart against the surah's real ayah count but not ayahEnd — a
// request for e.g. Surah 97 (Al-Qadr, 5 ayahs) with ayahEnd: 7 silently aligned against only the
// 5 ayahs that exist instead of rejecting the out-of-range request, so a caller (the mobile app
// hardcoded ayahEnd: 7 regardless of the selected surah's real length) got a shorter alignment than
// it asked for with no error to signal the mismatch.
test("predictAlignment rejects an ayahEnd beyond the surah's real ayah count (400, not a silent truncation)", async () => {
  await assert.rejects(
    () =>
      predictAlignment({
        tenantId: "test-ayah-end-bounds",
        sessionId: "s-ayah-end-bounds",
        quranRef: { surahNumber: 97, ayahStart: 1, ayahEnd: 7, display: "Al-Qadr 1-7" },
      }),
    (e) => e.status === 400,
    "ayahEnd beyond Surah 97's 5 ayahs must be a 400, not a silently truncated result",
  );
});

// GET /v1/audit-events used to fall back to returning EVERY tenant's events when the tenantId
// query param was omitted, gated only by the single shared ML_API_KEY (not tenant-specific) --
// any caller holding that one key could read every other tenant's audit trail. Exercises the real
// HTTP route() dispatcher, not just the getAuditEvents() test-only accessor, since the bug lived
// in the route handler's own fallback, not in that accessor.
test("GET /v1/audit-events requires tenantId and never leaks another tenant's events", async () => {
  await predictAlignment({
    tenantId: "audit-leak-tenant-a",
    sessionId: "s-audit-leak-a",
    quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
  });
  await predictAlignment({
    tenantId: "audit-leak-tenant-b",
    sessionId: "s-audit-leak-b",
    quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
  });

  // No tenantId -> 400, not "every tenant's events".
  await assert.rejects(
    () => route(mockRequest("/v1/audit-events"), mockResponse()),
    (e) => e.status === 400,
    "omitting tenantId must be a 400, not a fallback to every tenant's events",
  );

  // With tenantId -> 200, scoped to exactly that tenant, tenant B's events absent.
  const res = mockResponse();
  await route(mockRequest("/v1/audit-events?tenantId=audit-leak-tenant-a"), res);
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "tenant A's own events must be present");
  assert.ok(
    res.body.every((event) => event.tenantId === "audit-leak-tenant-a"),
    "response must contain ONLY tenant A's events, never tenant B's",
  );
});

test("a learner who declined ASR consent gets NO alignment claims, not a perfect score", async () => {
  // The exact production trigger, measured against the running service before the fix:
  //   externalAsr : {"called": false, "reason": "consent-revoked-or-insufficient"}
  //   confidence  : 1
  //   1:1:1: status=matched conf=1 heard='بِسْمِ'   ← the canonical text, echoed back
  //
  // `apps/web` persists alignments unconditionally and `word_alignments` has no reviewStatus
  // column, so this became a stored record of a flawless recitation of the Qur'an that nobody had
  // listened to — and, once findings anchor to alignments, a teacher's review queue built on it.
  const res = await predictAlignment({
    tenantId: "test-asr-denied",
    sessionId: "s-denied",
    externalAsrRequested: true,
    audioBase64: "AAAA",
    consent: { guardianApproved: true, externalAsrProcessing: false },
  });

  assert.equal(res.externalAsr.called, false, "consent was declined, so no audio may be sent");
  assert.equal(res.confidence, 0, "nothing was heard, so nothing may be scored");
  assert.ok(
    res.alignments.every((a) => a.status === "needs-review" && a.confidence === 0 && a.heardText === ""),
    "no word may be reported as matched, missed, or heard as anything",
  );
});

test("a real transcript still aligns normally — the fix does not blunt recognition", async () => {
  // The other direction. A guard that made every alignment `needs-review` would be safe and
  // useless; the point is that unrecognised means unrecognised, not that nothing ever matches.
  const res = await predictAlignment({
    tenantId: "test-asr-real",
    sessionId: "s-real",
    quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "x" },
    recognizedTextString: "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ",
  });
  assert.equal(res.confidence, 1, "a correct recitation still scores 1");
  assert.ok(res.alignments.every((a) => a.status === "matched"));
});

// ── Session transcription from the gateway's stored chunks ──────────────────────────────────────

test("wavFromPcm16 writes a header that DESCRIBES the samples and changes none of them", () => {
  // The gateway forwards raw PCM16; the ASR service accepts only container formats. A wrong header
  // is not a crash — the ASR reads the samples at the wrong rate and transcribes a recitation that
  // sounds nothing like what was recorded.
  const pcm = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03, 0x00]);
  const wav = wavFromPcm16(pcm, 16000);

  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1, "audio format 1 = uncompressed PCM");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 16000, "sample rate");
  assert.equal(wav.readUInt32LE(28), 16000 * 2, "byte rate = rate * channels * bytesPerSample");
  assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data size must equal the PCM length");
  assert.equal(wav.length, 44 + pcm.length, "44-byte header, then the samples verbatim");
  assert.deepEqual(wav.subarray(44), pcm, "the samples must be byte-identical");
});

test("a 48kHz stream is described as 48kHz, not assumed to be 16k", () => {
  // The rate comes from the chunk metadata. Hardcoding 16000 would make every other rate play back
  // at the wrong speed and transcribe as gibberish.
  const wav = wavFromPcm16(Buffer.alloc(4), 48000);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt32LE(28), 48000 * 2);
});

test("no ASR consent means no transcription, and the refusal is audited", async () => {
  const tenantId = "test-transcript-denied";
  const res = await transcribeSession({
    tenantId,
    learnerId: "learner-1",
    sessionId: "s-denied",
    consent: { externalAsrProcessing: false, guardianApproved: true },
  });

  assert.equal(res.transcribed, false);
  assert.equal(res.reason, "consent-revoked-or-insufficient");
  assert.deepEqual(res.recognizedText, [], "no words may be claimed");
  const ev = lastEvent(tenantId, "privacy.external-asr.denied");
  assert.ok(ev, "a refusal to process someone's audio is an accountable act");
});

test("consent is required to be SUPPLIED, not merely absent-and-assumed", async () => {
  // The stored chunk metadata carries no consent — the gateway does not send any — so a caller that
  // forgot to pass it must be refused rather than defaulted to permitted.
  const res = await transcribeSession({
    tenantId: "test-transcript-noconsent",
    learnerId: "learner-1",
    sessionId: "s",
  });
  assert.equal(res.transcribed, false);
  assert.equal(res.reason, "consent-revoked-or-insufficient");
});

test("a session with no stored audio says so, rather than returning an empty transcript", async () => {
  // "no-audio" and "the learner said nothing" are different facts, and only one of them is a
  // statement about the recitation.
  const res = await transcribeSession({
    tenantId: "test-transcript-empty",
    learnerId: "learner-1",
    sessionId: "s-none",
    consent: { externalAsrProcessing: true, guardianApproved: true },
  });
  assert.equal(res.transcribed, false);
  assert.equal(res.reason, "no-audio");
  assert.deepEqual(res.recognizedText, []);
});
