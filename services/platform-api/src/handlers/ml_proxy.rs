use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, Method};
use sqlx::Row;

use crate::AppState;
use crate::types::*;

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
    mut body: serde_json::Value,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = crate::auth::resolve_actor(method, headers, state).await?;

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
        actor.require_self_or_any(&session_learner_id, &[ActorRole::Admin, ActorRole::Ops])?;
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

    let result: serde_json::Value = response.json().await.map_err(|e| {
        tracing::error!("ML proxy {label} parse error: {e}");
        ApiError::Upstream("ML service returned an invalid response".to_owned())
    })?;

    Ok(Json(result))
}

/// Proxy alignment prediction through the platform API so the ML API key stays server-side.
pub async fn proxy_predict_alignment(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
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
    Json(body): Json<serde_json::Value>,
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
    Json(body): Json<serde_json::Value>,
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
    Json(body): Json<serde_json::Value>,
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
    body: serde_json::Value,
) -> Result<Json<serde_json::Value>, ApiError> {
    crate::auth::resolve_actor(method, headers, state).await?;

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
