import type { Migration } from '../../../services/migrations.service'

export function durationLabel(m: Migration) {
  if (!m.startedAt) return '—'
  const end = m.completedAt ? new Date(m.completedAt) : new Date()
  const ms = end.getTime() - new Date(m.startedAt).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const min = Math.floor(s / 60)
  return `${min}m ${s % 60}s`
}

export function rowsLabel(rowsMigrated?: number) {
  if (rowsMigrated === -1) return 'N/A (stream mode)'
  return ((rowsMigrated ?? 0)).toLocaleString()
}
