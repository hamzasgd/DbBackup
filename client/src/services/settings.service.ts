import api from '../lib/api'

export interface NotificationSettings {
  id?: string
  emailEnabled: boolean
  emailAddress?: string | null
  smtpHost?: string | null
  smtpPort?: number | null
  smtpUser?: string | null
  smtpPass?: string | null
  smtpSecure: boolean
  slackEnabled: boolean
  slackWebhookUrl?: string | null
  notifyOnSuccess: boolean
  notifyOnFailure: boolean
  notifyOnRetention: boolean
}

export interface StorageSettings {
  id?: string
  provider: 'LOCAL' | 'S3'
  bucket?: string | null
  region?: string | null
  accessKeyId?: string | null
  secretAccessKey?: string | null
  endpoint?: string | null
  prefix?: string | null
  deleteLocal: boolean
}

export const notificationsApi = {
  get: () => api.get<{ success: boolean; data: NotificationSettings | null }>('/notifications'),
  save: (data: Partial<NotificationSettings>) =>
    api.put<{ success: boolean; data: NotificationSettings }>('/notifications', data),
  test: (channel: 'email' | 'slack') =>
    api.post<{ success: boolean; message: string }>('/notifications/test', { channel }),
}

export const storageApi = {
  get: () => api.get<{ success: boolean; data: StorageSettings | null }>('/storage'),
  save: (data: Partial<StorageSettings>) =>
    api.put<{ success: boolean; data: StorageSettings }>('/storage', data),
  test: (data: { region: string; bucket: string; accessKeyId: string; secretAccessKey: string; endpoint?: string }) =>
    api.post<{ success: boolean; message: string }>('/storage/test', data),
}
