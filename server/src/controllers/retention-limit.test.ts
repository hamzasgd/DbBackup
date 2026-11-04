import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { createSchedule, updateSchedule } from './schedule.controller';
import { setUserRetentionLimit } from './admin.controller';
import { prisma } from '../config/database';
import { DatabaseType, ScheduleFrequency } from '@prisma/client';

/** Integration tests for the per-user max retention period (real test Postgres). */
describe('retention limit', () => {
  let user: { id: string; email: string };
  let connId: string;
  let scheduleId: string;

  function mkReq(user: { userId: string; email: string; role: 'USER' | 'ADMIN' }, extra: Record<string, unknown> = {}) {
    return { user, ip: '127.0.0.1', headers: {}, originalUrl: '/api/test', ...extra } as unknown as AuthRequest;
  }
  function mkRes() {
    return { json: vi.fn(), status: vi.fn(function (this: Response) { return this; }) } as unknown as Response;
  }

  beforeEach(async () => {
    user = await prisma.user.create({
      data: {
        email: `retlimit-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        name: 'Retention User',
        passwordHash: 'hashed',
      },
    });
    const conn = await prisma.connection.create({
      data: {
        userId: user.id, name: 'C', type: DatabaseType.MYSQL,
        host: 'localhost', port: 3306, database: 'db', username: 'u', password: 'p',
      },
    });
    connId = conn.id;
  });

  afterEach(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('defaults new users to a 30-day max retention', async () => {
    const u = await prisma.user.findUnique({ where: { id: user.id }, select: { maxRetentionDays: true } });
    expect(u?.maxRetentionDays).toBe(30);
  });

  it('createSchedule rejects retention above the cap and allows under it', async () => {
    const body = { connectionId: connId, name: 'Nightly', frequency: ScheduleFrequency.DAILY, cronExpression: '0 2 * * *', retentionDays: 90 };
    const req = mkReq({ userId: user.id, email: user.email, role: 'USER' }, { body });
    const res = mkRes();
    const next = vi.fn() as NextFunction;
    await createSchedule(req, res, next);
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));

    body.retentionDays = 30;
    const req2 = mkReq({ userId: user.id, email: user.email, role: 'USER' }, { body });
    const res2 = mkRes();
    await createSchedule(req2, res2, vi.fn() as NextFunction);
    const payload = (res2.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.success).toBe(true);
    scheduleId = payload.data.id;
  });

  it('updateSchedule rejects raising retention above the cap', async () => {
    const created = await prisma.schedule.create({
      data: { connectionId: connId, name: 'S', frequency: ScheduleFrequency.DAILY, cronExpression: '0 2 * * *', retentionDays: 14 },
    });
    const req = mkReq({ userId: user.id, email: user.email, role: 'USER' }, {
      params: { id: created.id },
      body: { name: 'S', frequency: ScheduleFrequency.DAILY, cronExpression: '0 2 * * *', isActive: true, retentionDays: 90 },
    });
    const res = mkRes();
    const next = vi.fn() as NextFunction;
    await updateSchedule(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('setUserRetentionLimit sets days, null, audits, and 400s invalid input', async () => {
    const req = mkReq({ userId: user.id, email: user.email, role: 'ADMIN' }, { params: { id: user.id }, body: { maxRetentionDays: 14 } });
    const res = mkRes();
    const next = vi.fn() as NextFunction;
    await setUserRetentionLimit(req, res, next);
    expect(next).not.toHaveBeenCalled();
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.data.maxRetentionDays).toBe(14);

    const req2 = mkReq({ userId: user.id, email: user.email, role: 'ADMIN' }, { params: { id: user.id }, body: { maxRetentionDays: null } });
    const res2 = mkRes();
    await setUserRetentionLimit(req2, res2, vi.fn() as NextFunction);
    const after = await prisma.user.findUnique({ where: { id: user.id }, select: { maxRetentionDays: true } });
    expect(after?.maxRetentionDays).toBeNull();
    const audit = await prisma.auditLog.count({ where: { action: 'ADMIN_SET_RETENTION_LIMIT', userId: user.id } });
    expect(audit).toBe(2);

    for (const bad of [0, 2.5, 'x']) {
      const reqBad = mkReq({ userId: user.id, email: user.email, role: 'ADMIN' }, { params: { id: user.id }, body: { maxRetentionDays: bad } });
      const resBad = mkRes();
      const nextBad = vi.fn() as NextFunction;
      await setUserRetentionLimit(reqBad, resBad, nextBad);
      expect(nextBad).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    }
  });

  it('getRetentionPolicy clamps schedule retention to the user cap', async () => {
    await prisma.schedule.create({
      data: { connectionId: connId, name: 'Long', frequency: ScheduleFrequency.DAILY, cronExpression: '0 2 * * *', retentionDays: 365 },
    });
    const { getRetentionPolicy } = await import('../services/retention.service');
    const clamped = await getRetentionPolicy(connId, 30);
    expect(clamped.retentionDays).toBe(30);
    const uncapped = await getRetentionPolicy(connId, null);
    expect(uncapped.retentionDays).toBe(365);
  });
});
