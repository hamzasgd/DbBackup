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
 */
export function useProgressSSE(url: string | null, active: boolean): ProgressEvent | null {
  const [event, setEvent] = useState<ProgressEvent | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const token = useAuthStore((s) => s.accessToken)

  useEffect(() => {
    if (!url || !active || !token) return

    // EventSource doesn't support custom headers, so we append token as query param
    const fullUrl = `/api${url}?token=${encodeURIComponent(token)}`
    const es = new EventSource(fullUrl)
    esRef.current = es

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as ProgressEvent
        setEvent(data)
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

  return event
}
