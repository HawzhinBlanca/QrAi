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


test("the W2.1 decision guard is part of the canonical Node suite", () => {
  const verify = read("scripts/verify.sh");
  const invocations = verify
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes("tests/contract/node-backend-decisions.test.mjs"));

  assert.equal(invocations.length, 1, "canonical verification must invoke the W2.1 guard once");
});
