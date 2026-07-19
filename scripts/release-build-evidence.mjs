import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const candidateShaPattern = /^[a-f0-9]{40}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const deployableServices = ["platform-api", "realtime-gateway", "ml-inference", "asr-inference", "web"];
const valuePattern = /^[A-Za-z0-9._:/@+=, -]{1,512}$/;

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
    fail("Release build evidence must be written from a Git checkout.");
  }
}

function assertCleanWorkingTree() {
  if (command("git", ["status", "--porcelain=v1", "--untracked-files=all"])) {
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

function assertExternalPath(filePath, repositoryRoot, flag, { exists = false } = {}) {
  if (!filePath) fail(`${flag} is required.`);
  const physicalPath = resolvePhysicalPath(filePath);
  const physicalRepositoryRoot = realpathSync.native(resolve(repositoryRoot));
  if (isPathWithin(physicalRepositoryRoot, physicalPath)) {
    fail(`${flag} must be outside the candidate checkout.`);
  }
  if (exists && !existsSync(physicalPath)) {
    fail(`${flag} must reference an existing file.`);
  }
  return physicalPath;
}

function assertValue(value, flag) {
  if (typeof value !== "string" || !valuePattern.test(value)) {
    fail(`${flag} must be a non-empty release metadata value.`);
  }
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parseImageDigests(filePath) {
  let imageDigests;
  try {
    imageDigests = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    fail("--image-digests must contain valid JSON.");
  }
  if (!imageDigests || typeof imageDigests !== "object" || Array.isArray(imageDigests)) {
    fail("--image-digests must contain an object.");
  }
  for (const service of deployableServices) {
    if (typeof imageDigests[service] !== "string" || !imageDigestPattern.test(imageDigests[service])) {
      fail(`imageDigests.${service} must be a non-empty sha256 digest.`);
    }
  }
  return imageDigests;
}

function parseArguments(argv) {
  const flags = new Set(["--summary-output", "--provenance-output", "--image-digests", "--builder-id", "--invocation-id", "--command"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.has(flag)) fail(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires a value.`);
    values[flag] = value;
    index += 1;
  }
  for (const flag of flags) {
    if (!values[flag]) fail(`${flag} is required.`);
  }
  for (const flag of ["--builder-id", "--invocation-id", "--command"]) {
    assertValue(values[flag], flag);
  }
  return values;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function main() {
  try {
    const values = parseArguments(process.argv.slice(2));
    const repositoryRoot = getRepositoryRoot();
    const summaryOutput = assertExternalPath(values["--summary-output"], repositoryRoot, "--summary-output");
    const provenanceOutput = assertExternalPath(values["--provenance-output"], repositoryRoot, "--provenance-output");
    const imageDigestsPath = assertExternalPath(values["--image-digests"], repositoryRoot, "--image-digests", { exists: true });
    if (summaryOutput === provenanceOutput) {
      fail("--summary-output and --provenance-output must be different files.");
    }
    assertCleanWorkingTree();
    const candidateSha = command("git", ["rev-parse", "HEAD"]);
    if (!candidateShaPattern.test(candidateSha)) fail("Current candidate must be a full lowercase Git SHA.");
    const imageDigests = parseImageDigests(imageDigestsPath);
    const completedAt = new Date().toISOString();
    const provenance = {
      schemaVersion: "qrai-build-provenance/v1",
      candidateSha,
      status: "passed",
      completedAt,
      builderId: values["--builder-id"],
      invocationId: values["--invocation-id"],
      command: values["--command"],
      imageDigests,
    };
    writeJson(provenanceOutput, provenance);
    const summary = {
      schemaVersion: "qrai-build-summary/v1",
      candidateSha,
      status: "passed",
      completedAt,
      imageDigests,
      provenance: {
        sha256: sha256(provenanceOutput),
        builderId: provenance.builderId,
        invocationId: provenance.invocationId,
      },
    };
    writeJson(summaryOutput, summary);
    console.log(`SUCCESS: Wrote candidate-bound build evidence for ${candidateSha}.`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
