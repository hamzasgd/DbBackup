import api from '../lib/api'

export interface Schedule {
  id: string
  connectionId: string
  connection?: { id: string; name: string; type: string }
  name: string
  frequency: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM'
  cronExpression: string
  isActive: boolean
  retentionDays: number
  lastRunAt?: string
  nextRunAt?: string
  createdAt: string
}

export const schedulesApi = {
  getAll: () =>
    api.get<{ success: boolean; data: Schedule[] }>('/schedules'),
  create: (data: { connectionId: string; name: string; frequency: string; cronExpression: string; retentionDays?: number }) =>
    api.post<{ success: boolean; data: Schedule }>('/schedules', data),
  update: (id: string, data: Partial<Schedule>) =>
    api.put<{ success: boolean; data: Schedule }>(`/schedules/${id}`, data),
  delete: (id: string) =>
    api.delete(`/schedules/${id}`),
}
