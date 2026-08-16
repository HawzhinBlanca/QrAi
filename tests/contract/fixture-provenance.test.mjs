import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * P3.2 — output derived from a FIXTURE must say so, in the payload and in the row. (Migration 0028)
 *
 * ── What was wrong ──────────────────────────────────────────────────────────────────────────────
 * `ML_USE_GOLDEN_FIXTURES=1` makes ml-inference answer from `fixtures/golden-evals.json` instead of
 * analysing anything. Measured against the running service on one identical request:
 *
 *   default   29 alignments, first word `needs-review`, heardText differs   · 38 tajweed findings
 *   fixture    8 alignments, EVERY word `matched`, heardText === canonical  ·  1 tajweed finding
 *
 * — a flawless recitation nobody performed. Both responses carried an IDENTICAL set of top-level
 * keys, and both set `fixtureCaseId: "fatihah-1-1-7-smoke"`, because that field means "the requested
 * passage matches a golden case", which is true on the real path too. So the one field that LOOKS
 * like provenance gives a false positive on every golden reference passage, and there was nothing
 * else to read.
 *
 * The findings persist. `persist_tajweed_findings` wrote every one as `analysis_basis =
 * 'canonical-text'`, indistinguishable from analysis of a child's recitation — permanently, since
 * unsetting the flag does not un-write the rows.
 *
 * ── What this file holds ────────────────────────────────────────────────────────────────────────
 * The service itself, over HTTP, in both configurations. Not a unit test of the branch: the claim is
 * about what a caller RECEIVES, and the previous state of this code would have passed any test that
 * inspected the fixture branch in isolation.
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
  const child = spawn(process.execPath, [join(root, "services/ml-inference/server.mjs")], {
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
  // A label that could be applied to identical output would prove nothing. This pins the measured
  // difference: fixture mode answers about a passage, the real path answers about a session.
  const fixture = await withService(FIXTURE_ENV, (post) => post("/v1/tajweed-findings:predict"));
  const computed = await withService({}, (post) => post("/v1/tajweed-findings:predict"));

  assert.notEqual(
    fixture.findings.length,
    computed.findings.length,
    `both modes returned ${fixture.findings.length} findings; if the fixture and the analyser have ` +
      "converged, this file is no longer testing what it claims to",
  );
});

test("both persistence paths bind the basis instead of hardcoding canonical-text", () => {
  // The label is only worth setting because it reaches the database. Both backends are held to it
  // (ADR-0044), because a one-sided fix leaves the Node port writing `canonical-text` for fixture
  // output while the Rust one records it — the exact divergence `assertABMutating` exists to catch.
  const rust = readFileSync(join(root, "services/platform-api/src/handlers/ml_proxy.rs"), "utf8");
  const node = readFileSync(join(root, "services/node-api/routes/ml-proxy.mjs"), "utf8");

  assert.match(rust, /Some\("fixture"\) => "fixture"/, "the Rust path no longer records fixture provenance");
  assert.match(node, /provenance === "fixture" \? "fixture" : "canonical-text"/, "the Node path no longer records it");

  // And neither may go back to writing the literal into the INSERT.
  assert.doesNotMatch(
    rust,
    /audit_event_id, analysis_basis\)\s*\n\s*VALUES[^"]*'canonical-text'\)/,
    "the Rust INSERT hardcodes analysis_basis again",
  );
  assert.doesNotMatch(node, /\$\{auditId\}, 'canonical-text'\)/, "the Node INSERT hardcodes analysis_basis again");
});

test("the database accepts `fixture` as a basis, and the migration is applied by CI", () => {
  // A value the code writes and the CHECK constraint rejects is a 500 on a learner's analysis
  // request, and CI's migration list is what decides whether the constraint exists there at all.
  const migration = readdirSync(join(root, "infra/sql")).find((name) => name.includes("fixture_basis"));
  assert.ok(migration, "the migration adding `fixture` to the analysis_basis CHECK is gone");

  const sql = readFileSync(join(root, "infra/sql", migration), "utf8");
  assert.match(sql, /'canonical-text',\s*'acoustic',\s*'fixture'/, "the CHECK no longer allows all three bases");

  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.ok(
    ci.includes(`infra/sql/${migration}`),
    `${migration} is not in ci.yml's apply list, so the constraint would not exist on CI`,
  );
});
