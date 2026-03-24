import mysql2 from 'mysql2/promise';
import { Pool, PoolClient } from 'pg';
import { ConnectionConfig } from '../../engines/base.engine';
import { buildPGCreateTable, escapeValue } from '../schema/schema-builder';
import { getMySQLTableMeta } from './mysql-executor';
import { getPGTableMeta } from './pg-executor';
import { TableMeta, MigrationOptions } from '../types/migration.types';
import { getEngineHostPort } from '../utils/engine-host';

/**
 * Migrate MySQL/MariaDB to PostgreSQL.
 */
export async function migrateMySQL2PG(
  src: ConnectionConfig,
  dst: ConnectionConfig,
  opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcRef = await getEngineHostPort(src);
  const dstRef = await getEngineHostPort(dst);

  const srcConn = await mysql2.createConnection({
    host: srcRef.host,
    port: srcRef.port,
    user: src.username,
    password: src.password ?? undefined,
    database: src.database,
    ssl: src.sslEnabled ? { rejectUnauthorized: false } : undefined,
  });

  const dstPool = new Pool({
    host: dstRef.host,
    port: dstRef.port,
    user: dst.username,
    password: dst.password ?? undefined,
    database: dst.database,
    ssl: dst.sslEnabled ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });

  try {
    const tables = opts.tables || [];
    const [rows] = await srcConn.query<mysql2.RowDataPacket[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
      [src.database]
    );
    const allTables = rows.map((r) => r.TABLE_NAME as string);
    const tablesToMigrate = opts.tables?.length ? allTables.filter((t) => opts.tables!.includes(t)) : allTables;

    const metas = await getMySQLTableMeta(srcConn, src.database, tablesToMigrate);

    let totalRows = 0;
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      const createSQL = buildPGCreateTable(meta, 'MYSQL');
      const dstClient = await dstPool.connect();

      try {
        await dstClient.query(`DROP TABLE IF EXISTS "${meta.name}" CASCADE`);
        await dstClient.query(createSQL);
        opts.onProgress?.({
          currentTable: meta.name,
          tablesCompleted: i,
          tableCount: metas.length,
          rowsMigrated: totalRows,
          progress: Math.round((i / metas.length) * 100),
        });

        const batchSize = opts.batchSize || 500;
        let offset = 0;
        let rowCount = 0;

        while (true) {
          const [rows] = await srcConn.query<mysql2.RowDataPacket[]>(
            `SELECT * FROM \`${meta.name}\` LIMIT ? OFFSET ?`,
            [batchSize, offset]
          );

          if (rows.length === 0) break;

          const columns = meta.columns.map((c) => c.name).join(', ');
          const placeholders = meta.columns.map((_, idx) => `$${idx + 1}`).join(', ');
          const values = rows.map((row) =>
            meta.columns.map((col) => {
              const val = row[col.name];
              if (val === null) return null;
              if (Buffer.isBuffer(val)) return val.toString('utf-8');
              return val;
            })
          );

          if (values.length > 0) {
            const insertSQL = `INSERT INTO "${meta.name}" (${columns}) VALUES ${values
              .map(
                (vals) =>
                  `(${vals
                    .map((v) => (v === null ? 'NULL' : escapeValue(v)))
                    .join(', ')})`
              )
              .join(', ')}`;
            await dstClient.query(insertSQL);
          }

          rowCount += rows.length;
          offset += batchSize;
        }

        totalRows += rowCount;
      } finally {
        dstClient.release();
      }
    }

    opts.onProgress?.({
      currentTable: 'Finished',
      tablesCompleted: metas.length,
      tableCount: metas.length,
      rowsMigrated: totalRows,
      progress: 100,
    });

    return { rowsMigrated: totalRows };
  } finally {
    await srcConn.end();
    await dstPool.end();
    if (srcRef.tunnel) srcRef.tunnel.close();
    if (dstRef.tunnel) dstRef.tunnel.close();
  }
}

/**
 * Migrate PostgreSQL to MySQL/MariaDB.
 */
export async function migratePG2MySQL(
  src: ConnectionConfig,
  dst: ConnectionConfig,
  opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcRef = await getEngineHostPort(src);
  const dstRef = await getEngineHostPort(dst);

  const srcPool = new Pool({
    host: srcRef.host,
    port: srcRef.port,
    user: src.username,
    password: src.password ?? undefined,
    database: src.database,
    ssl: src.sslEnabled ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });

  const dstConn = await mysql2.createConnection({
    host: dstRef.host,
    port: dstRef.port,
    user: dst.username,
    password: dst.password ?? undefined,
    database: dst.database,
    ssl: dst.sslEnabled ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const { rows: tableRows } = await srcPool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const allTables = tableRows.map((r) => r.table_name as string);
    const tablesToMigrate = opts.tables?.length ? allTables.filter((t) => opts.tables!.includes(t)) : allTables;

    const metas = await getPGTableMeta(srcPool, tablesToMigrate);

    let totalRows = 0;
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      await dstConn.query(`DROP TABLE IF EXISTS \`${meta.name}\``);

      const createSQL = `CREATE TABLE \`${meta.name}\` (${meta.columns.map((c) => `\`${c.name}\` ${c.type}`).join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
      await dstConn.query(createSQL);

      opts.onProgress?.({
        currentTable: meta.name,
        tablesCompleted: i,
        tableCount: metas.length,
        rowsMigrated: totalRows,
        progress: Math.round((i / metas.length) * 100),
      });

      const batchSize = opts.batchSize || 500;
      let offset = 0;
      let rowCount = 0;

      while (true) {
        const result = await srcPool.query(`SELECT * FROM "${meta.name}" LIMIT $1 OFFSET $2`, [
          batchSize,
          offset,
        ]);
        const rows = result.rows;

        if (rows.length === 0) break;

        const columns = meta.columns.map((c) => `\`${c.name}\``).join(', ');
        const placeholders = rows
          .map(
            () =>
              `(${meta.columns.map(() => '?').join(', ')})`
          )
          .join(', ');

        const values = rows.flatMap((row) =>
          meta.columns.map((col) => {
            const val = (row as Record<string, unknown>)[col.name];
            if (val === null) return null;
            if (Buffer.isBuffer(val)) return val.toString('utf-8');
            return val;
          })
        );

        if (values.length > 0) {
          await dstConn.query(
            `INSERT INTO \`${meta.name}\` (${columns}) VALUES ${placeholders}`,
            values
          );
        }

        rowCount += rows.length;
        offset += batchSize;
      }

      totalRows += rowCount;
    }

    opts.onProgress?.({
      currentTable: 'Finished',
      tablesCompleted: metas.length,
      tableCount: metas.length,
      rowsMigrated: totalRows,
      progress: 100,
    });

    return { rowsMigrated: totalRows };
  } finally {
    await srcPool.end();
    await dstConn.end();
    if (srcRef.tunnel) srcRef.tunnel.close();
    if (dstRef.tunnel) dstRef.tunnel.close();
  }
}
