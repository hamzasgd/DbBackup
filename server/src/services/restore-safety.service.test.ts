import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Response } from 'express';
import { DatabaseType } from '@prisma/client';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';
import { AppError } from '../middleware/errorHandler';

// Connections store encrypted fields; give the lazy KeyManager a key (CI sets none)
process.env.ENCRYPTION_KEY_PRIMARY = process.env.ENCRYPTION_KEY_PRIMARY ?? '3'.repeat(64);

import { encrypt } from './crypto.service';
import { checkRestoreTarget, databaseAddress, isNetworkLocalHost } from './restore-safety.service';
import { restoreBackup } from '../controllers/restore.controller';
import { getRestoreQueue } from '../queue/restore.queue';

describe('restore target address', () => {
  it('treats loopback, private IPs and single-label names as network-local', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '10.0.0.5', '172.18.0.2', '192.168.1.9', 'db', 'postgres']) {
      expect(isNetworkLocalHost(h), h).toBe(true);
    }
    for (const h of ['casa.abc123.us-east-1.rds.amazonaws.com', '159.203.71.89', '172.32.0.1', 'db.example.com']) {
      expect(isNetworkLocalHost(h), h).toBe(false);
    }
  });

  const base = { type: 'MYSQL' as const, host: 'casa.x.rds.amazonaws.com', port: 3306, sshEnabled: false, sshHost: undefined, sshPort: 22 };

  it('matches a public host whichever way it is reached, case and trailing dot aside', () => {
    const direct = databaseAddress(base, 'casa_loyalty_prod');
    const viaSsh = databaseAddress({ ...base, host: 'CASA.x.rds.amazonaws.com.', sshEnabled: true, sshHost: 'jump.example.com' }, 'CASA_LOYALTY_PROD');
    expect(viaSsh).toBe(direct);
    // MariaDB and MySQL connections to the same server are the same database
    expect(databaseAddress({ ...base, type: 'MARIADB' as never }, 'casa_loyalty_prod')).toBe(direct);
  });

  it('tells apart network-local hosts behind different SSH servers', () => {
    const a = databaseAddress({ ...base, host: '127.0.0.1', sshEnabled: true, sshHost: 'one.example.com' }, 'app');
    const b = databaseAddress({ ...base, host: 'localhost', sshEnabled: true, sshHost: 'two.example.com' }, 'app');
    const a2 = databaseAddress({ ...base, host: 'localhost', sshEnabled: true, sshHost: 'ONE.example.com' }, 'app');
    expect(a).not.toBe(b);
    expect(a2).toBe(a);
  });

  it('differs by port, database and engine family', () => {
    const a = databaseAddress(base, 'app');
    expect(databaseAddress({ ...base, port: 3307 }, 'app')).not.toBe(a);
    expect(databaseAddress(base, 'app_copy')).not.toBe(a);
    expect(databaseAddress({ ...base, type: 'POSTGRESQL' as never }, 'app')).not.toBe(a);
  });
});

