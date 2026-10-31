# ─── Build stage: compile client + server ──────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy workspace root (package.json + yarn workspaces)
COPY package.json yarn.lock ./
COPY server/package.json server/
COPY client/package.json client/

RUN yarn install --frozen-lockfile

# Copy source
COPY server/ server/
COPY client/ client/

# Build
RUN yarn workspace dbbackup-server run build && yarn workspace client run build

# Generate Prisma client
RUN cd server && npx prisma generate

# ─── Runtime stage: slim image ─────────────────────────────────────────────
FROM node:22-alpine

# CLI tools for backup engines
RUN apk add --no-cache mysql-client postgresql17-client mongodb-tools redis

WORKDIR /app

# Copy workspace root for module resolution
COPY --from=build /app/package.json /app/yarn.lock ./
COPY --from=build /app/server/package.json server/

# Install production dependencies only
RUN yarn install --production --frozen-lockfile

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
