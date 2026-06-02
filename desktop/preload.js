const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion:    () => ipcRenderer.invoke('get-app-version'),
  getUserDataPath:  () => ipcRenderer.invoke('get-user-data-path'),
  isElectron:       true,

  // ── Auto-updater ──────────────────────────────────────────────────────────
  startDownload:    () => ipcRenderer.invoke('start-update-download'),
  installNow:       () => ipcRenderer.invoke('install-update-now'),

  onUpdateAvailable:     (cb) => ipcRenderer.on('update-available',         (_e, info) => cb(info)),
  onDownloadProgress:    (cb) => ipcRenderer.on('update-download-progress', (_e, info) => cb(info)),
  onUpdateDownloaded:    (cb) => ipcRenderer.on('update-downloaded',        (_e, info) => cb(info)),
  onUpdateError:         (cb) => ipcRenderer.on('update-error',             (_e, info) => cb(info)),
  removeUpdateListeners: () => {
    ipcRenderer.removeAllListeners('update-available')
    ipcRenderer.removeAllListeners('update-download-progress')
    ipcRenderer.removeAllListeners('update-downloaded')
    ipcRenderer.removeAllListeners('update-error')
  },
})
