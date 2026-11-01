import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { EventEmitter } from 'events';
import type { Response } from 'express';
import { Client as PgClient } from 'pg';
import mysql2 from 'mysql2/promise';
import type { ConnectionConfig } from '../../services/engines/base.engine';

/** Parsed E2E_* URL, or null when the suite should be skipped. */
export function dbUrl(name: string): URL | null {
  const raw = process.env[name];
  return raw ? new URL(raw) : null;
}

export const PG = dbUrl('E2E_POSTGRES_URL');
export const MARIADB = dbUrl('E2E_MARIADB_URL');
export const MONGO = dbUrl('E2E_MONGODB_URL');
export const REDIS = dbUrl('E2E_REDIS_URL');
export const APP_DB = process.env.E2E_APP_DATABASE_URL ?? null;
export const TLS_CA = process.env.E2E_TLS_CA_FILE ? fs.readFileSync(process.env.E2E_TLS_CA_FILE, 'utf8') : null;
export const TLS_WRONG_CA = process.env.E2E_TLS_WRONG_CA_FILE ? fs.readFileSync(process.env.E2E_TLS_WRONG_CA_FILE, 'utf8') : null;

/** Short random suffix so test databases never collide with real ones or with each other. */
export function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function tmpDir(prefix = 'dbbk-e2e-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function engineConfig(
  type: ConnectionConfig['type'],
  url: URL,
  database: string,
  extra: Partial<ConnectionConfig> = {},
): ConnectionConfig {
  return {
    type,
    host: url.hostname,
    port: Number(url.port),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password) || undefined,
    database,
    ...extra,
  };
}

// ── Postgres admin helpers

export async function pgAdmin<T>(database: string, fn: (c: PgClient) => Promise<T>): Promise<T> {
  const c = new PgClient({
    host: PG!.hostname, port: Number(PG!.port), user: decodeURIComponent(PG!.username),
    password: decodeURIComponent(PG!.password), database,
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function pgCreateDb(name: string): Promise<void> {
  await pgAdmin('postgres', (c) => c.query(`CREATE DATABASE "${name}"`));
}

export async function pgDropDb(name: string): Promise<void> {
  await pgAdmin('postgres', (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

/**
 * Content fingerprint of every user table: md5 over the text form of all rows
 * in a stable order. Identical fingerprints mean identical data.
 */
export async function pgFingerprint(database: string): Promise<Record<string, string>> {
  return pgAdmin(database, async (c) => {
    const { rows } = await c.query(
      `SELECT n.nspname AS s, c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY 1, 2`,
    );
    const out: Record<string, string> = {};
    for (const { s, t } of rows) {
      const q = `"${s.replace(/"/g, '""')}"."${t.replace(/"/g, '""')}"`;
      const r = await c.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${q} x`);
      out[`${s}.${t}`] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    return out;
  });
}

// ── MariaDB admin helpers

export async function myAdmin<T>(fn: (c: mysql2.Connection) => Promise<T>, database?: string): Promise<T> {
  const c = await mysql2.createConnection({
    host: MARIADB!.hostname, port: Number(MARIADB!.port), user: decodeURIComponent(MARIADB!.username),
    password: decodeURIComponent(MARIADB!.password), database, multipleStatements: true,
  });
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** CHECKSUM TABLE for every base table, plus routine/trigger names, so schema objects are compared too. */
export async function myFingerprint(database: string): Promise<Record<string, string>> {
  return myAdmin(async (c) => {
    const [tables] = await c.query<mysql2.RowDataPacket[]>(
      "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1",
      [database],
    );
    const out: Record<string, string> = {};
    for (const { t } of tables) {
      const [[cnt]] = await c.query<mysql2.RowDataPacket[]>('SELECT COUNT(*) AS n FROM ??.??', [database, t]);
      const [[sum]] = await c.query<mysql2.RowDataPacket[]>('CHECKSUM TABLE ??.?? EXTENDED', [database, t]);
      out[t] = `${cnt.n}:${sum.Checksum}`;
    }
    const [routines] = await c.query<mysql2.RowDataPacket[]>(
      'SELECT ROUTINE_NAME AS r FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY 1', [database]);
    const [triggers] = await c.query<mysql2.RowDataPacket[]>(
      'SELECT TRIGGER_NAME AS t FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY 1', [database]);
    out['@routines'] = routines.map((r) => r.r).join(',');
    out['@triggers'] = triggers.map((r) => r.t).join(',');
    return out;
  });
}

// ── Fake Express response that collects a streamed body

export class CollectingResponse extends Writable {
  chunks: Buffer[] = [];
  headers: Record<string, string> = {};
  headersSent = false;
  ended = false;
  /** Max bytes buffered before write() reports backpressure (exercises the drain path). */
  constructor(private readonly slow = false) {
    super({ highWaterMark: 16 * 1024 });
  }
  setHeader(name: string, value: string): this { this.headers[name.toLowerCase()] = value; return this; }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    if (this.slow) setTimeout(() => cb(), 0); else cb();
  }
  _final(cb: () => void): void { this.ended = true; cb(); }
  get body(): string { return Buffer.concat(this.chunks).toString('utf8'); }
  asResponse(): Response { return this as unknown as Response; }
}

export function onceEvent(emitter: EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}
