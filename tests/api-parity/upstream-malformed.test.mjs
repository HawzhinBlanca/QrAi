import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { request, startApi, startMockUpstream } from "./lib/harness.mjs";

/**
 * P5.3 fault injection — an ML service that returns the WRONG SHAPE.
 *
 * `upstream-hang.test.mjs` covers an upstream that never answers, and `proxy-endpoints.test.mjs`
 * covers one that answers with an error status. This covers the one that answers **200 with
 * something unexpected**, which is the failure a model server actually produces: a partially
 * migrated response, a proxy error page, a debug build returning a different schema.
 *
 * It matters more here than in a normal proxy because of the domain rule: learner-facing AI feedback
 * must never appear without source, confidence and an approval gate. `redact_withheld_findings`
 * enforces that server-side (ADR-0028) — and it does so by INSPECTING the shape it was given. So the
 * question this file asks is not "does the gate work" but "what does the gate do when the ML service
 * hands it something it did not expect", which is the only way an ungated finding could reach a
 * learner without anyone editing the gate.
 */

const ML_ROUTE = "/v1/ml/tajweed-findings:predict";

let api;
let ml;
let asr;

before(async () => {
  ml = await startMockUpstream(() => ({ status: 200, body: { findings: [] } }));
  asr = await startMockUpstream(() => ({ status: 200, body: { text: "", words: [] } }));
  api = await startApi({ env: { ML_INFERENCE_URL: ml.url, ASR_INFERENCE_URL: asr.url } });
});

after(async () => {
  await api?.stop();
  await ml?.stop();
  await asr?.stop();
});

const predict = () =>
  request(api.baseUrl, ML_ROUTE, { method: "POST", role: "learner", body: { words: [] } });

test("a non-JSON ML body becomes a 502, not a 500", async () => {
  // The ASR proxy has had this test since C2; the ML proxy never did, though it has the same
  // `response.json()` failure path. A 200 carrying an HTML error page is the realistic version:
  // an ingress or sidecar in front of the model server.
  ml.respond = () => ({ status: 200, body: "<html>502 Bad Gateway</html>", contentType: "text/html" });
  const res = await predict();

  assert.equal(res.status, 502);
  assert.equal(res.body.error, "ML service returned an invalid response");
  assert.ok(
    !String(res.text).includes(new URL(ml.url).host),
    "the internal ML address must never be echoed to the browser",
  );
});

test("findings with no gate fields at all are withheld, not shown", async () => {
  // The baseline the gate exists for, stated against a hostile upstream rather than a cooperative
  // one: no reviewStatus, no confidence, no sources. Every `unwrap_or` in the gate should land on
  // its closed default.
  ml.respond = () => ({
    status: 200,
    body: {
      findings: [
        { wordId: "1:1:1", rule: "Ghunnah", explanation: "Hold the nasalization.", severity: "warning" },
      ],
    },
  });
  const res = await predict();

  assert.equal(res.status, 200);
  const [finding] = res.body.findings;
  assert.equal(finding.withheld, true, "a finding with no review state reached the learner");
  assert.equal(finding.explanation, "", "the explanation survived redaction");
  assert.equal(finding.rule, "", "the rule survived redaction");
  assert.equal(finding.confidence, 0);
  assert.deepEqual(finding.sources, []);
});

test("a finding that is not an object cannot carry content to the learner", async () => {
  // `redact_withheld_findings` does `let Some(obj) = finding.as_object_mut() else { continue }`.
  // A non-object element therefore skips redaction entirely and is forwarded verbatim. Whether any
  // client would RENDER a bare string is not the question — the server's job under ADR-0028 is to
  // not emit ungated model output at all, and "the client probably ignores it" is exactly the
  // reasoning that puts the gate on the wrong side of the boundary.
  const smuggled = "UNGATED-MODEL-TEXT-THAT-NO-TEACHER-APPROVED";
  ml.respond = () => ({ status: 200, body: { findings: [smuggled, 42, null] } });
  const res = await predict();

  assert.equal(res.status, 200);
  assert.ok(
    !JSON.stringify(res.body).includes(smuggled),
    `raw model text passed through the learner gate untouched: ${JSON.stringify(res.body).slice(0, 200)}`,
  );
});

test("a findings field that is not an array cannot carry content to the learner", async () => {
  // The earlier `return` in the same function: if `findings` is not an array, NOTHING is redacted
  // and the whole upstream body is forwarded as-is.
  const smuggled = "UNGATED-VIA-OBJECT-SHAPED-FINDINGS";
  ml.respond = () => ({ status: 200, body: { findings: { rule: smuggled, confidence: 0.99 } } });
  const res = await predict();

  assert.ok(
    !JSON.stringify(res.body).includes(smuggled),
    `an object-shaped findings field carried ungated model text to the learner: ${JSON.stringify(res.body).slice(0, 200)}`,
  );
});

test("a high-confidence unreviewed finding is still withheld", async () => {
  // Confidence alone must never open the gate — this is the case a model author would most expect
  // to work, and the one the domain rule most specifically forbids.
  ml.respond = () => ({
    status: 200,
    body: {
      findings: [
        {
          wordId: "1:1:1",
          rule: "Qalqalah",
          explanation: "Bounce the qaf.",
          confidence: 0.999,
          reviewStatus: "pending",
          sources: [{ id: "s1", title: "t", citation: "c" }],
        },
      ],
    },
  });
  const res = await predict();

  const [finding] = res.body.findings;
  assert.equal(finding.withheld, true, "0.999 confidence opened the gate without a teacher");
  assert.equal(finding.explanation, "");
});
