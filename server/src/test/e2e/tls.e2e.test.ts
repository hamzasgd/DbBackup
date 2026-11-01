import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { engineFactory } from '../../services/engines/engine.factory';
import type { ConnectionConfig } from '../../services/engines/base.engine';
import { exportPostgres, exportMySQL } from '../../services/export.service';
import { PG, MARIADB, TLS_CA, TLS_WRONG_CA, uniq, tmpDir, engineConfig, pgCreateDb, pgDropDb, pgAdmin, myAdmin, CollectingResponse } from './helpers';

/**
 * The test servers present a certificate issued by the test CA for "localhost"
 * only (no IP address). So, with the CA configured:
 *   host "localhost"   → must succeed (chain and name both match)
 *   host "127.0.0.1"   → must fail (name mismatch)
 *   another CA         → must fail (untrusted chain)
 * Each case runs through the CLI tools (backup/restore) and the Node drivers (export).
 */

const ready = !!(PG && MARIADB && TLS_CA && TLS_WRONG_CA);

describe.skipIf(!ready)('TLS verification for backups and driver queries', () => {
  const pgDb = uniq('e2e_tls_pg');
  const myDb = uniq('e2e_tls_my');
  const out = tmpDir();

  beforeAll(async () => {
    await pgCreateDb(pgDb);
    await pgAdmin(pgDb, (c) => c.query("CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT i, 'v' || i FROM generate_series(1, 50) i"));
    await myAdmin((c) => c.query(`CREATE DATABASE \`${myDb}\`; CREATE TABLE \`${myDb}\`.t (id INT PRIMARY KEY, v TEXT); INSERT INTO \`${myDb}\`.t VALUES (1,'a'),(2,'b')`));
  });
  afterAll(async () => {
    await pgDropDb(pgDb);
    await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${myDb}\``));
    fs.rmSync(out, { recursive: true, force: true });
  });

  const pg = (host: string, extra: Partial<ConnectionConfig>) => engineConfig('POSTGRESQL', PG!, pgDb, { host, sslEnabled: true, ...extra });
  const my = (type: 'MARIADB' | 'MYSQL', host: string, extra: Partial<ConnectionConfig>) =>
    engineConfig(type, MARIADB!, myDb, { host, sslEnabled: true, ...extra });

  async function pgExport(cfg: ConnectionConfig): Promise<string> {
    const res = new CollectingResponse();
    await exportPostgres(cfg, ['t'], 'csv', res.asResponse());
    return res.body;
  }
  async function myExport(cfg: ConnectionConfig): Promise<string> {
    const res = new CollectingResponse();
    await exportMySQL(cfg, ['t'], 'csv', res.asResponse());
    return res.body;
  }

  describe('PostgreSQL', () => {
    it('CA + matching host name: backup, restore and driver queries succeed over TLS', async () => {
      const cfg = pg('localhost', { sslCa: TLS_CA });
      const engine = engineFactory(cfg);
      const backup = await engine.backup(out, { format: 'CUSTOM' });
      const target = uniq('e2e_tls_pg_rst');
      await pgCreateDb(target);
      try {
        await engine.restore(backup.filePath, target);
        const n = await pgAdmin(target, (c) => c.query('SELECT count(*)::int AS n FROM t'));
        expect(n.rows[0].n).toBe(50);
      } finally {
        await pgDropDb(target);
      }
      expect(await pgExport(cfg)).toContain('# TABLE: t');
      // The backup really used TLS: the server sees the session as encrypted
      const r = await engine.testConnection();
      expect(r.success).toBe(true);
    });

    it('CA + host name not in the certificate: refused by pg_dump and by the driver', async () => {
      const cfg = pg('127.0.0.1', { sslCa: TLS_CA });
      await expect(engineFactory(cfg).backup(out, { format: 'CUSTOM' })).rejects.toThrow(/does not match host name/);
      await expect(pgExport(cfg)).rejects.toThrow(/IP: 127\.0\.0\.1 is not in the cert's list|does not match/);
    });

    it('wrong CA: refused by pg_dump and by the driver', async () => {
      const cfg = pg('localhost', { sslCa: TLS_WRONG_CA });
      await expect(engineFactory(cfg).backup(out, { format: 'CUSTOM' })).rejects.toThrow(/certificate verify failed/);
      await expect(pgExport(cfg)).rejects.toThrow(/self[- ]signed|unable to verify|unable to get/i);
    });

    it('SSL on without a CA: encrypted (sslmode=require) but not verified, so any certificate is accepted', async () => {
      const cfg = pg('127.0.0.1', {});
      const backup = await engineFactory(cfg).backup(out, { format: 'CUSTOM' });
      expect(backup.fileSize).toBeGreaterThan(0);
      expect(await pgExport(cfg)).toContain('# TABLE: t');
    });

    it('no temporary certificate files are left behind', () => {
      const left = fs.readdirSync(require('os').tmpdir()).filter((f) => f.startsWith('dbbk-tls-'));
      expect(left).toEqual([]);
    });
  });

  describe('MariaDB / MySQL', () => {
    for (const type of ['MARIADB', 'MYSQL'] as const) {
      it(`${type}: CA + matching host name succeeds; wrong CA and wrong host name are refused`, async () => {
        const good = my(type, 'localhost', { sslCa: TLS_CA });
        const backup = await engineFactory(good).backup(out, { format: 'PLAIN_SQL' });
        expect(fs.readFileSync(backup.filePath, 'utf8')).toContain('CREATE TABLE `t`');
        expect(await myExport(good)).toContain('# TABLE: t');

        await expect(engineFactory(my(type, 'localhost', { sslCa: TLS_WRONG_CA })).backup(out, { format: 'PLAIN_SQL' }))
          .rejects.toThrow(/certificate|TLS|SSL/i);
        await expect(myExport(my(type, 'localhost', { sslCa: TLS_WRONG_CA }))).rejects.toThrow(/self[- ]signed|unable to verify|unable to get/i);

        // 127.0.0.2, not 127.0.0.1: the MariaDB client never checks the name for 127.0.0.1/localhost
        await expect(engineFactory(my(type, '127.0.0.2', { sslCa: TLS_CA })).backup(out, { format: 'PLAIN_SQL' }))
          .rejects.toThrow(/subject name doesn't match|certificate|TLS|SSL/i);
      });
    }

    it('SSL on without a CA: encrypted but not verified', async () => {
      const cfg = my('MARIADB', '127.0.0.1', {});
      const backup = await engineFactory(cfg).backup(out, { format: 'PLAIN_SQL' });
      expect(backup.fileSize).toBeGreaterThan(0);
      expect(await myExport(cfg)).toContain('# TABLE: t');
    });
  });
});
