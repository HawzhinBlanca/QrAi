// Regression tests for audit-trail honesty in the ML inference handlers.
// Hermetic (no network, no DB) — run by `node --test` in the CODYSTEM gate. Importing server.mjs
// is safe: its side effects (listen(), cleanup timers, signal handlers) are gated on `isMain`, so
// importing the module here neither binds a port nor keeps the event loop alive.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
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

// ── P3.2 — fixture output must be a deliberate act, not a flag somebody set once ──────────────────
//
// `ML_USE_GOLDEN_FIXTURES=1` makes `predictAlignment` and `predictTajweed` answer from
// fixtures/golden-evals.json instead of analysing anything. The alignment branch emits
//
//     heardText: w.canonicalText,  status: "matched"
//
// — a FLAWLESS recitation that nobody performed — and the tajweed branch emits the fixture's
// findings. Nothing in either payload says it came from a fixture.
//
// Those findings persist. `persist_tajweed_findings` (handlers/ml_proxy.rs) writes them to
// tajweed_findings with `analysis_basis = 'canonical-text'`, exactly like a real one. So the flag
// being set ONCE — a demo, a staging box, a copied env file — contaminates the corpus permanently,
// and turning it off later does not un-write the rows. A teacher reviewing one cannot tell it from
// analysis of a child's actual recitation.
//
// The flag is genuinely needed for smoke and eval runs. So it is not removed: it is made a
// deliberate act. Requesting fixture output now also requires acknowledging what it means, in a
// variable whose name is the acknowledgement, and the service refuses to start otherwise — the same
// shape as AUDIO_STORAGE_DRIVER refusing a backend it cannot honour rather than quietly using
// another one.

import { spawn as spawnGuarded } from "node:child_process";

