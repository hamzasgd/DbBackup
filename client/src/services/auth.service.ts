import api from '../lib/api'
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { useAuthStore } from '../store/auth.store'

export const authApi = {
  register: (data: { name: string; email: string; password: string }) =>
    api.post('/auth/register', data),
  login: (data: { email: string; password: string }) =>
    api.post('/auth/login', data),
  logout: () => api.post('/auth/logout', { refreshToken: useAuthStore.getState().refreshToken }),
  me: () => api.get('/auth/me'),
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    api.put('/auth/change-password', data),

  // Active sessions
  sessions: () =>
    api.get<{ success: boolean; data: { sessions: ActiveSession[]; count: number } }>('/auth/sessions'),
  revokeSession: (id: string) => api.delete(`/auth/sessions/${id}`),
  revokeAllSessions: () => api.delete('/auth/sessions'),

  // Passkeys (WebAuthn)
  passkeyRegisterOptions: () =>
    api.post<{ success: boolean; data: { options: PublicKeyCredentialCreationOptionsJSON } }>('/auth/passkey/register/options'),
  passkeyRegisterVerify: (response: unknown, name?: string) =>
    api.post<{ success: boolean }>('/auth/passkey/register/verify', { response, name }),
  passkeys: () =>
    api.get<{ success: boolean; data: { passkeys: Passkey[] } }>('/auth/passkey/list'),
  deletePasskey: (id: string) => api.delete(`/auth/passkey/${id}`),
  passkeyLoginOptions: () =>
    api.post<{ success: boolean; data: { options: PublicKeyCredentialRequestOptionsJSON } }>('/auth/passkey/login/options'),
  passkeyLoginVerify: (response: unknown) =>
    api.post<{ success: boolean; data: { user: { id: string; name: string; email: string }; accessToken: string; refreshToken: string } }>('/auth/passkey/login/verify', { response }),
}

export interface ActiveSession {
  id: string
  createdAt: string
  expiresAt: string
  ipAddress?: string | null
  userAgent?: string | null
  browser: string
  os: string
}

export interface Passkey {
  id: string
  name: string
  deviceType?: string | null
  backedUp: boolean
  createdAt: string
  lastUsedAt?: string | null
}
