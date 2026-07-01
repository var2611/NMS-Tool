import { useEffect, useState, useRef, useCallback } from 'react'
import { trapsApi, devicesApi, mibsApi } from '../utils/api'
import { useStore } from '../store'
import { formatTs } from '../utils/timezone'
import {
  Zap, Plus, Trash2, ToggleLeft, ToggleRight, Send,
  ChevronDown, ChevronRight, Settings, Activity, Edit2,
  Play, Square, RefreshCw, Search, Radio
} from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const SEV_BADGE = { critical: 'badge-critical', warning: 'badge-warning', info: 'badge-info' }
const SEV_DOT   = { critical: 'bg-red-500', warning: 'bg-amber-500', info: 'bg-blue-400' }

// ─── Common OIDs for quick-pick in OID Probe ──────────────────────────────────
const QUICK_OIDS = [
  { label: 'System Description',   oid: '1.3.6.1.2.1.1.1.0',  op: 'get' },
  { label: 'System Name',          oid: '1.3.6.1.2.1.1.5.0',  op: 'get' },
  { label: 'System Uptime',        oid: '1.3.6.1.2.1.1.3.0',  op: 'get' },
  { label: 'System Location',      oid: '1.3.6.1.2.1.1.6.0',  op: 'get' },
  { label: 'CPU Load',             oid: '1.3.6.1.2.1.25.3.3.1.2', op: 'walk' },
  { label: 'Interface List',       oid: '1.3.6.1.2.1.2.2.1.2', op: 'walk' },
  { label: 'Interface Status',     oid: '1.3.6.1.2.1.2.2.1.8', op: 'walk' },
  { label: 'Interface In Octets',  oid: '1.3.6.1.2.1.2.2.1.10', op: 'walk' },
  { label: 'Interface Out Octets', oid: '1.3.6.1.2.1.2.2.1.16', op: 'walk' },
  { label: 'Storage Desc',         oid: '1.3.6.1.2.1.25.2.3.1.3', op: 'walk' },
  { label: 'Storage Used',         oid: '1.3.6.1.2.1.25.2.3.1.6', op: 'walk' },
  { label: 'RF Signal (Ubiquiti)', oid: '1.3.6.1.4.1.41112.1.4.7.1.3', op: 'walk' },
  { label: 'RF CCQ (Ubiquiti)',    oid: '1.3.6.1.4.1.41112.1.4.7.1.13', op: 'walk' },
  { label: 'Toner Level',          oid: '1.3.6.1.2.1.43.11.1.1.9', op: 'walk' },
]

