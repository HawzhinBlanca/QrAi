import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { DEPLOYABLE_IMAGES, DEPLOYABLE_IMAGE_KEYS } from "../../scripts/lib/deployable-images.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const read = (path) => readFileSync(join(repo, path), "utf8");

test("the Node image is digest-locked, multi-stage, production-only, and non-root", () => {
  const dockerfile = read("server/Dockerfile");

  assert.match(
    dockerfile,
    /ARG NODE_IMAGE=node:22\.13\.1-bookworm-slim@sha256:83fdfa2a4de32d7f8d79829ea259bd6a4821f8b2d123204ac467fbe3966450fc/,
  );
  assert.equal((dockerfile.match(/^FROM \$\{NODE_IMAGE\}/gm) ?? []).length, 2);
  assert.match(dockerfile, /npm install --global corepack@0\.34\.5/);
  assert.match(dockerfile, /pnpm --filter @quran-ai\/server deploy --legacy --prod \/out/);
  assert.match(dockerfile, /COPY --from=deploy --chown=node:node \/out\/node_modules \.\/node_modules/);
  assert.match(dockerfile, /ENV NODE_ENV=production/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK .*server\/src\/container-healthcheck\.mjs/m);
  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m);
  assert.match(dockerfile, /^CMD \["node", "server\/src\/main\.mjs"\]$/m);
  assert.doesNotMatch(dockerfile, /COPY .*services\/ml-inference\/(?:model-attribution|alignment)/);
  assert.match(
    dockerfile,
    /COPY --chown=node:node packages\/quran-data\/src\/data\/full-quran\/provenance-v2\.json \.\/packages\/quran-data\/src\/data\/full-quran\//,
  );
  assert.match(
    dockerfile,
    /COPY --chown=node:node services\/asr-inference\/acoustic-candidates\.json \.\/services\/asr-inference\/acoustic-candidates\.json/,
  );
  assert.match(
    dockerfile,
    /COPY --chown=node:node packages\/contracts\/route-manifest\.json \.\/packages\/contracts\/route-manifest\.json/,
  );
  assert.match(dockerfile, /^EXPOSE 8081 8082 8098$/m);
  assert.doesNotMatch(dockerfile, /apt-get|apk add|curl|wget/);
  assert.doesNotMatch(dockerfile, /services\/node-api/, "the production image must not copy the retired tree");
  assert.doesNotMatch(dockerfile, /COPY (?:tests\/|apps\/|packages\/\s|services\/platform-api)/);
});

test("the retired ML service source is absent and all three Node roles use one image", () => {
  for (const name of ["Dockerfile", "README.md", "server.mjs"]) {
    assert.equal(existsSync(join(repo, "services/ml-inference", name)), false, `${name} still deploys old ML`);
  }
  const compose = parseYaml(read("docker-compose.yml"));
  assert.equal(compose.services?.["node-api"]?.build?.dockerfile, "server/Dockerfile");
  assert.equal(compose.services?.["job-worker"]?.build?.dockerfile, "server/Dockerfile");
  assert.equal(compose.services?.["node-realtime"]?.build?.dockerfile, "server/Dockerfile");
  assert.equal(compose.services?.["ml-inference"], undefined);
});

