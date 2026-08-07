import assert from "node:assert/strict";
import test from "node:test";

import { createApplication } from "../../server/src/app.mjs";
import { ROUTES, ROUTE_KEYS, fastifyPath } from "../../server/src/routes/index.mjs";

test("no-upstream mode registers the complete executable registry locally", async (t) => {
  const app = createApplication({ logger: false });
  t.after(() => app.close());
  await app.ready();

  assert.equal(app.apiMode, "standalone");
  const enabledByDefault = ROUTES.filter((route) => route.ownerGate === undefined);
  assert.deepEqual(app.localRouteKeys, enabledByDefault.map((route) => route.key));
  for (const route of ROUTES) {
    assert.equal(
      app.hasRoute({ method: route.method.toUpperCase(), url: fastifyPath(route.path) }),
      route.ownerGate === undefined,
      `${route.key} owner-gate registration disagrees with the default`,
    );
  }

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.body, "ok");
});

test("standalone unknown routes and no-database cookie auth never fetch an upstream", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("standalone attempted a network delegation");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const app = createApplication({ logger: false });
  t.after(() => app.close());
  await app.ready();

  const missing = await app.inject({ method: "GET", url: "/v1/not-a-contracted-route" });
  assert.equal(missing.statusCode, 404);

  const cookie = await app.inject({
    method: "GET",
    url: "/v1/learner/progress",
    headers: { cookie: "__Host-qrai-pilot=declared-test-token" },
  });
  assert.equal(cookie.statusCode, 401);
  assert.deepEqual(cookie.json(), { error: "missing or invalid authorization" });
  assert.equal(calls, 0, "standalone delegated to a Rust/upstream process");
});

test("a partial route selection cannot masquerade as standalone", () => {
  assert.throws(
    () => createApplication({ compatibilityRouteKeys: new Set(["GET /health"]) }),
    /compatibilityRouteKeys requires an upstream/,
  );
});
