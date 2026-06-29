use std::net::SocketAddr;

use quran_ai_realtime_gateway::{GatewayServerConfig, gateway_router};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = std::env::var("REALTIME_GATEWAY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8081".to_owned())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;

    println!("quran-ai realtime gateway listening on http://{addr}");
    axum::serve(listener, gateway_router(GatewayServerConfig::default())).await?;

    Ok(())
}
