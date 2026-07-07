use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::IntoResponse;
use serde_json::{Value, json};
use tower::ServiceExt;

use quran_ai_platform_api::{AppState, platform_router_with_rate_limit};

fn test_state() -> AppState {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect_lazy(
            &std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgresql://hawzhin@localhost:5432/quran_ai".to_owned()),
        )
        .expect("failed to create pool");
    // Tests exercise the spoofable header-auth path; enable it explicitly so we don't
    // depend on a process-wide env var. Production reads ALLOW_HEADER_AUTH (default off).
    AppState::with_header_auth(pool, "test-jwt-secret", true)
}

async fn send_json(
    router: &axum::Router,
    method: Method,
    uri: &str,
    tenant: Option<&str>,
    role: Option<&str>,
    body: Value,
) -> axum::response::Response {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(tenant) = tenant {
        request = request.header("x-tenant-id", tenant);
    }
    if let Some(role) = role {
        request = request
            .header(
                "x-user-id",
                match role {
                    "learner" => "learner-1",
                    "teacher" => "teacher-1",
                    "scholar" => "scholar-1",
                    "admin" => "admin-1",
                    "ops" => "ops-1",
                    _ => "unknown",
                },
            )
            .header("x-user-role", role);
    }
    router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

async fn read_json<T: serde::de::DeserializeOwned>(response: axum::response::Response) -> T {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// Security regression: when header-auth is OFF (production default), spoofed
/// x-user-role headers must NOT grant access — a valid Bearer JWT is required.
/// Auth is rejected before any DB access, so this needs no live Postgres.
#[tokio::test]
async fn rejects_spoofed_header_identity_when_header_auth_disabled() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy("postgresql://invalid:invalid@127.0.0.1:1/none")
        .expect("lazy pool");
    let state = AppState::with_header_auth(pool, "test-jwt-secret", false);
    let router = platform_router_with_rate_limit(state, false);

    // Spoofed admin headers — must be rejected with 401.
    let response = send_json(
        &router,
        Method::GET,
        "/v1/scholar-approvals",
        Some("tenant-quran-ai"),
        Some("admin"),
        json!({}),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "spoofed header identity must be rejected when ALLOW_HEADER_AUTH is off"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn creates_recitation_session_in_postgres() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "learnerId": "learner-1",
            "quranRef": {
                "surahNumber": 1,
                "ayahStart": 1,
                "ayahEnd": 7,
                "display": "Al-Fatihah 1:1-7"
            },
            "sourceChecksum": "fnv1a32:test",
            "modelVersion": "model-v0.3",
            "language": "ckb",
            "mode": "guided-recite",
            "practicePlanId": "fatihah-mastery-v1",
            "consent": {
                "audioRetention": "discard",
                "anonymizedLearning": true,
                "externalAsrProcessing": false,
                "guardianApproved": true,
                "consentVersion": "pilot-v1"
            }
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = read_json(response).await;
    assert!(body["id"].as_str().unwrap().starts_with("session-"));
    assert_eq!(body["tenantId"], "hikmah-pilot-erbil");
    assert_eq!(body["learnerId"], "learner-1");
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn gets_quran_surah_list_from_postgres() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::GET,
        "/v1/quran/surahs",
        None,
        None,
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Vec<Value> = read_json(response).await;
    assert!(body.len() >= 114);
    // Surah 1 has a real name in canonical_surahs; a bug that filtered the case backwards (keeping
    // only empty names) would make list_surahs fall back to the synthetic "Surah 1" placeholder for
    // every surah with real metadata.
    let surah_1 = body
        .iter()
        .find(|s| s["surahNumber"] == json!(1))
        .expect("surah 1 must be present");
    assert_eq!(surah_1["name"], "Al-Faatiha");
    assert_ne!(surah_1["name"], "Surah 1");
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn gets_eval_run_from_postgres() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::GET,
        "/v1/eval-runs/model-v0.3",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = read_json(response).await;
    assert_eq!(body["modelVersion"], "model-v0.3");
    assert_eq!(body["passed"], true);
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn registers_then_logs_in_a_new_user() {
    let router = platform_router_with_rate_limit(test_state(), false);

    // Register a fresh learner. No email -> unique auto-generated user id each run,
    // so the test is idempotent against a shared database.
    let register = send_json(
        &router,
        Method::POST,
        "/v1/auth/register",
        None,
        None,
        json!({
            "tenantId": "hikmah-pilot-erbil",
            "displayName": "E2E Test User",
            "role": "learner",
            "language": "en",
            "password": "SmokeTest1234"
        }),
    )
    .await;
    assert_eq!(register.status(), StatusCode::OK);
    let reg_body: Value = read_json(register).await;
    let user_id = reg_body["userId"].as_str().unwrap().to_string();
    assert!(user_id.starts_with("user-"));
    assert!(reg_body["token"].as_str().unwrap().len() > 20);

    // Log in with the new credentials.
    let login = send_json(
        &router,
        Method::POST,
        "/v1/auth/login",
        None,
        None,
        json!({ "userId": user_id, "tenantId": "hikmah-pilot-erbil", "password": "SmokeTest1234" }),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let login_body: Value = read_json(login).await;
    assert_eq!(login_body["userId"], user_id);
    assert_eq!(login_body["role"], "learner");
    assert!(login_body["token"].as_str().unwrap().len() > 20);

    // Wrong password must be rejected.
    let bad = send_json(
        &router,
        Method::POST,
        "/v1/auth/login",
        None,
        None,
        json!({ "userId": user_id, "tenantId": "hikmah-pilot-erbil", "password": "wrong-password" }),
    )
    .await;
    assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);

    // A NON-EXISTENT user must also be rejected with 401 (never 404/500) — this exercises the login
    // path's "no row" branch, which now still runs one bcrypt verify against a decoy hash so response
    // latency can't distinguish "no such user" from "wrong password" (account-enumeration side-channel).
    let missing = send_json(
        &router,
        Method::POST,
        "/v1/auth/login",
        None,
        None,
        json!({ "userId": "user-does-not-exist-xyz", "tenantId": "hikmah-pilot-erbil", "password": "whatever12345" }),
    )
    .await;
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
}

/// Security/data-integrity regression: registration's email-uniqueness check is SELECT-then-INSERT,
/// which under READ COMMITTED is a TOCTOU race — verified empirically that 10 truly concurrent
/// registrations with an identical email ALL succeeded before this was fixed (0013 migration adds a
/// partial unique index; the handler maps the resulting unique_violation to a clean 400). Fire several
/// genuinely concurrent registrations with the same email and assert exactly one wins.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn concurrent_registration_with_same_email_is_race_safe() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let email = format!("race-itest-{}@example.com", next_suffix());

    // Collect the JoinHandles FIRST (tokio::spawn starts the task immediately) so all 5 requests are
    // genuinely in flight together before we await any of them — a sequential await-per-iteration
    // would serialize the requests and never exercise the race.
    let handles: Vec<_> = (0..5)
        .map(|i| {
            let router = router.clone();
            let email = email.clone();
            tokio::spawn(async move {
                send_json(
                    &router,
                    Method::POST,
                    "/v1/auth/register",
                    None,
                    None,
                    json!({
                        "tenantId": "hikmah-pilot-erbil",
                        "displayName": format!("Racer {i}"),
                        "role": "learner",
                        "language": "en",
                        "email": email,
                        "password": "RaceTest1234"
                    }),
                )
                .await
                .status()
            })
        })
        .collect();

    let mut statuses = Vec::with_capacity(handles.len());
    for handle in handles {
        statuses.push(handle.await.expect("register task panicked"));
    }

    let ok_count = statuses.iter().filter(|s| **s == StatusCode::OK).count();
    let bad_request_count = statuses
        .iter()
        .filter(|s| **s == StatusCode::BAD_REQUEST)
        .count();
    assert_eq!(
        ok_count, 1,
        "exactly one concurrent registration must win: {statuses:?}"
    );
    assert_eq!(
        bad_request_count, 4,
        "every loser must get a clean 400 (never a 500 leaking the DB constraint error): {statuses:?}"
    );
}

/// Data-integrity regression: update_progress reads the prior SM-2 state, computes the next state IN
/// RUST, then writes it — two separate round trips, so `INSERT ... ON CONFLICT DO UPDATE` alone does
/// NOT close a lost-update race (unlike the email-uniqueness race above, a DB constraint can't help
/// here — the race is in the compute step, not the write). Verified empirically before the fix: 8
/// concurrent quality=5 submissions for one ayah left `repetitions=4`, not 8 — half were silently
/// lost. Fixed with a `pg_advisory_xact_lock` keyed on (tenant, learner, ayah) that serializes the
/// whole read-compute-write section, including a learner's very first review of an ayah (where there
/// is no existing row yet for `SELECT ... FOR UPDATE` to lock).
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn concurrent_progress_updates_for_the_same_ayah_do_not_lose_repetitions() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let ayah_ref = format!("1:lost-update-itest-{}", next_suffix());

    let handles: Vec<_> = (0..8)
        .map(|_| {
            let router = router.clone();
            let ayah_ref = ayah_ref.clone();
            tokio::spawn(async move {
                send_json(
                    &router,
                    Method::POST,
                    "/v1/learner/progress",
                    Some("hikmah-pilot-erbil"),
                    Some("learner"),
                    json!({ "quality": 5, "ayahRef": ayah_ref }),
                )
                .await
                .status()
            })
        })
        .collect();

    for handle in handles {
        assert_eq!(
            handle.await.expect("progress task panicked"),
            StatusCode::OK
        );
    }

    let repetitions: i32 = sqlx::query_scalar(
        "SELECT repetitions FROM learner_progress
         WHERE tenant_id = 'hikmah-pilot-erbil' AND learner_id = 'learner-1' AND ayah_ref = $1",
    )
    .bind(&ayah_ref)
    .fetch_one(&state.pool)
    .await
    .expect("progress row must exist after 8 successful submissions");

    assert_eq!(
        repetitions, 8,
        "every one of the 8 concurrent perfect-quality reviews must be reflected — a lower count means \
         the advisory lock is not serializing the read-compute-write section"
    );
}

#[test]
fn sm2_spaced_repetition_updates_correctly() {
    use quran_ai_platform_api::handlers::progress::{Sm2State, sm2_update};

    // Perfect response (quality=5)
    let state = Sm2State::default();
    let updated = sm2_update(&state, 5);
    assert_eq!(updated.repetitions, 1);
    assert_eq!(updated.interval_days, 1);
    assert!(updated.easiness_factor > 2.5);

    // Second perfect response
    let updated2 = sm2_update(&updated, 5);
    assert_eq!(updated2.repetitions, 2);
    assert_eq!(updated2.interval_days, 6);

    // Third perfect response
    let updated3 = sm2_update(&updated2, 5);
    assert!(updated3.interval_days > 6);

    // Failed response resets
    let failed = sm2_update(&updated3, 1);
    assert_eq!(failed.repetitions, 0);
    assert_eq!(failed.interval_days, 1);
}

#[test]
fn sm2_quality_three_is_a_pass_not_a_reset() {
    // The pass/fail boundary is `q < 3.0` — quality exactly 3 must count as a (weak) pass,
    // not trigger the reset branch, even though it's the lowest passing grade.
    use quran_ai_platform_api::handlers::progress::{Sm2State, sm2_update};

    let state = Sm2State::default();
    let updated = sm2_update(&state, 3);
    assert_eq!(
        updated.repetitions, 1,
        "quality=3 must increment repetitions, not reset"
    );
    assert_eq!(updated.interval_days, 1);
    // A weak pass shrinks EF (5-q=2 is the harshest non-failing penalty) but never below the
    // algorithm's 1.3 floor.
    assert!(updated.easiness_factor < state.easiness_factor);
    assert!(updated.easiness_factor >= 1.3);
}

#[test]
fn sm2_interval_never_exceeds_the_ten_year_cap() {
    // MAX_INTERVAL_DAYS (3650) exists specifically so interval_days never grows large enough to
    // overflow chrono when a caller later does `Utc::now() + Duration::days(interval_days)` —
    // left unbounded it grows by ×EF on every perfect review and EF itself keeps climbing.
    // Regression test for that cap actually holding under sustained perfect reviews.
    use quran_ai_platform_api::handlers::progress::{Sm2State, sm2_update};

    let mut state = Sm2State::default();
    for _ in 0..200 {
        state = sm2_update(&state, 5);
        assert!(
            state.interval_days <= 3650,
            "interval_days {} exceeded the 10-year cap",
            state.interval_days
        );
    }
    // 200 consecutive perfect reviews must have driven it all the way to the cap, not just
    // stayed under it by coincidence — otherwise this test would pass even if the cap were
    // silently removed from a code path that never gets reached.
    assert_eq!(state.interval_days, 3650);
}

#[test]
fn review_status_serializes_teacher_review_required() {
    use quran_ai_platform_api::types::ReviewStatus;

    let status: ReviewStatus = serde_json::from_str("\"teacher-review-required\"").unwrap();
    assert_eq!(status, ReviewStatus::TeacherReviewRequired);
    assert_eq!(
        serde_json::to_string(&status).unwrap(),
        "\"teacher-review-required\""
    );
}

/// Proves begin_tenant_tx activates the RLS tenant context at runtime: within the
/// transaction, `current_setting('app.tenant_id')` equals the actor's tenant. Combined with
/// the SQL RLS smoke (policies enforce GIVEN that setting), this shows runtime RLS works.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn begin_tenant_tx_activates_rls_context() {
    use sqlx::Row;
    let state = test_state();
    let mut tx = quran_ai_platform_api::begin_tenant_tx(&state.pool, "tenant-rls-check")
        .await
        .expect("begin tenant tx");
    let row = sqlx::query("SELECT current_setting('app.tenant_id', true) AS t")
        .fetch_one(&mut *tx)
        .await
        .expect("read app.tenant_id");
    let t: Option<String> = row.try_get("t").unwrap();
    assert_eq!(t.as_deref(), Some("tenant-rls-check"));
    tx.commit().await.unwrap();
}

