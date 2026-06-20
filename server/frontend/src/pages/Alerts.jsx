import { useEffect, useState } from 'react'
import { alertsApi } from '../utils/api'
import { AlertTriangle, CheckCircle, XCircle, Clock, Filter } from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const SEV_STYLES = {
  critical: { badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300', dot: 'bg-red-500', row: 'border-l-red-500' },
  warning:  { badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300', dot: 'bg-amber-500', row: 'border-l-amber-500' },
  info:     { badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300', dot: 'bg-blue-400', row: 'border-l-blue-400' },
}
const STATUS_STYLES = {
  new:          'bg-red-50 text-red-600 dark:bg-red-900/20',
  acknowledged: 'bg-amber-50 text-amber-600 dark:bg-amber-900/20',
  resolved:     'bg-green-50 text-green-600 dark:bg-green-900/20',
}

function StatBadge({ label, value, color }) {
  return (
    <div className={clsx('card p-4 text-center', color)}>
      <p className="text-3xl font-bold">{value}</p>
      <p className="text-sm font-medium mt-1 opacity-80">{label}</p>
    </div>
  )
}

export default function Alerts() {
  const [alerts, setAlerts] = useState([])
  const [summary, setSummary] = useState({ last_24h: 0, critical_24h: 0, unacknowledged: 0 })
  const [filter, setFilter] = useState({ status: '', severity: '', hours: 72 })
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const [aRes, sRes] = await Promise.all([
        alertsApi.list({ ...filter, limit: 200 }),
        alertsApi.summary(),
      ])
      setAlerts(aRes.data)
      setSummary(sRes.data)
    } catch { toast.error('Could not load alerts') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [filter.status, filter.severity, filter.hours])

  const acknowledge = async (id) => {
    try {
      await alertsApi.acknowledge(id, { acknowledged_by: 'admin' })
      setAlerts(a => a.map(x => x.id === id ? { ...x, status: 'acknowledged', acknowledged_at: new Date().toISOString() } : x))
      toast.success('Alert acknowledged')
    } catch { toast.error('Failed') }
  }

  const resolve = async (id) => {
    try {
      await alertsApi.resolve(id)
      setAlerts(a => a.map(x => x.id === id ? { ...x, status: 'resolved', resolved_at: new Date().toISOString() } : x))
      toast.success('Alert resolved')
    } catch { toast.error('Failed') }
  }

  const ackAll = async () => {
    const newAlerts = alerts.filter(a => a.status === 'new')
    await Promise.all(newAlerts.map(a => alertsApi.acknowledge(a.id, { acknowledged_by: 'admin' })))
    load()
    toast.success(`Acknowledged ${newAlerts.length} alerts`)
  }

  const setF = (k, v) => setFilter(f => ({ ...f, [k]: v }))

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Alerts</h1>
          <p className="text-gray-500 text-sm mt-1">All threshold breaches and trap-generated alerts</p>
        </div>
        {summary.unacknowledged > 0 && (
          <button onClick={ackAll} className="btn-secondary flex items-center gap-2 text-sm">
            <CheckCircle size={14} /> Acknowledge all ({summary.unacknowledged})
          </button>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <StatBadge label="Last 24h" value={summary.last_24h} color="text-gray-700 dark:text-gray-300" />
        <StatBadge label="Critical 24h" value={summary.critical_24h} color="text-red-600" />
        <StatBadge label="Unacknowledged" value={summary.unacknowledged} color="text-amber-600" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <Filter size={15} className="text-gray-400" />
        <select className="input w-40" value={filter.status} onChange={e => setF('status', e.target.value)}>
          <option value="">All statuses</option>
          <option value="new">New</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
        <select className="input w-40" value={filter.severity} onChange={e => setF('severity', e.target.value)}>
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <select className="input w-40" value={filter.hours} onChange={e => setF('hours', +e.target.value)}>
          <option value={24}>Last 24h</option>
          <option value={72}>Last 3 days</option>
          <option value={168}>Last 7 days</option>
          <option value={720}>Last 30 days</option>
        </select>
        <span className="text-sm text-gray-400">{alerts.length} alerts</span>
      </div>

      {/* Alert list */}
      <div className="space-y-2">
        {loading ? (
          <div className="card p-12 text-center">
            <div className="w-8 h-8 border-4 border-teal-500 border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        ) : alerts.length === 0 ? (
          <div className="card p-16 text-center text-gray-400">
            <CheckCircle size={40} className="mx-auto mb-3 text-green-400" />
            <p className="font-medium">No alerts matching current filters</p>
            <p className="text-sm mt-1">Everything looks clean!</p>
          </div>
        ) : alerts.map(a => {
          const sev = SEV_STYLES[a.severity] || SEV_STYLES.info
          return (
            <div key={a.id} className={clsx('card border-l-4 p-4', sev.row)}>
              <div className="flex items-start gap-3">
                <span className={clsx('w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0', sev.dot)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-gray-900 dark:text-gray-100">{a.title}</p>
                    <span className={clsx('badge text-xs', sev.badge)}>{a.severity}</span>
                    <span className={clsx('badge text-xs', STATUS_STYLES[a.status] || '')}>{a.status}</span>
                    <span className="text-xs text-gray-400">{a.source}</span>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{a.message}</p>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
                    <span className="flex items-center gap-1">
                      <Clock size={11} /> {new Date(a.timestamp).toLocaleString()}
                    </span>
                    {a.metric_name && <span>{a.metric_name}: {a.metric_value}</span>}
                    {a.acknowledged_by && <span>Acked by {a.acknowledged_by}</span>}
                  </div>
                </div>
                <div className="flex gap-1.5 flex-shrink-0">
                  {a.status === 'new' && (
                    <button onClick={() => acknowledge(a.id)}
                      className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-300 transition-colors">
                      <Clock size={12} /> Ack
                    </button>
                  )}
                  {a.status !== 'resolved' && (
                    <button onClick={() => resolve(a.id)}
                      className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-300 transition-colors">
                      <CheckCircle size={12} /> Resolve
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
