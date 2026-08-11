import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

/**
 * Every service Prometheus scrapes must be able to answer it.
 *
 * `/metrics` is fail-closed on an unset token — `metrics_access_allowed` reads
 * `None => state.metrics_dev_open`, and METRICS_DEV_OPEN is empty in the shipped compose. NO compose
 * file passed METRICS_TOKEN to any service, while monitoring/prometheus.yml sends `x-metrics-token`
 * and monitoring/README.md tells the operator to substitute the real value there. The two halves
 * could never match.
 *
 * Measured, in exactly the shipped posture (METRICS_TOKEN unset, METRICS_DEV_OPEN unset):
 * `GET /metrics` with a token returns **404**.
 *
 * What that costs is not "no metrics". A failed scrape sets `up` to 0, so `PlatformApiDown`
 * (alerts.yml:9, `up{job="platform-api"} == 0`) fires permanently from the moment monitoring is
 * deployed, while every other rule is blind because its series never arrive. One permanent false
 * alarm and no real ones is worse than no monitoring, because it teaches an operator to ignore the
 * channel — and P5.5 is exactly the row that says monitoring is "wired, not witnessed". This is one
 * concrete reason it never was.
 *
 * Derived from prometheus.yml rather than pinned to a service list: adding a scrape target without
 * the passthrough fails HERE, naming the service.
 *
 * Hermetic: two YAML files.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const prom = parse(readFileSync(join(root, "monitoring/prometheus.yml"), "utf8"));
const compose = parse(readFileSync(join(root, "docker-compose.yml"), "utf8"));

/** Scrape jobs that send the token header — i.e. that expect a gated /metrics. */
function gatedJobs() {
  return (prom.scrape_configs ?? []).filter((job) => {
    const headers = job.http_headers ?? {};
    return Object.keys(headers).some((h) => h.toLowerCase() === "x-metrics-token");
  });
}

/** The compose service a scrape target names, e.g. "platform-api:8080" -> "platform-api". */
function targetsOf(job) {
  return (job.static_configs ?? []).flatMap((sc) => sc.targets ?? []).map((t) => String(t).split(":")[0]);
}

test("the scrape config still gates on a token, so this check is measuring something", () => {
  // If the header were dropped, every assertion below would pass vacuously over an empty list.
  const jobs = gatedJobs();
  assert.ok(jobs.length > 0, "no scrape job sends x-metrics-token — /metrics is no longer gated?");
  assert.ok(
    jobs.flatMap(targetsOf).length > 0,
    "the gated jobs name no static targets, so nothing is being checked",
  );
});

test("every scraped service is passed METRICS_TOKEN by docker-compose", () => {
  const missing = [];
  for (const job of gatedJobs()) {
    for (const service of targetsOf(job)) {
      const env = compose.services?.[service]?.environment;
      if (env === undefined) {
        missing.push(`${service} (job ${job.job_name}) — no such service in docker-compose.yml`);
      } else if (!("METRICS_TOKEN" in env)) {
        missing.push(`${service} (job ${job.job_name}) — compose never passes METRICS_TOKEN`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Prometheus sends x-metrics-token to these, and they cannot have a token to match:\n  ` +
      `${missing.join("\n  ")}\n` +
      `The scrape returns 404, \`up\` goes 0, and PlatformApiDown fires forever.`,
  );
});

test("the placeholder in prometheus.yml is still obviously a placeholder", () => {
  // It is substituted at deploy (README step 1). If someone replaces it with a real-looking value
  // and commits, the token is in git — and a reviewer skimming would not notice, because the file
  // is SUPPOSED to contain a token-shaped string.
  const raw = readFileSync(join(root, "monitoring/prometheus.yml"), "utf8");
  assert.match(
    raw,
    /REPLACE_WITH_METRICS_TOKEN/,
    "the placeholder is gone — if a real token was committed, rotate it",
  );
});
