import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Edit2, Clock, ToggleLeft, ToggleRight } from 'lucide-react'
import { schedulesApi } from '../../services/schedules.service'
import { connectionsApi } from '../../services/connections.service'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { formatDate, dbTypeLabel } from '../../lib/utils'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { CardSkeleton } from '../../components/ui/Skeleton'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

const schema = z.object({
  connectionId: z.string().min(1, 'Connection is required'),
  name: z.string().min(1, 'Name is required'),
  frequency: z.enum(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']),
  cronExpression: z.string().min(1, 'Cron expression is required'),
  retentionDays: z.coerce.number().int().min(1).max(365).default(30),
})
type FormData = z.infer<typeof schema>

const CRON_PRESETS: Record<string, string> = {
  HOURLY: '0 * * * *',
  DAILY: '0 2 * * *',
  WEEKLY: '0 2 * * 0',
  MONTHLY: '0 2 1 * *',
  CUSTOM: '',
}

export default function SchedulesPage() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const { data: schedulesData, isLoading } = useQuery({ queryKey: ['schedules'], queryFn: schedulesApi.getAll })
  const { data: connsData } = useQuery({ queryKey: ['connections'], queryFn: connectionsApi.getAll })
  const schedules = schedulesData?.data.data ?? []
  const connections = connsData?.data.data ?? []

  const { register, handleSubmit, reset, setValue, watch, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { frequency: 'DAILY', cronExpression: CRON_PRESETS.DAILY, retentionDays: 30 },
  })

  const frequency = watch('frequency')

  const createMutation = useMutation({
    mutationFn: schedulesApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedules'] }); toast.success('Schedule created'); closeModal() },
    onError: () => toast.error('Failed to create schedule'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<FormData> }) => schedulesApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedules'] }); toast.success('Schedule updated'); closeModal() },
    onError: () => toast.error('Failed to update schedule'),
  })

  const deleteMutation = useMutation({
    mutationFn: schedulesApi.delete,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedules'] }); toast.success('Schedule deleted') },
    onError: () => toast.error('Failed to delete'),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => schedulesApi.update(id, { isActive }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedules'] }); toast.success('Schedule updated') },
  })

  const closeModal = () => { setModalOpen(false); setEditId(null); reset() }

  const onSubmit = (data: FormData) => {
    if (editId) updateMutation.mutate({ id: editId, data })
    else createMutation.mutate(data)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Schedules</h1>
          <p className="text-gray-500 mt-1">Automate your database backups</p>
        </div>
        <Button onClick={() => { reset(); setEditId(null); setModalOpen(true) }}>
          <Plus className="h-4 w-4" />New Schedule
        </Button>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      )}

      {!isLoading && schedules.length === 0 && (
        <Card>
          <CardContent className="text-center py-16">
            <Clock className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 font-medium">No schedules yet</p>
            <p className="text-gray-400 text-sm mt-1">Set up automated backups on a schedule</p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {schedules.map((s) => (
          <Card key={s.id} className={!s.isActive ? 'opacity-60' : ''}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-gray-400" />
                <CardTitle>{s.name}</CardTitle>
              </div>
              <Badge className={s.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}>
                {s.isActive ? 'Active' : 'Paused'}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-sm text-gray-500 space-y-1">
                <p><span className="font-medium text-gray-700">Connection:</span> {s.connection?.name} ({dbTypeLabel(s.connection?.type ?? '')})</p>
                <p><span className="font-medium text-gray-700">Frequency:</span> {s.frequency}</p>
                <p><span className="font-medium text-gray-700">Cron:</span> <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">{s.cronExpression}</code></p>
                <p><span className="font-medium text-gray-700">Retention:</span> {s.retentionDays} days</p>
                {s.lastRunAt && <p><span className="font-medium text-gray-700">Last run:</span> {formatDate(s.lastRunAt)}</p>}
              </div>
              <div className="flex gap-2 pt-2 border-t border-gray-50">
                <Button size="sm" variant="ghost"
                  onClick={() => toggleMutation.mutate({ id: s.id, isActive: !s.isActive })}>
                  {s.isActive ? <ToggleRight className="h-4 w-4 text-green-500" /> : <ToggleLeft className="h-4 w-4" />}
                  {s.isActive ? 'Pause' : 'Resume'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditId(s.id); reset(s as unknown as FormData); setModalOpen(true) }}>
                  <Edit2 className="h-3.5 w-3.5" />Edit
                </Button>
                <Button size="sm" variant="ghost" className="text-red-500 hover:bg-red-50 ml-auto"
                  onClick={() => setDeleteTarget(s.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Modal open={modalOpen} onClose={closeModal} title={editId ? 'Edit Schedule' : 'New Schedule'}>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input label="Schedule name" placeholder="Nightly backup" error={errors.name?.message} {...register('name')} required />
          <Select
            label="Connection"
            options={connections.map((c) => ({ label: `${c.name} (${dbTypeLabel(c.type)})`, value: c.id }))}
            error={errors.connectionId?.message}
            {...register('connectionId')}
          />
          <Select
            label="Frequency"
            options={[
              { label: 'Hourly', value: 'HOURLY' },
              { label: 'Daily', value: 'DAILY' },
              { label: 'Weekly', value: 'WEEKLY' },
              { label: 'Monthly', value: 'MONTHLY' },
              { label: 'Custom', value: 'CUSTOM' },
            ]}
            {...register('frequency', {
              onChange: (e) => {
                if (e.target.value !== 'CUSTOM') setValue('cronExpression', CRON_PRESETS[e.target.value])
              }
            })}
          />
          <Input
            label="Cron expression"
            placeholder="0 2 * * *"
            hint={frequency !== 'CUSTOM' ? `Preset: ${CRON_PRESETS[frequency]}` : 'Enter a valid cron expression'}
            error={errors.cronExpression?.message}
            {...register('cronExpression')}
          />
          <Input label="Retention (days)" type="number" defaultValue={30} error={errors.retentionDays?.message} {...register('retentionDays')} />
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={closeModal}>Cancel</Button>
            <Button type="submit" loading={isSubmitting || createMutation.isPending || updateMutation.isPending}>
              {editId ? 'Save changes' : 'Create schedule'}
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget); setDeleteTarget(null) } }}
        title="Delete Schedule"
        description="This will permanently delete this schedule and stop all future backups."
        confirmLabel="Delete"
        variant="danger"
        loading={deleteMutation.isPending}
      />
    </div>
  )
}
