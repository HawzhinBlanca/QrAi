#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { realtimeImageCommandPlan } from "./lib/realtime-image-evidence.mjs";
import {
  createRealtimeProofPreflight,
  createRealtimeRetentionProofAdaptersFromEnvironment,
  parseRealtimeProofPort,
  runRealtimeRetentionStage,
} from "./lib/realtime-image-probe.mjs";
import {
  assertReleaseDeploymentSelection,
  composeImageEnvironment,
} from "./lib/release-deployment.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const providerPattern = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const proofIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const enabledProbeStages = new Set(["retention"]);
const allowedFlags = new Set([
  "--selection",
  "--project-name",
  "--provider",
  "--actor-class",
  "--node-port",
  "--secondary-node-port",
  "--acknowledge-staging-isolated",
]);

function fail(message) {
  throw new TypeError(message);
}

function parsePairs(argv) {
  if (argv.length % 2 !== 0) fail(`invalid argument near ${argv.at(-1) ?? "end of command"}`);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowedFlags.has(flag)) fail(`unknown proof argument: ${flag ?? "end of command"}`);
    if (Object.hasOwn(values, flag)) fail(`duplicate proof argument: ${flag}`);
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(`invalid value for ${flag}`);
    }
    values[flag] = value;
  }
  for (const flag of allowedFlags) {
    if (!Object.hasOwn(values, flag)) fail(`${flag} is required`);
  }
  return values;
}

export function parseRealtimeImageProofArguments(argv) {
  const [command, ...rest] = argv;
  if (command === "probe") {
    if (
      rest.length !== 2 ||
      rest[0] !== "--stage" ||
      !enabledProbeStages.has(rest[1])
    ) {
      fail("probe requires exactly one enabled --stage argument");
    }
    return { command, stage: rest[1] };
  }
  if (command !== "preflight") {
    fail("proof command must be preflight or an enabled probe stage");
  }
  const values = parsePairs(rest);
  if (!isAbsolute(values["--selection"])) fail("--selection must be an absolute path");
  realtimeImageCommandPlan({ projectName: values["--project-name"] });
  if (!providerPattern.test(values["--provider"])) {
    fail("--provider must be a stable non-secret staging identifier");
  }
  if (!new Set(["release-automation", "release-operator"]).has(values["--actor-class"])) {
    fail("--actor-class must identify release automation or a release operator");
  }
  if (values["--acknowledge-staging-isolated"] !== "yes") {
    fail("--acknowledge-staging-isolated must be exactly yes");
  }
  const nodePort = parseRealtimeProofPort(values["--node-port"]);
  const secondaryNodePort = parseRealtimeProofPort(values["--secondary-node-port"]);
  if (secondaryNodePort === nodePort) fail("proof ports must be distinct");
  return {
    command,
    selectionPath: values["--selection"],
    projectName: values["--project-name"],
    provider: values["--provider"],
    actorClass: values["--actor-class"],
    nodePort,
    secondaryNodePort,
  };
}

function stageString(env, name, maximumBytes = 4_096) {
  const value = env[name];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    Buffer.byteLength(value) > maximumBytes
  ) {
    fail(`realtime proof stage configuration requires ${name}`);
  }
  return value;
}

function stageIdentity(env, name) {
  const value = stageString(env, name, 128);
  if (!proofIdentityPattern.test(value) || value.includes("..")) {
    fail(`realtime proof stage configuration rejects ${name}`);
  }
  return value;
}

function stageOrigin(env) {
  const value = stageString(env, "REALTIME_PROOF_ORIGIN", 2_048);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("realtime proof stage configuration requires an exact HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    fail("realtime proof stage configuration requires an exact HTTPS origin");
  }
  return value;
}

function stageTimeout(env) {
  const value = stageString(env, "REALTIME_PROOF_TIMEOUT_MS", 5);
  if (!/^[0-9]+$/.test(value)) {
    fail("realtime proof stage configuration timeout is invalid");
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) {
    fail("realtime proof stage configuration timeout is invalid");
  }
  return timeoutMs;
}

