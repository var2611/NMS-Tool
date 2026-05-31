import { useEffect, useState } from 'react'
import { trapsApi } from '../utils/api'
import { useStore } from '../store'
import { Zap, Plus, Trash2, ToggleLeft, ToggleRight, Send, ChevronDown, ChevronRight, Settings } from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const SEV_BADGE = { critical: 'badge-critical', warning: 'badge-warning', info: 'badge-info' }
const SEV_DOT   = { critical: 'bg-red-500', warning: 'bg-amber-500', info: 'bg-blue-400' }

// ─── Trap Event Row ───────────────────────────────────────────────────────────
function TrapRow({ trap }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-gray-100 dark:border-gray-700 last:border-0">
      <div
        className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className={clsx('w-2 h-2 rounded-full flex-shrink-0', SEV_DOT[trap.severity] || 'bg-gray-400')} />
        <span className="text-xs font-mono text-gray-400 w-32 flex-shrink-0 hidden md:block">
          {new Date(trap.timestamp).toLocaleTimeString()}
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
        <div className="px-5 pb-4 bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-600 dark:text-gray-400 space-y-1">
          <div><strong>OID:</strong> <span className="font-mono">{trap.trap_oid}</span></div>
          <div><strong>Name:</strong> {trap.trap_name}</div>
          <div><strong>Source:</strong> {trap.source_ip}</div>
          {trap.rule_matched && <div><strong>Rule matched:</strong> {trap.rule_matched}</div>}
          <div><strong>Time:</strong> {new Date(trap.timestamp).toLocaleString()}</div>
        </div>
      )}
    </div>
  )
}

