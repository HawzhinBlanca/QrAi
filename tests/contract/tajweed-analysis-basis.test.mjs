import assert from "node:assert/strict";
import test from "node:test";

import { predictTajweed } from "../../server/src/inference/runtime.mjs";

const requestFor = (tenantId, sessionId) => ({
  tenantId,
  sessionId,
  sourceChecksum: "declared-contract-fixture",
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
});

test("the real deterministic analyser emits instruction, never learner-performance findings", async () => {
  const result = await predictTajweed(requestFor("basis-tenant", "basis-session"));
  assert.ok(result.annotations.length > 0, "real Al-Fatihah analysis returned no instruction");
  assert.deepEqual(result.findings, []);

  for (const annotation of result.annotations) {
    assert.equal(annotation.analysisBasis, "text-rule");
    assert.equal(annotation.instructional, true);
    for (const forbidden of ["confidence", "severity", "reviewStatus"]) {
      assert.equal(Object.hasOwn(annotation, forbidden), false, forbidden);
    }
  }
});

test("instruction semantics do not change with learner, tenant, or session identity", async () => {
  const first = await predictTajweed(requestFor("basis-tenant-a", "basis-session-a"));
  const second = await predictTajweed(requestFor("basis-tenant-b", "basis-session-b"));
  const semantics = (result) =>
    result.annotations.map(({ wordId, rule, explanation, sources, analysisBasis, instructional }) => ({
      wordId,
      rule,
      explanation,
      sources,
      analysisBasis,
      instructional,
    }));
  assert.deepEqual(semantics(second), semantics(first));
});
