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

    #[test]
    fn rejects_ticket_with_blank_tenant_id() {
        let ticket = "rt_v1.s1..l1.false.2000.n1.deadbeef";
        assert_eq!(
            validate_realtime_ticket("s1", ticket, "sec", 1_000),
            Err(TicketError::Malformed)
        );
    }

    #[test]
    fn rejects_ticket_with_blank_learner_id() {
        let ticket = "rt_v1.s1.t1..false.2000.n1.deadbeef";
        assert_eq!(
            validate_realtime_ticket("s1", ticket, "sec", 1_000),
            Err(TicketError::Malformed)
        );
    }

    #[test]
    fn rejects_ticket_with_blank_nonce() {
        let ticket = "rt_v1.s1.t1.l1.false.2000..deadbeef";
        assert_eq!(
            validate_realtime_ticket("s1", ticket, "sec", 1_000),
            Err(TicketError::Malformed)
        );
    }

    #[test]
    fn rejects_wrong_version_tag() {
        let ticket = "rt_v2.s1.t1.l1.false.2000.n1.deadbeef";
        assert_eq!(
            validate_realtime_ticket("s1", ticket, "sec", 1_000),
            Err(TicketError::Malformed)
        );
    }

    #[test]
    fn rejects_ticket_with_trailing_extra_parts() {
        let secret = "test-secret";
        let ticket = issue_realtime_ticket("s1", "t1", "l1", false, 2_000, "n1", secret);
        let with_trailer = format!("{ticket}.extra");
        assert_eq!(
            validate_realtime_ticket("s1", &with_trailer, secret, 1_000),
            Err(TicketError::Malformed)
        );
    }

    #[test]
    fn constant_time_eq_rejects_differences_that_would_cancel_under_xor_fold() {
        // A fold using `^` instead of `|` would let two differing bytes cancel
        // each other out (1 ^ 1 == 0), wrongly reporting equality. `|` cannot
        // cancel: any nonzero byte-diff keeps the accumulator nonzero.
        let left = [0b0000_0001, 0b0000_0010];
        let right = [0b0000_0000, 0b0000_0011];
        assert!(!constant_time_eq(&left, &right));
    }
}

/// N1 — the Rust half of the cross-language ticket vectors.
/// specs/node-backend-port/plan.md §5
///
/// The same file is asserted by `tests/node-api/ticket-vectors.test.mjs`. Both halves must agree,
/// which is what lets a Node `platform-api` mint tickets the UNCHANGED Rust gateway accepts — so the
/// two services no longer have to cut over together (plan.md §1).
///
/// The vectors were generated FROM THIS IMPLEMENTATION. Never regenerate them from a port: vectors
/// derived from the port would pin the port's behaviour, bugs included, and both suites would agree
/// while both were wrong.
#[cfg(test)]
mod ticket_vectors {
    use super::*;

    fn vectors() -> Vec<serde_json::Value> {
        // CARGO_MANIFEST_DIR keeps this working regardless of the caller's cwd.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../specs/node-backend-port/fixtures/ticket-vectors.json"
        );
        let raw = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("cannot read ticket vectors at {path}: {e}"));
        serde_json::from_str::<serde_json::Value>(&raw).expect("ticket vectors must be valid JSON")
            ["vectors"]
            .as_array()
            .expect("`vectors` must be an array")
            .clone()
    }

    #[test]
    fn rust_reproduces_every_committed_vector() {
        let vectors = vectors();
        assert!(!vectors.is_empty(), "the vector file must not be empty");
        for v in &vectors {
            let name = v["name"].as_str().unwrap();
            let issued = issue_realtime_ticket(
                v["sessionId"].as_str().unwrap(),
                v["tenantId"].as_str().unwrap(),
                v["learnerId"].as_str().unwrap(),
                v["externalAsrProcessing"].as_bool().unwrap(),
                // A STRING in the fixture, not a JSON number: u64::MAX does not survive
                // JSON.parse in the Node half (18446744073709551615 -> ...552000). Found by
                // the max-u64 vector, which is why it is in the set.
                v["expiresAtUnixSeconds"].as_str().unwrap().parse().unwrap(),
                v["nonce"].as_str().unwrap(),
                v["secret"].as_str().unwrap(),
            );
            assert_eq!(
                issued,
                v["expectedTicket"].as_str().unwrap(),
                "vector '{name}' drifted — the wire format changed, which is a TWO-SERVICE change"
            );
        }
    }

    #[test]
    fn every_committed_vector_validates_against_this_implementation() {
        // Reproducing the string is not enough: the gateway must also accept it. A format change
        // that broke only validation would pass the test above.
        for v in vectors() {
            let expires: u64 = v["expiresAtUnixSeconds"].as_str().unwrap().parse().unwrap();
            let claims = validate_realtime_ticket(
                v["sessionId"].as_str().unwrap(),
                v["expectedTicket"].as_str().unwrap(),
                v["secret"].as_str().unwrap(),
                expires - 1,
            )
            .unwrap_or_else(|e| panic!("vector '{}' failed validation: {e}", v["name"]));
            assert_eq!(claims.tenant_id, v["tenantId"].as_str().unwrap());
            assert_eq!(claims.learner_id, v["learnerId"].as_str().unwrap());
        }
    }

    #[test]
    fn the_vector_count_is_pinned() {
        // Guards against a truncated or partially-written file silently reducing coverage to zero
        // while both suites still report green.
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../specs/node-backend-port/fixtures/ticket-vectors.json"
        ))
        .unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            doc["vectorCount"].as_u64().unwrap() as usize,
            doc["vectors"].as_array().unwrap().len()
        );
    }
}
