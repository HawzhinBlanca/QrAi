import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const verifySource = readFileSync(join(repo, "scripts", "verify.sh"), "utf8");
const ciSource = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
const mlSmokeSource = readFileSync(join(repo, "scripts", "smoke-ml.mjs"), "utf8");
const goldenFixture = JSON.parse(
  readFileSync(join(repo, "server", "src", "inference", "fixtures", "golden-evals.json"), "utf8"),
);

const GOLDEN_REGRESSION = "tests/inference/golden-regression.test.mjs";
const INVOCATION_GUARD = "tests/contract/verify-invocations.test.mjs";
const EVAL_EVIDENCE_MIGRATION = "tests/migrations/eval-evidence-migration.test.mjs";
const JOB_OUTBOX_MIGRATION = "tests/migrations/job-outbox-migration.test.mjs";
const DEVICE_IDENTITY_MIGRATION = "tests/migrations/device-identity-migration.test.mjs";
const DEVICE_SESSIONS = "tests/node-api/device-sessions.test.mjs";
const DEVICE_ENROLLMENT = "tests/e2e/device-enrollment.test.mjs";
const DURABLE_JOBS = "tests/jobs/durable-jobs.test.mjs";
const LOCAL_INFERENCE_WORKER = "tests/jobs/local-inference-worker.test.mjs";
const COMPATIBILITY_INGRESS = "tests/inference/compatibility-ingress.test.mjs";
const AUDIO_RETENTION_WORKER = "tests/inference/audio-retention-worker.test.mjs";
const BOUNDED_WINDOW_SPANS = "tests/inference/bounded-window-spans.test.mjs";
const CANONICAL_BYTES_ALIGNMENT = "tests/inference/canonical-bytes-through-alignment.test.mjs";
const FORCED_ALIGN_SPANS = "test_forced_align_spans.py";
const INFERENCE_COMPATIBILITY_SURFACE = "tests/contract/inference-compatibility-surface.test.mjs";
const API_JOB_WAIT = "tests/jobs/api-job-wait.test.mjs";
const INFERENCE_CANCELLATION = "tests/jobs/inference-cancellation.test.mjs";
const DURABLE_WORKFLOWS = "tests/e2e/durable-workflows.test.mjs";
const WORKER_LIFECYCLE = "tests/node-api/worker-lifecycle.test.mjs";
const JOB_BOUNDARY = "tests/security/job-boundary.test.mjs";
const MODEL_CLAIM_AUTHORITY = "tests/release/model-claim-authority.test.mjs";
const RELEASE_ARTIFACT_CONSUMPTION = "tests/release/release-artifact-consumption.test.mjs";
const RELEASE_DEPLOYMENT_SELECTION = "tests/release/release-deployment-selection.test.mjs";
const HTTP_CANARY_TOPOLOGY = "tests/contract/http-canary-topology.test.mjs";
const HTTP_CANARY_EFFECTS = "tests/e2e/http-canary-effects.test.mjs";
const HTTP_CANARY_IMAGE = "tests/release/http-canary-image.test.mjs";
const HTTP_CANARY_LOAD = "scripts/load-test.test.mjs";
const HTTP_CANARY_MONITORING = "tests/observability/http-canary-monitoring.test.mjs";
const HTTP_CANARY_CONTROLLER = "tests/release/http-canary-controller.test.mjs";
const HTTP_CANARY_ROLLBACK_EVIDENCE = "tests/release/canary-rollback-evidence.test.mjs";
const REALTIME_DECISIONS = "tests/contract/realtime-decisions.test.mjs";
const REALTIME_PROTOCOL_FIXTURES = "tests/realtime/protocol-fixtures.test.mjs";
const REALTIME_PROCESS_LIFECYCLE = "tests/realtime/process-lifecycle.test.mjs";
const REALTIME_TICKET_BOUNDARY = "tests/realtime/ticket-boundary.test.mjs";
const ACOUSTIC_CANDIDATE_PROOF_TEST = "scripts/acoustic-candidate-proof.test.mjs";
const ACOUSTIC_CANDIDATE_PROOF_RUNNER = "node scripts/acoustic-candidate-proof.mjs";

function activeNodeTestLines(source) {
  return source
    .split("\n")
    .filter((line) => line.includes("node ") && line.includes("--test "))
    .filter((line) => !line.trimStart().startsWith("#"));
}

test("canonical verification runs the deterministic golden regression exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  const goldenInvocations = invocations.filter((line) => line.includes(GOLDEN_REGRESSION));

  assert.equal(
    goldenInvocations.length,
    1,
    `${GOLDEN_REGRESSION} must appear in exactly one active node --test invocation`,
  );
  assert.ok(
    invocations.some((line) => line.includes(INVOCATION_GUARD)),
    `${INVOCATION_GUARD} must protect its own canonical invocation`,
  );
});

