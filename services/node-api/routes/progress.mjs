/**
 * Learner progress. Port of services/platform-api/src/handlers/progress.rs.
 *
 * `GET /v1/learner/progress` was N4; N7 moved it here unchanged. The comments are the expensive
 * part of this file — each one records a wire-format finding an A/B against Rust produced, not a
 * reading of the Rust source.
 */
import { ApiError, requireAnyRole, requireSelfOrAny, resolveActor } from "../lib/authz.mjs";
import { f64 } from "../lib/json.mjs";
import { proxy } from "../lib/proxy.mjs";

/** GET /v1/learner/progress — handlers/progress.rs:81 */
export async function getLearnerProgress(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  // TWO gates, with DIFFERENT lists — handlers/progress.rs:81-96. A scholar fails the first one;
  // collapsing them into a single check would silently grant scholars access.
  requireAnyRole(actor, ["learner", "teacher", "admin", "ops"]);
  const requested = req.query.learnerId;
  const learnerId = requested ?? actor.userId;
  if (requested !== undefined) {
    // Note the allowlist: teacher/admin/ops, NOT scholar. Transcribed from the Rust, not guessed
    // — my first attempt included scholar, which would have been a real privilege widening.
    requireSelfOrAny(actor, requested, ["teacher", "admin", "ops"]);
  }

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [{ count: totalSessions }] = await tx`
      SELECT COUNT(*)::int AS count FROM recitation_sessions
      WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;

    const reps = await tx`
      SELECT repetitions FROM learner_progress
      WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;

    // Mean per-card min(repetitions/4, 1), rounded to 3 decimals — inlined in the Rust handler
    // (progress.rs:119-124), so it is pinned here rather than re-derived.
    const mastery =
      reps.length === 0
        ? 0
        : Math.round(
            (reps.reduce((a, r) => a + Math.min(r.repetitions / 4, 1), 0) / reps.length) * 1000,
          ) / 1000;

    // chrono's `to_rfc3339()` renders `+00:00`, NOT the `Z` that Date#toISOString produces, and
    // it prints 0/3/6 fractional digits (SecondsFormat::AutoSi). Formatting this in Postgres and
    // trimming the same way is the only thing that keeps the wire value identical.
    const [{ base, us }] = await tx`
      SELECT to_char(MIN(next_review_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS base,
             (EXTRACT(microseconds FROM MIN(next_review_at))::bigint % 1000000) AS us
      FROM learner_progress
      WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;

    const days = await tx`
      SELECT DISTINCT (started_at AT TIME ZONE 'UTC')::date AS d
      FROM recitation_sessions
      WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}
      ORDER BY d DESC`;

    // serde_json is built without `preserve_order`, so `json!` serializes keys ALPHABETICALLY.
    // Insertion order here is therefore part of matching the Rust bytes, not a style choice.
    return {
      learnerId,
      mastery: f64(mastery),
      nextReviewAt: base === null ? null : `${base}${fractional(Number(us))}+00:00`,
      streak: computeStreak(days.map((r) => r.d)),
      tenantId: actor.tenantId,
      totalSessions,
    };
  });

  return reply.send(body);
}

/**
 * SM-2. Port of `sm2_update` (progress.rs:31).
 *
 * The arithmetic is transcribed, not re-derived from a description of SM-2 — implementations differ
 * in exactly the places that matter here (whether a failure resets the easiness factor, whether the
 * second interval is 6 days or `1 * EF`), and the recurrence is what a learner's whole schedule is
 * built on. `progress-parity.test.mjs` drives a 7-step quality sequence into both implementations
 * and compares every step, because one review would agree by accident.
 */
export function sm2Update(state, quality) {
  const q = Math.min(quality, 5);

  if (q < 3) {
    // Failed — reset. Note the easiness factor is CARRIED, not reset: a learner who forgets one
    // ayah does not lose the difficulty estimate built from every prior review of it.
    return { easinessFactor: state.easinessFactor, intervalDays: 1, repetitions: 0 };
  }

  const repetitions = state.repetitions + 1;
  // Cap at 10 years. Unbounded, the interval grows by ×EF every perfect review and eventually
  // overflows chrono when added to now(), panicking the request.
  const MAX_INTERVAL_DAYS = 3650;
  const intervalDays =
    repetitions === 1
      ? 1
      : repetitions === 2
        ? 6
        : Math.min(Math.round(state.intervalDays * state.easinessFactor), MAX_INTERVAL_DAYS);

  const easinessFactor = Math.max(
    state.easinessFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)),
    1.3,
  );

  return { easinessFactor, intervalDays, repetitions };
}

const SM2_DEFAULT = { easinessFactor: 2.5, intervalDays: 1, repetitions: 0 };

/**
 * POST /v1/learner/progress — progress.rs:277
 *
 * ── No ownership check, deliberately ────────────────────────────────────────────────────────────
 * `ProgressUpdate` has no learnerId field: this ALWAYS writes the caller's own row. A prior version
 * of the Rust called `require_self_or_any(&actor.user_id, …)`, comparing the actor's id to itself —
 * a tautology that always passed and read as an authz gate without being one. A valid tenant-scoped
 * token is the only check this handler needs, and adding a fake one back would be worse than none.
 */
export async function updateProgress(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  const ayahRef = req.body?.ayahRef;
  const rawQuality = req.body?.quality;
  if (typeof ayahRef !== "string" || ayahRef === "" || typeof rawQuality !== "number") {
    throw new ApiError("quality and ayahRef are required", 422);
  }

  // Clamp BEFORE use. `sm2Update` clamps internally, but the raw value is also stored in
  // learner_progress.last_quality, which has CHECK (0..5) — an out-of-range input would otherwise
  // violate the constraint and fail the whole write with a 500 instead of persisting the review.
  const quality = Math.min(Math.max(Math.trunc(rawQuality), 0), 5);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    // ── The lock that makes read-compute-write atomic ──────────────────────────────────────────
    // This handler READS the prior state, computes the next state in application code, then WRITES
    // it — two round trips. `INSERT … ON CONFLICT DO UPDATE` alone does NOT close the race: two
    // concurrent reviews of the same (learner, ayah) both read the same prior state before either
    // commits, and the second clobbers the first's progression. The Rust comment records the
    // measurement: 8 concurrent quality=5 submissions left repetitions=4 — half the reviews lost.
    //
    // Auto-released at transaction end. Unlike `SELECT … FOR UPDATE` this also covers a learner's
    // FIRST review of an ayah, where there is no row yet to lock.
    //
    // A port that drops this line passes every single-request test in the suite.
    const lockKey = `progress:${actor.tenantId}:${actor.userId}:${ayahRef}`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

    const [current] = await tx`
      SELECT easiness_factor, interval_days, repetitions FROM learner_progress
      WHERE tenant_id = ${actor.tenantId} AND learner_id = ${actor.userId}
        AND ayah_ref = ${ayahRef}`;

    const prior = current
      ? {
          // numeric/float8 comes back as a string from the driver; Number() matches Rust's f64.
          easinessFactor: Number(current.easiness_factor ?? 2.5),
          intervalDays: Number(current.interval_days ?? 1),
          repetitions: Number(current.repetitions ?? 0),
        }
      : SM2_DEFAULT;

    const updated = sm2Update(prior, quality);
    // Defensive clamp in case a pre-existing row stored a huge interval.
    const days = Math.min(Math.max(updated.intervalDays, 1), 3650);

    // The timestamp is generated and formatted BY POSTGRES, in one statement, and read back with
    // RETURNING.
    //
    // The first version built it as `new Date(Date.now() + …)`. A JS Date holds MILLISECONDS, so
    // the wire value came out as `.384` where Rust — formatting an in-memory chrono value — writes
    // `.366908`. Measured, not assumed: 3 fractional digits against Rust's 6, on every single
    // response. The N10 A/B did not catch it because its normalizer replaced nextReviewAt with a
    // placeholder; the same class of bug then turned up in N14a where nothing was normalized, and
    // that is what sent me back here.
    //
    // `now()` is transaction time rather than chrono's `Utc::now()`, so the INSTANT still differs by
    // microseconds — it always would, and no test can pin it. The PRECISION is what a client sees
    // and it now matches.
    const [{ base, us }] = await tx`
      INSERT INTO learner_progress
        (tenant_id, learner_id, ayah_ref, easiness_factor, interval_days, repetitions,
         last_quality, next_review_at, updated_at)
      VALUES (${actor.tenantId}, ${actor.userId}, ${ayahRef}, ${updated.easinessFactor},
              ${updated.intervalDays}, ${updated.repetitions}, ${quality},
              now() + make_interval(days => ${days}), now())
      ON CONFLICT (tenant_id, learner_id, ayah_ref) DO UPDATE SET
        easiness_factor = ${updated.easinessFactor}, interval_days = ${updated.intervalDays},
        repetitions = ${updated.repetitions}, last_quality = ${quality},
        next_review_at = now() + make_interval(days => ${days}), updated_at = now()
      RETURNING to_char(next_review_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS base,
                (EXTRACT(microseconds FROM next_review_at)::bigint % 1000000) AS us`;

    // json! keys, alphabetical.
    return {
      ayahRef,
      learnerId: actor.userId,
      nextReviewAt: `${base}${fractional(Number(us))}+00:00`,
      quality,
      sm2State: {
        easinessFactor: f64(updated.easinessFactor),
        intervalDays: updated.intervalDays,
        repetitions: updated.repetitions,
      },
      tenantId: actor.tenantId,
    };
  });

  return reply.send(body);
}

/** GET /v1/learner/progress/weekly — progress.rs:165 */
export async function getWeeklyProgress(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  // Same two-gate structure as getLearnerProgress, with the same two DIFFERENT lists. A scholar
  // fails the first one.
  requireAnyRole(actor, ["learner", "teacher", "admin", "ops"]);
  const requested = req.query.learnerId;
  const learnerId = requested ?? actor.userId;
  if (requested !== undefined) {
    requireSelfOrAny(actor, requested, ["teacher", "admin", "ops"]);
  }

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    // word_alignments has no timestamp of its own; a word belongs to the day its session started.
    // LEFT JOIN so a day with sessions but no alignments still appears with a null accuracy.
    // `accuracy` counts ONLY words the server itself transcribed (`transcript_source =
    // 'server-derived'`). The other kind comes from a transcript the CLIENT supplied and a caller
    // can assert a flawless recitation having recited nothing — averaging the two into a figure
    // called "accuracy" is arithmetic over data that means something else. See ADR-0030 and the
    // Rust original in progress.rs, which this must match query-for-query.
    const rows = await tx`
      SELECT (rs.started_at AT TIME ZONE 'UTC')::date AS day,
             COUNT(DISTINCT rs.id) AS sessions,
             COUNT(wa.id) FILTER (WHERE wa.transcript_source = 'server-derived') AS words_total,
             COUNT(wa.id) FILTER (WHERE wa.transcript_source = 'server-derived'
                                    AND wa.status = 'matched') AS words_matched,
             COUNT(wa.id) FILTER (WHERE wa.transcript_source = 'client-reported') AS words_self_reported
      FROM recitation_sessions rs
      LEFT JOIN word_alignments wa
        ON wa.session_id = rs.id AND wa.tenant_id = rs.tenant_id
      WHERE rs.tenant_id = ${actor.tenantId} AND rs.learner_id = ${learnerId}
        AND rs.started_at >= now() - interval '7 days'
      GROUP BY day
      ORDER BY day`;

    return {
      days: rows.map((r) => {
        const wordsTotal = Number(r.words_total ?? 0);
        const wordsMatched = Number(r.words_matched ?? 0);
        return {
          // NULL, not 0, when nothing was aligned. 0/0 is unknown accuracy; rendering it as 0%
          // tells a learner they got everything wrong on a day they simply have no data for.
          accuracy: wordsTotal > 0 ? f64(Math.round((wordsMatched / wordsTotal) * 1000) / 10) : null,
          // `NaiveDate::to_string()` is YYYY-MM-DD. The driver hands back a JS Date for a `date`
          // column, and toISOString() would append a time and a Z.
          date: formatDate(r.day),
          sessions: Number(r.sessions ?? 0),
          wordsMatched,
          // Words the learner practised that the server did not transcribe itself. Reported so a
          // day of real practice never looks like an empty one, and named so it cannot be mistaken
          // for the measured figure.
          wordsSelfReported: Number(r.words_self_reported ?? 0),
          wordsTotal,
        };
      }),
      learnerId,
      tenantId: actor.tenantId,
    };
  });

  return reply.send(body);
}

/** `NaiveDate::to_string()` — YYYY-MM-DD, in UTC, with no time part. */
function formatDate(d) {
  if (typeof d === "string") return d.slice(0, 10);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * chrono's SecondsFormat::AutoSi: no fractional part when it is zero, 3 digits when the value is a
 * whole millisecond, 6 otherwise. `Date#toISOString` always prints exactly 3 and always ends in `Z`,
 * so using it here would put a different string on the wire for the same instant.
 */
export function fractional(us) {
  if (!us) return "";
  if (us % 1000 === 0) return `.${String(us / 1000).padStart(3, "0")}`;
  return `.${String(us).padStart(6, "0")}`;
}

/**
 * Port of `compute_streak` (handlers/progress.rs:247). Consecutive days ending today or yesterday;
 * anything older is a streak of zero.
 */
export function computeStreak(daysDesc) {
  if (!daysDesc || daysDesc.length === 0) return 0;
  const day = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000;
  const first = day(daysDesc[0]);
  if (first !== today && first !== today - 1) return 0;

  let streak = 0;
  let expected = first;
  for (const d of daysDesc) {
    const v = day(d);
    if (v === expected) {
      streak += 1;
      expected -= 1;
    } else if (v < expected) {
      break;
    }
  }
  return streak;
}
