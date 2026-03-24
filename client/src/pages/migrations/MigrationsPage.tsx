import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Plus, RefreshCw, MoveRight } from 'lucide-react'
import { migrationsApi, type Migration, type MigrationVerificationResult } from '../../services/migrations.service'
import { connectionsApi } from '../../services/connections.service'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Modal } from '../../components/ui/Modal'
import { Badge } from '../../components/ui/Badge'
import { dbTypeLabel } from '../../lib/utils'
import { cn } from '../../lib/utils'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { TableSkeleton } from '../../components/ui/Skeleton'
import {
  ActiveMigrationCard,
  MigrationHistoryTable,
  statusIcon,
  statusBadge,
} from './components'

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
  const [tableVerifyOpen, setTableVerifyOpen] = useState(false)
  const [tableVerifyTarget, setTableVerifyTarget] = useState<Migration | null>(null)
  const [selectedVerifyTable, setSelectedVerifyTable] = useState('')

  const { data: connsData } = useQuery({ queryKey: ['connections'], queryFn: () => connectionsApi.getAll() })
  const connections = connsData?.data.data ?? []

  const { data: tableVerifyInfo, isLoading: isLoadingVerifyTables } = useQuery({
    queryKey: ['verify-table-options', tableVerifyTarget?.id, tableVerifyTarget?.sourceConnectionId],
    queryFn: () => connectionsApi.getInfo(tableVerifyTarget!.sourceConnectionId),
    enabled: tableVerifyOpen && !!tableVerifyTarget?.sourceConnectionId,
    staleTime: 60_000,
  })

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
    mutationFn: ({ id, tables }: { id: string; tables?: string[] }) => migrationsApi.verify(id, tables),
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
  const verifyTables = tableVerifyInfo?.data.data.tables.map((t) => t.name) ?? []
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
            <MigrationHistoryTable
              migrations={migrations.filter(m => m.status === 'COMPLETED' || m.status === 'FAILED')}
              onVerify={(id) => verifyMutation.mutate({ id })}
              onTableVerify={(m) => {
                setTableVerifyTarget(m)
                setSelectedVerifyTable('')
                setTableVerifyOpen(true)
              }}
              onDelete={(id) => setDeleteTarget(id)}
              verifyLoading={verifyMutation.isPending}
            />
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

      <Modal
        open={tableVerifyOpen}
        onClose={() => {
          setTableVerifyOpen(false)
          setTableVerifyTarget(null)
          setSelectedVerifyTable('')
        }}
        title="Verify Specific Table"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Run verification for one table only. This is faster and helps avoid timeout on large databases.
          </p>

          <div>
            <label className="text-sm font-medium text-gray-700">Table</label>
            <select
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={selectedVerifyTable}
              onChange={e => setSelectedVerifyTable(e.target.value)}
              disabled={isLoadingVerifyTables || verifyMutation.isPending}
            >
              <option value="">Select table…</option>
              {verifyTables.map((tableName) => (
                <option key={tableName} value={tableName}>{tableName}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-1">
              {isLoadingVerifyTables
                ? 'Loading table list...'
                : verifyTables.length > 0
                  ? `${verifyTables.length} tables available`
                  : 'No tables found for this source connection'}
            </p>
          </div>

          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => {
                setTableVerifyOpen(false)
                setTableVerifyTarget(null)
                setSelectedVerifyTable('')
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!tableVerifyTarget || !selectedVerifyTable) return
                verifyMutation.mutate({ id: tableVerifyTarget.id, tables: [selectedVerifyTable] })
                setTableVerifyOpen(false)
                setTableVerifyTarget(null)
                setSelectedVerifyTable('')
              }}
              loading={verifyMutation.isPending}
              disabled={!tableVerifyTarget || !selectedVerifyTable || isLoadingVerifyTables}
            >
              Verify Table
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
