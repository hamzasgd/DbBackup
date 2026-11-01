import { prisma } from '../config/database';
import { engineFactory } from './engines/engine.factory';
import { logger } from '../config/logger';
import { notify } from './notification.service';
import { logAudit } from './audit.service';
import { toEngineConfig } from './engines/connection-config';

const HEARTBEAT_TIMEOUT_MS = 5000;
const PRUNE_DAYS = 7;

export interface HeartbeatSummary {
  checked: number;
  up: number;
  down: number;
}

/**
 * Ping every heartbeat-enabled connection, record the result, and notify +
 * audit on UP↔DOWN transitions (so inboxes stay quiet while status is stable).
 */
export async function runHeartbeatChecks(): Promise<HeartbeatSummary> {
  const conns = await prisma.connection.findMany({
    where: { heartbeatEnabled: true },
  });

  let up = 0;
  let down = 0;

  for (const conn of conns) {
    const prev = await prisma.connectionHeartbeat.findFirst({
      where: { connectionId: conn.id },
      orderBy: { checkedAt: 'desc' },
      select: { status: true },
    });

    let result: { up: boolean; latencyMs: number; error?: string };
    try {
      const engine = engineFactory(toEngineConfig(conn));
      result = await engine.ping(HEARTBEAT_TIMEOUT_MS);
    } catch (e) {
      result = { up: false, latencyMs: 0, error: e instanceof Error ? e.message : String(e) };
    }

    const status = result.up ? 'UP' : 'DOWN';
    await prisma.connectionHeartbeat.create({
      data: {
        connectionId: conn.id,
        status,
        latencyMs: result.up ? result.latencyMs : null,
        error: result.up ? null : (result.error ?? 'unknown error').slice(0, 500),
      },
    });
    if (result.up) up++;
    else down++;

    // Transition → notify + audit (only when the previous status differs)
    if (prev && prev.status !== status) {
      if (status === 'DOWN') {
        await logAudit(conn.userId, 'HEARTBEAT_DOWN', 'connection', {
          connectionId: conn.id, name: conn.name, error: (result.error ?? '').slice(0, 200),
        });
        void notify(conn.userId, {
          event: 'HEARTBEAT_DOWN',
          title: '⚠️ Database Unreachable',
          message: `Connection "${conn.name}" failed its health check.`,
          details: { Connection: conn.name, Error: (result.error ?? '').slice(0, 200) },
        }).catch(() => undefined);
      } else {
        await logAudit(conn.userId, 'HEARTBEAT_RECOVERED', 'connection', {
          connectionId: conn.id, name: conn.name, latencyMs: result.latencyMs,
        });
        void notify(conn.userId, {
          event: 'HEARTBEAT_RECOVERED',
          title: '✅ Database Back Online',
          message: `Connection "${conn.name}" is reachable again (${result.latencyMs} ms).`,
          details: { Connection: conn.name, Latency: `${result.latencyMs} ms` },
        }).catch(() => undefined);
      }
    }
  }

  // Prune history beyond the retention window
  const cutoff = new Date(Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000);
  await prisma.connectionHeartbeat
    .deleteMany({ where: { checkedAt: { lt: cutoff } } })
    .catch((err) => logger.warn('Heartbeat prune failed:', err));

  return { checked: conns.length, up, down };
}

/** Heartbeat summary + recent history for one connection (7-day window). */
export async function getHeartbeatSummary(connectionId: string) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [latest, history, last24h] = await Promise.all([
    prisma.connectionHeartbeat.findFirst({
      where: { connectionId },
      orderBy: { checkedAt: 'desc' },
    }),
    prisma.connectionHeartbeat.findMany({
      where: { connectionId },
      orderBy: { checkedAt: 'desc' },
      take: 200,
    }),
    prisma.connectionHeartbeat.findMany({
      where: { connectionId, checkedAt: { gte: since } },
      select: { status: true, latencyMs: true },
    }),
  ]);

  const checks = last24h.length;
  const upChecks = last24h.filter((h) => h.status === 'UP').length;
  const latencies = last24h.filter((h) => h.status === 'UP' && h.latencyMs != null).map((h) => h.latencyMs as number);

  return {
    latest,
    history,
    stats24h: {
      checks,
      upChecks,
      uptimePercent: checks > 0 ? (upChecks / checks) * 100 : null,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    },
  };
}
