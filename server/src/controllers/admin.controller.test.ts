import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Response, NextFunction } from 'express';
import { AuthRequest, requireAdmin } from '../middleware/auth.middleware';
import { getPlatformStats, listUsers, getUserDetail, setUserStatus } from './admin.controller';
import { prisma } from '../config/database';
import { DatabaseType } from '@prisma/client';

/** Integration tests for the super-admin controller (real test Postgres). */
describe('AdminController', () => {
  let admin: { id: string; email: string };
  let target: { id: string; email: string };

  function mkReq(user: { userId: string; email: string; role: 'USER' | 'ADMIN' }, extra: Record<string, unknown> = {}) {
    return { user, ip: '127.0.0.1', headers: {}, originalUrl: '/api/admin/test', ...extra } as unknown as AuthRequest;
  }
  function mkRes() {
    return { json: vi.fn() } as unknown as Response;
  }

  beforeEach(async () => {
    admin = await prisma.user.create({
      data: {
        email: `admin-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        name: 'Admin',
        passwordHash: 'hashed',
        role: 'ADMIN',
      },
    });
    target = await prisma.user.create({
      data: {
        email: `target-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        name: 'Target',
        passwordHash: 'hashed',
        role: 'USER',
      },
    });
  });

  afterEach(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});
  });

  describe('requireAdmin', () => {
    it('rejects a USER with 403', async () => {
      const req = mkReq({ userId: target.id, email: target.email, role: 'USER' });
      const res = mkRes();
      const next = vi.fn() as NextFunction;
      await requireAdmin(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as { message: string; statusCode: number };
      expect(err.message).toContain('admin access required');
      expect(err.statusCode).toBe(403);
    });

    it('lets an ADMIN through', async () => {
      const req = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' });
      const res = mkRes();
      const next = vi.fn() as NextFunction;
      await requireAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('getPlatformStats', () => {
    it('aggregates platform-wide counts', async () => {
      const conn = await prisma.connection.create({
        data: {
          userId: target.id, name: 'C1', type: DatabaseType.MYSQL,
          host: 'localhost', port: 3306, database: 'db1', username: 'u', password: 'p',
        },
      });
      await prisma.backup.createMany({
        data: [
          { userId: target.id, connectionId: conn.id, fileName: 'a.gz', filePath: '/tmp/a.gz', fileSize: BigInt(1024), dbType: DatabaseType.MYSQL, dbName: 'db1', status: 'COMPLETED', format: 'COMPRESSED_SQL', storageType: 'LOCAL' },
          { userId: target.id, connectionId: conn.id, fileName: 'b.gz', filePath: '/tmp/b.gz', fileSize: BigInt(512), dbType: DatabaseType.MYSQL, dbName: 'db1', status: 'COMPLETED', format: 'COMPRESSED_SQL', storageType: 'LOCAL' },
          { userId: target.id, connectionId: conn.id, fileName: 'c.gz', filePath: '/tmp/c.gz', fileSize: BigInt(4096), dbType: DatabaseType.MYSQL, dbName: 'db1', status: 'FAILED', format: 'COMPRESSED_SQL', storageType: 'LOCAL' },
        ],
      });
      const req = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' });
      const res = mkRes();
      const next = vi.fn() as NextFunction;
      await getPlatformStats(req, res, next);
      expect(next).not.toHaveBeenCalled();
      const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload.data.users.total).toBe(2);
      expect(payload.data.users.active).toBe(2);
      expect(payload.data.connections.total).toBe(1);
      expect(payload.data.backups.byStatus.COMPLETED).toBe(2);
      expect(payload.data.backups.byStatus.FAILED).toBe(1);
      expect(BigInt(payload.data.storageBytes)).toBe(BigInt(1536));
      expect(payload.data.backups.failedLast7d).toBe(1);
      expect(payload.data.mcpKeys.total).toBe(0);
    });
  });

  describe('listUsers', () => {
    it('paginates, searches and counts per-user aggregates', async () => {
      const conn = await prisma.connection.create({
        data: {
          userId: target.id, name: 'C1', type: DatabaseType.MYSQL,
          host: 'localhost', port: 3306, database: 'db1', username: 'u', password: 'p',
        },
      });
      await prisma.backup.create({
        data: { userId: target.id, connectionId: conn.id, fileName: 'a.gz', filePath: '/tmp/x.gz', fileSize: BigInt(100), dbType: DatabaseType.MYSQL, dbName: 'db1', status: 'COMPLETED', format: 'COMPRESSED_SQL' },
      });
      const req = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' }, { query: { page: '1', limit: '10' } });
      const res = mkRes();
      const next = vi.fn() as NextFunction;
      await listUsers(req, res, next);
      expect(next).not.toHaveBeenCalled();
      const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload.data.total).toBe(2);
      const t = payload.data.users.find((u: { id: string }) => u.id === target.id);
      expect(t.connections).toBe(1);
      expect(t.backups).toBe(1);
      expect(t.lastBackupAt).toBeTruthy();
    });

    it('filters by search and suspended status', async () => {
      await prisma.user.update({ where: { id: target.id }, data: { isActive: false } });
      const req = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' }, { query: { status: 'suspended', search: target.email.slice(0, 8) } });
      const res = mkRes();
      const next = vi.fn() as NextFunction;
      await listUsers(req, res, next);
      const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload.data.total).toBe(1);
      expect(payload.data.users[0].id).toBe(target.id);
    });
  });

  describe('getUserDetail', () => {
    it('returns masked support view and never exposes secrets or paths', async () => {
      const conn = await prisma.connection.create({
        data: {
          userId: target.id, name: 'C1', type: DatabaseType.MYSQL,
          host: 'localhost', port: 3306, database: 'db1', username: 'u', password: 'p',
        },
      });
      await prisma.backup.create({
        data: { userId: target.id, connectionId: conn.id, fileName: 'a.gz', filePath: '/srv/secret/a.gz', storageKey: 'bucket/a.gz', fileSize: BigInt(100), dbType: DatabaseType.MYSQL, dbName: 'db1', status: 'COMPLETED', format: 'COMPRESSED_SQL' },
      });
      const req = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' }, { params: { id: target.id } });
      const res = mkRes();
      const next = vi.fn() as NextFunction;
      await getUserDetail(req, res, next);
      expect(next).not.toHaveBeenCalled();
      const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload.data.user.id).toBe(target.id);
      expect(payload.data.connections).toHaveLength(1);
      expect(payload.data.connections[0]).not.toHaveProperty('password');
      expect(payload.data.connections[0]).not.toHaveProperty('sshPrivateKey');
      expect(payload.data.backups).toHaveLength(1);
      expect(payload.data.backups[0]).not.toHaveProperty('filePath');
      expect(payload.data.backups[0]).not.toHaveProperty('storageKey');
      const audit = await prisma.auditLog.count({ where: { action: 'ADMIN_VIEW_USER', userId: admin.id } });
      expect(audit).toBe(1);
    });

    it('allows self-view (single-user installs) and 404s unknown users', async () => {
      const reqSelf = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' }, { params: { id: admin.id } });
      const resSelf = mkRes();
      const nextSelf = vi.fn() as NextFunction;
      await getUserDetail(reqSelf, resSelf, nextSelf);
      expect(nextSelf).not.toHaveBeenCalled();
      const selfPayload = (resSelf.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(selfPayload.success).toBe(true);
      expect(selfPayload.data.user.id).toBe(admin.id);

      const reqMissing = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' }, { params: { id: 'no-such-user' } });
      const resMissing = mkRes();
      const nextMissing = vi.fn() as NextFunction;
      await getUserDetail(reqMissing, resMissing, nextMissing);
      expect(nextMissing).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('setUserStatus', () => {
    it('suspends (isActive=false + tokenVersion bump) and reacts cleanly', async () => {
      const before = await prisma.user.findUnique({ where: { id: target.id }, select: { tokenVersion: true } });
      const req = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' }, { params: { id: target.id }, body: { isActive: false } });
      const res = mkRes();
      const next = vi.fn() as NextFunction;
      await setUserStatus(req, res, next);
      expect(next).not.toHaveBeenCalled();
      const after = await prisma.user.findUnique({ where: { id: target.id }, select: { isActive: true, tokenVersion: true } });
      expect(after?.isActive).toBe(false);
      expect(after!.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);
      const audit = await prisma.auditLog.count({ where: { action: 'ADMIN_SUSPEND', userId: admin.id } });
      expect(audit).toBe(1);

      const req2 = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' }, { params: { id: target.id }, body: { isActive: true } });
      const res2 = mkRes();
      await setUserStatus(req2, res2, vi.fn() as NextFunction);
      const revived = await prisma.user.findUnique({ where: { id: target.id }, select: { isActive: true } });
      expect(revived?.isActive).toBe(true);
    });

    it('rejects self-suspension and no-ops an unchanged status', async () => {
      const req = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' }, { params: { id: admin.id }, body: { isActive: false } });
      const res = mkRes();
      const next = vi.fn() as NextFunction;
      await setUserStatus(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));

      const req2 = mkReq({ userId: admin.id, email: admin.email, role: 'ADMIN' }, { params: { id: target.id }, body: { isActive: true } });
      const res2 = mkRes();
      await setUserStatus(req2, res2, vi.fn() as NextFunction);
      const payload = (res2.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload.data.unchanged).toBe(true);
    });
  });
});
