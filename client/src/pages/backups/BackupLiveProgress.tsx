import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { Backup, BackupStage } from '../../services/backups.service'
import type { LiveProgress } from './live-progress'
import { formatBytes } from '../../lib/utils'

const STAGE_LABEL: Record<BackupStage, string> = {
  DUMPING: 'Dumping',
  VERIFYING: 'Verifying',
  ENCRYPTING: 'Encrypting',
  UPLOADING: 'Saving to storage',
}

/** No output growth for this long while dumping → "no new data" warning. */
const NO_DATA_WARN_MS = 2 * 60_000
/** Worker heartbeats every ~3s; this long without one → it has likely died. */
const HEARTBEAT_LOST_MS = 60_000

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Re-render on an interval so elapsed-time text and warnings stay current. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}

export function BackupLiveProgress({ backup, live }: { backup: Backup; live: LiveProgress }) {
  const now = useNow(1000)

  // Heartbeat loss is measured on this browser's clock from when the last
  // heartbeat ARRIVED, so a skewed client clock can't raise a false alarm.
  const [beat, setBeat] = useState({ value: live.progressAt, receivedAt: now })
  if (beat.value !== live.progressAt) setBeat({ value: live.progressAt, receivedAt: now })

  if (backup.status === 'PENDING') {
    return <p className="text-xs text-gray-500">Queued — waiting for a free worker…</p>
  }

  const stage = live.stage
  if (!stage) {
    return <p className="text-xs text-gray-500">Starting…</p>
  }

  const dumping = stage === 'DUMPING'
  const hasEstimate = live.expectedBytes !== null && live.expectedBytes > 0
  const determinate = !dumping || hasEstimate
  const startedAt = backup.startedAt ? Date.parse(backup.startedAt) : null
  const elapsedMs = startedAt ? now - startedAt : null
  // Bytes and the time they were measured are both server-side, so the rate
  // isn't skewed by this browser's clock or by how stale the last update is
  const measuredMs = startedAt && live.bytesChangedAt ? Date.parse(live.bytesChangedAt) - startedAt : 0
  const rate = dumping && measuredMs > 3000 && live.bytesWritten > 0
    ? live.bytesWritten / (measuredMs / 1000)
    : null
  const remainingBytes = hasEstimate ? live.expectedBytes! - live.bytesWritten : null
  const etaMs = rate && remainingBytes !== null && remainingBytes > 0 ? (remainingBytes / rate) * 1000 : null

  // Both timestamps are server times, so this gap is immune to clock skew
  const noDataMs = dumping && live.progressAt && live.bytesChangedAt
    ? Date.parse(live.progressAt) - Date.parse(live.bytesChangedAt)
    : 0
  const heartbeatLostMs = live.progressAt ? now - beat.receivedAt : 0

  return (
    <div className="w-56 space-y-1">
      <div className="flex justify-between gap-2 text-xs text-gray-500">
        <span className="truncate">
          {STAGE_LABEL[stage]}
          {dumping && (
            <>
              {' · '}
              <span className="font-medium text-gray-700">{formatBytes(live.bytesWritten)}</span>
              {hasEstimate && <> of ~{formatBytes(live.expectedBytes!)}</>}
            </>
          )}
        </span>
        {determinate && <span>{live.progress}%</span>}
      </div>
      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
        {determinate ? (
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-500"
            style={{ width: `${live.progress}%` }}
          />
        ) : (
          <div className="h-full w-full bg-blue-400 rounded-full animate-pulse" />
        )}
      </div>
      <p className="text-[11px] text-gray-400">
        {elapsedMs !== null && <>Running {fmtDuration(elapsedMs)}</>}
        {rate !== null && <> · {formatBytes(rate)}/s</>}
        {etaMs !== null && <> · ~{fmtDuration(etaMs)} left</>}
        {dumping && !hasEstimate && <> · first backup, no size estimate yet</>}
      </p>
      {heartbeatLostMs > HEARTBEAT_LOST_MS ? (
        <p className="flex items-start gap-1 text-[11px] text-red-600">
          <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
          Worker hasn&apos;t reported for {fmtDuration(heartbeatLostMs)}. It may have stopped or restarted.
        </p>
      ) : noDataMs > NO_DATA_WARN_MS ? (
        <p className="flex items-start gap-1 text-[11px] text-amber-600">
          <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
          No new data for {fmtDuration(noDataMs)}. The database may be busy, locked, or the dump may be stuck.
        </p>
      ) : null}
    </div>
  )
}
