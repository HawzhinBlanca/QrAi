/**
 * N10 — `POST /v1/learner/progress` and `GET /v1/learner/progress/weekly`.
 * specs/migration-completion/plan.md §2
 *
 *   NODE_API_PORTED="POST /v1/learner/progress,GET /v1/learner/progress/weekly" \
 *     node --test tests/api-parity/progress-parity.test.mjs
 *
 * The POST is the first ported route that WRITES, and the first whose response embeds `now()`.
 * `assertABMutating` exists for it — see the note there on why an identical request to both sides
 * would be the wrong experiment.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertAB, assertABMutating } from "./lib/ab.mjs";
import { TENANT, queryJson, request, startApi, startShell, uniqueSuffix } from "./lib/harness.mjs";

let api;
let shell;
/**
 * The RUST url, which is not `rustUrl`.
 *
 * Under `PARITY_THROUGH_SHELL=1` — the configuration in which this file's A/B is the only thing that
 * proves anything about the port — `startApi` puts a Node shell in front of the binary and returns
 * the SHELL as `baseUrl`, exposing Rust as `upstreamUrl`. Wiring `startShell({ upstream:
 * rustUrl })` and differing against `rustUrl` therefore put Node on BOTH sides of every
 * `assertAB`: a shell in front of a shell, compared with that inner shell. Identical code cannot
 * disagree with itself, so the probes passed by construction.
 *
 * Measured before this was fixed: a `NODE_ONLY_FIELD` added to Node's `listSurahs` response — a
 * divergence a byte comparison cannot miss — left `assertAB` GREEN in both verify.sh passes. What
 * caught it was a literal key-list assertion beside the probe, which is not a comparison at all.
 */
let rustUrl;

before(async () => {
  api = await startApi({});
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl });
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

const learner = { role: "learner" };

/** Blank only what provably varies: the wall clock, and the per-side subject id. */
function normalizeProgress(body) {
  if (!body || typeof body !== "object") return body;
  return { ...body, nextReviewAt: "<TIME>", ayahRef: "<AYAH>" };
}

test("POST /v1/learner/progress — same SM-2 result on both, for a first-ever review", async () => {
  const suffix = uniqueSuffix();
  await assertABMutating(shell.baseUrl, rustUrl, {
    name: "POST progress (first review, quality 5)",
    probeFor: (side) => ({
      path: "/v1/learner/progress",
      method: "POST",
      ...learner,
      body: { quality: 5, ayahRef: `2:${suffix}-${side}` },
    }),
    normalize: normalizeProgress,
  });
});

test("the SM-2 progression matches Rust step for step, not just on the first review", async () => {
  // One review proves almost nothing: SM-2's interesting behaviour is the RECURRENCE — 1, 6, then
  // round(interval * EF), with EF itself drifting. Drive the same quality sequence into both and
  // compare every step.
  const suffix = uniqueSuffix();
  const qualities = [5, 4, 5, 3, 2, 5, 5];
  const seen = { shell: [], rust: [] };

  for (const [i, quality] of qualities.entries()) {
    for (const [side, baseUrl] of [
      ["shell", shell.baseUrl],
      ["rust", rustUrl],
    ]) {
      const res = await request(baseUrl, "/v1/learner/progress", {
        method: "POST",
        ...learner,
        body: { quality, ayahRef: `3:${suffix}-${side}` },
      });
      assert.equal(res.status, 200, `${side} step ${i} (quality ${quality})`);
      seen[side].push(res.body.sm2State);
    }
  }

  assert.deepEqual(seen.shell, seen.rust, "the SM-2 state diverged somewhere in the sequence");
  // Pin the shape too, so a port that returned an empty object at every step would not "match".
  assert.deepEqual(Object.keys(seen.shell[0]), ["easinessFactor", "intervalDays", "repetitions"]);
  assert.equal(seen.shell[0].intervalDays, 1, "first review is always a 1-day interval");
  assert.equal(seen.shell[1].intervalDays, 6, "second review is always 6 days");
  assert.equal(seen.shell[4].repetitions, 0, "quality 2 is a failure and RESETS repetitions");
});

