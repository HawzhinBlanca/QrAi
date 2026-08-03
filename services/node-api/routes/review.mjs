/**
 * N15 — the review gates. Port of handlers/review.rs.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────────────────────────
 * No learner-facing AI feedback without a source, a confidence, and a human approval. Two of the
 * five operations here are where that stops being a policy and becomes a refusal:
 * `scholar-approved` with no sources is a 400, and `scholar-approved` at high risk is a 400. Both
 * are checked BEFORE anything is written, so a refused approval leaves no row and no audit trail
 * suggesting one was considered.
 *
 * ── And the rule that repeats twice ─────────────────────────────────────────────────────────────
 * The author of a review, and the reviewer on an approval, are the AUTHENTICATED ACTOR — never the
 * caller-supplied `teacherId`/`reviewerId`. Those fields are accepted by the request struct and
 * then IGNORED. Trusting them let any teacher attribute a review to another user, including a
 * cross-tenant one, because `users(id)` is a platform-global FK.
 */
import { randomUUID } from "node:crypto";

import { ApiError, NotFound, RejectionError, requireAnyRole, resolveActor } from "../lib/authz.mjs";
import { f64, sortKeysDeep } from "../lib/json.mjs";
import { proxy } from "../lib/proxy.mjs";

const newId = (prefix) => `${prefix}-${randomUUID()}`;
const traceId = (req) => req.headers["x-trace-id"] ?? null;

const TEACHER_DECISIONS = ["accepted", "rejected", "edited"];
const SCHOLAR_DECISIONS = ["draft", "scholar-approved", "blocked"];
const RISK_LEVELS = ["low", "medium", "high"];

/** types.rs:341-344 — thiserror Display strings, which ARE the wire messages. */
const MISSING_SOURCES = "source references are required for scholar-approved content";
const HIGH_RISK_APPROVAL = "high-risk content cannot be auto-approved";
/** review.rs — the ApiError::BadRequest string, which IS the wire message. */
const UNSOURCED_ACCEPTANCE =
  "a finding with no source cannot be released to a learner; reject it, or have a source added first";

