#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertReleaseDeploymentSelection,
  composeImageEnvironment,
  createReleaseDeploymentSelection,
  RELEASE_APPLICATION_SERVICES,
  verifyRunningReleaseApplicationImages,
  verifyRunningReleaseImages,
} from "./lib/release-deployment.mjs";
import { DEPLOYABLE_IMAGES } from "./lib/deployable-images.mjs";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || !["create", "env", "verify"].includes(command)) {
    fail("command must be create, env, or verify");
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      fail(`invalid argument near ${flag ?? "end of command"}`);
    }
    if (values[flag]) fail(`duplicate argument: ${flag}`);
    values[flag] = value;
  }
  return { command, values };
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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function createSelection(values) {
  const selection = createReleaseDeploymentSelection({
    candidateSha: required(values, "--candidate-sha"),
    candidateImageDigests: readJson(required(values, "--candidate-digests"), "candidate digests"),
    previousSha: required(values, "--previous-sha"),
    previousImageDigests: readJson(required(values, "--previous-digests"), "previous digests"),
    namespace: required(values, "--namespace"),
    createdAt: values["--created-at"] ?? new Date().toISOString(),
  });
  writeJson(required(values, "--output"), selection);
}

function loadSelection(values) {
  return assertReleaseDeploymentSelection(
    readJson(required(values, "--selection"), "release deployment selection"),
  );
}

function writeEnvironment(values) {
  const environment = composeImageEnvironment(loadSelection(values), required(values, "--slot"));
  const lines = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
  writeFileSync(required(values, "--output"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

function docker(args, environment = process.env) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function observeRunningImages(selection, slot, projectName, services) {
  const imageEnvironment = composeImageEnvironment(selection, slot);
  const environment = { ...process.env, ...imageEnvironment };
  const observations = {};
  const compose = [
    "compose",
    "--project-name",
    projectName,
    "--file",
    "docker-compose.yml",
    "--file",
    "docker-compose.release.yml",
  ];

  for (const service of services) {
    const containerIds = docker([...compose, "ps", "--all", "--quiet", service], environment)
      .split("\n")
      .filter(Boolean);
    if (containerIds.length !== 1) {
      fail(`${service} must resolve to exactly one release container`);
    }
    const [container] = JSON.parse(docker(["inspect", containerIds[0]], environment));
    const [image] = JSON.parse(docker(["image", "inspect", container.Config.Image], environment));
    observations[service] = {
      containerId: container.Id,
      configuredImage: container.Config.Image,
      imageId: container.Image,
      localImageId: image.Id,
      repoDigests: image.RepoDigests ?? [],
      running: container.State.Running,
      completed: container.State.Status === "exited",
      exitCode: container.State.ExitCode,
    };
  }
  return observations;
}

function verifySelection(values) {
  const selection = loadSelection(values);
  const slot = required(values, "--slot");
  const scope = values["--scope"] ?? "all";
  if (scope !== "all" && scope !== "application") {
    fail("--scope must be all or application");
  }
  const services = scope === "application"
    ? RELEASE_APPLICATION_SERVICES
    : DEPLOYABLE_IMAGES.flatMap(({ composeServices }) => composeServices);
  const observations = observeRunningImages(
    selection,
    slot,
    required(values, "--project-name"),
    services,
  );
  const images = scope === "application"
    ? verifyRunningReleaseApplicationImages({ selection, slot, observations })
    : verifyRunningReleaseImages({ selection, slot, observations });
  writeJson(required(values, "--evidence-output"), {
    schemaVersion: scope === "application"
      ? "qrai-running-application-image-evidence/v1"
      : "qrai-running-image-evidence/v1",
    sourceSha: selection[slot].sourceSha,
    slot,
    ...(scope === "application" ? { scope } : {}),
    observedAt: new Date().toISOString(),
    images,
  });
}

function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "create") createSelection(values);
  if (command === "env") writeEnvironment(values);
  if (command === "verify") verifySelection(values);
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
