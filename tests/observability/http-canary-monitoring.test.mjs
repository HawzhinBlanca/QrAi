import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

import {
  HTTP_CANARY_STOP_LIMITS,
  HTTP_CANARY_OBSERVATION_KEYS,
} from "../../scripts/lib/http-canary-controller.mjs";

const prometheus = YAML.parse(readFileSync("monitoring/prometheus.yml", "utf8"));
const alerts = YAML.parse(readFileSync("monitoring/alerts.yml", "utf8"));
const monitoringCompose = readFileSync("monitoring/docker-compose.monitoring.yml", "utf8");
const appCompose = readFileSync("docker-compose.yml", "utf8");
const dashboard = JSON.parse(readFileSync("monitoring/grafana-dashboard.json", "utf8"));

test("Prometheus scrapes all Node roles, Rust, and gateway with the private metrics token", () => {
  const jobs = Object.fromEntries(prometheus.scrape_configs.map((job) => [job.job_name, job]));
  assert.deepEqual(Object.keys(jobs).sort(), [
    "job-worker",
    "node-api",
    "node-realtime",
    "platform-api",
    "realtime-gateway",
  ]);
  const targets = Object.fromEntries(
    Object.entries(jobs).map(([name, job]) => [name, job.static_configs[0].targets]),
  );
  assert.deepEqual(targets, {
    "platform-api": ["platform-api:8080"],
    "node-api": ["node-api:8082"],
    "job-worker": ["job-worker:8098"],
    "node-realtime": ["node-realtime:8081"],
    "realtime-gateway": ["realtime-gateway:8081"],
  });
  for (const job of Object.values(jobs)) {
    assert.deepEqual(job.http_headers["x-metrics-token"].files, [
      "/run/secrets/metrics_token",
    ]);
  }
  assert.doesNotMatch(readFileSync("monitoring/prometheus.yml", "utf8"), /REPLACE_WITH|secrets:\s*\[/i);
  assert.match(monitoringCompose, /METRICS_TOKEN_FILE/);
  assert.match(monitoringCompose, /secrets:[\s\S]*source:\s*metrics_token[\s\S]*target:\s*metrics_token/);
  assert.match(appCompose, /platform-api:[\s\S]*METRICS_TOKEN:/);
  assert.match(appCompose, /realtime-gateway:[\s\S]*METRICS_TOKEN:/);
});

test("canary alerts cover readiness, errors, fallback, jobs, and lost audio without sensitive labels", () => {
  const rules = alerts.groups.flatMap((group) => group.rules);
  const names = new Set(rules.map(({ alert }) => alert));
  for (const required of [
    "NodeCanaryDown",
    "JobWorkerDown",
    "RustOracleDown",
    "NodeCanaryHighErrorRate",
    "NodeCanaryHighLatency",
    "NodeCanaryFallbackShare",
    "DurableJobBacklog",
    "DurableJobRetries",
    "DurableJobDeadLetter",
    "StoredAudioUnindexed",
    "NodeRealtimeShadowUnready",
  ]) {
    assert.ok(names.has(required), `${required} alert is missing`);
  }
  const source = readFileSync("monitoring/alerts.yml", "utf8");
  assert.match(source, /job_state\{[^}]*status="queued"[^}]*\}/);
  assert.match(source, /job_state\{[^}]*status="retry"[^}]*\}/);
  assert.match(source, /job_state\{[^}]*status="dead"[^}]*\}/);
  assert.match(source, /realtime_gateway_chunks_stored_unindexed_total/);
  assert.doesNotMatch(source, /tenant[_-]?id|learner[_-]?id|user[_-]?id|session[_-]?id|trace[_-]?id/i);
});

test("the automatic stop vocabulary includes every non-Prometheus trust invariant", () => {
  assert.deepEqual(HTTP_CANARY_OBSERVATION_KEYS, [
    "nodeReady",
    "workerReady",
    "rustReady",
    "httpErrorRate",
    "httpP95Ms",
    "fallbackShare",
    "jobQueued",
    "jobRetry",
    "jobDead",
    "privacyFailures",
    "tenantIsolationFailures",
    "lostChunks",
    "feedbackLeaks",
  ]);
  assert.deepEqual(HTTP_CANARY_STOP_LIMITS, {
    httpErrorRate: 0.01,
    httpP95Ms: 1000,
    fallbackShare: 0.05,
    jobQueued: 100,
    jobRetry: 10,
    jobDead: 0,
    privacyFailures: 0,
    tenantIsolationFailures: 0,
    lostChunks: 0,
    feedbackLeaks: 0,
  });
  assert.match(monitoringCompose, /node-api:[\s\S]*condition:\s*service_healthy/);
  assert.match(monitoringCompose, /job-worker:[\s\S]*condition:\s*service_healthy/);
  assert.match(monitoringCompose, /node-realtime:[\s\S]*condition:\s*service_healthy/);
  assert.match(monitoringCompose, /realtime-gateway:[\s\S]*condition:\s*service_healthy/);
});

test("the canary dashboard separates Node traffic and exposes worker and lost-audio stop signals", () => {
  const expressions = dashboard.panels
    .flatMap((panel) => panel.targets ?? [])
    .map(({ expr }) => expr)
    .join("\n");
  assert.match(expressions, /http_requests_total\{[^}]*job="node-api"[^}]*\}/);
  for (const status of ["queued", "retry", "dead"]) {
    assert.match(expressions, new RegExp(`job_state\\{[^}]*job="job-worker"[^}]*status="${status}"[^}]*\\}`));
  }
  assert.match(expressions, /realtime_gateway_chunks_stored_unindexed_total\{[^}]*job="realtime-gateway"[^}]*\}/);
  assert.doesNotMatch(expressions, /tenant[_-]?id|learner[_-]?id|user[_-]?id|session[_-]?id|trace[_-]?id/i);
});
