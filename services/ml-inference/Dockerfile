FROM node:22-bookworm-slim
WORKDIR /app
# No `pnpm install` — server.mjs/alignment.js/tajweed.js have zero external npm imports (only
# node: builtins and relative local files); the sole reason packages/ is copied is that server.mjs
# reads packages/quran-data/src/data/full-quran/*.json directly via fs.readFileSync, not as an
# installed package. Installing here used to run `pnpm install` at the workspace root with no
# --filter, pulling in every OTHER package's full dependency tree (apps/web's React/Vite/vitest,
# TypeScript, etc.) into an image that needs none of it — pure build-time cost and image bloat.
COPY packages/ ./packages/
COPY services/ml-inference/ ./services/ml-inference/
# Run as a non-root user. The service writes recorded audio to AUDIO_STORAGE_DIR (compose mounts a
# named volume at /data/audio-storage; without compose it defaults to ./audio-storage under the
# service dir), so give the user ownership of both so writes succeed and the named volume inherits
# writable ownership on first init.
RUN useradd --system --uid 10001 --no-create-home appuser \
    && mkdir -p /data/audio-storage \
    && chown -R appuser /data/audio-storage /app/services/ml-inference
WORKDIR /app/services/ml-inference
USER appuser
EXPOSE 8090
CMD ["node", "server.mjs"]
