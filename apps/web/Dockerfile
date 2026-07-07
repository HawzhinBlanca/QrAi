FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/web/ ./apps/web/
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @quran-ai/web build

# nginxinc/nginx-unprivileged runs as non-root (UID 101) by default — no USER directive needed,
# unlike the four backend services which need an explicit `useradd`/`USER appuser` (uid 10001)
# because their base images run as root by default. It listens on 8080 (not 80) because
# unprivileged processes can't bind to ports < 1024.
FROM nginxinc/nginx-unprivileged:alpine
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
