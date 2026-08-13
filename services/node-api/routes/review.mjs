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
/** types.rs — ApiError::NotAScholar. Names the rule, not the caller's role. */
const NOT_A_SCHOLAR = "only a scholar may record a scholar-approved decision";
/** review.rs — the ApiError::BadRequest string, which IS the wire message. */
const UNSOURCED_ACCEPTANCE =
  "a finding with no source cannot be released to a learner; reject it, or have a source added first";

/**
 * What a reviewer can do with this finding's audio. Mirrors `audio_status` in handlers/review.rs.
 *
 *   available     a stored chunk covers the finding's span, and consent permits keeping it
 *   discarded     consent said `discard`; the recording was destroyed on purpose
 *   not-captured  retention was permitted, but no audio was stored for this span
 *   unknown       retention could not be established — never offered for playback
 *
 * Consent is checked FIRST and is authoritative. A chunk existing under `discard` consent is a
 * retention BUG, and answering `available` would invite a teacher to listen to a recording that
 * should not exist. `discard` means `discarded`, whatever happens to be on disk.
 *
 * A missing consent record is `unknown`, not `not-captured`: those are different claims, and only
 * one of them is true when the row a session's retention policy lives in has gone.
 */
function audioStatus(audioRetention, hasAudio) {
  if (audioRetention === "discard") return "discarded";
  if (audioRetention === null || audioRetention === undefined) return "unknown";
  return hasAudio ? "available" : "not-captured";
}

/**
 * GET /v1/tajweed-findings/{id}/audio — review.rs `get_finding_audio` (ADR-0037).
 *
 * The recitation a finding is about, for the person judging it. The bytes travel THROUGH here rather
 * than via a signed URL handed to the client: a URL that grants access is a credential outliving the
 * check that produced it, unrevocable when consent is withdrawn mid-window, and its audit record
 * would say a link was issued rather than that a recording was heard.
 *
 * Roles are exactly `createTeacherReview`'s — whoever can RECORD A DECISION about the finding.
 * Scholar is deliberately absent even though a scholar can read the finding queue: reviewing content
 * for religious accuracy does not require listening to a particular child's voice.
 *
 * Order: authenticate -> authorize -> find in tenant -> consent -> AUDIT -> fetch. The audit row is
 * written before the bytes are requested so a transfer that dies halfway is still recorded, and
 * after authorization so an unauthenticated caller cannot write rows by asking.
 */
