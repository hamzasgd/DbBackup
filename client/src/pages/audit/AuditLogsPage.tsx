import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, ChevronLeft, ChevronRight, History } from 'lucide-react'
import { auditApi, type AuditLog } from '../../services/audit.service'
import { Button } from '../../components/ui/Button'
import { Card, CardContent } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Select } from '../../components/ui/Select'
import { TableSkeleton } from '../../components/ui/Skeleton'
import { formatDate } from '../../lib/utils'

const PAGE_SIZE = 50

const ACTION_GROUPS: Record<string, { label: string; color: string }> = {
  LOGIN: { label: 'Login', color: 'bg-green-100 text-green-700' },
  LOGIN_FAILED: { label: 'Login failed', color: 'bg-red-100 text-red-700' },
  LOGOUT: { label: 'Logout', color: 'bg-gray-100 text-gray-600' },
  REGISTER: { label: 'Register', color: 'bg-blue-100 text-blue-700' },
  PASSWORD_CHANGE: { label: 'Password change', color: 'bg-orange-100 text-orange-700' },
  CREATE: { label: 'Create', color: 'bg-blue-100 text-blue-700' },
  UPDATE: { label: 'Update', color: 'bg-yellow-100 text-yellow-700' },
  DELETE: { label: 'Delete', color: 'bg-red-100 text-red-700' },
  TEST: { label: 'Test', color: 'bg-purple-100 text-purple-700' },
  TRIGGER: { label: 'Trigger', color: 'bg-indigo-100 text-indigo-700' },
  BACKUP_COMPLETED: { label: 'Backup done', color: 'bg-green-100 text-green-700' },
  BACKUP_FAILED: { label: 'Backup failed', color: 'bg-red-100 text-red-700' },
  RESTORE: { label: 'Restore', color: 'bg-cyan-100 text-cyan-700' },
  RESTORE_FAILED: { label: 'Restore failed', color: 'bg-red-100 text-red-700' },
  VERIFY: { label: 'Verify', color: 'bg-teal-100 text-teal-700' },
  DOWNLOAD: { label: 'Download', color: 'bg-gray-100 text-gray-600' },
  RETENTION_SWEEP: { label: 'Retention', color: 'bg-amber-100 text-amber-700' },
  MCP_CALL: { label: 'MCP tool call', color: 'bg-violet-100 text-violet-700' },
  MCP_KEY_CREATE: { label: 'MCP key created', color: 'bg-violet-100 text-violet-700' },
  MCP_KEY_REVOKE: { label: 'MCP key revoked', color: 'bg-red-100 text-red-700' },
  MCP_KEY_ROTATE: { label: 'MCP key rotated', color: 'bg-blue-100 text-blue-700' },
  MCP_APPROVE: { label: 'MCP approved', color: 'bg-green-100 text-green-700' },
  MCP_DENY: { label: 'MCP denied', color: 'bg-red-100 text-red-700' },
  BACKUP_STALE: { label: 'Backup missed', color: 'bg-amber-100 text-amber-700' },
  DRILL_PASSED: { label: 'Drill passed', color: 'bg-green-100 text-green-700' },
  DRILL_FAILED: { label: 'Drill failed', color: 'bg-red-100 text-red-700' },
  LOGIN_IP_LOCKOUT: { label: 'IP locked', color: 'bg-red-100 text-red-700' },
  LOGIN_BRUTE_FORCE_SUSPECT: { label: 'Brute force', color: 'bg-red-100 text-red-700' },
  LOGIN_BLOCKED_LOCKDOWN: { label: 'Lockdown block', color: 'bg-orange-100 text-orange-700' },
}

const RESOURCE_LABELS: Record<string, string> = {
  user: 'User / Auth',
  connection: 'Connection',
  backup: 'Backup',
  schedule: 'Schedule',
  storage_settings: 'Storage',
  notification_settings: 'Notifications',
  migration: 'Migration',
  sync_config: 'Sync',
}

function actionBadge(a: string) {
  const g = ACTION_GROUPS[a]
  return <Badge className={g?.color ?? 'bg-gray-100 text-gray-600'}>{g?.label ?? a}</Badge>
}

