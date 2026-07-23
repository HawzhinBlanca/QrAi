use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use sqlx::Row;

use crate::AppState;
use crate::types::*;

pub async fn get_eval_run(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    Path(model_version): Path<String>,
) -> Result<Json<EvalRun>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[ActorRole::Admin, ActorRole::Ops])?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    let row = sqlx::query(
        "SELECT model_version_id, dataset_version,
                word_alignment_f1::float8 as word_alignment_f1,
                tajweed_f1::float8 as tajweed_f1,
                false_positive_rate::float8 as false_positive_rate,
                teacher_agreement_rate::float8 as teacher_agreement_rate,
                unsourced_learner_outputs, passed
         FROM eval_runs
         WHERE model_version_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC
         LIMIT 1",
    )
    .bind(&model_version)
    .bind(&actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;

    tx.commit().await?;

    Ok(Json(EvalRun {
        model_version: row.try_get("model_version_id")?,
        dataset_version: row.try_get("dataset_version")?,
        word_alignment_f1: row.try_get::<f64, _>("word_alignment_f1")? as f32,
        tajweed_f1: row.try_get::<f64, _>("tajweed_f1")? as f32,
        false_positive_rate: row.try_get::<f64, _>("false_positive_rate")? as f32,
        teacher_agreement_rate: row.try_get::<f64, _>("teacher_agreement_rate")? as f32,
        unsourced_learner_outputs: row
            .try_get::<i32, _>("unsourced_learner_outputs")
            .unwrap_or(0) as u32,
        passed: row.try_get("passed")?,
    }))
}
