import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Response } from 'express';
import { DatabaseType } from '@prisma/client';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';

process.env.ENCRYPTION_KEY_PRIMARY = process.env.ENCRYPTION_KEY_PRIMARY ?? '3'.repeat(64);

import { encrypt } from '../services/crypto.service';
import { startDataSync, cancelDataSync } from './data-sync.controller';
import { getDataSyncQueue } from '../queue/data-sync.queue';

/** Integration: real test Postgres + Redis (jobs are removed again). */
describe('data sync API guards', () => {
  let userId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { email: `ds-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, name: 'D', passwordHash: 'h' } });
    userId = u.id;
  });
  afterEach(async () => {
    const runs = await prisma.dataSyncRun.findMany({ where: { userId }, select: { id: true } });
    for (const r of runs) await getDataSyncQueue().remove(r.id).catch(() => undefined);
    await prisma.dataSyncRun.deleteMany({ where: { userId } });
  });

  const conn = (name: string, host: string, database: string, type: DatabaseType = DatabaseType.MYSQL) => prisma.connection.create({
    data: { userId, name, type, host: encrypt(host), port: 3306, database: encrypt(database), username: encrypt('u'), password: encrypt('p') },
  });
  const req = (body: object, params: object = {}) => ({ user: { userId, email: 'x', role: 'USER' }, body, params, ip: '127.0.0.1', headers: {} }) as unknown as AuthRequest;
  const res = () => {
    const r = { json: vi.fn(), status: vi.fn() } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    r.status.mockReturnValue(r);
    return r;
  };
  async function call(body: object) {
    const r = res(); const next = vi.fn();
    await startDataSync(req(body), r, next);
    return { r, err: next.mock.calls[0]?.[0] };
  }

  it('quick needs a completed sync to start from, and looks back from it with a margin', async () => {
    const a = await conn('Prod', 'a.example.com', 'shop');
    const b = await conn('Copy', 'b.example.com', 'shop_copy');
    const quick = { sourceConnectionId: a.id, targetConnectionId: b.id, mode: 'COMPARE', method: 'QUICK' };
    const base = { userId, sourceConnectionId: a.id, targetConnectionId: b.id, sourceName: 'Prod', targetName: 'Copy', sourceDatabase: 'shop', targetDatabase: 'shop_copy' };
    expect((await call(quick)).err).toMatchObject({ code: 'NO_BASELINE', statusCode: 400 });

    // A compare alone is no starting point; a completed sync of all tables is
    const t0 = new Date('2026-11-20T10:00:00.000Z');
    await prisma.dataSyncRun.create({ data: { ...base, mode: 'COMPARE', status: 'COMPLETED', sourceTime: new Date('2026-11-20T08:00:00.000Z'), createdAt: new Date('2026-11-20T08:00:00.000Z') } });
    expect((await call(quick)).err).toMatchObject({ code: 'NO_BASELINE' });
    await prisma.dataSyncRun.create({ data: { ...base, mode: 'APPLY', status: 'COMPLETED', sourceTime: t0, createdAt: t0 } });
    const ok = await call(quick);
    expect(ok.err).toBeUndefined();
    const run = await prisma.dataSyncRun.findUniqueOrThrow({ where: { id: ok.r.json.mock.calls[0][0].data.id } });
    expect(run.method).toBe('QUICK');
    expect(run.since?.toISOString()).toBe('2026-11-20T09:45:00.000Z');
    // Out of the way (it is queued, so it would block the next start), whatever the current time is
    await getDataSyncQueue().remove(run.id).catch(() => undefined);
    await prisma.dataSyncRun.delete({ where: { id: run.id } });

    // A sync of only some tables: the other tables were last checked by the full compare before it
    await prisma.dataSyncRun.create({ data: { ...base, mode: 'COMPARE', status: 'COMPLETED', sourceTime: new Date('2026-11-21T09:00:00.000Z'), createdAt: new Date('2026-11-21T09:00:00.000Z') } });
    await prisma.dataSyncRun.create({ data: { ...base, mode: 'APPLY', status: 'COMPLETED', tables: ['orders'], sourceTime: new Date('2026-11-21T10:00:00.000Z'), createdAt: new Date('2026-11-21T10:00:00.000Z') } });
    const partial = await call(quick);
    expect(partial.err).toBeUndefined();
    const run2 = await prisma.dataSyncRun.findUniqueOrThrow({ where: { id: partial.r.json.mock.calls[0][0].data.id } });
    expect(run2.since?.toISOString()).toBe('2026-11-21T08:45:00.000Z');
  });

  it('refuses the same database as source and target', async () => {
    const a = await conn('Prod', 'db.example.com', 'shop');
    const b = await conn('Prod again', 'DB.example.com', 'shop');
    expect((await call({ sourceConnectionId: a.id, targetConnectionId: a.id, mode: 'COMPARE' })).err).toMatchObject({ code: 'SAME_DATABASE' });
    expect((await call({ sourceConnectionId: a.id, targetConnectionId: b.id, mode: 'COMPARE' })).err).toMatchObject({ code: 'SAME_DATABASE' });
  });

  it('only supports MySQL/MariaDB for now', async () => {
    const a = await conn('Prod', 'a.example.com', 'shop');
    const pg = await conn('PG', 'b.example.com', 'shop', DatabaseType.POSTGRESQL);
    expect((await call({ sourceConnectionId: a.id, targetConnectionId: pg.id, mode: 'COMPARE' })).err).toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('needs the target name typed back to apply, allows one run per target, and can be stopped', async () => {
    const a = await conn('Prod', 'a.example.com', 'shop');
    const b = await conn('Copy', 'b.example.com', 'shop_copy');
    for (const confirmTarget of [undefined, 'shop', 'yes']) {
      expect((await call({ sourceConnectionId: a.id, targetConnectionId: b.id, mode: 'APPLY', confirmTarget })).err).toMatchObject({ code: 'CONFIRM_TARGET', statusCode: 409 });
    }
    expect(await prisma.dataSyncRun.count({ where: { userId } })).toBe(0);

    const ok = await call({ sourceConnectionId: a.id, targetConnectionId: b.id, mode: 'APPLY', confirmTarget: 'shop_copy', tables: ['orders'] });
    expect(ok.err).toBeUndefined();
    expect(ok.r.status).toHaveBeenCalledWith(202);
    const id = ok.r.json.mock.calls[0][0].data.id;
    expect(await prisma.dataSyncRun.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'PENDING', mode: 'APPLY', sourceName: 'Prod', targetName: 'Copy', sourceDatabase: 'shop', targetDatabase: 'shop_copy', tables: ['orders'],
    });
    expect((await getDataSyncQueue().getJob(id))?.data).toEqual({ runId: id, userId });

    expect((await call({ sourceConnectionId: a.id, targetConnectionId: b.id, mode: 'COMPARE' })).err).toMatchObject({ code: 'SYNC_IN_PROGRESS' });

    const next = vi.fn();
    await cancelDataSync(req({}, { id }), res(), next);
    expect(next).not.toHaveBeenCalled();
    expect(await prisma.dataSyncRun.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'CANCELLED', cancelRequested: true });
    expect(await getDataSyncQueue().getJob(id)).toBeUndefined();
  });
});