/** Start the service with the given env and return { code, stderr } once it has settled. */
function bootWith(env) {
  return new Promise((resolve) => {
    const child = spawnGuarded(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ML_INFERENCE_PORT: "8397",
        ML_API_KEY: "boot-guard-test",
        AUDIO_STORAGE_DIR: mkdtempSync(join(tmpdir(), "ml-boot-")),
        ...env,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.once("exit", (code) => resolve({ code, stderr }));
    // A service that starts successfully never exits; give it a moment, then kill and report that.
    setTimeout(() => child.kill("SIGKILL"), 1500);
  });
}

test("fixture output is REFUSED unless the operator acknowledges what it reports", async () => {
  const { code, stderr } = await bootWith({ ML_USE_GOLDEN_FIXTURES: "1" });
  assert.notEqual(
    code,
    null,
    "the service started with ML_USE_GOLDEN_FIXTURES=1 and no acknowledgement — it would report " +
      "recitations nobody performed, and persist them as though they were real",
  );
  assert.match(
    stderr,
    /ML_ACKNOWLEDGE_FIXTURE_OUTPUT/,
    `the refusal must name the variable that unblocks it, or an operator cannot act on it:\n${stderr}`,
  );
  // The message has to say WHAT it is refusing, not just that it refused.
  assert.match(
    stderr,
    /nobody performed|not analysed|fixture/i,
    `the refusal must say what fixture output actually is:\n${stderr}`,
  );
});

test("fixture output starts normally once acknowledged — smoke and eval still work", async () => {
  // The control. Without it every assertion above is satisfied by a service that refuses to start
  // at all, which would break the smoke and eval runs this flag exists for.
  const { code, stderr } = await bootWith({
    ML_USE_GOLDEN_FIXTURES: "1",
    ML_ACKNOWLEDGE_FIXTURE_OUTPUT: "1",
  });
  assert.equal(code, null, `acknowledged fixture mode still refused to start:\n${stderr}`);
});

test("the default path is unaffected — no flag, no acknowledgement, normal boot", async () => {
  const { code, stderr } = await bootWith({});
  assert.equal(code, null, `the service refuses to start with no fixture flags at all:\n${stderr}`);
});

// ── The external-ASR consent gate, held to the shared corpus ─────────────────────────────────────
//
// packages/contracts/fixtures/canonical-gates.json describes `canUseExternalAsr` as "the only thing
// stopping audio leaving without guardian consent", and pins all four combinations "so a port cannot
// implement OR by mistake". Five code sites implement that rule — contracts, recitation.rs:160,
// session-writes.mjs:129, and TWO expressions in this file (server.mjs:473 and :1184) — and only the
// reference was ever checked against the corpus.
//
// The test above covers exactly one combination, for a CHILD profile. The rule is not about children:
// an adult learner's recording must not leave either. These run the corpus's four cases through the
// real decision on the default profile, and assert on the AUDIT TRAIL rather than the return value —
// `privacy.external-asr.called` is the record of audio actually being sent, which is the thing the
// rule exists to prevent.

const ASR_CORPUS = JSON.parse(
  readFileSync(new URL("../../packages/contracts/fixtures/canonical-gates.json", import.meta.url), "utf8"),
)["canUseExternalAsr"];

test("no combination the corpus forbids ever sends audio to external ASR", async () => {
  const cases = ASR_CORPUS?.cases ?? [];
  assert.equal(cases.length, 4, `the corpus should pin all four combinations, found ${cases.length}`);
  assert.ok(
    cases.some((c) => c.expected === true) && cases.some((c) => c.expected === false),
    "the corpus must contain both answers, or a gate hardcoded to false satisfies it — which would " +
      "silently disable external ASR entirely rather than gate it",
  );

  const wrong = [];
  for (const c of cases) {
    const { externalAsrProcessing, guardianApproved } = c.input;
    const tenantId = `asr-corpus-${externalAsrProcessing}-${guardianApproved}-${Date.now()}`;
    // In this hermetic suite there IS no ASR service, so "the audio was sent" manifests two ways: an
    // audited `privacy.external-asr.called`, or `transcribeAudio` throwing on a fetch to nothing.
    // Both mean the gate let it through; only "neither happened" means it was stopped.
    let attempted = false;
    try {
      await predictAlignment({
      tenantId,
      sessionId: "s-corpus",
      // NOT a child profile: this rule is about consent, not about age, and the child check is an
      // ADDITIONAL condition layered on top of it (server.mjs:481).
      externalAsrRequested: true,
      consent: { externalAsrProcessing, guardianApproved },
      audioBase64: "AAAA",
        quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      });
    } catch {
      attempted = true;
    }
    attempted ||= lastEvent(tenantId, "privacy.external-asr.called") !== undefined;

    if (attempted !== c.expected) {
      wrong.push(
        `${c.name}: corpus says ${c.expected ? "permitted" : "FORBIDDEN"}, audio was ` +
          `${attempted ? "SENT" : "not sent"}`,
      );
    }
  }

  assert.deepEqual(
    wrong,
    [],
    `the external-ASR gate disagrees with the corpus that describes it as the only thing stopping\n` +
      `audio leaving without guardian consent:\n  ${wrong.join("\n  ")}`,
  );
});

// ── The retention sweep and the contract gate must agree on every mode ────────────────────────────
//
// `mustDiscardAudio` (packages/contracts) had NO CALLER — one of two exported contract functions
// nothing referenced. So its disagreement with this service went unnoticed: it answered
// `retention === "discard"`, a denylist of one, while the sweep here has always applied the discard
// TTL to anything it does not recognise.
//
// They matched on every value in the vocabulary and differed on the one OUTSIDE it, in the direction
// that matters — the contract function said "you may keep it" for a child's recording held under a
// policy nobody can state. `services/shared-ticket` carries `audio_retention` as a deliberately
// unvalidated string on the stated grounds that an unknown value "can only shorten retention", which
// is true only if every consumer treats unknown as discard.
//
// This runs the corpus through BOTH, so the agreement is pinned rather than coincidental.

const RETENTION_CORPUS = JSON.parse(
  readFileSync(new URL("../../packages/contracts/fixtures/canonical-gates.json", import.meta.url), "utf8"),
)["mustDiscardAudio"];

test("the retention sweep destroys exactly what the contract says must be destroyed", async () => {
  const { mustDiscardAudio } = await import("../../packages/contracts/src/index.ts");
  const { retentionTtlHours } = await import("./server.mjs");

  const cases = RETENTION_CORPUS?.cases ?? [];
  assert.ok(cases.length >= 5, `the retention corpus is down to ${cases.length} cases; it had 5`);
  assert.ok(
    cases.some((c) => c.expected === true) && cases.some((c) => c.expected === false),
    "the corpus must contain both answers, or a gate hardcoded either way satisfies it",
  );

  // The premise the comparison rests on: if the two TTLs were configured equal, "is this the discard
  // TTL" could not distinguish anything and every case would pass for the wrong reason.
  assert.notEqual(
    retentionTtlHours("discard"),
    retentionTtlHours("teacher-review"),
    "the discard and review TTLs are equal, so this test cannot tell them apart — set " +
      "AUDIO_RETENTION_DISCARD_TTL_HOURS and AUDIO_RETENTION_REVIEW_TTL_HOURS to different values",
  );

  const wrong = [];
  for (const c of cases) {
    const retention = c.input;
    const contractSaysDestroy = mustDiscardAudio(retention);
    // `training-opt-in` never reaches the TTL branch — the sweep `continue`s on it — so the sweep's
    // answer for it is "keep forever", which is `false` for "must destroy".
    const sweepSaysDestroy =
      retention === "training-opt-in" ? false : retentionTtlHours(retention) === retentionTtlHours("discard");

    if (contractSaysDestroy !== sweepSaysDestroy) {
      wrong.push(
        `${JSON.stringify(retention)}: contract says ${contractSaysDestroy ? "DESTROY" : "keep"}, ` +
          `sweep says ${sweepSaysDestroy ? "DESTROY" : "keep"}`,
      );
    }
    if (contractSaysDestroy !== c.expected) {
      wrong.push(`${JSON.stringify(retention)}: contract disagrees with the corpus`);
    }
  }

  assert.deepEqual(
    wrong,
    [],
    `the retention gate and the sweep that enforces it disagree:\n  ${wrong.join("\n  ")}`,
  );
});
