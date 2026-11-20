import api from '../lib/api'

export type DataSyncMode = 'COMPARE' | 'APPLY'
export type DataSyncStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type TableStatus = 'SAME' | 'DIFFERENT' | 'SYNCED' | 'CREATED' | 'ONLY_IN_SOURCE' | 'ONLY_IN_TARGET' | 'SKIPPED' | 'ERROR'

export interface TableReport {
  table: string
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
  start: (data: { sourceConnectionId: string; targetConnectionId: string; mode: DataSyncMode; tables?: string[]; confirmTarget?: string }) =>
    api.post<{ success: boolean; data: { id: string } }>('/data-sync', data),
  cancel: (id: string) => api.post(`/data-sync/${id}/cancel`),
}
