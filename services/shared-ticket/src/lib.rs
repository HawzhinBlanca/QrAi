//! Shared realtime ticket issuance and validation for the Quran AI platform.
//!
//! Both `platform-api` (issuer) and `realtime-gateway` (validator) use this crate
//! so the HMAC ticket format and signing logic live in exactly one place.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// TTL for realtime session tickets (seconds). Consumers may override.
pub const DEFAULT_TICKET_TTL_SECONDS: u64 = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeTicketClaims {
    pub session_id: String,
    pub tenant_id: String,
    pub learner_id: String,
    pub external_asr_processing: bool,
    pub expires_at_unix_seconds: u64,
    pub nonce: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketError {
    Missing,
    Malformed,
    SessionMismatch,
    Expired,
    InvalidSignature,
}

impl std::fmt::Display for TicketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => write!(f, "missing realtime ticket"),
            Self::Malformed => write!(f, "malformed realtime ticket"),
            Self::SessionMismatch => write!(f, "realtime ticket is bound to another session"),
            Self::Expired => write!(f, "realtime ticket expired"),
            Self::InvalidSignature => write!(f, "realtime ticket signature is invalid"),
        }
    }
}

impl std::error::Error for TicketError {}

/// Issue a signed realtime ticket string.
pub fn issue_realtime_ticket(
    session_id: &str,
    tenant_id: &str,
    learner_id: &str,
    external_asr_processing: bool,
    expires_at_unix_seconds: u64,
    nonce: &str,
    secret: &str,
) -> String {
    let payload = ticket_payload(
        session_id,
        tenant_id,
        learner_id,
        external_asr_processing,
        expires_at_unix_seconds,
        nonce,
    );
    let signature = sign_ticket_payload(&payload, secret);
    format!(
        "rt_v1.{session_id}.{tenant_id}.{learner_id}.{external_asr_processing}.{expires_at_unix_seconds}.{nonce}.{signature}"
    )
}

/// Validate a signed realtime ticket string.
pub fn validate_realtime_ticket(
    expected_session_id: &str,
    ticket: &str,
    secret: &str,
    now_unix_seconds: u64,
) -> Result<RealtimeTicketClaims, TicketError> {
    let trimmed = ticket.trim();
    if trimmed.is_empty() {
        return Err(TicketError::Missing);
    }

    let mut parts = trimmed.split('.');
    let version = parts.next().ok_or(TicketError::Malformed)?;
    let session_id = parts.next().ok_or(TicketError::Malformed)?;
    let tenant_id = parts.next().ok_or(TicketError::Malformed)?;
    let learner_id = parts.next().ok_or(TicketError::Malformed)?;
    let external_asr_processing = parts.next().ok_or(TicketError::Malformed)?;
    let expires_at = parts.next().ok_or(TicketError::Malformed)?;
    let nonce = parts.next().ok_or(TicketError::Malformed)?;
    let signature = parts.next().ok_or(TicketError::Malformed)?;
    if parts.next().is_some()
        || version != "rt_v1"
        || tenant_id.trim().is_empty()
        || learner_id.trim().is_empty()
        || nonce.trim().is_empty()
    {
        return Err(TicketError::Malformed);
    }

    if session_id != expected_session_id {
        return Err(TicketError::SessionMismatch);
    }

    let expires_at = expires_at
        .parse::<u64>()
        .map_err(|_| TicketError::Malformed)?;
    if expires_at <= now_unix_seconds {
        return Err(TicketError::Expired);
    }
    let external_asr_processing = external_asr_processing
        .parse::<bool>()
        .map_err(|_| TicketError::Malformed)?;

    let payload = ticket_payload(
        session_id,
        tenant_id,
        learner_id,
        external_asr_processing,
        expires_at,
        nonce,
    );
    let expected_signature = sign_ticket_payload(&payload, secret);
    if !constant_time_eq(signature.as_bytes(), expected_signature.as_bytes()) {
        return Err(TicketError::InvalidSignature);
    }

    Ok(RealtimeTicketClaims {
        session_id: session_id.to_owned(),
        tenant_id: tenant_id.to_owned(),
        learner_id: learner_id.to_owned(),
        external_asr_processing,
        expires_at_unix_seconds: expires_at,
        nonce: nonce.to_owned(),
    })
}

fn ticket_payload(
    session_id: &str,
    tenant_id: &str,
    learner_id: &str,
    external_asr_processing: bool,
    expires_at_unix_seconds: u64,
    nonce: &str,
) -> String {
    format!(
        "{session_id}.{tenant_id}.{learner_id}.{external_asr_processing}.{expires_at_unix_seconds}.{nonce}"
    )
}

fn sign_ticket_payload(payload: &str, secret: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length for realtime ticket signing");
    mac.update(payload.as_bytes());
    to_hex(&mac.finalize().into_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    left.iter()
        .zip(right)
        .fold(0_u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_issue_validate() {
        let secret = "test-secret";
        let ticket = issue_realtime_ticket(
            "session-1",
            "tenant-1",
            "learner-1",
            true,
            2_000,
            "nonce-1",
            secret,
        );
        let claims = validate_realtime_ticket("session-1", &ticket, secret, 1_000).unwrap();
        assert_eq!(claims.session_id, "session-1");
        assert_eq!(claims.tenant_id, "tenant-1");
        assert_eq!(claims.learner_id, "learner-1");
        assert!(claims.external_asr_processing);
    }

    #[test]
    fn rejects_session_mismatch() {
        let secret = "test-secret";
        let ticket = issue_realtime_ticket("s1", "t1", "l1", false, 2_000, "n1", secret);
        assert_eq!(
            validate_realtime_ticket("s2", &ticket, secret, 1_000),
            Err(TicketError::SessionMismatch)
        );
    }

    #[test]
    fn rejects_expired_ticket() {
        let secret = "test-secret";
        let ticket = issue_realtime_ticket("s1", "t1", "l1", false, 2_000, "n1", secret);
        assert_eq!(
            validate_realtime_ticket("s1", &ticket, secret, 2_000),
            Err(TicketError::Expired)
        );
    }

    #[test]
    fn rejects_wrong_secret() {
        let ticket = issue_realtime_ticket("s1", "t1", "l1", false, 2_000, "n1", "correct");
        assert_eq!(
            validate_realtime_ticket("s1", &ticket, "wrong", 1_000),
            Err(TicketError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_empty_and_malformed() {
        assert_eq!(
            validate_realtime_ticket("s1", "", "sec", 0),
            Err(TicketError::Missing)
        );
        assert_eq!(
            validate_realtime_ticket("s1", "rt_smoke_ticket", "sec", 0),
            Err(TicketError::Malformed)
        );
    }
}
