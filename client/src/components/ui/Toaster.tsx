import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react'
import { useToastStore } from '../../store/toast.store'
import { cn } from '../../lib/utils'

export function Toaster() {
  const { toasts, remove } = useToastStore()

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg border text-sm',
            'transition-all duration-300 ease-out',
            t.type === 'success' && 'bg-green-50 border-green-200 text-green-800',
            t.type === 'error' && 'bg-red-50 border-red-200 text-red-800',
            t.type === 'warning' && 'bg-yellow-50 border-yellow-200 text-yellow-800',
            t.type === 'info' && 'bg-blue-50 border-blue-200 text-blue-800',
          )}
        >
          {t.type === 'success' && <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />}
          {t.type === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
          {t.type === 'warning' && <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />}
          {t.type === 'info' && <Info className="h-4 w-4 mt-0.5 shrink-0" />}
          <span className="flex-1">{t.message}</span>
          <button onClick={() => remove(t.id)} className="shrink-0 opacity-60 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
