/**
 * k6 load test for the QrAi platform critical paths.
 *
 * Targets:
 *   - platform-api /health (baseline latency)
 *   - platform-api /v1/quran/surahs (read path)
 *   - ml-inference /health (ML service latency)
 *   - ml-inference /v1/alignment (the hot path: alignment + tajweed)
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
 *   - /v1/alignment p95 < 2000ms (alignment + tajweed is CPU-bound)
 *   - error rate < 1%
 */

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// Configurable endpoints (override with env vars for non-local deployments).
const PLATFORM_API = __ENV.PLATFORM_API || "http://127.0.0.1:8080";
const ML_API = __ENV.ML_API || "http://127.0.0.1:8090";
const ML_API_KEY = __ENV.ML_API_KEY || "dev-ml-api-key-not-for-production";

// Custom metrics for per-endpoint tracking.
const healthLatency = new Trend("health_latency", true);
const surahsLatency = new Trend("surahs_latency", true);
const alignmentLatency = new Trend("alignment_latency", true);
const errorRate = new Rate("errors");

export const options = {
  vus: 5,
  duration: "10s",
  thresholds: {
    health_latency: ["p(95)<100"],      // /health must be fast
    surahs_latency: ["p(95)<500"],      // read path is cached
    alignment_latency: ["p(95)<2000"],  // alignment DP + tajweed scan
    errors: ["rate<0.01"],              // < 1% error rate
    http_req_duration: ["p(95)<2000"],  // overall p95
  },
};

// Minimal valid alignment request (Al-Fatihah 1:1 = 4 words, perfect recitation).
const ALIGNMENT_BODY = JSON.stringify({
  tenantId: "loadtest-tenant",
  sessionId: "loadtest-session",
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
  recognizedText: ["بِسْمِ", "ٱللَّهِ", "ٱلرَّحْمَٰنِ", "ٱلرَّحِيمِ"],
  sourceChecksum: "fnv1a32:loadtest",
  consent: { externalAsrProcessing: false, guardianApproved: false },
});

const ML_HEADERS = {
  "Content-Type": "application/json",
  "X-ML-API-Key": ML_API_KEY,
  "X-Tenant-Id": "loadtest-tenant",
  "X-User-Id": "loadtest-user",
  "X-User-Role": "learner",
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
        "X-Tenant-Id": "loadtest-tenant",
        "X-User-Id": "loadtest-user",
        "X-User-Role": "learner",
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

  // 4. Alignment + tajweed (the hot path)
  group("ml-inference /v1/alignment", () => {
    const res = http.post(`${ML_API}/v1/alignment`, ALIGNMENT_BODY, {
      headers: ML_HEADERS,
    });
    alignmentLatency.add(res.timings.duration);
    const ok = check(res, {
      "status 200": (r) => r.status === 200,
      "has alignments": (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.alignments && body.alignments.length > 0;
        } catch { return false; }
      },
      "has tajweed": (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.tajweedFindings && body.tajweedFindings.length > 0;
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
      error_rate: data.metrics.errors?.values?.rate ?? null,
      http_req_duration_p95_ms: data.metrics.http_req_duration?.values?.["p(95)"] ?? null,
      total_requests: data.metrics.http_reqs?.values?.count ?? null,
    },
    thresholds_passed: Object.values(data.root_group?.checks ?? {}).every((c) => c.passes > 0 && c.fails === 0),
  };
  return {
    stdout: JSON.stringify(summary, null, 2) + "\n",
  };
}
