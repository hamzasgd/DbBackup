import { cn } from '../../lib/utils'

interface BadgeProps {
  className?: string
  children: React.ReactNode
}

export function Badge({ className, children }: BadgeProps) {
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', className)}>
      {children}
    </span>
  )
}
