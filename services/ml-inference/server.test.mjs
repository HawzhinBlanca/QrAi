// Regression tests for audit-trail honesty in the ML inference handlers.
// Hermetic (no network, no DB) — run by `node --test` in the CODYSTEM gate. Importing server.mjs
// is safe: its side effects (listen(), cleanup timers, signal handlers) are gated on `isMain`, so
// importing the module here neither binds a port nor keeps the event loop alive.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  predictAlignment,
  predictTajweed,
  createEvalRun,
  getAuditEvents,
  safeStorageSegment,
  route,
} from "./server.mjs";

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

test("alignment audit event records the REAL confidence and word counts, not the golden fixture's", async () => {
  const tenantId = "test-audit-alignment-honesty";
  // Default quranRef (Al-Fatihah 1:1-7) intentionally matches a golden fixture, with no audio and
  // no recognizedText → the real path scores a perfect (canonical == recognized) recitation.
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
  assert.equal(ev.details.recognizedCount, res.alignments.length, "audit recognizedCount must match too");
  // A perfect real recitation of the full canonical set scores 1.0 — NOT the fixture's 0.94 — and
  // spans the real 29-word Al-Fatihah 1:1-7, NOT the fixture's 8-word abbreviation.
  assert.equal(res.confidence, 1, "perfect default recitation scores 1.0 (real path)");
  assert.ok(res.alignments.length > 8, `expected the real 29-word set, got ${res.alignments.length}`);
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
