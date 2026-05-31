// src/pages/Devices.jsx
import { useEffect, useState } from 'react'
import { devicesApi } from '../utils/api'
import { Monitor, RefreshCw, Plus, Trash2, Radio } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const STATUS_BADGE = {
  online: 'badge-online', offline: 'badge-critical', warning: 'badge-warning', unknown: 'bg-gray-100 text-gray-600'
}

export default function Devices() {
  const [devices, setDevices] = useState([])
  const [selected, setSelected] = useState(null)
  const [metrics, setMetrics] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const load = async () => {
    try {
      const res = await devicesApi.list({ limit: 200 })
      setDevices(res.data)
    } catch { toast.error('Could not load devices') }
    finally { setLoading(false) }
  }

  const loadMetrics = async (id) => {
    try {
      const res = await devicesApi.metrics(id, 6)
      setMetrics(res.data.map(m => ({ ...m, time: new Date(m.timestamp).toLocaleTimeString() })))
    } catch { setMetrics([]) }
  }

  const selectDevice = (d) => { setSelected(d); loadMetrics(d.id) }

  const pollNow = async (id) => {
    await devicesApi.poll(id)
    toast.success('Poll triggered — results in a few seconds')
  }

  const removeDevice = async (id) => {
    if (!confirm('Remove this device from monitoring?')) return
    await devicesApi.delete(id)
    setDevices(d => d.filter(x => x.id !== id))
    if (selected?.id === id) setSelected(null)
    toast.success('Device removed')
  }

  useEffect(() => { load() }, [])

  const filtered = devices.filter(d =>
    !filter || d.name.toLowerCase().includes(filter.toLowerCase()) ||
    d.ip_address.includes(filter) || d.device_type.includes(filter.toLowerCase())
  )

  return (
    <div className="flex gap-6 h-full animate-fade-in">
      {/* Device list */}
      <div className="flex-1 min-w-0 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Devices</h1>
          <div className="flex gap-2">
            <input type="text" className="input w-48" placeholder="Search devices..."
              value={filter} onChange={e => setFilter(e.target.value)} />
            <button onClick={load} className="btn-secondary flex items-center gap-2">
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <div className="card p-12 text-center"><div className="w-8 h-8 border-4 border-teal-500 border-t-transparent rounded-full animate-spin mx-auto" /></div>
        ) : (
          <div className="card divide-y divide-gray-100 dark:divide-gray-700">
            {filtered.map(d => (
              <div key={d.id}
                onClick={() => selectDevice(d)}
                className={clsx('flex items-center gap-4 p-4 cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800',
                  selected?.id === d.id && 'bg-teal-50 dark:bg-teal-900/20')}>
                <span className={clsx('w-3 h-3 rounded-full flex-shrink-0',
                  d.status === 'online' ? 'bg-green-500' :
                  d.status === 'offline' ? 'bg-red-500' :
                  d.status === 'warning' ? 'bg-amber-500' : 'bg-gray-400'
                )} />
                <Monitor size={18} className="text-gray-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{d.name}</p>
                  <p className="text-xs text-gray-500 font-mono">{d.ip_address}</p>
                </div>
                <span className={clsx('badge text-xs', STATUS_BADGE[d.status] || 'bg-gray-100 text-gray-600')}>
                  {d.status}
                </span>
                <span className="text-xs text-gray-400 hidden md:block">{d.device_type}</span>
                <div className="flex gap-1">
                  <button onClick={e => { e.stopPropagation(); pollNow(d.id) }}
                    className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700" title="Poll now">
                    <Radio size={14} className="text-teal-600" />
                  </button>
                  <button onClick={e => { e.stopPropagation(); removeDevice(d.id) }}
                    className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30" title="Remove">
                    <Trash2 size={14} className="text-red-400" />
                  </button>
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="p-12 text-center text-gray-400">
                <Monitor size={36} className="mx-auto mb-3 opacity-30" />
                <p>No devices found. Use Auto-Discover to scan your network.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="w-80 flex-shrink-0 space-y-4">
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-3">{selected.name}</h3>
            <table className="w-full text-sm">
              {[
                ['IP Address', selected.ip_address],
                ['Type', selected.device_type],
                ['Status', selected.status],
                ['SNMP', `${selected.snmp_version} / ${selected.snmp_community}`],
                ['Last seen', selected.last_seen ? new Date(selected.last_seen).toLocaleString() : 'Never'],
                ['Uptime', selected.uptime_seconds ? `${Math.floor(selected.uptime_seconds/3600)}h ${Math.floor((selected.uptime_seconds%3600)/60)}m` : 'Unknown'],
                ['Location', selected.sys_location || '—'],
              ].map(([k, v]) => (
                <tr key={k} className="border-b border-gray-100 dark:border-gray-700">
                  <td className="py-1.5 pr-2 text-gray-500">{k}</td>
                  <td className="py-1.5 text-gray-900 dark:text-gray-200 font-medium">{v}</td>
                </tr>
              ))}
            </table>
          </div>

          {metrics.length > 0 && (
            <div className="card p-5">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">CPU % (last 6h)</h4>
              <ResponsiveContainer width="100%" height={80}>
                <LineChart data={metrics}>
                  <Line type="monotone" dataKey="cpu_percent" stroke="#14b8a6" strokeWidth={2} dot={false} />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} hide />
                  <Tooltip formatter={v => v != null ? `${v}%` : 'N/A'} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {selected.notes && (
            <div className="card p-4">
              <p className="text-xs text-gray-500 font-medium mb-1">Notes</p>
              <p className="text-sm text-gray-700 dark:text-gray-300">{selected.notes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
