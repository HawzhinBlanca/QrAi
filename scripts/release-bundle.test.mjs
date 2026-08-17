import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEPLOYABLE_IMAGE_KEYS } from "./lib/deployable-images.mjs";
import { BUNDLE_FILES } from "./release-bundle.mjs";

/**
 * The whole release chain, run once, end to end. (P0.4)
 *
 * ── What had never happened ─────────────────────────────────────────────────────────────────────
 * `release-manifest.mjs --generate` had NO caller anywhere in the repository.
 * `release-build-evidence.mjs` had no caller of any kind. `release-challenge.yml` passes eight file
 * paths that no process produced together. Every part was tested; the chain was not — which is how
 * an SBOM shipped with no producer (#439) and a digest map shipped in a shape its only consumer
 * refuses (#445).
 *
 * This assembles a bundle with the real `release-build-evidence.mjs` and the real
 * `release-manifest.mjs`, then hands the result to the real `release-challenge.mjs`. That last step
 * is the claim that matters: the challenge workflow's inputs are satisfied by what the assembler
 * writes.
 *
 * ── One stub, named ─────────────────────────────────────────────────────────────────────────────
 * `generate-sbom.mjs` is STUBBED in the fixture. It enumerates the real dependency trees
 * (`pnpm licenses list`, `cargo metadata` across three crates), which a throwaway repository has
 * none of. It has its own tests (`generate-sbom.test.mjs`, 14 cases including the non-vacuity
 * floors), and `release-pipeline.test.mjs` covers the digest seam. What is under test HERE is the
 * assembler's orchestration and the bundle's acceptance by the challenge — so the stub writes a
 * valid SPDX document and nothing else.
 *
 * Docker-free by construction: image digests are an INPUT to the assembler, exactly as they are in
 * CI, so no daemon or registry is involved.
 */

