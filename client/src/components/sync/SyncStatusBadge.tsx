import { Badge } from '../ui/Badge'

interface SyncStatusBadgeProps {
  status: 'ACTIVE' | 'PAUSED' | 'FAILED' | 'STOPPED' | 'RUNNING' | 'PENDING'
}

const statusConfig = {
  ACTIVE: { label: 'Active', color: 'bg-green-100 text-green-700' },
  PAUSED: { label: 'Paused', color: 'bg-yellow-100 text-yellow-700' },
  FAILED: { label: 'Failed', color: 'bg-red-100 text-red-700' },
  STOPPED: { label: 'Stopped', color: 'bg-gray-100 text-gray-700' },
  RUNNING: { label: 'Running', color: 'bg-blue-100 text-blue-700' },
  PENDING: { label: 'Pending', color: 'bg-blue-100 text-blue-700' }
}

export function SyncStatusBadge({ status }: SyncStatusBadgeProps) {
  const config = statusConfig[status]
  
  return (
    <Badge className={config.color}>
      {config.label}
    </Badge>
  )
}
