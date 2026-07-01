import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { devicesApi, mibsApi } from '../utils/api'
import api from '../utils/api'
import { Monitor, RefreshCw, Plus, Trash2, Radio, X, ChevronDown, ChevronUp, Info, Pencil, RotateCcw, Cloud, ShieldAlert } from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const STATUS_BADGE = {
  online: 'badge-online', offline: 'badge-critical',
  warning: 'badge-warning', unknown: 'bg-gray-100 text-gray-600'
}

const DEVICE_TYPES = [
  { value: 'unknown',       label: 'Unknown' },
  { value: 'pc',            label: 'PC / Workstation' },
  { value: 'laptop',        label: 'Laptop' },
  { value: 'server',        label: 'Server' },
  { value: 'router',        label: 'Router / Switch' },
  { value: 'printer',       label: 'Printer' },
  { value: 'rf_link',       label: 'RF Link (Ubiquiti / Cambium)' },
  { value: 'access_point',  label: 'Access Point' },
  { value: 'indoor_unit_fso', label: 'Indoor Unit FSO' },
]

const SNMP_SETUP = {
  pc:              { title: 'Windows PC/Server', steps: ['Open Services (Win+R → services.msc)', 'Find "SNMP Service" → Properties → Security tab', 'Add community string "public" with READ access', 'Accept SNMP packets from: add this NMS server\'s IP', 'Start service, set Startup Type: Automatic'] },
  laptop:          { title: 'Windows Laptop',    steps: ['Same as PC: enable SNMP Service via Services', 'Or via optional features: Settings → Apps → Optional Features → SNMP'] },
  server:          { title: 'Linux/Windows Server', steps: ['Linux: sudo apt install snmpd', 'Edit /etc/snmp/snmpd.conf → add: rocommunity public default', 'sudo systemctl restart snmpd && sudo ufw allow 161/udp', 'Windows: enable SNMP Service via Services'] },
  router:          { title: 'Router / Switch',   steps: ['MikroTik: Winbox → IP → SNMP → Enable, set community', 'Cisco: conf t → snmp-server community public RO → write memory', 'TP-Link/Netgear: Web UI → Management → SNMP → Enable'] },
  printer:         { title: 'Network Printer',   steps: ['Open printer web UI at http://<printer-ip>', 'Go to Networking or Settings → SNMP', 'Enable SNMPv1/v2c → set Read community to "public"', 'Save and reboot if required'] },
  rf_link:         { title: 'RF Link (Ubiquiti / Cambium)', steps: ['Ubiquiti AirMax: System → SNMP → Enable, set community', 'AirFiber: Settings → Services → SNMP', 'Cambium ePMP: Configuration → System → SNMP'] },
  access_point:    { title: 'Access Point',      steps: ['Open AP web interface', 'Navigate to Management or Services → SNMP', 'Enable SNMPv2c, set community string', 'Allow SNMP from NMS IP if IP filter available'] },
  indoor_unit_fso: { title: 'Indoor Unit FSO',   steps: ['Open FSO web management UI', 'Go to SNMP settings page', 'Enable SNMP agent / service', 'Set Read-Only community name (e.g. "public")', 'Save configuration and reboot if needed'] },
  unknown:         { title: 'Generic Device',    steps: ['Consult device documentation for SNMP settings', 'Look for: Management → SNMP → Enable', 'Set community string (e.g. "public")', 'Ensure UDP port 161 is open on the device firewall'] },
}

const EMPTY_FORM = {
  ip_address: '', name: '', device_type: 'unknown',
  snmp_version: 'v2c', snmp_community: 'public',
  snmp_port: 161, poll_interval: 300, notes: '', mib_id: '',
  latitude: '', longitude: '', associated_device_id: '',
}

// ─── Add / Edit Device Modal ──────────────────────────────────────────────────

function deviceToForm(device) {
  return {
    ip_address: device.ip_address || '',
    name: device.name || '',
    device_type: device.device_type || 'unknown',
    snmp_version: device.snmp_version || 'v2c',
    snmp_community: device.snmp_community || 'public',
    snmp_port: device.snmp_port || 161,
    poll_interval: device.poll_interval || 300,
    notes: device.notes || '',
    mib_id: device.mib_id != null ? String(device.mib_id) : '',
    latitude: device.latitude != null ? String(device.latitude) : '',
    longitude: device.longitude != null ? String(device.longitude) : '',
    associated_device_id: device.associated_device_id != null ? String(device.associated_device_id) : '',
  }
}

