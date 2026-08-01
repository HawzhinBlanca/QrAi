/**
 * Port of `services/platform-api/src/metrics.rs` — Prometheus text exposition v0.0.4.
 * specs/migration-completion/plan.md §2 (N8)
 *
 * ── One deliberate improvement over the Rust, and why it is safe ────────────────────────────────
 * Rust renders `http_requests_total` by iterating a `HashMap`, whose order is randomized per
 * process. A JS `Map` iterates in INSERTION order, so this renderer is deterministic. That is a
 * divergence, but only in line ORDER, which the Prometheus text format does not constrain — and the
 * A/B compares metric names and bucket bounds rather than bytes precisely because the Rust side
 * cannot be pinned. Deterministic output is strictly easier to diff by hand during a cutover.
 *
 * ── Cardinality ─────────────────────────────────────────────────────────────────────────────────
 * Bounded by the route table: the label is the MATCHED route pattern, never the raw URL, so
 * `/v1/…/{id}/…` collapses to one series regardless of the id. The label uses the AXUM spelling
 * (`{id}`), not Fastify's (`:id`), so a scrape of the Node shell and a scrape of Rust produce
 * comparable series names.
 */

/**
 * Cumulative "less-than-or-equal" latency buckets in milliseconds (a +Inf bucket is implied by the
 * total count). Transcribed from metrics.rs:15 — changing one silently breaks every existing
 * histogram query, so it is pinned by a test rather than left as a literal someone may "tidy".
 */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000];

/** Prometheus label values must escape backslash, double-quote, and newline. metrics.rs:95 */
export function escape(s) {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}

export function createMetrics() {
  /** key `${method}\u0000${path}\u0000${status}` → count. A Map keeps insertion order. */
  const requests = new Map();
  const latencyLe = new Array(LATENCY_BUCKETS_MS.length).fill(0);
  let latencySumMs = 0;
  let latencyCount = 0;

  function record(method, matchedPath, status, latencyMs) {
    const key = `${method}\u0000${matchedPath}\u0000${status}`;
    requests.set(key, (requests.get(key) ?? 0) + 1);
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
      if (latencyMs <= LATENCY_BUCKETS_MS[i]) latencyLe[i] += 1;
    }
    latencySumMs += latencyMs;
    latencyCount += 1;
  }

  function render() {
    let out = "";
    out += "# HELP http_requests_total Total HTTP requests handled.\n";
    out += "# TYPE http_requests_total counter\n";
    for (const [key, count] of requests) {
      const [method, path, status] = key.split("\u0000");
      out += `http_requests_total{method="${escape(method)}",path="${escape(path)}",status="${status}"} ${count}\n`;
    }

    out += "# HELP http_request_duration_ms Request latency in milliseconds.\n";
    out += "# TYPE http_request_duration_ms histogram\n";
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
      out += `http_request_duration_ms_bucket{le="${LATENCY_BUCKETS_MS[i]}"} ${latencyLe[i]}\n`;
    }
    out += `http_request_duration_ms_bucket{le="+Inf"} ${latencyCount}\n`;
    out += `http_request_duration_ms_sum ${latencySumMs}\n`;
    out += `http_request_duration_ms_count ${latencyCount}\n`;
    return out;
  }

  return { record, render };
}

/**
 * Is the caller allowed to scrape? Port of `metrics_access_allowed` (lib.rs:440).
 *
 * Fail-closed: with a token configured, only that exact token passes. With NO token configured it
 * opens only in explicit dev mode. Anything else 404s — hiding the endpoint's existence rather than
 * advertising it with a 401, because the audit flagged the gateway's /metrics as publicly exposed
 * and this service must not repeat it.
 */
export function metricsAccessAllowed({ metricsToken, metricsDevOpen }, headers) {
  if (metricsToken !== null && metricsToken !== undefined && metricsToken !== "") {
    return headers["x-metrics-token"] === metricsToken;
  }
  return metricsDevOpen === true;
}
