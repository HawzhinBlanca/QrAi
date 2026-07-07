FROM rust:1.96-bookworm AS builder
WORKDIR /app
# The crate has a path dependency `quran-ai-shared-ticket = { path = "../shared-ticket" }`; from the
# /app workdir that resolves to /shared-ticket, so the crate must be copied there or cargo build fails.
COPY services/shared-ticket /shared-ticket
# packages/contracts and packages/quran-data (TypeScript) are NOT copied here — Cargo.toml has no
# path dependency on either, and nothing under src/ or tests/ reads them (confirmed: only a doc
# comment cross-references packages/contracts by name, no include_str!/file read). Copying them
# used to bust this build stage's Docker layer cache on every unrelated TS-only change, forcing a
# full `cargo build --release` re-run for no reason.
COPY services/platform-api/Cargo.toml services/platform-api/Cargo.lock* ./
COPY services/platform-api/src ./src
COPY services/platform-api/tests ./tests
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y curl libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/quran-ai-platform-api /usr/local/bin/
# Run as a non-root user (defense-in-depth). The binary reads env + talks to Postgres/ML over the
# network and writes no files, so no chown is needed.
RUN useradd --system --uid 10001 --no-create-home appuser
USER appuser
EXPOSE 8080
CMD ["quran-ai-platform-api"]
