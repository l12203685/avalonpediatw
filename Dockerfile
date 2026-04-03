# Multi-stage build for Avalon Pedia
# Stage 1: Build
FROM node:20-alpine as builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@8

# Copy workspace config
COPY pnpm-workspace.yaml tsconfig.json turbo.json package.json ./

# Copy package manifests for all workspace members
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
# Web stub: needed for workspace resolution but deps skipped
RUN mkdir -p packages/web && echo '{"name":"@avalon/web","version":"0.0.1","private":true}' > packages/web/package.json

# Install server + shared dependencies only (no lockfile — web stub differs)
RUN pnpm install --no-frozen-lockfile

# Copy source code
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# Build shared first, then server
RUN pnpm --filter @avalon/shared build
RUN pnpm --filter @avalon/server build

# Stage 2: Runtime
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules

# Set environment
ENV NODE_ENV=production

# Health check — uses PORT env var (Render sets PORT=10000)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "const p=process.env.PORT||3001;require('http').get('http://localhost:'+p+'/health',(r)=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "packages/server/dist/index.js"]

EXPOSE 10000
