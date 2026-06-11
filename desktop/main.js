const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron')
const { spawn, exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const os = require('os')
const { autoUpdater } = require('electron-updater')

// ─── Config ───────────────────────────────────────────────────────────────────

const API_PORT = 8765
const BACKEND_STARTUP_TIMEOUT = 30000  // 30s to wait for backend

let mainWindow = null
let tray = null
let backendProcess = null
let backendReady = false

// ─── Paths ────────────────────────────────────────────────────────────────────

function getResourcePath(...parts) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...parts)
  }
  return path.join(__dirname, '..', ...parts)
}

/**
 * Returns the backend executable path.
 *
 * Packaged:    Resources/nms-backend/nms-backend(.exe)  ← PyInstaller binary
 * Development: venv/bin/python (or venv/Scripts/python.exe on Windows)
 *              falls back to system python3 if no venv found
 */
function getBackendExe() {
  if (app.isPackaged) {
    const name = process.platform === 'win32' ? 'nms-backend.exe' : 'nms-backend'
    return path.join(process.resourcesPath, 'nms-backend', name)
  }
  // Dev mode: use local venv
  const venvPaths = [
    path.join(__dirname, '..', 'venv', 'bin', 'python'),
    path.join(__dirname, '..', 'venv', 'Scripts', 'python.exe'),
  ]
  for (const p of venvPaths) {
    if (fs.existsSync(p)) return p
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

// ─── Backend ──────────────────────────────────────────────────────────────────

function startBackend() {
  const exe = getBackendExe()
  const userData = app.getPath('userData')

  // Ensure writable data directories exist in userData
  fs.mkdirSync(path.join(userData, 'data', 'mibs'), { recursive: true })

  // .env lives in userData so the user can edit it
  const envFile = path.join(userData, '.env')
  if (!fs.existsSync(envFile)) {
    const envExample = getResourcePath('.env.example')
    if (fs.existsSync(envExample)) {
      fs.copyFileSync(envExample, envFile)
    }
  }

  const env = {
    ...process.env,
    APP_MODE: 'desktop',
    API_HOST: '127.0.0.1',
    API_PORT: String(API_PORT),
    SQLITE_DB_PATH: path.join(userData, 'nms.db'),
    LOG_FILE: path.join(userData, 'nms.log'),
  }

  let spawnArgs, cwd

  if (app.isPackaged) {
    // PyInstaller binary — call with args directly, no "python -m uvicorn"
    spawnArgs = [
      '--host', '127.0.0.1',
      '--port', String(API_PORT),
      '--log-level', 'warning',
    ]
    // cwd = userData so relative paths (./data/mibs, .env) resolve correctly
    cwd = userData
  } else {
    // Dev mode — python -m uvicorn via local venv
    spawnArgs = [
      '-m', 'uvicorn', 'api.main:app',
      '--host', '127.0.0.1',
      '--port', String(API_PORT),
      '--log-level', 'warning',
    ]
    cwd = path.join(__dirname, '..')
  }

  console.log(`Starting backend: ${exe} ${spawnArgs.join(' ')}`)

  backendProcess = spawn(exe, spawnArgs, {
    cwd,
    env,
    windowsHide: true,
  })

  backendProcess.stdout.on('data', (d) => console.log('[backend]', d.toString().trim()))
  backendProcess.stderr.on('data', (d) => console.error('[backend]', d.toString().trim()))

  backendProcess.on('exit', (code) => {
    console.log(`Backend exited with code ${code}`)
    backendReady = false
    if (mainWindow && !app.isQuitting) {
      mainWindow.webContents.loadURL(`data:text/html,
        <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#1e3a5f;color:white;margin:0}</style>
        <div style="text-align:center"><h2>Backend stopped (code ${code})</h2>
        <p>Check logs at: ${path.join(app.getPath('userData'), 'nms.log')}</p>
        <button onclick="location.reload()" style="padding:8px 20px;background:#14b8a6;border:none;color:white;border-radius:8px;cursor:pointer">Retry</button></div>
      `)
    }
  })
}

function waitForBackend(timeout = BACKEND_STARTUP_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (Date.now() - start > timeout) {
        reject(new Error('Backend startup timed out'))
        return
      }
      const req = http.get(`http://127.0.0.1:${API_PORT}/api/v1/ping`, (res) => {
        if (res.statusCode === 200) resolve()
        else setTimeout(check, 500)
      })
      req.on('error', () => setTimeout(check, 500))
      req.setTimeout(1000, () => { req.destroy(); setTimeout(check, 500) })
    }
    check()
  })
}

