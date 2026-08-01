/**
 * N11 — the three read-only reporting routes: agent runs, audit events, eval runs.
 * Port of handlers/agent.rs (list only), handlers/audit.rs, handlers/eval.rs.
 *
 * They share a shape — staff-only, tenant-scoped, one query, no writes — which is why they are one
 * file. `POST /v1/agent-runs` is deliberately NOT here: it carries the learner-facing AI gate
 * (a server-side re-derivation of `canShowLearnerFacingAiOutput`) and is the only place an agent
 * run's status is ever set, so it gets its own slice rather than riding along with three reads.
 */
import { NotFound, requireAnyRole, resolveActor } from "../lib/authz.mjs";
import { f32, f64, sortKeysDeep } from "../lib/json.mjs";
import { proxy } from "../lib/proxy.mjs";

/** GET /v1/agent-runs — agent.rs list_agent_runs */
export async function listAgentRuns(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  // Note scholar IS allowed here, unlike the audit and eval routes below. The three lists are
  // different on purpose and were transcribed one at a time.
  requireAnyRole(actor, ["teacher", "scholar", "admin", "ops"]);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const rows = await tx`
      SELECT id, name, goal, status, confidence::float8 AS confidence, review_status,
             source_refs, trace, learner_id
      FROM agent_runs WHERE tenant_id = ${actor.tenantId} ORDER BY created_at DESC LIMIT 50`;

    return rows.map((r) => {
      const trace = r.trace ?? {};
      return {
        // json! keys, alphabetical.
        confidence: f64(Number(r.confidence ?? 0)),
        // finding_id lives inside the trace JSONB, not a column. `agent_runs.finding_id` has no FK
        // at all — tracked separately; this route only surfaces what create_agent_run stored.
        findingId: typeof trace.finding_id === "string" ? trace.finding_id : null,
        goal: r.goal ?? "",
        id: r.id ?? "",
        // Rust reads `trace.last_event` and falls back to "" — NOT to null. A null here would make
        // the field disappear from a client that treats null as absent.
        lastEvent: typeof trace.last_event === "string" ? trace.last_event : "",
        learnerId: r.learner_id ?? null,
        name: r.name ?? "",
        reviewStatus: r.review_status ?? "",
        // `source_refs` is jsonb. The server enforces no SHAPE on it (the contract records that
        // too), but it does not pass through untouched: Rust reads it into a serde_json::Value,
        // which is a BTreeMap, so re-serializing emits every object's keys ALPHABETICALLY. The
        // driver here preserves the order Postgres stored. `sortKeysDeep` reproduces the BTreeMap.
        // Found by the N11 A/B — same data, different bytes, invisible in both source files.
        sources: sortKeysDeep(r.source_refs ?? []),
        status: r.status ?? "",
      };
    });
  });

  return reply.send(body);
}

/** GET /v1/audit-events — audit.rs list_audit_events */
export async function listAuditEvents(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["admin", "ops"]);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const rows = await tx`
      SELECT id, tenant_id, actor_id, action, subject_type, subject_id, metadata
      FROM audit_events
      WHERE tenant_id = ${actor.tenantId}
      ORDER BY created_at DESC
      LIMIT 200`;

    // `AuditEvent` is a derive(Serialize) STRUCT, so DECLARATION order, not alphabetical.
    return rows.map((r) => {
      const metadata = r.metadata ?? {};
      return {
        id: r.id ?? "",
        tenantId: r.tenant_id ?? "",
        actorId: r.actor_id ?? "",
        // Option<String>: absent, non-string, or a JSON null all become null — `as_str()` on a
        // non-string returns None in Rust, it does not stringify.
        traceId: typeof metadata.trace_id === "string" ? metadata.trace_id : null,
        action: r.action ?? "",
        subjectType: r.subject_type ?? "",
        subjectId: r.subject_id ?? "",
      };
    });
  });

  return reply.send(body);
}

/** GET /v1/eval-runs/{model_version} — eval.rs get_eval_run */
export async function getEvalRun(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["admin", "ops"]);

  const modelVersion = req.params.model_version;

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [row] = await tx`
      SELECT model_version_id, dataset_version,
             word_alignment_f1::float8 AS word_alignment_f1,
             tajweed_f1::float8 AS tajweed_f1,
             false_positive_rate::float8 AS false_positive_rate,
             teacher_agreement_rate::float8 AS teacher_agreement_rate,
             unsourced_learner_outputs, passed
      FROM eval_runs
      WHERE model_version_id = ${modelVersion} AND tenant_id = ${actor.tenantId}
      ORDER BY created_at DESC
      LIMIT 1`;
    if (!row) throw NotFound();

    // `EvalRun` is a derive(Serialize) STRUCT — declaration order.
    //
    // The four metrics are f32 in Rust (types.rs:276-279), read as float8 and narrowed with
    // `as f32`. serde then prints the shortest string that round-trips to that SINGLE, which is
    // shorter than the double the database handed over. `f32()` does both steps; using `f64()`
    // here would put extra digits on the wire for every metric.
    return {
      modelVersion: row.model_version_id,
      datasetVersion: row.dataset_version,
      wordAlignmentF1: f32(Number(row.word_alignment_f1)),
      tajweedF1: f32(Number(row.tajweed_f1)),
      falsePositiveRate: f32(Number(row.false_positive_rate)),
      teacherAgreementRate: f32(Number(row.teacher_agreement_rate)),
      // u32, not a float: an integer count must not gain a decimal point.
      unsourcedLearnerOutputs: Number(row.unsourced_learner_outputs ?? 0),
      passed: row.passed,
    };
  });

  return reply.send(body);
}
