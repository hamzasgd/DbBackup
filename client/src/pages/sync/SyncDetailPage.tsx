import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { 
  ArrowLeft, Database, ArrowRight, Clock, AlertCircle, 
  CheckCircle, RefreshCw, Activity 
} from 'lucide-react'
import { syncApi } from '../../services/sync.service'
import { SyncStatusBadge } from '../../components/sync/SyncStatusBadge'
import { ProgressIndicator } from '../../components/sync/ProgressIndicator'
import { LifecycleControls } from '../../components/sync/LifecycleControls'
import { SyncHistoryTable } from '../../components/sync/SyncHistoryTable'
import { ConflictResolutionModal } from '../../components/sync/ConflictResolutionModal'
import { SchemaComparisonModal } from '../../components/sync/SchemaComparisonModal'
import { Card, CardContent } from '../../components/ui/Card'
import { Skeleton } from '../../components/ui/Skeleton'

type TabType = 'overview' | 'history' | 'conflicts' | 'settings'

/**
 * **Validates: Requirements 5, 16**
 * 
 * SyncDetailPage displays detailed information about a sync configuration.
 * 
 * Features:
 * - React Router route setup using useParams to get config ID
 * - Fetch configuration and state data with React Query
 * - Polling for state when status is RUNNING (every 3 seconds)
 * - Header section with config details and status badge
 * - Statistics cards showing sync metrics
 * - Tab navigation for Overview, History, Conflicts, Settings
 * - Back button to configurations list
 */
