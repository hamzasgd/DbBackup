import { useState } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, RotateCcw, XCircle } from 'lucide-react'
import type { RestoreRecord, RestoreStage } from '../../services/backups.service'
import { useProgressSSE, type ProgressEvent } from '../../hooks/useProgressSSE'
import { isActiveRestore } from './restore-live'
import { useNow } from '../../hooks/useNow'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { formatBytes, formatDate, formatDuration } from '../../lib/utils'

const STAGE_LABEL: Record<RestoreStage, string> = {
  PREPARING: 'Preparing',
  DOWNLOADING: 'Downloading the backup',
  DECRYPTING: 'Decrypting the backup',
  RESTORING: 'Restoring',
}

/** Worker heartbeats every ~3s; this long without one (server clock) → it has likely died. */
const HEARTBEAT_LOST_MS = 60_000
/** No speed or time-left guess before a step has run this long. */
const RATE_MIN_MS = 15_000
const ETA_MIN_MS = 30_000

/**
 * Subscribes to one running restore's SSE stream and hands every event up.
 * Rendered once per active restore, so a finished restore toasts exactly once
 * however many places show it.
 */
export function RestoreEvents({ restore, onEvent }: {
  restore: RestoreRecord
  onEvent: (restore: RestoreRecord, event: ProgressEvent) => void
}) {
  useProgressSSE(`/restore/${restore.id}/progress`, true, (e) => onEvent(restore, e))
  return null
}

