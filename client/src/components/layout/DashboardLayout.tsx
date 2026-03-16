import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'

export function DashboardLayout() {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 md:ml-64 overflow-y-auto min-h-screen">
        <div className="p-4 pt-16 md:pt-8 md:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
