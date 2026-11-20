import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, Edit2, Zap, Database, Shield, Network, Info, Lock } from 'lucide-react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { connectionsApi, type CreateConnectionPayload } from '../../services/connections.service'
import { useAuthStore } from '../../store/auth.store'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { CardSkeleton } from '../../components/ui/Skeleton'
import { dbTypeLabel, dbTypeBadgeColor, getApiErrorMessage } from '../../lib/utils'

/** A number box: empty (or not a number) → undefined. z.coerce would turn "" into 0. */
const numberOrEmpty = (v: unknown) =>
  v === '' || v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? undefined : Number(v)

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(['MYSQL', 'MARIADB', 'POSTGRESQL', 'MONGODB', 'REDIS']),
  host: z.string().min(1, 'Host is required'),
  port: z.preprocess(numberOrEmpty, z.number({ error: 'Port is required' }).int('Whole number').min(1, 'Port must be 1–65535').max(65535, 'Port must be 1–65535')),
  username: z.string().min(1, 'Username is required'),
  password: z.string().optional(),
  database: z.string().min(1, 'Database name is required'),
  sslEnabled: z.boolean().default(false),
  sslCa: z.string().optional().nullable(),
  sslCert: z.string().optional().nullable(),
  sslKey: z.string().optional().nullable(),
  sshEnabled: z.boolean().default(false),
  heartbeatEnabled: z.boolean().default(false),
  compressTraffic: z.boolean().default(false),
  writeProtected: z.boolean().default(false),
  // Empty box = watchdog off (null). Not z.coerce: it turns "" into 0, which failed "> 0"
  // and silently blocked every save once the field was on screen
  expectedBackupHours: z.preprocess(
    (v) => (v === '' || v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? null : Number(v)),
    z.number({ error: 'Enter a number of hours' }).int('Whole hours only').min(1, 'At least 1 hour').max(8760, 'At most 8760 hours (a year)').nullable(),
  ).optional(),
  sshHost: z.string().optional().nullable(),
  sshPort: z.preprocess((v) => numberOrEmpty(v) ?? 22, z.number().int('Whole number').min(1, 'SSH port must be 1–65535').max(65535, 'SSH port must be 1–65535')),
  sshUsername: z.string().optional().nullable(),
  sshPrivateKey: z.string().optional().nullable(),
  sshPrivateKeyPath: z.string().optional().nullable(),
  sshPassphrase: z.string().optional().nullable(),
  connectionTimeout: z.preprocess((v) => numberOrEmpty(v) ?? 30000, z.number().int('Whole milliseconds').min(1000, 'Timeout: at least 1000 ms').max(600000, 'Timeout: at most 600000 ms')),
})
type FormData = z.output<typeof schema>
type FormInput = z.input<typeof schema>

const DEFAULT_PORTS: Record<string, number> = { MYSQL: 3306, MARIADB: 3306, POSTGRESQL: 5432 }

