import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Plus, Trash2, RefreshCw, MoveRight, CheckCircle2, XCircle, Clock, Loader2, Info } from 'lucide-react'
import { migrationsApi, type Migration, type MigrationVerificationResult } from '../../services/migrations.service'
import { connectionsApi } from '../../services/connections.service'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { formatDate, dbTypeLabel, dbTypeBadgeColor } from '../../lib/utils'
import { cn } from '../../lib/utils'
import { useProgressSSE } from '../../hooks/useProgressSSE'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { TableSkeleton } from '../../components/ui/Skeleton'

function statusIcon(status: Migration['status']) {
  if (status === 'COMPLETED') return <CheckCircle2 className="h-4 w-4 text-green-500" />
  if (status === 'FAILED') return <XCircle className="h-4 w-4 text-red-500" />
  if (status === 'RUNNING') return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
  return <Clock className="h-4 w-4 text-gray-400" />
}

function statusBadge(status: Migration['status']) {
  const map: Record<Migration['status'], string> = {
    COMPLETED: 'bg-green-100 text-green-700',
    FAILED: 'bg-red-100 text-red-700',
    RUNNING: 'bg-blue-100 text-blue-700',
    PENDING: 'bg-gray-100 text-gray-600',
  }
  return map[status]
}

function durationLabel(m: Migration) {
  if (!m.startedAt) return '—'
  const end = m.completedAt ? new Date(m.completedAt) : new Date()
  const ms = end.getTime() - new Date(m.startedAt).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const min = Math.floor(s / 60)
  return `${min}m ${s % 60}s`
}

function rowsLabel(rowsMigrated?: number) {
  if (rowsMigrated === -1) return 'N/A (stream mode)'
  return ((rowsMigrated ?? 0)).toLocaleString()
}

