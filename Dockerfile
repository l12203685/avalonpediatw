# Multi-stage build for Avalon Pedia
# Stage 1: Build
FROM node:20-alpine as builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@8

# Copy workspace files
COPY pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json turbo.json ./

# Copy package files
COPY packages ./packages

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build all packages
RUN pnpm build

# Stage 2: Runtime
FROM node:20-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@8

# Install dumb-init
RUN apk add --no-cache dumb-init

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/pnpm-workspace.yaml ./

# Set environment
ENV NODE_ENV=production
ENV PORT=3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["/sbin/dumb-init", "--"]

# Start server
CMD ["pnpm", "-F", "server", "start"]

EXPOSE 3001
