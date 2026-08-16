import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SERVICES, digestMap } from "./release-images.mjs";

/**
 * The release PRODUCERS, fed to the release CONSUMER. (P0.4)
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────────
 * `scripts/release-manifest.test.mjs` is thorough — 30 tests, 9 adversarial refusals — and every
 * one of them runs against evidence inputs the test file HAND-WRITES itself
 * (`writeEvidenceInputs`, :57-143). No output of an actual producer has ever been passed to
 * `--generate`. The consumer is proven; the seam is not.
 *
 * That blindness is not hypothetical. It let the SPDX SBOM ship with a consumer requiring it and no
 * producer emitting it (fixed in #439), and it currently hides a straight contract break in the
 * image digests: `release-images.mjs` keys its map by TAG and `release-manifest.mjs` requires bare
 * SERVICE names, so the only digest producer in the repository emits a shape its only consumer
 * refuses. Nothing catches that, because nothing has ever run one into the other.
 *
 * ── Hermetic, and deliberately Docker-free ──────────────────────────────────────────────────────
 * The digest VALUES are stubs. What is under test is the SHAPE of the map — its keys — which
 * `release-images.mjs` builds from its own exported `imageTag()`, the same call `main()` uses at
 * the line that populates `digests`. So this reproduces the producer's contract exactly without a
 * daemon, a registry, or a build. A test that needed Docker would not run in CI here, which is
 * precisely how the seam stayed untested.
 */

const here = dirname(fileURLToPath(import.meta.url));
const manifestScript = join(here, "release-manifest.mjs");
const requiredArtifacts = ["plan.md", "spec.md", "research.md", "impact-map.md", "tasks.md"];

/**
 * A digest map built by the PRODUCER'S OWN function, not by this file.
 *
 * The first version of this fixture wrote the keys itself. That made the whole file decorative:
 * reverting `release-images.mjs` to its broken tag-keyed form changed nothing here and all three
 * tests stayed green — measured. A test that constructs the shape it is checking is asserting
 * against itself. Calling `digestMap` is what binds this to the code under test.
 */
export function producerShapedDigests() {
  return digestMap(
    SERVICES.map((service, index) => ({ service, id: `sha256:${String(index + 1).repeat(64)}` })),
  );
}

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A clean candidate checkout plus a full evidence bundle, with `imageDigests` supplied by the
 * caller so one test can pass the producer's shape and another the shape the consumer documents.
 */
