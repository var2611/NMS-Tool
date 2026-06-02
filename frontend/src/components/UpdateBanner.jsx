import { useEffect, useState } from 'react'
import { Download, RefreshCw, X, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'

/**
 * UpdateBanner — shown inside the Electron desktop app when a new version is available.
 * Communicates with main.js via window.electronAPI (preload bridge).
 * In the web version (no electronAPI) this component renders nothing.
 */
export default function UpdateBanner() {
  const api = window.electronAPI

  const [state, setState] = useState(null)
  // state shape:
  //   { phase: 'available', version, releaseDate }
  //   { phase: 'downloading', percent, bytesPerSecond }
  //   { phase: 'ready', version }
  //   { phase: 'error', message }

  useEffect(() => {
    // Only wire up in Electron
    if (!api?.onUpdateAvailable) return

    api.onUpdateAvailable(info => {
      setState({ phase: 'available', version: info.version, releaseDate: info.releaseDate })
    })
    api.onDownloadProgress(info => {
      setState(s => ({ ...s, phase: 'downloading', percent: Math.round(info.percent), bytesPerSecond: info.bytesPerSecond }))
    })
    api.onUpdateDownloaded(info => {
      setState({ phase: 'ready', version: info.version })
    })
    api.onUpdateError(info => {
      setState({ phase: 'error', message: info.message })
    })

    return () => api.removeUpdateListeners?.()
  }, [])

  if (!state) return null

  return (
    <div className={clsx(
      'fixed bottom-4 right-4 z-50 max-w-sm rounded-xl shadow-2xl border p-4',
      'bg-white dark:bg-navy-800',
      state.phase === 'error'
        ? 'border-red-200 dark:border-red-800'
        : 'border-teal-200 dark:border-teal-700'
    )}>
      {/* Close button (only dismisses the banner, not the update) */}
      <button
        onClick={() => setState(null)}
        className="absolute top-3 right-3 p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        <X size={14} className="text-gray-400" />
      </button>

      {/* ── Update available ── */}
      {state.phase === 'available' && (
        <>
          <div className="flex items-start gap-3 pr-4">
            <div className="w-8 h-8 rounded-full bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center flex-shrink-0">
              <Download size={16} className="text-teal-600 dark:text-teal-400" />
            </div>
            <div>
              <p className="font-semibold text-sm text-gray-900 dark:text-white">
                Update available — v{state.version}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                A new version of SentinelNMS is ready to download.
              </p>
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button
              onClick={async () => {
                setState(s => ({ ...s, phase: 'downloading', percent: 0 }))
                await api.startDownload()
              }}
              className="flex-1 btn-primary text-xs py-2 flex items-center justify-center gap-1.5"
            >
              <Download size={13} /> Download update
            </button>
            <button onClick={() => setState(null)} className="btn-secondary text-xs py-2 px-3">
              Later
            </button>
          </div>
        </>
      )}

      {/* ── Downloading ── */}
      {state.phase === 'downloading' && (
        <>
          <div className="flex items-center gap-3 pr-4">
            <RefreshCw size={16} className="text-teal-500 animate-spin flex-shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-sm text-gray-900 dark:text-white">
                Downloading update… {state.percent ?? 0}%
              </p>
              {state.bytesPerSecond && (
                <p className="text-xs text-gray-400">
                  {(state.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
            <div
              className="bg-teal-500 h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${state.percent ?? 0}%` }}
            />
          </div>
        </>
      )}

      {/* ── Ready to install ── */}
      {state.phase === 'ready' && (
        <>
          <div className="flex items-start gap-3 pr-4">
            <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center flex-shrink-0">
              <RefreshCw size={16} className="text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="font-semibold text-sm text-gray-900 dark:text-white">
                v{state.version} ready to install
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Restart the app to apply the update.
              </p>
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => api.installNow()}
              className="flex-1 btn-primary text-xs py-2 flex items-center justify-center gap-1.5"
            >
              <RefreshCw size={13} /> Restart &amp; Update
            </button>
            <button onClick={() => setState(null)} className="btn-secondary text-xs py-2 px-3">
              Later
            </button>
          </div>
        </>
      )}

      {/* ── Error ── */}
      {state.phase === 'error' && (
        <div className="flex items-start gap-3 pr-4">
          <AlertTriangle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-sm text-gray-900 dark:text-white">Update failed</p>
            <p className="text-xs text-red-500 mt-0.5 break-words">{state.message}</p>
          </div>
        </div>
      )}
    </div>
  )
}
