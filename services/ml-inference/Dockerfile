FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY services/ml-inference/ ./services/ml-inference/
RUN corepack enable && pnpm install --frozen-lockfile
# Run as a non-root user. The service writes recorded audio to AUDIO_STORAGE_DIR (compose mounts a
# named volume at /data/audio-storage; without compose it defaults to ./audio-storage under the
# service dir), so give the user ownership of both so writes succeed and the named volume inherits
# writable ownership on first init. node_modules stay root-owned but world-readable.
RUN useradd --system --uid 10001 --no-create-home appuser \
    && mkdir -p /data/audio-storage \
    && chown -R appuser /data/audio-storage /app/services/ml-inference
WORKDIR /app/services/ml-inference
USER appuser
EXPOSE 8090
CMD ["node", "server.mjs"]
