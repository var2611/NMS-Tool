import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { useEffect, Component } from 'react'
import { useStore } from './store'

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace', background: '#1e1e2e', color: '#cdd6f4', minHeight: '100vh' }}>
          <h2 style={{ color: '#f38ba8', marginBottom: 16 }}>⚠️ SentinelNMS Render Error</h2>
          <pre style={{ background: '#181825', padding: 20, borderRadius: 8, overflow: 'auto', fontSize: 13 }}>
            {this.state.error.toString()}{'\n\n'}{this.state.error.stack}
          </pre>
          <button onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: '8px 20px', background: '#89b4fa', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
import { useWebSocket } from './hooks/useWebSocket'
import { settingsApi } from './utils/api'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Devices from './pages/Devices'
import DeviceDetail from './pages/DeviceDetail'
import Discovery from './pages/Discovery'
import Traps from './pages/Traps'
import Alerts from './pages/Alerts'
import MIBs from './pages/MIBs'
import Reports from './pages/Reports'
import SettingsPage from './pages/Settings'
import Users from './pages/Users'
import Login from './pages/Login'

function AppInner() {
  useWebSocket()
  const { theme, appMode, setAppMode, user, advanceFeaturesEnabled } = useStore()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    settingsApi.get().then(r => setAppMode(r.data.app?.mode)).catch(() => {})
  }, [])

  const isDesktop = appMode === 'desktop'
  const isViewer = user?.role === 'viewer' || (isDesktop && !advanceFeaturesEnabled)

  return (
    <Layout>
      {isViewer ? (
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/devices/:id" element={<DeviceDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      ) : (
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/devices/:id" element={<DeviceDetail />} />
          <Route path="/discovery" element={<Discovery />} />
          <Route path="/traps" element={<Traps />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/mibs" element={<MIBs />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<SettingsPage />} />
          {!isDesktop && <Route path="/users" element={<Users />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </Layout>
  )
}

function ProtectedRoute({ children }) {
  const { token } = useStore()
  if (!token) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-right" toastOptions={{ duration: 4000 }} />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={
          <ProtectedRoute>
            <ErrorBoundary><AppInner /></ErrorBoundary>
          </ProtectedRoute>
        } />
      </Routes>
    </BrowserRouter>
  )
}