function retentionStageConfiguration(env) {
  try {
    const jwtSecret = stageString(env, "JWT_SECRET");
    if (Buffer.byteLength(jwtSecret) < 32) {
      fail("realtime proof stage configuration JWT secret is too short");
    }
    return Object.freeze({
      nodePort: parseRealtimeProofPort(stageString(env, "REALTIME_PROOF_NODE_PORT", 5)),
      origin: stageOrigin(env),
      jwtSecret,
      tenantId: stageIdentity(env, "REALTIME_PROOF_TENANT_ID"),
      learnerId: stageIdentity(env, "REALTIME_PROOF_LEARNER_ID"),
      timeoutMs: stageTimeout(env),
    });
  } catch {
    throw new TypeError("realtime proof stage retention configuration is invalid");
  }
}

export async function runRealtimeImageProofStage({
  stage,
  env = process.env,
  retentionAdaptersFactory = createRealtimeRetentionProofAdaptersFromEnvironment,
  retentionStage = runRealtimeRetentionStage,
} = {}) {
  if (stage !== "retention") {
    throw new TypeError("realtime proof stage is not enabled");
  }
  const configuration = retentionStageConfiguration(env);
  if (typeof retentionAdaptersFactory !== "function" || typeof retentionStage !== "function") {
    throw new TypeError("realtime proof stage retention adapters are invalid");
  }

  let adapters = null;
  let measurements = null;
  let failure = null;
  try {
    adapters = await retentionAdaptersFactory({ env });
    if (
      typeof adapters?.observationProbe !== "function" ||
      typeof adapters?.cleanupProbe !== "function" ||
      typeof adapters?.close !== "function"
    ) {
      throw new TypeError("retention adapters were incomplete");
    }
    measurements = await retentionStage({
      ...configuration,
      observationProbe: adapters.observationProbe,
      cleanupProbe: adapters.cleanupProbe,
    });
  } catch {
    failure = new Error("realtime proof stage retention failed");
  }
  if (adapters !== null) {
    try {
      await adapters.close();
    } catch {
      failure = new Error("realtime proof stage retention failed");
    }
  }
  if (failure) throw failure;
  return Object.freeze({ status: "passed", stage, measurements });
}

function readSelection(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`release selection must be readable JSON: ${error.message}`);
  }
  return assertReleaseDeploymentSelection(parsed);
}

function run(file, args, environment = process.env) {
  return execFileSync(file, args, {
    cwd: repo,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 800);
}

async function main() {
  const options = parseRealtimeImageProofArguments(process.argv.slice(2));
  if (options.command === "probe") {
    console.log(JSON.stringify(await runRealtimeImageProofStage({
      stage: options.stage,
      env: process.env,
    })));
    return;
  }
  const selection = readSelection(options.selectionPath);
  const sourceState = {
    headSha: run("git", ["rev-parse", "HEAD"]),
    clean: run("git", ["status", "--porcelain"]) === "",
  };
  const commandEnvironment = {
    ...process.env,
    ...composeImageEnvironment(selection, "candidate"),
    REALTIME_PROOF_NODE_PORT: String(options.nodePort),
    REALTIME_PROOF_SECONDARY_NODE_PORT: String(options.secondaryNodePort),
  };
  const [file, ...args] = realtimeImageCommandPlan({ projectName: options.projectName })[0];
  const rendered = JSON.parse(run(file, args, commandEnvironment));
  const preflight = createRealtimeProofPreflight({
    sourceState,
    selection,
    rendered,
    nodePort: options.nodePort,
    secondaryNodePort: options.secondaryNodePort,
  });
  console.log(JSON.stringify({
    status: "passed",
    command: options.command,
    sourceSha: preflight.sourceSha,
    projectName: options.projectName,
    environment: { class: "staging-isolated", provider: options.provider },
    actorClass: options.actorClass,
    renderedSha256: preflight.renderedSha256,
    topology: preflight.topology,
    storageConfiguration: preflight.storageConfiguration,
  }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`ERROR: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
