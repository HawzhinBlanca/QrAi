import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify as verifySignature } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const schemaVersion = "2.1.0";
const requiredArtifactFiles = [
  join("specs", "readiness-recovery-10-10", "plan.md"),
  join("specs", "readiness-recovery-10-10", "spec.md"),
  join("specs", "readiness-recovery-10-10", "research.md"),
  join("specs", "readiness-recovery-10-10", "impact-map.md"),
  join("specs", "readiness-recovery-10-10", "tasks.md")
];
const deployableServices = ["platform-api", "realtime-gateway", "ml-inference", "asr-inference", "web"];
const sha256Digest = /^sha256:[a-f0-9]{64}$/;
const sha256Hash = /^[a-f0-9]{64}$/;
const candidateSha = /^[a-f0-9]{40}$/;
const traceId = /^release-trace-[a-z0-9][a-z0-9-]{15,127}$/;
const keyId = /^[A-Za-z0-9._-]{1,128}$/;
const policyId = /^[A-Za-z0-9._-]{1,128}$/;
const inputFlags = ["--build-summary", "--build-provenance", "--sbom", "--smoke-summary", "--test-summary", "--environment-summary", "--trusted-signers"];

function fail(message) {
  throw new Error(message);
}

function command(commandName, args) {
  return execFileSync(commandName, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function getRepositoryRoot() {
  try {
    return command("git", ["rev-parse", "--show-toplevel"]);
  } catch {
    fail("Release evidence must be generated or verified from a Git checkout.");
  }
}

function getGitSha() {
  return command("git", ["rev-parse", "HEAD"]);
}

function assertCleanWorkingTree() {
  const status = command("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) {
    fail("Candidate checkout contains untracked or modified files.");
  }
}

function isPathWithin(directory, candidatePath) {
  const relativePath = relative(directory, candidatePath);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function resolvePhysicalPath(filePath) {
  let existingPath = resolve(filePath);
  const missingSegments = [];
  while (!existsSync(existingPath)) {
    const parentPath = dirname(existingPath);
    if (parentPath === existingPath) {
      fail(`Unable to resolve path: ${filePath}`);
    }
    missingSegments.unshift(basename(existingPath));
    existingPath = parentPath;
  }
  return join(realpathSync.native(existingPath), ...missingSegments);
}

function assertExternalPath(filePath, repositoryRoot, label) {
  if (!filePath) {
    fail(`${label} is required.`);
  }
  const physicalPath = resolvePhysicalPath(filePath);
  const physicalRepositoryRoot = realpathSync.native(resolve(repositoryRoot));
  if (isPathWithin(physicalRepositoryRoot, physicalPath)) {
    fail(`${label} must be outside the candidate checkout.`);
  }
  return physicalPath;
}

function assertExistingExternalPath(filePath, repositoryRoot, label) {
  const absolutePath = assertExternalPath(filePath, repositoryRoot, label);
  if (!existsSync(absolutePath)) {
    fail(`${label} does not exist: ${absolutePath}`);
  }
  return absolutePath;
}

function getFileSha256(filePath) {
  if (!existsSync(filePath)) {
    fail(`Declared artifact is missing: ${filePath}`);
  }
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((property) => `${JSON.stringify(property)}:${canonicalJson(value[property])}`)
    .join(",")}}`;
}

function unsignedManifest(manifest) {
  const { signature, ...unsigned } = manifest;
  return unsigned;
}

function signaturePayload(manifest) {
  return Buffer.from(canonicalJson(unsignedManifest(manifest)));
}

function parseJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Unable to parse ${label}: ${error.message}`);
  }
}

function assertJsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Hash.test(value)) {
    fail(`${label} must be a SHA-256 hex digest.`);
  }
}

