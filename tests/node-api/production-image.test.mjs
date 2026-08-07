import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { SERVICES } from "../../scripts/release-images.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const read = (path) => readFileSync(join(repo, path), "utf8");

const deployableServices = [
  "platform-api",
  "node-api",
  "realtime-gateway",
  "ml-inference",
  "asr-inference",
  "web",
];

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
  assert.match(dockerfile, /^CMD \["node", "server\/src\/main\.mjs"\]$/m);
  assert.match(
    dockerfile,
    /COPY --chown=node:node services\/ml-inference\/model-attribution\.mjs services\/ml-inference\/alignment\.js \.\/services\/ml-inference\//,
  );
  assert.match(
    dockerfile,
    /COPY --chown=node:node packages\/quran-data\/src\/data\/full-quran\/provenance-v2\.json \.\/packages\/quran-data\/src\/data\/full-quran\//,
  );
  assert.doesNotMatch(dockerfile, /apt-get|apk add|curl|wget/);
  assert.doesNotMatch(dockerfile, /services\/node-api/, "the production image must not copy the retired tree");
  assert.doesNotMatch(dockerfile, /COPY (?:tests\/|apps\/|packages\/\s|services\/platform-api)/);
});

test("Compose adds an internal shadow while Rust remains the only traffic target", () => {
  const compose = parseYaml(read("docker-compose.yml"));
  const nodeApi = compose.services?.["node-api"];

  assert.ok(nodeApi, "node-api service is required");
  assert.equal(nodeApi.build?.dockerfile, "server/Dockerfile");
  assert.deepEqual(nodeApi.expose, ["8082"]);
  assert.equal(nodeApi.ports, undefined, "the shadow must not publish a host port");
  assert.equal(nodeApi.environment?.NODE_API_BIND, "0.0.0.0:8082");
  assert.match(nodeApi.environment?.NODE_API_PORTED, /GET \/health/);
  assert.match(nodeApi.environment?.NODE_API_PORTED, /GET \/ready/);
  assert.equal(nodeApi.environment?.PLATFORM_API_UPSTREAM, "http://platform-api:8080");
  assert.equal(nodeApi.depends_on?.["platform-api"]?.condition, "service_healthy");
  assert.deepEqual(nodeApi.healthcheck?.test, ["CMD", "node", "server/src/container-healthcheck.mjs"]);

  assert.equal(compose.services.web.depends_on?.["platform-api"]?.condition, "service_healthy");
  assert.equal(compose.services.web.depends_on?.["node-api"], undefined);
  assert.equal(compose.services["realtime-gateway"].environment.PLATFORM_API_URL, "http://platform-api:8080");
});

test("release, rollback, SBOM, licence, and Docker workflows include node-api", () => {
  assert.deepEqual(SERVICES, deployableServices);

  for (const path of [
    "scripts/release-build-evidence.mjs",
    "scripts/release-manifest.mjs",
    "scripts/smoke-evidence.mjs",
  ]) {
    assert.match(read(path), /deployableServices[^\n]*"node-api"/, `${path} omits node-api`);
  }

  const dockerWorkflow = read(".github/workflows/docker-build.yml");
  assert.match(dockerWorkflow, /- "server\/\*\*"/);
  assert.match(dockerWorkflow, /for svc in platform-api node-api realtime-gateway/);
  assert.match(dockerWorkflow, /name: Clean Node production image smoke/);

  const releaseWorkflow = read(".github/workflows/release-image.yml");
  assert.match(releaseWorkflow, /APP_DATABASE_PASSWORD:/);

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
