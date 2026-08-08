import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const decisions = readFileSync(join(repo, "docs", "DECISIONS.md"), "utf8");
const architecture = readFileSync(join(repo, "docs", "architecture", "10-10-platform.md"), "utf8");
const testing = readFileSync(join(repo, "docs", "TESTING.md"), "utf8");

function adr(number) {
  const marker = `## ADR-${number}`;
  const start = decisions.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must exist`);
  const next = decisions.indexOf("\n---\n\n## ADR-", start);
  return decisions.slice(start, next === -1 ? undefined : next);
}

test("ADR-0051 accepts one independently drainable realtime entrypoint in the Node package", () => {
  const decision = adr("0051");

  assert.match(decision, /\*\*Status:\*\* Accepted/);
  assert.match(decision, /\*\*Decider:\*\* repository owner/i);
  assert.match(decision, /same `server` package/i);
  assert.match(decision, /separate (?:realtime )?(?:process|entrypoint)/i);
  assert.match(decision, /independently (?:deployable|drainable)/i);
  assert.match(decision, /Rust gateway remains the compatibility oracle/i);
});

test("ADR-0051 freezes replay, Origin, queue, and acknowledgement safety boundaries", () => {
  const decision = adr("0051");

  assert.match(decision, /Postgres/i);
  assert.match(decision, /SHA-256 nonce hash/i);
  assert.match(decision, /raw ticket[^.]*never (?:stored|persisted)/i);
  assert.match(decision, /benchmark/i);
  assert.match(decision, /fail(?:s)? closed/i);
  assert.match(decision, /browser[^.]*Origin allowlist/i);
  assert.match(decision, /native[^.]*no-Origin/i);
  assert.match(decision, /bounded per-session queue/i);
  assert.match(decision, /explicit `audio\.ack`/i);
  assert.match(decision, /diagnostic prose/i);
  assert.match(decision, /does not add Redis,\s+NATS/i);
});

test("living architecture and testing docs expose the W3.1 boundary and its two hermetic gates", () => {
  assert.match(architecture, /Target realtime boundary \(ADR-0051\)/);
  assert.match(architecture, /Rust-generated.*rt_v2.*audio\.ack/is);
  assert.match(architecture, /shared authority must fail closed/i);

  for (const target of [
    "tests/contract/realtime-decisions.test.mjs",
    "tests/realtime/protocol-fixtures.test.mjs",
  ]) {
    assert.equal(
      testing.split(target).length - 1,
      1,
      `${target} must be documented exactly once as a focused gate`,
    );
  }
});
