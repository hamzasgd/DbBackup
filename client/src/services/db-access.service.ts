import api from '../lib/api'

export interface GatewayStatus {
  running: boolean
  port: number | null
  publicHost: string | null
  requireTls: boolean
  tls: { configured: boolean; subject: string | null; validTo: string | null; error: string | null }
  problem: string | null
  presets: Record<'read' | 'write' | 'full', string[]>
  databasePrivileges: string[]
  tablePrivileges: string[]
}

export interface DbAccess {
  id: string
  name: string
  username: string
  connectionId: string
  connectionName: string | null
  database: string
  /** Empty: the whole database */
  tables: string[]
  privileges: string[]
  maxConnections: number
  enabled: boolean
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
  activeSessions: number
}

/** What to put in DBeaver, DbGate or the mysql client */
export interface ClientSettings {
  host: string
  port: number
  username: string
  password: string | null
  database: string
  ssl: string
  url: string
  command: string
}

export interface AccessSession {
  id: string
  clientIp: string
  clientProgram: string | null
  serverVersion: string | null
  startedAt: string
  endedAt: string | null
  queries: number
  bytesIn: number
  bytesOut: number
  error: string | null
}

export interface AccessQuery {
  id: string
  at: string
  kind: 'QUERY' | 'PREPARE' | 'USE' | 'BLOCKED'
  sql: string
}

export interface AccessInput {
  connectionId: string
  name: string
  username?: string
  database?: string
  tables?: string[]
  privileges: string[]
  maxConnections?: number
  expiresAt?: string | null
}

export const dbAccessApi = {
  status: () => api.get<{ success: boolean; data: GatewayStatus }>('/db-access/status'),
  list: () => api.get<{ success: boolean; data: { accesses: DbAccess[] } }>('/db-access'),
  tables: (connectionId: string, database?: string) =>
    api.get<{ success: boolean; data: { database: string; tables: string[] } }>('/db-access/tables', { params: { connectionId, database } }),
  create: (data: AccessInput) =>
    api.post<{ success: boolean; data: { access: DbAccess; settings: ClientSettings } }>('/db-access', data),
  update: (id: string, data: Partial<Omit<AccessInput, 'connectionId' | 'username' | 'database'>> & { enabled?: boolean }) =>
    api.patch<{ success: boolean; data: { access: DbAccess } }>(`/db-access/${id}`, data),
  resetPassword: (id: string) => api.post<{ success: boolean; data: { settings: ClientSettings } }>(`/db-access/${id}/password`),
  remove: (id: string, force = false) =>
    api.delete<{ success: boolean; data: { warning: string | null } }>(`/db-access/${id}`, { params: force ? { force: 'true' } : {} }),
  sessions: (id: string) => api.get<{ success: boolean; data: { sessions: AccessSession[] } }>(`/db-access/${id}/sessions`),
  queries: (sessionId: string) => api.get<{ success: boolean; data: { queries: AccessQuery[] } }>(`/db-access/sessions/${sessionId}/queries`),
  closeSession: (sessionId: string) => api.post(`/db-access/sessions/${sessionId}/close`),
}
