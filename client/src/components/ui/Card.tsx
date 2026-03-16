import { cn } from '../../lib/utils'
import { type ReactNode } from 'react'

interface CardProps {
  className?: string
  children: ReactNode
}

export function Card({ className, children }: CardProps) {
  return (
    <div className={cn('bg-white rounded-xl border border-gray-200 shadow-sm', className)}>
      {children}
    </div>
  )
}

export function CardHeader({ className, children }: CardProps) {
  return (
    <div className={cn('px-6 py-4 border-b border-gray-100 flex items-center justify-between', className)}>
      {children}
    </div>
  )
}

export function CardTitle({ className, children }: CardProps) {
  return <h3 className={cn('text-base font-semibold text-gray-900', className)}>{children}</h3>
}

export function CardContent({ className, children }: CardProps) {
  return <div className={cn('px-6 py-4', className)}>{children}</div>
}
