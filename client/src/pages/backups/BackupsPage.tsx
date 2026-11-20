import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Download, RotateCcw, HardDrive, RefreshCw, Filter, ShieldCheck, ShieldAlert, ShieldOff, FlaskConical, AlertTriangle, Info, Loader2 } from 'lucide-react'
import { backupsApi, restoreApi, type BackupFormat, type Backup } from '../../services/backups.service'
import { connectionsApi } from '../../services/connections.service'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { Select } from '../../components/ui/Select'
import { Input } from '../../components/ui/Input'
import { formatBytes, formatDate, statusBadgeColor, dbTypeBadgeColor, dbTypeLabel, getApiErrorMessage } from '../../lib/utils'
import { useProgressSSE, type ProgressEvent } from '../../hooks/useProgressSSE'
import { RestoresPanel, RestoreEvents, RestoreItem } from './RestoresPanel'
import { isActiveRestore, liveRestore } from './restore-live'
import { ToolStrategyPicker } from '../../components/ToolStrategyPicker'
import { sshServerStrategyAvailable, type ToolStrategy } from '../../lib/tool-strategy'
import { BackupLiveProgress, type Freshness } from './BackupLiveProgress'
import { liveProgress } from './live-progress'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { TableSkeleton } from '../../components/ui/Skeleton'
import { useAuthStore } from '../../store/auth.store'

function startBackupDownload(backup: Backup) {
  const accessToken = useAuthStore.getState().accessToken
  const tokenQuery = accessToken ? `?token=${encodeURIComponent(accessToken)}` : ''
  const url = `/api/backups/${backup.id}/download${tokenQuery}`

  const a = document.createElement('a')
  a.href = url
  a.download = backup.fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

const MYSQL_FORMATS: { label: string; value: BackupFormat }[] = [
  { label: 'Compressed SQL (.sql.gz)', value: 'COMPRESSED_SQL' },
  { label: 'Plain SQL (.sql)', value: 'PLAIN_SQL' },
]

const NOSQL_FORMATS: { label: string; value: BackupFormat }[] = [
  { label: 'Native archive (mongodump / RDB snapshot)', value: 'COMPRESSED_SQL' },
]

const PG_FORMATS: { label: string; value: BackupFormat }[] = [
  { label: 'Custom / pg_dump (-Fc)', value: 'CUSTOM' },
  { label: 'Compressed SQL (.sql.gz)', value: 'COMPRESSED_SQL' },
  { label: 'Plain SQL (.sql)', value: 'PLAIN_SQL' },
  { label: 'Directory (parallel)', value: 'DIRECTORY' },
  { label: 'Tar archive (.tar)', value: 'TAR' },
]

function formatLabel(format: BackupFormat) {
  const all = [...MYSQL_FORMATS, ...PG_FORMATS]
  return all.find(f => f.value === format)?.label ?? format
}

function VerifiedBadge({ backup }: { backup: Backup }) {
  if (backup.status !== 'COMPLETED') return null
  if (backup.verified) {
    return (
      <span
        title={`SHA-256: ${backup.checksum ?? 'n/a'}\nVerified: ${backup.verifiedAt ? formatDate(backup.verifiedAt) : 'n/a'}`}
        className="inline-flex items-center gap-1 text-xs text-green-600 font-medium"
      >
        <ShieldCheck className="h-3.5 w-3.5" />Verified
      </span>
    )
  }
  if (backup.storageType === 'S3') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-400 font-medium">
        <ShieldOff className="h-3.5 w-3.5" />S3 stored
      </span>
    )
  }
  if (backup.storageType === 'GOOGLE_DRIVE') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-400 font-medium">
        <ShieldOff className="h-3.5 w-3.5" />Drive stored
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-yellow-600 font-medium">
      <ShieldAlert className="h-3.5 w-3.5" />Unverified
    </span>
  )
}