export default function SyncDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<TabType>('overview')
  const [schemaModalOpen, setSchemaModalOpen] = useState(false)

  // Fetch configuration details
  const { data: configResponse, isLoading: configLoading } = useQuery({
    queryKey: ['sync-configuration', id],
    queryFn: () => syncApi.getOne(id!),
    enabled: !!id
  })
  const config = configResponse?.data.data

  // Fetch sync state with polling when running
  const { data: stateResponse, isLoading: stateLoading } = useQuery({
    queryKey: ['sync-state', id],
    queryFn: () => syncApi.getState(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      // Poll every 3 seconds if running
      const status = query.state.data?.data.data.status
      return status === 'RUNNING' ? 3000 : false
    }
  })
  const state = stateResponse?.data.data

  // Fetch conflicts for alert banner
  const { data: conflictsResponse } = useQuery({
    queryKey: ['sync-conflicts', id],
    queryFn: () => syncApi.getConflicts(id!),
    enabled: !!id
  })
  const conflicts = conflictsResponse?.data.data || []
  const hasUnresolvedConflicts = conflicts.length > 0

  const isLoading = configLoading || stateLoading

  const formatTimestamp = (timestamp?: string) => {
    if (!timestamp) return 'Never'
    return new Date(timestamp).toLocaleString()
  }

  const formatDuration = (seconds?: number) => {
    if (!seconds) return 'N/A'
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return `${minutes}m ${remainingSeconds}s`
  }

  const tabs: { id: TabType; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'history', label: 'History' },
    { 
      id: 'conflicts', 
      label: hasUnresolvedConflicts ? `Conflicts (${conflicts.length})` : 'Conflicts' 
    },
    { id: 'settings', label: 'Settings' }
  ]

  return (
    <div className="space-y-6">
      {/* Back button and header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate('/sync')}
          className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          title="Back to sync configurations"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          {isLoading ? (
            <Skeleton className="h-8 w-64" />
          ) : (
            <>
              <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                <RefreshCw className="h-6 w-6 text-blue-600" />
                {config?.name}
              </h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Sync Configuration Details
              </p>
            </>
          )}
        </div>
        {config && <SyncStatusBadge status={config.status} />}
      </div>

      {/* Configuration details header */}
      {isLoading ? (
        <Card>
          <CardContent className="p-6">
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </CardContent>
        </Card>
      ) : config ? (
        <Card>
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-gray-500 mb-1">Source Connection</p>
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-blue-500" />
                  <p className="font-medium text-gray-900 truncate">{config.sourceConnectionId}</p>
                </div>
              </div>
              <div>
                <p className="text-gray-500 mb-1">Target Connection</p>
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-blue-500" />
                  <p className="font-medium text-gray-900 truncate">{config.targetConnectionId}</p>
                </div>
              </div>
              <div>
                <p className="text-gray-500 mb-1">Direction</p>
                <div className="flex items-center gap-2">
                  <ArrowRight className="h-4 w-4 text-gray-400" />
                  <p className="font-medium text-gray-900">
                    {config.direction === 'BIDIRECTIONAL' ? '↔ Bidirectional' : '→ Unidirectional'}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-gray-500 mb-1">Mode</p>
                <p className="font-medium text-gray-900">{config.mode}</p>
              </div>
              <div>
                <p className="text-gray-500 mb-1">Conflict Strategy</p>
                <p className="font-medium text-gray-900">{config.conflictStrategy.replace(/_/g, ' ')}</p>
              </div>
              <div>
                <p className="text-gray-500 mb-1">Batch Size</p>
                <p className="font-medium text-gray-900">{config.batchSize.toLocaleString()}</p>
              </div>
              {config.cronExpression && (
                <div>
                  <p className="text-gray-500 mb-1">Schedule</p>
                  <p className="font-mono text-xs text-gray-900">{config.cronExpression}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Statistics cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-4 w-24 mb-2" />
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : state ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Total Rows Synced */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Total Rows Synced</p>
                <Activity className="h-4 w-4 text-blue-500" />
              </div>
              <p className="text-2xl font-bold text-gray-900">
                {state.totalRowsSynced.toLocaleString()}
              </p>
            </CardContent>
          </Card>

          {/* Consecutive Failures */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Consecutive Failures</p>
                {state.consecutiveFailures > 0 ? (
                  <AlertCircle className="h-4 w-4 text-red-500" />
                ) : (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                )}
              </div>
              <p className={`text-2xl font-bold ${state.consecutiveFailures > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {state.consecutiveFailures}
              </p>
            </CardContent>
          </Card>

          {/* Average Duration */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Avg Duration</p>
                <Clock className="h-4 w-4 text-purple-500" />
              </div>
              <p className="text-2xl font-bold text-gray-900">
                {formatDuration(state.averageDuration)}
              </p>
            </CardContent>
          </Card>

          {/* Last/Next Sync */}
          <Card>
            <CardContent className="p-6">
              <div className="mb-3">
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Last Sync</p>
                <p className="text-sm font-medium text-gray-900">
                  {formatTimestamp(state.lastSyncAt)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Next Sync</p>
                <p className="text-sm font-medium text-gray-900">
                  {formatTimestamp(state.nextSyncAt)}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Last Error Display */}
      {state?.lastError && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-red-900 mb-1">Last Error</p>
                <p className="text-sm text-red-700">{state.lastError}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Alert Banner for Unresolved Conflicts */}
      {hasUnresolvedConflicts && (
        <Card className="border-yellow-200 bg-yellow-50">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-yellow-900 mb-1">
                  {conflicts.length} Unresolved Conflict{conflicts.length !== 1 ? 's' : ''}
                </p>
                <p className="text-sm text-yellow-700">
                  Manual conflict resolution required. View the Conflicts tab to resolve.
                </p>
              </div>
              <button
                onClick={() => setActiveTab('conflicts')}
                className="px-3 py-1 text-xs font-medium text-yellow-700 hover:text-yellow-800 hover:bg-yellow-100 rounded transition-colors"
                aria-label="Go to conflicts tab"
              >
                View Conflicts
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Alert Banner for Consecutive Failures */}
      {state && state.consecutiveFailures > 2 && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-red-900 mb-1">
                  Multiple Consecutive Failures
                </p>
                <p className="text-sm text-red-700">
                  This sync has failed {state.consecutiveFailures} times in a row. Please review the error and configuration.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lifecycle Controls */}
      {config && (
        <Card>
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Lifecycle Controls</h3>
            <LifecycleControls configId={id!} status={config.status} />
          </CardContent>
        </Card>
      )}

      {/* Progress Indicator for Running Syncs */}
      {state?.status === 'RUNNING' || state?.status === 'PENDING' ? (
        <ProgressIndicator 
          configId={id!} 
          status={state.status}
          mini={false}
        />
      ) : null}

      {/* Tab Navigation */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-8" aria-label="Tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                py-4 px-1 border-b-2 font-medium text-sm transition-colors
                ${activeTab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }
              `}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="min-h-[400px]">
        {activeTab === 'overview' && (
          <Card>
            <CardContent className="p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Overview</h3>
              <div className="space-y-4 text-sm">
                <div>
                  <p className="text-gray-500 mb-2">Included Tables</p>
                  {config?.includedTables && config.includedTables.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {config.includedTables.map((table) => (
                        <span 
                          key={table}
                          className="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs font-mono"
                        >
                          {table}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-gray-400 italic">All tables</p>
                  )}
                </div>
                <div>
                  <p className="text-gray-500 mb-2">Excluded Tables</p>
                  {config?.excludedTables && config.excludedTables.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {config.excludedTables.map((table) => (
                        <span 
                          key={table}
                          className="px-2 py-1 bg-red-50 text-red-700 rounded text-xs font-mono"
                        >
                          {table}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-gray-400 italic">None</p>
                  )}
                </div>
                <div className="pt-4 border-t border-gray-100">
                  <p className="text-gray-500 mb-1">Created</p>
                  <p className="text-gray-900">{formatTimestamp(config?.createdAt)}</p>
                </div>
                <div>
                  <p className="text-gray-500 mb-1">Last Updated</p>
                  <p className="text-gray-900">{formatTimestamp(config?.updatedAt)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === 'history' && (
          <SyncHistoryTable configId={id!} />
        )}

        {activeTab === 'conflicts' && (
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Conflicts</h3>
            <ConflictResolutionModal configId={id!} />
          </div>
        )}

        {activeTab === 'settings' && (
          <Card>
            <CardContent className="p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Settings</h3>
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Schema Management</h4>
                  <p className="text-sm text-gray-500 mb-3">
                    Compare schemas between source and target databases to identify and fix schema drift
                  </p>
                  <button
                    onClick={() => setSchemaModalOpen(true)}
                    className="px-4 py-2 text-sm font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors border border-blue-200"
                  >
                    Compare Schemas
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Schema Comparison Modal */}
      <SchemaComparisonModal
        open={schemaModalOpen}
        onClose={() => setSchemaModalOpen(false)}
        configId={id!}
      />
    </div>
  )
}
