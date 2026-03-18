import { Pool, PoolClient } from 'pg';
import { CDCTrackerService } from './cdc-tracker.service';
import { SSHTunnel } from '../ssh.service';
import { prisma } from '../../config/database';
import { decrypt, decryptIfPresent } from '../crypto.service';

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

/**
 * PostgreSQLCDCTracker - Change Data Capture tracker for PostgreSQL databases
 * 
 * Implements CDC using two strategies:
 * 1. Logical replication slots (primary method)
 * 2. Trigger-based change capture (fallback)
 * 
 * Requirements: 2.3, 2.4, 2.5
 */
export class PostgreSQLCDCTracker implements CDCTrackerService {
  private useTriggerBased: boolean = false;

  /**
   * Create a database connection pool with SSH tunnel support
   */
  private async createPool(
    connectionConfig: any,
    origin: 'source' | 'target'
  ): Promise<{ pool: Pool; tunnel: SSHTunnel | null }> {
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

      const pool = new Pool({
        host,
        port,
        user: decryptedConfig.username,
        password: decryptedConfig.password,
        database: decryptedConfig.database,
        ssl: decryptedConfig.sslEnabled ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: decryptedConfig.connectionTimeout || 30000,
        max: 5,
      });

      return { pool, tunnel };
    } catch (error) {
      tunnel?.close();
      throw error;
    }
  }

  /**
   * Check if logical replication is available
   */
  private async isLogicalReplicationAvailable(client: PoolClient): Promise<boolean> {
    try {
      // Check if wal_level is set to 'logical'
      const result = await client.query("SHOW wal_level");
      const walLevel = result.rows[0]?.wal_level;
      
      if (walLevel !== 'logical') {
        return false;
      }

      // Check if user has replication privilege
      const roleResult = await client.query(
        "SELECT rolreplication FROM pg_roles WHERE rolname = current_user"
      );
      
      return roleResult.rows[0]?.rolreplication === true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get list of tables to track based on include/exclude filters
   */
  private async getTablesToTrack(
    client: PoolClient,
    includeTables: string[],
    excludeTables: string[]
  ): Promise<string[]> {
    const result = await client.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );

    let tables = result.rows.map((r) => r.table_name as string);

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
    client: PoolClient,
    tableName: string
  ): Promise<string[]> {
    const result = await client.query(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary
       ORDER BY a.attnum`,
      [tableName]
    );
    return result.rows.map((r) => r.column_name as string);
  }

  /**
   * Get all columns for a table
   */
  private async getTableColumns(
    client: PoolClient,
    tableName: string
  ): Promise<string[]> {
    const result = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );
    return result.rows.map((r) => r.column_name as string);
  }

  /**
   * Build JSON object expression for columns
   */
  private buildJsonObject(columns: string[], prefix: string): string {
    if (columns.length === 0) {
      return "'{}'::jsonb";
    }
    const pairs = columns.map((col) => `'${col}', ${prefix}.${col}`).join(', ');
    return `jsonb_build_object(${pairs})`;
  }

  /**
   * Create audit triggers for a table (trigger-based CDC)
   */
  private async createTriggersForTable(
    client: PoolClient,
    tableName: string,
    syncConfigId: string
  ): Promise<void> {
    const pkColumns = await this.getPrimaryKeyColumns(client, tableName);
    if (pkColumns.length === 0) {
      throw new Error(`Table ${tableName} has no primary key`);
    }

    const allColumns = await this.getTableColumns(client, tableName);
    const triggerPrefix = `cdc_${syncConfigId.replace(/-/g, '_').substring(0, 20)}`;

    // Create changelog table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS _cdc_changelog (
        id BIGSERIAL PRIMARY KEY,
        sync_config_id VARCHAR(36) NOT NULL,
        table_name VARCHAR(255) NOT NULL,
        operation VARCHAR(10) NOT NULL,
        primary_key_values JSONB NOT NULL,
        change_data JSONB,
        change_timestamp TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT idx_sync_config_timestamp 
          CHECK (sync_config_id IS NOT NULL AND change_timestamp IS NOT NULL)
      )
    `);

    // Create index if it doesn't exist
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cdc_changelog_sync_config 
      ON _cdc_changelog(sync_config_id, change_timestamp)
    `);

    // Create trigger function for this table
    const pkJsonObject = this.buildJsonObject(pkColumns, 'OLD');
    const pkJsonObjectNew = this.buildJsonObject(pkColumns, 'NEW');
    const allColumnsJsonNew = this.buildJsonObject(allColumns, 'NEW');

    await client.query(`
      CREATE OR REPLACE FUNCTION ${triggerPrefix}_${tableName}_fn()
      RETURNS TRIGGER AS $$
      BEGIN
        IF (TG_OP = 'INSERT') THEN
          INSERT INTO _cdc_changelog (sync_config_id, table_name, operation, primary_key_values, change_data)
          VALUES (
            '${syncConfigId}',
            '${tableName}',
            'INSERT',
            ${pkJsonObjectNew},
            ${allColumnsJsonNew}
          );
          RETURN NEW;
        ELSIF (TG_OP = 'UPDATE') THEN
          INSERT INTO _cdc_changelog (sync_config_id, table_name, operation, primary_key_values, change_data)
          VALUES (
            '${syncConfigId}',
            '${tableName}',
            'UPDATE',
            ${pkJsonObjectNew},
            ${allColumnsJsonNew}
          );
          RETURN NEW;
        ELSIF (TG_OP = 'DELETE') THEN
          INSERT INTO _cdc_changelog (sync_config_id, table_name, operation, primary_key_values, change_data)
          VALUES (
            '${syncConfigId}',
            '${tableName}',
            'DELETE',
            ${pkJsonObject},
            NULL
          );
          RETURN OLD;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Create triggers
    await client.query(`
      DROP TRIGGER IF EXISTS ${triggerPrefix}_${tableName}_insert ON ${tableName}
    `);
    await client.query(`
      CREATE TRIGGER ${triggerPrefix}_${tableName}_insert
      AFTER INSERT ON ${tableName}
      FOR EACH ROW EXECUTE FUNCTION ${triggerPrefix}_${tableName}_fn()
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS ${triggerPrefix}_${tableName}_update ON ${tableName}
    `);
    await client.query(`
      CREATE TRIGGER ${triggerPrefix}_${tableName}_update
      AFTER UPDATE ON ${tableName}
      FOR EACH ROW EXECUTE FUNCTION ${triggerPrefix}_${tableName}_fn()
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS ${triggerPrefix}_${tableName}_delete ON ${tableName}
    `);
    await client.query(`
      CREATE TRIGGER ${triggerPrefix}_${tableName}_delete
      AFTER DELETE ON ${tableName}
      FOR EACH ROW EXECUTE FUNCTION ${triggerPrefix}_${tableName}_fn()
    `);
  }

  /**
   * Drop audit triggers for a table
   */
  private async dropTriggersForTable(
    client: PoolClient,
    tableName: string,
    syncConfigId: string
  ): Promise<void> {
    const triggerPrefix = `cdc_${syncConfigId.replace(/-/g, '_').substring(0, 20)}`;

    try {
      await client.query(`DROP TRIGGER IF EXISTS ${triggerPrefix}_${tableName}_insert ON ${tableName}`);
      await client.query(`DROP TRIGGER IF EXISTS ${triggerPrefix}_${tableName}_update ON ${tableName}`);
      await client.query(`DROP TRIGGER IF EXISTS ${triggerPrefix}_${tableName}_delete ON ${tableName}`);
      await client.query(`DROP FUNCTION IF EXISTS ${triggerPrefix}_${tableName}_fn()`);
    } catch (error) {
      // Ignore errors if triggers don't exist
    }
  }

  /**
   * Create a logical replication slot
   */
  private async createReplicationSlot(
    client: PoolClient,
    slotName: string
  ): Promise<void> {
    try {
      // Check if slot already exists
      const checkResult = await client.query(
        "SELECT slot_name FROM pg_replication_slots WHERE slot_name = $1",
        [slotName]
      );

      if (checkResult.rows.length === 0) {
        // Create the replication slot using pgoutput plugin
        await client.query(
          "SELECT pg_create_logical_replication_slot($1, 'pgoutput')",
          [slotName]
        );
      }
    } catch (error: any) {
      throw new Error(`Failed to create replication slot: ${error.message}`);
    }
  }

  /**
   * Drop a logical replication slot
   */
  private async dropReplicationSlot(
    client: PoolClient,
    slotName: string
  ): Promise<void> {
    try {
      // Check if slot exists
      const checkResult = await client.query(
        "SELECT slot_name FROM pg_replication_slots WHERE slot_name = $1",
        [slotName]
      );

      if (checkResult.rows.length > 0) {
        await client.query(
          "SELECT pg_drop_replication_slot($1)",
          [slotName]
        );
      }
    } catch (error) {
      // Ignore errors if slot doesn't exist
    }
  }

  /**
   * Get replication slot name for a sync configuration
   */
  private getSlotName(syncConfigId: string): string {
    // Slot names must be valid PostgreSQL identifiers (lowercase, no hyphens)
    return `cdc_slot_${syncConfigId.replace(/-/g, '_')}`.toLowerCase();
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

    const { pool, tunnel } = await this.createPool(sourceConnection, 'source');
    const client = await pool.connect();

    try {
      // Check if logical replication is available
      const logicalReplicationAvailable = await this.isLogicalReplicationAvailable(client);
      
      if (!logicalReplicationAvailable) {
        console.log(`Logical replication not available for ${sourceConnection.database}, using trigger-based CDC`);
        this.useTriggerBased = true;
      }

      if (this.useTriggerBased) {
        // Set up trigger-based CDC
        const tables = await this.getTablesToTrack(
          client,
          config.includeTables,
          config.excludeTables
        );

        for (const table of tables) {
          await this.createTriggersForTable(client, table, config.id);
        }
      } else {
        // Set up logical replication slot
        const slotName = this.getSlotName(config.id);
        await this.createReplicationSlot(client, slotName);
      }
    } finally {
      client.release();
      await pool.end();
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

    const { pool, tunnel } = await this.createPool(sourceConnection, 'source');
    const client = await pool.connect();

    try {
      if (this.useTriggerBased) {
        const tables = await this.getTablesToTrack(
          client,
          config.includeTables,
          config.excludeTables
        );

        for (const table of tables) {
          await this.dropTriggersForTable(client, table, config.id);
        }

        // Optionally clean up the changelog table
        await client.query(`DROP TABLE IF EXISTS _cdc_changelog`);
      } else {
        // Drop logical replication slot
        const slotName = this.getSlotName(config.id);
        await this.dropReplicationSlot(client, slotName);
      }
    } finally {
      client.release();
      await pool.end();
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
      return this.captureChangesFromReplicationSlot(config, sourceConnection, since);
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
    const { pool, tunnel } = await this.createPool(sourceConnection, 'source');
    const client = await pool.connect();

    try {
      // Parse checkpoint (format: "timestamp:lastId")
      const [timestampStr, lastIdStr] = since.split(':');
      const sinceTimestamp = timestampStr || new Date(0).toISOString();
      const sinceId = lastIdStr ? parseInt(lastIdStr, 10) : 0;

      const result = await client.query(
        `SELECT id, table_name, operation, primary_key_values, change_data, change_timestamp
         FROM _cdc_changelog
         WHERE sync_config_id = $1 
           AND (change_timestamp > $2 OR (change_timestamp = $2 AND id > $3))
         ORDER BY change_timestamp, id
         LIMIT 10000`,
        [config.id, sinceTimestamp, sinceId]
      );

      const changeLogs: ChangeLog[] = [];

      for (const row of result.rows) {
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
      client.release();
      await pool.end();
      tunnel?.close();
    }
  }

  /**
   * Capture changes from logical replication slot
   * Note: This is a simplified implementation. Production would parse WAL changes
   */
  private async captureChangesFromReplicationSlot(
    config: SyncConfiguration,
    sourceConnection: any,
    since: string
  ): Promise<ChangeLog[]> {
    // Logical replication slot parsing is complex and requires decoding WAL changes
    // For this implementation, we'll return an empty array and log a warning
    // In production, you would use:
    // 1. pg_logical_slot_get_changes() to retrieve changes
    // 2. Parse the pgoutput plugin format
    // 3. Decode the binary WAL data
    // 4. Extract table names, operations, and data
    
    console.warn('Logical replication slot CDC not fully implemented. Use trigger-based CDC instead.');
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

    const { pool, tunnel } = await this.createPool(connection, origin);
    const client = await pool.connect();

    try {
      if (this.useTriggerBased) {
        // For trigger-based, return current timestamp
        const result = await client.query('SELECT CURRENT_TIMESTAMP(6) as now');
        return `${new Date(result.rows[0].now).toISOString()}:0`;
      } else {
        // For replication slot-based, return current LSN
        const result = await client.query("SELECT pg_current_wal_lsn() as lsn");
        return result.rows[0].lsn;
      }
    } finally {
      client.release();
      await pool.end();
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
