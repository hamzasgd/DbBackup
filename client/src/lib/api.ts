import axios, { type AxiosError } from 'axios'
import { useAuthStore } from '../store/auth.store'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
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
    const refreshToken = useAuthStore.getState().refreshToken
    if (!refreshToken) throw new Error('No refresh token')

    const { data } = await axios.post('/api/auth/refresh', { refreshToken })
    useAuthStore.getState().setTokens(data.data.accessToken, data.data.refreshToken)
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
        // Dynamically import to avoid circular dependency
        import('../App').then(({ queryClient }) => queryClient.clear())
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export default api
