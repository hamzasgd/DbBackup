import api from '../lib/api'

export interface AuditLog {
  id: string
  userId: string | null
  action: string
  resource: string
  details?: Record<string, unknown> | null
  ipAddress?: string | null
  userAgent?: string | null
  createdAt: string
}

export interface AuditFilters {
  page?: number
  limit?: number
  action?: string
  resource?: string
  from?: string
  to?: string
}

export const auditApi = {
  getAll: (params?: AuditFilters) =>
    api.get<{ success: boolean; data: { logs: AuditLog[]; total: number } }>('/audit', { params }),
}
