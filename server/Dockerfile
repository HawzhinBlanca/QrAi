# syntax=docker/dockerfile:1.7

# Node 22.13.1 is the repository's tested runtime floor. The OCI index digest locks every supported
# architecture to the reviewed 2025-02-04 official-image publication instead of trusting a mutable
# tag during a release build.
ARG NODE_IMAGE=node:22.13.1-bookworm-slim@sha256:83fdfa2a4de32d7f8d79829ea259bd6a4821f8b2d123204ac467fbe3966450fc

FROM ${NODE_IMAGE} AS deploy
WORKDIR /workspace
# The Corepack bundled with this 2025 Node image predates npm's rotated pnpm signing key. Refresh
# only the disposable builder's verifier to the newest Node-22.13-compatible pinned release; runtime
# receives none of it.
RUN npm install --global corepack@0.34.5 \
    && corepack enable \
    && corepack prepare pnpm@11.7.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/ ./server/
# Deploy only the server's frozen production graph. `--legacy` selects pnpm's isolated deploy
# implementation because this workspace intentionally does not inject sibling workspace packages.
RUN pnpm --filter @quran-ai/server deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
LABEL org.opencontainers.image.title="Quran AI Node Backend" \
      org.opencontainers.image.description="Node API, realtime, and inference worker roles for the Flutter/Node consolidation" \
      org.opencontainers.image.source="https://github.com/hawzhin/QrAi"

# `/out` contains only declared production dependencies. Put them at the application root so the
# package-owned entrypoint resolves the server package's frozen dependency graph.
COPY --from=deploy --chown=node:node /out/node_modules ./node_modules
COPY --from=deploy --chown=node:node /out/package.json ./server/package.json
COPY --from=deploy --chown=node:node /out/src ./server/src
COPY --from=deploy --chown=node:node /out/scripts ./server/scripts
# Canary compatibility mode derives its exact retained operation set from this reviewed contract;
# it is never a copied environment-variable list.
COPY --chown=node:node packages/contracts/route-manifest.json ./packages/contracts/route-manifest.json
# The server-owned inference validator binds its quran-aligner identity to this exact provenance.
COPY --chown=node:node packages/quran-data/src/data/full-quran/provenance-v2.json ./packages/quran-data/src/data/full-quran/
# The worker and Python ASR service validate the same immutable acoustic candidate declaration.
COPY --chown=node:node services/asr-inference/acoustic-candidates.json ./services/asr-inference/acoustic-candidates.json
RUN mkdir -p /data/audio-storage && chown node:node /data/audio-storage

USER node
EXPOSE 8081 8082 8098
HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD ["node", "server/src/container-healthcheck.mjs"]
STOPSIGNAL SIGTERM
CMD ["node", "server/src/main.mjs"]