test("golden regression fixture is mechanically ineligible for authoritative claims", () => {
  assert.deepEqual(
    {
      evidenceKind: goldenFixture.evidenceKind,
      evidenceEligibility: goldenFixture.evidenceEligibility,
      modelEvaluationEligible: goldenFixture.modelEvaluationEligible,
      calibrationEligible: goldenFixture.calibrationEligible,
      releaseEligible: goldenFixture.releaseEligible,
    },
    {
      evidenceKind: "deterministic-regression-fixture",
      evidenceEligibility: "fixture-only-not-model-evaluation-or-calibration",
      modelEvaluationEligible: false,
      calibrationEligible: false,
      releaseEligible: false,
    },
  );
});

// W1.13's proof clause is "verify guard and fixture-label mutation". The guard above is the label
// half, and it holds: measured, all seven label mutations (flipping releaseEligible /
// modelEvaluationEligible / calibrationEligible to true, rewriting evidenceKind or
// evidenceEligibility, deleting one label, deleting every label) fail it.
//
// The other half is the pass BAR. `golden-regression.test.mjs` recomputes F1 for real and asserts it
// meets `thresholds` — deliberately not committed constants, so the numbers are earned rather than
// pinned. But the thresholds themselves live in the same fixture, so the bar grades its own exam:
// measured, setting every threshold to 0 leaves all 61 assertions across the golden regression, the
// invocation guard, the module-boundary suite and both release-evidence suites green. One edit to
// one JSON file silently retires the deterministic regression, and AGENTS.md's "never disable a
// failing test to make CI pass" has nothing to catch it with.
//
// So the floor is committed HERE, in the file whose job is that the gate cannot be quietly weakened.
// Raising a threshold stays a one-line fixture edit. Lowering one now requires editing this test
// too — a visible, reviewable act rather than a silent one.
const ENFORCED_THRESHOLD_FLOORS = {
  // `>=` lower bounds actually read by golden-regression.test.mjs.
  wordAlignmentF1: 0.9,
};
const EXACT_THRESHOLDS = {
  // Read as an equality: findings without a source are never acceptable, at any count.
  unsourcedLearnerOutputs: 0,
};
// Published in the fixture but read by NOTHING (verified: zero `thresholds.<key>` references across
// tests/, scripts/ and server/). They are listed rather than quietly tolerated so that this suite
// states today's real coverage instead of implying five thresholds gate something when two do.
// Enforcing them belongs to W1.12's reproducible evaluator, not to a fixture that grades itself.
const DECLARED_UNENFORCED_THRESHOLDS = ["tajweedF1", "falsePositiveRate", "teacherAgreementRate"];

test("the golden regression's pass bar cannot be lowered without editing this test", () => {
  for (const [key, floor] of Object.entries(ENFORCED_THRESHOLD_FLOORS)) {
    const actual = goldenFixture.thresholds?.[key];
    assert.equal(typeof actual, "number", `thresholds.${key} is missing or not a number`);
    assert.ok(
      actual >= floor,
      `thresholds.${key} was lowered from its committed floor ${floor} to ${actual}. That retires ` +
        `the deterministic regression without failing anything — which is the point of this test.`,
    );
  }

  for (const [key, exact] of Object.entries(EXACT_THRESHOLDS)) {
    assert.equal(goldenFixture.thresholds?.[key], exact, `thresholds.${key} must stay exactly ${exact}`);
  }
});

test("every published threshold is either enforced with a floor or declared unenforced", () => {
  // Adding a threshold to the fixture must be a decision, not a decoration: either it gates
  // something and gets a committed floor here, or it is named as unenforced. Without this, a new
  // number can be added, cited as if it were a gate, and never be read by anything.
  const published = Object.keys(goldenFixture.thresholds ?? {}).sort();
  const accounted = [
    ...Object.keys(ENFORCED_THRESHOLD_FLOORS),
    ...Object.keys(EXACT_THRESHOLDS),
    ...DECLARED_UNENFORCED_THRESHOLDS,
  ].sort();

  assert.deepEqual(
    published,
    accounted,
    "a threshold appeared in or vanished from golden-evals.json without being classified here as " +
      "enforced (with a floor) or explicitly unenforced",
  );
});

test("canonical verification runs the row-authoritative offline evaluator suite exactly once", () => {
  const command = "python3 test_eval_pipeline.py";
  const activeInvocations = verifySource
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes(command));
  assert.equal(activeInvocations.length, 1, `${command} must run exactly once in canonical verification`);
});