export async function getFindingAudio(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["teacher", "admin", "ops"]);

  const findingId = req.params.id;
  const prepared = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [row] = await tx`
      SELECT rs.learner_id, cr.audio_retention,
             ac.id AS chunk_id,
             wa.start_ms AS finding_start_ms, wa.end_ms AS finding_end_ms,
             (SELECT count(*) FROM audio_chunks c2
               WHERE c2.session_id = wa.session_id AND c2.tenant_id = tf.tenant_id
                 AND c2.start_ms < wa.end_ms AND c2.end_ms > wa.start_ms) AS overlapping
      FROM tajweed_findings tf
      JOIN word_alignments wa ON wa.id = tf.alignment_id
      LEFT JOIN recitation_sessions rs ON rs.id = wa.session_id
      LEFT JOIN consent_records cr ON cr.id = rs.consent_record_id
      LEFT JOIN audio_chunks ac ON ac.session_id = wa.session_id
           AND ac.tenant_id = tf.tenant_id
           AND ac.start_ms < wa.end_ms AND ac.end_ms > wa.start_ms
      WHERE tf.id = ${findingId} AND tf.tenant_id = ${actor.tenantId}
      ORDER BY ac.start_ms ASC NULLS LAST
      LIMIT 1`;

    // 404 whether the finding does not exist or belongs to another tenant: distinguishing them lets
    // a teacher in one tenant confirm a finding id in another.
    if (!row) throw NotFound();

    const status = audioStatus(row.audio_retention ?? null, row.chunk_id != null);

    // EVERY authorized attempt is audited, not only the ones that return bytes: an attempt on a
    // discarded recording is at least as interesting as a successful one. The outcome is recorded
    // WITH the attempt, so the row never claims audio was heard when it was not.
    const auditId = newId("audit");
    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, 'recitation.audio.read',
              'tajweed_finding', ${findingId},
              ${tx.json({
                trace_id: traceId(req),
                outcome: status,
                chunk_id: row.chunk_id ?? null,
                learner_id: row.learner_id ?? null,
              })})`;

    return {
      status,
      auditId,
      chunkId: row.chunk_id ?? null,
      learnerId: row.learner_id ?? null,
      findingStartMs: Number(row.finding_start_ms ?? 0),
      findingEndMs: Number(row.finding_end_ms ?? 0),
      overlapping: Number(row.overlapping ?? 0),
    };
  });

  // OUTSIDE the transaction, deliberately. `withTenant` wraps `sql.begin`, so throwing inside it
  // rolls the transaction back — and the audit row with it. An audited refusal that erases its own
  // audit row is worse than no audit at all, because it looks like nobody asked. Rust has the same
  // shape for the same reason: `tx.commit()` runs before the status is acted on.
  //
  // 410 Gone, not 404. The finding exists and the recording DID exist; the learner asked for it to
  // be destroyed and it was. A 404 reads as "we lost it" and a teacher keeps coming back.
  if (prepared.status === "discarded") {
    throw new ApiError("this recording was discarded at the learner's request", 410);
  }
  if (prepared.status === "unknown") {
    throw new ApiError("retention for this recording cannot be established", 410);
  }
  if (prepared.status !== "available" || !prepared.chunkId || !prepared.learnerId) throw NotFound();

  // The object key's PARTS, never the key — and the tenant is the ACTOR's, never a value read from
  // the row. A tenant id taken from data is a tenant id an attacker can influence.
  let upstream;
  try {
    upstream = await fetch(`${ctx.mlInferenceUrl}/v1/audio-objects:read`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ml-api-key": ctx.mlApiKey },
      body: JSON.stringify({
        tenantId: actor.tenantId,
        learnerId: prepared.learnerId,
        chunkId: prepared.chunkId,
      }),
      // lib.rs `upstream_timeout` — review.rs:171 uses the same timed client.
      signal: AbortSignal.timeout(ctx.upstreamTimeout),
    });
  } catch {
    throw new ApiError("audio storage unavailable", 502);
  }

  if (upstream.status === 410) {
    // ml-inference checks the retention stored ALONGSIDE the bytes. Reaching here means the two
    // records disagree — the consent row said retain, the object said otherwise. Refuse.
    throw new ApiError("this recording was not retained for review", 410);
  }
  if (upstream.status === 404) throw NotFound();
  if (!upstream.ok) throw new ApiError("audio storage error", 502);

  let object;
  try {
    object = await upstream.json();
  } catch {
    throw new ApiError("audio storage returned an invalid response", 502);
  }

  // json! keys, alphabetical.
  return reply.send({
    audioBase64: object.audioBase64 ?? null,
    auditEventId: prepared.auditId,
    chunkId: prepared.chunkId,
    chunksOverlappingFinding: prepared.overlapping,
    endMs: object.endMs ?? null,
    findingEndMs: prepared.findingEndMs,
    findingStartMs: prepared.findingStartMs,
    sampleRate: object.sampleRate ?? null,
    startMs: object.startMs ?? null,
  });
}

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

  // ── Only a scholar may say "scholar-approved" ─────────────────────────────────────────────────
  // The route gate above still admits admin and ops, and that stays: recording a `draft`, or
  // `blocked`ing something, is operational work. Approving is not. `scholar_approvals` rows carry
  // religious authority — the status names it — and this table is the artifact a "qualified scholar
  // approval" is evidenced with, so a row an operator minted is indistinguishable from a scholar's.
  //
  // Measured before this check existed, one request per role, all else equal:
  //     scholar -> 200  scholar-approved by a scholar
  //     ops     -> 200  scholar-approved by a ops
  //     admin   -> 200  scholar-approved by a admin
  //
  // BEFORE the sources and risk refusals, deliberately. Authorization precedes validation elsewhere
  // in this codebase for a stated reason, and a caller who may not approve at all should not learn
  // whether their sources would have been accepted.
  if (b.status === "scholar-approved" && actor.role !== "scholar") {
    throw new ApiError(NOT_A_SCHOLAR, 403);
  }

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

  // `offset` reaches SQL, so it is parsed STRICTLY rather than coerced — a string, a negative or a
  // float is a clean 400 naming the parameter. Mirrors the same parse in handlers/review.rs.
  const rawOffset = req.query.offset;
  let offset = 0;
  if (rawOffset !== undefined) {
    // Number("") is 0 and Number("1.5") is 1.5: both would otherwise slip through a bare Number().
    offset = /^\d+$/.test(String(rawOffset)) ? Number(rawOffset) : NaN;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ApiError("offset must be a non-negative integer", 400);
    }
  }

  let totalAwaiting = 0;
  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const rows = await tx`
      SELECT tf.id, tf.alignment_id, wa.session_id, wa.word_id, wa.transcript_source, tf.analysis_basis,
             tf.rule, tf.severity,
             tf.confidence::float8 AS confidence, tf.explanation, tf.review_status, tf.source_refs,
             cr.audio_retention,
             EXISTS (
               SELECT 1 FROM audio_chunks ac
               WHERE ac.session_id = wa.session_id
                 AND ac.tenant_id = tf.tenant_id
                 AND ac.start_ms < wa.end_ms AND ac.end_ms > wa.start_ms
             ) AS has_audio
      FROM tajweed_findings tf
      JOIN word_alignments wa ON wa.id = tf.alignment_id
      -- LEFT, both of them. An INNER join would silently DROP any finding whose session or consent
      -- record has gone, and a finding vanishing from a review queue is worse than one that cannot
      -- be played.
      LEFT JOIN recitation_sessions rs ON rs.id = wa.session_id
      LEFT JOIN consent_records cr ON cr.id = rs.consent_record_id
      WHERE tf.tenant_id = ${actor.tenantId}
