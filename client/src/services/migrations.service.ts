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

export interface MigrationTableVerification {
  tableName: string
  sourceRows: number
  targetRows: number
  rowsMatch: boolean
  missingInTarget: boolean
  missingIndexes: string[]
  extraIndexes: string[]
  indexDefinitionMismatches: string[]
  columnProfileMismatches: string[]
  rowSampleHashMatch: boolean | null
  rowSampledCount: number
  rowSampleSourceHash?: string
  rowSampleTargetHash?: string
}

export interface MigrationVerificationResult {
  ok: boolean
  sourceDatabase: string
  targetDatabase: string
  tableCountChecked: number
  rowMismatchCount: number
  missingTableCount: number
  missingIndexCount: number
  indexDefinitionMismatchCount: number
  columnProfileMismatchCount: number
  rowSampleHashMismatchCount: number
  deepChecksApplied: boolean
  schemaErrors: string[]
  schemaWarnings: string[]
  tableResults: MigrationTableVerification[]
}

export const migrationsApi = {
  getAll: () =>
    api.get<{ success: boolean; data: { migrations: Migration[]; total: number } }>('/migrations'),
  getOne: (id: string) =>
    api.get<{ success: boolean; data: Migration }>(`/migrations/${id}`),
  create: (data: CreateMigrationPayload) =>
    api.post<{ success: boolean; data: Migration }>('/migrations', data),
  verify: (id: string, tables?: string[]) =>
    api.post<{ success: boolean; data: MigrationVerificationResult; message: string }>(`/migrations/${id}/verify`, { tables }),
  delete: (id: string) =>
    api.delete(`/migrations/${id}`),
}
