import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, GitCompareArrows, Loader2, OctagonX, Search, Square, XCircle } from 'lucide-react'
import { connectionsApi, type Connection } from '../../services/connections.service'
import { dataSyncApi, type DataSyncRun, type TableReport, type TableStatus } from '../../services/data-sync.service'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Select } from '../../components/ui/Select'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { formatDate, formatDuration, getApiErrorMessage, dbTypeLabel } from '../../lib/utils'
import { useNow } from '../../hooks/useNow'

const SUPPORTED = new Set(['MYSQL', 'MARIADB'])
const HEARTBEAT_LOST_MS = 60_000

const STATUS_LABEL: Record<TableStatus, string> = {
  SAME: 'Same',
  DIFFERENT: 'Differs',
  SYNCED: 'Synced',
  CREATED: 'Created',
  ONLY_IN_SOURCE: 'Missing on target',
  ONLY_IN_TARGET: 'Only on target',
  SKIPPED: 'Skipped',
  ERROR: 'Error',
}
const STATUS_COLOR: Record<TableStatus, string> = {
  SAME: 'text-gray-500',
  DIFFERENT: 'text-amber-700',
  SYNCED: 'text-green-700',
  CREATED: 'text-green-700',
  ONLY_IN_SOURCE: 'text-amber-700',
  ONLY_IN_TARGET: 'text-gray-500',
  SKIPPED: 'text-red-600',
  ERROR: 'text-red-600',
}

const isActive = (r: DataSyncRun) => r.status === 'PENDING' || r.status === 'RUNNING'
const n = (v: number) => v.toLocaleString()

function totals(results: TableReport[]) {
  return results.reduce(
    (t, r) => ({ inserted: t.inserted + r.inserted, updated: t.updated + r.updated, deleted: t.deleted + r.deleted }),
    { inserted: 0, updated: 0, deleted: 0 },
  )
}

