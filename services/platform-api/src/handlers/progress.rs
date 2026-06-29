use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::AppState;
use crate::auth::actor_from_headers;
use crate::types::*;

/// SM-2 spaced repetition algorithm.
/// Given the current state and quality of response (0-5), returns the new state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sm2State {
    pub easiness_factor: f64,
    pub interval_days: i32,
    pub repetitions: i32,
}

impl Default for Sm2State {
    fn default() -> Self {
        Self {
            easiness_factor: 2.5,
            interval_days: 1,
            repetitions: 0,
        }
    }
}

/// Quality of response: 0 (complete failure) to 5 (perfect response)
pub fn sm2_update(state: &Sm2State, quality: u32) -> Sm2State {
    let q = quality.min(5) as f64;

    let (repetitions, interval, ef) = if q < 3.0 {
        // Failed — reset
        (0, 1, state.easiness_factor)
    } else {
        let new_rep = state.repetitions + 1;
        let new_interval = if new_rep == 1 {
            1
        } else if new_rep == 2 {
            6
        } else {
            ((state.interval_days as f64) * state.easiness_factor).round() as i32
        };

        let new_ef =
            (state.easiness_factor + (0.1 - (5.0 - q) * (0.08 + (5.0 - q) * 0.02))).max(1.3);

        (new_rep, new_interval, new_ef)
    };

    Sm2State {
        easiness_factor: ef,
        interval_days: interval,
        repetitions,
    }
}

/// Get learner progress (stored in agent_runs table as a simple progress record)
pub async fn get_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[
        ActorRole::Learner,
        ActorRole::Teacher,
        ActorRole::Admin,
        ActorRole::Ops,
    ])?;

    // Count sessions for this learner
    let session_count = sqlx::query(
        "SELECT COUNT(*) as count FROM recitation_sessions WHERE tenant_id = $1 AND learner_id = $2",
    )
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .fetch_one(&state.pool)
    .await?;

    let count: i64 = session_count.try_get("count").unwrap_or(0);

    Ok(Json(serde_json::json!({
        "learnerId": actor.user_id,
        "tenantId": actor.tenant_id,
        "totalSessions": count,
        "streak": 0,
        "mastery": 0.0,
        "nextReviewAt": null,
    })))
}

/// Update learner progress after a practice session
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressUpdate {
    pub quality: u32,
    pub ayah_ref: String,
}

pub async fn update_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ProgressUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_self_or_any(&actor.user_id, &[ActorRole::Admin, ActorRole::Ops])?;

    // Run SM-2 update
    let current = Sm2State::default();
    let updated = sm2_update(&current, req.quality);

    let next_review = chrono::Utc::now() + chrono::Duration::days(updated.interval_days as i64);

    Ok(Json(serde_json::json!({
        "learnerId": actor.user_id,
        "tenantId": actor.tenant_id,
        "ayahRef": req.ayah_ref,
        "sm2State": {
            "easinessFactor": updated.easiness_factor,
            "intervalDays": updated.interval_days,
            "repetitions": updated.repetitions,
        },
        "nextReviewAt": next_review.to_rfc3339(),
        "quality": req.quality,
    })))
}
