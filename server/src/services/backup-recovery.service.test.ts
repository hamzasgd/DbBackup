import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Queue } from 'bullmq';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseType } from '@prisma/client';
import { prisma } from '../config/database';
import { getRedisConfig } from '../config/redis';

vi.mock('./notification.service', () => ({ notify: vi.fn(async () => undefined) }));

import {
  reconcileInterruptedBackups, INTERRUPTED_MESSAGE, reconcileInterruptedRestores, RESTORE_INTERRUPTED_MESSAGE,
} from './backup-recovery.service';
import { notify } from './notification.service';

/** Integration: real test Postgres + real Redis (a throwaway queue name). */
describe('reconcileInterruptedBackups', () => {
  let queue: Queue;
  let userId: string;

  beforeEach(async () => {
    queue = new Queue(`backups-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`, { connection: getRedisConfig() });
    const user = await prisma.user.create({
      data: { email: `rec-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, name: 'R', passwordHash: 'h' },
    });
    userId = user.id;
    vi.mocked(notify).mockClear();
  });

  afterEach(async () => {
    await prisma.backup.deleteMany({ where: { userId } });
    await queue.obliterate({ force: true });
    await queue.close();
  });

  function addRow(status: 'PENDING' | 'RUNNING' | 'COMPLETED', ageMs: number, filePath = 'pending') {
    return prisma.backup.create({
      data: {
        userId, fileName: 'pending', filePath, dbType: DatabaseType.MYSQL, dbName: 'shop',
        status, format: 'COMPRESSED_SQL', createdAt: new Date(Date.now() - ageMs),
      },
    });
  }

  it('fails rows whose job is gone, keeps rows with a live job, recent rows and finished rows', async () => {
    // partial dump of the killed run (temp dir is inside the delete guard)
    const partial = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), 'mysql_shop.sql.gz');
    fs.writeFileSync(partial, Buffer.alloc(1024));
    const orphanRunning = await addRow('RUNNING', 10 * 60_000, partial);
    const orphanPending = await addRow('PENDING', 10 * 60_000);
    const queued = await addRow('RUNNING', 10 * 60_000);
    const justCreated = await addRow('PENDING', 1_000);
    const done = await addRow('COMPLETED', 10 * 60_000);
    await queue.add('backup', { backupId: queued.id, connectionId: 'c', outputDir: '/tmp' });

    expect(await reconcileInterruptedBackups(queue)).toBe(2);

    const byId = async (id: string) => prisma.backup.findUniqueOrThrow({ where: { id } });
    for (const b of [orphanRunning, orphanPending]) {
      const row = await byId(b.id);
      expect(row.status).toBe('FAILED');
      expect(row.error).toBe(INTERRUPTED_MESSAGE);
      expect(row.completedAt).not.toBeNull();
    }
    expect(fs.existsSync(partial)).toBe(false);
    expect((await byId(queued.id)).status).toBe('RUNNING');
    expect((await byId(justCreated.id)).status).toBe('PENDING');
    expect((await byId(done.id)).status).toBe('COMPLETED');
    expect(notify).toHaveBeenCalledTimes(2);

    // idempotent
    expect(await reconcileInterruptedBackups(queue)).toBe(0);
  });
});

describe('reconcileInterruptedRestores', () => {
  let queue: Queue;
  let userId: string;

  beforeEach(async () => {
    queue = new Queue(`restores-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`, { connection: getRedisConfig() });
    const user = await prisma.user.create({
      data: { email: `rrec-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, name: 'R', passwordHash: 'h' },
    });
    userId = user.id;
    vi.mocked(notify).mockClear();
  });

  afterEach(async () => {
    await prisma.restore.deleteMany({ where: { userId } });
    await queue.obliterate({ force: true });
    await queue.close();
  });

  function addRow(status: 'PENDING' | 'RUNNING' | 'COMPLETED', ageMs: number) {
    return prisma.restore.create({
      data: {
        userId, backupLabel: 'shop', targetName: 'Copy', targetDatabase: 'shop', status,
        stage: status === 'RUNNING' ? 'RESTORING' : null, createdAt: new Date(Date.now() - ageMs),
      },
    });
  }

  it('fails restores whose job is gone and never re-queues them', async () => {
    const orphan = await addRow('RUNNING', 10 * 60_000);
    const queued = await addRow('PENDING', 10 * 60_000);
    const justCreated = await addRow('PENDING', 1_000);
    const done = await addRow('COMPLETED', 10 * 60_000);
    await queue.add('restore', { jobId: queued.id, backupId: 'b', userId });

    expect(await reconcileInterruptedRestores(queue)).toBe(1);

    const row = await prisma.restore.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(row).toMatchObject({ status: 'FAILED', error: RESTORE_INTERRUPTED_MESSAGE, stage: null });
    expect(row.completedAt).not.toBeNull();
    for (const [r, status] of [[queued, 'PENDING'], [justCreated, 'PENDING'], [done, 'COMPLETED']] as const) {
      expect((await prisma.restore.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(status);
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await reconcileInterruptedRestores(queue)).toBe(0);
  });
});
