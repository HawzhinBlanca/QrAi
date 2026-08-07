/**
 * N18 — `POST /v1/agent-runs`. Port of handlers/agent.rs `create_agent_run`.
 *
 * Split out of N11 (the three agent/audit/eval READS) on purpose. This is the ONLY place an agent
 * run's status is ever set, and setting it to `approved` is a claim that the run's output may reach
 * a learner directly. Three reads and one security-critical write do not belong in one slice.
 *
 * ── The gate ────────────────────────────────────────────────────────────────────────────────────
 * `status: "approved"` must INDEPENDENTLY satisfy every condition of
 * `canShowLearnerFacingAiOutput` — a reviewed status, confidence ≥ 0.82, and at least one source.
 * There is no separate human-approval endpoint for agent runs (unlike teacher_reviews and
 * scholar_approvals), so trusting a client-computed "approved" would let one new or misbehaving
 * agent module ship unreviewed, low-confidence content as approved.
 */
import { randomUUID } from "node:crypto";

import { ApiError, NotFound, RejectionError, requireAnyRole, resolveActor } from "../lib/authz.mjs";
import { f64, sortKeysDeep } from "../lib/json.mjs";
import { proxy } from "../lib/proxy.mjs";

const ALLOWED_STATUS = ["queued", "running", "needs-human-review", "approved", "blocked"];

/**
 * review_status drives the learner-facing gate, so it is validated against the contract's set HERE
 * — otherwise a typo only trips the DB CHECK and surfaces as an opaque 500 instead of a clean 400.
 */
const ALLOWED_REVIEW = [
  "draft",
  "ai-suggested",
  "teacher-review-required",
  "teacher-reviewed",
  "scholar-approved",
  "blocked",
];

/** The two review states that count as human-reviewed for the approval gate. */
const APPROVED_REVIEW = ["teacher-reviewed", "scholar-approved"];

/** POST /v1/agent-runs — agent.rs:32 */
export async function createAgentRun(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["scholar", "admin", "ops"]);

  const b = req.body ?? {};
  for (const k of ["name", "goal", "status", "reviewStatus"]) {
    if (typeof b[k] !== "string") throw new RejectionError(`${k} is required`, 422);
  }
  if (typeof b.confidence !== "number") throw new RejectionError("confidence is required", 422);

  // serde defaults: sources -> [], lastEvent -> "", findingId/learnerId -> null.
  const sources = b.sources === undefined ? [] : b.sources;
  const lastEvent = typeof b.lastEvent === "string" ? b.lastEvent : "";
  const findingId = typeof b.findingId === "string" ? b.findingId : null;
  const learnerId = typeof b.learnerId === "string" ? b.learnerId : null;

  if (!ALLOWED_STATUS.includes(b.status)) {
    throw new ApiError(`invalid agent run status: ${b.status}`, 400);
  }
  if (!ALLOWED_REVIEW.includes(b.reviewStatus)) {
    throw new ApiError(`invalid agent run review_status: ${b.reviewStatus}`, 400);
  }
  if (!(b.confidence >= 0 && b.confidence <= 1)) {
    throw new ApiError("confidence must be within [0, 1]", 400);
  }

  const runId = `agent-run-${randomUUID()}`;
  const auditId = `audit-${randomUUID()}`;
  const traceId = req.headers["x-trace-id"] ?? null;

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    // FK1 — only when PRESENT. learnerId is optional and a learner-less run is legitimate: the
    // mistake-pattern and practice-plan agents both write them. Firing on absent-vs-unknown would
    // break the agents service silently. Tenant-scoped, so one tenant cannot confirm the existence
    // of another tenant's user ids.
    if (learnerId !== null) {
      const [exists] = await tx`
        SELECT 1 FROM users WHERE id = ${learnerId} AND tenant_id = ${actor.tenantId}`;
      if (!exists) throw NotFound();
    }

    // ── The learner-facing AI gate, re-derived SERVER-side ──────────────────────────────────────
    // A full mirror of canShowLearnerFacingAiOutput (packages/contracts) / statusForRun
    // (services/agents/lib/gate.mjs). `approved` is a claim that this output may reach a learner
    // directly, so it must satisfy every condition here — not just the source-count check this
    // endpoint once enforced alone.
    const sourceCount = Array.isArray(sources) ? sources.length : 0;
    const isApprovedReview = APPROVED_REVIEW.includes(b.reviewStatus);
    if (b.status === "approved" && !(isApprovedReview && b.confidence >= 0.82 && sourceCount > 0)) {
      throw new ApiError(
        "an approved agent run must have reviewStatus teacher-reviewed or scholar-approved, " +
          "confidence >= 0.82, and at least one source",
        400,
      );
    }

    // `finding_id` lives inside the trace JSONB — there is no column for it, and no FK either.
    const trace = { last_event: lastEvent, finding_id: findingId, trace_id: traceId };

    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, 'agent.run.recorded', 'agent_run',
              ${runId}, ${tx.json({ trace_id: traceId })})`;

    await tx`
      INSERT INTO agent_runs
        (id, tenant_id, name, goal, status, confidence, review_status, source_refs, trace,
         audit_event_id, learner_id)
      VALUES (${runId}, ${actor.tenantId}, ${b.name}, ${b.goal}, ${b.status},
              ${b.confidence}::float8::numeric, ${b.reviewStatus}, ${tx.json(sources)},
              ${tx.json(trace)}, ${auditId}, ${learnerId})`;

    // json! keys, alphabetical. Note this is NOT the same shape as the LIST route: no findingId and
    // no auditEventId here.
    return {
      confidence: f64(b.confidence),
      goal: b.goal,
      id: runId,
      lastEvent,
      learnerId,
      name: b.name,
      reviewStatus: b.reviewStatus,
      // The response ECHOES the request value — but by the time Rust echoes it, serde has already
      // parsed the body into a serde_json::Value, which is BTreeMap-backed. So the sources come back
      // with their keys ALPHABETIZED even though they were never near the database. Node's parser
      // preserves the client's order, so the same normalization the N11 read route needed applies
      // here too, on a path that never touches Postgres.
      sources: sortKeysDeep(sources),
      status: b.status,
    };
  });

  return reply.send(body);
}
