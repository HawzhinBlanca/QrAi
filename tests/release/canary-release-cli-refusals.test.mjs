/**
 * The canary release operator REFUSES, proven by running it. (W2.18)
 *
 *   node --test tests/release/canary-release-cli-refusals.test.mjs
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * `scripts/http-canary-release-evidence.mjs` is the outermost gate on a production canary: given a
 * candidate commit and twelve external evidence documents, it decides whether a rollout may
 * proceed. `scripts/verify.sh --release` calls it twice, and nothing ships without it.
 *
 * Its checks were covered only by a SOURCE-TEXT assertion —
 * `canary-rollback-evidence.test.mjs` reads the file and matches regexes like `/--validate-only/`
 * and `/status[\s\S]*--porcelain/`. That proves the words are present, not that the program acts on
 * them. Measured: replacing
 *
 *     if (headSha !== expectedSha) fail("--candidate-sha does not match the checked-out candidate");
 *
 * with `if (false) …` — evidence from any other commit now passes as this candidate's — left all 26
 * assertions across the four canary suites green, because the string it greps for is still there.
 * The same held for the clean-checkout requirement, the rule that each approval role must use a
 * distinct file, and the promotion-readiness assertion: four for four survived.
 *
 * The code is correct today; that was verified by running it. What was missing is any test that
 * would notice if it stopped being correct. So this file executes the operator as a process and
 * asserts what it does, not what it contains.
 *
 * ── What is NOT covered here, deliberately ──────────────────────────────────────────────────────
 * The clean-checkout and distinct-approval-file checks are ordered BEHIND the candidate-sha check
 * and behind each other, so reaching them requires driving the operator inside a purpose-built git
 * repository with twelve valid signed documents. That is worth doing and is not done here. Naming
 * the gap is the point: this file covers the candidate-binding check — the one that stops evidence
 * from another commit being presented as this one's — plus the argument contract, and says plainly
 * that the remaining two are still source-checked only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPERATOR = "scripts/http-canary-release-evidence.mjs";

/** Every document flag the operator requires, pointed at paths that need not exist. */
const EVIDENCE_FLAGS = [
  "--candidate-evidence",
  "--classroom-load-evidence",
  "--burst-load-evidence",
  "--soak-load-evidence",
  "--observation-evidence",
  "--healthy-controller-evidence",
  "--rollback-controller-evidence",
  "--remote-ci-evidence",
  "--owner-approval",
  "--security-approval",
  "--sre-approval",
  "--trust-policy",
];

const documentArgs = (overrides = {}) =>
  EVIDENCE_FLAGS.flatMap((flag) => [flag, overrides[flag] ?? `/nonexistent/${flag.slice(2)}.json`]);

/** Run the operator and return {code, output}. It must never throw its way past a refusal. */
function runOperator(args) {
  try {
    const stdout = execFileSync("node", [OPERATOR, ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const headSha = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

test("evidence from a different commit cannot be presented as this candidate's", () => {
  // The protection that matters most. Release evidence is only meaningful bound to the exact tree it
  // was produced from; without this, yesterday's passing canary run authorises today's rollout.
  const result = runOperator([
    "--validate-only",
    "--candidate-sha",
    "0".repeat(40),
    ...documentArgs(),
  ]);

  assert.notEqual(result.code, 0, "the operator accepted a candidate sha that is not the checkout");
  assert.match(
    result.output,
    /--candidate-sha does not match the checked-out candidate/,
    `expected the candidate-binding refusal, got: ${result.output.trim().slice(0, 300)}`,
  );
});

test("the refusal happens before any evidence document is read", () => {
  // Ordering is load-bearing: the paths above do not exist, so if the operator read documents first
  // it would fail for a missing file and the candidate-binding check would never run. That would
  // still LOOK like a refusal while proving nothing about commit binding.
  const result = runOperator([
    "--validate-only",
    "--candidate-sha",
    "0".repeat(40),
    ...documentArgs(),
  ]);

  assert.doesNotMatch(
    result.output,
    /does not exist|cannot be read|must be valid JSON/,
    "the operator reached document loading before checking which candidate the evidence is for",
  );
});

test("a correct candidate sha does not by itself authorise anything", () => {
  // The complement of the test above, and the reason it is not enough on its own: matching the sha
  // must not be a free pass. With the real HEAD the operator must still refuse — here on the next
  // requirement in the chain — rather than proceeding on unreadable evidence.
  const result = runOperator(["--validate-only", "--candidate-sha", headSha(), ...documentArgs()]);

  assert.notEqual(result.code, 0, "a matching candidate sha alone was treated as sufficient");
  assert.doesNotMatch(
    result.output,
    /--candidate-sha does not match/,
    "the real HEAD was rejected as a mismatch",
  );
});

test("every required document flag is genuinely required", () => {
  // One omitted flag at a time, so a check that only ever validated the first one cannot pass.
  for (const omitted of EVIDENCE_FLAGS) {
    const kept = EVIDENCE_FLAGS.filter((flag) => flag !== omitted).flatMap((flag) => [
      flag,
      `/nonexistent/${flag.slice(2)}.json`,
    ]);
    const result = runOperator(["--validate-only", "--candidate-sha", headSha(), ...kept]);

    assert.notEqual(result.code, 0, `${omitted} was not required`);
    assert.match(
      result.output,
      new RegExp(`${omitted} is required`),
      `omitting ${omitted} produced: ${result.output.trim().slice(0, 200)}`,
    );
  }
});

test("the argument contract refuses duplicates, unknowns, and output during validation", () => {
  const sha = headSha();

  const duplicate = runOperator([
    "--validate-only",
    "--candidate-sha",
    sha,
    "--candidate-sha",
    sha,
    ...documentArgs(),
  ]);
  assert.match(duplicate.output, /duplicate argument/, "a repeated flag was accepted");

  const unknown = runOperator([
    "--validate-only",
    "--candidate-sha",
    sha,
    "--not-a-real-flag",
    "x",
    ...documentArgs(),
  ]);
  assert.match(unknown.output, /unknown argument/, "an unrecognised flag was accepted");

  // `--validate-only` must never write closure output: a validation run that also produces the
  // artifact downstream steps consume would make "we only checked" indistinguishable from "we
  // approved".
  const withOutput = runOperator([
    "--validate-only",
    "--candidate-sha",
    sha,
    "--output",
    "/nonexistent/closure.json",
    ...documentArgs(),
  ]);
  assert.match(withOutput.output, /--output is not accepted with --validate-only/);
});
