import { cn } from '../../lib/utils'
import { Card } from './Card'
import { CardContent } from './Card'

/** Stat tile used by the dashboard and the super-admin page. */
export function StatCard({
  icon: Icon, label, value, sub, tone,
}: {
  icon: React.ElementType
  label: string
  value: string | number
  sub?: React.ReactNode
  tone: 'blue' | 'violet' | 'green' | 'amber'
}) {
  const tones = {
    blue: 'bg-blue-50 text-blue-600',
    violet: 'bg-violet-50 text-violet-600',
    green: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
  } as const
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">{label}</p>
            <p className="mt-1.5 text-2xl font-bold text-gray-900 tabular-nums leading-none">{value}</p>
            {sub && <p className="mt-2 text-xs text-gray-500 truncate">{sub}</p>}
          </div>
          <div className={cn('rounded-lg p-2.5 shrink-0', tones[tone])}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
