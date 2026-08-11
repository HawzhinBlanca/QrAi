import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { request, startApi } from "./lib/harness.mjs";

/**
 * MAINTENANCE_MODE=1 — the documented kill switch — must behave identically whichever service
 * answers.
 *
 * `docs/readiness/INVENTORIES.md` lists it as the pilot's kill switch and P5.5 rests on it: "every
 * route except /health, /ready, /metrics returns a clean 503", so orchestrators and monitoring read
 * the process as up-in-maintenance rather than crashed.
 *
 * platform-api has implemented it since lib.rs:427. The Node port had NOTHING, and no test compared
 * them. Measured with every portable route enabled:
 *
 *     Rust        /health 200   /v1/quran/surahs 503   /v1/recitation-sessions 503
 *     Node port   /health 200   /v1/quran/surahs 200   /v1/recitation-sessions 200
 *
 * At cutover that is 37 of 42 routes still serving live traffic while `/health` reports
 * up-in-maintenance. An operator taking the pilot down mid-incident would read "up, in maintenance"
 * and be wrong about the only thing they needed to be right about. A switch that reports success
 * and stops nothing is worse than no switch.
 *
 * ── Absolute assertions, not an A/B ────────────────────────────────────────────────────────────
 * This file deliberately does NOT use `assertAB`. Under PARITY_THROUGH_SHELL=1 `startApi().baseUrl`
 * IS the shell, so the natural-looking A/B would put Node on both sides and pass by construction —
 * the trap `SHELL_URLS` exists to catch (harness.mjs:425). Asserting the CONTRACT instead means the
 * same expectations run against Rust in one pass and the port in the other, which is what "the two
 * agree" actually requires.
 */

let api;

before(async () => {
  api = await startApi({ env: { MAINTENANCE_MODE: "1" } });
});
after(async () => {
  await api?.stop();
});

test("liveness, readiness and metrics stay reachable in maintenance", async () => {
  // The whole point of the exemption: an orchestrator must be able to tell "up, in maintenance"
  // from "crashed". If /health 503'd too, the container would be restarted in a loop.
  const health = await request(api.baseUrl, "/health");
  assert.equal(health.status, 200, "liveness must stay up, or the orchestrator kills the pod");

  const ready = await request(api.baseUrl, "/ready");
  assert.notEqual(ready.status, 503, "readiness must answer on its own terms, not the kill switch's");

  // /metrics is fail-closed on its token, so 404 is its correct unauthorized answer here. What
  // matters is that the kill switch did not swallow it — monitoring has to keep scraping.
  const metrics = await request(api.baseUrl, "/metrics");
  assert.notEqual(metrics.status, 503, "monitoring must keep scraping while the pilot is down");
});

for (const [label, path, role] of [
  ["an unauthenticated read", "/v1/quran/surahs", undefined],
  ["a learner read", "/v1/quran/surahs", "learner"],
  ["a staff list", "/v1/recitation-sessions", "admin"],
  ["a route nobody has ported", "/v1/teacher-review-queue", "admin"],
]) {
  test(`${label} is refused with a clean 503`, async () => {
    const res = await request(api.baseUrl, path, { role });
    assert.equal(res.status, 503, `${path} kept serving while the pilot was supposed to be down`);
    // Byte-identical to axum's `Json(json!({ "error": "service is in maintenance" }))`. The differ
    // compares bodies, and an "improved" message in the port is a divergence like any other.
    assert.deepEqual(res.body, { error: "service is in maintenance" });
  });
}

test("the switch reaches routes that are PROXIED, not only ported ones", async () => {
  // Under PARITY_THROUGH_SHELL the shell forwards unported routes to Rust. Both are in maintenance,
  // so this passes either way — but if the guard were registered after the catch-all, or only on
  // registered routes, a proxied route would slip through in the pass where it is NOT ported.
  const res = await request(api.baseUrl, "/v1/scholar-approvals", { role: "admin" });
  assert.equal(res.status, 503);
});

test("an unknown path is also refused, not 404'd", async () => {
  // The guard must short-circuit BEFORE routing. A 404 here would mean the kill switch runs after
  // route matching, and the shape of the response would then leak which paths exist while the
  // service is supposed to be answering nothing.
  const res = await request(api.baseUrl, "/v1/not-a-real-route", { role: "admin" });
  assert.equal(res.status, 503);
});
