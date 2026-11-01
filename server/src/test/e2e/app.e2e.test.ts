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
 * The real Express app against a real app database and Redis: the full auth
 * lifecycle with the refresh token in an httpOnly cookie, the CSRF header
 * requirement, access-token invalidation via tokenVersion, and /health.
 */
describe.skipIf(!APP_DB || !process.env.REDIS_HOST)('app: auth cookies, CSRF, tokenVersion, /health', () => {
  let server: http.Server;
  let base = '';
  const email = `e2e-${randomUUID()}@example.com`;
  const password = 'correct horse battery staple';
  const CSRF = { 'x-dbbk-csrf': '1' };

  interface CallResult { status: number; json: any; cookies: string[]; }
  const call = async (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; cookie?: string } = {}): Promise<CallResult> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    if (opts.cookie) headers['cookie'] = opts.cookie;
    const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, cookies: res.headers.getSetCookie?.() ?? [] };
  };
  /** Extract the dbbk_refresh cookie value from Set-Cookie headers. */
  const refreshCookie = (cookies: string[]): string | null => {
    for (const c of cookies) {
      const m = /^dbbk_refresh=([^;]*)/.exec(c);
      if (m) return m[1] || null; // empty value = cleared
    }
    return null;
  };
  const cookieHeader = (value: string) => `dbbk_refresh=${value}`;
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
    await prisma.user.create({
      data: { id: randomUUID(), name: 'E2E', email, passwordHash: await bcrypt.hash(password, 4), termsAcceptedAt: new Date() },
    });
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

  it('login returns the refresh token only as an httpOnly, SameSite=Strict cookie (never in the body), stored hashed', async () => {
    const login = await call('POST', '/api/auth/login', { body: { email, password } });
    expect(login.status).toBe(200);
    expect(login.json.data.accessToken).toBeTruthy();
    expect(login.json.data.refreshToken).toBeUndefined(); // not in the JSON body

    const setCookie = login.cookies.find((c) => c.startsWith('dbbk_refresh='));
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/auth/i);

    const raw = refreshCookie(login.cookies)!;
    const rows = await tokenRows();
    expect(rows.some((r) => r.token === hashRefreshToken(raw))).toBe(true); // stored as a hash
    for (const r of rows) expect(r.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refresh requires the CSRF header and the cookie, rotates single-use, logout clears it', async () => {
    const login = await call('POST', '/api/auth/login', { body: { email, password } });
    const first = refreshCookie(login.cookies)!;

    // Missing CSRF header → 403 (blocks cross-site cookie use)
    expect((await call('POST', '/api/auth/refresh', { cookie: cookieHeader(first) })).status).toBe(403);

    // With header + cookie → 200, new access token, rotated cookie
    const refreshed = await call('POST', '/api/auth/refresh', { headers: CSRF, cookie: cookieHeader(first) });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.data.accessToken).toBeTruthy();
    const second = refreshCookie(refreshed.cookies)!;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // Old cookie is single-use → 401, and the response clears the cookie
    const reuse = await call('POST', '/api/auth/refresh', { headers: CSRF, cookie: cookieHeader(first) });
    expect(reuse.status).toBe(401);
    expect(reuse.cookies.find((c) => c.startsWith('dbbk_refresh='))).toMatch(/dbbk_refresh=;|Expires=Thu, 01 Jan 1970/i);

    // Logout revokes the current cookie
    expect((await call('POST', '/api/auth/logout', { headers: CSRF, cookie: cookieHeader(second) })).status).toBe(200);
    expect((await call('POST', '/api/auth/refresh', { headers: CSRF, cookie: cookieHeader(second) })).status).toBe(401);
  });

  it('access tokens are rejected after "revoke all sessions" (tokenVersion bump)', async () => {
    const login = await call('POST', '/api/auth/login', { body: { email, password } });
    const access: string = login.json.data.accessToken;
    const auth = { authorization: `Bearer ${access}` };

    expect((await call('GET', '/api/auth/me', { headers: auth })).status).toBe(200);

    // Revoke all sessions (bumps tokenVersion)
    expect((await call('DELETE', '/api/auth/sessions', { headers: auth })).status).toBe(200);

    // The same access token is now stale
    const me = await call('GET', '/api/auth/me', { headers: auth });
    expect(me.status).toBe(401);
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

    // The body fallback still accepts a (now-hashed) token for pre-cookie clients, with the CSRF header
    const refreshed = await call('POST', '/api/auth/refresh', { headers: CSRF, body: { refreshToken: legacy } });
    expect(refreshed.status).toBe(200);
  });
});
