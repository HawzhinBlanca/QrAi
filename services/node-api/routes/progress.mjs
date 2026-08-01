/**
 * Learner progress. Port of services/platform-api/src/handlers/progress.rs.
 *
 * `GET /v1/learner/progress` was N4; N7 moved it here unchanged. The comments are the expensive
 * part of this file — each one records a wire-format finding an A/B against Rust produced, not a
 * reading of the Rust source.
 */
import { requireAnyRole, requireSelfOrAny, resolveActor } from "../lib/authz.mjs";
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
      mastery,
      nextReviewAt: base === null ? null : `${base}${fractional(Number(us))}+00:00`,
      streak: computeStreak(days.map((r) => r.d)),
      tenantId: actor.tenantId,
      totalSessions,
    };
  });

  return reply.send(body);
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
