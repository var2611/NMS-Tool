import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { updateApi } from '../utils/api'
import { useStore } from '../store'
import {
  DownloadCloud, RefreshCw, CheckCircle, XCircle, Loader, Rocket,
  GitCommitHorizontal, WifiOff, ArrowUpCircle,
} from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'

/**
 * ServerUpdate — admin-only "Update now" for the dockerized server.
 *
 * The actual update runs on the HOST (scripts/server-auto-update.sh via cron):
 * pressing the button drops a trigger file through the API; the host script
 * picks it up within a minute and streams progress into data/update/status.json,
 * which this component polls — including across the API restart gap while the
 * container is being recreated.
 */

const STEPS = [
  { phase: 'pulling',    label: 'Downloading new version',      desc: 'Pulling the latest code from GitHub' },
  { phase: 'frontend',   label: 'Building web interface',       desc: 'Compiling the React frontend' },
  { phase: 'containers', label: 'Rebuilding services',          desc: 'Rebuilding and restarting Docker containers' },
  { phase: 'migrations', label: 'Applying database migrations', desc: 'Upgrading the database schema' },
  { phase: 'done',       label: 'Finished',                     desc: 'Everything is up to date' },
]

function stepState(stepIndex, status) {
  if (!status) return 'pending'
  const current = status.step ?? 0
  if (status.phase === 'done') return 'done'
  if (status.phase === 'error') {
    if (stepIndex + 1 < current) return 'done'
    if (stepIndex + 1 === current) return 'error'
    return 'pending'
  }
  if (stepIndex + 1 < current) return 'done'
  if (stepIndex + 1 === current) return 'active'
  return 'pending'
}

