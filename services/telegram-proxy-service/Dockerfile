# ============================================================================
# Telegram Proxy Service Dockerfile
# 
# This Dockerfile implements a multi-stage build for the Telegram Proxy Service:
# 1. Build stage: Compiles TypeScript code
# 2. Production stage: Creates minimal production image
# ============================================================================

# ============================================================================
# Stage 1: Build Stage
# ============================================================================
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy package files for dependency installation
COPY package.json ./
COPY pnpm-lock.yaml ./

# Install all dependencies (including dev dependencies)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript code
RUN pnpm build

# Prune development dependencies
RUN pnpm prune --prod

# ============================================================================
# Stage 2: Production Stage
# ============================================================================
FROM node:18-alpine AS production

# Set environment variables
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=2048"

# Create app directory and set permissions
WORKDIR /app

# Create a non-root user and group
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Install pnpm globally
RUN npm install -g pnpm

# Copy package files and built code from builder stage
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Copy .env.example for reference (but don't use it directly)
COPY .env.example ./

# Set ownership to non-root user
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose the API server port
EXPOSE 3000

# Configure health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Set the entry point
CMD ["node", "dist/index.js"]