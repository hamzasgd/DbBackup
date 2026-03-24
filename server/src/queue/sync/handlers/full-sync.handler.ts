import { Job } from 'bullmq';
import { ChangeOperation } from '@prisma/client';
import { prisma } from '../../../config/database';
import { logger } from '../../../config/logger';
import { publishProgress } from '../../../services/sse.service';
import { ConnectionConfig } from '../../../services/engines/base.engine';
import { BaseEngine } from '../../../services/engines/base.engine';
import {
  connectionToConfig,
  extractPrimaryKeyFromColumns,
  fetchPrimaryKeyColumnsMySQL,
  fetchPrimaryKeyColumnsPG,
} from '../../../services/sync/sync-utils';
import { ConnectionFactory } from '../../../services/engines/connection-factory';
import { validateChange } from '../validation/change-validator';
import { applyChangeBatch } from '../execution/change-applicator';
import { getTablesInDependencyOrder } from '../execution/table-ordered-executor';
import { fetchTableRecordsPaginated } from '../utils/pagination';
import type { SyncJobData } from '../sync.queue';

// SYNC_PROGRESS_CHANNEL is re-exported from sync.queue.ts
const SYNC_PROGRESS_CHANNEL = (id: string) => `sync:progress:${id}`;
export { SYNC_PROGRESS_CHANNEL };

/** Page size when streaming large tables during full sync */
const FULL_SYNC_PAGE_SIZE = 10000;

export interface FullSyncContext {
  configId: string;
  config: {
    id: string;
    includeTables: string[];
    excludeTables: string[];
    batchSize: number;
  };
  syncStateId: string;
  job: Job<SyncJobData>;
  sourceConfig: ConnectionConfig;
  targetConfig: ConnectionConfig;
  sourceEngine: BaseEngine;
  targetEngine: BaseEngine;
  strictTableOrdering: boolean;
}

export interface FullSyncResult {
  totalRowsSynced: number;
  tablesProcessed: number;
  validationErrors: number;
}

/**
 * Execute full sync for a configuration.
 * Handles initial synchronization of all tables.
 */
export async function executeFullSync(ctx: FullSyncContext): Promise<FullSyncResult> {
  const { configId, config, syncStateId, job, sourceConfig, targetConfig, sourceEngine, targetEngine, strictTableOrdering } = ctx;

  let totalRowsSynced = 0;
  let tablesProcessed = 0;
  let validationErrors = 0;
  let lastProgressUpdate = Date.now();

  logger.info(`Starting full sync for ${configId}`);

  // Get list of tables to sync
  const tablesToSync =
    config.includeTables.length > 0
      ? config.includeTables
      : await getTableList(sourceEngine, sourceConfig);

  const filteredTables = tablesToSync.filter((t) => !config.excludeTables.includes(t));
  const orderedTables = await getTablesInDependencyOrder(targetConfig, filteredTables, {
    strict: strictTableOrdering,
  });

  // Cache primary key columns per table for the duration of this sync
  const pkCache = new Map<string, string[]>();

  for (const tableName of orderedTables) {
    await prisma.syncState.update({
      where: { id: syncStateId },
      data: { currentTable: tableName },
    });

    // Fetch PK columns for this table (cached)
    if (!pkCache.has(tableName)) {
      const pkCols = await fetchPrimaryKeyColumnsForConfig(sourceConfig, tableName);
      pkCache.set(tableName, pkCols);
    }
    const pkColumns = pkCache.get(tableName)!;

    if (pkColumns.length === 0) {
      logger.warn(`Table ${tableName} has no detectable primary key, skipping`);
      tablesProcessed++;
      continue;
    }

    // Paginated fetch
    let offset = 0;
    let pageRecords: Record<string, unknown>[];
    do {
      pageRecords = await fetchTableRecordsPaginated(sourceConfig, tableName, FULL_SYNC_PAGE_SIZE, offset);

      if (pageRecords.length === 0) break;

      // Process records in batches
      const batchSize = config.batchSize;
      for (let i = 0; i < pageRecords.length; i += batchSize) {
        const batch = pageRecords.slice(i, Math.min(i + batchSize, pageRecords.length));

        // Convert records to change log format using real PK columns
        const changes = batch.map((record) => ({
          operation: ChangeOperation.INSERT,
          primaryKeyValues: extractPrimaryKeyFromColumns(record, pkColumns),
          changeData: record,
        }));

        // Validate and filter
        const validChanges: typeof changes = [];
        for (const change of changes) {
          const validation = await validateChange(change, tableName, targetEngine, targetConfig);
          if (!validation.valid) {
            validationErrors++;
            logger.warn(`Validation failed for ${tableName}:`, validation.errors);
            continue;
          }
          validChanges.push(change);
        }

        if (validChanges.length > 0) {
          await applyChangeBatch(targetConfig, tableName, validChanges);
          totalRowsSynced += validChanges.length;
        }

        // Publish progress
        const now = Date.now();
        if (now - lastProgressUpdate >= 2000) {
          lastProgressUpdate = now;
          const progress = Math.min(
            Math.round(
              ((tablesProcessed + (offset + i) / Math.max(offset + pageRecords.length, 1)) /
                orderedTables.length) *
                100
            ),
            99
          );

          await prisma.syncState.update({
            where: { id: syncStateId },
            data: {
              currentProgress: progress,
              totalRowsSynced: BigInt(totalRowsSynced),
            },
          });

          await publishProgress(SYNC_PROGRESS_CHANNEL(configId), {
            progress,
            status: 'RUNNING',
            currentTable: tableName,
            tablesProcessed,
            tableCount: orderedTables.length,
            rowsSynced: totalRowsSynced,
          });

          await job.updateProgress(progress);
        }
      }

      offset += pageRecords.length;
    } while (pageRecords.length === FULL_SYNC_PAGE_SIZE);

    tablesProcessed++;
  }

  return { totalRowsSynced, tablesProcessed, validationErrors };
}

async function getTableList(engine: BaseEngine, config: ConnectionConfig): Promise<string[]> {
  const dbInfo = await engine.getDbInfo();
  return dbInfo.tables.map((t: { name: string }) => t.name);
}

async function fetchPrimaryKeyColumnsForConfig(
  config: ConnectionConfig,
  tableName: string
): Promise<string[]> {
  if (config.type === 'MYSQL' || config.type === 'MARIADB') {
    const result = await ConnectionFactory.createMySQLConnection(config);
    try {
      return await fetchPrimaryKeyColumnsMySQL(result.connection, config.database, tableName);
    } finally {
      await ConnectionFactory.closeMySQLConnection(result);
    }
  } else if (config.type === 'POSTGRESQL' || config.type === 'POSTGRES') {
    const result = await ConnectionFactory.createPostgreSQLPool(config);
    try {
      const client = await ConnectionFactory.getPostgreSQLClient(result.pool);
      return await fetchPrimaryKeyColumnsPG(client, tableName);
    } finally {
      await ConnectionFactory.closePostgreSQLPool(result);
    }
  }
  return [];
}
