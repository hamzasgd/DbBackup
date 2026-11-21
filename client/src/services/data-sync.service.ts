import api from '../lib/api'

export type DataSyncMode = 'COMPARE' | 'APPLY'
export type DataSyncMethod = 'FULL' | 'QUICK'
export type DataSyncStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type TableStatus = 'SAME' | 'DIFFERENT' | 'SYNCED' | 'CREATED' | 'ONLY_IN_SOURCE' | 'ONLY_IN_TARGET' | 'SKIPPED' | 'ERROR'

export interface TableReport {
  table: string
  /** The table's name on the target when it differs in case (e.g. "appsettings") */
  targetTable?: string
  status: TableStatus
  rows: number
  /** Rows inserted / replaced / deleted on the target (or that would be, for a compare) */
  inserted: number
  updated: number
  deleted: number
  chunks: number
  chunksDifferent: number
  reason?: string
  warning?: string
  /** How long the table took */
  ms?: number
  /** QUICK: only rows changed since the last sync; FULL: every row */
  method?: 'QUICK' | 'FULL'
  /** How the table was compared, when worth saying */
  note?: string
}

export interface SchemaChange {
  kind: 'CREATE_TABLE' | 'ADD_COLUMN' | 'ADD_INDEX' | 'ADD_FOREIGN_KEY'
  table: string
  targetTable: string
  name: string
  sql: string
  status?: 'APPLIED' | 'FAILED'
  error?: string
}

export interface SchemaNote {
  kind: string
  table: string
  name: string
  source?: string
  target?: string
  suggestedSql?: string
}

/** Schema check: additions (applied when syncing) and differences that are only reported */
export interface SchemaReport {
  changes: SchemaChange[]
  notes: SchemaNote[]
  tablesCompared: number
}

export interface DataSyncRun {
  id: string
  sourceConnectionId: string | null
  targetConnectionId: string | null
  sourceName: string
  targetName: string
  sourceDatabase: string
  targetDatabase: string
  mode: DataSyncMode
  tables: string[]
  /** Chunks checked at the same time */
  parallel: number
  /** FULL: every row; QUICK: rows changed since `since` (by updatedAt), plus new and deleted rows */
  method: DataSyncMethod
  since: string | null
  status: DataSyncStatus
  cancelRequested: boolean
  currentTable: string | null
  tablesDone: number
  tablesTotal: number | null
  rowsChecked: number
  rowsEstimate: number | null
  results: TableReport[] | null
  schema: SchemaReport | null
  error: string | null
  /** Started by a live sync to catch up */
  liveSyncId: string | null
  progressAt: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

export type LiveSyncStatus = 'STARTING' | 'CATCHING_UP' | 'RUNNING' | 'PAUSED' | 'RECONNECTING' | 'STOPPED' | 'ERROR'

/** Follows the source's binary log and applies each change to the target as it happens */
export interface LiveSync {
  id: string
  sourceConnectionId: string | null
  targetConnectionId: string | null
  sourceName: string
  targetName: string
  sourceDatabase: string
  targetDatabase: string
  enabled: boolean
  status: LiveSyncStatus
  /** Where it continues reading the source's log */
  binlogFile: string | null
  binlogPos: number | null
  /** The sync bringing the target up to date before following the log */
  catchUpRunId: string | null
  /** Source time of the last change applied, and when it was applied */
  lastEventAt: string | null
  appliedAt: string | null
  /** End of the source's log when last checked */
  headFile: string | null
  headPos: number | null
  checkedAt: string | null
  inserted: number
  updated: number
  deleted: number
  transactions: number
  warnings: string[]
  error: string | null
  startedAt: string | null
  stoppedAt: string | null
  createdAt: string
}

export const dataSyncApi = {
  list: (limit = 10) =>
    api.get<{ success: boolean; data: { runs: DataSyncRun[]; serverTime: string } }>('/data-sync', { params: { limit } }),
  start: (data: { sourceConnectionId: string; targetConnectionId: string; mode: DataSyncMode; tables?: string[]; confirmTarget?: string; parallel?: number; method?: DataSyncMethod }) =>
    api.post<{ success: boolean; data: { id: string } }>('/data-sync', data),
  cancel: (id: string) => api.post(`/data-sync/${id}/cancel`),
  listLive: () => api.get<{ success: boolean; data: { liveSyncs: LiveSync[]; serverTime: string } }>('/data-sync/live'),
  startLive: (data: { sourceConnectionId: string; targetConnectionId: string; confirmTarget: string }) =>
    api.post<{ success: boolean; data: LiveSync }>('/data-sync/live', data),
  stopLive: (id: string) => api.post(`/data-sync/live/${id}/stop`),
  removeLive: (id: string) => api.delete(`/data-sync/live/${id}`),
}
