#!/usr/bin/env node
/**
 * A model version may not CLAIM it passed evaluation without an evaluation that passes.
 *
 *   node scripts/check-model-eval-claims.mjs --self-test   # prove the checker can fail
 *   node scripts/check-model-eval-claims.mjs               # check the live database
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * `modelEvalPassesReleaseGate` (packages/contracts) encodes the bar a model must clear to ship:
 * wordAlignmentF1 >= 0.9, tajweedF1 >= 0.82, falsePositiveRate <= 0.08, teacherAgreementRate >= 0.9,
 * zero unsourced learner outputs, and `passed`. It was written, unit-tested against fixtures, and
 * CALLED BY NOTHING — one reference in the whole repository outside its own test, its own
 * definition. A release gate that no release runs.
 *
 * Meanwhile `model_versions.status` can say `eval-passed`, and nothing checked that against
 * `eval_runs`. Measured when this was written:
 *
 *     model-v0.3    eval-passed   0.93 / 0.86 / 0.05 / 0.92 / 0 / passed
 *     tajweed-v0.1  eval-passed   NO EVAL RUN AT ALL
 *
 * A model asserting it met a bar nobody measured is a fabricated evaluation — the standing rule this
 * project holds itself to says not to produce one, and the database was carrying one anyway.
 *
 * `status` is read by no service; it is pure EVIDENCE. That is exactly why a false value matters:
 * evidence nothing acts on is evidence nobody re-derives, and it is read years later as fact.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────────────────────────
 * It does not evaluate anything. Running a real evaluation is P3.4/P3.5 — a protocol, a held-out
 * set, representative slices, and a scholar. This only refuses the CLAIM when the evidence is
 * absent or fails, which is the part that can be automated honestly.
 */
import pg from "pg";

import { modelEvalPassesReleaseGate } from "../packages/contracts/src/index.ts";

/** Statuses that assert an evaluation was passed. `draft` and `blocked` claim nothing. */
const CLAIMS_EVALUATION = new Set(["eval-passed", "released"]);

/**
 * The gate's own verdict on one model, or a sentence saying why it has none.
 *
 * Deliberately delegates to `modelEvalPassesReleaseGate` rather than re-checking the thresholds
 * here. A second copy of the bar is a second bar, and the whole finding is that the first one had no
 * caller — reimplementing it would leave that true.
 */
export function claimProblem(model, evalRun) {
  if (!CLAIMS_EVALUATION.has(model.status)) return null;

  if (!evalRun) {
    return `${model.id} claims status "${model.status}" and has NO eval run — nothing measured it`;
  }
  if (!modelEvalPassesReleaseGate(evalRun)) {
    const detail = [
      `wordAlignmentF1=${evalRun.wordAlignmentF1}`,
      `tajweedF1=${evalRun.tajweedF1}`,
      `falsePositiveRate=${evalRun.falsePositiveRate}`,
      `teacherAgreementRate=${evalRun.teacherAgreementRate}`,
      `unsourcedLearnerOutputs=${evalRun.unsourcedLearnerOutputs}`,
      `passed=${evalRun.passed}`,
    ].join(" ");
    return `${model.id} claims status "${model.status}" but its eval run does not clear the gate: ${detail}`;
  }
  return null;
}

/**
 * Prove the checker can fail before trusting it to pass.
 *
 * The licence gate learned this the hard way: it once reported "0 unapproved" because it had been
 * handed zero packages. A checker that has never been shown a bad input is a checker nobody has
 * seen work.
 */
