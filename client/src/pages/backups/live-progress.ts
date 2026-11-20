import type { Backup, BackupStage } from '../../services/backups.service'
import type { ProgressEvent } from '../../hooks/useProgressSSE'

export interface LiveProgress {
  stage: BackupStage | null
  progress: number
  bytesWritten: number
  expectedBytes: number | null
  progressAt: string | null
  bytesChangedAt: string | null
}

/**
 * Freshest view of a running backup: the SSE stream when it is newer than the
 * polled row (the stream closes after a few minutes, the 5s poll keeps going).
 */
export function liveProgress(b: Backup, sse: ProgressEvent | null): LiveProgress {
  const fromRow: LiveProgress = {
    stage: b.stage ?? null,
    progress: b.progress,
    bytesWritten: b.bytesWritten ?? 0,
    expectedBytes: b.expectedBytes ?? null,
    progressAt: b.progressAt ?? null,
    bytesChangedAt: b.bytesChangedAt ?? null,
  }
  if (!sse?.at || (fromRow.progressAt && Date.parse(sse.at) < Date.parse(fromRow.progressAt))) return fromRow
  return {
    // Backup SSE only ever carries backup stages
    stage: (sse.stage as BackupStage | undefined) ?? fromRow.stage,
    progress: sse.progress ?? fromRow.progress,
    bytesWritten: sse.bytesWritten ?? fromRow.bytesWritten,
    expectedBytes: sse.expectedBytes ?? fromRow.expectedBytes,
    progressAt: sse.at,
    bytesChangedAt: sse.bytesChangedAt ?? fromRow.bytesChangedAt,
  }
}
