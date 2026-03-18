import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Database, Clock, CheckCircle } from 'lucide-react'
import { syncApi, type SyncConflict } from '../../services/sync.service'
import { Modal } from '../ui/Modal'
import { Card, CardContent } from '../ui/Card'
import { Button } from '../ui/Button'
import { Skeleton } from '../ui/Skeleton'
import { toast } from '../../store/toast.store'

interface ConflictResolutionModalProps {
  configId: string
}

/**
 * **Validates: Requirements 9, 17, 19**
 * 
 * ConflictResolutionModal displays and resolves data conflicts.
 * 
 * Features:
 * - Fetch conflicts with React Query
 * - Display table with table name, primary key values, conflict timestamp
 * - View Details button for each conflict
 * - Side-by-side comparison of source and target data
 * - Modification timestamps for both versions
 * - "Use Source" and "Use Target" resolution buttons
 * - Empty state when no conflicts exist
 * - Responsive design (stacks vertically on mobile)
 */
export function ConflictResolutionModal({ configId }: ConflictResolutionModalProps) {
  const [selectedConflict, setSelectedConflict] = useState<SyncConflict | null>(null)
  const queryClient = useQueryClient()

  const { data: conflictsResponse, isLoading } = useQuery({
    queryKey: ['sync-conflicts', configId],
    queryFn: () => syncApi.getConflicts(configId)
  })

  const conflicts = conflictsResponse?.data.data || []

  const resolveMutation = useMutation({
    mutationFn: ({ conflictId, resolution }: { conflictId: string; resolution: 'SOURCE' | 'TARGET' }) =>
      syncApi.resolveConflict(conflictId, resolution),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sync-conflicts', configId] })
      queryClient.invalidateQueries({ queryKey: ['sync-history', configId] })
      toast.success('Conflict resolved')
      setSelectedConflict(null)
    },
    onError: (error: any) => {
      const message = error.response?.data?.message || 'Failed to resolve conflict'
      toast.error(message)
    }
  })

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString()
  }

  const formatPrimaryKey = (pkValues: Record<string, unknown>) => {
    return Object.entries(pkValues)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ')
  }

  const formatData = (data: Record<string, unknown>) => {
    return JSON.stringify(data, null, 2)
  }

  const handleResolve = (resolution: 'SOURCE' | 'TARGET') => {
    if (!selectedConflict) return
    resolveMutation.mutate({ conflictId: selectedConflict.id, resolution })
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    )
  }

  if (conflicts.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No conflicts to resolve</h3>
          <p className="text-sm text-gray-500">
            All data is synchronized without conflicts
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <div className="space-y-4">
        {conflicts.map((conflict) => (
          <Card key={conflict.id} className="border-yellow-200 bg-yellow-50">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 shrink-0" />
                    <h4 className="text-sm font-semibold text-gray-900">
                      Conflict in table: <span className="font-mono">{conflict.tableName}</span>
                    </h4>
                  </div>
                  <div className="space-y-1 text-sm">
                    <p className="text-gray-600">
                      <span className="font-medium">Primary Key:</span>{' '}
                      <span className="font-mono text-xs">{formatPrimaryKey(conflict.primaryKeyValues)}</span>
                    </p>
                    <p className="text-gray-600">
                      <span className="font-medium">Detected:</span> {formatTimestamp(conflict.detectedAt)}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedConflict(conflict)}
                  aria-label="View conflict details"
                >
                  View Details
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Conflict Detail Modal */}
      <Modal
        open={!!selectedConflict}
        onClose={() => setSelectedConflict(null)}
        title="Resolve Conflict"
      >
        {selectedConflict && (
          <div className="space-y-6">
            {/* Conflict Info */}
            <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-gray-500" />
                <span className="font-medium text-gray-700">Table:</span>
                <span className="font-mono text-gray-900">{selectedConflict.tableName}</span>
              </div>
              <div>
                <span className="font-medium text-gray-700">Primary Key:</span>{' '}
                <span className="font-mono text-xs text-gray-900">
                  {formatPrimaryKey(selectedConflict.primaryKeyValues)}
                </span>
              </div>
            </div>

            {/* Side-by-side comparison */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Source Data */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-gray-900">Source Data</h4>
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Clock className="h-3 w-3" />
                    {formatTimestamp(selectedConflict.sourceModifiedAt)}
                  </div>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 overflow-auto max-h-96">
                  <pre className="text-xs font-mono text-gray-900 whitespace-pre-wrap break-words">
                    {formatData(selectedConflict.sourceData)}
                  </pre>
                </div>
                <Button
                  variant="primary"
                  className="w-full"
                  onClick={() => handleResolve('SOURCE')}
                  disabled={resolveMutation.isPending}
                  aria-label="Use source data to resolve conflict"
                >
                  Use Source
                </Button>
              </div>

              {/* Target Data */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-gray-900">Target Data</h4>
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Clock className="h-3 w-3" />
                    {formatTimestamp(selectedConflict.targetModifiedAt)}
                  </div>
                </div>
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 overflow-auto max-h-96">
                  <pre className="text-xs font-mono text-gray-900 whitespace-pre-wrap break-words">
                    {formatData(selectedConflict.targetData)}
                  </pre>
                </div>
                <Button
                  variant="primary"
                  className="w-full"
                  onClick={() => handleResolve('TARGET')}
                  disabled={resolveMutation.isPending}
                  aria-label="Use target data to resolve conflict"
                >
                  Use Target
                </Button>
              </div>
            </div>

            {/* Cancel button */}
            <div className="flex justify-end pt-4 border-t border-gray-200">
              <Button
                variant="outline"
                onClick={() => setSelectedConflict(null)}
                disabled={resolveMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
