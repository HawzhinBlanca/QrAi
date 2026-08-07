FROM node:22.13.1-bookworm-slim

RUN npm install --global pnpm@11.7.0 \
    && groupadd --system --gid 10001 appuser \
    && useradd --system --uid 10001 --gid 10001 --no-create-home appuser

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts --filter quran-ai-platform

COPY server/scripts/ ./server/scripts/
COPY infra/migrations/ ./infra/migrations/
COPY infra/provision/ ./infra/provision/

USER 10001
CMD ["node", "server/scripts/migrate.mjs"]
