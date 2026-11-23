import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Copy, KeyRound, Pencil, Plug, Plus, Power, Trash2, XCircle,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Modal } from '../../components/ui/Modal'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { connectionsApi } from '../../services/connections.service'
import {
  dbAccessApi, type AccessInput, type ClientSettings, type DbAccess, type GatewayStatus,
} from '../../services/db-access.service'
import { toast } from '../../store/toast.store'
import { formatBytes, formatDate, getApiErrorMessage } from '../../lib/utils'
import { useNow } from '../../hooks/useNow'

type Preset = 'read' | 'write' | 'full' | 'custom'

const PRESET_LABELS: Record<Preset, { title: string; text: string }> = {
  read: { title: 'Read only', text: 'See tables and data. Cannot change anything.' },
  write: { title: 'Read and write data', text: 'Also add, change and delete rows. Cannot change tables.' },
  full: { title: 'Everything in this database', text: 'Also create, change and drop tables, views and routines.' },
  custom: { title: 'Choose rights', text: 'Pick exactly which rights.' },
}

const ENDS = [
  { label: 'Never', value: '' },
  { label: 'In 1 day', value: '1' },
  { label: 'In 7 days', value: '7' },
  { label: 'In 30 days', value: '30' },
  { label: 'In 90 days', value: '90' },
]

/** The moment a number of days from now, for an end date */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

function presetOf(privileges: string[], status?: GatewayStatus): Preset {
  if (!status) return 'custom'
  const key = [...privileges].sort().join()
  for (const p of ['read', 'write', 'full'] as const) {
    if ([...status.presets[p]].sort().join() === key) return p
  }
  return 'custom'
}

function rightsSummary(a: DbAccess, status?: GatewayStatus): string {
  const p = presetOf(a.privileges, status)
  return p === 'custom' ? a.privileges.join(', ') : PRESET_LABELS[p].title
}

function accessState(a: DbAccess, now: number): { label: string; cls: string } {
  if (!a.enabled) return { label: 'Off', cls: 'bg-gray-100 text-gray-600' }
  if (a.expiresAt && Date.parse(a.expiresAt) <= now) return { label: 'Expired', cls: 'bg-amber-50 text-amber-700' }
  return { label: 'Active', cls: 'bg-green-50 text-green-700' }
}

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-24 shrink-0 text-gray-500">{label}</span>
      <code className={`flex-1 min-w-0 truncate rounded bg-gray-50 border border-gray-200 px-2 py-1 ${secret ? 'text-red-700' : 'text-gray-900'}`}>{value}</code>
      <Button variant="ghost" size="sm" className="p-1.5" title={`Copy ${label.toLowerCase()}`}
        onClick={() => navigator.clipboard.writeText(value).then(() => toast.success(`${label} copied`), () => toast.error('Could not copy'))}>
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

/** The login, shown once after it is created or its password is changed */
function SettingsModal({ settings, onClose }: { settings: ClientSettings | null; onClose: () => void }) {
  if (!settings) return null
  return (
    <Modal open onClose={onClose} title="Login details" className="max-w-xl">
      <div className="space-y-4">
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Copy the password now: DbBackup does not keep it and won&apos;t show it again. Send it privately (not in a group chat).
        </p>
        <div className="space-y-1.5">
          <CopyField label="Host" value={settings.host} />
          <CopyField label="Port" value={String(settings.port)} />
          <CopyField label="User" value={settings.username} />
          {settings.password && <CopyField label="Password" value={settings.password} secret />}
          <CopyField label="Database" value={settings.database} />
          <CopyField label="SSL" value={settings.ssl} />
        </div>
        <div className="text-xs text-gray-600 space-y-1.5">
          <p><b>DBeaver:</b> New connection → MySQL. Main tab: host, port, user, password. SSL tab: tick <i>Use SSL</i> and <i>Require SSL</i>. No SSH tab needed.</p>
          <p><b>DbGate:</b> New connection → MySQL. Fill in host, port, user, password; on the SSL tab tick <i>Use SSL</i>.</p>
          <p><b>Command line:</b> <code className="break-all">{settings.command}</code></p>
        </div>
        {settings.password && <CopyField label="URL" value={settings.url} secret />}
        <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
      </div>
    </Modal>
  )
}

