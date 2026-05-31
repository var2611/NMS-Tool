import { useEffect, useState } from 'react'
import { settingsApi } from '../utils/api'
import api from '../utils/api'
import { Settings, Cloud, Mail, Lock, Wifi, CheckCircle, XCircle, RefreshCw } from 'lucide-react'
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
  const [sync, setSync] = useState({ server_url: '', api_key: '', interval_minutes: 5 })
  const [syncStatus, setSyncStatus] = useState(null)
  const [syncTesting, setSyncTesting] = useState(false)

  // SMTP
  const [smtp, setSmtp] = useState({ host: '', port: 587, user: '', password: '', from_email: '' })
  const [smtpStatus, setSmtpStatus] = useState(null)
  const [smtpTesting, setSmtpTesting] = useState(false)

  // Password
  const [pwd, setPwd] = useState({ current_password: '', new_password: '', confirm: '' })
  const [pwdLoading, setPwdLoading] = useState(false)

  useEffect(() => {
    settingsApi.get().then(r => {
      setConfig(r.data)
      if (r.data.sync) {
        setSync(s => ({
          ...s,
          server_url: r.data.sync.server_url || '',
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
    }).finally(() => setLoading(false))
  }, [])

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
            <div><label className="label">Server URL</label>
              <input className="input" value={sync.server_url}
                onChange={e => setSync(s => ({ ...s, server_url: e.target.value }))}
                placeholder="https://nms.yourcompany.com" /></div>
            <div><label className="label">API Key</label>
              <input className="input" type="password" value={sync.api_key}
                onChange={e => setSync(s => ({ ...s, api_key: e.target.value }))}
                placeholder="Site API key from server settings" /></div>
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

      {/* SNMP info */}
      <Section title="SNMP Configuration" icon={Wifi}>
        <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
          <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
            <span>Trap listen port</span>
            <span className="font-mono font-semibold text-gray-800 dark:text-gray-200">{config?.snmp?.trap_port}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
            <span>Default community string</span>
            <span className="font-mono font-semibold text-gray-800 dark:text-gray-200">{config?.snmp?.default_community}</span>
          </div>
          <div className="flex justify-between py-2">
            <span>Poll timeout</span>
            <span className="font-mono font-semibold text-gray-800 dark:text-gray-200">{config?.snmp?.timeout}s</span>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-3">
          To change SNMP settings, edit the <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">.env</code> file and restart NMS-Tool.
        </p>
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
