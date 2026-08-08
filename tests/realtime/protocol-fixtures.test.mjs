import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const fixtureRoot = join(repo, "packages", "contracts", "fixtures", "realtime");
const ticketPath = join(fixtureRoot, "rt-v2-ticket-vectors.json");
const ackPath = join(fixtureRoot, "audio-ack-vectors.json");
const oldTicketPath = join(repo, "specs", "node-backend-port", "fixtures", "ticket-vectors.json");
const protocolPath = join(repo, "server", "src", "realtime", "protocol.mjs");
const expectedTicketValueHash = "3b096188a93e37f5e4d9f3b59f195c3a1b8750994bb913b9bf5b5a1f932b5a2e";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("the contracts package is the single realtime fixture authority", () => {
  assert.equal(existsSync(ticketPath), true, "the final rt_v2 ticket fixture must exist");
  assert.equal(existsSync(ackPath), true, "the Rust-generated audio.ack fixture must exist");
  assert.equal(existsSync(oldTicketPath), false, "the transitional ticket fixture must be moved, not copied");

  const executableReaders = [
    "tests/node-api/ticket-vectors.test.mjs",
    "services/shared-ticket/src/lib.rs",
    "services/shared-ticket/tests/regenerate_vectors.rs",
    "server/src/lib/ticket.mjs",
  ];
  for (const relativePath of executableReaders) {
    assert.doesNotMatch(
      readFileSync(join(repo, relativePath), "utf8"),
      /specs\/node-backend-port\/fixtures\/ticket-vectors\.json/,
      `${relativePath} still references the transitional authority`,
    );
  }
});

test("the move preserves all six Rust-generated ticket values byte-for-byte", () => {
  const fixture = readJson(ticketPath);
  assert.equal(fixture.vectorCount, 6);
  assert.equal(fixture.vectors.length, 6);
  const valueBytes = JSON.stringify(
    fixture.vectors.map(({ name, expectedTicket }) => ({ name, expectedTicket })),
  );
  assert.equal(
    createHash("sha256").update(valueBytes).digest("hex"),
    expectedTicketValueHash,
    "ticket values changed during an ownership-only move",
  );
});

test("Node parses, constructs, and serializes every Rust-generated audio.ack vector", async () => {
  const protocol = await import(pathToFileURL(protocolPath));
  const fixture = readJson(ackPath);
  assert.equal(fixture.vectorCount, fixture.vectors.length);
  assert.ok(fixture.vectors.length >= 2, "cover accepted/rejected and trace/null variants");
  assert.deepEqual(
    [...new Set(fixture.vectors.map(({ ack }) => ack.accepted))].sort(),
    [false, true],
    "the Rust vectors must cover accepted and rejected acknowledgements",
  );
  assert.equal(
    fixture.vectors.some(({ ack }) => ack.trace_id === null),
    true,
    "the Rust vectors must cover an explicit null trace",
  );
  assert.equal(
    fixture.vectors.some(({ ack }) => typeof ack.trace_id === "string" && ack.trace_id.length > 0),
    true,
    "the Rust vectors must cover a non-empty trace",
  );

  for (const vector of fixture.vectors) {
    const ack = vector.ack;
    assert.deepEqual(Object.keys(ack).sort(), [...protocol.AUDIO_ACK_FIELDS].sort(), vector.name);
    assert.deepEqual(protocol.parseAudioAck(JSON.stringify(ack)), ack, vector.name);
    assert.deepEqual(JSON.parse(protocol.serializeAudioAck(ack)), ack, vector.name);
    assert.deepEqual(
      protocol.createAudioAck({
        sessionId: ack.session_id,
        chunkId: ack.chunk_id,
        sequence: ack.sequence,
        accepted: ack.accepted,
        traceId: ack.trace_id,
        message: ack.message,
      }),
      ack,
      vector.name,
    );
  }
});

test("the Node audio.ack boundary refuses ambiguous or lossy wire documents", async () => {
  const { parseAudioAck } = await import(pathToFileURL(protocolPath));
  const valid = {
    kind: "audio.ack",
    session_id: "session-1",
    chunk_id: "chunk-1",
    sequence: 0,
    accepted: true,
    trace_id: null,
    message: "diagnostic wording is not a semantic enum",
  };
  const invalid = [
    { ...valid, kind: "audio.accepted" },
    { ...valid, session_id: " " },
    { ...valid, chunk_id: "" },
    { ...valid, sequence: -1 },
    { ...valid, sequence: 0.5 },
    { ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, accepted: "true" },
    { ...valid, trace_id: undefined },
    { ...valid, trace_id: "" },
    { ...valid, message: " " },
    { ...valid, extra: true },
  ];

  for (const value of invalid) {
    assert.equal(parseAudioAck(value), null, JSON.stringify(value));
  }
  assert.deepEqual(parseAudioAck(valid), valid);
  assert.deepEqual(
    parseAudioAck({ ...valid, accepted: false, message: "any non-empty diagnostic may change" }),
    { ...valid, accepted: false, message: "any non-empty diagnostic may change" },
    "message prose must not become a semantic enum",
  );
});
