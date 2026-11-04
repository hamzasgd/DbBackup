import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, RefreshCw, Database, HardDrive, Clock, Bot, Ban, CheckCircle2, ShieldCheck,
} from 'lucide-react'
import { adminApi } from '../../services/admin.service'
import { Button } from '../../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Input } from '../../components/ui/Input'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { TableSkeleton, StatCardSkeleton } from '../../components/ui/Skeleton'
import { StatCard } from '../../components/ui/StatCard'
import { formatBytes, formatDate } from '../../lib/utils'
import { toast } from '../../store/toast.store'
import { useAuthStore } from '../../store/auth.store'

export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const me = useAuthStore((s) => s.user)
  const qc = useQueryClient()
  const [confirmSuspend, setConfirmSuspend] = useState(false)

  const detail = useQuery({
    queryKey: ['admin-user', id],
    queryFn: () => adminApi.getUser(id!),
    enabled: !!id,
  })

  const statusMutation = useMutation({
    mutationFn: (isActive: boolean) => adminApi.setUserStatus(id!, isActive),
    onSuccess: (_res, isActive) => {
      void qc.invalidateQueries({ queryKey: ['admin-user'] })
      void qc.invalidateQueries({ queryKey: ['admin-users'] })
      void qc.invalidateQueries({ queryKey: ['admin-stats'] })
      toast.success(isActive ? 'User reactivated' : 'User suspended — their sessions were revoked')
      setConfirmSuspend(false)
    },
    onError: (e) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to update user status'),
  })

  const data = detail.data?.data.data
  const isSelf = me?.id === id

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-1">
            <ArrowLeft className="h-4 w-4" />Super Admin
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 flex-wrap">
            <ShieldCheck className="h-6 w-6 text-violet-500 shrink-0" />
            <span className="truncate">{data?.user.name ?? '…'}</span>
            {data?.user.role === 'ADMIN' && <Badge className="bg-violet-100 text-violet-700">Admin</Badge>}
            {data && !data.user.isActive && <Badge className="bg-red-100 text-red-700">Suspended</Badge>}
          </h1>
          <p className="text-gray-500 mt-0.5 truncate">{data?.user.email}</p>
        </div>
        {data && !isSelf && (data.user.isActive
          ? <Button variant="danger" size="sm" onClick={() => setConfirmSuspend(true)}><Ban className="h-4 w-4" />Suspend</Button>
          : <Button variant="primary" size="sm" loading={statusMutation.isPending} onClick={() => statusMutation.mutate(true)}><CheckCircle2 className="h-4 w-4" />Reactivate</Button>)}
      </div>

      {detail.isError ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-red-600 mb-3">Couldn't load user — {detail.error instanceof Error ? detail.error.message : 'Request failed'}</p>
            <Button variant="outline" size="sm" onClick={() => detail.refetch()}><RefreshCw className="h-4 w-4" />Retry</Button>
          </CardContent>
        </Card>
      ) : detail.isLoading || !data ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {[0, 1, 2, 3, 4].map((i) => <StatCardSkeleton key={i} />)}
          </div>
          <Card><CardContent className="p-6"><TableSkeleton rows={6} /></CardContent></Card>
        </>
      ) : (
        <>
          {/* Stats row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard
              icon={HardDrive}
              label="Storage used"
              value={formatBytes(data.quota.usedBytes)}
              tone={data.quota.percent != null && data.quota.percent >= 80 ? 'amber' : 'green'}
              sub={data.quota.percent != null
                ? `${data.quota.percent}% of ${formatBytes(data.quota.quotaBytes ?? 0)} quota`
                : 'no quota (unlimited)'}
            />
            <StatCard icon={Database} label="Connections" value={data.connections.length} tone="violet" />
            <StatCard icon={HardDrive} label="Backups (latest shown)" value={data.backups.length} tone="blue" sub={`latest 20 of all time`} />
            <StatCard icon={Clock} label="Schedules" value={data.schedules} tone="blue" />
            <StatCard icon={Bot} label="MCP keys" value={data.mcpKeys.filter((k) => !k.revokedAt).length} tone="violet" sub={`${data.mcpKeys.length} total`} />
          </div>

          {/* Profile line */}
          <Card>
            <CardContent className="p-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
              <span>Joined {formatDate(data.user.createdAt)}</span>
              <span>{data.user.passwordLoginDisabled ? 'Passkey-only sign-in' : 'Password + passkey sign-in'}</span>
              <span>{data.user.termsAcceptedAt ? 'ToS accepted' : 'ToS not accepted'}</span>
              <span className="text-gray-400">Support view is read-only; secrets masked, paths never shown.</span>
            </CardContent>
          </Card>

          {/* Quota editor */}
          <QuotaEditor
            userId={data.user.id}
            usedBytes={data.quota.usedBytes}
            quotaBytes={data.quota.quotaBytes}
            percent={data.quota.percent}
          />

          {/* Connection limit editor */}
          <ConnectionLimitEditor
            userId={data.user.id}
            used={data.connections.length}
            limit={data.user.connectionLimit}
          />

          {/* Connections (masked) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Connections ({data.connections.length}) <span className="font-normal text-gray-400">— secrets masked</span></CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.connections.length === 0 ? (
                <div className="text-center py-10 text-gray-400 text-sm">No connections</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400 uppercase border-b border-gray-100">
                        <th className="px-6 py-3 font-medium">Name</th>
                        <th className="px-6 py-3 font-medium">Type</th>
                        <th className="px-6 py-3 font-medium">Host</th>
                        <th className="px-6 py-3 font-medium">Database</th>
                        <th className="px-6 py-3 font-medium">Flags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.connections.map((c) => (
                        <tr key={c.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                          <td className="px-6 py-3 text-gray-900">{c.name}</td>
                          <td className="px-6 py-3 text-gray-600">{c.type}</td>
                          <td className="px-6 py-3 text-gray-600 font-mono text-xs">{c.host ?? '—'}:{c.port}</td>
                          <td className="px-6 py-3 text-gray-600 font-mono text-xs">{c.database ?? '—'}</td>
                          <td className="px-6 py-3 text-xs text-gray-500">
                            {[c.sslEnabled ? 'SSL' : null, c.sshEnabled ? 'SSH' : null, c.heartbeatEnabled ? 'Heartbeat' : null].filter(Boolean).join(' · ') || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent backups */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Recent backups <span className="font-normal text-gray-400">(latest 20)</span></CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.backups.length === 0 ? (
                <div className="text-center py-10 text-gray-400 text-sm">No backups</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400 uppercase border-b border-gray-100">
                        <th className="px-6 py-3 font-medium">File</th>
                        <th className="px-6 py-3 font-medium">Database</th>
                        <th className="px-6 py-3 font-medium">Status</th>
                        <th className="px-6 py-3 font-medium">Size</th>
                        <th className="px-6 py-3 font-medium">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.backups.map((b) => (
                        <tr key={b.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                          <td className="px-6 py-3 text-gray-900 font-mono text-xs">{b.fileName}</td>
                          <td className="px-6 py-3 text-gray-600">{b.dbName}</td>
                          <td className="px-6 py-3">
                            <Badge className={b.status === 'COMPLETED' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}>{b.status}</Badge>
                          </td>
                          <td className="px-6 py-3 text-gray-600 tabular-nums">{formatBytes(Number(b.fileSize))}</td>
                          <td className="px-6 py-3 text-gray-500 whitespace-nowrap">{formatDate(b.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* MCP keys + recent activity */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">MCP keys ({data.mcpKeys.length})</CardTitle></CardHeader>
              <CardContent className="p-0">
                {data.mcpKeys.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 text-sm">No MCP keys</div>
                ) : (
                  <ul className="divide-y divide-gray-50">
                    {data.mcpKeys.map((k) => (
                      <li key={k.id} className="px-6 py-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-gray-900">{k.name}</span>
                          <Badge className={k.revokedAt ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}>{k.revokedAt ? 'Revoked' : 'Active'}</Badge>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{k.keyPrefix}… · scopes {k.scopes.join(', ')} · today {k.callsToday}{k.dailyCallLimit ? `/${k.dailyCallLimit}` : ''}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Recent activity</CardTitle></CardHeader>
              <CardContent className="p-0">
                {data.auditLogs.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 text-sm">No activity</div>
                ) : (
                  <ul className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
                    {data.auditLogs.map((l, i) => (
                      <li key={i} className="px-6 py-2.5 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-gray-900">{l.action}</span>
                          <span className="text-gray-400 text-xs whitespace-nowrap">{formatDate(l.createdAt)}</span>
                        </div>
                        <p className="text-gray-400 text-xs">{l.ipAddress ?? '—'}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmSuspend}
        onClose={() => setConfirmSuspend(false)}
        onConfirm={() => statusMutation.mutate(false)}
        title={`Suspend ${data?.user.email ?? ''}?`}
        description="They are signed out immediately and cannot sign in until reactivated. Their connections, backups and settings are untouched."
        confirmLabel="Suspend user"
        variant="danger"
        loading={statusMutation.isPending}
      />
    </div>
  )
}

/* ───────────────────────── quota editor ───────────────────────── */

function QuotaEditor({ userId, usedBytes, quotaBytes, percent }: {
  userId: string
  usedBytes: number
  quotaBytes: number | null
  percent: number | null
}) {
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const [syncedFor, setSyncedFor] = useState(userId)
  if (syncedFor !== userId) {
    setSyncedFor(userId)
    setInput('')
  }

  const mutation = useMutation({
    mutationFn: (gb: number | null) => adminApi.setUserQuota(userId, gb),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-users'] })
      void qc.invalidateQueries({ queryKey: ['admin-user'] })
      void qc.invalidateQueries({ queryKey: ['admin-stats'] })
      toast.success('Storage quota updated')
      setInput('')
    },
    onError: (e) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to update quota'),
  })

  const save = () => {
    const trimmed = input.trim()
    if (trimmed === '') return
    const gb = Number(trimmed)
    if (!Number.isFinite(gb) || gb <= 0) {
      toast.error('Enter a positive number of GB, or use Unlimit for no cap')
      return
    }
    mutation.mutate(gb)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Storage quota</CardTitle>
        <span className="text-xs text-gray-500 tabular-nums">
          {percent != null ? `${percent}% · ${formatBytes(usedBytes)} / ${formatBytes(quotaBytes ?? 0)}` : `${formatBytes(usedBytes)} · unlimited`}
        </span>
      </CardHeader>
      <CardContent>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden mb-3">
          <div
            className={`h-full rounded-full ${percent != null && percent >= 80 ? 'bg-red-500' : percent != null && percent >= 70 ? 'bg-amber-400' : 'bg-emerald-500'}`}
            style={{ width: `${Math.min(100, percent ?? 0)}%` }}
          />
        </div>
        <div className="flex gap-2 items-end flex-wrap">
          <div className="w-40">
            <Input label="New quota (GB)" placeholder="e.g. 5" value={input} onChange={(e) => setInput(e.target.value)} />
          </div>
          <Button variant="primary" size="sm" loading={mutation.isPending} onClick={save}>Save</Button>
          {quotaBytes != null && (
            <Button variant="outline" size="sm" loading={mutation.isPending} onClick={() => mutation.mutate(null)}>Unlimit</Button>
          )}
        </div>
        <p className="text-[11px] text-gray-400 mt-2">New backups are blocked once used storage reaches the quota. Unlimit removes the cap entirely.</p>
      </CardContent>
    </Card>
  )
}

/* ───────────────────── connection limit editor ───────────────────── */

function ConnectionLimitEditor({ userId, used, limit }: {
  userId: string
  used: number
  limit: number | null
}) {
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const mutation = useMutation({
    mutationFn: (v: number | null) => adminApi.setUserConnectionLimit(userId, v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-users'] })
      void qc.invalidateQueries({ queryKey: ['admin-user'] })
      void qc.invalidateQueries({ queryKey: ['admin-stats'] })
      toast.success('Connection limit updated')
      setInput('')
    },
    onError: (e) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to update connection limit'),
  })

  const save = () => {
    const trimmed = input.trim()
    if (trimmed === '') return
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n <= 0) {
      toast.error('Enter a positive whole number, or use Unlimit for no cap')
      return
    }
    mutation.mutate(n)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Connection limit</CardTitle>
        <span className="text-xs text-gray-500 tabular-nums">
          {limit == null ? `${used} · unlimited` : `${used} / ${limit} used`}
        </span>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2 items-end flex-wrap">
          <div className="w-40">
            <Input label="Max connections" placeholder="e.g. 10" value={input} onChange={(e) => setInput(e.target.value)} />
          </div>
          <Button variant="primary" size="sm" loading={mutation.isPending} onClick={save}>Save</Button>
          {limit != null && (
            <Button variant="outline" size="sm" loading={mutation.isPending} onClick={() => mutation.mutate(null)}>Unlimit</Button>
          )}
        </div>
        <p className="text-[11px] text-gray-400 mt-2">New connections (including config-bundle imports) are blocked once the count reaches the limit.</p>
      </CardContent>
    </Card>
  )
}
