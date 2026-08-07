import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { canShowLearnerFacingAiOutput } from "../../packages/contracts/src/index.ts";
import { predictTajweed } from "../../services/ml-inference/server.mjs";

const forbiddenPerformanceFields = ["confidence", "severity", "reviewStatus"];

function assertInstructionHasNoInventedPerformance(annotation) {
  assert.equal(annotation.analysisBasis, "text-rule");
  assert.equal(annotation.instructional, true);
  for (const field of forbiddenPerformanceFields) {
    assert.equal(Object.hasOwn(annotation, field), false, `instruction contains invented ${field}`);
  }
}

test("production rule output contains no invented confidence or performance judgment", async () => {
  const result = await predictTajweed({
    tenantId: "no-confidence-tenant",
    sessionId: "no-confidence-session",
    quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
  });
  assert.ok(result.annotations.length > 0);
  result.annotations.forEach(assertInstructionHasNoInventedPerformance);
  assert.deepEqual(result.findings, []);
});

test("golden fixture decimals are not reported as learner confidence", () => {
  const storage = mkdtempSync(`${tmpdir()}/qrai-no-invented-confidence-`);
  try {
    const script = `
      const { predictTajweed } = await import('./services/ml-inference/server.mjs');
      const result = await predictTajweed({
        tenantId: 'fixture-tenant', sessionId: 'fixture-session',
        quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: 'Al-Fatihah' }
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        AUDIO_STORAGE_DIR: storage,
        ML_USE_GOLDEN_FIXTURES: "1",
        ML_ACKNOWLEDGE_FIXTURE_OUTPUT: "1",
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.ok(result.annotations.length > 0, "declared fixture returned no instruction");
    result.annotations.forEach(assertInstructionHasNoInventedPerformance);
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

test("a fake numeric confidence cannot turn a text rule into learner feedback", () => {
  assert.equal(
    canShowLearnerFacingAiOutput({
      analysisBasis: "text-rule",
      confidence: 1,
      reviewStatus: "scholar-approved",
      sources: [{ id: "s", title: "Declared source", citation: "fixture" }],
    }),
    false,
  );
});
