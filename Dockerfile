# ─── Build stage: compile client + server ──────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy workspace root (package.json + npm workspaces lockfile)
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

RUN npm ci

# Copy source
COPY server/ server/
COPY client/ client/

# Build (server build runs `prisma generate` first)
RUN npm run build -w dbbackup-server && npm run build -w client

# ─── Runtime stage: slim image ─────────────────────────────────────────────
FROM node:22-alpine

# CLI tools for backup engines
RUN apk add --no-cache mysql-client postgresql17-client mongodb-tools redis

WORKDIR /app

# Copy workspace manifests for module resolution
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/client/package.json client/

# Install production dependencies of the server workspace only
RUN npm ci --omit=dev -w dbbackup-server && npm cache clean --force

# Copy built artifacts
COPY --from=build /app/server/dist server/dist/
COPY --from=build /app/server/prisma server/prisma/
COPY --from=build /app/client/dist client/dist/
COPY --from=build /app/node_modules/.prisma node_modules/.prisma/

# Non-root user
RUN addgroup -S dbbackup && adduser -S dbbackup -G dbbackup \
    && mkdir -p /app/backups && chown -R dbbackup:dbbackup /app
USER dbbackup

EXPOSE 3001

ENV NODE_ENV=production

# Run migrations then start
CMD ["sh", "-c", "cd server && npx prisma migrate deploy && node dist/index.js"]
