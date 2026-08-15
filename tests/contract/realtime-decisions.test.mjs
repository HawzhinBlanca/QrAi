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
  assert.match(architecture, /W3\.3 milestone[^.]*1013/is);
  assert.match(architecture, /Rust[^.]*only realtime traffic target/is);
  assert.equal(
    testing.split("tests/realtime/ticket-boundary.test.mjs").length - 1,
    1,
    "the W3.3 focused gate must be documented exactly once",
  );
});

test("ADR-0053 records the implemented restricted Postgres replay authority", () => {
  const decision = adr("0053");

  assert.match(decision, /\*\*Status:\*\* Accepted/);
  assert.match(decision, /\*\*Decider:\*\* repository owner/i);
  assert.match(decision, /migration 0036/i);
  assert.match(decision, /forced-RLS `realtime_ticket_replay_claims`/i);
  assert.match(decision, /SHA-256 of the exact signed nonce bytes/i);
  assert.match(decision, /ON CONFLICT DO NOTHING RETURNING/i);
  assert.match(decision, /database time/i);
  assert.match(decision, /generic 401/i);
  assert.match(decision, /bodyless 503/i);
  assert.match(decision, /no memory fallback/i);
  assert.match(decision, /p95 `<100 ms`/i);
  assert.match(decision, /throughput `>=100\/s`/i);
  assert.match(decision, /Rust Redis\/in-memory behavior remains/i);
  assert.match(decision, /adds no\s+service, dependency, port, public route/i);
});

test("living docs expose W3.4 as implemented and document its focused proofs once", () => {
  assert.match(architecture, /W3\.4 durable replay \(ADR-0053\)/);
  assert.match(architecture, /atomically claims[^.]*SHA-256/is);
  assert.match(architecture, /database failure is bodyless 503/i);
  assert.match(architecture, /leaving the Rust Redis oracle and all traffic routing unchanged/i);
  for (const target of [
    "tests/migrations/realtime-replay-migration.test.mjs",
    "tests/realtime/replay-protection.test.mjs",
  ]) {
    assert.equal(
      testing.split(target).length - 1,
      1,
      `${target} must be documented exactly once as a focused W3.4 gate`,
    );
  }
});

test("ADR-0051/0052 and living docs expose the implemented bounded W3.5 runtime without a traffic claim", () => {
  const contractDecision = adr("0051");
  const admissionDecision = adr("0052");
  for (const decision of [contractDecision, admissionDecision]) {
    assert.match(decision, /W3\.5 implementation note/i);
    assert.match(decision, /2 MiB \+ 64 KiB transport/i);
    assert.match(decision, /100\s+active\/draining sessions/i);
    assert.match(decision, /accepted=true[^.]*enqueued[^.]*not stored/is);
    assert.match(decision, /Rust[^.]*traffic target/is);
  }
  assert.match(architecture, /W3\.5 bounded audio runtime \(ADR-0051\/0052\)/);
  assert.match(architecture, /8 chunks[^.]*4 MiB[^.]*64 MiB[^.]*100 active\/draining sessions/is);
  assert.match(architecture, /browser WebM\/MP4[^.]*cutover blocker/is);
  assert.equal(
    testing.split("tests/realtime/backpressure.test.mjs").length - 1,
    1,
    "the W3.5 focused gate must be documented exactly once",
  );
});

test("ADR-0051/0052 and living docs expose W3.6 durable outcomes without a playback or traffic fork", () => {
  for (const decision of [adr("0051"), adr("0052")]) {
    assert.match(decision, /W3\.6 implementation note/i);
    assert.match(decision, /migration 0037/i);
    assert.match(decision, /accepted-lost/i);
    assert.match(decision, /(?:audio_chunks[^.]*sole playback|sole playback[^.]*audio_chunks)/i);
    assert.match(decision, /Rust[^.]*traffic/i);
  }
  assert.match(architecture, /W3\.6 durable storage\/index outcomes/i);
  assert.match(architecture, /Finalization unions unrepaired accepted losses/i);
  assert.match(architecture, /Playback never reads the diagnostic\s+table/i);
  for (const target of [
    "tests/migrations/realtime-audio-outcomes-migration.test.mjs",
    "tests/realtime/storage-index.test.mjs",
  ]) {
    assert.equal(
      testing.split(target).length - 1,
      1,
      `${target} must be documented exactly once as a focused W3.6 gate`,
    );
  }
});

test("ADR-0051/0052 and living docs expose honest W3.7 recovery without an end-to-end claim", () => {
  for (const decision of [adr("0051"), adr("0052")]) {
    assert.match(decision, /W3\.7 implementation note/i);
    assert.match(decision, /fresh (?:API-issued )?(?:single-use )?ticket/i);
    assert.match(decision, /125-frame\/2 MiB|125 frames\/2 MiB/i);
    assert.match(
      decision,
      /safe reconnect only when no sent\s+frame is ambiguous|never replays ambiguous/is,
    );
    assert.match(decision, /migration\s+0038/i);
    assert.match(
      decision,
      /only the owning learner may submit|only the owning learner may submit or retry/i,
    );
    assert.match(decision, /staff[^.]*legacy\s+empty-?\s*body/i);
    assert.match(
      decision,
      /(?:client[^.]*server|server[^.]*client)[^.]*separat|separat[^.]*client[^.]*server/is,
    );
    assert.match(decision, /Flutter W4\.11/i);
    assert.match(decision, /Rust[^.]*public(?: realtime traffic| target)/is);
  }

  assert.match(architecture, /W3\.7 realtime recovery and honest fallback/i);
  assert.match(architecture, /sent\/no-ack disconnect is uncertain[^.]*never replayed/is);
  assert.match(architecture, /legacy client with\s+no report is `unverified`/i);
  assert.match(architecture, /real API\/WebSocket\/Postgres proof[^.]*Flutter\s+W4\.11/is);
  for (const target of [
    "tests/migrations/realtime-recovery-migration.test.mjs",
    "tests/e2e/realtime-recovery.test.mjs",
  ]) {
    assert.equal(
      testing.split(target).length - 1,
      1,
      `${target} must be documented exactly once as a focused W3.7 gate`,
    );
  }
});
