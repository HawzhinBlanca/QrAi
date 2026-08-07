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
LABEL org.opencontainers.image.title="Quran AI Node API" \
      org.opencontainers.image.description="Internal shadow API for the Flutter/Node consolidation" \
      org.opencontainers.image.source="https://github.com/hawzhin/QrAi"

# `/out` contains only declared production dependencies. Put them at the application root so the
# package-owned entrypoint resolves the server package's frozen dependency graph.
COPY --from=deploy --chown=node:node /out/node_modules ./node_modules
COPY --from=deploy --chown=node:node /out/package.json ./server/package.json
COPY --from=deploy --chown=node:node /out/src ./server/src
COPY --from=deploy --chown=node:node /out/scripts ./server/scripts
# The transitional ML proxy imports the shared validator, which binds its quran-aligner identity to
# these exact implementation/provenance bytes. Copy the three files, never either broad source tree.
COPY --chown=node:node services/ml-inference/model-attribution.mjs services/ml-inference/alignment.js ./services/ml-inference/
COPY --chown=node:node packages/quran-data/src/data/full-quran/provenance-v2.json ./packages/quran-data/src/data/full-quran/

USER node
EXPOSE 8082
HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD ["node", "server/src/container-healthcheck.mjs"]
CMD ["node", "server/src/main.mjs"]
