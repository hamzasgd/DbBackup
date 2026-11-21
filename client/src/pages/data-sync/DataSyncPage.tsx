import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ChevronDown, GitCompareArrows, Loader2, OctagonX, Radio, Search, Square, XCircle } from 'lucide-react'
import { connectionsApi, type Connection } from '../../services/connections.service'
import { dataSyncApi, type DataSyncMethod, type DataSyncRun, type LiveSync, type SchemaReport, type TableReport, type TableStatus } from '../../services/data-sync.service'
import { LiveSyncCard } from './LiveSyncCard'
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

const METHOD_OPTIONS = [
  { label: 'Full — every row', value: 'FULL' },
  { label: 'Quick — changes since last sync', value: 'QUICK' },
]

const PARALLEL_OPTIONS = [
  { label: '1 at a time — lightest on both servers', value: '1' },
  { label: '2 at a time', value: '2' },
  { label: '4 at a time (recommended)', value: '4' },
  { label: '8 at a time — fastest, most load', value: '8' },
]
const n = (v: number) => v.toLocaleString()

function totals(results: TableReport[]) {
  return results.reduce(
    (t, r) => ({ inserted: t.inserted + r.inserted, updated: t.updated + r.updated, deleted: t.deleted + r.deleted }),
    { inserted: 0, updated: 0, deleted: 0 },
  )
}

const CHANGE_LABEL: Record<string, string> = {
  CREATE_TABLE: 'table', ADD_COLUMN: 'column', ADD_INDEX: 'index', ADD_FOREIGN_KEY: 'foreign key',
}
const NOTE_LABEL: Record<string, string> = {
  COLUMN_DIFFERS: 'column differs',
  COLUMN_ONLY_ON_TARGET: 'column only on the target',
  INDEX_DIFFERS: 'index differs',
  INDEX_ONLY_ON_TARGET: 'index only on the target',
  FOREIGN_KEY_DIFFERS: 'foreign key differs',
  FOREIGN_KEY_ONLY_ON_TARGET: 'foreign key only on the target',
  PRIMARY_KEY_DIFFERS: 'primary key differs',
  TABLE_ONLY_ON_TARGET: 'table only on the target',
}

