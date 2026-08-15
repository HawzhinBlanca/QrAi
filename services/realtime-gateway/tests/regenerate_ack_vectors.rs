//! Rust-oracle generator for packages/contracts/fixtures/realtime/audio-ack-vectors.json.
//!
//! Run deliberately with:
//!
//!   cargo test -p quran-ai-realtime-gateway --test regenerate_ack_vectors -- --ignored --nocapture
//!
//! This is compiled by ordinary `cargo test` but ignored so CI never rewrites a committed fixture.
//! Edit the inputs here, regenerate, and review the fixture and both language consumers together.

use quran_ai_realtime_gateway::{AudioIngressAck, GatewayError};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NamedVector {
    name: &'static str,
    ack: AudioIngressAck,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    #[serde(rename = "$comment")]
    comment: &'static str,
    ack_kind: &'static str,
    vector_count: usize,
    vectors: Vec<NamedVector>,
}

#[test]
#[ignore = "one-shot Rust-oracle generator, not a gate"]
fn regenerate() {
    let vectors = vec![
        NamedVector {
            name: "accepted-with-trace",
            ack: AudioIngressAck {
                kind: "audio.ack",
                session_id: "session-1".to_owned(),
                chunk_id: "session-1-ws-0000".to_owned(),
                sequence: 0,
                accepted: true,
                trace_id: Some("trace-abc".to_owned()),
                message: "accepted".to_owned(),
            },
        },
        NamedVector {
            name: "backpressure-without-trace",
            ack: AudioIngressAck {
                kind: "audio.ack",
                session_id: "session-2".to_owned(),
                chunk_id: "session-2-ws-0007".to_owned(),
                sequence: 7,
                accepted: false,
                trace_id: None,
                message: GatewayError::Backpressure("session-2".to_owned()).to_string(),
            },
        },
        NamedVector {
            name: "session-start-refusal",
            ack: AudioIngressAck {
                kind: "audio.ack",
                session_id: "session-3".to_owned(),
                chunk_id: "session-start".to_owned(),
                sequence: 0,
                accepted: false,
                trace_id: Some("trace-start".to_owned()),
                message: GatewayError::SessionAlreadyExists("session-3".to_owned()).to_string(),
            },
        },
    ];
    let fixture = Fixture {
        comment: "Language-neutral audio.ack vectors generated only by the Rust realtime gateway oracle. message is diagnostic prose; consumers branch only on kind and accepted. Regenerate with services/realtime-gateway/tests/regenerate_ack_vectors.rs; never hand-author values as runtime or model evidence.",
        ack_kind: "audio.ack",
        vector_count: vectors.len(),
        vectors,
    };
    let mut output = serde_json::to_string_pretty(&fixture).expect("ack fixture should serialize");
    output.push('\n');
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/fixtures/realtime/audio-ack-vectors.json"
    );
    std::fs::write(path, output).expect("ack fixture should be writable");
    println!("wrote {} audio ack vectors to {path}", fixture.vector_count);
}
