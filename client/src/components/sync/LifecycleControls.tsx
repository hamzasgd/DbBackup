import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Pause, Square, RefreshCw, Database } from 'lucide-react'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { syncApi } from '../../services/sync.service'
import { toast } from '../../store/toast.store'

interface LifecycleControlsProps {
  configId: string
  status: 'ACTIVE' | 'PAUSED' | 'FAILED' | 'STOPPED'
}

export function LifecycleControls({ configId, status }: LifecycleControlsProps) {
  const queryClient = useQueryClient()
  const [activationModalOpen, setActivationModalOpen] = useState(false)
  const [stopDialogOpen, setStopDialogOpen] = useState(false)
  const [performInitialSync, setPerformInitialSync] = useState(false)

  // Activate mutation
  const activateMutation = useMutation({
    mutationFn: () => syncApi.activate(configId, performInitialSync),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sync-configuration', configId] })
      queryClient.invalidateQueries({ queryKey: ['sync-state', configId] })
      toast.success('Sync activated')
      setActivationModalOpen(false)
    },
    onError: (error: any) => {
      const message = error.response?.data?.message || 'Failed to activate sync'
      toast.error(message)
    }
  })

  // Pause mutation
  const pauseMutation = useMutation({
    mutationFn: () => syncApi.pause(configId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sync-state', configId] })
      toast.success('Sync paused')
    },
    onError: (error: any) => {
      const message = error.response?.data?.message || 'Failed to pause sync'
      toast.error(message)
    }
  })

  // Resume mutation
  const resumeMutation = useMutation({
    mutationFn: () => syncApi.resume(configId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sync-state', configId] })
      toast.success('Sync resumed')
    },
    onError: (error: any) => {
      const message = error.response?.data?.message || 'Failed to resume sync'
      toast.error(message)
    }
  })

  // Stop mutation
  const stopMutation = useMutation({
    mutationFn: () => syncApi.stop(configId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sync-configuration', configId] })
      queryClient.invalidateQueries({ queryKey: ['sync-state', configId] })
      toast.success('Sync stopped')
      setStopDialogOpen(false)
    },
    onError: (error: any) => {
      const message = error.response?.data?.message || 'Failed to stop sync'
      toast.error(message)
    }
  })

  // Trigger manual sync mutation
  const triggerMutation = useMutation({
    mutationFn: () => syncApi.trigger(configId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sync-state', configId] })
      toast.success('Manual sync triggered')
    },
    onError: (error: any) => {
      const message = error.response?.data?.message || 'Failed to trigger sync'
      toast.error(message)
    }
  })

  // Trigger full sync mutation
  const fullSyncMutation = useMutation({
    mutationFn: () => syncApi.fullSync(configId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sync-state', configId] })
      toast.success('Full sync triggered')
    },
    onError: (error: any) => {
      const message = error.response?.data?.message || 'Failed to trigger full sync'
      toast.error(message)
    }
  })

  const handleActivateClick = () => {
    setActivationModalOpen(true)
  }

  const handleActivateConfirm = () => {
    activateMutation.mutate()
  }

  const handleStopClick = () => {
    setStopDialogOpen(true)
  }

  const handleStopConfirm = () => {
    stopMutation.mutate()
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {/* STOPPED: Activate, Delete */}
        {status === 'STOPPED' && (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={handleActivateClick}
              disabled={activateMutation.isPending}
              loading={activateMutation.isPending}
            >
              <Play className="h-4 w-4" />
              Activate
            </Button>
          </>
        )}

        {/* ACTIVE: Pause, Stop, Trigger Manual Sync, Trigger Full Sync */}
        {status === 'ACTIVE' && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => pauseMutation.mutate()}
              disabled={pauseMutation.isPending}
              loading={pauseMutation.isPending}
            >
              <Pause className="h-4 w-4" />
              Pause
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerMutation.mutate()}
              disabled={triggerMutation.isPending}
              loading={triggerMutation.isPending}
            >
              <RefreshCw className="h-4 w-4" />
              Trigger Manual Sync
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fullSyncMutation.mutate()}
              disabled={fullSyncMutation.isPending}
              loading={fullSyncMutation.isPending}
            >
              <Database className="h-4 w-4" />
              Trigger Full Sync
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleStopClick}
              disabled={stopMutation.isPending}
            >
              <Square className="h-4 w-4" />
              Stop
            </Button>
          </>
        )}

        {/* PAUSED: Resume, Stop */}
        {status === 'PAUSED' && (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={() => resumeMutation.mutate()}
              disabled={resumeMutation.isPending}
              loading={resumeMutation.isPending}
            >
              <Play className="h-4 w-4" />
              Resume
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleStopClick}
              disabled={stopMutation.isPending}
            >
              <Square className="h-4 w-4" />
              Stop
            </Button>
          </>
        )}

        {/* FAILED: Activate, Stop */}
        {status === 'FAILED' && (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={handleActivateClick}
              disabled={activateMutation.isPending}
              loading={activateMutation.isPending}
            >
              <Play className="h-4 w-4" />
              Activate
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleStopClick}
              disabled={stopMutation.isPending}
            >
              <Square className="h-4 w-4" />
              Stop
            </Button>
          </>
        )}
      </div>

      {/* Activation Modal */}
      <Modal
        open={activationModalOpen}
        onClose={() => setActivationModalOpen(false)}
        title="Activate Sync Configuration"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Would you like to perform an initial full sync to synchronize all existing data?
          </p>
          <div className="space-y-2">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="initialSync"
                checked={performInitialSync}
                onChange={() => setPerformInitialSync(true)}
                className="mt-0.5"
              />
              <div>
                <div className="text-sm font-medium text-gray-900">
                  Yes, perform initial full sync
                </div>
                <div className="text-xs text-gray-500">
                  Synchronize all existing data from source to target
                </div>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="initialSync"
                checked={!performInitialSync}
                onChange={() => setPerformInitialSync(false)}
                className="mt-0.5"
              />
              <div>
                <div className="text-sm font-medium text-gray-900">
                  No, only sync new changes
                </div>
                <div className="text-xs text-gray-500">
                  Start monitoring for new changes without syncing existing data
                </div>
              </div>
            </label>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActivationModalOpen(false)}
              disabled={activateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleActivateConfirm}
              loading={activateMutation.isPending}
            >
              Activate
            </Button>
          </div>
        </div>
      </Modal>

      {/* Stop Confirmation Dialog */}
      <ConfirmDialog
        open={stopDialogOpen}
        onClose={() => setStopDialogOpen(false)}
        onConfirm={handleStopConfirm}
        title="Stop Sync Configuration"
        description={
          <>
            Stopping this sync configuration will remove all sync state and history.
            This action cannot be undone. Are you sure you want to continue?
          </>
        }
        confirmLabel="Stop"
        variant="danger"
        loading={stopMutation.isPending}
      />
    </>
  )
}