test("CI installs the exact Python test prerequisites invoked by canonical verification", () => {
  assert.match(ciSource, /python-version:\s*["']3\.11["']/);
  assert.match(ciSource, /python3 -m pip install --quiet "numpy==2\.4\.6" "pytest==9\.1\.1"/);
  assert.match(
    ciSource,
    /--index-url https:\/\/download\.pytorch\.org\/whl\/cpu "torch==2\.12\.1" "torchaudio==2\.11\.0"/,
  );
  assert.match(verifySource, /python3 -m pytest -q test_model_attribution\.py test_acoustic_tajweed\.py/);
});

test("canonical verification runs the forced-aligner producer span suite exactly once", () => {
  const target = FORCED_ALIGN_SPANS;
  const activeInvocations = verifySource
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes(target));
  assert.equal(activeInvocations.length, 1, `${target} must run exactly once in canonical verification`);
});

test("canonical verification runs the evaluation-evidence migration suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(EVAL_EVIDENCE_MIGRATION)).length,
    1,
    `${EVAL_EVIDENCE_MIGRATION} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable job-outbox migration suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(JOB_OUTBOX_MIGRATION)).length,
    1,
    `${JOB_OUTBOX_MIGRATION} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the device-identity migration suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(DEVICE_IDENTITY_MIGRATION)).length,
    1,
    `${DEVICE_IDENTITY_MIGRATION} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the device-session runtime suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(DEVICE_SESSIONS)).length,
    1,
    `${DEVICE_SESSIONS} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the device-enrollment route suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(DEVICE_ENROLLMENT)).length,
    1,
    `${DEVICE_ENROLLMENT} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable job store/runtime suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(DURABLE_JOBS)).length,
    1,
    `${DURABLE_JOBS} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the local inference boundary suites exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [
    LOCAL_INFERENCE_WORKER,
    API_JOB_WAIT,
    INFERENCE_CANCELLATION,
    COMPATIBILITY_INGRESS,
    AUDIO_RETENTION_WORKER,
    INFERENCE_COMPATIBILITY_SURFACE,
  ]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must run exactly once in canonical verification`,
    );
  }
});

test("canonical verification runs the bounded-window span suite exactly once", () => {
  // W1.6/QA-2. This suite directly covers `boundedPcmWindows` and `recognizedTokensFrom`, which
  // compose local model timings onto the absolute session timeline. The Python producer suite is
  // guarded independently above because it runs in a separate pytest invocation.
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(BOUNDED_WINDOW_SPANS)).length,
    1,
    `${BOUNDED_WINDOW_SPANS} must run exactly once in canonical verification`,
  );

  // W1.7. This one guards canonical Quran bytes crossing the alignment engine unaltered. Measured:
  // normalizing `canonicalText` leaves the alignment engine, marks-parity, golden-regression and
  // session-transcript suites entirely green, and is caught only by the Node-vs-Rust effect differ
  // in tests/api-parity/effect-parity.test.mjs. impact-map.md §8.3 retires that Rust oracle and
  // names "A/B oracle tests" among the casualties, so without this unit-level suite the invariant
  // loses its last guard on the day the oracle is deleted.
  assert.equal(
    invocations.filter((line) => line.includes(CANONICAL_BYTES_ALIGNMENT)).length,
    1,
    `${CANONICAL_BYTES_ALIGNMENT} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable domain workflow suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(DURABLE_WORKFLOWS)).length,
    1,
    `${DURABLE_WORKFLOWS} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable worker lifecycle suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(WORKER_LIFECYCLE)).length,
    1,
    `${WORKER_LIFECYCLE} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable job security boundary exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(JOB_BOUNDARY)).length,
    1,
    `${JOB_BOUNDARY} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the expanded learner-feedback gate exactly once", () => {
  const target = "tests/contract/learner-feedback-gate.test.mjs";
  const count = activeNodeTestLines(verifySource).filter((line) => line.includes(target)).length;
  assert.equal(count, 1, `${target} must appear exactly once in the active canonical Node test command`);
});

test("canonical verification runs learner-owned delayed-review history exactly once", () => {
  const target = "tests/e2e/learner-history.test.mjs";
  const count = activeNodeTestLines(verifySource).filter((line) => line.includes(target)).length;
  assert.equal(count, 1, `${target} must appear exactly once in canonical verification`);
});

test("canonical verification runs both ordered Node boundary gates exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [
    "tests/node-api/middleware-order.test.mjs",
    "tests/security/node-boundary.test.mjs",
  ]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must appear exactly once in canonical verification`,
    );
  }
});

