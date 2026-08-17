import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * P3.2 — output derived from a FIXTURE must say so, and must never become a learner finding.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────────────────────────
 * `ML_USE_GOLDEN_FIXTURES=1` makes the inference runtime answer from `fixtures/golden-evals.json`
 * instead of analysing anything. Measured against the running service on one identical request:
 *
 *   default   29 alignments, first word `needs-review`, heardText differs   · 38 tajweed findings
 *   fixture    8 alignments, EVERY word `matched`, heardText === canonical  ·  1 tajweed finding
 *
 * — a flawless recitation nobody performed. Both responses carried an IDENTICAL set of top-level
 * keys, and both set `fixtureCaseId: "fatihah-1-1-7-smoke"`, because that field means "the requested
 * passage matches a golden case", which is true on the real path too. So the one field that LOOKS
 * like provenance gives a false positive on every golden reference passage.
 *
 * Those findings persisted as `analysis_basis = 'canonical-text'`, indistinguishable from analysis
 * of a child's recitation — permanently, since unsetting the flag does not un-write the rows.
 *
 * ── How this is now prevented, and why this file changed ────────────────────────────────────────
 * #440 fixed it by LABELLING: bind `analysis_basis` from the response so a stored row stays
 * distinguishable. ADR-0044 (#388) retired `services/ml-inference` and `services/node-api` into
 * `server/`, and closed the same hole STRUCTURALLY instead — which is strictly stronger, because a
 * label only helps someone who reads it:
 *
 *   1. `predictTajweed` returns `findings: []` unconditionally. Fixture rules — and canonical rules
 *      generally — surface as INSTRUCTIONAL annotations (`analysisBasis: "text-rule"`), which are
 *      not a performance claim and are never persisted.
 *   2. `requireTajweedSemantics` (Node) and `require_tajweed_semantics` (Rust) refuse any finding
 *      whose `analysisBasis` is not `"acoustic"`, so fixture output cannot enter the persist path
 *      even if an upstream fabricated it.
 *   3. Persisting additionally demands a release-eligible `eval_runs` row whose artifact digests
 *      match the finding.
 *   4. Migration 0030 narrows the CHECK to ('text-rule','acoustic'). `'fixture'` is not a storable
 *      basis, by construction.
 *
 * So the assertions below moved from "the stored row is labelled fixture" to "nothing fixture-
 * derived can be stored at all", and the payload label is still asserted because a caller receiving
 * fixture output must still be told.
 *
 * Hermetic: one child process, no database, no network beyond loopback.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const PORT = 8401;
const API_KEY = "fixture-provenance-test";

const REQUEST = {
  tenantId: "tenant-internal",
  sessionId: "session-fixture-provenance",
  learnerId: "learner-fixture-provenance",
  // The golden case. Chosen deliberately: on any OTHER passage the two modes diverge anyway
  // because no fixture matches, so a passage with no golden case could not tell them apart.
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
};

async function withService(env, body) {
  // The compatibility ingress harness is what `services/ml-inference/server.mjs` became: same two
  // endpoints, same single shared ML_API_KEY, over real HTTP. The claim is about what a caller
  // RECEIVES, and the previous state of this code would have passed any test that inspected the
  // fixture branch in isolation — so this still goes over the wire rather than importing the branch.
  const child = spawn(process.execPath, [join(root, "tests/inference/lib/worker-compatibility-harness.mjs")], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ML_INFERENCE_PORT: String(PORT),
      ML_API_KEY: API_KEY,
      AUDIO_STORAGE_DIR: mkdtempSync(join(tmpdir(), "fixture-provenance-")),
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    // Poll rather than sleep a fixed interval: a fixed wait is either slow or flaky, and on a busy
    // runner it is both.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (health.ok) break;
      } catch {
        /* not listening yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await body(async (path) => {
      const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ml-api-key": API_KEY },
        body: JSON.stringify(REQUEST),
      });
      assert.equal(response.status, 200, `${path} answered ${response.status}\n${stderr}`);
      return response.json();
    });
  } finally {
    child.kill("SIGKILL");
  }
}

const FIXTURE_ENV = { ML_USE_GOLDEN_FIXTURES: "1", ML_ACKNOWLEDGE_FIXTURE_OUTPUT: "1" };

test("fixture-derived output declares itself as fixture-derived", async () => {
  await withService(FIXTURE_ENV, async (post) => {
    const alignment = await post("/v1/alignments:predict");
    const tajweed = await post("/v1/tajweed-findings:predict");

    assert.equal(alignment.provenance, "fixture");
    assert.equal(tajweed.provenance, "fixture");

    // The thing the label is ABOUT, asserted rather than assumed: this really is the flawless
    // recitation. Without it the test would still pass if fixture mode stopped doing anything.
    assert.ok(alignment.alignments.length > 0, "fixture mode returned no alignments at all");
    assert.ok(
      alignment.alignments.every((word) => word.status === "matched" && word.heardText === word.canonicalText),
      "fixture mode no longer returns a flawless recitation — the label's subject has changed",
    );
  });
});

test("real analysis declares itself computed, on the same passage", async () => {
  // The control, and the reason the request targets a golden case. `fixtureCaseId` is set here too;
  // if `provenance` behaved the same way it would be just as useless.
  await withService({}, async (post) => {
    const alignment = await post("/v1/alignments:predict");
    const tajweed = await post("/v1/tajweed-findings:predict");

    assert.equal(alignment.provenance, "computed");
    assert.equal(tajweed.provenance, "computed");
    assert.equal(
      alignment.fixtureCaseId,
      "fatihah-1-1-7-smoke",
      "the premise of this test is that fixtureCaseId is set on the REAL path too; if that has " +
        "changed, provenance may no longer be the only field that distinguishes the two",
    );
  });
});

test("the two modes differ in the payload, not only in the label", async () => {
  // A label that could be applied to identical output would prove nothing. The measured difference
  // now lives in the ALIGNMENTS — fixture mode answers about a passage with a recitation nobody
  // performed, the real path answers about a session — because findings are empty on both paths.
  const fixture = await withService(FIXTURE_ENV, (post) => post("/v1/alignments:predict"));
  const computed = await withService({}, (post) => post("/v1/alignments:predict"));

  assert.notDeepEqual(
    fixture.alignments,
    computed.alignments,
    "both modes returned identical alignments; if the fixture and the analyser have converged, " +
      "this file is no longer testing what it claims to",
  );
  assert.ok(
    !computed.alignments.every((word) => word.status === "matched" && word.heardText === word.canonicalText),
    "the REAL path returned a flawless recitation, which is the fixture's signature, not analysis",
  );
});

test("fixture output is never a learner finding, in either mode", async () => {
  // The structural half of P3.2 (ADR-0044). A finding is a claim about how THIS learner recited;
  // a fixture cannot support one, so the runtime does not emit findings at all and the fixture's
  // rules arrive as instruction. This is what replaced #440's "label the stored row".
  for (const [label, env] of [["fixture", FIXTURE_ENV], ["computed", {}]]) {
    await withService(env, async (post) => {
      const tajweed = await post("/v1/tajweed-findings:predict");

      assert.deepEqual(
        tajweed.findings,
        [],
        `${label} mode emitted tajweed findings; a finding is a performance claim and neither a ` +
          "fixture nor a canonical-text rule can support one",
      );
      assert.ok(tajweed.annotations.length > 0, `${label} mode returned no annotations at all`);
      assert.ok(
        tajweed.annotations.every(
          (annotation) => annotation.analysisBasis === "text-rule" && annotation.instructional === true,
        ),
        `${label} mode returned an annotation that is not instructional text-rule`,
      );
      // An annotation carrying performance fields would be a finding wearing instruction's label.
      assert.ok(
        tajweed.annotations.every(
          (annotation) => !["confidence", "severity", "reviewStatus"].some((f) => Object.hasOwn(annotation, f)),
        ),
        `${label} mode returned an instructional annotation carrying performance fields`,
      );
    });
  }
});

test("neither persistence path can write a fixture-derived basis", () => {
  // Both backends are held to this (ADR-0044), because a one-sided fix leaves one port storable
  // while the other is not — the exact divergence the parity guards exist to catch.
  //
  // The guarantee is no longer "the basis is bound from the response" but the stronger "only
  // `acoustic` reaches the table, and only after the semantics gate has proved the item is one".
  const rust = readFileSync(join(root, "services/platform-api/src/handlers/ml_proxy.rs"), "utf8");
  const node = readFileSync(join(root, "server/src/routes/ml-proxy.mjs"), "utf8");

  assert.match(
    node,
    /analysisBasis !== "acoustic"/,
    "the Node semantics gate no longer refuses non-acoustic findings",
  );
  assert.match(
    rust,
    /!= Some\("acoustic"\)/,
    "the Rust semantics gate no longer refuses non-acoustic findings",
  );

  // Neither INSERT may take its basis from the upstream response: after the gate above, `acoustic`
  // is the only correct value, and reading it back from the payload would re-open the hole.
  assert.match(node, /\$\{auditId\}, 'acoustic'/, "the Node INSERT no longer writes the acoustic literal");
  assert.match(rust, /\$10, 'acoustic'/, "the Rust INSERT no longer writes the acoustic literal");
  assert.doesNotMatch(node, /analysis_basis\s*=\s*result/, "the Node INSERT reads its basis from the response");
});

test("`fixture` is not a storable basis, in the schema", () => {
  // The code half is only trustworthy if the database agrees. 0030 draws the instruction/performance
  // boundary; a later migration widening it back would silently undo everything above.
  const migrations = join(root, "infra/migrations");
  const boundary = readFileSync(join(migrations, "0030_tajweed_instruction_performance_boundary.sql"), "utf8");

  assert.match(
    boundary,
    /check \(analysis_basis in \('text-rule', 'acoustic'\)\)/,
    "0030 no longer constrains analysis_basis to the instruction/performance pair",
  );

  // And nothing after it may re-admit `fixture`. This is the §0 trap from the #388 merge: main's
  // 0028 added `fixture`, 0030 removed it, and a merge that kept both would have left code writing
  // a value the CHECK rejects.
  for (const name of readdirSync(migrations).filter((f) => f.endsWith(".sql") && f > "0030")) {
    const sql = readFileSync(join(migrations, name), "utf8");
    assert.doesNotMatch(
      sql,
      /analysis_basis in \([^)]*'fixture'/,
      `${name} re-admits 'fixture' as an analysis_basis, undoing 0030`,
    );
  }
});
