import * as mysql2 from 'mysql2/promise';
import { CDCTrackerService } from './cdc-tracker.service';
import { SSHTunnel } from '../ssh.service';
import { prisma } from '../../config/database';
import { decrypt, decryptIfPresent } from '../crypto.service';
import { logger } from '../../config/logger';
import {
  SyncConfigWithConnections,
  escapeIdentifierMySQL,
} from './sync-utils';

interface ChangeLog {
  id: string;
  syncConfigId: string;
  tableName: string;
  operation: string;
  primaryKeyValues: any;
  changeData: any;
  timestamp: Date;
  checkpoint: string;
  origin: string;
  synchronized: boolean;
  synchronizedAt: Date | null;
}

interface BinlogPosition {
  file: string;
  position: number;
}

/**
 * MySQLCDCTracker - Change Data Capture tracker for MySQL/MariaDB databases
 * 
 * Implements CDC using trigger-based change capture.
 * Binary log support is detected but falls back to triggers when binlog
 * parsing is not implemented.
 * 
 * Requirements: 2.2, 2.4, 2.5
 */
export class MySQLCDCTracker implements CDCTrackerService {
  /** Per-config tracking of whether to use trigger-based CDC */
  private triggerBasedConfigs = new Map<string, boolean>();

  private isTriggerBased(configId: string): boolean {
    return this.triggerBasedConfigs.get(configId) ?? true; // default to trigger-based (safe)
  }

  /**
   * Create a database connection with SSH tunnel support
   */
  private async createConnection(
    connectionConfig: any,
    origin: 'source' | 'target'
  ): Promise<{ conn: mysql2.Connection; tunnel: SSHTunnel | null }> {
    let tunnel: SSHTunnel | null = null;

    try {
      // Decrypt connection credentials
      const decryptedConfig = {
        ...connectionConfig,
        host: decrypt(connectionConfig.host),
        username: decrypt(connectionConfig.username),
        password: decrypt(connectionConfig.password),
        database: decrypt(connectionConfig.database),
        sshHost: decryptIfPresent(connectionConfig.sshHost),
        sshUsername: decryptIfPresent(connectionConfig.sshUsername),
        sshPrivateKey: decryptIfPresent(connectionConfig.sshPrivateKey),
        sshPassphrase: decryptIfPresent(connectionConfig.sshPassphrase),
      };

      if (decryptedConfig.sshEnabled) {
        tunnel = new SSHTunnel(decryptedConfig);
        const localPort = await tunnel.connect();
        (decryptedConfig as any)._localPort = localPort;
      }

      const host = decryptedConfig.sshEnabled ? '127.0.0.1' : decryptedConfig.host;
      const port = decryptedConfig.sshEnabled
        ? (decryptedConfig as any)._localPort || decryptedConfig.port
        : decryptedConfig.port;

      const conn = await mysql2.createConnection({
        host,
        port,
        user: decryptedConfig.username,
        password: decryptedConfig.password,
        database: decryptedConfig.database,
        ssl: decryptedConfig.sslEnabled ? { rejectUnauthorized: false } : undefined,
        connectTimeout: decryptedConfig.connectionTimeout || 30000,
      });

      return { conn, tunnel };
    } catch (error) {
      tunnel?.close();
      throw error;
    }
  }

