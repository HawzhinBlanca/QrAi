import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { request, startApi, startMockUpstream } from "../api-parity/lib/harness.mjs";

/**
 * A trace has to survive the request FAILING. (P5.3 — observability assertions)
 *
 * `tests/observability/trace-join.test.mjs` proves the join on the happy path: one learner request,
 * two services, the same trace in `audit_events.metadata.trace_id` and in ml-inference's audit log.
 * That is the case nobody needs a trace for. The operator reaches for a trace id when something
 * went wrong.
 *
 * ── What was measured ───────────────────────────────────────────────────────────────────────────
 * On the ML proxy's three failure paths — send error, non-2xx upstream, unparseable body — the
 * service logged only which label failed:
 *
 *     ML proxy tajweed send error: <reqwest error>
 *
 * and the audit write that carries `trace_id` lives in `persist_tajweed_findings`, which runs ONLY
 * on success. So a learner's `x-trace-id` was recoverable for every request that worked and for
 * none that failed. An operator handed that id after a failed practice session had nothing to grep:
 * not a log line, not an audit row. The trail existed exactly where it was not needed.
 *
 * The fix is deliberately the smallest one that makes the claim true: the trace is bound before the
 * upstream call and interpolated into each failure log. No new audit row — a failed analysis is not
 * an action taken on a subject, and inventing an audit shape to satisfy a test would be worse than
 * the gap.
 *
 * ── Why assert on the log ───────────────────────────────────────────────────────────────────────
 * Because that is precisely the claim. "An operator can follow a failed request by its trace id"
 * is a claim about what was written down, and for a failure the thing written down is the log. A
 * test that asserted the 502 instead would pass with the trace still missing — that is what the
 * existing suite already does.
 *
 * Requires a live Postgres. `hang` uses the harness's fault injection: the socket is accepted, the
 * request read, and no answer ever sent — a wedged process, not one returning an error.
 */

const TIMEOUT_SECS = 3;
const ML_ROUTE = "/v1/ml/tajweed-findings:predict";
const ASR_ROUTE = "/v1/asr/transcribe";

let api;
let ml;
let asr;

before(async () => {
  ml = await startMockUpstream(() => ({ status: 200, body: { findings: [] } }));
  asr = await startMockUpstream(() => ({ status: 200, body: { text: "", words: [] } }));
  api = await startApi({
    env: {
      ML_INFERENCE_URL: ml.url,
      ASR_INFERENCE_URL: asr.url,
      UPSTREAM_TIMEOUT_SECS: String(TIMEOUT_SECS),
      // The failure logs are `error!`; BASE_ENV already sets RUST_LOG=error, named here so a change
      // to that default cannot silently empty this test's evidence.
      RUST_LOG: "error",
    },
  });
});

after(async () => {
  await api?.stop();
  await ml?.stop();
  await asr?.stop();
});

/** A trace id unique per assertion, so one test cannot pass on another's log line. */
function traceId(what) {
  return `trace-fault-${what}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Wait for the service to flush the line; logs are streamed, not synchronous with the response. */
async function logContaining(needle, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (api.stdout.includes(needle) || api.stderr.includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("a wedged ML upstream still records the caller's trace", async () => {
  const trace = traceId("ml-hang");
  ml.respond = () => ({ hang: true });

  const res = await request(api.baseUrl, ML_ROUTE, {
    method: "POST",
    role: "learner",
    body: { words: [] },
    headers: { "x-trace-id": trace },
  });

  assert.equal(res.status, 502, "a wedged upstream should still be a 502 to the caller");
  assert.ok(
    await logContaining(trace),
    `the ML timeout was not recorded against trace ${trace}. An operator holding this id from a ` +
      `learner's failed session has nothing to search. Recent log output:\n${api.stdout.slice(-2000)}`,
  );
});

test("an ML upstream that answers with an error records the trace too", async () => {
  // A different code path from the hang: `response.status().is_success()` is false, which used to
  // log at warn! — invisible at the RUST_LOG=error the service actually runs at, so this failure
  // left no record at ALL, not merely a traceless one.
  const trace = traceId("ml-500");
  ml.respond = () => ({ status: 500, body: { error: "upstream exploded" } });

  const res = await request(api.baseUrl, ML_ROUTE, {
    method: "POST",
    role: "learner",
    body: { words: [] },
    headers: { "x-trace-id": trace },
  });

  assert.equal(res.status, 502);
  assert.ok(
    await logContaining(trace),
    `a non-2xx ML response was not recorded against trace ${trace}. ` +
      `Recent log output:\n${api.stdout.slice(-2000)}`,
  );
});

test("an unparseable ML body records the trace", async () => {
  const trace = traceId("ml-garbage");
  ml.respond = () => ({ status: 200, body: "not json at all", contentType: "application/json" });

  const res = await request(api.baseUrl, ML_ROUTE, {
    method: "POST",
    role: "learner",
    body: { words: [] },
    headers: { "x-trace-id": trace },
  });

  assert.equal(res.status, 502);
  assert.ok(
    await logContaining(trace),
    `an unparseable ML body was not recorded against trace ${trace}. ` +
      `Recent log output:\n${api.stdout.slice(-2000)}`,
  );
});

test("the ASR proxy records the trace on failure as well", async () => {
  // Same shape, separate code path. The ML fix would not have reached it, and the ASR route is the
  // one carrying a learner's actual audio.
  const trace = traceId("asr-hang");
  asr.respond = () => ({ hang: true });

  const res = await request(api.baseUrl, ASR_ROUTE, {
    method: "POST",
    role: "learner",
    body: { audioBase64: "AAAA" },
    headers: { "x-trace-id": trace },
  });

  assert.ok(
    res.status >= 400,
    `expected the wedged ASR upstream to fail the request, got ${res.status}`,
  );
  assert.ok(
    await logContaining(trace),
    `the ASR failure was not recorded against trace ${trace}. ` +
      `Recent log output:\n${api.stdout.slice(-2000)}`,
  );
});

test("the trace reaches the log while the 502 body still tells the caller nothing", async () => {
  // An earlier version of this test asserted that the failure LOG must not contain the upstream
  // address. That was wrong, and the code says so: `proxy_asr`'s doc comment reads "internal
  // URL/errors are logged, never returned". reqwest's own error text embeds the URL it could not
  // reach, and an operator debugging a wedged upstream wants exactly that. The boundary is the
  // RESPONSE, not the log — so this asserts the boundary that actually exists rather than one the
  // test invented.
  const trace = traceId("boundary");
  ml.respond = () => ({ hang: true });

  const res = await request(api.baseUrl, ML_ROUTE, {
    method: "POST",
    role: "learner",
    body: { words: [] },
    headers: { "x-trace-id": trace },
  });

  assert.ok(await logContaining(trace), "the operator's side of the boundary must have the trace");

  const returned = JSON.stringify(res.body);
  assert.ok(
    !returned.includes(new URL(ml.url).host),
    `the 502 body leaks the internal ML address: ${returned}`,
  );
  assert.ok(
    !returned.toLowerCase().includes("reqwest") && !returned.includes("127.0.0.1"),
    `the 502 body leaks upstream internals: ${returned}`,
  );
});
