import { useQuery } from '@tanstack/react-query'
import { Database, HardDrive, Clock, CheckCircle, AlertCircle, Activity } from 'lucide-react'
import { connectionsApi } from '../../services/connections.service'
import { backupsApi } from '../../services/backups.service'
import { schedulesApi } from '../../services/schedules.service'
import { useAuthStore } from '../../store/auth.store'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { formatBytes, formatDate, statusBadgeColor, dbTypeLabel, dbTypeBadgeColor } from '../../lib/utils'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/Button'

function StatCard({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: number | string; color: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-4">
        <div className={`rounded-xl p-3 ${color}`}>
          <Icon className="h-5 w-5 text-white" />
        </div>
        <div>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          <p className="text-sm text-gray-500">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user)
  const { data: connsData } = useQuery({ queryKey: ['connections'], queryFn: () => connectionsApi.getAll() })
  const { data: backupsData } = useQuery({ queryKey: ['backups'], queryFn: () => backupsApi.getAll({ limit: 10 }) })
  const { data: schedulesData } = useQuery({ queryKey: ['schedules'], queryFn: () => schedulesApi.getAll() })

  const connections = connsData?.data.data ?? []
  const backups = backupsData?.data.data.backups ?? []
  const schedules = schedulesData?.data.data ?? []

  const completedBackups = backups.filter((b) => b.status === 'COMPLETED').length
  const failedBackups = backups.filter((b) => b.status === 'FAILED').length
  const activeSchedules = schedules.filter((s) => s.isActive).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Welcome back, {user?.name} 👋</h1>
        <p className="text-gray-500 mt-1">Here's what's happening with your database backups</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Database} label="Connections" value={connections.length} color="bg-blue-500" />
        <StatCard icon={HardDrive} label="Total Backups" value={backups.length} color="bg-purple-500" />
        <StatCard icon={CheckCircle} label="Completed" value={completedBackups} color="bg-green-500" />
        <StatCard icon={Clock} label="Active Schedules" value={activeSchedules} color="bg-orange-500" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Backups */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Backups</CardTitle>
            <Link to="/backups">
              <Button variant="ghost" size="sm">View all</Button>
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {backups.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-8">No backups yet</p>
            ) : (
              <div className="divide-y divide-gray-50">
                {backups.slice(0, 6).map((b) => (
                  <div key={b.id} className="flex items-center justify-between px-6 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {b.snapshotName || b.dbName}
                      </p>
                      <p className="text-xs text-gray-400">{formatDate(b.createdAt)}</p>
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      <span className="text-xs text-gray-400">{formatBytes(b.fileSize)}</span>
                      <Badge className={statusBadgeColor(b.status)}>{b.status}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {failedBackups > 0 && (
              <div className="flex items-center gap-2 px-6 py-3 bg-red-50 text-red-700 text-sm border-t">
                <AlertCircle className="h-4 w-4" />
                {failedBackups} backup(s) failed
              </div>
            )}
          </CardContent>
        </Card>

        {/* Connections */}
        <Card>
          <CardHeader>
            <CardTitle>Connections</CardTitle>
            <Link to="/connections">
              <Button variant="ghost" size="sm">Manage</Button>
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {connections.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-gray-400 text-sm">No connections yet</p>
                <Link to="/connections">
                  <Button size="sm" className="mt-3">Add Connection</Button>
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {connections.map((c) => (
                  <div key={c.id} className="flex items-center justify-between px-6 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                      <p className="text-xs text-gray-400">{c.host}:{c.port}</p>
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      <Badge className={dbTypeBadgeColor(c.type)}>{dbTypeLabel(c.type)}</Badge>
                      {c.sshEnabled && <Badge className="bg-gray-100 text-gray-600">SSH</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Schedules */}
      {schedules.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle><span className="flex items-center gap-2"><Activity className="h-4 w-4" />Active Schedules</span></CardTitle>
            <Link to="/schedules"><Button variant="ghost" size="sm">View all</Button></Link>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-gray-50">
              {schedules.filter(s => s.isActive).slice(0, 5).map((s) => (
                <div key={s.id} className="flex items-center justify-between px-6 py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{s.name}</p>
                    <p className="text-xs text-gray-400 font-mono">{s.cronExpression}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="bg-gray-100 text-gray-600">{s.frequency}</Badge>
                    {s.lastRunAt && <span className="text-xs text-gray-400">Last: {formatDate(s.lastRunAt)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
