use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, Method};
use sqlx::Row;

use crate::AppState;
use crate::types::*;

/// Who may run analysis against a session that is not their own — and therefore who receives the
/// findings unredacted. ONE list, used for both: two copies would drift, and the direction they
/// would drift in is a learner reading an unreviewed judgement about their own recitation.
///
/// Teacher is deliberately absent. Reviewing a stored finding is `/v1/teacher-reviews`; re-running
/// the analyser against somebody's session is not part of that, and never was.
const ANALYSIS_STAFF: &[ActorRole] = &[ActorRole::Admin, ActorRole::Ops];

/// Proxy a prediction request to the internal ML service.
///
/// Tenant isolation: the caller is authenticated and the request's `tenantId` is OVERWRITTEN with the
/// actor's server-validated tenant — the client-supplied `tenantId` is never trusted. Otherwise a
/// learner authenticated for tenant A could set `tenantId: "tenant-B"` in the body and have the ML
/// service write audit/storage records under another tenant's namespace (cross-tenant IDOR).
///
/// Upstream failures map to a 502 with a GENERIC message; the underlying `reqwest`/parse error (which
/// can contain the internal ML URL / connection details) is logged server-side only, never returned
/// to the browser.
async fn proxy_ml(
    state: &AppState,
    method: &Method,
    headers: &HeaderMap,
    label: &str,
    path: &str,
    body: JsonBody<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = crate::auth::resolve_actor(method, headers, state).await?;
    // `serde_json::Value` accepts almost anything, so `{}` parsed fine and this route LOOKED like it
    // authenticated first. Malformed JSON (`{`) did not: it was a 400 naming the parse failure to a
    // caller with no credentials. Measured — the untyped body hid the same ordering bug the typed
    // ones had, and a probe that sent only `{}` reported this route as correct.
    let Json(mut body) = body?;

    let obj = body
        .as_object_mut()
        .ok_or_else(|| ApiError::BadRequest("request body must be a JSON object".to_owned()))?;

    // Runtime guard: reject unapproved / experimental model configurations
    const APPROVED_MODELS: &[&str] = &["ml-aligner-v0.2"];
    if let Some(model_str) = obj
        .get("modelVersion")
        .and_then(|v| v.as_str())
        .filter(|s| !APPROVED_MODELS.contains(s))
    {
        return Err(ApiError::BadRequest(format!(
            "Model version '{}' is not approved for production use",
            model_str
        )));
    }

    // Server-authoritative tenant: ignore whatever the client claimed.
    obj.insert(
        "tenantId".to_owned(),
        serde_json::Value::String(actor.tenant_id.clone()),
    );

    // Server-authoritative CONSENT. The ML service (services/ml-inference) decides external-ASR and
    // child-safety gating from the request body's `consent` object — so a client that re-supplies
    // `consent: { guardianApproved: true, externalAsrProcessing: true }` on an analysis request could
    // claim approval it never gave. The only trustworthy consent is the record captured when the
    // session was created. For any session-scoped request, load that record (within the actor's
    // tenant, so RLS also isolates it) and OVERWRITE the forwarded consent with the stored values. A
    // sessionId that resolves to no session in the actor's tenant is refused — you cannot run analysis
    // against a session that isn't yours or doesn't exist.
    if let Some(session_id) = obj
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
    {
        let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;
        let row = sqlx::query(
            "SELECT s.learner_id, c.guardian_approved, c.external_asr_processing, c.audio_retention
             FROM recitation_sessions s
             JOIN consent_records c ON c.id = s.consent_record_id
             WHERE s.id = $1 AND s.tenant_id = $2",
        )
        .bind(&session_id)
        .bind(&actor.tenant_id)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;

        let row = row.ok_or(ApiError::Forbidden)?;
        // The session must belong to the caller: a learner may only run analysis against their OWN
        // session; admin/ops may run against any in-tenant session. Without this, a learner could
        // pass another in-tenant learner's sessionId and have THAT session's stored consent applied
        // to their own forwarded audio. Mirrors create_realtime_ticket / persist_session_alignments.
        let session_learner_id: String = row.try_get("learner_id")?;
        actor.require_self_or_any(&session_learner_id, ANALYSIS_STAFF)?;
        let guardian_approved: bool = row.try_get("guardian_approved")?;
        let external_asr_processing: bool = row.try_get("external_asr_processing")?;
        let audio_retention: String = row.try_get("audio_retention")?;

        obj.insert(
            "consent".to_owned(),
            serde_json::json!({
                "guardianApproved": guardian_approved,
                "externalAsrProcessing": external_asr_processing,
                "audioRetention": audio_retention,
            }),
        );
    }

    let response = state
        .http_client
        .post(format!("{}{}", state.ml_inference_url, path))
        .header("content-type", "application/json")
        .header("x-ml-api-key", &state.ml_api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            tracing::error!("ML proxy {label} send error: {e}");
            ApiError::Upstream("ML service unavailable".to_owned())
        })?;

    if !response.status().is_success() {
        tracing::warn!("ML proxy {label} upstream status {}", response.status());
        return Err(ApiError::Upstream("ML service error".to_owned()));
    }

    let mut result: serde_json::Value = response.json().await.map_err(|e| {
        tracing::error!("ML proxy {label} parse error: {e}");
        ApiError::Upstream("ML service returned an invalid response".to_owned())
    })?;

    // Tajweed findings existed only for the length of this response until now: nothing wrote them
    // down, so no teacher could ever review one and no learner could ever be shown one. See
    // `persist_tajweed_findings`.
    if label == "tajweed"
        && let Some(session_id) = result.get("sessionId").and_then(|v| v.as_str())
    {
        persist_tajweed_findings(
            state,
            &actor.tenant_id,
            &actor.user_id,
            session_id,
            &result,
            crate::auth::extract_trace_id(headers).as_deref(),
        )
        .await?;
    }

    // The learner gate applies to THIS response too, not only to the copy that was just stored.
    //
    // Everything ml-inference returns here is freshly computed and `ai-suggested` by construction —
    // no human has looked at any of it — so for a learner the whole set is withheld. It was
    // nonetheless being sent to their device in full: every rule, severity, explanation and
    // confidence, with `canShowLearnerFacingAiOutput` in the browser trusted to hide it. That is a
    // display choice, not an authorization boundary; `curl` with the learner's own token read all of
    // it. Same reasoning, and the same redaction, as `list_session_tajweed_findings`.
    //
    // Staff get it whole: analysing a session in order to review it is what the route is for.
    if label == "tajweed" && !ANALYSIS_STAFF.contains(&actor.role) {
        redact_withheld_findings(&mut result);
    }

    Ok(Json(result))
}

