import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import {
  Database, HardDrive, Clock, CheckCircle2, Activity, Plus, Zap,
  TrendingUp, ShieldCheck, ShieldAlert, LogIn, LogOut, KeyRound, Trash2,
  Settings2, Bot, HardDriveDownload,
} from 'lucide-react'
import { connectionsApi } from '../../services/connections.service'
import { backupsApi } from '../../services/backups.service'
import { schedulesApi } from '../../services/schedules.service'
import { storageApi } from '../../services/settings.service'
import { auditApi } from '../../services/audit.service'
import { useAuthStore } from '../../store/auth.store'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { formatBytes, formatDate, statusBadgeColor, dbTypeLabel, dbTypeBadgeColor } from '../../lib/utils'
import { cn } from '../../lib/utils'
import { CardSkeleton, StatCardSkeleton } from '../../components/ui/Skeleton'

/* ───────────────────────────── helpers ───────────────────────────── */

const DAY = 24 * 60 * 60 * 1000

function dayKey(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10)
}

/** Compact "x ago" for activity feeds. */
function timeAgo(date: string): string {
  const diff = Date.now() - new Date(date).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/* ───────────────────────────── stat card ───────────────────────────── */

function StatCard({
  icon: Icon, label, value, sub, tone,
}: {
  icon: React.ElementType
  label: string
  value: string | number
  sub?: React.ReactNode
  tone: 'blue' | 'violet' | 'green' | 'amber'
}) {
  const tones = {
    blue: 'bg-blue-50 text-blue-600',
    violet: 'bg-violet-50 text-violet-600',
    green: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
  } as const
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">{label}</p>
            <p className="mt-1.5 text-2xl font-bold text-gray-900 tabular-nums leading-none">{value}</p>
            {sub && <p className="mt-2 text-xs text-gray-500 truncate">{sub}</p>}
          </div>
          <div className={cn('rounded-lg p-2.5 shrink-0', tones[tone])}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/* ───────────────────────── 30-day activity chart (pure SVG) ───────────────────────── */

interface DayBucket { size: number; ok: number; failed: number }

function ActivityChart({ backups, now }: { backups: { createdAt: string; status: string; fileSize: number }[]; now: number }) {
  const days = 30
  const buckets = new Map<string, DayBucket>()
  for (let i = days - 1; i >= 0; i--) {
    buckets.set(dayKey(new Date(now - i * DAY)), { size: 0, ok: 0, failed: 0 })
  }
  for (const b of backups) {
    const key = dayKey(b.createdAt)
    const bucket = buckets.get(key)
    if (!bucket) continue
    if (b.status === 'FAILED') bucket.failed += 1
    else if (b.status === 'COMPLETED') {
      bucket.ok += 1
      bucket.size += Number(b.fileSize) || 0
    }
  }
  const series = [...buckets.values()]
  const maxSize = Math.max(1, ...series.map((d) => d.size))
  const W = 720, H = 168, PAD_B = 22, PAD_T = 8
  const innerH = H - PAD_B - PAD_T
  const barW = W / days

  // ~5 x-axis labels
  const ticks = [0, 7, 14, 21, 29].map((i) => ({
    x: (i + 0.5) * barW,
    label: new Date(now - (days - 1 - i) * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  }))

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-44" role="img" aria-label="Backup activity, last 30 days">
        {/* gridlines */}
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={PAD_T + innerH * (1 - f)} y2={PAD_T + innerH * (1 - f)} stroke="#f3f4f6" strokeWidth={1} />
        ))}
        {/* baseline */}
        <line x1={0} x2={W} y1={H - PAD_B} y2={H - PAD_B} stroke="#e5e7eb" strokeWidth={1} />
        {series.map((d, i) => {
          const h = Math.max(d.size > 0 ? 4 : 0, (d.size / maxSize) * innerH)
          const x = i * barW + barW * 0.18
          const w = barW * 0.64
          const y = H - PAD_B - h
          const dateLabel = new Date(now - (days - 1 - i) * DAY).toLocaleDateString()
          const title = `${dateLabel} — ${d.ok} completed, ${d.failed} failed${d.size ? `, ${formatBytes(d.size)}` : ''}`
          return (
            <g key={i}>
              {d.size > 0 && (
                <title>{title}</title>
              )}
              <rect
                x={x} y={y} width={w} height={h}
                rx={Math.min(3, w / 2)}
                fill={d.failed > 0 ? '#f87171' : '#60a5fa'}
                opacity={d.size > 0 ? 0.9 : 0}
                className={d.size > 0 ? 'hover:opacity-100' : undefined}
              />
              {d.size === 0 && (
                <rect x={x} y={H - PAD_B - 2} width={w} height={2} rx={1} fill="#e5e7eb" />
              )}
            </g>
          )
        })}
        {ticks.map((t, i) => (
          <text key={i} x={t.x} y={H - 6} textAnchor="middle" fontSize={10} fill="#9ca3af">
            {t.label}
          </text>
        ))}
      </svg>
      <div className="flex items-center gap-4 px-1 -mt-1">
        <span className="flex items-center gap-1.5 text-xs text-gray-400"><span className="h-2 w-2 rounded-sm bg-blue-400" />completed (bar height = data size)</span>
        <span className="flex items-center gap-1.5 text-xs text-gray-400"><span className="h-2 w-2 rounded-sm bg-red-400" />day with failures</span>
      </div>
    </div>
  )
}

