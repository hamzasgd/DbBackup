import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { createConnection } from './connection.controller';
import { setUserConnectionLimit } from './admin.controller';
import { prisma } from '../config/database';
import { DatabaseType } from '@prisma/client';

// createConnection encrypts fields via the lazy KeyManager singleton; give it
// a key before any test triggers encrypt() (CI sets none).
process.env.ENCRYPTION_KEY_PRIMARY = process.env.ENCRYPTION_KEY_PRIMARY ?? '3'.repeat(64);

/** Integration tests for the per-user connection limit (real test Postgres). */
describe('connection limit', () => {
  let user: { id: string; email: string };

  function mkReq(user: { userId: string; email: string; role: 'USER' | 'ADMIN' }, extra: Record<string, unknown> = {}) {
    return { user, ip: '127.0.0.1', headers: {}, originalUrl: '/api/test', ...extra } as unknown as AuthRequest;
  }
  function mkRes() {
    const res = { json: vi.fn(), status: vi.fn() } as unknown as Response & { status: ReturnType<typeof vi.fn> };
    (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
    return res;
  }

  beforeEach(async () => {
    user = await prisma.user.create({
      data: {
        email: `connlimit-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        name: 'Conn Limit User',
        passwordHash: 'hashed',
      },
    });
  });

  afterEach(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});
  });

  async function addConn() {
    return prisma.connection.create({
      data: {
        userId: user.id, name: `C-${Math.random().toString(36).slice(2, 6)}`, type: DatabaseType.MYSQL,
        host: 'localhost', port: 3306, database: 'db', username: 'u', password: 'p',
      },
    });
  }

  it('defaults new users to a limit of 5', async () => {
    const u = await prisma.user.findUnique({ where: { id: user.id }, select: { connectionLimit: true } });
    expect(u?.connectionLimit).toBe(5);
  });

  it('createConnection succeeds under the limit and 403s at it', async () => {
    for (let i = 0; i < 5; i++) await addConn();

    // 6th connection → 403
    const req = mkReq({ userId: user.id, email: user.email, role: 'USER' }, {
      body: { name: 'Sixth', type: 'MYSQL', host: 'localhost', port: '3306', username: 'u', password: 'p', database: 'db' },
    });
    const res = mkRes();
    const next = vi.fn() as NextFunction;
    await createConnection(req, res, next);
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as { message: string };
    expect(err.message).toContain('Connection limit reached (5 of 5)');

    // Raise the limit → the 6th goes through
    await prisma.user.update({ where: { id: user.id }, data: { connectionLimit: 6 } });
    const req2 = mkReq({ userId: user.id, email: user.email, role: 'USER' }, {
      body: { name: 'Sixth', type: 'MYSQL', host: 'localhost', port: '3306', username: 'u', password: 'p', database: 'db' },
    });
    const res2 = mkRes();
    await createConnection(req2, res2, vi.fn() as NextFunction);
    expect((res2.json as ReturnType<typeof vi.fn>).mock.calls[0][0].success).toBe(true);
  });

  it('null limit means unlimited', async () => {
    await prisma.user.update({ where: { id: user.id }, data: { connectionLimit: null } });
    for (let i = 0; i < 7; i++) await addConn();
    const req = mkReq({ userId: user.id, email: user.email, role: 'USER' }, {
      body: { name: 'Eighth', type: 'MYSQL', host: 'localhost', port: '3306', username: 'u', password: 'p', database: 'db' },
    });
    const res = mkRes();
    await createConnection(req, res, vi.fn() as NextFunction);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].success).toBe(true);
  });

  it('setUserConnectionLimit sets int, null, audits, and 400s invalid input', async () => {
    const req = mkReq({ userId: user.id, email: user.email, role: 'ADMIN' }, { params: { id: user.id }, body: { connectionLimit: 10 } });
    const res = mkRes();
    const next = vi.fn() as NextFunction;
    await setUserConnectionLimit(req, res, next);
    expect(next).not.toHaveBeenCalled();
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.data.connectionLimit).toBe(10);

    const req2 = mkReq({ userId: user.id, email: user.email, role: 'ADMIN' }, { params: { id: user.id }, body: { connectionLimit: null } });
    const res2 = mkRes();
    await setUserConnectionLimit(req2, res2, vi.fn() as NextFunction);
    const after = await prisma.user.findUnique({ where: { id: user.id }, select: { connectionLimit: true } });
    expect(after?.connectionLimit).toBeNull();
    const audit = await prisma.auditLog.count({ where: { action: 'ADMIN_SET_CONNECTION_LIMIT', userId: user.id } });
    expect(audit).toBe(2);

    for (const bad of [0, 2.5, 'x']) {
      const reqBad = mkReq({ userId: user.id, email: user.email, role: 'ADMIN' }, { params: { id: user.id }, body: { connectionLimit: bad } });
      const resBad = mkRes();
      const nextBad = vi.fn() as NextFunction;
      await setUserConnectionLimit(reqBad, resBad, nextBad);
      expect(nextBad).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    }
  });
});
