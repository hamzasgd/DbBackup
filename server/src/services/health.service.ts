import { prisma } from '../config/database';
import { getRedis } from '../config/redis';

let workersStarted = false;

export function markWorkersStarted(): void {
  workersStarted = true;
}

type CheckResult = { ok: boolean; latencyMs: number; error?: string };

async function timed(check: () => Promise<unknown>, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Readiness for /health: the app database, Redis (job queues) and the queue
 * workers. Any failure makes the endpoint return 503 so an external uptime
 * monitor raises an alert even when the app cannot send one itself.
 */
export async function checkHealth(timeoutMs = 3000) {
  const [database, redis] = await Promise.all([
    timed(() => prisma.$queryRaw`SELECT 1`, timeoutMs),
    timed(async () => {
      const reply = await getRedis().ping();
      if (reply !== 'PONG') throw new Error(`unexpected reply ${reply}`);
    }, timeoutMs),
  ]);
  const workers = { ok: workersStarted };
  const ok = database.ok && redis.ok && workers.ok;
  return {
    status: ok ? 'ok' : 'error',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks: { database, redis, workers },
  };
}
