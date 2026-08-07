import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { request, startApi, startMockUpstream } from "./lib/harness.mjs";

/**
 * P5.3 fault injection — a WEDGED ML/ASR upstream.
 *
 * `lib.rs` has carried this comment since the client was written:
 *
 *   "A bare `Client::new()` has no request timeout, so a stuck/hung ML or ASR upstream (e.g. a
 *    GPU/MPS fault mid-inference) would block the calling request indefinitely"
 *
 * The timeout was there. Nothing ever fired it. Every existing proxy test uses an upstream that
 * ANSWERS — with 200, or with an error that becomes a 502 — and an upstream that answers is a
 * different failure from one that does not. A wedged process is the realistic ML fault: the socket
 * is accepted, the request is read, and no response ever comes.
 *
 * ── Why the timeout had to become configurable ────────────────────────────────────────────────
 * It was hardcoded to 60s, so this test could not exist: a gate cannot spend a minute per assertion.
 * `UPSTREAM_TIMEOUT_SECS` (lib.rs `upstream_timeout`) makes it injectable, which is also the honest
 * operational answer — 60s was one deployment's guess about its own hardware.
 *
 * ── What "the timeout fired" means here ───────────────────────────────────────────────────────
 * A 502 alone proves nothing: platform-api collapses EVERY upstream failure into 502, so a
 * connection refused, a malformed reply and a hang are indistinguishable by status. The timing is
 * what separates them, so these tests assert a window rather than a code.
 */

const TIMEOUT_SECS = 3;
const ML_ROUTE = "/v1/ml/tajweed-findings:predict";

let api;
let ml;
let asr;

before(async () => {
  ml = await startMockUpstream(() => ({ status: 200, body: { annotations: [], findings: [] } }));
  asr = await startMockUpstream(() => ({ status: 200, body: { text: "", words: [] } }));
  api = await startApi({
    env: {
      ML_INFERENCE_URL: ml.url,
      ASR_INFERENCE_URL: asr.url,
      UPSTREAM_TIMEOUT_SECS: String(TIMEOUT_SECS),
    },
  });
});

after(async () => {
  await api?.stop();
  await ml?.stop();
  await asr?.stop();
});

test("a wedged ML upstream fails the request in bounded time instead of hanging forever", async () => {
  ml.respond = () => ({ hang: true });
  ml.received.length = 0;

  const started = Date.now();
  const res = await request(api.baseUrl, ML_ROUTE, {
    method: "POST",
    role: "learner",
    body: { words: [] },
  });
  const elapsedMs = Date.now() - started;

  assert.equal(res.status, 502, "a hung upstream must surface as a clean 502, not a 500 or a crash");
  assert.equal(ml.received.length, 1, "the request must actually have reached the upstream and stuck there");

  // The lower bound is what proves the TIMEOUT ended this rather than something failing early: a
  // refused connection or a serialisation error would come back in milliseconds and would otherwise
  // satisfy every other assertion here.
  assert.ok(
    elapsedMs >= TIMEOUT_SECS * 1000 * 0.8,
    `returned after ${elapsedMs}ms, far too fast to be the ${TIMEOUT_SECS}s timeout — something ` +
      `else failed first and this test is not exercising the hang`,
  );
  // The upper bound is the actual bug being guarded: without a client timeout this never returns.
  // It is also the proof UPSTREAM_TIMEOUT_SECS is HONOURED — at the old hardcoded 60s this fails.
  assert.ok(
    elapsedMs < TIMEOUT_SECS * 1000 + 4000,
    `took ${elapsedMs}ms against a ${TIMEOUT_SECS}s timeout — the configured value is being ignored`,
  );
});

