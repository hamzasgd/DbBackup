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
/** Worker heartbeats every ~3s; this long without one (on the server's clock) → it has likely died. */
const HEARTBEAT_LOST_MS = 60_000

/** How current this page's data is: lets a stale tab tell "I can't see" from "the worker is silent". */
export interface Freshness {
  /** Server time of the last successful list response */
  serverTime: string | null
  /** Set when refreshing fails: when the page last had good data (ms epoch) */
  offlineSince: number | null
}
/** Speed is measured over this recent window, not since the start: the first
 * minute (connecting, schema, small tables) says little about the rest. */
const RATE_WINDOW_MS = 60_000
/** Need at least this much of the window before trusting the speed. */
const RATE_MIN_SPAN_MS = 20_000
/** No time-left guess before the dump has run this long. */
const ETA_MIN_ELAPSED_MS = 60_000

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

export function BackupLiveProgress({ backup, live, freshness }: { backup: Backup; live: LiveProgress; freshness: Freshness }) {
  const now = useNow(1000)

  // (server time, bytes) at every heartbeat; bytes are unchanged since the last
  // measurement, so each heartbeat is a valid sample and a stall reads as 0 B/s
  const [samples, setSamples] = useState<{ t: number; b: number }[]>([])
  const sampleT = live.stage === 'DUMPING' && live.progressAt ? Date.parse(live.progressAt) : null
  const lastSample = samples[samples.length - 1]
  if (sampleT !== null && (!lastSample || sampleT > lastSample.t)) {
    setSamples([...samples.filter((x) => x.t >= sampleT - RATE_WINDOW_MS), { t: sampleT, b: live.bytesWritten }])
  }

  if (backup.status === 'PENDING') {
    return <p className="text-xs text-gray-500">Queued — waiting for a free worker…</p>
  }

  const stage = live.stage
  if (!stage) {
    return <p className="text-xs text-gray-500">Starting…</p>
  }

  const dumping = stage === 'DUMPING'
  const hasEstimate = live.expectedBytes !== null && live.expectedBytes > 0
  // Bigger than last time: the estimate no longer means anything
  const overEstimate = dumping && hasEstimate && live.bytesWritten > live.expectedBytes!
  const determinate = !dumping || (hasEstimate && !overEstimate)
  // Same formula as the server (dump = 0-90%), but with a decimal while small
  // so a multi-hour dump doesn't sit at "0%"
  const pct = dumping && hasEstimate
    ? Math.min(90, (live.bytesWritten / live.expectedBytes!) * 90)
    : live.progress
  const pctLabel = pct < 10 ? pct.toFixed(1) : String(Math.floor(pct))
  const startedAt = backup.startedAt ? Date.parse(backup.startedAt) : null
  const elapsedMs = startedAt ? now - startedAt : null
  // Speed over the recent window (server timestamps: no clock skew). Until the
  // window has enough data, fall back to the average since the start.
  const first = samples[0]
  const last = samples[samples.length - 1]
  const span = first && last ? last.t - first.t : 0
  const measuredMs = startedAt && live.bytesChangedAt ? Date.parse(live.bytesChangedAt) - startedAt : 0
  const rate = !dumping
    ? null
    : span >= RATE_MIN_SPAN_MS
      ? (last.b - first.b) / (span / 1000)
      : measuredMs > 3000 && live.bytesWritten > 0
        ? live.bytesWritten / (measuredMs / 1000)
        : null
  const remainingBytes = hasEstimate && !overEstimate ? live.expectedBytes! - live.bytesWritten : null
  const etaMs = rate && span >= RATE_MIN_SPAN_MS && elapsedMs !== null && elapsedMs >= ETA_MIN_ELAPSED_MS &&
    remainingBytes !== null && remainingBytes > 0
    ? (remainingBytes / rate) * 1000
    : null
  const estimatingEta = dumping && hasEstimate && !overEstimate && etaMs === null && !(rate === 0)

  // Both timestamps are server times, so this gap is immune to clock skew
  const noDataMs = dumping && live.progressAt && live.bytesChangedAt
    ? Date.parse(live.progressAt) - Date.parse(live.bytesChangedAt)
    : 0
  // Worker silence is judged ONLY on server timestamps (the list response's
  // serverTime vs the last heartbeat), so a background tab or a sleeping laptop
  // that simply hasn't fetched in a while can't raise a false alarm
  const silentMs = freshness.serverTime && live.progressAt
    ? Math.max(0, Date.parse(freshness.serverTime) - Date.parse(live.progressAt))
    : 0
  const offline = freshness.offlineSince !== null
  const lost = !offline && silentMs > HEARTBEAT_LOST_MS
  // Speed and time left are leftovers when either side is out of touch
  const stale = lost || offline
  const fmtClock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const lastUpdate = live.progressAt ? fmtClock(Date.parse(live.progressAt)) : null

  return (
    <div className="w-56 space-y-1">
      <div className="flex justify-between gap-2 text-xs text-gray-500">
        <span className="truncate">
          {STAGE_LABEL[stage]}
          {dumping && (
            <>
              {' · '}
              <span className="font-medium text-gray-700">{formatBytes(live.bytesWritten)}</span>
              {hasEstimate && !overEstimate && <> of ~{formatBytes(live.expectedBytes!)}</>}
            </>
          )}
        </span>
        {determinate && <span>{pctLabel}%</span>}
      </div>
      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
        {determinate ? (
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        ) : overEstimate ? (
          <div className="h-full w-[90%] bg-blue-500 rounded-full animate-pulse" />
        ) : (
          <div className="h-full w-full bg-blue-400 rounded-full animate-pulse" />
        )}
      </div>
      <p className="text-[11px] text-gray-400">
        {elapsedMs !== null && <>Running {fmtDuration(elapsedMs)}</>}
        {!stale && rate !== null && <> · {formatBytes(rate)}/s</>}
        {!stale && etaMs !== null && <> · ~{fmtDuration(etaMs)} left</>}
        {!stale && estimatingEta && <> · estimating time…</>}
        {dumping && !hasEstimate && <> · first backup, no size estimate yet</>}
        {overEstimate && <> · already bigger than the last backup ({formatBytes(live.expectedBytes!)})</>}
      </p>
      {offline ? (
        <p className="flex items-start gap-1 text-[11px] text-gray-500">
          <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
          Can&apos;t reach the server since {fmtClock(freshness.offlineSince!)}. These numbers may be out of date.
        </p>
      ) : lost ? (
        <p className="flex items-start gap-1 text-[11px] text-red-600">
          <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
          No update since {lastUpdate} ({fmtDuration(silentMs)} ago). The app probably stopped or restarted;
          this backup will be marked failed.
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
