import { spawn } from 'child_process';
import { createWriteStream, statSync } from 'fs';
import { createGzip } from 'zlib';
import path from 'path';
import { BaseEngine, BackupResult, BackupOptions, TestConnectionResult, ConnectionConfig, DbInfo, TableInfo, ColumnInfo } from './base.engine';
import { SSHTunnel } from '../ssh.service';
import mysql2 from 'mysql2/promise';

export class MySQLEngine extends BaseEngine {
  private getArgs(includePassword = true): string[] {
    const args = [
      `-h${this.config.host}`,
      `-P${this.config.port}`,
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
        await tunnel.connect();
      }

      return await new Promise((resolve, reject) => {
        const proc = spawn('mysql', [
          ...this.getArgs(),
          '--connect-timeout=5',
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
        await tunnel.connect();
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
        await tunnel.connect();
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
    return new Promise((resolve, reject) => {
      const proc = spawn('mysql', [
        ...this.getArgs(),
        '-e', 'SHOW DATABASES;',
        '--batch', '--skip-column-names',
      ]);

      let output = '';
      proc.stdout.on('data', (d) => output += d.toString());
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim().split('\n').filter(Boolean));
        } else {
          reject(new Error('Failed to list databases'));
        }
      });
    });
  }

  async getDbInfo(): Promise<DbInfo> {
    let tunnel: SSHTunnel | null = null;
    let conn: mysql2.Connection | null = null;
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        await tunnel.connect();
      }

      conn = await mysql2.createConnection({
        host: this.config.host,
        port: this.config.port,
        user: this.config.username,
        password: this.config.password,
        database: this.config.database,
        ssl: this.config.sslEnabled ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 10000,
      });

      // Version
      const [[versionRow]] = await conn.query<mysql2.RowDataPacket[]>('SELECT VERSION() AS v');
      const version = (versionRow as mysql2.RowDataPacket)['v'] as string;

      // Table stats from information_schema
      const [tableRows] = await conn.query<mysql2.RowDataPacket[]>(`
        SELECT
          TABLE_NAME        AS name,
          TABLE_ROWS        AS row_count,
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
          `, [this.config.database, t['name']]);

          const columns: ColumnInfo[] = (colRows as mysql2.RowDataPacket[]).map((c) => ({
            name: c['col_name'] as string,
            type: c['col_type'] as string,
            nullable: c['nullable'] === 'YES',
            defaultValue: c['default_val'] as string | null,
            isPrimaryKey: c['col_key'] === 'PRI',
            extra: c['extra'] as string || undefined,
          }));

          return {
            name: t['name'] as string,
            rowCount: Number(t['row_count']) || 0,
            sizeBytes: Number(t['size_bytes']) || 0,
            columns,
          };
        })
      );

      return {
        database: this.config.database,
        version,
        totalSizeBytes,
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