/**
 * The gap the normalizer left open.
 *
 * `normalizeProgress` replaces `nextReviewAt` with a placeholder, because two calls a millisecond
 * apart legitimately differ. That is correct — and it meant the A/B could not see that the port was
 * emitting `.384` where Rust emits `.366908`: three fractional digits against six, on EVERY
 * response, because a JS `Date` holds milliseconds. The bug was found later in N14a, where nothing
 * was normalized, and traced back here.
 *
 * A timestamp's VALUE cannot be compared. Its PRECISION can. Four calls are enough: the odds of
 * four consecutive timestamps landing on a whole millisecond are about 1e-12.
 */
test("nextReviewAt carries microsecond precision, like chrono — not millisecond", async () => {
  const suffix = uniqueSuffix();
  const digits = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await request(shell.baseUrl, "/v1/learner/progress", {
      method: "POST",
      ...learner,
      body: { quality: 5, ayahRef: `7:${suffix}-${i}` },
    });
    assert.equal(res.status, 200, res.text);
    digits.push((res.body.nextReviewAt.match(/\.(\d+)/) ?? [, ""])[1].length);
  }
  assert.ok(
    digits.some((d) => d > 3),
    `every nextReviewAt had <=3 fractional digits (${digits.join(",")}). A JS Date holds ` +
      "milliseconds; the timestamp must be generated and formatted by Postgres.",
  );
});

test("quality is clamped to 0..5 BEFORE it is stored, not just before sm2_update", async () => {
  // learner_progress.last_quality has CHECK (0..5). An unclamped write violates it and fails the
  // whole request with a 500 instead of persisting the review.
  const suffix = uniqueSuffix();
  await assertABMutating(shell.baseUrl, rustUrl, {
    name: "POST progress (quality 99)",
    probeFor: (side) => ({
      path: "/v1/learner/progress",
      method: "POST",
      ...learner,
      body: { quality: 99, ayahRef: `4:${suffix}-${side}` },
    }),
    normalize: normalizeProgress,
  });

  const res = await request(shell.baseUrl, "/v1/learner/progress", {
    method: "POST",
    ...learner,
    body: { quality: 99, ayahRef: `5:${suffix}` },
  });
  assert.equal(res.status, 200, "an out-of-range quality must not 500");
  assert.equal(res.body.quality, 5, "the response reports the CLAMPED value, not the input");

  const rows = await queryJson(
    "SELECT last_quality FROM learner_progress WHERE tenant_id = $1 AND ayah_ref = $2",
    [TENANT, `5:${suffix}`],
  );
  assert.equal(rows[0].last_quality, 5, "the stored value must satisfy the CHECK constraint");
});

/**
 * The lost-update race, and the lock that closes it.
 *
 * `update_progress` READS the prior SM-2 state, computes the next state in application code, then
 * WRITES it — two round trips. `INSERT … ON CONFLICT DO UPDATE` alone does not make that atomic:
 * two concurrent reviews of the same ayah both read the same prior state and the second clobbers
 * the first. The Rust handler takes `pg_advisory_xact_lock(hashtext(key))` to serialize the whole
 * section, and the comment there records the empirical result without it — 8 concurrent quality=5
 * submissions left repetitions=4, so half the reviews vanished.
 *
 * A port that omits the lock passes every single-request test in this file.
 */
test("concurrent reviews of the SAME ayah do not lose updates", async () => {
  const suffix = uniqueSuffix();
  const ayahRef = `6:${suffix}`;
  const N = 8;

  const results = await Promise.all(
    Array.from({ length: N }, () =>
      request(shell.baseUrl, "/v1/learner/progress", {
        method: "POST",
        ...learner,
        body: { quality: 5, ayahRef },
      }),
    ),
  );
  for (const r of results) assert.equal(r.status, 200);

  const rows = await queryJson(
    "SELECT repetitions FROM learner_progress WHERE tenant_id = $1 AND ayah_ref = $2",
    [TENANT, ayahRef],
  );
  assert.equal(
    rows[0].repetitions,
    N,
    `${N} successful reviews must leave repetitions=${N}. A lower number means concurrent ` +
      "read-compute-write cycles clobbered each other — the advisory lock is missing or ineffective",
  );
});

