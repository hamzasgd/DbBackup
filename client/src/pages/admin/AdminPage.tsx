import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ShieldCheck, Users, Database, HardDrive, ChevronLeft, ChevronRight,
  RefreshCw, AlertTriangle, Eye, Ban, CheckCircle2, HardDriveDownload,
} from 'lucide-react'
import { adminApi, type AdminUser } from '../../services/admin.service'
import { Button } from '../../components/ui/Button'
import { Card, CardContent } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { TableSkeleton, StatCardSkeleton } from '../../components/ui/Skeleton'
import { StatCard } from '../../components/ui/StatCard'
import { formatBytes, formatDate } from '../../lib/utils'
import { toast } from '../../store/toast.store'
import { useAuthStore } from '../../store/auth.store'

const PAGE_SIZE = 20

function statusBadge(u: AdminUser) {
  if (!u.isActive) return <Badge className="bg-red-100 text-red-700">Suspended</Badge>
  if (u.role === 'ADMIN') return <Badge className="bg-violet-100 text-violet-700">Admin</Badge>
  return <Badge className="bg-green-100 text-green-700">Active</Badge>
}

export default function AdminPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [suspendTarget, setSuspendTarget] = useState<AdminUser | null>(null)

  // 300ms debounce for the search box
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  const onSearchChange = (value: string) => {
    setSearchInput(value)
    if (debounceTimer) clearTimeout(debounceTimer)
    setDebounceTimer(setTimeout(() => { setSearch(value); setPage(1) }, 300))
  }

  const stats = useQuery({ queryKey: ['admin-stats'], queryFn: () => adminApi.getStats() })
  const users = useQuery({
    queryKey: ['admin-users', page, search, status],
    queryFn: () => adminApi.getUsers({ page, limit: PAGE_SIZE, search: search || undefined, status: status || undefined }),
  })
  const statusMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => adminApi.setUserStatus(id, isActive),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: ['admin-users'] })
      void qc.invalidateQueries({ queryKey: ['admin-stats'] })
      void qc.invalidateQueries({ queryKey: ['admin-user'] })
      toast.success(vars.isActive ? 'User reactivated' : 'User suspended — their sessions were revoked')
      setSuspendTarget(null)
    },
    onError: (e) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to update user status'),
  })

  const stat = stats.data?.data.data
  const list = users.data?.data.data
  const rows = list?.users ?? []
  const total = list?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-violet-500" />Super Admin
          </h1>
          <p className="text-gray-500 mt-1">Manage the SaaS: users, platform stats and support views</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => stats.refetch()} disabled={stats.isFetching}>
          <RefreshCw className={`h-4 w-4 ${stats.isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Platform stats */}
      {stats.isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {[0, 1, 2, 3, 4].map((i) => <StatCardSkeleton key={i} />)}
        </div>
      ) : stat ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard icon={Users} label="Users" value={stat.users.total} tone="blue" sub={`${stat.users.active} active`} />
          <StatCard icon={Database} label="Connections" value={stat.connections.total} tone="violet" />
          <StatCard icon={HardDrive} label="Backups" value={stat.backups.byStatus.COMPLETED ?? 0} tone="green" sub={`${stat.backups.byStatus.FAILED ?? 0} failed all-time`} />
          <StatCard icon={HardDriveDownload} label="Storage used" value={formatBytes(Number(stat.storageBytes))} tone="amber" />
          <StatCard icon={AlertTriangle} label="Failed backups (7d)" value={stat.backups.failedLast7d} tone="amber" />
        </div>
      ) : null}

      {/* Users table */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <Input
                label="Search users"
                placeholder="Email or name…"
                value={searchInput}
                onChange={(e) => onSearchChange(e.target.value)}
              />
            </div>
            <Select
              label="Status"
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1) }}
              options={[
                { label: 'All statuses', value: '' },
                { label: 'Active', value: 'active' },
                { label: 'Suspended', value: 'suspended' },
              ]}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {users.isLoading ? (
            <div className="p-6"><TableSkeleton rows={6} /></div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-gray-400">No users found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 uppercase border-b border-gray-100">
                    <th className="px-6 py-3 font-medium">User</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 font-medium">Connections</th>
                    <th className="px-6 py-3 font-medium">Backups</th>
                    <th className="px-6 py-3 font-medium">Storage</th>
                    <th className="px-6 py-3 font-medium">Last backup</th>
                    <th className="px-6 py-3 font-medium">Joined</th>
                    <th className="px-6 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-6 py-3">
                        <p className="font-medium text-gray-900">{u.name}</p>
                        <p className="text-gray-400 text-xs">{u.email}</p>
                      </td>
                      <td className="px-6 py-3">{statusBadge(u)}</td>
                      <td className="px-6 py-3 text-gray-600 tabular-nums">
                        {u.connectionLimit == null ? `${u.connections} · unlimited` : `${u.connections} / ${u.connectionLimit}`}
                      </td>
                      <td className="px-6 py-3 text-gray-600 tabular-nums">{u.backups}</td>
                      <td className="px-6 py-3 text-gray-600 whitespace-nowrap">
                        {u.storageQuotaBytes == null
                          ? `${formatBytes(Number(u.storageUsed))} · unlimited`
                          : `${formatBytes(Number(u.storageUsed))} / ${formatBytes(Number(u.storageQuotaBytes))}`}
                      </td>
                      <td className="px-6 py-3 text-gray-500 whitespace-nowrap">{u.lastBackupAt ? formatDate(u.lastBackupAt) : '—'}</td>
                      <td className="px-6 py-3 text-gray-500 whitespace-nowrap">{formatDate(u.createdAt)}</td>
                      <td className="px-6 py-3">
                        <div className="flex justify-end gap-1.5">
                          <Button variant="outline" size="sm" onClick={() => navigate(`/admin/users/${u.id}`)}>
                            <Eye className="h-4 w-4" />View
                          </Button>
                          {u.id !== me?.id && (u.isActive
                            ? (
                              <Button variant="danger" size="sm" onClick={() => setSuspendTarget(u)}>
                                <Ban className="h-4 w-4" />Suspend
                              </Button>
                            )
                            : (
                              <Button variant="primary" size="sm" onClick={() => statusMutation.mutate({ id: u.id, isActive: true })}>
                                <CheckCircle2 className="h-4 w-4" />Reactivate
                              </Button>
                            ))}
                        </div>
                      </td>
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

      {/* Suspend confirmation */}
      <ConfirmDialog
        open={!!suspendTarget}
        onClose={() => setSuspendTarget(null)}
        onConfirm={() => suspendTarget && statusMutation.mutate({ id: suspendTarget.id, isActive: false })}
        title={`Suspend ${suspendTarget?.email ?? ''}?`}
        description="They are signed out immediately and cannot sign in until reactivated. Their connections, backups and settings are untouched."
        confirmLabel="Suspend user"
        variant="danger"
        loading={statusMutation.isPending}
      />
    </div>
  )
}