// ─── Auto-launch on system startup ───────────────────────────────────────────
// Windows/macOS go through the OS login-item APIs; Linux has no Electron API
// for this, so we manage a freedesktop autostart entry ourselves.

const AUTOSTART_ARG = '--autostart'

function linuxAutostartFile() {
  return path.join(os.homedir(), '.config', 'autostart', 'sentinelnms-desktop.desktop')
}

function getAutoLaunchEnabled() {
  if (process.platform === 'linux') {
    return fs.existsSync(linuxAutostartFile())
  }
  return app.getLoginItemSettings({ args: [AUTOSTART_ARG] }).openAtLogin
}

function setAutoLaunchEnabled(enabled) {
  try {
    if (process.platform === 'linux') {
      const file = linuxAutostartFile()
      if (enabled) {
        // AppImage exposes its own path via $APPIMAGE; .deb installs run the binary directly
        const exec = process.env.APPIMAGE || process.execPath
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, [
          '[Desktop Entry]',
          'Type=Application',
          'Name=SentinelNMS',
          'Comment=Network monitoring agent — Nav Wireless Technologies',
          `Exec="${exec}" ${AUTOSTART_ARG}`,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          '',
        ].join('\n'))
      } else {
        fs.rmSync(file, { force: true })
      }
    } else {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true,                      // macOS ≤12: launch without showing the window
        args: enabled ? [AUTOSTART_ARG] : [],    // Windows: lets us detect a login launch
      })
    }
    return { enabled: getAutoLaunchEnabled() }
  } catch (err) {
    console.error('[autostart] Failed to update:', err.message)
    return { enabled: getAutoLaunchEnabled(), error: err.message }
  }
}

function launchedAtSystemStartup() {
  if (process.argv.includes(AUTOSTART_ARG)) return true   // Windows + Linux
  if (process.platform === 'darwin') {
    try {
      const s = app.getLoginItemSettings()
      return Boolean(s.wasOpenedAtLogin || s.wasOpenedAsHidden)
    } catch { return false }
  }
  return false
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  // When the OS launched us at login, stay minimized in the tray — monitoring
  // and cloud sync run in the backend regardless of window visibility.
  const startHidden = launchedAtSystemStartup()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'SentinelNMS',
    backgroundColor: '#f9fafb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    // Custom titlebar on Windows
    ...(process.platform === 'win32' ? { titleBarStyle: 'default' } : { titleBarStyle: 'hiddenInset' }),
  })

  // Show loading screen
  mainWindow.loadURL(`data:text/html,
    <style>
      body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;
           background:linear-gradient(135deg,#0f2035,#0d9488);color:white;margin:0}
      .spinner{width:40px;height:40px;border:4px solid rgba(255,255,255,0.2);border-top-color:white;
               border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
      @keyframes spin{to{transform:rotate(360deg)}}
    </style>
    <div style="text-align:center">
      <div class="spinner"></div>
      <h2 style="margin:0 0 8px">SentinelNMS starting...</h2>
      <p style="margin:0;opacity:0.7;font-size:14px">Nav Wireless Technologies</p>
    </div>
  `)

  mainWindow.once('ready-to-show', () => { if (!startHidden) mainWindow.show() })

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  // Wait for backend then load app
  waitForBackend()
    .then(() => {
      backendReady = true
      mainWindow.loadURL(`http://127.0.0.1:${API_PORT}`)
    })
    .catch((err) => {
      dialog.showErrorBox('SentinelNMS startup failed',
        `Could not start the backend server.\n\n${err.message}\n\nCheck logs at:\n${path.join(app.getPath('userData'), 'nms.log')}`)
      app.quit()
    })
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png')
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('SentinelNMS')

  const menu = Menu.buildFromTemplate([
    { label: 'Open SentinelNMS', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { label: 'Open Dashboard', click: () => { mainWindow?.show(); mainWindow?.webContents.loadURL(`http://127.0.0.1:${API_PORT}`) } },
    { type: 'separator' },
    { label: 'Open Log File', click: () => {
      const { shell } = require('electron')
      shell.openPath(path.join(app.getPath('userData'), 'nms.log'))
    }},
    { label: 'Open Data Folder', click: () => {
      const { shell } = require('electron')
      shell.openPath(app.getPath('userData'))
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit() } },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus() })
}

