import api from '../lib/api'

export type BackupFormat = 'COMPRESSED_SQL' | 'PLAIN_SQL' | 'CUSTOM' | 'DIRECTORY' | 'TAR'
export type ExportFormat = 'json' | 'csv' | 'sql'

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
}

export const backupsApi = {
  getAll: (params?: { connectionId?: string; page?: number; limit?: number }) =>
    api.get<{ success: boolean; data: { backups: Backup[]; total: number } }>('/backups', { params }),
  getOne: (id: string) =>
    api.get<{ success: boolean; data: Backup }>(`/backups/${id}`),
  trigger: (data: { connectionId: string; snapshotName?: string; notes?: string; format?: BackupFormat }) =>
    api.post<{ success: boolean; data: Backup }>('/backups', data),
  delete: (id: string) =>
    api.delete(`/backups/${id}`),
  verify: (id: string) =>
    api.post<{ success: boolean; data: { valid: boolean; checksum: string } }>(`/backups/${id}/verify`),
  drill: (id: string) => api.post<{ success: boolean; data: { drillId: string }; message: string }>(`/backups/${id}/drill`),
  runRetention: () =>
    api.post<{ success: boolean; data: { deleted: number; freedBytes: number; connections: number } }>('/backups/retention/run'),
  downloadUrl: (id: string) => `/api/backups/${id}/download`,
}

export const restoreApi = {
  // Returns 202 with a jobId — track progress via SSE at /restore/:jobId/progress
  restore: (data: { backupId: string; targetConnectionId?: string; targetDatabase?: string }) =>
    api.post<{ success: boolean; data: { jobId: string }; message: string }>('/restore', data),
}
