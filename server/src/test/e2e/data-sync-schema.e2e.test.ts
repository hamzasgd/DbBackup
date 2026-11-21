import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type mysql2 from 'mysql2/promise';
import { mysqlDataSync, type TableReport } from '../../services/data-sync/mysql-data-sync';
import type { SchemaReport } from '../../services/data-sync/mysql-schema';
import { MARIADB, uniq, engineConfig, myAdmin } from './helpers';

/** Schema before rows: additions only, nothing on the target removed or changed (E2E_MARIADB_URL). */
describe.skipIf(!MARIADB)('MySQL data sync: schema', () => {
  const src = uniq('e2e_schema_src');
  const dst = uniq('e2e_schema_dst');
  const cfg = (db: string) => engineConfig('MYSQL', MARIADB!, db);
  const byTable = (r: TableReport[]) => Object.fromEntries(r.map((x) => [x.table, x]));
  const q = <T = mysql2.RowDataPacket>(sql: string) => myAdmin(async (c) => (await c.query(sql))[0] as T[]);
  const create = async (db: string, t: string) => (await q<{ 'Create Table': string }>(`SHOW CREATE TABLE \`${db}\`.\`${t}\``))[0]['Create Table'];

  beforeAll(async () => {
    await myAdmin(async (c) => {
      await c.query(`CREATE DATABASE \`${src}\`; CREATE DATABASE \`${dst}\``);
      for (const db of [src, dst]) {
        await c.query(`CREATE TABLE \`${db}\`.parent (id INT PRIMARY KEY)`);
        await c.query(`INSERT INTO \`${db}\`.parent VALUES (1), (2)`);
      }
      await c.query(`
        CREATE TABLE \`${src}\`.grow (id INT PRIMARY KEY, parent_id INT NOT NULL, v VARCHAR(20) NOT NULL,
          added VARCHAR(30) NOT NULL DEFAULT 'none', updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          KEY grow_updated_at (updatedAt), UNIQUE KEY grow_v (v),
          CONSTRAINT grow_parent FOREIGN KEY (parent_id) REFERENCES parent (id) ON DELETE CASCADE);
        CREATE TABLE \`${dst}\`.grow (id INT PRIMARY KEY, parent_id INT NOT NULL, v VARCHAR(20) NOT NULL,
          updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3));
        CREATE TABLE \`${src}\`.extra (id INT PRIMARY KEY, v INT);
        CREATE TABLE \`${dst}\`.extra (id INT PRIMARY KEY, v INT, local_note VARCHAR(40), KEY extra_local (local_note));
        CREATE TABLE \`${src}\`.typechg (id INT PRIMARY KEY, amount DECIMAL(12,2));
        CREATE TABLE \`${dst}\`.typechg (id INT PRIMARY KEY, amount DECIMAL(10,2));
        CREATE TABLE \`${src}\`.newtab (id INT PRIMARY KEY, parent_id INT, CONSTRAINT newtab_parent FOREIGN KEY (parent_id) REFERENCES parent (id));
        CREATE TABLE \`${dst}\`.only_dst (id INT PRIMARY KEY);
        INSERT INTO \`${src}\`.grow (id, parent_id, v, added, updatedAt) VALUES (1, 1, 'a', 'first', '2026-01-01 00:00:00'), (2, 2, 'b', 'second', '2026-01-02 00:00:00');
        INSERT INTO \`${dst}\`.grow (id, parent_id, v, updatedAt) VALUES (1, 1, 'a', '2026-01-01 00:00:00'), (2, 2, 'b', '2026-01-02 00:00:00');
        INSERT INTO \`${src}\`.extra VALUES (1, 10);
        INSERT INTO \`${dst}\`.extra VALUES (1, 10, 'kept on the target');
        INSERT INTO \`${src}\`.typechg VALUES (1, 12345678.90);
        INSERT INTO \`${dst}\`.typechg VALUES (1, 5.50);
        INSERT INTO \`${src}\`.newtab VALUES (1, 1);
        INSERT INTO \`${dst}\`.only_dst VALUES (7);
      `);
    });
  });

  afterAll(async () => {
    await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${src}\`; DROP DATABASE IF EXISTS \`${dst}\``));
  });

  it('compare lists what would be added and what differs, and changes nothing', async () => {
    const before = await Promise.all(['grow', 'extra', 'typechg', 'only_dst'].map((t) => create(dst, t)));
    let schema: SchemaReport | null = null;
    await mysqlDataSync(cfg(src), cfg(dst), { apply: false, onSchema: (r) => { schema = r; } });
    const s = schema as unknown as SchemaReport;
    const changes = s.changes.map((c) => `${c.kind} ${c.table}.${c.name}`).sort();
    expect(changes).toEqual([
      // MySQL gave the source's foreign key its own index (grow_parent), so that index is added too
      'ADD_COLUMN grow.added', 'ADD_FOREIGN_KEY grow.grow_parent', 'ADD_INDEX grow.grow_parent', 'ADD_INDEX grow.grow_updated_at', 'ADD_INDEX grow.grow_v',
      'CREATE_TABLE newtab.newtab',
    ]);
    const notes = s.notes.map((n) => `${n.kind} ${n.table}.${n.name}`).sort();
    expect(notes).toEqual([
      'COLUMN_DIFFERS typechg.amount', 'COLUMN_ONLY_ON_TARGET extra.local_note', 'INDEX_ONLY_ON_TARGET extra.extra_local',
      'TABLE_ONLY_ON_TARGET only_dst.only_dst',
    ]);
    expect(s.notes.find((n) => n.kind === 'COLUMN_DIFFERS')!.suggestedSql).toMatch(/MODIFY COLUMN `amount` decimal\(12,2\)/i);
    expect(await Promise.all(['grow', 'extra', 'typechg', 'only_dst'].map((t) => create(dst, t)))).toEqual(before);
    expect((await q(`SHOW TABLES FROM \`${dst}\` LIKE 'newtab'`)).length).toBe(0);
  });

  it('sync adds the missing schema, then the rows, and removes or changes nothing on the target', async () => {
    let schema: SchemaReport | null = null;
    const r = byTable(await mysqlDataSync(cfg(src), cfg(dst), { apply: true, onSchema: (x) => { schema = x; } }));
    const s = schema as unknown as SchemaReport;
    expect(s.changes.every((c) => c.status === 'APPLIED')).toBe(true);

    // Added: the column (values copied by the data sync), indexes, foreign key, the new table and its rows
    const grow = await create(dst, 'grow');
    expect(grow).toMatch(/`added` varchar\(30\)[^,\n]* NOT NULL DEFAULT 'none'/);
    expect(grow).toMatch(/KEY `grow_updated_at`/);
    expect(grow).toMatch(/UNIQUE KEY `grow_v`/);
    expect(grow).toMatch(/CONSTRAINT `grow_parent` FOREIGN KEY/);
    expect(grow.indexOf('`added`')).toBeLessThan(grow.indexOf('`updatedAt`'));
    expect(r.grow).toMatchObject({ status: 'SYNCED', updated: 2 });
    expect((await q(`SELECT id, added FROM \`${dst}\`.grow ORDER BY id`)).map((x) => x.added)).toEqual(['first', 'second']);
    expect(r.newtab.status).toBe('SYNCED');
    expect((await q(`SELECT * FROM \`${dst}\`.newtab`)).length).toBe(1);

    // Nothing lost: the target's own column, index, table and values are all still there
    expect(await create(dst, 'extra')).toMatch(/`local_note`[\s\S]*KEY `extra_local`/);
    expect(r.extra.status).toBe('SKIPPED'); // its columns still differ, so its rows aren't touched
    expect((await q(`SELECT local_note FROM \`${dst}\`.extra`))[0].local_note).toBe('kept on the target');
    expect(await create(dst, 'typechg')).toMatch(/`amount` decimal\(10,2\)/);
    expect(r.typechg.status).toBe('SKIPPED');
    expect(String((await q(`SELECT amount FROM \`${dst}\`.typechg`))[0].amount)).toBe('5.50');
    expect((await q(`SELECT * FROM \`${dst}\`.only_dst`)).length).toBe(1);

    // Running it again finds nothing left to add
    let again: SchemaReport | null = null;
    await mysqlDataSync(cfg(src), cfg(dst), { apply: false, onSchema: (x) => { again = x; } });
    expect((again as unknown as SchemaReport).changes).toEqual([]);
  });
});
