import { AlertTriangle, Loader2, Pause, Play, Radio, Square, Trash2, XCircle } from 'lucide-react'
import type { LiveSync } from '../../services/data-sync.service'
import { Button } from '../../components/ui/Button'
import { Card, CardContent, CardHeader } from '../../components/ui/Card'
import { formatBytes, formatDate, formatDuration } from '../../lib/utils'
import { useNow } from '../../hooks/useNow'

const n = (v: number) => v.toLocaleString()

/** Whether position a is before b in the source's log */
const before = (aFile: string, aPos: number, bFile: string, bPos: number) => aFile < bFile || (aFile === bFile && aPos < bPos)

function Badge({ live }: { live: LiveSync }) {
  const base = 'inline-flex items-center gap-1 text-xs font-medium'
  switch (live.status) {
    case 'RUNNING':
      return <span className={`${base} text-green-700`}><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" /><span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" /></span>Live</span>
    case 'STARTING':
    case 'CATCHING_UP':
      return <span className={`${base} text-blue-700`}><Loader2 className="h-3.5 w-3.5 animate-spin" />{live.status === 'STARTING' ? 'Starting' : 'Catching up'}</span>
    case 'PAUSED':
      return <span className={`${base} text-gray-600`}><Pause className="h-3.5 w-3.5" />Paused</span>
    case 'RECONNECTING':
      return <span className={`${base} text-amber-700`}><Loader2 className="h-3.5 w-3.5 animate-spin" />Reconnecting</span>
    case 'ERROR':
      return <span className={`${base} text-red-700`}><XCircle className="h-3.5 w-3.5" />{live.enabled ? 'Error, retrying' : 'Stopped with an error'}</span>
    default:
      return <span className={`${base} text-gray-500`}><Square className="h-3.5 w-3.5" />Off</span>
  }
}

export function LiveSyncCard({ live, serverTime, onStop, onStart, onRemove, busy }: {
  live: LiveSync
  serverTime: string | null
  onStop: (l: LiveSync) => void
  onStart: (l: LiveSync) => void
  onRemove: (l: LiveSync) => void
  busy: boolean
}) {
  const now = useNow(1000)
  // Server time, adjusted for the seconds since it was read
  const skew = serverTime ? Date.parse(serverTime) - now : 0
  const ago = (iso: string | null) => (iso ? formatDuration(Math.max(0, now + skew - Date.parse(iso))) : null)

  const hasHead = live.headFile !== null && live.headPos !== null && live.binlogFile !== null && live.binlogPos !== null
  const caughtUp = hasHead && !before(live.binlogFile!, live.binlogPos!, live.headFile!, live.headPos!)
  const behindBytes = hasHead && live.binlogFile === live.headFile ? Math.max(0, live.headPos! - live.binlogPos!) : null

  return (
    <Card>
      <CardHeader className="items-start gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[11px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 bg-green-50 text-green-700 inline-flex items-center gap-1">
              <Radio className="h-3 w-3" />Live
            </span>
            <span className="font-medium text-gray-900">{live.sourceName}</span>
            <span className="text-gray-400 text-xs">{live.sourceDatabase}</span>
            <span className="text-gray-400">→</span>
            <span className="font-medium text-gray-900">{live.targetName}</span>
            <span className="text-gray-400 text-xs">{live.targetDatabase}</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {live.startedAt ? <>following since {formatDate(live.startedAt)}</> : <>created {formatDate(live.createdAt)}</>}
            {!live.enabled && live.stoppedAt && <> · stopped {formatDate(live.stoppedAt)}</>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge live={live} />
          {live.enabled ? (
            <Button size="sm" variant="outline" onClick={() => onStop(live)} disabled={busy}><Square className="h-3.5 w-3.5" />Stop</Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => onStart(live)} disabled={busy}><Play className="h-3.5 w-3.5" />Start again</Button>
              <Button size="sm" variant="ghost" onClick={() => onRemove(live)} disabled={busy} title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {live.status === 'STARTING' && <p className="text-gray-600">Checking the source and noting where its change log ends…</p>}
        {live.status === 'CATCHING_UP' && (
          <p className="text-gray-600">
            A sync is bringing the target up to date first (shown under Recent runs). Changes made meanwhile are kept in
            the source&apos;s log and applied right after it, then every new change follows within seconds.
          </p>
        )}
        {live.status === 'PAUSED' && (
          <p className="text-gray-600">Paused while a sync into this target runs, so the two never write at once. It continues from where it was afterwards.</p>
        )}
        {(live.status === 'RUNNING' || live.status === 'RECONNECTING' || (live.status === 'ERROR' && live.enabled)) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-gray-700">
            <span>
              {caughtUp
                ? <b className="font-medium text-green-700">Up to date</b>
                : behindBytes !== null
                  ? <>Behind: <b className="font-medium">{formatBytes(behindBytes)}</b> of changes to apply</>
                  : hasHead ? <>Behind: applying older log files</> : <>Checking…</>}
              {live.checkedAt && <span className="text-gray-400"> · checked {ago(live.checkedAt)} ago</span>}
            </span>
            {live.lastEventAt && (
              <span>
                Last change applied {ago(live.appliedAt)} ago
                <span className="text-gray-400"> (made on the source at {formatDate(live.lastEventAt)})</span>
              </span>
            )}
          </div>
        )}
        {live.transactions > 0 && (
          <p className="text-xs text-gray-500">
            Applied so far: {n(live.transactions)} transaction{live.transactions === 1 ? '' : 's'} · {n(live.inserted)} rows added ·{' '}
            {n(live.updated)} changed · {n(live.deleted)} deleted
          </p>
        )}
        {live.error && (
          <p className={`text-xs rounded-lg px-2.5 py-1.5 border ${live.status === 'RECONNECTING' ? 'text-amber-800 bg-amber-50 border-amber-200' : 'text-red-800 bg-red-50 border-red-200'}`}>
            {live.error}
            {live.enabled && live.status === 'ERROR' && <> — it tries again every minute.</>}
          </p>
        )}
        {live.warnings.length > 0 && (
          <details className="text-xs text-amber-800">
            <summary className="cursor-pointer inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" />{live.warnings.length} note{live.warnings.length === 1 ? '' : 's'}</summary>
            <ul className="list-disc pl-5 mt-1 space-y-0.5">{live.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </details>
        )}
      </CardContent>
    </Card>
  )
}
