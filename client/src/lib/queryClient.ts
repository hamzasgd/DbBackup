import { QueryClient } from '@tanstack/react-query'
import { isAxiosError } from 'axios'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Retry once on network errors and 5xx, never on 4xx: retrying a 429
      // (rate limited) or 401/403/404 can't succeed and only burns more of
      // the rate-limit window.
      retry: (failureCount, error) => {
        if (isAxiosError(error) && error.response && error.response.status < 500) return false
        return failureCount < 1
      },
    },
  },
})