// ─── Rule Card ────────────────────────────────────────────────────────────────
function RuleCard({ rule, onToggle, onDelete }) {
  return (
    <div className={clsx('card p-4 border-l-4 transition-all',
      rule.is_enabled ? 'border-l-teal-500' : 'border-l-gray-300')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-800 dark:text-gray-200 truncate">{rule.name}</p>
          <p className="text-xs font-mono text-gray-400 truncate mt-0.5">{rule.trap_oid_pattern}</p>
          {rule.plain_english_template && (
            <p className="text-xs text-gray-500 mt-1 truncate italic">"{rule.plain_english_template}"</p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <span className={clsx('badge text-xs', SEV_BADGE[rule.severity] || 'bg-gray-100 text-gray-600')}>
            {rule.severity}
          </span>
          <button onClick={() => onToggle(rule.id)} title="Enable/Disable"
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
            {rule.is_enabled
              ? <ToggleRight size={18} className="text-teal-600" />
              : <ToggleLeft size={18} className="text-gray-400" />}
          </button>
          <button onClick={() => onDelete(rule.id)}
            className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30">
            <Trash2 size={14} className="text-red-400" />
          </button>
        </div>
      </div>
      <div className="flex gap-2 mt-2 text-xs text-gray-400">
        {rule.create_alert && <span className="bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">Creates alert</span>}
        {rule.send_email  && <span className="bg-blue-50 text-blue-600 px-2 py-0.5 rounded">Email</span>}
        {rule.send_webhook&& <span className="bg-purple-50 text-purple-600 px-2 py-0.5 rounded">Webhook</span>}
      </div>
    </div>
  )
}

// ─── New Rule Form ────────────────────────────────────────────────────────────
function NewRuleModal({ onClose, onSave, standardTypes }) {
  const [form, setForm] = useState({
    name: '', trap_oid_pattern: '', severity: 'warning',
    plain_english_template: '', create_alert: true,
    send_email: false, send_webhook: false,
  })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.name || !form.trap_oid_pattern) return toast.error('Name and OID pattern required')
    try {
      await trapsApi.createRule(form)
      toast.success('Rule created')
      onSave()
    } catch { toast.error('Could not save rule') }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-lg p-6">
        <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">New Trap Rule</h3>
        <div className="space-y-3">
          <div><label className="label">Rule name</label>
            <input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Link Down Alert" /></div>
          <div>
            <label className="label">
              Trap OID pattern
              <span className="text-xs text-gray-400 font-normal ml-2">— quick pick:</span>
            </label>
            <div className="flex gap-2 mb-1 flex-wrap">
              {standardTypes.slice(0, 4).map(t => (
                <button key={t.oid} onClick={() => { set('trap_oid_pattern', t.oid); set('name', t.name) }}
                  className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded hover:bg-teal-50 dark:hover:bg-teal-900/30 text-gray-600 dark:text-gray-300">
                  {t.name}
                </button>
              ))}
            </div>
            <input className="input font-mono text-xs" value={form.trap_oid_pattern}
              onChange={e => set('trap_oid_pattern', e.target.value)}
              placeholder="1.3.6.1.6.3.1.1.5.3" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Severity</label>
              <select className="input" value={form.severity} onChange={e => set('severity', e.target.value)}>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select></div>
            <div></div>
          </div>
          <div><label className="label">Plain English message template</label>
            <input className="input" value={form.plain_english_template}
              onChange={e => set('plain_english_template', e.target.value)}
              placeholder="{device} interface went down" /></div>
          <div className="flex gap-4 text-sm">
            {[['create_alert','Create alert'],['send_email','Send email'],['send_webhook','Webhook']].map(([k,lbl]) => (
              <label key={k} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form[k]} onChange={e => set(k, e.target.checked)}
                  className="rounded text-teal-600" />
                {lbl}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={submit} className="btn-primary">Save Rule</button>
        </div>
      </div>
    </div>
  )
}

// ─── Test Trap Panel ──────────────────────────────────────────────────────────
function TestTrapPanel({ standardTypes }) {
  const [form, setForm] = useState({ target_ip: '127.0.0.1', port: 162, community: 'public', trap_oid: '1.3.6.1.6.3.1.1.5.1', version: 'v2c' })
  const [result, setResult] = useState(null)
  const [sending, setSending] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const send = async () => {
    setSending(true); setResult(null)
    try {
      const res = await trapsApi.sendTest(form)
      setResult(res.data)
      if (res.data.success) toast.success(`Test trap sent in ${res.data.elapsed_ms}ms`)
      else toast.error(`Failed: ${res.data.error}`)
    } catch { toast.error('Could not send trap') }
    finally { setSending(false) }
  }

  return (
    <div className="card p-5">
      <h3 className="font-semibold text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
        <Send size={16} className="text-teal-600" /> Send Test Trap
      </h3>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div><label className="label">Target IP</label>
          <input className="input" value={form.target_ip} onChange={e => set('target_ip', e.target.value)} /></div>
        <div><label className="label">Port</label>
          <input className="input" type="number" value={form.port} onChange={e => set('port', +e.target.value)} /></div>
        <div><label className="label">Community</label>
          <input className="input" value={form.community} onChange={e => set('community', e.target.value)} /></div>
        <div><label className="label">SNMP Version</label>
          <select className="input" value={form.version} onChange={e => set('version', e.target.value)}>
            <option value="v1">v1</option><option value="v2c">v2c</option>
          </select></div>
      </div>
      <div className="mb-3"><label className="label">Trap type</label>
        <select className="input" value={form.trap_oid} onChange={e => set('trap_oid', e.target.value)}>
          {standardTypes.map(t => <option key={t.oid} value={t.oid}>{t.name} — {t.description}</option>)}
        </select></div>
      <button onClick={send} disabled={sending} className="btn-primary flex items-center gap-2">
        {sending ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Send size={14} />}
        {sending ? 'Sending...' : 'Send Trap'}
      </button>
      {result && (
        <div className={clsx('mt-3 p-3 rounded-lg text-sm', result.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700')}>
          {result.success ? `✅ Sent successfully in ${result.elapsed_ms}ms` : `❌ ${result.error}`}
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Traps() {
  const [tab, setTab] = useState('events') // events | rules | test
  const [events, setEvents] = useState([])
  const [rules, setRules] = useState([])
  const [standardTypes, setStandardTypes] = useState([])
  const [showNewRule, setShowNewRule] = useState(false)
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

  // Merge live WS traps with API events
  const allEvents = [...recentTraps.filter(t => !events.find(e => e.timestamp === t.timestamp)), ...events]

  const toggleRule = async (id) => {
    await trapsApi.toggleRule(id); loadRules()
  }
  const deleteRule = async (id) => {
    if (!confirm('Delete this rule?')) return
    await trapsApi.deleteRule(id); loadRules(); toast.success('Rule deleted')
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">SNMP Traps</h1>
          <p className="text-gray-500 text-sm mt-1">Real-time trap receiver · rule engine · test sender</p>
        </div>
        {tab === 'rules' && (
          <button onClick={() => setShowNewRule(true)} className="btn-primary flex items-center gap-2">
            <Plus size={15} /> New Rule
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {[['events','Trap Events'],['rules','Trap Rules'],['test','Test Trap']].map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            className={clsx('px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
              tab === k ? 'border-teal-600 text-teal-600' : 'border-transparent text-gray-500 hover:text-gray-700')}>
            {lbl}
            {k === 'events' && allEvents.length > 0 && (
              <span className="ml-2 bg-gray-200 dark:bg-gray-700 text-xs px-1.5 py-0.5 rounded-full">{allEvents.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Events Tab */}
      {tab === 'events' && (
        <div className="space-y-3">
          <div className="flex gap-3">
            <select className="input w-40" value={hours} onChange={e => setHours(+e.target.value)}>
              <option value={1}>Last 1 hour</option>
              <option value={6}>Last 6 hours</option>
              <option value={24}>Last 24 hours</option>
              <option value={72}>Last 3 days</option>
            </select>
            <button onClick={loadEvents} className="btn-secondary text-sm">Refresh</button>
          </div>
          <div className="card">
            <div className="grid grid-cols-[8px_128px_128px_1fr_80px_16px] gap-3 px-5 py-2 text-xs font-medium text-gray-400 border-b border-gray-100 dark:border-gray-700 hidden md:grid">
              <span/><span>Time</span><span>Source IP</span><span>Description</span><span>Severity</span><span/>
            </div>
            {allEvents.length === 0 ? (
              <div className="py-16 text-center text-gray-400">
                <Zap size={36} className="mx-auto mb-3 opacity-30" />
                <p>No trap events in the last {hours} hour{hours !== 1 ? 's' : ''}</p>
                <p className="text-xs mt-1">Traps appear here immediately when received</p>
              </div>
            ) : allEvents.map((t, i) => <TrapRow key={t.id || i} trap={t} />)}
          </div>
        </div>
      )}

      {/* Rules Tab */}
      {tab === 'rules' && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rules.map(r => <RuleCard key={r.id} rule={r} onToggle={toggleRule} onDelete={deleteRule} />)}
          {rules.length === 0 && (
            <div className="col-span-3 card py-16 text-center text-gray-400">
              <Settings size={36} className="mx-auto mb-3 opacity-30" />
              <p>No trap rules yet</p>
              <p className="text-xs mt-1">Rules determine what happens when a trap is received</p>
            </div>
          )}
        </div>
      )}

      {/* Test Tab */}
      {tab === 'test' && (
        <div className="max-w-lg">
          <TestTrapPanel standardTypes={standardTypes} />
          <div className="mt-4 card p-4 text-sm text-gray-500 dark:text-gray-400">
            <p className="font-medium text-gray-700 dark:text-gray-300 mb-2">💡 How to use</p>
            <ul className="space-y-1 text-xs list-disc list-inside">
              <li>Set Target IP to <strong>127.0.0.1</strong> to test your own NMS-Tool trap receiver</li>
              <li>Or enter another device's IP to test that device receives traps</li>
              <li>The trap will appear in the Events tab immediately if sent to this machine</li>
              <li>Default trap port is 162 (needs root) or 1162 (no root needed)</li>
            </ul>
          </div>
        </div>
      )}

      {showNewRule && (
        <NewRuleModal
          standardTypes={standardTypes}
          onClose={() => setShowNewRule(false)}
          onSave={() => { setShowNewRule(false); loadRules() }}
        />
      )}
    </div>
  )
}