/// Strip, in place, the content of every finding in an ML response that a learner may not be shown.
///
/// The array KEEPS its length and each finding keeps its `reviewStatus`: both clients render "N
/// notes are waiting for a teacher" from a count, and a count of pending notes says nothing about
/// how the person recited. Everything that does say something goes.
///
/// The values left behind are not filler — `confidence: 0` and `sources: []` make each redacted
/// finding fail `canShowLearnerFacingAiOutput` and `isLearnerVisible` on its own merits, so a client
/// that ignores the redaction entirely still cannot present one as feedback.
fn redact_withheld_findings(result: &mut serde_json::Value) {
    let Some(raw) = result.get_mut("findings") else {
        // No `findings` key at all: the response claims nothing about how the person recited, so
        // there is nothing to gate. This is a legitimate ML response shape and stays untouched.
        return;
    };

    // ── Shapes this function was NOT written to inspect ─────────────────────────────────────────
    // Both branches below used to `return`/`continue`, i.e. forward the value UNREDACTED. That was
    // the gate failing OPEN on exactly the input it cannot reason about, and it is reachable without
    // anyone editing the gate: a partially migrated model server, a debug build with a different
    // schema, or an ML service someone has compromised. `tests/api-parity/upstream-malformed.test.mjs`
    // demonstrated both by putting a marker string in front of a learner.
    //
    // The rule (ADR-0028) is that learner-facing model output does not leave this service without
    // source, confidence and an approval gate. "A client probably would not render it" is not that
    // rule — it is the reasoning that put the gate on the wrong side of the boundary in the first
    // place.
    let Some(findings) = raw.as_array_mut() else {
        tracing::error!(
            "ML proxy: `findings` was present but not an array; dropping ungated model output"
        );
        *raw = serde_json::json!([]);
        return;
    };

    for finding in findings.iter_mut() {
        let Some(obj) = finding.as_object_mut() else {
            // Not an object, so its fields cannot be cleared one by one. Replace it wholesale with a
            // withheld placeholder rather than passing it through: the array keeps its length, which
            // is what both clients count to render "N notes are waiting for a teacher", and it
            // carries no model text.
            tracing::error!(
                "ML proxy: a finding was not an object; replacing it with a withheld placeholder"
            );
            *finding = serde_json::json!({
                "withheld": true,
                "confidence": 0.0,
                "sources": [],
            });
            continue;
        };
        let status = obj
            .get("reviewStatus")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        let confidence = obj
            .get("confidence")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let sources = obj
            .get("sources")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        if crate::handlers::review::clears_learner_gate(&status, confidence, &sources) {
            continue;
        }

        for field in ["rule", "arabicName", "category", "severity", "explanation"] {
            if obj.contains_key(field) {
                obj.insert(field.to_owned(), serde_json::json!(""));
            }
        }
        if obj.contains_key("wordId") {
            obj.insert("wordId".to_owned(), serde_json::json!(""));
        }
        obj.insert("confidence".to_owned(), serde_json::json!(0.0));
        obj.insert("sources".to_owned(), serde_json::json!([]));
        obj.insert("withheld".to_owned(), serde_json::json!(true));
    }
}

