# Multi-stage build for Avalon Pedia
# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@8

# Copy workspace config and lockfile first (better layer caching)
COPY pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json turbo.json package.json ./

# Copy only package.json files first for dependency caching
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/server/package.json packages/server/tsconfig.json ./packages/server/
# Web package.json needed for pnpm workspace resolution
COPY packages/web/package.json ./packages/web/

# Install dependencies (cached unless package.json/lockfile changes)
RUN pnpm install --frozen-lockfile

# Copy source files
COPY packages/shared/src ./packages/shared/src
COPY packages/server/src ./packages/server/src

# Build shared first, then server
RUN pnpm --filter @avalon/shared build
RUN NODE_OPTIONS="--max-old-space-size=384" pnpm --filter @avalon/server build

# Stage 2: Runtime (minimal)
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "const p=process.env.PORT||3001;require('http').get('http://localhost:'+p+'/health',(r)=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "packages/server/dist/index.js"]

EXPOSE 10000