function prepareCandidate(t, imageDigests) {
  const repo = mkdtempSync(join(tmpdir(), "qrai-release-pipeline-repo-"));
  const evidence = mkdtempSync(join(tmpdir(), "qrai-release-pipeline-evidence-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(evidence, "release-private.pem");
  writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  const specDirectory = join(repo, "specs", "readiness-recovery-10-10");
  mkdirSync(specDirectory, { recursive: true });
  for (const artifact of requiredArtifacts) {
    writeFileSync(join(specDirectory, artifact), `# ${artifact}\nrelease pipeline fixture\n`);
  }
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(manifestScript, join(repo, "scripts", "release-manifest.mjs"));

  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Release Pipeline Test"]);
  git(repo, ["config", "user.email", "release-pipeline@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "candidate source"]);

  const candidateSha = git(repo, ["rev-parse", "HEAD"]);
  const traceId = "release-trace-1234567890abcdef";
  const completedAt = new Date().toISOString();
  const digests = imageDigests(candidateSha);

  const paths = Object.fromEntries(
    [
      "build-summary",
      "build-provenance",
      "test-summary",
      "smoke-summary",
      "environment-summary",
      "sbom.spdx",
      "trusted-signers",
    ].map((name) => [name, join(evidence, `${name}.json`)]),
  );

  writeJson(paths["build-provenance"], {
    schemaVersion: "qrai-build-provenance/v1",
    candidateSha,
    status: "passed",
    completedAt,
    builderId: "release-pipeline-test",
    invocationId: "release-pipeline-test-run",
    command: "node scripts/release-images.mjs",
    imageDigests: digests,
  });
  writeJson(paths["build-summary"], {
    schemaVersion: "qrai-build-summary/v1",
    candidateSha,
    status: "passed",
    completedAt,
    imageDigests: digests,
    provenance: {
      sha256: execFileSync("node", ["-e", `
        const {createHash}=require("node:crypto");const {readFileSync}=require("node:fs");
        process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
      `, paths["build-provenance"]], { encoding: "utf8" }),
      builderId: "release-pipeline-test",
      invocationId: "release-pipeline-test-run",
    },
  });
  writeJson(paths["test-summary"], {
    schemaVersion: "qrai-test-summary/v1",
    candidateSha,
    status: "passed",
    completedAt,
    command: "bash scripts/verify.sh --release",
  });
  writeJson(paths["smoke-summary"], {
    schemaVersion: "qrai-smoke-summary/v1",
    candidateSha,
    status: "passed",
    traceId,
    completedAt,
    results: [{ step: "proof", status: "passed" }],
  });
  writeJson(paths["environment-summary"], {
    schemaVersion: "qrai-environment-summary/v1",
    candidateSha,
    status: "passed",
    class: "ci",
    provider: "release-pipeline-test",
    completedAt,
  });
  writeJson(paths["sbom.spdx"], {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `qrai-${candidateSha}`,
    documentNamespace: `https://qrai.invalid/sbom/${candidateSha}`,
    creationInfo: { created: completedAt, creators: ["Tool: qrai-generate-sbom"] },
    packages: [
      { SPDXID: "SPDXRef-npm-fixture-1.0.0", name: "fixture", versionInfo: "1.0.0", licenseDeclared: "MIT" },
    ],
  });
  writeJson(paths["trusted-signers"], {
    schemaVersion: "qrai-release-trusted-signers/v1",
    policyId: "release-pipeline-policy",
    keys: [{ keyId: "release-pipeline-test", algorithm: "ed25519", publicKey: publicKeyPem }],
  });

  return { repo, evidence, paths, privateKeyPath, candidateSha, traceId, digests };
}

function generate(candidate) {
  const result = spawnSync(
    process.execPath,
    [
      manifestScript,
      "--generate",
      "--output", join(candidate.evidence, "candidate-evidence.json"),
      "--build-summary", candidate.paths["build-summary"],
      "--build-provenance", candidate.paths["build-provenance"],
      "--sbom", candidate.paths["sbom.spdx"],
      "--smoke-summary", candidate.paths["smoke-summary"],
      "--test-summary", candidate.paths["test-summary"],
      "--environment-summary", candidate.paths["environment-summary"],
      "--trusted-signers", candidate.paths["trusted-signers"],
      "--signing-key", candidate.privateKeyPath,
      "--key-id", "release-pipeline-test",
      "--trace-id", candidate.traceId,
      "--expires-at", new Date(Date.now() + 3600_000).toISOString(),
    ],
    { cwd: candidate.repo, encoding: "utf8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("the digest producer's output is accepted by the manifest generator", (t) => {
  // THE seam. `release-images.mjs` is the only thing in the repository that produces image digests
  // and `release-manifest.mjs --generate` is the only thing that consumes them. Until this test,
  // no run of either had ever seen the other's data.
  const candidate = prepareCandidate(t, producerShapedDigests);
  const result = generate(candidate);

  assert.equal(
    result.status,
    0,
    "the only image-digest producer in this repository emits a shape the only consumer refuses, " +
      "so a release could never be generated from what the build actually writes:\n" +
      result.output,
  );
});

test("every service the producer builds is one the manifest requires, and the reverse", () => {
  // Two hardcoded lists, in two files, with no link between them: `SERVICES` in release-images.mjs
  // and `deployableServices` in release-manifest.mjs. A service added to one and not the other
  // silently drops out of the release evidence (or blocks it) with nothing to say so.
  const consumerSource = readFileSync(manifestScript, "utf8");
  const declared = /const deployableServices = \[([^\]]*)\]/.exec(consumerSource);
  assert.ok(declared, "could not read deployableServices out of release-manifest.mjs");
  const consumerServices = [...declared[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);

  assert.ok(consumerServices.length >= 3, `parsed only ${consumerServices.length} services; the regex is stale`);
  assert.deepEqual(
    [...SERVICES].sort(),
    [...consumerServices].sort(),
    "release-images.mjs SERVICES and release-manifest.mjs deployableServices disagree",
  );
});

test("REFUSES a digest map missing a service, so this is not passing vacuously", (t) => {
  // The control. Without it, the first test would be satisfied by a consumer that checks nothing.
  const candidate = prepareCandidate(t, (sha) => {
    const digests = producerShapedDigests(sha);
    delete digests[Object.keys(digests)[0]];
    return digests;
  });

  const result = generate(candidate);
  assert.notEqual(result.status, 0, "the generator accepted a bundle with a service digest missing");
  assert.match(result.output, /sha256 digest/i);
});