function ActiveMigrationCard({ m }: { m: Migration }) {
  const isActive = m.status === 'RUNNING' || m.status === 'PENDING'
  const sse = useProgressSSE(`/migrations/${m.id}/progress`, isActive)

  const progress = sse?.progress ?? m.progress
  const currentTable = sse?.currentTable ?? m.currentTable
  const tablesCompleted = sse?.tablesCompleted ?? m.tablesCompleted
  const tableCount = sse?.tableCount ?? m.tableCount
  const rowsMigrated = sse?.rowsMigrated ?? m.rowsMigrated
  const isStreamMode = rowsMigrated === -1 || /dump pipe|pgloader/i.test(currentTable ?? '')

  return (
    <Card className="border-blue-200 bg-blue-50/40">
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start gap-4">
          <div className="mt-0.5">{statusIcon(m.status)}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-gray-900">{m.sourceConnection?.name}</span>
              <MoveRight className="h-4 w-4 text-gray-400 shrink-0" />
              <span className="font-medium text-gray-900">{m.targetConnection?.name}</span>
              <Badge className={statusBadge(m.status)}>{m.status}</Badge>
            </div>

            {currentTable && (
              <p className="text-xs text-gray-500 mt-1">
                Currently migrating: <span className="font-mono text-blue-600">{currentTable}</span>
              </p>
            )}

            <div className="mt-3 space-y-1">
              <div className="flex justify-between text-xs text-gray-500">
                <span>{tablesCompleted} / {tableCount} tables</span>
                <span className="inline-flex items-center gap-1">
                  {isStreamMode ? 'Streaming' : `${progress}%`}
                  {isStreamMode && (
                    <span
                      className="inline-flex items-center text-gray-400"
                      title="This migration runs in stream mode (CLI pipe), so exact row-by-row progress is not available."
                    >
                      <Info className="h-3.5 w-3.5" />
                    </span>
                  )}
                </span>
              </div>
              <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-700',
                    isStreamMode ? 'bg-blue-400 animate-pulse w-full' : 'bg-blue-500'
                  )}
                  style={isStreamMode ? undefined : { width: `${progress}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-400">
                <span>{rowsLabel(rowsMigrated)} rows migrated</span>
                <span>Running for {durationLabel(m)}</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function MigrationsPage() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [sourceId, setSourceId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [batchSize, setBatchSize] = useState(500)
  const [notes, setNotes] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [verification, setVerification] = useState<MigrationVerificationResult | null>(null)
  const [verificationOpen, setVerificationOpen] = useState(false)

  const { data: connsData } = useQuery({ queryKey: ['connections'], queryFn: () => connectionsApi.getAll() })
  const connections = connsData?.data.data ?? []

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['migrations'],
    queryFn: () => migrationsApi.getAll(),
    refetchInterval: (query) => {
      const items = query.state.data?.data.data.migrations ?? []
      return items.some(m => m.status === 'RUNNING' || m.status === 'PENDING') ? 3000 : false
    },
  })
  const migrations = data?.data.data.migrations ?? []

  const createMutation = useMutation({
    mutationFn: () => {
      const payload = {
        sourceConnectionId: sourceId,
        targetConnectionId: targetId,
        notes: notes || undefined,
        ...(usesRowBatching ? { batchSize: batchSize || 500 } : {}),
      }

      return migrationsApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['migrations'] })
      toast.success('Migration started')
      setModalOpen(false)
      setSourceId('')
      setTargetId('')
      setNotes('')
      setBatchSize(500)
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error(err?.response?.data?.message ?? 'Failed to start migration'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => migrationsApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['migrations'] }); toast.success('Migration removed') },
    onError: () => toast.error('Failed to delete migration'),
  })

  const verifyMutation = useMutation({
    mutationFn: (id: string) => migrationsApi.verify(id),
    onSuccess: (res) => {
      setVerification(res.data.data)
      setVerificationOpen(true)
      if (res.data.data.ok) toast.success('Verification passed')
      else toast.error('Verification found mismatches')
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error(err?.response?.data?.message ?? 'Verification failed'),
  })

  const targetOptions = connections.filter(c => c.id !== sourceId)
  const selectedSource = connections.find(c => c.id === sourceId)
  const selectedTarget = connections.find(c => c.id === targetId)
  const usesRowBatching = selectedSource?.type === 'POSTGRESQL' && (selectedTarget?.type === 'MYSQL' || selectedTarget?.type === 'MARIADB')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ArrowLeftRight className="h-6 w-6 text-blue-600" />
            Migrations
          </h1>
          <p className="text-gray-500 mt-1">Copy data between databases, across engines</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setModalOpen(true)} disabled={connections.length < 2}>
            <Plus className="h-4 w-4" />New Migration
          </Button>
        </div>
      </div>

      {connections.length < 2 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
          ⚠️ You need at least 2 connections to run a migration. Add more connections first.
        </div>
      )}

      {isLoading && <TableSkeleton rows={4} cols={6} />}

      {!isLoading && migrations.length === 0 && (
        <Card>
          <CardContent className="text-center py-16">
            <ArrowLeftRight className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 font-medium">No migrations yet</p>
            <p className="text-gray-400 text-sm mt-1">Start a migration to copy data between databases</p>
          </CardContent>
        </Card>
      )}

      {/* Active / Running migrations */}
      {migrations.filter(m => m.status === 'RUNNING' || m.status === 'PENDING').map(m => (
        <ActiveMigrationCard key={m.id} m={m} />
      ))}

      {/* History */}
      {migrations.filter(m => m.status === 'COMPLETED' || m.status === 'FAILED').length > 0 && (
        <Card>
          <CardHeader><CardTitle>Migration History</CardTitle></CardHeader>
          <div className="overflow-x-auto scroll-shadow-x">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Route</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Tables</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Rows</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {migrations
                  .filter(m => m.status === 'COMPLETED' || m.status === 'FAILED')
                  .map(m => (
                    <tr key={m.id} className="hover:bg-gray-50">
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="flex items-center gap-1">
                            <Badge className={dbTypeBadgeColor(m.sourceConnection?.type ?? '')}>{dbTypeLabel(m.sourceConnection?.type ?? '')}</Badge>
                            <span className="text-gray-700 font-medium">{m.sourceConnection?.name}</span>
                          </div>
                          <MoveRight className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                          <div className="flex items-center gap-1">
                            <Badge className={dbTypeBadgeColor(m.targetConnection?.type ?? '')}>{dbTypeLabel(m.targetConnection?.type ?? '')}</Badge>
                            <span className="text-gray-700 font-medium">{m.targetConnection?.name}</span>
                          </div>
                        </div>
                        {m.notes && <p className="text-xs text-gray-400 mt-0.5">{m.notes}</p>}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-1.5">
                          {statusIcon(m.status)}
                          <Badge className={statusBadge(m.status)}>{m.status}</Badge>
                        </div>
                        {m.error && <p className="text-xs text-red-500 mt-0.5 max-w-[220px] truncate" title={m.error}>{m.error}</p>}
                      </td>
                      <td className="px-6 py-3 text-gray-600">{m.tablesCompleted} / {m.tableCount}</td>
                      <td
                        className="px-6 py-3 text-gray-600"
                        title={m.rowsMigrated === -1 ? 'Stream mode does not provide exact migrated row count.' : undefined}
                      >
                        {rowsLabel(m.rowsMigrated)}
                      </td>
                      <td className="px-6 py-3 text-gray-500 text-xs">{durationLabel(m)}</td>
                      <td className="px-6 py-3 text-gray-500 text-xs">{formatDate(m.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          {m.status === 'COMPLETED' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-blue-600 hover:bg-blue-50"
                              onClick={() => verifyMutation.mutate(m.id)}
                              loading={verifyMutation.isPending}
                            >
                              Verify
                            </Button>
                          )}
                          <Button
                            size="sm" variant="ghost"
                            className="text-red-500 hover:bg-red-50"
                            onClick={() => setDeleteTarget(m.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* New Migration Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Migration">
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
            ℹ️ Migration will copy all tables and data from the source to the target database.
            Existing tables on the target will be replaced.
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Source Connection</label>
            <select
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={sourceId}
              onChange={e => { setSourceId(e.target.value); setTargetId('') }}
            >
              <option value="">Select source…</option>
              {connections.map(c => (
                <option key={c.id} value={c.id}>{c.name} ({dbTypeLabel(c.type)})</option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-center text-gray-400">
            <MoveRight className="h-5 w-5" />
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Target Connection</label>
            <select
              className={cn(
                'mt-1 w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500',
                !sourceId ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed' : 'border-gray-300'
              )}
              value={targetId}
              onChange={e => setTargetId(e.target.value)}
              disabled={!sourceId}
            >
              <option value="">Select target…</option>
              {targetOptions.map(c => (
                <option key={c.id} value={c.id}>{c.name} ({dbTypeLabel(c.type)})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Batch Size</label>
            <input
              type="number"
              className={cn(
                'mt-1 w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500',
                usesRowBatching ? 'border-gray-300' : 'border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed'
              )}
              value={batchSize}
              min={100}
              max={10000}
              step={100}
              onChange={e => setBatchSize(Number(e.target.value))}
              disabled={!usesRowBatching}
            />
            <p className="text-xs text-gray-400 mt-1">
              {usesRowBatching
                ? 'Rows per INSERT batch (row-copy mode). Lower = safer for large tables, higher = faster.'
                : 'Ignored for this route. This migration uses stream mode (dump/restore or pgloader).'}
            </p>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Notes (optional)</label>
            <textarea
              rows={2}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. Migrating production to staging…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate()}
              loading={createMutation.isPending}
              disabled={!sourceId || !targetId}
            >
              <ArrowLeftRight className="h-4 w-4" />Start Migration
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget); setDeleteTarget(null) } }}
        title="Delete Migration"
        description="This will permanently remove this migration record."
        confirmLabel="Delete"
        variant="danger"
        loading={deleteMutation.isPending}
      />

      <Modal
        open={verificationOpen}
        onClose={() => setVerificationOpen(false)}
        title="Migration Verification"
        className="max-w-4xl"
      >
        {!verification ? null : (
          <div className="space-y-4">
            <div className={cn(
              'rounded-lg border px-3 py-2 text-sm',
              verification.ok
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-amber-50 border-amber-200 text-amber-800'
            )}>
              {verification.ok
                ? 'Verification passed: rows, schema, index signatures, and deep data checks matched.'
                : 'Verification found mismatches. Review details below.'}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 text-sm">
              <div className="bg-gray-50 rounded p-2">
                <p className="text-gray-500 text-xs">Tables Checked</p>
                <p className="font-semibold text-gray-800">{verification.tableCountChecked}</p>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <p className="text-gray-500 text-xs">Row Mismatches</p>
                <p className="font-semibold text-gray-800">{verification.rowMismatchCount}</p>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <p className="text-gray-500 text-xs">Missing Tables</p>
                <p className="font-semibold text-gray-800">{verification.missingTableCount}</p>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <p className="text-gray-500 text-xs">Missing Index Signatures</p>
                <p className="font-semibold text-gray-800">{verification.missingIndexCount}</p>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <p className="text-gray-500 text-xs">Index Def Mismatches</p>
                <p className="font-semibold text-gray-800">{verification.indexDefinitionMismatchCount}</p>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <p className="text-gray-500 text-xs">Column Profile Mismatches</p>
                <p className="font-semibold text-gray-800">{verification.columnProfileMismatchCount}</p>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <p className="text-gray-500 text-xs">Row Sample Hash Mismatches</p>
                <p className="font-semibold text-gray-800">{verification.rowSampleHashMismatchCount}</p>
              </div>
            </div>

            {verification.deepChecksApplied && (
              <p className="text-xs text-gray-500">
                Deep checks enabled for MySQL-like routes: full index definition parity, per-column null/length profiles, and deterministic sampled row hashes.
              </p>
            )}

            {verification.schemaErrors.length > 0 && (
              <div>
                <p className="text-sm font-medium text-red-700 mb-1">Schema Errors</p>
                <ul className="text-xs text-red-600 space-y-1 max-h-28 overflow-y-auto pr-1">
                  {verification.schemaErrors.map((err) => (
                    <li key={err}>• {err}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2">Table</th>
                      <th className="text-left px-3 py-2">Rows (src -&gt; dst)</th>
                      <th className="text-left px-3 py-2">Missing Idx</th>
                      <th className="text-left px-3 py-2">Extra Idx</th>
                      <th className="text-left px-3 py-2">Idx Def</th>
                      <th className="text-left px-3 py-2">Col Profile</th>
                      <th className="text-left px-3 py-2">Row Hash</th>
                      <th className="text-left px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {verification.tableResults.map((t) => {
                      const issue = t.missingInTarget
                        || !t.rowsMatch
                        || t.missingIndexes.length > 0
                        || t.indexDefinitionMismatches.length > 0
                        || t.columnProfileMismatches.length > 0
                        || t.rowSampleHashMatch === false
                      return (
                        <tr key={t.tableName}>
                          <td className="px-3 py-2 font-mono text-gray-700">{t.tableName}</td>
                          <td className="px-3 py-2 text-gray-600">{t.sourceRows.toLocaleString()} -&gt; {t.targetRows.toLocaleString()}</td>
                          <td className="px-3 py-2 text-gray-600">{t.missingIndexes.length}</td>
                          <td className="px-3 py-2 text-gray-600">{t.extraIndexes.length}</td>
                          <td className="px-3 py-2 text-gray-600">{t.indexDefinitionMismatches.length}</td>
                          <td className="px-3 py-2 text-gray-600">{t.columnProfileMismatches.length}</td>
                          <td className="px-3 py-2 text-gray-600">
                            {t.rowSampleHashMatch === null
                              ? 'Skipped'
                              : t.rowSampleHashMatch
                                ? `OK (${t.rowSampledCount})`
                                : `Mismatch (${t.rowSampledCount})`}
                          </td>
                          <td className="px-3 py-2">
                            <Badge className={issue ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}>
                              {issue ? 'Needs Review' : 'OK'}
                            </Badge>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
