import { spawn } from 'child_process';
import { statSync, createReadStream } from 'fs';
import { createGunzip } from 'zlib';
import { BaseEngine, BackupResult, BackupOptions, RestoreOptions, TestConnectionResult, ConnectionConfig, DbInfo, TableInfo, ColumnInfo } from './base.engine';
import { SSHTunnel } from '../ssh.service';
import { dumpToFile } from './dump-to-file';
import mysql2 from 'mysql2/promise';
import { TlsFiles, nodeTlsOptions, mysqlCliTlsArgs } from './tls';
import { buildBackupPath } from './backup-path';
import { watchOutputSize, countStreamBytes } from './output-watcher';
import { remoteMysqlBackup, remoteMysqlRestore } from './mysql-remote';
import { cliEnv, mysqlRestoreGuardArgs, mysqlCompressArgsFor, mysqlClientHasCompressionAlgorithms, toolVersionText } from './cli-safety';
import { logger } from '../../config/logger';

/** Tables estimated below this many rows are counted exactly on the Database Info page */
const EXACT_COUNT_MAX_ROWS = 100_000;

export class MySQLEngine extends BaseEngine {
  private quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  /** Connection + TLS arguments for the mysql / mysqldump / mariadb-dump CLI `bin`. */
  private getArgs(bin: string, files: TlsFiles): string[] {
    const host = this.config.sshEnabled ? '127.0.0.1' : this.config.host;
    const port = this.config.sshEnabled ? (this.config as any)._localPort || this.config.port : this.config.port;
    return [
      `-h${host}`,
      `-P${port}`,
      `-u${this.config.username}`,
      ...mysqlCliTlsArgs(this.config, bin, !!this.config.sshEnabled, files),
    ];
  }

  /**
   * Protocol-compression flags for `bin` when the connection has
   * compressTraffic on. A modern Oracle client first asks the server which
   * algorithms it allows (one short query), so zstd is used where possible.
   */
  private async compressArgs(bin: string, files: TlsFiles): Promise<string[]> {
    if (!this.config.compressTraffic) return [];
    const version = toolVersionText(bin);
    let serverAlgorithms: string | null = null;
    if (mysqlClientHasCompressionAlgorithms(version)) {
      serverAlgorithms = await this.queryVariable(files, 'SELECT @@protocol_compression_algorithms').catch(() => null);
    }
    const args = mysqlCompressArgsFor(version, serverAlgorithms);
    logger.info(`${bin}: traffic compression on (${args.join(' ')})`);
    return args;
  }

