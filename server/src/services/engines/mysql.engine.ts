import { spawn } from 'child_process';
import { createWriteStream, statSync } from 'fs';
import { createGzip } from 'zlib';
import path from 'path';
import { BaseEngine, BackupResult, BackupOptions, TestConnectionResult, ConnectionConfig, DbInfo, TableInfo, ColumnInfo } from './base.engine';
import { SSHTunnel } from '../ssh.service';
import mysql2 from 'mysql2/promise';

export class MySQLEngine extends BaseEngine {
  private quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  private getArgs(includePassword = true): string[] {
    const host = this.config.sshEnabled ? '127.0.0.1' : this.config.host;
    const port = this.config.sshEnabled ? (this.config as any)._localPort || this.config.port : this.config.port;
    const args = [
      `-h${host}`,
      `-P${port}`,
      `-u${this.config.username}`,
    ];
    if (includePassword) args.push(`-p${this.config.password}`);
    return args;
  }

  async testConnection(): Promise<TestConnectionResult> {
    let tunnel: SSHTunnel | null = null;
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      return await new Promise((resolve, reject) => {
        const timeout = this.config.connectionTimeout ? Math.floor(this.config.connectionTimeout / 1000) : 30;
        const proc = spawn('mysql', [
          ...this.getArgs(),
          `--connect-timeout=${timeout}`,
          '-e', 'SELECT VERSION() as version;',
          '--batch', '--skip-column-names',
        ]);

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
    }
  }

  async backup(outputDir: string, options: BackupOptions = {}): Promise<BackupResult> {
    const { format = 'COMPRESSED_SQL', onProgress } = options;
    // MySQL/MariaDB only support SQL formats (plain or compressed)
    const useGzip = format !== 'PLAIN_SQL';

    let tunnel: SSHTunnel | null = null;
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = useGzip ? '.sql.gz' : '.sql';
      const enginePrefix = this.config.type === 'MARIADB' ? 'mariadb' : 'mysql';
      const fileName = `${enginePrefix}_${this.config.database}_${timestamp}${ext}`;
      const filePath = path.join(outputDir, fileName);

      onProgress?.(5);

      await new Promise<void>((resolve, reject) => {
        const dumpCmd = this.config.type === 'MARIADB' ? 'mariadb-dump' : 'mysqldump';
        const dump = spawn(dumpCmd, [
          ...this.getArgs(),
          '--single-transaction',
          '--routines',
          '--triggers',
          '--add-drop-table',
          this.config.database,
        ]);

        const fileStream = createWriteStream(filePath);
        const outStream = useGzip ? createGzip() : fileStream;
        if (useGzip) (outStream as ReturnType<typeof createGzip>).pipe(fileStream);
        dump.stdout.pipe(outStream as NodeJS.WritableStream);

        let error = '';
        dump.stderr.on('data', (d) => {
          const msg = d.toString();
          if (!msg.includes('Warning')) error += msg;
        });

        fileStream.on('finish', resolve);
        if (!useGzip) dump.stdout.on('end', () => fileStream.end());
        dump.on('close', (code) => {
          if (code !== 0) reject(new Error(`${dumpCmd} failed: ${error}`));
        });
        dump.on('error', reject);
      });

      onProgress?.(95);
      const stats = statSync(filePath);
      onProgress?.(100);
      return { fileName, filePath, fileSize: stats.size };
    } finally {
      tunnel?.close();
    }
  }

