import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { devicesApi } from '../utils/api'
import { useStore } from '../store'
import { formatTs, chartLabel } from '../utils/timezone'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine
} from 'recharts'
import { ArrowLeft, Radio, Trash2, Wifi, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const STATUS_COLOR = {
  online: 'bg-green-500', offline: 'bg-red-500',
  warning: 'bg-amber-500', unknown: 'bg-gray-400',
}
const STATUS_BADGE = {
  online: 'badge-online', offline: 'badge-critical',
  warning: 'badge-warning', unknown: 'bg-gray-100 text-gray-600',
}

// ─── Metric chart ─────────────────────────────────────────────────────────────

function MetricChart({ title, data, dataKeys, colors, unit = '', height = 120, hours = 24 }) {
  const { theme, timezone } = useStore()

  const hasData = data.some(d => dataKeys.some(k => d[k] != null))
  if (!hasData) return (
    <div className="card p-4">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">{title}</p>
      <p className="text-xs text-gray-400 italic h-8 flex items-center">No data yet — waiting for next poll</p>
    </div>
  )

  // Read dark mode from the DOM class — always accurate regardless of store timing.
  // Recharts renders tooltip AFTER hover so it must use the live DOM state,
  // not a potentially-stale Zustand value.
  const isDark = document.documentElement.classList.contains('dark')
  const tickColor     = isDark ? '#9ca3af' : '#6b7280'
  const gridColor     = isDark ? '#374151' : '#e5e7eb'
  const tooltipBg     = isDark ? '#1e293b' : '#ffffff'
  const tooltipBorder = isDark ? '#334155' : '#e5e7eb'
  const tooltipLabel  = isDark ? '#f1f5f9' : '#111827'   // always high-contrast on tooltip bg

  // ── Numeric time domain (the correct Recharts approach for time axes)
  // Explicit ms domain guarantees the axis ALWAYS spans now−Xh → now,
  // even when data only covers part of that window.
  const nowMs         = Date.now()
  const windowStartMs = nowMs - hours * 3_600_000
  const domain        = [windowStartMs, nowMs]

  // 7 evenly-spaced tick marks spanning the full window (always includes start + end)
  const TICK_COUNT = 7
  const tickStep   = (nowMs - windowStartMs) / (TICK_COUNT - 1)
  const ticks      = Array.from({ length: TICK_COUNT }, (_, i) =>
    Math.round(windowStartMs + i * tickStep)
  )

  // X-axis formatter: HH:MM for ≤6h, "3 Jun 14:30" for longer (clear + compact)
  const fmtTick = (ms) => {
    if (!ms) return ''
    const d    = new Date(ms)
    const opts = { timeZone: timezone, hour12: false }
    return hours <= 6
      ? new Intl.DateTimeFormat('en-GB', { ...opts, hour: '2-digit', minute: '2-digit' }).format(d)
      : new Intl.DateTimeFormat('en-GB', { ...opts, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d)
  }

  // Tooltip timestamp — full readable datetime in user's timezone
  const fmtTooltipLabel = (ms) => {
    if (!ms) return ''
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour12: false,
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit'
    }).format(new Date(ms))
  }

  return (
    <div className="card p-4">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-3">{title}</p>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 10, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} strokeOpacity={0.6} />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={domain}
            ticks={ticks}
            tickFormatter={fmtTick}
            tick={{ fontSize: 9, fill: tickColor }}
            tickLine={{ stroke: tickColor }}
            axisLine={{ stroke: gridColor }}
            padding={{ left: 8, right: 8 }}
          />
          <YAxis
            tick={{ fontSize: 10, fill: tickColor }}
            tickLine={{ stroke: tickColor }}
            axisLine={{ stroke: gridColor }}
            width={42}
            tickFormatter={v => v != null ? `${v}${unit}` : ''}
            domain={[0, 'auto']}
            allowDataOverflow={false}
          />
          <Tooltip
            cursor={{ stroke: tickColor, strokeWidth: 1, strokeDasharray: '4 2' }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const dk     = document.documentElement.classList.contains('dark')
              const bg     = dk ? '#1e293b' : '#ffffff'
              const border = dk ? '#334155' : '#e2e8f0'
              const lc     = dk ? '#f1f5f9' : '#0f172a'
              return (
                <div style={{
                  background: bg, border: `1px solid ${border}`,
                  borderRadius: 7, padding: '7px 11px',
                  boxShadow: dk ? '0 4px 14px rgba(0,0,0,0.5)' : '0 4px 14px rgba(0,0,0,0.1)',
                  fontSize: 11, minWidth: 140,
                }}>
                  <p style={{ color: lc, fontWeight: 700, marginBottom: 4 }}>
                    {fmtTooltipLabel(label)}
                  </p>
                  {payload.map((entry, i) => (
                    <p key={i} style={{ color: entry.color, margin: '2px 0' }}>
                      {entry.name}: {entry.value != null ? `${entry.value}${unit}` : 'N/A'}
                    </p>
                  ))}
                </div>
              )
            }}
          />
          {dataKeys.length > 1 && (
            <Legend iconSize={8} wrapperStyle={{ fontSize: 10, paddingTop: 4, color: tickColor }} />
          )}
          {dataKeys.map((k, i) => (
            <Line
              key={k} type="monotone" dataKey={k}
              stroke={colors[i] || '#14b8a6'} strokeWidth={1.8}
              dot={false} name={k} connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Interface management ─────────────────────────────────────────────────────

function InterfacePanel({ device }) {
  const [open, setOpen] = useState(false)
  const [interfaces, setInterfaces] = useState([])
  const [monitored, setMonitored] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await devicesApi.getInterfaces(device.id)
      setInterfaces(res.data.interfaces || [])
      setMonitored(res.data.monitored || [])
    } catch {
      toast.error('Could not fetch interfaces — check SNMP connectivity')
    } finally { setLoading(false) }
  }, [device.id])

  const toggle = (idx) =>
    setMonitored(prev => prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx])

  const save = async () => {
    setSaving(true)
    try {
      await devicesApi.saveInterfaces(device.id, monitored)
      toast.success('Monitored interfaces saved')
    } catch { toast.error('Save failed') }
    finally { setSaving(false) }
  }

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => { setOpen(o => !o); if (!open && interfaces.length === 0) load() }}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Wifi size={15} className="text-teal-500" />
          <span className="font-medium text-gray-800 dark:text-gray-200 text-sm">
            Interface Monitoring
          </span>
          {monitored.length > 0 && (
            <span className="text-xs bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300 px-2 py-0.5 rounded-full">
              {monitored.length} tracked
            </span>
          )}
        </div>
        {open ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
      </button>

      {open && (
        <div className="border-t border-gray-100 dark:border-gray-700 p-4">
          {loading ? (
            <div className="flex justify-center py-6">
              <div className="w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : interfaces.length === 0 ? (
            <div className="text-center py-4 space-y-2">
              <p className="text-sm text-gray-500">No interfaces found</p>
              <button onClick={load} className="text-xs text-teal-600 underline">Retry</button>
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-3">
                Tick interfaces to track their bandwidth (Mbps) historically.
                Bandwidth delta is computed between polls.
              </p>
              <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                {interfaces.map(iface => (
                  <label key={iface.index}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-colors">
                    <input
                      type="checkbox"
                      checked={monitored.includes(iface.index)}
                      onChange={() => toggle(iface.index)}
                      className="w-3.5 h-3.5 rounded text-teal-600"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">{iface.name}</p>
                      <p className="text-xs text-gray-400">
                        {iface.speed_mbps > 0 ? `${iface.speed_mbps} Mbps  ·  ` : ''}
                        <span className={iface.status === 'up' ? 'text-green-500' : 'text-gray-400'}>
                          {iface.status}
                        </span>
                      </p>
                    </div>
                    <span className={clsx('w-2 h-2 rounded-full flex-shrink-0',
                      iface.status === 'up' ? 'bg-green-400' : 'bg-gray-300')} />
                  </label>
                ))}
              </div>
              <div className="flex gap-2 mt-4">
                <button onClick={save} disabled={saving} className="btn-primary text-sm py-2 px-4">
                  {saving ? 'Saving…' : 'Save selection'}
                </button>
                <button onClick={load} className="btn-secondary text-sm py-2 px-4 flex items-center gap-1.5">
                  <RefreshCw size={12} /> Refresh list
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Device Detail Page ───────────────────────────────────────────────────────

export default function DeviceDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { timezone } = useStore()

  const [device, setDevice] = useState(null)
  const [metrics, setMetrics] = useState([])
  const [loading, setLoading] = useState(true)
  const [hours, setHours] = useState(3)   // default 3h — smallest useful window, fastest load

  const loadDevice = useCallback(async () => {
    try {
      const res = await devicesApi.get(id)
      setDevice(res.data)
    } catch {
      toast.error('Device not found')
      navigate('/devices')
    }
  }, [id, navigate])

  const loadMetrics = useCallback(async (h = hours) => {
    try {
      const res = await devicesApi.metrics(id, h)
      // ts = numeric ms timestamp — used by XAxis type="number" scale="time"
      // This lets Recharts set an exact domain and place ticks anywhere in the window
      const toMs = (iso) => {
        const utc = iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z'
        return new Date(utc).getTime()
      }

      const rows = res.data.map(m => ({
        ...m,
        ts:    toMs(m.timestamp),
        label: chartLabel(m.timestamp, timezone),
      }))

      // Sentinel points anchor the X-axis to the full selected window (now−h → now).
      // Without them, if the device was offline for hours, the axis only spans
      // the actual data range (e.g., "12:35–20:56 yesterday") instead of the
      // expected "12:08 yesterday – 12:08 today".
      const nowMs2       = Date.now()
      const startMs2     = nowMs2 - h * 3_600_000
      const sentinel = (ms) => ({ ts: ms, timestamp: new Date(ms).toISOString() })

      setMetrics([sentinel(startMs2), ...rows, sentinel(nowMs2)])
    } catch { setMetrics([]) }
  }, [id, hours, timezone])

  useEffect(() => {
    Promise.all([loadDevice(), loadMetrics()]).finally(() => setLoading(false))
  }, [id])

  // Re-label when timezone changes (label is display-only, ts/domain stay numeric)
  useEffect(() => {
    setMetrics(prev => prev.map(m => ({
      ...m,
      label: m.timestamp ? chartLabel(m.timestamp, timezone) : m.label,
    })))
  }, [timezone])

  // Re-run loadMetrics when hours selector changes (re-anchors the window too)
  const handleHoursChange = (h) => {
    setHours(h)
    loadMetrics(h)
  }

  const pollNow = async () => {
    await devicesApi.poll(id)
    toast.success('Poll triggered — refreshing in 10s…')
    setTimeout(() => { loadDevice(); loadMetrics() }, 10000)
  }

  const removeDevice = async () => {
    if (!confirm(`Remove "${device?.name}" from monitoring?`)) return
    await devicesApi.delete(id)
    toast.success('Device removed')
    navigate('/devices')
  }

  // Collect interface indexes to chart:
  // • If user has selected monitored interfaces → show only those
  // • Otherwise → show all that appear in stored metrics
  const ifaceIndexes = useCallback(() => {
    const monitored = device?.tags?.monitored_interfaces || []
    if (monitored.length > 0) return monitored.slice().sort((a, b) => a - b)
    const seen = new Set()
    metrics.forEach(m => Object.keys(m.interfaces || {}).forEach(i => seen.add(Number(i))))
    return [...seen].sort((a, b) => a - b)
  }, [metrics, device])

  const ifaceData = useCallback((idx) =>
    metrics
      .filter(m => m.interfaces?.[idx] != null)
      .map(m => ({
        ts:         m.ts,
        timestamp:  m.timestamp,
        label:      m.label,
        'In Mbps':  m.interfaces[idx]?.in_mbps  ?? null,
        'Out Mbps': m.interfaces[idx]?.out_mbps ?? null,
      }))
  , [metrics])

  if (loading) return (
    <div className="flex justify-center items-center h-64">
      <div className="w-8 h-8 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!device) return null

  // Remote = device owned by a desktop agent. The server must NOT poll it or
  // run live SNMP queries (interface monitoring) — those would conflict with
  // the agent's data and can't reach the remote LAN anyway.
  const isRemote = device.source === 'desktop_sync'

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ── Header ── */}
      <div className="flex items-start justify-between">
        <div>
          <button
            onClick={() => navigate('/devices')}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-teal-600 mb-2 transition-colors"
          >
            <ArrowLeft size={14} /> Back to Devices
          </button>
          <div className="flex items-center gap-3">
            <span className={clsx('w-3 h-3 rounded-full', STATUS_COLOR[device.status] || 'bg-gray-400')} />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{device.name}</h1>
            <span className={clsx('badge text-sm', STATUS_BADGE[device.status] || 'bg-gray-100 text-gray-600')}>
              {device.status}
            </span>
            <span className="text-sm text-gray-400">{device.device_type}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 ml-6">
            <span className="font-mono text-sm text-gray-500">{device.ip_address}</span>
            {device.sys_location && <span className="text-sm text-gray-400">· {device.sys_location}</span>}
            {/* Origin badge */}
            {device.source === 'desktop_sync' && device.site_name ? (
              <span className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 px-2.5 py-0.5 rounded-full font-medium">
                🔄 Synced from {device.site_name}
                {device.synced_at && (
                  <span className="font-normal ml-1 opacity-70">
                    · {formatTs(device.synced_at, timezone, 'short')}
                  </span>
                )}
              </span>
            ) : device.source === 'discovery' ? (
              <span className="text-xs bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300 px-2.5 py-0.5 rounded-full">🔍 Auto-discovered</span>
            ) : (
              <span className="text-xs bg-gray-100 text-gray-500 px-2.5 py-0.5 rounded-full">💻 Local</span>
            )}
          </div>
        </div>

        <div className="flex gap-2 flex-shrink-0">
          <select
            value={hours}
            onChange={e => handleHoursChange(+e.target.value)}
            className="input text-sm py-1.5 w-32"
          >
            <option value={3}>Last 3h</option>
            <option value={6}>Last 6h</option>
            <option value={24}>Last 24h</option>
            <option value={72}>Last 3 days</option>
            <option value={168}>Last 7 days</option>
          </select>
          {/* Poll Now only for locally-owned devices — remote agents own their own polling */}
          {!isRemote && (
            <button onClick={pollNow} className="btn-secondary flex items-center gap-1.5 text-sm">
              <Radio size={14} /> Poll now
            </button>
          )}
          <button onClick={removeDevice} className="btn-danger flex items-center gap-1.5 text-sm">
            <Trash2 size={14} /> Remove
          </button>
        </div>
      </div>

      {/* Remote-managed banner */}
      {isRemote && (
        <div className="card p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 flex items-center gap-2">
          <span className="text-base">🔄</span>
          <p className="text-sm text-blue-700 dark:text-blue-300">
            This device is monitored by the <strong>{device.site_name}</strong> agent.
            Polling, interface selection, and SNMP queries are managed there — this is a read-only view of synced data.
          </p>
        </div>
      )}

      {/* ── Device info + stats ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Last seen',  value: formatTs(device.last_seen, timezone) },
          { label: 'Uptime',     value: device.uptime_seconds
              ? `${Math.floor(device.uptime_seconds/3600)}h ${Math.floor((device.uptime_seconds%3600)/60)}m`
              : '—' },
          { label: 'SNMP',       value: `${device.snmp_version} / ${device.snmp_community}` },
          { label: 'Poll every', value: `${device.poll_interval}s` },
        ].map(({ label, value }) => (
          <div key={label} className="card p-4">
            <p className="text-xs text-gray-400 mb-1">{label}</p>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">{value}</p>
          </div>
        ))}
      </div>

      {/* ── Charts grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        <MetricChart
          title="CPU %"
          data={metrics}
          dataKeys={['cpu_percent']}
          colors={['#14b8a6']}
          unit="%" hours={hours}
        />

        <MetricChart
          title="Memory & Disk %"
          data={metrics}
          dataKeys={['memory_percent', 'disk_percent']}
          colors={['#6366f1', '#f59e0b']}
          unit="%" hours={hours}
        />

        <MetricChart
          title="Ping Latency (ms)"
          data={metrics}
          dataKeys={['ping_ms']}
          colors={['#ec4899']}
          unit=" ms" hours={hours}
        />

        {/* Bandwidth charts — one per monitored (or stored) interface */}
        {ifaceIndexes().length === 0 ? (
          <div className="card p-4 flex flex-col justify-center items-center text-center h-40">
            <Wifi size={24} className="text-gray-300 mb-2" />
            <p className="text-sm text-gray-400">No interface data yet</p>
            <p className="text-xs text-gray-400 mt-1">
              {isRemote
                ? `Interface selection is managed by the ${device.site_name} agent`
                : 'Open "Interface Monitoring" below and select interfaces to track'}
            </p>
          </div>
        ) : (
          ifaceIndexes().map(idx => {
            const data = ifaceData(idx)
            const name = [...metrics].reverse().find(m => m.interfaces?.[idx])?.interfaces?.[idx]?.name || `Interface ${idx}`
            const hasData = data.some(d => d['In Mbps'] != null || d['Out Mbps'] != null)
            return (
              <div key={idx}>
                {hasData ? (
                  <MetricChart
                    title={`Bandwidth — ${name}`}
                    data={data}
                    dataKeys={['In Mbps', 'Out Mbps']}
                    colors={['#3b82f6', '#10b981']}
                    unit=" Mbps" hours={hours}
                  />
                ) : (
                  <div className="card p-4">
                    <p className="text-xs font-semibold text-gray-500 mb-2">Bandwidth — {name}</p>
                    <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded p-2">
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                      Waiting for first poll cycle — data will appear shortly
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}

        {/* RF signal if present */}
        {metrics.some(m => m.signal_dbm != null) && (
          <MetricChart
            title="RF Signal (dBm)"
            data={metrics}
            dataKeys={['signal_dbm', 'noise_dbm']}
            colors={['#8b5cf6', '#6b7280']}
            unit=" dBm" hours={hours}
          />
        )}
      </div>

      {/* ── Interface management — local devices only ── */}
      {/* Remote devices: interface selection runs live SNMP from the owning
          agent, not the server. Showing it here would query an unreachable LAN. */}
      {!isRemote && <InterfacePanel device={device} />}

      {/* ── Notes ── */}
      {device.notes && (
        <div className="card p-4">
          <p className="text-xs font-semibold text-gray-400 mb-1">Notes</p>
          <p className="text-sm text-gray-700 dark:text-gray-300">{device.notes}</p>
        </div>
      )}

    </div>
  )
}
