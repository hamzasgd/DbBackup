import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Response } from 'express';
import { DatabaseType } from '@prisma/client';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';

process.env.ENCRYPTION_KEY_PRIMARY = process.env.ENCRYPTION_KEY_PRIMARY ?? '3'.repeat(64);

import { encrypt } from './crypto.service';
import { restoreBackup } from '../controllers/restore.controller';
import { startDataSync } from '../controllers/data-sync.controller';
import { createMigration } from '../controllers/migration.controller';
import { deleteConnection, updateConnection } from '../controllers/connection.controller';
import { getDataSyncQueue } from '../queue/data-sync.queue';

/** Integration: a write-protected connection refuses every write path; reading still works. */
describe('write protection', () => {
  let userId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { email: `wp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, name: 'W', passwordHash: 'h' } });
    userId = u.id;
  });
  afterEach(async () => {
    const runs = await prisma.dataSyncRun.findMany({ where: { userId }, select: { id: true } });
    for (const r of runs) await getDataSyncQueue().remove(r.id).catch(() => undefined);
    await prisma.dataSyncRun.deleteMany({ where: { userId } });
    await prisma.restore.deleteMany({ where: { userId } });
    await prisma.backup.deleteMany({ where: { userId } });
  });

  const conn = (name: string, host: string, writeProtected = false) => prisma.connection.create({
    data: {
      userId, name, type: DatabaseType.MYSQL, host: encrypt(host), port: 3306, database: encrypt('shop'),
      username: encrypt('u'), password: encrypt('p'), writeProtected,
    },
  });
  const req = (body: object, params: object = {}, query: object = {}) =>
    ({ user: { userId, email: 'x', role: 'USER' }, body, params, query, ip: '127.0.0.1', headers: {} }) as unknown as AuthRequest;
  const res = () => {
    const r = { json: vi.fn(), status: vi.fn() } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    r.status.mockReturnValue(r);
    return r;
  };
  async function run(handler: (rq: AuthRequest, rs: Response, nx: () => void) => Promise<void>, rq: AuthRequest) {
    const r = res(); const next = vi.fn();
    await handler(rq, r, next);
    return { r, err: next.mock.calls[0]?.[0] };
  }
  const WRITE_PROTECTED = { statusCode: 403, code: 'WRITE_PROTECTED' };

  it('refuses restore, sync, migration and delete; allows compare and reading', async () => {
    const prod = await conn('Prod', 'prod.example.com', true);
    const copy = await conn('Copy', 'copy.example.com');
    const backup = await prisma.backup.create({
      data: { userId, connectionId: prod.id, fileName: 'b.sql.gz', filePath: '/tmp/b', dbType: DatabaseType.MYSQL, dbName: 'shop', status: 'COMPLETED', fileSize: BigInt(1) },
    });

    // Restore into the protected database, even with the overwrite confirmation typed in
    expect((await run(restoreBackup, req({ backupId: backup.id, targetConnectionId: prod.id, confirmOverwrite: 'shop' }))).err).toMatchObject(WRITE_PROTECTED);
    expect(await prisma.restore.count({ where: { userId } })).toBe(0);

    // Sync into it is refused; comparing against it (and syncing from it) is fine
    expect((await run(startDataSync, req({ sourceConnectionId: copy.id, targetConnectionId: prod.id, mode: 'APPLY', confirmTarget: 'shop' }))).err).toMatchObject(WRITE_PROTECTED);
    const compare = await run(startDataSync, req({ sourceConnectionId: copy.id, targetConnectionId: prod.id, mode: 'COMPARE' }));
    expect(compare.err).toBeUndefined();
    await getDataSyncQueue().remove(compare.r.json.mock.calls[0][0].data.id);
    await prisma.dataSyncRun.deleteMany({ where: { userId } });
    const fromProd = await run(startDataSync, req({ sourceConnectionId: prod.id, targetConnectionId: copy.id, mode: 'APPLY', confirmTarget: 'shop' }));
    expect(fromProd.err).toBeUndefined();

    // Migration into it, and deleting the connection
    expect((await run(createMigration, req({ sourceConnectionId: copy.id, targetConnectionId: prod.id, tables: ['t'] }))).err).toMatchObject(WRITE_PROTECTED);
    expect((await run(deleteConnection, req({}, { id: prod.id }))).err).toMatchObject(WRITE_PROTECTED);
    expect(await prisma.connection.count({ where: { id: prod.id } })).toBe(1);

    // Turning protection off is a deliberate edit; then delete works
    const upd = await run(updateConnection, req({ name: 'Prod', type: 'MYSQL', port: 3306, writeProtected: false }, { id: prod.id }));
    expect(upd.err).toBeUndefined();
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: prod.id } })).writeProtected).toBe(false);
    expect((await run(deleteConnection, req({}, { id: prod.id }))).err).toBeUndefined();
  });

  it('keeps the setting when an edit does not send it', async () => {
    const prod = await conn('Prod', 'prod.example.com', true);
    const upd = await run(updateConnection, req({ name: 'Prod renamed', type: 'MYSQL', port: 3306 }, { id: prod.id }));
    expect(upd.err).toBeUndefined();
    expect(await prisma.connection.findUniqueOrThrow({ where: { id: prod.id } })).toMatchObject({ name: 'Prod renamed', writeProtected: true });
  });
});