/// Security: `GET /v1/learner/progress?learnerId=X` lets staff read any learner in-tenant,
/// but a learner may only read their own — a cross-learner read is Forbidden.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn learner_progress_learner_id_is_authorized() {
    let router = platform_router_with_rate_limit(test_state(), false);

    // Ops may read another learner's progress.
    let ops = send_json(
        &router,
        Method::GET,
        "/v1/learner/progress?learnerId=learner-1",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({}),
    )
    .await;
    assert_eq!(ops.status(), StatusCode::OK);
    let body: Value = read_json(ops).await;
    assert_eq!(body["learnerId"], "learner-1");

    // A learner may NOT read a different learner's progress.
    let cross = send_json(
        &router,
        Method::GET,
        "/v1/learner/progress?learnerId=learner-2",
        Some("hikmah-pilot-erbil"),
        Some("learner"), // x-user-id = learner-1
        json!({}),
    )
    .await;
    assert_eq!(cross.status(), StatusCode::FORBIDDEN);
}

/// get_progress's mastery formula (mean of per-card `min(repetitions/4, 1)`, rounded to 3
/// decimals) is inlined in the handler, not a standalone function, so pin its exact output here.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn get_progress_mastery_is_the_exact_mean_of_capped_per_card_repetitions() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-mastery-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Mastery Learner', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();

    // repetitions 2, 4, 8 -> per-card 0.5, 1.0 (capped from 1.0), 1.0 (capped from 2.0)
    // -> mean = (0.5 + 1.0 + 1.0) / 3 = 0.8333... -> rounded to 3 decimals = 0.833.
    for (ayah, reps) in [("1:1", 2), ("1:2", 4), ("1:3", 8)] {
        sqlx::query(
            "INSERT INTO learner_progress (tenant_id, learner_id, ayah_ref, repetitions)
             VALUES ('hikmah-pilot-erbil', $1, $2, $3)",
        )
        .bind(&learner_id)
        .bind(ayah)
        .bind(reps)
        .execute(&state.pool)
        .await
        .unwrap();
    }

    let response = send_json(
        &router,
        Method::GET,
        &format!("/v1/learner/progress?learnerId={learner_id}"),
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = read_json(response).await;
    assert_eq!(
        body["mastery"],
        json!(0.833),
        "expected the exact mean of capped per-card repetitions, got {:?}",
        body["mastery"]
    );
}

