import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";


const read = (relativePath) => readFileSync(
  new URL(`../../${relativePath}`, import.meta.url),
  "utf8",
);

const adrSection = (source, number) => {
  const match = new RegExp(
    `^## ADR-${number}[^\\n]*\\n([\\s\\S]*?)(?=^---$|^## ADR-|(?![\\s\\S]))`,
    "m",
  ).exec(source);
  assert.ok(match, `ADR-${number} is missing`);
  return match[0];
};


test("W2.1 accepts every Node backend boundary before the package is created", () => {
  const adr = adrSection(read("docs/DECISIONS.md"), "0050");

  assert.match(adr, /\*\*Status:\*\* Accepted/);
  assert.match(adr, /one production dependency boundary/i);
  assert.match(adr, /API, realtime, and worker entrypoints/i);
  assert.match(adr, /CPU-heavy[^.]*never[^.]*API event loop/i);
  assert.match(adr, /runtime imports?[^.]*server\/package\.json[^.]*dependencies/i);
  assert.match(adr, /@aws-sdk\/client-s3/);
  assert.match(adr, /private S3-compatible object storage/i);
  assert.match(adr, /filesystem[^.]*test\/development only/i);
  assert.match(adr, /monotonic deadline/i);
  assert.match(adr, /AbortSignal/);
  assert.match(adr, /no durable operation[^.]*complete after\s+cancellation/i);
  assert.match(adr, /bounded per-process token buckets/i);
  assert.match(adr, /Postgres[^.]*credential[^.]*replay/i);
  assert.match(adr, /no Redis\s+or NATS/i);
  assert.match(adr, /server-derived tenant and role/i);
  assert.match(adr, /hash-only credential storage/i);
  assert.match(adr, /ADR-0038/);
});


test("the accepted boundary is reflected in living architecture and testing docs", () => {
  const architecture = read("docs/architecture/10-10-platform.md");
  const testing = read("docs/TESTING.md");

  assert.match(architecture, /Target Node backend boundary \(ADR-0050\)/);
  assert.match(architecture, /server\/package\.json/);
  assert.match(architecture, /API, realtime, and worker/);
  assert.match(architecture, /S3-compatible/);
  assert.match(architecture, /AbortSignal/);
  assert.match(architecture, /controlled device enrollment/);
  assert.match(testing, /tests\/contract\/node-backend-decisions\.test\.mjs/);
  assert.match(testing, /decision proof only/i);
});


test("W2.16 device identity is reflected across every operational living document", () => {
  const decisions = adrSection(read("docs/DECISIONS.md"), "0038");
  const architecture = read("docs/architecture/10-10-platform.md");
  const testing = read("docs/TESTING.md");
  const inventory = read("docs/DATA_INVENTORY.md");
  const runbook = read("docs/STAGING_RUNBOOK.md");
  const threatModel = read("docs/readiness/THREAT_MODEL.md");
  const impactMap = read("specs/lean-flutter-node-consolidation/impact-map.md");

  assert.match(decisions, /W2\.16 implementation note/i);
  assert.match(decisions, /15-minute access/i);
  assert.match(decisions, /seven-day idle/i);
  assert.match(decisions, /30-day absolute/i);
  assert.match(decisions, /refresh replay[^.]*credential family/i);
  assert.match(decisions, /provision-device-enrollment\.mjs/);

  assert.match(architecture, /implemented W2\.16 device-identity boundary/i);
  assert.match(architecture, /DEVICE_IDENTITY_ENABLED=1/);
  assert.match(architecture, /migration 0035/i);
  assert.doesNotMatch(architecture, /durable enrollment,[\s\n]+infrastructure provisioning[^.]*remain target/i);

  assert.match(testing, /W2\.16 controlled device enrollment/i);
  assert.match(testing, /tests\/e2e\/device-enrollment\.test\.mjs/);
  assert.match(testing, /invitation reuse, expiry, forgery, refresh replay/i);

  assert.match(inventory, /Device enrollment invitations and sessions/);
  assert.match(inventory, /hash-only invitation, access, and refresh credentials/i);
  assert.match(inventory, /count-only device credential markers/i);

  assert.match(runbook, /Controlled device enrollment rollout/);
  assert.match(runbook, /provision-device-enrollment\.mjs/);
  assert.match(runbook, /DEVICE_IDENTITY_ENABLED=0/);
  assert.match(runbook, /refresh replay[^.]*entire credential family/i);

  assert.match(threatModel, /256-bit opaque device invitations/i);
  assert.match(threatModel, /refresh replay[^.]*credential family/i);
  assert.match(threatModel, /device identity rows[^.]*count-only/i);

  assert.match(impactMap, /W2\.16 implemented device identity/i);
  assert.match(impactMap, /provisionDeviceEnrollment/);
});


