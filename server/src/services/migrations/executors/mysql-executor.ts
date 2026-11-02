import mysql2 from 'mysql2/promise';
import { ConnectionConfig } from '../../engines/base.engine';
import { getEngineHostPort } from '../utils/engine-host';
import { TableMeta, MigrationOptions } from '../types/migration.types';
import { TlsFiles, mysqlCliTlsArgs } from '../../engines/tls';
import { runPipe } from '../utils/process-pipe';

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
 * Passwords go through MYSQL_PWD (never argv, which other users can read with `ps`).
 */
export async function migrateMySQL2MySQL(
  src: ConnectionConfig,
  dst: ConnectionConfig,
  opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcRef = await getEngineHostPort(src);
  const dstRef = await getEngineHostPort(dst);
  const files = new TlsFiles();

  try {
    const dumpCmd = src.type === 'MARIADB' ? 'mariadb-dump' : 'mysqldump';
    const restoreCmd = dst.type === 'MARIADB' ? 'mariadb' : 'mysql';

    opts.onProgress?.({
      currentTable: 'Starting dump pipe...',
      tablesCompleted: 0,
      tableCount: 1,
      rowsMigrated: 0,
      progress: 10,
    });

    await runPipe(
      {
        cmd: dumpCmd,
        args: [
          `-h${srcRef.host}`, `-P${srcRef.port}`, `-u${src.username}`,
          ...mysqlCliTlsArgs(src, dumpCmd, !!srcRef.tunnel, files),
          '--single-transaction', '--routines', '--triggers', '--events', '--add-drop-table',
          '--', // end of options: database + table names below can never be read as flags
          src.database,
          ...(opts.tables ?? []),
        ],
        env: { ...process.env, MYSQL_PWD: src.password || undefined },
      },
      {
        cmd: restoreCmd,
        args: [
          `-h${dstRef.host}`, `-P${dstRef.port}`, `-u${dst.username}`,
          ...mysqlCliTlsArgs(dst, restoreCmd, !!dstRef.tunnel, files),
          '--',
          dst.database,
        ],
        env: { ...process.env, MYSQL_PWD: dst.password || undefined },
      },
      'MySQL migration',
    );

    opts.onProgress?.({
      currentTable: 'Finished',
      tablesCompleted: 1,
      tableCount: 1,
      rowsMigrated: -1,
      progress: 100,
    });
    return { rowsMigrated: -1 }; // -1 indicates stream method
  } finally {
    files.cleanup();
    if (srcRef.tunnel) srcRef.tunnel.close();
    if (dstRef.tunnel) dstRef.tunnel.close();
  }
}