  /** One-value query through the mysql CLI; rejects when the server doesn't know it. */
  private queryVariable(files: TlsFiles, sql: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('mysql', [...this.getArgs('mysql', files), '--connect-timeout=15', '-Nse', sql], { env: this.getEnv() });
      let out = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
    });
  }

  /** Minimal environment (none of the app's secrets) plus the password, which stays off argv. */
  private getEnv(): NodeJS.ProcessEnv {
    return cliEnv({ MYSQL_PWD: this.config.password ?? undefined });
  }

  private getSslOptions() {
    return nodeTlsOptions(this.config, 'mysql2');
  }

  async testConnection(): Promise<TestConnectionResult> {
    let tunnel: SSHTunnel | null = null;
    const files = new TlsFiles();
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      return await new Promise((resolve, reject) => {
        const timeout = this.config.connectionTimeout ? Math.floor(this.config.connectionTimeout / 1000) : 30;
        const proc = spawn('mysql', [
          ...this.getArgs('mysql', files),
          `--connect-timeout=${timeout}`,
          '-e', 'SELECT VERSION() as version;',
          '--batch', '--skip-column-names',
        ], { env: this.getEnv() });

        let output = '';
        let errorOutput = '';

        proc.stdout.on('data', (d) => output += d.toString());
        proc.stderr.on('data', (d) => errorOutput += d.toString());

        proc.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true, version: output.trim(), message: 'Connection successful' });
          } else {
            reject(new Error(`MySQL connection failed: ${errorOutput}`));
          }
        });
      });
    } finally {
      tunnel?.close();
      files.cleanup();
    }
  }

  async backup(outputDir: string, options: BackupOptions = {}): Promise<BackupResult> {
    const { format = 'COMPRESSED_SQL', onProgress } = options;
    // MySQL/MariaDB only support SQL formats (plain or compressed)
    const useGzip = format !== 'PLAIN_SQL';
    if (options.strategy === 'SSH_SERVER') return this.backupOnSshServer(outputDir, useGzip, options);

    let tunnel: SSHTunnel | null = null;
    const files = new TlsFiles();
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = useGzip ? '.sql.gz' : '.sql';
      const enginePrefix = this.config.type === 'MARIADB' ? 'mariadb' : 'mysql';
      const { fileName, filePath } = buildBackupPath(outputDir, enginePrefix, this.config.database, timestamp, ext);
      options.onOutputPath?.(filePath);

      onProgress?.(5);

      const dumpCmd = this.config.type === 'MARIADB' ? 'mariadb-dump' : 'mysqldump';
      const stopWatch = watchOutputSize(filePath, options.onBytes);
      const compress = await this.compressArgs(dumpCmd, files);
      await dumpToFile(dumpCmd, [
        ...this.getArgs(dumpCmd, files),
        ...compress,
        '--single-transaction',
        '--routines',
        '--triggers',
        '--events',
        '--set-charset',
        '--add-drop-table',
        '--', // end of options: the database name can never be read as a flag
        this.config.database,
      ], this.getEnv(), filePath, useGzip, (msg) => !msg.includes('Warning'))
        .finally(stopWatch);

      onProgress?.(95);
      const stats = statSync(filePath);
      onProgress?.(100);
      return { fileName, filePath, fileSize: stats.size };
    } finally {
      tunnel?.close();
      files.cleanup();
    }
  }

  /** mysqldump | gzip on the SSH server; only the compressed dump comes back over SSH. */
  private async backupOnSshServer(outputDir: string, useGzip: boolean, options: BackupOptions): Promise<BackupResult> {
    if (!this.config.sshEnabled) throw new Error('"Run on the SSH server" needs a connection that uses SSH');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = useGzip ? '.sql.gz' : '.sql';
    const enginePrefix = this.config.type === 'MARIADB' ? 'mariadb' : 'mysql';
    const { fileName, filePath } = buildBackupPath(outputDir, enginePrefix, this.config.database, timestamp, ext);
    options.onOutputPath?.(filePath);
    options.onProgress?.(5);
    const stopWatch = watchOutputSize(filePath, options.onBytes);
    await remoteMysqlBackup(this.config, filePath, useGzip).finally(stopWatch);
    options.onProgress?.(95);
    const stats = statSync(filePath);
    options.onProgress?.(100);
    return { fileName, filePath, fileSize: stats.size };
  }

  async restore(backupFilePath: string, targetDatabase?: string, options: RestoreOptions = {}): Promise<void> {
    if (options.strategy === 'SSH_SERVER') {
      if (!this.config.sshEnabled) throw new Error('"Run on the SSH server" needs a connection that uses SSH');
      return remoteMysqlRestore(this.config, backupFilePath, targetDatabase || this.config.database, options.onBytes);
    }
    let tunnel: SSHTunnel | null = null;
    const files = new TlsFiles();
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      const dbName = targetDatabase || this.config.database;
      const isGzip = backupFilePath.endsWith('.gz');
      const compress = await this.compressArgs('mysql', files);

      await new Promise<void>((resolve, reject) => {
        // The dump is only SQL to execute: client commands in it (\! shell, source, tee, connect) are refused
        const mysqlArgs = [...this.getArgs('mysql', files), ...compress, ...mysqlRestoreGuardArgs('mysql'), '--', dbName];
        const mysql = spawn('mysql', mysqlArgs, { env: this.getEnv() });

        let error = '';
        let settled = false;
        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };

        mysql.stderr.on('data', (d) => error += d.toString());
        mysql.on('close', (code) => {
          if (code === 0) settle();
          else settle(new Error(`MySQL restore failed: ${error}`));
        });
        mysql.on('error', settle);

        // Prevent EPIPE crash: if mysql exits early (bad SQL, connection error),
        // the file stream is still writing to its stdin — handle the broken pipe
        mysql.stdin.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EPIPE') {
            // mysql closed its stdin — the 'close' event will fire with the exit
            // code; don't crash the process, just destroy the source stream
            settle(new Error(`MySQL restore failed: ${error || 'mysql exited early'}`));
          } else {
            settle(err);
          }
        });

        // Bytes are counted as read from the file (compressed when .gz); mysql
        // applies backpressure, so this tracks how far the restore really is
        const file = createReadStream(backupFilePath);
        countStreamBytes(file, options.onBytes);
        file.on('error', settle);
        const source = isGzip ? file.pipe(createGunzip()) : file;

        source.on('error', settle);
        source.pipe(mysql.stdin);
      });
    } finally {
      tunnel?.close();
      files.cleanup();
    }
  }

  async listDatabases(): Promise<string[]> {
    let tunnel: SSHTunnel | null = null;
    let conn: mysql2.Connection | null = null;
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }
      
      const host = this.config.sshEnabled ? '127.0.0.1' : this.config.host;
      const port = this.config.sshEnabled ? (this.config as any)._localPort || this.config.port : this.config.port;

      conn = await mysql2.createConnection({
        host: host,
        port: port,
        user: this.config.username,
        password: this.config.password ?? undefined,
        ssl: this.getSslOptions(),
      });

      const [rows] = await conn.query<mysql2.RowDataPacket[]>('SHOW DATABASES;');
      return rows.map((r: mysql2.RowDataPacket) => r.Database);
    } catch (e: any) {
      throw new Error(`Failed to list databases: ${e.message}`);
    } finally {
      if (conn) await conn.end();
      tunnel?.close();
    }
  }

  async getDbInfo(): Promise<DbInfo> {
    let tunnel: SSHTunnel | null = null;
    let conn: mysql2.Connection | null = null;
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      const host = this.config.sshEnabled ? '127.0.0.1' : this.config.host;
      const port = this.config.sshEnabled ? (this.config as any)._localPort || this.config.port : this.config.port;

      conn = await mysql2.createConnection({
        host: host,
        port: port,
        user: this.config.username,
        password: this.config.password ?? undefined,
        database: this.config.database,
        ssl: this.getSslOptions(),
        connectTimeout: this.config.connectionTimeout || 30000,
      });
      // Version
      const [[versionRow]] = await conn.query<mysql2.RowDataPacket[]>('SELECT VERSION() AS v');
      const version = (versionRow as mysql2.RowDataPacket)['v'] as string;

      // Table sizes and row estimates from information_schema
      const [tableRows] = await conn.query<mysql2.RowDataPacket[]>(`
        SELECT
          TABLE_NAME        AS name,
          DATA_LENGTH       AS data_bytes,
          INDEX_LENGTH      AS index_bytes,
          DATA_LENGTH + INDEX_LENGTH AS size_bytes,
          TABLE_ROWS        AS est_rows
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
          AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME
      `, [this.config.database]);

      // Total size
      const [[totalRow]] = await conn.query<mysql2.RowDataPacket[]>(`
        SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS total
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
      `, [this.config.database]);
      const totalSizeBytes = Number((totalRow as mysql2.RowDataPacket)['total']);

      // Columns, indexes and foreign keys of every table: three queries, not three per table
      // (each one is a round trip, slow over an SSH tunnel)
      const byTable = (rows: mysql2.RowDataPacket[]) => {
        const m = new Map<string, mysql2.RowDataPacket[]>();
        for (const r of rows) {
          const k = String(r['table_name']);
          if (!m.has(k)) m.set(k, []);
          m.get(k)!.push(r);
        }
        return m;
      };
      const [colAll] = await conn.query<mysql2.RowDataPacket[]>(`
        SELECT TABLE_NAME AS table_name, COLUMN_NAME AS col_name, COLUMN_TYPE AS col_type, IS_NULLABLE AS nullable,
               COLUMN_DEFAULT AS default_val, COLUMN_KEY AS col_key, EXTRA AS extra
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`, [this.config.database]);
      const [idxAll] = await conn.query<mysql2.RowDataPacket[]>(`
        SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique,
               COLUMN_NAME AS column_name, SEQ_IN_INDEX AS seq_in_index
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [this.config.database]);
      const [fkAll] = await conn.query<mysql2.RowDataPacket[]>(`
        SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS constraint_name, COLUMN_NAME AS column_name,
               REFERENCED_TABLE_NAME AS referenced_table, REFERENCED_COLUMN_NAME AS referenced_column
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, [this.config.database]);
      const colsByTable = byTable(colAll);
      const idxByTable = byTable(idxAll);
      const fkByTable = byTable(fkAll);

      // Exact row counts only where counting is cheap. COUNT(*) reads the whole table, so a
      // table with millions of rows would take minutes and load the server: those show the
      // server's own estimate instead (marked as such).
      const counts = new Map<string, number>();
      const small = (tableRows as mysql2.RowDataPacket[])
        .filter((t) => (Number(t['est_rows']) || 0) < EXACT_COUNT_MAX_ROWS)
        .map((t) => String(t['name']));
      for (let i = 0; i < small.length; i += 50) {
        const batch = small.slice(i, i + 50);
        const [countRows] = await conn.query<mysql2.RowDataPacket[]>(
          batch.map((name) => `SELECT ? AS t, COUNT(*) AS n FROM ${this.quoteIdentifier(name)}`).join(' UNION ALL '),
          batch,
        );
        for (const r of countRows) counts.set(String(r['t']), Number(r['n']) || 0);
      }

      const tables: TableInfo[] = (tableRows as mysql2.RowDataPacket[]).map((t) => {
          const tableName = t['name'] as string;
          const indexMap = new Map<string, { name: string; unique: boolean; primary: boolean; columns: string[] }>();
          (idxByTable.get(tableName) ?? []).forEach((r) => {
            const indexName = String(r['index_name']);
            if (!indexMap.has(indexName)) {
              indexMap.set(indexName, {
                name: indexName,
                unique: Number(r['non_unique']) === 0,
                primary: indexName === 'PRIMARY',
                columns: [],
              });
            }

            const rec = indexMap.get(indexName)!;
            rec.columns.push(String(r['column_name']));
          });

          const indexes = [...indexMap.values()];
          const primaryKeyColumns = indexes.find((i) => i.primary)?.columns ?? [];
          const uniqueConstraints = indexes
            .filter((i) => i.unique && !i.primary)
            .map((i) => ({ name: i.name, columns: i.columns }));

          const indexedColumns = new Set(indexes.flatMap((i) => i.columns));
          const uniqueColumns = new Set(indexes.filter((i) => i.unique).flatMap((i) => i.columns));

          const foreignKeys = (fkByTable.get(tableName) ?? []).map((r) => ({
            constraintName: String(r['constraint_name']),
            column: String(r['column_name']),
            referencedTable: String(r['referenced_table']),
            referencedColumn: String(r['referenced_column']),
          }));
          const foreignKeyByColumn = new Map(foreignKeys.map((fk) => [fk.column, fk]));

          const columns: ColumnInfo[] = (colsByTable.get(tableName) ?? []).map((c) => ({
            name: c['col_name'] as string,
            type: c['col_type'] as string,
            nullable: c['nullable'] === 'YES',
            defaultValue: c['default_val'] as string | null,
            isPrimaryKey: c['col_key'] === 'PRI',
            isUnique: uniqueColumns.has(c['col_name'] as string),
            isIndexed: indexedColumns.has(c['col_name'] as string),
            isForeignKey: foreignKeyByColumn.has(c['col_name'] as string),
            references: foreignKeyByColumn.has(c['col_name'] as string)
              ? {
                  table: foreignKeyByColumn.get(c['col_name'] as string)!.referencedTable,
                  column: foreignKeyByColumn.get(c['col_name'] as string)!.referencedColumn,
                  constraintName: foreignKeyByColumn.get(c['col_name'] as string)!.constraintName,
                }
              : undefined,
            extra: c['extra'] as string || undefined,
          }));

          return {
            name: tableName,
            rowCount: counts.get(tableName) ?? (Number(t['est_rows']) || 0),
            rowCountEstimated: !counts.has(tableName),
            sizeBytes: Number(t['size_bytes']) || 0,
            logicalSizeBytes: Number(t['data_bytes']) || 0,
            indexSizeBytes: Number(t['index_bytes']) || 0,
            extraStorageBytes: Math.max(
              (Number(t['size_bytes']) || 0) - (Number(t['data_bytes']) || 0) - (Number(t['index_bytes']) || 0),
              0
            ),
            overheadBytes: Number(t['index_bytes']) || 0,
            overheadPercent: (Number(t['data_bytes']) || 0) > 0
              ? ((Number(t['index_bytes']) || 0) / Number(t['data_bytes'])) * 100
              : 0,
            primaryKeyColumns,
            uniqueConstraints,
            indexes,
            foreignKeys,
            columns,
          };
        });

      const logicalSizeBytes = tables.reduce((sum, t) => sum + t.logicalSizeBytes, 0);
      const indexSizeBytes = tables.reduce((sum, t) => sum + t.indexSizeBytes, 0);
      const overheadBytes = Math.max(totalSizeBytes - logicalSizeBytes, 0);
      const extraStorageBytes = Math.max(overheadBytes - indexSizeBytes, 0);
      const overheadPercent = logicalSizeBytes > 0 ? (overheadBytes / logicalSizeBytes) * 100 : 0;

      return {
        database: this.config.database,
        version,
        totalSizeBytes,
        logicalSizeBytes,
        indexSizeBytes,
        extraStorageBytes,
        overheadBytes,
        overheadPercent,
        tableCount: tables.length,
        tables,
      };
    } finally {
      await conn?.end();
      tunnel?.close();
    }
  }

  /** Lightweight health probe — connect + SELECT 1 with a short timeout. */
  async ping(timeoutMs = 5000): Promise<{ up: boolean; latencyMs: number; error?: string }> {
    let tunnel: SSHTunnel | null = null;
    let conn: mysql2.Connection | null = null;
    const started = Date.now();
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      const host = this.config.sshEnabled ? '127.0.0.1' : this.config.host;
      const port = this.config.sshEnabled ? (this.config as any)._localPort || this.config.port : this.config.port;

      conn = await mysql2.createConnection({
        host,
        port,
        user: this.config.username,
        password: this.config.password ?? undefined,
        ssl: this.getSslOptions(),
        connectTimeout: timeoutMs,
      });
      await conn.query('SELECT 1');
      return { up: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { up: false, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (conn) await conn.end().catch(() => undefined);
      tunnel?.close();
    }
  }

  // ── Restore drill helpers ──────────────────────────────────────────────

  private async drillConn(database?: string): Promise<mysql2.Connection> {
    const tunnel = this.config.sshEnabled ? new SSHTunnel(this.config) : null;
    if (tunnel) (this.config as any)._localPort = await tunnel.connect();
    const host = this.config.sshEnabled ? '127.0.0.1' : this.config.host;
    const port = this.config.sshEnabled ? (this.config as any)._localPort || this.config.port : this.config.port;
    const conn = await mysql2.createConnection({
      host, port,
      user: this.config.username,
      password: this.config.password ?? undefined,
      ssl: this.getSslOptions(),
      ...(database ? { database } : {}),
      connectTimeout: 15000,
      multipleStatements: false,
    });
    // Keep the tunnel alive as long as the connection; close both together below
    (conn as unknown as { _tunnel?: SSHTunnel })._tunnel = tunnel ?? undefined;
    return conn;
  }

  private async closeDrillConn(conn: mysql2.Connection): Promise<void> {
    await conn.end().catch(() => undefined);
    const tunnel = (conn as unknown as { _tunnel?: SSHTunnel })._tunnel;
    tunnel?.close();
  }

  async createDatabase(name: string): Promise<void> {
    const conn = await this.drillConn();
    try {
      await conn.query(`CREATE DATABASE \`${name.replace(/`/g, '')}\``);
    } finally {
      await this.closeDrillConn(conn);
    }
  }

  async dropDatabase(name: string): Promise<void> {
    const conn = await this.drillConn();
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${name.replace(/`/g, '')}\``);
    } finally {
      await this.closeDrillConn(conn);
    }
  }

  async countAllTables(database: string): Promise<{ tables: number; rows: bigint }> {
    const conn = await this.drillConn(database);
    try {
      const [rows] = await conn.query<mysql2.RowDataPacket[]>(
        'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = \'BASE TABLE\'',
        [database],
      );
      let total = 0n;
      for (const r of rows) {
        const [[c]] = await conn.query<mysql2.RowDataPacket[]>(
          `SELECT COUNT(*) AS c FROM \`${database}\`.\`${String(r['t']).replace(/`/g, '')}\``,
        );
        total += BigInt(Number(c['c']));
      }
      return { tables: rows.length, rows: total };
    } finally {
      await this.closeDrillConn(conn);
    }
  }
}

/**
 * MariaDB uses the same code path; MySQLEngine picks `mariadb-dump` for this type.
 * (An override here used to drop the backup options, so MariaDB backups ignored the
 * chosen format, always produced .sql.gz, and never reported progress.)
 */
export class MariaDBEngine extends MySQLEngine {}
