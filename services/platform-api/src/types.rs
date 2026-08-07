use serde::{Deserialize, Serialize};

// Mirrors packages/contracts/src/index.ts's SUPPORTED_LANGUAGE_CODES exactly. `language` fields
// (users.language, recitation_sessions.language) were plain unvalidated Strings -- every other
// enum-shaped column in this schema (role, review_status, status, severity, risk, audio_retention)
// has a matching Rust-side check + a DB CHECK constraint; this one didn't, so an arbitrary string
// could be persisted and later silently drive UI logic (e.g. text-direction selection) with no
// validation error anywhere. See infra/migrations for the matching DB-level CHECK constraint.
pub const SUPPORTED_LANGUAGE_CODES: [&str; 9] =
    ["ar", "ckb", "en", "tr", "ur", "id", "ms", "fr", "de"];

pub fn is_supported_language(code: &str) -> bool {
    SUPPORTED_LANGUAGE_CODES.contains(&code)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorRole {
    Learner,
    Teacher,
    Scholar,
    Admin,
    Ops,
}

impl ActorRole {
    pub fn parse_role(value: &str) -> Option<Self> {
        match value {
            "learner" => Some(Self::Learner),
            "teacher" => Some(Self::Teacher),
            "scholar" => Some(Self::Scholar),
            "admin" => Some(Self::Admin),
            "ops" => Some(Self::Ops),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Actor {
    pub tenant_id: String,
    pub user_id: String,
    pub role: ActorRole,
}

impl Actor {
    pub fn require_any(&self, allowed: &[ActorRole]) -> Result<(), ApiError> {
        if allowed.contains(&self.role) {
            Ok(())
        } else {
            Err(ApiError::Forbidden)
        }
    }

    pub fn require_self_or_any(
        &self,
        owner_id: &str,
        allowed: &[ActorRole],
    ) -> Result<(), ApiError> {
        if self.user_id == owner_id || allowed.contains(&self.role) {
            Ok(())
        } else {
            Err(ApiError::Forbidden)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuranReference {
    pub surah_number: u16,
    pub ayah_start: u16,
    pub ayah_end: u16,
    // packages/contracts/src/index.ts's QuranReference has always declared these two as optional
    // (word-level scoping within an ayah range), but this struct never had matching fields --
    // serde silently drops any unknown JSON field on deserialize, so a caller sending wordStart/
    // wordEnd lost that data the instant the request was parsed, before it ever reached the DB.
    pub word_start: Option<u16>,
    pub word_end: Option<u16>,
    pub display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Consent {
    #[serde(default)]
    pub recording_consent: bool,
    pub audio_retention: AudioRetention,
    pub anonymized_learning: bool,
    #[serde(default)]
    pub external_asr_processing: bool,
    #[serde(default)]
    pub guardian_approved: bool,
    #[serde(default = "default_consent_version")]
    pub consent_version: String,
}

fn default_consent_version() -> String {
    "pilot-v1".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum AudioRetention {
    Discard,
    TrainingOptIn,
    TeacherReview,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewStatus {
    Draft,
    AiSuggested,
    TeacherReviewRequired,
    TeacherReviewed,
    ScholarApproved,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ScholarDecision {
    Draft,
    ScholarApproved,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum TeacherDecision {
    Accepted,
    Rejected,
    Edited,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum PracticeMode {
    Listen,
    GuidedRecite,
    MemoryRecite,
    Correction,
    Drill,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceReference {
    pub id: String,
    pub title: String,
    pub citation: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecitationSessionRequest {
    pub learner_id: String,
    pub quran_ref: QuranReference,
    pub source_checksum: String,
    #[serde(default)]
    pub model_version: Option<String>,
    pub language: String,
    #[serde(default = "default_practice_mode")]
    pub mode: PracticeMode,
    #[serde(default = "default_practice_plan_id")]
    pub practice_plan_id: String,
    pub consent: Consent,
}

fn default_practice_mode() -> PracticeMode {
    PracticeMode::GuidedRecite
}

fn default_practice_plan_id() -> String {
    "fatihah-mastery-v1".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecitationSession {
    pub id: String,
    pub tenant_id: String,
    pub learner_id: String,
    pub quran_ref: QuranReference,
    pub source_checksum: String,
    pub model_version: String,
    pub language: String,
    pub mode: PracticeMode,
    pub practice_plan_id: String,
    pub external_processing_allowed: bool,
    pub confidence: f32,
    pub review_status: ReviewStatus,
    pub consent: Consent,
    pub audit_event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeSessionTicketRequest {
    pub session_id: String,
    #[serde(default)]
    pub requested_sample_rates: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeSessionTicket {
    pub session_id: String,
    pub tenant_id: String,
    pub learner_id: String,
    pub expires_at: String,
    pub allowed_sample_rates: Vec<u32>,
    pub external_asr_processing: bool,
    pub token: String,
    pub audit_event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeacherReviewRequest {
    pub finding_id: String,
    pub teacher_id: String,
    pub decision: TeacherDecision,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeacherReview {
    pub id: String,
    pub tenant_id: String,
    /// `None` once the finding is gone.
    ///
    /// A re-record detaches this review rather than deleting it (ADR-0031), which released the
    /// column to NULL. The wire type followed a step late: the queue mapped that NULL to `""` and
    /// the contract said `minLength: 1`, so every detached review was a response the API's own
    /// schema forbids — and `""` reads as "the finding is the empty string", not "there isn't one".
    pub finding_id: Option<String>,
    pub teacher_id: String,
    pub decision: TeacherDecision,
    pub note: String,
    /// When a re-record superseded this review, or `None` while it is still about a live finding.
    ///
    /// Without it a reader sees a review pointing at no finding and nothing saying why — the same
    /// "a teacher rejected something" gap ADR-0031 closed at the row level, reappearing at the API.
    pub superseded_at: Option<String>,
    pub audit_event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScholarApprovalRequest {
    pub topic: String,
    pub reviewer_id: String,
    pub status: ScholarDecision,
    pub risk: RiskLevel,
    pub sources: Vec<SourceReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScholarApproval {
    pub id: String,
    pub tenant_id: String,
    pub topic: String,
    pub reviewer_id: String,
    pub status: ScholarDecision,
    pub risk: RiskLevel,
    pub sources: Vec<SourceReference>,
    pub audit_event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvalRun {
    pub model_version: String,
    pub dataset_version: String,
    pub word_alignment_f1: f32,
    pub tajweed_f1: f32,
    pub false_positive_rate: f32,
    pub teacher_agreement_rate: f32,
    pub unsourced_learner_outputs: u32,
    pub passed: bool,
    pub evaluation_task: Option<String>,
    pub evidence_id: Option<String>,
    pub evidence_kind: String,
    pub evidence_eligibility: String,
    pub release_eligible: bool,
    pub evidence_payload: Option<serde_json::Value>,
    pub evidence_payload_sha256: Option<String>,
    pub candidate_id: Option<String>,
    pub model_artifact_sha256: Option<String>,
    pub dataset_manifest_sha256: Option<String>,
    pub split_manifest_sha256: Option<String>,
    pub split_id: Option<String>,
    pub evaluator_version: Option<String>,
    pub evaluator_source_sha256: Option<String>,
    pub evaluator_protocol_sha256: Option<String>,
    pub raw_row_manifest_sha256: Option<String>,
    pub raw_results_sha256: Option<String>,
    pub calibrator_id: Option<String>,
    pub calibrator_artifact_sha256: Option<String>,
    pub signer_key_id: Option<String>,
    pub signature_algorithm: Option<String>,
    pub signature_base64_url: Option<String>,
    pub signed_at: Option<String>,
    pub evaluation_counts: Option<serde_json::Value>,
    pub slice_metrics: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: String,
    pub tenant_id: String,
    pub actor_id: String,
    pub trace_id: Option<String>,
    pub action: String,
    pub subject_type: String,
    pub subject_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum PrivacyJobKind {
    Export,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyJobRequest {
    pub learner_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyJob {
    pub id: String,
    pub tenant_id: String,
    pub learner_id: String,
    pub kind: PrivacyJobKind,
    pub included_records: Vec<String>,
    pub deleted_records: Vec<String>,
    pub audio_object_keys_deleted: Vec<String>,
    pub audit_event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorBody {
    pub error: String,
}

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum ApiError {
    #[error("missing or invalid authorization")]
    Unauthorized,
    #[error("actor is not allowed to perform this action")]
    Forbidden,
    #[error("record not found")]
    NotFound,
    #[error("source references are required for scholar-approved content")]
    MissingSources,
    #[error("high-risk content cannot be auto-approved")]
    HighRiskApproval,
    #[error("database error: {0}")]
    Database(String),
    #[error("{0}")]
    BadRequest(String),
    /// An upstream/proxied service (e.g. ML inference) failed. The message is GENERIC and safe to
    /// return to clients — detailed errors are logged server-side, never surfaced (no topology leak).
    #[error("{0}")]
    Upstream(String),
    /// The service is temporarily unable to serve — currently only DB connection-pool exhaustion
    /// (acquire timeout). Distinct 503 (retryable) rather than a generic 500, so a classroom burst
    /// that saturates the pool is a clear "busy, try again" signal, not indistinguishable from a bug.
    #[error("{0}")]
    Unavailable(String),
    /// The thing existed and is deliberately gone — not lost, not pending, not forbidden.
    ///
    /// Used for a recitation a learner asked to have destroyed. A 404 there reads as "we lost it" or
    /// "not yet" and a teacher keeps coming back; 403 reads as "ask for access" and invites someone
    /// to try. 410 is the only one of the three that says what actually happened, and it is the
    /// honest answer to give about consent being honoured.
    #[error("{0}")]
    Gone(String),
    /// A request-body rejection, carried VERBATIM so it reaches the wire exactly as axum would have
    /// sent it: its own status (400 syntax / 422 data / 415 content-type) and its own `text/plain`
    /// message, not this enum's `{"error": …}` JSON envelope.
    ///
    /// It exists so a handler can check the CALLER before it parses the body. Taking
    /// `Result<Json<T>, JsonRejection>` makes the extractor infallible, moving the body error from
    /// "before the handler runs" to "wherever the handler chooses" — which must be after
    /// `resolve_actor` and `require_any`. Reconstructing the message here rather than reusing
    /// axum's response would silently change the bytes an authorized caller sees, trading one
    /// divergence for another.
    #[error("{1}")]
    BodyRejection(StatusCode, String),
}

/// Verbatim capture, so authorized callers see byte-identical body errors before and after the
/// reordering. `status()` and `body_text()` are what axum's own `IntoResponse` uses.
impl From<axum::extract::rejection::JsonRejection> for ApiError {
    fn from(rejection: axum::extract::rejection::JsonRejection) -> Self {
        Self::BodyRejection(rejection.status(), rejection.body_text())
    }
}

/// An UNPARSED request body: what a handler takes when it must identify the caller first.
///
/// `Json<T>` is an axum EXTRACTOR — it runs before the handler function body, so a handler declaring
/// it has already rejected a malformed body before its first line executes, and `resolve_actor` /
/// `require_any` never run. That ordering told an anonymous caller the field names of every
/// authenticated write endpoint: `POST /v1/pilot/invitations` with `{}` and no credentials at all
/// answered *missing field `learnerId`*. Measured on 16 routes, not deduced.
///
/// `Result<Json<T>, JsonRejection>` is itself an extractor and CANNOT fail, which moves the body
/// error from "before the handler" to wherever the handler unwraps it. Take this, check the caller,
/// then `let Json(req) = body?;`.
///
/// The `?` converts through `From<JsonRejection> for ApiError` above, so an authorized caller's
/// malformed-body response is byte-for-byte what axum sent before.
pub type JsonBody<T> = Result<Json<T>, axum::extract::rejection::JsonRejection>;

/// The two SQLSTATEs a caller-supplied NUL byte (`U+0000`) produces, depending on column type:
///
/// - `22021` `character_not_in_repertoire` — into a `text` column:
///   *invalid byte sequence for encoding "UTF8": 0x00*
/// - `22P05` `untranslatable_character` — into `jsonb`:
///   *unsupported Unicode escape sequence*
///
/// **`22P05` was added after the plan.** The plan said "`22021` only", written before measuring that
/// the same input produces a different code when the column is `jsonb` — which is why
/// `POST /v1/agent-runs` with a NUL inside `sources` was the one surface still 500ing after the
/// first fix. Same defect, same caller-supplied byte, different column type.
///
/// SQLSTATE class `22` is "Data Exception": the value cannot be represented, which is the caller's
/// problem and not a server fault. But only THESE TWO codes, deliberately — other class-22 codes are
/// not unambiguously caller-supplied. `22003` numeric_value_out_of_range is exactly how the SM-2
/// `interval_days` overflow surfaced (`1675d62`), and mapping it to 400 would have reported that
/// SERVER bug as a client error and hidden it.
///
/// These two are safe because **nothing in this service emits a NUL byte**, so every occurrence is
/// caller-supplied by construction. The service is UTF-8 end to end (Rust `String`, Postgres UTF8),
/// so a NUL is the only untranslatable character either code can be reporting.
const SQLSTATE_NUL_BYTE: [&str; 2] = ["22021", "22P05"];

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        // Checked before the match: these arrive as sqlx::Error::Database, which would otherwise
        // fall to the catch-all below and become a 500.
        if e.as_database_error()
            .and_then(|db| db.code())
            .is_some_and(|code| SQLSTATE_NUL_BYTE.contains(&code.as_ref()))
        {
            // A fixed message, NOT the Postgres text. `Self::Database` redacts raw database errors
            // because they can carry table and constraint names and, on constraint violations, the
            // conflicting values themselves. A 400 must not become the way around that.
            return Self::BadRequest(
                "request contains a NUL byte (U+0000), which cannot be stored".to_owned(),
            );
        }
        match e {
            sqlx::Error::RowNotFound => Self::NotFound,
            // Pool acquire timed out — every connection is in use. This is load, not a fault: a 503
            // tells the client (and any LB/retry policy) to back off and retry, not that the request
            // was malformed or the server broke.
            sqlx::Error::PoolTimedOut => {
                Self::Unavailable("the service is busy; please try again in a moment".to_owned())
            }
            other => Self::Database(other.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // Straight back out, before the JSON envelope below can touch it: a body rejection is
        // text/plain with axum's own wording, and wrapping it in `{"error": …}` would be a wire
        // change for every authorized caller who sends a malformed body.
        if let Self::BodyRejection(status, text) = self {
            return (status, text).into_response();
        }
        let status = match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::MissingSources | Self::HighRiskApproval | Self::BadRequest(_) => {
                StatusCode::BAD_REQUEST
            }
            Self::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Gone(_) => StatusCode::GONE,
            // Returned above. Listed rather than caught by a `_` so that adding a variant later is
            // still a compile error here instead of silently becoming a 500.
            Self::BodyRejection(..) => unreachable!("returned before this match"),
        };
        // Database errors get the SAME treatment as Upstream (see its doc comment): the raw sqlx/
        // Postgres error text can embed table/constraint names and, for constraint-violation DETAIL
        // lines, the actual conflicting VALUES (e.g. an email address that collided on a unique
        // index) — verified by constructing a real duplicate-key error and observing it serialize
        // straight into the response body. Log the detail server-side; return a generic message.
        let message = match &self {
            Self::Database(detail) => {
                tracing::error!("database error: {detail}");
                "a database error occurred".to_owned()
            }
            _ => self.to_string(),
        };
        (status, Json(ApiErrorBody { error: message })).into_response()
    }
}

pub fn next_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// N1 — the SQLSTATE mapping itself, not only its effect through one handler.
    /// specs/nul-byte-5xx/plan.md §5
    ///
    /// This conversion sits on essentially every `await?` in the service, so a wrong condition here
    /// changes how EVERY database error is reported. The parity suite proves the 400 reaches the
    /// wire on 16 real endpoints; this proves the rule those 16 rest on, including the far more
    /// important negative case: **anything that is not a NUL byte must still be a 500.** A 400 on a
    /// genuine server fault reads as the caller's problem and makes the bug invisible.
    #[test]
    fn only_a_nul_byte_sqlstate_becomes_a_bad_request() {
        // A minimal sqlx::Error::Database carrying a chosen SQLSTATE. sqlx's own PgDatabaseError is
        // not constructible from outside the crate, so the code is exercised through the same
        // `as_database_error().code()` path a real error takes.
        #[derive(Debug)]
        struct FakeDbError(&'static str);
        impl std::fmt::Display for FakeDbError {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(
                    f,
                    "table \"users\" constraint \"idx_users_tenant_email_unique\""
                )
            }
        }
        impl std::error::Error for FakeDbError {}
        impl sqlx::error::DatabaseError for FakeDbError {
            fn message(&self) -> &str {
                "unsupported Unicode escape sequence"
            }
            fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
                Some(std::borrow::Cow::Borrowed(self.0))
            }
            fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
                self
            }
            fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
                self
            }
            fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
                self
            }
            fn kind(&self) -> sqlx::error::ErrorKind {
                sqlx::error::ErrorKind::Other
            }
        }
        let as_api =
            |code: &'static str| ApiError::from(sqlx::Error::Database(Box::new(FakeDbError(code))));

        // A NUL byte, in a text column and in jsonb.
        for code in ["22021", "22P05"] {
            match as_api(code) {
                ApiError::BadRequest(message) => {
                    assert!(
                        message.contains("NUL"),
                        "{code}: must name the problem: {message}"
                    );
                    // The fixed message must not forward the database's, which carries a table and
                    // an index name here — Database(_) redacts that, and a 400 must not become the
                    // way around the redaction.
                    assert!(
                        !message.contains("users"),
                        "{code}: leaked a table name: {message}"
                    );
                    assert!(
                        !message.contains("Unicode"),
                        "{code}: forwarded Postgres text: {message}"
                    );
                }
                other => panic!("{code} must be a 400, got {other:?}"),
            }
        }

        // THE NEGATIVE CASE. Every other SQLSTATE — including the rest of class 22 — must still be
        // a 500. 22003 is numeric_value_out_of_range, which is how the SM-2 interval overflow
        // surfaced: as a 400 it would have read as the caller's fault and been ignored.
        for code in ["22003", "22001", "23505", "23503", "42P01", "40001"] {
            assert!(
                matches!(as_api(code), ApiError::Database(_)),
                "{code} must stay a 500 — mapping it to 400 would hide a server fault"
            );
        }
    }

    /// A client-facing 500 for a DB error must never echo the raw sqlx/Postgres error text: it can
    /// contain table/constraint names and, for constraint-violation DETAIL lines, the actual
    /// conflicting VALUES (e.g. another user's email that collided on a unique index).
    #[tokio::test]
    async fn database_error_response_never_leaks_the_raw_message() {
        let raw = "error returned from database: duplicate key value violates unique constraint \
                    \"idx_users_tenant_email_unique\" DETAIL: Key (tenant_id, email)=\
                    (hikmah-pilot-erbil, someone@example.com) already exists.";
        let response = ApiError::Database(raw.to_owned()).into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(
            !text.contains("someone@example.com")
                && !text.contains("idx_users_tenant_email_unique"),
            "response body leaked the raw database error: {text}",
        );
        assert!(text.contains("a database error occurred"), "got: {text}");
    }

    #[test]
    fn consent_deserializes_the_documented_default_version_when_omitted() {
        // The consent_version is part of the compliance/audit trail — a consent record is only
        // meaningful against the policy version it was captured under. If the client omits it, the
        // server must stamp the documented default ("pilot-v1"), never an empty or arbitrary
        // string. Pins default_consent_version() AND its #[serde(default = ...)] wiring: a mutant
        // returning "" or some other value would silently mislabel every default-version consent.
        let consent: Consent = serde_json::from_value(serde_json::json!({
            "audioRetention": "discard",
            "anonymizedLearning": false,
        }))
        .expect("consent with only required fields deserializes");
        assert_eq!(consent.consent_version, "pilot-v1");
    }

    #[test]
    fn recitation_session_request_deserializes_the_documented_default_practice_plan_when_omitted() {
        // When a session request omits practicePlanId, the server must fall back to the documented
        // default plan ("fatihah-mastery-v1"), not an empty/arbitrary id — an empty plan id would
        // detach the session from any real practice plan. Pins default_practice_plan_id() and its
        // serde-default wiring.
        let req: RecitationSessionRequest = serde_json::from_value(serde_json::json!({
            "learnerId": "learner-1",
            "quranRef": { "surahNumber": 1, "ayahStart": 1, "ayahEnd": 7, "display": "Al-Fatihah 1-7" },
            "sourceChecksum": "sha256:abc",
            "language": "ar",
            "consent": { "audioRetention": "discard", "anonymizedLearning": false },
        }))
        .expect("session request without an explicit practice plan id deserializes");
        assert_eq!(req.practice_plan_id, "fatihah-mastery-v1");
        assert_eq!(req.model_version, None);
    }
}
