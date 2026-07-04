use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;

use crate::AppState;
use crate::auth::actor_from_headers;
use crate::types::*;

/// Server-side ML inference URL (never exposed to the browser).
fn ml_inference_url() -> String {
    std::env::var("ML_INFERENCE_URL").unwrap_or_else(|_| "http://127.0.0.1:8090".to_owned())
}

/// Server-side ML API key (never exposed to the browser). In production the key MUST be set; the
/// insecure default is refused at boot unless ALLOW_INSECURE_DEFAULTS is enabled (see main.rs
/// `ensure_secure_config`), so this fallback only ever applies in dev/CI.
fn ml_api_key() -> String {
    std::env::var("ML_API_KEY").unwrap_or_else(|_| "smoke-ml-api-key".to_owned())
}

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
    headers: &HeaderMap,
    label: &str,
    path: &str,
    mut body: serde_json::Value,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = actor_from_headers(headers, &state.jwt_config)?;

    let obj = body
        .as_object_mut()
        .ok_or_else(|| ApiError::BadRequest("request body must be a JSON object".to_owned()))?;
    // Server-authoritative tenant: ignore whatever the client claimed.
    obj.insert(
        "tenantId".to_owned(),
        serde_json::Value::String(actor.tenant_id.clone()),
    );

    let response = state
        .http_client
        .post(format!("{}{}", ml_inference_url(), path))
        .header("content-type", "application/json")
        .header("x-ml-api-key", ml_api_key())
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
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    proxy_ml(
        &state,
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
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    proxy_ml(
        &state,
        &headers,
        "tajweed",
        "/v1/tajweed-findings:predict",
        body,
    )
    .await
}

/// Server-side ASR inference URL (never exposed to the browser).
fn asr_inference_url() -> String {
    std::env::var("ASR_INFERENCE_URL").unwrap_or_else(|_| "http://127.0.0.1:8091".to_owned())
}

/// Server-side ASR API key (never exposed to the browser). In production the key MUST be set; the
/// insecure default is refused at boot unless ALLOW_INSECURE_DEFAULTS is enabled (see main.rs
/// `ensure_secure_config`), so this fallback only ever applies in dev/CI.
fn asr_api_key() -> String {
    std::env::var("ASR_API_KEY").unwrap_or_else(|_| "smoke-asr-api-key".to_owned())
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
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Authenticate the caller (propagates 401 on a missing/invalid actor). The actor value itself is
    // unused because the transcribe call is not tenant-scoped.
    actor_from_headers(&headers, &state.jwt_config)?;

    let response = state
        .http_client
        .post(format!("{}/v1/transcribe", asr_inference_url()))
        .header("content-type", "application/json")
        .header("x-asr-api-key", asr_api_key())
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            tracing::error!("ASR proxy transcribe send error: {e}");
            ApiError::Upstream("ASR service unavailable".to_owned())
        })?;

    if !response.status().is_success() {
        tracing::warn!("ASR proxy transcribe upstream status {}", response.status());
        return Err(ApiError::Upstream("ASR service error".to_owned()));
    }

    let result: serde_json::Value = response.json().await.map_err(|e| {
        tracing::error!("ASR proxy transcribe parse error: {e}");
        ApiError::Upstream("ASR service returned an invalid response".to_owned())
    })?;

    Ok(Json(result))
}
