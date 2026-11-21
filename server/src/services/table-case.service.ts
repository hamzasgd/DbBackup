import { ConnectionFactory } from './engines/connection-factory';
import { toEngineConfig, type StoredConnection } from './engines/connection-config';

/**
 * How a MySQL/MariaDB server stores table names, and which tables of a
 * database have capital letters in their names.
 *
 * With lower_case_table_names=1 (aaPanel's default, and Windows) the server
 * stores every table name in lowercase: restoring a backup with "AppSettings"
 * creates "appsettings". Apps still find their tables there (lookups ignore
 * case too), but a backup taken from such a server has lowercase names, and
 * restored onto a server that keeps case (=0, e.g. AWS RDS) an app asking for
 * "AppSettings" no longer finds its table.
 */
export interface TableCaseInfo {
  /** 0: names kept as written, case matters; 1: stored in lowercase; 2: kept as written, compared in lowercase */
  lowerCaseTableNames: number;
  /** Tables with capital letters (up to 20) */
  capitalized: string[];
  /** All tables with capital letters */
  capitalizedCount: number;
}

const MYSQL_TYPES = new Set(['MYSQL', 'MARIADB']);
export const supportsTableCase = (type: string) => MYSQL_TYPES.has(type);

/** Connects briefly (through SSH when set up) and reads the setting and the table names. */
export async function tableCaseInfo(conn: StoredConnection, database?: string): Promise<TableCaseInfo> {
  const config = toEngineConfig(conn);
  const { connection, tunnel } = await ConnectionFactory.createMySQLConnection(config, { connectTimeout: 15_000 });
  try {
    const [[setting]] = await connection.query('SELECT @@lower_case_table_names AS v') as unknown as [{ v: number | string }[]];
    const [names] = await connection.query(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND BINARY TABLE_NAME <> BINARY LOWER(TABLE_NAME) ORDER BY TABLE_NAME`,
      [database || config.database],
    ) as unknown as [{ t: string }[]];
    return {
      lowerCaseTableNames: Number(setting.v),
      capitalized: names.slice(0, 20).map((n) => n.t),
      capitalizedCount: names.length,
    };
  } finally {
    await connection.end().catch(() => undefined);
    tunnel?.close();
  }
}

const list = (names: string[], count: number) =>
  `${names.slice(0, 3).join(', ')}${count > 3 ? ` and ${count - 3} more` : ''}`;

/**
 * The warning for restoring a backup of `source` into `target`, or null.
 * `source` is the backup's own connection now (null when it was deleted or
 * can't be reached), which tells what names the backup has.
 */
export function restoreCaseWarning(source: TableCaseInfo | null, target: TableCaseInfo): string | null {
  if (target.lowerCaseTableNames === 1) {
    if (source && source.lowerCaseTableNames !== 1 && source.capitalizedCount > 0) {
      return `This server stores table names in lowercase (lower_case_table_names=1), so ${list(source.capitalized, source.capitalizedCount)} `
        + 'will be created in lowercase. Apps still find them on this server, but backups taken from it will have lowercase names, '
        + "which break apps when restored onto a server that keeps case (like AWS RDS). This can't be changed on this server "
        + 'without re-creating its MySQL data folder with lower_case_table_names=0.';
    }
    return null;
  }
  if (target.lowerCaseTableNames === 0 && source?.lowerCaseTableNames === 1) {
    return 'This backup comes from a server that stores table names in lowercase (lower_case_table_names=1), so all its table names are '
      + 'lowercase. This server keeps case: an app that uses names with capitals (e.g. AppSettings) will not find its tables after the restore.';
  }
  return null;
}

/** The warning for taking a backup of a server, or null. */
export function backupCaseWarning(info: TableCaseInfo): string | null {
  if (info.lowerCaseTableNames !== 1) return null;
  return 'This server stores table names in lowercase (lower_case_table_names=1), so backups of it have lowercase table names. '
    + 'Restored onto a server that keeps case (like AWS RDS), apps that use names with capitals (e.g. AppSettings) will not find their tables.';
}
