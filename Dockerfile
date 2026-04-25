# Avalon Pedia server — unified production Dockerfile
# Context: monorepo root. Supports any container host that injects PORT env
# (Back4App, Fly.io, Railway, Cloud Run, etc.) without EXPOSE hard-coding.
#
# 設計：
#  - multi-stage build（shrink runtime image，低記憶體容器也 OK）
#  - Web stub 避免 monorepo web deps 被拉進來（packages/web 由 Cloudflare Pages 託管）
#  - 不 EXPOSE 硬值：host 用 $PORT env 決定（src/index.ts 已讀 env）
#  - pnpm install --prod + store prune：runtime 只帶 production deps
#  - Node 20-alpine
#
# 歷史：此檔原名 Dockerfile.back4app（Back4App 遷移時建立）；Render 舊 Dockerfile
# 因 EXPOSE 10000 硬寫導致 Back4App healthcheck 錯開，2026-04-21 晉升此檔為主
# Dockerfile，同時刪除 Dockerfile.back4app 避免雙檔維護分歧。

# ── Stage 1: Builder ──────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
RUN npm install -g pnpm@8

# Workspace manifests only（利用 docker layer cache）
COPY pnpm-workspace.yaml tsconfig.json turbo.json package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json

# Web stub（packages/web 不進此 image，由 CF Pages 獨立構建）
RUN mkdir -p packages/web && \
    echo '{"name":"@avalon/web","version":"0.0.1","private":true}' > packages/web/package.json

# Install 含 dev deps（build 需要 typescript/tsc）
RUN pnpm install --no-frozen-lockfile

# Source code（web 仍然不進來）
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# Build shared → server（順序重要，server 依賴 shared dist）
RUN pnpm --filter @avalon/shared build
RUN pnpm --filter @avalon/server build

# ── Stage 2: Production runtime ────────────────────────────────
FROM node:20-alpine

WORKDIR /app
RUN npm install -g pnpm@8

# 只帶必要產物到 runtime
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/dist ./packages/server/dist
# AI 牌譜分析用的預生成 cache（server runtime 需要）
COPY --from=builder /app/packages/server/analysis_cache.json ./packages/server/analysis_cache.json
# Web stub（workspace resolution 需要，但不裝 deps）
RUN mkdir -p packages/web && \
    echo '{"name":"@avalon/web","version":"0.0.1","private":true}' > packages/web/package.json

# 只裝 production deps，降低 runtime 記憶體 / image size
ENV NODE_ENV=production
RUN pnpm install --prod --no-frozen-lockfile && \
    pnpm store prune && \
    rm -rf /root/.npm /root/.pnpm-store

# Healthcheck：讀 $PORT env（host 注入）打 /health
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "const p=process.env.PORT||3001;require('http').get('http://localhost:'+p+'/health',(r)=>{process.exit(r.statusCode===200?0:1)})"

# 不 EXPOSE 硬值——runtime 由 $PORT env 決定
# （src/index.ts 第 72 行：`const PORT = process.env.PORT || 3001`）

CMD ["node", "packages/server/dist/index.js"]
