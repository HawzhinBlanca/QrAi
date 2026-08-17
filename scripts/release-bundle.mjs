#!/usr/bin/env node
/**
 * Assemble the release evidence bundle: run the producers, in order, into one directory. (P0.4)
 *
 * ── The gap this fills ──────────────────────────────────────────────────────────────────────────
 * `scripts/release-manifest.mjs --generate` is the thing that binds a candidate. NOTHING IN THIS
 * REPOSITORY INVOKED IT — `grep -rn "release-manifest.mjs"` returned only prose in `specs/` and
 * `docs/`, the script itself, and its own tests. `scripts/release-build-evidence.mjs` had ZERO
 * callers of any kind. `.github/workflows/release-challenge.yml` passes eight file paths that no
 * process produced together.
 *
 * So the release chain was a set of parts, tested individually, that had never been run as a chain.
 * That is the same shape as the two defects it already cost: an SPDX SBOM required by a consumer
 * and emitted by no producer (#439), and a digest map keyed by tag against a consumer requiring
 * service names (#445). Both were invisible because nothing ran end to end.
 *
 * ── What this DOES NOT do, and why that is the point ────────────────────────────────────────────
 * It does not run `verify.sh --release`, and it does not call `scripts/release-evidence-summary.mjs`.
 *
 * That script writes `status: "passed"` and `command: "bash scripts/verify.sh --release"` as string
 * LITERALS. Those literals are honest exactly because `verify.sh` invokes it at :371, AFTER the
 * `if [[ "$fail" -ne 0 ]]; then exit 1; fi` guard at :365 — the line is unreachable on a failing
 * gate. Called from here, it would fabricate a passing test summary for a gate this script never
 * ran, which is the precise failure this project keeps finding in itself.
 *
 * The test and environment summaries are therefore INPUTS. `verify.sh --release` produces them, on
 * success, and hands them over. Same for the smoke run: this reads the summary that
 * `scripts/smoke-all.mjs` wrote during that gate rather than re-running or re-asserting it.
 *
 * `trusted-signers.json` is an input too, and always will be: it names who is permitted to sign a
 * release. That is a statement by the release authority (P0.1), not something a script may mint.
 *
 * Image digests are an input because producing them needs a Docker daemon and a registry
 * (`scripts/release-images.mjs`). CI has both; this keeps the assembler runnable and testable where
 * they are absent.
 *
 * ── What it produces ────────────────────────────────────────────────────────────────────────────
 *   sbom.spdx.json           generate-sbom.mjs
 *   build-provenance.json    release-build-evidence.mjs
 *   build-summary.json       release-build-evidence.mjs
 *   smoke-summary.json       copied from <smoke-artifact-dir>/summary.json  (see below)
 *   test-summary.json        copied from the input
 *   environment-summary.json copied from the input
 *   trusted-signers.json     copied from the input
 *   candidate-evidence.json  release-manifest.mjs --generate
 *
 * Exactly the eight names `release-challenge.yml:97-104` passes.
 *
 * ── The smoke filename ──────────────────────────────────────────────────────────────────────────
 * `smoke-all.mjs:342` writes `<artifactRoot>/summary.json`; the challenge workflow passes
 * `evidence/smoke-summary.json`. Nothing renamed, documented or tested that mapping, because
 * nothing ever assembled a bundle. It is done here, explicitly, with the schema checked on the way
 * through rather than assumed.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const REQUIRED = [
  "--out-dir",
  "--image-digests",
  "--smoke-artifact-dir",
  "--test-summary",
  "--environment-summary",
  "--trusted-signers",
  "--signing-key",
  "--key-id",
  "--trace-id",
  "--expires-at",
  "--builder-id",
  "--invocation-id",
  "--build-command",
];

function fail(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag.startsWith("--")) fail(`unexpected argument ${JSON.stringify(flag)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
    values[flag] = value;
  }
  for (const flag of REQUIRED) {
    if (!values[flag]) fail(`${flag} is required`);
  }
  return values;
}

function run(command, args, cwd) {
  const result = execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.trim();
}

/** Is `candidatePath` inside `directory`? */
function isWithin(directory, candidatePath) {
  const rel = relative(directory, candidatePath);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not readable JSON (${path}): ${error.message}`);
  }
}

function main() {
  const values = parseArguments(process.argv.slice(2));
  const repositoryRoot = run("git", ["rev-parse", "--show-toplevel"]);
  const outDir = resolve(values["--out-dir"]);

  // The bundle must not live inside the candidate. `release-challenge.mjs` refuses evidence that
  // resolves inside the checkout — "a candidate that supplies its own proof has not been
  // independently verified of anything" — and a bundle written there would also dirty the tree the
  // manifest is about to assert is clean.
  if (isWithin(repositoryRoot, outDir)) {
    fail(`--out-dir must be outside the candidate checkout (${repositoryRoot})`);
  }

  // A dirty tree means the manifest would bind a SHA that does not describe what was built. The
  // manifest checks this too; failing here says which step introduced it.
  if (run("git", ["status", "--porcelain=v1", "--untracked-files=all"], repositoryRoot)) {
    fail("the candidate checkout has uncommitted or untracked files");
  }
  const candidateSha = run("git", ["rev-parse", "HEAD"], repositoryRoot);

  mkdirSync(outDir, { recursive: true });
  const out = (name) => join(outDir, name);

  // ── 1. SBOM ───────────────────────────────────────────────────────────────────────────────────
  console.log("bundle: generating SPDX SBOM");
  run("node", [
    join(repositoryRoot, "scripts/generate-sbom.mjs"),
    "--out", out("sbom.spdx.json"),
    "--candidate-sha", candidateSha,
  ], repositoryRoot);

  // ── 2. Build summary + provenance, from the digests the build produced ────────────────────────
  console.log("bundle: recording build provenance");
  run("node", [
    join(repositoryRoot, "scripts/release-build-evidence.mjs"),
    "--summary-output", out("build-summary.json"),
    "--provenance-output", out("build-provenance.json"),
    "--image-digests", resolve(values["--image-digests"]),
    "--builder-id", values["--builder-id"],
    "--invocation-id", values["--invocation-id"],
    "--command", values["--build-command"],
  ], repositoryRoot);

  // ── 3. The summaries this script may NOT mint ─────────────────────────────────────────────────
  // Copied, not generated. See the header: `release-evidence-summary.mjs` writes `status: "passed"`
  // as a literal, which is only true because verify.sh calls it after its fail-gate.
  for (const [flag, name] of [
    ["--test-summary", "test-summary.json"],
    ["--environment-summary", "environment-summary.json"],
    ["--trusted-signers", "trusted-signers.json"],
  ]) {
    const source = resolve(values[flag]);
    if (!existsSync(source)) fail(`${flag} does not exist: ${source}`);
    copyFileSync(source, out(name));
  }

  // Both summaries must describe THIS candidate. Without this the bundle can be assembled from a
  // gate that ran against a different commit, and the manifest would bind it happily — every hash
  // would agree, about the wrong thing.
  for (const name of ["test-summary.json", "environment-summary.json"]) {
    const summary = readJson(out(name), name);
    if (summary.candidateSha !== candidateSha) {
      fail(`${name} is for candidate ${summary.candidateSha}, not ${candidateSha}`);
    }
    if (summary.status !== "passed") {
      fail(`${name} records status ${JSON.stringify(summary.status)} — a bundle needs a passing gate`);
    }
  }

  // ── 4. The smoke summary, under the name the challenge expects ────────────────────────────────
  const smokeSource = join(resolve(values["--smoke-artifact-dir"]), "summary.json");
  if (!existsSync(smokeSource)) {
    fail(
      `no smoke summary at ${smokeSource}. scripts/smoke-all.mjs writes summary.json into ` +
        "SMOKE_ARTIFACT_DIR; the challenge workflow expects it as smoke-summary.json, which is the " +
        "rename this step performs.",
    );
  }
  const smoke = readJson(smokeSource, "smoke summary");
  if (smoke.schemaVersion !== "qrai-smoke-summary/v1") {
    fail(`smoke summary has schemaVersion ${JSON.stringify(smoke.schemaVersion)}`);
  }
  if (smoke.candidateSha !== candidateSha) {
    fail(`smoke summary is for candidate ${smoke.candidateSha}, not ${candidateSha}`);
  }
  copyFileSync(smokeSource, out("smoke-summary.json"));

  // ── 5. The manifest that binds all of it ──────────────────────────────────────────────────────
  console.log("bundle: generating the signed manifest");
  run("node", [
    join(repositoryRoot, "scripts/release-manifest.mjs"),
    "--generate",
    "--output", out("candidate-evidence.json"),
    "--build-summary", out("build-summary.json"),
    "--build-provenance", out("build-provenance.json"),
    "--sbom", out("sbom.spdx.json"),
    "--smoke-summary", out("smoke-summary.json"),
    "--test-summary", out("test-summary.json"),
    "--environment-summary", out("environment-summary.json"),
    "--trusted-signers", out("trusted-signers.json"),
    "--signing-key", resolve(values["--signing-key"]),
    "--key-id", values["--key-id"],
    "--trace-id", values["--trace-id"],
    "--expires-at", values["--expires-at"],
  ], repositoryRoot);

  const manifest = readJson(out("candidate-evidence.json"), "manifest");
  writeFileSync(
    out("BUNDLE.txt"),
    `candidate ${candidateSha}\ngenerated ${new Date().toISOString()}\n` +
      `files: ${BUNDLE_FILES.join(" ")}\n`,
  );
  console.log(`✓ bundle for ${candidateSha} in ${outDir} (manifest ${manifest.schemaVersion})`);
}

/** The eight names `.github/workflows/release-challenge.yml` passes, in its order. */
export const BUNDLE_FILES = [
  "candidate-evidence.json",
  "build-summary.json",
  "build-provenance.json",
  "sbom.spdx.json",
  "smoke-summary.json",
  "test-summary.json",
  "environment-summary.json",
  "trusted-signers.json",
];

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith("release-bundle.mjs");
if (isMain) main();