// ─── App Events ───────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()
  createTray()
  startBackend()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms
})

app.on('before-quit', () => {
  app.isQuitting = true
  if (backendProcess) {
    console.log('Stopping backend...')
    backendProcess.kill('SIGTERM')
    // Force kill after 3s
    setTimeout(() => backendProcess?.kill('SIGKILL'), 3000)
  }
})

// ─── Auto-Updater ─────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  // Only run in packaged app — skip in dev mode
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false        // ask user before downloading
  autoUpdater.autoInstallOnAppQuit = true // install silently when user quits

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for update...')
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] Update available: v${info.version}`)
    // Notify the renderer so it can show a banner
    if (mainWindow) {
      mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes || '',
        releaseDate: info.releaseDate,
      })
    }
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] App is up to date')
  })

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent)
    console.log(`[updater] Downloading... ${pct}%`)
    if (mainWindow) {
      mainWindow.webContents.send('update-download-progress', { percent: pct, bytesPerSecond: progress.bytesPerSecond })
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] Update downloaded: v${info.version}`)
    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded', { version: info.version })
    }
  })

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message)
    if (mainWindow) {
      mainWindow.webContents.send('update-error', { message: err.message })
    }
  })

  // Check 10 seconds after app is ready (let backend start first)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.error('[updater] Check failed:', err.message)
    })
  }, 10_000)

  // Re-check every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 4 * 60 * 60 * 1000)
}

// IPC handlers
ipcMain.handle('get-app-version', () => app.getVersion())
ipcMain.handle('get-user-data-path', () => app.getPath('userData'))

// Auto-launch IPC
ipcMain.handle('get-auto-launch', () => ({ enabled: getAutoLaunchEnabled() }))
ipcMain.handle('set-auto-launch', (_e, enabled) => setAutoLaunchEnabled(Boolean(enabled)))

// Updater IPC
ipcMain.handle('start-update-download', async () => {
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('install-update-now', async () => {
  // 1. Tell the renderer we're about to restart (so it can show "Installing…")
  if (mainWindow) {
    mainWindow.webContents.send('update-installing')
  }

  // 2. Gracefully stop the Python backend before the installer takes over.
  //    Give it 4 seconds to shut down cleanly before we force-quit.
  if (backendProcess) {
    console.log('[updater] Stopping backend before update install...')
    backendProcess.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 4000))
    backendProcess?.kill('SIGKILL')
    backendProcess = null
  }

  // 3. Install silently (isSilent=true) and relaunch after install (isForceRunAfter=true).
  //    On Windows:  runs NSIS installer silently, then relaunches the new version.
  //    On macOS:    moves the new .app into place (requires signed + notarized build).
  app.isQuitting = true
  autoUpdater.quitAndInstall(true, true)
})

ipcMain.handle('open-releases-page', () => {
  const { shell } = require('electron')
  shell.openExternal('https://github.com/var2611/NMS-Tool/releases/latest')
})

function isNewerVersion(latest, current) {
  const a = String(latest).split('.').map(n => parseInt(n, 10) || 0)
  const b = String(current).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

ipcMain.handle('check-for-updates-now', async () => {
  if (!app.isPackaged) return { error: 'Updates only work in the installed app (dev mode)' }
  try {
    // The raw UpdateCheckResult holds a CancellationToken and can't cross the
    // IPC boundary — return a plain summary instead. The update-available /
    // download events still fire as usual and drive the top banner.
    const result = await autoUpdater.checkForUpdates()
    const current = app.getVersion()
    const latest = result?.updateInfo?.version || null
    return { current, latest, available: latest ? isNewerVersion(latest, current) : false }
  } catch (e) {
    return { error: e.message, current: app.getVersion() }
  }
})
