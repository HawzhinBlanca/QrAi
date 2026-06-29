FROM rust:1.96-bookworm AS builder
WORKDIR /app
COPY services/platform-api/Cargo.toml services/platform-api/Cargo.lock* ./
COPY packages/contracts ./packages/contracts/
COPY packages/quran-data ./packages/quran-data/
COPY services/platform-api/src ./src
COPY services/platform-api/tests ./tests
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y curl libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/quran-ai-platform-api /usr/local/bin/
EXPOSE 8080
CMD ["quran-ai-platform-api"]
