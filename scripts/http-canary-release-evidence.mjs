#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertHttpCanaryReleaseEvidenceDocuments } from "./lib/http-canary-release-evidence.mjs";

const repositoryRoot = realpathSync.native(resolve(fileURLToPath(new URL("..", import.meta.url))));
const valueFlags = new Set([
  "--candidate-sha",
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
  "--output",
]);

function fail(message) {
  throw new Error(message);
}

function command(file, args) {
  return execFileSync(file, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseArguments(argv) {
  const values = {};
  let validateOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--validate-only") {
      if (validateOnly) fail("duplicate argument: --validate-only");
      validateOnly = true;
      continue;
    }
    if (!valueFlags.has(flag)) fail(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
    if (values[flag]) fail(`duplicate argument: ${flag}`);
    values[flag] = value;
    index += 1;
  }
  for (const flag of valueFlags) {
    if (flag === "--output" && validateOnly) continue;
    if (!values[flag]) fail(`${flag} is required`);
  }
  if (validateOnly && values["--output"]) {
    fail("--output is not accepted with --validate-only");
  }
  return { values, validateOnly };
}

function isPathWithin(directory, candidatePath) {
  const pathFromDirectory = relative(directory, candidatePath);
  return pathFromDirectory === "" || (
    pathFromDirectory !== ".." &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromDirectory)
  );
}

function resolvePhysicalPath(filePath) {
  let existingPath = resolve(filePath);
  const missingSegments = [];
  while (!existsSync(existingPath)) {
    const parentPath = dirname(existingPath);
    if (parentPath === existingPath) fail(`cannot resolve path: ${filePath}`);
    missingSegments.unshift(basename(existingPath));
    existingPath = parentPath;
  }
  return join(realpathSync.native(existingPath), ...missingSegments);
}

function externalPath(filePath, label, { mustExist }) {
  const physical = resolvePhysicalPath(filePath);
  if (isPathWithin(repositoryRoot, physical)) {
    fail(`${label} must be outside the candidate checkout`);
  }
  if (mustExist && !existsSync(physical)) fail(`${label} does not exist`);
  return physical;
}

function readExternalText(filePath, label) {
  const physical = externalPath(filePath, label, { mustExist: true });
  try {
    return { physical, text: readFileSync(physical, "utf8") };
  } catch (error) {
    fail(`${label} cannot be read: ${error.message}`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} must be valid JSON: ${error.message}`);
  }
}

function assertCleanCandidate(expectedSha) {
  const headSha = command("git", ["rev-parse", "HEAD"]);
  if (headSha !== expectedSha) fail("--candidate-sha does not match the checked-out candidate");
  const status = command("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) fail("candidate checkout must be clean before release evidence validation");
}

function readDocuments(values) {
  const inputs = {
    candidate: readExternalText(values["--candidate-evidence"], "candidate image evidence"),
    classroom: readExternalText(values["--classroom-load-evidence"], "classroom load evidence"),
    burst: readExternalText(values["--burst-load-evidence"], "burst load evidence"),
    soak: readExternalText(values["--soak-load-evidence"], "soak load evidence"),
    observation: readExternalText(values["--observation-evidence"], "observation evidence"),
    healthy: readExternalText(values["--healthy-controller-evidence"], "healthy controller evidence"),
    rollback: readExternalText(values["--rollback-controller-evidence"], "rollback controller evidence"),
    remoteCi: readExternalText(values["--remote-ci-evidence"], "remote CI evidence"),
    owner: readExternalText(values["--owner-approval"], "release-owner approval"),
    security: readExternalText(values["--security-approval"], "security approval"),
    sre: readExternalText(values["--sre-approval"], "SRE approval"),
    trustPolicy: readExternalText(values["--trust-policy"], "HTTP canary trust policy"),
  };
  const uniquePhysicalPaths = new Set(Object.values(inputs).map(({ physical }) => physical));
  if (uniquePhysicalPaths.size !== Object.keys(inputs).length) {
    fail("every release evidence role must use a distinct external file");
  }
  return {
    candidateEvidenceText: inputs.candidate.text,
    loadEvidenceTexts: {
      classroom: inputs.classroom.text,
      burst: inputs.burst.text,
      soak: inputs.soak.text,
    },
    observationEvidenceText: inputs.observation.text,
    healthyControllerEvidenceText: inputs.healthy.text,
    rollbackControllerEvidenceText: inputs.rollback.text,
    remoteCiEvidenceText: inputs.remoteCi.text,
    approvalEvidenceTexts: {
      "release-owner": inputs.owner.text,
      security: inputs.security.text,
      sre: inputs.sre.text,
    },
    trustPolicy: parseJson(inputs.trustPolicy.text, "HTTP canary trust policy"),
  };
}

function main() {
  const { values, validateOnly } = parseArguments(process.argv.slice(2));
  const candidateSha = values["--candidate-sha"];
  assertCleanCandidate(candidateSha);
  const result = assertHttpCanaryReleaseEvidenceDocuments(readDocuments(values), {
    validatedAt: new Date().toISOString(),
    expectedCandidateSha: candidateSha,
  });
  if (result.status !== "ready-for-manual-promotion") {
    fail("release evidence did not reach ready-for-manual-promotion");
  }
  if (!validateOnly) {
    const output = externalPath(values["--output"], "closure output", { mustExist: false });
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  console.log(JSON.stringify({
    status: "ready-for-manual-promotion",
    candidateSha: result.candidateSha,
    validation: validateOnly ? "passed" : "written",
  }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