/// SM-2 quality is clamped to its 0..=5 domain: an out-of-range quality must NOT violate the
/// learner_progress.last_quality CHECK (0..5) and fail the write with a 500 — it is clamped and the
/// review still persists.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn progress_quality_out_of_range_is_clamped_not_500() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let res = send_json(
        &router,
        Method::POST,
        "/v1/learner/progress",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "quality": 6, "ayahRef": "1:1" }),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK); // clamped, not a CHECK-constraint 500
    let body: Value = read_json(res).await;
    assert_eq!(body["quality"], 5); // 6 clamped to the SM-2 / DB max of 5

    // nextReviewAt must be in the future (now + interval_days) — a `+` -> `-` regression in
    // update_progress would schedule the review in the past instead.
    let next_review_at =
        chrono::DateTime::parse_from_rfc3339(body["nextReviewAt"].as_str().unwrap())
            .unwrap()
            .with_timezone(&chrono::Utc);
    assert!(
        next_review_at > chrono::Utc::now(),
        "nextReviewAt {next_review_at} must be in the future"
    );
}

/// The un-capped active-learners endpoint returns the COMPLETE distinct learner set for the tenant
/// (not the 50-row session listing that silently drops learners), staff only. Self-seeds its own
/// learner + session rather than depending on a fixed "learner-1" seed row: this test used to assert
/// on the seeded learner-1's presence, but smoke-api.mjs's privacy-delete success path deletes
/// learner-1's recitation_sessions row against this same persistent local Postgres — any
/// `pnpm smoke:all` run (or a plain re-run of smoke-api.mjs) before this test made it fail with
/// "seeded learner present", even though nothing about the endpoint itself was broken.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn list_active_learners_is_distinct_and_staff_only() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let learner_id = format!("learner-active-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Active Learners Probe', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&test_state().pool)
    .await
    .unwrap();
    create_test_session_for_learner(&router, &learner_id).await;

    let ok = send_json(
        &router,
        Method::GET,
        "/v1/learners/active",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({}),
    )
    .await;
    assert_eq!(ok.status(), StatusCode::OK);
    let arr: Value = read_json(ok).await;
    let ids = arr.as_array().expect("array of learner ids");
    assert!(
        ids.iter().any(|v| v == learner_id.as_str()),
        "self-seeded learner present"
    );
    let mut seen = std::collections::HashSet::new();
    assert!(
        ids.iter()
            .all(|v| seen.insert(v.as_str().unwrap_or_default().to_owned())),
        "learner ids are distinct"
    );

    // A learner may NOT enumerate the tenant's active learners.
    let denied = send_json(
        &router,
        Method::GET,
        "/v1/learners/active",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
}

/// An invalid agent_run review_status is a clean 400 (validated against the contract allowlist),
/// not an opaque DB-CHECK 500.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn agent_run_invalid_review_status_is_bad_request() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let res = send_json(
        &router,
        Method::POST,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({
            "name": "Tajweed Explainer",
            "goal": "explain a finding",
            "status": "queued",
            "confidence": 0.9,
            "reviewStatus": "not-a-real-status",
            "sources": []
        }),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