test("GET /v1/learner/progress/weekly is byte-identical", async () => {
  await assertAB(shell.baseUrl, rustUrl, { path: "/v1/learner/progress/weekly", ...learner });
});

test("weekly: a learner may not read another learner's week; staff may", async () => {
  for (const probe of [
    { path: "/v1/learner/progress/weekly?learnerId=learner-someone-else", ...learner },
    { path: "/v1/learner/progress/weekly?learnerId=learner-someone-else", role: "teacher" },
    { path: "/v1/learner/progress/weekly?learnerId=learner-someone-else", role: "scholar" },
  ]) {
    await assertAB(shell.baseUrl, rustUrl, probe);
  }
});

test("weekly: a scholar is refused at the FIRST gate, before ownership is considered", async () => {
  // Two gates with DIFFERENT lists: require_any([learner, teacher, admin, ops]) then
  // require_self_or_any(id, [teacher, admin, ops]). A scholar fails the first. Collapsing them
  // into one check would silently admit scholars to their own row.
  const res = await request(shell.baseUrl, "/v1/learner/progress/weekly", { role: "scholar" });
  assert.equal(res.status, 403);
});

test("a scholar is refused on GET /v1/learner/progress too, not only on weekly", async () => {
  // The SAME two-gate structure guards both progress routes — require_any([learner, teacher,
  // admin, ops]) then require_self_or_any(id, [teacher, admin, ops]) — and until now only WEEKLY
  // was ever probed with a scholar. `handlers/progress.rs:81` carries the note that its author's
  // first attempt put scholar in the allowlist, "which would have been a real privilege widening".
  // The route where that was caught by hand is the one nothing checked.
  //
  // Asserted A/B: a Node port that widened the list on this route only would otherwise diverge in
  // silence, since no probe here ever sent a scholar.
  await assertAB(shell.baseUrl, rustUrl, { path: "/v1/learner/progress", role: "scholar" });

  const res = await request(shell.baseUrl, "/v1/learner/progress", { role: "scholar" });
  assert.equal(res.status, 403, "a scholar reached the learner progress route");

  // ...and refused at the FIRST gate, so the refusal cannot be mistaken for an ownership failure
  // that a scholar might pass by asking for their own id.
  const own = await request(shell.baseUrl, "/v1/learner/progress?learnerId=scholar-1", { role: "scholar" });
  assert.equal(own.status, 403, "a scholar asking for their OWN row got past the first gate");
});

test("the weekly day shape is pinned — accuracy is null, not 0, when no words were aligned",
  async () => {
    const res = await request(shell.baseUrl, "/v1/learner/progress/weekly", learner);
    assert.equal(res.status, 200);
    // Alphabetical, not the order the `json!` literal is written in: serde_json without
    // preserve_order is BTreeMap-backed. Asserted from the real response, not from reading the Rust.
    assert.deepEqual(Object.keys(res.body), ["days", "learnerId", "tenantId"]);
    for (const day of res.body.days) {
      assert.deepEqual(Object.keys(day), [
        "accuracy",
        "date",
        "sessions",
        "wordsMatched",
        "wordsSelfReported",
        "wordsTotal",
      ]);
      if (day.wordsTotal === 0) {
        assert.equal(day.accuracy, null, "0/0 is unknown accuracy, not 0% — rendering 0% is a lie");
      }
      // ADR-0030: `wordsTotal` is server-derived words only. A day whose practice was all
      // self-reported must therefore report accuracy: null — never a measured-looking number over
      // words the server never heard.
      assert.ok(
        day.wordsMatched <= day.wordsTotal,
        `matched (${day.wordsMatched}) exceeds measured total (${day.wordsTotal}) — the two ` +
          `counters are reading different populations, so accuracy can exceed 100%`,
      );
    }
  });
