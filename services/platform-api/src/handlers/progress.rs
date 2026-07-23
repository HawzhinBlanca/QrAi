use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::AppState;
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
        // Cap the interval at 10 years. Left unbounded, it grows by ×EF every perfect review
        // and eventually overflows chrono when added to `now()` (Utc::now() + Duration::days),
        // panicking the request. Spaced repetition never needs a longer interval.
        const MAX_INTERVAL_DAYS: i32 = 3650;
        let new_interval = if new_rep == 1 {
            1
        } else if new_rep == 2 {
            6
        } else {
            (((state.interval_days as f64) * state.easiness_factor).round() as i32)
                .min(MAX_INTERVAL_DAYS)
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
    method: axum::http::Method,
    headers: HeaderMap,
    Query(query): Query<ProgressQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
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
    .await?;

    // Mastery = mean per-card retention from SM-2 repetitions (4+ reps == mastered).
    let reps: Vec<i32> = sqlx::query_scalar(
        "SELECT repetitions FROM learner_progress WHERE tenant_id = $1 AND learner_id = $2",
    )
    .bind(&actor.tenant_id)
    .bind(&learner_id)
    .fetch_all(&mut *tx)
    .await?;
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
    .await?;

    let days: Vec<chrono::NaiveDate> = sqlx::query_scalar(
        "SELECT DISTINCT (started_at AT TIME ZONE 'UTC')::date AS d
         FROM recitation_sessions WHERE tenant_id = $1 AND learner_id = $2 ORDER BY d DESC",
    )
    .bind(&actor.tenant_id)
    .bind(&learner_id)
    .fetch_all(&mut *tx)
    .await?;
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

/// Real per-day practice history for the last 7 days: session count and word-level accuracy
/// (matched / total aligned words) per UTC day. This exists so the web's weekly chart can show
/// MEASURED data — the previous client-side implementation fabricated a linear "week" from the
/// single mastery scalar (see apps/web/src/data/quran.ts history), which violated the repo's
/// no-fake-data rule. Days with sessions but no persisted alignments report accuracy: null
/// (unknown), NOT 0 (which would falsely read as "got everything wrong").
///
/// There is deliberately NO minutes/duration field: recitation_sessions has no duration column
/// (latency_ms is processing latency), so practice minutes cannot be honestly computed.
pub async fn get_weekly_progress(
    State(state): State<AppState>,
    method: axum::http::Method,
    headers: HeaderMap,
    Query(query): Query<ProgressQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;
    actor.require_any(&[
        ActorRole::Learner,
        ActorRole::Teacher,
        ActorRole::Admin,
        ActorRole::Ops,
    ])?;

    // Same ownership rule as get_progress: reading another learner requires a staff role.
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

    // word_alignments has no timestamp of its own; a word belongs to the day its session started.
    // LEFT JOIN so a day with sessions but no alignments still appears (accuracy null).
    let rows = sqlx::query(
        "SELECT (rs.started_at AT TIME ZONE 'UTC')::date AS day,
                COUNT(DISTINCT rs.id) AS sessions,
                COUNT(wa.id) AS words_total,
                COUNT(wa.id) FILTER (WHERE wa.status = 'matched') AS words_matched
         FROM recitation_sessions rs
         LEFT JOIN word_alignments wa
           ON wa.session_id = rs.id AND wa.tenant_id = rs.tenant_id
         WHERE rs.tenant_id = $1 AND rs.learner_id = $2
           AND rs.started_at >= now() - interval '7 days'
         GROUP BY day
         ORDER BY day",
    )
    .bind(&actor.tenant_id)
    .bind(&learner_id)
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    let days: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            let day: chrono::NaiveDate = r.try_get("day").unwrap_or_default();
            let sessions: i64 = r.try_get("sessions").unwrap_or(0);
            let words_total: i64 = r.try_get("words_total").unwrap_or(0);
            let words_matched: i64 = r.try_get("words_matched").unwrap_or(0);
            let accuracy = if words_total > 0 {
                serde_json::json!(
                    ((words_matched as f64 / words_total as f64) * 1000.0).round() / 10.0
                )
            } else {
                serde_json::Value::Null
            };
            serde_json::json!({
                "date": day.to_string(),
                "sessions": sessions,
                "wordsTotal": words_total,
                "wordsMatched": words_matched,
                "accuracy": accuracy,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "learnerId": learner_id,
        "tenantId": actor.tenant_id,
        "days": days,
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
    method: axum::http::Method,
    headers: HeaderMap,
    Json(req): Json<ProgressUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // ProgressUpdate has no learner_id field -- this always writes the caller's own row (unlike
    // get_progress, which takes an optional learner_id and needs a real ownership/role check).
    // A prior version of this line was `require_self_or_any(&actor.user_id, ...)`, comparing the
    // actor's id to itself -- a tautology that always passed and read as an authz gate without
    // being one. actor_from_headers() already requires a valid, tenant-scoped token, which is the
    // only check this handler needs.
    let actor = crate::auth::resolve_actor(&method, &headers, &state).await?;

    let mut tx = crate::begin_tenant_tx(&state.pool, &actor.tenant_id).await?;

    // This handler reads the prior SM-2 state, computes the next state IN RUST, then writes it —
    // the read and the write are two separate round trips, so `INSERT ... ON CONFLICT DO UPDATE`
    // alone does NOT close a lost-update race: two concurrent reviews for the same (learner, ayah)
    // can both read the same prior state before either commits, and the second write clobbers the
    // first's progression instead of building on it. Verified empirically: 8 concurrent quality=5
    // submissions for one ayah left repetitions=4, not 8 — half the reviews were silently lost.
    //
    // A Postgres advisory lock keyed on (tenant, learner, ayah) serializes the whole read-compute-
    // write section for that specific triple: a second concurrent request blocks here until the
    // first commits, then its own SELECT correctly sees the just-committed state. Auto-released at
    // transaction end (commit or rollback) — never needs an explicit unlock. Unlike `SELECT ...
    // FOR UPDATE`, this also covers a learner's FIRST-ever review of an ayah, where there is no
    // existing row yet to lock.
    let lock_key = format!(
        "progress:{}:{}:{}",
        actor.tenant_id, actor.user_id, req.ayah_ref
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(&lock_key)
        .execute(&mut *tx)
        .await?;

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

    // Clamp the SM-2 quality to its 0..=5 domain BEFORE use: sm2_update clamps internally, but the
    // raw value is also stored in learner_progress.last_quality, which has a CHECK (0..5) — an
    // out-of-range input (e.g. a client bug or a future 0..10 slider) would otherwise violate the
    // constraint and fail the whole write with a leaking 500 instead of persisting the review.
    let quality = req.quality.min(5);
    let updated = sm2_update(&prior, quality);
    // Defensive clamp (in case a pre-existing row stored a huge interval): never feed an
    // out-of-range day count into chrono's Add, which would panic.
    let next_review =
        chrono::Utc::now() + chrono::Duration::days(updated.interval_days.clamp(1, 3650) as i64);

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
    .bind(quality as i32)
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
        "quality": quality,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn sm2_update_pins_the_exact_ef_arithmetic() {
        // EF' = EF + (0.1 - (5-q)*(0.08 + (5-q)*0.02)), floored at 1.3. The existing tests only
        // assert direction (EF rose/fell), which a `+`/`-`/`*`/`/` slip in the formula can still
        // satisfy. Pin exact values for two quality grades so the arithmetic itself is checked.
        let state = Sm2State::default(); // ef = 2.5
        let q5 = sm2_update(&state, 5);
        // q=5: (5-q)=0 -> term = 0.1 - 0*(0.08+0) = 0.1 -> ef' = 2.6
        assert!(
            (q5.easiness_factor - 2.6).abs() < 1e-9,
            "expected ef 2.6, got {}",
            q5.easiness_factor
        );

        let q3 = sm2_update(&state, 3);
        // q=3: (5-q)=2 -> term = 0.1 - 2*(0.08+2*0.02) = 0.1 - 2*0.12 = -0.14 -> ef' = 2.36
        assert!(
            (q3.easiness_factor - 2.36).abs() < 1e-9,
            "expected ef 2.36, got {}",
            q3.easiness_factor
        );
    }

    fn days_ago(n: i64) -> chrono::NaiveDate {
        chrono::Utc::now().date_naive() - Duration::days(n)
    }

    #[test]
    fn compute_streak_is_zero_for_no_sessions() {
        assert_eq!(compute_streak(&[]), 0);
    }

    #[test]
    fn compute_streak_is_zero_when_the_most_recent_session_is_not_today_or_yesterday() {
        assert_eq!(compute_streak(&[days_ago(2)]), 0);
    }

    #[test]
    fn compute_streak_counts_a_single_session_today() {
        assert_eq!(compute_streak(&[days_ago(0)]), 1);
    }

    #[test]
    fn compute_streak_counts_a_single_session_yesterday_as_a_live_streak() {
        // A streak "ending today or yesterday" still counts — the learner has until end of day
        // to keep it alive, not lose credit the moment midnight passes.
        assert_eq!(compute_streak(&[days_ago(1)]), 1);
    }

    #[test]
    fn compute_streak_counts_consecutive_days_ending_today() {
        assert_eq!(compute_streak(&[days_ago(0), days_ago(1), days_ago(2)]), 3);
    }

    #[test]
    fn compute_streak_stops_at_the_first_gap() {
        // Sessions today, yesterday, then a gap (2 days ago missing), then 3/4 days ago. Only the
        // unbroken run counting back from today should count.
        assert_eq!(
            compute_streak(&[days_ago(0), days_ago(1), days_ago(3), days_ago(4)]),
            2
        );
    }

    #[test]
    fn compute_streak_never_resumes_counting_after_a_gap_even_if_a_later_date_realigns() {
        // Sessions today, yesterday, then a gap (5 days ago instead of the expected 2 days ago),
        // then a date that WOULD match `expected` (2 days ago) if the loop kept scanning instead
        // of breaking on the gap. A `break` -> "just don't match, keep looping" regression (e.g.
        // `<` mutated to `==`) would let this later entry re-match and wrongly extend the streak
        // to 3; the real streak, ending at the 5-days-ago gap, is 2.
        assert_eq!(
            compute_streak(&[days_ago(0), days_ago(1), days_ago(5), days_ago(2)]),
            2
        );
    }

    #[test]
    fn compute_streak_ignores_a_duplicate_day_without_double_counting() {
        // Two sessions on the same day (already deduped by the DISTINCT query in practice, but
        // compute_streak itself must not silently double-count if that ever changes) must not
        // inflate the streak — the loop's `*d == expected` / `*d < expected` branches must not
        // treat a repeated date as a fresh day.
        assert_eq!(compute_streak(&[days_ago(0), days_ago(0), days_ago(1)]), 2);
    }
}