test("Compose adds an internal shadow while Rust remains the only traffic target", () => {
  const compose = parseYaml(read("docker-compose.yml"));
  const nodeApi = compose.services?.["node-api"];

  assert.ok(nodeApi, "node-api service is required");
  assert.equal(nodeApi.build?.dockerfile, "server/Dockerfile");
  assert.equal(nodeApi.image, "qrai/node-backend:${NODE_BACKEND_IMAGE_TAG:-local}");
  assert.deepEqual(nodeApi.expose, ["8082"]);
  assert.equal(nodeApi.ports, undefined, "the shadow must not publish a host port");
  assert.equal(nodeApi.environment?.NODE_API_BIND, "0.0.0.0:8082");
  assert.equal(
    nodeApi.environment?.DEVICE_IDENTITY_ENABLED,
    "${DEVICE_IDENTITY_ENABLED:-0}",
    "controlled device identity must be explicitly owner-enabled and default off",
  );
  assert.equal(nodeApi.environment?.SHUTDOWN_GRACE_SECS, "${SHUTDOWN_GRACE_SECS:-8}");
  assert.equal(nodeApi.environment?.NODE_HEALTHCHECK_URL, "http://127.0.0.1:8082/ready");
  assert.equal(nodeApi.environment?.NODE_API_HEALTHCHECK_URL, undefined);
  assert.equal(nodeApi.environment?.AUDIO_STORAGE_DRIVER, "${AUDIO_STORAGE_DRIVER:-filesystem}");
  assert.equal(nodeApi.environment?.AUDIO_STORAGE_S3_BUCKET, "${AUDIO_STORAGE_S3_BUCKET:-}");
  assert.ok(nodeApi.volumes.includes("audio_storage:/data/audio-storage"));
  assert.equal(nodeApi.stop_grace_period, "${NODE_API_STOP_GRACE_PERIOD:-10s}");
  assert.match(nodeApi.environment?.NODE_API_PORTED, /GET \/health/);
  assert.match(nodeApi.environment?.NODE_API_PORTED, /GET \/ready/);
  assert.equal(nodeApi.environment?.NODE_API_ROUTE_MODE, "explicit-compatibility");
  assert.equal(nodeApi.environment?.PLATFORM_API_UPSTREAM, "http://platform-api:8080");
  assert.equal(nodeApi.depends_on?.["platform-api"]?.condition, "service_healthy");
  assert.deepEqual(nodeApi.healthcheck?.test, ["CMD", "node", "server/src/container-healthcheck.mjs"]);

  const worker = compose.services?.["job-worker"];
  assert.ok(worker, "same-package durable worker service is required");
  assert.equal(worker.build?.dockerfile, "server/Dockerfile");
  assert.equal(worker.image, nodeApi.image, "Node API and worker must execute one tagged image");
  assert.deepEqual(worker.command, ["node", "server/src/worker.mjs"]);
  assert.deepEqual(worker.expose, ["8098"]);
  assert.equal(worker.ports, undefined, "the worker must not publish a host port");
  assert.match(worker.environment?.DATABASE_URL, /quran_ai_app/);
  assert.equal(worker.environment?.JOB_WORKER_BIND, "0.0.0.0:8098");
  assert.equal(worker.environment?.NODE_HEALTHCHECK_URL, "http://127.0.0.1:8098/ready");
  assert.equal(worker.environment?.NODE_API_HEALTHCHECK_URL, undefined);
  assert.equal(worker.depends_on?.migrations?.condition, "service_completed_successfully");
  assert.equal(worker.depends_on?.["asr-inference"]?.condition, "service_healthy");
  assert.equal(worker.depends_on?.["ml-inference"], undefined);
  assert.equal(worker.environment?.ML_INFERENCE_URL, undefined);
  assert.equal(worker.environment?.ASR_SERVICE_URL, "http://asr-inference:8091");
  assert.ok(worker.volumes.includes("audio_storage:/data/audio-storage"));
  assert.equal(worker.stop_grace_period, "${JOB_WORKER_STOP_GRACE_PERIOD:-10s}");

  const realtime = compose.services?.["node-realtime"];
  assert.ok(realtime, "same-package realtime shadow is required");
  assert.equal(realtime.build?.dockerfile, "server/Dockerfile");
  assert.equal(realtime.image, nodeApi.image, "API, worker, and realtime must execute one tagged image");
  assert.deepEqual(realtime.command, ["node", "server/src/realtime/main.mjs"]);
  assert.deepEqual(realtime.expose, ["8081"]);
  assert.equal(realtime.ports, undefined, "the realtime shadow must not publish a host port");
  assert.match(realtime.environment?.DATABASE_URL, /quran_ai_app/);
  assert.equal(realtime.environment?.NODE_REALTIME_BIND, "0.0.0.0:8081");
  assert.equal(realtime.environment?.NODE_HEALTHCHECK_URL, "http://127.0.0.1:8081/ready");
  assert.equal(realtime.environment?.REALTIME_READINESS_TIMEOUT_MS, "${REALTIME_READINESS_TIMEOUT_MS:-2000}");
  assert.equal(realtime.environment?.ML_INFERENCE_URL, "http://job-worker:8098");
  assert.equal(realtime.environment?.ASR_SERVICE_URL, "http://asr-inference:8091");
  assert.equal(realtime.depends_on?.migrations?.condition, "service_completed_successfully");
  assert.equal(realtime.depends_on?.["job-worker"]?.condition, "service_healthy");
  assert.equal(realtime.depends_on?.["asr-inference"]?.condition, "service_healthy");
  assert.equal(realtime.depends_on?.["platform-api"], undefined);
  assert.ok(realtime.volumes.includes("audio_storage:/data/audio-storage"));
  assert.equal(realtime.stop_grace_period, "${NODE_REALTIME_STOP_GRACE_PERIOD:-10s}");
  assert.deepEqual(realtime.healthcheck?.test, ["CMD", "node", "server/src/container-healthcheck.mjs"]);

  assert.equal(compose.services.web.depends_on?.["platform-api"]?.condition, "service_healthy");
  assert.equal(compose.services.web.environment?.WEB_PLATFORM_API_UPSTREAM, "platform-api:8080");
  assert.equal(compose.services.web.depends_on?.["node-api"], undefined);
  assert.equal(compose.services.web.depends_on?.["node-realtime"], undefined);
  assert.equal(compose.services.web.depends_on?.["ml-inference"], undefined);
  assert.equal(compose.services["platform-api"].environment.ML_INFERENCE_URL, "http://job-worker:8098");
  assert.equal(nodeApi.environment.ML_INFERENCE_URL, "http://job-worker:8098");
  assert.equal(compose.services["realtime-gateway"].environment.ML_INFERENCE_URL, "http://job-worker:8098");
  assert.equal(compose.services["realtime-gateway"].environment.PLATFORM_API_URL, "http://platform-api:8080");
  assert.equal(compose.services["realtime-gateway"].depends_on?.["job-worker"]?.condition, "service_healthy");
});

