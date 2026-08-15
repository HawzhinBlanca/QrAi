import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

import { createApplication } from "../../server/src/app.mjs";
import { retainedCanaryRouteKeys } from "../../server/src/routes/canary.mjs";
import { ROUTES } from "../../server/src/routes/index.mjs";

const manifest = JSON.parse(readFileSync("packages/contracts/route-manifest.json", "utf8"));

async function rustOracle(t) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ oracle: "rust", method: req.method, path: req.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { requests, url: `http://127.0.0.1:${port}` };
}

test("the canary serves retained routes locally and forwards each transition request exactly once", async (t) => {
  const oracle = await rustOracle(t);
  const localRoutes = new Set(retainedCanaryRouteKeys(manifest, ROUTES));
  const app = createApplication({
    upstream: oracle.url,
    compatibilityRouteKeys: localRoutes,
    enforceRestrictedDbRole: false,
    rateLimitEnabled: false,
  });
  t.after(() => app.close());
  await app.ready();

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.body, "ok");
  assert.equal(oracle.requests.length, 0, "a retained route must never reach Rust");

  const agentTransition = await app.inject({
    method: "POST",
    url: "/v1/agent-runs",
    payload: { status: "queued" },
  });
  assert.equal(agentTransition.statusCode, 200);
  assert.equal(agentTransition.json().oracle, "rust");
  assert.deepEqual(oracle.requests, [{ method: "POST", path: "/v1/agent-runs" }]);

  const rustOnlyTransition = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "fixture@example.test", password: "fixture-only" },
  });
  assert.equal(rustOnlyTransition.json().oracle, "rust");
  assert.deepEqual(oracle.requests.at(-1), { method: "POST", path: "/v1/auth/login" });

  const beforeRetainedWrite = oracle.requests.length;
  const retainedWrite = await app.inject({
    method: "POST",
    url: "/v1/privacy/export",
    payload: { learnerId: "learner-fixture" },
  });
  assert.equal(retainedWrite.statusCode, 401);
  assert.equal(
    oracle.requests.length,
    beforeRetainedWrite,
    "a retained mutable request must execute on one backend only",
  );
});

test("retained-canary proof headers distinguish Node ownership from the Rust compatibility path", async (t) => {
  const oracle = await rustOracle(t);
  const localRoutes = new Set(retainedCanaryRouteKeys(manifest, ROUTES));
  const app = createApplication({
    upstream: oracle.url,
    compatibilityRouteKeys: localRoutes,
    canaryProofHeaders: true,
    enforceRestrictedDbRole: false,
    rateLimitEnabled: false,
  });
  t.after(() => app.close());
  await app.ready();

  const local = await app.inject({ method: "GET", url: "/health" });
  assert.equal(local.headers["x-qrai-route-owner"], "node-local");

  const transition = await app.inject({ method: "GET", url: "/v1/agent-runs" });
  assert.equal(transition.headers["x-qrai-route-owner"], "rust-compatibility");

  const ordinary = createApplication({
    upstream: oracle.url,
    compatibilityRouteKeys: localRoutes,
    enforceRestrictedDbRole: false,
    rateLimitEnabled: false,
  });
  t.after(() => ordinary.close());
  await ordinary.ready();
  const ordinaryLocal = await ordinary.inject({ method: "GET", url: "/health" });
  assert.equal(ordinaryLocal.headers["x-qrai-route-owner"], undefined);
});
