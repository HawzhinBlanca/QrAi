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

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Learner => "learner",
            Self::Teacher => "teacher",
            Self::Scholar => "scholar",
            Self::Admin => "admin",
            Self::Ops => "ops",
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
    pub display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Consent {
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
        (
            status,
            Json(ApiErrorBody {
                error: self.to_string(),
            }),
        )
            .into_response()
    }
}

pub fn next_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}
