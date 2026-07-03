use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
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
                {"wordId": "extra-0", "heardText": "x", "startMs": 0, "endMs": 0, "confidence": 0.5, "status": "extra"}
            ]
        }),
    )
    .await;
    assert_eq!(persisted.status(), StatusCode::OK);
    let body: Value = read_json(persisted).await;
    assert_eq!(body["persisted"], 1); // extra skipped

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

#[tokio::test]
#[ignore = "requires live Postgres"]
async fn privacy_delete_preserves_other_learners_teacher_reviews() {
    let state = test_state();
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
