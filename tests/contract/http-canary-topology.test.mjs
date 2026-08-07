import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { retainedCanaryRouteKeys } from "../../server/src/routes/canary.mjs";
import { ROUTES } from "../../server/src/routes/index.mjs";

const read = (path) => readFileSync(path, "utf8");
const manifest = JSON.parse(read("packages/contracts/route-manifest.json"));

test("the canary route set is derived from the contract and contains exactly 39 retained operations", () => {
  const expected = [
    ...manifest.baselineOperations
      .filter(({ target }) => target === "retain")
      .map(({ method, path }) => `${method} ${path}`),
    ...manifest.targetAdditions
      .filter(({ implementationStatus }) => implementationStatus === "implemented-node")
      .map(({ method, path }) => `${method} ${path}`),
  ].sort();
  const actual = retainedCanaryRouteKeys(manifest, ROUTES).sort();

  assert.equal(actual.length, 39);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
  for (const operation of manifest.baselineOperations.filter(({ target }) => target === "retire")) {
    assert.equal(actual.includes(`${operation.method} ${operation.path}`), false);
  }
  for (const route of ROUTES.filter(({ ownerGate }) => ownerGate !== undefined)) {
    assert.equal(actual.includes(route.key), false);
  }

  const missing = structuredClone(manifest);
  missing.baselineOperations = missing.baselineOperations.filter(
    ({ method, path }) => `${method} ${path}` !== actual[0],
  );
  assert.throws(() => retainedCanaryRouteKeys(missing, ROUTES), /exactly 39 operations/);

  const ownerGated = structuredClone(manifest);
  const selected = ownerGated.baselineOperations.find(({ target }) => target === "retain");
  selected.method = "POST";
  selected.path = "/v1/device-enrollments:exchange";
  assert.throws(() => retainedCanaryRouteKeys(ownerGated, ROUTES), /owner-gated/);
});

test("Node startup exposes one closed retained-canary mode and keeps explicit compatibility mode", () => {
  const main = read("server/src/main.mjs");
  assert.match(main, /loadRetainedCanaryRouteKeys/);
  assert.match(main, /NODE_API_ROUTE_MODE/);
  assert.match(main, /retained-canary/);
  assert.match(main, /NODE_API_PORTED/);

  const dockerfile = read("server/Dockerfile");
  assert.match(dockerfile, /packages\/contracts\/route-manifest\.json/);
});

test("web runtime templating allows only the named Rust or Node upstream", () => {
  const dockerfile = read("apps/web/Dockerfile");
  assert.match(dockerfile, /\/etc\/nginx\/templates\/default\.conf\.template/);
  assert.match(dockerfile, /validate-api-upstream\.sh/);

  const validator = read("apps/web/validate-api-upstream.sh");
  assert.match(validator, /platform-api:8080/);
  assert.match(validator, /node-api:8082/);
  assert.match(validator, /exit 1/);
  for (const value of ["platform-api:8080", "node-api:8082"]) {
    const result = spawnSync("sh", ["apps/web/validate-api-upstream.sh"], {
      env: { WEB_PLATFORM_API_UPSTREAM: value },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const value of ["", "localhost:8080", "node-api:8080", "http://node-api:8082"]) {
    const result = spawnSync("sh", ["apps/web/validate-api-upstream.sh"], {
      env: { WEB_PLATFORM_API_UPSTREAM: value },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `${JSON.stringify(value)} must fail closed`);
  }

  for (const config of [read("apps/web/nginx.conf"), read("apps/web/nginx-tls.conf")]) {
    assert.match(config, /proxy_pass http:\/\/\$\{WEB_PLATFORM_API_UPSTREAM\}/);
    assert.doesNotMatch(config, /proxy_pass http:\/\/(?:platform-api:8080|node-api:8082)/);
  }
});

test("base Compose is Rust-safe while the explicit overlay switches Web and gateway together", () => {
  const base = parseYaml(read("docker-compose.yml"));
  assert.equal(base.services.web.environment.WEB_PLATFORM_API_UPSTREAM, "platform-api:8080");
  assert.equal(base.services["realtime-gateway"].environment.PLATFORM_API_URL, "http://platform-api:8080");
  assert.match(base.services["node-api"].environment.NODE_API_PORTED, /GET \/health/);
  assert.equal(base.services["node-api"].environment.NODE_API_ROUTE_MODE, "explicit-compatibility");
  assert.equal(base.services["node-api"].environment.PLATFORM_API_UPSTREAM, "http://platform-api:8080");

  const canary = read("docker-compose.canary.yml");
  assert.match(canary, /WEB_PLATFORM_API_UPSTREAM:\s*"node-api:8082"/);
  assert.match(canary, /PLATFORM_API_URL:\s*"http:\/\/node-api:8082"/);
  assert.match(canary, /NODE_API_ROUTE_MODE:\s*"retained-canary"/);
  assert.match(canary, /NODE_API_PORTED:\s*""/);
  assert.match(canary, /platform-api:\s*\n\s*condition:\s*service_healthy/);
  const activeCanary = canary
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(activeCanary, /weight|percent|random|shadow|NODE_API_ROUTE_MODE:\s*"standalone"/i);
});

test("TLS and Docker CI consume the runtime template and canary surfaces", () => {
  const tls = read("docker-compose.tls.yml");
  assert.match(tls, /nginx-tls\.conf:\/etc\/nginx\/templates\/default\.conf\.template:ro/);

  const workflow = read(".github/workflows/docker-build.yml");
  assert.match(workflow, /apps\/web\/nginx/);
  assert.match(workflow, /docker-compose\*\.yml/);
});
