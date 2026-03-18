import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, Edit2, RefreshCw, ArrowRight, Database, AlertCircle, AlertTriangle } from 'lucide-react'
import { syncApi, type SyncConfiguration, type SyncState } from '../../services/sync.service'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { CardSkeleton } from '../../components/ui/Skeleton'
import { SyncStatusBadge } from '../../components/sync/SyncStatusBadge'
import { ProgressIndicator } from '../../components/sync/ProgressIndicator'
import { SyncConfigForm } from '../../components/sync/SyncConfigForm'

export default function SyncConfigurationsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  const { data: response, isLoading } = useQuery({
    queryKey: ['sync-configurations'],
    queryFn: () => syncApi.getAll(),
    refetchInterval: 5000 // Poll every 5 seconds to check for running syncs
  })
  const configurations = response?.data.data ?? []

  // Fetch sync states for all configurations to check if any are running
  const { data: statesData } = useQuery({
    queryKey: ['sync-states-all'],
    queryFn: async () => {
      const configs = response?.data.data ?? []
      const states = await Promise.all(
        configs.map((c: SyncConfiguration) => 
          syncApi.getState(c.id).then(res => ({ id: c.id, state: res.data.data }))
        )
      )
      return states
    },
    enabled: (response?.data.data?.length ?? 0) > 0,
    refetchInterval: 5000
  })

  // Fetch conflicts for all configurations to show warning icons
  const { data: conflictsData } = useQuery({
    queryKey: ['sync-conflicts-all'],
    queryFn: async () => {
      const configs = response?.data.data ?? []
      const conflicts = await Promise.all(
        configs.map((c: SyncConfiguration) => 
          syncApi.getConflicts(c.id).then(res => ({ id: c.id, count: res.data.data.length }))
        )
      )
      return conflicts
    },
    enabled: (response?.data.data?.length ?? 0) > 0,
    refetchInterval: 10000 // Poll every 10 seconds for conflicts
  })

  const getStateForConfig = (configId: string): SyncState | undefined => {
    return statesData?.find((s: { id: string; state: SyncState }) => s.id === configId)?.state
  }

  const getConflictsForConfig = (configId: string): number => {
    return conflictsData?.find((c: { id: string; count: number }) => c.id === configId)?.count ?? 0
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => syncApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sync-configurations'] })
      toast.success('Sync configuration deleted')
      setDeleteTarget(null)
    },
    onError: () => toast.error('Failed to delete sync configuration'),
  })

  const formatTimestamp = (timestamp?: string) => {
    if (!timestamp) return 'Never'
    return new Date(timestamp).toLocaleString()
  }

  const openCreate = () => {
    setEditId(null)
    setModalOpen(true)
  }

  const openEdit = (id: string) => {
    setEditId(id)
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setEditId(null)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sync Configurations</h1>
          <p className="text-gray-500 mt-1">Manage database synchronization configurations</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />New Sync Configuration
        </Button>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      )}

      {!isLoading && configurations.length === 0 && (
        <Card>
          <CardContent className="text-center py-16">
            <RefreshCw className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 font-medium">No sync configurations yet</p>
            <p className="text-gray-400 text-sm mt-1">Create your first sync configuration to get started</p>
            <Button onClick={openCreate} className="mt-4">
              <Plus className="h-4 w-4" />Add Sync Configuration
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {configurations.map((config: SyncConfiguration) => {
          const state = getStateForConfig(config.id)
          const isRunning = state?.status === 'RUNNING' || state?.status === 'PENDING'
          const conflictCount = getConflictsForConfig(config.id)
          const hasConflicts = conflictCount > 0
          const hasFailures = state && state.consecutiveFailures > 2
          
          return (
            <Card key={config.id} className="hover:shadow-md transition-shadow">
              <CardHeader>
                <div className="flex items-center gap-2 min-w-0">
                  <RefreshCw className="h-4 w-4 text-gray-400 shrink-0" />
                  <CardTitle className="truncate">{config.name}</CardTitle>
                  {hasConflicts && (
                    <div title={`${conflictCount} unresolved conflict${conflictCount !== 1 ? 's' : ''}`}>
                      <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
                    </div>
                  )}
                  {hasFailures && (
                    <div title={`${state.consecutiveFailures} consecutive failures`}>
                      <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                    </div>
                  )}
                </div>
                <SyncStatusBadge status={config.status} />
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm text-gray-500 space-y-2">
                  <div className="flex items-center gap-2">
                    <Database className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Source: {config.sourceConnectionId}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {config.direction === 'BIDIRECTIONAL' ? '↔' : '→'} {config.direction}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Database className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Target: {config.targetConnectionId}</span>
                  </div>
                </div>

                {isRunning && state && (
                  <div className="pt-2 border-t border-gray-50">
                    <ProgressIndicator 
                      configId={config.id} 
                      status={state.status}
                      mini={true}
                    />
                  </div>
                )}

                <div className="text-xs text-gray-400 pt-2 border-t border-gray-50">
                  <p>Last sync: {formatTimestamp(state?.lastSyncAt || config.updatedAt)}</p>
                </div>

                <div className="flex gap-2 pt-2 border-t border-gray-50">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate(`/sync/${config.id}`)}
                  >
                    View Details
                  </Button>
                  <Button 
                    size="sm" 
                    variant="ghost" 
                    onClick={() => openEdit(config.id)}
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-500 hover:text-red-700 hover:bg-red-50 ml-auto"
                    onClick={() => setDeleteTarget({ id: config.id, name: config.name })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { 
          if (deleteTarget) { 
            deleteMutation.mutate(deleteTarget.id)
          } 
        }}
        title="Delete Sync Configuration"
        description={
          <>
            Are you sure you want to delete <strong>{deleteTarget?.name}</strong>?
            <br /><br />
            This will permanently delete this sync configuration and all associated sync state, history, and conflicts. This action cannot be undone.
          </>
        }
        confirmLabel="Delete"
        variant="danger"
        loading={deleteMutation.isPending}
      />

      <SyncConfigForm 
        open={modalOpen}
        onClose={closeModal}
        editId={editId}
      />
    </div>
  )
}
