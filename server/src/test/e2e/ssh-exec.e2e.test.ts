import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { engineFactory } from '../../services/engines/engine.factory';
import type { BackupFormat, ConnectionConfig } from '../../services/engines/base.engine';
import { SshExec } from '../../services/ssh.service';
import { MARIADB, uniq, tmpDir, engineConfig, myAdmin, myFingerprint } from './helpers';

/**
 * "Run on the SSH server" strategy against a real OpenSSH server.
 *
 * E2E_SSH_EXEC_URL       ssh://user@host:port of a server with mysql, mysqldump and gzip
 * E2E_SSH_EXEC_KEY_FILE  private key accepted by that user
 * E2E_MARIADB_URL        the database, reachable at that host:port from the SSH server too
 */
const SSH = process.env.E2E_SSH_EXEC_URL ? new URL(process.env.E2E_SSH_EXEC_URL) : null;
const KEY = process.env.E2E_SSH_EXEC_KEY_FILE;

describe.skipIf(!SSH || !KEY || !MARIADB)('MySQL backup and restore run on the SSH server', () => {
  const source = uniq('e2e_sshx_src');
  const out = tmpDir();
  let cfg: (db: string) => ConnectionConfig;
  let expected: Record<string, string>;

  beforeAll(async () => {
    cfg = (db: string) => engineConfig('MYSQL', MARIADB!, db, {
      sshEnabled: true,
      sshHost: SSH!.hostname,
      sshPort: Number(SSH!.port) || 22,
      sshUsername: decodeURIComponent(SSH!.username),
      sshPrivateKey: fs.readFileSync(KEY!, 'utf8'),
    });
    await myAdmin(async (c) => {
      await c.query(`CREATE DATABASE \`${source}\``);
      await c.query(`
        CREATE TABLE \`${source}\`.items (id INT PRIMARY KEY AUTO_INCREMENT, label TEXT, raw VARBINARY(16), n INT);
        CREATE TABLE \`${source}\`.tiers (id INT PRIMARY KEY, name VARCHAR(20));
        INSERT INTO \`${source}\`.tiers VALUES (1, 'Silver'), (2, 'Gold');
        CREATE TRIGGER \`${source}\`.items_touch BEFORE INSERT ON \`${source}\`.items FOR EACH ROW SET NEW.n = IFNULL(NEW.n, 7);
      `);
      const rows = Array.from({ length: 5000 }, (_, i) => [`row ${i} it's "quoted" \\ back ${'x'.repeat(i % 50)}`, Buffer.from([i % 256, 0, 255, 39, 34, 92]), i]);
      await c.query(`INSERT INTO \`${source}\`.items (label, raw, n) VALUES ?`, [rows]);
    });
    expected = await myFingerprint(source);
  });

  afterAll(async () => {
    await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${source}\``));
    fs.rmSync(out, { recursive: true, force: true });
  });

  it.each<BackupFormat>(['COMPRESSED_SQL', 'PLAIN_SQL'])('%s: dump and restore on the SSH server give an identical database', async (format) => {
    const sizes: number[] = [];
    const backup = await engineFactory(cfg(source)).backup(out, { format, strategy: 'SSH_SERVER', onBytes: (n) => sizes.push(n) });
    expect(backup.fileName).toMatch(format === 'PLAIN_SQL' ? /\.sql$/ : /\.sql\.gz$/);
    expect(sizes.at(-1)).toBe(backup.fileSize);

    const target = uniq('e2e_sshx_dst');
    await myAdmin((c) => c.query(`CREATE DATABASE \`${target}\``));
    try {
      const read: number[] = [];
      await engineFactory(cfg(source)).restore(backup.filePath, target, { strategy: 'SSH_SERVER', onBytes: (n) => read.push(n) });
      expect(read.at(-1)).toBe(backup.fileSize);
      expect(await myFingerprint(target)).toEqual(expected);
    } finally {
      await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${target}\``));
    }
  });

  it('reports database errors and leaves no temp files on the SSH server', async () => {
    const bad = { ...cfg(source), password: 'definitely-wrong' };
    await expect(engineFactory(bad).backup(out, { format: 'COMPRESSED_SQL', strategy: 'SSH_SERVER' }))
      .rejects.toThrow(/mysqldump on the SSH server failed \(exit \d+\): .*Access denied/);

    const ssh = new SshExec(cfg(source));
    await ssh.connect();
    try {
      const res = await ssh.run('ls -d "${TMPDIR:-/tmp}"/dbbackup.* 2>/dev/null | wc -l');
      expect(res.stdout.trim()).toBe('0');
    } finally {
      ssh.close();
    }
  });
});