/** POST /v1/teacher-reviews — review.rs:9 */
export async function createTeacherReview(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["teacher", "admin", "ops"]);

  const b = req.body ?? {};
  if (typeof b.findingId !== "string") throw new RejectionError("findingId is required", 422);
  if (!TEACHER_DECISIONS.includes(b.decision)) throw new RejectionError("decision is required", 422);
  if (typeof b.note !== "string") throw new RejectionError("note is required", 422);

  const reviewId = newId("teacher-review");
  const auditId = newId("audit");

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    // The finding must exist IN THIS TENANT. Without it a dangling findingId fails the FK and
    // surfaces as a 500; a missing referenced entity is a 404.
    // The snapshot comes from THIS read, not a second one: re-reading afterwards would leave a
    // window in which the finding changed between the check and the copy. Mirrors review.rs.
    const [finding] = await tx`
      SELECT jsonb_array_length(tf.source_refs) AS source_count,
             jsonb_build_object(
               'findingId',    tf.id,
               'wordId',       wa.word_id,
               'sessionId',    wa.session_id,
               'rule',         tf.rule,
               'severity',     tf.severity,
               'confidence',   tf.confidence::float8,
               'explanation',  tf.explanation,
               'reviewStatus', tf.review_status,
               'sources',      tf.source_refs
             ) AS reviewed_finding
      FROM tajweed_findings tf
      JOIN word_alignments wa ON wa.id = tf.alignment_id
      WHERE tf.id = ${b.findingId} AND tf.tenant_id = ${actor.tenantId}`;
    if (!finding) throw NotFound();

    // Accepting an UNSOURCED finding is refused, mirroring review.rs and the scholar path's
    // MISSING_SOURCES check below. A teacher acceptance releases content to a learner (ADR-0027),
    // and `canShowLearnerFacingAiOutput` in the client was the only thing withholding one.
    // Refused before any write. Only `accepted` — rejecting or editing an unsourced finding is
    // exactly what a teacher should be able to do with it.
    if (b.decision === "accepted" && Number(finding.source_count ?? 0) === 0) {
      throw new ApiError(UNSOURCED_ACCEPTANCE, 400);
    }

    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, 'review.teacher.submitted',
              'teacher_review', ${reviewId},
              ${tx.json({ trace_id: traceId(req), decision: b.decision })})`;

    // The author is the AUTHENTICATED actor. `b.teacherId` is accepted by the request shape and
    // deliberately IGNORED — trusting it let any teacher attribute a review to another user, even a
    // cross-tenant one, since users(id) is a platform-global FK.
    // `reviewed_finding` is what the teacher was looking at. A review that outlives its finding
    // (0024) reads as "a teacher rejected something" without it — the sentence stops being evidence
    // at the point it matters most. Taken from the same read that validated the finding exists, so
    // the snapshot is of the row this decision was actually made against.
    await tx`
      INSERT INTO teacher_reviews
        (id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id, reviewed_finding)
      VALUES (${reviewId}, ${actor.tenantId}, ${b.findingId}, ${actor.userId}, ${b.decision},
              ${b.note}, ${auditId}, ${tx.json(finding.reviewed_finding ?? {})})`;

    // The decision reaches the finding (ADR-0027). Same transaction as the review row and the
    // audit event: a promotion without its audit trail is learner-facing content nobody can account
    // for, and a lost promotion is a teacher's decision silently dropped.
    //
    // `edited` promotes NOTHING — the rewrite has nowhere to live, so promoting would publish the
    // original wording as teacher-approved: exactly the text the teacher said was wrong.
    // Mirrors review.rs; tests/api-parity keeps the two honest.
    const promoted = { accepted: "teacher-reviewed", rejected: "blocked", edited: null }[b.decision];
    if (promoted) {
      await tx`
        UPDATE tajweed_findings SET review_status = ${promoted}
        WHERE id = ${b.findingId} AND tenant_id = ${actor.tenantId}`;
    }

    // `TeacherReview` struct — DECLARATION order.
    return {
      id: reviewId,
      tenantId: actor.tenantId,
      findingId: b.findingId,
      teacherId: actor.userId,
      decision: b.decision,
      note: b.note,
      // Freshly written, so it is about a live finding by construction.
      supersededAt: null,
      auditEventId: auditId,
    };
  });

  return reply.send(body);
}

/** GET /v1/teacher-review-queue — review.rs:85 */
export async function listTeacherReviewQueue(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["teacher", "admin", "ops"]);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const rows = await tx`
      SELECT id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id,
             to_char(superseded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS superseded_at
      FROM teacher_reviews WHERE tenant_id = ${actor.tenantId}
      ORDER BY created_at DESC, id LIMIT 200`;

    return rows.map((r) => ({
      id: r.id ?? "",
      tenantId: r.tenant_id ?? "",
      // NULL, not "". A re-record detaches a review instead of deleting it (ADR-0031), and a
      // detached one genuinely has no finding — `""` says the finding is the empty string, and the
      // contract's own `minLength: 1` forbids it.
      findingId: r.finding_id ?? null,
      teacherId: r.teacher_id ?? "",
      // An unrecognised decision falls back to "accepted" — transcribed, and worth noticing: the
      // fallback is the PERMISSIVE value, so a corrupt row reads as an acceptance. Not changed here
      // (that is a behaviour change, not a port), but it is the sort of default worth a second look.
      decision: TEACHER_DECISIONS.includes(r.decision) ? r.decision : "accepted",
      note: r.note ?? "",
      // Between note and auditEventId because serde emits the Rust struct in DECLARATION order and
      // the A/B compares response bytes. Null while the review is about a live finding.
      supersededAt: r.superseded_at ?? null,
      auditEventId: r.audit_event_id ?? "",
    }));
  });

  return reply.send(body);
}

/** POST /v1/scholar-approvals — review.rs:130 */
export async function createScholarApproval(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["scholar", "admin", "ops"]);

  const b = req.body ?? {};
  if (typeof b.topic !== "string") throw new RejectionError("topic is required", 422);
  if (!SCHOLAR_DECISIONS.includes(b.status)) throw new RejectionError("status is required", 422);
  if (!RISK_LEVELS.includes(b.risk)) throw new RejectionError("risk is required", 422);
  if (!Array.isArray(b.sources)) throw new RejectionError("sources is required", 422);

  // ── The two refusals, BEFORE anything is written ──────────────────────────────────────────────
  // Order matters and is transcribed: sources first, then risk. A request that fails both gets the
  // sources message, and a client that branches on the message would otherwise see it change.
  if (b.status === "scholar-approved" && b.sources.length === 0) {
    throw new ApiError(MISSING_SOURCES, 400);
  }
  if (b.status === "scholar-approved" && b.risk === "high") {
    throw new ApiError(HIGH_RISK_APPROVAL, 400);
  }

  const approvalId = newId("scholar-approval");
  const auditId = newId("audit");

  // `SourceReference` is a typed struct — DECLARATION order (id, title, citation, url), with `url`
  // an Option that is present-and-null when absent.
  const sources = b.sources.map((s) => ({
    id: typeof s?.id === "string" ? s.id : "",
    title: typeof s?.title === "string" ? s.title : "",
    citation: typeof s?.citation === "string" ? s.citation : "",
    url: typeof s?.url === "string" ? s.url : null,
  }));

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, 'review.scholar.approved',
              'scholar_approval', ${approvalId}, ${tx.json({ trace_id: traceId(req) })})`;

    // The reviewer is the AUTHENTICATED actor; `b.reviewerId` is ignored, same rule as above.
    await tx`
      INSERT INTO scholar_approvals
        (id, tenant_id, topic, reviewer_id, status, risk, source_refs, audit_event_id)
      VALUES (${approvalId}, ${actor.tenantId}, ${b.topic}, ${actor.userId}, ${b.status},
              ${b.risk}, ${tx.json(sources)}, ${auditId})`;

    // `ScholarApproval` struct — DECLARATION order.
    return {
      id: approvalId,
      tenantId: actor.tenantId,
      topic: b.topic,
      reviewerId: actor.userId,
      status: b.status,
      risk: b.risk,
      sources,
      auditEventId: auditId,
    };
  });

  return reply.send(body);
}

