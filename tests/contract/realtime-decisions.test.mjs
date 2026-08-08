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

test("ADR-0052 pins one supported internal WebSocket admission adapter and no traffic claim", () => {
  const decision = adr("0052");

  assert.match(decision, /\*\*Status:\*\* Accepted/);
  assert.match(decision, /\*\*Decider:\*\* repository owner/i);
  assert.match(decision, /`@fastify\/websocket` 11\.3\.0/);
  assert.match(decision, /register(?:ed|s)? before (?:all )?routes/i);
  assert.match(decision, /exact session-audio route/i);
  assert.match(decision, /close(?:s|d)? (?:code )?1013/i);
  assert.match(decision, /no (?:host port|public traffic)/i);
  assert.match(decision, /Rust gateway remains the\s+(?:traffic target|compatibility oracle)/i);
  assert.match(decision, /W3\.4 owns replay/i);
  assert.match(decision, /W3\.5 owns\s+(?:audio|bounded audio)/i);
});

test("living docs expose W3.3 as admitted-but-unavailable and document its focused gate once", () => {
  assert.match(architecture, /W3\.3 realtime admission \(ADR-0052\)/);
  assert.match(architecture, /valid shadow upgrade[^.]*1013/is);
  assert.match(architecture, /Rust[^.]*only realtime traffic target/is);
  assert.equal(
    testing.split("tests/realtime/ticket-boundary.test.mjs").length - 1,
    1,
    "the W3.3 focused gate must be documented exactly once",
  );
});
