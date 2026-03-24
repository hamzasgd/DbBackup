import { CheckCircle2, XCircle, Loader2, Clock } from 'lucide-react'
import { Badge } from '../../../components/ui/Badge'
import type { Migration } from '../../../services/migrations.service'

function statusIcon(status: Migration['status']) {
  if (status === 'COMPLETED') return <CheckCircle2 className="h-4 w-4 text-green-500" />
  if (status === 'FAILED') return <XCircle className="h-4 w-4 text-red-500" />
  if (status === 'RUNNING') return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
  return <Clock className="h-4 w-4 text-gray-400" />
}

function statusBadge(status: Migration['status']) {
  const map: Record<Migration['status'], string> = {
    COMPLETED: 'bg-green-100 text-green-700',
    FAILED: 'bg-red-100 text-red-700',
    RUNNING: 'bg-blue-100 text-blue-700',
    PENDING: 'bg-gray-100 text-gray-600',
  }
  return map[status]
}

export function MigrationStatusIcon({ status }: { status: Migration['status'] }) {
  return statusIcon(status)
}

export function MigrationStatusBadge({ status }: { status: Migration['status'] }) {
  return <Badge className={statusBadge(status)}>{status}</Badge>
}

export { statusIcon, statusBadge }