test("canonical verification runs all database boundary gates exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [
    "tests/node-api/db-architecture.test.mjs",
    "tests/node-api/db-role-guard.test.mjs",
    "tests/node-api/db-tenant.test.mjs",
  ]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must appear exactly once in canonical verification`,
    );
  }
});

test("canonical verification runs the shared dependency-timeout fault suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  const target = "tests/faults/dependency-timeouts.test.mjs";
  assert.equal(
    invocations.filter((line) => line.includes(target)).length,
    1,
    `${target} must appear exactly once in canonical verification`,
  );
});

test("canonical verification runs the bounded graceful-shutdown proof exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  const target = "tests/node-api/graceful-shutdown.test.mjs";
  assert.equal(
    invocations.filter((line) => line.includes(target)).length,
    1,
    `${target} must appear exactly once in canonical verification`,
  );
});

test("canonical verification runs the private audio lifecycle proof exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  const target = "tests/e2e/audio-lifecycle.test.mjs";
  assert.equal(
    invocations.filter((line) => line.includes(target)).length,
    1,
    `${target} must appear exactly once in canonical verification`,
  );
});

test("ML smoke uses the offline evaluator and signature verifier, never an online eval POST", () => {
  assert.match(mlSmokeSource, /services\/asr-inference\/evaluate_candidate\.py/);
  assert.match(mlSmokeSource, /verifyModelEvidenceBundle/);
  assert.doesNotMatch(mlSmokeSource, /postJson\(["']\/v1\/eval-runs["']/);
  assert.match(mlSmokeSource, /eligibility:\s*["']fixture-regression["']/);
  assert.match(mlSmokeSource, /releaseTrusted\s*===\s*false/);
});

test("canonical verification runs the release-authority selection suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(MODEL_CLAIM_AUTHORITY)).length,
    1,
    `${MODEL_CLAIM_AUTHORITY} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable release-artifact contracts exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [RELEASE_ARTIFACT_CONSUMPTION, RELEASE_DEPLOYMENT_SELECTION]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must run exactly once in canonical verification`,
    );
  }
});

test("canonical verification runs every HTTP canary topology, proof, load, monitoring, and rollback contract exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [
    HTTP_CANARY_TOPOLOGY,
    HTTP_CANARY_EFFECTS,
    HTTP_CANARY_IMAGE,
    HTTP_CANARY_LOAD,
    HTTP_CANARY_MONITORING,
    HTTP_CANARY_CONTROLLER,
    HTTP_CANARY_ROLLBACK_EVIDENCE,
  ]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must run exactly once in canonical verification`,
    );
  }
});

test("canonical verification runs both W3.1 realtime contract gates exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [REALTIME_DECISIONS, REALTIME_PROTOCOL_FIXTURES]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must run exactly once in canonical verification`,
    );
  }
});

test("canonical verification runs the W3.2 realtime process lifecycle exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(REALTIME_PROCESS_LIFECYCLE)).length,
    1,
    `${REALTIME_PROCESS_LIFECYCLE} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the W3.3 realtime admission boundary exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(REALTIME_TICKET_BOUNDARY)).length,
    1,
    `${REALTIME_TICKET_BOUNDARY} must run exactly once in canonical verification`,
  );
});

test("canonical verification guards the W1.10 exact-image harness and release mode runs it exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(ACOUSTIC_CANDIDATE_PROOF_TEST)).length,
    1,
    `${ACOUSTIC_CANDIDATE_PROOF_TEST} must run exactly once in canonical verification`,
  );

  const activeRunnerLines = verifySource
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes(ACOUSTIC_CANDIDATE_PROOF_RUNNER));
  assert.equal(
    activeRunnerLines.length,
    1,
    `${ACOUSTIC_CANDIDATE_PROOF_RUNNER} must run exactly once in release verification`,
  );
  assert.match(
    verifySource,
    /if \[\[ "\$RELEASE" == "yes" \]\]; then[\s\S]*node scripts\/acoustic-candidate-proof\.mjs/,
  );
});

test("the minimum-Node projection still extracts the W1.10 guard from canonical verification", () => {
  const marker = ciSource.match(/if '([^']+)' in line:/)?.[1];
  assert.equal(typeof marker, "string", "the node-min workflow must declare its verify.sh line marker");

  const canonicalLine = verifySource.split("\n").find((line) => line.includes(marker));
  assert.ok(canonicalLine, `the node-min marker ${JSON.stringify(marker)} must match an active verify.sh line`);

  const extracted = canonicalLine.match(/[\w./-]+\.test\.mjs/g) ?? [];
  assert.equal(
    extracted.filter((path) => path === ACOUSTIC_CANDIDATE_PROOF_TEST).length,
    1,
    `${ACOUSTIC_CANDIDATE_PROOF_TEST} must survive the minimum-Node workflow projection exactly once`,
  );
});