function assertIsoDate(value, field, { future = false } = {}) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be an ISO-8601 timestamp.`);
  }
  const timestamp = new Date(value);
  if (timestamp.toISOString() !== value) {
    fail(`${field} must be a normalized ISO-8601 timestamp.`);
  }
  if (future && timestamp.getTime() <= Date.now()) {
    fail(`${field} is expired.`);
  }
  return timestamp;
}

function assertTraceId(value, label = "traceId") {
  if (typeof value !== "string" || !traceId.test(value)) {
    fail(`${label} must be a release trace identifier.`);
  }
}

function assertCandidate(value, label, expectedCandidate) {
  if (typeof value !== "string" || !candidateSha.test(value)) {
    fail(`${label} must be a full lowercase Git SHA.`);
  }
  if (expectedCandidate && value !== expectedCandidate) {
    fail(`${label} does not match the release candidate.`);
  }
}

function assertArtifactPath(repositoryRoot, filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    fail("Artifact path must be a non-empty relative path.");
  }
  const physicalPath = resolvePhysicalPath(resolve(repositoryRoot, filePath));
  const physicalRepositoryRoot = realpathSync.native(resolve(repositoryRoot));
  if (!isPathWithin(physicalRepositoryRoot, physicalPath)) {
    fail(`Artifact path escapes the candidate checkout: ${filePath}`);
  }
  return physicalPath;
}

function assertImageDigests(imageDigests, label = "imageDigests") {
  assertJsonObject(imageDigests, label);
  for (const service of deployableServices) {
    if (typeof imageDigests[service] !== "string" || !sha256Digest.test(imageDigests[service])) {
      fail(`${label}.${service} must be a non-empty sha256 digest.`);
    }
  }
}

function readExternalJsonInput(values, flag, repositoryRoot, label) {
  const filePath = assertExistingExternalPath(values[flag], repositoryRoot, flag);
  return { filePath, value: parseJsonFile(filePath, label), sha256: getFileSha256(filePath) };
}

function assertPassedSummary(summary, label, schema, expectedCandidate) {
  assertJsonObject(summary, label);
  if (summary.schemaVersion !== schema) {
    fail(`${label} schemaVersion must be ${schema}.`);
  }
  assertCandidate(summary.candidateSha, `${label} candidateSha`, expectedCandidate);
  if (summary.status !== "passed") {
    fail(`${label} status must be passed.`);
  }
  assertIsoDate(summary.completedAt, `${label} completedAt`);
}

function assertTrustedSignerPolicy(policy) {
  assertJsonObject(policy, "trusted signer policy");
  if (policy.schemaVersion !== "qrai-release-trusted-signers/v1") {
    fail("trusted signer policy schemaVersion is unsupported.");
  }
  if (typeof policy.policyId !== "string" || !policyId.test(policy.policyId)) {
    fail("trusted signer policy policyId is invalid.");
  }
  if (!Array.isArray(policy.keys) || policy.keys.length === 0) {
    fail("trusted signer policy must contain at least one key.");
  }
  const keys = new Map();
  for (const signer of policy.keys) {
    assertJsonObject(signer, "trusted signer policy key");
    if (typeof signer.keyId !== "string" || !keyId.test(signer.keyId) || keys.has(signer.keyId)) {
      fail("trusted signer policy contains an invalid or duplicate keyId.");
    }
    if (signer.algorithm !== "ed25519" || typeof signer.publicKey !== "string") {
      fail(`trusted signer policy key ${signer.keyId} must provide an ed25519 public key.`);
    }
    let publicKey;
    try {
      publicKey = createPublicKey(signer.publicKey);
    } catch {
      fail(`trusted signer policy key ${signer.keyId} is not a valid public key.`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      fail(`trusted signer policy key ${signer.keyId} is not an ed25519 key.`);
    }
    keys.set(signer.keyId, publicKey);
  }
  return { policyId: policy.policyId, keys };
}

function assertBuildProvenance(provenance, expectedCandidate, expectedImageDigests, buildSummary) {
  assertPassedSummary(provenance, "build provenance", "qrai-build-provenance/v1", expectedCandidate);
  assertImageDigests(provenance.imageDigests, "build provenance imageDigests");
  if (canonicalJson(provenance.imageDigests) !== canonicalJson(expectedImageDigests)) {
    fail("build provenance imageDigests do not match build summary.");
  }
  for (const field of ["builderId", "invocationId", "command"]) {
    if (typeof provenance[field] !== "string" || provenance[field].trim() === "") {
      fail(`build provenance ${field} is required.`);
    }
  }
  assertJsonObject(buildSummary.provenance, "build summary provenance");
  assertSha256(buildSummary.provenance.sha256, "build summary provenance.sha256");
  if (typeof buildSummary.provenance.builderId !== "string" || buildSummary.provenance.builderId !== provenance.builderId) {
    fail("build summary provenance builderId does not match build provenance.");
  }
  if (typeof buildSummary.provenance.invocationId !== "string" || buildSummary.provenance.invocationId !== provenance.invocationId) {
    fail("build summary provenance invocationId does not match build provenance.");
  }
}

function readEvidenceInputs(values, repositoryRoot, expectedCandidate, expectedTrace) {
  const build = readExternalJsonInput(values, "--build-summary", repositoryRoot, "build summary");
  assertPassedSummary(build.value, "build summary", "qrai-build-summary/v1", expectedCandidate);
  assertImageDigests(build.value.imageDigests, "build summary imageDigests");
  const buildProvenance = readExternalJsonInput(values, "--build-provenance", repositoryRoot, "build provenance");
  assertBuildProvenance(buildProvenance.value, expectedCandidate, build.value.imageDigests, build.value);
  if (build.value.provenance.sha256 !== buildProvenance.sha256) {
    fail("build summary provenance hash does not match build provenance.");
  }

  const test = readExternalJsonInput(values, "--test-summary", repositoryRoot, "test summary");
  assertPassedSummary(test.value, "test summary", "qrai-test-summary/v1", expectedCandidate);
  if (typeof test.value.command !== "string" || test.value.command.trim() === "") {
    fail("test summary command is required.");
  }

  const smoke = readExternalJsonInput(values, "--smoke-summary", repositoryRoot, "smoke summary");
  assertPassedSummary(smoke.value, "smoke summary", "qrai-smoke-summary/v1", expectedCandidate);
  assertTraceId(smoke.value.traceId, "smoke summary traceId");
  if (expectedTrace && smoke.value.traceId !== expectedTrace) {
    fail("smoke summary traceId does not match release trace.");
  }
  if (!Array.isArray(smoke.value.results) || smoke.value.results.length === 0 || smoke.value.results.some((result) => !result || (result.status !== "passed" && result.status !== "started" && result.status !== "already-running"))) {
    fail("smoke summary results must contain only successful stages.");
  }

  const environment = readExternalJsonInput(values, "--environment-summary", repositoryRoot, "environment summary");
  assertPassedSummary(environment.value, "environment summary", "qrai-environment-summary/v1", expectedCandidate);
  if (typeof environment.value.class !== "string" || environment.value.class.trim() === "") {
    fail("environment summary class is required.");
  }
  if (typeof environment.value.provider !== "string" || environment.value.provider.trim() === "") {
    fail("environment summary provider is required.");
  }

  const sbom = readExternalJsonInput(values, "--sbom", repositoryRoot, "SBOM");
  assertJsonObject(sbom.value, "SBOM");
  if (typeof sbom.value.spdxVersion !== "string" || !sbom.value.spdxVersion.startsWith("SPDX-")) {
    fail("SBOM must declare an SPDX version.");
  }
  if (typeof sbom.value.SPDXID !== "string" || typeof sbom.value.name !== "string" || typeof sbom.value.documentNamespace !== "string") {
    fail("SBOM is missing required SPDX document fields.");
  }
  assertJsonObject(sbom.value.creationInfo, "SBOM creationInfo");
  assertIsoDate(sbom.value.creationInfo.created, "SBOM creationInfo.created");
  if (!Array.isArray(sbom.value.creationInfo.creators) || sbom.value.creationInfo.creators.length === 0) {
    fail("SBOM creationInfo.creators is required.");
  }

  const trustedSigners = readExternalJsonInput(values, "--trusted-signers", repositoryRoot, "trusted signer policy");
  const signerPolicy = assertTrustedSignerPolicy(trustedSigners.value);

  return {
    build: {
      summarySha256: build.sha256,
      provenanceSha256: buildProvenance.sha256,
      completedAt: build.value.completedAt,
      imageDigests: build.value.imageDigests,
      builderId: buildProvenance.value.builderId,
      invocationId: buildProvenance.value.invocationId,
    },
    test: {
      summarySha256: test.sha256,
      completedAt: test.value.completedAt,
      command: test.value.command
    },
    smoke: {
      summarySha256: smoke.sha256,
      completedAt: smoke.value.completedAt,
      traceId: smoke.value.traceId
    },
    environment: {
      summarySha256: environment.sha256,
      completedAt: environment.value.completedAt,
      class: environment.value.class,
      provider: environment.value.provider
    },
    sbom: {
      sha256: sbom.sha256,
      spdxVersion: sbom.value.spdxVersion,
      documentNamespace: sbom.value.documentNamespace
    },
    signerPolicy: {
      sha256: trustedSigners.sha256,
      policyId: signerPolicy.policyId,
      keys: signerPolicy.keys
    }
  };
}

function assertMaterialHash(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} hash does not match manifest.`);
  }
}

