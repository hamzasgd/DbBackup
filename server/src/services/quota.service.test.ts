import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { getQuotaUsage, assertQuotaAllowsFile } from './quota.service';
import { triggerBackup } from '../controllers/backup.controller';
import { setUserQuota } from '../controllers/admin.controller';
import { prisma } from '../config/database';
import { DatabaseType } from '@prisma/client';

/** Integration tests for the per-user storage quota (real test Postgres). */
describe('storage quota', () => {
  let user: { id: string; email: string };

  function mkReq(user: { userId: string; email: string; role: 'USER' | 'ADMIN' }, extra: Record<string, unknown> = {}) {
    return { user, ip: '127.0.0.1', headers: {}, originalUrl: '/api/admin/test', ...extra } as unknown as AuthRequest;
  }
  function mkRes() {
    return { json: vi.fn() } as unknown as Response;
  }

  beforeEach(async () => {
    user = await prisma.user.create({
      data: {
        email: `quota-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        name: 'Quota User',
        passwordHash: 'hashed',
      },
    });
  });

  afterEach(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});
  });

  async function addBackup(fileSize: bigint, status: 'COMPLETED' | 'FAILED' = 'COMPLETED') {
    const conn = await prisma.connection.create({
      data: {
        userId: user.id, name: 'C', type: DatabaseType.MYSQL,
        host: 'localhost', port: 3306, database: 'db', username: 'u', password: 'p',
      },
    });
    return prisma.backup.create({
      data: { userId: user.id, connectionId: conn.id, fileName: 'f.gz', filePath: '/tmp/f.gz', fileSize, dbType: DatabaseType.MYSQL, dbName: 'db', status, format: 'COMPRESSED_SQL' },
    });
  }

  it('defaults new users to 1 GB quota', async () => {
    const u = await getQuotaUsage(user.id);
    expect(u.quotaBytes).toBe(BigInt(1073741824));
    expect(u.usedBytes).toBe(BigInt(0));
    expect(u.percent).toBe(0);
  });

  it('sums COMPLETED backups only, all providers', async () => {
    await addBackup(BigInt(400));
    await addBackup(BigInt(250));
    await addBackup(BigInt(999), 'FAILED');
    const u = await getQuotaUsage(user.id);
    expect(u.usedBytes).toBe(BigInt(650));
    expect(u.percent).toBe(Math.round((650 / 1073741824) * 100));
  });

  it('allows a file under quota and blocks one that would exceed it', async () => {
    await prisma.user.update({ where: { id: user.id }, data: { storageQuotaBytes: BigInt(1000) } });
    await addBackup(BigInt(500));
    expect((await assertQuotaAllowsFile(user.id, BigInt(400))).ok).toBe(true);
    const over = await assertQuotaAllowsFile(user.id, BigInt(600));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain('Storage quota exceeded');
  });

  it('null quota means unlimited', async () => {
    await prisma.user.update({ where: { id: user.id }, data: { storageQuotaBytes: null } });
    await addBackup(BigInt(5000));
    expect((await assertQuotaAllowsFile(user.id, BigInt(999999))).ok).toBe(true);
    const u = await getQuotaUsage(user.id);
    expect(u.quotaBytes).toBeNull();
    expect(u.percent).toBeNull();
  });

  it('triggerBackup rejects with 403 when already over quota', async () => {
    await prisma.user.update({ where: { id: user.id }, data: { storageQuotaBytes: BigInt(1000) } });
    await addBackup(BigInt(1000));
    const conn = await prisma.connection.create({
      data: {
        userId: user.id, name: 'C2', type: DatabaseType.MYSQL,
        host: 'localhost', port: 3306, database: 'db', username: 'u', password: 'p',
      },
    });
    const req = mkReq({ userId: user.id, email: user.email, role: 'USER' }, { body: { connectionId: conn.id } });
    const res = mkRes();
    const next = vi.fn() as NextFunction;
    await triggerBackup(req, res, next);
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('setUserQuota sets bytes, null for unlimited, and 400s invalid input', async () => {
    const req = mkReq({ userId: user.id, email: user.email, role: 'ADMIN' }, { params: { id: user.id }, body: { storageQuotaGb: 2 } });
    const res = mkRes();
    const next = vi.fn() as NextFunction;
    await setUserQuota(req, res, next);
    expect(next).not.toHaveBeenCalled();
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.data.storageQuotaBytes).toBe(2147483648);

    const req2 = mkReq({ userId: user.id, email: user.email, role: 'ADMIN' }, { params: { id: user.id }, body: { storageQuotaGb: null } });
    const res2 = mkRes();
    await setUserQuota(req2, res2, vi.fn() as NextFunction);
    const after = await prisma.user.findUnique({ where: { id: user.id }, select: { storageQuotaBytes: true } });
    expect(after?.storageQuotaBytes).toBeNull();
    const audit = await prisma.auditLog.count({ where: { action: 'ADMIN_SET_QUOTA', userId: user.id } });
    expect(audit).toBe(2);

    const req3 = mkReq({ userId: user.id, email: user.email, role: 'ADMIN' }, { params: { id: user.id }, body: { storageQuotaGb: 0 } });
    const res3 = mkRes();
    const next3 = vi.fn() as NextFunction;
    await setUserQuota(req3, res3, next3);
    expect(next3).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});
