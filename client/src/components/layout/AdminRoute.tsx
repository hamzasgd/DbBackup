import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '../../store/auth.store'

/** Guards /admin routes: non-admins never render the page. The API enforces
 * the same rule server-side (requireAdmin), so this is UX, not security. */
export function AdminRoute() {
  const role = useAuthStore((s) => s.user?.role)
  return role === 'ADMIN' ? <Outlet /> : <Navigate to="/dashboard" replace />
}