/// Write the findings the ML service just computed into `tajweed_findings`.
///
/// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
/// `services/ml-inference` has no database. It computes findings per request and returns them, and
/// until this function nothing ever persisted one: `grep "INSERT INTO tajweed_findings" services/`
/// matched only tests, and every row in a real deployment came from `0006_seed_internal.sql`. So the
/// teacher queue showed seed data, and a learner's actual mistakes were analysed and discarded in
/// the same breath.
///
/// ── Three constraints, and what each forces ─────────────────────────────────────────────────────
/// **1. A finding must anchor to a real alignment.** `tajweed_findings.alignment_id` references
/// `word_alignments`, and a finding says "this word, in this recitation, was mispronounced" — the
/// alignment is the evidence that the word was heard at all. Findings whose `wordId` has no
/// alignment in this session are SKIPPED, not invented: manufacturing a `word_alignments` row would
/// mean fabricating `heardText`, `startMs` and `endMs` for audio nobody aligned.
///
/// That has a consequence worth stating plainly: the Flutter practice flow does not persist
/// alignments (it streams to the gateway, which forwards audio chunks and produces none), so today
/// this writes nothing for a Flutter session. The count is logged rather than left silent.
///
/// **2. Once per session.** `persist_session_alignments` cascades `teacher_reviews` →
/// `tajweed_findings` → `word_alignments` on re-record. If re-analysis re-wrote findings it would
/// destroy a teacher's completed review because a learner tapped stop twice. The analyser is
/// deterministic over canonical text, so a second run has nothing new to say: if the session
/// already has findings, this is a no-op.
///
/// **3. The response's own `modelVersion` is not a usable FK.** ml-inference reports
/// `ml-aligner-v0.2` — its global model name, an ALIGNMENT model — on a tajweed response, and no
/// such row exists in `model_versions`. Rather than substitute silently (the failure
/// `persist_session_alignments` documents at length), the tajweed model is resolved by kind, and
/// anything other than exactly one match refuses rather than guesses.
async fn persist_tajweed_findings(
    state: &AppState,
    tenant_id: &str,
    actor_id: &str,
    session_id: &str,
    result: &serde_json::Value,
    trace_id: Option<&str>,
) -> Result<(), ApiError> {
    let findings = match result.get("findings").and_then(|v| v.as_array()) {
        Some(f) if !f.is_empty() => f,
        _ => return Ok(()),
    };

    let mut tx = crate::begin_tenant_tx(&state.pool, tenant_id).await?;

    // Constraint 2 — already analysed. Checked FIRST so the common re-run path costs one query.
    // `sqlx::query` and not `query_scalar::<_, i64>`: Postgres types a bare `SELECT 1` as int4, so
    // decoding it as i64 fails at runtime and surfaces as a 500 on a learner's analysis request.
    // `create_teacher_review`'s existence check is written this way for the same reason.
    let existing = sqlx::query(
        "SELECT 1 FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id
         WHERE wa.session_id = $1 AND wa.tenant_id = $2 LIMIT 1",
    )
    .bind(session_id)
    .bind(tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    if existing.is_some() {
        tx.commit().await?;
        return Ok(());
    }

    // Constraint 1 — word_id → alignment id, for this session only.
    let alignment_rows = sqlx::query(
        "SELECT id, word_id FROM word_alignments WHERE session_id = $1 AND tenant_id = $2",
    )
    .bind(session_id)
    .bind(tenant_id)
    .fetch_all(&mut *tx)
    .await?;
    let alignments: std::collections::HashMap<String, String> = alignment_rows
        .into_iter()
        .filter_map(|r| Some((r.try_get("word_id").ok()?, r.try_get("id").ok()?)))
        .collect();
    if alignments.is_empty() {
        tx.commit().await?;
        tracing::info!(
            "tajweed findings not persisted for session {session_id}: it has no word alignments to \
             anchor them to, so there is no evidence a finding could point at"
        );
        return Ok(());
    }

    // Constraint 3 — resolve the tajweed model by kind.
    let model_versions: Vec<String> =
        sqlx::query_scalar("SELECT id FROM model_versions WHERE kind = 'tajweed' ORDER BY id")
            .fetch_all(&mut *tx)
            .await?;
    let [model_version] = model_versions.as_slice() else {
        tracing::error!(
            "cannot persist tajweed findings: model_versions has {} rows of kind 'tajweed', \
             expected exactly 1 — refusing to guess which produced these findings",
            model_versions.len()
        );
        return Err(ApiError::Upstream(
            "tajweed findings could not be recorded for review".to_owned(),
        ));
    };

    let audit_id = next_id("audit");
    // Ordered before the findings, which FK-reference this row.
    // `actor_id` REFERENCES users(id), so it must be a real user — a synthetic 'ml-inference'
    // is a foreign-key violation, which surfaces as a 500 on a learner's analysis request. The
    // authenticated caller is the honest answer anyway: they asked for the analysis.
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, 'ml.tajweed.persisted', 'recitation_session', $4, $5)",
    )
    .bind(&audit_id)
    .bind(tenant_id)
    .bind(actor_id)
    .bind(session_id)
    .bind(serde_json::json!({"trace_id": trace_id, "findingCount": findings.len()}))
    .execute(&mut *tx)
    .await?;

    // `severity` has a CHECK constraint; an unknown value would be a 500 on a learner's request.
    const SEVERITIES: [&str; 3] = ["practice", "warning", "critical"];
    let mut written = 0usize;
    let mut unanchored = 0usize;
    for finding in findings {
        let Some(word_id) = finding.get("wordId").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(alignment_id) = alignments.get(word_id) else {
            unanchored += 1;
            continue;
        };
        let severity = finding
            .get("severity")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !SEVERITIES.contains(&severity) {
            unanchored += 1;
            continue;
        }

        sqlx::query(
            // `analysis_basis` is a LITERAL, not a field read from the ML response.
            //
            // `analyzeAyah` inspects `word.text` — the canonical Uthmani text — and nothing else: no
            // audio, no heard text, no timing, no pitch. Every finding it produces is "a rule applies
            // at this position in the passage", which is true of the text and identical for every
            // learner who ever recites it. Recording that is what lets a teacher tell it apart from a
            // judgement about how THIS learner recited.
            //
            // Hardcoded for the same reason `TranscriptSource::ClientReported` is (ADR-0030): a value
            // read from a response is one refactor away from being caller-controlled, and this one
            // decides whether a teacher trusts what they are looking at. When an acoustic analyser
            // exists, writing `acoustic` will be a deliberate code change with its own review.
            "INSERT INTO tajweed_findings
               (id, tenant_id, alignment_id, rule, severity, confidence, explanation,
                review_status, source_refs, model_version_id, audit_event_id, analysis_basis)
             VALUES ($1, $2, $3, $4, $5, $6::float8::numeric, $7, 'ai-suggested', $8, $9, $10, 'canonical-text')",
        )
        .bind(next_id("tajweed-finding"))
        .bind(tenant_id)
        .bind(alignment_id)
        .bind(finding.get("rule").and_then(|v| v.as_str()).unwrap_or(""))
        .bind(severity)
        // `ai-suggested` is not negotiable here and is written as a literal above: this is a model's
        // opinion, and only `create_teacher_review` may move it (ADR-0027).
        // `::float8::numeric` in the VALUES list, matching persist_session_alignments: the column
        // is `numeric` and sqlx binds an f64 as float8, which Postgres will not coerce. Without
        // the cast this is a 500 on a learner's analysis request.
        .bind(
            finding
                .get("confidence")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                .clamp(0.0, 1.0),
        )
        .bind(
            finding
                .get("explanation")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        )
        .bind(
            finding
                .get("sources")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([])),
        )
        .bind(model_version)
        .bind(&audit_id)
        .execute(&mut *tx)
        .await?;
        written += 1;
    }

    tx.commit().await?;
    if unanchored > 0 {
        tracing::info!(
            "session {session_id}: persisted {written} tajweed findings, skipped {unanchored} with \
             no matching alignment or an unknown severity"
        );
    }
    Ok(())
}

