import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../config/database';

const published: Array<{ channel: string; payload: Record<string, unknown> }> = [];
vi.mock('./sse.service', () => ({
  RESTORE_PROGRESS_CHANNEL: (userId: string, id: string) => `restore:progress:${userId}:${id}`,
  publishProgress: vi.fn(async (channel: string, payload: Record<string, unknown>) => { published.push({ channel, payload }); }),
}));

import { startRestoreTracker } from './restore-progress.service';

/** Integration: real test Postgres, SSE mocked. */
describe('restore live progress', () => {
  let userId: string;

  beforeEach(async () => {
    published.length = 0;
    const user = await prisma.user.create({
      data: { email: `rprog-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, name: 'P', passwordHash: 'h' },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.restore.deleteMany({ where: { userId } });
  });

  function addRestore(status = 'RUNNING') {
    return prisma.restore.create({
      data: { userId, backupLabel: 'db', targetName: 'Copy', targetDatabase: 'db', status },
    });
  }

  it('records stage, bytes and a heartbeat, and resets bytes per stage', async () => {
    const r = await addRestore();
    const tracker = startRestoreTracker(r.id, userId, 20);
    tracker.setStage('DECRYPTING', 4000);
    tracker.setBytes(1000);
    await new Promise((res) => setTimeout(res, 80));
    let row = await prisma.restore.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ stage: 'DECRYPTING', bytesRead: BigInt(1000), totalBytes: BigInt(4000) });
    expect(row.progressAt).not.toBeNull();

    tracker.setStage('RESTORING', 3000);
    tracker.setBytes(2500);
    await new Promise((res) => setTimeout(res, 80));
    await tracker.stop();
    row = await prisma.restore.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ stage: 'RESTORING', bytesRead: BigInt(2500), totalBytes: BigInt(3000) });
    expect(row.stageStartedAt!.getTime()).toBeGreaterThan(row.createdAt.getTime() - 1);

    const last = published[published.length - 1];
    expect(last.channel).toBe(`restore:progress:${userId}:${r.id}`);
    expect(last.payload).toMatchObject({ status: 'RUNNING', stage: 'RESTORING', bytesRead: 2500, totalBytes: 3000 });

    // Nothing is written after stop()
    const before = row.progressAt!.getTime();
    await new Promise((res) => setTimeout(res, 60));
    expect((await prisma.restore.findUniqueOrThrow({ where: { id: r.id } })).progressAt!.getTime()).toBe(before);
  });

  it('never touches a restore that already finished', async () => {
    const r = await addRestore('COMPLETED');
    const tracker = startRestoreTracker(r.id, userId, 20);
    tracker.setStage('RESTORING', 10);
    await new Promise((res) => setTimeout(res, 60));
    await tracker.stop();
    const row = await prisma.restore.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ status: 'COMPLETED', stage: null, progressAt: null });
  });
});
