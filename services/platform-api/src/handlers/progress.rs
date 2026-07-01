use axum::Json;
use axum::extract::{Query, State};
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressQuery {
    /// Read another learner's progress. Staff (teacher/admin/ops) only; a learner may only
    /// pass their own id. Absent = the caller's own progress (unchanged default).
    pub learner_id: Option<String>,
}

/// Real learner progress: aggregates persisted SM-2 state + session history.
pub async fn get_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ProgressQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_any(&[
        ActorRole::Learner,
        ActorRole::Teacher,
        ActorRole::Admin,
        ActorRole::Ops,
    ])?;

    // Resolve whose progress to read. Reading another learner requires a staff role; a
    // learner passing their own id is fine, anyone else is Forbidden.
    let learner_id = match query.learner_id {
        Some(id) => {
            actor.require_self_or_any(
                &id,
                &[ActorRole::Teacher, ActorRole::Admin, ActorRole::Ops],
            )?;
            id
        }
        None => actor.user_id.clone(),
    };

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let total_sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM recitation_sessions WHERE tenant_id = $1 AND learner_id = $2",
    )
    .bind(&actor.tenant_id)
    .bind(&learner_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap_or(0);

    // Mastery = mean per-card retention from SM-2 repetitions (4+ reps == mastered).
    let reps: Vec<i32> = sqlx::query_scalar(
        "SELECT repetitions FROM learner_progress WHERE tenant_id = $1 AND learner_id = $2",
    )
    .bind(&actor.tenant_id)
    .bind(&learner_id)
    .fetch_all(&mut *tx)
    .await
    .unwrap_or_default();
    let mastery = if reps.is_empty() {
        0.0
    } else {
        let sum: f64 = reps.iter().map(|r| (*r as f64 / 4.0).min(1.0)).sum();
        ((sum / reps.len() as f64) * 1000.0).round() / 1000.0
    };

    let next_review: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT MIN(next_review_at) FROM learner_progress WHERE tenant_id = $1 AND learner_id = $2",
    )
    .bind(&actor.tenant_id)
    .bind(&learner_id)
    .fetch_one(&mut *tx)
    .await
    .ok()
    .flatten();

    let days: Vec<chrono::NaiveDate> = sqlx::query_scalar(
        "SELECT DISTINCT (started_at AT TIME ZONE 'UTC')::date AS d
         FROM recitation_sessions WHERE tenant_id = $1 AND learner_id = $2 ORDER BY d DESC",
    )
    .bind(&actor.tenant_id)
    .bind(&learner_id)
    .fetch_all(&mut *tx)
    .await
    .unwrap_or_default();
    let streak = compute_streak(&days);

    tx.commit().await?;

    Ok(Json(serde_json::json!({
        "learnerId": learner_id,
        "tenantId": actor.tenant_id,
        "totalSessions": total_sessions,
        "streak": streak,
        "mastery": mastery,
        "nextReviewAt": next_review.map(|d| d.to_rfc3339()),
    })))
}

/// Consecutive days (ending today or yesterday) that have >= 1 session.
fn compute_streak(days_desc: &[chrono::NaiveDate]) -> i32 {
    if days_desc.is_empty() {
        return 0;
    }
    let today = chrono::Utc::now().date_naive();
    let yesterday = today.pred_opt().unwrap_or(today);
    if days_desc[0] != today && days_desc[0] != yesterday {
        return 0;
    }
    let mut streak = 0;
    let mut expected = days_desc[0];
    for d in days_desc {
        if *d == expected {
            streak += 1;
            expected = expected.pred_opt().unwrap_or(expected);
        } else if *d < expected {
            break;
        }
    }
    streak
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressUpdate {
    pub quality: u32,
    pub ayah_ref: String,
}

/// Persist an SM-2 review for one ayah (upsert), reading the prior state first.
pub async fn update_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ProgressUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = actor_from_headers(&headers, &state.jwt_config)?;
    actor.require_self_or_any(&actor.user_id, &[ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let current = sqlx::query(
        "SELECT easiness_factor, interval_days, repetitions FROM learner_progress
         WHERE tenant_id = $1 AND learner_id = $2 AND ayah_ref = $3",
    )
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(&req.ayah_ref)
    .fetch_optional(&mut *tx)
    .await?;

    let prior = match current {
        Some(r) => Sm2State {
            easiness_factor: r.try_get("easiness_factor").unwrap_or(2.5),
            interval_days: r.try_get("interval_days").unwrap_or(1),
            repetitions: r.try_get("repetitions").unwrap_or(0),
        },
        None => Sm2State::default(),
    };

    let updated = sm2_update(&prior, req.quality);
    let next_review = chrono::Utc::now() + chrono::Duration::days(updated.interval_days as i64);

    sqlx::query(
        "INSERT INTO learner_progress
            (tenant_id, learner_id, ayah_ref, easiness_factor, interval_days, repetitions,
             last_quality, next_review_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (tenant_id, learner_id, ayah_ref) DO UPDATE SET
            easiness_factor = $4, interval_days = $5, repetitions = $6,
            last_quality = $7, next_review_at = $8, updated_at = now()",
    )
    .bind(&actor.tenant_id)
    .bind(&actor.user_id)
    .bind(&req.ayah_ref)
    .bind(updated.easiness_factor)
    .bind(updated.interval_days)
    .bind(updated.repetitions)
    .bind(req.quality as i32)
    .bind(next_review)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

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