/// Proxy alignment prediction through the platform API so the ML API key stays server-side.
pub async fn proxy_predict_alignment(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    body: JsonBody<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    proxy_ml(
        &state,
        &method,
        &headers,
        "alignment",
        "/v1/alignments:predict",
        body,
    )
    .await
}

/// Proxy tajweed prediction through the platform API so the ML API key stays server-side.
pub async fn proxy_predict_tajweed(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    body: JsonBody<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    proxy_ml(
        &state,
        &method,
        &headers,
        "tajweed",
        "/v1/tajweed-findings:predict",
        body,
    )
    .await
}

/// Proxy audio transcription to the internal ASR service so `ASR_API_KEY` stays server-side and the
/// browser never reaches the ASR service directly (previously the web posted audio straight to
/// :8091, which had no auth at all).
///
/// The caller must be an authenticated actor. Unlike the ML proxy there is no `tenantId` to override:
/// the transcribe request is `{audioBase64, audioFormat, language, wordTimestamps}` and performs no
/// tenant-scoped writes (it returns recognized text only), so authentication alone is the control.
///
/// Upstream failures map to a 502 with a GENERIC message; the underlying error (which can leak the
/// internal ASR URL / connection details) is logged server-side only.
pub async fn proxy_asr_transcribe(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    body: JsonBody<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    proxy_asr(
        &state,
        &method,
        &headers,
        "/v1/transcribe",
        "transcribe",
        body,
    )
    .await
}

