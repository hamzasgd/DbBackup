import { spawn } from 'child_process';
import { createWriteStream, statSync, createReadStream, mkdirSync } from 'fs';
import { createGunzip, createGzip } from 'zlib';
import path from 'path';
import { BaseEngine, BackupResult, BackupOptions, TestConnectionResult, DbInfo, TableInfo, ColumnInfo } from './base.engine';
import { SSHTunnel } from '../ssh.service';
import { Pool } from 'pg';

export class PostgreSQLEngine extends BaseEngine {
  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private getEnv(): NodeJS.ProcessEnv {
    return { ...process.env, PGPASSWORD: this.config.password };
  }

  private getSslOptions(): { rejectUnauthorized: boolean; ca?: string } | undefined {
    if (!this.config.sslEnabled) return undefined;
    if (this.config.sslCa) {
      return { rejectUnauthorized: true, ca: this.config.sslCa };
    }
    // No CA provided - warn and allow self-signed
    console.warn('SSL enabled but no CA cert provided - using rejectUnauthorized: false');
    return { rejectUnauthorized: false };
  }

  private getBaseArgs(): string[] {
    const host = this.config.sshEnabled ? '127.0.0.1' : this.config.host;
    const port = this.config.sshEnabled ? (this.config as any)._localPort || this.config.port : this.config.port;
    
    return [
      '-h', host,
      '-p', String(port),
      '-U', this.config.username,
    ];
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
        const timeout = this.config.connectionTimeout ? Math.floor(this.config.connectionTimeout / 1000).toString() : '30';
        const proc = spawn('psql', [
          ...this.getBaseArgs(),
          '-d', this.config.database,
          '-c', 'SELECT version();',
          '-t'
        ], { 
          env: {
            ...this.getEnv(),
            PGCONNECT_TIMEOUT: timeout
          }
        });

        let output = '';
        let errorOutput = '';

        proc.stdout.on('data', (d: Buffer) => output += d.toString());
        proc.stderr.on('data', (d: Buffer) => errorOutput += d.toString());

        proc.on('close', (code: number) => {
          if (code === 0) {
            resolve({ success: true, version: output.trim(), message: 'Connection successful' });
          } else {
            reject(new Error(`PostgreSQL connection failed: ${errorOutput}`));
          }
        });
      });
    } finally {
      tunnel?.close();
    }
  }

  async backup(outputDir: string, options: BackupOptions = {}): Promise<BackupResult> {
    const { format = 'COMPRESSED_SQL', onProgress } = options;

    let tunnel: SSHTunnel | null = null;
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      onProgress?.(5);

      // Map format to pg_dump flags + file extension
      const formatMap: Record<string, { flag: string; ext: string }> = {
        CUSTOM:         { flag: '-Fc', ext: '.dump' },
        TAR:            { flag: '-Ft', ext: '.tar' },
        DIRECTORY:      { flag: '-Fd', ext: '' },      // output is a directory
        PLAIN_SQL:      { flag: '-Fp', ext: '.sql' },
        COMPRESSED_SQL: { flag: '-Fp', ext: '.sql.gz' },
      };
      const { flag, ext } = formatMap[format] ?? formatMap['CUSTOM'];
      const fileName = `postgres_${this.config.database}_${timestamp}${ext}`;
      const outputPath = path.join(outputDir, fileName);

      if (format === 'DIRECTORY') {
        mkdirSync(outputPath, { recursive: true });
      }

      await new Promise<void>((resolve, reject) => {
        const args = [
          ...this.getBaseArgs(),
          '-d', this.config.database,
          flag,
          '--no-password',
          '--no-tablespaces',
        ];

        if (format === 'DIRECTORY') {
          // parallel jobs for directory format
          args.push('--jobs=4', '-f', outputPath);
          const dump = spawn('pg_dump', args, { env: this.getEnv() });
          let error = '';
          dump.stderr.on('data', (d: Buffer) => error += d.toString());
          dump.on('close', (code: number) => code === 0 ? resolve() : reject(new Error(`pg_dump failed: ${error}`)));
          dump.on('error', reject);
        } else if (format === 'COMPRESSED_SQL') {
          // pipe plain SQL through gzip
          args.push('-f', '-'); // write to stdout
          const dump = spawn('pg_dump', [...this.getBaseArgs(), '-d', this.config.database, '-Fp', '--no-password', '--no-tablespaces'], { env: this.getEnv() });
          const gzip = createGzip();
          const out = createWriteStream(outputPath);
          dump.stdout.pipe(gzip).pipe(out);
          let error = '';
          dump.stderr.on('data', (d: Buffer) => error += d.toString());
          out.on('finish', resolve);
          dump.on('close', (code: number) => { if (code !== 0) reject(new Error(`pg_dump failed: ${error}`)); });
          dump.on('error', reject);
        } else {
          // CUSTOM, TAR, PLAIN_SQL — write direct to file
          const dumpArgs = [...this.getBaseArgs(), '-d', this.config.database, flag, '--no-password', '--no-tablespaces', '-f', outputPath];
          const dump = spawn('pg_dump', dumpArgs, { env: this.getEnv() });
          let error = '';
          dump.stderr.on('data', (d: Buffer) => error += d.toString());
          dump.on('close', (code: number) => code === 0 ? resolve() : reject(new Error(`pg_dump failed: ${error}`)));
          dump.on('error', reject);
        }
      });

      onProgress?.(95);
      // For directory format, size is sum of all files inside
      const fileSize = format === 'DIRECTORY'
        ? (() => {
            try {
              let total = 0;
              const entries = require('fs').readdirSync(outputPath, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isFile()) total += statSync(path.join(outputPath, entry.name)).size;
              }
              return total;
            } catch { return 0; }
          })()
        : statSync(outputPath).size;

      onProgress?.(100);
      return { fileName, filePath: outputPath, fileSize };
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
      const isCustomFormat = backupFilePath.endsWith('.dump');
      const isTarFormat = backupFilePath.endsWith('.tar');
      const isDirectory = (() => { try { return statSync(backupFilePath).isDirectory(); } catch { return false; } })();
      const usePgRestore = isCustomFormat || isTarFormat || isDirectory;

      await new Promise<void>((resolve, reject) => {
        let proc;

        if (usePgRestore) {
          const args = [
            ...this.getBaseArgs(),
            '-d', dbName,
            '--no-password',
            '--clean',
            '--if-exists',
          ];
          if (isDirectory) args.push('--jobs=4');
          args.push(backupFilePath);

          proc = spawn('pg_restore', args, { env: this.getEnv() });
        } else {
          proc = spawn('psql', [
            ...this.getBaseArgs(),
            '-d', dbName,
            '--no-password',
          ], { env: this.getEnv() });

          const fileStream = createReadStream(backupFilePath);
          if (backupFilePath.endsWith('.gz')) {
            fileStream.pipe(createGunzip()).pipe(proc.stdin);
          } else {
            fileStream.pipe(proc.stdin);
          }
        }

        let error = '';
        proc.stderr.on('data', (d: Buffer) => error += d.toString());
        proc.on('close', (code: number) => {
          if (code === 0) resolve();
          else reject(new Error(`pg_restore failed: ${error}`));
        });
        proc.on('error', reject);
      });
    } finally {
      tunnel?.close();
    }
  }

  async listDatabases(): Promise<string[]> {
    let tunnel: SSHTunnel | null = null;
    let pool: Pool | null = null;
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      const host = this.config.sshEnabled ? '127.0.0.1' : this.config.host;
      const port = this.config.sshEnabled ? (this.config as any)._localPort || this.config.port : this.config.port;

      pool = new Pool({
        host,
        port,
        user: this.config.username,
        password: this.config.password,
        database: 'postgres',
        ssl: this.getSslOptions(),
        connectionTimeoutMillis: 10000,
        max: 1,
      });

      const res = await pool.query('SELECT datname FROM pg_database WHERE datistemplate = false;');
      return res.rows.map(r => r.datname);
    } catch (error: any) {
      throw new Error(`Failed to list databases: ${error.message}`);
    } finally {
      await pool?.end();
      tunnel?.close();
    }
  }

  async getDbInfo(): Promise<DbInfo> {
    let tunnel: SSHTunnel | null = null;
    let pool: Pool | null = null;
    try {
      if (this.config.sshEnabled) {
        tunnel = new SSHTunnel(this.config);
        const localPort = await tunnel.connect();
        (this.config as any)._localPort = localPort;
      }

      const host = this.config.sshEnabled ? '127.0.0.1' : this.config.host;
      const port = this.config.sshEnabled ? (this.config as any)._localPort || this.config.port : this.config.port;

      pool = new Pool({
        host,
        port,
        user: this.config.username,
        password: this.config.password,
        database: this.config.database,
        ssl: this.getSslOptions(),
        connectionTimeoutMillis: 10000,
        max: 1,
      });

      // Version
      const { rows: [vRow] } = await pool.query('SELECT version() AS v');
      const version = vRow.v as string;

      // Database total size
      const { rows: [sizeRow] } = await pool.query(
        'SELECT pg_database_size($1) AS total', [this.config.database]
      );
      const totalSizeBytes = Number(sizeRow.total);

      // Tables and sizes. Row counts are fetched exactly per table below.
      const { rows: tableRows } = await pool.query(`
        SELECT
          t.table_schema                            AS schema,
          t.table_name                              AS name,
          pg_relation_size(
            quote_ident(t.table_schema) || '.' || quote_ident(t.table_name)
          )                                         AS logical_size_bytes,
          pg_indexes_size(
            quote_ident(t.table_schema) || '.' || quote_ident(t.table_name)
          )                                         AS index_size_bytes,
          pg_total_relation_size(
            quote_ident(t.table_schema) || '.' || quote_ident(t.table_name)
          )                                         AS size_bytes
        FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name
      `);

      // Primary key columns
      const { rows: pkRows } = await pool.query(`
        SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = 'public'
      `);
      const pkSet = new Set(pkRows.map(r => `${r.table_name}.${r.column_name}`));

      // Columns for each table
      const tables: TableInfo[] = await Promise.all(
        tableRows.map(async (t) => {
          const tableSchema = t.schema as string;
          const tableName = t.name as string;
          const safeSchema = this.quoteIdentifier(tableSchema);
          const safeTable = this.quoteIdentifier(tableName);

          const { rows: [countRow] } = await pool!.query(
            `SELECT COUNT(*)::bigint AS row_count FROM ${safeSchema}.${safeTable}`
          );

          const { rows: colRows } = await pool!.query(`
            SELECT 
              column_name as name, 
              data_type               AS type,
              character_maximum_length,
              numeric_precision,
              is_nullable             AS nullable,
              column_default          AS default_val,
              udt_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
            ORDER BY ordinal_position
          `, [tableName]);

          const { rows: indexRows } = await pool!.query(`
            SELECT
              i.relname AS index_name,
              ix.indisunique AS is_unique,
              ix.indisprimary AS is_primary,
              a.attname AS column_name,
              arr.n AS position
            FROM pg_class t
            JOIN pg_namespace ns ON ns.oid = t.relnamespace
            JOIN pg_index ix ON ix.indrelid = t.oid
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS arr(attnum, n) ON true
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = arr.attnum
            WHERE ns.nspname = 'public'
              AND t.relname = $1
            ORDER BY i.relname, arr.n
          `, [tableName]);

          const indexMap = new Map<string, { name: string; unique: boolean; primary: boolean; columns: string[] }>();
          indexRows.forEach((r) => {
            const indexName = r.index_name as string;
            if (!indexMap.has(indexName)) {
              indexMap.set(indexName, {
                name: indexName,
                unique: Boolean(r.is_unique),
                primary: Boolean(r.is_primary),
                columns: [],
              });
            }

            indexMap.get(indexName)!.columns.push(r.column_name as string);
          });

          const indexes = [...indexMap.values()];
          const primaryKeyColumns = indexes.find((i) => i.primary)?.columns ?? [];
          const uniqueConstraints = indexes
            .filter((i) => i.unique && !i.primary)
            .map((i) => ({ name: i.name, columns: i.columns }));
          const indexedColumns = new Set(indexes.flatMap((i) => i.columns));
          const uniqueColumns = new Set(indexes.filter((i) => i.unique).flatMap((i) => i.columns));

          const { rows: fkRows } = await pool!.query(`
            SELECT
              tc.constraint_name,
              kcu.column_name,
              ccu.table_name AS referenced_table,
              ccu.column_name AS referenced_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema = tc.table_schema
            WHERE tc.table_schema = 'public'
              AND tc.table_name = $1
              AND tc.constraint_type = 'FOREIGN KEY'
          `, [tableName]);

          const foreignKeys = fkRows.map((r) => ({
            constraintName: r.constraint_name as string,
            column: r.column_name as string,
            referencedTable: r.referenced_table as string,
            referencedColumn: r.referenced_column as string,
          }));
          const foreignKeyByColumn = new Map(foreignKeys.map((fk) => [fk.column, fk]));

          const columns: ColumnInfo[] = colRows.map((c) => {
            // Build a readable type string
            let typeName = c.type as string;
            if (typeName === 'character varying' && c.character_maximum_length) {
              typeName = `varchar(${c.character_maximum_length})`;
            } else if (typeName === 'numeric' && c.numeric_precision) {
              typeName = `numeric(${c.numeric_precision})`;
            } else if (typeName === 'USER-DEFINED') {
              typeName = c.udt_name as string;
            }

            return {
              name: c.name as string,
              type: typeName,
              nullable: c.nullable === 'YES',
              defaultValue: c.default_val as string | null,
              isPrimaryKey: pkSet.has(`${t.name}.${c.name}`),
              isUnique: uniqueColumns.has(c.name as string),
              isIndexed: indexedColumns.has(c.name as string),
              isForeignKey: foreignKeyByColumn.has(c.name as string),
              references: foreignKeyByColumn.has(c.name as string)
                ? {
                    table: foreignKeyByColumn.get(c.name as string)!.referencedTable,
                    column: foreignKeyByColumn.get(c.name as string)!.referencedColumn,
                    constraintName: foreignKeyByColumn.get(c.name as string)!.constraintName,
                  }
                : undefined,
            };
          });

          return {
            name: tableName,
            rowCount: Number(countRow?.row_count ?? 0),
            sizeBytes: Number(t.size_bytes),
            logicalSizeBytes: Number(t.logical_size_bytes),
            indexSizeBytes: Number(t.index_size_bytes),
            extraStorageBytes: Math.max(
              Number(t.size_bytes) - Number(t.logical_size_bytes) - Number(t.index_size_bytes),
              0
            ),
            overheadBytes: Math.max(Number(t.size_bytes) - Number(t.logical_size_bytes), 0),
            overheadPercent: Number(t.logical_size_bytes) > 0
              ? (Math.max(Number(t.size_bytes) - Number(t.logical_size_bytes), 0) / Number(t.logical_size_bytes)) * 100
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
      await pool?.end();
      tunnel?.close();
    }
  }
}
