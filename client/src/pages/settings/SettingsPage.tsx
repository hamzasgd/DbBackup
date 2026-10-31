import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { User, Lock, Save, Bell, Cloud, Mail, MessageSquare, CheckCircle, AlertCircle, Loader2, Monitor, Globe, KeyRound } from 'lucide-react'
import { useAuthStore } from '../../store/auth.store'
import { authApi, type ActiveSession, type Passkey } from '../../services/auth.service'
import { notificationsApi, storageApi } from '../../services/settings.service'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card'
import { formatDate } from '../../lib/utils'
import { startRegistration } from '@simplewebauthn/browser'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'Must be at least 8 characters'),
  confirmPassword: z.string(),
}).refine((d) => d.newPassword === d.confirmPassword, {
  message: "Passwords don't match",
  path: ['confirmPassword'],
})
type PasswordForm = z.infer<typeof passwordSchema>

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-300'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
      </div>
      <span className="text-sm font-medium text-gray-700">{label}</span>
    </label>
  )
}

function NotificationsTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['notification-settings'],
    queryFn: () => notificationsApi.get(),
  })

  const [form, setForm] = useState({
    emailEnabled: false,
    emailAddress: '',
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
    smtpSecure: false,
    slackEnabled: false,
    slackWebhookUrl: '',
    notifyOnSuccess: true,
    notifyOnFailure: true,
    notifyOnRetention: false,
    notifyOnLogin: true,
    notifyOnStorage: true,
  })

  useEffect(() => {
    const s = data?.data?.data
    if (s && Object.keys(s).length > 0) {
      setForm((prev) => ({
        ...prev,
        emailEnabled: s.emailEnabled ?? prev.emailEnabled,
        emailAddress: s.emailAddress ?? '',
        smtpHost: s.smtpHost ?? '',
        smtpPort: s.smtpPort ?? 587,
        smtpUser: s.smtpUser ?? '',
        smtpPass: s.smtpPass ?? '',
        smtpSecure: s.smtpSecure ?? prev.smtpSecure,
        slackEnabled: s.slackEnabled ?? prev.slackEnabled,
        slackWebhookUrl: s.slackWebhookUrl ?? '',
        notifyOnSuccess: s.notifyOnSuccess ?? prev.notifyOnSuccess,
        notifyOnFailure: s.notifyOnFailure ?? prev.notifyOnFailure,
        notifyOnRetention: s.notifyOnRetention ?? prev.notifyOnRetention,
        notifyOnLogin: s.notifyOnLogin ?? prev.notifyOnLogin,
        notifyOnStorage: s.notifyOnStorage ?? prev.notifyOnStorage,
      }))
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: () => notificationsApi.save(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-settings'] })
      toast.success('Notification settings saved')
    },
    onError: () => toast.error('Failed to save notification settings'),
  })

  const [testingEmail, setTestingEmail] = useState(false)
  const [testingSlack, setTestingSlack] = useState(false)

  async function testChannel(channel: 'email' | 'slack') {
    const setLoading = channel === 'email' ? setTestingEmail : setTestingSlack
    setLoading(true)
    try {
      const res = await notificationsApi.test(channel)
      const result = (res.data as unknown as { data?: { success?: boolean; error?: string } })?.data
      if (result?.success) toast.success(`Test ${channel} sent!`)
      else toast.error(`Test failed: ${result?.error ?? 'Unknown error'}`)
    } catch {
      toast.error(`Failed to send test ${channel} notification`)
    } finally {
      setLoading(false)
    }
  }

  function field(key: 'emailAddress' | 'smtpHost' | 'smtpUser' | 'smtpPass' | 'slackWebhookUrl') {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
    }
  }

  if (isLoading) return <div className="text-center py-12 text-gray-400">Loading...</div>

  return (
    <div className="space-y-6">
      <StorageUsageCard />
      <Card>
        <CardHeader><CardTitle><span className="flex items-center gap-2"><Bell className="h-4 w-4" />Notify me when</span></CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Toggle checked={form.notifyOnSuccess} onChange={(v) => setForm(f => ({ ...f, notifyOnSuccess: v }))} label="Backup / migration completes successfully" />
          <Toggle checked={form.notifyOnFailure} onChange={(v) => setForm(f => ({ ...f, notifyOnFailure: v }))} label="Backup / migration fails" />
          <Toggle checked={form.notifyOnRetention} onChange={(v) => setForm(f => ({ ...f, notifyOnRetention: v }))} label="Old backups are deleted by retention policy" />
          <Toggle checked={form.notifyOnLogin} onChange={(v) => setForm(f => ({ ...f, notifyOnLogin: v }))} label="Login alerts — new sign-in or wrong-password attempt" />
          <Toggle checked={form.notifyOnStorage} onChange={(v) => setForm(f => ({ ...f, notifyOnStorage: v }))} label="Storage threshold — local disk / S3 / Google Drive above limit %" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
            <CardTitle><span className="flex items-center gap-2"><Mail className="h-4 w-4" />Email</span></CardTitle>
            <Toggle checked={form.emailEnabled} onChange={(v) => setForm(f => ({ ...f, emailEnabled: v }))} label="Enabled" />
        </CardHeader>
        {form.emailEnabled && (
          <CardContent className="space-y-4">
            <Input label="Recipient email" type="email" placeholder="you@example.com" {...field('emailAddress')} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="SMTP host" placeholder="smtp.example.com" {...field('smtpHost')} />
              <Input label="SMTP port" type="number" placeholder="587"
                value={form.smtpPort}
                onChange={(e) => setForm(f => ({ ...f, smtpPort: Number(e.target.value) }))}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="SMTP username" placeholder="user@example.com" {...field('smtpUser')} />
              <Input label="SMTP password" type="password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" {...field('smtpPass')} />
            </div>
            <Toggle checked={form.smtpSecure} onChange={(v) => setForm(f => ({ ...f, smtpSecure: v }))} label="Use TLS (port 465)" />
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => testChannel('email')} disabled={testingEmail}>
                {testingEmail ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
                Send test email
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
            <CardTitle><span className="flex items-center gap-2"><MessageSquare className="h-4 w-4" />Slack</span></CardTitle>
            <Toggle checked={form.slackEnabled} onChange={(v) => setForm(f => ({ ...f, slackEnabled: v }))} label="Enabled" />
        </CardHeader>
        {form.slackEnabled && (
          <CardContent className="space-y-4">
            <Input label="Webhook URL" type="password" placeholder="https://hooks.slack.com/services/..." {...field('slackWebhookUrl')} />
            <p className="text-xs text-gray-400">
              Create a webhook at{' '}
              <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">
                api.slack.com/apps
              </a>{' '}
              &rarr; Incoming Webhooks
            </p>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => testChannel('slack')} disabled={testingSlack}>
                {testingSlack ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
                Send test message
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} loading={saveMutation.isPending}>
          <Save className="h-4 w-4" />Save notifications
        </Button>
      </div>
    </div>
  )
}


function UsageBar({ label, usage, threshold }: { label: string; usage: { usedBytes: number | null; totalBytes: number | null; percent: number | null } | null; threshold: number }) {
  if (!usage || usage.percent == null) return null
  const pct = Math.min(100, usage.percent)
  const fmt = (b: number | null) => (b != null ? `${(b / 1024 ** 3).toFixed(1)} GB` : '?')
  const over = pct >= threshold
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-gray-600">{label}</span>
        <span className={over ? 'text-red-600 font-medium' : 'text-gray-500'}>
          {pct.toFixed(0)}% · {fmt(usage.usedBytes)}{usage.totalBytes ? ` / ${fmt(usage.totalBytes)}` : ''}
        </span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${over ? 'bg-red-500' : pct >= threshold - 10 ? 'bg-yellow-400' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function StorageUsageCard() {
  const { data } = useQuery({
    queryKey: ['storage-usage'],
    queryFn: () => storageApi.usage(),
    refetchInterval: 5 * 60_000,
  })
  const usage = data?.data.data
  if (!usage || (!usage.local && !usage.gdrive && !usage.s3)) return null
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Current usage <span className="font-normal text-gray-400">(alert at {usage.thresholdPercent}%)</span></CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <UsageBar label="Local backup disk" usage={usage.local} threshold={usage.thresholdPercent} />
        <UsageBar label="Google Drive" usage={usage.gdrive} threshold={usage.thresholdPercent} />
        <UsageBar label="S3 (budget)" usage={usage.s3} threshold={usage.thresholdPercent} />
      </CardContent>
    </Card>
  )
}

function StorageTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['storage-settings'],
    queryFn: () => storageApi.get(),
  })

  const [form, setForm] = useState({
    provider: 'LOCAL' as 'LOCAL' | 'S3' | 'GOOGLE_DRIVE',
    bucket: '',
    region: '',
    accessKeyId: '',
    secretAccessKey: '',
    endpoint: '',
    prefix: '',
    gdriveClientId: '',
    gdriveClientSecret: '',
    gdriveRefreshToken: '',
    gdriveFolderId: '',
    backupEncryptionEnabled: false,
    backupPassphrase: '',
    currentBackupPassphrase: '',
    deleteLocal: false,
  })

  useEffect(() => {
    const s = data?.data?.data
    if (s && Object.keys(s).length > 0) {
      setForm((prev) => ({
        ...prev,
        provider: (s.provider as 'LOCAL' | 'S3' | 'GOOGLE_DRIVE') ?? prev.provider,
        bucket: s.bucket ?? '',
        region: s.region ?? '',
        accessKeyId: s.accessKeyId ?? '',
        secretAccessKey: s.secretAccessKey ?? '',
        endpoint: s.endpoint ?? '',
        prefix: s.prefix ?? '',
        gdriveClientId: s.gdriveClientId ?? '',
        gdriveClientSecret: s.gdriveClientSecret ?? '',
        gdriveRefreshToken: s.gdriveRefreshToken ?? '',
        gdriveFolderId: s.gdriveFolderId ?? '',
        backupEncryptionEnabled: s.backupEncryptionEnabled ?? prev.backupEncryptionEnabled,
        backupPassphrase: s.backupPassphrase ?? '',
        deleteLocal: s.deleteLocal ?? prev.deleteLocal,
      }))
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: () => storageApi.save(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['storage-settings'] })
      toast.success('Storage settings saved')
    },
    onError: () => toast.error('Failed to save storage settings'),
  })

  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testError, setTestError] = useState('')

  async function testConnection() {
    setTestResult('testing')
    setTestError('')
    try {
      await storageApi.test(form)
      setTestResult('ok')
      toast.success('Connection successful!')
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Connection failed'
      setTestError(msg)
      setTestResult('error')
    }
  }

  function field(key: 'bucket' | 'region' | 'accessKeyId' | 'secretAccessKey' | 'endpoint' | 'prefix' | 'gdriveClientId' | 'gdriveClientSecret' | 'gdriveRefreshToken' | 'gdriveFolderId' | 'backupPassphrase') {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
    }
  }

  if (isLoading) return <div className="text-center py-12 text-gray-400">Loading...</div>

  return (
    <div className="space-y-6">
      <StorageUsageCard />
      <Card>
        <CardHeader><CardTitle><span className="flex items-center gap-2"><Cloud className="h-4 w-4" />Storage Provider</span></CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700">Provider</label>
            <select
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.provider}
              onChange={(e) => setForm(f => ({ ...f, provider: e.target.value as 'LOCAL' | 'S3' | 'GOOGLE_DRIVE' }))}
            >
              <option value="LOCAL">Local disk (default)</option>
              <option value="S3">Amazon S3 / S3-compatible</option>
              <option value="GOOGLE_DRIVE">Google Drive</option>
            </select>
          </div>

          {form.provider === 'LOCAL' && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-500">
              Backups are stored on the server&apos;s local filesystem in the{' '}
              <code className="font-mono bg-gray-100 px-1 rounded">backups/</code> directory.
            </div>
          )}

          <div className="border border-blue-100 bg-blue-50/50 rounded-lg p-4 space-y-3">
            <Toggle
              checked={form.backupEncryptionEnabled}
              onChange={(v) => setForm(f => ({ ...f, backupEncryptionEnabled: v }))}
              label="🔐 Encrypt backup files at rest (AES-256-GCM)"
            />
            {form.backupEncryptionEnabled && form.backupPassphrase === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' && (
              <Input
                label="Current passphrase (required to change it)"
                type="password"
                value={form.currentBackupPassphrase}
                onChange={(e) => setForm(f => ({ ...f, currentBackupPassphrase: e.target.value }))}
              />
            )}
            {form.backupEncryptionEnabled && (
              <>
                <Input
                  label="Backup passphrase"
                  type="password"
                  placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull; (leave as-is to keep current)"
                  {...field('backupPassphrase')}
                />
                <p className="text-xs text-gray-400">
                  New backups are encrypted with this passphrase before they touch disk, S3 or Google Drive
                  (<code className="font-mono">.enc</code> files). Downloads, restores and verification decrypt
                  automatically. Set a strong passphrase and keep a copy somewhere safe — files cannot be
                  recovered without it.
                </p>
              </>
            )}
          </div>

          {form.provider === 'S3' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input label="Bucket name" placeholder="my-backup-bucket" {...field('bucket')} />
                <Input label="Region" placeholder="us-east-1" {...field('region')} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input label="Access Key ID" placeholder="AKIA..." {...field('accessKeyId')} />
                <Input label="Secret Access Key" type="password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" {...field('secretAccessKey')} />
              </div>
              <Input label="Endpoint URL (optional)" placeholder="https://nyc3.digitaloceanspaces.com" {...field('endpoint')} />
              <p className="text-xs text-gray-400 -mt-2">
                Leave empty for AWS S3. Set for MinIO, DigitalOcean Spaces, Backblaze B2, etc.
              </p>
              <Input label="Key prefix (optional)" placeholder="backups/prod" {...field('prefix')} />
              <Toggle
                checked={form.deleteLocal}
                onChange={(v) => setForm(f => ({ ...f, deleteLocal: v }))}
                label="Delete local copy after uploading to S3"
              />
              <div className="flex items-center gap-3 pt-1">
                <Button variant="outline" size="sm" onClick={testConnection} disabled={testResult === 'testing'}>
                  {testResult === 'testing'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Cloud className="h-3.5 w-3.5" />
                  }
                  Test connection
                </Button>
                {testResult === 'ok' && (
                  <span className="text-sm text-green-600 flex items-center gap-1">
                    <CheckCircle className="h-4 w-4" />Bucket accessible
                  </span>
                )}
                {testResult === 'error' && (
                  <span className="text-sm text-red-600 flex items-center gap-1">
                    <AlertCircle className="h-4 w-4" />{testError || 'Connection failed'}
                  </span>
                )}
              </div>
            </div>
          )}

          {form.provider === 'GOOGLE_DRIVE' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input label="Google Client ID" placeholder="1234567890-abc....apps.googleusercontent.com" {...field('gdriveClientId')} />
                <Input label="Google Client Secret" type="password" placeholder="GOCSPX-..." {...field('gdriveClientSecret')} />
              </div>
              <Input label="Refresh Token (drive scope)" type="password" placeholder="1//0g..." {...field('gdriveRefreshToken')} />
              <Input label="Drive folder ID (optional)" placeholder="Leave empty to auto-create 'DbBackups' folder" {...field('gdriveFolderId')} />
              <p className="text-xs text-gray-400 -mt-2">
                Create an OAuth Client (Desktop app) in Google Cloud Console, then authorize with the{' '}
                <code className="font-mono bg-gray-100 px-1 rounded">drive</code> scope at{' '}
                <a href="https://developers.google.com/oauthplayground" target="_blank" rel="noreferrer" className="underline">OAuth Playground</a>{' '}
                (gear icon &rarr; use your own credentials) to get the refresh token.
              </p>
              <Toggle
                checked={form.deleteLocal}
                onChange={(v) => setForm(f => ({ ...f, deleteLocal: v }))}
                label="Delete local copy after uploading to Google Drive"
              />
              <div className="flex items-center gap-3 pt-1">
                <Button variant="outline" size="sm" onClick={testConnection} disabled={testResult === 'testing'}>
                  {testResult === 'testing'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Cloud className="h-3.5 w-3.5" />
                  }
                  Test connection
                </Button>
                {testResult === 'ok' && (
                  <span className="text-sm text-green-600 flex items-center gap-1">
                    <CheckCircle className="h-4 w-4" />Google Drive accessible
                  </span>
                )}
                {testResult === 'error' && (
                  <span className="text-sm text-red-600 flex items-center gap-1">
                    <AlertCircle className="h-4 w-4" />{testError || 'Connection failed'}
                  </span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} loading={saveMutation.isPending}>
          <Save className="h-4 w-4" />Save storage settings
        </Button>
      </div>
    </div>
  )
}