/** Progress of one restore: step, bytes, bar, speed, time left, and a warning when the worker goes silent. */
export function RestoreProgress({ restore: r, serverTime }: { restore: RestoreRecord; serverTime: string | null }) {
  const now = useNow(1000)

  if (r.status === 'PENDING') {
    return <p className="text-xs text-gray-500">Queued — waits for any restore already running to finish…</p>
  }
  if (r.status !== 'RUNNING') return null

  const stage = r.stage ?? 'PREPARING'
  const total = r.totalBytes && r.totalBytes > 0 ? r.totalBytes : null
  const pct = total ? Math.min(100, (r.bytesRead / total) * 100) : null
  const pctLabel = pct === null ? '' : pct < 10 ? pct.toFixed(1) : String(Math.floor(pct))

  // Speed over the current step, on the server's clock (no client clock skew)
  const stageMs = r.stageStartedAt && r.progressAt ? Date.parse(r.progressAt) - Date.parse(r.stageStartedAt) : 0
  const rate = stage !== 'PREPARING' && stageMs >= RATE_MIN_MS && r.bytesRead > 0 ? r.bytesRead / (stageMs / 1000) : null
  const etaMs = rate && total && stageMs >= ETA_MIN_MS && total > r.bytesRead ? ((total - r.bytesRead) / rate) * 1000 : null
  const elapsedMs = r.startedAt ? now - Date.parse(r.startedAt) : null

  const silentMs = serverTime && r.progressAt ? Math.max(0, Date.parse(serverTime) - Date.parse(r.progressAt)) : 0
  const lost = silentMs > HEARTBEAT_LOST_MS

  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2 text-xs text-gray-600">
        <span className="truncate">
          {STAGE_LABEL[stage]}
          {stage !== 'PREPARING' && (
            <>
              {' · '}
              <span className="font-medium text-gray-800">{formatBytes(r.bytesRead)}</span>
              {total && <> of {formatBytes(total)}{stage === 'RESTORING' && ' read'}</>}
            </>
          )}
        </span>
        {pct !== null && <span className="tabular-nums">{pctLabel}%</span>}
      </div>
      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
        {pct !== null ? (
          <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
        ) : (
          <div className="h-full w-full bg-blue-400 rounded-full animate-pulse" />
        )}
      </div>
      <p className="text-[11px] text-gray-500">
        {elapsedMs !== null && <>Running {formatDuration(elapsedMs)}</>}
        {!lost && rate !== null && <> · {formatBytes(rate)}/s</>}
        {!lost && etaMs !== null && <> · ~{formatDuration(etaMs)} left</>}
        {!lost && stage === 'RESTORING' && total && etaMs === null && <> · estimating time…</>}
      </p>
      {lost && (
        <p className="flex items-start gap-1 text-[11px] text-red-600">
          <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
          No update for {formatDuration(silentMs)}. The app probably stopped or restarted; this restore will be marked
          failed, and the database may be only partly restored.
        </p>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: RestoreRecord['status'] }) {
  if (status === 'COMPLETED') return <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
  if (status === 'FAILED') return <XCircle className="h-4 w-4 text-red-600 shrink-0" />
  if (status === 'RUNNING') return <Loader2 className="h-4 w-4 text-blue-600 animate-spin shrink-0" />
  return <RotateCcw className="h-4 w-4 text-gray-400 shrink-0" />
}

/** One line per restore: from which backup, into which database, and how it is going or how it ended. */
export function RestoreItem({ restore: r, serverTime }: { restore: RestoreRecord; serverTime: string | null }) {
  const [showError, setShowError] = useState(false)
  const took = r.startedAt && r.completedAt ? Date.parse(r.completedAt) - Date.parse(r.startedAt) : null

  return (
    <div className="py-3 space-y-2">
      <div className="flex items-start gap-2">
        <StatusIcon status={r.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
            <span className="font-medium text-gray-900">{r.backupLabel}</span>
            {r.backupCreatedAt && <span className="text-gray-400 text-xs">backup of {formatDate(r.backupCreatedAt)}</span>}
            <ArrowRight className="h-3.5 w-3.5 text-gray-400" />
            <span className="font-medium text-gray-900">{r.targetName}</span>
            <span className="text-gray-500 text-xs">database {r.targetDatabase}</span>
            {r.strategy === 'SSH_SERVER' && (
              <span className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded px-1.5" title="mysql ran on the target's SSH server">
                on SSH server
              </span>
            )}
            {r.overwritesSource && (
              <span className="text-[11px] font-medium text-red-700 bg-red-50 border border-red-200 rounded px-1.5">
                overwrote its source
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {r.status === 'COMPLETED' && <>Completed {r.completedAt && formatDate(r.completedAt)}{took !== null && <> · took {formatDuration(took)}</>}</>}
            {r.status === 'FAILED' && <>Failed {r.completedAt && formatDate(r.completedAt)}{took !== null && <> after {formatDuration(took)}</>}</>}
            {isActiveRestore(r) && <>Started {formatDate(r.startedAt ?? r.createdAt)}</>}
          </p>
        </div>
      </div>
      {isActiveRestore(r) && (
        <div className="pl-6">
          <RestoreProgress restore={r} serverTime={serverTime} />
        </div>
      )}
      {r.status === 'FAILED' && r.error && (
        <div className="pl-6">
          <p className={`text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-words ${showError ? '' : 'line-clamp-2'}`}>
            {r.error}
          </p>
          {r.error.length > 160 && (
            <button className="text-[11px] text-gray-500 hover:text-gray-700 mt-0.5" onClick={() => setShowError((v) => !v)}>
              {showError ? 'Show less' : 'Show full error'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Running restores with live progress, and the most recent finished ones. */
export function RestoresPanel({ restores, serverTime }: { restores: RestoreRecord[]; serverTime: string | null }) {
  const [showAll, setShowAll] = useState(false)
  if (restores.length === 0) return null

  const active = restores.filter(isActiveRestore)
  const finished = restores.filter((r) => !isActiveRestore(r))
  const shownFinished = showAll ? finished : finished.slice(0, active.length > 0 ? 2 : 3)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-gray-500" />
          Restores
          {active.length > 0 && (
            <span className="text-xs font-medium text-blue-700 bg-blue-50 rounded-full px-2 py-0.5">{active.length} running</span>
          )}
        </CardTitle>
        {finished.length > shownFinished.length || showAll ? (
          <button className="text-xs text-gray-500 hover:text-gray-800" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${finished.length} recent`}
          </button>
        ) : null}
      </CardHeader>
      <CardContent className="py-1 divide-y divide-gray-100">
        {[...active, ...shownFinished].map((r) => <RestoreItem key={r.id} restore={r} serverTime={serverTime} />)}
      </CardContent>
    </Card>
  )
}