function assertEvidenceMatchesManifest(evidence, manifest) {
  assertMaterialHash(evidence.build.summarySha256, manifest.build.summarySha256, "build summary");
  assertMaterialHash(evidence.build.provenanceSha256, manifest.build.provenanceSha256, "build provenance");
  assertMaterialHash(evidence.test.summarySha256, manifest.test.summarySha256, "test summary");
  assertMaterialHash(evidence.smoke.summarySha256, manifest.smoke.summarySha256, "smoke summary");
  assertMaterialHash(evidence.environment.summarySha256, manifest.environment.summarySha256, "environment summary");
  assertMaterialHash(evidence.sbom.sha256, manifest.sbom.sha256, "SBOM");
  assertMaterialHash(evidence.signerPolicy.sha256, manifest.signerPolicy.sha256, "trusted signer policy");
  if (evidence.signerPolicy.policyId !== manifest.signerPolicy.policyId) {
    fail("trusted signer policy ID does not match manifest.");
  }
  if (evidence.smoke.traceId !== manifest.traceId || evidence.smoke.traceId !== manifest.smoke.traceId) {
    fail("smoke summary traceId does not match manifest.");
  }
  if (canonicalJson(evidence.build.imageDigests) !== canonicalJson(manifest.imageDigests) || canonicalJson(evidence.build.imageDigests) !== canonicalJson(manifest.build.imageDigests)) {
    fail("build summary image digests do not match manifest.");
  }
  if (evidence.build.builderId !== manifest.build.builderId || evidence.build.invocationId !== manifest.build.invocationId) {
    fail("build provenance metadata does not match manifest.");
  }
  if (evidence.test.command !== manifest.test.command || evidence.environment.class !== manifest.environment.class || evidence.environment.provider !== manifest.environment.provider) {
    fail("release evidence metadata does not match manifest.");
  }
}

