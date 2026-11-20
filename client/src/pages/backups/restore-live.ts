import type { RestoreRecord, RestoreStage } from '../../services/backups.service'
import type { ProgressEvent } from '../../hooks/useProgressSSE'

export function isActiveRestore(r: RestoreRecord): boolean {
  return r.status === 'PENDING' || r.status === 'RUNNING'
}

/** The row from the list, updated with a newer SSE event when there is one. */
export function liveRestore(r: RestoreRecord, sse: ProgressEvent | undefined): RestoreRecord {
  if (!isActiveRestore(r)) return r
  if (!sse || sse.status !== 'RUNNING' || !sse.at || !sse.stage) return r
  if (r.progressAt && Date.parse(sse.at) < Date.parse(r.progressAt)) return r
  return {
    ...r,
    status: 'RUNNING',
    stage: sse.stage as RestoreStage,
    bytesRead: sse.bytesRead ?? r.bytesRead,
    totalBytes: sse.totalBytes === undefined ? r.totalBytes : sse.totalBytes,
    stageStartedAt: sse.stageStartedAt ?? r.stageStartedAt,
    progressAt: sse.at,
  }
}
