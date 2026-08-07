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
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createHttpCanaryImageEvidence,
  httpCanaryImageCommandPlan,
} from "./lib/http-canary-image.mjs";
import {
  runHttpCanaryAudioIndexProbe,
  runHttpCanaryHostileProbe,
  runHttpCanaryRouteProbe,
  loadHttpCanaryRouteKeys,
} from "./lib/http-canary-probe.mjs";
import {
  assertReleaseDeploymentSelection,
  composeImageEnvironment,
} from "./lib/release-deployment.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));

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

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} must be valid JSON: ${error.message}`);
  }
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

function run(file, args, { env = process.env } = {}) {
  return execFileSync(file, args, {
    cwd: repo,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function docker(args, env) {
  return run("docker", args, { env });
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
    "--file",
    "docker-compose.canary.yml",
  ];
}

function containerId(compose, service, env) {
  const ids = docker([...compose, "ps", "--all", "--quiet", service], env)
    .split("\n")
    .filter(Boolean);
  if (ids.length !== 1) fail(`${service} must resolve to exactly one canary container`);
  return ids[0];
}

function selectedContainerEnvironment(compose, service, keys, env) {
  const [container] = JSON.parse(docker(["inspect", containerId(compose, service, env)], env));
  const values = Object.fromEntries(
    (container.Config.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  return Object.fromEntries(keys.map((key) => [key, values[key] ?? null]));
}

function validateRenderedTopology(rendered, candidateEnvironment) {
  if (!rendered?.services || typeof rendered.services !== "object") {
    fail("rendered Compose topology has no services object");
  }
  const expectedImages = {
    migrations: candidateEnvironment.MIGRATION_RUNNER_IMAGE,
    "platform-api": candidateEnvironment.PLATFORM_API_IMAGE,
    "node-api": candidateEnvironment.NODE_BACKEND_IMAGE,
    "job-worker": candidateEnvironment.NODE_BACKEND_IMAGE,
    "realtime-gateway": candidateEnvironment.REALTIME_GATEWAY_IMAGE,
    "asr-inference": candidateEnvironment.ASR_INFERENCE_IMAGE,
    web: candidateEnvironment.WEB_IMAGE,
  };
  for (const [service, image] of Object.entries(expectedImages)) {
    const config = rendered.services[service];
    if (!config || config.image !== image) fail(`${service} does not select the candidate digest`);
    if (config.build != null) fail(`${service} still has a source build in release image mode`);
  }
  const topology = {
    webTarget: rendered.services.web.environment.WEB_PLATFORM_API_UPSTREAM,
    gatewayTarget: rendered.services["realtime-gateway"].environment.PLATFORM_API_URL,
    nodeRouteMode: rendered.services["node-api"].environment.NODE_API_ROUTE_MODE,
    rustUpstream: rendered.services["node-api"].environment.PLATFORM_API_UPSTREAM,
  };
  const expected = {
    webTarget: "node-api:8082",
    gatewayTarget: "http://node-api:8082",
    nodeRouteMode: "retained-canary",
    rustUpstream: "http://platform-api:8080",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (topology[key] !== value) fail(`rendered topology ${key} must be ${value}`);
  }
  return topology;
}

function validateRunningTopology(compose, env) {
  const web = selectedContainerEnvironment(
    compose,
    "web",
    ["WEB_PLATFORM_API_UPSTREAM"],
    env,
  );
  const gateway = selectedContainerEnvironment(
    compose,
    "realtime-gateway",
    ["PLATFORM_API_URL"],
    env,
  );
  const node = selectedContainerEnvironment(
    compose,
    "node-api",
    ["NODE_API_ROUTE_MODE", "PLATFORM_API_UPSTREAM"],
    env,
  );
  const observed = {
    webTarget: web.WEB_PLATFORM_API_UPSTREAM,
    gatewayTarget: gateway.PLATFORM_API_URL,
    nodeRouteMode: node.NODE_API_ROUTE_MODE,
    rustUpstream: node.PLATFORM_API_UPSTREAM,
  };
  const expected = {
    webTarget: "node-api:8082",
    gatewayTarget: "http://node-api:8082",
    nodeRouteMode: "retained-canary",
    rustUpstream: "http://platform-api:8080",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (observed[key] !== value) fail(`running topology ${key} must be ${value}`);
  }
  return observed;
}

async function waitForHealth(url, label, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The restored container has not become reachable yet.
    }
    await sleep(250);
  }
  fail(`${label} did not become healthy at ${url}`);
}

function writeOnce(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 800);
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const selection = assertReleaseDeploymentSelection(
    readJson(required(values, "--selection"), "release deployment selection"),
  );
  const projectName = required(values, "--project-name");
  const environmentClass = required(values, "--environment-class");
  const provider = required(values, "--provider");
  const actorClass = required(values, "--actor-class");
  const evidenceOutput = required(values, "--evidence-output");
  if (required(values, "--acknowledge-disposable-database") !== "yes") {
    fail("--acknowledge-disposable-database must be exactly yes");
  }
  const baseUrl = values["--base-url"] ?? "http://127.0.0.1:5173";
  const gatewayUrl = values["--gateway-url"] ?? "ws://127.0.0.1:8081";
  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET;
  const realtimeTicketSecret = process.env.REALTIME_GATEWAY_TICKET_SECRET;
  for (const [name, value] of Object.entries({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    REALTIME_GATEWAY_TICKET_SECRET: realtimeTicketSecret,
  })) {
    if (!value) fail(`${name} is required in the operator environment`);
  }
  // Parse and pin the approved command surface before any mutation. This also rejects an unsafe
  // project name through the shared contract used by the unit test.
  httpCanaryImageCommandPlan({ projectName });

  const startedAt = new Date().toISOString();
  let sourceState = { headSha: "unknown", clean: false };
  const stages = [];
  let platformStopped = false;
  let restorationError = null;
  let tempDirectory = null;
  const candidateEnvironment = composeImageEnvironment(selection, "candidate");
  const commandEnvironment = { ...process.env, ...candidateEnvironment };
  const compose = composePrefix(projectName);

  async function stage(name, commandLabel, operation) {
    const stageStartedAt = new Date().toISOString();
    const result = await operation();
    const stageCompletedAt = new Date().toISOString();
    stages.push({
      name,
      status: "passed",
      startedAt: stageStartedAt,
      completedAt: stageCompletedAt,
      commandSha256: sha256(commandLabel),
      outputSha256: sha256(canonicalJson(result)),
      ...(name === "rust-unavailable-routes" ? { details: result } : {}),
    });
    return result;
  }

  async function restorePlatformApi() {
    docker([...compose, "up", "-d", "--no-deps", "--pull", "never", "platform-api"], commandEnvironment);
    await waitForHealth("http://127.0.0.1:8080/health", "restored Rust platform API");
    platformStopped = false;
    return runHttpCanaryRouteProbe({ baseUrl, rustAvailable: true });
  }

  try {
    sourceState = {
      headSha: run("git", ["rev-parse", "HEAD"]),
      clean: run("git", ["status", "--porcelain"]) === "",
    };
    if (!sourceState.clean) fail("source tree must be clean before candidate image proof");
    if (sourceState.headSha !== selection.candidate.sourceSha) {
      fail("checked-out source SHA does not match the candidate selection");
    }

    const renderedText = docker([...compose, "config", "--format", "json"], commandEnvironment);
    const rendered = JSON.parse(renderedText);
    const topology = validateRenderedTopology(rendered, candidateEnvironment);
    validateRunningTopology(compose, commandEnvironment);

    tempDirectory = mkdtempSync(join(tmpdir(), "qrai-http-canary-image-"));
    const runningEvidencePath = join(tempDirectory, "running-images.json");
    const images = await stage(
      "candidate-running-images",
      "release-deployment verify candidate immutable images",
      async () => {
        run(process.execPath, [
          "scripts/release-deployment.mjs",
          "verify",
          "--selection",
          required(values, "--selection"),
          "--slot",
          "candidate",
          "--project-name",
          projectName,
          "--evidence-output",
          runningEvidencePath,
        ], { env: commandEnvironment });
        const evidence = readJson(runningEvidencePath, "running image evidence");
        if (evidence.sourceSha !== selection.candidate.sourceSha || evidence.slot !== "candidate") {
          fail("running image evidence does not bind the selected candidate");
        }
        return evidence.images;
      },
    );

    await stage(
      "retained-hostile-input",
      "probe exact retained and transition inventories plus hostile inputs through candidate Web",
      async () => ({
        routes: await runHttpCanaryRouteProbe({ baseUrl, rustAvailable: true }),
        hostile: await runHttpCanaryHostileProbe({ baseUrl, jwtSecret }),
      }),
    );

    await stage(
      "effect-privacy-tenant",
      "smoke-api through immutable candidate Web with JWT actors and disposable database",
      async () => ({
        smoke: run(process.execPath, ["scripts/smoke-api.mjs"], {
          env: {
            ...commandEnvironment,
            PLATFORM_API_SMOKE_URL: baseUrl,
            SMOKE_JWT_SECRET: jwtSecret,
            DATABASE_URL: databaseUrl,
          },
        }),
      }),
    );

    await stage(
      "audio-index",
      "durable Node audio index plus realtime gateway smoke against candidate images",
      async () => ({
        index: await runHttpCanaryAudioIndexProbe({ baseUrl, jwtSecret }),
        gateway: run(process.execPath, ["scripts/smoke-gateway.mjs"], {
          env: {
            ...commandEnvironment,
            REALTIME_GATEWAY_BASE_URL: gatewayUrl,
            REALTIME_GATEWAY_TICKET_SECRET: realtimeTicketSecret,
          },
        }),
      }),
    );

    await stage(
      "rust-unavailable-routes",
      "docker compose stop platform-api then probe exact retained and transition inventories",
      async () => {
        docker([...compose, "stop", "--timeout", "10", "platform-api"], commandEnvironment);
        platformStopped = true;
        const proof = await runHttpCanaryRouteProbe({ baseUrl, rustAvailable: false });
        return {
          rustRunning: false,
          retainedAttempted: proof.retainedAttempted,
          retainedFallbacks: proof.retainedFallbacks,
          transitionAttempted: proof.transitionAttempted,
          transitionDependencyFailures: proof.transitionDependencyFailures,
        };
      },
    );

    await stage(
      "rust-restored",
      "docker compose restore selected Rust platform-api and re-probe transition ownership",
      restorePlatformApi,
    );

    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(completedAt) + 24 * 60 * 60 * 1_000).toISOString();
    const evidence = createHttpCanaryImageEvidence({
      sourceState,
      selection,
      environment: { class: environmentClass, provider },
      actorClass,
      evidenceClass: "live-candidate",
      executionMode: "immutable-compose-images",
      startedAt,
      completedAt,
      expiresAt,
      topology: { renderedSha256: sha256(renderedText), ...topology },
      routeKeys: loadHttpCanaryRouteKeys(),
      images,
      stages,
      validatedAt: completedAt,
    });
    writeOnce(evidenceOutput, evidence);
    console.log(JSON.stringify({ status: "passed", evidenceOutput, sourceSha: evidence.sourceSha }));
  } catch (error) {
    if (platformStopped) {
      try {
        await restorePlatformApi();
      } catch (restoreError) {
        restorationError = safeError(restoreError);
      }
    }
    const failure = {
      schemaVersion: "qrai-http-canary-image-failure/v1",
      status: "failed",
      failedAt: new Date().toISOString(),
      sourceState,
      candidateSourceSha: selection.candidate.sourceSha,
      environment: { class: environmentClass, provider },
      actorClass,
      executionMode: "immutable-compose-images",
      error: safeError(error),
      restoration: restorationError === null ? "not-required-or-restored" : "failed",
      restorationError,
      completedStages: stages,
    };
    writeOnce(evidenceOutput, failure);
    throw error;
  } finally {
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`ERROR: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
