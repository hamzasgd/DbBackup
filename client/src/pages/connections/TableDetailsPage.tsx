import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, AlertCircle, RefreshCw, Table2, HardDrive, Rows3, Key, Link2, Hash } from 'lucide-react'
import { connectionsApi } from '../../services/connections.service'
import { cn, formatBytes } from '../../lib/utils'

function decodeTableName(raw: string | undefined): string {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export default function TableDetailsPage() {
  const { id, tableName } = useParams<{ id: string; tableName: string }>()
  const navigate = useNavigate()
  const decodedTableName = decodeTableName(tableName)

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['db-info', id],
    queryFn: () => connectionsApi.getInfo(id!),
    staleTime: 60_000,
    retry: 1,
    enabled: !!id,
  })

  const info = data?.data.data
  const table = useMemo(() => info?.tables.find((t) => t.name === decodedTableName), [info, decodedTableName])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate(`/connections/${id}/info`)}
          className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          title="Back to connection info"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Table2 className="h-6 w-6 text-blue-600" />
            <span className="font-mono truncate">{decodedTableName || 'Table Details'}</span>
          </h1>
          {info && <p className="text-sm text-gray-500 mt-0.5">Database: <span className="font-mono">{info.database}</span></p>}
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

      {isLoading && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm flex flex-col items-center justify-center py-24 gap-3">
          <RefreshCw className="h-8 w-8 text-blue-400 animate-spin" />
          <p className="text-sm text-gray-500">Loading table metadata...</p>
        </div>
      )}

      {isError && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm flex flex-col items-center justify-center py-20 gap-3">
          <AlertCircle className="h-10 w-10 text-red-400" />
          <p className="text-sm font-medium text-gray-700">Failed to load table details</p>
          <p className="text-xs text-gray-400 font-mono max-w-sm text-center">
            {(error as { response?: { data?: { message?: string } } })?.response?.data?.message
              ?? (error as Error)?.message
              ?? 'Unknown error'}
          </p>
        </div>
      )}

      {!isLoading && !isError && !table && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm flex flex-col items-center justify-center py-20 gap-3">
          <AlertCircle className="h-10 w-10 text-amber-400" />
          <p className="text-sm font-medium text-gray-700">Table not found</p>
          <p className="text-xs text-gray-400">The table may have been renamed or removed.</p>
        </div>
      )}

      {table && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Rows</p>
              <p className="text-sm font-semibold text-gray-800 flex items-center gap-1 mt-1">
                <Rows3 className="h-4 w-4 text-gray-500" /> {table.rowCount.toLocaleString()}
              </p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Physical</p>
              <p className="text-sm font-semibold text-gray-800 flex items-center gap-1 mt-1">
                <HardDrive className="h-4 w-4 text-gray-500" /> {formatBytes(table.sizeBytes)}
              </p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Logical</p>
              <p className="text-sm font-semibold text-gray-800 mt-1">{formatBytes(table.logicalSizeBytes)}</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Primary Key</p>
              <p className="text-sm font-semibold text-gray-800 mt-1">{table.primaryKeyColumns.length || 0}</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Indexes</p>
              <p className="text-sm font-semibold text-gray-800 mt-1">{table.indexes.length}</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Foreign Keys</p>
              <p className="text-sm font-semibold text-gray-800 mt-1">{table.foreignKeys.length}</p>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">Columns ({table.columns.length})</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100 text-gray-500 uppercase tracking-wide">
                    <th className="text-left px-4 py-2 font-medium">Name</th>
                    <th className="text-left px-4 py-2 font-medium">Type</th>
                    <th className="text-left px-4 py-2 font-medium">Nullable</th>
                    <th className="text-left px-4 py-2 font-medium">Default</th>
                    <th className="text-left px-4 py-2 font-medium">Constraints</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {table.columns.map((col) => (
                    <tr key={col.name} className="hover:bg-blue-50/40 transition-colors">
                      <td className="px-4 py-2 font-mono font-medium text-gray-800">{col.name}</td>
                      <td className="px-4 py-2 font-mono text-blue-600">{col.type}</td>
                      <td className="px-4 py-2 text-gray-700">{col.nullable ? 'YES' : 'NO'}</td>
                      <td className="px-4 py-2 font-mono text-gray-500">{col.defaultValue ?? '—'}</td>
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
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">Primary Key</h3>
              </div>
              <div className="p-4">
                {table.primaryKeyColumns.length === 0 ? (
                  <p className="text-xs text-gray-400">No primary key defined.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {table.primaryKeyColumns.map((c) => (
                      <span key={c} className="px-2 py-1 rounded bg-amber-100 text-amber-800 text-xs font-mono">{c}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">Unique Constraints</h3>
              </div>
              <div className="p-4 space-y-2">
                {table.uniqueConstraints.length === 0 ? (
                  <p className="text-xs text-gray-400">No unique constraints found.</p>
                ) : table.uniqueConstraints.map((u) => (
                  <div key={u.name} className="border border-gray-100 rounded p-2">
                    <p className="text-xs font-medium text-gray-800 font-mono">{u.name}</p>
                    <p className="text-xs text-gray-500 mt-1">{u.columns.join(', ')}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">Foreign Keys</h3>
              </div>
              <div className="p-4 space-y-2">
                {table.foreignKeys.length === 0 ? (
                  <p className="text-xs text-gray-400">No foreign keys found.</p>
                ) : table.foreignKeys.map((fk) => (
                  <div key={`${fk.constraintName}:${fk.column}`} className="border border-gray-100 rounded p-2">
                    <p className="text-xs font-medium text-gray-800 font-mono">{fk.constraintName}</p>
                    <p className="text-xs text-gray-500 mt-1">{fk.column} -&gt; {fk.referencedTable}.{fk.referencedColumn}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">Indexes ({table.indexes.length})</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100 text-gray-500 uppercase tracking-wide">
                    <th className="text-left px-4 py-2 font-medium">Name</th>
                    <th className="text-left px-4 py-2 font-medium">Columns</th>
                    <th className="text-left px-4 py-2 font-medium">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {table.indexes.map((idx) => (
                    <tr key={idx.name} className="hover:bg-blue-50/40 transition-colors">
                      <td className="px-4 py-2 font-mono text-gray-800">{idx.name}</td>
                      <td className="px-4 py-2 text-gray-700">{idx.columns.join(', ')}</td>
                      <td className="px-4 py-2">
                        {idx.primary ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-xs font-medium">PRIMARY</span>
                        ) : idx.unique ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-xs font-medium">UNIQUE</span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded bg-purple-100 text-purple-700 text-xs font-medium">INDEX</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
