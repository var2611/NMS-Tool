import { useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import UpdateBanner from './UpdateBanner'
import {
  LayoutDashboard, Monitor, Radar, Bell, AlertTriangle,
  FileCode, BarChart3, Settings, Wifi, WifiOff,
  Sun, Moon, Menu, Zap, Users as UsersIcon, LogOut,
  ShieldAlert, ShieldCheck
} from 'lucide-react'
import clsx from 'clsx'
import SentinelLogo from './SentinelLogo'
import api from '../utils/api'
import toast from 'react-hot-toast'

const NAV = [
  { to: '/',          icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/devices',   icon: Monitor,         label: 'Devices' },
  { to: '/discovery', icon: Radar,           label: 'Auto-Discover' },
  { to: '/traps',     icon: Zap,             label: 'SNMP Traps' },
  { to: '/alerts',    icon: AlertTriangle,   label: 'Alerts' },
  { to: '/mibs',      icon: FileCode,        label: 'MIB Manager' },
  { to: '/reports',   icon: BarChart3,       label: 'Reports' },
  { to: '/users',     icon: UsersIcon,       label: 'Users', adminOnly: true, hideOnDesktop: true },
  { to: '/settings',  icon: Settings,        label: 'Settings' },
]

export default function Layout({ children }) {
  const {
    sidebarOpen, toggleSidebar, toggleTheme, theme, wsConnected, alertSummary,
    user, logout, appMode, advanceFeaturesEnabled, setAdvanceFeaturesEnabled
  } = useStore()
  
  const [showUnlockModal, setShowUnlockModal] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [loadingUnlock, setLoadingUnlock] = useState(false)

  const location = useLocation()
  const navigate = useNavigate()

  const handleToggleAdvance = () => {
    if (advanceFeaturesEnabled) {
      setAdvanceFeaturesEnabled(false)
      toast.success('Admin features locked.')
    } else {
      if (!location.pathname.startsWith('/devices')) {
        navigate('/devices')
        setTimeout(() => {
          setShowUnlockModal(true)
        }, 300)
      } else {
        setShowUnlockModal(true)
      }
    }
  }

  const handleUnlockSubmit = async (e) => {
    e.preventDefault()
    if (!passwordInput) {
      setErrorMsg('Password is required')
      return
    }
    setLoadingUnlock(true)
    try {
      await api.post('/auth/verify-admin-password', { password: passwordInput })
      setAdvanceFeaturesEnabled(true)
      setShowUnlockModal(false)
      setPasswordInput('')
      toast.success('Admin features unlocked!')
    } catch (err) {
      setErrorMsg(err.response?.data?.detail || 'Incorrect password')
    } finally {
      setLoadingUnlock(false)
    }
  }

  const isAdmin = user?.role === 'admin'
  const isDesktop = appMode === 'desktop'
  const isViewer = user?.role === 'viewer' || (isDesktop && !advanceFeaturesEnabled)
  const visibleNav = NAV.filter(item => {
    if (isViewer) {
      return item.to === '/' || item.to === '/devices'
    }
    return (!item.adminOnly || isAdmin) && (!item.hideOnDesktop || !isDesktop)
  })

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950">
      {/* Sidebar */}
      <aside className={clsx(
        'flex flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 transition-all duration-200 flex-shrink-0',
        sidebarOpen ? 'w-60' : 'w-16'
      )}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 h-16 border-b border-gray-200 dark:border-gray-700">
          {sidebarOpen ? (
            <SentinelLogo size={36} showText />
          ) : (
            <SentinelLogo size={32} />
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 px-2 space-y-0.5 overflow-y-auto">
          {visibleNav.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} end={to === '/'}
              className={({ isActive }) => clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all',
                isActive
                  ? 'bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100'
              )}
            >
              <Icon size={18} className="flex-shrink-0" />
              {sidebarOpen && <span>{label}</span>}
              {/* Alert badge */}
              {sidebarOpen && label === 'Alerts' && alertSummary.unacknowledged > 0 && (
                <span className="ml-auto bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
                  {alertSummary.unacknowledged > 99 ? '99+' : alertSummary.unacknowledged}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-gray-200 dark:border-gray-700 space-y-1">
          {/* WS status */}
          <div className={clsx(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-xs',
            wsConnected ? 'text-green-600 bg-green-50 dark:bg-green-900/20' : 'text-red-500 bg-red-50 dark:bg-red-900/20'
          )}>
            {wsConnected ? <Wifi size={14} /> : <WifiOff size={14} />}
            {sidebarOpen && (wsConnected ? 'Live connected' : 'Reconnecting...')}
          </div>
          {isDesktop && (
            <button onClick={handleToggleAdvance}
              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
              {advanceFeaturesEnabled ? <ShieldCheck size={16} className="text-green-500" /> : <ShieldAlert size={16} className="text-amber-500" />}
              {sidebarOpen && (advanceFeaturesEnabled ? 'Lock Admin Features' : 'Unlock Admin Features')}
            </button>
          )}
          <button onClick={toggleTheme}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            {sidebarOpen && (theme === 'dark' ? 'Light mode' : 'Dark mode')}
          </button>

          {/* Current user + logout */}
          {user && (
            <button onClick={logout}
              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 transition-colors">
              <LogOut size={16} />
              {sidebarOpen && (
                <span className="flex-1 text-left truncate">
                  {user.full_name || user.username}
                  <span className="block text-xs text-gray-400 capitalize">{user.role} · log out</span>
                </span>
              )}
            </button>
          )}
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-16 flex items-center justify-between px-6 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <button onClick={toggleSidebar} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <Menu size={20} className="text-gray-500" />
          </button>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            </span>
          </div>
        </header>

        {/* Update banner — shown only in desktop Electron app */}
        <UpdateBanner />

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>

      {showUnlockModal && createPortal(
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100000]" style={{ transform: 'translate3d(0,0,0)', backfaceVisibility: 'hidden' }}>
          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl max-w-sm w-full border border-gray-200 dark:border-gray-700 shadow-xl space-y-4">
            <div>
              <h3 className="text-lg font-bold text-gray-950 dark:text-white flex items-center gap-2">
                <ShieldAlert className="text-amber-500" size={20} />
                Unlock Admin Features
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Enter the administrator password to enable advanced monitoring controls and view IP addresses.
              </p>
            </div>
            
            <form onSubmit={handleUnlockSubmit} className="space-y-4">
              <div>
                <label className="label">Admin Password</label>
                <input
                  type="password"
                  className="input w-full"
                  placeholder="Enter password..."
                  value={passwordInput}
                  onChange={e => {
                    setPasswordInput(e.target.value)
                    setErrorMsg('')
                  }}
                  autoFocus
                />
                {errorMsg && <p className="text-xs text-red-500 mt-1">{errorMsg}</p>}
              </div>

              <div className="flex justify-end gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => {
                    setShowUnlockModal(false)
                    setPasswordInput('')
                    setErrorMsg('')
                  }}
                  className="btn-secondary py-1.5 px-3"
                  disabled={loadingUnlock}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary py-1.5 px-3 flex items-center gap-2"
                  disabled={loadingUnlock}
                >
                  {loadingUnlock ? 'Verifying...' : 'Unlock'}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
