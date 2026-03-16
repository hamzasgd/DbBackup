import { useEffect, useRef } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '../../store/auth.store'
import { queryClient } from '../../App'

export function ProtectedRoute() {
  const { isAuthenticated, user } = useAuthStore()
  const prevUserIdRef = useRef(user?.id)

  // If the logged-in user changes (account switch), nuke the entire React Query cache
  // so the new user never sees stale data from the previous session.
  useEffect(() => {
    if (user?.id && prevUserIdRef.current && user.id !== prevUserIdRef.current) {
      queryClient.clear()
    }
    prevUserIdRef.current = user?.id
  }, [user?.id])

  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />
}