interface FormState {
  connectionId: string
  name: string
  username: string
  database: string
  preset: Preset
  privileges: string[]
  scope: 'all' | 'tables'
  tables: string[]
  maxConnections: number
  ends: string
}

/** Create a new access, or change an existing one (connection, login name and database stay) */
function AccessForm({ status, existing, onClose, onCreated }: {
  status: GatewayStatus
  existing: DbAccess | null
  onClose: () => void
  onCreated: (s: ClientSettings) => void
}) {
  const qc = useQueryClient()
  const { data: connsData } = useQuery({ queryKey: ['connections'], queryFn: () => connectionsApi.getAll() })
  const conns = (connsData?.data.data ?? []).filter((c) => c.type === 'MYSQL' || c.type === 'MARIADB')
  const [f, setF] = useState<FormState>(() => existing
    ? {
      connectionId: existing.connectionId, name: existing.name, username: existing.username, database: existing.database,
      preset: presetOf(existing.privileges, status), privileges: existing.privileges,
      scope: existing.tables.length ? 'tables' : 'all', tables: existing.tables, maxConnections: existing.maxConnections,
      ends: '',
    }
    : { connectionId: '', name: '', username: '', database: '', preset: 'read', privileges: status.presets.read, scope: 'all', tables: [], maxConnections: 5, ends: '' })
  const set = (patch: Partial<FormState>) => setF((s) => ({ ...s, ...patch }))
  const conn = conns.find((c) => c.id === f.connectionId)
  const database = f.database || conn?.database || ''
  const [filter, setFilter] = useState('')

  const tablesQuery = useQuery({
    queryKey: ['db-access-tables', f.connectionId, database],
    queryFn: () => dbAccessApi.tables(f.connectionId, database),
    enabled: f.scope === 'tables' && !!f.connectionId && !!database,
    staleTime: 60_000,
  })
  const allTables = tablesQuery.data?.data.data.tables ?? []
  const shownTables = allTables.filter((t) => t.toLowerCase().includes(filter.toLowerCase()))

  const choices = f.scope === 'tables' ? status.tablePrivileges : status.databasePrivileges
  const privileges = f.preset === 'custom' ? f.privileges.filter((p) => choices.includes(p)) : status.presets[f.preset].filter((p) => choices.includes(p))
  const writes = privileges.some((p) => p !== 'SELECT' && p !== 'SHOW VIEW')

  const save = useMutation({
    mutationFn: async () => {
      const expiresAt = f.ends === 'never' ? null
        : f.ends ? daysFromNow(Number(f.ends))
          : existing ? undefined : null
      const common = {
        name: f.name.trim(),
        tables: f.scope === 'tables' ? f.tables : [],
        privileges,
        maxConnections: f.maxConnections,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      }
      if (existing) {
        await dbAccessApi.update(existing.id, common)
        return null
      }
      const body: AccessInput = { ...common, connectionId: f.connectionId, database, ...(f.username.trim() ? { username: f.username.trim() } : {}) }
      return (await dbAccessApi.create(body)).data.data.settings
    },
    onSuccess: (settings) => {
      qc.invalidateQueries({ queryKey: ['db-access'] })
      toast.success(existing ? 'Access changed. Open sessions were ended so the change applies.' : 'Access created')
      if (settings) onCreated(settings)
      onClose()
    },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, existing ? 'Could not change the access' : 'Could not create the access')),
  })

  const ready = f.name.trim() && f.connectionId && database && privileges.length > 0 && (f.scope === 'all' || f.tables.length > 0)

  return (
    <Modal open onClose={onClose} title={existing ? `Change access: ${existing.name}` : 'Give database access'} className="max-w-2xl">
      <div className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Who is it for" placeholder="e.g. Ali (backend)" value={f.name} onChange={(e) => set({ name: e.target.value })} required />
          {existing
            ? <Input label="Login name" value={existing.username} disabled />
            : <Input label="Login name (optional)" placeholder="made from the name" value={f.username}
                onChange={(e) => set({ username: e.target.value.toLowerCase() })}
                hint="3-32 lowercase letters, digits, _ . -" />}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select label="Database connection" disabled={!!existing} value={f.connectionId}
            onChange={(e) => set({ connectionId: e.target.value, database: '', tables: [] })}
            options={[{ label: conns.length ? 'Choose a MySQL / MariaDB connection' : 'No MySQL / MariaDB connections', value: '' },
              ...conns.map((c) => ({ label: `${c.name} (${c.database})${c.writeProtected ? ' — write-protected' : ''}`, value: c.id }))]} />
          <Input label="Database" disabled={!!existing} value={database} onChange={(e) => set({ database: e.target.value, tables: [] })} />
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">What they can do</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
              <label key={p} className={`flex gap-2 rounded-lg border px-3 py-2 cursor-pointer ${f.preset === p ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                <input type="radio" className="mt-1" checked={f.preset === p}
                  onChange={() => set({ preset: p, privileges: p === 'custom' ? privileges : status.presets[p] })} />
                <span>
                  <span className="block text-sm font-medium text-gray-900">{PRESET_LABELS[p].title}</span>
                  <span className="block text-xs text-gray-500">{PRESET_LABELS[p].text}</span>
                </span>
              </label>
            ))}
          </div>
          {f.preset === 'custom' && (
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
              {choices.map((p) => (
                <label key={p} className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={f.privileges.includes(p)}
                    onChange={(e) => set({ privileges: e.target.checked ? [...f.privileges, p] : f.privileges.filter((x) => x !== p) })} />
                  {p}
                </label>
              ))}
            </div>
          )}
          {writes && conn?.writeProtected && (
            <p className="mt-2 text-xs text-red-700">{conn.name} is write-protected: only Read only can be given on it.</p>
          )}
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">Which tables</p>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" checked={f.scope === 'all'} onChange={() => set({ scope: 'all' })} />Every table in {database || 'the database'}</label>
            <label className="flex items-center gap-2"><input type="radio" checked={f.scope === 'tables'} onChange={() => set({ scope: 'tables' })} />Only some tables</label>
          </div>
          {f.scope === 'tables' && (
            <div className="mt-2 rounded-lg border border-gray-200">
              <div className="p-2 border-b border-gray-100 flex items-center gap-2">
                <input className="flex-1 text-sm px-2 py-1 border border-gray-200 rounded" placeholder="Filter tables"
                  value={filter} onChange={(e) => setFilter(e.target.value)} />
                <span className="text-xs text-gray-500 shrink-0">{f.tables.length} chosen</span>
              </div>
              <div className="max-h-48 overflow-y-auto p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
                {tablesQuery.isLoading && <p className="text-sm text-gray-500">Loading tables…</p>}
                {tablesQuery.isError && <p className="text-sm text-red-600">{getApiErrorMessage(tablesQuery.error, 'Could not list the tables')}</p>}
                {shownTables.map((t) => (
                  <label key={t} className="flex items-center gap-2 text-sm text-gray-700 truncate">
                    <input type="checkbox" checked={f.tables.includes(t)}
                      onChange={(e) => set({ tables: e.target.checked ? [...f.tables, t] : f.tables.filter((x) => x !== t) })} />
                    <span className="truncate">{t}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select label="Access ends" value={f.ends} onChange={(e) => set({ ends: e.target.value })}
            options={existing
              ? [{ label: existing.expiresAt ? `Keep: ${formatDate(existing.expiresAt)}` : 'Keep: never', value: '' },
                { label: 'Never', value: 'never' }, ...ENDS.slice(1)]
              : ENDS} />
          <Input label="Connections at once" type="number" min={1} max={50} value={f.maxConnections}
            onChange={(e) => set({ maxConnections: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })}
            hint="DBeaver and DbGate open 2–3 per window" />
        </div>

        <p className="text-xs text-gray-500">
          DbBackup creates a database user with exactly these rights and logs in as it for them; they never see its password.
          Every query they run is recorded here.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>{existing ? 'Save' : 'Create access'}</Button>
        </div>
      </div>
    </Modal>
  )
}

function Sessions({ access }: { access: DbAccess }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)
  // How many sessions, and how many statements of the open one, are shown; the server keeps them all
  const [shown, setShown] = useState(50)
  const [limit, setLimit] = useState(1000)
  const { data } = useQuery({ queryKey: ['db-access', access.id, 'sessions', shown], queryFn: () => dbAccessApi.sessions(access.id, shown), refetchInterval: 10_000 })
  const sessions = data?.data.data.sessions ?? []
  const total = data?.data.data.total ?? 0
  const queries = useQuery({ queryKey: ['db-access-queries', open, limit], queryFn: () => dbAccessApi.queries(open!, limit), enabled: !!open })
  const end = useMutation({
    mutationFn: (id: string) => dbAccessApi.closeSession(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['db-access'] }); toast.success('Session ended') },
  })
  const toggle = (id: string) => { setOpen(open === id ? null : id); setLimit(1000) }
  if (!sessions.length) return <p className="text-sm text-gray-500">No sessions yet.</p>
  return (
    <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
      {sessions.map((s) => (
        <div key={s.id}>
          <div role="button" tabIndex={0} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50"
            onClick={() => toggle(s.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') toggle(s.id) }}>
            {open === s.id ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
            <span className="text-gray-900">{formatDate(s.startedAt)}</span>
            <span className="text-gray-500 truncate">{s.clientProgram ?? 'client'} · {s.clientIp}</span>
            <span className="ml-auto text-gray-500 shrink-0">{s.queries} quer{s.queries === 1 ? 'y' : 'ies'}{s.endedAt ? ` · ${formatBytes(s.bytesOut)} sent` : ''}</span>
            {s.endedAt
              ? <span className="text-xs text-gray-400 shrink-0">{s.error ?? 'ended'}</span>
              : <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); end.mutate(s.id) }}>End</Button>}
          </div>
          {open === s.id && (
            <div className="px-3 pb-3 space-y-1 max-h-72 overflow-y-auto">
              {queries.isLoading && <p className="text-xs text-gray-500">Loading…</p>}
              {(queries.data?.data.data.queries ?? []).map((q) => (
                <div key={q.id} className="flex gap-2 text-xs">
                  <span className="text-gray-400 shrink-0 w-20 whitespace-nowrap">{new Date(q.at).toLocaleTimeString()}</span>
                  <span className={`shrink-0 w-16 ${q.kind === 'BLOCKED' ? 'text-red-600' : 'text-gray-500'}`}>{q.kind}</span>
                  <code className="text-gray-800 whitespace-pre-wrap break-all">{q.sql}</code>
                </div>
              ))}
              {queries.data && !queries.data.data.data.queries.length && <p className="text-xs text-gray-500">No queries in this session.</p>}
              {queries.data && queries.data.data.data.queries.length < queries.data.data.data.total && (
                <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + 1000)}>
                  Show more statements ({queries.data.data.data.queries.length} of {queries.data.data.data.total})
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
      {sessions.length < total && (
        <div className="px-3 py-2">
          <Button variant="outline" size="sm" onClick={() => setShown((n) => n + 50)}>Show more sessions ({sessions.length} of {total})</Button>
        </div>
      )}
    </div>
  )
}

function AccessRow({ a, status, onEdit, onSettings }: { a: DbAccess; status?: GatewayStatus; onEdit: () => void; onSettings: (s: ClientSettings) => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<'normal' | 'force' | null>(null)
  const now = useNow(30_000)
  const state = accessState(a, now)
  const refresh = () => qc.invalidateQueries({ queryKey: ['db-access'] })
  const toggle = useMutation({
    mutationFn: () => dbAccessApi.update(a.id, { enabled: !a.enabled }),
    onSuccess: () => { refresh(); toast.success(a.enabled ? 'Access turned off; open sessions were ended' : 'Access turned on') },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Could not change it')),
  })
  const password = useMutation({
    mutationFn: () => dbAccessApi.resetPassword(a.id),
    onSuccess: (r) => { refresh(); onSettings(r.data.data.settings) },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Could not change the password')),
  })
  const remove = useMutation({
    mutationFn: (force: boolean) => dbAccessApi.remove(a.id, force),
    onSuccess: (r) => {
      refresh()
      setConfirmRemove(null)
      if (r.data.data.warning) toast.error(r.data.data.warning)
      else toast.success('Access removed, and its database user dropped')
    },
    onError: (e: unknown) => { setConfirmRemove('force'); toast.error(getApiErrorMessage(e, 'Could not remove it')) },
  })

  return (
    <div className="border-b border-gray-100 last:border-0">
      <div role="button" tabIndex={0} aria-expanded={open} className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50"
        onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(!open) }}>
        {open ? <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" /> : <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-gray-900">{a.name}</span>
            <code className="text-xs text-gray-500">{a.username}</code>
            <span className={`text-[11px] font-medium rounded px-1.5 py-0.5 ${state.cls}`}>{state.label}</span>
            {a.activeSessions > 0 && <span className="text-[11px] font-medium rounded px-1.5 py-0.5 bg-blue-50 text-blue-700">{a.activeSessions} connected</span>}
          </div>
          <p className="text-xs text-gray-500 mt-0.5 truncate">
            {a.connectionName} · {a.database} · {rightsSummary(a, status)}
            {a.tables.length ? ` · ${a.tables.length} table${a.tables.length === 1 ? '' : 's'}` : ' · all tables'}
            {a.expiresAt ? ` · ends ${formatDate(a.expiresAt)}` : ''}
          </p>
        </div>
        <span className="text-xs text-gray-400 shrink-0 hidden sm:block">{a.lastUsedAt ? `last used ${formatDate(a.lastUsedAt)}` : 'never used'}</span>
      </div>
      {open && (
        <div className="px-4 pb-4 pl-11 space-y-4">
          <div className="text-sm text-gray-700 space-y-1">
            <p><span className="text-gray-500">Rights:</span> {a.privileges.join(', ')}</p>
            <p><span className="text-gray-500">Tables:</span> {a.tables.length ? a.tables.join(', ') : `every table in ${a.database}`}</p>
            <p><span className="text-gray-500">Connections at once:</span> {a.maxConnections}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5" />Change</Button>
            <Button size="sm" variant="outline" loading={toggle.isPending} onClick={() => toggle.mutate()}>
              <Power className="h-3.5 w-3.5" />{a.enabled ? 'Turn off' : 'Turn on'}
            </Button>
            <Button size="sm" variant="outline" loading={password.isPending} onClick={() => password.mutate()}>
              <KeyRound className="h-3.5 w-3.5" />New password
            </Button>
            <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setConfirmRemove('normal')}>
              <Trash2 className="h-3.5 w-3.5" />Remove
            </Button>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Sessions</p>
            <Sessions access={a} />
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => remove.mutate(confirmRemove === 'force')}
        loading={remove.isPending}
        title={confirmRemove === 'force' ? 'Remove anyway?' : `Remove ${a.name}'s access?`}
        description={confirmRemove === 'force'
          ? 'The database user behind it could not be dropped (see the message). Remove the access from DbBackup anyway? It stays turned off; drop that user on the database yourself.'
          : `${a.username} can no longer log in, open sessions end now, and the database user DbBackup made for it is dropped. The query log goes too.`}
        confirmLabel={confirmRemove === 'force' ? 'Remove anyway' : 'Remove'}
      />
    </div>
  )
}