function assertManifestShape(manifest, repositoryRoot) {
  assertJsonObject(manifest, "Release evidence");
  if (manifest.schemaVersion !== schemaVersion) {
    fail(`Unsupported release evidence schema: ${manifest.schemaVersion ?? "missing"}.`);
  }
  assertCandidate(manifest.candidateSha, "candidateSha");
  assertIsoDate(manifest.generatedAt, "generatedAt");
  assertIsoDate(manifest.expiresAt, "expiresAt", { future: true });
  assertTraceId(manifest.traceId);

  assertJsonObject(manifest.environment, "environment");
  for (const field of ["nodeVersion", "platform", "arch", "pnpmVersion", "summarySha256", "class", "provider", "completedAt"]) {
    if (typeof manifest.environment[field] !== "string" || manifest.environment[field].trim() === "") {
      fail(`environment.${field} is required.`);
    }
  }
  assertSha256(manifest.environment.summarySha256, "environment.summarySha256");
  assertIsoDate(manifest.environment.completedAt, "environment.completedAt");

  assertImageDigests(manifest.imageDigests);
  if (!manifest.artifactHashes || typeof manifest.artifactHashes !== "object" || Array.isArray(manifest.artifactHashes)) {
    fail("artifactHashes is required.");
  }
  for (const requiredArtifact of requiredArtifactFiles) {
    if (!Object.hasOwn(manifest.artifactHashes, requiredArtifact)) {
      fail(`Missing required artifact hash: ${requiredArtifact}`);
    }
  }
  for (const [filePath, expectedHash] of Object.entries(manifest.artifactHashes)) {
    assertArtifactPath(repositoryRoot, filePath);
    assertSha256(expectedHash, `Artifact hash for ${filePath}`);
  }

  assertJsonObject(manifest.build, "build evidence");
  assertSha256(manifest.build.summarySha256, "build.summarySha256");
  assertSha256(manifest.build.provenanceSha256, "build.provenanceSha256");
  assertIsoDate(manifest.build.completedAt, "build.completedAt");
  assertImageDigests(manifest.build.imageDigests, "build.imageDigests");
  for (const field of ["builderId", "invocationId"]) {
    if (typeof manifest.build[field] !== "string" || manifest.build[field].trim() === "") {
      fail(`build.${field} is required.`);
    }
  }
  assertJsonObject(manifest.test, "test evidence");
  assertSha256(manifest.test.summarySha256, "test.summarySha256");
  assertIsoDate(manifest.test.completedAt, "test.completedAt");
  if (typeof manifest.test.command !== "string" || manifest.test.command.trim() === "") {
    fail("test.command is required.");
  }
  assertJsonObject(manifest.smoke, "smoke evidence");
  assertSha256(manifest.smoke.summarySha256, "smoke.summarySha256");
  assertIsoDate(manifest.smoke.completedAt, "smoke.completedAt");
  assertTraceId(manifest.smoke.traceId, "smoke.traceId");
  assertJsonObject(manifest.sbom, "SBOM evidence");
  assertSha256(manifest.sbom.sha256, "sbom.sha256");
  if (typeof manifest.sbom.spdxVersion !== "string" || typeof manifest.sbom.documentNamespace !== "string") {
    fail("SBOM evidence is incomplete.");
  }
  assertJsonObject(manifest.signerPolicy, "signer policy evidence");
  assertSha256(manifest.signerPolicy.sha256, "signerPolicy.sha256");
  if (typeof manifest.signerPolicy.policyId !== "string" || !policyId.test(manifest.signerPolicy.policyId)) {
    fail("signerPolicy.policyId is invalid.");
  }

  assertJsonObject(manifest.signature, "signature");
  if (manifest.signature.algorithm !== "ed25519") {
    fail("signature.algorithm must be ed25519.");
  }
  if (typeof manifest.signature.keyId !== "string" || !keyId.test(manifest.signature.keyId)) {
    fail("signature.keyId is invalid.");
  }
  if (typeof manifest.signature.value !== "string" || manifest.signature.value.length === 0) {
    fail("signature.value is required.");
  }
}

