FROM rust:1.96-bookworm AS builder
WORKDIR /app
COPY services/realtime-gateway/Cargo.toml services/realtime-gateway/Cargo.lock* ./
COPY services/realtime-gateway/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y curl libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/quran-ai-realtime-gateway /usr/local/bin/
# Run as a non-root user (defense-in-depth). The binary only reads env + serves the WebSocket over
# the network and writes no files, so no chown is needed.
RUN useradd --system --uid 10001 --no-create-home appuser
USER appuser
EXPOSE 8081
CMD ["quran-ai-realtime-gateway"]
