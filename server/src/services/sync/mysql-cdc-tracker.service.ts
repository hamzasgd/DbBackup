import * as mysql2 from 'mysql2/promise';
import { CDCTrackerService } from './cdc-tracker.service';
import { SSHTunnel } from '../ssh.service';
import { prisma } from '../../config/database';

interface SyncConfiguration {
  id: string;
  userId: string;
  name: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  direction: string;
  mode: string;
  conflictStrategy: string;
  includeTables: string[];
  excludeTables: string[];
  cronExpression: string | null;
  batchSize: number;
  parallelTables: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  sourceConnection?: any;
  targetConnection?: any;
}

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
 * Implements CDC using two strategies:
 * 1. Binary log position tracking (primary method)
 * 2. Trigger-based change capture (fallback)
 * 
 * Requirements: 2.2, 2.4, 2.5
 */
export class MySQLCDCTracker implements CDCTrackerService {
  private useTriggerBased: boolean = false;

  /**
   * Create a database connection with SSH tunnel support
   */
  private async createConnection(
    connectionConfig: any,
    origin: 'source' | 'target'
  ): Promise<{ conn: mysql2.Connection; tunnel: SSHTunnel | null }> {
    let tunnel: SSHTunnel | null = null;

    try {
      if (connectionConfig.sshEnabled) {
        tunnel = new SSHTunnel(connectionConfig);
        const localPort = await tunnel.connect();
        (connectionConfig as any)._localPort = localPort;
      }

      const host = connectionConfig.sshEnabled ? '127.0.0.1' : connectionConfig.host;
      const port = connectionConfig.sshEnabled
        ? (connectionConfig as any)._localPort || connectionConfig.port
        : connectionConfig.port;

      const conn = await mysql2.createConnection({
        host,
        port,
        user: connectionConfig.username,
        password: connectionConfig.password,
        database: connectionConfig.database,
        ssl: connectionConfig.sslEnabled ? { rejectUnauthorized: false } : undefined,
        connectTimeout: connectionConfig.connectionTimeout || 30000,
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
    const triggerPrefix = `cdc_${syncConfigId.replace(/-/g, '_').substring(0, 20)}`;

    // Create changelog table if it doesn't exist (in the source database)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ${database}._cdc_changelog (
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

    // Build primary key JSON object for triggers
    const pkJsonParts = pkColumns.map((col) => `'${col}', OLD.${col}`).join(', ');
    const pkJsonPartsNew = pkColumns.map((col) => `'${col}', NEW.${col}`).join(', ');
    const allColumnsJsonNew = this.buildAllColumnsJson(allColumns, 'NEW');
    const allColumnsJsonOld = this.buildAllColumnsJson(allColumns, 'OLD');

    // INSERT trigger
    await conn.query(`
      CREATE TRIGGER ${triggerPrefix}_${tableName}_insert
      AFTER INSERT ON ${database}.${tableName}
      FOR EACH ROW
      BEGIN
        INSERT INTO ${database}._cdc_changelog (sync_config_id, table_name, operation, primary_key_values, change_data)
        VALUES (
          '${syncConfigId}',
          '${tableName}',
          'INSERT',
          JSON_OBJECT(${pkJsonPartsNew}),
          JSON_OBJECT(${allColumnsJsonNew})
        );
      END
    `);

    // UPDATE trigger
    await conn.query(`
      CREATE TRIGGER ${triggerPrefix}_${tableName}_update
      AFTER UPDATE ON ${database}.${tableName}
      FOR EACH ROW
      BEGIN
        INSERT INTO ${database}._cdc_changelog (sync_config_id, table_name, operation, primary_key_values, change_data)
        VALUES (
          '${syncConfigId}',
          '${tableName}',
          'UPDATE',
          JSON_OBJECT(${pkJsonPartsNew}),
          JSON_OBJECT(${allColumnsJsonNew})
        );
      END
    `);

    // DELETE trigger
    await conn.query(`
      CREATE TRIGGER ${triggerPrefix}_${tableName}_delete
      AFTER DELETE ON ${database}.${tableName}
      FOR EACH ROW
      BEGIN
        INSERT INTO ${database}._cdc_changelog (sync_config_id, table_name, operation, primary_key_values, change_data)
        VALUES (
          '${syncConfigId}',
          '${tableName}',
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
   */
  private buildAllColumnsJson(columns: string[], prefix: string): string {
    if (columns.length === 0) {
      return "'{}'";
    }
    const parts = columns.map((col) => `'${col}', ${prefix}.${col}`).join(', ');
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
    const triggerPrefix = `cdc_${syncConfigId.replace(/-/g, '_').substring(0, 20)}`;

    try {
      await conn.query(`DROP TRIGGER IF EXISTS ${triggerPrefix}_${tableName}_insert`);
      await conn.query(`DROP TRIGGER IF EXISTS ${triggerPrefix}_${tableName}_update`);
      await conn.query(`DROP TRIGGER IF EXISTS ${triggerPrefix}_${tableName}_delete`);
    } catch (error) {
      // Ignore errors if triggers don't exist
    }
  }

  /**
   * Initialize change tracking for a sync configuration
   * Requirements: 2.1
   */
  async initializeTracking(config: SyncConfiguration): Promise<void> {
    const sourceConnection = config.sourceConnection || 
      await prisma.connection.findUnique({ where: { id: config.sourceConnectionId } });
    
    if (!sourceConnection) {
      throw new Error('Source connection not found');
    }

    const { conn, tunnel } = await this.createConnection(sourceConnection, 'source');

    try {
      // Check if binary log is enabled
      const binlogEnabled = await this.isBinlogEnabled(conn);
      
      if (!binlogEnabled) {
        console.log(`Binary log not enabled for ${sourceConnection.database}, using trigger-based CDC`);
        this.useTriggerBased = true;
      }

      if (this.useTriggerBased) {
        // Set up trigger-based CDC
        const tables = await this.getTablesToTrack(
          conn,
          sourceConnection.database,
          config.includeTables,
          config.excludeTables
        );

        for (const table of tables) {
          await this.createTriggersForTable(
            conn,
            sourceConnection.database,
            table,
            config.id
          );
        }
      } else {
        // For binlog-based CDC, just verify we can read the position
        const position = await this.getBinlogPosition(conn);
        if (!position) {
          throw new Error('Unable to read binary log position');
        }
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
  async teardownTracking(config: SyncConfiguration): Promise<void> {
    const sourceConnection = config.sourceConnection || 
      await prisma.connection.findUnique({ where: { id: config.sourceConnectionId } });
    
    if (!sourceConnection) {
      return; // Connection already deleted
    }

    const { conn, tunnel } = await this.createConnection(sourceConnection, 'source');

    try {
      if (this.useTriggerBased) {
        const tables = await this.getTablesToTrack(
          conn,
          sourceConnection.database,
          config.includeTables,
          config.excludeTables
        );

        for (const table of tables) {
          await this.dropTriggersForTable(
            conn,
            sourceConnection.database,
            table,
            config.id
          );
        }

        // Optionally clean up the changelog table
        await conn.query(`DROP TABLE IF EXISTS ${sourceConnection.database}._cdc_changelog`);
      }
    } finally {
      await conn.end();
      tunnel?.close();
    }
  }

  /**
   * Capture changes from the database since the specified checkpoint
   * Requirements: 2.4, 2.6
   */
  async captureChanges(config: SyncConfiguration, since: string): Promise<ChangeLog[]> {
    const sourceConnection = config.sourceConnection || 
      await prisma.connection.findUnique({ where: { id: config.sourceConnectionId } });
    
    if (!sourceConnection) {
      throw new Error('Source connection not found');
    }

    if (this.useTriggerBased) {
      return this.captureChangesFromTriggers(config, sourceConnection, since);
    } else {
      return this.captureChangesFromBinlog(config, sourceConnection, since);
    }
  }

  /**
   * Capture changes from trigger-based changelog table
   */
  private async captureChangesFromTriggers(
    config: SyncConfiguration,
    sourceConnection: any,
    since: string
  ): Promise<ChangeLog[]> {
    const { conn, tunnel } = await this.createConnection(sourceConnection, 'source');

    try {
      // Parse checkpoint (format: "timestamp:lastId")
      const [timestampStr, lastIdStr] = since.split(':');
      const sinceTimestamp = timestampStr || new Date(0).toISOString();
      const sinceId = lastIdStr ? parseInt(lastIdStr, 10) : 0;

      const [rows] = await conn.query<mysql2.RowDataPacket[]>(
        `SELECT id, table_name, operation, primary_key_values, change_data, change_timestamp
         FROM ${sourceConnection.database}._cdc_changelog
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
   * Capture changes from binary log
   * Note: This is a simplified implementation. Production would use mysqlbinlog or a library
   */
  private async captureChangesFromBinlog(
    config: SyncConfiguration,
    sourceConnection: any,
    since: string
  ): Promise<ChangeLog[]> {
    // Binary log parsing is complex and typically requires external tools or libraries
    // For this implementation, we'll return an empty array and log a warning
    // In production, you would use:
    // 1. mysqlbinlog command-line tool
    // 2. A library like mysql-binlog-connector-java (for Java) or zongji (for Node.js)
    // 3. MySQL's binlog API
    
    console.warn('Binary log CDC not fully implemented. Use trigger-based CDC instead.');
    return [];
  }

  /**
   * Get the current checkpoint for a sync configuration
   * Requirements: 2.5
   */
  async getCheckpoint(config: SyncConfiguration, origin: 'source' | 'target'): Promise<string> {
    const connectionId = origin === 'source' ? config.sourceConnectionId : config.targetConnectionId;
    const connection = await prisma.connection.findUnique({ where: { id: connectionId } });
    
    if (!connection) {
      throw new Error(`${origin} connection not found`);
    }

    const { conn, tunnel } = await this.createConnection(connection, origin);

    try {
      if (this.useTriggerBased) {
        // For trigger-based, return current timestamp
        const [[row]] = await conn.query<mysql2.RowDataPacket[]>('SELECT NOW(6) as now');
        return `${new Date(row.now).toISOString()}:0`;
      } else {
        // For binlog-based, return binlog position
        const position = await this.getBinlogPosition(conn);
        if (!position) {
          throw new Error('Unable to read binary log position');
        }
        return `${position.file}:${position.position}`;
      }
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
    config: SyncConfiguration,
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
  async cleanupChangeLogs(config: SyncConfiguration, before: Date): Promise<number> {
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
