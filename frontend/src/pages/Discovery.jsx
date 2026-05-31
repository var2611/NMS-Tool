import { useState, useEffect, useRef } from 'react'
import { discoveryApi } from '../utils/api'
import { Radar, Search, Check, Plus, ChevronDown, ChevronUp, Info } from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const DEVICE_ICONS = { pc:'💻', laptop:'💻', printer:'🖨️', rf_link:'📡', router:'🔀', switch:'🔀', unknown:'📟' }
const DEVICE_LABELS = { pc:'PC', laptop:'Laptop', printer:'Printer', rf_link:'RF Link', router:'Router/Switch', unknown:'Unknown' }

const SETUP_GUIDES = [
  {
    label: 'Windows PC/Server',
    icon: '💻',
    steps: [
      'Open "Services" (Win+R → services.msc)',
      'Find "SNMP Service" → right-click → Properties',
      'Security tab → add community string (e.g. "public") with READ access',
      'Accept from: add your NMS server IP (or "Any")',
      'Start the service → set Startup Type: Automatic',
    ],
    note: 'If SNMP Service is missing, add it via: Settings → Optional Features → Add a feature → "Simple Network Management Protocol"',
  },
  {
    label: 'Linux (Net-SNMP)',
    icon: '🐧',
    steps: [
      'Install: sudo apt install snmpd  (or yum install net-snmp)',
      'Edit /etc/snmp/snmpd.conf',
      'Add:  rocommunity public <NMS-IP>',
      'Or for any host:  rocommunity public default',
      'Restart: sudo systemctl restart snmpd',
      'Allow UDP 161 in firewall: ufw allow 161/udp',
    ],
    note: 'Default config in Ubuntu blocks all access — you MUST edit snmpd.conf.',
  },
  {
    label: 'MikroTik Router',
    icon: '🔀',
    steps: [
      'Winbox → IP → SNMP',
      'Check "Enabled"',
      'Set community (default: "public"), set "Trap Version: 2"',
      'Or via terminal:  /snmp set enabled=yes',
      '/snmp community set 0 name=public',
    ],
    note: 'No firewall change needed — MikroTik allows SNMP by default once enabled.',
  },
  {
    label: 'Cisco Router/Switch',
    icon: '🔌',
    steps: [
      'Enter config mode: conf t',
      'snmp-server community public RO',
      'snmp-server location "Server Room"',
      'snmp-server contact admin@company.com',
      'exit → write memory',
    ],
    note: 'Replace "public" with your chosen community string. Use a strong, private string in production.',
  },
  {
    label: 'Ubiquiti / RF Links',
    icon: '📡',
    steps: [
      'Open device web UI → Settings → Services',
      'Enable SNMP → set community string (e.g. "public")',
      'For AirMax: System → SNMP → Enable',
      'No port changes needed — uses default 161',
    ],
    note: 'AirFiber and AirMax devices report signal dBm, noise, and CCQ% via SNMP.',
  },
  {
    label: 'Printers (HP / Xerox / Canon)',
    icon: '🖨️',
    steps: [
      'Open printer web interface (http://<printer-ip>)',
      'Navigate to: Networking → SNMP or Settings → Network → SNMP',
      'Enable SNMPv1/v2c → set Read community (e.g. "public")',
      'Save and apply',
    ],
    note: 'Most modern network printers have SNMP enabled with "public" by default.',
  },
]

