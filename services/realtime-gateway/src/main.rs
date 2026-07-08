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
    // ML_API_KEY is the only credential gating the ML inference service; refuse the public default.
    let ml_key = std::env::var("ML_API_KEY").unwrap_or_default();
    if ml_key.trim().is_empty() || ml_key == "smoke-ml-api-key" {
        panic!(
            "ML_API_KEY must be set to a non-default value in production (it is the only credential \
             gating the ML inference service). Set ALLOW_INSECURE_DEFAULTS=1 for local dev only."
        );
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ensure_secure_config();

    // Without this, every tracing::info!/warn! call in lib.rs (CSWSH rejections, ticket
    // validation failures, rate-limit events — all security-relevant) is silently dropped: there
    // was no subscriber registered to emit them anywhere, and tracing-subscriber wasn't even a
    // dependency. Matches platform-api's main.rs, which already has this.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "quran_ai_realtime_gateway=info,tower_http=info".into()),
        )
        .init();

    let addr: SocketAddr = std::env::var("REALTIME_GATEWAY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8081".to_owned())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;

    println!("quran-ai realtime gateway listening on http://{addr}");
    // `into_make_service_with_connect_info` is required for tower_governor's default (non-proxy)
    // key extractor to read the peer IP — without it every request 500s with "Unable To Extract
    // Key!" the instant rate limiting is enabled. Verified empirically: this is the actual reason
    // the gateway shipped with rate limiting off by default — turning it on without this wiring
    // broke every request. Matches platform-api's main.rs, which already wires this correctly.
    axum::serve(
        listener,
        gateway_router(GatewayServerConfig::default())
            .into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    println!("quran-ai realtime gateway shut down cleanly");
    Ok(())
}

/// Resolves on SIGTERM (container stop / redeploy) or Ctrl-C so axum can drain in-flight requests
/// and stop accepting new connections rather than dropping them mid-deploy (P3.10).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
