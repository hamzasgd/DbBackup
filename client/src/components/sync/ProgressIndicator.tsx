import { useProgressSSE } from '../../hooks/useProgressSSE'
import { Clock, Database, CheckCircle, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'

interface ProgressIndicatorProps {
  configId: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  mini?: boolean
}

/**
 * **Validates: Requirements 7**
 * 
 * ProgressIndicator displays real-time sync progress using SSE updates.
 * 
 * Features:
 * - Subscribes to SSE when status is RUNNING or PENDING
 * - Displays progress bar, current table, tables completed/total
 * - Shows rows synced and elapsed time
 * - Mini mode for compact display on cards
 * - Completion status and error messages
 */
export function ProgressIndicator({ configId, status, mini = false }: ProgressIndicatorProps) {
  // Subscribe to SSE progress updates when sync is active
  const progress = useProgressSSE(
    `/sync/configurations/${configId}/progress`,
    status === 'RUNNING' || status === 'PENDING'
  )

  // Show nothing if not active and no progress data
  if (!progress && status !== 'RUNNING' && status !== 'PENDING') {
    return null
  }

  // Extract progress data with defaults
  const percentage = progress?.progress ?? 0
  const currentTable = progress?.currentTable
  const tablesCompleted = progress?.tablesCompleted ?? 0
  const tableCount = progress?.tableCount ?? 0
  const rowsSynced = progress?.rowsMigrated ?? 0
  const error = progress?.error

  // Calculate elapsed time from start (using a simple estimation based on progress)
  // Note: The backend SSE should ideally provide elapsedTime directly
  const formatElapsedTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return `${minutes}m ${remainingSeconds}s`
  }

  // Estimate elapsed time (this is a placeholder - backend should provide actual elapsed time)
  const estimatedElapsedSeconds = Math.floor(rowsSynced / 1000) // Rough estimate: 1000 rows per second

  // Mini mode for configuration cards
  if (mini) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-gray-600">
          <span className="truncate">{currentTable || 'Starting...'}</span>
          <span className="font-medium">{Math.round(percentage)}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-1.5">
          <div
            className={cn(
              'h-1.5 rounded-full transition-all duration-300',
              status === 'FAILED' ? 'bg-red-500' : 'bg-blue-500'
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>
    )
  }

  // Full mode for detail page
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">Sync Progress</h3>
        {status === 'COMPLETED' && (
          <div className="flex items-center gap-2 text-green-600">
            <CheckCircle className="h-5 w-5" />
            <span className="text-sm font-medium">Completed</span>
          </div>
        )}
        {status === 'FAILED' && (
          <div className="flex items-center gap-2 text-red-600">
            <XCircle className="h-5 w-5" />
            <span className="text-sm font-medium">Failed</span>
          </div>
        )}
      </div>

      {/* Progress Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">Progress</span>
          <span className="font-medium text-gray-900">{Math.round(percentage)}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2.5">
          <div
            className={cn(
              'h-2.5 rounded-full transition-all duration-300',
              status === 'FAILED' ? 'bg-red-500' : 
              status === 'COMPLETED' ? 'bg-green-500' : 
              'bg-blue-500'
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      {/* Current Table */}
      {currentTable && (
        <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg">
          <Database className="h-5 w-5 text-blue-600 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900">Current Table</p>
            <p className="text-sm text-gray-600 truncate">{currentTable}</p>
          </div>
        </div>
      )}

      {/* Statistics Grid */}
      <div className="grid grid-cols-2 gap-4">
        {/* Tables Progress */}
        <div className="space-y-1">
          <p className="text-xs text-gray-500">Tables</p>
          <p className="text-lg font-semibold text-gray-900">
            {tablesCompleted} / {tableCount}
          </p>
        </div>

        {/* Rows Synced */}
        <div className="space-y-1">
          <p className="text-xs text-gray-500">Rows Synced</p>
          <p className="text-lg font-semibold text-gray-900">
            {rowsSynced.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Elapsed Time */}
      {(status === 'RUNNING' || status === 'COMPLETED') && estimatedElapsedSeconds > 0 && (
        <div className="flex items-center gap-2 text-sm text-gray-600 pt-2 border-t border-gray-100">
          <Clock className="h-4 w-4" />
          <span>Elapsed: {formatElapsedTime(estimatedElapsedSeconds)}</span>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm font-medium text-red-900">Error</p>
          <p className="text-sm text-red-700 mt-1">{error}</p>
        </div>
      )}
    </div>
  )
}