// ─── Trap Event Row ───────────────────────────────────────────────────────────
function TrapRow({ trap }) {
  const { timezone } = useStore()
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-gray-100 dark:border-gray-700 last:border-0">
      <div
        className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className={clsx('w-2 h-2 rounded-full flex-shrink-0', SEV_DOT[trap.severity] || 'bg-gray-400')} />
        <span className="text-xs font-mono text-gray-400 w-36 flex-shrink-0 hidden md:block">
          {formatTs(trap.timestamp, timezone, 'short')}
        </span>
        <span className="font-mono text-xs text-gray-500 w-32 flex-shrink-0 hidden lg:block truncate">{trap.source_ip}</span>
        <span className="flex-1 text-sm text-gray-800 dark:text-gray-200 truncate">
          {trap.plain_english || trap.trap_name || trap.trap_oid}
        </span>
        <span className={clsx('badge text-xs flex-shrink-0', SEV_BADGE[trap.severity] || 'bg-gray-100 text-gray-600')}>
          {trap.severity}
        </span>
        {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
      </div>
      {open && (
        <div className="px-5 pb-4 bg-gray-50 dark:bg-gray-800/50 text-xs space-y-1.5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-600 dark:text-gray-400">
            <div><strong className="text-gray-700 dark:text-gray-300">OID:</strong>
              <span className="font-mono ml-1">{trap.trap_oid}</span></div>
            <div><strong className="text-gray-700 dark:text-gray-300">Name:</strong>
              <span className="ml-1">{trap.trap_name || '—'}</span></div>
            <div><strong className="text-gray-700 dark:text-gray-300">Source:</strong>
              <span className="font-mono ml-1">{trap.source_ip}</span></div>
            <div><strong className="text-gray-700 dark:text-gray-300">Rule:</strong>
              <span className="ml-1">{trap.rule_matched || 'No rule matched'}</span></div>
            <div className="col-span-2"><strong className="text-gray-700 dark:text-gray-300">Time:</strong>
              <span className="ml-1">{formatTs(trap.timestamp, timezone)}</span></div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Rule Card ────────────────────────────────────────────────────────────────
function RuleCard({ rule, onToggle, onDelete, onEdit }) {
  return (
    <div className={clsx('card p-4 border-l-4 transition-all',
      rule.is_enabled ? 'border-l-teal-500' : 'border-l-gray-300 dark:border-l-gray-600')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-800 dark:text-gray-200 truncate">{rule.name}</p>
          <p className="text-xs font-mono text-gray-400 truncate mt-0.5">{rule.trap_oid_pattern}</p>
          {rule.plain_english_template && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 italic truncate">
              "{rule.plain_english_template}"
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <span className={clsx('badge text-xs', SEV_BADGE[rule.severity] || 'bg-gray-100 text-gray-600')}>
            {rule.severity}
          </span>
          <button onClick={() => onEdit(rule)} title="Edit"
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
            <Edit2 size={13} className="text-gray-400" />
          </button>
          <button onClick={() => onToggle(rule.id)} title={rule.is_enabled ? 'Disable' : 'Enable'}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
            {rule.is_enabled
              ? <ToggleRight size={18} className="text-teal-600" />
              : <ToggleLeft  size={18} className="text-gray-400" />}
          </button>
          <button onClick={() => onDelete(rule.id)}
            className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30">
            <Trash2 size={13} className="text-red-400" />
          </button>
        </div>
      </div>
      <div className="flex gap-1.5 mt-2.5 flex-wrap">
        {rule.create_alert && <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded">Creates alert</span>}
        {rule.send_email   && <span className="text-xs bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded">Email</span>}
        {rule.send_webhook && <span className="text-xs bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 px-2 py-0.5 rounded">Webhook</span>}
        {rule.suppress_start_hour != null && (
          <span className="text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded">
            Suppressed {rule.suppress_start_hour}:00–{rule.suppress_end_hour}:00
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Rule Modal (add / edit) ──────────────────────────────────────────────────
function RuleModal({ initial, onClose, onSave, standardTypes }) {
  const isEdit = !!initial?.id
  const [form, setForm] = useState(initial || {
    name: '', trap_oid_pattern: '', severity: 'warning',
    plain_english_template: '', create_alert: true,
    send_email: false, send_webhook: false,
    suppress_start_hour: null, suppress_end_hour: null,
  })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.name || !form.trap_oid_pattern) return toast.error('Name and OID pattern required')
    try {
      isEdit
        ? await trapsApi.updateRule(form.id, form)
        : await trapsApi.createRule(form)
      toast.success(isEdit ? 'Rule updated' : 'Rule created')
      onSave()
    } catch { toast.error('Could not save rule') }
  }

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
        <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
          {isEdit ? 'Edit Rule' : 'New Trap Rule'}
        </h3>
        <div className="space-y-3">
          <div><label className="label">Rule name</label>
            <input className="input" value={form.name} onChange={e => set('name', e.target.value)}
              placeholder="e.g. Link Down Alert" /></div>
          <div>
            <label className="label">Trap OID pattern
              <span className="text-xs text-gray-400 font-normal ml-2">quick pick:</span>
            </label>
            <div className="flex gap-1.5 mb-2 flex-wrap">
              {standardTypes.map(t => (
                <button key={t.oid} onClick={() => { set('trap_oid_pattern', t.oid); if (!form.name) set('name', t.name) }}
                  className={clsx('text-xs px-2 py-1 rounded border transition-colors',
                    form.trap_oid_pattern === t.oid
                      ? 'bg-teal-100 border-teal-400 text-teal-700 dark:bg-teal-900/40 dark:border-teal-600 dark:text-teal-300'
                      : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-teal-300')}>
                  {t.name}
                </button>
              ))}
            </div>
            <input className="input font-mono text-xs" value={form.trap_oid_pattern}
              onChange={e => set('trap_oid_pattern', e.target.value)}
              placeholder="1.3.6.1.6.3.1.1.5.3  or  1.3.6.1.4.1.*" />
            <p className="text-xs text-gray-400 mt-1">Use * as wildcard for enterprise-specific traps</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Severity</label>
              <select className="input" value={form.severity} onChange={e => set('severity', e.target.value)}>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select></div>
          </div>
          <div><label className="label">Human-readable message</label>
            <input className="input" value={form.plain_english_template || ''}
              onChange={e => set('plain_english_template', e.target.value)}
              placeholder="{device} interface went DOWN" /></div>

          {/* Maintenance window suppression */}
          <div>
            <label className="label">Maintenance window (suppress alerts)</label>
            <div className="flex items-center gap-2">
              <input type="number" className="input w-20" min={0} max={23}
                placeholder="From" value={form.suppress_start_hour ?? ''}
                onChange={e => set('suppress_start_hour', e.target.value ? +e.target.value : null)} />
              <span className="text-gray-400 text-sm">:00 to</span>
              <input type="number" className="input w-20" min={0} max={23}
                placeholder="To" value={form.suppress_end_hour ?? ''}
                onChange={e => set('suppress_end_hour', e.target.value ? +e.target.value : null)} />
              <span className="text-gray-400 text-sm">:00 (24h)</span>
            </div>
          </div>

          <div className="flex gap-4 text-sm pt-1">
            {[['create_alert','Create alert'],['send_email','Email'],['send_webhook','Webhook']].map(([k,lbl]) => (
              <label key={k} className="flex items-center gap-2 cursor-pointer text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={!!form[k]} onChange={e => set(k, e.target.checked)}
                  className="rounded text-teal-600" />
                {lbl}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={submit} className="btn-primary">{isEdit ? 'Update Rule' : 'Save Rule'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── Test Trap Panel ──────────────────────────────────────────────────────────
function TestTrapPanel({ standardTypes }) {
  const [form, setForm] = useState({
    target_ip: '127.0.0.1', port: 162, community: 'public',
    trap_oid: '1.3.6.1.6.3.1.1.5.1', version: 'v2c'
  })
  const [result, setResult] = useState(null)
  const [sending, setSending] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const send = async () => {
    setSending(true); setResult(null)
    try {
      const res = await trapsApi.sendTest(form)
      setResult(res.data)
      res.data.success
        ? toast.success(`Trap sent in ${res.data.elapsed_ms}ms`)
        : toast.error(`Failed: ${res.data.error}`)
    } catch { toast.error('Could not send trap') }
    finally { setSending(false) }
  }

  return (
    <div className="max-w-xl space-y-4">
      <div className="card p-5">
        <h3 className="font-semibold text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
          <Send size={16} className="text-teal-600" /> Send Test Trap
        </h3>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div><label className="label">Target IP</label>
            <input className="input font-mono" value={form.target_ip} onChange={e => set('target_ip', e.target.value)}
              placeholder="127.0.0.1 or device IP" /></div>
          <div><label className="label">Port</label>
            <input className="input" type="number" value={form.port} onChange={e => set('port', +e.target.value)} /></div>
          <div><label className="label">Community</label>
            <input className="input" value={form.community} onChange={e => set('community', e.target.value)} /></div>
          <div><label className="label">SNMP Version</label>
            <select className="input" value={form.version} onChange={e => set('version', e.target.value)}>
              <option value="v1">v1</option><option value="v2c">v2c</option>
            </select></div>
        </div>
        <div className="mb-4">
          <label className="label">Trap type</label>
          <select className="input" value={form.trap_oid} onChange={e => set('trap_oid', e.target.value)}>
            {standardTypes.map(t => (
              <option key={t.oid} value={t.oid}>{t.name} — {t.description}</option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1 font-mono">{form.trap_oid}</p>
        </div>
        <button onClick={send} disabled={sending} className="btn-primary flex items-center gap-2">
          {sending ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
          {sending ? 'Sending…' : 'Send Trap'}
        </button>
        {result && (
          <div className={clsx('mt-3 p-3 rounded-lg text-sm font-medium',
            result.success
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
              : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400')}>
            {result.success ? `✓ Sent in ${result.elapsed_ms}ms → target ${result.target}` : `✗ ${result.error}`}
          </div>
        )}
      </div>
      <div className="card p-4 text-sm text-gray-500 dark:text-gray-400">
        <p className="font-medium text-gray-700 dark:text-gray-300 mb-2">How to use</p>
        <ul className="space-y-1 text-xs list-disc list-inside">
          <li>Set Target IP to <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">127.0.0.1</code> to test your own trap receiver — it will appear in the Events tab instantly</li>
          <li>Enter any device IP to send a trap TO that device</li>
          <li>Default port 162 requires admin/root; use 1162 without elevated privileges</li>
        </ul>
      </div>
    </div>
  )
}

// ─── OID Probe Panel ──────────────────────────────────────────────────────────
function OidProbePanel() {
  const [devices, setDevices] = useState([])
  const [deviceId, setDeviceId] = useState('')
  const [customIp, setCustomIp] = useState('')
  const [community, setCommunity] = useState('public')
  const [oid, setOid] = useState('1.3.6.1.2.1.1.1.0')
  const [op, setOp] = useState('get')           // get | walk
  const [results, setResults] = useState([])    // [{ts, oid, name, value}]
  const [running, setRunning] = useState(false)
  const [polling, setPolling] = useState(false)
  const [pollInterval, setPollInterval] = useState(10)  // seconds
  const intervalRef = useRef(null)

  useEffect(() => {
    devicesApi.list({ limit: 200 }).then(r => setDevices(r.data)).catch(() => {})
    return () => clearInterval(intervalRef.current)
  }, [])

  const getTarget = () => {
    if (customIp.trim()) return { ip: customIp.trim(), community }
    const dev = devices.find(d => String(d.id) === deviceId)
    return dev ? { ip: dev.ip_address, community: dev.snmp_community || community } : null
  }

  const probe = useCallback(async () => {
    const target = getTarget()
    if (!target) return toast.error('Select a device or enter a custom IP')
    if (!oid.trim()) return toast.error('Enter an OID')

    setRunning(true)
    const ts = new Date().toISOString()
    try {
      if (op === 'get') {
        const res = await mibsApi.testOid({ ip: target.ip, oid: oid.trim(), community: target.community })
        if (res.data.success) {
          setResults(prev => [{
            ts, oid: res.data.oid, name: res.data.name || oid,
            value: res.data.value, unit: res.data.unit || '', error: null
          }, ...prev].slice(0, 200))
        } else {
          setResults(prev => [{ ts, oid: oid.trim(), name: oid, value: null, error: res.data.error }, ...prev].slice(0, 200))
          toast.error(res.data.error)
        }
      } else {
        // WALK
        const res = await mibsApi.walkOid({ ip: target.ip, oid: oid.trim(), community: target.community, max_rows: 50 })
        if (res.data.success) {
          const walkRows = res.data.results.map(r => ({ ts, oid: r.oid, name: r.name, value: r.value, error: null }))
          setResults(prev => [...walkRows, ...prev].slice(0, 200))
          toast.success(`Walk returned ${res.data.count} OIDs`)
        } else {
          toast.error(res.data.error)
        }
      }
    } catch (e) {
      toast.error('Query failed: ' + (e.message || 'unknown'))
    } finally {
      setRunning(false)
    }
  }, [deviceId, customIp, community, oid, op, devices])

  const startPolling = () => {
    setPolling(true)
    probe()
    intervalRef.current = setInterval(probe, pollInterval * 1000)
  }
  const stopPolling = () => {
    setPolling(false)
    clearInterval(intervalRef.current)
  }

  const selectedDevice = devices.find(d => String(d.id) === deviceId)

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h3 className="font-semibold text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
          <Activity size={16} className="text-teal-600" /> Live OID Probe
          <span className="text-xs text-gray-400 font-normal ml-1">— query any OID on any device in real-time</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          {/* Device selector */}
          <div>
            <label className="label">Device (from monitoring list)</label>
            <select className="input" value={deviceId} onChange={e => { setDeviceId(e.target.value); setCustomIp('') }}>
              <option value="">— select device —</option>
              {devices.map(d => (
                <option key={d.id} value={d.id}>{d.name} ({d.ip_address})</option>
              ))}
            </select>
            {selectedDevice && (
              <p className="text-xs text-gray-400 mt-1 font-mono">
                {selectedDevice.ip_address} · community: {selectedDevice.snmp_community}
              </p>
            )}
          </div>

          {/* Custom IP override */}
          <div>
            <label className="label">Or enter custom IP + community</label>
            <div className="flex gap-2">
              <input className="input font-mono flex-1" value={customIp}
                onChange={e => { setCustomIp(e.target.value); setDeviceId('') }}
                placeholder="172.29.239.1" />
              <input className="input w-24" value={community}
                onChange={e => setCommunity(e.target.value)} placeholder="public" />
            </div>
          </div>
        </div>

        {/* OID + operation */}
        <div className="mb-3">
          <label className="label">OID — quick pick:</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {QUICK_OIDS.map(q => (
              <button key={q.oid} onClick={() => { setOid(q.oid); setOp(q.op) }}
                className={clsx('text-xs px-2 py-1 rounded border transition-colors',
                  oid === q.oid
                    ? 'bg-teal-100 border-teal-400 text-teal-700 dark:bg-teal-900/40 dark:border-teal-600 dark:text-teal-300'
                    : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-teal-300')}>
                {q.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input className="input font-mono flex-1 text-sm" value={oid}
              onChange={e => setOid(e.target.value)} placeholder="1.3.6.1.2.1.1.1.0" />
            <select className="input w-24" value={op} onChange={e => setOp(e.target.value)}>
              <option value="get">GET</option>
              <option value="walk">WALK</option>
            </select>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            GET = single OID value · WALK = entire subtree (up to 50 OIDs)
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={probe} disabled={running || polling}
            className="btn-primary flex items-center gap-2">
            {running ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
            {running ? 'Querying…' : 'Query Once'}
          </button>

          {!polling ? (
            <button onClick={startPolling} disabled={running}
              className="btn-secondary flex items-center gap-2 text-sm">
              <Play size={13} className="text-green-600" />
              Poll every
              <input type="number" min={5} max={300} value={pollInterval}
                onChange={e => setPollInterval(+e.target.value)}
                onClick={e => e.stopPropagation()}
                className="w-14 text-center rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-1 py-0.5 text-xs font-mono"
              />
              s
            </button>
          ) : (
            <button onClick={stopPolling} className="btn-danger flex items-center gap-2 text-sm">
              <Square size={13} /> Stop Polling
              <span className="text-xs opacity-75 font-mono">(every {pollInterval}s)</span>
            </button>
          )}

          {results.length > 0 && (
            <button onClick={() => setResults([])}
              className="text-xs text-gray-400 hover:text-red-500 transition-colors">
              Clear ({results.length})
            </button>
          )}
        </div>
      </div>

      {/* Results table */}
      {results.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-700">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Results {polling && <span className="text-xs text-green-500 animate-pulse ml-2">● live polling</span>}
            </p>
            <span className="text-xs text-gray-400">{results.length} entries</span>
          </div>
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th className="text-left px-4 py-2 text-gray-500 font-medium w-36">Time</th>
                  <th className="text-left px-4 py-2 text-gray-500 font-medium">OID / Name</th>
                  <th className="text-left px-4 py-2 text-gray-500 font-medium w-48">Value</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className={clsx('border-b border-gray-100 dark:border-gray-700 last:border-0',
                    r.error ? 'bg-red-50 dark:bg-red-900/10' : i === 0 && polling ? 'bg-teal-50/50 dark:bg-teal-900/10' : '')}>
                    <td className="px-4 py-2 font-mono text-gray-400 whitespace-nowrap">
                      {new Date(r.ts).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-2">
                      <p className="text-gray-700 dark:text-gray-300 font-medium">{r.name}</p>
                      <p className="text-gray-400 font-mono truncate max-w-xs">{r.oid}</p>
                    </td>
                    <td className="px-4 py-2">
                      {r.error
                        ? <span className="text-red-500">{r.error}</span>
                        : <span className="font-mono text-teal-600 dark:text-teal-400 font-semibold break-all">
                            {r.value ?? 'null'}
                          </span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {results.length === 0 && !running && (
        <div className="card p-8 text-center text-gray-400">
          <Radio size={32} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No results yet</p>
          <p className="text-xs mt-1">Select a device and OID, then click Query Once or start live polling</p>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Traps() {
  const { timezone } = useStore()
  const [tab, setTab] = useState('events')
  const [events, setEvents] = useState([])
  const [rules, setRules] = useState([])
  const [standardTypes, setStandardTypes] = useState([])
  const [showRuleModal, setShowRuleModal] = useState(false)
  const [editRule, setEditRule] = useState(null)
  const [hours, setHours] = useState(24)
  const { recentTraps } = useStore()

  const loadEvents = async () => {
    try { const r = await trapsApi.events({ hours }); setEvents(r.data) } catch {}
  }
  const loadRules = async () => {
    try { const r = await trapsApi.rules(); setRules(r.data) } catch {}
  }
  const loadStandard = async () => {
    try { const r = await trapsApi.standardTypes(); setStandardTypes(r.data) } catch {}
  }

  useEffect(() => { loadEvents(); loadRules(); loadStandard() }, [hours])

  const allEvents = [
    ...recentTraps.filter(t => !events.find(e => e.timestamp === t.timestamp)),
    ...events
  ]

  const toggleRule = async (id) => { await trapsApi.toggleRule(id); loadRules() }
  const deleteRule = async (id) => {
    if (!confirm('Delete this rule?')) return
    await trapsApi.deleteRule(id); loadRules(); toast.success('Rule deleted')
  }

  const TABS = [
    ['events', 'Trap Events',  allEvents.length],
    ['rules',  'Trap Rules',   rules.length],
    ['test',   'Test Trap',    0],
    ['probe',  'OID Probe',    0],
  ]

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">SNMP Traps</h1>
          <p className="text-gray-500 text-sm mt-1">Real-time receiver · rule engine · test sender · OID probe</p>
        </div>
        {tab === 'rules' && (
          <button onClick={() => { setEditRule(null); setShowRuleModal(true) }}
            className="btn-primary flex items-center gap-2">
            <Plus size={15} /> New Rule
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {TABS.map(([k, lbl, count]) => (
          <button key={k} onClick={() => setTab(k)}
            className={clsx('px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
              tab === k
                ? 'border-teal-600 text-teal-600 dark:text-teal-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300')}>
            {lbl}
            {count > 0 && (
              <span className="ml-2 bg-gray-200 dark:bg-gray-700 text-xs px-1.5 py-0.5 rounded-full">{count}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Events ── */}
      {tab === 'events' && (
        <div className="space-y-3">
          <div className="flex gap-3">
            <select className="input w-40" value={hours} onChange={e => setHours(+e.target.value)}>
              <option value={1}>Last 1 hour</option>
              <option value={6}>Last 6 hours</option>
              <option value={24}>Last 24 hours</option>
              <option value={72}>Last 3 days</option>
            </select>
            <button onClick={loadEvents} className="btn-secondary text-sm flex items-center gap-1.5">
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
          <div className="card">
            <div className="grid grid-cols-[8px_144px_128px_1fr_80px_16px] gap-3 px-5 py-2 text-xs font-medium text-gray-400 border-b border-gray-100 dark:border-gray-700 hidden md:grid">
              <span/><span>Time ({timezone})</span><span>Source IP</span><span>Description</span><span>Severity</span><span/>
            </div>
            {allEvents.length === 0 ? (
              <div className="py-16 text-center text-gray-400">
                <Zap size={36} className="mx-auto mb-3 opacity-30" />
                <p>No traps in the last {hours}h</p>
                <p className="text-xs mt-1">Use the OID Probe tab to send a test and verify they arrive here</p>
              </div>
            ) : allEvents.map((t, i) => <TrapRow key={t.id || i} trap={t} />)}
          </div>
        </div>
      )}

      {/* ── Rules ── */}
      {tab === 'rules' && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rules.map(r => (
            <RuleCard key={r.id} rule={r} onToggle={toggleRule} onDelete={deleteRule}
              onEdit={rule => { setEditRule(rule); setShowRuleModal(true) }} />
          ))}
          {rules.length === 0 && (
            <div className="col-span-3 card py-16 text-center text-gray-400">
              <Settings size={36} className="mx-auto mb-3 opacity-30" />
              <p>No trap rules configured</p>
              <p className="text-xs mt-1">Click "+ New Rule" to add one</p>
            </div>
          )}
        </div>
      )}

      {/* ── Test Trap ── */}
      {tab === 'test' && <TestTrapPanel standardTypes={standardTypes} />}

      {/* ── OID Probe ── */}
      {tab === 'probe' && <OidProbePanel />}

      {/* Rule modal */}
      {showRuleModal && (
        <RuleModal
          initial={editRule}
          standardTypes={standardTypes}
          onClose={() => { setShowRuleModal(false); setEditRule(null) }}
          onSave={() => { setShowRuleModal(false); setEditRule(null); loadRules() }}
        />
      )}
    </div>
  )
}
