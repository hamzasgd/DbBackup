import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseType } from '@prisma/client';
import { prisma } from '../config/database';

const published: object[] = [];
vi.mock('./sse.service', () => ({
  BACKUP_PROGRESS_CHANNEL: (id: string) => `backup:progress:${id}`,
  publishProgress: vi.fn(async (_ch: string, payload: object) => { published.push(payload); }),
}));

import { estimatePercent, expectedBackupBytes, startProgressTracker } from './backup-progress.service';

/** Integration tests for live backup progress (real test Postgres, SSE mocked). */
describe('backup live progress', () => {
  let userId: string;
  let connId: string;

  beforeEach(async () => {
    published.length = 0;
    const user = await prisma.user.create({
      data: { email: `prog-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, name: 'P', passwordHash: 'h' },
    });
    userId = user.id;
    const conn = await prisma.connection.create({
      data: { userId, name: 'C', type: DatabaseType.MYSQL, host: 'localhost', port: 3306, database: 'db', username: 'u', password: 'p' },
    });
    connId = conn.id;
  });

  afterEach(async () => {
    // backups.userId has no FK, so they survive the user wipe in setup.ts
    await prisma.backup.deleteMany({ where: { userId } });
  });

  function addBackup(data: { fileSize: bigint; status?: 'COMPLETED' | 'FAILED' | 'RUNNING'; format?: 'COMPRESSED_SQL' | 'PLAIN_SQL'; createdAt?: Date }) {
    return prisma.backup.create({
      data: {
        userId, connectionId: connId, fileName: 'f', filePath: '/tmp/f', dbType: DatabaseType.MYSQL, dbName: 'db',
        fileSize: data.fileSize, status: data.status ?? 'COMPLETED', format: data.format ?? 'COMPRESSED_SQL',
        createdAt: data.createdAt ?? new Date(),
      },
    });
  }

  it('estimatePercent: dump fills 0-90 against the estimate, later stages are fixed', () => {
    expect(estimatePercent('DUMPING', 0, 1000)).toBe(0);
    expect(estimatePercent('DUMPING', 500, 1000)).toBe(45);
    expect(estimatePercent('DUMPING', 5000, 1000)).toBe(90); // bigger than last time: capped
    expect(estimatePercent('DUMPING', 500, null)).toBe(0);   // no history: UI shows indeterminate
    expect(estimatePercent('VERIFYING', 0, null)).toBe(91);
    expect(estimatePercent('UPLOADING', 0, 1000)).toBe(97);
  });

  it('expectedBackupBytes uses the latest completed backup of the same format', async () => {
    await addBackup({ fileSize: BigInt(100), createdAt: new Date(Date.now() - 3 * 86400_000) });
    await addBackup({ fileSize: BigInt(300), createdAt: new Date(Date.now() - 86400_000) });
    await addBackup({ fileSize: BigInt(999), format: 'PLAIN_SQL' });
    await addBackup({ fileSize: BigInt(777), status: 'FAILED' });
    const running = await addBackup({ fileSize: BigInt(0), status: 'RUNNING' });

    expect(await expectedBackupBytes(connId, 'COMPRESSED_SQL', running.id)).toBe(BigInt(300));
    expect(await expectedBackupBytes(connId, 'CUSTOM', running.id)).toBeNull();
    expect(await expectedBackupBytes(null, 'COMPRESSED_SQL', running.id)).toBeNull();
  });

  it('tracker writes bytes, stage, estimate and heartbeat; nothing after stop', async () => {
    const running = await addBackup({ fileSize: BigInt(0), status: 'RUNNING' });
    const tracker = startProgressTracker(running.id, BigInt(1000), 60_000);

    tracker.setBytes(500);
    await tracker.flush();
    let row = await prisma.backup.findUniqueOrThrow({ where: { id: running.id } });
    expect(row.stage).toBe('DUMPING');
    expect(row.bytesWritten).toBe(BigInt(500));
    expect(row.expectedBytes).toBe(BigInt(1000));
    expect(row.progress).toBe(45);
    expect(row.progressAt).not.toBeNull();
    expect(row.bytesChangedAt).not.toBeNull();
    expect(published[published.length - 1]).toMatchObject({ status: 'RUNNING', stage: 'DUMPING', bytesWritten: 500, expectedBytes: 1000, progress: 45 });

    tracker.setStage('VERIFYING');
    await tracker.flush();
    row = await prisma.backup.findUniqueOrThrow({ where: { id: running.id } });
    expect(row.stage).toBe('VERIFYING');
    expect(row.progress).toBe(91);

    await tracker.stop();
    const count = published.length;
    tracker.setStage('UPLOADING');
    await tracker.flush();
    row = await prisma.backup.findUniqueOrThrow({ where: { id: running.id } });
    expect(row.stage).toBe('VERIFYING');
    expect(published.length).toBe(count);
  });
});
