/**
 * k6 load test for the QrAi platform critical paths.
 *
 * Targets:
 *   - platform-api /health (baseline latency)
 *   - platform-api /v1/quran/surahs (read path)
 *   - ml-inference /health (ML service latency)
 *   - ml-inference /v1/alignments:predict (the hot path: word alignment)
 *   - ml-inference /v1/tajweed-findings:predict (rule-based tajweed analysis)
 *
 * Usage:
 *   # Quick smoke (10s, 5 VUs):
 *   k6 run scripts/load-test.js
 *
 *   # Sustained load (60s, 20 VUs):
 *   k6 run --vus 20 --duration 60s scripts/load-test.js
 *
 *   # Target a deployed stack:
 *   PLATFORM_API=http://deployed-host:8080 ML_API=http://deployed-host:8090 k6 run scripts/load-test.js
 *
 * Thresholds:
 *   - /health p95 < 100ms
 *   - /v1/quran/surahs p95 < 500ms
 *   - /v1/alignments:predict p95 < 2000ms (Needleman-Wunsch alignment is CPU-bound)
 *   - /v1/tajweed-findings:predict p95 < 500ms (regex-based rule scan)
 *   - error rate < 1%
 *
 * KNOWN CONSTRAINT: ml-inference has a hardcoded, non-configurable per-IP rate limit of 100
 * requests/minute (services/ml-inference/server.mjs). Verified empirically: even this script's
 * default "quick smoke" config (5 VUs, 10s, hitting ml-inference 3x per ~100ms iteration) trips
 * it from a single source IP — which is exactly what happens in local/CI runs, since every VU
 * shares one loopback address. When k6's error-rate threshold fails and the JSON summary shows
 * a high error_rate but LOW latencies on every *_latency metric, that is this rate limiter
 * rejecting requests with 429s, NOT a real backend failure — check the summary's latency
 * numbers, not just the errors threshold, before concluding something is actually broken.
 */

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// Configurable endpoints (override with env vars for non-local deployments).
const PLATFORM_API = __ENV.PLATFORM_API || "http://127.0.0.1:8080";
const ML_API = __ENV.ML_API || "http://127.0.0.1:8090";
const ML_API_KEY = __ENV.ML_API_KEY || "smoke-ml-api-key";

// Custom metrics for per-endpoint tracking.
const healthLatency = new Trend("health_latency", true);
const surahsLatency = new Trend("surahs_latency", true);
const alignmentLatency = new Trend("alignment_latency", true);
const tajweedLatency = new Trend("tajweed_latency", true);
const errorRate = new Rate("errors");

export const options = {
  vus: 5,
  duration: "10s",
  thresholds: {
    health_latency: ["p(95)<100"],       // /health must be fast
    surahs_latency: ["p(95)<500"],       // read path is cached
    alignment_latency: ["p(95)<2000"],   // alignment DP is CPU-bound
    tajweed_latency: ["p(95)<500"],      // regex rule scan is cheap
    errors: ["rate<0.01"],               // < 1% error rate
    http_req_duration: ["p(95)<2000"],   // overall p95
  },
};