function GatewayCard({ status }: { status?: GatewayStatus }) {
  const now = useNow(3_600_000)
  if (!status) return null
  const certDays = status.tls.validTo ? Math.floor((Date.parse(status.tls.validTo) - now) / 86_400_000) : null
  return (
    <Card>
      <CardContent className="py-4 text-sm space-y-2">
        {status.running ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5 text-green-700 font-medium"><CheckCircle2 className="h-4 w-4" />Gateway running</span>
            <span className="text-gray-700">Connect to <code className="bg-gray-50 px-1 rounded">{status.publicHost ?? '(this server)'}:{status.port}</code></span>
            <span className="text-gray-500">{status.requireTls ? 'SSL required' : 'SSL optional'}</span>
            {status.tls.configured && certDays !== null && (
              <span className={certDays < 14 ? 'text-amber-700' : 'text-gray-500'}>certificate valid for {certDays} more day{certDays === 1 ? '' : 's'}</span>
            )}
          </div>
        ) : (
          <div className="flex gap-2 text-amber-800">
            <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">The gateway is not running</p>
              <p>{status.problem}</p>
              <p className="text-xs text-gray-600">
                In <code>server/.env</code>: <code>DB_GATEWAY_PORT=3307</code>, <code>DB_GATEWAY_TLS_CERT</code> and <code>DB_GATEWAY_TLS_KEY</code> (e.g. this
                site&apos;s Let&apos;s Encrypt <code>fullchain.pem</code> and <code>privkey.pem</code>), then restart DbBackup and open the port in the firewall.
              </p>
            </div>
          </div>
        )}
        {status.tls.error && <p className="text-xs text-red-700 flex gap-1.5"><AlertTriangle className="h-3.5 w-3.5 mt-0.5" />{status.tls.error}</p>}
      </CardContent>
    </Card>
  )
}

