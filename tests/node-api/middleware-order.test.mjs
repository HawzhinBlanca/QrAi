import assert from "node:assert/strict";
import test from "node:test";

import { createApplication } from "../../server/src/app.mjs";

const ORIGIN = "https://app.example.test";

/** @param {import("node:test").TestContext} t */
async function application(t, config = {}) {
  const app = createApplication({
    logger: false,
    corsAllowedOrigins: ORIGIN,
    ...config,
  });
  t.after(() => app.close());
  await app.ready();
  return app;
}

const corsHeaders = {
  origin: ORIGIN,
};

test("CORS preflight is outermost and spends no maintenance or rate-limit capacity", async (t) => {
  const app = await application(t, {
    maintenanceMode: true,
    rateLimitOptions: { capacity: 1, refillIntervalMs: 60_000 },
  });

  for (let i = 0; i < 3; i += 1) {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/quran/surahs",
      headers: {
        ...corsHeaders,
        "access-control-request-method": "GET",
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], ORIGIN);
  }

  const admitted = await app.inject({ method: "GET", url: "/health", headers: corsHeaders });
  assert.equal(admitted.statusCode, 200, "preflight consumed the only admission token");

  const limited = await app.inject({ method: "GET", url: "/health", headers: corsHeaders });
  assert.equal(limited.statusCode, 429);
  // Plain text, not JSON: the 429 body is byte-identical to tower_governor's, because a nicer JSON
  // error in the port would be a divergence on every throttled request
  // (tests/api-parity/rate-limit-parity.test.mjs asserts the exact bytes). This case is about
  // ORDER, so it only needs to recognise the refusal.
  assert.match(limited.body, /^Too Many Requests! Wait for \d+s$/);
  assert.equal(limited.headers["access-control-allow-origin"], ORIGIN);
});

test("maintenance is inside CORS but before rate admission and authorization", async (t) => {
  const app = await application(t, {
    maintenanceMode: true,
    rateLimitOptions: { capacity: 1, refillIntervalMs: 60_000 },
  });

  for (let i = 0; i < 2; i += 1) {
    const blocked = await app.inject({
      method: "GET",
      url: "/v1/learner/progress",
      headers: corsHeaders,
    });
    assert.equal(blocked.statusCode, 503, "maintenance did not short-circuit before auth/rate");
    assert.deepEqual(blocked.json(), { error: "service is in maintenance" });
    assert.equal(blocked.headers["access-control-allow-origin"], ORIGIN);
  }

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200, "maintenance must exempt liveness");
});

test("rate admission precedes authorization", async (t) => {
  const app = await application(t, {
    rateLimitOptions: { capacity: 1, refillIntervalMs: 60_000 },
  });

  const unauthorized = await app.inject({ method: "GET", url: "/v1/learner/progress" });
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(unauthorized.json(), { error: "missing or invalid authorization" });

  const limited = await app.inject({ method: "GET", url: "/v1/learner/progress" });
  assert.equal(limited.statusCode, 429, "authorization ran before exhausted admission control");
  assert.match(limited.body, /^Too Many Requests! Wait for \d+s$/);
});

test("metrics observe a maintenance response while the three operational probes stay exempt", async (t) => {
  const app = await application(t, {
    maintenanceMode: true,
    rateLimitEnabled: false,
    metricsDevOpen: true,
  });

  const blocked = await app.inject({ method: "GET", url: "/v1/quran/surahs" });
  assert.equal(blocked.statusCode, 503);

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);

  const ready = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(ready.statusCode, 503, "readiness must run normally and report its real DB state");
  assert.equal(ready.body, "not ready");

  const metrics = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(metrics.statusCode, 200);
  assert.match(
    metrics.body,
    /http_requests_total\{method="GET",path="\/v1\/quran\/surahs",status="503"\} 1/,
  );
});
