#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertCanaryLoadEvidenceSetForPromotion } from "./lib/canary-load-evidence.mjs";
import {
  HttpCanaryControllerError,
  evaluateHttpCanaryObservation,
  httpCanaryControllerCommandPlan,
  runHttpCanaryController,
} from "./lib/http-canary-controller.mjs";
import { assertHttpCanaryImageEvidenceForPromotion } from "./lib/http-canary-image.mjs";
import {
  httpCanaryEvidenceTextSha256,
  httpCanaryLoadEvidenceTextsSha256,
} from "./lib/http-canary-release-evidence.mjs";
import { runHttpCanaryRollbackProbe } from "./lib/http-canary-rollback-probe.mjs";
import {
  assertReleaseDeploymentSelection,
  composeImageEnvironment,
} from "./lib/release-deployment.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const operationTimeoutMs = 120_000;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      fail(`invalid argument near ${flag ?? "end of command"}`);
    }
    if (values[flag]) fail(`duplicate argument: ${flag}`);
    values[flag] = value;
  }
  return values;
}

function required(values, flag) {
  if (!values[flag]) fail(`${flag} is required`);
  return values[flag];
}

function readText(path, label) {
  try {
    return readFileSync(path, "utf8");
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

function readJson(path, label) {
  return parseJson(readText(path, label), label);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function execute(command, environment) {
  const [file, ...args] = command;
  return execFileSync(file, args, {
    cwd: repo,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: operationTimeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function commandResult(command, output) {
  return {
    commandSha256: sha256(canonicalJson(command)),
    outputSha256: sha256(canonicalJson(output)),
  };
}

function docker(args, environment) {
  return execute(["docker", ...args], environment);
}

function composePrefix(projectName) {
  return [
    "compose",
    "--project-name",
    projectName,
    "--file",
    "docker-compose.yml",
    "--file",
    "docker-compose.release.yml",
  ];
}

function container(compose, service, environment) {
  const ids = docker([...compose, "ps", "--all", "--quiet", service], environment)
    .split("\n")
    .filter(Boolean);
  if (ids.length !== 1) fail(`${service} must resolve to exactly one release container`);
  return JSON.parse(docker(["inspect", ids[0]], environment))[0];
}

function configuredEnvironment(containerValue) {
  return Object.fromEntries((containerValue.Config.Env ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function assertReversedTopology(compose, environment) {
  const web = configuredEnvironment(container(compose, "web", environment));
  const gateway = configuredEnvironment(container(compose, "realtime-gateway", environment));
  const observed = {
    webTarget: web.WEB_PLATFORM_API_UPSTREAM,
    gatewayTarget: gateway.PLATFORM_API_URL,
  };
  if (observed.webTarget !== "platform-api:8080") {
    fail("traffic reversal did not return Web to the Rust API");
  }
  if (observed.gatewayTarget !== "http://platform-api:8080") {
    fail("traffic reversal did not return realtime indexing to the Rust API");
  }
  return observed;
}

async function waitForApplicationContainers(compose, environment, attempts = 120) {
  const services = [
    "platform-api",
    "node-api",
    "job-worker",
    "node-realtime",
    "realtime-gateway",
    "asr-inference",
    "web",
  ];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const states = services.map((service) => {
      try {
        const value = container(compose, service, environment);
        return {
          service,
          running: value.State.Running === true,
          health: value.State.Health?.Status ?? "missing",
        };
      } catch {
        return { service, running: false, health: "missing" };
      }
    });
    if (states.every(({ running, health }) => running && health === "healthy")) return states;
    await sleep(500);
  }
  fail("previous application containers did not become healthy within 60 seconds");
}

function validatePromotionProofs({ selection, candidateText, loadTexts, validatedAt }) {
  const candidate = assertHttpCanaryImageEvidenceForPromotion(
    parseJson(candidateText, "candidate image evidence"),
    { validatedAt },
  );
  if (!isDeepStrictEqual(candidate.selection, selection)) {
    fail("candidate image evidence does not match the preserved deployment selection");
  }
  const nodeImage = candidate.images.find(({ service }) => service === "node-api");
  if (!nodeImage) fail("candidate image evidence is missing node-api");
  assertCanaryLoadEvidenceSetForPromotion(
    Object.fromEntries(Object.entries(loadTexts).map(([profile, text]) => [
      profile,
      parseJson(text, `${profile} load evidence`),
    ])),
    {
      sourceSha: candidate.sourceSha,
      nodeImageId: nodeImage.imageId,
      topologySha256: candidate.topology.renderedSha256,
    },
    { validatedAt },
  );
}

function writeOnce(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1[REDACTED]@")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 800);
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const outputPath = required(values, "--evidence-output");
  let wrote = false;
  let selection = null;
  let observation = null;
  let observationAccepted = false;
  try {
    const selectionPath = required(values, "--selection");
    selection = assertReleaseDeploymentSelection(
      readJson(selectionPath, "release deployment selection"),
    );
    const projectName = required(values, "--project-name");
    const runClass = required(values, "--run-class");
    const plan = httpCanaryControllerCommandPlan({ projectName });
    observation = readJson(required(values, "--observation"), "HTTP canary observation");
    const stopSignals = evaluateHttpCanaryObservation(observation);
    observationAccepted = true;
    const candidateText = readText(
      required(values, "--candidate-evidence"),
      "candidate image evidence",
    );
    const loadTexts = {
      classroom: readText(
        required(values, "--classroom-load-evidence"),
        "classroom load evidence",
      ),
      burst: readText(required(values, "--burst-load-evidence"), "burst load evidence"),
      soak: readText(required(values, "--soak-load-evidence"), "soak load evidence"),
    };
    if (stopSignals.length === 0) {
      validatePromotionProofs({
        selection,
        candidateText,
        loadTexts,
        validatedAt: new Date().toISOString(),
      });
    }

    const candidateEvidenceSha256 = httpCanaryEvidenceTextSha256(candidateText);
    const loadEvidenceSha256 = httpCanaryLoadEvidenceTextsSha256(loadTexts);
    const candidateEnvironment = {
      ...process.env,
      ...composeImageEnvironment(selection, "candidate"),
    };
    const previousEnvironment = {
      ...process.env,
      ...composeImageEnvironment(selection, "previous"),
    };
    const compose = composePrefix(projectName);
    const tempDirectory = mkdtempSync(join(tmpdir(), "qrai-http-canary-controller-"));
    const runningEvidencePath = join(tempDirectory, "previous-applications.json");

    try {
      const operations = {
        async reverseTraffic() {
          const output = execute(plan.reverseTraffic, candidateEnvironment);
          const topology = assertReversedTopology(compose, candidateEnvironment);
          return commandResult(plan.reverseTraffic, { output, topology });
        },
        async deployPrevious() {
          const output = execute(plan.deployPrevious, previousEnvironment);
          return commandResult(plan.deployPrevious, output);
        },
        async verifyPrevious() {
          const states = await waitForApplicationContainers(compose, previousEnvironment);
          const verifyCommand = [
            ...plan.verifyPrevious,
            "--selection",
            selectionPath,
            "--project-name",
            projectName,
            "--evidence-output",
            runningEvidencePath,
          ];
          const verifyOutput = execute(verifyCommand, previousEnvironment);
          const runningEvidence = readJson(runningEvidencePath, "previous application evidence");
          if (
            runningEvidence.schemaVersion !== "qrai-running-application-image-evidence/v1" ||
            runningEvidence.sourceSha !== selection.previous.sourceSha ||
            runningEvidence.slot !== "previous" ||
            runningEvidence.scope !== "application" ||
            !Array.isArray(runningEvidence.images) ||
            runningEvidence.images.length !== 7
          ) {
            fail("previous application image evidence does not match the preserved selection");
          }
          const jwtSecret = process.env.JWT_SECRET;
          const databaseUrl = process.env.DATABASE_URL;
          if (!jwtSecret) fail("JWT_SECRET is required for rollback effect verification");
          if (!databaseUrl) fail("DATABASE_URL is required for rollback effect verification");
          const effect = await runHttpCanaryRollbackProbe({
            baseUrl: values["--base-url"] ?? "http://127.0.0.1:5173",
            jwtSecret,
            databaseUrl,
          });
          const output = { verifyOutput, states, images: runningEvidence.images, effect };
          return {
            ...commandResult(verifyCommand, output),
            applicationImagesVerified: runningEvidence.images.length,
            storedEffects: effect.storedEffects,
            duplicateEffects: effect.duplicateEffects,
            privacyCleanup: effect.privacyCleanup,
          };
        },
      };

      const evidence = await runHttpCanaryController({
        selection,
        sourceSha: selection.candidate.sourceSha,
        runClass,
        candidateEvidenceSha256,
        loadEvidenceSha256,
        observation,
        operations,
      });
      writeOnce(outputPath, evidence);
      wrote = true;
      console.log(JSON.stringify({ status: evidence.status, evidenceOutput: outputPath }));
      if (evidence.status === "rollback-complete") process.exitCode = 2;
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  } catch (error) {
    const failure = error instanceof HttpCanaryControllerError
      ? error.evidence
      : {
          schemaVersion: "qrai-http-canary-controller-input-failure/v1",
          status: "failed",
          failedAt: new Date().toISOString(),
          candidateSourceSha: selection?.candidate?.sourceSha ?? "unknown",
          observationAccepted,
          error: safeError(error),
        };
    if (!wrote) writeOnce(outputPath, failure);
    throw error;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`ERROR: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
