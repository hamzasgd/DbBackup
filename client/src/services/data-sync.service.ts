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
  error: string | null
  progressAt: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

export const dataSyncApi = {
  list: (limit = 10) =>
    api.get<{ success: boolean; data: { runs: DataSyncRun[]; serverTime: string } }>('/data-sync', { params: { limit } }),
  start: (data: { sourceConnectionId: string; targetConnectionId: string; mode: DataSyncMode; tables?: string[]; confirmTarget?: string; parallel?: number; method?: DataSyncMethod }) =>
    api.post<{ success: boolean; data: { id: string } }>('/data-sync', data),
  cancel: (id: string) => api.post(`/data-sync/${id}/cancel`),
}
