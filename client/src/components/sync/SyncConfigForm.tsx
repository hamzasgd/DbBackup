import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { syncApi, type SyncConfigFormData } from '../../services/sync.service'
import { connectionsApi } from '../../services/connections.service'
import { toast } from '../../store/toast.store'
import { Modal } from '../ui/Modal'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { Button } from '../ui/Button'

// Validation schema
const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  sourceConnectionId: z.string().min(1, 'Source connection is required'),
  targetConnectionId: z.string().min(1, 'Target connection is required'),
  direction: z.enum(['UNIDIRECTIONAL', 'BIDIRECTIONAL']),
  mode: z.enum(['REALTIME', 'SCHEDULED', 'MANUAL']),
  cronExpression: z.string().optional(),
  conflictStrategy: z.enum(['LAST_WRITE_WINS', 'SOURCE_WINS', 'TARGET_WINS', 'MANUAL']),
  includedTables: z.string(),
  excludedTables: z.string(),
  batchSize: z.coerce.number().int().min(1).max(10000).default(500)
}).refine(data => {
  if (data.mode === 'SCHEDULED' && !data.cronExpression) {
    return false
  }
  return true
}, {
  message: 'Cron expression required for scheduled mode',
  path: ['cronExpression']
}).refine(data => {
  return data.sourceConnectionId !== data.targetConnectionId
}, {
  message: 'Source and target must be different',
  path: ['targetConnectionId']
})

type FormData = z.infer<typeof schema>

interface SyncConfigFormProps {
  open: boolean
  onClose: () => void
  editId?: string | null
}

