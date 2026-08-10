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
  probeRealtimeCandidateRunningImages,
  runRealtimeHostileCapacityStage,
  runRealtimeProtocolParityStage,
  runRealtimeRetentionStage,
} from "./lib/realtime-image-probe.mjs";
import {
  assertReleaseDeploymentSelection,
  composeImageEnvironment,
} from "./lib/release-deployment.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const providerPattern = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const proofIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const enabledProbeStages = new Set([
  "candidate-running-images",
  "protocol-parity",
  "hostile-capacity",
  "retention",
]);
const allowedFlags = new Set([
  "--selection",
  "--project-name",
  "--provider",
  "--actor-class",
  "--node-port",
  "--secondary-node-port",
  "--fault-node-port",
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
  const faultNodePort = parseRealtimeProofPort(values["--fault-node-port"]);
  if (new Set([nodePort, secondaryNodePort, faultNodePort]).size !== 3) {
    fail("proof ports must be distinct");
  }
  return {
    command,
    selectionPath: values["--selection"],
    projectName: values["--project-name"],
    provider: values["--provider"],
    actorClass: values["--actor-class"],
    nodePort,
    secondaryNodePort,
    faultNodePort,
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

function stageOrigin(env, name = "REALTIME_PROOF_ORIGIN") {
  const value = stageString(env, name, 2_048);
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

function candidateStageConfiguration(env) {
  try {
    const selectionPath = stageString(env, "REALTIME_PROOF_SELECTION_PATH");
    if (!isAbsolute(selectionPath)) {
      fail("realtime proof candidate selection path must be absolute");
    }
    const projectName = stageString(env, "REALTIME_PROOF_PROJECT_NAME", 128);
    realtimeImageCommandPlan({ projectName });
    const nodePort = parseRealtimeProofPort(
      stageString(env, "REALTIME_PROOF_NODE_PORT", 5),
    );
    const secondaryNodePort = parseRealtimeProofPort(
      stageString(env, "REALTIME_PROOF_SECONDARY_NODE_PORT", 5),
    );
    const faultNodePort = parseRealtimeProofPort(
      stageString(env, "REALTIME_PROOF_FAULT_NODE_PORT", 5),
    );
    if (new Set([nodePort, secondaryNodePort, faultNodePort]).size !== 3) {
      fail("realtime proof candidate ports must be distinct");
    }
    return Object.freeze({
      selectionPath,
      projectName,
      nodePort,
      secondaryNodePort,
      faultNodePort,
    });
  } catch {
    throw new TypeError(
      "realtime proof stage candidate-running-images configuration is invalid",
    );
  }
}

function protocolStageConfiguration(env) {
  try {
    const base = retentionStageConfiguration(env);
    const secondaryNodePort = parseRealtimeProofPort(
      stageString(env, "REALTIME_PROOF_SECONDARY_NODE_PORT", 5),
    );
    if (secondaryNodePort === base.nodePort) {
      fail("realtime proof stage protocol ports must be distinct");
    }
    const disallowedOrigin = stageOrigin(env, "REALTIME_PROOF_DISALLOWED_ORIGIN");
    if (disallowedOrigin === base.origin) {
      fail("realtime proof stage protocol origins must be distinct");
    }
    return Object.freeze({ ...base, secondaryNodePort, disallowedOrigin });
  } catch {
    throw new TypeError("realtime proof stage protocol-parity configuration is invalid");
  }
}

function hostileCapacityStageConfiguration(env) {
  try {
    return Object.freeze({
      ...retentionStageConfiguration(env),
      metricsToken: stageString(env, "REALTIME_PROOF_METRICS_TOKEN"),
    });
  } catch {
    throw new TypeError("realtime proof stage hostile-capacity configuration is invalid");
  }
}

async function runAggregateStage(stage, configuration, runner) {
  if (typeof runner !== "function") {
    throw new TypeError(`realtime proof stage ${stage} adapter is invalid`);
  }
  try {
    return Object.freeze({
      status: "passed",
      stage,
      measurements: await runner(configuration),
    });
  } catch {
    throw new Error(`realtime proof stage ${stage} failed`);
  }
}

async function runCandidateStage(stage, configuration, runner) {
  if (typeof runner !== "function") {
    throw new TypeError(`realtime proof stage ${stage} adapter is invalid`);
  }
  try {
    const result = await runner(configuration);
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(["images", "measurements"])
    ) {
      throw new TypeError("candidate runtime result is invalid");
    }
    return Object.freeze({ status: "passed", stage, ...result });
  } catch {
    throw new Error(`realtime proof stage ${stage} failed`);
  }
}

export async function runRealtimeImageProofStage({
  stage,
  env = process.env,
  candidateStage,
  protocolStage = runRealtimeProtocolParityStage,
  hostileCapacityStage = runRealtimeHostileCapacityStage,
  retentionAdaptersFactory = createRealtimeRetentionProofAdaptersFromEnvironment,
  retentionStage = runRealtimeRetentionStage,
} = {}) {
  if (!enabledProbeStages.has(stage)) {
    throw new TypeError("realtime proof stage is not enabled");
  }
  if (stage === "candidate-running-images") {
    const configuration = candidateStageConfiguration(env);
    const runner = candidateStage ?? ((input) => collectRealtimeCandidateRunningImagesRuntime({
      selection: readSelection(input.selectionPath),
      projectName: input.projectName,
      nodePort: input.nodePort,
      secondaryNodePort: input.secondaryNodePort,
      faultNodePort: input.faultNodePort,
      env,
    }));
    return runCandidateStage(stage, configuration, runner);
  }
  if (stage === "protocol-parity") {
    return runAggregateStage(stage, protocolStageConfiguration(env), protocolStage);
  }
  if (stage === "hostile-capacity") {
    return runAggregateStage(
      stage,
      hostileCapacityStageConfiguration(env),
      hostileCapacityStage,
    );
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

export function collectRealtimeCandidateRunningImagesRuntime({
  selection,
  projectName,
  nodePort,
  secondaryNodePort,
  faultNodePort,
  env = process.env,
  commandRunner = run,
}) {
  const selected = assertReleaseDeploymentSelection(selection);
  realtimeImageCommandPlan({ projectName });
  if (typeof commandRunner !== "function") {
    throw new TypeError("realtime candidate runtime command adapter is invalid");
  }
  const commandEnvironment = {
    ...env,
    ...composeImageEnvironment(selected, "candidate"),
    REALTIME_PROOF_NODE_PORT: String(nodePort),
    REALTIME_PROOF_SECONDARY_NODE_PORT: String(secondaryNodePort),
    REALTIME_PROOF_FAULT_NODE_PORT: String(faultNodePort),
  };
  const sourceState = {
    headSha: commandRunner("git", ["rev-parse", "HEAD"], commandEnvironment).trim(),
    clean: commandRunner("git", ["status", "--porcelain"], commandEnvironment).trim() === "",
  };
  const [dockerFile, ...renderArguments] = realtimeImageCommandPlan({ projectName })[0];
  if (dockerFile !== "docker") {
    throw new TypeError("realtime candidate runtime Compose command is invalid");
  }
  const rendered = JSON.parse(commandRunner(
    dockerFile,
    renderArguments,
    commandEnvironment,
  ));
  const composeArguments = renderArguments.slice(0, -3);
  const services = ["node-api", "job-worker", "node-realtime", "realtime-gateway"];
  const observations = {};
  for (const service of services) {
    const containerIds = commandRunner(
      "docker",
      [...composeArguments, "ps", "--all", "--quiet", service],
      commandEnvironment,
    ).trim().split("\n").filter(Boolean);
    if (containerIds.length !== 1) {
      throw new TypeError(`${service} must resolve to exactly one proof container`);
    }
    const inspectedContainers = JSON.parse(commandRunner(
      "docker",
      ["inspect", containerIds[0]],
      commandEnvironment,
    ));
    if (!Array.isArray(inspectedContainers) || inspectedContainers.length !== 1) {
      throw new TypeError(`${service} proof container inspection is invalid`);
    }
    const container = inspectedContainers[0];
    const inspectedImages = JSON.parse(commandRunner(
      "docker",
      ["image", "inspect", container?.Config?.Image],
      commandEnvironment,
    ));
    if (!Array.isArray(inspectedImages) || inspectedImages.length !== 1) {
      throw new TypeError(`${service} proof image inspection is invalid`);
    }
    const effectiveUidValue = commandRunner(
      "docker",
      ["exec", container.Id, "id", "-u"],
      commandEnvironment,
    ).trim();
    if (!/^[0-9]+$/.test(effectiveUidValue)) {
      throw new TypeError(`${service} effective runtime UID is invalid`);
    }
    const image = inspectedImages[0];
    observations[service] = {
      containerId: container.Id,
      configuredImage: container.Config.Image,
      imageId: container.Image,
      localImageId: image.Id,
      repoDigests: image.RepoDigests ?? [],
      running: container.State?.Running,
      health: container.State?.Health?.Status,
      configuredUser: container.Config.User,
      effectiveUid: Number(effectiveUidValue),
    };
  }
  return probeRealtimeCandidateRunningImages({
    sourceState,
    selection: selected,
    rendered,
    nodePort,
    secondaryNodePort,
    faultNodePort,
    observations,
  });
}

function realtimeProofComposeArguments(projectName) {
  const [file, ...argumentsWithConfig] = realtimeImageCommandPlan({ projectName })[0];
  const expectedTail = [
    "--profile",
    "realtime-proof-fault",
    "config",
    "--format",
    "json",
  ];
  if (
    file !== "docker" ||
    JSON.stringify(argumentsWithConfig.slice(-expectedTail.length)) !== JSON.stringify(expectedTail)
  ) {
    throw new TypeError("realtime proof Compose command is invalid");
  }
  return argumentsWithConfig.slice(0, -expectedTail.length);
}

/** Bind the Postgres outage probe to one exact isolated Compose container. */
export function createRealtimePostgresFaultLifecycleRuntime({
  projectName,
  env = process.env,
  commandRunner = runBounded,
  delayImpl = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  healthAttempts = 40,
} = {}) {
  let containerId = null;
  try {
    const composeArguments = realtimeProofComposeArguments(projectName);
    if (
      !env ||
      typeof env !== "object" ||
      Array.isArray(env) ||
      typeof commandRunner !== "function" ||
      typeof delayImpl !== "function" ||
      !Number.isSafeInteger(healthAttempts) ||
      healthAttempts < 1 ||
      healthAttempts > 80
    ) {
      throw new TypeError("realtime Postgres lifecycle adapters are invalid");
    }

    const resolveContainer = () => {
      const ids = commandRunner(
        "docker",
        [...composeArguments, "ps", "--all", "--quiet", "postgres"],
        env,
      ).trim().split("\n").filter(Boolean);
      if (ids.length !== 1 || !/^[0-9a-f]{12,64}$/.test(ids[0])) {
        throw new TypeError("realtime Postgres container resolution failed");
      }
      if (containerId !== null && ids[0] !== containerId) {
        throw new TypeError("realtime Postgres container was replaced during the fault");
      }
      containerId = ids[0];
      return containerId;
    };

    const inspectContainer = () => {
      const inspected = JSON.parse(commandRunner("docker", ["inspect", containerId], env));
      if (
        !Array.isArray(inspected) ||
        inspected.length !== 1 ||
        inspected[0]?.Id !== containerId
      ) {
        throw new TypeError("realtime Postgres container inspection failed");
      }
      return inspected[0];
    };

    async function stopPostgres() {
      try {
        resolveContainer();
        const before = inspectContainer();
        if (before.State?.Running !== true || before.State?.Health?.Status !== "healthy") {
          throw new TypeError("realtime Postgres was not healthy before the fault");
        }
        commandRunner(
          "docker",
          [...composeArguments, "stop", "--timeout", "10", "postgres"],
          env,
        );
        const stopped = inspectContainer();
        if (stopped.State?.Running !== false) {
          throw new TypeError("realtime Postgres stop was not observed");
        }
        return Object.freeze({ stopped: true });
      } catch {
        throw new Error("realtime Postgres lifecycle failed");
      }
    }

    async function startPostgres() {
      try {
        commandRunner("docker", [...composeArguments, "start", "postgres"], env);
        resolveContainer();
        for (let attempt = 0; attempt < healthAttempts; attempt += 1) {
          const restarted = inspectContainer();
          if (
            restarted.State?.Running === true &&
            restarted.State?.Health?.Status === "healthy"
          ) {
            return Object.freeze({ healthy: true });
          }
          if (attempt === healthAttempts - 1) break;
          await delayImpl(250);
        }
        throw new TypeError("realtime Postgres did not become healthy");
      } catch {
        throw new Error("realtime Postgres lifecycle failed");
      }
    }

    return Object.freeze({ stopPostgres, startPostgres });
  } catch {
    throw new Error("realtime Postgres lifecycle failed");
  }
}

function nonRootContainerUser(value) {
  if (typeof value !== "string") return false;
  const user = value.split(":", 1)[0];
  return user !== "" && user !== "root" && user !== "0";
}

async function defaultS3FaultReadinessProbe({ port, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/ready`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    return { reachable: true, statusCode: response.status };
  } catch {
    return { reachable: false, statusCode: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Prove the opt-in same-image process fails closed against its fixed unreachable S3 endpoint. */
export async function probeRealtimeS3FaultProcessRuntime({
  selection,
  projectName,
  faultNodePort,
  env = process.env,
  commandRunner = run,
  readinessProbe = defaultS3FaultReadinessProbe,
  fetchImpl = globalThis.fetch,
  delayImpl = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  timeoutMs = 2_000,
} = {}) {
  const serviceName = "node-realtime-proof-s3-fault";
  let failure = null;
  let result = null;
  let composeArguments = null;
  let commandEnvironment = null;
  try {
    const selected = assertReleaseDeploymentSelection(selection);
    const selectedImages = composeImageEnvironment(selected, "candidate");
    const port = parseRealtimeProofPort(String(faultNodePort));
    if (
      typeof commandRunner !== "function" ||
      typeof readinessProbe !== "function" ||
      typeof fetchImpl !== "function" ||
      typeof delayImpl !== "function" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 5_000
    ) {
      throw new TypeError("realtime S3 fault process adapters are invalid");
    }
    composeArguments = realtimeProofComposeArguments(projectName);
    commandEnvironment = {
      ...env,
      ...selectedImages,
      REALTIME_PROOF_FAULT_NODE_PORT: String(port),
    };
    const withFaultProfile = [...composeArguments, "--profile", "realtime-proof-fault"];
    commandRunner(
      "docker",
      [
        ...withFaultProfile,
        "up",
        "-d",
        "--no-build",
        "--no-deps",
        serviceName,
      ],
      commandEnvironment,
    );
    const containerIds = commandRunner(
      "docker",
      [...withFaultProfile, "ps", "--all", "--quiet", serviceName],
      commandEnvironment,
    ).trim().split("\n").filter(Boolean);
    if (containerIds.length !== 1 || !/^[0-9a-f]{12,64}$/.test(containerIds[0])) {
      throw new TypeError("realtime S3 fault process container resolution failed");
    }
    const containerId = containerIds[0];
    let container = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const inspected = JSON.parse(commandRunner(
        "docker",
        ["inspect", containerId],
        commandEnvironment,
      ));
      if (!Array.isArray(inspected) || inspected.length !== 1) {
        throw new TypeError("realtime S3 fault process inspection failed");
      }
      container = inspected[0];
      if (container?.State?.Running === false) break;
      if (attempt === 39) throw new TypeError("realtime S3 fault process did not stop");
      await delayImpl(250);
    }
    const inspectedImages = JSON.parse(commandRunner(
      "docker",
      ["image", "inspect", container?.Config?.Image],
      commandEnvironment,
    ));
    if (!Array.isArray(inspectedImages) || inspectedImages.length !== 1) {
      throw new TypeError("realtime S3 fault image inspection failed");
    }
    const image = inspectedImages[0];
    if (
      container?.State?.Running !== false ||
      !Number.isSafeInteger(container?.State?.ExitCode) ||
      container.State.ExitCode === 0 ||
      container.State.Health?.Status === "healthy"
    ) {
      throw new TypeError("realtime S3 fault process did not fail closed");
    }
    if (
      container?.Config?.Image !== selectedImages.NODE_BACKEND_IMAGE ||
      typeof container?.Image !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(container.Image) ||
      image?.Id !== container.Image ||
      !Array.isArray(image?.RepoDigests) ||
      !image.RepoDigests.includes(selectedImages.NODE_BACKEND_IMAGE)
    ) {
      throw new TypeError("realtime S3 fault process image identity failed");
    }
    if (
      !nonRootContainerUser(container.Config.User) ||
      !nonRootContainerUser(image?.Config?.User) ||
      container.Config.User !== image.Config.User
    ) {
      throw new TypeError("realtime S3 fault process must preserve the image non-root user");
    }
    const readiness = await readinessProbe({ port, timeoutMs, fetchImpl });
    if (
      !readiness ||
      JSON.stringify(Object.keys(readiness).sort()) !==
        JSON.stringify(["reachable", "statusCode"]) ||
      readiness.reachable !== false ||
      readiness.statusCode !== null
    ) {
      throw new TypeError("realtime S3 fault process became reachable");
    }
    result = {
      sameCandidateImage: true,
      configuredNonRoot: true,
      unreachableEndpointUnready: true,
      removed: true,
    };
  } catch {
    failure = new Error("realtime S3 fault process probe failed");
  } finally {
    if (composeArguments !== null && commandEnvironment !== null) {
      const withFaultProfile = [
        ...composeArguments,
        "--profile",
        "realtime-proof-fault",
      ];
      try {
        commandRunner(
          "docker",
          [...withFaultProfile, "rm", "--stop", "--force", serviceName],
          commandEnvironment,
        );
        const remaining = commandRunner(
          "docker",
          [...withFaultProfile, "ps", "--all", "--quiet", serviceName],
          commandEnvironment,
        ).trim();
        if (remaining !== "") throw new TypeError("realtime S3 fault process cleanup failed");
      } catch {
        failure = new Error("realtime S3 fault process probe failed");
      }
    }
  }
  if (failure !== null || result === null) {
    throw failure ?? new Error("realtime S3 fault process probe failed");
  }
  return Object.freeze(result);
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

function runBounded(file, args, environment = process.env) {
  return execFileSync(file, args, {
    cwd: repo,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    killSignal: "SIGKILL",
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
    REALTIME_PROOF_FAULT_NODE_PORT: String(options.faultNodePort),
  };
  const [file, ...args] = realtimeImageCommandPlan({ projectName: options.projectName })[0];
  const rendered = JSON.parse(run(file, args, commandEnvironment));
  const preflight = createRealtimeProofPreflight({
    sourceState,
    selection,
    rendered,
    nodePort: options.nodePort,
    secondaryNodePort: options.secondaryNodePort,
    faultNodePort: options.faultNodePort,
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
