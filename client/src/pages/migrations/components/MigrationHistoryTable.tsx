import { Trash2, MoveRight } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Badge } from '../../../components/ui/Badge'
import { MigrationStatusIcon, MigrationStatusBadge } from './MigrationStatusBadge'
import { durationLabel, rowsLabel } from './MigrationLabels'
import { dbTypeLabel, dbTypeBadgeColor, formatDate } from '../../../lib/utils'
import type { Migration } from '../../../services/migrations.service'

interface MigrationHistoryTableProps {
  migrations: Migration[]
  onVerify: (id: string) => void
  onTableVerify: (m: Migration) => void
  onDelete: (id: string) => void
  verifyLoading?: boolean
}

export function MigrationHistoryTable({
  migrations,
  onVerify,
  onTableVerify,
  onDelete,
  verifyLoading,
}: MigrationHistoryTableProps) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50">
          <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Route</th>
          <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
          <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Tables</th>
          <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Rows</th>
          <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
          <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
          <th className="px-4 py-3"></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {migrations.map(m => (
          <tr key={m.id} className="hover:bg-gray-50">
            <td className="px-6 py-3">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1">
                  <Badge className={dbTypeBadgeColor(m.sourceConnection?.type ?? '')}>{dbTypeLabel(m.sourceConnection?.type ?? '')}</Badge>
                  <span className="text-gray-700 font-medium">{m.sourceConnection?.name}</span>
                </div>
                <MoveRight className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                <div className="flex items-center gap-1">
                  <Badge className={dbTypeBadgeColor(m.targetConnection?.type ?? '')}>{dbTypeLabel(m.targetConnection?.type ?? '')}</Badge>
                  <span className="text-gray-700 font-medium">{m.targetConnection?.name}</span>
                </div>
              </div>
              {m.notes && <p className="text-xs text-gray-400 mt-0.5">{m.notes}</p>}
            </td>
            <td className="px-6 py-3">
              <div className="flex items-center gap-1.5">
                <MigrationStatusIcon status={m.status} />
                <MigrationStatusBadge status={m.status} />
              </div>
              {m.error && <p className="text-xs text-red-500 mt-0.5 max-w-[220px] truncate" title={m.error}>{m.error}</p>}
            </td>
            <td className="px-6 py-3 text-gray-600">{m.tablesCompleted} / {m.tableCount}</td>
            <td
              className="px-6 py-3 text-gray-600"
              title={m.rowsMigrated === -1 ? 'Stream mode does not provide exact migrated row count.' : undefined}
            >
              {rowsLabel(m.rowsMigrated)}
            </td>
            <td className="px-6 py-3 text-gray-500 text-xs">{durationLabel(m)}</td>
            <td className="px-6 py-3 text-gray-500 text-xs">{formatDate(m.createdAt)}</td>
            <td className="px-4 py-3">
              <div className="flex items-center gap-1 justify-end">
                {m.status === 'COMPLETED' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-blue-600 hover:bg-blue-50"
                    onClick={() => onVerify(m.id)}
                    loading={verifyLoading}
                  >
                    Verify
                  </Button>
                )}
                {m.status === 'COMPLETED' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-indigo-600 hover:bg-indigo-50"
                    onClick={() => onTableVerify(m)}
                  >
                    Table Verify
                  </Button>
                )}
                <Button
                  size="sm" variant="ghost"
                  className="text-red-500 hover:bg-red-50"
                  onClick={() => onDelete(m.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