  /**
   * Check if binary log is enabled on the MySQL server
   */
  private async isBinlogEnabled(conn: mysql2.Connection): Promise<boolean> {
    try {
      const [rows] = await conn.query<mysql2.RowDataPacket[]>(
        "SHOW VARIABLES LIKE 'log_bin'"
      );
      return rows.length > 0 && rows[0].Value === 'ON';
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the current binary log position
   */
  private async getBinlogPosition(conn: mysql2.Connection): Promise<BinlogPosition | null> {
    try {
      const [rows] = await conn.query<mysql2.RowDataPacket[]>('SHOW MASTER STATUS');
      if (rows.length === 0) {
        return null;
      }
      return {
        file: rows[0].File as string,
        position: rows[0].Position as number,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Get list of tables to track based on include/exclude filters
   */
  private async getTablesToTrack(
    conn: mysql2.Connection,
    database: string,
    includeTables: string[],
    excludeTables: string[]
  ): Promise<string[]> {
    const [rows] = await conn.query<mysql2.RowDataPacket[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES 
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
      [database]
    );

    let tables = rows.map((r) => r.TABLE_NAME as string);

    // Apply filters
    if (includeTables.length > 0) {
      tables = tables.filter((t) => includeTables.includes(t));
    }
    if (excludeTables.length > 0) {
      tables = tables.filter((t) => !excludeTables.includes(t));
    }

    return tables;
  }

  /**
   * Get primary key columns for a table
   */
  private async getPrimaryKeyColumns(
    conn: mysql2.Connection,
    database: string,
    tableName: string
  ): Promise<string[]> {
    const [rows] = await conn.query<mysql2.RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
       ORDER BY ORDINAL_POSITION`,
      [database, tableName]
    );
    return rows.map((r) => r.COLUMN_NAME as string);
  }

  /**
   * Create audit triggers for a table (trigger-based CDC)
   * Uses escaped identifiers to prevent SQL injection.
   */
  private async createTriggersForTable(
    conn: mysql2.Connection,
    database: string,
    tableName: string,
    syncConfigId: string
  ): Promise<void> {
    const pkColumns = await this.getPrimaryKeyColumns(conn, database, tableName);
    if (pkColumns.length === 0) {
      throw new Error(`Table ${tableName} has no primary key`);
    }

    const allColumns = await this.getTableColumns(conn, database, tableName);
    // UUID only — safe for use in trigger names
    const sanitizedConfigId = syncConfigId.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 20);
    const triggerPrefix = `cdc_${sanitizedConfigId}`;

    const escapedDb = escapeIdentifierMySQL(database);
    const escapedTable = escapeIdentifierMySQL(tableName);

    // Create changelog table if it doesn't exist (in the source database)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ${escapedDb}.\`_cdc_changelog\` (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        sync_config_id VARCHAR(36) NOT NULL,
        table_name VARCHAR(255) NOT NULL,
        operation VARCHAR(10) NOT NULL,
        primary_key_values JSON NOT NULL,
        change_data JSON,
        change_timestamp TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),
        INDEX idx_sync_config (sync_config_id, change_timestamp)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Build primary key JSON object for triggers using escaped column refs
    const pkJsonParts = pkColumns.map((col) => `'${col.replace(/'/g, "''")}', OLD.${escapeIdentifierMySQL(col)}`).join(', ');
    const pkJsonPartsNew = pkColumns.map((col) => `'${col.replace(/'/g, "''")}', NEW.${escapeIdentifierMySQL(col)}`).join(', ');
    const allColumnsJsonNew = this.buildAllColumnsJson(allColumns, 'NEW');
    const allColumnsJsonOld = this.buildAllColumnsJson(allColumns, 'OLD');

    const escapedSyncConfigId = syncConfigId.replace(/'/g, "''");

    // INSERT trigger
    const insertTriggerName = `${triggerPrefix}_${sanitizedConfigId}_insert`;
    await conn.query(`DROP TRIGGER IF EXISTS ${escapeIdentifierMySQL(insertTriggerName)}`);
    await conn.query(`
      CREATE TRIGGER ${escapeIdentifierMySQL(insertTriggerName)}
      AFTER INSERT ON ${escapedDb}.${escapedTable}
      FOR EACH ROW
      BEGIN
        INSERT INTO ${escapedDb}.\`_cdc_changelog\` (sync_config_id, table_name, operation, primary_key_values, change_data)
        VALUES (
          '${escapedSyncConfigId}',
          '${tableName.replace(/'/g, "''")}',
          'INSERT',
          JSON_OBJECT(${pkJsonPartsNew}),
          JSON_OBJECT(${allColumnsJsonNew})
        );
      END
    `);

    // UPDATE trigger
    const updateTriggerName = `${triggerPrefix}_${sanitizedConfigId}_update`;
    await conn.query(`DROP TRIGGER IF EXISTS ${escapeIdentifierMySQL(updateTriggerName)}`);
    await conn.query(`
      CREATE TRIGGER ${escapeIdentifierMySQL(updateTriggerName)}
      AFTER UPDATE ON ${escapedDb}.${escapedTable}
      FOR EACH ROW
      BEGIN
        INSERT INTO ${escapedDb}.\`_cdc_changelog\` (sync_config_id, table_name, operation, primary_key_values, change_data)
        VALUES (
          '${escapedSyncConfigId}',
          '${tableName.replace(/'/g, "''")}',
          'UPDATE',
          JSON_OBJECT(${pkJsonPartsNew}),
          JSON_OBJECT(${allColumnsJsonNew})
        );
      END
    `);

    // DELETE trigger
    const deleteTriggerName = `${triggerPrefix}_${sanitizedConfigId}_delete`;
    await conn.query(`DROP TRIGGER IF EXISTS ${escapeIdentifierMySQL(deleteTriggerName)}`);
    await conn.query(`
      CREATE TRIGGER ${escapeIdentifierMySQL(deleteTriggerName)}
      AFTER DELETE ON ${escapedDb}.${escapedTable}
      FOR EACH ROW
      BEGIN
        INSERT INTO ${escapedDb}.\`_cdc_changelog\` (sync_config_id, table_name, operation, primary_key_values, change_data)
        VALUES (
          '${escapedSyncConfigId}',
          '${tableName.replace(/'/g, "''")}',
          'DELETE',
          JSON_OBJECT(${pkJsonParts}),
          NULL
        );
      END
    `);
  }

  /**
   * Get all columns for a table to build JSON_OBJECT expression
   */
  private async getTableColumns(
    conn: mysql2.Connection,
    database: string,
    tableName: string
  ): Promise<string[]> {
    const [rows] = await conn.query<mysql2.RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [database, tableName]
    );
    return rows.map((r) => r.COLUMN_NAME as string);
  }

  /**
   * Build JSON_OBJECT expression for all columns in a table
   * Uses escaped identifiers for column references
   */
  private buildAllColumnsJson(columns: string[], prefix: string): string {
    if (columns.length === 0) {
      return "'{}'";
    }
    const parts = columns.map((col) => `'${col.replace(/'/g, "''")}', ${prefix}.${escapeIdentifierMySQL(col)}`).join(', ');
    return parts;
  }

  /**
   * Drop audit triggers for a table
   */
  private async dropTriggersForTable(
    conn: mysql2.Connection,
    database: string,
    tableName: string,
    syncConfigId: string
  ): Promise<void> {
    const sanitizedConfigId = syncConfigId.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 20);
    const triggerPrefix = `cdc_${sanitizedConfigId}`;

    try {
      await conn.query(`DROP TRIGGER IF EXISTS ${escapeIdentifierMySQL(`${triggerPrefix}_${sanitizedConfigId}_insert`)}`);
      await conn.query(`DROP TRIGGER IF EXISTS ${escapeIdentifierMySQL(`${triggerPrefix}_${sanitizedConfigId}_update`)}`);
      await conn.query(`DROP TRIGGER IF EXISTS ${escapeIdentifierMySQL(`${triggerPrefix}_${sanitizedConfigId}_delete`)}`);
    } catch (error) {
      // Ignore errors if triggers don't exist
    }
  }

  /**
   * Initialize change tracking for a sync configuration
   * Requirements: 2.1
   */
  async initializeTracking(config: SyncConfigWithConnections): Promise<void> {
    const sourceConnection = config.sourceConnection || 
      await prisma.connection.findUnique({ where: { id: config.sourceConnectionId } });
    
    if (!sourceConnection) {
      throw new Error('Source connection not found');
    }

    const { conn, tunnel } = await this.createConnection(sourceConnection, 'source');
    const decryptedDb = decrypt(sourceConnection.database);

    try {
      // Check if binary log is enabled
      const binlogEnabled = await this.isBinlogEnabled(conn);
      
      if (!binlogEnabled) {
        logger.info(`Binary log not enabled for ${decryptedDb}, using trigger-based CDC`);
        this.triggerBasedConfigs.set(config.id, true);
      } else {
        // Binlog parsing is not implemented — fall back to trigger-based CDC
        logger.info(`Binary log enabled for ${decryptedDb} but parsing not implemented, using trigger-based CDC`);
        this.triggerBasedConfigs.set(config.id, true);
      }

      // Always use trigger-based for now (binlog parsing is not implemented)
      const tables = await this.getTablesToTrack(
        conn,
        decryptedDb,
        config.includeTables,
        config.excludeTables
      );

      for (const table of tables) {
        await this.createTriggersForTable(
          conn,
          decryptedDb,
          table,
          config.id
        );
      }
    } finally {
      await conn.end();
      tunnel?.close();
    }
  }

  /**
   * Teardown change tracking for a sync configuration
   * Requirements: 2.1
   */
  async teardownTracking(config: SyncConfigWithConnections): Promise<void> {
    const sourceConnection = config.sourceConnection || 
      await prisma.connection.findUnique({ where: { id: config.sourceConnectionId } });
    
    if (!sourceConnection) {
      return; // Connection already deleted
    }

    const { conn, tunnel } = await this.createConnection(sourceConnection, 'source');
    const decryptedDb = decrypt(sourceConnection.database);

    try {
      const tables = await this.getTablesToTrack(
        conn,
        decryptedDb,
        config.includeTables,
        config.excludeTables
      );

      for (const table of tables) {
        await this.dropTriggersForTable(
          conn,
          decryptedDb,
          table,
          config.id
        );
      }

      // Optionally clean up the changelog table
      const escapedDb = escapeIdentifierMySQL(decryptedDb);
      await conn.query(`DROP TABLE IF EXISTS ${escapedDb}.\`_cdc_changelog\``);
    } finally {
      await conn.end();
      tunnel?.close();
    }

    // Clean up per-config tracking
    this.triggerBasedConfigs.delete(config.id);
  }

  /**
   * Capture changes from the database since the specified checkpoint
   * Requirements: 2.4, 2.6
   */
  async captureChanges(config: SyncConfigWithConnections, since: string): Promise<ChangeLog[]> {
    const sourceConnection = config.sourceConnection || 
      await prisma.connection.findUnique({ where: { id: config.sourceConnectionId } });
    
    if (!sourceConnection) {
      throw new Error('Source connection not found');
    }

    // Always use trigger-based capture (binlog parsing not implemented)
    return this.captureChangesFromTriggers(config, sourceConnection, since);
  }

  /**
   * Capture changes from trigger-based changelog table
   */
  private async captureChangesFromTriggers(
    config: SyncConfigWithConnections,
    sourceConnection: any,
    since: string
  ): Promise<ChangeLog[]> {
    const { conn, tunnel } = await this.createConnection(sourceConnection, 'source');
    const decryptedDb = decrypt(sourceConnection.database);

    try {
      // Parse checkpoint (format: "timestamp:lastId")
      const [timestampStr, lastIdStr] = since.split(':');
      const sinceTimestamp = timestampStr || new Date(0).toISOString();
      const sinceId = lastIdStr ? parseInt(lastIdStr, 10) : 0;

      const escapedDb = escapeIdentifierMySQL(decryptedDb);
      const [rows] = await conn.query<mysql2.RowDataPacket[]>(
        `SELECT id, table_name, operation, primary_key_values, change_data, change_timestamp
         FROM ${escapedDb}.\`_cdc_changelog\`
         WHERE sync_config_id = ? AND (change_timestamp > ? OR (change_timestamp = ? AND id > ?))
         ORDER BY change_timestamp, id
         LIMIT 10000`,
        [config.id, sinceTimestamp, sinceTimestamp, sinceId]
      );

      const changeLogs: ChangeLog[] = [];

      for (const row of rows) {
        const checkpoint = `${row.change_timestamp.toISOString()}:${row.id}`;
        
        changeLogs.push({
          id: '', // Will be generated by Prisma
          syncConfigId: config.id,
          tableName: row.table_name,
          operation: row.operation,
          primaryKeyValues: row.primary_key_values,
          changeData: row.change_data,
          timestamp: new Date(row.change_timestamp),
          checkpoint,
          origin: 'source',
          synchronized: false,
          synchronizedAt: null,
        });
      }

      return changeLogs;
    } finally {
      await conn.end();
      tunnel?.close();
    }
  }

  /**
   * Get the current checkpoint for a sync configuration
   * Requirements: 2.5
   */
  async getCheckpoint(config: SyncConfigWithConnections, origin: 'source' | 'target'): Promise<string> {
    const connectionId = origin === 'source' ? config.sourceConnectionId : config.targetConnectionId;
    const connection = await prisma.connection.findUnique({ where: { id: connectionId } });
    
    if (!connection) {
      throw new Error(`${origin} connection not found`);
    }

    const { conn, tunnel } = await this.createConnection(connection, origin);

    try {
      // For trigger-based, return current timestamp
      const [[row]] = await conn.query<mysql2.RowDataPacket[]>('SELECT NOW(6) as now');
      return `${new Date(row.now).toISOString()}:0`;
    } finally {
      await conn.end();
      tunnel?.close();
    }
  }

  /**
   * Update the checkpoint after successful synchronization
   * Requirements: 2.5, 7.4
   */
  async updateCheckpoint(
    config: SyncConfigWithConnections,
    checkpoint: string,
    origin: 'source' | 'target'
  ): Promise<void> {
    const field = origin === 'source' ? 'sourceCheckpoint' : 'targetCheckpoint';
    
    await prisma.syncState.update({
      where: { syncConfigId: config.id },
      data: { [field]: checkpoint },
    });
  }

  /**
   * Clean up old change log entries
   * Requirements: 2.7
   */
  async cleanupChangeLogs(config: SyncConfigWithConnections, before: Date): Promise<number> {
    const result = await prisma.changeLog.deleteMany({
      where: {
        syncConfigId: config.id,
        synchronized: true,
        synchronizedAt: {
          lt: before,
        },
      },
    });

    return result.count;
  }
}
