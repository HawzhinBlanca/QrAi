//! Generator for specs/node-backend-port/fixtures/ticket-vectors.json.
//!
//! The fixture's own $comment mandates this path: vectors are GENERATED FROM RUST, never
//! hand-written and never derived from the Node port. Run with:
//!
//!   cargo test --test regenerate_vectors -- --ignored --nocapture
//!
//! A TOOL, not a gate — `#[ignore]`d so it never runs in CI and never rewrites the fixture behind
//! anyone's back. It is committed rather than thrown away because the last format change had to
//! reconstruct it from the fixture comment, and because `cargo test` still COMPILES an ignored test:
//! the next change to `issue_realtime_ticket`'s signature breaks this file loudly, at exactly the
//! moment someone needs it. The table below is the input spec; the JSON is the output. Edit here,
//! re-run, commit both.
use quran_ai_shared_ticket::{TICKET_VERSION, issue_realtime_ticket};

struct Vector {
    name: &'static str,
    session_id: &'static str,
    tenant_id: &'static str,
    learner_id: &'static str,
    external_asr_processing: bool,
    audio_retention: &'static str,
    expires_at: &'static str,
    nonce: &'static str,
    secret: &'static str,
}

/// The same six cases as before, each now carrying a retention value. All three values the
/// `consent_records.audio_retention` CHECK constraint permits appear at least once.
const VECTORS: &[Vector] = &[
    Vector {
        name: "ascii-basic",
        session_id: "session-1",
        tenant_id: "tenant-1",
        learner_id: "learner-1",
        external_asr_processing: true,
        audio_retention: "discard",
        expires_at: "2000",
        nonce: "nonce-1",
        secret: "test-secret",
    },
    Vector {
        name: "external-asr-false",
        session_id: "session-2",
        tenant_id: "hikmah-pilot-erbil",
        learner_id: "learner-1",
        external_asr_processing: false,
        audio_retention: "teacher-review",
        expires_at: "1900000000",
        nonce: "n-2",
        secret: "test-secret",
    },
    Vector {
        name: "prefixed-uuid-ids",
        session_id: "recitation-session-550e8400-e29b-41d4-a716-446655440000",
        tenant_id: "hikmah-pilot-erbil",
        learner_id: "learner-42",
        external_asr_processing: true,
        audio_retention: "training-opt-in",
        expires_at: "1893456000",
        nonce: "0123456789abcdef",
        secret: "a-much-longer-secret-value-32ch",
    },
    Vector {
        name: "unicode-tenant",
        session_id: "s-1",
        tenant_id: "مدرسة-هيكمة",
        learner_id: "learner-ك",
        external_asr_processing: false,
        audio_retention: "teacher-review",
        expires_at: "2147483647",
        nonce: "nonce-ünïcode",
        secret: "sécret-with-ünicode",
    },
    Vector {
        name: "empty-secret",
        session_id: "s-1",
        tenant_id: "t-1",
        learner_id: "l-1",
        external_asr_processing: true,
        audio_retention: "training-opt-in",
        expires_at: "2000",
        nonce: "n-1",
        secret: "",
    },
    Vector {
        name: "max-u64-expiry",
        session_id: "s-1",
        tenant_id: "t-1",
        learner_id: "l-1",
        external_asr_processing: false,
        audio_retention: "discard",
        expires_at: "18446744073709551615",
        nonce: "n-1",
        secret: "test-secret",
    },
];

#[test]
#[ignore = "one-shot generator, not a gate"]
fn regenerate() {
    let comment = concat!(
        "N1 — cross-language golden vectors for the realtime ticket ",
        "(services/shared-ticket/src/lib.rs). Asserted by BOTH a Rust test in that crate and ",
        "tests/node-api/ticket-vectors.test.mjs, so platform-api and realtime-gateway can be ported ",
        "independently instead of cutting over together (specs/node-backend-port/plan.md §1). ",
        "GENERATED FROM RUST, never from a port: vectors derived from the port would pin the port's ",
        "behaviour including its bugs, and both suites would agree while both were wrong. To ",
        "regenerate, add a temporary generator test to shared-ticket — do not hand-edit ",
        "expectedTicket. expiresAtUnixSeconds is a STRING, not a JSON number: Rust's u64 range ",
        "exceeds JS's Number.MAX_SAFE_INTEGER, and the max-u64 vector proved it — JSON.parse turned ",
        "18446744073709551615 into 18446744073709552000. Any u64 crossing a JSON boundary in this ",
        "port has the same hazard. audioRetention joined the payload on 2026-08-03 (rt_v1 -> rt_v2) ",
        "so the gateway can tell ml-inference how long a learner agreed their audio may be kept; ",
        "every value the database CHECK permits appears in the set below."
    );

    let mut out = String::new();
    out.push_str("{\n");
    out.push_str(&format!("  \"$comment\": {},\n", json_string(comment)));
    out.push_str(
        "  \"payloadFormat\": \"{sessionId}.{tenantId}.{learnerId}.{externalAsrProcessing}.{audioRetention}.{expiresAtUnixSeconds}.{nonce}\",\n",
    );
    out.push_str(&format!(
        "  \"ticketFormat\": \"{TICKET_VERSION}.{{payload}}.{{lowercase hex HMAC-SHA256(secret, payload)}}\",\n"
    ));
    out.push_str(&format!("  \"vectorCount\": {},\n", VECTORS.len()));
    out.push_str("  \"vectors\": [\n");
    for (i, v) in VECTORS.iter().enumerate() {
        let ticket = issue_realtime_ticket(
            v.session_id,
            v.tenant_id,
            v.learner_id,
            v.external_asr_processing,
            v.audio_retention,
            v.expires_at.parse().unwrap(),
            v.nonce,
            v.secret,
        );
        out.push_str("    {\n");
        out.push_str(&format!("      \"name\": {},\n", json_string(v.name)));
        out.push_str(&format!(
            "      \"sessionId\": {},\n",
            json_string(v.session_id)
        ));
        out.push_str(&format!(
            "      \"tenantId\": {},\n",
            json_string(v.tenant_id)
        ));
        out.push_str(&format!(
            "      \"learnerId\": {},\n",
            json_string(v.learner_id)
        ));
        out.push_str(&format!(
            "      \"externalAsrProcessing\": {},\n",
            v.external_asr_processing
        ));
        out.push_str(&format!(
            "      \"audioRetention\": {},\n",
            json_string(v.audio_retention)
        ));
        out.push_str(&format!(
            "      \"expiresAtUnixSeconds\": {},\n",
            json_string(v.expires_at)
        ));
        out.push_str(&format!("      \"nonce\": {},\n", json_string(v.nonce)));
        out.push_str(&format!("      \"secret\": {},\n", json_string(v.secret)));
        out.push_str(&format!(
            "      \"expectedTicket\": {}\n",
            json_string(&ticket)
        ));
        out.push_str(if i + 1 == VECTORS.len() {
            "    }\n"
        } else {
            "    },\n"
        });
    }
    out.push_str("  ]\n}\n");

    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../specs/node-backend-port/fixtures/ticket-vectors.json"
    );
    std::fs::write(path, &out).unwrap();
    println!("wrote {} vectors to {path}", VECTORS.len());
}

/// Minimal JSON string escaping. Non-ASCII stays raw UTF-8 (the previous file did too).
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}