/** GET /v1/scholar-approvals — review.rs:206 */
export async function listScholarApprovals(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  // Note this list includes TEACHER, unlike the create above (scholar/admin/ops). A teacher may
  // read what a scholar approved without being able to approve anything.
  requireAnyRole(actor, ["scholar", "teacher", "admin", "ops"]);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const rows = await tx`
      SELECT id, topic, reviewer_id, status, risk, source_refs
      FROM scholar_approvals WHERE tenant_id = ${actor.tenantId}
      ORDER BY created_at DESC, id LIMIT 200`;

    return rows.map((r) => ({
      // json! keys, alphabetical. Note this shape is NOT the ScholarApproval struct: the list
      // returns a COUNT rather than the sources themselves, and `reviewer` rather than `reviewerId`.
      id: r.id ?? "",
      // "reviewer" sorts BEFORE "risk": at index 1 it is 'e' vs 'i'. Alphabetical, not eyeballed —
      // the first draft of both this object and its test had them the other way round.
      reviewer: r.reviewer_id ?? "",
      risk: r.risk ?? "",
      sourceCount: Array.isArray(r.source_refs) ? r.source_refs.length : 0,
      status: r.status ?? "",
      topic: r.topic ?? "",
    }));
  });

  return reply.send(body);
}

/** GET /v1/tajweed-findings — review.rs:253 */
export async function listTajweedFindings(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["teacher", "scholar", "admin", "ops"]);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const rows = await tx`
      SELECT tf.id, tf.alignment_id, wa.word_id, wa.transcript_source, tf.analysis_basis,
             tf.rule, tf.severity,
             tf.confidence::float8 AS confidence, tf.explanation, tf.review_status, tf.source_refs
      FROM tajweed_findings tf
      JOIN word_alignments wa ON wa.id = tf.alignment_id
      WHERE tf.tenant_id = ${actor.tenantId}
      -- tf.id breaks ties: confidence is NOT unique (findings routinely share 0.9), so with the
      -- LIMIT below Postgres would drop an ARBITRARY subset of the tied rows at the cutoff and
      -- return a different set run to run. Any ORDER BY feeding a LIMIT needs a unique tiebreaker
      -- to be reproducible.
      ORDER BY tf.confidence DESC, tf.id LIMIT 200`;

    return rows.map((r) => ({
      // json! keys, alphabetical.
      // `canonical-text` | `acoustic` — what the finding is ABOUT (ADR-0033). Today always
      // canonical-text: the analyser reads the passage's Uthmani text and detects where a rule
      // applies, which is true of the text and identical for every learner.
      analysisBasis: r.analysis_basis ?? "canonical-text",
      confidence: f64(Number(r.confidence ?? 0)),
      explanation: r.explanation ?? "",
      id: r.id ?? "",
      reviewStatus: r.review_status ?? "",
      rule: r.rule ?? "",
      severity: r.severity ?? "",
      // Untyped jsonb passed straight through, so BTreeMap key ordering applies.
      sources: sortKeysDeep(r.source_refs ?? []),
      // `server-derived` | `client-reported` — whether the platform heard the recitation this
      // finding is anchored to at all (ADR-0030). Different question from analysisBasis, and a
      // teacher deciding whether to release the finding needs both.
      transcriptSource: r.transcript_source ?? "client-reported",
      wordId: r.word_id ?? "",
    }));
  });

  return reply.send(body);
}
