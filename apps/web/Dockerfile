FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/web/ ./apps/web/
RUN corepack enable && pnpm install --frozen-lockfile

# Vite inlines VITE_* at BUILD time, so these must be build args — not runtime container env. They
# were previously declared under `environment:` in docker-compose.yml, which is runtime env on an
# nginx container serving a pre-built bundle: completely inert. The bundle silently fell back to the
# code defaults instead ("" -> relative /v1/ through the nginx proxy, and ws://127.0.0.1:8081 for
# the gateway), so the declared values were decorative. Empty defaults here preserve exactly that
# effective behaviour; docker-compose.tls.yml overrides them to bake wss:// for the TLS stack
# (ws:// from an https page is blocked as mixed content).
ARG VITE_PLATFORM_API_URL=""
ARG VITE_REALTIME_GATEWAY_URL=""
ENV VITE_PLATFORM_API_URL=$VITE_PLATFORM_API_URL
ENV VITE_REALTIME_GATEWAY_URL=$VITE_REALTIME_GATEWAY_URL
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
