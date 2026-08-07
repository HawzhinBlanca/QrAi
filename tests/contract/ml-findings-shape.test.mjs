import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzeWord } from "../../server/src/inference/tajweed.mjs";

/**
 * W1.9 — deterministic Quran instruction and learner-performance findings are disjoint types.
 *
 * The text-rule detector sees no learner audio. Its output must therefore never satisfy either
 * persistence path. Acoustic findings remain persistable for the declared evaluation fixture and
 * the future real acoustic producer, but only after the runtime boundary validates their basis.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const RUST_PROXY = readFileSync(
  join(repo, "services", "platform-api", "src", "handlers", "ml_proxy.rs"),
  "utf8",
);
const NODE_PROXY = readFileSync(
  join(repo, "server", "src", "routes", "ml-proxy.mjs"),
  "utf8",
);

// A bare final noon triggers a real deterministic rule. Arabic combining classes remain escaped in
// the detector itself; this fixture contains letters only and is not canonical corpus text.
const WORD_WITH_INSTRUCTION = "من";

test("deterministic Tajweed output is instructional and carries no performance fields", () => {
  const annotations = analyzeWord("1:1:1", WORD_WITH_INSTRUCTION);
  assert.ok(annotations.length > 0, "the fixture word no longer produces instruction");

  for (const annotation of annotations) {
    assert.equal(annotation.analysisBasis, "text-rule");
    assert.equal(annotation.instructional, true);
    assert.ok(annotation.sources.length > 0, "instruction lost its source");
    for (const forbidden of ["confidence", "severity", "reviewStatus"]) {
      assert.equal(
        Object.hasOwn(annotation, forbidden),
        false,
        `text-rule annotation invented learner-performance field ${forbidden}`,
      );
    }
  }
});

test("both runtime boundaries validate the disjoint annotations/findings envelope", () => {
  for (const [name, source] of [
    ["rust", RUST_PROXY],
    ["node", NODE_PROXY],
  ]) {
    assert.match(source, /annotations/, `${name}: no annotations boundary`);
    assert.match(source, /findings/, `${name}: no findings boundary`);
    assert.match(source, /text-rule/, `${name}: no text-rule validation`);
    assert.match(source, /instructional/, `${name}: no instructional validation`);
    assert.match(source, /acoustic/, `${name}: no acoustic validation`);
    for (const forbidden of ["confidence", "severity", "reviewStatus"]) {
      assert.match(
        source,
        new RegExp(forbidden),
        `${name}: the boundary no longer checks performance field ${forbidden}`,
      );
    }
  }
});

test("both persistence paths consume only findings and write an acoustic basis literal", () => {
  const rustPersist = RUST_PROXY.slice(RUST_PROXY.indexOf("async fn persist_tajweed_findings"));
  const nodePersist = NODE_PROXY.slice(NODE_PROXY.indexOf("async function persistTajweedFindings"));

  assert.match(rustPersist, /get\("findings"\)/, "Rust persistence does not read findings[]");
  assert.doesNotMatch(rustPersist, /get\("annotations"\)/, "Rust persistence reads annotations[]");
  assert.match(rustPersist, /'acoustic'/, "Rust persistence does not write acoustic literally");
  assert.doesNotMatch(rustPersist, /\.clamp\(/, "Rust persistence still clamps model scores");
  assert.match(rustPersist, /evaluation_evidence_id/, "Rust persistence drops evaluation provenance");

  assert.match(nodePersist, /result\.findings/, "Node persistence does not read findings[]");
  assert.doesNotMatch(nodePersist, /result\.annotations/, "Node persistence reads annotations[]");
  assert.match(nodePersist, /'acoustic'/, "Node persistence does not write acoustic literally");
  assert.doesNotMatch(nodePersist, /Math\.min\(1/, "Node persistence still clamps model scores");
  assert.match(nodePersist, /evaluation_evidence_id/, "Node persistence drops evaluation provenance");
});