function BackupRow({
  b,
  onRestore,
  onDelete,
  onVerified,
  onDrill,
  drilling,
  onCancelDrill,
  freshness,
}: {
  b: Backup
  onRestore: () => void
  onDelete: () => void
  onVerified: () => void
  onDrill: () => void
  drilling: boolean
  onCancelDrill: () => void
  freshness: Freshness
}) {
  const isActive = b.status === 'RUNNING' || b.status === 'PENDING'
  const sse = useProgressSSE(`/backups/${b.id}/progress`, isActive)
  const live = liveProgress(b, sse)
  const [verifying, setVerifying] = useState(false)
  const [downloading, setDownloading] = useState(false)

  async function handleVerify() {
    setVerifying(true)
    try {
      const res = await backupsApi.verify(b.id)
      const { valid } = res.data.data
      onVerified()
      toast.success(valid ? 'Backup verified successfully' : 'Backup verification failed')
    } catch {
      toast.error('Failed to verify backup')
    } finally {
      setVerifying(false)
    }
  }

  function handleDownload() {
    if (downloading) return
    setDownloading(true)
    startBackupDownload(b)
    toast.success('Download started in browser')
    window.setTimeout(() => setDownloading(false), 4000)
  }

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-3">
        <p className="font-medium text-gray-900">{b.snapshotName || b.dbName}</p>
        {b.snapshotName && <p className="text-xs text-gray-400">{b.dbName}</p>}
        <p className="text-xs text-gray-400 mt-0.5">
          {formatLabel(b.format)}
          {b.strategy === 'SSH_SERVER' && <span title="mysqldump ran on the connection's SSH server"> · on SSH server</span>}
        </p>
      </td>
      <td className="px-6 py-3">
        <div className="flex items-center gap-2">
          <Badge className={dbTypeBadgeColor(b.dbType)}>{dbTypeLabel(b.dbType)}</Badge>
          <span className="text-gray-600">{b.connection?.name ?? <em className="text-gray-400">no connection</em>}</span>
        </div>
      </td>
      <td className="px-6 py-3 text-gray-600">
        {b.fileSize
          ? formatBytes(b.fileSize)
          : isActive && live.bytesWritten > 0
            ? <span className="whitespace-nowrap" title="Written so far">{formatBytes(live.bytesWritten)}…</span>
            : '\u2014'}
      </td>
      <td className="px-6 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge className={statusBadgeColor(b.status)}>{b.status}</Badge>
            {b.status === 'COMPLETED' && <VerifiedBadge backup={b} />}
            {b.status === 'COMPLETED' && b.lastDrill && (
              <span
                className={`inline-flex items-center gap-1 text-xs font-medium ${
                  b.lastDrill.status === 'PASSED' ? 'text-green-600'
                  : b.lastDrill.status === 'FAILED' ? 'text-red-600'
                  : 'text-gray-400'
                }`}
                title={b.lastDrill.error ?? `Restored into a scratch database — ${b.lastDrill.tablesRestored ?? '?'} tables, ${Number(b.lastDrill.rowsRestored ?? 0).toLocaleString()} rows`}
              >
                {b.lastDrill.status === 'PASSED' && <ShieldCheck className="h-3.5 w-3.5" />}
                {b.lastDrill.status === 'FAILED' && <ShieldAlert className="h-3.5 w-3.5" />}
                {b.lastDrill.status === 'RUNNING' && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                {b.lastDrill.status === 'PASSED'
                  ? `Drill passed (${b.lastDrill.tablesRestored ?? '?'} tables)`
                  : b.lastDrill.status === 'FAILED' ? 'Drill failed' : 'Drilling…'}
              </span>
            )}
          </div>
          {isActive && <BackupLiveProgress backup={b} live={live} freshness={freshness} />}
          {b.error && <p className="text-xs text-red-500 max-w-[200px] truncate" title={b.error}>{b.error}</p>}
        </div>
      </td>
      <td className="px-6 py-3 text-gray-500 text-xs">{formatDate(b.createdAt)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1 justify-end flex-wrap">
          {b.status === 'COMPLETED' && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDownload}
                title="Download backup file"
                loading={downloading}
                disabled={downloading}
              >
                {!downloading && <Download className="h-3.5 w-3.5" />}
              </Button>
              <Button size="sm" variant="ghost" onClick={onRestore} title="Restore backup">
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm" variant="ghost"
                onClick={() => {
                  if (b.lastDrill?.status === 'RUNNING') {
                    onCancelDrill()
                  } else {
                    onDrill()
                  }
                }}
                disabled={(!drilling && b.status !== 'COMPLETED') || (drilling && !b.lastDrill)}
                title={b.lastDrill?.status === 'RUNNING' ? 'Cancel stuck drill' : 'Restore drill — test-restore into a scratch database'}
              >
                <FlaskConical className={`h-3.5 w-3.5 ${b.lastDrill?.status === 'RUNNING' ? 'text-amber-500' : ''}`} />
              </Button>
              <Button
                size="sm" variant="ghost"
                onClick={handleVerify}
                loading={verifying}
                title={b.verified ? 'Re-verify backup integrity' : 'Verify backup integrity'}
                className={b.verified ? 'text-green-600 hover:bg-green-50' : 'text-yellow-600 hover:bg-yellow-50'}
              >
                {!verifying && (b.verified
                  ? <ShieldCheck className="h-3.5 w-3.5" />
                  : <ShieldAlert className="h-3.5 w-3.5" />
                )}
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" className="text-red-500 hover:bg-red-50" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  )
}

export default function BackupsPage() {
  const qc = useQueryClient()
  const [selectedConnection, setSelectedConnection] = useState('')
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'>('ALL')
  const [triggerModal, setTriggerModal] = useState(false)
  const [restoreModal, setRestoreModal] = useState(false)
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null)
  const [snapshotName, setSnapshotName] = useState('')
  const [notes, setNotes] = useState('')
  const [triggerConnId, setTriggerConnId] = useState('')
  const [backupFormat, setBackupFormat] = useState<BackupFormat>('COMPRESSED_SQL')
  const [restoreTargetConn, setRestoreTargetConn] = useState('')
  const [restoreJobId, setRestoreJobId] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [backupStrategy, setBackupStrategy] = useState<ToolStrategy>('TUNNEL')
  const [restoreStrategy, setRestoreStrategy] = useState<ToolStrategy>('TUNNEL')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [purgeOpen, setPurgeOpen] = useState(false)

  const { data: connsData } = useQuery({ queryKey: ['connections'], queryFn: () => connectionsApi.getAll() })
  const connections = connsData?.data.data ?? []

  const selectedConnObj = connections.find(c => c.id === triggerConnId)
  const formatOptions = selectedConnObj?.type === 'POSTGRESQL' ? PG_FORMATS : (selectedConnObj?.type === 'MONGODB' || selectedConnObj?.type === 'REDIS') ? NOSQL_FORMATS : MYSQL_FORMATS

  const { data, isLoading, refetch, isRefetchError, dataUpdatedAt } = useQuery({
    queryKey: ['backups', selectedConnection],
    queryFn: () => backupsApi.getAll({ connectionId: selectedConnection || undefined }),
    refetchInterval: (query) => {
      const backups = query.state.data?.data.data.backups ?? []
      const drilling = backups.some(b => b.lastDrill?.status === 'RUNNING')
      return (backups.some(b => b.status === 'RUNNING' || b.status === 'PENDING') || drilling) ? 5000 : false
    },
  })
  const allBackups = data?.data.data.backups ?? []
  const freshness: Freshness = {
    serverTime: data?.data.data.serverTime ?? null,
    offlineSince: isRefetchError ? dataUpdatedAt : null,
  }
  const total = data?.data.data.total ?? 0
  const backups = statusFilter === 'ALL' ? allBackups : allBackups.filter(b => b.status === statusFilter)
  const statusCounts = {
    ALL: allBackups.length,
    PENDING: allBackups.filter(b => b.status === 'PENDING').length,
    RUNNING: allBackups.filter(b => b.status === 'RUNNING').length,
    COMPLETED: allBackups.filter(b => b.status === 'COMPLETED').length,
    FAILED: allBackups.filter(b => b.status === 'FAILED').length,
  }
  const selectedBackupObj = allBackups.find(b => b.id === selectedBackup)

  // Restores: recent ones with live progress (polled while any runs, plus SSE per running restore)
  const { data: restoresData } = useQuery({
    queryKey: ['restores'],
    queryFn: () => restoreApi.list(10),
    refetchInterval: (query) => ((query.state.data?.data.data.restores ?? []).some(isActiveRestore) ? 5000 : false),
  })
  const restoreRows = restoresData?.data.data.restores
  const restoreServerTime = restoresData?.data.data.serverTime ?? null
  const [restoreLive, setRestoreLive] = useState<Record<string, ProgressEvent>>({})
  const restores = (restoreRows ?? []).map((r) => liveRestore(r, restoreLive[r.id]))
  const onRestoreEvent = (r: { id: string }, e: ProgressEvent) => {
    setRestoreLive((prev) => ({ ...prev, [r.id]: e }))
    if (e.status === 'COMPLETED' || e.status === 'FAILED') qc.invalidateQueries({ queryKey: ['restores'] })
  }
  // One toast when a restore seen running on this page finishes
  const seenActive = useRef(new Set<string>())
  useEffect(() => {
    for (const r of restoreRows ?? []) {
      if (isActiveRestore(r)) { seenActive.current.add(r.id); continue }
      if (!seenActive.current.delete(r.id)) continue
      if (r.status === 'COMPLETED') toast.success(`Restore into ${r.targetName} completed`)
      else toast.error(`Restore into ${r.targetName} failed${r.error ? `: ${r.error.slice(0, 160)}` : ''}`)
    }
  }, [restoreRows])

  // What the chosen restore would do, checked by the server before it can start
  const restoreCheck = useQuery({
    queryKey: ['restore-check', selectedBackup, restoreTargetConn],
    queryFn: () => restoreApi.check({ backupId: selectedBackup!, targetConnectionId: restoreTargetConn }),
    enabled: restoreModal && !!selectedBackup && !!restoreTargetConn && !restoreJobId,
    retry: false,
    staleTime: 0,
  })
  const check = restoreTargetConn ? restoreCheck.data?.data.data : undefined
  const sameFamily = (t: string) => (t === 'MARIADB' ? 'MYSQL' : t)
  const restoreTargets = connections.filter(
    (c) => !selectedBackupObj || sameFamily(c.type) === sameFamily(selectedBackupObj.dbType),
  )
  const confirmMatches = !!check && confirmText === check.target.database
  const canRestore = !!check && !check.incompatible && !check.busy && !check.target.writeProtected
    && (!check.overwritesSource || confirmMatches) && !restoreCheck.isFetching
  const queuedRestore = restoreJobId ? restores.find((r) => r.id === restoreJobId) : undefined
  const restoreTargetObj = connections.find((c) => c.id === restoreTargetConn)
  const openRestore = (b: Backup) => {
    setSelectedBackup(b.id)
    setRestoreTargetConn('') // no default: the backup's own database is the dangerous choice
    setConfirmText('')
    setRestoreJobId(null)
    setRestoreStrategy('TUNNEL')
    setRestoreModal(true)
  }
  const closeRestore = () => { setRestoreModal(false); setRestoreJobId(null); setConfirmText('') }

  const triggerMutation = useMutation({
    mutationFn: () => backupsApi.trigger({
      connectionId: triggerConnId,
      snapshotName: snapshotName || undefined,
      notes: notes || undefined,
      format: backupFormat,
      strategy: sshServerStrategyAvailable(selectedConnObj) ? backupStrategy : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backups'] })
      toast.success('Backup queued successfully')
      setTriggerModal(false)
    },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Failed to trigger backup')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => backupsApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['backups'] }); toast.success('Backup deleted') },
    onError: () => toast.error('Failed to delete backup'),
  })

  // Cancel a stuck drill (e.g. after a server crash)
  const cancelDrillMutation = useMutation({
    mutationFn: ({ backupId, drillId }: { backupId: string; drillId: string }) =>
      backupsApi.cancelDrill(backupId, drillId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backups'] })
      toast.success('Drill cancelled')
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to cancel'),
  })

  // Restore drill — proves the backup actually restores
  const drillMutation = useMutation({
    mutationFn: (id: string) => backupsApi.drill(id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['backups'] })
      toast.success(res.data.message ?? 'Drill started')
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to start drill'),
  })

  // On-demand retention purge — same policy as the daily sweep
  const purgeMutation = useMutation({
    mutationFn: () => backupsApi.runRetention(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['backups'] })
      const { deleted, freedBytes } = res.data.data
      if (deleted === 0) toast.success('Nothing to purge — all backups are within policy')
      else toast.success(`Purged ${deleted} backup(s), freed ${formatBytes(freedBytes)}`)
      setPurgeOpen(false)
    },
    onError: () => toast.error('Failed to run retention'),
  })

  const restoreMutation = useMutation({
    mutationFn: () => restoreApi.restore({
      backupId: selectedBackup!,
      targetConnectionId: restoreTargetConn,
      confirmOverwrite: check?.overwritesSource ? confirmText : undefined,
      strategy: sshServerStrategyAvailable(restoreTargetObj) ? restoreStrategy : undefined,
    }),
    onSuccess: (res) => {
      setRestoreJobId(res.data.data.jobId)
      qc.invalidateQueries({ queryKey: ['restores'] })
    },
    onError: (e: unknown) => {
      toast.error(getApiErrorMessage(e, 'Failed to queue restore'))
      qc.invalidateQueries({ queryKey: ['restore-check'] })
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Backups</h1>
          <p className="text-gray-500 mt-1">{total} total backup{total !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}><RefreshCw className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => setPurgeOpen(true)} title="Delete backups that exceed the retention policy">
            <Trash2 className="h-4 w-4" />Purge Old
          </Button>
          <Button onClick={() => {
            const first = connections[0]
            setTriggerConnId(first?.id ?? '')
            setBackupFormat(first?.type === 'POSTGRESQL' ? 'CUSTOM' : 'COMPRESSED_SQL')
            setBackupStrategy('TUNNEL')
            setTriggerModal(true)
          }}>
            <Plus className="h-4 w-4" />New Backup
          </Button>
        </div>
      </div>

      {/* Running restores with live progress, and the latest finished ones */}
      {restores.filter(isActiveRestore).map((r) => <RestoreEvents key={r.id} restore={r} onEvent={onRestoreEvent} />)}
      <RestoresPanel restores={restores} serverTime={restoreServerTime} />

      {connections.length > 0 && (
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400" />
          <select
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={selectedConnection}
            onChange={(e) => setSelectedConnection(e.target.value)}
          >
            <option value="">All connections</option>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}

      {/* Status filter chips */}
      <div className="flex gap-2 flex-wrap">
        {(['ALL', 'PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              statusFilter === s
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300 hover:text-gray-800'
            }`}
          >
            {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
            <span className={`ml-1.5 tabular-nums ${statusFilter === s ? 'text-gray-300' : 'text-gray-400'}`}>
              {statusCounts[s]}
            </span>
          </button>
        ))}
      </div>

      {isLoading && <TableSkeleton rows={5} cols={5} />}

      {!isLoading && backups.length === 0 && (
        <Card>
          <CardContent className="text-center py-16">
            <HardDrive className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 font-medium">No backups yet</p>
            <p className="text-gray-400 text-sm mt-1">Trigger a manual backup or set up a schedule</p>
          </CardContent>
        </Card>
      )}

      {backups.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Backup History</CardTitle></CardHeader>
          <div className="overflow-x-auto scroll-shadow-x">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white shadow-[0_1px_0_0_#e5e7eb] z-10">
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Backup</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Connection</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Size</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {backups.map((b) => (
                  <BackupRow
                    key={b.id}
                    b={b}
                    onRestore={() => openRestore(b)}
                    onDelete={() => setDeleteTarget(b.id)}
                    onVerified={() => qc.invalidateQueries({ queryKey: ['backups'] })}
                    onDrill={() => drillMutation.mutate(b.id)}
                    drilling={b.lastDrill?.status === 'RUNNING' || drillMutation.isPending}
                    onCancelDrill={() => b.lastDrill && cancelDrillMutation.mutate({ backupId: b.id, drillId: b.lastDrill.id })}
                    freshness={freshness}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={triggerModal} onClose={() => setTriggerModal(false)} title="New Backup">
        <div className="space-y-4">
          <Select
            label="Connection"
            options={connections.map((c) => ({ label: `${c.name} (${dbTypeLabel(c.type)})`, value: c.id }))}
            value={triggerConnId}
            onChange={(e) => {
              setTriggerConnId(e.target.value)
              const conn = connections.find(c => c.id === e.target.value)
              setBackupFormat(conn?.type === 'POSTGRESQL' ? 'CUSTOM' : 'COMPRESSED_SQL')
              setBackupStrategy('TUNNEL')
            }}
          />
          <div>
            <label className="text-sm font-medium text-gray-700">Backup Format</label>
            <select
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={backupFormat}
              onChange={(e) => setBackupFormat(e.target.value as BackupFormat)}
            >
              {formatOptions.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <ToolStrategyPicker value={backupStrategy} onChange={setBackupStrategy} connection={selectedConnObj} action="backup" />
          <Input label="Snapshot name (optional)" placeholder="e.g. before-migration" value={snapshotName} onChange={(e) => setSnapshotName(e.target.value)} />
          <div>
            <label className="text-sm font-medium text-gray-700">Notes (optional)</label>
            <textarea rows={2} className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Any notes about this backup..." value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setTriggerModal(false)}>Cancel</Button>
            <Button onClick={() => triggerMutation.mutate()} loading={triggerMutation.isPending} disabled={!triggerConnId}>
              <HardDrive className="h-4 w-4" />Start Backup
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={restoreModal} onClose={closeRestore} title="Restore Backup">
        <div className="space-y-4">
          {restoreJobId ? (
            <div className="space-y-3">
              {queuedRestore ? (
                <div className="border border-gray-200 rounded-lg px-3">
                  <RestoreItem restore={queuedRestore} serverTime={restoreServerTime} />
                </div>
              ) : (
                <p className="flex items-center gap-2 text-sm text-gray-600">
                  <Loader2 className="h-4 w-4 animate-spin" />Restore queued…
                </p>
              )}
              <p className="flex items-start gap-1.5 text-xs text-gray-500">
                <Info className="h-3.5 w-3.5 mt-px shrink-0" />
                You can close this window. The restore keeps running on the server, and its progress stays on this page under Restores.
              </p>
              <div className="flex justify-end">
                <Button variant="outline" onClick={closeRestore}>Close</Button>
              </div>
            </div>
          ) : (
            <>
              {selectedBackupObj && (
                <div className="text-sm">
                  <p className="text-xs font-medium text-gray-500 mb-0.5">Backup</p>
                  <p className="text-gray-900">
                    <span className="font-medium">{selectedBackupObj.snapshotName || selectedBackupObj.dbName}</span>
                    <span className="text-gray-500">
                      {' · '}{formatDate(selectedBackupObj.createdAt)}{' · '}{formatBytes(selectedBackupObj.fileSize)}
                      {selectedBackupObj.connection?.name && <> · from {selectedBackupObj.connection.name}</>}
                    </span>
                  </p>
                </div>
              )}
              <Select
                label="Restore into"
                options={[
                  { label: 'Choose a database…', value: '' },
                  ...restoreTargets.map((c) => ({
                    label: `${c.name} (${dbTypeLabel(c.type)})${c.id === selectedBackupObj?.connectionId ? ' — where this backup came from' : ''}${c.writeProtected ? ' — write-protected' : ''}`,
                    value: c.id,
                  })),
                ]}
                value={restoreTargetConn}
                onChange={(e) => { setRestoreTargetConn(e.target.value); setConfirmText(''); setRestoreStrategy('TUNNEL') }}
              />
              {check && !check.incompatible && (
                <ToolStrategyPicker value={restoreStrategy} onChange={setRestoreStrategy} connection={restoreTargetObj} action="restore" />
              )}

              {restoreTargetConn && restoreCheck.isFetching && !check && (
                <p className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Checking the target…</p>
              )}
              {restoreTargetConn && restoreCheck.isError && (
                <p className="text-sm text-red-600">{getApiErrorMessage(restoreCheck.error, 'Could not check this target')}</p>
              )}

              {check?.incompatible && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{check.incompatible}</div>
              )}
              {check && !check.incompatible && check.target.writeProtected && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
                  <b>{check.target.name}</b> is write-protected, so nothing can be restored into it. Choose another
                  database, or turn write protection off in the connection's settings if you really mean to.
                </div>
              )}
              {check && !check.incompatible && !check.target.writeProtected && check.busy && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                  A restore into {check.target.name} (database {check.target.database}) is already {check.busy.status === 'RUNNING' ? 'running' : 'queued'}.
                  Wait for it to finish before starting another one.
                </div>
              )}

              {check && !check.incompatible && !check.target.writeProtected && check.overwritesSource && (
                <div className="bg-red-50 border-2 border-red-300 rounded-lg p-3 space-y-2 text-sm text-red-800">
                  <p className="flex items-center gap-1.5 font-semibold text-red-700">
                    <AlertTriangle className="h-4 w-4 shrink-0" />This is the live database the backup came from
                  </p>
                  <p>
                    {check.overwritesSourceReason === 'same-address'
                      ? <>“{check.target.name}” points to the same database as “{check.backup.sourceName}”, where this backup was taken.</>
                      : <>“{check.target.name}” is the connection this backup was taken from.</>}
                    {' '}Restoring replaces the current data in <b>{check.target.database}</b> with the data from{' '}
                    <b>{formatDate(check.backup.createdAt)}</b>. Everything written since then is lost.
                  </p>
                  <p>If you want a copy to look at or test with, choose a different database instead.</p>
                  <Input
                    label={`Type ${check.target.database} to confirm`}
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              )}

              {check && !check.incompatible && !check.target.writeProtected && !check.overwritesSource && !check.busy && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                  Restores into <b>{check.target.name}</b>, database <b>{check.target.database}</b>. Tables in this backup replace the
                  tables with the same names there; other tables are left as they are.
                </div>
              )}

              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={closeRestore}>Cancel</Button>
                <Button
                  variant="danger"
                  onClick={() => restoreMutation.mutate()}
                  loading={restoreMutation.isPending}
                  disabled={!canRestore}
                >
                  <RotateCcw className="h-4 w-4" />{check?.overwritesSource ? 'Overwrite live database' : 'Restore'}
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget); setDeleteTarget(null) } }}
        title="Delete Backup"
        description="This will permanently delete this backup file and cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        loading={deleteMutation.isPending}
      />

      <ConfirmDialog
        open={purgeOpen}
        onClose={() => setPurgeOpen(false)}
        onConfirm={() => purgeMutation.mutate()}
        title="Purge Old Backups"
        description="Deletes backups that exceed each connection's retention policy (from its schedule, or server defaults). This cannot be undone."
        confirmLabel="Purge"
        variant="danger"
        loading={purgeMutation.isPending}
      />
    </div>
  )
}