function detailSummary(log: AuditLog): string {
  const d = log.details ?? {}
  const parts: string[] = []

  // MCP tool calls: key name, tool, result, duration
  if (log.action === 'MCP_CALL') {
    if (d.tool) parts.push(String(d.tool))
    if (d.key) parts.push(`via ${d.key}`)
    if (d.ms !== undefined) parts.push(`${d.ms}ms`)
    if (d.ok === false) parts.push('failed')
    return parts.join(' · ')
  }

  // MCP key lifecycle events
  if (log.action.startsWith('MCP_KEY') || log.action.startsWith('MCP_APPROVE') || log.action.startsWith('MCP_DENY')) {
    if (d.name) parts.push(String(d.name))
    if (d.keyId) parts.push(String(d.keyId).slice(0, 8))
    if (d.scopes) parts.push(Array.isArray(d.scopes) ? d.scopes.join(', ') : String(d.scopes))
    return parts.join(' · ')
  }

  if (d.name) parts.push(String(d.name))
  else if (d.fileName) parts.push(String(d.fileName))
  else if (d.email) parts.push(String(d.email))
  if (d.error) parts.push(`error: ${String(d.error).slice(0, 120)}`)
  else if (d.success === false) parts.push('failed')
  else if (d.valid === false) parts.push('invalid checksum')
  if (d.deleted) parts.push(`${d.deleted} deleted`)
  if (d.sizeBytes) parts.push(`${(Number(d.sizeBytes) / 1048576).toFixed(1)} MB`)
  if (d.storageType) parts.push(String(d.storageType))
  if (d.percent) parts.push(`${d.percent}%`)
  if (d.connectionId) parts.push(String(d.connectionId).slice(0, 8))
  if (d.attempts) parts.push(`${d.attempts} attempts`)
  if (d.minutes) parts.push(`${d.minutes} min`)
  return parts.join(' · ')
}

export default function AuditLogsPage() {
  const [page, setPage] = useState(1)
  const [action, setAction] = useState('')
  const [resource, setResource] = useState('')

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['audit-logs', page, action, resource],
    queryFn: () => auditApi.getAll({
      page,
      limit: PAGE_SIZE,
      action: action || undefined,
      resource: resource || undefined,
    }),
  })

  const logs = data?.data.data.logs ?? []
  const total = data?.data.data.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <History className="h-6 w-6 text-gray-400" />Activity Logs
          </h1>
          <p className="text-gray-500 mt-1">{total} total event{total !== 1 ? 's' : ''}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Select
              label="Action"
              value={action}
              onChange={(e) => { setAction(e.target.value); setPage(1) }}
              options={[
                { label: 'All actions', value: '' },
                ...Object.entries(ACTION_GROUPS).map(([value, g]) => ({ label: g.label, value })),
              ]}
            />
            <Select
              label="Resource"
              value={resource}
              onChange={(e) => { setResource(e.target.value); setPage(1) }}
              options={[
                { label: 'All resources', value: '' },
                ...Object.entries(RESOURCE_LABELS).map(([value, label]) => ({ label, value })),
              ]}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6"><TableSkeleton rows={8} /></div>
          ) : logs.length === 0 ? (
            <div className="text-center py-16 text-gray-400">No activity found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 uppercase border-b border-gray-100">
                    <th className="px-6 py-3 font-medium">Time</th>
                    <th className="px-6 py-3 font-medium">Action</th>
                    <th className="px-6 py-3 font-medium">Resource</th>
                    <th className="px-6 py-3 font-medium">Details</th>
                    <th className="px-6 py-3 font-medium">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-6 py-3 text-gray-500 whitespace-nowrap">{formatDate(log.createdAt)}</td>
                      <td className="px-6 py-3">{actionBadge(log.action)}</td>
                      <td className="px-6 py-3 text-gray-600 whitespace-nowrap">{RESOURCE_LABELS[log.resource] ?? log.resource}</td>
                      <td className="px-6 py-3 text-gray-600 max-w-md">
                        <span className="line-clamp-2">{detailSummary(log) || <span className="text-gray-300">—</span>}</span>
                      </td>
                      <td className="px-6 py-3 text-gray-400 whitespace-nowrap" title={log.userAgent ?? undefined}>{log.ipAddress ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-3 border-t border-gray-100">
              <span className="text-xs text-gray-400">Page {page} of {totalPages}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4" />Prev
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  Next<ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
