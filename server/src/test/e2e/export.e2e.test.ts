import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exportPostgres, exportMySQL, type ExportFormat } from '../../services/export.service';
import { engineFactory } from '../../services/engines/engine.factory';
import { PG, MARIADB, uniq, engineConfig, pgCreateDb, pgDropDb, pgFingerprint, pgAdmin, myAdmin, myFingerprint, CollectingResponse } from './helpers';
import { seedPostgres, seedMariaDB, BIG } from './seed';

/**
 * Table export streams rows in batches. These tests export the 12,000-row
 * fixture tables and check the output is complete and correct: JSON parses,
 * CSV has one line per row, and the SQL export re-imports into an empty copy
 * of the schema with identical data.
 */

async function collect(fn: (res: CollectingResponse) => Promise<void>, slow = false): Promise<CollectingResponse> {
  const res = new CollectingResponse(slow);
  await fn(res);
  // res.end() was called; with a slow client the last chunks are still being written
  if (!res.writableFinished) await new Promise((resolve) => res.once('finish', resolve));
  return res;
}

/** Number of CSV records (quoted fields may contain newlines). */
function csvRecords(section: string): number {
  let records = 0;
  let inQuotes = false;
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '\n' && !inQuotes) records++;
  }
  return records;
}

describe.skipIf(!PG)('PostgreSQL table export', () => {
  const db = uniq('e2e_exp_pg');
  const cfg = () => engineConfig('POSTGRESQL', PG!, db);

  beforeAll(async () => {
    await pgCreateDb(db);
    await seedPostgres(db);
  });
  afterAll(() => pgDropDb(db));

  it('JSON: valid, complete, one array per table (written with backpressure)', async () => {
    const res = await collect((r) => exportPostgres(cfg(), ['customers', 'orders'], 'json', r.asResponse()), true);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.ended).toBe(true);
    const data = JSON.parse(res.body);
    expect(Object.keys(data)).toEqual(['customers', 'orders']);
    expect(data.customers).toHaveLength(BIG);
    expect(data.orders).toHaveLength(BIG);
    expect(data.customers.find((c: { id: number }) => c.id === 3).name).toBe('Ünïcødé 名前 😀 #3');
    const ids = new Set(data.customers.map((c: { id: number }) => c.id));
    expect(ids.size).toBe(BIG); // no row repeated or skipped across batches
  });

  it('CSV: a header plus one record per row for each table', async () => {
    const res = await collect((r) => exportPostgres(cfg(), ['customers', 'orders'], 'csv', r.asResponse()));
    const [, customers, orders] = res.body.split(/^# TABLE: .*\n/m);
    expect(csvRecords(customers.trimEnd() + '\n')).toBe(BIG + 1);
    expect(csvRecords(orders.trimEnd() + '\n')).toBe(BIG + 1);
  });

  it('SQL: re-imports into an empty copy of the schema with identical data', async () => {
    const res = await collect((r) => exportPostgres(cfg(), ['customers', 'orders'], 'sql', r.asResponse()));
    const target = uniq('e2e_exp_pg_rst');
    await pgCreateDb(target);
    try {
      // Same schema, then empty it: the export must refill it exactly
      const engine = engineFactory(engineConfig('POSTGRESQL', PG!, db));
      const dir = (await import('./helpers')).tmpDir();
      const backup = await engine.backup(dir, { format: 'CUSTOM' });
      await engine.restore(backup.filePath, target);
      await pgAdmin(target, (c) => c.query('ALTER TABLE orders DISABLE TRIGGER USER; TRUNCATE orders, customers'));
      // orders.id is GENERATED ALWAYS; the export carries explicit ids
      const sql = res.body.replace(/INSERT INTO "orders" \(([^)]*)\) VALUES/g, 'INSERT INTO "orders" ($1) OVERRIDING SYSTEM VALUE VALUES');
      await pgAdmin(target, (c) => c.query(sql));
      const a = await pgFingerprint(db);
      const b = await pgFingerprint(target);
      for (const t of ['public.customers', 'public.orders']) expect(b[t]).toBe(a[t]);
    } finally {
      await pgDropDb(target);
    }
  });

  it('table names outside [A-Za-z0-9_$] are rejected (400), as before', async () => {
    await expect(exportPostgres(cfg(), ['Weird Table'], 'json', new CollectingResponse().asResponse())).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each<ExportFormat>(['json', 'csv', 'sql'])('%s: an unknown table is a 404 before anything is sent', async (format) => {
    const res = new CollectingResponse();
    await expect(exportPostgres(cfg(), ['customers', 'missing_table'], format, res.asResponse())).rejects.toMatchObject({ statusCode: 404 });
    expect(res.chunks).toHaveLength(0);
  });

  it('a client that disconnects mid-export stops the export without an error', async () => {
    const res = new CollectingResponse(true);
    const done = exportPostgres(cfg(), ['customers', 'orders'], 'json', res.asResponse());
    setTimeout(() => res.destroy(), 5);
    await expect(done).resolves.toBeUndefined();
    expect(res.body.length).toBeLessThan(1_000_000);
  });
});

describe.skipIf(!MARIADB)('MariaDB table export', () => {
  const db = uniq('e2e_exp_my');
  const cfg = () => engineConfig('MARIADB', MARIADB!, db);

  beforeAll(() => seedMariaDB(db));
  afterAll(() => myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${db}\``)));

  it('JSON: valid and complete', async () => {
    const res = await collect((r) => exportMySQL(cfg(), ['customers', 'orders'], 'json', r.asResponse()), true);
    const data = JSON.parse(res.body);
    expect(data.customers).toHaveLength(BIG);
    expect(new Set(data.orders.map((o: { id: number }) => o.id)).size).toBe(BIG);
  });

  it('CSV: one record per row', async () => {
    const res = await collect((r) => exportMySQL(cfg(), ['customers'], 'csv', r.asResponse()));
    const [, customers] = res.body.split(/^# TABLE: .*\n/m);
    expect(csvRecords(customers.trimEnd() + '\n')).toBe(BIG + 1);
  });

  it('SQL: re-imports with identical data (quotes, backslashes, binary, JSON, emoji)', async () => {
    const res = await collect((r) => exportMySQL(cfg(), ['customers', 'orders'], 'sql', r.asResponse()));
    const target = uniq('e2e_exp_my_rst');
    try {
      await myAdmin(async (c) => {
        await c.query(`CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        const [[cust]] = await c.query<any[]>(`SHOW CREATE TABLE \`${db}\`.customers`);
        const [[ord]] = await c.query<any[]>(`SHOW CREATE TABLE \`${db}\`.orders`);
        await c.query(`USE \`${target}\``);
        await c.query(cust['Create Table']);
        await c.query(ord['Create Table']);
        await c.query(`SET NAMES utf8mb4; START TRANSACTION; ${res.body} COMMIT;`);
      }, db);
      const a = await myFingerprint(db);
      const b = await myFingerprint(target);
      expect(b.customers).toBe(a.customers);
      expect(b.orders).toBe(a.orders);
    } finally {
      await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${target}\``));
    }
  });
});