export function SyncConfigForm({ open, onClose, editId }: SyncConfigFormProps) {
  const qc = useQueryClient()

  // Fetch connections for dropdowns
  const { data: connectionsData } = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.getAll(),
    enabled: open
  })
  const connections = connectionsData?.data.data ?? []

  // Fetch existing configuration if editing
  const { data: configData } = useQuery({
    queryKey: ['sync-configuration', editId],
    queryFn: () => syncApi.getOne(editId!),
    enabled: !!editId && open
  })

  const { register, handleSubmit, reset, watch, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      direction: 'UNIDIRECTIONAL',
      mode: 'MANUAL',
      conflictStrategy: 'LAST_WRITE_WINS',
      includedTables: '',
      excludedTables: '',
      batchSize: 500
    }
  })

  const mode = watch('mode')
  const sourceConnectionId = watch('sourceConnectionId')

  // Load existing configuration data when editing
  useEffect(() => {
    if (configData?.data.data && open) {
      const config = configData.data.data
      reset({
        name: config.name,
        sourceConnectionId: config.sourceConnectionId,
        targetConnectionId: config.targetConnectionId,
        direction: config.direction,
        mode: config.mode,
        cronExpression: config.cronExpression || '',
        conflictStrategy: config.conflictStrategy,
        includedTables: config.includedTables.join(', '),
        excludedTables: config.excludedTables.join(', '),
        batchSize: config.batchSize
      })
    }
  }, [configData, open, reset])

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (data: SyncConfigFormData) => syncApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sync-configurations'] })
      toast.success('Sync configuration created')
      closeModal()
    },
    onError: (e: unknown) => {
      const message = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Failed to create configuration'
      toast.error(message)
    }
  })

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<SyncConfigFormData> }) => 
      syncApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sync-configurations'] })
      qc.invalidateQueries({ queryKey: ['sync-configuration', editId] })
      toast.success('Sync configuration updated')
      closeModal()
    },
    onError: () => {
      toast.error('Failed to update configuration')
    }
  })

  const closeModal = () => {
    onClose()
    reset()
  }

  const onSubmit = (data: FormData) => {
    // Transform form data to API format
    const payload: SyncConfigFormData = {
      ...data,
      includedTables: data.includedTables.trim() ? data.includedTables.split(',').map(t => t.trim()).filter(Boolean).join(',') : '',
      excludedTables: data.excludedTables.trim() ? data.excludedTables.split(',').map(t => t.trim()).filter(Boolean).join(',') : ''
    }

    if (editId) {
      updateMutation.mutate({ id: editId, data: payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  // Filter target connections to exclude source
  const targetConnections = connections.filter(c => c.id !== sourceConnectionId)

  return (
    <Modal 
      open={open} 
      onClose={closeModal} 
      title={editId ? 'Edit Sync Configuration' : 'New Sync Configuration'}
      className="max-w-2xl"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Input
          label="Configuration name"
          placeholder="My Sync Configuration"
          error={errors.name?.message}
          {...register('name')}
          required
        />

        <Select
          label="Source connection"
          options={[
            { label: 'Select source connection', value: '' },
            ...connections.map(c => ({ label: `${c.name} (${c.type})`, value: c.id }))
          ]}
          error={errors.sourceConnectionId?.message}
          {...register('sourceConnectionId')}
          required
        />

        <Select
          label="Target connection"
          options={[
            { label: 'Select target connection', value: '' },
            ...targetConnections.map(c => ({ label: `${c.name} (${c.type})`, value: c.id }))
          ]}
          error={errors.targetConnectionId?.message}
          {...register('targetConnectionId')}
          required
        />

        <Select
          label="Sync direction"
          options={[
            { label: 'Unidirectional (Source → Target)', value: 'UNIDIRECTIONAL' },
            { label: 'Bidirectional (Source ↔ Target)', value: 'BIDIRECTIONAL' }
          ]}
          {...register('direction')}
          required
        />

        <Select
          label="Sync mode"
          options={[
            { label: 'Manual', value: 'MANUAL' },
            { label: 'Real-time', value: 'REALTIME' },
            { label: 'Scheduled', value: 'SCHEDULED' }
          ]}
          {...register('mode')}
          required
        />

        {mode === 'SCHEDULED' && (
          <Input
            label="Cron expression"
            placeholder="0 0 * * *"
            hint="Example: 0 0 * * * (daily at midnight)"
            error={errors.cronExpression?.message}
            {...register('cronExpression')}
            required
          />
        )}

        <Select
          label="Conflict strategy"
          options={[
            { label: 'Last Write Wins', value: 'LAST_WRITE_WINS' },
            { label: 'Source Wins', value: 'SOURCE_WINS' },
            { label: 'Target Wins', value: 'TARGET_WINS' },
            { label: 'Manual Resolution', value: 'MANUAL' }
          ]}
          {...register('conflictStrategy')}
          required
        />

        <div>
          <label className="text-sm font-medium text-gray-700">
            Included tables
          </label>
          <textarea
            placeholder="table1, table2, table3 (leave empty for all tables)"
            rows={3}
            className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            {...register('includedTables')}
          />
          {errors.includedTables && (
            <p className="text-xs text-red-500 mt-1">{errors.includedTables.message}</p>
          )}
          <p className="text-xs text-gray-500 mt-1">Comma-separated list of table names</p>
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700">
            Excluded tables
          </label>
          <textarea
            placeholder="logs, temp_data (optional)"
            rows={3}
            className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            {...register('excludedTables')}
          />
          {errors.excludedTables && (
            <p className="text-xs text-red-500 mt-1">{errors.excludedTables.message}</p>
          )}
          <p className="text-xs text-gray-500 mt-1">Comma-separated list of table names to exclude</p>
        </div>

        <Input
          label="Batch size"
          type="number"
          placeholder="500"
          hint="Number of rows to sync per batch (1-10000)"
          error={errors.batchSize?.message}
          {...register('batchSize')}
          required
        />

        <div className="flex gap-2 pt-2 justify-end border-t border-gray-100">
          <Button type="button" variant="outline" onClick={closeModal}>
            Cancel
          </Button>
          <Button 
            type="submit" 
            loading={isSubmitting || createMutation.isPending || updateMutation.isPending}
          >
            {editId ? 'Save changes' : 'Create configuration'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
