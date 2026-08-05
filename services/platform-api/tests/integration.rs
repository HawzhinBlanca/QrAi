use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::IntoResponse;
use serde_json::{Value, json};
use tower::ServiceExt;

use quran_ai_platform_api::{AppState, platform_router_with_rate_limit};

fn test_state() -> AppState {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET app.tenant_id = 'hikmah-pilot-erbil'")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
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
async fn quran_ref_word_start_and_word_end_round_trip_through_create_and_get() {
    // Regression test: QuranReference in Rust used to have no word_start/word_end fields even
    // though packages/contracts/src/index.ts has always declared them (optional word-level
    // scoping within an ayah range) -- serde silently drops unknown JSON fields on deserialize,
    // so a caller sending wordStart/wordEnd lost that data the instant the request was parsed,
    // before it ever reached the DB, and it was of course also absent from every subsequent read.
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-word-scope-{}", next_suffix());
    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Word Scope Learner', 'learner', 'ckb')",
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
            "quranRef": {
                "surahNumber": 1,
                "ayahStart": 1,
                "ayahEnd": 1,
                "wordStart": 2,
                "wordEnd": 4,
                "display": "Al-Fatihah 1:1, words 2-4"
            },
            "sourceChecksum": "fnv1a32:word-scope",
            "modelVersion": "model-v0.3",
            "language": "ckb",
            "mode": "listen",
            "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": false, "guardianApproved": true, "consentVersion": "pilot-v1"}
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let created_body: Value = read_json(created).await;
    assert_eq!(created_body["quranRef"]["wordStart"], json!(2));
    assert_eq!(created_body["quranRef"]["wordEnd"], json!(4));
    let session_id = created_body["id"].as_str().unwrap().to_string();

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
        fetched_body["quranRef"]["wordStart"],
        json!(2),
        "wordStart must survive a round trip through the DB, not be silently dropped"
    );
    assert_eq!(
        fetched_body["quranRef"]["wordEnd"],
        json!(4),
        "wordEnd must survive a round trip through the DB, not be silently dropped"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_session_rejects_an_unsupported_language_code() {
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
            "language": "xx-not-a-real-code",
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
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

/// /ready reports true readiness by actually querying the DB pool (SELECT 1), unlike /health
/// which is pure liveness. With a live pool it must return 200 (P3.6).
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn ready_endpoint_returns_200_when_the_db_pool_answers() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(&router, Method::GET, "/ready", None, None, json!({})).await;
    assert_eq!(response.status(), StatusCode::OK);
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

/// Security regression: an admin/ops may create elevated-role users (teacher/scholar/admin/ops)
/// only within THEIR OWN tenant. The registration tx is scoped to the client-supplied req.tenant_id,
/// so RLS's `with check (tenant_id = app.current_tenant_id())` is satisfied for whatever tenant the
/// caller names — role alone is not enough. Before the fix, a tenant-A admin could POST
/// {tenantId:"B", role:"admin", password:...} and mint an attacker-controlled admin in tenant B,
/// then log in for full cross-tenant takeover. Assert the cross-tenant attempt is Forbidden while a
/// same-tenant elevated registration still succeeds.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn register_cannot_create_elevated_user_in_another_tenant() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);

    // A second, real tenant must EXIST so the target-tenant existence check passes and we reach the
    // authorization check (otherwise a nonexistent tenant would 404 and mask the 403 we're proving).
    let victim_tenant = format!("tenant-cross-register-victim-{}", next_suffix());
    sqlx::query("INSERT INTO institutions (id, name, region) VALUES ($1, 'Victim Tenant', 'test') ON CONFLICT (id) DO NOTHING")
        .bind(&victim_tenant)
        .execute(&state.pool)
        .await
        .unwrap();

    // Admin of hikmah-pilot-erbil tries to create an ADMIN in the victim tenant -> Forbidden.
    let cross = send_json(
        &router,
        Method::POST,
        "/v1/auth/register",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({
            "tenantId": victim_tenant,
            "displayName": "Injected Admin",
            "role": "admin",
            "language": "en",
            "password": "AttackerSet1234"
        }),
    )
    .await;
    assert_eq!(
        cross.status(),
        StatusCode::FORBIDDEN,
        "an admin must not create an elevated-role user in another tenant"
    );

    // Sanity: no user was written into the victim tenant.
    let leaked: Option<(i64,)> =
        sqlx::query_as("SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'admin'")
            .bind(&victim_tenant)
            .fetch_optional(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        leaked.map(|c| c.0),
        Some(0),
        "no admin leaked into victim tenant"
    );

    // Regression: the legitimate same-tenant path still works — an admin CAN create a teacher in
    // their own tenant.
    let same_tenant = send_json(
        &router,
        Method::POST,
        "/v1/auth/register",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({
            "tenantId": "hikmah-pilot-erbil",
            "displayName": "Legit Teacher",
            "role": "teacher",
            "language": "ckb",
            "password": "LegitTeach1234"
        }),
    )
    .await;
    assert_eq!(
        same_tenant.status(),
        StatusCode::OK,
        "an admin must still be able to create an elevated-role user in their own tenant"
    );
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

/// /v1/learner/progress/weekly reports MEASURED per-day data — regression guard for the
/// fabricated weekly chart this endpoint replaces (the web client used to synthesize a linear
/// "week" from the single mastery scalar). Pins three properties:
///  1. accuracy is computed from real word_alignments (matched/total) for the session's day;
///  2. a day with sessions but NO alignments reports accuracy null — unknown, not a false 0;
///  3. a plain learner cannot read another learner's weekly history (staff can).
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn weekly_progress_reports_real_per_day_sessions_and_word_accuracy() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let suffix = next_suffix();
    let learner_id = format!("learner-weekly-{suffix}");

    // Dedicated learner so concurrent tests (which all write as learner-1) can't skew counts.
    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Weekly Probe', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();

    let session_id = create_test_session_for_learner(&router, &learner_id).await;

    // Seed 3 alignments for that session: 2 matched + 1 misread -> accuracy 2/3 = 66.7%.
    let alignment_audit = format!("audit-wa-weekly-{suffix}");
    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
         VALUES ($1, 'hikmah-pilot-erbil', 'ops-1', 'test.seed', 'word_alignment', $2)",
    )
    .bind(&alignment_audit)
    .bind(&session_id)
    .execute(&state.pool)
    .await
    .unwrap();
    for (i, (word_id, status)) in [
        ("1:1:1", "matched"),
        ("1:1:2", "matched"),
        ("1:1:3", "misread"),
    ]
    .iter()
    .enumerate()
    {
        sqlx::query(
            // `server-derived` explicitly (ADR-0030). This test is about the ARITHMETIC of measured
            // accuracy, so its rows have to be the kind that counts toward it. The column defaults
            // to `client-reported` and that default is deliberate — it is why this insert had to
            // change rather than inherit, and why the assertions below still mean what they say.
            "INSERT INTO word_alignments
               (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status, model_version_id, audit_event_id, transcript_source)
             VALUES ($1, 'hikmah-pilot-erbil', $2, $3, 'x', 0, 100, 0.9, $4, 'model-v0.3', $5, 'server-derived')",
        )
        .bind(format!("wa-weekly-{suffix}-{i}"))
        .bind(&session_id)
        .bind(word_id)
        .bind(status)
        .bind(&alignment_audit)
        .execute(&state.pool)
        .await
        .unwrap();
    }

    // A plain learner may NOT read another learner's weekly history.
    let denied = send_json(
        &router,
        Method::GET,
        &format!("/v1/learner/progress/weekly?learnerId={learner_id}"),
        Some("hikmah-pilot-erbil"),
        Some("learner"), // learner-1, not the owner
        json!({}),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    // Staff reads the real numbers.
    let ok = send_json(
        &router,
        Method::GET,
        &format!("/v1/learner/progress/weekly?learnerId={learner_id}"),
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({}),
    )
    .await;
    assert_eq!(ok.status(), StatusCode::OK);
    let body: Value = read_json(ok).await;
    let days = body["days"].as_array().expect("days array");
    assert_eq!(days.len(), 1, "one practiced day: {days:?}");
    assert_eq!(days[0]["sessions"], 1);
    assert_eq!(days[0]["wordsTotal"], 3);
    assert_eq!(days[0]["wordsMatched"], 2);
    assert_eq!(days[0]["accuracy"], 66.7); // 2/3, one decimal — measured, not synthesized
    assert_eq!(
        days[0]["wordsSelfReported"], 0,
        "these three words were server-derived; none of them is a learner's own claim"
    );
    assert!(
        days[0]["date"].as_str().is_some_and(|d| d.len() == 10),
        "date is a YYYY-MM-DD string: {:?}",
        days[0]["date"]
    );

    // A session with no alignments yet -> accuracy null (unknown), never a false 0.
    let bare_learner = format!("learner-weekly-bare-{suffix}");
    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Weekly Bare Probe', 'learner', 'ckb')",
    )
    .bind(&bare_learner)
    .execute(&state.pool)
    .await
    .unwrap();
    create_test_session_for_learner(&router, &bare_learner).await;
    let bare = send_json(
        &router,
        Method::GET,
        &format!("/v1/learner/progress/weekly?learnerId={bare_learner}"),
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({}),
    )
    .await;
    assert_eq!(bare.status(), StatusCode::OK);
    let bare_body: Value = read_json(bare).await;
    let bare_days = bare_body["days"].as_array().expect("days array");
    assert_eq!(bare_days.len(), 1);
    assert_eq!(bare_days[0]["sessions"], 1);
    assert_eq!(bare_days[0]["wordsTotal"], 0);
    assert!(
        bare_days[0]["accuracy"].is_null(),
        "no alignments -> accuracy must be null, got {:?}",
        bare_days[0]["accuracy"]
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

/// The learner-initiated "send to teacher" transition (SHIP_PLAN P1.2): owner flips their own
/// draft session to teacher-review-required; a different learner is Forbidden; re-sending is an
/// idempotent 200 (double-tap must not error); and the flip is visible on read-back.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn request_teacher_review_flips_own_draft_session_and_is_owner_gated() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-send-review-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Send Review Probe', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();
    let session_id = create_test_session_for_learner(&router, &learner_id).await;
    let path = format!("/v1/recitation-sessions/{session_id}/request-teacher-review");

    // A DIFFERENT learner (learner-1) may not send someone else's session.
    let denied = send_json(
        &router,
        Method::POST,
        &path,
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    // The owner sends it. send_json's identities are fixed, so act as the owner directly.
    let owner_send = |uri: String| {
        let router = router.clone();
        let learner_id = learner_id.clone();
        async move {
            let request = Request::builder()
                .method(Method::POST)
                .uri(uri)
                .header("content-type", "application/json")
                .header("x-tenant-id", "hikmah-pilot-erbil")
                .header("x-user-id", &learner_id)
                .header("x-user-role", "learner")
                .body(Body::from("{}"))
                .unwrap();
            router.oneshot(request).await.unwrap()
        }
    };
    let sent = owner_send(path.clone()).await;
    assert_eq!(sent.status(), StatusCode::OK);
    let body: Value = read_json(sent).await;
    assert_eq!(body["reviewStatus"], "teacher-review-required");

    // Idempotent: sending again is a 200 no-op, flagged as already requested.
    let resent = owner_send(path.clone()).await;
    assert_eq!(resent.status(), StatusCode::OK);
    let resent_body: Value = read_json(resent).await;
    assert_eq!(resent_body["alreadyRequested"], true);

    // The flip is real: staff read-back sees teacher-review-required.
    let read = send_json(
        &router,
        Method::GET,
        &format!("/v1/recitation-sessions/{session_id}"),
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({}),
    )
    .await;
    assert_eq!(read.status(), StatusCode::OK);
    let session: Value = read_json(read).await;
    assert_eq!(session["reviewStatus"], "teacher-review-required");
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
        json!({ "alignments": [{"wordId": "1:1:1", "heardText": "بسم", "startMs": 0, "endMs": 400, "confidence": 0.9, "status": "matched"}] }),
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
    // The id is captured HERE, while finding_id still points at the finding. After the re-record
    // below it is NULL by design (ADR-0031), so a lookup by finding_id would find nothing and the
    // survival assertions further down would read as "deleted" whether or not it was.
    let stored = sqlx::query("SELECT id, teacher_id FROM teacher_reviews WHERE finding_id = $1")
        .bind(&finding_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let review_id: String = stored.try_get("id").unwrap();
    let stored_author: String = stored.try_get("teacher_id").unwrap();
    assert_eq!(stored_author, "teacher-1", "author must not be forgeable");

    // (2) Re-record alignment for the SAME session (which now has a finding+review): must
    // cascade-delete them and succeed, not FK-violate into a 500.
    let rerecord = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "alignments": [{"wordId": "1:1:2", "heardText": "الله", "startMs": 400, "endMs": 800, "confidence": 0.95, "status": "matched"}] }),
    )
    .await;
    assert_eq!(
        rerecord.status(),
        StatusCode::OK,
        "re-record must not FK-violate"
    );
    let rerecord_body: Value = read_json(rerecord).await;
    let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tajweed_findings WHERE id = $1")
        .bind(&finding_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        gone, 0,
        "stale finding should be cascaded away on re-record"
    );

    // (3) The cascade above ran on behalf of a LEARNER (the session owner) over a TEACHER's review.
    // It must be visible in the persist audit event — the count is how an operator learns that
    // review history was affected at all.
    let audit_event_id = rerecord_body["auditEventId"].as_str().unwrap().to_owned();
    let meta: Value = sqlx::query_scalar("SELECT metadata FROM audit_events WHERE id = $1")
        .bind(&audit_event_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        meta["deletedTeacherReviews"], 1,
        "the affected teacher review must be visible in the persist audit metadata"
    );
    assert_eq!(
        meta["deletedTajweedFindings"], 1,
        "the erased tajweed finding must be visible in the persist audit metadata"
    );

    // (4) ADR-0031 — and the review itself SURVIVED.
    //
    // This used to be a DELETE, so a learner re-recording their own session erased a named teacher's
    // judgement about a named learner. The finding going is correct: it points at words that no
    // longer exist. The record of a professional having made a decision is a different kind of thing,
    // and no learner action should be able to remove it.
    let review: (
        Option<String>,
        Option<chrono::DateTime<chrono::Utc>>,
        Value,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT finding_id, superseded_at, reviewed_finding, decision, note
             FROM teacher_reviews WHERE id = $1",
    )
    .bind(&review_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap()
    .expect("the teacher's review was DELETED by a learner re-recording their own session");

    assert_eq!(
        review.0, None,
        "finding_id must be released, or the finding below could not be deleted at all"
    );
    assert!(
        review.1.is_some(),
        "a detached review with no superseded_at is indistinguishable from a review of nothing"
    );
    assert_eq!(review.3, "rejected", "the decision itself must survive");
    assert!(!review.4.is_empty(), "the teacher's note must survive");

    // The snapshot is the difference between evidence and "a teacher rejected something".
    let snapshot = &review.2;
    assert_eq!(
        snapshot["findingId"].as_str(),
        Some(finding_id.as_str()),
        "the snapshot must name the finding this decision was made against: {snapshot}"
    );
    for field in ["wordId", "rule", "severity", "explanation", "reviewStatus"] {
        assert!(
            snapshot[field].is_string(),
            "the snapshot lost `{field}`, so nobody can now say what was judged: {snapshot}"
        );
    }
    assert!(
        snapshot["confidence"].is_number(),
        "the snapshot lost `confidence`: {snapshot}"
    );

    // (5) And a reader of the QUEUE can tell what happened to it.
    //
    // ADR-0031 preserved the row and stopped there. The queue then mapped the released
    // `finding_id` NULL to `""` and said nothing about `superseded_at`, so a staff reader saw a
    // review pointing at no finding with no explanation — the same "a teacher rejected something"
    // gap, one level up at the API. `""` also violated this endpoint's own contract, which declared
    // `findingId` with `minLength: 1`.
    let queue = send_json(
        &router,
        Method::GET,
        "/v1/teacher-review-queue",
        Some("hikmah-pilot-erbil"),
        Some("teacher"),
        json!({}),
    )
    .await;
    assert_eq!(queue.status(), StatusCode::OK);
    let rows: Vec<Value> = read_json(queue).await;
    let row = rows
        .iter()
        .find(|r| r["id"] == json!(review_id))
        .unwrap_or_else(|| panic!("the detached review vanished from the queue: {rows:?}"));

    assert_eq!(
        row["findingId"],
        Value::Null,
        "a detached review must report NO finding, not the empty string: {row}"
    );
    assert!(
        row["supersededAt"].is_string(),
        "nothing on the wire says why this review has no finding: {row}"
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

/// PJ1 — a privacy job for a learner that does not exist is a clean 404, never a 500.
/// specs/privacy-job-404/plan.md
///
/// `privacy_jobs.learner_id` REFERENCES users(id), so without the pre-check the INSERT violates the
/// FK and surfaces as "a database error occurred" — on a right-to-erasure endpoint, indistinguishable
/// from a real database failure, and an invitation to retry something that can never succeed.
///
/// NO MOCK ML SERVICE HERE, on purpose. The existence check runs BEFORE the audio erase, so an
/// unknown learner must 404 even with the ML service unreachable. Point this at a mock and the test
/// would still pass with the check in the wrong place — which is exactly the mistake the plan made
/// and the red run caught.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn privacy_job_for_unknown_learner_is_not_found() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let ghost = format!("learner-does-not-exist-{}", next_suffix());

    for route in ["/v1/privacy/export", "/v1/privacy/delete"] {
        let res = send_json(
            &router,
            Method::POST,
            route,
            Some("hikmah-pilot-erbil"),
            Some("admin"),
            json!({ "learnerId": ghost }),
        )
        .await;
        assert_eq!(
            res.status(),
            StatusCode::NOT_FOUND,
            "{route} must be 404 for a learner that does not exist"
        );
        let body: Value = read_json(res).await;
        assert_eq!(body["error"], json!("record not found"));
    }
}

/// The ordering that makes the 404 above safe: authorization is decided BEFORE existence.
///
/// If the existence check ever moved ahead of `require_self_or_any`, a learner could enumerate which
/// learner ids exist by reading 404-vs-403 — the check added to fix a 500 would have created an
/// information leak. Cross-tenant is included because RLS scopes the lookup, so a real id in another
/// tenant would otherwise be the same probe by a different route.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn privacy_job_answers_forbidden_before_not_found() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);

    for (label, learner) in [
        ("another existing learner", "learner-2"),
        (
            "a learner that does not exist",
            "learner-does-not-exist-probe",
        ),
    ] {
        let res = send_json(
            &router,
            Method::POST,
            "/v1/privacy/delete",
            Some("hikmah-pilot-erbil"),
            Some("learner"),
            json!({ "learnerId": learner }),
        )
        .await;
        assert_eq!(
            res.status(),
            StatusCode::FORBIDDEN,
            "a learner asking about {label} must get 403, never a 404 that reveals existence"
        );
    }
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
async fn privacy_delete_erases_learner_agent_runs() {
    let mock_ml = spawn_mock_ml_privacy_delete().await;
    let state = test_state().with_ml_inference_url(mock_ml);
    let router = platform_router_with_rate_limit(state.clone(), false);
    let target_learner = format!("learner-privacy-target-ar-{}", next_suffix());
    let other_learner = format!("learner-privacy-other-ar-{}", next_suffix());

    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Privacy Target Agent Run', 'learner', 'ckb'),
                ($2, 'hikmah-pilot-erbil', 'Privacy Other Agent Run', 'learner', 'ckb')",
    )
    .bind(&target_learner)
    .bind(&other_learner)
    .execute(&state.pool)
    .await
    .unwrap();

    // Create an agent run for the target learner
    let target_created = send_json(
        &router,
        Method::POST,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({
            "name": "Target Learner Agent Run",
            "goal": "target-goal",
            "status": "queued",
            "confidence": 0.5,
            "reviewStatus": "draft",
            "sources": [],
            "learnerId": target_learner
        }),
    )
    .await;
    assert_eq!(target_created.status(), StatusCode::OK);
    let target_run_body: Value = read_json(target_created).await;
    let target_run_id = target_run_body["id"].as_str().unwrap().to_string();

    // Create an agent run for the other learner
    let other_created = send_json(
        &router,
        Method::POST,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({
            "name": "Other Learner Agent Run",
            "goal": "other-goal",
            "status": "queued",
            "confidence": 0.5,
            "reviewStatus": "draft",
            "sources": [],
            "learnerId": other_learner
        }),
    )
    .await;
    assert_eq!(other_created.status(), StatusCode::OK);
    let other_run_body: Value = read_json(other_created).await;
    let other_run_id = other_run_body["id"].as_str().unwrap().to_string();

    // Perform privacy export for target learner and ensure it includes their agent run
    let exported = send_json(
        &router,
        Method::POST,
        "/v1/privacy/export",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({ "learnerId": target_learner }),
    )
    .await;
    assert_eq!(exported.status(), StatusCode::OK);
    let exported_body: Value = read_json(exported).await;
    let target_run_record_key = format!("agent_run:{target_run_id}");
    assert!(
        exported_body["includedRecords"]
            .as_array()
            .is_some_and(|records| records.contains(&json!(target_run_record_key))),
        "export must include the learner's agent run, got {:?}",
        exported_body["includedRecords"]
    );

    // Perform privacy delete for target learner
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
    let deleted_body: Value = read_json(deleted).await;
    assert!(
        deleted_body["deletedRecords"]
            .as_array()
            .is_some_and(|records| records.contains(&json!(target_run_record_key))),
        "delete must report deleting the learner's agent run, got {:?}",
        deleted_body["deletedRecords"]
    );

    // Check DB that target agent run is deleted
    let target_run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_runs WHERE id = $1")
        .bind(&target_run_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        target_run_count, 0,
        "target learner agent run should be deleted"
    );

    // Check DB that other agent run is NOT deleted (same-tenant preservation)
    let other_run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_runs WHERE id = $1")
        .bind(&other_run_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        other_run_count, 1,
        "other learner agent run must be preserved"
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
         -- Sourced: `create_teacher_review` refuses to ACCEPT a finding with no sources
         -- (ADR-0027 item 6), and callers of this helper exercise all three decisions. An
         -- unsourced fixture would make them fail on the rule rather than on what they test.
         VALUES ($1, 'hikmah-pilot-erbil', $2, 'Ghunnah', 'warning', 0.8, 'x', 'teacher-review-required',
                 '[{\"id\":\"s1\",\"title\":\"Board\",\"citation\":\"policy\"}]'::jsonb, 'model-v0.3', $3)",
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

    // Backdate the session so the seeded finding is at the FRONT of the queue.
    //
    // `/v1/tajweed-findings` returns awaiting findings OLDEST FIRST with a LIMIT of 200. A session
    // created a moment ago is the newest, so in a tenant with a real backlog its finding sits on
    // page 20 and this assertion fails for a reason that has nothing to do with what it is testing.
    //
    // It passed before only because the queue used to sort by `confidence DESC` and this fixture
    // seeds 0.8 — visibility by accident of a number that no longer means anything (ADR-0036). The
    // ordering now depends on how long a finding has waited, so the fixture states how long.
    sqlx::query(
        "UPDATE recitation_sessions SET started_at = now() - interval '10 years' WHERE id = $1",
    )
    .bind(&session_id)
    .execute(&state.pool)
    .await
    .expect("backdate the fixture session");

    // This endpoint intentionally returns only its highest-priority 200 findings. The integration
    // database is persistent across local runs, so an ordinary 0.8 fixture can legitimately fall
    // below that boundary after enough unrelated tests. Rank this test's fixture first instead of
    // weakening the assertion to merely prove that some historical row was returned.
    sqlx::query("UPDATE tajweed_findings SET confidence = 1 WHERE id = $1")
        .bind(&finding_id)
        .execute(&state.pool)
        .await
        .unwrap();

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

    // ── Clean up the row this test created, or the workaround above becomes the problem ─────────
    //
    // Ranking the fixture first by setting `confidence = 1` was correct and it DEGRADED, because
    // every run left its confidence-1 row behind for good. After ~200 runs against one long-lived
    // local database there were 201 rows tied at the maximum, the endpoint returns
    // `ORDER BY confidence DESC, tf.id LIMIT 200`, ids are timestamp-prefixed so the NEWEST sorts
    // last — and this test's own fixture was the one that fell off the end. Measured: 201 rows at
    // confidence 1, cut at 200.
    //
    // It went red for a developer who had merely run `verify.sh` often enough, on a change that
    // touched none of this. That is the flaky-gate failure mode verify.sh's own comments warn about:
    // a gate that teaches people to re-run stops being a gate.
    //
    // So the test now removes what it added. Ordered teacher_reviews -> tajweed_findings, because
    // teacher_reviews.finding_id RESTRICTs. Deliberately NOT touching rows from earlier runs: this
    // test owns exactly one finding and cleaning up other people's data from a test is how a suite
    // starts deleting something it did not understand.
    sqlx::query("DELETE FROM teacher_reviews WHERE finding_id = $1")
        .bind(&finding_id)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM tajweed_findings WHERE id = $1")
        .bind(&finding_id)
        .execute(&state.pool)
        .await
        .unwrap();
}

/// T18 proof #2 — the teacher cockpit's cross-tenant isolation.
///
/// The existing `adversarial_api_isolation_prevents_cross_tenant_read` does NOT cover this: it
/// sends a LEARNER actor at /v1/learner/progress, so `require_self_or_any` rejects it on the ROLE
/// check before tenant scoping is ever reached — it proves learner-vs-learner authz and passes even
/// if tenant isolation were broken. The hostile actor here is a TEACHER of tenant B, who passes
/// every role check, so the ONLY thing that can stop them is tenant scoping — which is what the
/// teacher cockpit actually relies on.
///
/// Covers the three endpoints TeacherSurface reads: the session, its alignments, and the findings
/// list. Each assertion has a same-tenant CONTROL, because "empty" would otherwise be
/// indistinguishable from "the endpoint is broken" — a test that passes for the wrong reason is
/// exactly what this replaces.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn teacher_of_another_tenant_cannot_read_this_tenants_sessions_findings_or_alignments() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let suffix = next_suffix();

    // --- Tenant A: a real learner with a real session + finding (what a teacher would review) ---
    let learner_id = format!("learner-xtenant-{suffix}");
    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Cross-tenant Probe Learner', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();
    let session_id = create_test_session_for_learner(&router, &learner_id).await;
    let (_finding_id, _review_id) =
        seed_reviewed_finding(&state.pool, &session_id, "xtenant").await;

    // --- Tenant B: a real, separate institution (institutions is not RLS-scoped) ---
    let tenant_b = format!("tenant-b-teacher-probe-{suffix}");
    sqlx::query(
        "INSERT INTO institutions (id, name, region) VALUES ($1, 'Rival Madrasa', 'test')
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(&tenant_b)
    .execute(&state.pool)
    .await
    .unwrap();

    // --- CONTROL: tenant A's own teacher CAN see all three. Without this, the assertions below
    //     would also pass if the endpoints simply returned nothing. ---
    let own = send_json(
        &router,
        Method::GET,
        &format!("/v1/recitation-sessions/{session_id}"),
        Some("hikmah-pilot-erbil"),
        Some("teacher"),
        Value::Null,
    )
    .await;
    assert_eq!(
        own.status(),
        StatusCode::OK,
        "control: in-tenant teacher reads the session"
    );

    let own_alignments = send_json(
        &router,
        Method::GET,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some("hikmah-pilot-erbil"),
        Some("teacher"),
        Value::Null,
    )
    .await;
    assert_eq!(own_alignments.status(), StatusCode::OK);
    let own_align_list: Vec<Value> = read_json(own_alignments).await;
    assert!(
        !own_align_list.is_empty(),
        "control: the session HAS alignments in its own tenant — otherwise 'empty for tenant B' below would prove nothing"
    );

    let own_findings = send_json(
        &router,
        Method::GET,
        "/v1/tajweed-findings",
        Some("hikmah-pilot-erbil"),
        Some("teacher"),
        Value::Null,
    )
    .await;
    assert_eq!(own_findings.status(), StatusCode::OK);
    let own_list: Vec<Value> = read_json(own_findings).await;
    // Assert NON-EMPTY rather than "contains finding_id": the list is capped at LIMIT 200 and the
    // shared dev DB already holds >200 findings for this tenant, so whether one specific row
    // survives the cutoff is not something this isolation test should depend on. Non-empty is
    // deterministic and is all the control needs to prove — the endpoint returns data in-tenant,
    // which is what makes "empty for tenant B" below meaningful.
    assert!(
        !own_list.is_empty(),
        "control: the findings endpoint returns data for its own tenant"
    );

    // --- The actual isolation checks: a TEACHER of tenant B (passes every role gate) ---
    let stolen_session = send_json(
        &router,
        Method::GET,
        &format!("/v1/recitation-sessions/{session_id}"),
        Some(&tenant_b),
        Some("teacher"),
        Value::Null,
    )
    .await;
    assert_eq!(
        stolen_session.status(),
        StatusCode::NOT_FOUND,
        "a teacher of another tenant must not read this tenant's session"
    );

    // Alignments answer 200 with an EMPTY list rather than 404: the query filters
    // `wa.tenant_id = $2` bound to the ACTOR's tenant, so tenant B simply matches no rows. That is
    // the "empty" outcome T18's proof allows — what matters is that none of the learner's recitation
    // crosses the boundary, which the non-empty control above makes meaningful.
    let stolen_alignments = send_json(
        &router,
        Method::GET,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some(&tenant_b),
        Some("teacher"),
        Value::Null,
    )
    .await;
    assert_eq!(stolen_alignments.status(), StatusCode::OK);
    let stolen_align_list: Vec<Value> = read_json(stolen_alignments).await;
    assert!(
        stolen_align_list.is_empty(),
        "the learner's recitation leaked to another tenant's teacher: {stolen_align_list:?}"
    );

    let stolen_findings = send_json(
        &router,
        Method::GET,
        "/v1/tajweed-findings",
        Some(&tenant_b),
        Some("teacher"),
        Value::Null,
    )
    .await;
    assert_eq!(stolen_findings.status(), StatusCode::OK);
    let stolen_list: Vec<Value> = read_json(stolen_findings).await;
    // Stronger than "doesn't contain finding_id": tenant B owns NO findings, so its queue must be
    // entirely empty. Paired with the non-empty control above, that is unambiguous isolation.
    assert!(
        stolen_list.is_empty(),
        "tenant A's findings leaked into tenant B's teacher queue: {stolen_list:?}"
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

// Echoes the request body back as a 200 — lets a test read exactly what the proxy FORWARDED,
// which is how the server-authoritative-consent overwrite is verified end to end.
async fn spawn_mock_upstream_echo(path: &'static str) -> String {
    let app = axum::Router::new().route(
        path,
        axum::routing::post(
            |axum::Json(body): axum::Json<serde_json::Value>| async move { axum::Json(body) },
        ),
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
async fn ml_proxy_refuses_analysis_for_a_session_that_does_not_exist() {
    // Fails closed BEFORE any upstream forward — no mock ML needed.
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::POST,
        "/v1/ml/alignments:predict",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "sessionId": "session-does-not-exist-xyz", "consent": { "guardianApproved": true } }),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "analysis against a nonexistent/foreign session must be refused, not forwarded"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn ml_proxy_overwrites_client_consent_with_the_stored_session_consent() {
    let mock_ml = spawn_mock_upstream_echo("/v1/alignments:predict").await;
    let state = test_state().with_ml_inference_url(mock_ml);
    let router = platform_router_with_rate_limit(state, false);

    // Create a session whose STORED consent withholds guardian approval and external ASR.
    let created = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "learnerId": "learner-1",
            "quranRef": { "surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7" },
            "sourceChecksum": "fnv1a32:consent-test",
            "modelVersion": "model-v0.3",
            "language": "ckb",
            "mode": "guided-recite",
            "practicePlanId": "fatihah-mastery-v1",
            "consent": { "audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": false, "guardianApproved": false, "consentVersion": "pilot-v1" }
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let created_body: Value = read_json(created).await;
    let session_id = created_body["id"].as_str().unwrap().to_string();

    // The client LIES on the analysis request, claiming full consent it never stored.
    let response = send_json(
        &router,
        Method::POST,
        "/v1/ml/alignments:predict",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "sessionId": session_id,
            "consent": { "guardianApproved": true, "externalAsrProcessing": true, "audioRetention": "training-opt-in" }
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    // The echo mock returns exactly what the proxy forwarded: the STORED consent must have won.
    let forwarded: Value = read_json(response).await;
    assert_eq!(
        forwarded["consent"]["guardianApproved"],
        json!(false),
        "stored guardian approval must override the client's claim"
    );
    assert_eq!(
        forwarded["consent"]["externalAsrProcessing"],
        json!(false),
        "stored external-ASR consent must override the client's claim"
    );
    assert_eq!(
        forwarded["consent"]["audioRetention"],
        json!("discard"),
        "stored audio retention must override the client's claim"
    );
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
async fn ml_proxy_allows_approved_model_version() {
    let mock_ml = spawn_mock_upstream_200(
        "/v1/alignments:predict",
        json!({"alignments": [], "modelVersion": "ml-aligner-v0.2"}),
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
        json!({"modelVersion": "ml-aligner-v0.2"}),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn ml_proxy_rejects_unapproved_model_version() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state, false);

    let response = send_json(
        &router,
        Method::POST,
        "/v1/ml/alignments:predict",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({"modelVersion": "neural-tajweed-v1"}),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = read_json(response).await;
    assert!(body["error"].as_str().unwrap().contains("not approved"));
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
async fn asr_force_align_proxy_forwards_and_requires_auth() {
    let mock_asr = spawn_mock_upstream_200(
        "/v1/force-align",
        json!({"words": [{"word": "بِسْمِ", "start": 0.06, "end": 0.61, "score": 0.9}], "duration": 0.61}),
    )
    .await;
    let state = test_state().with_asr_inference_url(mock_asr);
    let router = platform_router_with_rate_limit(state, false);

    // Unauthenticated -> 401 (never reaches the ASR service).
    let unauth = send_json(
        &router,
        Method::POST,
        "/v1/asr/force-align",
        None,
        None,
        json!({}),
    )
    .await;
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

    // Authenticated -> forwarded, response passed through.
    let ok = send_json(
        &router,
        Method::POST,
        "/v1/asr/force-align",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "audioBase64": "AAAA", "transcript": "بِسْمِ" }),
    )
    .await;
    assert_eq!(ok.status(), StatusCode::OK);
    let body: Value = read_json(ok).await;
    assert_eq!(body["words"][0]["word"], "بِسْمِ");
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
async fn create_agent_run_rejects_approved_with_low_confidence() {
    // canShowLearnerFacingAiOutput (packages/contracts) requires confidence >= 0.82. This
    // endpoint used to only check the source count, so a caller could claim "approved" at any
    // confidence as long as it cited a source.
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
            "confidence": 0.5,
            "reviewStatus": "scholar-approved",
            "sources": [{"id": "s", "title": "t", "citation": "c", "url": null}]
        }),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "an approved agent run must meet the 0.82 confidence floor, mirroring the learner-facing gate"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_agent_run_rejects_approved_with_an_unreviewed_review_status() {
    // canShowLearnerFacingAiOutput only allows reviewStatus "teacher-reviewed" or
    // "scholar-approved" to clear the gate. "ai-suggested" is a valid AgentRunRequest.review_status
    // value (agents write it on every fresh candidate) but must never itself justify "approved".
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
            "confidence": 0.99,
            "reviewStatus": "ai-suggested",
            "sources": [{"id": "s", "title": "t", "citation": "c", "url": null}]
        }),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "an approved agent run must have a reviewed reviewStatus, mirroring the learner-facing gate"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn create_agent_run_accepts_approved_when_every_gate_condition_is_met() {
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
            "confidence": 0.82,
            "reviewStatus": "teacher-reviewed",
            "sources": [{"id": "s", "title": "t", "citation": "c", "url": null}]
        }),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "a run genuinely meeting every gate condition (confidence exactly at the 0.82 floor) must be accepted"
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

/// list_agent_runs must surface `findingId` (from the run's trace) so the agents service can dedup
/// — skip findings that already have a run — instead of re-recording every finding each batch tick.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn list_agent_runs_surfaces_finding_id_for_dedup() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let finding_id = format!("tf-dedup-{}", next_suffix());
    let name = format!("run-fid-{}", next_suffix());

    let created = send_json(
        &router,
        Method::POST,
        "/v1/agent-runs",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        json!({
            "name": name,
            "goal": "explain a finding",
            "status": "queued",
            "confidence": 0.5,
            "reviewStatus": "ai-suggested",
            "sources": [],
            "findingId": finding_id
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);

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
    let mine = runs
        .iter()
        .find(|r| r["name"] == json!(name))
        .expect("created run is listed");
    assert_eq!(
        mine["findingId"],
        json!(finding_id),
        "findingId must be surfaced so the agents service can dedup: {mine:?}"
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
async fn register_rejects_an_unsupported_language_code() {
    // language was plain unvalidated text -- unlike every other enum-shaped field (role,
    // review_status, etc.) it had no server-side check, so an arbitrary string could be
    // persisted and later silently drive UI logic (e.g. text-direction) with no error anywhere.
    let router = platform_router_with_rate_limit(test_state(), false);
    let response = send_json(
        &router,
        Method::POST,
        "/v1/auth/register",
        None,
        None,
        json!({
            "tenantId": "hikmah-pilot-erbil",
            "displayName": "Bad Language User",
            "role": "learner",
            "language": "xx-not-a-real-code",
            "password": "validpass123"
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

// --- Adversarial Cross-Tenant RLS & Security Tests ---

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn adversarial_sql_isolation_prevents_cross_tenant_access() {
    // Deliberately NOT test_state(): its pool pins every connection's SESSION tenant to
    // 'hikmah-pilot-erbil' (after_connect), so the old shape — `SET LOCAL app.tenant_id =
    // 'tenant-b'` layered on top — FAILED OPEN whenever the LOCAL scope didn't take effect as
    // assumed (observed as a CI flake: the "hostile" read ran as the victim tenant and saw its
    // rows). A dedicated single-connection pool pinned session-level to tenant-b has no fallback
    // identity to fail open into, and mirrors production more honestly: production pools have no
    // session default at all (current_setting is NULL -> RLS yields zero rows, fail closed).
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET app.tenant_id = 'tenant-b'")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect_lazy(
            &std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgresql://hawzhin@localhost:5432/quran_ai".to_owned()),
        )
        .expect("failed to create tenant-b pool");

    let mut tx = pool.begin().await.unwrap();

    // Drop to the production app role for the probes. CI's DATABASE_URL connects as the
    // container SUPERUSER, and superusers bypass row-level security unconditionally (FORCE or
    // not) — under that identity this test can never pass, which surfaced the day verify.sh's
    // 2s psql probe first succeeded on a CI runner and the DB-gated suite actually ran there.
    // quran_ai_app exists in every environment that applies infra/sql/rls-app-role.sql (CI does;
    // local staging already connects as it, where SET ROLE to self is a no-op). LOCAL scope
    // reverts the role at tx end.
    sqlx::query("SET LOCAL ROLE quran_ai_app")
        .execute(&mut *tx)
        .await
        .expect("quran_ai_app role must exist — apply infra/sql/rls-app-role.sql");

    // Sanity gate: prove the hostile identity is in effect BEFORE probing, so any future
    // scoping surprise fails loudly here instead of as a mysterious row-count assertion.
    let ctx: String = sqlx::query_scalar("SELECT current_setting('app.tenant_id', true)")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        ctx, "tenant-b",
        "hostile tenant context must be active before the RLS probes"
    );

    // 1. Trying to read Tenant A's seeded users must yield zero rows
    let user_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE tenant_id = 'hikmah-pilot-erbil'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(
        user_count, 0,
        "Hostile SQL read must return 0 rows for other tenant"
    );

    // 2. Trying to insert a user for Tenant A must violate RLS WITH CHECK policy
    let res = sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ('adversarial-user', 'hikmah-pilot-erbil', 'Adversarial', 'learner', 'ckb')",
    )
    .execute(&mut *tx)
    .await;

    assert!(res.is_err(), "RLS must block inserts for another tenant");
    let err_msg = res.unwrap_err().to_string();
    assert!(
        err_msg.contains("violates row-level security policy") || err_msg.contains("42501"),
        "Error must be RLS violation, got: {}",
        err_msg
    );
    tx.rollback().await.unwrap();
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn adversarial_api_isolation_prevents_cross_tenant_read() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-a-{}", next_suffix());

    // Setup Tenant A user
    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Tenant A Learner', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();

    // Hostile Tenant B attempts to read Tenant A's progress
    let response = send_json(
        &router,
        Method::GET,
        &format!("/v1/learner/progress?learnerId={}", learner_id),
        Some("other-tenant"),
        Some("learner"),
        Value::Null,
    )
    .await;

    // Should be Forbidden or Unauthorized because Tenant B actor cannot see Tenant A's data
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn adversarial_api_isolation_prevents_cross_tenant_write() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-a-{}", next_suffix());

    // Setup Tenant A user
    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Tenant A Learner', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();

    // Hostile Tenant B attempts to create a session for Tenant A's user
    let response = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("other-tenant"),
        Some("learner"),
        json!({
            "learnerId": learner_id,
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": "fnv1a32:adversarial-write",
            "modelVersion": "model-v0.3",
            "language": "ckb",
            "mode": "guided-recite",
            "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": false, "guardianApproved": true, "consentVersion": "pilot-v1"}
        }),
    )
    .await;

    // The request should fail with FORBIDDEN since the actor is a learner trying to create a session for another user
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn adversarial_api_isolation_prevents_cross_tenant_delete() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let learner_id = format!("learner-a-{}", next_suffix());

    // Setup Tenant A user
    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Tenant A Learner', 'learner', 'ckb')",
    )
    .bind(&learner_id)
    .execute(&state.pool)
    .await
    .unwrap();

    // Hostile Tenant B attempts to delete Tenant A's user
    let response = send_json(
        &router,
        Method::POST,
        "/v1/privacy/delete",
        Some("other-tenant"),
        Some("learner"),
        json!({
            "learnerId": learner_id,
            "kind": "delete"
        }),
    )
    .await;

    // Should fail with FORBIDDEN since Tenant B cannot manage Tenant A's user privacy
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_platform_api_cors_origin_validation() {
    use std::sync::Mutex;
    static CORS_LOCK: Mutex<()> = Mutex::new(());
    let _guard = CORS_LOCK.lock().unwrap();

    // 1. Setup environment allowed origin
    unsafe {
        std::env::set_var("CORS_ALLOWED_ORIGINS", "https://allowed.example.com");
    }

    let state = test_state();
    let router = platform_router_with_rate_limit(state, false);

    // 2. Disallowed origin request
    let disallowed_req = Request::builder()
        .method(Method::GET)
        .uri("/health")
        .header("origin", "https://disallowed.example.com")
        .body(Body::empty())
        .unwrap();

    let res = router.clone().oneshot(disallowed_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        res.headers().get("access-control-allow-origin").is_none(),
        "CORS header must be absent for disallowed origins"
    );

    // 3. Allowed origin request
    let allowed_req = Request::builder()
        .method(Method::GET)
        .uri("/health")
        .header("origin", "https://allowed.example.com")
        .body(Body::empty())
        .unwrap();

    let res = router.oneshot(allowed_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()
            .get("access-control-allow-origin")
            .unwrap()
            .to_str()
            .unwrap(),
        "https://allowed.example.com",
        "CORS header must be present and match allowed origin"
    );

    // Clean up
    unsafe {
        std::env::remove_var("CORS_ALLOWED_ORIGINS");
    }
}

// --- /metrics endpoint (T15 observability) ---

#[tokio::test]
async fn metrics_endpoint_serves_prometheus_and_counts_requests() {
    // Dev-open (no token). No DB needed: /health and /metrics never touch the pool.
    let state = test_state().with_metrics_access(None, true);
    let router = platform_router_with_rate_limit(state, false);

    // Generate some traffic so there is something to report.
    for _ in 0..3 {
        let r = send_json(&router, Method::GET, "/health", None, None, Value::Null).await;
        assert_eq!(r.status(), StatusCode::OK);
    }

    let response = send_json(&router, Method::GET, "/metrics", None, None, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = String::from_utf8(
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(
        body.contains("http_requests_total{method=\"GET\",path=\"/health\",status=\"200\"} 3"),
        "expected 3 counted /health hits, got:\n{body}"
    );
    assert!(body.contains("http_request_duration_ms_count"));
    assert!(body.contains("http_request_duration_ms_bucket{le=\"+Inf\"}"));
}

#[tokio::test]
async fn metrics_endpoint_requires_a_token_when_one_is_configured() {
    let state = test_state().with_metrics_access(Some("scrape-secret"), false);
    let router = platform_router_with_rate_limit(state, false);

    // No token -> 404 (hides existence).
    let no_token = send_json(&router, Method::GET, "/metrics", None, None, Value::Null).await;
    assert_eq!(no_token.status(), StatusCode::NOT_FOUND);

    // Wrong token -> 404.
    let wrong = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/metrics")
                .header("x-metrics-token", "nope")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::NOT_FOUND);

    // Correct token -> 200 with Prometheus content type.
    let ok = router
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/metrics")
                .header("x-metrics-token", "scrape-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    let ct = ok
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    assert!(ct.starts_with("text/plain"), "content type was {ct}");
}

#[tokio::test]
async fn metrics_endpoint_is_closed_by_default_without_dev_flag_or_token() {
    let state = test_state().with_metrics_access(None, false);
    let router = platform_router_with_rate_limit(state, false);
    let response = send_json(&router, Method::GET, "/metrics", None, None, Value::Null).await;
    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "metrics must be fail-closed when neither a token nor dev mode is set"
    );
}

// ============================================================================
// P1.6 — pilot identity: admin-minted invitations, cookie auth, CSRF/Origin.
// These exercise the pilot HTTP boundary that previously had only SQL-level
// (smoke-sql) coverage. All require a live Postgres with migration 0021.
// ============================================================================

/// Like `send_json` but with an explicit header list and optional body, so a pilot test can set
/// Cookie / Origin / x-csrf-token directly (send_json only ever sends dev-header identity).
async fn send_with_headers(
    router: &axum::Router,
    method: Method,
    uri: &str,
    header_pairs: &[(&str, &str)],
    body: Option<Value>,
) -> axum::response::Response {
    let mut request = Request::builder().method(method).uri(uri);
    for (k, v) in header_pairs {
        request = request.header(*k, *v);
    }
    let body = match body {
        Some(b) => Body::from(b.to_string()),
        None => Body::empty(),
    };
    router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap()
}

/// Extract the raw `__Host-qrai-pilot` session token from a bootstrap response's Set-Cookie.
fn pilot_cookie_from(response: &axum::response::Response) -> Option<String> {
    for v in response.headers().get_all("set-cookie") {
        if let Ok(s) = v.to_str()
            && let Some(rest) = s.strip_prefix("__Host-qrai-pilot=")
        {
            let token = rest.split(';').next().unwrap_or("").to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    None
}

async fn mint_pilot_token(router: &axum::Router, learner_id: &str) -> Value {
    let mint = send_json(
        router,
        Method::POST,
        "/v1/pilot/invitations",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({ "learnerId": learner_id }),
    )
    .await;
    assert_eq!(
        mint.status(),
        StatusCode::OK,
        "admin should mint an invitation"
    );
    read_json(mint).await
}

const PILOT_ORIGIN: &str = "https://pilot.example";

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn pilot_admin_mints_and_learner_bootstraps_and_cookie_authenticates() {
    let router = platform_router_with_rate_limit(test_state(), false);

    let minted = mint_pilot_token(&router, "learner-1").await;
    let token = minted["token"]
        .as_str()
        .expect("raw token returned once")
        .to_string();
    assert!(!token.is_empty());

    // Learner exchanges the invite for a session cookie (Origin required by bootstrap).
    let boot = send_with_headers(
        &router,
        Method::POST,
        "/v1/pilot/session/bootstrap",
        &[
            ("content-type", "application/json"),
            ("origin", PILOT_ORIGIN),
        ],
        Some(json!({ "token": token })),
    )
    .await;
    assert_eq!(
        boot.status(),
        StatusCode::OK,
        "a valid invite should bootstrap a session"
    );
    let session_cookie =
        pilot_cookie_from(&boot).expect("bootstrap must set __Host-qrai-pilot cookie");
    let boot_body: Value = read_json(boot).await;
    assert_eq!(boot_body["userId"], "learner-1");
    assert_eq!(boot_body["tenantId"], "hikmah-pilot-erbil");
    assert_eq!(
        boot_body["role"], "learner",
        "pilot role is server-pinned to learner"
    );
    assert!(
        boot_body["csrfToken"].as_str().is_some(),
        "bootstrap returns a CSRF token"
    );

    // The cookie ALONE authenticates a GET — no dev headers, no Bearer. This is the whole point:
    // identity comes from the server-side session, not a browser-asserted header.
    let cookie_hdr = format!("__Host-qrai-pilot={session_cookie}");
    let me = send_with_headers(
        &router,
        Method::GET,
        "/v1/learner/progress",
        &[("cookie", &cookie_hdr)],
        None,
    )
    .await;
    assert_eq!(
        me.status(),
        StatusCode::OK,
        "the pilot cookie must authenticate a request"
    );
    let prog: Value = read_json(me).await;
    assert_eq!(
        prog["learnerId"], "learner-1",
        "identity is the cookie's learner, not a header"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn pilot_invitation_is_single_use() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let token = mint_pilot_token(&router, "learner-1").await["token"]
        .as_str()
        .unwrap()
        .to_string();

    let hdrs = [
        ("content-type", "application/json"),
        ("origin", PILOT_ORIGIN),
    ];
    let first = send_with_headers(
        &router,
        Method::POST,
        "/v1/pilot/session/bootstrap",
        &hdrs,
        Some(json!({ "token": token })),
    )
    .await;
    assert_eq!(first.status(), StatusCode::OK);
    let second = send_with_headers(
        &router,
        Method::POST,
        "/v1/pilot/session/bootstrap",
        &hdrs,
        Some(json!({ "token": token })),
    )
    .await;
    assert_eq!(
        second.status(),
        StatusCode::UNAUTHORIZED,
        "a consumed invitation must not bootstrap a second session"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn pilot_bootstrap_rejects_expired_invitation() {
    let state = test_state();
    let router = platform_router_with_rate_limit(state.clone(), false);
    let minted = mint_pilot_token(&router, "learner-1").await;
    let token = minted["token"].as_str().unwrap().to_string();
    let invitation_id = minted["invitationId"].as_str().unwrap().to_string();

    // The endpoint clamps ttl >= 1h, so drive expiry directly (connection tenant context is set by
    // the pool's after_connect hook, matching every other direct-SQL test here).
    sqlx::query(
        "UPDATE pilot_invitations SET expires_at = now() - interval '1 hour' WHERE id = $1",
    )
    .bind(&invitation_id)
    .execute(&state.pool)
    .await
    .unwrap();

    let boot = send_with_headers(
        &router,
        Method::POST,
        "/v1/pilot/session/bootstrap",
        &[
            ("content-type", "application/json"),
            ("origin", PILOT_ORIGIN),
        ],
        Some(json!({ "token": token })),
    )
    .await;
    assert_eq!(
        boot.status(),
        StatusCode::UNAUTHORIZED,
        "an expired invitation must not bootstrap"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn pilot_non_admin_cannot_mint_invitation() {
    let router = platform_router_with_rate_limit(test_state(), false);
    for role in ["learner", "teacher", "scholar"] {
        let r = send_json(
            &router,
            Method::POST,
            "/v1/pilot/invitations",
            Some("hikmah-pilot-erbil"),
            Some(role),
            json!({ "learnerId": "learner-1" }),
        )
        .await;
        assert_eq!(
            r.status(),
            StatusCode::FORBIDDEN,
            "{role} must not be able to mint pilot invitations"
        );
    }
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn pilot_mint_rejects_nonexistent_and_non_learner_targets() {
    let router = platform_router_with_rate_limit(test_state(), false);

    let missing = send_json(
        &router,
        Method::POST,
        "/v1/pilot/invitations",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({ "learnerId": "no-such-user-xyz" }),
    )
    .await;
    assert_eq!(
        missing.status(),
        StatusCode::NOT_FOUND,
        "unknown learner -> 404"
    );

    // teacher-1 exists in the seed but is not a learner -> 400.
    let non_learner = send_json(
        &router,
        Method::POST,
        "/v1/pilot/invitations",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({ "learnerId": "teacher-1" }),
    )
    .await;
    assert_eq!(
        non_learner.status(),
        StatusCode::BAD_REQUEST,
        "a non-learner target must be rejected"
    );
}

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn pilot_cookie_mutation_requires_origin_and_csrf() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let token = mint_pilot_token(&router, "learner-1").await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let boot = send_with_headers(
        &router,
        Method::POST,
        "/v1/pilot/session/bootstrap",
        &[
            ("content-type", "application/json"),
            ("origin", PILOT_ORIGIN),
        ],
        Some(json!({ "token": token })),
    )
    .await;
    let cookie = pilot_cookie_from(&boot).unwrap();
    let csrf = read_json::<Value>(boot).await["csrfToken"]
        .as_str()
        .unwrap()
        .to_string();
    let cookie_hdr = format!("__Host-qrai-pilot={cookie}");
    let body = json!({ "quality": 5, "ayahRef": "1:1" });

    // (a) valid Origin, NO csrf -> 401
    let no_csrf = send_with_headers(
        &router,
        Method::POST,
        "/v1/learner/progress",
        &[
            ("content-type", "application/json"),
            ("origin", PILOT_ORIGIN),
            ("cookie", &cookie_hdr),
        ],
        Some(body.clone()),
    )
    .await;
    assert_eq!(
        no_csrf.status(),
        StatusCode::UNAUTHORIZED,
        "mutation without CSRF is rejected"
    );

    // (b) valid Origin, WRONG csrf -> 401
    let bad_csrf = send_with_headers(
        &router,
        Method::POST,
        "/v1/learner/progress",
        &[
            ("content-type", "application/json"),
            ("origin", PILOT_ORIGIN),
            ("cookie", &cookie_hdr),
            ("x-csrf-token", "not-the-real-token"),
        ],
        Some(body.clone()),
    )
    .await;
    assert_eq!(
        bad_csrf.status(),
        StatusCode::UNAUTHORIZED,
        "mutation with wrong CSRF is rejected"
    );

    // (c) correct csrf, NO Origin -> 403
    let no_origin = send_with_headers(
        &router,
        Method::POST,
        "/v1/learner/progress",
        &[
            ("content-type", "application/json"),
            ("cookie", &cookie_hdr),
            ("x-csrf-token", &csrf),
        ],
        Some(body.clone()),
    )
    .await;
    assert_eq!(
        no_origin.status(),
        StatusCode::FORBIDDEN,
        "mutation without Origin is rejected"
    );

    // (d) correct Origin + CSRF -> accepted
    let ok = send_with_headers(
        &router,
        Method::POST,
        "/v1/learner/progress",
        &[
            ("content-type", "application/json"),
            ("origin", PILOT_ORIGIN),
            ("cookie", &cookie_hdr),
            ("x-csrf-token", &csrf),
        ],
        Some(body.clone()),
    )
    .await;
    assert_eq!(
        ok.status(),
        StatusCode::OK,
        "correct Origin + CSRF must be accepted"
    );
}

/// F3 regression: `proxy_ml` must scope the consent-source session to the CALLER, not just the
/// tenant. A learner passing another in-tenant learner's sessionId (to ride on that session's stored
/// consent) is Forbidden before any ML forward; the session owner is allowed.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn ml_proxy_rejects_analysis_against_another_learners_session() {
    let mock_ml = spawn_mock_upstream_echo("/v1/alignments:predict").await;
    let state = test_state().with_ml_inference_url(mock_ml);
    let router = platform_router_with_rate_limit(state, false);

    // learner-1 owns the session (created via admin so the learnerId can be set explicitly).
    let session_id = create_test_session_for_learner(&router, "learner-1").await;

    // A DIFFERENT in-tenant learner cannot run analysis against it.
    let foreign = send_with_headers(
        &router,
        Method::POST,
        "/v1/ml/alignments:predict",
        &[
            ("content-type", "application/json"),
            ("x-tenant-id", "hikmah-pilot-erbil"),
            ("x-user-id", "learner-2"),
            ("x-user-role", "learner"),
        ],
        Some(json!({ "sessionId": session_id, "consent": { "guardianApproved": true } })),
    )
    .await;
    assert_eq!(
        foreign.status(),
        StatusCode::FORBIDDEN,
        "a learner must not analyze another learner's session"
    );

    // The session OWNER may (the rejection is scoped to identity, not a blanket block).
    let owner = send_json(
        &router,
        Method::POST,
        "/v1/ml/alignments:predict",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "sessionId": session_id, "consent": { "guardianApproved": true } }),
    )
    .await;
    assert_eq!(
        owner.status(),
        StatusCode::OK,
        "the session owner may run analysis"
    );
}

/// P5.5 kill-switch: with maintenance mode on, normal routes return a clean 503 while liveness stays
/// up (so orchestrators/monitoring see up-in-maintenance, not crashed). The middleware short-circuits
/// before any handler, so this needs no live Postgres.
#[tokio::test]
async fn maintenance_mode_503s_normal_routes_but_keeps_health_live() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy("postgresql://invalid:invalid@127.0.0.1:1/none")
        .expect("lazy pool");
    let state =
        AppState::with_header_auth(pool, "test-jwt-secret", true).with_maintenance_mode(true);
    let router = platform_router_with_rate_limit(state, false);

    let blocked = send_json(
        &router,
        Method::GET,
        "/v1/quran/surahs",
        None,
        None,
        Value::Null,
    )
    .await;
    assert_eq!(
        blocked.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "maintenance mode must 503 normal routes (no DB touched)"
    );

    let health = send_json(&router, Method::GET, "/health", None, None, Value::Null).await;
    assert_eq!(
        health.status(),
        StatusCode::OK,
        "liveness must stay up during maintenance"
    );
}

/// P5.3 fault test — **Postgres unreachable**, the row in the P5.2 map with no test.
///
/// `docs/readiness/INVENTORIES.md` states the contract: "`/ready` returns 503 when the pool can't
/// answer (liveness `/health` stays 200) so orchestrators see 'up but can't serve'". Only the HAPPY
/// path was tested (`ready_endpoint_returns_200_when_the_db_pool_answers`, itself `#[ignore]`d behind
/// live Postgres), so the entire reason `/ready` exists — being DIFFERENT from `/health` during a
/// database outage — was never executed.
///
/// Both halves are asserted in ONE test because the PAIRING is the contract, and each half fails a
/// different way in production:
///   • `/ready` wrongly 200 → the orchestrator keeps routing traffic to a pod where every request
///     fails, and the outage looks like an application bug instead of a database one.
///   • `/health` wrongly 503 → the orchestrator kills and reschedules pods that are perfectly
///     healthy, turning a recoverable DB blip into a restart storm.
///
/// Deterministic and needs NO live Postgres: `connect_lazy` never dials, so the first connection
/// attempt is the one `/ready` makes, against a port nothing listens on. The short `acquire_timeout`
/// is what keeps this fast — sqlx otherwise retries for its 30s default before giving up.
#[tokio::test]
async fn readiness_reports_503_when_postgres_is_unreachable_while_liveness_holds() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(2))
        .connect_lazy("postgresql://invalid:invalid@127.0.0.1:1/none")
        .expect("lazy pool");
    let router = platform_router_with_rate_limit(
        AppState::with_header_auth(pool, "test-jwt-secret", true),
        false,
    );

    let ready = send_json(&router, Method::GET, "/ready", None, None, Value::Null).await;
    assert_eq!(
        ready.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "/ready answered OK while Postgres was unreachable — an orchestrator would keep sending \
         traffic to a process that cannot serve a single request"
    );

    let health = send_json(&router, Method::GET, "/health", None, None, Value::Null).await;
    assert_eq!(
        health.status(),
        StatusCode::OK,
        "/health must stay 200 during a database outage: the PROCESS is alive. A 503 here tells the \
         orchestrator to kill a pod that would recover on its own"
    );
}

/// P5.3 fault test — the kill-switch must not blind the people using it.
///
/// `maintenance_guard` exempts three paths: `/health`, `/ready`, `/metrics`. The test above covers
/// exactly one of them. Drop `"/metrics"` from that match arm and every existing test still passes,
/// while Prometheus starts receiving `503 service is in maintenance` for every scrape — losing
/// observability precisely during the window when somebody is watching the system most closely.
///
/// `/ready` is checked by BODY rather than status: with a dead pool it is 503 either way, so the
/// status cannot tell "the readiness handler ran and reported the DB is down" apart from "the
/// maintenance guard swallowed the request before the handler existed". The body can — the guard
/// emits `{"error":"service is in maintenance"}` and the handler does not.
#[tokio::test]
async fn maintenance_mode_leaves_metrics_and_readiness_reachable() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(2))
        .connect_lazy("postgresql://invalid:invalid@127.0.0.1:1/none")
        .expect("lazy pool");
    let state = AppState::with_header_auth(pool, "test-jwt-secret", true)
        .with_maintenance_mode(true)
        // No token + dev_open, so the scrape needs no credential and this asserts the MAINTENANCE
        // exemption rather than accidentally re-testing metrics auth.
        .with_metrics_access(None, true);
    let router = platform_router_with_rate_limit(state, false);

    let metrics = send_json(&router, Method::GET, "/metrics", None, None, Value::Null).await;
    assert_eq!(
        metrics.status(),
        StatusCode::OK,
        "the maintenance guard swallowed /metrics — monitoring goes dark exactly when it is needed"
    );

    let ready = send_json(&router, Method::GET, "/ready", None, None, Value::Null).await;
    let ready_body = axum::body::to_bytes(ready.into_body(), usize::MAX)
        .await
        .expect("readiness body");
    let ready_text = String::from_utf8_lossy(&ready_body);
    assert!(
        !ready_text.contains("service is in maintenance"),
        "/ready was answered by the maintenance guard instead of the readiness handler, so during \
         maintenance it can no longer report whether the database is actually reachable — got: {ready_text}"
    );

    // The contrast, in the same test: a normal route IS refused. Without this, both assertions above
    // would still hold if maintenance mode had simply stopped working.
    let blocked = send_json(
        &router,
        Method::GET,
        "/v1/quran/surahs",
        None,
        None,
        Value::Null,
    )
    .await;
    assert_eq!(
        blocked.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "maintenance mode is not actually engaged, so the exemptions above prove nothing"
    );
}

/// MIG2a — RLS as a BACKSTOP, not just as a barrier against a hostile tenant.
///
/// `adversarial_sql_isolation_prevents_cross_tenant_access` proves RLS blocks a caller who is
/// *pretending to be another tenant*. It does not prove the case that actually matters for a
/// backend rewrite: a handler that **forgets to set a tenant context at all**.
///
/// Today every handler goes through `begin_tenant_tx`, so nothing exercises the omission. That is
/// precisely the bug a Node port introduces — a stray `pool.query()` issued outside the reserved
/// transaction runs on a pooled connection where `app.tenant_id` was never set. `plan.md` §2.2
/// leans on "Postgres fails closed" to make that survivable; this test is what turns that sentence
/// into evidence.
///
/// It also pins the *direction* of the failure. `app.current_tenant_id()` returns NULL when unset,
/// and `tenant_id = NULL` is never true, so an unscoped read must yield **zero rows** — never the
/// whole table. A future migration that "helpfully" rewrote the policy with a
/// `current_setting(...) IS NULL OR ...` escape hatch would flip this to fail-open and silently
/// expose every tenant; this test fails loudly if that ever happens.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn rls_backstops_a_query_that_forgets_its_tenant_context() {
    // A pool with NO after_connect tenant pinning — this is the shape of a forgotten context, and
    // it mirrors production, where pooled connections carry no session default at all.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy(
            &std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgresql://hawzhin@localhost:5432/quran_ai".to_owned()),
        )
        .expect("failed to create unscoped pool");

    let mut tx = pool.begin().await.unwrap();

    // Drop to the production app role: CI's default DATABASE_URL is a superuser, and superusers
    // bypass RLS unconditionally, so without this the test would pass for the wrong reason.
    sqlx::query("SET LOCAL ROLE quran_ai_app")
        .execute(&mut *tx)
        .await
        .expect("quran_ai_app role must exist — apply infra/sql/rls-app-role.sql");

    // Sanity gate: prove the tenant GUC really is unset, so a zero-row result below can only be
    // RLS doing its job — not an empty table or a stale context from a recycled connection.
    let ctx: Option<String> = sqlx::query_scalar("SELECT current_setting('app.tenant_id', true)")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert!(
        ctx.as_deref().unwrap_or("").is_empty(),
        "tenant context must be UNSET for this test to mean anything, got {ctx:?}"
    );

    // The rows exist — proven from a context that can see them (below). An unscoped read must
    // still return zero.
    let unscoped: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&mut *tx)
        .await
        .expect("an unscoped SELECT must be permitted, just empty — not an error");
    assert_eq!(
        unscoped, 0,
        "RLS must fail CLOSED for a query with no tenant context; returning rows here means a \
         forgotten begin_tenant_tx would leak across tenants"
    );

    // An unscoped INSERT must be rejected by WITH CHECK rather than silently landing in a row no
    // tenant can read back. Wrapped in a SAVEPOINT: the rejection aborts the surrounding
    // transaction (Postgres 25P02), which would otherwise make the control query below
    // unrunnable and the whole test a false negative.
    sqlx::query("SAVEPOINT mig2a_insert_probe")
        .execute(&mut *tx)
        .await
        .unwrap();
    let res = sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ('mig2a-unscoped-user', 'hikmah-pilot-erbil', 'Unscoped', 'learner', 'ckb')",
    )
    .execute(&mut *tx)
    .await;
    assert!(
        res.is_err(),
        "RLS must block an INSERT issued with no tenant context"
    );
    let err = res.unwrap_err().to_string();
    assert!(
        err.contains("violates row-level security policy") || err.contains("42501"),
        "expected an RLS violation, got: {err}"
    );
    sqlx::query("ROLLBACK TO SAVEPOINT mig2a_insert_probe")
        .execute(&mut *tx)
        .await
        .expect("savepoint rollback must restore a usable transaction");

    // Control: with the context set, the same read sees rows. Without this, a zero-row result
    // above could just mean the table was empty and the test would prove nothing.
    sqlx::query("SELECT set_config('app.tenant_id', 'hikmah-pilot-erbil', true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    let scoped: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert!(
        scoped > 0,
        "control failed: the seeded tenant must have users, otherwise the zero above is meaningless"
    );

    tx.rollback().await.unwrap();
}

/// ADR-0027 — a teacher's decision reaches the finding.
///
/// Before this, `create_teacher_review` recorded a row and stopped: nothing anywhere updated
/// `tajweed_findings.review_status`, so an accepted finding stayed `ai-suggested`, stayed below
/// `canShowLearnerFacingAiOutput`, and no finding could become learner-visible by any path. A
/// teacher could work the queue every evening and change nothing.
///
/// Asserts all three decisions, and — the claim that actually matters — that an accepted finding
/// then satisfies every term of the learner gate, not just the status one.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn teacher_decision_promotes_the_finding_and_edited_promotes_nothing() {
    use sqlx::Row;
    let state = test_state();
    let router = platform_router_with_rate_limit(test_state(), false);

    // A finding needs a real alignment, which needs a real session.
    let created = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "learnerId": "learner-1",
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": "fnv1a32:promote", "modelVersion": "model-v0.3", "language": "ckb",
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
        json!({ "alignments": [{"wordId": "1:1:1", "heardText": "بسم", "startMs": 0, "endMs": 400, "confidence": 0.9, "status": "matched"}] }),
    )
    .await;
    assert_eq!(persisted.status(), StatusCode::OK);
    let align_id: String =
        sqlx::query("SELECT id FROM word_alignments WHERE session_id = $1 LIMIT 1")
            .bind(&session_id)
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .try_get("id")
            .unwrap();

    // Seeded ai-suggested, sourced, and above the 0.82 floor — so the ONLY thing keeping it from a
    // learner is the review status. That isolates what this test is about.
    let seed_finding = |suffix: String| {
        let pool = state.pool.clone();
        let align_id = align_id.clone();
        async move {
            let audit = format!("audit-tf-{suffix}");
            let id = format!("tf-promote-{suffix}");
            sqlx::query("INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id) VALUES ($1,'hikmah-pilot-erbil','ops-1','test.seed','tajweed_finding',$2)")
                .bind(&audit).bind(&id).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO tajweed_findings (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status, source_refs, model_version_id, audit_event_id) VALUES ($1,'hikmah-pilot-erbil',$2,'Ghunnah','warning',0.9,'x','ai-suggested','[{\"id\":\"s1\",\"title\":\"Board\",\"citation\":\"policy\"}]'::jsonb,'model-v0.3',$3)")
                .bind(&id).bind(&align_id).bind(&audit).execute(&pool).await.unwrap();
            id
        }
    };

    let status_of = |id: String| {
        let pool = state.pool.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "SELECT review_status FROM tajweed_findings WHERE id = $1",
            )
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };

    let review = |id: String, decision: &'static str| {
        let router = router.clone();
        async move {
            let r = send_json(
                &router,
                Method::POST,
                "/v1/teacher-reviews",
                Some("hikmah-pilot-erbil"),
                Some("teacher"),
                json!({ "findingId": id, "teacherId": "teacher-1", "decision": decision, "note": "" }),
            )
            .await;
            assert_eq!(r.status(), StatusCode::OK, "{decision} was not recorded");
        }
    };

    // (1) accepted → teacher-reviewed, and the learner gate is now satisfied in FULL.
    let accepted = seed_finding(next_suffix().to_string()).await;
    review(accepted.clone(), "accepted").await;
    assert_eq!(
        status_of(accepted.clone()).await,
        "teacher-reviewed",
        "an accepted finding must reach the status the learner gate admits"
    );
    let row = sqlx::query(
        "SELECT review_status, confidence::float8 AS confidence, jsonb_array_length(source_refs) AS sources
         FROM tajweed_findings WHERE id = $1",
    )
    .bind(&accepted)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    // canShowLearnerFacingAiOutput, term for term (packages/contracts/src/index.ts:373). Asserting
    // only the status would leave the end-to-end claim — "the learner can now see it" — untested.
    let status: String = row.try_get("review_status").unwrap();
    let confidence: f64 = row.try_get("confidence").unwrap();
    let sources: i32 = row.try_get("sources").unwrap();
    assert!(status == "teacher-reviewed" || status == "scholar-approved");
    assert!(confidence >= 0.82, "confidence floor");
    assert!(sources > 0, "a finding with no source is still withheld");

    // (2) rejected → blocked. Distinguishable from "nobody has looked yet".
    let rejected = seed_finding(next_suffix().to_string()).await;
    review(rejected.clone(), "rejected").await;
    assert_eq!(status_of(rejected).await, "blocked");

    // (3) edited → UNCHANGED. The rewrite has nowhere to live, so promoting would publish the
    // original wording as teacher-approved: exactly the text the teacher said was wrong.
    let edited = seed_finding(next_suffix().to_string()).await;
    review(edited.clone(), "edited").await;
    assert_eq!(
        status_of(edited).await,
        "ai-suggested",
        "edited must not release the unedited explanation to a learner"
    );

    // (4) The last decision wins, so a teacher can correct their own mistake without an admin.
    let corrected = seed_finding(next_suffix().to_string()).await;
    review(corrected.clone(), "accepted").await;
    review(corrected.clone(), "rejected").await;
    assert_eq!(status_of(corrected).await, "blocked");
}

