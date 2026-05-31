import { useEffect, useState } from 'react'
import { reportsApi } from '../utils/api'
import { BarChart3, CheckCircle, XCircle, Clock } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Legend
} from 'recharts'
import clsx from 'clsx'

export default function Reports() {
  const [summary, setSummary] = useState(null)
  const [uptime, setUptime] = useState([])
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([reportsApi.summary(days), reportsApi.uptime()])
      .then(([s, u]) => { setSummary(s.data); setUptime(u.data) })
      .finally(() => setLoading(false))
  }, [days])

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  const alertsByDay = summary?.alerts_by_day?.map(d => ({ date: d.date.slice(5), count: d.count })) || []

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Reports</h1>
          <p className="text-gray-500 text-sm mt-1">Network summary and device uptime</p>
        </div>
        <select className="input w-36" value={days} onChange={e => setDays(+e.target.value)}>
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Devices', value: summary?.total_devices, icon: BarChart3, color: 'text-teal-600' },
          { label: `Alerts (${days}d)`, value: summary?.total_alerts, icon: BarChart3, color: 'text-amber-600' },
          { label: 'Critical', value: summary?.critical_alerts, icon: XCircle, color: 'text-red-600' },
          { label: 'Traps', value: summary?.total_traps, icon: Clock, color: 'text-blue-600' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card p-5 flex items-center gap-4">
            <Icon size={24} className={color} />
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{value ?? '–'}</p>
              <p className="text-sm text-gray-500">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Alerts by day chart */}
      <div className="card p-6">
        <h3 className="font-semibold text-gray-800 dark:text-gray-200 mb-4">Alerts per day</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={alertsByDay}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar dataKey="count" fill="#14b8a6" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Uptime table */}
      <div className="card">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
          <h3 className="font-semibold text-gray-800 dark:text-gray-200">Device Uptime</h3>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {uptime.length === 0 ? (
            <div className="py-12 text-center text-gray-400">
              <BarChart3 size={32} className="mx-auto mb-3 opacity-30" />
              <p>No uptime data yet — add devices and let them be polled</p>
            </div>
          ) : uptime.map(d => (
            <div key={d.ip} className="flex items-center gap-4 px-5 py-3">
              <span className={clsx('w-2.5 h-2.5 rounded-full flex-shrink-0',
                d.status === 'online' ? 'bg-green-500' : d.status === 'offline' ? 'bg-red-500' : 'bg-amber-500')} />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-gray-200 truncate">{d.name}</p>
                <p className="text-xs text-gray-400 font-mono">{d.ip}</p>
              </div>
              <div className="text-right text-sm">
                <p className="font-semibold text-gray-700 dark:text-gray-300">
                  {d.uptime_hours > 0 ? `${d.uptime_hours}h uptime` : 'Unknown'}
                </p>
                <p className="text-xs text-gray-400">
                  {d.last_seen ? `Last seen ${new Date(d.last_seen).toLocaleString()}` : 'Never seen'}
                </p>
              </div>
              {d.failures > 0 && (
                <span className="badge badge-critical text-xs">{d.failures} fail{d.failures > 1 ? 's' : ''}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
