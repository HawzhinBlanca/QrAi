import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const challengeSchemaVersion = "qrai-release-challenge/v1";
const runnerValue = /^[A-Za-z0-9._-]{1,128}$/;
const traceId = /^release-trace-[a-z0-9][a-z0-9-]{15,127}$/;
const manifestInputs = [
  "--manifest",
  "--build-summary",
  "--build-provenance",
  "--sbom",
  "--smoke-summary",
  "--test-summary",
  "--environment-summary",
  "--trusted-signers",
];

function fail(message) {
  throw new Error(message);
}

function command(commandName, args, cwd) {
  return execFileSync(commandName, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function getCandidateRoot(candidateDirectory) {
  const resolvedCandidate = resolve(candidateDirectory);
  if (!existsSync(resolvedCandidate)) fail(`--candidate-dir does not exist: ${resolvedCandidate}`);
  try {
    const gitRoot = command("git", ["rev-parse", "--show-toplevel"], resolvedCandidate);
    if (realpathSync.native(gitRoot) !== realpathSync.native(resolvedCandidate)) {
      fail("--candidate-dir must be the root of the clean candidate checkout.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("--candidate-dir must")) throw error;
    fail("--candidate-dir must be a Git checkout root.");
  }
  return realpathSync.native(resolvedCandidate);
}

function assertCleanCandidate(candidateDirectory) {
  if (command("git", ["status", "--porcelain=v1", "--untracked-files=all"], candidateDirectory)) {
    fail("Challenge candidate checkout contains untracked or modified files.");
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
    if (parentPath === existingPath) fail(`Unable to resolve path: ${filePath}`);
    missingSegments.unshift(basename(existingPath));
    existingPath = parentPath;
  }
  return join(realpathSync.native(existingPath), ...missingSegments);
}

function assertExternalPath(filePath, candidateRoot, flag, { exists = false } = {}) {
  if (!filePath) fail(`${flag} is required.`);
  const physicalPath = resolvePhysicalPath(filePath);
  if (isPathWithin(candidateRoot, physicalPath)) {
    fail(`${flag} must be outside the candidate checkout.`);
  }
  if (exists && !existsSync(physicalPath)) {
    fail(`${flag} does not exist: ${physicalPath}`);
  }
  return physicalPath;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Unable to parse ${label}: ${error.message}`);
  }
}

function parseArguments(argv) {
  const requiredValues = new Set([
    "--candidate-dir",
    ...manifestInputs,
    "--challenge-output",
    "--runner-id",
    "--runner-class",
  ]);
  const releaseValues = new Set([
    "--challenge-smoke-dir",
    "--challenge-test-summary",
    "--challenge-environment-summary",
    "--challenge-trace-id",
    "--environment-class",
    "--environment-provider",
  ]);
  const knownValues = new Set([...requiredValues, ...releaseValues]);
  const values = {};
  let mode;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--verify-manifest-only" || argument === "--run-release") {
      if (mode) fail("Choose exactly one of --verify-manifest-only or --run-release.");
      mode = argument;
      continue;
    }
    if (!knownValues.has(argument)) fail(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value.`);
    values[argument] = value;
    index += 1;
  }

  if (!mode) fail("Choose --verify-manifest-only or --run-release.");
  for (const flag of requiredValues) {
    if (!values[flag]) fail(`${flag} is required.`);
  }
  if (mode === "--run-release") {
    for (const flag of releaseValues) {
      if (!values[flag]) fail(`${flag} is required with --run-release.`);
    }
  }
  for (const flag of ["--runner-id", "--runner-class"]) {
    if (!runnerValue.test(values[flag])) {
      fail(`${flag} must contain only letters, numbers, dots, underscores, or hyphens.`);
    }
  }
  if (mode === "--run-release") {
    for (const flag of ["--environment-class", "--environment-provider"]) {
      if (!runnerValue.test(values[flag])) {
        fail(`${flag} must contain only letters, numbers, dots, underscores, or hyphens.`);
      }
    }
    if (!traceId.test(values["--challenge-trace-id"])) {
      fail("--challenge-trace-id must be a release trace identifier.");
    }
  }
  return { mode, values };
}

function manifestArguments(paths) {
  return [
    "--verify",
    "--manifest", paths["--manifest"],
    "--build-summary", paths["--build-summary"],
    "--build-provenance", paths["--build-provenance"],
    "--sbom", paths["--sbom"],
    "--smoke-summary", paths["--smoke-summary"],
    "--test-summary", paths["--test-summary"],
    "--environment-summary", paths["--environment-summary"],
    "--trusted-signers", paths["--trusted-signers"],
  ];
}

function runOrFail(commandName, args, { cwd, env }) {
  const result = spawnSync(commandName, args, {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) fail(`${commandName} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${commandName} ${args.join(" ")} failed with exit status ${result.status ?? "unknown"}.`);
}

function writeReport(outputPath, report) {
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function challengePaths(values, candidateRoot) {
  const paths = {};
  for (const flag of manifestInputs) {
    paths[flag] = assertExternalPath(values[flag], candidateRoot, flag, { exists: true });
  }
  paths["--challenge-output"] = assertExternalPath(values["--challenge-output"], candidateRoot, "--challenge-output");
  return paths;
}

function releasePaths(values, candidateRoot) {
  const paths = {};
  for (const flag of ["--challenge-smoke-dir", "--challenge-test-summary", "--challenge-environment-summary"]) {
    paths[flag] = assertExternalPath(values[flag], candidateRoot, flag);
  }
  if (paths["--challenge-test-summary"] === paths["--challenge-environment-summary"]) {
    fail("--challenge-test-summary and --challenge-environment-summary must be different files.");
  }
  return paths;
}

function validateIndependentRunner(values, paths) {
  const provenance = readJson(paths["--build-provenance"], "build provenance");
  if (!runnerValue.test(provenance.builderId ?? "")) {
    fail("build provenance builderId is invalid.");
  }
  if (values["--runner-id"] === provenance.builderId) {
    fail("--runner-id must differ from build provenance builderId.");
  }
  return provenance.builderId;
}

function main() {
  let outputPath;
  let candidateSha;
  let values;
  let mode;
  try {
    ({ mode, values } = parseArguments(process.argv.slice(2)));
    const candidateRoot = getCandidateRoot(values["--candidate-dir"]);
    assertCleanCandidate(candidateRoot);
    const paths = challengePaths(values, candidateRoot);
    outputPath = paths["--challenge-output"];
    const builderId = validateIndependentRunner(values, paths);
    const manifest = readJson(paths["--manifest"], "release manifest");
    candidateSha = manifest.candidateSha;

    runOrFail(process.execPath, [join(candidateRoot, "scripts", "release-manifest.mjs"), ...manifestArguments(paths)], {
      cwd: candidateRoot,
      env: process.env,
    });

    let releaseGate = { status: "not-run", reason: "manifest-only challenge" };
    if (mode === "--run-release") {
      if (!process.env.RELEASE_DATABASE_URL) {
        fail("RELEASE_DATABASE_URL must be set for --run-release and is intentionally accepted only through the environment.");
      }
      const freshPaths = releasePaths(values, candidateRoot);
      runOrFail("bash", ["scripts/verify.sh", "--release"], {
        cwd: candidateRoot,
        env: {
          ...process.env,
          RELEASE_SMOKE_ARTIFACT_DIR: freshPaths["--challenge-smoke-dir"],
          RELEASE_SMOKE_TRACE_ID: values["--challenge-trace-id"],
          RELEASE_TEST_SUMMARY: freshPaths["--challenge-test-summary"],
          RELEASE_ENVIRONMENT_SUMMARY: freshPaths["--challenge-environment-summary"],
          RELEASE_ENVIRONMENT_CLASS: values["--environment-class"],
          RELEASE_ENVIRONMENT_PROVIDER: values["--environment-provider"],
          RELEASE_IMAGE_DIGESTS_JSON: JSON.stringify(manifest.imageDigests),
        },
      });
      releaseGate = {
        status: "passed",
        command: "bash scripts/verify.sh --release",
        traceId: values["--challenge-trace-id"],
        smokeSummarySha256: sha256(join(freshPaths["--challenge-smoke-dir"], "summary.json")),
        testSummarySha256: sha256(freshPaths["--challenge-test-summary"]),
        environmentSummarySha256: sha256(freshPaths["--challenge-environment-summary"]),
      };
    }

    const report = {
      schemaVersion: challengeSchemaVersion,
      status: mode === "--run-release" ? "passed" : "manifest-verified-only",
      candidateSha,
      completedAt: new Date().toISOString(),
      challenger: {
        runnerId: values["--runner-id"],
        runnerClass: values["--runner-class"],
        differsFromBuilderId: builderId,
      },
      manifest: {
        sha256: sha256(paths["--manifest"]),
        verification: "passed",
      },
      releaseGate,
    };
    writeReport(outputPath, report);
    console.log(`SUCCESS: Release challenge ${report.status} for ${candidateSha}.`);
  } catch (error) {
    if (outputPath) {
      writeReport(outputPath, {
        schemaVersion: challengeSchemaVersion,
        status: "failed",
        candidateSha: candidateSha ?? null,
        completedAt: new Date().toISOString(),
        challenger: values ? { runnerId: values["--runner-id"], runnerClass: values["--runner-class"] } : null,
        failure: error instanceof Error ? error.message : String(error),
      });
    }
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