export function DeviceModal({ device, onClose, onSaved }) {
  const { appMode } = useStore()
  const isEdit = !!device
  const [form, setForm] = useState(() => isEdit ? deviceToForm(device) : EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [mibs, setMibs] = useState([])
  const [allDevices, setAllDevices] = useState([])
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const guide = SNMP_SETUP[form.device_type] || SNMP_SETUP.unknown

  useEffect(() => { mibsApi.list().then(r => setMibs(r.data)).catch(() => {}) }, [])
  useEffect(() => { devicesApi.list({ limit: 200 }).then(r => setAllDevices(r.data)).catch(() => {}) }, [])

  const submit = async (e) => {
    e.preventDefault()
    if (!form.ip_address.trim()) return toast.error('IP address is required')
    if (!form.name.trim()) return toast.error('Device name is required')
    setSaving(true)
    try {
      const payload = {
        ...form,
        snmp_port: Number(form.snmp_port),
        poll_interval: Number(form.poll_interval),
        mib_id: form.mib_id ? Number(form.mib_id) : null,
        latitude: form.latitude !== '' ? Number(form.latitude) : null,
        longitude: form.longitude !== '' ? Number(form.longitude) : null,
        associated_device_id: form.associated_device_id ? Number(form.associated_device_id) : null,
      }
      const res = isEdit
        ? await devicesApi.update(device.id, payload)
        : await devicesApi.create(payload)
      toast.success(isEdit ? `Device "${res.data.name}" updated!` : `Device "${res.data.name}" added!`)
      onSaved(res.data)
      onClose()
    } catch (e) {
      toast.error(e.response?.data?.detail || (isEdit ? 'Could not update device' : 'Could not add device'))
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{isEdit ? 'Edit Device' : 'Add Device Manually'}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{isEdit ? `Update connection settings for ${device.name}` : 'Enter the device IP and SNMP credentials'}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
            <X size={18} className="text-gray-500" />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">IP Address <span className="text-red-400">*</span></label>
              <input className="input font-mono" placeholder="192.168.1.100"
                value={form.ip_address} onChange={e => set('ip_address', e.target.value)} />
            </div>
            <div>
              <label className="label">Device Name <span className="text-red-400">*</span></label>
              <input className="input" placeholder="e.g. Office-Printer-1"
                value={form.name} onChange={e => set('name', e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Device Type</label>
            <select className="input" value={form.device_type} onChange={e => set('device_type', e.target.value)}>
              {DEVICE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="bg-gray-50 dark:bg-gray-800 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">SNMP Settings</div>
            <div className="p-4 grid grid-cols-2 gap-3">
              <div>
                <label className="label">SNMP Version</label>
                <select className="input" value={form.snmp_version} onChange={e => set('snmp_version', e.target.value)}>
                  <option value="v1">SNMPv1</option>
                  <option value="v2c">SNMPv2c (recommended)</option>
                  <option value="v3">SNMPv3</option>
                </select>
              </div>
              <div>
                <label className="label">Community String</label>
                <input className="input font-mono" placeholder="public"
                  value={form.snmp_community} onChange={e => set('snmp_community', e.target.value)} />
              </div>
              <div>
                <label className="label">SNMP Port <span className="text-xs text-gray-400 font-normal">(default: 161)</span></label>
                <input type="number" className="input font-mono" value={form.snmp_port}
                  onChange={e => set('snmp_port', e.target.value)} min={1} max={65535} />
              </div>
              {appMode !== 'desktop' && (
                <div>
                  <label className="label">Poll Interval</label>
                  <select className="input" value={form.poll_interval} onChange={e => set('poll_interval', Number(e.target.value))}>
                    <option value={60}>60s — every minute</option>
                    <option value={120}>120s — every 2 min</option>
                    <option value={300}>300s — every 5 min</option>
                    <option value={600}>600s — every 10 min</option>
                    <option value={1800}>1800s — every 30 min</option>
                  </select>
                </div>
              )}
            </div>
          </div>
          <div>
            <label className="label">Vendor MIB <span className="text-xs text-gray-400 font-normal">(optional — enables auto port/interface discovery)</span></label>
            <select className="input" value={form.mib_id} onChange={e => set('mib_id', e.target.value)}>
              <option value="">No MIB — standard discovery only</option>
              {mibs.map(m => (
                <option key={m.id} value={m.id}>{m.name}{m.vendor ? ` — ${m.vendor}` : ''} ({m.oid_count} OIDs)</option>
              ))}
            </select>
          </div>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="bg-gray-50 dark:bg-gray-800 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Map Placement (optional)</div>
            <div className="p-4 space-y-3">
              <p className="text-xs text-gray-500">
                Place this device on the Dashboard network map and optionally pair it with an associated
                device — a colored line is drawn between paired devices that both have coordinates.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Latitude</label>
                  <input type="number" step="any" className="input font-mono" placeholder="19.0760"
                    value={form.latitude} onChange={e => set('latitude', e.target.value)} />
                </div>
                <div>
                  <label className="label">Longitude</label>
                  <input type="number" step="any" className="input font-mono" placeholder="72.8777"
                    value={form.longitude} onChange={e => set('longitude', e.target.value)} />
                </div>
              </div>
              <div>
                <label className="label">Associated Device <span className="text-xs text-gray-400 font-normal">(for drawing a link line)</span></label>
                <select className="input" value={form.associated_device_id} onChange={e => set('associated_device_id', e.target.value)}>
                  <option value="">None</option>
                  {allDevices.filter(d => !device || d.id !== device.id).map(d => (
                    <option key={d.id} value={d.id}>{d.name} ({d.ip_address})</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-teal-200 dark:border-teal-800 overflow-hidden">
            <button type="button" onClick={() => setGuideOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 bg-teal-50 dark:bg-teal-900/20 hover:bg-teal-100 dark:hover:bg-teal-900/30 transition-colors text-left">
              <div className="flex items-center gap-2">
                <Info size={14} className="text-teal-600" />
                <span className="text-sm font-medium text-teal-800 dark:text-teal-300">How to enable SNMP on: {guide.title}</span>
              </div>
              {guideOpen ? <ChevronUp size={14} className="text-teal-600" /> : <ChevronDown size={14} className="text-teal-600" />}
            </button>
            {guideOpen && (
              <div className="p-4 bg-white dark:bg-gray-900 border-t border-teal-100 dark:border-teal-800">
                <ol className="space-y-2">
                  {guide.steps.map((step, i) => (
                    <li key={i} className="flex gap-2.5 text-xs text-gray-700 dark:text-gray-300">
                      <span className="w-5 h-5 rounded-full bg-teal-100 dark:bg-teal-900 text-teal-700 dark:text-teal-300 flex items-center justify-center flex-shrink-0 font-bold text-xs mt-0.5">{i + 1}</span>
                      <span className="font-mono leading-relaxed">{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
          <div>
            <label className="label">Notes <span className="text-xs text-gray-400 font-normal">(optional)</span></label>
            <textarea className="input resize-none" rows={2} placeholder="Location, owner, etc."
              value={form.notes} onChange={e => set('notes', e.target.value)} />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
              {isEdit ? <Pencil size={15} /> : <Plus size={15} />}
              {isEdit ? (saving ? 'Saving...' : 'Save Changes') : (saving ? 'Adding...' : 'Add Device')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Devices list page ────────────────────────────────────────────────────────

export default function Devices() {
  const navigate = useNavigate()
  const { user, appMode, advanceFeaturesEnabled, setAdvanceFeaturesEnabled } = useStore()
  const [devices, setDevices] = useState([])
  const [deleted, setDeleted] = useState([])
  const [showDeleted, setShowDeleted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editingDevice, setEditingDevice] = useState(null)

  const [showUnlockPrompt, setShowUnlockPrompt] = useState(false)
  const [promptPassword, setPromptPassword] = useState('')
  const [promptError, setPromptError] = useState('')
  const [promptLoading, setPromptLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)

  const runWithLockCheck = (action, callback) => {
    if (appMode === 'desktop' && !advanceFeaturesEnabled) {
      setPendingAction({ name: action, run: callback })
      setShowUnlockPrompt(true)
    } else {
      callback()
    }
  }

  const handlePromptSubmit = async (e) => {
    e.preventDefault()
    if (!promptPassword) {
      setPromptError('Password is required')
      return
    }
    setPromptLoading(true)
    try {
      await api.post('/auth/verify-admin-password', { password: promptPassword })
      setAdvanceFeaturesEnabled(true)
      setShowUnlockPrompt(false)
      setPromptPassword('')
      toast.success('Admin features unlocked!')
      if (pendingAction && pendingAction.run) {
        pendingAction.run()
      }
    } catch (err) {
      setPromptError(err.response?.data?.detail || 'Incorrect password')
    } finally {
      setPromptLoading(false)
      setPendingAction(null)
    }
  }

  const getVisibleIp = (ip) => {
    if (appMode === 'desktop') {
      return advanceFeaturesEnabled ? ip : '*.*.*.*'
    }
    return user?.role === 'admin' ? ip : '*.*.*.*'
  }

  const load = async () => {
    try {
      const res = await devicesApi.list({ limit: 200 })
      setDevices(res.data)
      const del = await devicesApi.listDeleted()
      setDeleted(del.data)
    } catch { toast.error('Could not load devices') }
    finally { setLoading(false) }
  }

  const pollNow = async (e, id) => {
    e.stopPropagation()
    await devicesApi.poll(id)
    toast.success('Poll triggered')
  }

  const removeDevice = async (e, id) => {
    e.stopPropagation()
    const target = devices.find(x => x.id === id)
    const msg = target?.source === 'desktop_sync'
      ? `Remove this synced device? It stays hidden here even while the "${target.site_name}" agent keeps syncing — restore it from "Removed devices" to bring it back.`
      : 'Remove this device from monitoring? You can restore it later from "Removed devices".'
    if (!confirm(msg)) return
    await devicesApi.delete(id)
    const removed = devices.find(x => x.id === id)
    setDevices(d => d.filter(x => x.id !== id))
    if (removed) setDeleted(prev => [...prev, removed])
    toast.success('Device removed — restore it anytime from "Removed devices"')
  }

  const restoreDevice = async (id) => {
    try {
      const res = await devicesApi.restore(id)
      setDeleted(prev => prev.filter(x => x.id !== id))
      setDevices(prev => [...prev, res.data])
      toast.success(`"${res.data.name}" restored`)
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not restore device')
    }
  }

  // ── Cloud backup fallback — recover devices lost locally ──────────────────
  const [showCloud, setShowCloud] = useState(false)
  const [cloud, setCloud] = useState(null)          // null = not loaded yet
  const [cloudLoading, setCloudLoading] = useState(false)
  const [cloudError, setCloudError] = useState(null)
  const [recoveringIp, setRecoveringIp] = useState(null)

  const loadCloud = async () => {
    setCloudLoading(true); setCloudError(null)
    try {
      const res = await devicesApi.cloudDevices()
      setCloud(res.data)
    } catch (e) {
      setCloud(null)
      setCloudError(e.response?.data?.detail || 'Could not reach the cloud server')
    } finally { setCloudLoading(false) }
  }

  const toggleCloud = () => {
    const opening = !showCloud
    setShowCloud(opening)
    if (opening && cloud === null) loadCloud()
  }

  const recoverFromCloud = async (ip) => {
    setRecoveringIp(ip)
    try {
      const res = await devicesApi.recoverFromCloud(ip)
      toast.success(`"${res.data.name}" recovered from cloud backup`)
      await load()
      await loadCloud()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Recovery failed')
    } finally { setRecoveringIp(null) }
  }

  const onDeviceSaved = (device) => {
    setDevices(prev => [...prev, device])
    navigate(`/devices/${device.id}`)
  }

  const onDeviceUpdated = (device) => {
    setDevices(prev => prev.map(d => d.id === device.id ? device : d))
  }

  useEffect(() => { load() }, [])

  const filtered = devices.filter(d =>
    !filter ||
    d.name.toLowerCase().includes(filter.toLowerCase()) ||
    d.ip_address.includes(filter) ||
    d.device_type.includes(filter.toLowerCase())
  )

  return (
    <div className="space-y-4 animate-fade-in">
      {showAdd && <DeviceModal onClose={() => setShowAdd(false)} onSaved={onDeviceSaved} />}
      {editingDevice && (
        <DeviceModal device={editingDevice} onClose={() => setEditingDevice(null)} onSaved={onDeviceUpdated} />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Devices</h1>
        <div className="flex gap-2">
          <input type="text" className="input w-48" placeholder="Search devices..."
            value={filter} onChange={e => setFilter(e.target.value)} />
          <button onClick={load} className="btn-secondary flex items-center gap-2">
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => runWithLockCheck('add', () => setShowAdd(true))} className="btn-primary flex items-center gap-2">
            <Plus size={14} /> Add Device
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card p-12 text-center">
          <div className="w-8 h-8 border-4 border-teal-500 border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      ) : (
        <div className="card divide-y divide-gray-100 dark:divide-gray-700">
          {filtered.map(d => (
            <div key={d.id}
              onClick={() => navigate(`/devices/${d.id}`)}
              className="flex items-center gap-4 p-4 cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 group">
              <span className={clsx('w-3 h-3 rounded-full flex-shrink-0',
                d.status === 'online'  ? 'bg-green-500' :
                d.status === 'offline' ? 'bg-red-500' :
                d.status === 'warning' ? 'bg-amber-500' : 'bg-gray-400'
              )} />
              <Monitor size={18} className="text-gray-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 dark:text-gray-100 truncate group-hover:text-teal-600 transition-colors">
                  {d.name}
                </p>
                <p className="text-xs text-gray-500 font-mono">{getVisibleIp(d.ip_address)}</p>
              </div>
              <span className={clsx('badge text-xs', STATUS_BADGE[d.status] || 'bg-gray-100 text-gray-600')}>
                {d.status}
              </span>
              <span className="text-xs text-gray-400 hidden md:block w-24 truncate">{d.device_type}</span>
              {/* Source badge */}
              {d.source === 'desktop_sync' && d.site_name ? (
                <span className="text-xs bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 px-2 py-0.5 rounded-full hidden lg:block truncate max-w-[120px]" title={`Synced from ${d.site_name}`}>
                  🔄 {d.site_name}
                </span>
              ) : d.source === 'discovery' ? (
                <span className="text-xs bg-teal-50 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400 px-2 py-0.5 rounded-full hidden lg:block">
                  🔍 Discovered
                </span>
              ) : (
                <span className="text-xs bg-gray-50 text-gray-400 px-2 py-0.5 rounded-full hidden lg:block">
                  Local
                </span>
              )}
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {/* Poll Now / Edit only for locally-owned devices — remote agents own their own config */}
                {d.source !== 'desktop_sync' && (
                  <>
                    <button onClick={e => pollNow(e, d.id)}
                      className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700" title="Poll now">
                      <Radio size={14} className="text-teal-600" />
                    </button>
                    <button onClick={e => { e.stopPropagation(); runWithLockCheck('edit', () => setEditingDevice(d)) }}
                      className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700" title="Edit device">
                      <Pencil size={14} className="text-gray-500" />
                    </button>
                  </>
                )}
                <button onClick={e => { e.stopPropagation(); runWithLockCheck('remove', () => removeDevice(e, d.id)) }}
                  className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30" title="Remove">
                  <Trash2 size={14} className="text-red-400" />
                </button>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="p-12 text-center text-gray-400">
              <Monitor size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">No devices yet.</p>
              <p className="text-sm mt-1">
                <button onClick={() => runWithLockCheck('add', () => setShowAdd(true))} className="text-teal-600 underline">Add a device</button>
                {' '}manually or use{' '}
                <button onClick={() => navigate('/discovery')} className="text-teal-600 underline">Auto-Discover</button>.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Removed (soft-deleted) devices — recoverable */}
      {!loading && deleted.length > 0 && (
        <div className="card overflow-hidden">
          <button onClick={() => setShowDeleted(o => !o)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left">
            <div className="flex items-center gap-2">
              <Trash2 size={14} className="text-gray-400" />
              <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                Removed devices ({deleted.length})
              </span>
              <span className="text-xs text-gray-400 hidden sm:block">— hidden from monitoring, can be restored</span>
            </div>
            {showDeleted ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
          </button>
          {showDeleted && (
            <div className="divide-y divide-gray-100 dark:divide-gray-700 border-t border-gray-100 dark:border-gray-700">
              {deleted.map(d => (
                <div key={d.id} className="flex items-center gap-4 p-4 opacity-70">
                  <Monitor size={18} className="text-gray-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-700 dark:text-gray-300 truncate">{d.name}</p>
                    <p className="text-xs text-gray-500 font-mono">{getVisibleIp(d.ip_address)}</p>
                  </div>
                  <span className="text-xs text-gray-400 hidden md:block w-24 truncate">{d.device_type}</span>
                  <button onClick={() => runWithLockCheck('restore', () => restoreDevice(d.id))}
                    className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5">
                    <RotateCcw size={12} /> Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Cloud backup — recover devices that no longer exist locally */}
      {!loading && (
        <div className="card overflow-hidden">
          <button onClick={toggleCloud}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left">
            <div className="flex items-center gap-2">
              <Cloud size={14} className="text-gray-400" />
              <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                Cloud backup
              </span>
              <span className="text-xs text-gray-400 hidden sm:block">— recover devices lost from this computer using their cloud copy</span>
            </div>
            {showCloud ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
          </button>
          {showCloud && (
            <div className="border-t border-gray-100 dark:border-gray-700">
              {cloudLoading ? (
                <div className="p-6 text-center">
                  <div className="w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full animate-spin mx-auto" />
                </div>
              ) : cloudError ? (
                <div className="p-6 text-center text-sm text-gray-400">
                  {cloudError}
                </div>
              ) : (() => {
                const recoverable = (cloud?.devices || []).filter(c => c.local_state === 'missing')
                if (recoverable.length === 0) return (
                  <div className="p-6 text-center text-sm text-gray-400">
                    Every cloud device for "{cloud?.site_name}" already exists on this computer.
                  </div>
                )
                return (
                  <div className="divide-y divide-gray-100 dark:divide-gray-700">
                    {recoverable.map(c => (
                      <div key={c.ip_address} className="flex items-center gap-4 p-4">
                        <Cloud size={18} className="text-blue-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-gray-700 dark:text-gray-300 truncate">{c.name}</p>
                          <p className="text-xs text-gray-500 font-mono">{getVisibleIp(c.ip_address)}</p>
                        </div>
                        <span className="text-xs text-gray-400 hidden md:block w-24 truncate">{c.device_type}</span>
                        {!c.active_on_server && (
                          <span className="text-xs text-amber-500 hidden sm:block" title="This copy was also removed on the server — recovering revives it there too">
                            removed on server
                          </span>
                        )}
                        <button onClick={() => runWithLockCheck('recover', () => recoverFromCloud(c.ip_address))}
                          disabled={recoveringIp === c.ip_address}
                          className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
                          <RotateCcw size={12} className={recoveringIp === c.ip_address ? 'animate-spin' : ''} />
                          {recoveringIp === c.ip_address ? 'Recovering…' : 'Recover'}
                        </button>
                      </div>
                    ))}
                  </div>
                )
              })()}
              <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-700 flex justify-end">
                <button onClick={loadCloud} className="text-xs text-gray-400 hover:text-teal-600 flex items-center gap-1">
                  <RefreshCw size={11} /> Refresh from cloud
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {showUnlockPrompt && createPortal(
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100000]" style={{ transform: 'translate3d(0,0,0)', backfaceVisibility: 'hidden' }}>
          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl max-w-sm w-full border border-gray-200 dark:border-gray-700 shadow-xl space-y-4 text-left">
            <div>
              <h3 className="text-lg font-bold text-gray-950 dark:text-white flex items-center gap-2">
                <ShieldAlert className="text-amber-500" size={20} />
                Confirm Admin Action
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                This operation requires administrator privileges. Please enter the admin password to continue.
              </p>
            </div>
            
            <form onSubmit={handlePromptSubmit} className="space-y-4">
              <div>
                <label className="label">Admin Password</label>
                <input
                  type="password"
                  className="input w-full"
                  placeholder="Enter password..."
                  value={promptPassword}
                  onChange={e => {
                    setPromptPassword(e.target.value)
                    setPromptError('')
                  }}
                  autoFocus
                />
                {promptError && <p className="text-xs text-red-500 mt-1">{promptError}</p>}
              </div>

              <div className="flex justify-end gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => {
                    setShowUnlockPrompt(false)
                    setPromptPassword('')
                    setPromptError('')
                    setPendingAction(null)
                  }}
                  className="btn-secondary py-1.5 px-3"
                  disabled={promptLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary py-1.5 px-3 flex items-center gap-2"
                  disabled={promptLoading}
                >
                  {promptLoading ? 'Verifying...' : 'Unlock & Run'}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
