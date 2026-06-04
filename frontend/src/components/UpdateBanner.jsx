import { useEffect, useState, useCallback } from 'react'
import { Download, RefreshCw, X, ExternalLink, CheckCircle, AlertTriangle, Loader } from 'lucide-react'
import clsx from 'clsx'

/**
 * UpdateBanner
 *
 * Renders a prominent top-bar inside the Electron desktop app when a
 * software update is available. Web visitors (no window.electronAPI) see nothing.
 *
 * Full lifecycle:
 *   idle → checking → available → downloading → ready → installing → (app restarts)
 *
 * Windows:  full silent download + install + auto-restart
 * macOS:    download + install (requires signed build; fallback opens GitHub)
 * Linux:    shows link to GitHub releases page
 */

const PHASES = {
  IDLE:        'idle',
  CHECKING:    'checking',
  AVAILABLE:   'available',
  DOWNLOADING: 'downloading',
  READY:       'ready',
  INSTALLING:  'installing',
  ERROR:       'error',
  UP_TO_DATE:  'up_to_date',
}

export default function UpdateBanner() {
  const api = window.electronAPI
  const [phase, setPhase]       = useState(PHASES.IDLE)
  const [info, setInfo]         = useState({})   // { version, releaseDate }
  const [progress, setProgress] = useState(0)    // 0-100
  const [speed, setSpeed]       = useState(0)    // bytes/sec
  const [error, setError]       = useState('')
  const [dismissed, setDismiss] = useState(false)

  // ── Wire up IPC events ──────────────────────────────────────────────────
  useEffect(() => {
    if (!api?.onUpdateAvailable) return

    api.onUpdateAvailable(i => {
      setInfo(i)
      setPhase(PHASES.AVAILABLE)
      setDismiss(false)
    })
    api.onDownloadProgress(i => {
      setPhase(PHASES.DOWNLOADING)
      setProgress(Math.round(i.percent || 0))
      setSpeed(i.bytesPerSecond || 0)
    })
    api.onUpdateDownloaded(i => {
      setInfo(prev => ({ ...prev, ...i }))
      setPhase(PHASES.READY)
    })
    api.onUpdateError(i => {
      setError(i.message || 'Unknown error')
      setPhase(PHASES.ERROR)
    })
    api.onUpdateInstalling?.(() => {
      setPhase(PHASES.INSTALLING)
    })

    return () => api.removeUpdateListeners?.()
  }, [])

  // ── Actions ─────────────────────────────────────────────────────────────
  const handleDownload = useCallback(async () => {
    setPhase(PHASES.DOWNLOADING)
    setProgress(0)
    const result = await api.startDownload()
    if (result?.error) {
      setError(result.error)
      setPhase(PHASES.ERROR)
    }
  }, [api])

  const handleInstall = useCallback(() => {
    setPhase(PHASES.INSTALLING)
    // Give React time to render "Installing…" before the app quits
    setTimeout(() => api.installNow(), 400)
  }, [api])

  const handleOpenGitHub = useCallback(() => {
    api.openReleasesPage?.()
  }, [api])

  const handleCheckNow = useCallback(async () => {
    setPhase(PHASES.CHECKING)
    setDismiss(false)
    const result = await api.checkNow?.()
    if (result?.error) {
      // checkNow returned no update or error
      setTimeout(() => setPhase(PHASES.IDLE), 3000)
    }
    // update-available event will fire if there IS a new version
  }, [api])

  // ── Render nothing if not Electron or dismissed or idle ─────────────────
  if (!api?.isElectron) return null
  if (dismissed && phase === PHASES.AVAILABLE) return null
  if (phase === PHASES.IDLE || phase === PHASES.UP_TO_DATE) return null

  const isWindows = api.platform === 'win32'
  const isMac     = api.platform === 'darwin'

  // ── Colour scheme per phase ─────────────────────────────────────────────
  const barColor = {
    [PHASES.CHECKING]:    'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
    [PHASES.AVAILABLE]:   'bg-teal-50 dark:bg-teal-900/30 border-teal-300 dark:border-teal-700',
    [PHASES.DOWNLOADING]: 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700',
    [PHASES.READY]:       'bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-700',
    [PHASES.INSTALLING]:  'bg-purple-50 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700',
    [PHASES.ERROR]:       'bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700',
  }[phase] || 'bg-gray-50 border-gray-200'

  return (
    <div className={clsx(
      'w-full border-b px-4 py-2.5 flex items-center gap-3 transition-all',
      barColor
    )}>

      {/* ── CHECKING ── */}
      {phase === PHASES.CHECKING && (
        <>
          <Loader size={15} className="text-gray-400 animate-spin flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-gray-300">Checking for updates…</span>
        </>
      )}

      {/* ── AVAILABLE ── */}
      {phase === PHASES.AVAILABLE && (
        <>
          <Download size={15} className="text-teal-600 dark:text-teal-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-teal-800 dark:text-teal-300">
              SentinelNMS v{info.version} is available
            </span>
            <span className="text-xs text-teal-600 dark:text-teal-400 ml-2">
              {info.releaseDate ? `Released ${new Date(info.releaseDate).toLocaleDateString()}` : ''}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {(isWindows || isMac) ? (
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              >
                <Download size={12} /> Download &amp; Update
              </button>
            ) : (
              <button
                onClick={handleOpenGitHub}
                className="flex items-center gap-1.5 bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              >
                <ExternalLink size={12} /> View Release
              </button>
            )}
            <button
              onClick={() => setDismiss(true)}
              className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10"
              title="Remind me later"
            >
              <X size={13} className="text-teal-600 dark:text-teal-400" />
            </button>
          </div>
        </>
      )}

      {/* ── DOWNLOADING ── */}
      {phase === PHASES.DOWNLOADING && (
        <>
          <RefreshCw size={15} className="text-blue-500 animate-spin flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-blue-800 dark:text-blue-300">
                Downloading v{info.version}… {progress}%
              </span>
              {speed > 0 && (
                <span className="text-xs text-blue-500 font-mono">
                  {(speed / 1024 / 1024).toFixed(1)} MB/s
                </span>
              )}
            </div>
            <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </>
      )}

      {/* ── READY TO INSTALL ── */}
      {phase === PHASES.READY && (
        <>
          <CheckCircle size={15} className="text-green-600 dark:text-green-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-green-800 dark:text-green-300">
              v{info.version} downloaded and ready to install
            </span>
            <span className="text-xs text-green-600 dark:text-green-400 ml-2">
              {isWindows
                ? 'The app will restart automatically after install'
                : 'The app will restart to apply the update'}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleInstall}
              className="flex items-center gap-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-4 py-1.5 rounded-lg transition-colors animate-pulse"
            >
              <RefreshCw size={12} /> Restart &amp; Install
            </button>
            <button
              onClick={() => setPhase(PHASES.IDLE)}
              className="text-xs text-green-600 dark:text-green-400 hover:underline"
              title="Install on next quit"
            >
              Later
            </button>
          </div>
        </>
      )}

      {/* ── INSTALLING ── */}
      {phase === PHASES.INSTALLING && (
        <>
          <Loader size={15} className="text-purple-500 animate-spin flex-shrink-0" />
          <span className="text-sm font-semibold text-purple-800 dark:text-purple-300">
            Installing update… The app will restart automatically.
          </span>
          <span className="text-xs text-purple-500 ml-2">Stopping backend services…</span>
        </>
      )}

      {/* ── ERROR ── */}
      {phase === PHASES.ERROR && (
        <>
          <AlertTriangle size={15} className="text-red-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-red-800 dark:text-red-300">Update failed: </span>
            <span className="text-xs text-red-600 dark:text-red-400 truncate">{error}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleOpenGitHub}
              className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400 underline"
            >
              <ExternalLink size={11} /> Download manually
            </button>
            <button onClick={() => setPhase(PHASES.IDLE)} className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10">
              <X size={13} className="text-red-400" />
            </button>
          </div>
        </>
      )}
    </div>
  )
}
