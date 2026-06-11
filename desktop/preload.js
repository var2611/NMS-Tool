const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion:    () => ipcRenderer.invoke('get-app-version'),
  getUserDataPath:  () => ipcRenderer.invoke('get-user-data-path'),
  isElectron:       true,

  // ── Auto-launch at system startup ─────────────────────────────────────────
  getAutoLaunch:    () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch:    (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),

  // ── Auto-updater ──────────────────────────────────────────────────────────
  startDownload:      () => ipcRenderer.invoke('start-update-download'),
  installNow:         () => ipcRenderer.invoke('install-update-now'),
  checkNow:           () => ipcRenderer.invoke('check-for-updates-now'),
  openReleasesPage:   () => ipcRenderer.invoke('open-releases-page'),
  platform:           process.platform,   // 'win32' | 'darwin' | 'linux'

  onUpdateAvailable:    (cb) => ipcRenderer.on('update-available',         (_e, i) => cb(i)),
  onDownloadProgress:   (cb) => ipcRenderer.on('update-download-progress', (_e, i) => cb(i)),
  onUpdateDownloaded:   (cb) => ipcRenderer.on('update-downloaded',        (_e, i) => cb(i)),
  onUpdateError:        (cb) => ipcRenderer.on('update-error',             (_e, i) => cb(i)),
  onUpdateInstalling:   (cb) => ipcRenderer.on('update-installing',        ()       => cb()),
  removeUpdateListeners: () => {
    ['update-available','update-download-progress','update-downloaded',
     'update-error','update-installing'].forEach(ch => ipcRenderer.removeAllListeners(ch))
  },
})
