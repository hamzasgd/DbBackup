import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import axios from 'axios'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number | bigint): string {
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes
  if (n === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(k))
  return `${parseFloat((n / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(date))
}

export function dbTypeLabel(type: string): string {
  if (type === 'MONGODB') return 'MongoDB'
  if (type === 'REDIS') return 'Redis'
  const map: Record<string, string> = {
    MYSQL: 'MySQL',
    MARIADB: 'MariaDB',
    POSTGRESQL: 'PostgreSQL',
  }
  return map[type] ?? type
}

export function dbTypeBadgeColor(type: string): string {
  if (type === 'MONGODB') return 'bg-green-100 text-green-700'
  if (type === 'REDIS') return 'bg-red-100 text-red-700'
  const map: Record<string, string> = {
    MYSQL: 'bg-orange-100 text-orange-700',
    MARIADB: 'bg-blue-100 text-blue-700',
    POSTGRESQL: 'bg-indigo-100 text-indigo-700',
  }
  return map[type] ?? 'bg-gray-100 text-gray-700'
}

export function statusBadgeColor(status: string): string {
  const map: Record<string, string> = {
    PENDING: 'bg-yellow-100 text-yellow-700',
    RUNNING: 'bg-blue-100 text-blue-700',
    COMPLETED: 'bg-green-100 text-green-700',
    FAILED: 'bg-red-100 text-red-700',
  }
  return map[status] ?? 'bg-gray-100 text-gray-700'
}

/**
 * Message from an API error response, or `fallback` when there isn't one.
 * Handles both `{ message }` and the error handler's `{ error: { code, message } }`.
 */
export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: unknown; error?: { message?: unknown } } | undefined
    const message = data?.error?.message ?? data?.message
    if (typeof message === 'string' && message) return message
  }
  return fallback
}

/** "45s", "3m 20s", "2h 5m" */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