function parseArguments(argv) {
  const values = {};
  let mode;
  const valueFlags = new Set(["--output", "--manifest", "--signing-key", "--key-id", "--trace-id", "--expires-at", ...inputFlags]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--generate" || argument === "--verify") {
      if (mode) {
        fail("Choose exactly one of --generate or --verify.");
      }
      mode = argument;
      continue;
    }
    if (!valueFlags.has(argument)) {
      fail(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`${argument} requires a value.`);
    }
    values[argument] = value;
    index += 1;
  }

  if (!mode) {
    fail("Usage: node scripts/release-manifest.mjs --generate --output <external-path> --build-summary <external-json> --build-provenance <external-json> --sbom <external-spdx-json> --smoke-summary <external-json> --test-summary <external-json> --environment-summary <external-json> --trusted-signers <external-json> --signing-key <external-pem> --key-id <id> --trace-id <id> --expires-at <iso> | --verify --manifest <external-path> --build-summary <external-json> --build-provenance <external-json> --sbom <external-spdx-json> --smoke-summary <external-json> --test-summary <external-json> --environment-summary <external-json> --trusted-signers <external-json>");
  }
  return { mode, values };
}

function artifactHashes(repositoryRoot) {
  return Object.fromEntries(
    requiredArtifactFiles.map((filePath) => [filePath, getFileSha256(assertArtifactPath(repositoryRoot, filePath))])
  );
}

