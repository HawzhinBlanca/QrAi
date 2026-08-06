/**
 * N8 — /health, /ready, /metrics: the Node shell against Rust.
 * specs/migration-completion/plan.md §2
 *
 * Run this file BOTH ways. Unported it proves the differ works; ported it proves the port does:
 *
 *   node --test tests/api-parity/infra-parity.test.mjs
 *   NODE_API_PORTED="GET /health,GET /ready,GET /metrics" node --test tests/api-parity/infra-parity.test.mjs
 *
 * ── The one response that CANNOT be compared byte-for-byte, and why ─────────────────────────────
 * Rust renders `http_requests_total` by iterating a `HashMap` (metrics.rs:59). Rust's HashMap
 * iteration order is deliberately non-deterministic — two runs of Rust itself emit those lines in
 * different orders. Asserting byte equality there would be a flaky test dressed as a strict one, and
 * the first person to hit it would "fix" it by loosening the whole comparison.
 *
 * So /metrics compares what is actually contract: the status, the content-type, the metric NAMES,
 * the histogram bucket bounds, and the exposition-format shape. The counter VALUES are deliberately
 * not compared — the two processes have served different requests, which is a fact about the
 * strangler, not a defect.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertAB } from "./lib/ab.mjs";
import { startApi, startShell } from "./lib/harness.mjs";

/**
 * The routes this file is ABOUT, served by the shell rather than proxied to Rust.
 *
 * Taken from the `NODE_API_PORTED=…` line in the header above, which every parity file carried and
 * none of them set. A file run directly therefore got a shell that proxied everything, so its
 * "shell" side WAS Rust and a Node-only defect could not fail it — the configuration a person
 * actually uses proved the least. Only verify.sh's second pass set the variable, so the same file
 * meant two different things depending on who ran it.
 *
 * `startShell` unions this with the ambient value, so verify.sh's exhaustive pass still serves every
 * PORTABLE route.
 */
const PORTED = "GET /health,GET /ready,GET /metrics";

let api;
let shell;
/**
 * The RUST url, which is not `rustUrl`.
 *
 * Under `PARITY_THROUGH_SHELL=1` — the configuration in which this file's A/B is the only thing that
 * proves anything about the port — `startApi` puts a Node shell in front of the binary and returns
 * the SHELL as `baseUrl`, exposing Rust as `upstreamUrl`. Wiring `startShell({ upstream:
 * rustUrl })` and differing against `rustUrl` therefore put Node on BOTH sides of every
 * `assertAB`: a shell in front of a shell, compared with that inner shell. Identical code cannot
 * disagree with itself, so the probes passed by construction.
 *
 * Measured before this was fixed: a `NODE_ONLY_FIELD` added to Node's `listSurahs` response — a
 * divergence a byte comparison cannot miss — left `assertAB` GREEN in both verify.sh passes. What
 * caught it was a literal key-list assertion beside the probe, which is not a comparison at all.
 */
let rustUrl;

before(async () => {
  api = await startApi({ env: { METRICS_TOKEN: "scrape-secret" } });
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl, env: { NODE_API_PORTED: PORTED, METRICS_TOKEN: "scrape-secret" } });
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

test("GET /health is identical", async () => {
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, { path: "/health", tenant: null });
  assert.equal(s.status, 200);
  assert.equal(s.text, "ok", "the body is the literal string ok, not JSON");
});

test("GET /ready is identical, and reports the DB it can actually reach", async () => {
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, { path: "/ready", tenant: null });
  assert.equal(s.status, 200, "both processes reach Postgres in this suite");
  assert.equal(s.text, "ready");
});

/**
 * Prometheus exposition, reduced to the parts that are contract. Values are excluded on purpose
 * (see the header): two processes that served different requests must not be asserted equal.
 */
function expositionShape(text) {
  const names = new Set();
  const buckets = new Set();
  for (const line of text.split("\n")) {
    if (line.startsWith("# TYPE ")) {
      const [, , name, type] = line.split(" ");
      names.add(`${name} ${type}`);
      continue;
    }
    const bucket = line.match(/^http_request_duration_ms_bucket\{le="([^"]+)"\}/);
    if (bucket) buckets.add(bucket[1]);
  }
  return { names: [...names].sort(), buckets: [...buckets].sort() };
}

test("GET /metrics with a correct token: same status, same content-type, same exposition shape", async () => {
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/metrics",
    tenant: null,
    headers: { "x-metrics-token": "scrape-secret" },
    compareBody(shellText, apiText, label) {
      assert.deepEqual(
        expositionShape(shellText),
        expositionShape(apiText),
        `${label}: metric names or histogram buckets differ`,
      );
    },
  });
  assert.equal(s.status, 200);
  assert.match(s.headers.get("content-type") ?? "", /^text\/plain/);
  // Not an empty 200: the correct-token case is the one that would otherwise pass while serving
  // nothing at all.
  assert.match(s.text, /http_request_duration_ms_bucket/);
});

test("GET /metrics fails closed identically: no token and wrong token are both 404", async () => {
  await assertAB(shell.baseUrl, rustUrl, { path: "/metrics", tenant: null });
  await assertAB(shell.baseUrl, rustUrl, {
    path: "/metrics",
    tenant: null,
    headers: { "x-metrics-token": "nope" },
  });
});

test("the 404 hides existence rather than reporting an outage — /health still answers 200", async () => {
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, { path: "/health", tenant: null });
  assert.equal(s.status, 200);
});
