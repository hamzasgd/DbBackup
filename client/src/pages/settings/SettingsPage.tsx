import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { User, Lock, Save, Bell, Cloud, Mail, MessageSquare, CheckCircle, AlertCircle, Loader2, Monitor, Globe, KeyRound, Bot, Copy, RotateCcw } from 'lucide-react'
import { useAuthStore } from '../../store/auth.store'
import { authApi, type ActiveSession, type Passkey } from '../../services/auth.service'
import { notificationsApi, storageApi, mcpApi, mcpApprovalsApi, type McpKey, type PendingApproval } from '../../services/settings.service'
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
    ntfyEnabled: false,
    ntfyServerUrl: '',
    ntfyTopic: '',
    telegramEnabled: false,
    telegramBotToken: '',
    telegramChatId: '',
    discordEnabled: false,
    discordWebhookUrl: '',
    whatsappEnabled: false,
    whatsappPhoneNumberId: '',
    whatsappAccessToken: '',
    whatsappRecipient: '',
    notifyOnSuccess: true,
    notifyOnFailure: true,
    notifyOnRetention: false,
    notifyOnLogin: true,
    notifyOnStorage: true,
  })

  // Copy server settings into the editable form when a new response arrives
  // (state adjusted during render, keyed on the response object, instead of an effect)
  const serverSettings = data?.data?.data
  const [syncedSettings, setSyncedSettings] = useState<typeof serverSettings>(undefined)
  if (serverSettings !== syncedSettings) {
    setSyncedSettings(serverSettings)
    const s = serverSettings
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
        ntfyEnabled: s.ntfyEnabled ?? false,
        ntfyServerUrl: s.ntfyServerUrl ?? '',
        ntfyTopic: s.ntfyTopic ?? '',
        telegramEnabled: s.telegramEnabled ?? false,
        telegramBotToken: s.telegramBotToken ?? '',
        telegramChatId: s.telegramChatId ?? '',
        discordEnabled: s.discordEnabled ?? false,
        discordWebhookUrl: s.discordWebhookUrl ?? '',
        whatsappEnabled: s.whatsappEnabled ?? false,
        whatsappPhoneNumberId: s.whatsappPhoneNumberId ?? '',
        whatsappAccessToken: '',
        whatsappRecipient: s.whatsappRecipient ?? '',
        notifyOnSuccess: s.notifyOnSuccess ?? prev.notifyOnSuccess,
        notifyOnFailure: s.notifyOnFailure ?? prev.notifyOnFailure,
        notifyOnRetention: s.notifyOnRetention ?? prev.notifyOnRetention,
        notifyOnLogin: s.notifyOnLogin ?? prev.notifyOnLogin,
        notifyOnStorage: s.notifyOnStorage ?? prev.notifyOnStorage,
      }))
    }
  }

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

  function field(key: 'emailAddress' | 'smtpHost' | 'smtpUser' | 'smtpPass' | 'slackWebhookUrl' | 'ntfyServerUrl' | 'ntfyTopic' | 'telegramBotToken' | 'telegramChatId' | 'discordWebhookUrl' | 'whatsappPhoneNumberId' | 'whatsappAccessToken' | 'whatsappRecipient') {
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

      <Card>
        <CardHeader>
            <CardTitle>ntfy</CardTitle>
            <Toggle checked={form.ntfyEnabled} onChange={(v) => setForm(f => ({ ...f, ntfyEnabled: v }))} label="Enabled" />
        </CardHeader>
        {form.ntfyEnabled && (
          <CardContent className="space-y-4">
            <Input label="Server URL (optional, default ntfy.sh)" placeholder="https://ntfy.sh" {...field('ntfyServerUrl')} />
            <Input label="Topic" placeholder="my-dbbackup-alerts" {...field('ntfyTopic')} />
            <p className="text-xs text-gray-400">
              Install the{' '}
              <a href="https://ntfy.sh" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">ntfy app</a>{' '}
              and subscribe to this topic to receive push notifications.
            </p>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
            <CardTitle>Telegram</CardTitle>
            <Toggle checked={form.telegramEnabled} onChange={(v) => setForm(f => ({ ...f, telegramEnabled: v }))} label="Enabled" />
        </CardHeader>
        {form.telegramEnabled && (
          <CardContent className="space-y-4">
            <Input label="Bot token" type="password" placeholder="123456:ABC-DEF..." {...field('telegramBotToken')} />
            <Input label="Chat ID" placeholder="-1001234567890" {...field('telegramChatId')} />
            <p className="text-xs text-gray-400">
              Create a bot via{' '}
              <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">@BotFather</a>{' '}
              and get your chat ID from{' '}
              <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">@userinfobot</a>.
            </p>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
            <CardTitle>Discord</CardTitle>
            <Toggle checked={form.discordEnabled} onChange={(v) => setForm(f => ({ ...f, discordEnabled: v }))} label="Enabled" />
        </CardHeader>
        {form.discordEnabled && (
          <CardContent className="space-y-4">
            <Input label="Webhook URL" type="password" placeholder="https://discord.com/api/webhooks/..." {...field('discordWebhookUrl')} />
            <p className="text-xs text-gray-400">
              Server Settings &rarr; Integrations &rarr; Webhooks &rarr; New Webhook.
            </p>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
            <CardTitle>WhatsApp</CardTitle>
            <Toggle checked={form.whatsappEnabled} onChange={(v) => setForm(f => ({ ...f, whatsappEnabled: v }))} label="Enabled" />
        </CardHeader>
        {form.whatsappEnabled && (
          <CardContent className="space-y-4">
            <Input label="Phone Number ID" placeholder="123456789012345" {...field('whatsappPhoneNumberId')} />
            <Input label="Access Token" type="password" placeholder="EAAG..." {...field('whatsappAccessToken')} />
            <Input label="Recipient (your WhatsApp number)" placeholder="15551234567" {...field('whatsappRecipient')} />
            <p className="text-xs text-gray-400">
              Meta Business Suite &rarr; WhatsApp Manager &rarr; API Setup. Phone Number ID and token from there.
              Recipient = your number in international format (no +, no spaces).
            </p>
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

  // Copy server settings into the editable form when a new response arrives
  // (state adjusted during render, keyed on the response object, instead of an effect)
  const serverSettings = data?.data?.data
  const [syncedSettings, setSyncedSettings] = useState<typeof serverSettings>(undefined)
  if (serverSettings !== syncedSettings) {
    setSyncedSettings(serverSettings)
    const s = serverSettings
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
  }

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

type Tab = 'profile' | 'security' | 'notifications' | 'storage' | 'mcp'


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



function PasswordLoginToggle() {
  const qc = useQueryClient()
  // The saved setting (it used to start as "off" after every reload, whatever was saved)
  const { data: meData, isLoading: meLoading } = useQuery({ queryKey: ['me'], queryFn: () => authApi.me() })
  const passkeyOnly = meData?.data.data.passwordLoginDisabled ?? false
  const { data: pkData } = useQuery({ queryKey: ['passkeys'], queryFn: () => authApi.passkeys() })
  const hasPasskeys = (pkData?.data.data.passkeys ?? []).length > 0

  const mutation = useMutation({
    mutationFn: (disabled: boolean) => authApi.togglePasswordLogin(disabled),
    // Re-read the saved state before the mutation settles, so the toggle shows what the server stored
    onSuccess: async (res) => { await qc.invalidateQueries({ queryKey: ['me'] }); toast.success(res.data.message) },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed'),
  })

  return (
    <div className="border border-purple-100 bg-purple-50/50 rounded-lg p-4 space-y-2">
      <Toggle
        checked={passkeyOnly}
        onChange={(v) => {
          if (meLoading || mutation.isPending) return // state unknown or a change in flight
          if (v && !hasPasskeys) { toast.error('Register a passkey first'); return }
          mutation.mutate(v)
        }}
        label="Passkey-only mode — disable password sign-in entirely"
      />
      <p className="text-xs text-gray-400">
        {hasPasskeys
          ? 'When enabled, sign-in requires a passkey (Touch ID / Face ID / security key). Password attempts are rejected.'
          : 'Register at least one passkey above before enabling this.'}
      </p>
    </div>
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
    // Show the server's reason (e.g. the last passkey can't be removed in passkey-only mode)
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to remove passkey'),
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



const MCP_AGENTS: { id: string; label: string; file: string; wrap: (url: string, key: string) => string }[] = [
  {
    id: 'claude-desktop', label: 'Claude Desktop',
    file: 'claude_desktop_config.json — macOS: ~/Library/Application Support/Claude/ · Windows: %APPDATA%\\Claude\\',
    wrap: (url, key) => JSON.stringify({ mcpServers: { dbbackup: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'claude-code', label: 'Claude Code',
    file: 'Terminal (one-liner, no JSON needed)',
    wrap: (url, key) => `claude mcp add --transport http dbbackup ${url} --header "Authorization: Bearer ${key}"`,
  },
  {
    id: 'cursor', label: 'Cursor',
    file: '~/.cursor/mcp.json (global) or .cursor/mcp.json (project)',
    wrap: (url, key) => JSON.stringify({ mcpServers: { dbbackup: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'windsurf', label: 'Windsurf',
    file: '~/.codeium/windsurf/mcp_config.json',
    wrap: (url, key) => JSON.stringify({ mcpServers: { dbbackup: { serverUrl: url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'vscode', label: 'VS Code (Copilot)',
    file: '.vscode/mcp.json in your workspace',
    wrap: (url, key) => JSON.stringify({ servers: { dbbackup: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'cline', label: 'Cline (VS Code)',
    file: 'Cline: MCP Servers → Configure → cline_mcp_settings.json',
    wrap: (url, key) => JSON.stringify({ mcpServers: { dbbackup: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'zed', label: 'Zed',
    file: 'settings.json (~/.config/zed/settings.json)',
    wrap: (url, key) => JSON.stringify({ context_servers: { dbbackup: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'zcode', label: 'ZCode',
    file: '~/.zcode/cli/config.json (mcp.servers) — if url-type is unsupported on your build, use the mcp-remote stdio variant in the README',
    wrap: (url, key) => JSON.stringify({ mcp: { servers: { dbbackup: { url, headers: { Authorization: `Bearer ${key}` }, enabled: true } } } }, null, 2),
  },
  {
    id: 'kiro', label: 'Kiro',
    file: '.kiro/settings/mcp.json in your workspace',
    wrap: (url, key) => JSON.stringify({ mcpServers: { dbbackup: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'codex', label: 'Codex CLI',
    file: '~/.codex/config.toml (TOML, not JSON)',
    wrap: (url, key) => `[mcp_servers.dbbackup]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${key}" }`,
  },
  {
    id: 'gemini', label: 'Gemini CLI',
    file: '~/.gemini/settings.json',
    wrap: (url, key) => JSON.stringify({ mcpServers: { dbbackup: { httpUrl: url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'trae', label: 'Trae',
    file: 'Trae: MCP → + Add Server (or mcp.json)',
    wrap: (url, key) => JSON.stringify({ mcpServers: { dbbackup: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'goose', label: 'Goose',
    file: '~/.config/goose/config.yaml',
    wrap: (url, key) => `mcpservers:\n  dbbackup:\n    url: ${url}\n    headers:\n      Authorization: Bearer ${key}`,
  },
]

function ConnectAgentHelper({ endpoint }: { endpoint: string }) {
  const [agentId, setAgentId] = useState('claude-desktop')
  const agent = MCP_AGENTS.find((a) => a.id === agentId) ?? MCP_AGENTS[0]
  const snippet = agent.wrap(endpoint, 'dbbk_mcp_PASTE_YOUR_KEY')

  return (
    <div className="border-t pt-4 space-y-2">
      <p className="text-sm font-medium text-gray-700">Connect your agent</p>
      <div className="flex gap-2 flex-wrap">
        {MCP_AGENTS.map((a) => (
          <button
            key={a.id}
            onClick={() => setAgentId(a.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              agentId === a.id ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-400">{agent.file}</p>
      <div className="flex gap-2 items-start">
        <pre className="flex-1 text-xs font-mono bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto">{snippet}</pre>
        <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(snippet); toast.success('Config copied') }}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

function McpTab() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['read'])
  const [approvalRequired, setApprovalRequired] = useState(false)
  const [dailyCallLimit, setDailyCallLimit] = useState<number | undefined>()
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [rotatedKey, setRotatedKey] = useState<string | null>(null)
  const endpoint = `${window.location.origin}/mcp`

  const { data, isLoading } = useQuery({ queryKey: ['mcp-keys'], queryFn: () => mcpApi.list() })
  const keys: McpKey[] = data?.data.data.keys ?? []

  const createMutation = useMutation({
    mutationFn: () => mcpApi.create({ name, scopes, approvalRequired, dailyCallLimit }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['mcp-keys'] })
      setCreatedKey(res.data.data.key)
      setName('')
      toast.success('API key created — copy it now')
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to create key'),
  })


  const { data: pendingData } = useQuery({
    queryKey: ['mcp-approvals'],
    queryFn: () => mcpApprovalsApi.pending(),
    refetchInterval: 10_000,
  })
  const pending: PendingApproval[] = pendingData?.data.data.approvals ?? []

  const approveMutation = useMutation({
    mutationFn: (id: string) => mcpApprovalsApi.approve(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mcp-approvals'] }); toast.success('Action executed') },
    onError: () => toast.error('Failed to execute'),
  })
  const denyMutation = useMutation({
    mutationFn: (id: string) => mcpApprovalsApi.deny(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mcp-approvals'] }); toast.success('Denied') },
    onError: () => toast.error('Failed to deny'),
  })

  const rotateMutation = useMutation({
    mutationFn: (id: string) => mcpApi.rotate(id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['mcp-keys'] })
      setRotatedKey(res.data.data.key)
      toast.success('Key rotated — copy the new key now')
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to rotate'),
  })

  const revokeMutation = useMutation({
    mutationFn: (id: string) => mcpApi.revoke(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mcp-keys'] }); toast.success('Key revoked') },
    onError: () => toast.error('Failed to revoke key'),
  })

  const toggleScope = (s: string) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle><span className="flex items-center gap-2"><Bot className="h-4 w-4" />AI Agent Access (MCP)</span></CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-500">
            Let AI agents (Claude, Cursor, …) operate DbBackup via the Model Context Protocol —
            with scoped API keys, per-call audit logging and instant revocation.
          </p>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs font-mono text-gray-600 space-y-1">
            <div>Endpoint: <span className="font-bold">{endpoint}</span></div>
            <div>Header: Authorization: Bearer dbbk_mcp_…</div>
            <div>Transport: Streamable HTTP (JSON-RPC 2.0)</div>
          </div>

          <ConnectAgentHelper endpoint={endpoint} />

          <div className="border-t pt-4 space-y-3">
            <Input label="Key name" placeholder="e.g. Claude Desktop" value={name} onChange={(e) => setName(e.target.value)} />
            <div>
              <p className="text-sm font-medium text-gray-700 mb-1">Scopes</p>
              <div className="flex gap-4 flex-wrap">
                {[
                  { id: 'read', label: 'Read (list, status, heartbeat, logs)' },
                  { id: 'write', label: 'Write (+ trigger backup, verify)' },
                  { id: 'admin', label: 'Admin (+ delete backups)' },
                ].map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm text-gray-600">
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={scopes.includes(s.id)}
                      onChange={() => toggleScope(s.id)}
                    />
                    {s.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">admin ⊃ write ⊃ read (implied automatically)</p>
              <label className="flex items-center gap-2 text-sm text-gray-600 mt-2">
                <input type="checkbox" className="rounded" checked={approvalRequired} onChange={(e) => setApprovalRequired(e.target.checked)} />
                Require approval for write/admin tools (human-in-the-loop)
              </label>
              <div className="mt-2">
                <label className="text-sm font-medium text-gray-700">Daily call limit (optional)</label>
                <input
                  type="number"
                  min={1}
                  placeholder="e.g. 100 — leave empty for unlimited"
                  className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={dailyCallLimit ?? ''}
                  onChange={(e) => setDailyCallLimit(e.target.value ? Number(e.target.value) : undefined)}
                />
                <p className="text-xs text-gray-400 mt-1">Caps the agent's tool calls per day (resets at midnight UTC). Prevents runaway agents from hammering your databases.</p>
              </div>
            </div>
            <Button onClick={() => createMutation.mutate()} disabled={!name.trim() || scopes.length === 0} loading={createMutation.isPending}>
              <KeyRound className="h-4 w-4" />Create API key
            </Button>
          </div>

          {rotatedKey && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
              <p className="text-sm font-medium text-blue-800">Key rotated! Copy the NEW key now (old key is dead):</p>
              <div className="flex gap-2 items-center">
                <code className="flex-1 text-xs font-mono bg-white border rounded p-2 break-all">{rotatedKey}</code>
                <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(rotatedKey); toast.success('Copied') }}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRotatedKey(null)}>✕</Button>
              </div>
            </div>
          )}

          {createdKey && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 space-y-2">
              <p className="text-sm font-medium text-yellow-800">Copy this key now — it cannot be shown again:</p>
              <div className="flex gap-2 items-center">
                <code className="flex-1 text-xs font-mono bg-white border rounded p-2 break-all">{createdKey}</code>
                <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(createdKey); toast.success('Copied') }}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {pending.length > 0 && (
        <Card className="border-amber-200">
          <CardHeader>
            <CardTitle className="text-amber-700">
              ⏸ Pending approvals ({pending.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pending.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-4 border border-amber-100 rounded-lg p-3 bg-amber-50/50">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">
                    <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{a.tool}</code>
                    <span className="text-gray-400 ml-2">via {a.keyName}</span>
                  </p>
                  {/* Show every argument in full: the owner must see exactly what will run */}
                  <pre className="text-xs text-gray-600 mt-1 whitespace-pre-wrap break-all font-mono bg-white/60 rounded p-1.5 max-h-48 overflow-auto">
                    {JSON.stringify(a.args ?? {}, null, 2)}
                  </pre>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" onClick={() => approveMutation.mutate(a.id)} loading={approveMutation.isPending && approveMutation.variables === a.id}>
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" className="text-red-500" onClick={() => denyMutation.mutate(a.id)}>
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Active keys <span className="text-sm font-normal text-gray-400">({keys.length})</span></CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
          {!isLoading && keys.length === 0 && <p className="text-sm text-gray-400">No keys yet.</p>}
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between gap-4 border border-gray-100 rounded-lg p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">{k.name}</p>
                <p className="text-xs text-gray-400 font-mono">{k.keyPrefix}…</p>
                <p className="text-xs text-gray-400 flex gap-2 flex-wrap mt-0.5">
                  <span>{k.scopes.join(', ')}</span>
                  <span>created {formatDate(k.createdAt)}</span>
                  {k.lastUsedAt && <span>last used {formatDate(k.lastUsedAt)}</span>}
                  {k.expiresAt && <span className="text-orange-500">expires {formatDate(k.expiresAt)}</span>}
                </p>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-blue-600 hover:bg-blue-50"
                  onClick={() => rotateMutation.mutate(k.id)}
                  loading={rotateMutation.isPending && rotateMutation.variables === k.id}
                  title="Generate a new key — old one stops working immediately"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-500 hover:bg-red-50"
                  onClick={() => revokeMutation.mutate(k.id)}
                  loading={revokeMutation.isPending && revokeMutation.variables === k.id}
                >
                  Revoke
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'security', label: 'Security' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'storage', label: 'Storage' },
  { id: 'mcp', label: 'AI / MCP' },
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
        <div className="space-y-4">
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
        </div>
      )}

      {activeTab === 'security' && (
        <>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 pt-2">Sign-in sessions</h3>
          <SessionsTab />
        </>
      )}
      {activeTab === 'security' && (
        <>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 pt-2">Passkeys</h3>
          <PasskeysCard />
          <PasswordLoginToggle />
        </>
      )}
      {activeTab === 'notifications' && <NotificationsTab />}
      {activeTab === 'storage' && <StorageTab />}
      {activeTab === 'mcp' && <McpTab />}
    </div>
  )
}