/// `confidence` is stored as Postgres NUMERIC but list_sessions/list_agent_runs used to decode it
/// straight into f64 without a `::float8` cast — sqlx cannot decode NUMERIC as f64 at all (a type
/// mismatch, not a NULL), so the decode always failed and `unwrap_or(0.0)` silently reported every
/// session/agent-run's confidence as 0.0 regardless of its real value. Pin a non-zero DB value and
/// confirm the list endpoints actually return it, not a fallback zero.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn list_endpoints_decode_real_numeric_confidence_not_a_fallback_zero() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-confidence-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Confidence Learner', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();

    let session_id = create_test_session_for_learner(&router, &learner_id).await;
    sqlx::query("UPDATE recitation_sessions SET confidence = 0.87 WHERE id = $1")
        .bind(&session_id)
        .execute(&state.pool)
        .await
        .unwrap();

    let sessions = send_json(
        &router,
        Method::GET,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({}),
    )
    .await;
    assert_eq!(sessions.status(), StatusCode::OK);
    let sessions_body: Vec<Value> = read_json(sessions).await;
    let listed = sessions_body
        .iter()
        .find(|s| s["id"] == session_id)
        .unwrap_or_else(|| panic!("seeded session {session_id} missing from list_sessions"));
    assert_eq!(
        listed["confidence"].as_f64(),
        Some(0.87),
        "list_sessions must decode real NUMERIC confidence, not fall back to 0.0"
    );

    let agent_run_id = format!("agent-confidence-{}", next_suffix());
    let audit_id = format!("audit-confidence-{}", next_suffix());
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
         VALUES ($1, 'hikmah-pilot-erbil', 'ops-1', 'test.seed', 'agent_run', $2)",
    )
    .bind(&audit_id)
    .bind(&agent_run_id)
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_runs
           (id, tenant_id, name, goal, status, confidence, review_status, source_refs, trace, audit_event_id)
         VALUES ($1, 'hikmah-pilot-erbil', 'Confidence Agent', 'test goal', 'approved', 0.73, 'draft', '[]'::jsonb, '{}'::jsonb, $2)",
    )
    .bind(&agent_run_id)
    .bind(&audit_id)
    .execute(&state.pool)
    .await
    .unwrap();

    let agent_runs = send_json(
        &router,
        Method::GET,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({}),
    )
    .await;
    assert_eq!(agent_runs.status(), StatusCode::OK);
    let agent_runs_body: Vec<Value> = read_json(agent_runs).await;
    let listed_agent_run = agent_runs_body
        .iter()
        .find(|a| a["id"] == agent_run_id)
        .unwrap_or_else(|| panic!("seeded agent run {agent_run_id} missing from list_agent_runs"));
    assert_eq!(
        listed_agent_run["confidence"].as_f64(),
        Some(0.73),
        "list_agent_runs must decode real NUMERIC confidence, not fall back to 0.0"
    );
}

/// Persist + read-back of a session's real alignment (the link that surfaces a learner's
/// recitation in the console). Synthetic "extra" ids are skipped; a non-owner learner is denied.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn persists_and_reads_back_session_alignment() {
    let router = platform_router_with_rate_limit(test_state(), false);

    // Create a session owned by learner-1.
    let created = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "learnerId": "learner-1",
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": "fnv1a32:itest",
            "modelVersion": "model-v0.3",
            "language": "ckb",
            "mode": "guided-recite",
            "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": false, "guardianApproved": true, "consentVersion": "pilot-v1"}
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let session: Value = read_json(created).await;
    let session_id = session["id"].as_str().unwrap().to_string();

    // A different learner may NOT write this session's alignment.
    let denied = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some("hikmah-pilot-erbil"),
        Some("scholar"), // x-user-id = scholar-1, not the owner and not staff-for-write
        json!({ "alignments": [] }),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    // The owner persists alignment: one real word + one synthetic "extra" (must be skipped).
    let persisted = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "modelVersion": "model-v0.3",
            "alignments": [
                {"wordId": "1:1:1", "heardText": "بسم", "startMs": 0, "endMs": 400, "confidence": 0.97, "status": "matched"},
                {"wordId": "extra-0", "heardText": "x", "startMs": 0, "endMs": 0, "confidence": 0.5, "status": "extra"},
                {"wordId": "nope-1", "heardText": "y", "startMs": 0, "endMs": 0, "confidence": 0.5, "status": "matche"}
            ]
        }),
    )
    .await;
    assert_eq!(persisted.status(), StatusCode::OK);
    let body: Value = read_json(persisted).await;
    // "nope-1" is invalid-status AND non-canonical: it must be counted ONCE (invalid status,
    // partitioned out BEFORE the canonical-word batch query), proving the two skip reasons are disjoint.
    assert_eq!(body["persisted"], 1); // only the real canonical "matched" word (1:1:1)
    assert_eq!(body["skippedUnknownWord"], 1); // synthetic "extra-0" is not a canonical word
    assert_eq!(body["skippedInvalidStatus"], 1); // "matche" typo is surfaced, not silently dropped

    // Staff reads it back (with canonical text joined).
    let read = send_json(
        &router,
        Method::GET,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({}),
    )
    .await;
    assert_eq!(read.status(), StatusCode::OK);
    let rows: Vec<Value> = read_json(read).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["wordId"], "1:1:1");
    assert_eq!(rows[0]["status"], "matched");
}