function SetupGuide() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState(0)

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Info size={16} className="text-teal-500" />
          <span className="font-medium text-gray-800 dark:text-gray-200 text-sm">
            How to enable SNMP on your devices (required for scan &amp; monitoring)
          </span>
        </div>
        {open ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
      </button>

      {open && (
        <div className="border-t border-gray-100 dark:border-gray-700">
          {/* Port info banner */}
          <div className="bg-teal-50 dark:bg-teal-900/20 px-4 py-3 flex flex-wrap gap-4 text-xs text-teal-800 dark:text-teal-300 border-b border-teal-100 dark:border-teal-800">
            <span><strong>SNMP Port:</strong> UDP 161 (standard, what this tool uses)</span>
            <span><strong>Trap Port:</strong> UDP 162 (for device alerts to NMS)</span>
            <span><strong>Protocol:</strong> SNMPv2c (recommended) or v1/v3</span>
            <span><strong>Community string:</strong> acts as a password — "public" is the default read-only string</span>
          </div>

          {/* Device tabs */}
          <div className="flex gap-1 p-3 flex-wrap border-b border-gray-100 dark:border-gray-700">
            {SETUP_GUIDES.map((g, i) => (
              <button
                key={i}
                onClick={() => setTab(i)}
                className={clsx(
                  'text-xs px-3 py-1.5 rounded-full border transition-colors',
                  tab === i
                    ? 'bg-teal-600 text-white border-teal-600'
                    : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-teal-400'
                )}
              >
                {g.icon} {g.label}
              </button>
            ))}
          </div>

          {/* Steps */}
          <div className="p-4">
            <ol className="space-y-2">
              {SETUP_GUIDES[tab].steps.map((step, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="w-5 h-5 rounded-full bg-teal-100 dark:bg-teal-900 text-teal-700 dark:text-teal-300 text-xs flex items-center justify-center flex-shrink-0 mt-0.5 font-bold">
                    {i + 1}
                  </span>
                  <span className="text-gray-700 dark:text-gray-300 font-mono text-xs leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>
            {SETUP_GUIDES[tab].note && (
              <div className="mt-3 bg-amber-50 dark:bg-amber-900/20 rounded p-3 text-xs text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                <strong>Note:</strong> {SETUP_GUIDES[tab].note}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Discovery() {
  const [subnet, setSubnet] = useState('192.168.1.0/24')
  const [communities, setCommunities] = useState('public,private')
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [saving, setSaving] = useState(false)
  const pollRef = useRef(null)

  const startScan = async () => {
    if (!subnet.trim()) return toast.error('Enter a subnet like 192.168.1.0/24')
    setScanning(true)
    setScan(null)
    setSelected(new Set())
    try {
      const res = await discoveryApi.startScan({
        subnet: subnet.trim(),
        communities: communities.split(',').map(c => c.trim()).filter(Boolean),
        max_concurrent: 30,
      })
      const scanId = res.data.scan_id
      pollRef.current = setInterval(async () => {
        const status = await discoveryApi.getScan(scanId)
        setScan({ ...status.data, scan_id: scanId })
        if (status.data.status === 'completed' || status.data.status === 'error') {
          clearInterval(pollRef.current)
          setScanning(false)
          if (status.data.status === 'completed') {
            toast.success(`Found ${status.data.found?.length || 0} devices!`)
          } else {
            toast.error(`Scan failed: ${status.data.error}`)
          }
        }
      }, 800)
    } catch (e) {
      setScanning(false)
      toast.error(e.response?.data?.detail || 'Scan failed')
    }
  }

  const stopScan = () => {
    clearInterval(pollRef.current)
    setScanning(false)
  }

  const toggleSelect = (ip) => {
    setSelected(prev => {
      const n = new Set(prev)
      n.has(ip) ? n.delete(ip) : n.add(ip)
      return n
    })
  }

  const selectAll = () => setSelected(new Set(scan?.found?.map(d => d.ip_address) || []))
  const deselectAll = () => setSelected(new Set())

  const saveDevices = async () => {
    if (!selected.size || !scan?.scan_id) return
    setSaving(true)
    try {
      const res = await discoveryApi.saveDevices(scan.scan_id, Array.from(selected))
      toast.success(`Saved ${res.data.saved} device(s)! ${res.data.skipped ? `${res.data.skipped} already existed.` : ''}`)
      setSelected(new Set())
    } catch (e) {
      toast.error('Could not save devices')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => () => clearInterval(pollRef.current), [])

  const progress = scan?.total > 0 ? Math.round((scan.progress / scan.total) * 100) : 0

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Auto-Discover Devices</h1>
        <p className="text-gray-500 text-sm mt-1">Scan your network to automatically find all SNMP-enabled devices</p>
      </div>

      {/* Client Setup Guide */}
      <SetupGuide />

      {/* Scan Config */}
      <div className="card p-6">
        <h2 className="font-semibold text-gray-800 dark:text-gray-200 mb-4">Network Scan</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div className="md:col-span-2">
            <label className="label">
              Network range to scan
              <span className="text-xs text-gray-400 font-normal ml-2">e.g. 192.168.1.0/24 scans 254 addresses</span>
            </label>
            <input type="text" className="input" value={subnet}
              onChange={e => setSubnet(e.target.value)}
              placeholder="192.168.1.0/24" />
          </div>
          <div>
            <label className="label">
              Community strings
              <span className="text-xs text-gray-400 font-normal ml-1">(comma separated)</span>
            </label>
            <input type="text" className="input" value={communities}
              onChange={e => setCommunities(e.target.value)}
              placeholder="public,private" />
            <p className="text-xs text-gray-400 mt-1">Tried in order until one responds</p>
          </div>
        </div>

        {/* Quick subnet buttons */}
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="text-xs text-gray-500 mr-1 self-center">Quick select:</span>
          {['192.168.1.0/24','192.168.0.0/24','10.0.0.0/24','172.16.0.0/24'].map(s => (
            <button key={s} onClick={() => setSubnet(s)}
              className={clsx('text-xs px-2 py-1 rounded border transition-colors',
                subnet === s ? 'bg-teal-100 border-teal-400 text-teal-700' : 'border-gray-200 hover:border-teal-300 text-gray-600')}>
              {s}
            </button>
          ))}
        </div>

        <div className="mt-4 flex gap-3">
          {!scanning ? (
            <button onClick={startScan} className="btn-primary flex items-center gap-2">
              <Radar size={16} /> Start Network Scan
            </button>
          ) : (
            <button onClick={stopScan} className="btn-danger flex items-center gap-2">
              Stop Scan
            </button>
          )}
        </div>
      </div>

      {/* Scan Progress */}
      {(scanning || scan) && (
        <div className="card p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              {scanning && <div className="w-4 h-4 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />}
              <span className="font-medium text-gray-800 dark:text-gray-200">
                {scanning ? `Scanning... checking ${scan?.current_ip || '...'}` :
                 scan?.status === 'completed' ? `Scan complete — found ${scan.found?.length || 0} devices` :
                 `Scan ${scan?.status}`}
              </span>
            </div>
            <span className="text-sm text-gray-500">
              {scan?.progress || 0} / {scan?.total || 0} addresses
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2.5">
            <div className="bg-teal-500 h-2.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {/* Results */}
      {scan?.found?.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-700">
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">
                Found {scan.found.length} device{scan.found.length !== 1 ? 's' : ''}
              </h3>
              <p className="text-sm text-gray-500 mt-0.5">Select devices to add to your monitoring list</p>
            </div>
            <div className="flex gap-2 items-center">
              <button onClick={selectAll} className="text-xs text-teal-600 hover:underline">Select all</button>
              <span className="text-gray-300">|</span>
              <button onClick={deselectAll} className="text-xs text-gray-500 hover:underline">Clear</button>
              {selected.size > 0 && (
                <button onClick={saveDevices} disabled={saving}
                  className="btn-primary flex items-center gap-2 text-sm ml-2">
                  <Plus size={14} />
                  {saving ? 'Saving...' : `Add ${selected.size} device${selected.size !== 1 ? 's' : ''}`}
                </button>
              )}
            </div>
          </div>

          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {scan.found.map(d => (
              <label key={d.ip_address}
                className="flex items-center gap-4 p-4 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors">
                <input type="checkbox" checked={selected.has(d.ip_address)}
                  onChange={() => toggleSelect(d.ip_address)}
                  className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500" />
                <span className="text-2xl">{DEVICE_ICONS[d.device_type] || '📟'}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-800 dark:text-gray-200">{d.name || d.ip_address}</p>
                  <p className="text-sm text-gray-500 truncate">{d.sys_descr?.slice(0, 80) || 'No description available'}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="font-mono text-sm text-gray-600 dark:text-gray-400">{d.ip_address}</p>
                  <span className={clsx('badge text-xs mt-1',
                    d.device_type === 'printer' ? 'badge-warning' :
                    d.device_type === 'rf_link' ? 'badge-info' :
                    'bg-gray-100 text-gray-700')}>
                    {DEVICE_LABELS[d.device_type] || d.device_type}
                  </span>
                </div>
                {selected.has(d.ip_address) && (
                  <Check size={18} className="text-teal-600 flex-shrink-0" />
                )}
              </label>
            ))}
          </div>
        </div>
      )}

      {scan?.status === 'completed' && scan.found?.length === 0 && (
        <div className="card p-8">
          <div className="text-center mb-6">
            <Search size={40} className="mx-auto text-gray-300 mb-3" />
            <p className="text-gray-700 dark:text-gray-300 font-semibold">No SNMP devices found in {subnet}</p>
            <p className="text-sm text-gray-400 mt-1 max-w-md mx-auto">
              The scan completed but no devices responded to SNMP. This usually means SNMP is not yet enabled on those devices.
            </p>
          </div>
          <div className="border-t border-gray-100 dark:border-gray-700 pt-5 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <p className="font-medium text-gray-700 dark:text-gray-300 mb-1">1. Enable SNMP</p>
              <p className="text-gray-500 text-xs">Use the "How to enable SNMP" guide above to configure each device.</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <p className="font-medium text-gray-700 dark:text-gray-300 mb-1">2. Check community string</p>
              <p className="text-gray-500 text-xs">Most devices default to "public". Enter the exact string set on the device.</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <p className="font-medium text-gray-700 dark:text-gray-300 mb-1">3. Check firewall/subnet</p>
              <p className="text-gray-500 text-xs">UDP port 161 must be open. Make sure you're scanning the right subnet.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