export default function DbAccessPage() {
  const [form, setForm] = useState<{ existing: DbAccess | null } | null>(null)
  const [settings, setSettings] = useState<ClientSettings | null>(null)
  const { data: statusData } = useQuery({ queryKey: ['db-access', 'status'], queryFn: () => dbAccessApi.status(), refetchInterval: 60_000 })
  const status = statusData?.data.data
  const { data, isLoading } = useQuery({ queryKey: ['db-access', 'list'], queryFn: () => dbAccessApi.list(), refetchInterval: 15_000 })
  const accesses = useMemo(() => data?.data.data.accesses ?? [], [data])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Database access</h1>
          <p className="text-gray-500 mt-1 max-w-3xl">
            Give people their own login to a MySQL or MariaDB database. They connect DBeaver, DbGate or <code>mysql</code> to
            DbBackup, which logs in for them with only the rights you choose and records every query. No SSH and no database
            password for them; turn it off or remove it at any time.
          </p>
        </div>
        <Button disabled={!status} onClick={() => setForm({ existing: null })}><Plus className="h-4 w-4" />Give access</Button>
      </div>

      <GatewayCard status={status} />

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Plug className="h-4 w-4" />People with access</CardTitle></CardHeader>
        <CardContent className="p-0">
          {isLoading ? <p className="px-4 py-6 text-sm text-gray-500">Loading…</p>
            : accesses.length === 0 ? <p className="px-4 py-6 text-sm text-gray-500">Nobody yet. Use “Give access” to create a login.</p>
              : accesses.map((a) => (
                <AccessRow key={a.id} a={a} status={status} onEdit={() => setForm({ existing: a })} onSettings={setSettings} />
              ))}
        </CardContent>
      </Card>

      {form && status && (
        <AccessForm status={status} existing={form.existing} onClose={() => setForm(null)} onCreated={setSettings} />
      )}
      <SettingsModal settings={settings} onClose={() => setSettings(null)} />
    </div>
  )
}
