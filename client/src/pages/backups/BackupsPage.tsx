import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Download, RotateCcw, HardDrive, RefreshCw, Filter, ShieldCheck, ShieldAlert, ShieldOff } from 'lucide-react'
import { backupsApi, restoreApi, type BackupFormat, type Backup } from '../../services/backups.service'
import { connectionsApi } from '../../services/connections.service'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { Select } from '../../components/ui/Select'
import { Input } from '../../components/ui/Input'
import { formatBytes, formatDate, statusBadgeColor, dbTypeBadgeColor, dbTypeLabel } from '../../lib/utils'
import { useProgressSSE } from '../../hooks/useProgressSSE'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { TableSkeleton } from '../../components/ui/Skeleton'
import api from '../../lib/api'

async function downloadBackup(backup: Backup) {
  try {
    const res = await api.get(`/backups/${backup.id}/download`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = backup.fileName
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    toast.error('Failed to download backup')
  }
}

const MYSQL_FORMATS: { label: string; value: BackupFormat }[] = [
  { label: 'Compressed SQL (.sql.gz)', value: 'COMPRESSED_SQL' },
  { label: 'Plain SQL (.sql)', value: 'PLAIN_SQL' },
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
}: {
  b: Backup
  onRestore: () => void
  onDelete: () => void
  onVerified: () => void
}) {
  const isActive = b.status === 'RUNNING' || b.status === 'PENDING'
  const sse = useProgressSSE(`/backups/${b.id}/progress`, isActive)
  const progress = sse?.progress ?? b.progress
  const [verifying, setVerifying] = useState(false)

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

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-3">
        <p className="font-medium text-gray-900">{b.snapshotName || b.dbName}</p>
        {b.snapshotName && <p className="text-xs text-gray-400">{b.dbName}</p>}
        <p className="text-xs text-gray-400 mt-0.5">{formatLabel(b.format)}</p>
      </td>
      <td className="px-6 py-3">
        <div className="flex items-center gap-2">
          <Badge className={dbTypeBadgeColor(b.dbType)}>{dbTypeLabel(b.dbType)}</Badge>
          <span className="text-gray-600">{b.connection?.name}</span>
        </div>
      </td>
      <td className="px-6 py-3 text-gray-600">{b.fileSize ? formatBytes(b.fileSize) : '\u2014'}</td>
      <td className="px-6 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge className={statusBadgeColor(b.status)}>{b.status}</Badge>
            {b.status === 'COMPLETED' && <VerifiedBadge backup={b} />}
          </div>
          {isActive && (
            <div className="w-32">
              <div className="flex justify-between text-xs text-gray-400 mb-0.5">
                <span>Progress</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}
          {b.error && <p className="text-xs text-red-500 max-w-[200px] truncate" title={b.error}>{b.error}</p>}
        </div>
      </td>
      <td className="px-6 py-3 text-gray-500 text-xs">{formatDate(b.createdAt)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1 justify-end flex-wrap">
          {b.status === 'COMPLETED' && (
            <>
              <Button size="sm" variant="ghost" onClick={() => downloadBackup(b)} title="Download backup file">
                <Download className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={onRestore} title="Restore backup">
                <RotateCcw className="h-3.5 w-3.5" />
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
  const [triggerModal, setTriggerModal] = useState(false)
  const [restoreModal, setRestoreModal] = useState(false)
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null)
  const [snapshotName, setSnapshotName] = useState('')
  const [notes, setNotes] = useState('')
  const [triggerConnId, setTriggerConnId] = useState('')
  const [backupFormat, setBackupFormat] = useState<BackupFormat>('COMPRESSED_SQL')
  const [restoreTargetConn, setRestoreTargetConn] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const { data: connsData } = useQuery({ queryKey: ['connections'], queryFn: () => connectionsApi.getAll() })
  const connections = connsData?.data.data ?? []

  const selectedConnObj = connections.find(c => c.id === triggerConnId)
  const formatOptions = selectedConnObj?.type === 'POSTGRESQL' ? PG_FORMATS : MYSQL_FORMATS

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['backups', selectedConnection],
    queryFn: () => backupsApi.getAll({ connectionId: selectedConnection || undefined }),
    refetchInterval: (query) => {
      const backups = query.state.data?.data.data.backups ?? []
      return backups.some(b => b.status === 'RUNNING' || b.status === 'PENDING') ? 5000 : false
    },
  })
  const backups = data?.data.data.backups ?? []
  const total = data?.data.data.total ?? 0

  const triggerMutation = useMutation({
    mutationFn: () => backupsApi.trigger({
      connectionId: triggerConnId,
      snapshotName: snapshotName || undefined,
      notes: notes || undefined,
      format: backupFormat,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backups'] })
      toast.success('Backup queued successfully')
      setTriggerModal(false)
    },
    onError: () => toast.error('Failed to trigger backup'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => backupsApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['backups'] }); toast.success('Backup deleted') },
    onError: () => toast.error('Failed to delete backup'),
  })

  const restoreMutation = useMutation({
    mutationFn: () => restoreApi.restore({ backupId: selectedBackup!, targetConnectionId: restoreTargetConn || undefined }),
    onSuccess: () => { toast.success('Restore completed successfully'); setRestoreModal(false) },
    onError: () => toast.error('Restore failed'),
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
          <Button onClick={() => {
            const first = connections[0]
            setTriggerConnId(first?.id ?? '')
            setBackupFormat(first?.type === 'POSTGRESQL' ? 'CUSTOM' : 'COMPRESSED_SQL')
            setTriggerModal(true)
          }}>
            <Plus className="h-4 w-4" />New Backup
          </Button>
        </div>
      </div>

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
              <thead>
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
                    onRestore={() => { setSelectedBackup(b.id); setRestoreTargetConn(b.connectionId); setRestoreModal(true) }}
                    onDelete={() => setDeleteTarget(b.id)}
                    onVerified={() => qc.invalidateQueries({ queryKey: ['backups'] })}
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

      <Modal open={restoreModal} onClose={() => setRestoreModal(false)} title="Restore Backup">
        <div className="space-y-4">
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
            \u26a0\ufe0f This will overwrite the target database. Make sure you have a backup before proceeding.
          </div>
          <Select
            label="Restore to connection"
            options={connections.map((c) => ({ label: `${c.name} (${dbTypeLabel(c.type)})`, value: c.id }))}
            value={restoreTargetConn}
            onChange={(e) => setRestoreTargetConn(e.target.value)}
          />
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setRestoreModal(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => restoreMutation.mutate()} loading={restoreMutation.isPending}>
              <RotateCcw className="h-4 w-4" />Restore
            </Button>
          </div>
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
    </div>
  )
}