/// Two regressions on a session that has a real tajweed finding attached:
///  1. Security: a teacher review records the AUTHENTICATED actor as author, never a
///     caller-supplied teacher_id (authorship forgery).
///  2. Blocker: re-recording a session's alignment when a finding already references it must
///     succeed (cascade), not FK-violate into a 500.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn teacher_review_author_is_actor_and_realignment_cascades() {
    use sqlx::Row;
    let state = test_state();
    let router = platform_router_with_rate_limit(test_state(), false);

    // Create a real session + alignment through the API (handles every column correctly).
    let created = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "learnerId": "learner-1",
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": "fnv1a32:cascade", "modelVersion": "model-v0.3", "language": "ckb",
            "mode": "guided-recite", "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": false, "guardianApproved": true, "consentVersion": "pilot-v1"}
        }),
    )
    .await;
    let session_id = read_json::<Value>(created).await["id"]
        .as_str()
        .unwrap()
        .to_string();

    let persisted = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "alignments": [{"wordId": "1:1:1", "heardText": "بسم", "confidence": 0.9, "status": "matched"}] }),
    )
    .await;
    assert_eq!(persisted.status(), StatusCode::OK);

    // Attach a tajweed finding to that alignment (the only bit not creatable via a plain API call).
    let align_id: String =
        sqlx::query("SELECT id FROM word_alignments WHERE session_id = $1 LIMIT 1")
            .bind(&session_id)
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .try_get("id")
            .unwrap();
    let finding_audit = format!("audit-tf-{}", next_suffix());
    let finding_id = format!("tf-cascade-{}", next_suffix());
    sqlx::query("INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id) VALUES ($1,'hikmah-pilot-erbil','ops-1','test.seed','tajweed_finding',$2)")
        .bind(&finding_audit).bind(&finding_id).execute(&state.pool).await.unwrap();
    sqlx::query("INSERT INTO tajweed_findings (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status, source_refs, model_version_id, audit_event_id) VALUES ($1,'hikmah-pilot-erbil',$2,'Ghunnah','warning',0.8,'x','teacher-review-required','[]'::jsonb,'model-v0.3',$3)")
        .bind(&finding_id).bind(&align_id).bind(&finding_audit).execute(&state.pool).await.unwrap();

    // (1) teacher-1 reviews it but tries to forge authorship as "teacher-2".
    let review = send_json(
        &router,
        Method::POST,
        "/v1/teacher-reviews",
        Some("hikmah-pilot-erbil"),
        Some("teacher"),
        json!({ "findingId": finding_id, "teacherId": "teacher-2", "decision": "rejected", "note": "forged?" }),
    )
    .await;
    assert_eq!(review.status(), StatusCode::OK);
    assert_eq!(read_json::<Value>(review).await["teacherId"], "teacher-1");
    let stored: String =
        sqlx::query("SELECT teacher_id FROM teacher_reviews WHERE finding_id = $1")
            .bind(&finding_id)
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .try_get("teacher_id")
            .unwrap();
    assert_eq!(stored, "teacher-1", "author must not be forgeable");

    // (2) Re-record alignment for the SAME session (which now has a finding+review): must
    // cascade-delete them and succeed, not FK-violate into a 500.
    let rerecord = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "alignments": [{"wordId": "1:1:2", "heardText": "الله", "confidence": 0.95, "status": "matched"}] }),
    )
    .await;
    assert_eq!(
        rerecord.status(),
        StatusCode::OK,
        "re-record must not FK-violate"
    );
    let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tajweed_findings WHERE id = $1")
        .bind(&finding_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        gone, 0,
        "stale finding should be cascaded away on re-record"
    );
}

