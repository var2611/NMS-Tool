import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import api from '../utils/api'
import toast from 'react-hot-toast'
import SentinelLogo from '../components/SentinelLogo'

export default function Login() {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { setAuth } = useStore()
  const navigate = useNavigate()

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await api.post('/auth/login', { username, password })
      setAuth(res.data.access_token, { username: res.data.username, role: res.data.role })
      navigate('/')
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Invalid username or password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-navy-900 to-teal-700">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <SentinelLogo size={64} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">
            Sentinel<span className="text-teal-600">NMS</span>
          </h1>
          <p className="text-gray-500 text-sm mt-1">Nav Wireless Technologies</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="label">Username</label>
            <input type="text" className="input" value={username}
              onChange={e => setUsername(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label">Password</label>
            <input type="password" className="input" value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Default: admin" />
          </div>
          <button type="submit" disabled={loading}
            className="btn-primary w-full justify-center flex items-center gap-2 py-2.5">
            {loading ? (
              <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Signing in...</>
            ) : 'Sign In'}
          </button>
        </form>

        <p className="text-xs text-center text-gray-400 mt-6">
          Default credentials: admin / admin<br />Change password in Settings after first login
        </p>
      </div>
    </div>
  )
}
