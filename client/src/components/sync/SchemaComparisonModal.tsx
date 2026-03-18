import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle, XCircle, AlertTriangle, Database, Table } from 'lucide-react'
import { syncApi } from '../../services/sync.service'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Card, CardContent } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { Skeleton } from '../ui/Skeleton'
import { toast } from '../../store/toast.store'

interface SchemaComparisonModalProps {
  open: boolean
  onClose: () => void
  configId: string
}

/**
 * **Validates: Requirements 10, 17**
 * 
 * SchemaComparisonModal compares schemas between source and target databases.
 * 
 * Features:
 * - Fetch schema comparison data with React Query
 * - Display overall compatibility status badge
 * - List missing tables in target database
 * - List column mismatches with table, column, source type, target type
 * - List type mismatches
 * - "Create Missing Tables" button when missing tables exist
 * - Empty state when schemas are compatible
 * - Loading state while fetching
 */
export function SchemaComparisonModal({ open, onClose, configId }: SchemaComparisonModalProps) {
  const queryClient = useQueryClient()

  const { data: comparisonResponse, isLoading } = useQuery({
    queryKey: ['schema-comparison', configId],
    queryFn: () => syncApi.getSchemaComparison(configId),
    enabled: open
  })

  const comparison = comparisonResponse?.data.data

  const createTablesMutation = useMutation({
    mutationFn: () => syncApi.createMissingTables(configId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schema-comparison', configId] })
      toast.success('Missing tables created successfully')
    },
    onError: (error: any) => {
      const message = error.response?.data?.message || 'Failed to create missing tables'
      toast.error(message)
    }
  })

  const handleCreateTables = () => {
    createTablesMutation.mutate()
  }

  return (
    <Modal open={open} onClose={onClose} title="Schema Comparison">
      <div className="space-y-6">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : comparison ? (
          <>
            {/* Overall Compatibility Status */}
            <Card className={comparison.compatible ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  {comparison.compatible ? (
                    <>
                      <CheckCircle className="h-6 w-6 text-green-600 shrink-0" />
                      <div>
                        <h3 className="text-sm font-semibold text-green-900">Schemas are compatible</h3>
                        <p className="text-xs text-green-700 mt-0.5">
                          No schema issues detected between source and target databases
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-6 w-6 text-red-600 shrink-0" />
                      <div>
                        <h3 className="text-sm font-semibold text-red-900">Schema incompatibility detected</h3>
                        <p className="text-xs text-red-700 mt-0.5">
                          Please review and resolve the issues below before syncing
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Missing Tables */}
            {comparison.missingTables.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Table className="h-5 w-5 text-yellow-600" />
                    <h4 className="text-sm font-semibold text-gray-900">
                      Missing Tables in Target ({comparison.missingTables.length})
                    </h4>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleCreateTables}
                    disabled={createTablesMutation.isPending}
                    aria-label="Create missing tables in target database"
                  >
                    {createTablesMutation.isPending ? 'Creating...' : 'Create Missing Tables'}
                  </Button>
                </div>
                <Card className="border-yellow-200 bg-yellow-50">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap gap-2">
                      {comparison.missingTables.map((table) => (
                        <Badge key={table} className="font-mono text-xs bg-yellow-100 text-yellow-700">
                          {table}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Column Mismatches */}
            {comparison.columnMismatches.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-orange-600" />
                  <h4 className="text-sm font-semibold text-gray-900">
                    Column Mismatches ({comparison.columnMismatches.length})
                  </h4>
                </div>
                <Card className="border-orange-200 bg-orange-50">
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-orange-100 border-b border-orange-200">
                          <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">
                              Table
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">
                              Column
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">
                              Source Type
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">
                              Target Type
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-orange-200">
                          {comparison.columnMismatches.map((mismatch, index) => (
                            <tr key={index} className="hover:bg-orange-100">
                              <td className="px-4 py-2 font-mono text-xs text-gray-900">
                                {mismatch.table}
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-gray-900">
                                {mismatch.column}
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-blue-700">
                                {mismatch.sourceType}
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-green-700">
                                {mismatch.targetType}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Type Mismatches */}
            {comparison.typeMismatches.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Database className="h-5 w-5 text-red-600" />
                  <h4 className="text-sm font-semibold text-gray-900">
                    Type Mismatches ({comparison.typeMismatches.length})
                  </h4>
                </div>
                <Card className="border-red-200 bg-red-50">
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-red-100 border-b border-red-200">
                          <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">
                              Table
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">
                              Column
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">
                              Source Type
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">
                              Target Type
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-red-200">
                          {comparison.typeMismatches.map((mismatch, index) => (
                            <tr key={index} className="hover:bg-red-100">
                              <td className="px-4 py-2 font-mono text-xs text-gray-900">
                                {mismatch.table}
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-gray-900">
                                {mismatch.column}
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-blue-700">
                                {mismatch.sourceType}
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-green-700">
                                {mismatch.targetType}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Close button */}
            <div className="flex justify-end pt-4 border-t border-gray-200">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
