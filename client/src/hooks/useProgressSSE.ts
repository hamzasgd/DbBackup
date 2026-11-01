import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../store/auth.store'

export interface ProgressEvent {
  progress?: number
  status?: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PENDING'
  error?: string
  currentTable?: string
  tablesCompleted?: number
  tableCount?: number
  rowsMigrated?: number
  verified?: boolean
}

/**
 * Subscribe to SSE progress updates for a backup or migration.
 * @param url  The SSE endpoint, e.g. `/api/backups/:id/progress`
 * @param active  Only connect when true (job is RUNNING/PENDING)
 * @param onEvent  Optional callback run for every event (use it for side effects such as toasts)
 */
export function useProgressSSE(
  url: string | null,
  active: boolean,
  onEvent?: (event: ProgressEvent) => void,
): ProgressEvent | null {
  // The event is stored with the URL it came from, so a finished job's last event
  // is never returned for the next job.
  const [latest, setLatest] = useState<{ url: string; event: ProgressEvent } | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const onEventRef = useRef(onEvent)
  const token = useAuthStore((s) => s.accessToken)

  useEffect(() => {
    onEventRef.current = onEvent
  })

  useEffect(() => {
    if (!url || !active || !token) return

    // EventSource doesn't support custom headers, so we append token as query param
    const fullUrl = `/api${url}?token=${encodeURIComponent(token)}`
    const es = new EventSource(fullUrl)
    esRef.current = es

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as ProgressEvent
        setLatest({ url, event: data })
        onEventRef.current?.(data)
      } catch { /* ignore */ }
    }

    es.onerror = () => {
      es.close()
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [url, active, token])

  return latest && latest.url === url ? latest.event : null
}