/** Schema differences of a run: additions (applied when syncing) and what is only reported. */
function SchemaSection({ schema, compare }: { schema: SchemaReport; compare: boolean }) {
  const [open, setOpen] = useState(false)
  const failed = schema.changes.filter((c) => c.status === 'FAILED')
  if (schema.changes.length === 0 && schema.notes.length === 0) {
    return <p className="text-xs text-gray-500">Schema: same tables, columns, indexes and foreign keys ({schema.tablesCompared} tables checked).</p>
  }
  return (
    <div className="text-xs border border-gray-100 rounded-lg p-2.5 space-y-1.5">
      <p className="text-gray-700">
        <b className="font-medium">Schema:</b>{' '}
        {schema.changes.length > 0 && (compare
          ? <>{schema.changes.length} missing on the target (a sync adds them)</>
          : <>{schema.changes.length - failed.length} added to the target{failed.length > 0 && <span className="text-red-600">, {failed.length} failed</span>}</>)}
        {schema.changes.length > 0 && schema.notes.length > 0 && ' · '}
        {schema.notes.length > 0 && <>{schema.notes.length} other difference{schema.notes.length === 1 ? '' : 's'}, not changed (never removed or altered automatically)</>}
        <button className="ml-2 text-blue-600 hover:underline" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'}</button>
      </p>
      {open && (
        <div className="space-y-2">
          {schema.changes.length > 0 && (
            <ul className="space-y-1">
              {schema.changes.map((c, i) => (
                <li key={i}>
                  <span className={c.status === 'FAILED' ? 'text-red-600' : c.status === 'APPLIED' ? 'text-green-700' : 'text-amber-700'}>
                    {c.status === 'APPLIED' ? 'Added' : c.status === 'FAILED' ? 'Failed' : 'Missing'}
                  </span>{' '}
                  {CHANGE_LABEL[c.kind]} <span className="font-mono">{c.kind === 'CREATE_TABLE' ? c.table : `${c.table}.${c.name}`}</span>
                  {c.error && <span className="text-red-600"> — {c.error}</span>}
                  <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] text-gray-500 bg-gray-50 rounded px-1.5 py-1 max-h-32 overflow-auto">{c.sql}</pre>
                </li>
              ))}
            </ul>
          )}
          {schema.notes.length > 0 && (
            <div>
              <p className="text-gray-500 mb-1">Not changed: fixing these means altering or removing something, which can lose data. Review the SQL and run it yourself if you want it.</p>
              <ul className="space-y-1">
                {schema.notes.map((n, i) => (
                  <li key={i}>
                    <span className="text-gray-700">{NOTE_LABEL[n.kind] ?? n.kind}</span>{' '}
                    <span className="font-mono">{n.kind === 'TABLE_ONLY_ON_TARGET' ? n.table : `${n.table}.${n.name}`}</span>
                    {(n.source || n.target) && <span className="text-gray-500"> — source: {n.source ?? 'none'}; target: {n.target ?? 'none'}</span>}
                    {n.suggestedSql && <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] text-gray-500 bg-gray-50 rounded px-1.5 py-1">{n.suggestedSql}</pre>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** One run: progress while it works, then a per-table report. */
function RunRow({ run, serverTime, onSyncThese, onStop, targetProtected, open, onToggle }: {
  run: DataSyncRun
  /** Details shown */
  open: boolean
  onToggle: () => void
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
  // Speed from server timestamps only, so the browser's clock doesn't skew it
  const workedMs = run.startedAt && run.progressAt ? Date.parse(run.progressAt) - Date.parse(run.startedAt) : 0
  const rate = workedMs > 10_000 && run.rowsChecked > 0 ? run.rowsChecked / (workedMs / 1000) : null
  const leftMs = rate && run.rowsEstimate && run.rowsEstimate > run.rowsChecked ? ((run.rowsEstimate - run.rowsChecked) / rate) * 1000 : null
  const elapsed = run.startedAt ? (run.completedAt ? Date.parse(run.completedAt) : now) - Date.parse(run.startedAt) : null
  const silentMs = serverTime && run.progressAt && run.status === 'RUNNING' ? Date.parse(serverTime) - Date.parse(run.progressAt) : 0
  const compare = run.mode === 'COMPARE'

  const summary = run.status === 'FAILED' ? null
    : isActive(run) ? (pct !== null ? `${pct < 10 ? pct.toFixed(1) : Math.floor(pct)}%` : null)
      : results.length === 0 ? null
        : changes === 0 ? 'No differences'
          : `${n(changes)} row${changes === 1 ? '' : 's'} ${compare ? (changes === 1 ? 'differs' : 'differ') : 'copied'}`

  return (
    <div className="border-b border-gray-100 last:border-0">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 px-4 sm:px-6 py-3 cursor-pointer hover:bg-gray-50 select-none"
      >
        <span className={`text-[11px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 shrink-0 ${compare ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>
          {compare ? 'Compare' : 'Sync'}
        </span>
        <div className="min-w-[12rem] sm:min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm min-w-0">
            <span className="font-medium text-gray-900 truncate">{run.sourceName}</span>
            <span className="text-gray-400 shrink-0">→</span>
            <span className="font-medium text-gray-900 truncate">{run.targetName}</span>
          </div>
          <p className="text-xs text-gray-400 truncate">
            {formatDate(run.startedAt ?? run.createdAt)}
            {elapsed !== null && <> · {isActive(run) ? 'running' : 'took'} {formatDuration(elapsed)}</>}
            {run.liveSyncId ? <> · Live sync catch-up</> : run.method === 'QUICK' ? <> · Quick</> : <> · Full</>}
            {run.tables.length > 0 && <> · {run.tables.length} table{run.tables.length === 1 ? '' : 's'}</>}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-auto">
          {summary && <span className={`text-xs tabular-nums ${problems.length ? 'text-red-600' : 'text-gray-600'}`}>{summary}{problems.length > 0 && !isActive(run) ? ` · ${problems.length} table${problems.length === 1 ? '' : 's'} failed` : ''}</span>}
          {run.status === 'COMPLETED' && <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700"><CheckCircle2 className="h-4 w-4" />Done</span>}
          {run.status === 'FAILED' && <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700"><XCircle className="h-4 w-4" />Failed</span>}
          {run.status === 'CANCELLED' && <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500"><OctagonX className="h-4 w-4" />Stopped</span>}
          {run.status === 'PENDING' && <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />Queued</span>}
          {isActive(run) && (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onStop(run) }} disabled={run.cancelRequested}>
              <Square className="h-3.5 w-3.5" />{run.cancelRequested ? 'Stopping…' : 'Stop'}
            </Button>
          )}
          <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </div>
      {open && (
      <div className="px-4 sm:px-6 pb-4 pt-1 space-y-3">
        <p className="text-xs text-gray-400">
          {run.sourceDatabase} → {run.targetDatabase}
          {run.method === 'QUICK' && <> · quick: changes since {run.since ? formatDate(run.since) : 'the last sync'}</>}
          {run.parallel > 1 && <> · {run.parallel} chunks at a time</>}
          {run.tables.length > 0 && <> · tables: {run.tables.join(', ')}</>}
        </p>
        {run.status === 'PENDING' && <p className="text-sm text-gray-500">Queued — waits for any other compare or sync to finish…</p>}
        {run.status === 'RUNNING' && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-gray-600">
              <span className="truncate">
                {run.currentTable ? <>Table <b className="font-medium text-gray-800">{run.currentTable}</b></> : 'Starting'}
                {run.tablesTotal ? <> ({Math.min(run.tablesDone + 1, run.tablesTotal)} of {run.tablesTotal})</> : null}
                {' · '}{n(run.rowsChecked)}{run.rowsEstimate ? <> of ~{n(run.rowsEstimate)}</> : null} rows checked
                {rate !== null && <> · {n(Math.round(rate))} rows/s</>}
                {leftMs !== null && <> · ~{formatDuration(leftMs)} left</>}
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

        {run.schema && <SchemaSection schema={run.schema} compare={compare} />}

        {results.length > 0 && (
          <div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="py-1.5 pr-3 font-medium">Table</th>
                    <th className="py-1.5 pr-3 font-medium">Result</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Rows</th>
                    <th className="py-1.5 pr-3 font-medium text-right" title="Rows in the source that the target doesn't have">{compare ? 'Missing' : 'Added'}</th>
                    <th className="py-1.5 pr-3 font-medium text-right" title="Rows in both, with different values">{compare ? 'Changed' : 'Replaced'}</th>
                    <th className="py-1.5 pr-3 font-medium text-right" title="Rows in the target that the source doesn't have (anymore)">{compare ? 'Only on target' : 'Deleted'}</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Time</th>
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
                      <td className="py-1.5 pr-3 text-right tabular-nums text-gray-500">{r.ms === undefined ? '' : r.ms < 1000 ? '<1s' : formatDuration(r.ms)}</td>
                      <td className="py-1.5 text-gray-500">
                        {[r.targetTable && `named ${r.targetTable} on the target`, r.note, r.reason, r.warning].filter(Boolean).join(' · ')}
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr><td colSpan={8} className="py-2 text-gray-500">All {results.length} tables are the same.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {compare && changes > 0 && (
              <p className="text-[11px] text-gray-500 mt-1.5">
                <b className="font-medium">Missing</b>: in the source, not yet on the target (syncing adds them) ·{' '}
                <b className="font-medium">Changed</b>: different values (syncing replaces them with the source's) ·{' '}
                <b className="font-medium">Only on target</b>: the source no longer has them, usually deleted there since the copy (<b className="font-medium">syncing deletes them</b>)
              </p>
            )}
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
      </div>
      )}
    </div>
  )
}

export default function DataSyncPage() {
  const qc = useQueryClient()
  const [sourceId, setSourceId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [tablesText, setTablesText] = useState('')
  const [parallel, setParallel] = useState(4)
  const [method, setMethod] = useState<DataSyncMethod>('FULL')
  const [confirm, setConfirm] = useState<{ source: Connection; target: Connection; tables: string[]; parallel: number; method: DataSyncMethod } | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [liveConfirm, setLiveConfirm] = useState<{ source: Connection; target: Connection } | null>(null)
  const [liveConfirmText, setLiveConfirmText] = useState('')
  const [runLimit, setRunLimit] = useState(10)
  /** Runs opened or closed by the user; others: open while running */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const { data: connsData } = useQuery({ queryKey: ['connections'], queryFn: () => connectionsApi.getAll() })
  const connections = (connsData?.data.data ?? []).filter((c) => SUPPORTED.has(c.type))
  const source = connections.find((c) => c.id === sourceId)
  const target = connections.find((c) => c.id === targetId)
  const tables = tablesText.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)

  const { data: liveData } = useQuery({
    queryKey: ['live-sync'],
    queryFn: () => dataSyncApi.listLive(),
    refetchInterval: (q) => ((q.state.data?.data.data.liveSyncs ?? []).some((l) => l.enabled) ? 3000 : false),
  })
  const lives = liveData?.data.data.liveSyncs ?? []
  const liveServerTime = liveData?.data.data.serverTime ?? null
  // While a live sync starts or catches up, its catch-up run appears among the runs
  const liveSettling = lives.some((l) => l.enabled && l.status !== 'RUNNING')

  const { data: runsData } = useQuery({
    queryKey: ['data-sync', runLimit],
    queryFn: () => dataSyncApi.list(runLimit),
    placeholderData: (prev) => prev,
    refetchInterval: (q) => ((q.state.data?.data.data.runs ?? []).some(isActive) || liveSettling ? 3000 : false),
  })
  const runs = runsData?.data.data.runs ?? []
  const serverTime = runsData?.data.data.serverTime ?? null

  const start = useMutation({
    mutationFn: (v: { mode: 'COMPARE' | 'APPLY'; source: Connection; target: Connection; tables: string[]; parallel: number; method: DataSyncMethod; confirmTarget?: string }) =>
      dataSyncApi.start({ sourceConnectionId: v.source.id, targetConnectionId: v.target.id, mode: v.mode, tables: v.tables, parallel: v.parallel, method: v.method, confirmTarget: v.confirmTarget }),
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

  const startLive = useMutation({
    mutationFn: (v: { source: Connection; target: Connection; confirmTarget: string }) =>
      dataSyncApi.startLive({ sourceConnectionId: v.source.id, targetConnectionId: v.target.id, confirmTarget: v.confirmTarget }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['live-sync'] })
      qc.invalidateQueries({ queryKey: ['data-sync'] })
      toast.success('Live sync started')
      setLiveConfirm(null)
      setLiveConfirmText('')
    },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Could not start Live sync')),
  })
  const stopLive = useMutation({
    mutationFn: (l: LiveSync) => dataSyncApi.stopLive(l.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['live-sync'] }); toast.success('Live sync stopped') },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Could not stop')),
  })
  const removeLive = useMutation({
    mutationFn: (l: LiveSync) => dataSyncApi.removeLive(l.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-sync'] }),
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Could not remove')),
  })
  const openLiveConfirm = (s?: Connection, t?: Connection) => {
    if (!s || !t) { toast.error('The source or target connection no longer exists'); return }
    setLiveConfirm({ source: s, target: t })
    setLiveConfirmText('')
  }
  const liveOnTarget = lives.find((l) => l.enabled && l.targetConnectionId === targetId)

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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="Only these tables (optional)"
              placeholder="All tables — or e.g. members, orders"
              value={tablesText}
              onChange={(e) => setTablesText(e.target.value)}
            />
            <Select
              label="Method"
              options={METHOD_OPTIONS}
              value={method}
              onChange={(e) => setMethod(e.target.value as DataSyncMethod)}
            />
            <Select
              label="Speed"
              options={PARALLEL_OPTIONS}
              value={String(parallel)}
              onChange={(e) => setParallel(Number(e.target.value))}
            />
          </div>
          {target?.writeProtected && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              {target.name} is write-protected: you can compare against it, but nothing will be synced into it.
            </p>
          )}
          <p className="text-xs text-gray-500">
            {method === 'QUICK'
              ? <>Quick: in big tables with an <code>updatedAt</code> column, only rows changed since the last completed
                sync are compared, plus rows added or deleted (found from the keys). Changes that didn&apos;t touch
                updatedAt are missed, so run a Full compare now and then. Other tables are compared in full.</>
              : <>Full: every row of every table is compared in chunks along its primary key; both databases checksum
                their own rows, so only checksums and the rows that differ travel over the network. Checking several
                chunks at a time is faster but adds load on both servers.</>}
          </p>
          <div className="flex flex-wrap gap-2 justify-end">
            <Button variant="outline" disabled={!ready} loading={start.isPending}
              onClick={() => source && target && start.mutate({ mode: 'COMPARE', source, target, tables, parallel, method })}>
              <Search className="h-4 w-4" />Compare (read-only)
            </Button>
            <Button variant="danger" disabled={!ready || !!target?.writeProtected}
              title={target?.writeProtected ? 'The target is write-protected: Compare only' : undefined}
              onClick={() => source && target && (setConfirm({ source, target, tables, parallel, method }), setConfirmText(''))}>
              <GitCompareArrows className="h-4 w-4" />Sync differences…
            </Button>
            <Button variant="primary" disabled={!ready || !!target?.writeProtected || !!liveOnTarget}
              title={liveOnTarget ? 'Live sync into this target is already on' : target?.writeProtected ? 'The target is write-protected' : 'Apply every change on the source to the target as it happens'}
              onClick={() => openLiveConfirm(source, target)}>
              <Radio className="h-4 w-4" />Start Live sync…
            </Button>
          </div>
        </CardContent>
      </Card>

      {lives.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-700">Live sync</h2>
          {lives.map((l) => (
            <LiveSyncCard
              key={l.id}
              live={l}
              serverTime={liveServerTime}
              busy={stopLive.isPending || removeLive.isPending || startLive.isPending}
              onStop={(x) => stopLive.mutate(x)}
              onRemove={(x) => removeLive.mutate(x)}
              onStart={(x) => openLiveConfirm(
                connections.find((c) => c.id === x.sourceConnectionId),
                connections.find((c) => c.id === x.targetConnectionId),
              )}
            />
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-700">Recent runs</h2>
          <Card className="overflow-hidden">
          {runs.map((r) => (
            <RunRow
              key={r.id}
              run={r}
              open={expanded[r.id] ?? isActive(r)}
              onToggle={() => setExpanded((x) => ({ ...x, [r.id]: !(x[r.id] ?? isActive(r)) }))}
              serverTime={serverTime}
              targetProtected={!!connections.find((c) => c.id === r.targetConnectionId)?.writeProtected}
              onStop={(run) => stop.mutate(run)}
              onSyncThese={(run) => {
                const s = connections.find((c) => c.id === run.sourceConnectionId)
                const t = connections.find((c) => c.id === run.targetConnectionId)
                if (!s || !t) { toast.error('The source or target connection no longer exists'); return }
                // Only the tables that differed
                const differing = (run.results ?? []).filter((x) => x.status === 'DIFFERENT' || x.status === 'ONLY_IN_SOURCE').map((x) => x.table)
                setConfirm({ source: s, target: t, tables: differing, parallel, method: run.method ?? 'FULL' })
                setConfirmText('')
              }}
            />
          ))}
          </Card>
          {runs.length >= runLimit && runLimit < 50 && (
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" onClick={() => setRunLimit((l) => Math.min(50, l + 10))}>Show older runs</Button>
            </div>
          )}
        </div>
      )}

      <Modal open={liveConfirm !== null} onClose={() => setLiveConfirm(null)} title="Start Live sync">
        {liveConfirm && (
          <div className="space-y-4 text-sm">
            <p className="text-gray-700">
              Keeps <b>{liveConfirm.target.name}</b> (database <b>{liveConfirm.target.database}</b>) in step with{' '}
              <b>{liveConfirm.source.name}</b> ({liveConfirm.source.database}): every insert, change and delete on the source
              is read from its binary log (its record of changes) and applied to the target within seconds. Nothing is
              read from the source&apos;s tables, so it adds almost no load there.
            </p>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900 space-y-1">
              <p className="font-medium">How it works:</p>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>first a sync brings the target up to date (Quick when a full sync was done before, else Full)</li>
                <li>then every change follows, in the same order; deletes and TRUNCATE on the source are applied too</li>
                <li>new tables, columns and indexes on the source are added to the target; nothing is ever removed or altered, and tables dropped on the source stay on the target</li>
                <li>it keeps running in the background, also after a restart of DbBackup, until you stop it</li>
                <li>while you run a sync into the same target it pauses, and continues afterwards</li>
              </ul>
              <p className="pt-1">
                The source needs <code>binlog_format=ROW</code> and <code>binlog_row_image=FULL</code> (AWS RDS&apos;s defaults), a user with
                REPLICATION SLAVE and REPLICATION CLIENT, and on RDS kept binary logs:{' '}
                <code>CALL mysql.rds_set_configuration(&apos;binlog retention hours&apos;, 24);</code>
              </p>
            </div>
            <Input
              label={`Type ${liveConfirm.target.database} to confirm`}
              value={liveConfirmText}
              onChange={(e) => setLiveConfirmText(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setLiveConfirm(null)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={liveConfirmText !== liveConfirm.target.database}
                loading={startLive.isPending}
                onClick={() => startLive.mutate({ source: liveConfirm.source, target: liveConfirm.target, confirmTarget: liveConfirmText })}
              >
                <Radio className="h-4 w-4" />Start Live sync
              </Button>
            </div>
          </div>
        )}
      </Modal>

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
                <li>schema first: missing tables, columns, indexes and foreign keys are added on the target; nothing is ever removed or altered</li>
                <li>tables only on the target are left alone; tables whose columns still differ are skipped and reported</li>
              </ul>
            </div>
            <Select
              label="Method"
              options={METHOD_OPTIONS}
              value={confirm.method}
              onChange={(e) => setConfirm({ ...confirm, method: e.target.value as DataSyncMethod })}
            />
            <Select
              label="Speed"
              options={PARALLEL_OPTIONS}
              value={String(confirm.parallel)}
              onChange={(e) => setConfirm({ ...confirm, parallel: Number(e.target.value) })}
            />
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
                onClick={() => start.mutate({ mode: 'APPLY', source: confirm.source, target: confirm.target, tables: confirm.tables, parallel: confirm.parallel, method: confirm.method, confirmTarget: confirmText })}
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
