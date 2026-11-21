import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import type { LiveSync, Connection } from '@prisma/client';
import { prisma } from '../../config/database';
import { getRedisConfig } from '../../config/redis';
import { logger } from '../../config/logger';
import { notify } from '../notification.service';
import { assertWritable } from '../write-protection';
import { toEngineConfig } from '../engines/connection-config';
import { addDataSyncJob } from '../../queue/data-sync.queue';
import { quickBaseline, QUICK_MARGIN_MS } from '../../controllers/data-sync.controller';
import { checkLiveSource, startLiveStream, LiveSyncError, type BinlogPosition, type LiveProgress } from './mysql-live';

/**
 * Keeps every enabled live sync running in this process:
 *
 * 1. With no saved position, it notes where the source's binary log ends now
 *    and starts a sync (Quick when possible) that brings the target up to
 *    date. Changes made meanwhile are in the log after that position.
 * 2. Then it follows the log from the saved position, applying each change
 *    and saving the position every few seconds.
 * 3. While any sync into the same target runs (a catch-up, or one the user
 *    started), it pauses, so two writers never race; afterwards it continues
 *    from its position (applying a change twice gives the same result).
 * 4. When the position can't be continued from (the source deleted that log),
 *    it starts over at step 1, catching up from the last change it applied.
 *
 * A Redis lock makes sure only one process follows a given live sync.
 */

const TICK_MS = 5_000;
const LOCK_TTL_MS = 30_000;
const FLUSH_MS = 2_000;
const CHECK_MS = 2_000;
const HEAD_MS = 15_000;
/** No events for this long while the source has new ones: the connection died quietly */
const STALL_MS = 120_000;
const CATCH_UP_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const behind = (a: BinlogPosition, b: BinlogPosition) => a.file < b.file || (a.file === b.file && a.pos < b.pos);

/** A replica id unlikely to collide with the source's own replicas */
export const randomServerId = () => 100_000 + Math.floor(Math.random() * 2_000_000_000);

let redis: Redis | null = null;
const lockKey = (id: string) => `live-sync:lock:${id}`;
const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

class Runner {
  private closed = false;
  private readonly token = randomUUID();
  private catchUpFailures = 0;
  private notifiedError = false;
  finished: Promise<void> = Promise.resolve();

  constructor(readonly id: string) {}

  start() {
    this.finished = this.loop()
      .catch((err) => { logger.error(`Live sync ${this.id} stopped unexpectedly:`, err); })
      .finally(() => { this.closed = true; void this.release(); runners.delete(this.id); });
  }

  close() { this.closed = true; }