type Tab = 'profile' | 'security' | 'notifications' | 'storage'


function SessionsTab() {
  const qc = useQueryClient()
  const [revokeAllOpen, setRevokeAllOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => authApi.sessions(),
    refetchInterval: 60_000,
  })

  const sessions: ActiveSession[] = data?.data.data.sessions ?? []
  const count = data?.data.data.count ?? 0

  const revokeMutation = useMutation({
    mutationFn: (id: string) => authApi.revokeSession(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['auth-sessions'] }); toast.success('Session revoked') },
    onError: () => toast.error('Failed to revoke session'),
  })

  const revokeAllMutation = useMutation({
    mutationFn: () => authApi.revokeAllSessions(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auth-sessions'] })
      toast.success('All sessions revoked — log in again')
      setRevokeAllOpen(false)
    },
    onError: () => toast.error('Failed to revoke sessions'),
  })

  if (isLoading) return <div className="text-center py-12 text-gray-400">Loading sessions...</div>

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="flex items-center gap-2">
            <Monitor className="h-4 w-4" />Active Sessions
            <span className="text-sm font-normal text-gray-400">({count})</span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {count === 0 && (
          <p className="text-sm text-gray-400">No active sessions.</p>
        )}
        {sessions.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-4 border border-gray-100 rounded-lg p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">
                {s.browser} · {s.os}
              </p>
              <p className="text-xs text-gray-400 flex items-center gap-2 flex-wrap">
                <Globe className="h-3 w-3" />{s.ipAddress ?? 'unknown IP'}
                <span>logged in {formatDate(s.createdAt)}</span>
                <span>expires {formatDate(s.expiresAt)}</span>
              </p>
              <p className="text-xs text-gray-300 truncate" title={s.userAgent ?? undefined}>{s.userAgent}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-red-500 hover:bg-red-50 shrink-0"
              onClick={() => revokeMutation.mutate(s.id)}
              loading={revokeMutation.isPending && revokeMutation.variables === s.id}
            >
              Revoke
            </Button>
          </div>
        ))}
        {count > 0 && (
          <div className="pt-2 border-t">
            <Button variant="danger" size="sm" onClick={() => setRevokeAllOpen(true)}>
              Revoke all sessions (log out everywhere)
            </Button>
            <p className="text-xs text-gray-400 mt-2">
              Revoking all ends every session including this one — you will need to log in again.
            </p>
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={revokeAllOpen}
        onClose={() => setRevokeAllOpen(false)}
        onConfirm={() => revokeAllMutation.mutate()}
        title="Revoke All Sessions"
        description="This logs out every device, including the one you are using now. You will need to log in again."
        confirmLabel="Revoke all"
        variant="danger"
        loading={revokeAllMutation.isPending}
      />
    </Card>
  )
}


