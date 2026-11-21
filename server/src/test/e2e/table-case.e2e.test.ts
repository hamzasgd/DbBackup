import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseType } from '@prisma/client';
import { tableCaseInfo } from '../../services/table-case.service';
import { encrypt } from '../../services/crypto.service';
import { MARIADB, uniq, myAdmin } from './helpers';

/** Reads lower_case_table_names and the tables with capitals from a real server (E2E_MARIADB_URL). */
describe.skipIf(!MARIADB)('table name case check', () => {
  const db = uniq('e2e_case');
  beforeAll(() => myAdmin((c) => c.query(`CREATE DATABASE \`${db}\`; CREATE TABLE \`${db}\`.AppSettings (id INT PRIMARY KEY); CREATE TABLE \`${db}\`.orders (id INT PRIMARY KEY)`)));
  afterAll(() => myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${db}\``)));

  it('lists the tables with capitals and the server setting', async () => {
    const url = MARIADB!;
    const stored = {
      type: DatabaseType.MYSQL, host: encrypt(url.hostname), port: Number(url.port), database: encrypt(db),
      username: encrypt(decodeURIComponent(url.username)), password: encrypt(decodeURIComponent(url.password)),
      sshEnabled: false,
    };
    const [[setting]] = await myAdmin((c) => c.query('SELECT @@lower_case_table_names AS v')) as unknown as [{ v: number }[]];
    const r = await tableCaseInfo(stored as never);
    expect(r.lowerCaseTableNames).toBe(Number(setting.v));
    if (Number(setting.v) === 0) expect(r).toMatchObject({ capitalized: ['AppSettings'], capitalizedCount: 1 });
  });
});
