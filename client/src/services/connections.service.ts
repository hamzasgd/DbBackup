import api from '../lib/api'

export interface Connection {
  id: string
  name: string
  type: 'MYSQL' | 'MARIADB' | 'POSTGRESQL'
  host: string
  port: number
  username: string
  password: string
  database: string
  sslEnabled: boolean
  sshEnabled: boolean
  sshHost?: string
  sshPort?: number
  sshUsername?: string
  createdAt: string
  updatedAt: string
}

export interface CreateConnectionPayload {
  name: string
  type: 'MYSQL' | 'MARIADB' | 'POSTGRESQL'
  host: string
  port: number
  username: string
  password?: string
  database: string
  sslEnabled?: boolean
  sshEnabled?: boolean
  sshHost?: string | null
  sshPort?: number | null
  sshUsername?: string | null
  sshPrivateKey?: string | null
  sshPassphrase?: string | null
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  extra?: string
}

export interface TableInfo {
  name: string
  rowCount: number
  sizeBytes: number
  logicalSizeBytes: number
  overheadBytes: number
  overheadPercent: number
  columns: ColumnInfo[]
}

export interface DbInfo {
  database: string
  version: string
  totalSizeBytes: number
  logicalSizeBytes: number
  overheadBytes: number
  overheadPercent: number
  tableCount: number
  tables: TableInfo[]
}

export const connectionsApi = {
  getAll: () => api.get<{ success: boolean; data: Connection[] }>('/connections'),
  getOne: (id: string) => api.get<{ success: boolean; data: Connection }>(`/connections/${id}`),
  create: (data: CreateConnectionPayload) => api.post<{ success: boolean; data: Connection }>('/connections', data),
  update: (id: string, data: Partial<CreateConnectionPayload>) => api.put<{ success: boolean; data: Connection }>(`/connections/${id}`, data),
  delete: (id: string) => api.delete(`/connections/${id}`),
  test: (id: string) => api.post<{ success: boolean; data: { success: boolean; version: string; message: string } }>(`/connections/${id}/test`),
  getInfo: (id: string) => api.get<{ success: boolean; data: DbInfo }>(`/connections/${id}/info`),
}