  async restore(backupFilePath: string, targetDatabase?: string): Promise<void> {
    let tunnel: SSHTunnel | null = null;
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      const dbName = targetDatabase || this.config.database;
      const isGzip = backupFilePath.endsWith('.gz');

      await new Promise<void>((resolve, reject) => {
        const mysqlArgs = [...this.getArgs(), dbName];
        const mysql = spawn('mysql', mysqlArgs);

        let error = '';
        mysql.stderr.on('data', (d) => error += d.toString());
        mysql.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`MySQL restore failed: ${error}`));
        });
        mysql.on('error', reject);

        if (isGzip) {
          const { createReadStream } = require('fs');
          const { createGunzip } = require('zlib');
          const fileStream = createReadStream(backupFilePath);
          const gunzip = createGunzip();
          fileStream.pipe(gunzip).pipe(mysql.stdin);
        } else {
          const { createReadStream } = require('fs');
          createReadStream(backupFilePath).pipe(mysql.stdin);
        }
      });
    } finally {
      tunnel?.close();
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
        password: this.config.password,
        ssl: this.config.sslEnabled ? { rejectUnauthorized: false } : undefined,
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
        password: this.config.password,
        database: this.config.database,
        ssl: this.config.sslEnabled ? { rejectUnauthorized: false } : undefined,
        connectTimeout: this.config.connectionTimeout || 30000,
      });

      // Version
      const [[versionRow]] = await conn.query<mysql2.RowDataPacket[]>('SELECT VERSION() AS v');
      const version = (versionRow as mysql2.RowDataPacket)['v'] as string;

      // Table sizes from information_schema. Row counts are fetched exactly per table below.
      const [tableRows] = await conn.query<mysql2.RowDataPacket[]>(`
        SELECT
          TABLE_NAME        AS name,
          DATA_LENGTH       AS data_bytes,
          INDEX_LENGTH      AS index_bytes,
          DATA_LENGTH + INDEX_LENGTH AS size_bytes
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

      // Columns for each table
      const tables: TableInfo[] = await Promise.all(
        (tableRows as mysql2.RowDataPacket[]).map(async (t) => {
          const tableName = t['name'] as string;
          const safeTable = this.quoteIdentifier(tableName);

          const [[countRow]] = await conn!.query<mysql2.RowDataPacket[]>(
            `SELECT COUNT(*) AS row_count FROM ${safeTable}`
          );

          const [colRows] = await conn!.query<mysql2.RowDataPacket[]>(`
            SELECT
              COLUMN_NAME             AS col_name,
              COLUMN_TYPE             AS col_type,
              IS_NULLABLE             AS nullable,
              COLUMN_DEFAULT          AS default_val,
              COLUMN_KEY              AS col_key,
              EXTRA                   AS extra
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
          `, [this.config.database, tableName]);

          const [idxRows] = await conn!.query<mysql2.RowDataPacket[]>(`
            SELECT
              INDEX_NAME AS index_name,
              NON_UNIQUE AS non_unique,
              COLUMN_NAME AS column_name,
              SEQ_IN_INDEX AS seq_in_index
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = ?
            ORDER BY INDEX_NAME, SEQ_IN_INDEX
          `, [this.config.database, tableName]);

          const [fkRows] = await conn!.query<mysql2.RowDataPacket[]>(`
            SELECT
              CONSTRAINT_NAME AS constraint_name,
              COLUMN_NAME AS column_name,
              REFERENCED_TABLE_NAME AS referenced_table,
              REFERENCED_COLUMN_NAME AS referenced_column
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = ?
              AND REFERENCED_TABLE_NAME IS NOT NULL
            ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION
          `, [this.config.database, tableName]);

          const indexMap = new Map<string, { name: string; unique: boolean; primary: boolean; columns: string[] }>();
          (idxRows as mysql2.RowDataPacket[]).forEach((r) => {
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

          const foreignKeys = (fkRows as mysql2.RowDataPacket[]).map((r) => ({
            constraintName: String(r['constraint_name']),
            column: String(r['column_name']),
            referencedTable: String(r['referenced_table']),
            referencedColumn: String(r['referenced_column']),
          }));
          const foreignKeyByColumn = new Map(foreignKeys.map((fk) => [fk.column, fk]));

          const columns: ColumnInfo[] = (colRows as mysql2.RowDataPacket[]).map((c) => ({
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
            rowCount: Number((countRow as mysql2.RowDataPacket)['row_count']) || 0,
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
        })
      );

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
}

export class MariaDBEngine extends MySQLEngine {
  async backup(outputDir: string): Promise<BackupResult> {
    // Try mariadb-dump first, fall back to mysqldump
    return super.backup(outputDir);
  }
}
