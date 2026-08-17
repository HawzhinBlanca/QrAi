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

test("prometheus.yml carries no token value at all, only a secret-file reference", () => {
  // This used to assert the opposite shape: that a `REPLACE_WITH_METRICS_TOKEN` placeholder was
  // still present and still obviously fake, because the file was SUPPOSED to contain a token-shaped
  // string and a reviewer skimming a real one would not notice.
  //
  // ADR-0044 removed the hazard instead of policing it: the token is now read from a Compose secret
  // file at scrape time and is never substituted into this tracked configuration, so there is no
  // token-shaped string here for anyone to overwrite. That is strictly stronger than a placeholder
  // a human has to keep looking obvious, so this asserts the new invariant rather than the old one.
  const raw = readFileSync(join(root, "monitoring/prometheus.yml"), "utf8");

  const jobs = raw.match(/^\s*- job_name:/gm) ?? [];
  const secretRefs = raw.match(/^\s*- "\/run\/secrets\/metrics_token"$/gm) ?? [];
  assert.ok(jobs.length > 0, "no scrape jobs in prometheus.yml");
  assert.equal(
    secretRefs.length,
    jobs.length,
    `${jobs.length} scrape jobs but ${secretRefs.length} secret-file references — a job whose ` +
      "token does not come from /run/secrets/metrics_token is either unauthenticated or inlined",
  );

  // The two ways a value could come back: the old placeholder, or Prometheus's inline `values:`
  // form for http_headers. Neither may appear.
  assert.doesNotMatch(
    raw,
    /REPLACE_WITH_METRICS_TOKEN/,
    "the placeholder is back — the token must come from the secret file, not this file",
  );
  assert.doesNotMatch(
    raw,
    /x-metrics-token:\s*\n\s*values:/,
    "a scrape job inlines its metrics token instead of reading the Compose secret file",
  );
});