function selfTest() {
  const passing = {
    wordAlignmentF1: 0.93,
    tajweedF1: 0.86,
    falsePositiveRate: 0.05,
    teacherAgreementRate: 0.92,
    unsourcedLearnerOutputs: 0,
    passed: true,
  };
  const cases = [
    ["a draft model needs no evidence", { id: "m", status: "draft" }, null, false],
    ["a blocked model needs no evidence", { id: "m", status: "blocked" }, null, false],
    ["eval-passed with a passing run is fine", { id: "m", status: "eval-passed" }, passing, false],
    ["released with a passing run is fine", { id: "m", status: "released" }, passing, false],
    ["eval-passed with NO run is refused", { id: "m", status: "eval-passed" }, null, true],
    ["released with NO run is refused", { id: "m", status: "released" }, null, true],
    [
      "a run below the alignment bar is refused",
      { id: "m", status: "eval-passed" },
      { ...passing, wordAlignmentF1: 0.89 },
      true,
    ],
    [
      "a run above the false-positive ceiling is refused",
      { id: "m", status: "eval-passed" },
      { ...passing, falsePositiveRate: 0.081 },
      true,
    ],
    [
      "a run with unsourced learner outputs is refused",
      { id: "m", status: "eval-passed" },
      { ...passing, unsourcedLearnerOutputs: 1 },
      true,
    ],
    [
      "a run whose own `passed` is false is refused",
      { id: "m", status: "eval-passed" },
      { ...passing, passed: false },
      true,
    ],
  ];

  let failures = 0;
  for (const [name, model, evalRun, shouldProblem] of cases) {
    const problem = claimProblem(model, evalRun);
    if (Boolean(problem) !== shouldProblem) {
      console.error(`  ✗ self-test: ${name} — expected ${shouldProblem ? "a problem" : "none"}`);
      failures += 1;
    }
  }
  if (failures > 0) {
    console.error(`check-model-eval-claims self-test FAILED (${failures})`);
    process.exit(1);
  }
  console.log(`check-model-eval-claims self-test OK (${cases.length} cases)`);
}

async function checkDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required — this check reads model_versions and eval_runs.");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // ── model_versions is GLOBAL; eval_runs is TENANT-OWNED ─────────────────────────────────────
    // A release asks "has this model been evaluated at all", which crosses tenants — but this
    // connects as `quran_ai_app` (nosuperuser, nobypassrls), so eval_runs is invisible until
    // `app.tenant_id` is set. The first version of this checker did not set it, read zero eval rows,
    // and reported that BOTH models had no evaluation — including the one that demonstrably does.
    // A gate that fails for a reason it invented is worse than one that passes: it teaches people
    // that its findings are noise.
    //
    // So the tenants are enumerated and each is asked in turn, which also keeps the RLS boundary
    // explicit rather than defeated.
    const { rows: models } = await client.query(
      "SELECT id, status FROM model_versions ORDER BY id",
    );
    if (models.length === 0) {
      console.error("✗ no model_versions rows at all — refusing to report a pass on an empty read");
      process.exit(1);
    }

    const { rows: tenants } = await client.query("SELECT id FROM institutions ORDER BY id");
    if (tenants.length === 0) {
      console.error("✗ no institutions — eval_runs is tenant-owned, so nothing could be read");
      process.exit(1);
    }

    /** The most recent eval run for a model, in whichever tenant holds one. */
    const latestEval = new Map();
    for (const { id: tenantId } of tenants) {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const { rows } = await client.query(
        `SELECT DISTINCT ON (model_version_id)
                model_version_id,
                word_alignment_f1::float8      AS "wordAlignmentF1",
                tajweed_f1::float8             AS "tajweedF1",
                false_positive_rate::float8    AS "falsePositiveRate",
                teacher_agreement_rate::float8 AS "teacherAgreementRate",
                unsourced_learner_outputs      AS "unsourcedLearnerOutputs",
                passed
         FROM eval_runs
         ORDER BY model_version_id, created_at DESC`,
      );
      await client.query("ROLLBACK");
      for (const r of rows) {
        if (!latestEval.has(r.model_version_id)) latestEval.set(r.model_version_id, r);
      }
    }

    const problems = models
      .map((m) => claimProblem(m, latestEval.get(m.id) ?? null))
      .filter(Boolean);

    if (problems.length > 0) {
      console.error("✗ model versions claim an evaluation they do not have:");
      for (const p of problems) console.error(`    ${p}`);
      console.error(
        "\n  A status of eval-passed/released asserts a bar was measured. Either attach a passing\n" +
          "  eval run, or set the status to draft — do not leave the claim standing.",
      );
      process.exit(1);
    }

    const claiming = models.filter((m) => CLAIMS_EVALUATION.has(m.status)).length;
    console.log(
      `✓ model eval claims: ${models.length} model version(s), ${claiming} claiming an evaluation, ` +
        `all evidenced (${latestEval.size} with an eval run across ${tenants.length} tenant(s))`,
    );
  } finally {
    await client.end();
  }
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  await checkDatabase();
}