// Minimal valid request bodies (Al-Fatihah 1:1 = 4 words, perfect recitation).
const QURAN_REF = { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" };

const ALIGNMENT_BODY = JSON.stringify({
  tenantId: "loadtest-tenant",
  sessionId: "loadtest-session",
  quranRef: QURAN_REF,
  recognizedText: ["بِسْمِ", "ٱللَّهِ", "ٱلرَّحْمَٰنِ", "ٱلرَّحِيمِ"],
  sourceChecksum: "fnv1a32:loadtest",
  consent: { externalAsrProcessing: false, guardianApproved: false },
});

const TAJWEED_BODY = JSON.stringify({
  tenantId: "loadtest-tenant",
  sessionId: "loadtest-session",
  quranRef: QURAN_REF,
  sourceChecksum: "fnv1a32:loadtest",
});

const ML_HEADERS = {
  "content-type": "application/json",
  "x-ml-api-key": ML_API_KEY,
};

export default function () {
  // 1. Platform API health
  group("platform-api /health", () => {
    const res = http.get(`${PLATFORM_API}/health`);
    healthLatency.add(res.timings.duration);
    const ok = check(res, {
      "status 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  // 2. Surah list (read path)
  group("platform-api /v1/quran/surahs", () => {
    const res = http.get(`${PLATFORM_API}/v1/quran/surahs`, {
      headers: {
        "x-tenant-id": "loadtest-tenant",
        "x-user-id": "loadtest-user",
        "x-user-role": "learner",
      },
    });
    surahsLatency.add(res.timings.duration);
    const ok = check(res, {
      "status 200": (r) => r.status === 200,
      "has surahs": (r) => {
        try { return JSON.parse(r.body).length >= 114; } catch { return false; }
      },
    });
    errorRate.add(!ok);
  });

  // 3. ML inference health
  group("ml-inference /health", () => {
    const res = http.get(`${ML_API}/health`);
    healthLatency.add(res.timings.duration);
    const ok = check(res, {
      "status 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  // 4. Word alignment (the hot path)
  group("ml-inference /v1/alignments:predict", () => {
    const res = http.post(`${ML_API}/v1/alignments:predict`, ALIGNMENT_BODY, {
      headers: ML_HEADERS,
    });
    alignmentLatency.add(res.timings.duration);
    const ok = check(res, {
      "status 200": (r) => r.status === 200,
      "has alignments": (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.alignments) && body.alignments.length > 0;
        } catch { return false; }
      },
    });
    errorRate.add(!ok);
  });

  // 5. Tajweed findings (rule-based, separate endpoint from alignment)
  group("ml-inference /v1/tajweed-findings:predict", () => {
    const res = http.post(`${ML_API}/v1/tajweed-findings:predict`, TAJWEED_BODY, {
      headers: ML_HEADERS,
    });
    tajweedLatency.add(res.timings.duration);
    const ok = check(res, {
      "status 200": (r) => r.status === 200,
      "has findings array": (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.findings);
        } catch { return false; }
      },
    });
    errorRate.add(!ok);
  });

  sleep(0.1); // small pause between iterations
}

export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    metrics: {
      health_p95_ms: data.metrics.health_latency?.values?.["p(95)"] ?? null,
      surahs_p95_ms: data.metrics.surahs_latency?.values?.["p(95)"] ?? null,
      alignment_p95_ms: data.metrics.alignment_latency?.values?.["p(95)"] ?? null,
      tajweed_p95_ms: data.metrics.tajweed_latency?.values?.["p(95)"] ?? null,
      error_rate: data.metrics.errors?.values?.rate ?? null,
      http_req_duration_p95_ms: data.metrics.http_req_duration?.values?.["p(95)"] ?? null,
      total_requests: data.metrics.http_reqs?.values?.count ?? null,
    },
    // Every check() call in this script's default function runs inside a group(...) block, so
    // k6 files them under data.root_group.groups[i].checks -- the top-level data.root_group.checks
    // array only holds checks made OUTSIDE any group, which this script has none of. Reading
    // root_group.checks here always sees an empty array, and Object.values([]).every(...) is
    // vacuously true regardless of real pass/fail -- confirmed empirically: a forced-failing check
    // inside a group still produced thresholds_passed: true. Also, this field is named
    // *thresholds*_passed but the old code recomputed it from *checks* -- two different k6
    // concepts. Read the actual configured thresholds (options.thresholds above) instead, via
    // each metric's own `.thresholds` object (`{ "<expression>": { ok: boolean } }`).
    thresholds_passed: Object.values(data.metrics)
      .flatMap((metric) => Object.values(metric.thresholds ?? {}))
      .every((threshold) => threshold.ok === true),
  };
  return {
    stdout: JSON.stringify(summary, null, 2) + "\n",
  };
}
