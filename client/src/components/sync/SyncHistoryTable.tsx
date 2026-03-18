import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, CheckCircle, XCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { syncApi } from '../../services/sync.service'
import { Card, CardContent } from '../ui/Card'
import { Skeleton } from '../ui/Skeleton'
import { Badge } from '../ui/Badge'

interface SyncHistoryTableProps {
  configId: string
}

/**
 * **Validates: Requirements 8, 18, 19**
 * 
 * SyncHistoryTable displays past sync executions with statistics.
 * 
 * Features:
 * - Fetch history data with React Query
 * - Display in reverse chronological order (most recent first)
 * - Show start time, end time, duration, status, rows synced, conflicts detected
 * - Expandable error messages for failed syncs
 * - Pagination with "Load More" button
 * - Empty state when no history exists
 * - Loading skeleton while fetching
 */
export function SyncHistoryTable({ configId }: SyncHistoryTableProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [displayCount, setDisplayCount] = useState(10)

  const { data: historyResponse, isLoading } = useQuery({
    queryKey: ['sync-history', configId],
    queryFn: () => syncApi.getHistory(configId)
  })

  const history = historyResponse?.data.data || []
  const displayedHistory = history.slice(0, displayCount)
  const hasMore = history.length > displayCount

  const toggleExpanded = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString()
  }

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return `${minutes}m ${remainingSeconds}s`
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (history.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <Clock className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No sync history yet</h3>
          <p className="text-sm text-gray-500">
            Sync history will appear here after the first sync execution
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          {/* Desktop table view */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Start Time
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    End Time
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Rows Synced
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Conflicts
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {displayedHistory.map((entry) => {
                  const isExpanded = expandedRows.has(entry.id)
                  const hasError = entry.status === 'FAILED' && entry.errorMessage

                  return (
                    <tr key={entry.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {formatTimestamp(entry.startedAt)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {entry.completedAt ? formatTimestamp(entry.completedAt) : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {formatDuration(entry.duration)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {entry.status === 'COMPLETED' ? (
                          <Badge className="flex items-center gap-1 w-fit bg-green-100 text-green-700">
                            <CheckCircle className="h-3 w-3" />
                            Completed
                          </Badge>
                        ) : (
                          <Badge className="flex items-center gap-1 w-fit bg-red-100 text-red-700">
                            <XCircle className="h-3 w-3" />
                            Failed
                          </Badge>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                        {entry.rowsSynced.toLocaleString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                        {entry.conflictsDetected > 0 ? (
                          <span className="text-yellow-600 font-medium">
                            {entry.conflictsDetected}
                          </span>
                        ) : (
                          <span className="text-gray-400">0</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        {hasError && (
                          <button
                            onClick={() => toggleExpanded(entry.id)}
                            className="text-gray-400 hover:text-gray-600 transition-colors"
                            aria-label={isExpanded ? 'Hide error details' : 'Show error details'}
                          >
                            {isExpanded ? (
                              <ChevronUp className="h-5 w-5" />
                            ) : (
                              <ChevronDown className="h-5 w-5" />
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {/* Expanded error messages */}
            {displayedHistory.map((entry) => {
              const isExpanded = expandedRows.has(entry.id)
              if (!isExpanded || !entry.errorMessage) return null

              return (
                <div key={`error-${entry.id}`} className="px-6 py-4 bg-red-50 border-t border-red-100">
                  <p className="text-xs font-medium text-red-900 mb-1">Error Message:</p>
                  <p className="text-sm text-red-700 font-mono">{entry.errorMessage}</p>
                </div>
              )
            })}
          </div>

          {/* Mobile card view */}
          <div className="md:hidden divide-y divide-gray-200">
            {displayedHistory.map((entry) => {
              const isExpanded = expandedRows.has(entry.id)
              const hasError = entry.status === 'FAILED' && entry.errorMessage

              return (
                <div key={entry.id} className="p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">
                        {formatTimestamp(entry.startedAt)}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Duration: {formatDuration(entry.duration)}
                      </p>
                    </div>
                    {entry.status === 'COMPLETED' ? (
                      <Badge className="flex items-center gap-1 bg-green-100 text-green-700">
                        <CheckCircle className="h-3 w-3" />
                        Completed
                      </Badge>
                    ) : (
                      <Badge className="flex items-center gap-1 bg-red-100 text-red-700">
                        <XCircle className="h-3 w-3" />
                        Failed
                      </Badge>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-gray-500 text-xs">Rows Synced</p>
                      <p className="font-medium text-gray-900">{entry.rowsSynced.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-gray-500 text-xs">Conflicts</p>
                      <p className={`font-medium ${entry.conflictsDetected > 0 ? 'text-yellow-600' : 'text-gray-400'}`}>
                        {entry.conflictsDetected}
                      </p>
                    </div>
                  </div>

                  {hasError && (
                    <button
                      onClick={() => toggleExpanded(entry.id)}
                      className="flex items-center gap-2 text-sm text-red-600 hover:text-red-700 transition-colors"
                      aria-label={isExpanded ? 'Hide error details' : 'Show error details'}
                    >
                      {isExpanded ? (
                        <>
                          <ChevronUp className="h-4 w-4" />
                          Hide error
                        </>
                      ) : (
                        <>
                          <ChevronDown className="h-4 w-4" />
                          Show error
                        </>
                      )}
                    </button>
                  )}

                  {isExpanded && entry.errorMessage && (
                    <div className="p-3 bg-red-50 rounded-lg border border-red-100">
                      <p className="text-xs font-medium text-red-900 mb-1">Error Message:</p>
                      <p className="text-sm text-red-700 font-mono break-words">{entry.errorMessage}</p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Load More button */}
      {hasMore && (
        <div className="text-center">
          <button
            onClick={() => setDisplayCount(prev => prev + 10)}
            className="px-4 py-2 text-sm font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
          >
            Load More
          </button>
        </div>
      )}
    </div>
  )
}
