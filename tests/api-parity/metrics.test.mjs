import assert from "node:assert/strict";
import test, { after } from "node:test";

import { request, startApi } from "./lib/harness.mjs";

/**
 * PAR3 — config group: /metrics access control. Two servers, because "closed" and "token-gated"
 * are different startup configurations (lib.rs:83-88).
 * specs/api-parity-suite/plan.md §4
 *
 * ── A real asymmetry in the code, relied on here and recorded as a finding ──────────────────────
 * `metrics_dev_open` is `ALLOW_INSECURE_DEFAULTS == "1"` (lib.rs:86), but main.rs's production boot
 * checks — strong secrets, and a refusal to run as a superuser DB role — treat `"1" OR "true"` as
 * dev (main.rs:26-28, :197-199).
 *
 * So `ALLOW_INSECURE_DEFAULTS=true` skips the boot checks while leaving metrics CLOSED. That is the
 * only combination that runs in both environments: CI's DATABASE_URL is a superuser, so a server
 * started with the boot checks ON would panic there before serving a request.
 *
 * The asymmetry fails in the SAFE direction (metrics closed, not open), so it is an inconsistency
 * rather than a vulnerability — but an operator setting `=true` expecting dev mode gets a closed
 * /metrics with no signal. Recorded, not silently depended on: if someone makes metrics_dev_open
 * accept "true", THESE TESTS GO RED rather than quietly becoming vacuous.
 */

const servers = [];
after(async () => {
  for (const s of servers) await s.stop();
});
const start = async (env) => {
  const api = await startApi({ env: { ALLOW_INSECURE_DEFAULTS: "true", ...env } });
  servers.push(api);
  return api;
};

// integration.rs:3416 — metrics_endpoint_is_closed_by_default_without_dev_flag_or_token
test("/metrics is CLOSED when neither a token nor dev mode is set", async () => {
  const api = await start({});
  const res = await request(api.baseUrl, "/metrics", { tenant: null });
  assert.equal(res.status, 404, "metrics must fail-closed with no token and no dev flag");

  // The 404 is a deliberate existence-hiding choice, not a routing accident: /health on the same
  // server answers 200, so the process is serving.
  const health = await request(api.baseUrl, "/health", { tenant: null });
  assert.equal(health.status, 200);
});

// integration.rs:3370 — metrics_endpoint_requires_a_token_when_one_is_configured
test("/metrics with a token configured: no token and wrong token both 404, correct token 200", async () => {
  const api = await start({ METRICS_TOKEN: "scrape-secret" });

  const noToken = await request(api.baseUrl, "/metrics", { tenant: null });
  assert.equal(noToken.status, 404, "no token -> 404, hiding existence");

  const wrong = await request(api.baseUrl, "/metrics", {
    tenant: null,
    headers: { "x-metrics-token": "nope" },
  });
  assert.equal(wrong.status, 404, "wrong token -> 404");

  const ok = await request(api.baseUrl, "/metrics", {
    tenant: null,
    headers: { "x-metrics-token": "scrape-secret" },
  });
  assert.equal(ok.status, 200);
  assert.match(
    ok.headers.get("content-type") ?? "",
    /^text\/plain/,
    "Prometheus scrape requires text/plain",
  );
  // Prove it is really the metrics body and not an empty 200 — the correct-token case is the one
  // that would otherwise pass while returning nothing.
  assert.match(ok.body, /http_request_duration_ms_bucket/);
});
