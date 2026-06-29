FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY services/ml-inference/ ./services/ml-inference/
RUN corepack enable && pnpm install --frozen-lockfile
WORKDIR /app/services/ml-inference
EXPOSE 8090
CMD ["node", "server.mjs"]
