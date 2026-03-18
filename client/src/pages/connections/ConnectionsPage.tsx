import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, Edit2, Zap, Database, Shield, Network, Info } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { connectionsApi, type CreateConnectionPayload } from '../../services/connections.service'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { CardSkeleton } from '../../components/ui/Skeleton'
import { dbTypeLabel, dbTypeBadgeColor } from '../../lib/utils'

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(['MYSQL', 'MARIADB', 'POSTGRESQL']),
  host: z.string().min(1, 'Host is required'),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().min(1, 'Username is required'),
  password: z.string().optional(),
  database: z.string().min(1, 'Database name is required'),
  sslEnabled: z.boolean().default(false),
  sshEnabled: z.boolean().default(false),
  sshHost: z.string().optional().nullable(),
  sshPort: z.coerce.number().optional().nullable(),
  sshUsername: z.string().optional().nullable(),
  sshPrivateKey: z.string().optional().nullable(),
  sshPassphrase: z.string().optional().nullable(),
  connectionTimeout: z.coerce.number().optional().default(30000),
})
type FormData = z.infer<typeof schema>

const DEFAULT_PORTS: Record<string, number> = { MYSQL: 3306, MARIADB: 3306, POSTGRESQL: 5432 }

export default function ConnectionsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [showSSH, setShowSSH] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.getAll(),
  })
  const connections = data?.data.data ?? []

  const { register, handleSubmit, reset, setValue, watch, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'MYSQL', port: 3306, sslEnabled: false, sshEnabled: false },
  })

  const _dbType = watch('type')
  void _dbType
  const sshEnabled = watch('sshEnabled')

  const createMutation = useMutation({
    mutationFn: (d: CreateConnectionPayload) => connectionsApi.create(d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); toast.success('Connection created'); closeModal() },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to create'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CreateConnectionPayload> }) => connectionsApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); toast.success('Connection updated'); closeModal() },
    onError: () => toast.error('Failed to update connection'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => connectionsApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); toast.success('Connection deleted') },
    onError: () => toast.error('Failed to delete connection'),
  })

  const testMutation = useMutation({
    mutationFn: (id: string) => connectionsApi.test(id),
    onSuccess: (res) => {
      const { message, version } = res.data.data
      toast.success(message + (version ? ` (${version})` : ''))
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast.error(msg ?? 'Connection test failed')
    },
  })

  const closeModal = () => { setModalOpen(false); setEditId(null); reset(); setShowSSH(false) }
  const openCreate = () => { reset({ type: 'MYSQL', port: 3306 }); setEditId(null); setModalOpen(true) }

  const openEdit = (c: (typeof connections)[0]) => {
    setEditId(c.id)
    reset({ ...c, password: '' } as unknown as FormData)
    setShowSSH(!!c.sshEnabled)
    setModalOpen(true)
  }

  const onSubmit = (data: FormData) => {
    const payload: CreateConnectionPayload = { ...data }
    if (editId) updateMutation.mutate({ id: editId, data: payload })
    else createMutation.mutate(payload)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Connections</h1>
          <p className="text-gray-500 mt-1">Manage your database connections</p>
        </div>
        <Button onClick={openCreate}><Plus className="h-4 w-4" />New Connection</Button>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      )}

      {!isLoading && connections.length === 0 && (
        <Card>
          <CardContent className="text-center py-16">
            <Database className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 font-medium">No connections yet</p>
            <p className="text-gray-400 text-sm mt-1">Add your first database connection to get started</p>
            <Button onClick={openCreate} className="mt-4"><Plus className="h-4 w-4" />Add Connection</Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {connections.map((c) => (
          <Card key={c.id} className="hover:shadow-md transition-shadow">
            <CardHeader>
              <div className="flex items-center gap-2 min-w-0">
                <Database className="h-4 w-4 text-gray-400 shrink-0" />
                <CardTitle className="truncate">{c.name}</CardTitle>
              </div>
              <Badge className={dbTypeBadgeColor(c.type)}>{dbTypeLabel(c.type)}</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-sm text-gray-500 space-y-1">
                <p className="flex items-center gap-1.5"><Network className="h-3.5 w-3.5" />{c.host}:{c.port}</p>
                <p className="flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />{c.database}</p>
              </div>
              <div className="flex gap-1 flex-wrap">
                {c.sslEnabled && <Badge className="bg-green-100 text-green-700"><Shield className="h-3 w-3 mr-1" />SSL</Badge>}
                {c.sshEnabled && <Badge className="bg-purple-100 text-purple-700">SSH Tunnel</Badge>}
              </div>
              <div className="flex gap-2 pt-2 border-t border-gray-50">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => testMutation.mutate(c.id)}
                  loading={testMutation.isPending && testMutation.variables === c.id}
                >
                  <Zap className="h-3.5 w-3.5" />Test
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(`/connections/${c.id}/info`)}
                >
                  <Info className="h-3.5 w-3.5" />Info
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                  <Edit2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-500 hover:text-red-700 hover:bg-red-50 ml-auto"
                  onClick={() => setDeleteTarget(c.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Modal open={modalOpen} onClose={closeModal} title={editId ? 'Edit Connection' : 'New Connection'} className="max-w-xl">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input label="Connection name" placeholder="My MySQL DB" error={errors.name?.message} {...register('name')} required />

          <Select
            label="Database type"
            options={[
              { label: 'MySQL', value: 'MYSQL' },
              { label: 'MariaDB', value: 'MARIADB' },
              { label: 'PostgreSQL', value: 'POSTGRESQL' },
            ]}
            {...register('type', {
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                setValue('port', DEFAULT_PORTS[e.target.value] || 3306),
            })}
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <Input label="Host" placeholder="localhost or IP" error={errors.host?.message} {...register('host')} required />
            </div>
            <Input label="Port" type="number" error={errors.port?.message} {...register('port')} required />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Username" placeholder="root" error={errors.username?.message} {...register('username')} required />
            <Input label="Password" type="password" placeholder="••••••••" error={errors.password?.message} {...register('password')} required={!editId} />
          </div>

          <Input label="Database name" placeholder="my_database" error={errors.database?.message} {...register('database')} required />

          <Input label="Connection Timeout (ms)" type="number" placeholder="30000" error={errors.connectionTimeout?.message} {...register('connectionTimeout')} />

          <div className="flex items-center gap-2">
            <input type="checkbox" id="sslEnabled" {...register('sslEnabled')} className="rounded" />
            <label htmlFor="sslEnabled" className="text-sm text-gray-700">Enable SSL</label>
          </div>

          <div className="border-t pt-3">
            <button
              type="button"
              className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
              onClick={() => setShowSSH(!showSSH)}
            >
              <Network className="h-4 w-4" />
              SSH Tunnel {showSSH ? '▲' : '▼'}
            </button>

            {showSSH && (
              <div className="mt-3 space-y-3 pl-4 border-l-2 border-blue-100">
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="sshEnabledTunnel" {...register('sshEnabled')} className="rounded" />
                  <label htmlFor="sshEnabledTunnel" className="text-sm text-gray-700">Enable SSH tunnel</label>
                </div>
                {sshEnabled && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <Input label="SSH Host" placeholder="bastion.example.com" {...register('sshHost')} />
                      </div>
                      <Input label="SSH Port" type="number" defaultValue={22} {...register('sshPort')} />
                    </div>
                    <Input label="SSH Username" placeholder="ubuntu" {...register('sshUsername')} />
                    <div>
                      <label className="text-sm font-medium text-gray-700">SSH Private Key</label>
                      <textarea
                        rows={4}
                        placeholder="-----BEGIN RSA PRIVATE KEY-----"
                        className="mt-1 w-full px-3 py-2 text-xs font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        {...register('sshPrivateKey')}
                      />
                    </div>
                    <Input label="Key passphrase (optional)" type="password" {...register('sshPassphrase')} />
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-2 justify-end">
            <Button type="button" variant="outline" onClick={closeModal}>Cancel</Button>
            <Button type="submit" loading={isSubmitting || createMutation.isPending || updateMutation.isPending}>
              {editId ? 'Save changes' : 'Create connection'}
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget); setDeleteTarget(null) } }}
        title="Delete Connection"
        description="This will permanently delete this connection and cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        loading={deleteMutation.isPending}
      />
    </div>
  )
}
