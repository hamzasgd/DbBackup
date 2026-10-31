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
  ntfyEnabled: boolean
  ntfyServerUrl?: string | null
  ntfyTopic?: string | null
  telegramEnabled: boolean
  telegramBotToken?: string | null
  telegramChatId?: string | null
  discordEnabled: boolean
  discordWebhookUrl?: string | null
  notifyOnSuccess: boolean
  notifyOnFailure: boolean
  notifyOnRetention: boolean
  notifyOnLogin: boolean
  notifyOnStorage: boolean
}

export interface StorageSettings {
  id?: string
  provider: 'LOCAL' | 'S3' | 'GOOGLE_DRIVE'
  bucket?: string | null
  region?: string | null
  accessKeyId?: string | null
  secretAccessKey?: string | null
  endpoint?: string | null
  prefix?: string | null
  gdriveClientId?: string | null
  gdriveClientSecret?: string | null
  gdriveRefreshToken?: string | null
  gdriveFolderId?: string | null
  backupEncryptionEnabled?: boolean
  backupPassphrase?: string | null
  currentBackupPassphrase?: string
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
  test: (data: Partial<StorageSettings>) =>
    api.post<{ success: boolean; message: string }>('/storage/test', data),
  usage: () =>
    api.get<{ success: boolean; data: {
      thresholdPercent: number
      local: { usedBytes: number | null; totalBytes: number | null; percent: number | null } | null
      gdrive: { usedBytes: number | null; totalBytes: number | null; percent: number | null } | null
      s3: { usedBytes: number | null; totalBytes: number | null; percent: number | null } | null
    } }>('/storage/usage'),
}

export interface McpKey {
  id: string
  name: string
  keyPrefix: string
  scopes: string[]
  approvalRequired?: boolean
  lastUsedAt?: string | null
  expiresAt?: string | null
  createdAt: string
}

export const mcpApi = {
  list: () => api.get<{ success: boolean; data: { keys: McpKey[] } }>('/mcp/keys'),
  create: (data: { name: string; scopes: string[]; expiresInDays?: number; approvalRequired?: boolean }) =>
    api.post<{ success: boolean; data: { id: string; name: string; scopes: string[]; key: string }; message: string }>('/mcp/keys', data),
  revoke: (id: string) => api.delete(`/mcp/keys/${id}`),
}

export interface PendingApproval {
  id: string
  keyName: string
  tool: string
  args?: Record<string, unknown> | null
  createdAt: string
}

export const mcpApprovalsApi = {
  pending: () =>
    api.get<{ success: boolean; data: { approvals: PendingApproval[] } }>('/mcp/keys/approvals/pending'),
  approve: (id: string) =>
    api.post<{ success: boolean; data: { text: string } }>(`/mcp/keys/approvals/${id}/approve`),
  deny: (id: string) =>
    api.post<{ success: boolean }>(`/mcp/keys/approvals/${id}/deny`),
}

export const bundleApi = {
  exportUrl: '/api/connections/bundle/export',
  import: (data: ArrayBuffer, passphrase: string) => {
    const formData = new FormData()
    formData.append('file', new Blob([data]))
    formData.append('passphrase', passphrase)
    return api.post('/connections/bundle/import', formData, { headers: { 'Content-Type': 'application/octet-stream' } })
  },
}
