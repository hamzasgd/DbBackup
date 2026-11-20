import api from '../lib/api'
import type { ToolStrategy } from '../lib/tool-strategy'

export type BackupFormat = 'COMPRESSED_SQL' | 'PLAIN_SQL' | 'CUSTOM' | 'DIRECTORY' | 'TAR'
export type ExportFormat = 'json' | 'csv' | 'sql'

export type BackupStage = 'DUMPING' | 'VERIFYING' | 'ENCRYPTING' | 'UPLOADING'

export interface Backup {
  id: string
  connectionId: string | null
  connection?: { id: string; name: string; type: string } | null
  fileName: string
  filePath?: string  // server-only, stripped from API responses
  fileSize: number
  dbType: string
  dbName: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  format: BackupFormat
  isCompressed: boolean
  snapshotName?: string
  notes?: string
  error?: string
  progress: number
  /** Live progress while RUNNING (see BackupLiveProgress) */
  stage?: BackupStage | null
  bytesWritten?: number
  expectedBytes?: number | null
  progressAt?: string | null
  bytesChangedAt?: string | null
  startedAt?: string
  completedAt?: string
  createdAt: string
  verified: boolean
  verifiedAt?: string
  lastDrill?: {
    id: string
    status: 'RUNNING' | 'PASSED' | 'FAILED'
    tablesRestored?: number | null
    rowsRestored?: number | string | null
    error?: string | null
    startedAt: string
    finishedAt?: string | null
  } | null
  checksum?: string
  storageType: 'LOCAL' | 'S3' | 'GOOGLE_DRIVE'
  /** Where the dump ran */
  strategy?: ToolStrategy
}

export const backupsApi = {
  getAll: (params?: { connectionId?: string; page?: number; limit?: number }) =>
    api.get<{ success: boolean; data: { backups: Backup[]; total: number; serverTime?: string } }>('/backups', { params }),
  getOne: (id: string) =>
    api.get<{ success: boolean; data: Backup }>(`/backups/${id}`),
  trigger: (data: { connectionId: string; snapshotName?: string; notes?: string; format?: BackupFormat; strategy?: ToolStrategy }) =>
    api.post<{ success: boolean; data: Backup }>('/backups', data),
  delete: (id: string) =>
    api.delete(`/backups/${id}`),
  verify: (id: string) =>
    api.post<{ success: boolean; data: { valid: boolean; checksum: string } }>(`/backups/${id}/verify`),
  cancelDrill: (backupId: string, drillId: string) => api.post(`/backups/${backupId}/drill/cancel`, { drillId }),
  drill: (id: string) => api.post<{ success: boolean; data: { drillId: string }; message: string }>(`/backups/${id}/drill`),
  runRetention: () =>
    api.post<{ success: boolean; data: { deleted: number; freedBytes: number; connections: number } }>('/backups/retention/run'),
  downloadUrl: (id: string) => `/api/backups/${id}/download`,
}

export type RestoreStage = 'PREPARING' | 'DOWNLOADING' | 'DECRYPTING' | 'RESTORING'
export type RestoreStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'

/** One restore, with live progress while it runs (bytes of the backup file read in the current stage). */
export interface RestoreRecord {
  id: string
  backupId: string | null
  backupLabel: string
  backupCreatedAt: string | null
  backupSourceName: string | null
  targetConnectionId: string | null
  targetName: string
  targetDatabase: string
  overwritesSource: boolean
  strategy: ToolStrategy
  status: RestoreStatus
  stage: RestoreStage | null
  bytesRead: number
  totalBytes: number | null
  stageStartedAt: string | null
  progressAt: string | null
  error: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

/** What a restore would do, checked before it starts. */
export interface RestoreCheck {
  backup: {
    id: string
    dbName: string
    dbType: string
    label: string
    createdAt: string
    fileSize: string
    sourceConnectionId: string | null
    sourceName: string | null
  }
  target: { connectionId: string; name: string; type: string; database: string; writeProtected?: boolean }
  overwritesSource: boolean
  overwritesSourceReason: 'same-connection' | 'same-address' | null
  incompatible: string | null
  busy: { restoreId: string; status: string } | null
}

export const restoreApi = {
  // Returns 202 with a jobId (the restore's id) — progress via list() or SSE at /restore/:jobId/progress
  restore: (data: { backupId: string; targetConnectionId?: string; targetDatabase?: string; confirmOverwrite?: string; strategy?: ToolStrategy }) =>
    api.post<{ success: boolean; data: { jobId: string }; message: string }>('/restore', data),
  check: (params: { backupId: string; targetConnectionId: string }) =>
    api.get<{ success: boolean; data: RestoreCheck }>('/restore/check', { params }),
  list: (limit = 10) =>
    api.get<{ success: boolean; data: { restores: RestoreRecord[]; serverTime: string } }>('/restore', { params: { limit } }),
}