test("release, rollback, SBOM, licence, and Docker workflows include the shared Node artifact", () => {
  assert.deepEqual(DEPLOYABLE_IMAGE_KEYS, [
    "platform-api",
    "node-backend",
    "migration-runner",
    "realtime-gateway",
    "asr-inference",
    "web",
  ]);
  assert.deepEqual(
    DEPLOYABLE_IMAGES.find(({ key }) => key === "node-backend")?.composeServices,
    ["node-api", "job-worker", "node-realtime"],
  );

  for (const path of [
    "scripts/release-build-evidence.mjs",
    "scripts/release-manifest.mjs",
    "scripts/smoke-evidence.mjs",
  ]) {
    assert.match(read(path), /deployable-images\.mjs/, `${path} bypasses the release image inventory`);
  }

  const dockerWorkflow = read(".github/workflows/docker-build.yml");
  assert.match(dockerWorkflow, /- "server\/\*\*"/);
  assert.match(dockerWorkflow, /for svc in platform-api node-api realtime-gateway/);
  assert.match(dockerWorkflow, /name: Clean Node production image smoke/);

  const releaseWorkflow = read(".github/workflows/release-image.yml");
  assert.match(releaseWorkflow, /packages:\s*write/);
  assert.match(releaseWorkflow, /registry:\s*ghcr\.io/);

  const ciWorkflow = read(".github/workflows/ci.yml");
  assert.match(ciWorkflow, /cdxgen@\^11 -o sbom\.cdx\.json \./);
  assert.match(read("scripts/verify.sh"), /guard: dependency licences.*check-licenses\.mjs/);
});

test("canonical verification invokes the production-image contract exactly once", () => {
  const target = "tests/node-api/production-image.test.mjs";
  const activeNodeTestLines = read("scripts/verify.sh")
    .split("\n")
    .filter((line) => line.includes("node ") && line.includes("--test "))
    .filter((line) => !line.trimStart().startsWith("#"));
  assert.equal(activeNodeTestLines.filter((line) => line.includes(target)).length, 1);
});

test("the native healthcheck accepts only an ok response and fails closed", async () => {
  const healthcheckPath = join(repo, "server", "src", "container-healthcheck.mjs");
  const { checkHealth } = await import(`${pathToFileURL(healthcheckPath).href}?test=${Date.now()}`);
  let cancelled = 0;
  let observedSignal;
  const ok = await checkHealth({
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      return { ok: true, body: { cancel: async () => { cancelled += 1; } } };
    },
    timeoutMs: 50,
    url: "http://127.0.0.1:8082/ready",
  });

  assert.equal(ok, true);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(cancelled, 1);
  assert.equal(await checkHealth({ fetchImpl: async () => ({ ok: false }), timeoutMs: 50 }), false);
  assert.equal(await checkHealth({ fetchImpl: async () => { throw new Error("offline"); }, timeoutMs: 50 }), false);
});
