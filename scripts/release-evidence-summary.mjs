import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const environmentValue = /^[A-Za-z0-9._-]{1,128}$/;

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
    fail("Release evidence summaries must be written from a Git checkout.");
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

function assertExternalOutput(filePath, repositoryRoot, flag) {
  if (!filePath) {
    fail(`${flag} is required.`);
  }
  const physicalPath = resolvePhysicalPath(filePath);
  const physicalRepositoryRoot = realpathSync.native(resolve(repositoryRoot));
  if (isPathWithin(physicalRepositoryRoot, physicalPath)) {
    fail(`${flag} must be outside the candidate checkout.`);
  }
  return physicalPath;
}

function parseArguments(argv) {
  const flags = new Set(["--test-output", "--environment-output", "--environment-class", "--environment-provider", "--smoke-artifact-dir"]);
  const values = {};
  let validateOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--validate-only") {
      validateOnly = true;
      continue;
    }
    if (!flags.has(flag)) {
      fail(`Unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`${flag} requires a value.`);
    }
    values[flag] = value;
    index += 1;
  }
  for (const flag of flags) {
    if (!values[flag]) {
      fail(`${flag} is required.`);
    }
  }
  for (const flag of ["--environment-class", "--environment-provider"]) {
    if (!environmentValue.test(values[flag])) {
      fail(`${flag} must contain only letters, numbers, dots, underscores, or hyphens.`);
    }
  }
  return { values, validateOnly };
}

function writeSummary(filePath, summary) {
  writeFileSync(filePath, JSON.stringify(summary, null, 2) + "\n");
}

function main() {
  try {
    const { values, validateOnly } = parseArguments(process.argv.slice(2));
    const repositoryRoot = getRepositoryRoot();
    const testOutput = assertExternalOutput(values["--test-output"], repositoryRoot, "--test-output");
    const environmentOutput = assertExternalOutput(values["--environment-output"], repositoryRoot, "--environment-output");
    assertExternalOutput(values["--smoke-artifact-dir"], repositoryRoot, "--smoke-artifact-dir");
    if (testOutput === environmentOutput) {
      fail("--test-output and --environment-output must be different files.");
    }
    assertCleanWorkingTree();
    if (validateOnly) {
      console.log("SUCCESS: Release evidence destinations are external and the candidate is clean.");
      return;
    }
    const candidateSha = command("git", ["rev-parse", "HEAD"]);
    const completedAt = new Date().toISOString();
    writeSummary(testOutput, {
      schemaVersion: "qrai-test-summary/v1",
      candidateSha,
      status: "passed",
      command: "bash scripts/verify.sh --release",
      completedAt
    });
    writeSummary(environmentOutput, {
      schemaVersion: "qrai-environment-summary/v1",
      candidateSha,
      status: "passed",
      class: values["--environment-class"],
      provider: values["--environment-provider"],
      completedAt
    });
    console.log(`SUCCESS: Wrote release test and environment summaries for ${candidateSha}.`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
