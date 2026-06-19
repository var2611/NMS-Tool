// Shim window.electronAPI using global Tauri API
(function() {
  const tauri = window.__TAURI__;
  if (!tauri) {
    console.error("Tauri global API not found. Please enable withGlobalTauri in tauri.conf.json");
    return;
  }

  const invoke = tauri.core.invoke;
  const listen = tauri.event.listen;

  // Track event listener cleanup functions
  const unlisteners = {};

  window.electronAPI = {
    getAppVersion:    () => invoke('get_app_version'),
    getUserDataPath:  () => invoke('get_user_data_path'),
    isElectron:       true, // Keep as true so React app believes it is running in desktop wrapper

    // ── Auto-launch at system startup ─────────────────────────────────────────
    getAutoLaunch:    () => invoke('get_auto_launch'),
    setAutoLaunch:    (enabled) => invoke('set_auto_launch', { enabled }),

    // ── Auto-updater ──────────────────────────────────────────────────────────
    startDownload:      () => invoke('start_update_download'),
    installNow:         () => invoke('install_update_now'),
    checkNow:           () => invoke('check_for_updates_now'),
    openReleasesPage:   () => invoke('open_releases_page'),
    platform:           navigator.userAgent.includes("Windows") ? "win32" : (navigator.userAgent.includes("Mac") ? "darwin" : "linux"),

    onUpdateAvailable:    async (cb) => {
      unlisteners['update-available'] = await listen('update-available', (event) => cb(event.payload));
    },
    onDownloadProgress:   async (cb) => {
      unlisteners['update-download-progress'] = await listen('update-download-progress', (event) => cb(event.payload));
    },
    onUpdateDownloaded:   async (cb) => {
      unlisteners['update-downloaded'] = await listen('update-downloaded', (event) => cb(event.payload));
    },
    onUpdateError:        async (cb) => {
      unlisteners['update-error'] = await listen('update-error', (event) => cb(event.payload));
    },
    onUpdateInstalling:   async (cb) => {
      unlisteners['update-installing'] = await listen('update-installing', () => cb());
    },
    removeUpdateListeners: () => {
      Object.keys(unlisteners).forEach(ch => {
        if (typeof unlisteners[ch] === 'function') {
          unlisteners[ch]();
        }
        delete unlisteners[ch];
      });
    },
  };
})();
