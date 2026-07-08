use serde::{Deserialize, Serialize};

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
    pub model_version: String,
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
    pub finding_id: String,
    pub teacher_id: String,
    pub decision: TeacherDecision,
    pub note: String,
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
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::RowNotFound = e {
            Self::NotFound
        } else {
            Self::Database(e.to_string())
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::MissingSources | Self::HighRiskApproval | Self::BadRequest(_) => {
                StatusCode::BAD_REQUEST
            }
            Self::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
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
}
