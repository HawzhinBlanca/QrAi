// Regression tests for audit-trail honesty in the ML inference handlers.
// Hermetic (no network, no DB) — run by `node --test` in the CODYSTEM gate. Importing server.mjs
// is safe: its side effects (listen(), cleanup timers, signal handlers) are gated on `isMain`, so
// importing the module here neither binds a port nor keeps the event loop alive.

import assert from "node:assert/strict";
import { test } from "node:test";

import { predictAlignment, predictTajweed, getAuditEvents } from "./server.mjs";

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
