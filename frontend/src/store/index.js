import { create } from 'zustand'

export const useStore = create((set, get) => ({
  // Auth
  token: localStorage.getItem('nms_token'),
  user: null,
  setAuth: (token, user) => {
    localStorage.setItem('nms_token', token)
    set({ token, user })
  },
  logout: () => {
    localStorage.removeItem('nms_token')
    set({ token: null, user: null })
  },

  // Devices
  devices: [],
  deviceSummary: { total: 0, online: 0, offline: 0, warning: 0, health_score: 0, by_type: {} },
  setDevices: (devices) => set({ devices }),
  setDeviceSummary: (s) => set({ deviceSummary: s }),
  updateDeviceStatus: (deviceId, status, metrics) => set(state => ({
    devices: state.devices.map(d =>
      d.id === deviceId ? { ...d, status, ...metrics } : d
    )
  })),

  // Alerts
  alerts: [],
  alertSummary: { last_24h: 0, critical_24h: 0, unacknowledged: 0 },
  setAlerts: (alerts) => set({ alerts }),
  setAlertSummary: (s) => set({ alertSummary: s }),
  addAlert: (alert) => set(state => ({ alerts: [alert, ...state.alerts].slice(0, 200) })),

  // Traps
  recentTraps: [],
  addTrap: (trap) => set(state => ({ recentTraps: [trap, ...state.recentTraps].slice(0, 100) })),

  // WebSocket
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),

  // UI
  theme: localStorage.getItem('nms_theme') || 'light',
  toggleTheme: () => set(state => {
    const next = state.theme === 'light' ? 'dark' : 'light'
    localStorage.setItem('nms_theme', next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    return { theme: next }
  }),

  // Timezone (frontend display only — DB stores everything as UTC)
  timezone: localStorage.getItem('nms_timezone') || 'UTC',
  setTimezone: (tz) => {
    localStorage.setItem('nms_timezone', tz)
    set({ timezone: tz })
  },

  sidebarOpen: true,
  toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),

  // Active scan
  activeScan: null,
  setActiveScan: (scan) => set({ activeScan: scan }),
}))