function trustedPublicKey(evidence, signatureKeyId) {
  const publicKey = evidence.signerPolicy.keys.get(signatureKeyId);
  if (!publicKey) {
    fail(`signature.keyId ${signatureKeyId} is not authorized by the trusted signer policy.`);
  }
  return publicKey;
}

function generate(values) {
  const repositoryRoot = getRepositoryRoot();
  const outputPath = assertExternalPath(values["--output"], repositoryRoot, "--output");
  const signingKeyPath = assertExistingExternalPath(values["--signing-key"], repositoryRoot, "--signing-key");
  const releaseKeyId = values["--key-id"];
  if (typeof releaseKeyId !== "string" || !keyId.test(releaseKeyId)) {
    fail("--key-id must contain only letters, numbers, dots, underscores, or hyphens.");
  }
  assertTraceId(values["--trace-id"], "--trace-id");
  const expiresAt = assertIsoDate(values["--expires-at"], "--expires-at", { future: true }).toISOString();

  assertCleanWorkingTree();
  const currentCandidate = getGitSha();
  const evidence = readEvidenceInputs(values, repositoryRoot, currentCandidate, values["--trace-id"]);
  const privateKey = createPrivateKey(readFileSync(signingKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    fail("--signing-key must be an ed25519 private key.");
  }
  const policyKey = trustedPublicKey(evidence, releaseKeyId);
  const derivedPublicKey = createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
  const trustedPolicyKey = policyKey.export({ format: "pem", type: "spki" }).toString();
  if (derivedPublicKey !== trustedPolicyKey) {
    fail("--signing-key does not match the trusted signer policy keyId.");
  }

  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion,
    generatedAt,
    expiresAt,
    candidateSha: currentCandidate,
    traceId: values["--trace-id"],
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pnpmVersion: command("pnpm", ["--version"]),
      ...evidence.environment
    },
    imageDigests: evidence.build.imageDigests,
    artifactHashes: artifactHashes(repositoryRoot),
    build: evidence.build,
    test: evidence.test,
    smoke: evidence.smoke,
    sbom: evidence.sbom,
    signerPolicy: {
      sha256: evidence.signerPolicy.sha256,
      policyId: evidence.signerPolicy.policyId
    }
  };

  assertManifestShape({
    ...manifest,
    signature: { algorithm: "ed25519", keyId: releaseKeyId, value: "pending" }
  }, repositoryRoot);
  manifest.signature = {
    algorithm: "ed25519",
    keyId: releaseKeyId,
    value: sign(null, signaturePayload(manifest), privateKey).toString("base64")
  };
  writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`SUCCESS: Release evidence generated at ${outputPath}`);
}

function verify(values) {
  const repositoryRoot = getRepositoryRoot();
  const manifestPath = assertExistingExternalPath(values["--manifest"], repositoryRoot, "--manifest");
  const manifest = parseJsonFile(manifestPath, "release evidence");

  assertManifestShape(manifest, repositoryRoot);
  assertCleanWorkingTree();
  const currentCandidate = getGitSha();
  if (currentCandidate !== manifest.candidateSha) {
    fail(`Release evidence candidate SHA does not match HEAD. Expected ${currentCandidate}, received ${manifest.candidateSha}.`);
  }
  const evidence = readEvidenceInputs(values, repositoryRoot, manifest.candidateSha, manifest.traceId);
  assertEvidenceMatchesManifest(evidence, manifest);
  for (const [filePath, expectedHash] of Object.entries(manifest.artifactHashes)) {
    const actualHash = getFileSha256(assertArtifactPath(repositoryRoot, filePath));
    if (actualHash !== expectedHash) {
      fail(`Artifact hash mismatch for ${filePath}.`);
    }
  }
  const publicKey = trustedPublicKey(evidence, manifest.signature.keyId);
  const signature = Buffer.from(manifest.signature.value, "base64");
  if (!verifySignature(null, signaturePayload(manifest), publicKey, signature)) {
    fail("Release evidence signature verification failed.");
  }
  console.log("SUCCESS: Release evidence is current, complete, candidate-bound, and signature-verified.");
}

function main() {
  try {
    const { mode, values } = parseArguments(process.argv.slice(2));
    if (mode === "--generate") {
      generate(values);
    } else {
      verify(values);
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