  async lock(): Promise<boolean> {
    if (!redis) return true;
    return (await redis.set(lockKey(this.id), this.token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
  }

  async renew(): Promise<boolean> {
    if (!redis) return true;
    return Number(await redis.eval(RENEW, 1, lockKey(this.id), this.token, String(LOCK_TTL_MS))) === 1;
  }

  private async release() {
    if (redis) await redis.eval(RELEASE, 1, lockKey(this.id), this.token).catch(() => undefined);
  }

  private update(data: Parameters<typeof prisma.liveSync.update>[0]['data']) {
    return prisma.liveSync.update({ where: { id: this.id }, data });
  }

  /** Stop for good with an error the user has to look at */
  private async halt(ls: LiveSync, message: string) {
    await this.update({ status: 'ERROR', enabled: false, error: message.slice(0, 4000), stoppedAt: new Date() });
    logger.warn(`Live sync ${this.id} (${ls.sourceName} → ${ls.targetName}) stopped: ${message}`);
    void notify(ls.userId, {
      event: 'SYNC_FAILED',
      title: '❌ Live sync stopped',
      message: `${ls.sourceName} → ${ls.targetName}: ${message.slice(0, 300)}`,
      details: { Source: ls.sourceName, Target: ls.targetName },
    }).catch(() => undefined);
  }

  private async loop() {
    let backoff = 5_000;
    while (!this.closed) {
      const ls = await prisma.liveSync.findUnique({ where: { id: this.id } });
      if (!ls || !ls.enabled) return;
      const [source, target] = await Promise.all([
        prisma.connection.findFirst({ where: { id: ls.sourceConnectionId ?? '', userId: ls.userId } }),
        prisma.connection.findFirst({ where: { id: ls.targetConnectionId ?? '', userId: ls.userId } }),
      ]);
      if (!source || !target) return this.halt(ls, 'The source or target connection was deleted');
      try {
        assertWritable(target, 'apply changes to it');
      } catch (err) {
        return this.halt(ls, messageOf(err));
      }

      // Any sync into the target running (our catch-up, or one the user started): wait for it
      const busy = await prisma.dataSyncRun.findFirst({
        where: { targetConnectionId: target.id, mode: 'APPLY', status: { in: ['PENDING', 'RUNNING'] } },
        select: { id: true },
      });
      if (busy) {
        const status = busy.id === ls.catchUpRunId ? 'CATCHING_UP' : 'PAUSED';
        if (ls.status !== status) await this.update({ status });
        await sleep(2_000);
        continue;
      }

      if (ls.catchUpRunId) {
        const run = await prisma.dataSyncRun.findUnique({ where: { id: ls.catchUpRunId }, select: { status: true, error: true } });
        if (run?.status === 'COMPLETED') {
          this.catchUpFailures = 0;
          await this.update({ catchUpRunId: null });
          continue;
        }
        if (run?.status === 'CANCELLED') return this.halt(ls, 'The catch-up sync was stopped, so Live sync stopped too');
        this.catchUpFailures++;
        const why = run?.error ?? 'it did not finish';
        if (this.catchUpFailures >= CATCH_UP_ATTEMPTS) return this.halt(ls, `The catch-up sync failed: ${why}`);
        // Start over: a new position and a new catch-up
        await this.update({ catchUpRunId: null, binlogFile: null, binlogPos: null, status: 'ERROR', error: `The catch-up sync failed, trying again: ${why}`.slice(0, 4000) });
        await sleep(60_000);
        continue;
      }

      if (!ls.binlogFile) {
        await this.beginCatchUp(ls, source, target);
        continue;
      }

      // RUNNING before the last look for syncs: a sync starting now sees it and waits for the pause
      await this.update({ status: 'RUNNING' });
      const lateSync = await prisma.dataSyncRun.findFirst({
        where: { targetConnectionId: target.id, mode: 'APPLY', status: { in: ['PENDING', 'RUNNING'] } },
        select: { id: true },
      });
      if (lateSync) continue;

      try {
        await this.follow(ls, source, target);
        backoff = 5_000;
      } catch (err) {
        const e = err instanceof LiveSyncError ? err : new LiveSyncError(messageOf(err), 'TRANSIENT');
        if (e.kind === 'CONFIG') return this.halt(ls, e.message);
        if (e.kind === 'RESYNC') {
          logger.warn(`Live sync ${this.id}: ${e.message}; catching up with a sync`);
          await this.update({ binlogFile: null, binlogPos: null, error: null });
          continue;
        }
        logger.warn(`Live sync ${this.id} (${e.kind}): ${e.message}`);
        await this.update({ status: e.kind === 'APPLY' ? 'ERROR' : 'RECONNECTING', error: e.message.slice(0, 4000) });
        if (e.kind === 'APPLY' && !this.notifiedError) {
          this.notifiedError = true;
          void notify(ls.userId, {
            event: 'SYNC_FAILED',
            title: '⚠️ Live sync can\'t apply a change',
            message: `${ls.sourceName} → ${ls.targetName}: ${e.message.slice(0, 300)}. It keeps trying every minute.`,
            details: { Source: ls.sourceName, Target: ls.targetName },
          }).catch(() => undefined);
        }
        await this.sleepUnlessClosed(e.kind === 'APPLY' ? 60_000 : backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async sleepUnlessClosed(ms: number) {
    const end = Date.now() + ms;
    while (!this.closed && Date.now() < end) {
      await sleep(Math.min(1000, end - Date.now()));
      const ls = await prisma.liveSync.findUnique({ where: { id: this.id }, select: { enabled: true } }).catch(() => null);
      if (ls && !ls.enabled) return;
    }
  }

  /** Note where the log ends now and start a sync that brings the target up to there */
  private async beginCatchUp(ls: LiveSync, source: Connection, target: Connection) {
    await this.update({ status: 'STARTING', error: null });
    let check;
    try {
      check = await checkLiveSource(toEngineConfig(source));
    } catch (err) {
      await this.update({ status: 'RECONNECTING', error: messageOf(err).slice(0, 4000) });
      await this.sleepUnlessClosed(30_000);
      return;
    }
    if (check.problems.length) return this.halt(ls, check.problems.join(' '));

    // From the last change it applied, or else from the last completed sync; a full sync otherwise
    let base = ls.lastEventAt;
    if (!base) base = await quickBaseline(ls.userId, source.id, target.id);
    const since = base ? new Date(base.getTime() - QUICK_MARGIN_MS) : null;
    const run = await prisma.dataSyncRun.create({
      data: {
        userId: ls.userId, sourceConnectionId: source.id, targetConnectionId: target.id,
        sourceName: source.name, targetName: target.name,
        sourceDatabase: ls.sourceDatabase, targetDatabase: ls.targetDatabase,
        mode: 'APPLY', tables: [], parallel: 4, method: since ? 'QUICK' : 'FULL', since, liveSyncId: ls.id,
      },
    });
    await this.update({
      binlogFile: check.position.file, binlogPos: BigInt(check.position.pos),
      catchUpRunId: run.id, status: 'CATCHING_UP', warnings: check.warnings,
    });
    try {
      await addDataSyncJob({ runId: run.id, userId: ls.userId });
    } catch (err) {
      await prisma.dataSyncRun.update({ where: { id: run.id }, data: { status: 'FAILED', error: 'Could not queue the run', completedAt: new Date() } });
      throw err;
    }
    logger.info(`Live sync ${this.id}: catching up with a ${since ? `quick sync since ${since.toISOString()}` : 'full sync'}, then following from ${check.position.file}:${check.position.pos}`);
  }

  /** Follow the log until stopped, paused or failed */
  private async follow(ls: LiveSync, source: Connection, target: Connection) {
    let position: BinlogPosition = { file: ls.binlogFile!, pos: Number(ls.binlogPos) };
    let saved = { ...position };
    let lastEventAt: Date | null = null;
    let appliedAt: Date | null = null;
    const pending = { inserted: 0, updated: 0, deleted: 0, transactions: 0 };
    const notes: string[] = [];

    const stream = await startLiveStream(toEngineConfig(source), toEngineConfig(target), {
      serverId: ls.serverId,
      start: position,
      onProgress: (p: LiveProgress) => {
        position = p.position;
        if (p.eventAt) { lastEventAt = p.eventAt; appliedAt = new Date(); }
        pending.inserted += p.inserted;
        pending.updated += p.updated;
        pending.deleted += p.deleted;
        pending.transactions += p.transactions;
      },
      onNote: (n) => { notes.push(n); logger.info(`Live sync ${this.id}: ${n}`); },
    });
    logger.info(`Live sync ${this.id} following ${ls.sourceName} from ${position.file}:${position.pos}`);
    await this.update({ status: 'RUNNING', error: null, startedAt: ls.startedAt ?? new Date(), stoppedAt: null });
    this.notifiedError = false;

    const flush = async () => {
      const counts = { ...pending };
      const pos = position;
      const moved = pos.file !== saved.file || pos.pos !== saved.pos;
      if (!moved && !counts.transactions && !notes.length) return;
      pending.inserted = pending.updated = pending.deleted = pending.transactions = 0;
      const newNotes = notes.splice(0);
      const current = newNotes.length ? (await prisma.liveSync.findUnique({ where: { id: this.id }, select: { warnings: true } }))?.warnings ?? [] : [];
      await this.update({
        binlogFile: pos.file, binlogPos: BigInt(pos.pos),
        ...(lastEventAt ? { lastEventAt, appliedAt } : {}),
        inserted: { increment: BigInt(counts.inserted) },
        updated: { increment: BigInt(counts.updated) },
        deleted: { increment: BigInt(counts.deleted) },
        transactions: { increment: BigInt(counts.transactions) },
        ...(newNotes.length ? { warnings: [...current, ...newNotes.filter((n) => !current.includes(n))].slice(-50) } : {}),
      });
      saved = pos;
    };

    let ended = false;
    let endError: unknown = null;
    stream.done.then(() => { ended = true; }, (err) => { ended = true; endError = err; });
    let lastFlush = Date.now();
    let lastCheck = 0;
    let lastHead = 0;
    try {
      while (!ended && !this.closed) {
        await sleep(500);
        const now = Date.now();
        if (now - lastFlush >= FLUSH_MS) { lastFlush = now; await flush(); }
        if (now - lastCheck >= CHECK_MS) {
          lastCheck = now;
          const row = await prisma.liveSync.findUnique({ where: { id: this.id }, select: { enabled: true } });
          if (!row?.enabled) break;
          const busy = await prisma.dataSyncRun.findFirst({
            where: { targetConnectionId: target.id, mode: 'APPLY', status: { in: ['PENDING', 'RUNNING'] } },
            select: { id: true },
          });
          if (busy) break; // the loop pauses until that sync is done
        }
        if (now - lastHead >= HEAD_MS) {
          lastHead = now;
          const head = await stream.head().catch(() => null);
          if (head) {
            await this.update({ headFile: head.file, headPos: BigInt(head.pos), checkedAt: new Date() });
            if (behind(position, head) && stream.pending() === 0 && now - stream.lastEventMs() > STALL_MS) {
              throw new LiveSyncError('No changes arrived for 2 minutes although the source has new ones; reconnecting', 'TRANSIENT');
            }
          }
        }
      }
    } finally {
      await stream.stop();
      await flush().catch((err) => logger.warn(`Live sync ${this.id}: saving the position failed:`, err));
    }
    if (endError) throw endError;
    const row = await prisma.liveSync.findUnique({ where: { id: this.id }, select: { enabled: true } });
    if (row && !row.enabled) await this.update({ status: 'STOPPED', stoppedAt: new Date() });
  }
}

const runners = new Map<string, Runner>();
let timer: NodeJS.Timeout | null = null;
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const enabled = await prisma.liveSync.findMany({ where: { enabled: true }, select: { id: true } });
    const ids = new Set(enabled.map((x) => x.id));
    for (const [id, r] of runners) {
      if (!ids.has(id)) continue; // it notices on its own and finishes
      if (!(await r.renew().catch(() => false))) {
        logger.warn(`Live sync ${id}: lost its lock; stopping here`);
        r.close();
      }
    }
    for (const id of ids) {
      if (runners.has(id)) continue;
      const r = new Runner(id);
      // Another process follows it
      if (!(await r.lock().catch(() => false))) continue;
      runners.set(id, r);
      r.start();
    }
  } catch (err) {
    logger.warn('Live sync manager tick failed:', err);
  } finally {
    ticking = false;
  }
}

export function startLiveSyncManager(): void {
  if (timer) return;
  try {
    redis = new Redis(getRedisConfig());
    redis.on('error', (err) => logger.warn('Live sync lock (Redis):', err.message));
  } catch (err) {
    logger.warn('Live sync: no Redis for locks; running without', err);
    redis = null;
  }
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  void tick();
}

export async function stopLiveSyncManager(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  const all = [...runners.values()];
  for (const r of all) r.close();
  await Promise.all(all.map((r) => r.finished));
  await redis?.quit().catch(() => undefined);
  redis = null;
}
