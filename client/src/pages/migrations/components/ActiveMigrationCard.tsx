import { MoveRight, Info } from 'lucide-react'
import { Card, CardContent } from '../../../components/ui/Card'
import { Badge } from '../../../components/ui/Badge'
import { useProgressSSE } from '../../../hooks/useProgressSSE'
import { MigrationStatusIcon, MigrationStatusBadge } from './MigrationStatusBadge'
import { durationLabel, rowsLabel } from './MigrationLabels'
import { cn } from '../../../lib/utils'
import type { Migration } from '../../../services/migrations.service'

export function ActiveMigrationCard({ m }: { m: Migration }) {
  const isActive = m.status === 'RUNNING' || m.status === 'PENDING'
  const sse = useProgressSSE(`/migrations/${m.id}/progress`, isActive)

  const progress = sse?.progress ?? m.progress
  const currentTable = sse?.currentTable ?? m.currentTable
  const tablesCompleted = sse?.tablesCompleted ?? m.tablesCompleted
  const tableCount = sse?.tableCount ?? m.tableCount
  const rowsMigrated = sse?.rowsMigrated ?? m.rowsMigrated
  const isStreamMode = rowsMigrated === -1 || /dump pipe|pgloader/i.test(currentTable ?? '')

  return (
    <Card className="border-blue-200 bg-blue-50/40">
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start gap-4">
          <div className="mt-0.5"><MigrationStatusIcon status={m.status} /></div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-gray-900">{m.sourceConnection?.name}</span>
              <MoveRight className="h-4 w-4 text-gray-400 shrink-0" />
              <span className="font-medium text-gray-900">{m.targetConnection?.name}</span>
              <MigrationStatusBadge status={m.status} />
            </div>

            {currentTable && (
              <p className="text-xs text-gray-500 mt-1">
                Currently migrating: <span className="font-mono text-blue-600">{currentTable}</span>
              </p>
            )}

            <div className="mt-3 space-y-1">
              <div className="flex justify-between text-xs text-gray-500">
                <span>{tablesCompleted} / {tableCount} tables</span>
                <span className="inline-flex items-center gap-1">
                  {isStreamMode ? 'Streaming' : `${progress}%`}
                  {isStreamMode && (
                    <span
                      className="inline-flex items-center text-gray-400"
                      title="This migration runs in stream mode (CLI pipe), so exact row-by-row progress is not available."
                    >
                      <Info className="h-3.5 w-3.5" />
                    </span>
                  )}
                </span>
              </div>
              <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-700',
                    isStreamMode ? 'bg-blue-400 animate-pulse w-full' : 'bg-blue-500'
                  )}
                  style={isStreamMode ? undefined : { width: `${progress}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-400">
                <span>{rowsLabel(rowsMigrated)} rows migrated</span>
                <span>Running for {durationLabel(m)}</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
