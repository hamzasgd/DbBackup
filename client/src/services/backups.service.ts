import api from '../lib/api'

export type BackupFormat = 'COMPRESSED_SQL' | 'PLAIN_SQL' | 'CUSTOM' | 'DIRECTORY' | 'TAR'
export type ExportFormat = 'json' | 'csv' | 'sql'

export interface Backup {
  id: string
  connectionId: string
  connection?: { id: string; name: string; type: string }
  fileName: string
  filePath: string
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
  checksum?: string
  storageType: 'LOCAL' | 'S3'
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
  downloadUrl: (id: string) => `/api/backups/${id}/download`,
}

export const restoreApi = {
  restore: (data: { backupId: string; targetConnectionId?: string; targetDatabase?: string }) =>
    api.post('/restore', data),
}