const here = dirname(fileURLToPath(import.meta.url));
const bundleScript = join(here, "release-bundle.mjs");
const requiredArtifacts = ["plan.md", "spec.md", "research.md", "impact-map.md", "tasks.md"];
// Derived, not restated. `parseImageDigestDocument` enforces set equality with DEPLOYABLE_IMAGE_KEYS
// in BOTH directions, so a hardcoded list here is a second source of truth that silently rots: this
// one still said `ml-inference` after ADR-0044 retired it and added `node-backend` and
// `migration-runner`, and the fixture it built was rejected by the script under test.
const SERVICES = DEPLOYABLE_IMAGE_KEYS;

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A candidate checkout carrying the real producer scripts, plus a stub SBOM generator. */
function prepareCandidate(t) {
  const repo = mkdtempSync(join(tmpdir(), "qrai-bundle-repo-"));
  const inputs = mkdtempSync(join(tmpdir(), "qrai-bundle-inputs-"));
  const outDir = join(mkdtempSync(join(tmpdir(), "qrai-bundle-out-")), "bundle");
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  t.after(() => rmSync(inputs, { recursive: true, force: true }));

  const specDirectory = join(repo, "specs", "readiness-recovery-10-10");
  mkdirSync(specDirectory, { recursive: true });
  for (const artifact of requiredArtifacts) {
    writeFileSync(join(specDirectory, artifact), `# ${artifact}\nbundle fixture\n`);
  }
  mkdirSync(join(repo, "scripts"), { recursive: true });
  for (const script of ["release-bundle.mjs", "release-manifest.mjs", "release-build-evidence.mjs", "release-challenge.mjs"]) {
    copyFileSync(join(here, script), join(repo, "scripts", script));
  }
  // ADR-0044 extracted the deployable-image set into `scripts/lib/`, and both `release-manifest.mjs`
  // and `release-build-evidence.mjs` import it. It is not optional scaffolding: without it the
  // scripts above throw ERR_MODULE_NOT_FOUND inside the temp repo, so the bundle this test builds
  // would not be the bundle the release workflow builds.
  mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
  for (const module of ["deployable-images.mjs"]) {
    copyFileSync(join(here, "lib", module), join(repo, "scripts", "lib", module));
  }
  // The one stub. See the header.
  writeFileSync(
    join(repo, "scripts", "generate-sbom.mjs"),
    `import { writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
const sha = process.argv[process.argv.indexOf("--candidate-sha") + 1];
writeFileSync(out, JSON.stringify({
  spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
  name: "qrai-" + sha, documentNamespace: "https://qrai.invalid/sbom/" + sha,
  creationInfo: { created: new Date().toISOString(), creators: ["Tool: fixture"] },
  packages: [{ SPDXID: "SPDXRef-npm-fixture-1.0.0", name: "fixture", versionInfo: "1.0.0", licenseDeclared: "MIT" }],
}, null, 2));
`,
  );

  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Bundle Test"]);
  git(repo, ["config", "user.email", "bundle@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "candidate source"]);
  const candidateSha = git(repo, ["rev-parse", "HEAD"]);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signingKey = join(inputs, "release-private.pem");
  writeFileSync(signingKey, privateKey.export({ format: "pem", type: "pkcs8" }));

  const traceId = "release-trace-1234567890abcdef";
  const completedAt = new Date().toISOString();

  // Image digests: an INPUT, as in CI. release-images.mjs produces this map keyed by service.
  const imageDigests = join(inputs, "image-digests.json");
  writeJson(
    imageDigests,
    Object.fromEntries(SERVICES.map((s, i) => [s, `sha256:${String(i + 1).repeat(64)}`])),
  );

  // What `verify.sh --release` hands over on success. NOT minted by the assembler — see its header.
  const testSummary = join(inputs, "test-summary.json");
  writeJson(testSummary, {
    schemaVersion: "qrai-test-summary/v1",
    candidateSha,
    status: "passed",
    command: "bash scripts/verify.sh --release",
    completedAt,
  });
  const environmentSummary = join(inputs, "environment-summary.json");
  writeJson(environmentSummary, {
    schemaVersion: "qrai-environment-summary/v1",
    candidateSha,
    status: "passed",
    class: "ci",
    provider: "bundle-test",
    completedAt,
  });

  // What smoke-all.mjs writes, under the name it actually uses.
  const smokeDir = join(inputs, "smoke");
  mkdirSync(smokeDir, { recursive: true });
  writeJson(join(smokeDir, "summary.json"), {
    schemaVersion: "qrai-smoke-summary/v1",
    candidateSha,
    status: "passed",
    traceId,
    completedAt,
    results: [{ step: "proof", status: "passed" }],
  });

  const trustedSigners = join(inputs, "trusted-signers.json");
  writeJson(trustedSigners, {
    schemaVersion: "qrai-release-trusted-signers/v1",
    policyId: "bundle-test-policy",
    keys: [
      {
        keyId: "bundle-test-key",
        algorithm: "ed25519",
        publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
      },
    ],
  });

  return {
    repo, inputs, outDir, candidateSha, traceId, signingKey,
    imageDigests, testSummary, environmentSummary, smokeDir, trustedSigners,
  };
}

function assemble(c, overrides = {}) {
  const args = {
    "--out-dir": c.outDir,
    "--image-digests": c.imageDigests,
    "--smoke-artifact-dir": c.smokeDir,
    "--test-summary": c.testSummary,
    "--environment-summary": c.environmentSummary,
    "--trusted-signers": c.trustedSigners,
    "--signing-key": c.signingKey,
    "--key-id": "bundle-test-key",
    "--trace-id": c.traceId,
    "--expires-at": new Date(Date.now() + 3600_000).toISOString(),
    "--builder-id": "bundle-test-builder",
    "--invocation-id": "bundle-test-run",
    "--build-command": "node scripts/release-images.mjs",
    ...overrides,
  };
  const argv = Object.entries(args).flatMap(([flag, value]) => (value === null ? [] : [flag, value]));
  const result = spawnSync(process.execPath, [join(c.repo, "scripts", "release-bundle.mjs"), ...argv], {
    cwd: c.repo,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("assembles every file the challenge workflow passes, and the challenge accepts them", (t) => {
  const c = prepareCandidate(t);
  const assembled = assemble(c);
  assert.equal(assembled.status, 0, assembled.output);

  for (const name of BUNDLE_FILES) {
    assert.ok(existsSync(join(c.outDir, name)), `bundle is missing ${name}:\n${assembled.output}`);
  }

  // THE claim. `release-challenge.yml` passes exactly these eight paths; until now nothing had ever
  // produced them together, so nobody knew whether the challenge would accept a real bundle.
  const challenge = spawnSync(
    process.execPath,
    [
      join(c.repo, "scripts", "release-challenge.mjs"), "--verify-manifest-only",
      "--candidate-dir", c.repo,
      "--manifest", join(c.outDir, "candidate-evidence.json"),
      "--build-summary", join(c.outDir, "build-summary.json"),
      "--build-provenance", join(c.outDir, "build-provenance.json"),
      "--sbom", join(c.outDir, "sbom.spdx.json"),
      "--smoke-summary", join(c.outDir, "smoke-summary.json"),
      "--test-summary", join(c.outDir, "test-summary.json"),
      "--environment-summary", join(c.outDir, "environment-summary.json"),
      "--trusted-signers", join(c.outDir, "trusted-signers.json"),
      "--challenge-output", join(c.inputs, "challenge-report.json"),
      "--runner-id", "independent-challenger",
      "--runner-class", "test",
    ],
    { cwd: c.repo, encoding: "utf8" },
  );
  assert.equal(
    challenge.status,
    0,
    `the challenge refused a bundle this repository's own assembler produced:\n${challenge.stdout}${challenge.stderr}`,
  );
});

test("the smoke summary is renamed from what smoke-all actually writes", (t) => {
  // smoke-all.mjs:342 writes `<artifactRoot>/summary.json`; the challenge expects
  // `smoke-summary.json`. Nothing renamed it, because nothing assembled a bundle.
  const c = prepareCandidate(t);
  assert.equal(assemble(c).status, 0);
  const bundled = JSON.parse(readFileSync(join(c.outDir, "smoke-summary.json"), "utf8"));
  const source = JSON.parse(readFileSync(join(c.smokeDir, "summary.json"), "utf8"));
  assert.deepEqual(bundled, source);
});

test("REFUSES a test summary from a different candidate", (t) => {
  // Every hash in the bundle would agree — about the wrong commit.
  const c = prepareCandidate(t);
  writeJson(c.testSummary, {
    schemaVersion: "qrai-test-summary/v1",
    candidateSha: "0".repeat(40),
    status: "passed",
    command: "bash scripts/verify.sh --release",
    completedAt: new Date().toISOString(),
  });
  const result = assemble(c);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /is for candidate 0{40}/);
});

test("REFUSES a gate that did not pass", (t) => {
  const c = prepareCandidate(t);
  const summary = JSON.parse(readFileSync(c.testSummary, "utf8"));
  writeJson(c.testSummary, { ...summary, status: "failed" });
  const result = assemble(c);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /a bundle needs a passing gate/);
});

test("REFUSES an expiry that never expires", (t) => {
  // The assembler hands --expires-at straight to release-manifest.mjs, so this is a seam test, not
  // a second implementation of the bound. It is here because this is the flag an operator actually
  // types: before release-manifest bounded the validity window, this exact invocation produced a
  // complete, signed bundle whose evidence stayed valid for 974 years.
  const c = prepareCandidate(t);
  const result = assemble(c, { "--expires-at": "3000-01-01T00:00:00.000Z" });
  assert.notEqual(result.status, 0, `the assembler accepted a 974-year expiry:\n${result.output}`);
  assert.match(result.output, /longer than the 7 days maximum/);
});

test("REFUSES a smoke summary from a different candidate", (t) => {
  const c = prepareCandidate(t);
  const summary = JSON.parse(readFileSync(join(c.smokeDir, "summary.json"), "utf8"));
  writeJson(join(c.smokeDir, "summary.json"), { ...summary, candidateSha: "1".repeat(40) });
  const result = assemble(c);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /smoke summary is for candidate/);
});

test("REFUSES writing the bundle inside the candidate", (t) => {
  // release-challenge.mjs refuses evidence that resolves inside the checkout — a candidate that
  // supplies its own proof has been independently verified of nothing. It would also dirty the tree
  // the manifest is about to assert is clean.
  const c = prepareCandidate(t);
  const result = assemble(c, { "--out-dir": join(c.repo, "evidence") });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /must be outside the candidate checkout/);
});

test("REFUSES a dirty candidate checkout", (t) => {
  const c = prepareCandidate(t);
  writeFileSync(join(c.repo, "untracked.txt"), "added after the commit\n");
  const result = assemble(c);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /uncommitted or untracked files/);
});

test("REFUSES a missing smoke summary, and says where it looked", (t) => {
  const c = prepareCandidate(t);
  rmSync(join(c.smokeDir, "summary.json"));
  const result = assemble(c);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /no smoke summary at/);
  assert.match(result.output, /smoke-all\.mjs writes summary\.json/);
});
