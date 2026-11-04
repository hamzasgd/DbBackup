import api from '../lib/api'

export type UserRole = 'USER' | 'ADMIN'

export interface AdminStats {
  users: { total: number; active: number }
  connections: { total: number }
  backups: { byStatus: Record<string, number>; failedLast7d: number }
  storageBytes: number
  mcpKeys: { active: number; total: number }
}

export interface AdminUser {
  id: string
  email: string
  name: string
  role: UserRole
  isActive: boolean
  createdAt: string
  connections: number
  backups: number
  lastBackupAt: string | null
  storageUsed: number
  storageQuotaBytes: number | null
  connectionLimit: number | null
}

export interface AdminConnection {
  id: string
  name: string
  type: string
  host: string | null
  port: number
  database: string | null
  username: string | null
  sslEnabled: boolean
  sshEnabled: boolean
  heartbeatEnabled: boolean
  createdAt: string
}

export interface AdminBackup {
  id: string
  fileName: string
  fileSize: number
  dbType: string
  dbName: string
  status: string
  storageType: string
  createdAt: string
}

export interface AdminMcpKey {
  id: string
  name: string
  keyPrefix: string
  scopes: string[]
  approvalRequired: boolean
  dailyCallLimit: number | null
  callsToday: number
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export interface AdminAuditEntry {
  action: string
  resource: string
  details?: Record<string, unknown> | null
  ipAddress?: string | null
  createdAt: string
}

export interface AdminUserDetail {
  user: {
    id: string; email: string; name: string; role: UserRole; isActive: boolean
    createdAt: string; termsAcceptedAt: string | null; passwordLoginDisabled: boolean
    storageQuotaBytes: number | null
    connectionLimit: number | null
  }
  connections: AdminConnection[]
  backups: AdminBackup[]
  schedules: number
  mcpKeys: AdminMcpKey[]
  auditLogs: AdminAuditEntry[]
  quota: { usedBytes: number; quotaBytes: number | null; percent: number | null }
}

export const adminApi = {
  getStats: () =>
    api.get<{ success: boolean; data: AdminStats }>('/admin/stats'),
  getUsers: (params?: { page?: number; limit?: number; search?: string; status?: string }) =>
    api.get<{ success: boolean; data: { users: AdminUser[]; total: number; page: number; limit: number } }>('/admin/users', { params }),
  getUser: (id: string) =>
    api.get<{ success: boolean; data: AdminUserDetail }>(`/admin/users/${id}`),
  setUserStatus: (id: string, isActive: boolean) =>
    api.patch<{ success: boolean; data: { id: string; isActive: boolean; unchanged?: boolean } }>(`/admin/users/${id}/status`, { isActive }),
  setUserQuota: (id: string, storageQuotaGb: number | null) =>
    api.patch<{ success: boolean; data: { id: string; storageQuotaBytes: number | null } }>(`/admin/users/${id}/quota`, { storageQuotaGb }),
  setUserConnectionLimit: (id: string, connectionLimit: number | null) =>
    api.patch<{ success: boolean; data: { id: string; connectionLimit: number | null } }>(`/admin/users/${id}/connection-limit`, { connectionLimit }),
}