test("W2.17 one-image inference ownership is reflected across operational living docs", () => {
  const decisions = adrSection(read("docs/DECISIONS.md"), "0050");
  const architecture = read("docs/architecture/10-10-platform.md");
  const testing = read("docs/TESTING.md");
  const inventory = read("docs/DATA_INVENTORY.md");
  const runbook = read("docs/STAGING_RUNBOOK.md");
  const threatModel = read("docs/readiness/THREAT_MODEL.md");
  const backup = read("docs/BACKUP_RESTORE.md");
  const readme = read("README.md");

  assert.match(decisions, /Implementation note \(2026-08-07, W2\.17\)/);
  assert.match(decisions, /server\/src\/inference/);
  assert.match(decisions, /exact same\s+production image/i);
  assert.match(decisions, /API never executes durable work inline/i);

  assert.match(architecture, /implemented W2\.17 cutover/i);
  assert.match(
    architecture,
    /node-api`, `job-worker`, and\s+`node-realtime` are three commands of the exact same OCI image/i,
  );
  assert.match(architecture, /internal no-traffic shadow/i);
  assert.doesNotMatch(architecture, /^- `services\/ml-inference`/m);

  assert.match(testing, /W2\.17 server-owned inference and one-image consolidation/i);
  assert.match(testing, /tests\/jobs\/api-job-wait\.test\.mjs/);
  assert.match(inventory, /`job-worker` retention sweep/);
  assert.match(runbook, /same image id/i);
  assert.match(threatModel, /worker inference runtime hard-requires `sessionId`/i);
  assert.match(backup, /`job-worker` owns retained-audio writes/i);
  assert.match(readme, /`server` is the single Node production package and image/i);
});


test("W2.18 explicit HTTP canary and immutable reversal are reflected in living docs", () => {
  const decisions = adrSection(read("docs/DECISIONS.md"), "0050");
  const architecture = read("docs/architecture/10-10-platform.md");
  const testing = read("docs/TESTING.md");
  const runbook = read("docs/STAGING_RUNBOOK.md");

  assert.match(decisions, /Implementation note \(2026-08-07, W2\.18\)/);
  assert.match(decisions, /exactly 39\s+retained routes/i);
  assert.match(decisions, /no random traffic split or dual write/i);

  assert.match(architecture, /implemented W2\.18 HTTP canary topology/i);
  assert.match(architecture, /docker-compose\.canary\.yml/);
  assert.match(architecture, /Web\s+and gateway indexing[^.]*Node/i);
  assert.match(architecture, /Base Compose[^.]*Rust-safe/i);

  assert.match(testing, /W2\.18 explicit HTTP canary topology/i);
  assert.match(testing, /tests\/contract\/http-canary-topology\.test\.mjs/);
  assert.match(testing, /tests\/e2e\/http-canary-effects\.test\.mjs/);
  assert.match(testing, /never reaches Rust/i);

  assert.match(runbook, /Immutable HTTP canary and reversal/i);
  assert.match(runbook, /docker-compose\.release\.yml/);
  assert.match(runbook, /docker-compose\.canary\.yml/);
  assert.match(runbook, /previous[^.]*digest/i);
  assert.doesNotMatch(runbook, /rollback today means[^.]*docker compose build/i);
  assert.doesNotMatch(runbook, /Interim procedure \(rebuild-based\)/i);
});


test("the W2.1 decision guard is part of the canonical Node suite", () => {
  const verify = read("scripts/verify.sh");
  const invocations = verify
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes("tests/contract/node-backend-decisions.test.mjs"));

  assert.equal(invocations.length, 1, "canonical verification must invoke the W2.1 guard once");
});
