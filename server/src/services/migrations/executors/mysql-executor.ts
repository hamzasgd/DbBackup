import mysql2 from 'mysql2/promise';
import { spawn } from 'child_process';
import { ConnectionConfig } from '../../engines/base.engine';
import { getEngineHostPort } from '../utils/engine-host';
import { TableMeta, MigrationOptions } from '../types/migration.types';

/**
 * Get table metadata from MySQL/MariaDB database.
 */
export async function getMySQLTableMeta(
  conn: mysql2.Connection,
  database: string,
  tables: string[]
): Promise<TableMeta[]> {
  const result: TableMeta[] = [];
  for (const table of tables) {
    const [pkRows] = await conn.query<mysql2.RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'`,
      [database, table]
    );
    const pkSet = new Set(pkRows.map((r) => r.COLUMN_NAME as string));

    const [colRows] = await conn.query<mysql2.RowDataPacket[]>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [database, table]
    );
    result.push({
      name: table,
      columns: colRows.map((c) => ({
        name: c.COLUMN_NAME as string,
        type: c.COLUMN_TYPE as string,
        nullable: c.IS_NULLABLE === 'YES',
        isPrimaryKey: pkSet.has(c.COLUMN_NAME as string),
        extra: (c.EXTRA as string) || '',
      })),
    });
  }
  return result;
}

/**
 * Migrate MySQL/MariaDB to MySQL/MariaDB using piped mysqldump -> mysql.
 */
export async function migrateMySQL2MySQL(
  src: ConnectionConfig,
  dst: ConnectionConfig,
  opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcRef = await getEngineHostPort(src);
  const dstRef = await getEngineHostPort(dst);

  try {
    return await new Promise((resolve, reject) => {
      const srcArgs = [
        `-h${srcRef.host}`,
        `-P${srcRef.port}`,
        `-u${src.username}`,
        src.password ? `-p${src.password}` : '',
        '--single-transaction',
        '--routines',
        '--triggers',
        '--events',
        '--add-drop-table',
        src.database,
      ].filter(Boolean);

      const dstArgs = [
        `-h${dstRef.host}`,
        `-P${dstRef.port}`,
        `-u${dst.username}`,
        dst.password ? `-p${dst.password}` : '',
        dst.database,
      ].filter(Boolean);

      opts.onProgress?.({
        currentTable: 'Starting dump pipe...',
        tablesCompleted: 0,
        tableCount: 1,
        rowsMigrated: 0,
        progress: 10,
      });

      const dumpCmd = src.type === 'MARIADB' ? 'mariadb-dump' : 'mysqldump';
      const dump = spawn(dumpCmd, srcArgs);

      const restoreCmd = dst.type === 'MARIADB' ? 'mariadb' : 'mysql';
      const restore = spawn(restoreCmd, dstArgs);

      let dumpError = '';
      let restoreError = '';

      dump.stderr.on('data', (d) => {
        const msg = d.toString();
        if (!msg.includes('Warning')) dumpError += msg;
      });

      restore.stderr.on('data', (d) => {
        const msg = d.toString();
        if (!msg.includes('Warning')) restoreError += msg;
      });

      dump.stdout.pipe(restore.stdin);

      restore.on('close', (code) => {
        if (code === 0) {
          opts.onProgress?.({
            currentTable: 'Finished',
            tablesCompleted: 1,
            tableCount: 1,
            rowsMigrated: -1,
            progress: 100,
          });
          resolve({ rowsMigrated: -1 }); // -1 indicates stream method
        } else {
          reject(new Error(`MySQL restore failed: ${restoreError || dumpError}`));
        }
      });

      dump.on('error', reject);
      restore.on('error', reject);
    });
  } finally {
    if (srcRef.tunnel) srcRef.tunnel.close();
    if (dstRef.tunnel) dstRef.tunnel.close();
  }
}