function UpdateProgressModal({ onClose }) {
  const [status, setStatus] = useState(null)
  const [offline, setOffline] = useState(false)
  const [newVersion, setNewVersion] = useState(null)
  const startedRef = useRef(Date.now())

  useEffect(() => {
    let stopped = false
    const poll = async () => {
      try {
        const r = await updateApi.status()
        if (stopped) return
        setOffline(false)
        setStatus(r.data.status)
        setNewVersion(r.data.app_version)
      } catch {
        // Expected while the API container is being recreated — keep the last
        // known progress on screen and let the user see we're reconnecting.
        if (!stopped) setOffline(true)
      }
    }
    poll()
    const t = setInterval(poll, 2000)
    return () => { stopped = true; clearInterval(t) }
  }, [])

  const phase = status?.phase
  const finished = phase === 'done'
  const failed = phase === 'error'
  const queued = !status || phase === 'queued'
  const queuedTooLong = queued && Date.now() - startedRef.current > 3 * 60 * 1000
  const alreadyUpToDate = finished && !status?.to

  return createPortal(
    <div className="fixed inset-0 z-[100000] flex items-center justify-center p-4 bg-black/70" style={{ transform: 'translate3d(0,0,0)', backfaceVisibility: 'hidden' }}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

        {/* Header */}
        <div className="px-6 pt-6 pb-4 text-center border-b border-gray-100 dark:border-gray-800">
          <div className={clsx('w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3',
            failed ? 'bg-red-100 dark:bg-red-900/30' : finished ? 'bg-green-100 dark:bg-green-900/30' : 'bg-teal-100 dark:bg-teal-900/30')}>
            {failed ? <XCircle size={28} className="text-red-500" />
              : finished ? <CheckCircle size={28} className="text-green-500" />
              : <Rocket size={28} className="text-teal-600" />}
          </div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {failed ? 'Update failed' : finished ? (alreadyUpToDate ? 'Already up to date' : 'Update complete!') : 'Updating server…'}
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            {finished || failed ? status?.message
              : queued ? 'Waiting for the server updater to start (up to a minute)…'
              : 'Please keep this window open — the connection drops briefly while services restart.'}
          </p>
        </div>

        {/* Steps */}
        {!alreadyUpToDate && (
          <div className="px-6 py-5 space-y-1">
            {STEPS.map((s, i) => {
              const st = stepState(i, status)
              return (
                <div key={s.phase} className="flex items-start gap-3 py-2">
                  <div className={clsx('w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-colors',
                    st === 'done' ? 'bg-green-100 dark:bg-green-900/30'
                    : st === 'active' ? 'bg-teal-100 dark:bg-teal-900/30'
                    : st === 'error' ? 'bg-red-100 dark:bg-red-900/30'
                    : 'bg-gray-100 dark:bg-gray-800')}>
                    {st === 'done' ? <CheckCircle size={15} className="text-green-500" />
                      : st === 'error' ? <XCircle size={15} className="text-red-500" />
                      : st === 'active' ? <Loader size={15} className="animate-spin text-teal-600" />
                      : <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-600" />}
                  </div>
                  <div className="min-w-0">
                    <p className={clsx('text-sm font-medium',
                      st === 'active' ? 'text-teal-600 dark:text-teal-400'
                      : st === 'done' ? 'text-gray-950 dark:text-white font-normal'
                      : 'text-gray-400 dark:text-gray-600')}>{s.label}</p>
                    {st === 'active' && <p className="text-xs text-gray-400 mt-0.5">{s.desc}</p>}
                    {st === 'error' && status.message && (
                      <p className="text-xs text-red-500 font-medium mt-1">{status.message}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}


        {/* Queued for too long */}
        {queuedTooLong && (
          <div className="mx-6 mb-4 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs">
            The updater has not started yet. Make sure the cron job is installed on the server:
            <code className="block mt-1 font-mono">bash scripts/server-auto-update.sh --install</code>
          </div>
        )}

        {/* Version summary on success */}
        {finished && !alreadyUpToDate && (
          <div className="mx-6 mb-4 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-green-50 dark:bg-green-900/20 text-sm">
            <GitCommitHorizontal size={15} className="text-green-600" />
            <span className="font-mono text-xs text-gray-600 dark:text-gray-300">{status?.from}</span>
            <span className="text-gray-400">→</span>
            <span className="font-mono text-xs font-semibold text-green-700 dark:text-green-400">{status?.to}</span>
            {newVersion && <span className="badge bg-green-100 text-green-700 text-xs ml-1">v{newVersion}</span>}
          </div>
        )}

        {/* Footer */}
        <div className="px-6 pb-6">
          {finished ? (
            alreadyUpToDate ? (
              <button onClick={onClose} className="btn-secondary w-full">Close</button>
            ) : (
              <button onClick={() => window.location.reload()} className="btn-primary w-full flex items-center justify-center gap-2">
                <RefreshCw size={15} /> Reload interface
              </button>
            )
          ) : failed ? (
            <div className="space-y-2">
              <p className="text-xs text-gray-500 text-center">
                Check <code className="font-mono">data/auto-update.log</code> on the server for details.
              </p>
              <button onClick={onClose} className="btn-secondary w-full">Close</button>
            </div>
          ) : (
            <p className="text-center text-xs text-gray-400">This usually takes 1–3 minutes</p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ServerUpdateSection() {
  const { user } = useStore()
  const [info, setInfo] = useState(null)        // GET /update/status payload
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)

  const isAdmin = user?.role === 'admin'

  const loadStatus = () => updateApi.status().then(r => { setInfo(r.data); return r.data }).catch(() => null)

  useEffect(() => { if (isAdmin) loadStatus() }, [isAdmin])

  if (!isAdmin || !info?.supported) return null

  const check = info.check
  const updateAvailable = check?.update_available

  const runCheck = async () => {
    setChecking(true)
    const before = check?.checked_at
    try {
      await updateApi.check()
      // The host updater refreshes check.json within ~1 min — poll until the
      // timestamp moves so the button reflects a real, fresh answer.
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 3000))
        const fresh = await loadStatus()
        if (fresh?.check?.checked_at && fresh.check.checked_at !== before) {
          toast.success(fresh.check.update_available
            ? `Update available: ${fresh.check.behind} new commit${fresh.check.behind === 1 ? '' : 's'}`
            : 'Already up to date')
          setChecking(false)
          return
        }
      }
      toast.error('Updater did not respond — is the cron job installed on the server?')
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Check failed')
    }
    setChecking(false)
  }

  const startUpdate = async () => {
    try {
      await updateApi.apply()
      setUpdating(true)
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not start update')
    }
  }

  return (
    <div className="card p-6">
      {updating && <UpdateProgressModal onClose={() => { setUpdating(false); loadStatus() }} />}

      <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-5">
        <DownloadCloud size={17} className="text-teal-600" /> Server Update
      </h3>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Installed version: <span className="font-semibold text-teal-600">v{info.app_version}</span>
            {check?.current && <span className="font-mono text-xs text-gray-400 ml-2">({check.current})</span>}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {check?.checked_at
              ? `Last checked: ${new Date(check.checked_at).toLocaleString()}`
              : 'Not checked yet'}
          </p>
        </div>
        <button onClick={runCheck} disabled={checking} className="btn-secondary flex items-center gap-2 text-sm">
          {checking ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {checking ? 'Checking…' : 'Check for Updates'}
        </button>
      </div>

      {updateAvailable && (
        <div className="mt-4 rounded-xl border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-900/20 p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <ArrowUpCircle size={18} className="text-teal-600" />
              <p className="text-sm font-semibold text-teal-800 dark:text-teal-300">
                New version available — {check.behind} commit{check.behind === 1 ? '' : 's'} behind
              </p>
            </div>
            <button onClick={startUpdate} className="btn-primary flex items-center gap-2 text-sm">
              <Rocket size={14} /> Update Now
            </button>
          </div>
          {check.commits?.length > 0 && (
            <ul className="mt-3 space-y-1">
              {check.commits.map(c => (
                <li key={c} className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <GitCommitHorizontal size={13} className="text-teal-500 flex-shrink-0 mt-0.5" />
                  <span className="font-mono truncate">{c}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