/// A mock ML service that answers `/v1/tajweed-findings:predict` with the shape
/// `services/ml-inference` actually returns — `sessionId` at the top level, findings carrying
/// `wordId`/`rule`/`severity`/`confidence`/`explanation`/`sources`, every one `ai-suggested`.
async fn spawn_mock_ml_tajweed(word_id: &'static str) -> String {
    let app = axum::Router::new().route(
        "/v1/tajweed-findings:predict",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| async move {
            axum::Json(json!({
                "sessionId": body["sessionId"],
                "tenantId": body["tenantId"],
                "modelVersion": "ml-aligner-v0.2",
                "reviewStatus": "ai-suggested",
                "confidence": 0.9,
                "findings": [
                    {
                        "wordId": word_id,
                        "rule": "ghunnah",
                        "severity": "practice",
                        "confidence": 0.9,
                        "explanation": "Apply ghunnah on the noon sakina.",
                        "sources": [{"id": "s1", "title": "Board", "citation": "policy"}],
                        "reviewStatus": "ai-suggested"
                    },
                    {
                        // A word this session never aligned: unanchorable, and must be SKIPPED
                        // rather than invented into a word_alignments row.
                        "wordId": "114:6:3",
                        "rule": "qalqalah",
                        "severity": "practice",
                        "confidence": 0.88,
                        "explanation": "unanchored",
                        "sources": [],
                        "reviewStatus": "ai-suggested"
                    }
                ]
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

/// ADR-0027 action item 4 — the last two links: findings are PERSISTED, and the learner can READ
/// their own.
///
/// Before this, `ml-inference` computed findings per request and nothing wrote them down (every row
/// in a real database came from `0006_seed_internal.sql`), and the only route that read the table
/// was staff-only. So a teacher's promotion moved a row nothing learner-facing could reach.
///
/// This drives the whole chain against live Postgres: analyse → persist → teacher accepts → the
/// LEARNER reads it back as `teacher-reviewed`.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn tajweed_findings_persist_and_the_learner_can_read_their_own() {
    use sqlx::Row;
    let mock_ml = spawn_mock_ml_tajweed("1:1:1").await;
    let state = test_state().with_ml_inference_url(mock_ml.clone());
    let router =
        platform_router_with_rate_limit(test_state().with_ml_inference_url(mock_ml), false);

    let created = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "learnerId": "learner-1",
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": "fnv1a32:persist", "modelVersion": "model-v0.3", "language": "ckb",
            "mode": "guided-recite", "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": false, "guardianApproved": true, "consentVersion": "pilot-v1"}
        }),
    )
    .await;
    let session_id = read_json::<Value>(created).await["id"]
        .as_str()
        .unwrap()
        .to_string();

    // (0) With NO alignments, analysis must still succeed and persist nothing. A finding with no
    // alignment has no evidence to point at, and fabricating one would invent heardText/startMs for
    // audio nobody aligned. This is the Flutter practice flow's shape today.
    let early = send_json(
        &router,
        Method::POST,
        "/v1/ml/tajweed-findings:predict",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "sessionId": session_id, "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "x"} }),
    )
    .await;
    assert_eq!(
        early.status(),
        StatusCode::OK,
        "analysis must not fail because nothing could be stored"
    );
    let none_yet: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tajweed_findings tf JOIN word_alignments wa ON wa.id = tf.alignment_id WHERE wa.session_id = $1",
    )
    .bind(&session_id).fetch_one(&state.pool).await.unwrap();
    assert_eq!(
        none_yet, 0,
        "nothing to anchor to, so nothing may be written"
    );

    // Now give the session a real alignment for 1:1:1.
    let persisted = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "alignments": [{"wordId": "1:1:1", "heardText": "بسم", "startMs": 0, "endMs": 400, "confidence": 0.9, "status": "matched"}] }),
    )
    .await;
    assert_eq!(persisted.status(), StatusCode::OK);

    // (1) Analysis now persists — the anchorable finding only.
    let analysed = send_json(
        &router,
        Method::POST,
        "/v1/ml/tajweed-findings:predict",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "sessionId": session_id, "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "x"} }),
    )
    .await;
    assert_eq!(analysed.status(), StatusCode::OK);

    let rows = sqlx::query(
        "SELECT tf.id, tf.rule, tf.review_status, tf.analysis_basis FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id WHERE wa.session_id = $1",
    )
    .bind(&session_id)
    .fetch_all(&state.pool)
    .await
    .unwrap();

    // ADR-0033 — what this finding is ABOUT, recorded on the row.
    //
    // `analyzeAyah` reads the passage's canonical Uthmani text and nothing else: no audio, no heard
    // text, no timing. What it returns is "a rule applies at this position", which is true of the
    // Quran and identical for every learner who ever recites it. This row is anchored to a
    // `word_alignments` row and will be released to the learner if a teacher accepts it — so
    // whether it is a fact about the text or a judgement about the person has to survive the write.
    for r in &rows {
        assert_eq!(
            r.try_get::<String, _>("analysis_basis").unwrap(),
            "canonical-text",
            "a text-derived finding was stored without saying so, which is how it becomes \
             indistinguishable from one derived from the learner's audio"
        );
    }
    assert_eq!(
        rows.len(),
        1,
        "one anchorable finding; the 114:6:3 one has no alignment and must be skipped"
    );
    let finding_id: String = rows[0].try_get("id").unwrap();
    assert_eq!(rows[0].try_get::<String, _>("rule").unwrap(), "ghunnah");
    assert_eq!(
        rows[0].try_get::<String, _>("review_status").unwrap(),
        "ai-suggested",
        "a model's opinion is never written as reviewed — only create_teacher_review may move it"
    );

    // (2) Idempotent. Re-analysis must not duplicate, and must NOT re-write: re-writing would
    // cascade away any teacher review already recorded, because a learner tapped stop twice.
    let again = send_json(
        &router,
        Method::POST,
        "/v1/ml/tajweed-findings:predict",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({ "sessionId": session_id, "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "x"} }),
    )
    .await;
    assert_eq!(again.status(), StatusCode::OK);
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tajweed_findings tf JOIN word_alignments wa ON wa.id = tf.alignment_id WHERE wa.session_id = $1",
    )
    .bind(&session_id).fetch_one(&state.pool).await.unwrap();
    assert_eq!(count, 1, "re-analysis duplicated the findings");

    // (3) The learner reads their OWN session and sees it pending.
    let path = format!("/v1/recitation-sessions/{session_id}/tajweed-findings");
    let mine = send_json(
        &router,
        Method::GET,
        &path,
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(mine.status(), StatusCode::OK);
    let body: Value = read_json(mine).await;
    assert_eq!(body.as_array().unwrap().len(), 1);
    assert_eq!(body[0]["reviewStatus"], "ai-suggested");
    // PENDING, and pending is ALL the learner learns. This assertion used to read
    // `sources[0]["id"] == "s1"` — it pinned the whole unreviewed finding arriving on the learner's
    // device, provenance and explanation and all, with the client trusted to hide it. That premise
    // was the bug ADR-0028 fixes; the test's purpose is step (4), where the loop closes and the
    // provenance assertion belongs.
    assert_eq!(body[0]["withheld"], json!(true));
    assert_eq!(body[0]["explanation"], json!(""));
    assert_eq!(body[0]["sources"], json!([]));

    // (4) THE LOOP. A teacher accepts; the learner reads it back as reviewed.
    let review = send_json(
        &router,
        Method::POST,
        "/v1/teacher-reviews",
        Some("hikmah-pilot-erbil"),
        Some("teacher"),
        json!({ "findingId": finding_id, "teacherId": "teacher-1", "decision": "accepted", "note": "" }),
    )
    .await;
    assert_eq!(review.status(), StatusCode::OK);

    let after = send_json(
        &router,
        Method::GET,
        &path,
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    let after_body: Value = read_json(after).await;
    assert_eq!(
        after_body[0]["reviewStatus"], "teacher-reviewed",
        "the learner must be able to READ the promotion — this is the link that was missing"
    );
    // canShowLearnerFacingAiOutput, term for term: the learner would now actually be shown this.
    assert!(after_body[0]["confidence"].as_f64().unwrap() >= 0.82);
    assert!(!after_body[0]["sources"].as_array().unwrap().is_empty());

    // (5) Ownership, not role: a different learner is refused.
    // Raw headers: send_json maps the role to a FIXED user id, so a second learner needs them.
    let other = send_with_headers(
        &router,
        Method::GET,
        &path,
        &[
            ("x-tenant-id", "hikmah-pilot-erbil"),
            ("x-user-id", "learner-2"),
            ("x-user-role", "learner"),
        ],
        None,
    )
    .await;
    assert_eq!(
        other.status(),
        StatusCode::FORBIDDEN,
        "a learner must not read another learner's findings"
    );

    // (6) An unknown session is 404 — and so is one in another tenant, before the ownership check,
    // so this cannot be used to probe for session ids elsewhere.
    let missing = send_json(
        &router,
        Method::GET,
        "/v1/recitation-sessions/session-does-not-exist/tajweed-findings",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

/// A mock ML service for the finalize chain: the session transcript, then the alignment computed
/// from it. Mirrors the real shapes — `transcribed`/`recognizedText` from `/v1/session-transcript`,
/// `alignments[]` from `/v1/alignments:predict`.
/// Like `spawn_mock_ml_finalize`, but the transcript reports chunks that never reached storage.
///
/// That is what an upstream outage leaves behind: ml-inference derives the gap from the holes in the
/// session's chunk run and reports it, and finalize has to write it down. Without this the session
/// record claims to be complete while its transcript is short — and the aligner then scores the
/// short transcript against the FULL passage, recording words the learner DID recite as missed.
async fn spawn_mock_ml_finalize_with_gap() -> String {
    let app = axum::Router::new()
        .route(
            "/v1/session-transcript",
            axum::routing::post(|| async {
                axum::Json(json!({
                    "transcribed": true, "reason": "consent-granted", "chunkCount": 3,
                    "recognizedText": ["بسم", "الله"],
                    "missingChunkIds": ["s-ws-0003", "s-ws-0004"]
                }))
            }),
        )
        .route(
            "/v1/alignments:predict",
            axum::routing::post(|| async {
                axum::Json(json!({
                    "sessionId": "s", "confidence": 0.9,
                    "alignments": [
                        {"wordId": "1:1:1", "canonicalText": "بِسْمِ", "heardText": "بسم",
                         "startMs": 0, "endMs": 100, "confidence": 0.9, "status": "matched"}
                    ]
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

async fn spawn_mock_ml_finalize(transcribed: bool) -> String {
    let app = axum::Router::new()
        .route(
            "/v1/session-transcript",
            axum::routing::post(move || async move {
                axum::Json(if transcribed {
                    json!({
                        "transcribed": true, "reason": "consent-granted", "chunkCount": 3,
                        "recognizedText": ["بسم", "الله"]
                    })
                } else {
                    json!({
                        "transcribed": false, "reason": "consent-revoked-or-insufficient",
                        "recognizedText": [], "chunkCount": 0
                    })
                })
            }),
        )
        .route(
            "/v1/alignments:predict",
            axum::routing::post(|| async {
                axum::Json(json!({
                    "sessionId": "s", "confidence": 0.9,
                    "alignments": [
                        {"wordId": "1:1:1", "canonicalText": "بِسْمِ", "heardText": "بسم",
                         "status": "matched", "confidence": 0.9, "startMs": 0, "endMs": 500},
                        {"wordId": "1:1:2", "canonicalText": "ٱللَّهِ", "heardText": "الله",
                         "status": "misread", "confidence": 0.7, "startMs": 500, "endMs": 900}
                    ]
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

async fn finalize_test_session(router: &axum::Router, checksum: &str) -> String {
    let created = send_json(
        router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "learnerId": "learner-1",
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": checksum, "modelVersion": "model-v0.3", "language": "ckb",
            "mode": "guided-recite", "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "teacher-review", "anonymizedLearning": true, "externalAsrProcessing": true, "guardianApproved": true, "consentVersion": "pilot-v1"}
        }),
    )
    .await;
    read_json::<Value>(created).await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// ADR-0027 item 5 — a gateway-streamed recitation becomes a reviewable one.
///
/// The gateway forwards audio to ml-inference and stops. Before this route there was no transcript,
/// so no alignment, so nothing a teacher could review and nothing a learner could ever be shown.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn finalize_persists_a_server_derived_alignment_and_refuses_without_consent() {
    use sqlx::Row;
    let mock = spawn_mock_ml_finalize(true).await;
    let state = test_state().with_ml_inference_url(mock.clone());
    let router = platform_router_with_rate_limit(test_state().with_ml_inference_url(mock), false);

    let session_id = finalize_test_session(&router, "fnv1a32:finalize").await;

    // (1) The happy path: transcript -> alignment -> persisted rows.
    let done = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/finalize"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(done.status(), StatusCode::OK);
    let body: Value = read_json(done).await;
    assert_eq!(body["finalized"], true);
    assert_eq!(body["persisted"], 2, "both aligned words must be stored");

    let rows = sqlx::query(
        "SELECT word_id, heard_text, status FROM word_alignments WHERE session_id = $1 ORDER BY word_id",
    )
    .bind(&session_id)
    .fetch_all(&state.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    // The stored text is what the ASR HEARD, not the canonical text echoed back — the distinction
    // the fabricated-alignment fix exists to protect.
    assert_eq!(rows[0].try_get::<String, _>("heard_text").unwrap(), "بسم");
    assert_eq!(rows[1].try_get::<String, _>("status").unwrap(), "misread");

    // (2) A different learner may not finalize someone else's session.
    let foreign = send_with_headers(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/finalize"),
        &[
            ("content-type", "application/json"),
            ("x-tenant-id", "hikmah-pilot-erbil"),
            ("x-user-id", "learner-2"),
            ("x-user-role", "learner"),
        ],
        Some(json!({})),
    )
    .await;
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);

    // (3) An unknown session is 404, before the ownership check.
    let missing = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions/nope/finalize",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

/// The refusal path: no transcript means NO stored alignment, not a fabricated one.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn finalize_without_a_transcript_stores_nothing() {
    let mock = spawn_mock_ml_finalize(false).await;
    let state = test_state().with_ml_inference_url(mock.clone());
    let router = platform_router_with_rate_limit(test_state().with_ml_inference_url(mock), false);

    let session_id = finalize_test_session(&router, "fnv1a32:finalize-denied").await;

    let done = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/finalize"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(
        done.status(),
        StatusCode::OK,
        "a refusal is an answer, not an error"
    );
    let body: Value = read_json(done).await;
    assert_eq!(body["finalized"], false);
    assert_eq!(body["reason"], "consent-revoked-or-insufficient");

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM word_alignments WHERE session_id = $1")
            .bind(&session_id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        count, 0,
        "nothing was heard, so nothing may be recorded about what was said"
    );
}

/// ADR-0027 item 6 — a teacher cannot release a finding with nothing behind it.
///
/// `create_scholar_approval` has always refused this (`MissingSources`). Teacher acceptance became
/// the OTHER way content reaches a learner in ADR-0027, and until this the only thing withholding an
/// unsourced acceptance was `canShowLearnerFacingAiOutput` in the client — one laxer future client
/// away from showing a learner a judgement with no source.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn accepting_an_unsourced_finding_is_refused_but_rejecting_it_is_not() {
    use sqlx::Row;
    let state = test_state();
    let router = platform_router_with_rate_limit(test_state(), false);

    let created = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "learnerId": "learner-1",
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": "fnv1a32:unsourced", "modelVersion": "model-v0.3", "language": "ckb",
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
        json!({ "alignments": [{"wordId": "1:1:1", "heardText": "بسم", "startMs": 0, "endMs": 400, "confidence": 0.9, "status": "matched"}] }),
    )
    .await;
    assert_eq!(persisted.status(), StatusCode::OK);
    let align_id: String =
        sqlx::query("SELECT id FROM word_alignments WHERE session_id = $1 LIMIT 1")
            .bind(&session_id)
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .try_get("id")
            .unwrap();

    // A finding with an EMPTY source_refs — the shape this refusal exists for.
    let suffix = next_suffix();
    let audit = format!("audit-tf-{suffix}");
    let finding_id = format!("tf-unsourced-{suffix}");
    sqlx::query("INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id) VALUES ($1,'hikmah-pilot-erbil','ops-1','test.seed','tajweed_finding',$2)")
        .bind(&audit).bind(&finding_id).execute(&state.pool).await.unwrap();
    sqlx::query("INSERT INTO tajweed_findings (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status, source_refs, model_version_id, audit_event_id) VALUES ($1,'hikmah-pilot-erbil',$2,'Ghunnah','warning',0.9,'x','ai-suggested','[]'::jsonb,'model-v0.3',$3)")
        .bind(&finding_id).bind(&align_id).bind(&audit).execute(&state.pool).await.unwrap();

    let review = |decision: &'static str| {
        let router = router.clone();
        let finding_id = finding_id.clone();
        async move {
            send_json(
                &router,
                Method::POST,
                "/v1/teacher-reviews",
                Some("hikmah-pilot-erbil"),
                Some("teacher"),
                json!({ "findingId": finding_id, "teacherId": "teacher-1", "decision": decision, "note": "" }),
            )
            .await
        }
    };

    // (1) Accepting is refused, with a message that says what to do instead.
    let accepted = review("accepted").await;
    assert_eq!(accepted.status(), StatusCode::BAD_REQUEST);
    let err: Value = read_json(accepted).await;
    assert!(
        err["error"].as_str().unwrap().contains("no source"),
        "the refusal must name the reason, got {err}"
    );

    // (2) NOTHING was written — the scholar path's rule: a refused approval leaves no row and no
    // audit trail suggesting one was considered.
    let reviews: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM teacher_reviews WHERE finding_id = $1")
            .bind(&finding_id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(reviews, 0, "a refused acceptance must leave no review row");
    let status: String =
        sqlx::query_scalar("SELECT review_status FROM tajweed_findings WHERE id = $1")
            .bind(&finding_id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        status, "ai-suggested",
        "and must not have promoted the finding"
    );

    // (3) REJECTING an unsourced finding is exactly what a teacher should be able to do with one.
    // Refusing this too would trap it in the queue forever.
    let rejected = review("rejected").await;
    assert_eq!(rejected.status(), StatusCode::OK);
    let blocked: String =
        sqlx::query_scalar("SELECT review_status FROM tajweed_findings WHERE id = $1")
            .bind(&finding_id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(blocked, "blocked");

    // (4) A SOURCED finding still accepts — the guard must not block the normal path.
    let suffix2 = next_suffix();
    let audit2 = format!("audit-tf-{suffix2}");
    let sourced_id = format!("tf-sourced-{suffix2}");
    sqlx::query("INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id) VALUES ($1,'hikmah-pilot-erbil','ops-1','test.seed','tajweed_finding',$2)")
        .bind(&audit2).bind(&sourced_id).execute(&state.pool).await.unwrap();
    sqlx::query("INSERT INTO tajweed_findings (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status, source_refs, model_version_id, audit_event_id) VALUES ($1,'hikmah-pilot-erbil',$2,'Ghunnah','warning',0.9,'x','ai-suggested','[{\"id\":\"s1\",\"title\":\"Board\",\"citation\":\"policy\"}]'::jsonb,'model-v0.3',$3)")
        .bind(&sourced_id).bind(&align_id).bind(&audit2).execute(&state.pool).await.unwrap();

    let ok = send_json(
        &router,
        Method::POST,
        "/v1/teacher-reviews",
        Some("hikmah-pilot-erbil"),
        Some("teacher"),
        json!({ "findingId": sourced_id, "teacherId": "teacher-1", "decision": "accepted", "note": "" }),
    )
    .await;
    assert_eq!(
        ok.status(),
        StatusCode::OK,
        "a sourced finding must still be acceptable"
    );
    let promoted: String =
        sqlx::query_scalar("SELECT review_status FROM tajweed_findings WHERE id = $1")
            .bind(&sourced_id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(promoted, "teacher-reviewed");
}

// ── P3.2 — withheld feedback and provenance ────────────────────────────────────────────────────

/// Seed one finding on `session_id` with an exact review status, confidence and provenance.
///
/// `seed_reviewed_finding` above always produces the same shape; these tests need the FOUR ways a
/// finding fails the learner gate, one per row, so they can prove each is withheld on its own merits
/// rather than on some other row's.
async fn seed_finding_for_gate(
    pool: &sqlx::PgPool,
    session_id: &str,
    label: &str,
    word_id: &str,
    review_status: &str,
    confidence: f64,
    sources: &str,
) -> String {
    let suffix = next_suffix();
    let alignment_id = format!("wa-p32-{label}-{suffix}");
    let finding_id = format!("tf-p32-{label}-{suffix}");
    let alignment_audit = format!("audit-wa-p32-{label}-{suffix}");
    let finding_audit = format!("audit-tf-p32-{label}-{suffix}");

    sqlx::query(
        "INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
         VALUES ($1, 'hikmah-pilot-erbil', 'ops-1', 'test.seed', 'word_alignment', $2),
                ($3, 'hikmah-pilot-erbil', 'ops-1', 'test.seed', 'tajweed_finding', $4)",
    )
    .bind(&alignment_audit)
    .bind(&alignment_id)
    .bind(&finding_audit)
    .bind(&finding_id)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO word_alignments
           (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
            model_version_id, audit_event_id)
         VALUES ($1, 'hikmah-pilot-erbil', $2, $3, 'heard', 0, 100, 0.9, 'matched', 'model-v0.3', $4)",
    )
    .bind(&alignment_id)
    .bind(session_id)
    .bind(word_id)
    .bind(&alignment_audit)
    .execute(pool)
    .await
    .unwrap();

    // `$6::float8::numeric` — a bare f64 bind against a `numeric` column fails to encode.
    sqlx::query(
        "INSERT INTO tajweed_findings
           (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
            source_refs, model_version_id, audit_event_id)
         VALUES ($1, 'hikmah-pilot-erbil', $2, 'Makhraj', 'warning', $3::float8::numeric,
                 'the throat letter drifted', $4, $5::jsonb, 'model-v0.3', $6)",
    )
    .bind(&finding_id)
    .bind(&alignment_id)
    .bind(confidence)
    .bind(review_status)
    .bind(sources)
    .bind(&finding_audit)
    .execute(pool)
    .await
    .unwrap();

    finding_id
}

/// Create an empty session owned by `learner-1`, and return its id.
async fn seed_session_for(router: &axum::Router, checksum: &str) -> String {
    let created = send_json(
        router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "learnerId": "learner-1",
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": format!("fnv1a32:{checksum}"),
            "modelVersion": "model-v0.3", "language": "ckb",
            "mode": "guided-recite", "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "discard", "anonymizedLearning": true,
                        "externalAsrProcessing": false, "guardianApproved": true,
                        "consentVersion": "pilot-v1"}
        }),
    )
    .await;
    read_json::<Value>(created).await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// P3.2 — a learner receives the EXISTENCE of a withheld finding, never its content.
///
/// The route's own doc comment used to argue that returning everything was safe because "a COUNT of
/// pending notes is not a judgement about the recitation". The argument was sound; the code did not
/// implement it. It shipped `rule`, `severity`, `explanation` and `wordId` — the judgement itself —
/// and left the withholding to `canShowLearnerFacingAiOutput` in the client. That is a display
/// choice, not a control: `curl` with the learner's own token read every unreviewed AI opinion about
/// their recitation.
///
/// Three of the four ways a finding fails the gate get a row each, so no one row can carry the test.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn learner_gets_withheld_findings_redacted_and_staff_get_them_intact() {
    let state = test_state();
    let router = platform_router_with_rate_limit(test_state(), false);
    let session_id = seed_session_for(&router, "p32redact").await;

    const SOURCED: &str = r#"[{"id":"s1","title":"Scholar Board","citation":"policy"}]"#;

    // Clears the gate: reviewed, confident, sourced.
    let visible = seed_finding_for_gate(
        &state.pool,
        &session_id,
        "ok",
        "1:1:1",
        "teacher-reviewed",
        0.90,
        SOURCED,
    )
    .await;
    // Fails on STATUS — raw model output no human has looked at.
    let unreviewed = seed_finding_for_gate(
        &state.pool,
        &session_id,
        "ai",
        "1:1:2",
        "ai-suggested",
        0.95,
        SOURCED,
    )
    .await;
    // Fails on PROVENANCE — reviewed, but nothing stands behind it.
    let unsourced = seed_finding_for_gate(
        &state.pool,
        &session_id,
        "nosrc",
        "1:1:3",
        "teacher-reviewed",
        0.90,
        "[]",
    )
    .await;
    // Fails on CONFIDENCE — reviewed and sourced, but below the shared floor.
    let low = seed_finding_for_gate(
        &state.pool,
        &session_id,
        "low",
        "1:1:4",
        "teacher-reviewed",
        0.50,
        SOURCED,
    )
    .await;

    let response = send_json(
        &router,
        Method::GET,
        &format!("/v1/recitation-sessions/{session_id}/tajweed-findings"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json::<Vec<Value>>(response).await;

    let by_id = |id: &str| -> Value {
        body.iter()
            .find(|f| f["id"] == id)
            .unwrap_or_else(|| panic!("finding {id} is missing from the learner's response"))
            .clone()
    };

    // The approved one arrives whole — withholding everything would be safe and useless.
    let shown = by_id(&visible);
    assert_eq!(shown["withheld"], json!(false));
    assert_eq!(shown["rule"], json!("Makhraj"));
    assert_eq!(shown["explanation"], json!("the throat letter drifted"));
    assert_eq!(shown["wordId"], json!("1:1:1"));
    assert_eq!(shown["sources"].as_array().unwrap().len(), 1);

    for (label, id) in [
        ("unreviewed", &unreviewed),
        ("unsourced", &unsourced),
        ("low-confidence", &low),
    ] {
        let f = by_id(id);
        // Present, so the panel can still say notes are waiting for a teacher.
        assert_eq!(
            f["withheld"],
            json!(true),
            "{label} must be marked withheld"
        );
        assert!(
            f["reviewStatus"].as_str().is_some_and(|s| !s.is_empty()),
            "{label} keeps its review status — that is the part the learner may know"
        );
        // And nothing that is a judgement about the recitation.
        for field in ["rule", "severity", "explanation", "wordId"] {
            assert_eq!(
                f[field],
                json!(""),
                "{label} leaked `{field}` to the learner"
            );
        }
        assert_eq!(f["confidence"], json!(0.0), "{label} leaked a confidence");
        assert_eq!(f["sources"], json!([]), "{label} leaked its sources");
    }

    // Staff must see everything: reviewing the unreviewed ones is the teacher queue's whole job.
    let staff = send_json(
        &router,
        Method::GET,
        &format!("/v1/recitation-sessions/{session_id}/tajweed-findings"),
        Some("hikmah-pilot-erbil"),
        Some("teacher"),
        json!({}),
    )
    .await;
    assert_eq!(staff.status(), StatusCode::OK);
    let staff_body = read_json::<Vec<Value>>(staff).await;
    let staff_view = staff_body
        .iter()
        .find(|f| f["id"] == json!(unreviewed.as_str()))
        .expect("staff must see the unreviewed finding");
    assert_eq!(
        staff_view["explanation"],
        json!("the throat letter drifted"),
        "a teacher cannot review a finding whose text was redacted from them"
    );
    assert_eq!(
        staff_view["withheld"],
        json!(true),
        "`withheld` means the same thing to staff: still not visible to the learner"
    );
}

/// P3.2 — fixture data. `0006_seed_internal.sql` plants `finding-seed-1`, which is
/// `teacher-reviewed`, sourced and 0.84 confident — it CLEARS the learner gate. That is fine only
/// because it is anchored to the seed session; the thing that must never happen is a real learner's
/// session picking up demo findings and presenting them as feedback on their own recitation.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn seed_findings_cannot_surface_in_a_real_learners_session() {
    let router = platform_router_with_rate_limit(test_state(), false);
    let session_id = seed_session_for(&router, "p32fixture").await;

    let response = send_json(
        &router,
        Method::GET,
        &format!("/v1/recitation-sessions/{session_id}/tajweed-findings"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json::<Vec<Value>>(response).await;

    assert!(
        body.is_empty(),
        "a fresh session must start with no findings at all, got {body:?}"
    );
    for f in &body {
        assert!(
            !f["id"].as_str().unwrap_or_default().contains("seed"),
            "seed fixture data reached a real learner's session: {f:?}"
        );
    }
}

/// P3.2 — the gate on the PREDICT response, not only on the stored copy.
///
/// `POST /v1/ml/tajweed-findings:predict` is learner-reachable and returns freshly computed findings
/// — `ai-suggested` by construction, so no human has seen any of them. They were being sent to the
/// learner's device in full, with the browser trusted to hide them. `curl` with the learner's own
/// token read every unreviewed judgement about their recitation; a client that forgot the gate
/// displayed them.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn ml_tajweed_predict_redacts_unreviewed_findings_for_a_learner() {
    let mock_ml = spawn_mock_ml_tajweed("1:1:1").await;
    let router =
        platform_router_with_rate_limit(test_state().with_ml_inference_url(mock_ml), false);
    let session_id = seed_session_for(&router, "p32predict").await;

    let analysis = json!({
        "sessionId": session_id,
        "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"}
    });

    let learner = send_json(
        &router,
        Method::POST,
        "/v1/ml/tajweed-findings:predict",
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        analysis.clone(),
    )
    .await;
    assert_eq!(learner.status(), StatusCode::OK);
    let body = read_json::<Value>(learner).await;

    let findings = body["findings"].as_array().expect("findings array");
    assert!(
        !findings.is_empty(),
        "the mock returns findings; the count must survive"
    );
    for f in findings {
        assert_eq!(
            f["withheld"],
            json!(true),
            "every ai-suggested finding is withheld"
        );
        for field in ["rule", "severity", "explanation", "wordId"] {
            assert_eq!(
                f[field],
                json!(""),
                "predict leaked `{field}` to the learner"
            );
        }
        assert_eq!(f["confidence"], json!(0.0));
        assert_eq!(f["sources"], json!([]));
        // Kept: this is the part that lets the panel say a note is waiting, and it is not a
        // judgement about the recitation.
        assert_eq!(f["reviewStatus"], json!("ai-suggested"));
    }

    // Ops analysing the same session get it whole. NOT "teacher": proxy_ml allows only the session
    // owner or ANALYSIS_STAFF (admin/ops), so a teacher is 403 here long before redaction matters.
    let staff = send_json(
        &router,
        Method::POST,
        "/v1/ml/tajweed-findings:predict",
        Some("hikmah-pilot-erbil"),
        Some("ops"),
        analysis,
    )
    .await;
    assert_eq!(staff.status(), StatusCode::OK);
    let staff_body = read_json::<Value>(staff).await;
    let first = &staff_body["findings"][0];
    assert_eq!(
        first["rule"],
        json!("ghunnah"),
        "staff cannot review what was redacted from them"
    );
    assert_eq!(
        first["explanation"],
        json!("Apply ghunnah on the noon sakina.")
    );
}

/// A session records the chunks it never got.
///
/// The failure this closes is not a missing file. Chunks accepted by the gateway and never stored
/// (an ML outage, a crashed writer) left the session record claiming to be complete while its
/// transcript was short — and the aligner scores a short transcript against the FULL canonical
/// passage, so words the learner DID recite are recorded as words they missed. The only trace was a
/// PROCESS counter on the gateway: some chunks were lost somewhere, for someone.
///
/// RECORDED, not acted on: finalize still succeeds and scoring is unchanged. What should happen to a
/// gapped session is a product decision, and this is what makes that decision possible.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn finalize_records_chunks_the_session_never_got() {
    use sqlx::Row;
    let mock = spawn_mock_ml_finalize_with_gap().await;
    let state = test_state().with_ml_inference_url(mock.clone());
    let router = platform_router_with_rate_limit(test_state().with_ml_inference_url(mock), false);

    let session_id = finalize_test_session(&router, "fnv1a32:finalize-gap").await;

    let done = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/finalize"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(done.status(), StatusCode::OK);
    let body = read_json::<Value>(done).await;

    // Still finalized — this records the gap, it does not refuse the session.
    assert_eq!(body["finalized"], json!(true));
    assert_eq!(
        body["lostChunkCount"],
        json!(2),
        "the response must tell a client the recording was incomplete, so it can say that to the \
         learner instead of letting them read the gap as their own mistakes"
    );

    let stored: i32 = sqlx::query("SELECT lost_chunk_count FROM recitation_sessions WHERE id = $1")
        .bind(&session_id)
        .fetch_one(&state.pool)
        .await
        .unwrap()
        .try_get("lost_chunk_count")
        .unwrap();
    assert_eq!(
        stored, 2,
        "the gap is not on the SESSION, so nothing downstream can know this recitation was incomplete"
    );
}

/// The other half: a complete session must not be labelled as gapped.
///
/// A column that is always non-zero is as useless as one that is always zero — this is what stops
/// the check above from passing against an implementation that simply writes a number.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn a_complete_session_records_no_lost_chunks() {
    use sqlx::Row;
    let mock = spawn_mock_ml_finalize(true).await;
    let state = test_state().with_ml_inference_url(mock.clone());
    let router = platform_router_with_rate_limit(test_state().with_ml_inference_url(mock), false);

    let session_id = finalize_test_session(&router, "fnv1a32:finalize-nogap").await;
    let done = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/finalize"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(done.status(), StatusCode::OK);
    assert_eq!(read_json::<Value>(done).await["lostChunkCount"], json!(0));

    let stored: i32 = sqlx::query("SELECT lost_chunk_count FROM recitation_sessions WHERE id = $1")
        .bind(&session_id)
        .fetch_one(&state.pool)
        .await
        .unwrap()
        .try_get("lost_chunk_count")
        .unwrap();
    assert_eq!(
        stored, 0,
        "a complete session was labelled as having lost chunks"
    );
}

/// Blocker 1 — the two ways alignments get written must stay distinguishable after the write.
///
/// The web practice loop posts alignments computed from a transcript the CLIENT supplied: either one
/// this API produced and handed to the browser, or the browser's own Web Speech recognition. A caller
/// can also post a flawless recitation having recited nothing at all. `finalize_session` is different
/// in kind — it fetches the transcript server-to-server from the service holding the audio and the
/// caller supplies no words.
///
/// Both wrote identical rows. `/v1/learner/progress/weekly` then averaged them into a figure it
/// called "accuracy", and a teacher promoting a finding to learner-visible feedback could not tell
/// which sort of evidence it rested on.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn a_client_posted_alignment_is_recorded_as_client_reported() {
    use sqlx::Row;
    let state = test_state();
    let router = platform_router_with_rate_limit(test_state(), false);
    let session_id = finalize_test_session(&router, "fnv1a32:provenance-client").await;

    let persisted = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({
            "modelVersion": "model-v0.3",
            // A perfect recitation, asserted rather than recited.
            "alignments": [
                {"wordId": "1:1:1", "heardText": "بسم", "startMs": 0, "endMs": 400, "confidence": 1.0, "status": "matched"},
                {"wordId": "1:1:2", "heardText": "الله", "startMs": 400, "endMs": 800, "confidence": 1.0, "status": "matched"}
            ]
        }),
    )
    .await;
    assert_eq!(persisted.status(), StatusCode::OK);
    let body = read_json::<Value>(persisted).await;
    assert_eq!(
        body["transcriptSource"],
        json!("client-reported"),
        "the response must not let a caller believe its words were recorded as measured evidence"
    );

    let sources: Vec<String> = sqlx::query(
        "SELECT transcript_source FROM word_alignments WHERE session_id = $1 AND tenant_id = $2",
    )
    .bind(&session_id)
    .bind("hikmah-pilot-erbil")
    .fetch_all(&state.pool)
    .await
    .unwrap()
    .into_iter()
    .map(|r| r.try_get::<String, _>("transcript_source").unwrap())
    .collect();
    assert_eq!(sources.len(), 2);
    assert!(
        sources.iter().all(|s| s == "client-reported"),
        "words the server never heard were stored as if it had: {sources:?}"
    );
}

/// The other half. A label that is always `client-reported` distinguishes nothing — this is what
/// stops the test above from passing against an implementation that simply writes one constant.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn a_finalized_session_records_a_server_derived_alignment() {
    use sqlx::Row;
    let mock = spawn_mock_ml_finalize(true).await;
    let state = test_state().with_ml_inference_url(mock.clone());
    let router = platform_router_with_rate_limit(test_state().with_ml_inference_url(mock), false);
    let session_id = finalize_test_session(&router, "fnv1a32:provenance-server").await;

    let done = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/finalize"),
        Some("hikmah-pilot-erbil"),
        Some("learner"),
        json!({}),
    )
    .await;
    assert_eq!(done.status(), StatusCode::OK);
    assert_eq!(read_json::<Value>(done).await["finalized"], json!(true));

    let sources: Vec<String> = sqlx::query(
        "SELECT transcript_source FROM word_alignments WHERE session_id = $1 AND tenant_id = $2",
    )
    .bind(&session_id)
    .bind("hikmah-pilot-erbil")
    .fetch_all(&state.pool)
    .await
    .unwrap()
    .into_iter()
    .map(|r| r.try_get::<String, _>("transcript_source").unwrap())
    .collect();
    assert!(!sources.is_empty(), "finalize persisted nothing to check");
    assert!(
        sources.iter().all(|s| s == "server-derived"),
        "the one path that never takes words from a caller was not credited for it: {sources:?}"
    );
}

/// Measured accuracy must come from words the server itself transcribed.
///
/// Averaging a learner's self-reported practice into a figure labelled "accuracy" is the same class
/// of untruth as the static charts P1.1 replaced, and harder to spot: the arithmetic is real, the
/// data underneath means something else.
///
/// ── Why this test creates its own learner ──────────────────────────────────────────────────────
/// `learner-1` is shared by the whole suite and the weekly window buckets by DAY, so every other
/// test that persists an alignment lands in the same bucket. Written against `learner-1` this test
/// first read a neighbour's `accuracy: 50.0` and failed while the code was correct; rewritten as a
/// before/after delta it then raced the two tests above, which run concurrently in this process and
/// moved the counters between the two reads. Neither failure was real and both looked real, which is
/// the expensive kind. A learner nobody else touches makes the numbers mean what they say.
#[tokio::test]
#[ignore = "requires live Postgres"]
async fn weekly_accuracy_excludes_self_reported_words_but_still_counts_them() {
    let state = test_state();
    let router = platform_router_with_rate_limit(test_state(), false);

    let learner = format!("learner-provenance-{}", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, tenant_id, display_name, role, language)
         VALUES ($1, 'hikmah-pilot-erbil', 'Provenance Test Learner', 'learner', 'ckb')",
    )
    .bind(&learner)
    .execute(&state.pool)
    .await
    .unwrap();

    // Admin creates and writes on the learner's behalf: `send_json` maps a role to one fixed user id,
    // so "learner" is always learner-1. Both routes allow admin (`require_self_or_any(.., ADMIN)`),
    // and this test is about arithmetic, not about who may write.
    let created = send_json(
        &router,
        Method::POST,
        "/v1/recitation-sessions",
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({
            "learnerId": learner,
            "quranRef": {"surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1:1-7"},
            "sourceChecksum": "fnv1a32:provenance-weekly", "modelVersion": "model-v0.3",
            "language": "ckb", "mode": "guided-recite", "practicePlanId": "fatihah-mastery-v1",
            "consent": {"audioRetention": "discard", "anonymizedLearning": true, "externalAsrProcessing": false, "guardianApproved": true, "consentVersion": "pilot-v1"}
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let session_id = read_json::<Value>(created).await["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let persisted = send_json(
        &router,
        Method::POST,
        &format!("/v1/recitation-sessions/{session_id}/alignments"),
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({
            "modelVersion": "model-v0.3",
            // A flawless recitation, asserted rather than recited.
            "alignments": [
                {"wordId": "1:1:1", "heardText": "بسم", "startMs": 0, "endMs": 400, "confidence": 1.0, "status": "matched"},
                {"wordId": "1:1:2", "heardText": "الله", "startMs": 400, "endMs": 800, "confidence": 1.0, "status": "matched"}
            ]
        }),
    )
    .await;
    assert_eq!(persisted.status(), StatusCode::OK);

    let weekly = send_json(
        &router,
        Method::GET,
        &format!("/v1/learner/progress/weekly?learnerId={learner}"),
        Some("hikmah-pilot-erbil"),
        Some("admin"),
        json!({}),
    )
    .await;
    assert_eq!(weekly.status(), StatusCode::OK);
    let body = read_json::<Value>(weekly).await;
    let days = body["days"].as_array().unwrap();
    assert_eq!(
        days.len(),
        1,
        "this learner has exactly one session: {body}"
    );
    let day = &days[0];

    assert_eq!(
        day["accuracy"],
        Value::Null,
        "two self-asserted words became a 100% measured accuracy: {day}"
    );
    assert_eq!(
        day["wordsTotal"],
        json!(0),
        "self-reported words were counted as measured: {day}"
    );
    assert_eq!(
        day["wordsMatched"],
        json!(0),
        "self-reported words were counted as correctly recited: {day}"
    );
    assert_eq!(
        day["wordsSelfReported"],
        json!(2),
        "the practice was recorded and then hidden from the learner entirely: {day}"
    );
    assert_eq!(
        day["sessions"],
        json!(1),
        "the session itself must still count: {day}"
    );
}
