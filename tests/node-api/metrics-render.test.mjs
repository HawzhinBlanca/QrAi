/**
 * N8 — the Prometheus renderer, pinned to the Rust unit tests it is a port of.
 * services/platform-api/src/metrics.rs:101-129
 *
 * The A/B compares metric NAMES and bucket bounds but deliberately not counter VALUES (the two
 * processes have served different requests). So the arithmetic — which request lands in which
 * bucket, what the sum is — has no cross-implementation oracle. These are the same assertions the
 * Rust suite makes, against the same inputs, so the two arithmetics are pinned to each other by
 * shared expectations rather than by hope.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LATENCY_BUCKETS_MS, createMetrics, escape, metricsAccessAllowed } from "../../server/src/lib/metrics.mjs";

test("records and renders prometheus exposition — metrics.rs records_and_renders", () => {
  const m = createMetrics();
  m.record("GET", "/health", 200, 3);
  m.record("GET", "/health", 200, 12);
  m.record("POST", "/v1/auth/login", 401, 40);

  const out = m.render();
  assert.ok(out.includes('http_requests_total{method="GET",path="/health",status="200"} 2'));
  assert.ok(out.includes('http_requests_total{method="POST",path="/v1/auth/login",status="401"} 1'));
  // 3 requests total; the le="5" bucket holds only the 3ms one.
  assert.ok(out.includes('http_request_duration_ms_bucket{le="5"} 1'));
  assert.ok(out.includes('http_request_duration_ms_bucket{le="+Inf"} 3'));
  assert.ok(out.includes("http_request_duration_ms_count 3"));
  assert.ok(out.includes("http_request_duration_ms_sum 55"));
});

test("escapes label values — metrics.rs escapes_label_values", () => {
  assert.equal(escape('a"b\\c'), 'a\\"b\\\\c');
  assert.equal(escape("a\nb"), "a b", "a newline would terminate the exposition line");
});

test("a label value containing a quote cannot break out of the label", () => {
  const m = createMetrics();
  m.record("GET", '/x"} evil{a="', 200, 1);
  const line = m.render().split("\n").find((l) => l.startsWith("http_requests_total{"));
  assert.equal(line, 'http_requests_total{method="GET",path="/x\\"} evil{a=\\"",status="200"} 1');
});

test("the bucket bounds are the ones every existing histogram query depends on", () => {
  assert.deepEqual(LATENCY_BUCKETS_MS, [5, 10, 25, 50, 100, 250, 500, 1000]);
});

test("buckets are CUMULATIVE — a 1ms request is in every bucket", () => {
  const m = createMetrics();
  m.record("GET", "/health", 200, 1);
  const out = m.render();
  for (const b of LATENCY_BUCKETS_MS) {
    assert.ok(
      out.includes(`http_request_duration_ms_bucket{le="${b}"} 1`),
      `le="${b}" must count the 1ms request; non-cumulative buckets break every quantile query`,
    );
  }
});

test("a request slower than the largest bound is in +Inf only", () => {
  const m = createMetrics();
  m.record("GET", "/health", 200, 5000);
  const out = m.render();
  assert.ok(out.includes('http_request_duration_ms_bucket{le="1000"} 0'));
  assert.ok(out.includes('http_request_duration_ms_bucket{le="+Inf"} 1'));
});

// ── the access gate: lib.rs:440 metrics_access_allowed ─────────────────────────────────────────

test("with a token configured, only the exact token is allowed", () => {
  const ctx = { metricsToken: "scrape-secret", metricsDevOpen: false };
  assert.equal(metricsAccessAllowed(ctx, { "x-metrics-token": "scrape-secret" }), true);
  assert.equal(metricsAccessAllowed(ctx, { "x-metrics-token": "nope" }), false);
  assert.equal(metricsAccessAllowed(ctx, {}), false);
});

test("a configured token beats dev-open — dev mode does NOT bypass an explicit token", () => {
  const ctx = { metricsToken: "scrape-secret", metricsDevOpen: true };
  assert.equal(
    metricsAccessAllowed(ctx, {}),
    false,
    "an operator who sets METRICS_TOKEN has asked for a gate; dev mode must not silently remove it",
  );
});

test("with NO token configured it is closed unless dev mode is explicit", () => {
  assert.equal(metricsAccessAllowed({ metricsToken: null, metricsDevOpen: false }, {}), false);
  assert.equal(metricsAccessAllowed({ metricsToken: null, metricsDevOpen: true }, {}), true);
});

test("an EMPTY token string is treated as unset, not as a token equal to ''", () => {
  // docker-compose passes variables through as `"${FOO:-}"`. If "" counted as configured, the gate
  // would compare against the empty string and open for anyone sending no header at all.
  assert.equal(metricsAccessAllowed({ metricsToken: "", metricsDevOpen: false }, {}), false);
});

// --- the alert rules and the exposition must agree ---

test("every metric monitoring/alerts.yml alerts on is one the service actually exports", () => {
  // P5.5's engineering half is delivered — scrape config, alert rules, dashboard, kill-switch — and
  // nothing checks the single assumption all of it rests on: that the names in the rules are the
  // names the services emit. Rename `http_requests_total` and every alert keeps parsing, keeps
  // evaluating, and silently never fires again. A monitoring stack that has gone blind looks
  // exactly like one with nothing wrong.
  //
  // This cannot prove an alert reaches a human — that needs a deployed Prometheus and an on-call
  // rota, and it is why the P5.5 ledger row stays open. It proves the rules are still pointed at
  // reality, which is the part that rots silently between drills.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const alerts = readFileSync(join(repoRoot, "monitoring/alerts.yml"), "utf8");

  // Metric selectors in PromQL expressions: bare identifiers before `{`, `[`, whitespace or an
  // operator. Suffixes (_bucket/_count/_sum) are how a histogram is queried, so they resolve back
  // to the base metric the renderer declares in its # TYPE line.
  const referenced = new Set(
    (alerts.match(/\b[a-z_][a-z0-9_]*_(?:total|bucket|count|sum|seconds)\b/g) ?? []).map((m) =>
      m.replace(/_(bucket|count|sum)$/, ""),
    ),
  );
  assert.ok(referenced.size > 0, "no metric selectors found — the parser, not the rules, is broken");

  const rendered = createMetrics().render();
  const exported = new Set(
    (rendered.match(/^# TYPE ([a-z_][a-z0-9_]*)/gm) ?? []).map((l) => l.replace("# TYPE ", "")),
  );

  // This repository deliberately still scrapes the Rust realtime gateway as the public oracle
  // until W3.9/W7.6. Alerts with job="realtime-gateway" therefore resolve against its renderer,
  // not the Node HTTP renderer above. The Rust suite separately executes render_prometheus and
  // asserts these exact names; this guard joins that exporter vocabulary to the shared rules.
  const gatewaySource = readFileSync(
    join(repoRoot, "services/realtime-gateway/src/lib.rs"),
    "utf8",
  );
  for (const match of gatewaySource.matchAll(/"(realtime_gateway_[a-z0-9_]+)"/g)) {
    exported.add(match[1]);
  }

  const missing = [...referenced].filter((m) => !exported.has(m));
  assert.deepEqual(
    missing,
    [],
    `monitoring/alerts.yml alerts on metrics nothing exports, so those alerts can never fire:\n  ${missing.join("\n  ")}\n` +
      `exported: ${[...exported].join(", ")}`,
  );
});