-- ── What this queue is FOR ─────────────────────────────────────────────────────────────────
      -- A teacher opens this to decide what to work on, so it sorts by whether work is NEEDED and
      -- then by how long it has waited. It used to sort by confidence DESC, which is unrelated to
      -- either -- and measured against a real corpus that page held 115 already-reviewed findings,
      -- 84 ai-suggested, and ZERO of the 1781 whose status literally names the need.
      --
      -- ADR-0036 then made it worse: setting canonical-text confidence to 0 (correctly -- it was
      -- fabricated) put every NEW finding behind all 2892 legacy ones carrying 0.80-0.90, so the
      -- newest evidence became the least visible.
      --
      -- An UNRECOGNISED status sorts with the awaiting group, not the decided one: a status nobody
      -- has heard of should surface for a human rather than vanish from the queue.
      --
      -- Oldest recitation first, because the longest wait is the most urgent and FIFO is the only
      -- order in which nothing starves.
      --
      -- rs.started_at, not tf.created_at: tajweed_findings has NO timestamp column at all. The first
      -- version of this ORDER BY assumed one and both implementations returned a database error,
      -- identically -- worth recording so the next person does not assume it either.
      --
      -- NULLS FIRST: a finding whose session has been erased still needs a human, and sinking it to
      -- the bottom of a truncated page is how an orphan becomes invisible.
      --
      -- tf.id still breaks ties: started_at is not unique across a session's findings.
      ORDER BY (tf.review_status IN ('teacher-reviewed', 'blocked', 'scholar-approved')),
               rs.started_at ASC NULLS FIRST, tf.id
      LIMIT 200 OFFSET ${offset}`;

    // How deep the queue actually is — a HEADER, not a wrapper object, because the response has
    // always been a bare array and every client reads it that way.
    const [{ total }] = await tx`
      SELECT count(*)::int AS total FROM tajweed_findings
      WHERE tenant_id = ${actor.tenantId}
        AND review_status NOT IN ('teacher-reviewed', 'blocked', 'scholar-approved')`;
    totalAwaiting = total;

    return rows.map((r) => ({
      // json! keys, alphabetical.
      // `canonical-text` | `acoustic` — what the finding is ABOUT (ADR-0033). Today always
      // canonical-text: the analyser reads the passage's Uthmani text and detects where a rule
      // applies, which is true of the text and identical for every learner.
      analysisBasis: r.analysis_basis ?? "canonical-text",
      // Whether a reviewer can HEAR the recitation this finding is about, and if not, why.
      audioStatus: audioStatus(r.audio_retention ?? null, r.has_audio === true),
      confidence: f64(Number(r.confidence ?? 0)),
      explanation: r.explanation ?? "",
      id: r.id ?? "",
      reviewStatus: r.review_status ?? "",
      rule: r.rule ?? "",
      // Alphabetical: this list is the WIRE ORDER and review-parity.test.mjs pins it key for key.
      // Rust serialises through a BTreeMap and sorts for free; here the literal order IS the output
      // order, so a key appended at the end is a parity failure rather than a cosmetic one.
      sessionId: r.session_id ?? "",
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

  return reply.header("x-total-awaiting", String(totalAwaiting)).send(body);
}
