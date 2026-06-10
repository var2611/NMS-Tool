import { useEffect, useState } from 'react'
import { devicesApi, alertsApi, trapsApi, reportsApi } from '../utils/api'
import { useStore } from '../store'
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell
} from 'recharts'
import { Monitor, Printer, Wifi, AlertTriangle, Activity, CheckCircle, XCircle } from 'lucide-react'
import clsx from 'clsx'
import NetworkMap from '../components/NetworkMap'

const STATUS_COLORS = {
  online: '#22c55e', offline: '#ef4444', warning: '#f59e0b', unknown: '#9ca3af'
}

const DEVICE_ICONS = {
  pc: Monitor, laptop: Monitor, printer: Printer, rf_link: Wifi,
  router: Activity, switch: Activity, server: Activity, unknown: Monitor
}

function StatCard({ label, value, icon: Icon, color, sub }) {
  return (
    <div className="card p-5 flex items-start gap-4">
      <div className={`p-3 rounded-xl ${color}`}>
        <Icon size={22} className="text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
        <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{label}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

function HealthRing({ score }) {
  const circumference = 2 * Math.PI * 36
  const offset = circumference - (score / 100) * circumference
  const color = score >= 80 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444'

  return (
    <div className="card p-5 flex items-center gap-6">
      <div className="relative w-24 h-24 flex-shrink-0">
        <svg className="-rotate-90 w-24 h-24">
          <circle cx="48" cy="48" r="36" fill="none" stroke="#e5e7eb" strokeWidth="8" />
          <circle cx="48" cy="48" r="36" fill="none" stroke={color} strokeWidth="8"
            strokeDasharray={circumference} strokeDashoffset={offset}
            strokeLinecap="round" style={{ transition: 'stroke-dashoffset 1s ease' }} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-2xl font-bold" style={{ color }}>{score}%</span>
        </div>
      </div>
      <div>
        <p className="font-semibold text-gray-900 dark:text-white">Network Health</p>
        <p className="text-sm text-gray-500 mt-1">
          {score >= 80 ? '✅ All systems running well' :
           score >= 50 ? '⚠️ Some devices need attention' :
           '🚨 Critical issues detected'}
        </p>
      </div>
    </div>
  )
}

function DeviceGrid({ devices }) {
  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">Live Device Status</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 max-h-64 overflow-y-auto pr-1">
        {devices.map(d => {
          const Icon = DEVICE_ICONS[d.device_type] || Monitor
          return (
            <div key={d.id} className={clsx(
              'flex items-center gap-2 p-2.5 rounded-lg border text-xs transition-all',
              d.status === 'online' ? 'border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800' :
              d.status === 'offline' ? 'border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800' :
              d.status === 'warning' ? 'border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800' :
              'border-gray-200 bg-gray-50 dark:bg-gray-800/40 dark:border-gray-700'
            )}>
              <span className={clsx('w-2 h-2 rounded-full flex-shrink-0',
                d.status === 'online' ? 'bg-green-500' :
                d.status === 'offline' ? 'bg-red-500' :
                d.status === 'warning' ? 'bg-amber-500' : 'bg-gray-400'
              )} />
              <Icon size={12} className="text-gray-500 flex-shrink-0" />
              <span className="truncate font-medium text-gray-700 dark:text-gray-300">{d.name}</span>
            </div>
          )
        })}
        {devices.length === 0 && (
          <div className="col-span-4 text-center py-8 text-gray-400">
            <Monitor size={32} className="mx-auto mb-2 opacity-40" />
            <p>No devices yet — go to Auto-Discover to find devices</p>
          </div>
        )}
      </div>
    </div>
  )
}

function AlertFeed({ alerts }) {
  const SEVERITY_STYLES = {
    critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  }

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">Recent Alerts</h3>
      <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
        {alerts.slice(0, 10).map((a, i) => (
          <div key={a.id || i} className="flex items-start gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800">
            <span className={clsx('badge text-xs flex-shrink-0 mt-0.5', SEVERITY_STYLES[a.severity] || SEVERITY_STYLES.info)}>
              {a.severity}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{a.title}</p>
              <p className="text-xs text-gray-500 truncate">{a.message}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                {new Date(a.timestamp).toLocaleTimeString()}
              </p>
            </div>
          </div>
        ))}
        {alerts.length === 0 && (
          <div className="text-center py-8 text-gray-400">
            <CheckCircle size={28} className="mx-auto mb-2 text-green-400" />
            <p className="text-sm">No alerts — everything looks good!</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { devices, deviceSummary, alerts, setDevices, setDeviceSummary, setAlerts, setAlertSummary } = useStore()
  const [reportData, setReportData] = useState(null)
  const [trapStats, setTrapStats] = useState({ last_24h_total: 0, last_24h_critical: 0 })
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const [devRes, summaryRes, alertRes, alertSumRes, trapRes, reportRes] = await Promise.allSettled([
        devicesApi.list({ limit: 200 }),
        devicesApi.summary(),
        alertsApi.list({ hours: 24, limit: 10 }),
        alertsApi.summary(),
        trapsApi.stats(),
        reportsApi.summary(7),
      ])
      if (devRes.status === 'fulfilled') setDevices(devRes.value.data)
      if (summaryRes.status === 'fulfilled') setDeviceSummary(summaryRes.value.data)
      if (alertRes.status === 'fulfilled') setAlerts(alertRes.value.data)
      if (alertSumRes.status === 'fulfilled') setAlertSummary(alertSumRes.value.data)
      if (trapRes.status === 'fulfilled') setTrapStats(trapRes.value.data)
      if (reportRes.status === 'fulfilled') setReportData(reportRes.value.data)
    } catch (e) { /* errors handled individually */ }
    finally { setLoading(false) }
  }

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [])

  const alertsByDay = reportData?.alerts_by_day?.map(d => ({
    date: d.date.slice(5), count: d.count
  })) || []

  const typePieData = Object.entries(deviceSummary.by_type || {})
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ name: k, value: v }))

  const PIE_COLORS = ['#14b8a6','#3b82f6','#f59e0b','#8b5cf6','#ef4444','#22c55e']

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-teal-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-gray-500">Loading network status...</p>
      </div>
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Page title */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">Overview of your entire network — last updated just now</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Devices" value={deviceSummary.total}
          icon={Monitor} color="bg-teal-600" sub="All monitored" />
        <StatCard label="Online" value={deviceSummary.online}
          icon={CheckCircle} color="bg-green-500" sub="Responding normally" />
        <StatCard label="Offline" value={deviceSummary.offline}
          icon={XCircle} color="bg-red-500" sub="Not responding" />
        <StatCard label="Alerts Today" value={reportData?.total_alerts || 0}
          icon={AlertTriangle} color="bg-amber-500" sub={`${trapStats.last_24h_total} traps received`} />
      </div>

      {/* Health + Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <HealthRing score={deviceSummary.health_score || 0} />

        <div className="card p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
            Alerts this week
          </h3>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={alertsByDay}>
              <defs>
                <linearGradient id="alertGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area type="monotone" dataKey="count" stroke="#f59e0b" fill="url(#alertGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Network map */}
      <NetworkMap devices={devices} />

      {/* Device list + Alert feed + Pie */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <DeviceGrid devices={devices} />
        </div>

        <div className="space-y-4">
          {typePieData.length > 0 && (
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">By Device Type</h3>
              <ResponsiveContainer width="100%" height={140}>
                <PieChart>
                  <Pie data={typePieData} cx="50%" cy="50%" innerRadius={35} outerRadius={60}
                    dataKey="value" paddingAngle={3}>
                    {typePieData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(val, name) => [val, name]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-2 mt-2">
                {typePieData.map((d, i) => (
                  <div key={d.name} className="flex items-center gap-1 text-xs text-gray-600">
                    <span className="w-2 h-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    {d.name} ({d.value})
                  </div>
                ))}
              </div>
            </div>
          )}
          <AlertFeed alerts={alerts} />
        </div>
      </div>
    </div>
  )
}