/** Integration: real test Postgres (and Redis for the one restore that is queued). */
describe('checkRestoreTarget and the restore guard', () => {
  let userId: string;

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: `rs-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, name: 'R', passwordHash: 'h' },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.restore.deleteMany({ where: { userId } });
    // backups.userId has no FK, so they survive the user wipe in setup.ts
    await prisma.backup.deleteMany({ where: { userId } });
  });

  function addConn(name: string, f: { type?: DatabaseType; host: string; port?: number; database: string; sshHost?: string }) {
    return prisma.connection.create({
      data: {
        userId, name, type: f.type ?? DatabaseType.MYSQL,
        host: encrypt(f.host), port: f.port ?? 3306, database: encrypt(f.database),
        username: encrypt('u'), password: encrypt('p'),
        sshEnabled: !!f.sshHost, sshHost: f.sshHost ? encrypt(f.sshHost) : null, sshUsername: f.sshHost ? encrypt('ubuntu') : null,
      },
    });
  }

  function addBackup(connectionId: string, dbName: string) {
    return prisma.backup.create({
      data: {
        userId, connectionId, fileName: 'b.sql.gz', filePath: '/tmp/b.sql.gz', dbType: DatabaseType.MYSQL, dbName,
        status: 'COMPLETED', format: 'COMPRESSED_SQL', fileSize: BigInt(1000),
      },
    });
  }

  it('flags the backup’s own connection and another connection to the same database', async () => {
    const aws = await addConn('Casa AWS', { host: 'casa.x.rds.amazonaws.com', database: 'casa_loyalty_prod', sshHost: 'jump.example.com' });
    const awsDirect = await addConn('Casa AWS direct', { host: 'casa.x.rds.amazonaws.com', database: 'casa_loyalty_prod' });
    const doCopy = await addConn('Casa DO', { host: '127.0.0.1', database: 'casa_loyalty_prod', sshHost: '159.203.71.89' });
    const backup = await addBackup(aws.id, 'casa_loyalty_prod');

    const own = await checkRestoreTarget(userId, backup.id, aws.id);
    expect(own).toMatchObject({ overwritesSource: true, overwritesSourceReason: 'same-connection', incompatible: null, busy: null });
    expect(own.target).toMatchObject({ name: 'Casa AWS', database: 'casa_loyalty_prod' });
    expect(own.backup.sourceName).toBe('Casa AWS');

    // No target given = the backup's own connection
    expect((await checkRestoreTarget(userId, backup.id)).overwritesSource).toBe(true);

    const sameAddress = await checkRestoreTarget(userId, backup.id, awsDirect.id);
    expect(sameAddress).toMatchObject({ overwritesSource: true, overwritesSourceReason: 'same-address' });

    const other = await checkRestoreTarget(userId, backup.id, doCopy.id);
    expect(other).toMatchObject({ overwritesSource: false, overwritesSourceReason: null });

    // Same connection, another database on that server: not the source
    expect((await checkRestoreTarget(userId, backup.id, aws.id, 'casa_staging')).overwritesSource).toBe(false);
  });

  it('reports an incompatible engine and a restore already running into the target', async () => {
    const src = await addConn('Src', { host: 'a.example.com', database: 'app' });
    const pg = await addConn('PG', { type: DatabaseType.POSTGRESQL, host: 'b.example.com', port: 5432, database: 'app' });
    const dst = await addConn('Dst', { host: 'c.example.com', database: 'app' });
    const backup = await addBackup(src.id, 'app');

    expect((await checkRestoreTarget(userId, backup.id, pg.id)).incompatible).toMatch(/MYSQL backup.*POSTGRESQL/);

    const running = await prisma.restore.create({
      data: { userId, backupId: backup.id, targetConnectionId: dst.id, backupLabel: 'app', targetName: 'Dst', targetDatabase: 'APP', status: 'RUNNING' },
    });
    expect((await checkRestoreTarget(userId, backup.id, dst.id)).busy).toEqual({ restoreId: running.id, status: 'RUNNING' });
  });

  it('rejects other users’ backups and connections', async () => {
    const src = await addConn('Src', { host: 'a.example.com', database: 'app' });
    const backup = await addBackup(src.id, 'app');
    const stranger = await prisma.user.create({ data: { email: `s-${Date.now()}@example.com`, name: 'S', passwordHash: 'h' } });
    await expect(checkRestoreTarget(stranger.id, backup.id, src.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  function mkReq(body: object) {
    return { user: { userId, email: 'x', role: 'USER' }, body } as unknown as AuthRequest;
  }
  function mkRes() {
    const res = { json: vi.fn(), status: vi.fn() } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    res.status.mockReturnValue(res);
    return res;
  }

  it('refuses to overwrite the source unless the database name is typed back, then records the restore', async () => {
    const aws = await addConn('Casa AWS', { host: 'casa.x.rds.amazonaws.com', database: 'casa_loyalty_prod' });
    const backup = await addBackup(aws.id, 'casa_loyalty_prod');

    for (const confirmOverwrite of [undefined, 'yes', 'casa_loyalty']) {
      const next = vi.fn();
      await restoreBackup(mkReq({ backupId: backup.id, targetConnectionId: aws.id, confirmOverwrite }), mkRes(), next);
      const err = next.mock.calls[0]?.[0];
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ statusCode: 409, code: 'CONFIRM_OVERWRITE_SOURCE' });
    }
    expect(await prisma.restore.count({ where: { userId } })).toBe(0);

    const res = mkRes();
    const next = vi.fn();
    await restoreBackup(mkReq({ backupId: backup.id, targetConnectionId: aws.id, confirmOverwrite: 'casa_loyalty_prod' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
    const { jobId } = res.json.mock.calls[0][0].data;
    try {
      const row = await prisma.restore.findUniqueOrThrow({ where: { id: jobId } });
      expect(row).toMatchObject({
        status: 'PENDING', overwritesSource: true, targetName: 'Casa AWS', targetDatabase: 'casa_loyalty_prod', backupLabel: 'casa_loyalty_prod',
      });
      const job = await getRestoreQueue().getJob(jobId);
      expect(job?.data).toMatchObject({ jobId, backupId: backup.id, userId, targetConnectionId: aws.id });

      // A second restore into the same database is refused while this one is queued
      const next2 = vi.fn();
      await restoreBackup(mkReq({ backupId: backup.id, targetConnectionId: aws.id, confirmOverwrite: 'casa_loyalty_prod' }), mkRes(), next2);
      expect(next2.mock.calls[0][0]).toMatchObject({ statusCode: 409, code: 'RESTORE_IN_PROGRESS' });
    } finally {
      await getRestoreQueue().remove(jobId);
    }
  });
});
