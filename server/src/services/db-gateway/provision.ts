import crypto from 'crypto';
import type mysql2 from 'mysql2/promise';
import { ConnectionFactory } from '../engines/connection-factory';
import type { ConnectionConfig } from '../engines/base.engine';
import { randomPassword } from './protocol';

/** Rights that can be given on a whole database */
export const DATABASE_PRIVILEGES = [
  'SELECT', 'SHOW VIEW', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'INDEX', 'REFERENCES',
  'CREATE VIEW', 'TRIGGER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE', 'CREATE ROUTINE',
  'ALTER ROUTINE', 'EVENT',
] as const;

/** Rights that can be given on single tables */
export const TABLE_PRIVILEGES = [
  'SELECT', 'SHOW VIEW', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'INDEX', 'REFERENCES',
  'CREATE VIEW', 'TRIGGER',
] as const;

/** Rights that only read */
export const READ_PRIVILEGES = new Set(['SELECT', 'SHOW VIEW']);

export const PRESETS: Record<string, string[]> = {
  read: ['SELECT', 'SHOW VIEW'],
  write: ['SELECT', 'SHOW VIEW', 'INSERT', 'UPDATE', 'DELETE', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE'],
  full: [...DATABASE_PRIVILEGES],
};

export class ProvisionError extends Error {}

export interface Grant {
  database: string;
  /** Empty: the whole database */
  tables: string[];
  privileges: string[];
  maxConnections: number;
}

/** The rights, checked against the list for the scope, in a fixed order */
export function normalizePrivileges(privileges: string[], tablesChosen: boolean): string[] {
  const allowed: readonly string[] = tablesChosen ? TABLE_PRIVILEGES : DATABASE_PRIVILEGES;
  const wanted = new Set(privileges.map((p) => p.trim().toUpperCase()));
  for (const p of wanted) {
    if (!allowed.includes(p)) {
      throw new ProvisionError(tablesChosen && DATABASE_PRIVILEGES.includes(p as never)
        ? `${p} can only be given on the whole database, not on single tables`
        : `Unknown right: ${p}`);
    }
  }
  const list = allowed.filter((p) => wanted.has(p));
  if (!list.length) throw new ProvisionError('Choose at least one right');
  return list;
}

export const onlyReads = (privileges: string[]) => privileges.every((p) => READ_PRIVILEGES.has(p));

const qid = (name: string) => `\`${name.replace(/`/g, '``')}\``;

function grantStatements(g: Grant): string[] {
  const privs = g.privileges.join(', ');
  if (!g.tables.length) return [`GRANT ${privs} ON ${qid(g.database)}.* TO ?@?`];
  return g.tables.map((t) => `GRANT ${privs} ON ${qid(g.database)}.${qid(t)} TO ?@?`);
}

function explain(e: unknown): ProvisionError {
  const err = e as { errno?: number; message?: string };
  if (err.errno === 1227 || err.errno === 1044 || err.errno === 1045 || err.errno === 1410 || err.errno === 1142) {
    return new ProvisionError(
      `The connection's database user may not create users or give these rights (${err.message}). ` +
      'Use a connection whose user has CREATE USER and the rights to give WITH GRANT OPTION (e.g. root).',
    );
  }
  return new ProvisionError(err.message ?? String(e));
}

async function withAdmin<T>(config: ConnectionConfig, fn: (c: mysql2.Connection) => Promise<T>): Promise<T> {
  const r = await ConnectionFactory.createMySQLConnection(config);
  try {
    return await fn(r.connection);
  } finally {
    await ConnectionFactory.closeMySQLConnection(r).catch(() => {});
  }
}

/**
 * Create the database user behind an access. Its host is the address the
 * database sees DbBackup connect from (through the SSH tunnel, if any), so the
 * user can only log in from there.
 */
export async function createBackendUser(config: ConnectionConfig, g: Grant): Promise<{ user: string; host: string; password: string }> {
  return withAdmin(config, async (c) => {
    try {
      const [who] = await c.query<mysql2.RowDataPacket[]>('SELECT USER() AS u');
      const u = String(who[0].u);
      const host = u.slice(u.lastIndexOf('@') + 1) || '%';
      const user = `dbb_${crypto.randomBytes(6).toString('hex')}`;
      const password = randomPassword(32);
      await c.query(`CREATE USER ?@? IDENTIFIED BY ? WITH MAX_USER_CONNECTIONS ${Math.floor(g.maxConnections) + 1}`, [user, host, password]);
      try {
        for (const sql of grantStatements(g)) await c.query(sql, [user, host]);
      } catch (e) {
        await c.query('DROP USER IF EXISTS ?@?', [user, host]).catch(() => {});
        throw e;
      }
      return { user, host, password };
    } catch (e) {
      throw explain(e);
    }
  });
}

/** Replace the rights of an existing database user */
export async function updateBackendUser(config: ConnectionConfig, user: string, host: string, g: Grant): Promise<void> {
  await withAdmin(config, async (c) => {
    try {
      await c.query('REVOKE ALL PRIVILEGES, GRANT OPTION FROM ?@?', [user, host]);
      for (const sql of grantStatements(g)) await c.query(sql, [user, host]);
      await c.query(`ALTER USER ?@? WITH MAX_USER_CONNECTIONS ${Math.floor(g.maxConnections) + 1}`, [user, host]);
    } catch (e) {
      throw explain(e);
    }
  });
}

export async function dropBackendUser(config: ConnectionConfig, user: string, host: string): Promise<void> {
  await withAdmin(config, async (c) => {
    try {
      await c.query('DROP USER IF EXISTS ?@?', [user, host]);
    } catch (e) {
      throw explain(e);
    }
  });
}

/** Tables of a database, for choosing some */
export async function listTables(config: ConnectionConfig, database: string): Promise<string[]> {
  return withAdmin(config, async (c) => {
    const [rows] = await c.query<mysql2.RowDataPacket[]>(
      'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [database]);
    return rows.map((r) => String(r.t));
  });
}