export default function ConnectionsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [showSSH, setShowSSH] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const me = useAuthStore((st) => st.user)
  const { data, isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.getAll(),
  })
  const connections = data?.data.data ?? []

  const { register, handleSubmit, reset, setValue, control, formState: { errors, isSubmitting } } = useForm<FormInput, unknown, FormData>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'MYSQL', port: 3306, sslEnabled: false, sshEnabled: false, heartbeatEnabled: false, compressTraffic: false, writeProtected: false },
  })

  const sshEnabled = useWatch({ control, name: 'sshEnabled' })
  const connType = useWatch({ control, name: 'type' })
  const sslEnabled = useWatch({ control, name: 'sslEnabled' })
  const sslCa = useWatch({ control, name: 'sslCa' })
  const editing = editId ? connections.find((c) => c.id === editId) : undefined

  const resetHostKeyMutation = useMutation({
    mutationFn: (id: string) => connectionsApi.resetSshHostKey(id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['connections'] })
      toast.success(res.data.message)
    },
    onError: () => toast.error('Failed to forget the SSH host key'),
  })

  const createMutation = useMutation({
    mutationFn: (d: CreateConnectionPayload) => connectionsApi.create(d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); toast.success('Connection created'); closeModal() },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Failed to create connection')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CreateConnectionPayload> }) => connectionsApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); toast.success('Connection updated'); closeModal() },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Failed to update connection')),
  })

  const deleteMutation = useMutation({
    mutationFn: ({ id, deleteBackups }: { id: string; deleteBackups: boolean }) => connectionsApi.delete(id, deleteBackups),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] })
      qc.invalidateQueries({ queryKey: ['backups'] })
      toast.success('Connection deleted')
    },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Failed to delete connection')),
  })

  const testMutation = useMutation({
    mutationFn: (id: string) => connectionsApi.test(id),
    onSuccess: (res) => {
      const { message, version, warning } = res.data.data
      toast.success(message + (version ? ` (${version})` : ''))
      if (warning) toast.warning(warning)
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
    reset({ ...c, password: '', sslKey: '' } as unknown as FormData)
    setShowSSH(!!c.sshEnabled)
    setModalOpen(true)
  }

  const onSubmit = (data: FormData) => {
    // Fields the server returned as null (no key path, no CA, ...) mean "not set":
    // send them as absent, which the API reads as "keep as is" (it rejects null).
    // The watchdog is the exception: null is how an emptied box turns it off.
    const payload = Object.fromEntries(
      Object.entries(data).filter(([k, v]) => v !== null || k === 'expectedBackupHours'),
    ) as unknown as CreateConnectionPayload
    if (editId) updateMutation.mutate({ id: editId, data: payload })
    else createMutation.mutate(payload)
  }

  // A field that fails validation may be in the collapsed SSH section: never fail silently
  const SSH_FIELDS = ['sshHost', 'sshPort', 'sshUsername', 'sshPrivateKey', 'sshPrivateKeyPath', 'sshPassphrase']
  const onInvalid = (errs: Record<string, { message?: string } | undefined>) => {
    if (Object.keys(errs).some((k) => SSH_FIELDS.includes(k))) setShowSSH(true)
    const first = Object.entries(errs).find(([, e]) => e?.message)
    toast.error(first ? `Check the form: ${first[1]!.message}` : 'Check the highlighted fields')
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Connections</h1>
          <p className="text-gray-500 mt-1">
            Manage your database connections
            {me?.connectionLimit != null && <span className="ml-2 text-xs text-gray-400">({connections.length} / {me.connectionLimit} used)</span>}
          </p>
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
                {c.heartbeatEnabled && (
                  <p className="flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${c.latestHeartbeat?.status === 'UP' ? 'bg-green-500' : c.latestHeartbeat?.status === 'DOWN' ? 'bg-red-500' : 'bg-gray-300'}`} />
                    <span className={c.latestHeartbeat?.status === 'UP' ? 'text-green-600' : c.latestHeartbeat?.status === 'DOWN' ? 'text-red-600' : 'text-gray-400'}>
                      {c.latestHeartbeat?.status === 'UP'
                        ? `Up · ${c.latestHeartbeat.latencyMs ?? '?'} ms`
                        : c.latestHeartbeat?.status === 'DOWN' ? 'Down' : 'No check yet'}
                    </span>
                  </p>
                )}
              </div>
              <div className="flex gap-1 flex-wrap">
                {c.sslEnabled && <Badge className="bg-green-100 text-green-700"><Shield className="h-3 w-3 mr-1" />SSL</Badge>}
                {c.sshEnabled && <Badge className="bg-purple-100 text-purple-700">SSH Tunnel</Badge>}
                {c.writeProtected && (
                  <Badge className="bg-amber-100 text-amber-800">
                    <Lock className="h-3 w-3 mr-1" />Write-protected
                  </Badge>
                )}
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
                  disabled={!!c.writeProtected}
                  title={c.writeProtected ? 'Write-protected: turn protection off in the connection settings to delete it' : 'Delete connection'}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Modal open={modalOpen} onClose={closeModal} title={editId ? 'Edit Connection' : 'New Connection'} className="max-w-xl">
        <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="space-y-4">
          <Input label="Connection name" placeholder="My MySQL DB" error={errors.name?.message} {...register('name')} required />

          <Select
            label="Database type"
            options={[
              { label: 'MySQL', value: 'MYSQL' },
              { label: 'MariaDB', value: 'MARIADB' },
              { label: 'PostgreSQL', value: 'POSTGRESQL' },
              { label: 'MongoDB', value: 'MONGODB' },
              { label: 'Redis', value: 'REDIS' },
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
            <Input label={editId ? 'Password (leave blank to keep current)' : 'Password'} type="password" placeholder="••••••••" error={errors.password?.message} {...register('password')} required={!editId} />
          </div>

          <Input label="Database name" placeholder="my_database" error={errors.database?.message} {...register('database')} required />

          <Input label="Connection Timeout (ms)" type="number" placeholder="30000 (default)" error={errors.connectionTimeout?.message} {...register('connectionTimeout')} />

          <div className="flex items-center gap-2">
            <input type="checkbox" id="sslEnabled" {...register('sslEnabled')} className="rounded" />
            <label htmlFor="sslEnabled" className="text-sm text-gray-700">Enable SSL</label>
          </div>

          {sslEnabled && (
            <div className="space-y-3 pl-4 border-l-2 border-green-100">
              <div>
                <label htmlFor="sslCa" className="text-sm font-medium text-gray-700">CA certificate (PEM)</label>
                <textarea
                  id="sslCa"
                  rows={3}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  className="mt-1 w-full px-3 py-2 text-xs font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  {...register('sslCa')}
                />
                {sslCa?.trim() ? (
                  <p className="text-xs text-green-700 mt-1">
                    The server certificate is verified against this CA, including the host name.
                  </p>
                ) : (
                  <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-1 mt-1">
                    ⚠ Without a CA certificate the connection is encrypted, but the server&apos;s identity is not checked,
                    so someone in the middle could read the traffic. Paste your provider&apos;s CA certificate to verify it.
                  </p>
                )}
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-gray-600">Client certificate (mutual TLS, optional)</summary>
                <div className="mt-2 space-y-2">
                  <textarea
                    rows={3}
                    aria-label="Client certificate (PEM)"
                    placeholder="Client certificate: -----BEGIN CERTIFICATE-----"
                    className="w-full px-3 py-2 text-xs font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    {...register('sslCert')}
                  />
                  <textarea
                    rows={3}
                    aria-label="Client private key (PEM)"
                    placeholder={editing?.hasSslKey ? 'Leave empty to keep the saved key' : 'Client key: -----BEGIN PRIVATE KEY-----'}
                    className="w-full px-3 py-2 text-xs font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    {...register('sslKey')}
                  />
                </div>
              </details>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
            <input type="checkbox" id="writeProtectedChk" {...register('writeProtected')} className="rounded mt-0.5" />
            <label htmlFor="writeProtectedChk" className="text-sm text-gray-700">
              <span className="inline-flex items-center gap-1 font-medium"><Lock className="h-3.5 w-3.5" />Write-protected</span>{' '}
              <span className="text-gray-500">
                (for production databases: DbBackup will never restore, sync or migrate data into this database, and the
                connection can't be deleted. Backups, Compare and using it as a source still work. Restore tests use a
                separate temporary database.)
              </span>
            </label>
          </div>

          {(connType === 'MYSQL' || connType === 'MARIADB') && (
            <div className="flex items-start gap-2">
              <input type="checkbox" id="compressTrafficChk" {...register('compressTraffic')} className="rounded mt-0.5" />
              <label htmlFor="compressTrafficChk" className="text-sm text-gray-700">
                Compress traffic{' '}
                <span className="text-gray-400">
                  (backups and restores send compressed data over the network; faster on slow or remote links,
                  uses more CPU on the database server; the backup file is identical)
                </span>
              </label>
            </div>
          )}

          <div className="border-t pt-3 space-y-3">
            <p className="text-sm font-medium text-gray-700">Monitoring</p>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="heartbeatEnabledChk" {...register('heartbeatEnabled')} className="rounded" />
              <label htmlFor="heartbeatEnabledChk" className="text-sm text-gray-700">
                Heartbeat monitoring <span className="text-gray-400">(health check every 5 min, alerts on down/recovery)</span>
              </label>
            </div>
            <div>
              <Input
                label="Missed-backup watchdog (hours, optional)"
                type="number"
                placeholder="Empty = off. e.g. 26: alert if no successful backup within 26 hours"
                error={errors.expectedBackupHours?.message}
                {...register('expectedBackupHours')}
              />
              <p className="text-xs text-gray-400 mt-1">
                Alerts when a scheduled backup is missed (⏰ dead-man switch — works even if the app was down). Leave empty to turn it off.
              </p>
            </div>
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
                      <Input label="SSH Port" type="number" placeholder="22" error={errors.sshPort?.message} {...register("sshPort")} />
                    </div>
                    <Input label="SSH Username" placeholder="ubuntu" {...register('sshUsername')} />
                    <div>
                      <label className="text-sm font-medium text-gray-700">SSH Private Key</label>
                      <textarea
                        rows={4}
                        placeholder={editId ? 'Leave empty to keep the saved key' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                        className="mt-1 w-full px-3 py-2 text-xs font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        {...register('sshPrivateKey')}
                      />
                    </div>
                    <Input label="Key passphrase (optional)" type="password" {...register('sshPassphrase')} />
                    <div className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-2 space-y-1">
                      <p className="font-medium text-gray-700">SSH server host key</p>
                      {editing?.sshHostKey ? (
                        <>
                          <p className="font-mono break-all text-gray-600">{editing.sshHostKey}</p>
                          <p className="text-gray-500">
                            Pinned on the first connection. A different key is refused. If the server was reinstalled,
                            check the new fingerprint with its admin, then forget the old one.
                          </p>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            loading={resetHostKeyMutation.isPending}
                            onClick={() => editId && resetHostKeyMutation.mutate(editId)}
                          >
                            Forget SSH host key
                          </Button>
                        </>
                      ) : (
                        <p className="text-gray-500">
                          Not pinned yet: the key the server presents on the next connection (for example &quot;Test&quot;) is saved and checked every time after that.
                        </p>
                      )}
                    </div>
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

      <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete Connection">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            What should happen to this connection's backups?
          </p>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
            Schedules linked to this connection will be deleted either way.
          </div>
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              onClick={() => { if (deleteTarget) { deleteMutation.mutate({ id: deleteTarget, deleteBackups: false }); setDeleteTarget(null) } }}
            >
              Keep backups — delete connection only
            </Button>
            <Button
              variant="danger"
              onClick={() => { if (deleteTarget) { deleteMutation.mutate({ id: deleteTarget, deleteBackups: true }); setDeleteTarget(null) } }}
            >
              Delete connection and all its backups
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
