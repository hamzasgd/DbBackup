import { useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Database, Table2, ChevronDown, ChevronRight,
  Key, Hash, HardDrive, Rows3, RefreshCw, AlertCircle, ArrowLeft, Download, Link2,
} from 'lucide-react'
import { connectionsApi, type TableInfo } from '../../services/connections.service'
import { formatBytes, cn } from '../../lib/utils'
import { toast } from '../../store/toast.store'
import api from '../../lib/api'

type ExportFormat = 'json' | 'csv' | 'sql'
type SortOption = 'name-asc' | 'rows-desc' | 'physical-desc' | 'logical-desc' | 'idx-pct-desc' | 'extra-pct-desc'
type FilterOption = 'all' | 'high-idx' | 'high-extra'

function pct(part: number, base: number): string {
  if (base <= 0) return '0.0'
  return ((part / base) * 100).toFixed(1)
}

async function downloadExport(connectionId: string, tableName: string, format: ExportFormat) {
  try {
    const res = await api.post(
      `/connections/${connectionId}/export`,
      { tables: [tableName], format },
      { responseType: 'blob' }
    )
    const ext = format
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${tableName}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    toast.error(`Failed to export ${tableName}`)
  }
}

function TableRow({ table, connectionId }: { table: TableInfo; connectionId: string }) {
  const [open, setOpen] = useState(false)
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const regularIndexCount = table.indexes.filter((idx) => !idx.primary && !idx.unique).length

  const handleExport = async (format: ExportFormat) => {
    setExporting(format)
    await downloadExport(connectionId, table.name, format)
    setExporting(null)
  }

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      >
        <span className="text-gray-400">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <Table2 className="h-4 w-4 text-blue-500 shrink-0" />
        <span className="font-mono text-sm font-medium text-gray-800 flex-1 truncate">{table.name}</span>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <Rows3 className="h-3.5 w-3.5" />
              {table.rowCount.toLocaleString()} rows
            </span>
            <span className="flex items-center gap-1">
              <HardDrive className="h-3.5 w-3.5" />
              {formatBytes(table.sizeBytes)} physical
            </span>
            <span>{formatBytes(table.logicalSizeBytes)} logical</span>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
              IDX {formatBytes(table.indexSizeBytes)} ({pct(table.indexSizeBytes, table.logicalSizeBytes)}%)
            </span>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">
              Extra {formatBytes(table.extraStorageBytes)} ({pct(table.extraStorageBytes, table.logicalSizeBytes)}%)
            </span>
            <span>+{table.overheadPercent.toFixed(1)}% total</span>
            <span className="text-gray-400">{table.columns.length} cols</span>
            <span className="text-gray-400">PK {table.primaryKeyColumns.length}</span>
            <span className="text-gray-400">UQ {table.uniqueConstraints.length}</span>
            <span className="text-gray-400">IDX {regularIndexCount}</span>
            <span className="text-gray-400">FK {table.foreignKeys.length}</span>
          </div>
          {/* Export buttons */}
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <Link
              to={`/connections/${connectionId}/info/tables/${encodeURIComponent(table.name)}`}
              className="px-2 py-1 text-xs font-medium rounded border bg-white border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50"
            >
              Details
            </Link>
            {(['json', 'csv', 'sql'] as ExportFormat[]).map(fmt => (
              <button
                key={fmt}
                onClick={() => handleExport(fmt)}
                disabled={exporting !== null}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border transition-colors',
                  exporting === fmt
                    ? 'bg-blue-50 border-blue-300 text-blue-600 cursor-wait'
                    : 'bg-white border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50',
                  exporting !== null && exporting !== fmt && 'opacity-40 cursor-not-allowed'
                )}
                title={`Export as ${fmt.toUpperCase()}`}
              >
                <Download className="h-3 w-3" />
                {exporting === fmt ? '…' : fmt.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </button>

      {open && (
        <div className="overflow-x-auto">
          <div className="px-4 py-3 bg-white border-t border-gray-100">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-100 text-amber-800">
                <Key className="h-3 w-3" /> PK: {table.primaryKeyColumns.length > 0 ? table.primaryKeyColumns.join(', ') : 'none'}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-100 text-blue-800">
                <Hash className="h-3 w-3" /> Unique: {table.uniqueConstraints.length}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-purple-100 text-purple-800">
                <Hash className="h-3 w-3" /> Indexes: {regularIndexCount}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-100 text-emerald-800">
                <Link2 className="h-3 w-3" /> Foreign Keys: {table.foreignKeys.length}
              </span>
            </div>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-white border-t border-gray-100 text-gray-400 uppercase tracking-wide">
                <th className="text-left px-4 py-2 font-medium">Column</th>
                <th className="text-left px-4 py-2 font-medium">Type</th>
                <th className="text-left px-4 py-2 font-medium">Nullable</th>
                <th className="text-left px-4 py-2 font-medium">Default</th>
                <th className="text-left px-4 py-2 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {table.columns.map((col) => (
                <tr
                  key={col.name}
                  className={cn(
                    'hover:bg-blue-50/40 transition-colors',
                    col.isPrimaryKey && 'bg-amber-50/60'
                  )}
                >
                  <td className="px-4 py-2 font-mono font-medium text-gray-800">
                    <span className="flex items-center gap-1.5">
                      {col.isPrimaryKey && <Key className="h-3 w-3 text-amber-500 shrink-0" />}
                      {col.name}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-blue-600">{col.type}</td>
                  <td className="px-4 py-2">
                    <span className={cn(
                      'px-1.5 py-0.5 rounded text-xs font-medium',
                      col.nullable
                        ? 'bg-gray-100 text-gray-500'
                        : 'bg-red-50 text-red-600'
                    )}>
                      {col.nullable ? 'YES' : 'NO'}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-gray-500">
                    {col.defaultValue ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1 flex-wrap">
                      {col.isPrimaryKey && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-xs font-medium">
                          <Key className="h-2.5 w-2.5" /> PK
                        </span>
                      )}
                      {col.isUnique && !col.isPrimaryKey && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-xs font-medium">
                          <Hash className="h-2.5 w-2.5" /> UQ
                        </span>
                      )}
                      {col.isIndexed && !col.isPrimaryKey && !col.isUnique && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-xs font-medium">
                          <Hash className="h-2.5 w-2.5" /> IDX
                        </span>
                      )}
                      {col.isForeignKey && col.references && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs font-medium">
                          <Link2 className="h-2.5 w-2.5" /> FK -&gt; {col.references.table}.{col.references.column}
                        </span>
                      )}
                      {col.extra && col.extra !== '' && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-xs font-medium">
                          <Hash className="h-2.5 w-2.5" /> {col.extra}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function ConnectionInfoPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('idx-pct-desc')
  const [filterBy, setFilterBy] = useState<FilterOption>('all')

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['db-info', id],
    queryFn: () => connectionsApi.getInfo(id!),
    staleTime: 60_000,
    retry: 1,
    enabled: !!id,
  })

  const info = data?.data.data

  const tables = info?.tables ?? []
  const searchTerm = search.trim().toLowerCase()
  const processedTables = tables
    .filter((t) => t.name.toLowerCase().includes(searchTerm))
    .filter((t) => {
      if (filterBy === 'high-idx') return t.logicalSizeBytes > 0 && (t.indexSizeBytes / t.logicalSizeBytes) * 100 >= 20
      if (filterBy === 'high-extra') return t.logicalSizeBytes > 0 && (t.extraStorageBytes / t.logicalSizeBytes) * 100 >= 10
      return true
    })
    .sort((a, b) => {
      if (sortBy === 'name-asc') return a.name.localeCompare(b.name)
      if (sortBy === 'rows-desc') return b.rowCount - a.rowCount
      if (sortBy === 'physical-desc') return b.sizeBytes - a.sizeBytes
      if (sortBy === 'logical-desc') return b.logicalSizeBytes - a.logicalSizeBytes
      if (sortBy === 'idx-pct-desc') {
        const aPct = a.logicalSizeBytes > 0 ? (a.indexSizeBytes / a.logicalSizeBytes) * 100 : 0
        const bPct = b.logicalSizeBytes > 0 ? (b.indexSizeBytes / b.logicalSizeBytes) * 100 : 0
        return bPct - aPct
      }

      const aPct = a.logicalSizeBytes > 0 ? (a.extraStorageBytes / a.logicalSizeBytes) * 100 : 0
      const bPct = b.logicalSizeBytes > 0 ? (b.extraStorageBytes / b.logicalSizeBytes) * 100 : 0
      return bPct - aPct
    })

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate('/connections')}
          className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          title="Back to connections"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Database className="h-6 w-6 text-blue-600" />
            {info?.database ?? 'Database Info'}
          </h1>
          {info && (
            <p className="text-sm text-gray-500 font-mono mt-0.5">{info.version}</p>
          )}
          {isLoading && (
            <p className="text-sm text-gray-400 mt-0.5">Loading…</p>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* Stats bar */}
      {info && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-4">
          <div className="bg-white border border-gray-200 rounded-xl px-6 py-4 text-center shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Database</p>
            <p className="text-sm font-semibold text-gray-800 font-mono">{info.database}</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-6 py-4 text-center shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Physical Size</p>
            <p className="text-sm font-semibold text-gray-800">{formatBytes(info.totalSizeBytes)}</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-6 py-4 text-center shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Logical Size</p>
            <p className="text-sm font-semibold text-gray-800">{formatBytes(info.logicalSizeBytes)}</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-6 py-4 text-center shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Overhead</p>
            <p className="text-sm font-semibold text-gray-800">{formatBytes(info.overheadBytes)}</p>
            <p className="text-xs text-gray-500 mt-1">+{info.overheadPercent.toFixed(1)}%</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-6 py-4 text-center shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Index Overhead</p>
            <p className="text-sm font-semibold text-gray-800">{formatBytes(info.indexSizeBytes)}</p>
            <p className="text-xs text-gray-500 mt-1">{pct(info.indexSizeBytes, info.logicalSizeBytes)}%</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-6 py-4 text-center shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Extra Storage</p>
            <p className="text-sm font-semibold text-gray-800">{formatBytes(info.extraStorageBytes)}</p>
            <p className="text-xs text-gray-500 mt-1">{pct(info.extraStorageBytes, info.logicalSizeBytes)}%</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-6 py-4 text-center shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Tables</p>
            <p className="text-sm font-semibold text-gray-800">{info.tableCount}</p>
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm flex flex-col items-center justify-center py-24 gap-3">
          <RefreshCw className="h-8 w-8 text-blue-400 animate-spin" />
          <p className="text-sm text-gray-500">Fetching schema info…</p>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm flex flex-col items-center justify-center py-20 gap-3">
          <AlertCircle className="h-10 w-10 text-red-400" />
          <p className="text-sm font-medium text-gray-700">Failed to load database info</p>
          <p className="text-xs text-gray-400 font-mono max-w-sm text-center">
            {(error as { response?: { data?: { message?: string } } })?.response?.data?.message
              ?? (error as Error)?.message
              ?? 'Unknown error'}
          </p>
          <button
            onClick={() => refetch()}
            className="mt-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Tables */}
      {info && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          {/* Search bar */}
          <div className="px-6 py-4 border-b border-gray-100 flex flex-col lg:flex-row gap-3">
            <input
              type="text"
              placeholder="Filter tables by name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full lg:flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select
              value={filterBy}
              onChange={(e) => setFilterBy(e.target.value as FilterOption)}
              className="w-full lg:w-52 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              title="Filter diagnostic categories"
            >
              <option value="all">All tables</option>
              <option value="high-idx">High IDX percent (&gt;= 20%)</option>
              <option value="high-extra">High Extra percent (&gt;= 10%)</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="w-full lg:w-64 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              title="Sort tables"
            >
              <option value="idx-pct-desc">Sort: IDX percent (high to low)</option>
              <option value="extra-pct-desc">Sort: Extra percent (high to low)</option>
              <option value="physical-desc">Sort: Physical size (high to low)</option>
              <option value="logical-desc">Sort: Logical size (high to low)</option>
              <option value="rows-desc">Sort: Rows (high to low)</option>
              <option value="name-asc">Sort: Name (A-Z)</option>
            </select>
          </div>

          {/* Table list */}
          <div className="p-4">
            {processedTables.length === 0 ? (
              <p className="text-center text-sm text-gray-400 py-8">
                {search || filterBy !== 'all' ? 'No tables matched current filters' : 'No tables found'}
              </p>
            ) : (
              <div className="space-y-2">
                {processedTables.map(table => (
                  <TableRow key={table.name} table={table} connectionId={id!} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
