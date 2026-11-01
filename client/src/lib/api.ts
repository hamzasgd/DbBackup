import axios, { type AxiosError } from 'axios'
import { useAuthStore } from '../store/auth.store'
import { queryClient } from './queryClient'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true, // send the httpOnly refresh cookie on /api/auth calls
  // Custom header the server requires on cookie endpoints (refresh/logout).
  // Cross-origin callers can't set it without a CORS preflight we don't allow → CSRF defence.
  headers: { 'X-DBBK-CSRF': '1' },
})

// Attach access token to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// ─── Refresh-token queue ────────────────────────────────────────────────────
// When multiple requests get 401 at the same time, only ONE refresh call is
// made. The others wait for it to complete and then retry with the new token.
let refreshPromise: Promise<string> | null = null

function doRefresh(): Promise<string> {
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    // The refresh token rides in the httpOnly cookie; no body needed.
    const { data } = await axios.post('/api/auth/refresh', {}, {
      withCredentials: true,
      headers: { 'X-DBBK-CSRF': '1' },
    })
    useAuthStore.getState().setAccessToken(data.data.accessToken)
    return data.data.accessToken as string
  })().finally(() => {
    refreshPromise = null
  })

  return refreshPromise
}

// Auto-refresh on 401
api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = original as any
    if (error.response?.status === 401 && !cfg._retry) {
      cfg._retry = true
      try {
        const newAccessToken = await doRefresh()
        original.headers.Authorization = `Bearer ${newAccessToken}`
        return api(original)
      } catch {
        useAuthStore.getState().logout()
        queryClient.clear()
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export default api