/** One run: progress while it works, then a per-table report. */
function RunCard({ run, serverTime, onSyncThese, onStop, targetProtected }: {
  run: DataSyncRun
  serverTime: string | null
  /** The target connection is write-protected now: no "Sync these differences" */
  targetProtected: boolean
  onSyncThese: (run: DataSyncRun) => void
  onStop: (run: DataSyncRun) => void
}) {
  const now = useNow(1000)
  const [showAll, setShowAll] = useState(false)
  const results = run.results ?? []
  const t = totals(results)
  const changes = t.inserted + t.updated + t.deleted
  const problems = results.filter((r) => r.status === 'SKIPPED' || r.status === 'ERROR')
  const notSame = results.filter((r) => r.status !== 'SAME')
  const shown = showAll ? results : notSame
  const pct = run.rowsEstimate ? Math.min(99, (run.rowsChecked / run.rowsEstimate) * 100) : null
  const elapsed = run.startedAt ? (run.completedAt ? Date.parse(run.completedAt) : now) - Date.parse(run.startedAt) : null
  const silentMs = serverTime && run.progressAt && run.status === 'RUNNING' ? Date.parse(serverTime) - Date.parse(run.progressAt) : 0
  const compare = run.mode === 'COMPARE'

  return (
    <Card>
      <CardHeader className="items-start gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`text-[11px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 ${compare ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>
              {compare ? 'Compare' : 'Sync'}
            </span>
            <span className="font-medium text-gray-900">{run.sourceName}</span>
            <span className="text-gray-400 text-xs">{run.sourceDatabase}</span>
            <span className="text-gray-400">→</span>
            <span className="font-medium text-gray-900">{run.targetName}</span>
            <span className="text-gray-400 text-xs">{run.targetDatabase}</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {formatDate(run.startedAt ?? run.createdAt)}
            {elapsed !== null && <> · {isActive(run) ? 'running' : 'took'} {formatDuration(elapsed)}</>}
            {run.tables.length > 0 && <> · tables: {run.tables.join(', ')}</>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {run.status === 'COMPLETED' && <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700"><CheckCircle2 className="h-4 w-4" />Done</span>}
          {run.status === 'FAILED' && <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700"><XCircle className="h-4 w-4" />Failed</span>}
          {run.status === 'CANCELLED' && <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500"><OctagonX className="h-4 w-4" />Stopped</span>}
          {isActive(run) && (
            <Button size="sm" variant="outline" onClick={() => onStop(run)} disabled={run.cancelRequested}>
              <Square className="h-3.5 w-3.5" />{run.cancelRequested ? 'Stopping…' : 'Stop'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {run.status === 'PENDING' && <p className="text-sm text-gray-500">Queued — waits for any other compare or sync to finish…</p>}
        {run.status === 'RUNNING' && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-gray-600">
              <span className="truncate">
                {run.currentTable ? <>Table <b className="font-medium text-gray-800">{run.currentTable}</b></> : 'Starting'}
                {run.tablesTotal ? <> ({Math.min(run.tablesDone + 1, run.tablesTotal)} of {run.tablesTotal})</> : null}
                {' · '}{n(run.rowsChecked)}{run.rowsEstimate ? <> of ~{n(run.rowsEstimate)}</> : null} rows checked
              </span>
              {pct !== null && <span className="tabular-nums">{pct < 10 ? pct.toFixed(1) : Math.floor(pct)}%</span>}
            </div>
            <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
              {pct !== null
                ? <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                : <div className="h-full w-full bg-blue-400 rounded-full animate-pulse" />}
            </div>
            {silentMs > HEARTBEAT_LOST_MS && (
              <p className="flex items-start gap-1 text-[11px] text-red-600">
                <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
                No update for {formatDuration(silentMs)}. The app probably stopped or restarted; this run will be marked failed.
              </p>
            )}
          </div>
        )}

        {!isActive(run) && run.status !== 'FAILED' && results.length > 0 && (
          <p className="text-sm text-gray-700">
            {changes === 0
              ? <>No differences in the tables that could be compared.</>
              : compare
                ? <><b>{n(changes)}</b> rows differ: {n(t.inserted)} missing on the target, {n(t.updated)} changed, {n(t.deleted)} only on the target.</>
                : <><b>{n(changes)}</b> rows copied: {n(t.inserted)} added, {n(t.updated)} replaced, {n(t.deleted)} deleted on the target.</>}
            {problems.length > 0 && <span className="text-red-600"> {problems.length} table{problems.length === 1 ? '' : 's'} could not be compared.</span>}
          </p>
        )}
        {run.status === 'FAILED' && run.error && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-words">{run.error}</p>
        )}

        {results.length > 0 && (
          <div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="py-1.5 pr-3 font-medium">Table</th>
                    <th className="py-1.5 pr-3 font-medium">Result</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Rows</th>
                    <th className="py-1.5 pr-3 font-medium text-right">{compare ? 'Missing' : 'Added'}</th>
                    <th className="py-1.5 pr-3 font-medium text-right">{compare ? 'Changed' : 'Replaced'}</th>
                    <th className="py-1.5 pr-3 font-medium text-right">{compare ? 'Only on target' : 'Deleted'}</th>
                    <th className="py-1.5 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {shown.map((r) => (
                    <tr key={r.table}>
                      <td className="py-1.5 pr-3 font-mono text-gray-800">{r.table}</td>
                      <td className={`py-1.5 pr-3 font-medium ${STATUS_COLOR[r.status]}`}>{STATUS_LABEL[r.status]}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-gray-600">{n(r.rows)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{r.inserted ? n(r.inserted) : '–'}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{r.updated ? n(r.updated) : '–'}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{r.deleted ? n(r.deleted) : '–'}</td>
                      <td className="py-1.5 text-gray-500">
                        {[r.targetTable && `named ${r.targetTable} on the target`, r.reason, r.warning].filter(Boolean).join(' · ')}
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr><td colSpan={7} className="py-2 text-gray-500">All {results.length} tables are the same.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {results.length !== notSame.length && (
              <button className="text-[11px] text-gray-500 hover:text-gray-800 mt-1" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show only tables with differences' : `Show all ${results.length} tables`}
              </button>
            )}
          </div>
        )}

        {compare && run.status === 'COMPLETED' && changes > 0 && run.sourceConnectionId && run.targetConnectionId && !targetProtected && (
          <div className="flex justify-end">
            <Button size="sm" variant="danger" onClick={() => onSyncThese(run)}>
              <GitCompareArrows className="h-3.5 w-3.5" />Sync these differences…
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function DataSyncPage() {
  const qc = useQueryClient()
  const [sourceId, setSourceId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [tablesText, setTablesText] = useState('')
  const [confirm, setConfirm] = useState<{ source: Connection; target: Connection; tables: string[] } | null>(null)
  const [confirmText, setConfirmText] = useState('')

  const { data: connsData } = useQuery({ queryKey: ['connections'], queryFn: () => connectionsApi.getAll() })
  const connections = (connsData?.data.data ?? []).filter((c) => SUPPORTED.has(c.type))
  const source = connections.find((c) => c.id === sourceId)
  const target = connections.find((c) => c.id === targetId)
  const tables = tablesText.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)

  const { data: runsData } = useQuery({
    queryKey: ['data-sync'],
    queryFn: () => dataSyncApi.list(10),
    refetchInterval: (q) => ((q.state.data?.data.data.runs ?? []).some(isActive) ? 3000 : false),
  })
  const runs = runsData?.data.data.runs ?? []
  const serverTime = runsData?.data.data.serverTime ?? null

  const start = useMutation({
    mutationFn: (v: { mode: 'COMPARE' | 'APPLY'; source: Connection; target: Connection; tables: string[]; confirmTarget?: string }) =>
      dataSyncApi.start({ sourceConnectionId: v.source.id, targetConnectionId: v.target.id, mode: v.mode, tables: v.tables, confirmTarget: v.confirmTarget }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['data-sync'] })
      toast.success(v.mode === 'APPLY' ? 'Sync started' : 'Comparison started')
      setConfirm(null)
      setConfirmText('')
    },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Could not start')),
  })
  const stop = useMutation({
    mutationFn: (run: DataSyncRun) => dataSyncApi.cancel(run.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['data-sync'] }),
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Could not stop')),
  })

  const ready = !!source && !!target && source.id !== target.id
  const options = (exclude?: string) => [
    { label: 'Choose a database…', value: '' },
    ...connections.filter((c) => c.id !== exclude).map((c) => ({
      label: `${c.name} (${dbTypeLabel(c.type)} · ${c.database})${c.writeProtected ? ' — write-protected' : ''}`,
      value: c.id,
    })),
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Compare &amp; Sync</h1>
        <p className="text-gray-500 mt-1">
          Copy only what changed from one database to another with the same tables. Works with any provider: it only
          needs to read the source and write the target.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>New comparison</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select label="Source (copied from)" options={options(targetId)} value={sourceId} onChange={(e) => setSourceId(e.target.value)} />
            <Select label="Target (brought up to date)" options={options(sourceId)} value={targetId} onChange={(e) => setTargetId(e.target.value)} />
          </div>
          <Input
            label="Only these tables (optional)"
            placeholder="All tables — or e.g. members, orders"
            value={tablesText}
            onChange={(e) => setTablesText(e.target.value)}
          />
          {target?.writeProtected && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              {target.name} is write-protected: you can compare against it, but nothing will be synced into it.
            </p>
          )}
          <p className="text-xs text-gray-500">
            Each table is compared in chunks along its primary key; both databases checksum their own rows, so only
            checksums and the rows that differ travel over the network. Every run still reads all rows on both sides.
          </p>
          <div className="flex flex-wrap gap-2 justify-end">
            <Button variant="outline" disabled={!ready} loading={start.isPending}
              onClick={() => source && target && start.mutate({ mode: 'COMPARE', source, target, tables })}>
              <Search className="h-4 w-4" />Compare (read-only)
            </Button>
            <Button variant="danger" disabled={!ready || !!target?.writeProtected}
              title={target?.writeProtected ? 'The target is write-protected: Compare only' : undefined}
              onClick={() => source && target && (setConfirm({ source, target, tables }), setConfirmText(''))}>
              <GitCompareArrows className="h-4 w-4" />Sync differences…
            </Button>
          </div>
        </CardContent>
      </Card>

      {runs.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-700">Recent runs</h2>
          {runs.map((r) => (
            <RunCard
              key={r.id}
              run={r}
              serverTime={serverTime}
              targetProtected={!!connections.find((c) => c.id === r.targetConnectionId)?.writeProtected}
              onStop={(run) => stop.mutate(run)}
              onSyncThese={(run) => {
                const s = connections.find((c) => c.id === run.sourceConnectionId)
                const t = connections.find((c) => c.id === run.targetConnectionId)
                if (!s || !t) { toast.error('The source or target connection no longer exists'); return }
                // Only the tables that differed
                const differing = (run.results ?? []).filter((x) => x.status === 'DIFFERENT' || x.status === 'ONLY_IN_SOURCE').map((x) => x.table)
                setConfirm({ source: s, target: t, tables: differing })
                setConfirmText('')
              }}
            />
          ))}
        </div>
      )}

      <Modal open={confirm !== null} onClose={() => setConfirm(null)} title="Sync differences">
        {confirm && (
          <div className="space-y-4 text-sm">
            <p className="text-gray-700">
              Brings <b>{confirm.target.name}</b> (database <b>{confirm.target.database}</b>) up to date with{' '}
              <b>{confirm.source.name}</b> ({confirm.source.database})
              {confirm.tables.length > 0 ? <> for {confirm.tables.length} table{confirm.tables.length === 1 ? '' : 's'}: {confirm.tables.join(', ')}</> : <>, all tables</>}.
            </p>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900 space-y-1">
              <p className="font-medium">This changes data in {confirm.target.name}:</p>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>rows missing on the target are added, changed rows are replaced</li>
                <li><b>rows that exist only on the target are deleted</b></li>
                <li>tables missing on the target are created; tables only on the target are left alone</li>
                <li>tables whose columns differ are skipped and reported</li>
              </ul>
            </div>
            <Input
              label={`Type ${confirm.target.database} to confirm`}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={confirmText !== confirm.target.database}
                loading={start.isPending}
                onClick={() => start.mutate({ mode: 'APPLY', source: confirm.source, target: confirm.target, tables: confirm.tables, confirmTarget: confirmText })}
              >
                {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitCompareArrows className="h-4 w-4" />}Sync now
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
