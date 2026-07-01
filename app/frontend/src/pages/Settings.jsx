import { useEffect, useState } from 'react'
import { settingsApi } from '../utils/api'
import api from '../utils/api'
import { Settings, Cloud, Mail, Lock, Wifi, CheckCircle, XCircle, RefreshCw, Globe, Monitor, Activity, MapPin } from 'lucide-react'
import { useStore } from '../store'
import ServerUpdateSection from '../components/ServerUpdate'
import { TIMEZONE_LIST } from '../utils/timezone'
import toast from 'react-hot-toast'
import clsx from 'clsx'

function Section({ title, icon: Icon, children }) {
  return (
    <div className="card p-6">
      <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-5">
        <Icon size={17} className="text-teal-600" /> {title}
      </h3>
      {children}
    </div>
  )
}

function StatusChip({ ok, label }) {
  return ok === null ? null : (
    <span className={clsx('flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full',
      ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}>
      {ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
      {label}
    </span>
  )
}

export default function SettingsPage() {
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)

  // Sync settings
  const [sync, setSync] = useState({ server_url: '', api_key: '', site_name: '', interval_minutes: 5 })
  const [syncSites, setSyncSites] = useState([])
  const [loadingSites, setLoadingSites] = useState(false)
  // Sync log
  const [syncLog, setSyncLog] = useState([])
  const [syncLogLoading, setSyncLogLoading] = useState(false)
  const [failedQueue, setFailedQueue] = useState([])
  const [retrying, setRetrying] = useState(false)

  const loadSyncLog = async () => {
    setSyncLogLoading(true)
    try {
      const [logRes, failedRes] = await Promise.all([
        settingsApi.syncLog(20),
        settingsApi.syncFailedQueue(),
      ])
      setSyncLog(logRes.data)
      setFailedQueue(failedRes.data)
    } catch { /* silent */ }
    finally { setSyncLogLoading(false) }
  }

  const retryFailed = async () => {
    setRetrying(true)
    try {
      const res = await settingsApi.syncRetryFailed()
      toast.success(res.data.message)
      await loadSyncLog()
    } catch { toast.error('Retry failed') }
    finally { setRetrying(false) }
  }
  const [syncStatus, setSyncStatus] = useState(null)
  const [syncTesting, setSyncTesting] = useState(false)

  // SMTP
  const [smtp, setSmtp] = useState({ host: '', port: 587, user: '', password: '', from_email: '' })
  const [smtpStatus, setSmtpStatus] = useState(null)
  const [smtpTesting, setSmtpTesting] = useState(false)

  // Password
  const [pwd, setPwd] = useState({ current_password: '', new_password: '', confirm: '' })
  const [pwdLoading, setPwdLoading] = useState(false)

  // SNMP timeout
  const [snmpTimeout, setSnmpTimeout] = useState(5)
  const [pollInterval, setPollInterval] = useState(5)
  const [snmpSaving, setSnmpSaving] = useState(false)


  // Timezone (frontend display preference — stored in localStorage via Zustand)
  const { timezone, setTimezone } = useStore()

  // ── Desktop application (Electron only) — auto-start + manual update check ──
  const electron = typeof window !== 'undefined' ? window.electronAPI : null
  const [appVersion, setAppVersion] = useState('')
  const [autoLaunch, setAutoLaunch] = useState(null)         // null = still loading
  const [updateCheck, setUpdateCheck] = useState({ phase: 'idle' })

  useEffect(() => {
    if (!electron?.isElectron) return
    electron.getAppVersion?.().then(v => setAppVersion(v || '')).catch(() => {})
    electron.getAutoLaunch?.()
      .then(r => setAutoLaunch(Boolean(r?.enabled)))
      .catch(() => setAutoLaunch(false))
  }, [])

  const toggleAutoLaunch = async () => {
    const next = !autoLaunch
    setAutoLaunch(next)
    try {
      const r = await electron.setAutoLaunch(next)
      setAutoLaunch(Boolean(r?.enabled))
      if (r?.error) toast.error(`Could not change auto-start: ${r.error}`)
      else toast.success(next
        ? 'SentinelNMS will now start when the computer starts'
        : 'Auto-start disabled')
    } catch {
      setAutoLaunch(!next)
      toast.error('Could not change auto-start')
    }
  }

  const checkForUpdates = async () => {
    setUpdateCheck({ phase: 'checking' })
    try {
      const r = await electron.checkNow()
      if (r?.error) setUpdateCheck({ phase: 'error', message: r.error })
      else if (r?.available) setUpdateCheck({ phase: 'available', latest: r.latest })
      else setUpdateCheck({ phase: 'uptodate', current: r?.current })
    } catch {
      setUpdateCheck({ phase: 'error', message: 'Update check failed' })
    }
  }

  useEffect(() => {
    settingsApi.get().then(r => {
      setConfig(r.data)
      if (r.data.sync) {
        setSync(s => ({
          ...s,
          server_url: r.data.sync.server_url || '',
          site_name: r.data.sync.site_name || '',
          interval_minutes: r.data.sync.interval_minutes || 5,
        }))
      }
      if (r.data.smtp) {
        setSmtp(s => ({
          ...s,
          host: r.data.smtp.host || '',
          port: r.data.smtp.port || 587,
          user: r.data.smtp.user || '',
        }))
      }
      if (r.data.snmp?.timeout) {
        setSnmpTimeout(r.data.snmp.timeout)
      }
      if (r.data.snmp?.poll_interval) {
        setPollInterval(r.data.snmp.poll_interval)
      }
      // Auto-load sync log in desktop mode
      if (r.data.app?.mode === 'desktop') {
        loadSyncLog()
      }
    }).finally(() => setLoading(false))
  }, [])

  const saveSnmpTimeout = async () => {
    setSnmpSaving(true)
    try {
      await settingsApi.saveSnmp({ timeout: snmpTimeout, poll_interval: pollInterval })
      toast.success(isDesktop
        ? `SNMP settings saved (timeout: ${snmpTimeout}s, polling: ${pollInterval}s)`
        : `SNMP timeout set to ${snmpTimeout}s`)
    } catch { toast.error('Failed to save SNMP settings') }
    finally { setSnmpSaving(false) }
  }
  const saveSync = async () => {
    try {
      await settingsApi.configurSync(sync)
      toast.success('Sync settings saved')
    } catch { toast.error('Failed to save sync settings') }
  }

  const testSync = async () => {
    setSyncTesting(true); setSyncStatus(null)
    try {
      const r = await settingsApi.testSync()
      setSyncStatus(r.data.success)
      toast[r.data.success ? 'success' : 'error'](r.data.success ? 'Server reachable!' : `Cannot reach server: ${r.data.error}`)
    } catch { setSyncStatus(false) }
    finally { setSyncTesting(false) }
  }

  const testSmtp = async () => {
    setSmtpTesting(true); setSmtpStatus(null)
    try {
      const r = await settingsApi.testSmtp(smtp)
      setSmtpStatus(r.data.success)
      toast[r.data.success ? 'success' : 'error'](r.data.success ? 'SMTP connection OK' : r.data.error)
    } catch { setSmtpStatus(false) }
    finally { setSmtpTesting(false) }
  }

  const changePassword = async () => {
    if (pwd.new_password !== pwd.confirm) return toast.error('Passwords do not match')
    if (pwd.new_password.length < 4) return toast.error('Password too short (min 4 characters)')
    setPwdLoading(true)
    try {
      await api.post('/auth/change-password', {
        current_password: pwd.current_password,
        new_password: pwd.new_password,
      })
      toast.success('Password changed!')
      setPwd({ current_password: '', new_password: '', confirm: '' })
    } catch (e) { toast.error(e.response?.data?.detail || 'Failed to change password') }
    finally { setPwdLoading(false) }
  }

  if (loading) return (
    <div className="flex justify-center pt-16">
      <div className="w-8 h-8 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  const isDesktop = config?.app?.mode === 'desktop'

  return (
    <div className="space-y-5 max-w-2xl animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-gray-500 text-sm mt-1">
          Mode: <span className="font-medium text-teal-600">{config?.app?.mode}</span>
          {' '}· Version: <span className="font-medium">{config?.app?.version}</span>
          {' '}· SNMP trap port: <span className="font-mono font-medium">{config?.snmp?.trap_port}</span>
        </p>
      </div>

      {/* Server self-update — server mode + admin only (gated inside the component) */}
      <ServerUpdateSection />

      {/* Desktop application — only inside the Electron app */}
      {electron?.isElectron && (
        <Section title="Application" icon={Monitor}>
          {/* Auto-start at login */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Start when the computer starts</p>
              <p className="text-xs text-gray-400 mt-0.5">
                Launches minimized to the tray at login, so monitoring and cloud sync resume automatically after a restart.
              </p>
            </div>
            <button
              onClick={toggleAutoLaunch}
              disabled={autoLaunch === null}
              role="switch" aria-checked={!!autoLaunch}
              className={clsx('relative w-11 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-40',
                autoLaunch ? 'bg-teal-600' : 'bg-gray-300 dark:bg-gray-600')}
            >
              <span className={clsx('absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform',
                autoLaunch && 'translate-x-5')} />
            </button>
          </div>

          {/* Manual update check */}
          <div className="mt-5 border-t border-gray-100 dark:border-gray-700 pt-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Software updates</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  Current version: <span className="font-mono">v{appVersion || config?.app?.version}</span>
                  {' '}· also checked automatically every 4 hours
                </p>
              </div>
              <button
                onClick={checkForUpdates}
                disabled={updateCheck.phase === 'checking'}
                className="btn-secondary flex items-center gap-2 flex-shrink-0"
              >
                <RefreshCw size={14} className={updateCheck.phase === 'checking' ? 'animate-spin' : ''} />
                {updateCheck.phase === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
            {updateCheck.phase === 'uptodate' && (
              <p className="mt-3 text-sm text-green-600 dark:text-green-400 flex items-center gap-1.5">
                <CheckCircle size={14} /> You're on the latest version{updateCheck.current ? ` (v${updateCheck.current})` : ''}.
              </p>
            )}
            {updateCheck.phase === 'available' && (
              <p className="mt-3 text-sm text-teal-600 dark:text-teal-400">
                v{updateCheck.latest} is available — use the update bar at the top of the window to download and install it.
              </p>
            )}
            {updateCheck.phase === 'error' && (
              <p className="mt-3 text-sm text-red-500">{updateCheck.message}</p>
            )}
          </div>
        </Section>
      )}

      {/* Cloud Sync — desktop mode only */}
      {isDesktop && (
        <Section title="Cloud Sync" icon={Cloud}>
          <p className="text-sm text-gray-500 mb-4">
            Push local monitoring data to a central NMS-Tool server. Works offline — data queues locally and syncs when connection restores.
          </p>
          {config?.sync?.connected && (
            <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg text-sm text-green-700 dark:text-green-300">
              ✅ Connected to {config.sync.server_url} · Last sync: {config.sync.last_sync ? new Date(config.sync.last_sync).toLocaleString() : 'never'}
            </div>
          )}
          <div className="space-y-3">
            <div>
              <label className="label">
                Site Name
                <span className="text-xs text-gray-400 font-normal ml-2">Identifies this desktop in the cloud dashboard</span>
              </label>
              <input className="input" value={sync.site_name}
                onChange={e => setSync(s => ({ ...s, site_name: e.target.value }))}
                placeholder="e.g. Office-HQ, Branch-Mumbai, Home-Lab" />
            </div>
            <div><label className="label">Cloud Server URL</label>
              <input className="input" value={sync.server_url}
                onChange={e => setSync(s => ({ ...s, server_url: e.target.value }))}
                placeholder="http://localhost:8765  or  https://nms.yourcompany.com" /></div>
            <div>
              <label className="label">
                Gateway API Key
                <span className="text-xs text-gray-400 font-normal ml-2">Set in server .env as SYNC_API_KEY</span>
              </label>
              <input className="input" type="password" value={sync.api_key}
                onChange={e => setSync(s => ({ ...s, api_key: e.target.value }))}
                placeholder="Leave empty if server has no key set" />
            </div>
            <div><label className="label">Sync every (minutes)</label>
              <input className="input w-32" type="number" min={1} max={60} value={sync.interval_minutes}
                onChange={e => setSync(s => ({ ...s, interval_minutes: +e.target.value }))} /></div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button onClick={saveSync} className="btn-primary">Save</button>
            <button onClick={testSync} disabled={syncTesting || !sync.server_url}
              className="btn-secondary flex items-center gap-2">
              {syncTesting ? <RefreshCw size={14} className="animate-spin" /> : <Cloud size={14} />}
              Test Connection
            </button>
            <StatusChip ok={syncStatus} label={syncStatus ? 'Connected' : 'Failed'} />
          </div>

          {/* ── Sync Activity Log ── */}
          <div className="mt-6 border-t border-gray-100 dark:border-gray-700 pt-5">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                <Activity size={14} className="text-teal-500" /> Sync Activity
              </h4>
              <div className="flex gap-2">
                {failedQueue.length > 0 && (
                  <button onClick={retryFailed} disabled={retrying}
                    className="text-xs bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400 border border-red-200 dark:border-red-800 px-3 py-1 rounded-full flex items-center gap-1 hover:bg-red-100 transition-colors">
                    <RefreshCw size={11} className={retrying ? 'animate-spin' : ''} />
                    {retrying ? 'Retrying…' : `Retry ${failedQueue.length} failed`}
                  </button>
                )}
                <button onClick={loadSyncLog} disabled={syncLogLoading}
                  className="text-xs text-gray-500 hover:text-teal-600 flex items-center gap-1">
                  <RefreshCw size={11} className={syncLogLoading ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </div>
            </div>

            {syncLog.length === 0 && !syncLogLoading ? (
              <div className="text-center py-6 text-sm text-gray-400">
                {sync.server_url
                  ? 'No sync activity yet — first sync will run shortly after saving'
                  : 'Configure the server URL above and save to start syncing'}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {syncLog.map(entry => (
                  <div key={entry.id}
                    className={clsx(
                      'flex items-start gap-3 p-2.5 rounded-lg text-xs border',
                      entry.status === 'success' ? 'bg-green-50 border-green-100 dark:bg-green-900/10 dark:border-green-900/30' :
                      entry.status === 'partial'  ? 'bg-amber-50 border-amber-100 dark:bg-amber-900/10 dark:border-amber-900/30' :
                      entry.status === 'offline'  ? 'bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-700' :
                                                    'bg-red-50 border-red-100 dark:bg-red-900/10 dark:border-red-900/30'
                    )}>
                    {/* Status icon */}
                    <span className="text-base flex-shrink-0 mt-0.5">
                      {entry.status === 'success' ? '✓' :
                       entry.status === 'partial'  ? '⚠' :
                       entry.status === 'offline'  ? '⊘' : '✗'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Timestamp in selected timezone */}
                        <span className="font-mono text-gray-500 dark:text-gray-400">
                          {new Intl.DateTimeFormat('en-GB', {
                            timeZone: timezone,
                            hour: '2-digit', minute: '2-digit', second: '2-digit',
                            hour12: false,
                          }).format(new Date(entry.timestamp + 'Z'))}
                        </span>
                        {/* Status badge */}
                        <span className={clsx('font-semibold capitalize',
                          entry.status === 'success' ? 'text-green-700 dark:text-green-400' :
                          entry.status === 'partial'  ? 'text-amber-700 dark:text-amber-400' :
                          entry.status === 'offline'  ? 'text-gray-500' :
                                                        'text-red-700 dark:text-red-400')}>
                          {entry.status}
                        </span>
                        {/* Counts */}
                        {(entry.items_pushed > 0 || entry.items_failed > 0) && (
                          <span className="text-gray-500">
                            pushed:{entry.items_pushed}
                            {entry.items_failed > 0 && (
                              <span className="text-red-500 ml-1">failed:{entry.items_failed}</span>
                            )}
                            {entry.items_pending > 0 && (
                              <span className="text-amber-500 ml-1">pending:{entry.items_pending}</span>
                            )}
                          </span>
                        )}
                        {/* Duration */}
                        {entry.duration_ms != null && (
                          <span className="text-gray-400">{entry.duration_ms}ms</span>
                        )}
                      </div>
                      {/* Error message */}
                      {entry.error && (
                        <p className="mt-0.5 text-red-600 dark:text-red-400 truncate" title={entry.error}>
                          {entry.error.length > 80 ? entry.error.slice(0, 80) + '…' : entry.error}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Connected Sites — server mode only */}
      {!isDesktop && (
        <Section title="Connected Desktop Agents" icon={Monitor}>
          <p className="text-sm text-gray-500 mb-4">
            Desktop installations that are syncing data to this server.
          </p>
          <button
            onClick={async () => {
              setLoadingSites(true)
              try { setSyncSites((await settingsApi.syncSites()).data) }
              catch { toast.error('Could not load sites') }
              finally { setLoadingSites(false) }
            }}
            className="btn-secondary text-sm flex items-center gap-2 mb-4"
          >
            <RefreshCw size={13} className={loadingSites ? 'animate-spin' : ''} />
            {loadingSites ? 'Loading...' : 'Refresh'}
          </button>
          {syncSites.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No desktop agents connected yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-xs text-gray-400 uppercase">
                    <th className="pb-2 pr-4">Site Name</th>
                    <th className="pb-2 pr-4">Status</th>
                    <th className="pb-2 pr-4">Devices</th>
                    <th className="pb-2 pr-4">Last Sync</th>
                    <th className="pb-2">Version</th>
                  </tr>
                </thead>
                <tbody>
                  {syncSites.map(site => (
                    <tr key={site.site_name} className="border-b border-gray-100 dark:border-gray-800">
                      <td className="py-2 pr-4 font-medium text-gray-800 dark:text-gray-200">{site.site_name}</td>
                      <td className="py-2 pr-4">
                        <span className={clsx('inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full',
                          site.status === 'online'  ? 'bg-green-100 text-green-700' :
                          site.status === 'recent'  ? 'bg-amber-100 text-amber-700' :
                                                      'bg-gray-100 text-gray-500')}>
                          <span className={clsx('w-1.5 h-1.5 rounded-full',
                            site.status === 'online' ? 'bg-green-500' :
                            site.status === 'recent' ? 'bg-amber-400' : 'bg-gray-400')} />
                          {site.status === 'online'  ? 'Online' :
                           site.status === 'recent'  ? `${Math.round(site.last_seen_ago_secs / 60)}m ago` :
                           'Offline'}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-gray-600 dark:text-gray-400">{site.device_count}</td>
                      <td className="py-2 pr-4 text-gray-500 text-xs font-mono">
                        {site.last_sync
                          ? (() => {
                              const d = new Date(site.last_sync + 'Z')
                              const diffMin = Math.round((Date.now() - d) / 60000)
                              return diffMin < 60
                                ? `${diffMin}m ago`
                                : d.toLocaleString()
                            })()
                          : '—'}
                      </td>
                      <td className="py-2 text-gray-400 text-xs">{site.software_version || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {/* SMTP */}
      <Section title="Email Notifications (SMTP)" icon={Mail}>
        <p className="text-sm text-gray-500 mb-4">
          Configure email alerts for critical events and trap rules.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 md:col-span-1">
            <label className="label">SMTP Host</label>
            <input className="input" value={smtp.host}
              onChange={e => setSmtp(s => ({ ...s, host: e.target.value }))}
              placeholder="smtp.gmail.com" />
          </div>
          <div>
            <label className="label">Port</label>
            <input className="input" type="number" value={smtp.port}
              onChange={e => setSmtp(s => ({ ...s, port: +e.target.value }))} />
          </div>
          <div>
            <label className="label">Username</label>
            <input className="input" value={smtp.user}
              onChange={e => setSmtp(s => ({ ...s, user: e.target.value }))}
              placeholder="alerts@yourcompany.com" />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" value={smtp.password}
              onChange={e => setSmtp(s => ({ ...s, password: e.target.value }))}
              placeholder="App password" />
          </div>
          <div>
            <label className="label">From address</label>
            <input className="input" value={smtp.from_email}
              onChange={e => setSmtp(s => ({ ...s, from_email: e.target.value }))}
              placeholder="nms@yourcompany.com" />
          </div>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button onClick={testSmtp} disabled={smtpTesting || !smtp.host}
            className="btn-primary flex items-center gap-2">
            {smtpTesting ? <RefreshCw size={14} className="animate-spin" /> : <Mail size={14} />}
            Test SMTP
          </button>
          <StatusChip ok={smtpStatus} label={smtpStatus ? 'SMTP OK' : 'Failed'} />
        </div>
      </Section>

      {/* SNMP Configuration */}
      <Section title="SNMP Configuration" icon={Wifi}>
        <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400 mb-5">
          <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
            <span>Trap listen port</span>
            <span className="font-mono font-semibold text-gray-800 dark:text-gray-200">{config?.snmp?.trap_port}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
            <span>Default community string</span>
            <span className="font-mono font-semibold text-gray-800 dark:text-gray-200">{config?.snmp?.default_community}</span>
          </div>
        </div>

        {/* Editable: Poll timeout */}
        <div>
          <label className="label">
            Poll timeout
            <span className="text-xs text-gray-400 font-normal ml-2">
              How long to wait for each SNMP response (2–15 seconds)
            </span>
          </label>
          <div className="flex items-center gap-4 mt-2">
            <input
              type="range" min={2} max={15} step={1}
              value={snmpTimeout}
              onChange={e => setSnmpTimeout(Number(e.target.value))}
              className="flex-1 accent-teal-500"
            />
            <span className="font-mono font-semibold text-gray-800 dark:text-gray-200 w-12 text-center">
              {snmpTimeout}s
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Lower = faster polls but more timeouts on slow devices. Higher = more reliable but slower detection.
          </p>
        </div>

        {/* Editable: Global Poll Interval (Desktop only) */}
        {isDesktop && (
          <div className="mt-5 border-t border-gray-100 dark:border-gray-700 pt-5 animate-fade-in">
            <label className="label">
              Global Poll Interval
              <span className="text-xs text-gray-400 font-normal ml-2">
                How often to poll devices (1–15 seconds)
              </span>
            </label>
            <div className="flex items-center gap-4 mt-2">
              <input
                type="range" min={1} max={15} step={1}
                value={pollInterval}
                onChange={e => setPollInterval(Number(e.target.value))}
                className="flex-1 accent-teal-500"
              />
              <span className="font-mono font-semibold text-gray-800 dark:text-gray-200 w-12 text-center">
                {pollInterval}s
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Controls how frequently the NMS desktop client queries devices. Range is 1 to 15 seconds. Default is 5s.
            </p>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button onClick={saveSnmpTimeout} disabled={snmpSaving} className="btn-primary text-sm px-4 py-1.5">
            {snmpSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </Section>

      {/* Timezone */}
      <Section title="Display Timezone" icon={Globe}>
        <p className="text-sm text-gray-500 mb-4">
          All timestamps are stored as <strong>UTC</strong> in the database.
          Select your local timezone to display them correctly throughout the app.
        </p>
        <div className="max-w-sm">
          <label className="label">Timezone</label>
          <select
            className="input"
            value={timezone}
            onChange={e => {
              setTimezone(e.target.value)
              toast.success(`Timezone set to ${e.target.value}`)
            }}
          >
            {TIMEZONE_LIST.map(group => (
              <optgroup key={group.group} label={group.group}>
                {group.options.map(tz => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-2">
            Current selection: <span className="font-mono font-medium text-gray-600 dark:text-gray-300">{timezone}</span>
            {' · '}Current time: <span className="font-mono font-medium text-gray-600 dark:text-gray-300">
              {new Intl.DateTimeFormat('en-GB', {
                timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
              }).format(new Date())}
            </span>
          </p>
        </div>
      </Section>

      {/* Password */}
      <Section title="Change Password" icon={Lock}>
        <div className="space-y-3 max-w-sm">
          <div><label className="label">Current password</label>
            <input className="input" type="password" value={pwd.current_password}
              onChange={e => setPwd(p => ({ ...p, current_password: e.target.value }))} /></div>
          <div><label className="label">New password</label>
            <input className="input" type="password" value={pwd.new_password}
              onChange={e => setPwd(p => ({ ...p, new_password: e.target.value }))} /></div>
          <div><label className="label">Confirm new password</label>
            <input className="input" type="password" value={pwd.confirm}
              onChange={e => setPwd(p => ({ ...p, confirm: e.target.value }))} /></div>
          <button onClick={changePassword} disabled={pwdLoading} className="btn-primary">
            {pwdLoading ? 'Saving...' : 'Update Password'}
          </button>
        </div>
      </Section>
    </div>
  )
}
