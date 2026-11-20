import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { toEngineConfig, type StoredConnection } from './engines/connection-config';
import type { ConnectionConfig } from './engines/base.engine';
import { logger } from '../config/logger';

/**
 * Checks done before a restore starts, so a restore can't silently overwrite
 * the live database a backup was taken from.
 *
 * "Same database" is decided two ways: the target is the backup's own
 * connection (and the same database name), or another connection that points
 * at the same place (same host, port and database). A false alarm costs the
 * user one typed confirmation; a miss costs their data, so the address match
 * errs towards "same".
 */

/** Backups of one family restore into connections of the same family. */
export function dbFamily(type: string): string {
  return type === 'MARIADB' ? 'MYSQL' : type;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function normHost(host: string | undefined | null): string {
  const h = (host ?? '').trim().toLowerCase().replace(/\.$/, '');
  return LOOPBACK.has(h) ? 'loopback' : h;
}

/**
 * Hosts whose meaning depends on the network you reach them from: loopback,
 * private and link-local IPs, and single-label names (Docker service names
 * like "db"). The same name behind two different SSH servers can be two
 * different databases. A public DNS name (an RDS endpoint) or public IP means
 * the same server whichever way you get there.
 */
export function isNetworkLocalHost(host: string): boolean {
  const h = normHost(host);
  if (h === 'loopback') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.includes(':')) return /^\[?(fc|fd|fe8|fe9|fea|feb)/.test(h); // IPv6 ULA / link-local
  return !h.includes('.');
}

type AddressFields = Pick<ConnectionConfig, 'type' | 'host' | 'port' | 'sshEnabled' | 'sshHost' | 'sshPort'>;

/** Where a database lives: two equal keys mean the same database. */
export function databaseAddress(cfg: AddressFields, database: string): string {
  const via = isNetworkLocalHost(cfg.host)
    ? (cfg.sshEnabled && cfg.sshHost ? `ssh:${normHost(cfg.sshHost)}:${cfg.sshPort || 22}` : 'direct')
    : 'any';
  // Database names compared case-insensitively: when unsure, warn
  return [dbFamily(cfg.type), via, normHost(cfg.host), cfg.port, database.toLowerCase()].join('|');
}

export interface RestoreTargetCheck {
  backup: {
    id: string;
    dbName: string;
    dbType: string;
    label: string;
    createdAt: Date;
    fileSize: string;
    sourceConnectionId: string | null;
    sourceName: string | null;
  };
  target: { connectionId: string; name: string; type: string; database: string; sshEnabled: boolean };
  /** The target is the database this backup was taken from */
  overwritesSource: boolean;
  /** Why the target counts as the source: same connection, or another connection to the same place */
  overwritesSourceReason: 'same-connection' | 'same-address' | null;
  /** Set when the backup can't be restored into this target at all */
  incompatible: string | null;
  /** A restore already queued or running into the same target */
  busy: { restoreId: string; status: string } | null;
}

function safeConfig(conn: StoredConnection): ConnectionConfig | null {
  try {
    return toEngineConfig(conn);
  } catch (err) {
    logger.warn(`Restore check: could not read connection ${conn.id}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function backupLabel(b: { dbName: string; snapshotName?: string | null }): string {
  return b.snapshotName ? `${b.snapshotName} (${b.dbName})` : b.dbName;
}

export async function checkRestoreTarget(
  userId: string,
  backupId: string,
  targetConnectionId?: string,
  targetDatabase?: string,
): Promise<RestoreTargetCheck> {
  const backup = await prisma.backup.findFirst({
    where: { id: backupId, userId },
    include: { connection: true },
  });
  if (!backup) throw new AppError('Backup not found', 404, 'NOT_FOUND');
  if (backup.status !== 'COMPLETED') throw new AppError('Backup is not in completed state', 400, 'BACKUP_NOT_COMPLETED');

  const connId = targetConnectionId || backup.connectionId;
  if (!connId) {
    throw new AppError('This backup has no source connection — select a target connection to restore', 400, 'TARGET_REQUIRED');
  }
  const target = await prisma.connection.findFirst({ where: { id: connId, userId } });
  if (!target) throw new AppError('Target connection not found', 404, 'NOT_FOUND');

  const targetCfg = safeConfig(target);
  if (!targetCfg) throw new AppError('The target connection’s settings could not be read', 400, 'TARGET_INVALID');
  const database = targetDatabase || targetCfg.database;

  let reason: RestoreTargetCheck['overwritesSourceReason'] = null;
  if (backup.connectionId === target.id && database.toLowerCase() === backup.dbName.toLowerCase()) {
    reason = 'same-connection';
  } else if (backup.connection) {
    const srcCfg = safeConfig(backup.connection);
    if (srcCfg && databaseAddress(srcCfg, backup.dbName) === databaseAddress(targetCfg, database)) {
      reason = 'same-address';
    }
  }

  const incompatible = dbFamily(backup.dbType) === dbFamily(target.type)
    ? null
    : `This is a ${backup.dbType} backup and "${target.name}" is a ${target.type} database: it can't be restored there.`;

  const running = await prisma.restore.findFirst({
    where: {
      userId,
      targetConnectionId: target.id,
      targetDatabase: { equals: database, mode: 'insensitive' },
      status: { in: ['PENDING', 'RUNNING'] },
    },
    select: { id: true, status: true },
  });

  return {
    backup: {
      id: backup.id,
      dbName: backup.dbName,
      dbType: backup.dbType,
      label: backupLabel(backup),
      createdAt: backup.createdAt,
      fileSize: backup.fileSize.toString(),
      sourceConnectionId: backup.connectionId,
      sourceName: backup.connection?.name ?? null,
    },
    target: { connectionId: target.id, name: target.name, type: target.type, database, sshEnabled: target.sshEnabled },
    overwritesSource: reason !== null,
    overwritesSourceReason: reason,
    incompatible,
    busy: running ? { restoreId: running.id, status: running.status } : null,
  };
}
