use std::net::SocketAddr;

use quran_ai_platform_api::{AppState, platform_router};
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "quran_ai_platform_api=info,tower_http=info".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://hawzhin@localhost:5432/quran_ai".to_owned());

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .map_err(|e| {
            eprintln!("Failed to connect to Postgres at {database_url}: {e}");
            e
        })?;

    let jwt_secret =
        std::env::var("JWT_SECRET").unwrap_or_else(|_| "quran-ai-dev-secret".to_owned());

    let state = AppState::new(pool, &jwt_secret);

    let addr: SocketAddr = std::env::var("PLATFORM_API_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_owned())
        .parse()?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("quran-ai platform api listening on http://{addr}");

    axum::serve(
        listener,
        platform_router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}