function PasskeysCard() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['passkeys'],
    queryFn: () => authApi.passkeys(),
  })

  const passkeys: Passkey[] = data?.data.data.passkeys ?? []

  const registerPasskey = async () => {
    setBusy(true)
    try {
      const opts = await authApi.passkeyRegisterOptions()
      const attestation = await startRegistration({ optionsJSON: opts.data.data.options })
      await authApi.passkeyRegisterVerify(attestation, label || 'Passkey')
      qc.invalidateQueries({ queryKey: ['passkeys'] })
      toast.success('Passkey registered — you can now sign in with it')
      setLabel('')
    } catch (err: unknown) {
      const apiMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      if (apiMsg) toast.error(apiMsg)
      else if ((err as Error)?.name === 'NotAllowedError') { /* cancelled */ }
      else toast.error('Passkey registration failed')
    } finally {
      setBusy(false)
    }
  }

  const removeMutation = useMutation({
    mutationFn: (id: string) => authApi.deletePasskey(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['passkeys'] }); toast.success('Passkey removed') },
    onError: () => toast.error('Failed to remove passkey'),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />Passkeys
            <span className="text-sm font-normal text-gray-400">({passkeys.length})</span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-gray-400">
          Passwordless login with Touch ID, Face ID, Windows Hello or a security key.
        </p>

        {isLoading && <p className="text-sm text-gray-400">Loading…</p>}

        {passkeys.map((pk) => (
          <div key={pk.id} className="flex items-center justify-between gap-4 border border-gray-100 rounded-lg p-3">
            <div>
              <p className="text-sm font-medium text-gray-900">{pk.name}</p>
              <p className="text-xs text-gray-400 flex gap-2 flex-wrap">
                <span>added {formatDate(pk.createdAt)}</span>
                {pk.lastUsedAt && <span>last used {formatDate(pk.lastUsedAt)}</span>}
                {pk.backedUp && <span className="text-green-600">synced</span>}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-red-500 hover:bg-red-50 shrink-0"
              onClick={() => removeMutation.mutate(pk.id)}
              loading={removeMutation.isPending && removeMutation.variables === pk.id}
            >
              Remove
            </Button>
          </div>
        ))}

        <div className="flex gap-2 items-center pt-2 border-t">
          <Input
            label="Label (optional)"
            placeholder="e.g. MacBook Touch ID"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button onClick={registerPasskey} disabled={busy} className="mt-5 shrink-0">
            {busy ? 'Waiting for device…' : 'Add passkey'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'security', label: 'Security' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'storage', label: 'Storage' },
]

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user)
  const [activeTab, setActiveTab] = useState<Tab>('profile')

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<PasswordForm>({
    resolver: zodResolver(passwordSchema),
  })

  const changePwMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) => authApi.changePassword(data),
    onSuccess: () => { toast.success('Password changed successfully'); reset() },
    onError: () => toast.error('Failed to change password'),
  })

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500 mt-1">Manage your account and notification settings</p>
      </div>

      <div className="flex flex-wrap border-b border-gray-200 gap-4 sm:gap-6">
        {TABS.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`pb-3 text-sm font-medium capitalize border-b-2 transition-colors ${
              activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'profile' && (
        <Card>
          <CardHeader><CardTitle><span className="flex items-center gap-2"><User className="h-4 w-4" />Profile</span></CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="bg-blue-100 rounded-full w-16 h-16 flex items-center justify-center">
                <span className="text-blue-600 text-2xl font-bold">{user?.name?.charAt(0).toUpperCase()}</span>
              </div>
              <div>
                <p className="font-semibold text-gray-900 text-lg">{user?.name}</p>
                <p className="text-gray-500">{user?.email}</p>
              </div>
            </div>
            <div className="border-t pt-4 text-sm text-gray-500">
              <p>Your account details can be updated by contacting support.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {activeTab === 'security' && (
        <Card>
          <CardHeader><CardTitle><span className="flex items-center gap-2"><Lock className="h-4 w-4" />Change Password</span></CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit((d) => changePwMutation.mutate(d))} className="space-y-4">
              <Input label="Current password" type="password" error={errors.currentPassword?.message} {...register('currentPassword')} />
              <Input label="New password" type="password" error={errors.newPassword?.message} {...register('newPassword')} />
              <Input label="Confirm new password" type="password" error={errors.confirmPassword?.message} {...register('confirmPassword')} />
              <Button type="submit" loading={isSubmitting || changePwMutation.isPending}>
                <Save className="h-4 w-4" />Update password
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {activeTab === 'security' && <SessionsTab />}
      {activeTab === 'security' && <PasskeysCard />}
      {activeTab === 'notifications' && <NotificationsTab />}
      {activeTab === 'storage' && <StorageTab />}
    </div>
  )
}
