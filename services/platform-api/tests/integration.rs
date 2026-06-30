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
    AppState::new(pool, "test-jwt-secret")
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