/* ───────────────────────── storage panel ───────────────────────── */

function StorageRow({ label, usage, threshold }: {
  label: string
  usage: { usedBytes: number | null; totalBytes: number | null; percent: number | null } | null
  threshold: number
}) {
  if (!usage || usage.percent == null) return null
  const pct = Math.min(100, usage.percent)
  const over = pct >= threshold
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-600 font-medium">{label}</span>
        <span className={cn('tabular-nums', over ? 'text-red-600 font-semibold' : 'text-gray-500')}>
          {pct.toFixed(0)}% · {usage.usedBytes != null ? formatBytes(usage.usedBytes) : '?'}
          {usage.totalBytes ? ` / ${formatBytes(usage.totalBytes)}` : ''}
        </span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', over ? 'bg-red-500' : pct > threshold - 10 ? 'bg-amber-400' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/* ───────────────────────── activity feed icons ───────────────────────── */

function auditIcon(action: string): { icon: React.ElementType; cls: string } {
  if (action.includes('LOGIN') || action === 'LOGOUT') return { icon: action === 'LOGOUT' ? LogOut : LogIn, cls: 'bg-gray-100 text-gray-500' }
  if (action.includes('FAILED')) return { icon: ShieldAlert, cls: 'bg-red-50 text-red-600' }
  if (action.startsWith('BACKUP_COMPLETED')) return { icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-600' }
  if (action === 'RESTORE') return { icon: HardDriveDownload, cls: 'bg-cyan-50 text-cyan-600' }
  if (action === 'DELETE' || action.includes('RETENTION')) return { icon: Trash2, cls: 'bg-orange-50 text-orange-600' }
  if (action === 'CREATE' || action === 'TRIGGER') return { icon: Plus, cls: 'bg-blue-50 text-blue-600' }
  if (action.startsWith('MCP')) return { icon: Bot, cls: 'bg-violet-50 text-violet-600' }
  if (action.startsWith('HEARTBEAT')) return { icon: Activity, cls: 'bg-amber-50 text-amber-600' }
  if (action === 'PASSKEY' || action.includes('PASSWORD')) return { icon: KeyRound, cls: 'bg-purple-50 text-purple-600' }
  if (action === 'UPDATE') return { icon: Settings2, cls: 'bg-gray-100 text-gray-500' }
  return { icon: Activity, cls: 'bg-gray-100 text-gray-500' }
}

/* ───────────────────────────── page ───────────────────────────── */

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()

  const { data: connsData, isLoading: connsLoading } = useQuery({ queryKey: ['connections'], queryFn: () => connectionsApi.getAll() })
  const { data: backupsData, isLoading: backupsLoading, dataUpdatedAt: backupsUpdatedAt } = useQuery({
    queryKey: ['backups', 'dash'],
    queryFn: () => backupsApi.getAll({ limit: 100 }),
    refetchInterval: (q) => {
      const list = q.state.data?.data.data.backups ?? []
      return list.some((b) => b.status === 'RUNNING' || b.status === 'PENDING') ? 5000 : 30000
    },
  })
  const { data: schedulesData } = useQuery({ queryKey: ['schedules'], queryFn: () => schedulesApi.getAll() })
  const { data: usageData } = useQuery({ queryKey: ['storage-usage'], queryFn: () => storageApi.usage() })
  const { data: auditData, isLoading: auditLoading } = useQuery({ queryKey: ['audit-logs', 'dash'], queryFn: () => auditApi.getAll({ limit: 8 }) })

  // "Now" for the 30-day window: when the backups were last fetched (pure; refreshes with each refetch)
  const [mountedAt] = useState(() => new Date().getTime())
  const now = backupsUpdatedAt || mountedAt

  const connections = connsData?.data.data ?? []
  const backups = backupsData?.data.data.backups ?? []
  const totalBackups = backupsData?.data.data.total ?? backups.length
  const schedules = schedulesData?.data.data ?? []
  const usage = usageData?.data.data
  const events = auditData?.data.data.logs ?? []

  // 30-day window stats
  const since30 = now - 30 * DAY
  const last30 = backups.filter((b) => new Date(b.createdAt).getTime() >= since30)
  const finished30 = last30.filter((b) => b.status === 'COMPLETED' || b.status === 'FAILED')
  const ok30 = finished30.filter((b) => b.status === 'COMPLETED')
  const successRate = finished30.length > 0 ? (ok30.length / finished30.length) * 100 : null
  const volume30 = ok30.reduce((sum, b) => sum + (Number(b.fileSize) || 0), 0)
  const failedRecent = last30.filter((b) => b.status === 'FAILED').length

  // heartbeat roll-up
  const withHeartbeat = connections.filter((c) => c.heartbeatEnabled)
  const hbUp = withHeartbeat.filter((c) => c.latestHeartbeat?.status === 'UP').length
  const hbDown = withHeartbeat.filter((c) => c.latestHeartbeat?.status === 'DOWN').length

  const activeSchedules = schedules.filter((s) => s.isActive)
  const nextRun = activeSchedules
    .map((s) => s.nextRunAt)
    .filter((d): d is string => Boolean(d))
    .sort()[0]

  const hasNoConnections = connections.length === 0

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Welcome back, {user?.name?.split(' ')[0]} 👋</h1>
          <p className="text-gray-500 mt-0.5 text-sm">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            {nextRun && <> · next scheduled backup {formatDate(nextRun)}</>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate('/connections')}>
            <Plus className="h-4 w-4" />Connection
          </Button>
          <Button size="sm" onClick={() => navigate('/backups')}>
            <Zap className="h-4 w-4" />New backup
          </Button>
        </div>
      </div>

      {/* Loading skeletons — never flash empty states while fetching */}
      {connsLoading ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => <StatCardSkeleton key={i} />)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </div>
        </div>
      ) : hasNoConnections ? (
        <Card>
          <CardContent className="py-14 text-center">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center">
              <Database className="h-6 w-6 text-blue-600" />
            </div>
            <h2 className="mt-4 text-lg font-semibold text-gray-900">Connect your first database</h2>
            <p className="mt-1 text-sm text-gray-500 max-w-md mx-auto">
              Add a MySQL, MariaDB or PostgreSQL connection — with optional SSH tunnel — and DbBackup
              handles scheduled backups, verification, retention and alerts.
            </p>
            <Button className="mt-5" onClick={() => navigate('/connections')}>
              <Plus className="h-4 w-4" />Add connection
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <StatCard
              icon={Database} tone="blue" label="Connections" value={connections.length}
              sub={withHeartbeat.length > 0
                ? (hbDown > 0
                  ? <span className="text-red-600 font-medium">{hbDown} down · {hbUp} up (heartbeat)</span>
                  : <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{hbUp}/{withHeartbeat.length} healthy</span>)
                : `${connections.filter((c) => c.sshEnabled).length} via SSH tunnel`}
            />
            <StatCard
              icon={HardDrive} tone="violet" label="Backups (30 days)" value={last30.length}
              sub={<span className="flex items-center gap-1"><TrendingUp className="h-3 w-3" />{formatBytes(volume30)} protected this month</span>}
            />
            <StatCard
              icon={successRate !== null && successRate >= 95 ? CheckCircle2 : ShieldAlert}
              tone={failedRecent > 0 ? 'amber' : 'green'}
              label="Success rate (30 days)"
              value={successRate !== null ? `${successRate.toFixed(0)}%` : '—'}
              sub={failedRecent > 0
                ? <span className="text-amber-600 font-medium">{failedRecent} failed backup{failedRecent > 1 ? 's' : ''}</span>
                : <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" />all verified runs passed</span>}
            />
            <StatCard
              icon={Clock} tone="amber" label="Active schedules" value={activeSchedules.length}
              sub={nextRun ? `next run ${timeAgo(nextRun) === 'just now' ? 'now' : `in ~${timeAgo(nextRun).replace(' ago', '')}`}` : 'no runs scheduled'}
            />
          </div>

          {/* Chart + storage */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Backup activity — last 30 days</CardTitle>
                <span className="text-xs text-gray-400">{totalBackups} backups stored</span>
              </CardHeader>
              <CardContent className="pt-0">
                <ActivityChart backups={backups} now={now} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Storage</CardTitle>
                <Link to="/settings" className="text-xs text-blue-600 hover:underline">manage</Link>
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                {usage && (usage.local || usage.gdrive || usage.s3) ? (
                  <>
                    <StorageRow label="Local disk" usage={usage.local} threshold={usage.thresholdPercent} />
                    <StorageRow label="Google Drive" usage={usage.gdrive} threshold={usage.thresholdPercent} />
                    <StorageRow label="S3 (budget)" usage={usage.s3} threshold={usage.thresholdPercent} />
                    <p className="text-[11px] text-gray-400">alerts at {usage.thresholdPercent}%</p>
                  </>
                ) : (
                  <div className="text-sm text-gray-400 py-6 text-center">
                    <HardDrive className="h-5 w-5 mx-auto mb-2 text-gray-300" />
                    No storage metrics yet
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Health + backups + activity */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Connection health */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Connection health</CardTitle>
                <Link to="/connections" className="text-xs text-blue-600 hover:underline">view</Link>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-gray-50">
                  {connections.slice(0, 5).map((c) => {
                    const hb = c.heartbeatEnabled ? c.latestHeartbeat : null
                    return (
                      <div key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className={cn(
                            'h-2 w-2 rounded-full shrink-0',
                            hb?.status === 'UP' ? 'bg-emerald-500' : hb?.status === 'DOWN' ? 'bg-red-500 animate-pulse' : 'bg-gray-300',
                          )} />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                            <p className="text-xs text-gray-400">
                              {hb?.status === 'UP' && hb.latencyMs != null ? `${hb.latencyMs} ms` : hb?.status === 'DOWN' ? 'unreachable' : dbTypeLabel(c.type)}
                            </p>
                          </div>
                        </div>
                        <Badge className={dbTypeBadgeColor(c.type)}>{dbTypeLabel(c.type)}</Badge>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Recent backups */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recent backups</CardTitle>
                <Link to="/backups" className="text-xs text-blue-600 hover:underline">view all</Link>
              </CardHeader>
              <CardContent className="p-0">
                {backupsLoading ? (
                  <p className="text-sm text-gray-300 text-center py-8">Loading…</p>
                ) : backups.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">No backups yet — trigger your first one</p>
                ) : (
                  <div className="divide-y divide-gray-50">
                    {backups.slice(0, 5).map((b) => (
                      <div key={b.id} className="flex items-center justify-between gap-3 px-5 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{b.connection?.name ?? b.dbName}</p>
                          <p className="text-xs text-gray-400">{timeAgo(b.createdAt)}{b.fileSize ? ` · ${formatBytes(b.fileSize)}` : ''}</p>
                        </div>
                        <Badge className={statusBadgeColor(b.status)}>{b.status.toLowerCase()}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Activity feed */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Activity</CardTitle>
                <Link to="/audit" className="text-xs text-blue-600 hover:underline">full log</Link>
              </CardHeader>
              <CardContent className="p-0">
                {auditLoading ? (
                  <p className="text-sm text-gray-300 text-center py-8">Loading…</p>
                ) : events.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">Nothing yet</p>
                ) : (
                  <div className="divide-y divide-gray-50">
                    {events.slice(0, 6).map((e) => {
                      const { icon: Icon, cls } = auditIcon(e.action)
                      return (
                        <div key={e.id} className="flex items-center gap-3 px-5 py-2.5">
                          <div className={cn('rounded-md p-1.5 shrink-0', cls)}>
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-gray-700 truncate">
                              {e.action.replaceAll('_', ' ').toLowerCase()}
                              {typeof e.details?.name === 'string' ? ` · ${e.details.name}` : ''}
                            </p>
                            <p className="text-[11px] text-gray-400">{timeAgo(e.createdAt)}{e.ipAddress ? ` · ${e.ipAddress}` : ''}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
