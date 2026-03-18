import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DashboardLayout } from './components/layout/DashboardLayout'
import { ProtectedRoute } from './components/layout/ProtectedRoute'
import { Toaster } from './components/ui/Toaster'
import LoginPage from './pages/auth/LoginPage'
import RegisterPage from './pages/auth/RegisterPage'
import DashboardPage from './pages/dashboard/DashboardPage'
import ConnectionsPage from './pages/connections/ConnectionsPage'
import ConnectionInfoPage from './pages/connections/ConnectionInfoPage'
import TableDetailsPage from './pages/connections/TableDetailsPage'
import BackupsPage from './pages/backups/BackupsPage'
import SchedulesPage from './pages/schedules/SchedulesPage'
import SettingsPage from './pages/settings/SettingsPage'
import MigrationsPage from './pages/migrations/MigrationsPage'
import SyncConfigurationsPage from './pages/sync/SyncConfigurationsPage'
import SyncDetailPage from './pages/sync/SyncDetailPage'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
})

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<DashboardLayout />}>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/connections" element={<ConnectionsPage />} />
              <Route path="/connections/:id/info" element={<ConnectionInfoPage />} />
              <Route path="/connections/:id/info/tables/:tableName" element={<TableDetailsPage />} />
              <Route path="/backups" element={<BackupsPage />} />
              <Route path="/schedules" element={<SchedulesPage />} />
              <Route path="/migrations" element={<MigrationsPage />} />
              <Route path="/sync" element={<SyncConfigurationsPage />} />
              <Route path="/sync/:id" element={<SyncDetailPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  )
}

export default App