test("a wedged ASR upstream behaves the same way", async () => {
  // Two separate clients would be a plausible refactor, and one of them getting a timeout while the
  // other kept `Client::new()` is exactly the asymmetry nobody would notice until a GPU fault.
  asr.respond = () => ({ hang: true });
  asr.received.length = 0;

  const started = Date.now();
  const res = await request(api.baseUrl, "/v1/asr/transcribe", {
    method: "POST",
    role: "learner",
    body: { audioBase64: "AAAA", audioFormat: "wav", language: "ar" },
  });
  const elapsedMs = Date.now() - started;

  assert.equal(res.status, 502);
  assert.ok(
    elapsedMs >= TIMEOUT_SECS * 1000 * 0.8 && elapsedMs < TIMEOUT_SECS * 1000 + 4000,
    `ASR hang returned in ${elapsedMs}ms; expected roughly the ${TIMEOUT_SECS}s timeout`,
  );
});

test("the timeout response leaks nothing about the upstream it failed to reach", async () => {
  ml.respond = () => ({ hang: true });
  const res = await request(api.baseUrl, ML_ROUTE, {
    method: "POST",
    role: "learner",
    body: { words: [] },
  });

  // These services sit behind platform-api precisely so the browser never learns they exist. A
  // timeout is the case most likely to leak one, because the error carries the URL it was dialling.
  const serialised = JSON.stringify(res.body ?? "") + String(res.text ?? "");
  const mlHost = new URL(ml.url).host;
  for (const leak of [mlHost, "127.0.0.1", "reqwest", "operation timed out", "tcp connect"]) {
    assert.ok(
      !serialised.toLowerCase().includes(leak.toLowerCase()),
      `the 502 body leaked ${JSON.stringify(leak)}: ${serialised.slice(0, 300)}`,
    );
  }
});

// ── The config guard itself ──────────────────────────────────────────────────────────────────
// Making the timeout configurable introduced a new way to get it wrong, and a knob whose bad values
// are accepted silently is worse than no knob: the operator believes they set 5 seconds and the
// service is still waiting 60. These two cases are the whole reason `upstream_timeout` parses
// strictly instead of `unwrap_or(60)`.

test("a non-numeric UPSTREAM_TIMEOUT_SECS refuses to boot rather than silently defaulting", async () => {
  // Capital letter O, not zero — the realistic typo, and the one `unwrap_or` swallows.
  await assert.rejects(
    () => startApi({ env: { UPSTREAM_TIMEOUT_SECS: "6O" }, timeoutMs: 8000 }),
    (error) => {
      assert.match(
        String(error.message),
        /UPSTREAM_TIMEOUT_SECS/,
        "the service died without naming the variable, so an operator cannot fix it",
      );
      return true;
    },
    "platform-api booted with an unparseable timeout — it is now running on a value nobody chose",
  );
});

test("UPSTREAM_TIMEOUT_SECS=0 refuses to boot, because reqwest reads it as NO timeout", async () => {
  // The trap worth spelling out: 0 reads like "fail immediately" and means the opposite. Accepting
  // it would restore the unbounded hang the tests above exist to prevent, via the one setting an
  // operator would reach for to make things stricter.
  await assert.rejects(
    () => startApi({ env: { UPSTREAM_TIMEOUT_SECS: "0" }, timeoutMs: 8000 }),
    (error) => {
      assert.match(String(error.message), /UPSTREAM_TIMEOUT_SECS/);
      return true;
    },
    "a zero timeout was accepted, which disables the timeout entirely",
  );
});

test("one hung request does not wedge the whole server", async () => {
  // The reliability property behind the timeout. If a stuck upstream held its worker, a handful of
  // hung recitations would take the API down for every learner — including the ones not using ML at
  // all. Deliberately NOT awaited: the assertions below run while the request is still in flight.
  ml.respond = () => ({ hang: true });
  const inFlight = request(api.baseUrl, ML_ROUTE, {
    method: "POST",
    role: "learner",
    body: { words: [] },
  });

  const health = await request(api.baseUrl, "/health", { method: "GET" });
  assert.equal(health.status, 200, "liveness stopped answering while ONE request was blocked upstream");

  const quran = await request(api.baseUrl, "/v1/quran/surahs", { method: "GET", role: "learner" });
  assert.notEqual(
    quran.status,
    502,
    "an unrelated route failed while an ML call was hung — the fault is not contained",
  );

  await inFlight;
});
