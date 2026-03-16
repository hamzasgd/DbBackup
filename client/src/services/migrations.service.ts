import api from '../lib/api'

export type MigrationStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'

export interface Migration {
  id: string
  sourceConnectionId: string
  targetConnectionId: string
  sourceConnection?: { id: string; name: string; type: string }
  targetConnection?: { id: string; name: string; type: string }
  status: MigrationStatus
  tableCount: number
  tablesCompleted: number
  rowsMigrated: number
  currentTable?: string
  progress: number
  notes?: string
  error?: string
  startedAt?: string
  completedAt?: string
  createdAt: string
}

export interface CreateMigrationPayload {
  sourceConnectionId: string
  targetConnectionId: string
  tables?: string[]
  batchSize?: number
  notes?: string
}

export const migrationsApi = {
  getAll: () =>
    api.get<{ success: boolean; data: { migrations: Migration[]; total: number } }>('/migrations'),
  getOne: (id: string) =>
    api.get<{ success: boolean; data: Migration }>(`/migrations/${id}`),
  create: (data: CreateMigrationPayload) =>
    api.post<{ success: boolean; data: Migration }>('/migrations', data),
  delete: (id: string) =>
    api.delete(`/migrations/${id}`),
}