/// Proxy forced alignment (T3) to the internal ASR service — audio + canonical transcript in,
/// per-word timestamps out. Same auth + server-side key control as transcribe; not tenant-scoped.
pub async fn proxy_asr_force_align(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    body: JsonBody<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    proxy_asr(
        &state,
        &method,
        &headers,
        "/v1/force-align",
        "force-align",
        body,
    )
    .await
}

/// Shared ASR forward: authenticate the caller, forward `body` to `{asr_inference_url}{path}` with
/// the server-side ASR key, and map upstream failures to a generic 502 (internal URL/errors are
/// logged, never returned). The ASR calls are not tenant-scoped (they return recognized text /
/// timestamps and perform no tenant writes), so authentication alone is the control.
async fn proxy_asr(
    state: &AppState,
    method: &Method,
    headers: &HeaderMap,
    path: &str,
    label: &str,
    body: JsonBody<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    crate::auth::resolve_actor(method, headers, state).await?;
    let Json(body) = body?;

    let response = state
        .http_client
        .post(format!("{}{}", state.asr_inference_url, path))
        .header("content-type", "application/json")
        .header("x-asr-api-key", &state.asr_api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            tracing::error!("ASR proxy {label} send error: {e}");
            ApiError::Upstream("ASR service unavailable".to_owned())
        })?;

    if !response.status().is_success() {
        tracing::warn!("ASR proxy {label} upstream status {}", response.status());
        return Err(ApiError::Upstream("ASR service error".to_owned()));
    }

    response.json().await.map(Json).map_err(|e| {
        tracing::error!("ASR proxy {label} parse error: {e}");
        ApiError::Upstream("ASR service returned an invalid response".to_owned())
    })
}