/// Spawn a throwaway HTTP server that impersonates the ML inference service's audio-erasure
/// endpoint, so a privacy delete (which now calls it for right-to-erasure) runs without a live ML
/// service. Returns the base URL to point AppState at.
async fn spawn_mock_ml_privacy_delete() -> String {
    let app = axum::Router::new().route(
        "/v1/privacy/delete",
        axum::routing::post(|| async {
            axum::Json(serde_json::json!({
                "deletedAudioObjectKeys": ["hikmah-pilot-erbil/learner/chunk-1.bin"],
                "deletedMetadataObjectKeys": ["hikmah-pilot-erbil/learner/chunk-1.meta.json"],
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn privacy_delete_preserves_other_learners_teacher_reviews() {
    // Point the ML endpoint at a mock so the right-to-erasure audio call succeeds off-network.
    let mock_ml = spawn_mock_ml_privacy_delete().await;
    let state = test_state().with_ml_inference_url(mock_ml);
    let router = platform_router_with_rate_limit(state.clone(), false);
    let target_learner = format!("learner-privacy-target-{}", next_suffix());
    let other_learner = format!("learner-privacy-other-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Privacy Target', 'learner', 'ckb'),
                ($2, 'hikmah-pilot-erbil', 'Privacy Other', 'learner', 'ckb')",
    )
    .bind(&target_learner)
    .bind(&other_learner)
    .execute(&state.pool)
    .await
    .unwrap();

    let target_session = create_test_session_for_learner(&router, &target_learner).await;
    let other_session = create_test_session_for_learner(&router, &other_learner).await;
    let (target_finding, target_review) =
        seed_reviewed_finding(&state.pool, &target_session, "target").await;
    let (other_finding, other_review) =
        seed_reviewed_finding(&state.pool, &other_session, "other").await;

    let deleted = send_json(
        &router,
        Method::POST,
        "/v1/privacy/delete",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({ "learnerId": target_learner }),
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    // Right-to-erasure: the delete must have erased the learner's audio via the ML service and
    // reported the erased object keys (previously this was always an empty list).
    let deleted_body: Value = read_json(deleted).await;
    // Assert the exact keys the mock ML service reported, not just "some non-empty list" — the
    // handler parses `deletedAudioObjectKeys`/`deletedMetadataObjectKeys` out of the upstream JSON
    // response, and a bug that fabricated a placeholder list instead would still pass a "non-empty"
    // check.
    assert_eq!(
        deleted_body["audioObjectKeysDeleted"],
        json!([
            "hikmah-pilot-erbil/learner/chunk-1.bin",
            "hikmah-pilot-erbil/learner/chunk-1.meta.json"
        ]),
        "privacy delete must report the exact erased audio object keys from the ML service"
    );
    // A delete job must report the records it actually deleted, not an empty list — this is the
    // caller-facing proof of erasure, distinct from (and in addition to) the DB-level checks below.
    assert_eq!(
        deleted_body["deletedRecords"], deleted_body["includedRecords"],
        "a delete job's deletedRecords must equal includedRecords"
    );
    assert!(
        deleted_body["deletedRecords"]
            .as_array()
            .is_some_and(|records| !records.is_empty()),
        "delete job must have deleted at least the seeded session, got {:?}",
        deleted_body["deletedRecords"]
    );

    let target_review_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM teacher_reviews WHERE id = $1")
            .bind(&target_review)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        target_review_count, 0,
        "target learner review should be deleted"
    );

    let target_finding_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tajweed_findings WHERE id = $1")
            .bind(&target_finding)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        target_finding_count, 0,
        "target learner finding should be deleted"
    );

    let other_review_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM teacher_reviews WHERE id = $1")
            .bind(&other_review)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        other_review_count, 1,
        "privacy delete must preserve other learners' teacher reviews"
    );

    let other_finding_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tajweed_findings WHERE id = $1")
            .bind(&other_finding)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        other_finding_count, 1,
        "privacy delete must preserve other learners' findings"
    );

    let other_session_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM recitation_sessions WHERE id = $1")
            .bind(&other_session)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        other_session_count, 1,
        "privacy delete must preserve other learners' sessions"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn privacy_export_reports_included_records_but_deletes_nothing() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-privacy-export-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Privacy Export', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();

    let session_id = create_test_session_for_learner(&router, &learner_id).await;

    let exported = send_json(
        &router,
        Method::POST,
        "/v1/privacy/export",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({ "learnerId": learner_id }),
    )
    .await;
    assert_eq!(exported.status(), StatusCode::OK);
    let exported_body: Value = read_json(exported).await;

    // An export must list what it found (the seeded session) but must not report anything deleted,
    // and must not report any audio erasure — this is the path guarded by the `kind == Delete` check
    // in create_privacy_job; if that check were ever inverted, an export would silently start
    // deleting the caller's data.
    assert!(
        exported_body["includedRecords"]
            .as_array()
            .is_some_and(|records| records.iter().any(|r| r == &json!(session_id))),
        "export must include the learner's session, got {:?}",
        exported_body["includedRecords"]
    );
    assert_eq!(
        exported_body["deletedRecords"],
        json!([]),
        "export must not delete any records"
    );
    assert_eq!(
        exported_body["audioObjectKeysDeleted"],
        json!([]),
        "export must not erase any audio"
    );

    let session_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM recitation_sessions WHERE id = $1")
            .bind(&session_id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        session_count, 1,
        "export must not delete the learner's session"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn list_audit_events_returns_real_rows_not_a_fallback_empty_list() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-audit-list-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Audit List Learner', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();

    // Creating a session writes an audit_events row (via the session-create handler); this proves
    // list_audit_events actually reads that row back rather than always returning [].
    create_test_session_for_learner(&router, &learner_id).await;

    let listed = send_json(
        &router,
        Method::GET,
        "/v1/audit-events",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        Value::Null,
    )
    .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let events: Vec<Value> = read_json(listed).await;
    assert!(
        !events.is_empty(),
        "audit events list must not be empty after seeding an action that logs one"
    );
    assert!(
        events
            .iter()
            .any(|e| e["actorId"].as_str() == Some("admin-1")),
        "expected to find the session-create action attributed to the test actor, got {events:?}"
    );
}

async fn create_test_session_for_learner(router: &axum::Router, learner_id: &str) -> String {
    let created = send_json(
        router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({
            "learnerId": learner_id,
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": "fnv1a32:privacy-scope",
            "modelVersion": "model-v0.3",
            "language": "ckb",
            "mode": "guided-recite",
            "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": false, "guardianApproved": true, "consentVersion": "pilot-v1"}
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    read_json::<Value>(created).await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn seed_reviewed_finding(
    pool: &sqlx::PgPool,
    session_id: &str,
    label: &str,
) -> (String, String) {
    let suffix = next_suffix();
    let alignment_id = format!("wa-privacy-{label}-{suffix}");
    let finding_id = format!("tf-privacy-{label}-{suffix}");
    let review_id = format!("review-privacy-{label}-{suffix}");
    let alignment_audit = format!("audit-wa-privacy-{label}-{suffix}");
    let finding_audit = format!("audit-tf-privacy-{label}-{suffix}");
    let review_audit = format!("audit-review-privacy-{label}-{suffix}");

    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
         VALUES ($1, 'hikmah-pilot-erbil', 'ops-1', 'test.seed', 'word_alignment', $2),
                ($3, 'hikmah-pilot-erbil', 'ops-1', 'test.seed', 'tajweed_finding', $4),
                ($5, 'hikmah-pilot-erbil', 'teacher-1', 'test.seed', 'teacher_review', $6)",
    )
    .bind(&alignment_audit)
    .bind(&alignment_id)
    .bind(&finding_audit)
    .bind(&finding_id)
    .bind(&review_audit)
    .bind(&review_id)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO word_alignments
           (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status, model_version_id, audit_event_id)
         VALUES ($1, 'hikmah-pilot-erbil', $2, '1:1:1', 'بسم', 0, 100, 0.9, 'matched', 'model-v0.3', $3)",
    )
    .bind(&alignment_id)
    .bind(session_id)
    .bind(&alignment_audit)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO tajweed_findings
           (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status, source_refs, model_version_id, audit_event_id)
         VALUES ($1, 'hikmah-pilot-erbil', $2, 'Ghunnah', 'warning', 0.8, 'x', 'teacher-review-required', '[]'::jsonb, 'model-v0.3', $3)",
    )
    .bind(&finding_id)
    .bind(&alignment_id)
    .bind(&finding_audit)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO teacher_reviews (id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id)
         VALUES ($1, 'hikmah-pilot-erbil', $2, 'teacher-1', 'accepted', 'scoped privacy regression', $3)",
    )
    .bind(&review_id)
    .bind(&finding_id)
    .bind(&review_audit)
    .execute(pool)
    .await
    .unwrap();

    (finding_id, review_id)
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_scholar_approval_rejects_approval_without_sources() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::POST,
        "/v1/scholar-approvals",
        Some("hikmah-pilot-erbil"),
        Some("scholar"),
        json!({
            "topic": format!("topic-{}", next_suffix()),
            "reviewerId": "ignored-should-use-actor",
            "status": "scholar-approved",
            "risk": "low",
            "sources": []
        }),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "a scholar-approved decision with zero sources must be rejected"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_scholar_approval_rejects_high_risk_approval() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::POST,
        "/v1/scholar-approvals",
        Some("hikmah-pilot-erbil"),
        Some("scholar"),
        json!({
            "topic": format!("topic-{}", next_suffix()),
            "reviewerId": "ignored-should-use-actor",
            "status": "scholar-approved",
            "risk": "high",
            "sources": [{"id": "src-1", "title": "t", "citation": "c", "url": null}]
        }),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "a scholar-approved decision at high risk must be rejected regardless of sources"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_scholar_approval_and_list_round_trips_all_fields() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let topic = format!("topic-{}", next_suffix());

    let created = send_json(
        &router,
        Method::POST,
        "/v1/scholar-approvals",
        Some("hikmah-pilot-erbil"),
        Some("scholar"),
        json!({
            "topic": topic,
            "reviewerId": "someone-else",
            "status": "scholar-approved",
            "risk": "low",
            "sources": [{"id": "src-1", "title": "t", "citation": "c", "url": null}]
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let created_body: Value = read_json(created).await;
    // The reviewer must be the authenticated actor, never the caller-supplied reviewerId.
    assert_eq!(created_body["reviewerId"], "scholar-1");
    assert_eq!(created_body["status"], "scholar-approved");
    assert_eq!(created_body["risk"], "low");

    let listed = send_json(
        &router,
        Method::GET,
        "/v1/scholar-approvals",
        Some("hikmah-pilot-erbil"),
        Some("scholar"),
        Value::Null,
    )
    .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let approvals: Vec<Value> = read_json(listed).await;
    let found = approvals
        .iter()
        .find(|a| a["topic"] == json!(topic))
        .unwrap_or_else(|| panic!("expected to find topic {topic} in {approvals:?}"));
    assert_eq!(found["status"], "scholar-approved");
    assert_eq!(found["risk"], "low");
    assert_eq!(found["sourceCount"], 1);
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn list_teacher_review_queue_round_trips_all_three_decisions() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-review-queue-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Review Queue Learner', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();
    let session_id = create_test_session_for_learner(&router, &learner_id).await;

    let mut expected = std::collections::HashMap::new();
    for decision in ["accepted", "rejected", "edited"] {
        let (finding_id, _review_id) =
            seed_reviewed_finding(&state.pool, &session_id, decision).await;
        // seed_reviewed_finding always inserts an "accepted" review row; overwrite it here so
        // each of the three TeacherDecision variants is actually exercised end to end through
        // the real create_teacher_review handler and read back through the real list endpoint.
        sqlx::query("DELETE FROM teacher_reviews WHERE finding_id = $1")
            .bind(&finding_id)
            .execute(&state.pool)
            .await
            .unwrap();

        let created = send_json(
            &router,
            Method::POST,
            "/v1/teacher-reviews",
            Some("hikmah-pilot-erbil"),
            Some("teacher"),
            json!({
                "findingId": finding_id,
                "teacherId": "ignored-should-use-actor",
                "decision": decision,
                "note": format!("note-{decision}")
            }),
        )
        .await;
        assert_eq!(created.status(), StatusCode::OK);
        expected.insert(finding_id, decision);
    }

    let listed = send_json(
        &router,
        Method::GET,
        "/v1/teacher-review-queue",
        Some("hikmah-pilot-erbil"),
        Some("teacher"),
        Value::Null,
    )
    .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let reviews: Vec<Value> = read_json(listed).await;
    for (finding_id, decision) in &expected {
        let found = reviews
            .iter()
            .find(|r| r["findingId"] == json!(finding_id))
            .unwrap_or_else(|| panic!("expected a queued review for finding {finding_id}"));
        assert_eq!(
            found["decision"],
            json!(decision),
            "decision must round-trip exactly, not collapse to a fallback"
        );
    }
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn list_tajweed_findings_returns_the_seeded_finding_not_an_empty_list() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-findings-list-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Findings List Learner', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();
    let session_id = create_test_session_for_learner(&router, &learner_id).await;
    let (finding_id, _review_id) = seed_reviewed_finding(&state.pool, &session_id, "list").await;

    let listed = send_json(
        &router,
        Method::GET,
        "/v1/tajweed-findings",
        Some("hikmah-pilot-erbil"),
        Some("teacher"),
        Value::Null,
    )
    .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let findings: Vec<Value> = read_json(listed).await;
    assert!(
        findings.iter().any(|f| f["id"] == json!(finding_id)),
        "expected to find seeded finding {finding_id} in {findings:?}"
    );
}

/// Spawn a throwaway HTTP server that always answers 500, to exercise the ML/ASR proxy handlers'
/// upstream-error path (their `if !status.is_success()` check).
async fn spawn_mock_upstream_500(path: &'static str) -> String {
    let app = axum::Router::new().route(
        path,
        axum::routing::post(|| async {
            (StatusCode::INTERNAL_SERVER_ERROR, "boom").into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

/// Spawn a throwaway HTTP server that always answers 200 with a fixed JSON body, to exercise the
/// ML/ASR proxy handlers' success path. This is what actually kills a `!status.is_success()` ->
/// `status.is_success()` mutation: on a 500 with a non-JSON body, both the correct code and the
/// mutant fall through to a JSON-parse failure and end up returning the same 502, so only a
/// genuine 200-with-valid-JSON response can distinguish "passed through as success" from
/// "wrongly treated as an upstream error".
async fn spawn_mock_upstream_200(path: &'static str, body: serde_json::Value) -> String {
    let app = axum::Router::new().route(
        path,
        axum::routing::post(move || {
            let body = body.clone();
            async move { axum::Json(body) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn ml_proxy_passes_through_a_successful_upstream_response() {
    let mock_ml = spawn_mock_upstream_200(
        "/v1/alignments:predict",
        json!({"alignments": [], "modelVersion": "model-v0.3"}),
    )
    .await;
    let state = test_state().with_ml_inference_url(mock_ml);
    let router = platform_router_with_rate_limit(state, false);

    let response = send_json(
        &router,
        Method::POST,
        "/v1/ml/alignments:predict",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = read_json(response).await;
    assert_eq!(body["modelVersion"], "model-v0.3");
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn asr_transcribe_proxy_passes_through_a_successful_upstream_response() {
    let mock_asr = spawn_mock_upstream_200("/v1/transcribe", json!({"text": "بِسْمِ اللَّهِ"})).await;
    let state = test_state().with_asr_inference_url(mock_asr);
    let router = platform_router_with_rate_limit(state, false);

    let response = send_json(
        &router,
        Method::POST,
        "/v1/asr/transcribe",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = read_json(response).await;
    assert_eq!(body["text"], "بِسْمِ اللَّهِ");
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn ml_proxy_maps_upstream_error_status_to_bad_gateway() {
    let mock_ml = spawn_mock_upstream_500("/v1/alignments:predict").await;
    let state = test_state().with_ml_inference_url(mock_ml);
    let router = platform_router_with_rate_limit(state, false);

    let response = send_json(
        &router,
        Method::POST,
        "/v1/ml/alignments:predict",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::BAD_GATEWAY,
        "a non-success upstream status must map to 502, not pass through as success"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn asr_transcribe_proxy_maps_upstream_error_status_to_bad_gateway() {
    let mock_asr = spawn_mock_upstream_500("/v1/transcribe").await;
    let state = test_state().with_asr_inference_url(mock_asr);
    let router = platform_router_with_rate_limit(state, false);

    let response = send_json(
        &router,
        Method::POST,
        "/v1/asr/transcribe",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::BAD_GATEWAY,
        "a non-success upstream status must map to 502, not pass through as success"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_agent_run_rejects_invalid_status() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::POST,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({
            "name": "run",
            "goal": "goal",
            "status": "not-a-real-status",
            "confidence": 0.5,
            "reviewStatus": "draft",
            "sources": []
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_agent_run_rejects_invalid_review_status() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::POST,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({
            "name": "run",
            "goal": "goal",
            "status": "queued",
            "confidence": 0.5,
            "reviewStatus": "not-a-real-review-status",
            "sources": []
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_agent_run_rejects_approved_without_sources() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::POST,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({
            "name": "run",
            "goal": "goal",
            "status": "approved",
            "confidence": 0.9,
            "reviewStatus": "scholar-approved",
            "sources": []
        }),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "an approved agent run must cite at least one source, mirroring the learner-facing gate"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_agent_run_accepts_a_valid_run_and_it_is_listed() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let name = format!("run-{}", next_suffix());

    let created = send_json(
        &router,
        Method::POST,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({
            "name": name,
            "goal": "goal",
            "status": "queued",
            "confidence": 0.42,
            "reviewStatus": "draft",
            "sources": []
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let created_body: Value = read_json(created).await;
    assert_eq!(created_body["status"], "queued");
    assert_eq!(created_body["reviewStatus"], "draft");

    let listed = send_json(
        &router,
        Method::GET,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        Value::Null,
    )
    .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let runs: Vec<Value> = read_json(listed).await;
    assert!(
        runs.iter().any(|r| r["name"] == json!(name)),
        "expected to find the created run {name} in {runs:?}"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn register_rejects_a_password_shorter_than_eight_characters() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::POST,
        "/v1/auth/register",
        None,
        None,
        json!({
            "tenantId": "hikmah-pilot-erbil",
            "displayName": "Weak Password User",
            "role": "learner",
            "language": "en",
            "password": "short1"
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn register_accepts_a_password_exactly_eight_characters_long() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::POST,
        "/v1/auth/register",
        None,
        None,
        json!({
            "tenantId": "hikmah-pilot-erbil",
            "displayName": "Exactly Eight User",
            "role": "learner",
            "language": "en",
            "password": "exactly8"
        }),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "an 8-character password is the minimum allowed length, not one below it"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_agent_run_defaults_sources_to_an_empty_array_when_omitted() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let created = send_json(
        &router,
        Method::POST,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({
            "name": format!("run-{}", next_suffix()),
            "goal": "goal",
            "status": "queued",
            "confidence": 0.5,
            "reviewStatus": "draft"
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let created_body: Value = read_json(created).await;
    assert_eq!(
        created_body["sources"],
        json!([]),
        "an omitted `sources` field must default to an empty array"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_session_external_processing_requires_both_asr_consent_and_guardian_approval() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let asr_only_learner = format!("learner-consent-asr-only-{}", next_suffix());
    let both_learner = format!("learner-consent-both-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Consent Learner', 'learner', 'ckb'),
                ($2, 'hikmah-pilot-erbil', 'Consent Learner', 'learner', 'ckb')",
    )
    .bind(&asr_only_learner)
    .bind(&both_learner)
    .execute(&state.pool)
    .await
    .unwrap();

    // ASR consent without guardian approval must NOT enable external processing — both are
    // required (the `&&` gate), not either alone.
    let asr_only = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({
            "learnerId": asr_only_learner,
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": "fnv1a32:consent-gate",
            "modelVersion": "model-v0.3",
            "language": "ckb",
            "mode": "guided-recite",
            "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": true, "guardianApproved": false, "consentVersion": "pilot-v1"}
        }),
    )
    .await;
    assert_eq!(asr_only.status(), StatusCode::OK);
    let asr_only_body: Value = read_json(asr_only).await;
    assert_eq!(asr_only_body["externalProcessingAllowed"], false);

    // Both consent flags true -> external processing allowed.
    let both = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({
            "learnerId": both_learner,
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": "fnv1a32:consent-gate",
            "modelVersion": "model-v0.3",
            "language": "ckb",
            "mode": "guided-recite",
            "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": true, "guardianApproved": true, "consentVersion": "pilot-v1"}
        }),
    )
    .await;
    assert_eq!(both.status(), StatusCode::OK);
    let both_body: Value = read_json(both).await;
    assert_eq!(both_body["externalProcessingAllowed"], true);
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_realtime_ticket_expires_at_matches_the_configured_ttl() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-rt-ticket-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'RT Ticket Learner', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();
    let session_id = create_test_session_for_learner(&router, &learner_id).await;

    let before = quran_ai_platform_api::unix_now_seconds();
    let ticket = send_json(
        &router,
        Method::POST,
        "/v1/realtime-session-tickets",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({ "sessionId": session_id }),
    )
    .await;
    assert_eq!(ticket.status(), StatusCode::OK);
    let ticket_body: Value = read_json(ticket).await;
    let expires_at: u64 = ticket_body["expiresAt"].as_str().unwrap().parse().unwrap();

    // Must be `now + TTL`, not `now - TTL` (an already-expired ticket) or `now * TTL`
    // (a nonsensical value decades in the future).
    let expected = before + quran_ai_platform_api::REALTIME_TICKET_TTL_SECONDS;
    assert!(
        expires_at.abs_diff(expected) <= 5,
        "expected expiresAt near {expected}, got {expires_at}"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn get_session_round_trips_every_practice_mode() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);

    for mode in [
        "listen",
        "guided-recite",
        "memory-recite",
        "correction",
        "drill",
        "complete",
    ] {
        let learner_id = format!("learner-mode-{mode}-{}", next_suffix());
        sqlx::query(
            "INSERT INTO users (id, tenant_id, display_name, role, language)
             VALUES ($1, 'hikmah-pilot-erbil', 'Mode Learner', 'learner', 'ckb')",
        )
        .bind(&learner_id)
        .execute(&state.pool)
        .await
        .unwrap();

        let created = send_json(
            &router,
            Method::POST,
            "/v1/recitation-sessions",
            Some("hikmah-pilot-erbil"),
            Some("admin"),
            json!({
                "learnerId": learner_id,
                "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
                "sourceChecksum": "fnv1a32:mode-round-trip",
                "modelVersion": "model-v0.3",
                "language": "ckb",
                "mode": mode,
                "practicePlanId": "fatihah-mastery-v1",
                "consent": {"audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": false, "guardianApproved": true, "consentVersion": "pilot-v1"}
            }),
        )
        .await;
        assert_eq!(created.status(), StatusCode::OK);
        let session_id = read_json::<Value>(created).await["id"]
            .as_str()
            .unwrap()
            .to_string();

        let fetched = send_json(
            &router,
            Method::GET,
            &format!("/v1/recitation-sessions/{session_id}"),
            Some("hikmah-pilot-erbil"),
            Some("admin"),
            Value::Null,
        )
        .await;
        assert_eq!(fetched.status(), StatusCode::OK);
        let fetched_body: Value = read_json(fetched).await;
        assert_eq!(
            fetched_body["mode"],
            json!(mode),
            "mode must round-trip exactly for {mode}, not collapse to a fallback"
        );
    }
}

fn next_suffix() -> String {
    // Unique across processes AND runs (the DB persists between runs), so seeded ids never
    // collide. SystemTime is fine here (unlike workflow scripts, ordinary tests may use it).
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", nanos, N.fetch_add(1, Ordering::Relaxed))
}
