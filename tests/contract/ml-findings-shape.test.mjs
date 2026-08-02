import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzeWord } from "../../services/ml-inference/tajweed.js";

/**
 * P3.2 — the one proxy response platform-api actually READS.
 *
 * `POST /v1/ml/tajweed-findings:predict` is one of the three `x-unvalidated` routes: platform-api
 * deserializes the upstream body as `serde_json::Value` and forwards it verbatim, so the contract
 * asserts nothing about its shape. That is the right call for a passthrough — but this one stopped
 * being a pure passthrough when `persist_tajweed_findings` started writing the findings down
 * (ADR-0027 item 4). It now reaches into the response by field name.
 *
 * ── The failure this exists to catch ────────────────────────────────────────────────────────────
 * Rename `wordId` to `word_id` in `services/ml-inference/tajweed.js` and every finding hits the
 * `continue` in ml_proxy.rs:265. `written` stays 0, `unanchored` stays 0, so even the "skipped N"
 * log never fires. Analysis keeps returning 200 with findings in the body, the learner keeps seeing
 * them in the panel, and NOTHING is ever persisted — so no teacher ever reviews one and no approved
 * finding ever reaches anybody. A silent, total, indefinite failure of the review loop, produced by
 * renaming a field in a service whose tests would all still pass.
 *
 * Neither side's own suite can see this: ml-inference tests what it emits, platform-api's
 * integration tests use a mock ML service that this repo also writes. The two agree with themselves.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const ML_PROXY = readFileSync(
  join(repo, "services", "platform-api", "src", "handlers", "ml_proxy.rs"),
  "utf8",
);
const TAJWEED_JS = readFileSync(join(repo, "services", "ml-inference", "tajweed.js"), "utf8");

/** The body of `persist_tajweed_findings`, so a `finding.get()` elsewhere in the file is not read. */
function persistBody(source) {
  const start = source.indexOf("async fn persist_tajweed_findings");
  assert.notEqual(start, -1, "persist_tajweed_findings is gone from ml_proxy.rs");
  const next = source.indexOf("\nasync fn ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

/** Every field name the Rust persist path reads off an individual finding. */
function consumedFields(source) {
  return new Set([...persistBody(source).matchAll(/finding\s*\.\s*get\("([^"]+)"\)/g)].map((m) => m[1]));
}

// A word ending in a bare noon — enough to trigger the ghunnah rule. Escapes, never literal
// combining marks: AGENTS.md, and the merged-range bug in forced_align.py that rule came from.
const WORD_WITH_A_FINDING = "من";

test("ml-inference emits every field the platform-api persist path reads", () => {
  const findings = analyzeWord("1:1:1", WORD_WITH_A_FINDING);
  assert.ok(findings.length > 0, "the fixture word no longer produces a finding; pick another");

  const consumed = consumedFields(ML_PROXY);
  assert.ok(
    consumed.has("wordId") && consumed.size >= 5,
    `expected the persist path to read several fields, found ${JSON.stringify([...consumed])} — ` +
      "if it was rewritten to deserialize into a struct, replace this extraction with that struct",
  );

  for (const finding of findings) {
    const missing = [...consumed].filter((field) => finding[field] === undefined);
    assert.deepEqual(
      missing,
      [],
      `ml-inference emits a finding without ${JSON.stringify(missing)}, which ` +
        "persist_tajweed_findings reads by name. Anything it cannot find is skipped silently: the " +
        `finding is shown to the learner and never written down. Emitted: ${JSON.stringify(Object.keys(finding))}`,
    );
  }
});

test("every severity ml-inference can emit survives the persist path's allowlist", () => {
  // ml_proxy.rs SKIPS a finding whose severity is not one of these — the column has a CHECK
  // constraint and an unknown value would be a 500 on a learner's request. Correct, and it means a
  // new severity added to tajweed.js alone would be dropped rather than stored.
  const allowlist = ML_PROXY.match(/const SEVERITIES: \[&str; \d+\] = \[([^\]]+)\]/);
  assert.ok(allowlist, "the SEVERITIES allowlist is gone from ml_proxy.rs");
  const allowed = new Set([...allowlist[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

  const emitted = new Set([...TAJWEED_JS.matchAll(/severity:\s*"([^"]+)"/g)].map((m) => m[1]));
  assert.ok(emitted.size > 0, "no severity literals found in tajweed.js; the extraction broke");

  const dropped = [...emitted].filter((s) => !allowed.has(s));
  assert.deepEqual(
    dropped,
    [],
    `tajweed.js emits ${JSON.stringify(dropped)}, which the persist path silently discards. ` +
      `It accepts ${JSON.stringify([...allowed])}. Add the value to the DB CHECK constraint and ` +
      "the allowlist, or do not emit it.",
  );
});
