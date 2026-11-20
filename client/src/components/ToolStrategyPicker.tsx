import { Server, Zap } from 'lucide-react'
import { cn } from '../lib/utils'
import { type ToolStrategy, sshServerStrategyAvailable } from '../lib/tool-strategy'

/**
 * "Run on" choice for a backup, restore or schedule: the tools run here
 * through the SSH tunnel (default), or on the connection's SSH server next to
 * the database. Renders nothing for connections where only the first exists.
 */
export function ToolStrategyPicker({ value, onChange, connection, action }: {
  value: ToolStrategy
  onChange: (value: ToolStrategy) => void
  connection: { type: string; sshEnabled: boolean; sshHost?: string } | undefined
  action: 'backup' | 'restore'
}) {
  if (!sshServerStrategyAvailable(connection)) return null
  const tool = action === 'backup' ? 'mysqldump' : 'mysql'
  const where = connection?.sshHost ? <b className="font-medium">{connection.sshHost}</b> : 'the SSH server'

  const options: { value: ToolStrategy; title: string; text: React.ReactNode; icon: typeof Server }[] = [
    {
      value: 'TUNNEL',
      title: 'DbBackup server (default)',
      text: <>Runs {tool} here and connects through the SSH tunnel. Works everywhere.</>,
      icon: Server,
    },
    {
      value: 'SSH_SERVER',
      title: 'SSH server — faster for remote databases',
      text: (
        <>
          Runs {tool} on {where}, next to the database; only compressed data travels over the internet. Needs the
          MySQL client and gzip installed there, and an SSH login that may run commands.
        </>
      ),
      icon: Zap,
    },
  ]

  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-gray-700 mb-1">Run on</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            'flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer text-sm',
            value === o.value ? 'border-blue-400 bg-blue-50/60' : 'border-gray-200 hover:border-gray-300',
          )}
        >
          <input
            type="radio"
            className="mt-1"
            name={`strategy-${action}`}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium text-gray-900">
              <o.icon className="h-3.5 w-3.5 text-gray-500" />{o.title}
            </span>
            <span className="block text-xs text-gray-500 mt-0.5">{o.text}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}
