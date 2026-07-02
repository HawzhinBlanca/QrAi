use std::net::SocketAddr;

use quran_ai_realtime_gateway::{GatewayServerConfig, gateway_router};

/// Refuse to boot in production with a missing or known-weak ticket secret. The HMAC
/// ticket secret must be shared with platform-api and unpredictable, otherwise anyone
/// can forge realtime-audio tickets. Local dev opts out with ALLOW_INSECURE_DEFAULTS=1.
fn ensure_secure_config() {
    let dev = std::env::var("ALLOW_INSECURE_DEFAULTS")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    if dev {
        return;
    }
    let secret = std::env::var("REALTIME_GATEWAY_TICKET_SECRET").unwrap_or_default();
    if secret.trim().is_empty()
        || secret == "smoke-secret"
        || secret == "production-secret-change-me"
        || secret.len() < 32
    {
        panic!(
            "REALTIME_GATEWAY_TICKET_SECRET must be set to a strong, non-default value in \
             production (shared with platform-api, at least 32 characters). Set ALLOW_INSECURE_DEFAULTS=1 for local dev only."
        );
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ensure_secure_config();

    let addr: SocketAddr = std::env::var("REALTIME_GATEWAY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8081".to_owned())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;

    println!("quran-ai realtime gateway listening on http://{addr}");
    axum::serve(listener, gateway_router(GatewayServerConfig::default())).await?;

    Ok(())
}
