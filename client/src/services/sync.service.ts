import api from '../lib/api'

// TypeScript Interfaces

export interface SyncConfiguration {
  id: string
  name: string
  sourceConnectionId: string
  targetConnectionId: string
  direction: 'UNIDIRECTIONAL' | 'BIDIRECTIONAL'
  mode: 'REALTIME' | 'SCHEDULED' | 'MANUAL'
  cronExpression?: string
  conflictStrategy: 'LAST_WRITE_WINS' | 'SOURCE_WINS' | 'TARGET_WINS' | 'MANUAL'
  includedTables: string[]
  excludedTables: string[]
  batchSize: number
  status: 'ACTIVE' | 'PAUSED' | 'FAILED' | 'STOPPED'
  createdAt: string
  updatedAt: string
}

export interface SyncState {
  id: string
  configurationId: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  lastSyncAt?: string
  nextSyncAt?: string
  totalRowsSynced: number
  consecutiveFailures: number
  lastError?: string
  averageDuration?: number
}

export interface SyncHistoryEntry {
  id: string
  configurationId: string
  startedAt: string
  completedAt?: string
  status: 'COMPLETED' | 'FAILED'
  rowsSynced: number
  conflictsDetected: number
  duration: number
  errorMessage?: string
}

export interface SyncConflict {
  id: string
  configurationId: string
  tableName: string
  primaryKeyValues: Record<string, unknown>
  sourceData: Record<string, unknown>
  targetData: Record<string, unknown>
  sourceModifiedAt: string
  targetModifiedAt: string
  detectedAt: string
}

export interface SchemaComparison {
  compatible: boolean
  missingTables: string[]
  columnMismatches: Array<{
    table: string
    column: string
    sourceType: string
    targetType: string
  }>
  typeMismatches: Array<{
    table: string
    column: string
    sourceType: string
    targetType: string
  }>
}

export interface SyncProgressEvent {
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  progress: number
  currentTable?: string
  tablesCompleted: number
  tableCount: number
  rowsSynced: number
  elapsedTime: number
  error?: string
}

export interface SyncConfigFormData {
  name: string
  sourceConnectionId: string
  targetConnectionId: string
  direction: 'UNIDIRECTIONAL' | 'BIDIRECTIONAL'
  mode: 'REALTIME' | 'SCHEDULED' | 'MANUAL'
  cronExpression?: string
  conflictStrategy: 'LAST_WRITE_WINS' | 'SOURCE_WINS' | 'TARGET_WINS' | 'MANUAL'
  includedTables: string
  excludedTables: string
  batchSize: number
}

// API Client

export const syncApi = {
  // Configuration CRUD
  getAll: () => 
    api.get<{ success: boolean; data: SyncConfiguration[] }>('/sync/configurations'),
  
  getOne: (id: string) => 
    api.get<{ success: boolean; data: SyncConfiguration }>(`/sync/configurations/${id}`),
  
  create: (data: SyncConfigFormData) => 
    api.post<{ success: boolean; data: SyncConfiguration }>('/sync/configurations', data),
  
  update: (id: string, data: Partial<SyncConfigFormData>) => 
    api.patch<{ success: boolean; data: SyncConfiguration }>(`/sync/configurations/${id}`, data),
  
  delete: (id: string) => 
    api.delete(`/sync/configurations/${id}`),
  
  // State and history
  getState: (id: string) => 
    api.get<{ success: boolean; data: SyncState }>(`/sync/configurations/${id}/state`),
  
  getHistory: (id: string) => 
    api.get<{ success: boolean; data: SyncHistoryEntry[] }>(`/sync/configurations/${id}/history`),
  
  // Lifecycle operations
  activate: (id: string, performInitialSync: boolean) => 
    api.post(`/sync/configurations/${id}/activate`, { performInitialSync }),
  
  pause: (id: string) => 
    api.post(`/sync/configurations/${id}/pause`),
  
  resume: (id: string) => 
    api.post(`/sync/configurations/${id}/resume`),
  
  stop: (id: string) => 
    api.post(`/sync/configurations/${id}/stop`),
  
  trigger: (id: string) => 
    api.post(`/sync/configurations/${id}/trigger`),
  
  fullSync: (id: string) => 
    api.post(`/sync/configurations/${id}/full-sync`),
  
  // Schema operations
  getSchemaComparison: (id: string) => 
    api.get<{ success: boolean; data: SchemaComparison }>(`/sync/configurations/${id}/schema-comparison`),
  
  createMissingTables: (id: string) => 
    api.post(`/sync/configurations/${id}/create-missing-tables`),
  
  // Conflicts
  getConflicts: (id: string) => 
    api.get<{ success: boolean; data: SyncConflict[] }>(`/sync/configurations/${id}/conflicts`),
  
  resolveConflict: (conflictId: string, resolution: 'SOURCE' | 'TARGET') => 
    api.post(`/sync/conflicts/${conflictId}/resolve`, { resolution })
}
