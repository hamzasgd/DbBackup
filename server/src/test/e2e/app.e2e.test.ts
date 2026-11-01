import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database';
import { connectRedis, disconnectRedis } from '../../config/redis';
import { initCrypto } from '../../services/crypto.service';
import { generateRefreshToken, hashRefreshToken, upgradeLegacyRefreshTokens } from '../../services/token.service';
import { markWorkersStarted } from '../../services/health.service';
import { APP_DB } from './helpers';

/**
 * The real Express app against a real app database and Redis: login, token
 * refresh and logout with hashed refresh tokens, and the /health endpoint.
 */
describe.skipIf(!APP_DB || !process.env.REDIS_HOST)('app: refresh tokens and /health', () => {
  let server: http.Server;
  let base = '';
  const email = `e2e-${randomUUID()}@example.com`;
  const password = 'correct horse battery staple';

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const tokenRows = async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return prisma.refreshToken.findMany({ where: { userId: user.id } });
  };

  beforeAll(async () => {
    await initCrypto();
    await connectRedis();
    const { default: app } = await import('../../app');
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await new Promise((resolve) => server?.close(resolve));
    await disconnectRedis();
    await prisma.$disconnect();
  });

  it('/health is 503 until the queue workers have started, then 200 with every check passing', async () => {
    const before = await call('GET', '/health');
    expect(before.status).toBe(503);
    expect(before.json.checks.database.ok).toBe(true);
    expect(before.json.checks.redis.ok).toBe(true);
    expect(before.json.checks.workers.ok).toBe(false);

    markWorkersStarted();
    const after = await call('GET', '/health');
    expect(after.status).toBe(200);
    expect(after.json.status).toBe('ok');
  });

  it('login stores only a SHA-256 hash of the refresh token', async () => {
    // Created directly: registration is closed once any user exists in the database
    await prisma.user.create({
      data: { id: randomUUID(), name: 'E2E', email, passwordHash: await bcrypt.hash(password, 4), termsAcceptedAt: new Date() },
    });
    const login = await call('POST', '/api/auth/login', { email, password });
    expect(login.status).toBe(200);
    const token: string = login.json.data.refreshToken;

    // A second login in the same second must not collide with the first token
    const again = await call('POST', '/api/auth/login', { email, password });
    expect(again.status).toBe(200);

    const rows = await tokenRows();
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.token).toMatch(/^[0-9a-f]{64}$/); // a hash, never the JWT
    expect(rows.map((r) => r.token)).toContain(hashRefreshToken(token));
  });

  it('refresh rotates the token; the old one stops working; logout revokes the new one', async () => {
    const login = await call('POST', '/api/auth/login', { email, password });
    const first: string = login.json.data.refreshToken;

    const refreshed = await call('POST', '/api/auth/refresh', { refreshToken: first });
    expect(refreshed.status).toBe(200);
    const second: string = refreshed.json.data.refreshToken;
    expect(second).not.toBe(first);

    expect((await call('POST', '/api/auth/refresh', { refreshToken: first })).status).toBe(401);

    expect((await call('POST', '/api/auth/logout', { refreshToken: second })).status).toBe(200);
    expect((await call('POST', '/api/auth/refresh', { refreshToken: second })).status).toBe(401);
  });

  it('a token stored in plain text by an older version is hashed at startup and keeps working', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const legacy = generateRefreshToken({ userId: user.id, email });
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.create({ data: { id: randomUUID(), token: legacy, userId: user.id, expiresAt } });

    expect(await upgradeLegacyRefreshTokens()).toBeGreaterThanOrEqual(1);
    const stored = await prisma.refreshToken.findFirst({ where: { token: hashRefreshToken(legacy) } });
    expect(stored).not.toBeNull();
    expect(await prisma.refreshToken.count({ where: { token: legacy } })).toBe(0);
    expect(await upgradeLegacyRefreshTokens()).toBe(0); // idempotent

    const refreshed = await call('POST', '/api/auth/refresh', { refreshToken: legacy });
    expect(refreshed.status).toBe(200);
  });
});
