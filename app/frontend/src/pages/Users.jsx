import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usersApi, settingsApi } from '../utils/api'
import { useStore } from '../store'
import { formatTs } from '../utils/timezone'
import {
  Users as UsersIcon, Plus, Trash2, Edit2, KeyRound, X,
  Shield, ShieldCheck, Eye, CheckCircle, XCircle
} from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const ROLE_BADGE = {
  admin:    { label: 'Admin',    cls: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400', icon: ShieldCheck },
  operator: { label: 'Operator', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',         icon: Shield },
  viewer:   { label: 'Viewer',   cls: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',            icon: Eye },
}

// ─── User add/edit modal ──────────────────────────────────────────────────────
function UserModal({ initial, sites, onClose, onSaved }) {
  const isEdit = !!initial?.id
  const [form, setForm] = useState(initial || {
    username: '', password: '', full_name: '', email: '',
    role: 'viewer', allowed_sites: [],
  })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const toggleSite = (site) => {
    setForm(f => ({
      ...f,
      allowed_sites: f.allowed_sites?.includes(site)
        ? f.allowed_sites.filter(s => s !== site)
        : [...(f.allowed_sites || []), site],
    }))
  }

  const submit = async () => {
    if (!isEdit && (!form.username || !form.password))
      return toast.error('Username and password are required')
    setSaving(true)
    try {
      if (isEdit) {
        await usersApi.update(form.id, {
          full_name: form.full_name, email: form.email,
          role: form.role, allowed_sites: form.allowed_sites,
        })
        toast.success('User updated')
      } else {
        await usersApi.create(form)
        toast.success(`User "${form.username}" created`)
      }
      onSaved()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {isEdit ? `Edit ${form.username}` : 'New User'}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
            <X size={18} className="text-gray-500" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {!isEdit && (
            <>
              <div>
                <label className="label">Username <span className="text-red-400">*</span></label>
                <input className="input" value={form.username}
                  onChange={e => set('username', e.target.value)} placeholder="jdoe" />
              </div>
              <div>
                <label className="label">Password <span className="text-red-400">*</span></label>
                <input className="input" type="password" value={form.password}
                  onChange={e => set('password', e.target.value)} placeholder="min 4 characters" />
              </div>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Full name</label>
              <input className="input" value={form.full_name || ''}
                onChange={e => set('full_name', e.target.value)} placeholder="John Doe" /></div>
            <div><label className="label">Email</label>
              <input className="input" value={form.email || ''}
                onChange={e => set('email', e.target.value)} placeholder="jdoe@co.com" /></div>
          </div>

          <div>
            <label className="label">Role</label>
            <select className="input" value={form.role} onChange={e => set('role', e.target.value)}>
              <option value="admin">Admin — full access, manages users</option>
              <option value="operator">Operator — edit assigned sites</option>
              <option value="viewer">Viewer — read-only on assigned sites</option>
            </select>
          </div>

          {/* Site assignment — only for non-admins */}
          {form.role !== 'admin' && (
            <div>
              <label className="label">
                Allowed sites
                <span className="text-xs text-gray-400 font-normal ml-2">which synced sites this user can see</span>
              </label>
              {sites.length === 0 ? (
                <p className="text-xs text-gray-400 italic py-2">
                  No synced sites yet. Local (non-synced) devices are visible to everyone.
                </p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-2">
                  {sites.map(site => (
                    <label key={site} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
                      <input type="checkbox"
                        checked={form.allowed_sites?.includes(site)}
                        onChange={() => toggleSite(site)}
                        className="rounded text-teal-600" />
                      <span className="text-sm text-gray-700 dark:text-gray-300">{site}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {form.role === 'admin' && (
            <p className="text-xs text-purple-500 bg-purple-50 dark:bg-purple-900/20 rounded p-2">
              Admins automatically have access to all sites and all devices.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-gray-100 dark:border-gray-700">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={submit} disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : (isEdit ? 'Update User' : 'Create User')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Reset password modal ─────────────────────────────────────────────────────
function ResetPwModal({ user, onClose }) {
  const [pw, setPw] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    if (pw.length < 4) return toast.error('Min 4 characters')
    setSaving(true)
    try {
      await usersApi.resetPassword(user.id, pw)
      toast.success(`Password reset for ${user.username}`)
      onClose()
    } catch (e) { toast.error(e.response?.data?.detail || 'Reset failed') }
    finally { setSaving(false) }
  }
  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Reset Password</h3>
        <p className="text-sm text-gray-500 mb-4">for user <strong>{user.username}</strong></p>
        <input className="input" type="password" value={pw} autoFocus
          onChange={e => setPw(e.target.value)} placeholder="New password (min 4 chars)" />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={submit} disabled={saving} className="btn-primary">
            {saving ? 'Resetting…' : 'Reset Password'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Users() {
  const navigate = useNavigate()
  const { user: currentUser, timezone } = useStore()
  const [users, setUsers] = useState([])
  const [sites, setSites] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editUser, setEditUser] = useState(null)
  const [resetUser, setResetUser] = useState(null)

  // Guard — non-admins shouldn't be here
  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') {
      toast.error('Admin access required')
      navigate('/')
    }
  }, [currentUser])

  const load = async () => {
    try {
      const [u, s] = await Promise.all([
        usersApi.list(),
        settingsApi.syncSites().catch(() => ({ data: [] })),
      ])
      setUsers(u.data)
      setSites((s.data || []).map(site => site.site_name))
    } catch (e) {
      toast.error('Could not load users')
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const remove = async (u) => {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return
    try {
      await usersApi.delete(u.id)
      toast.success('User deleted')
      load()
    } catch (e) { toast.error(e.response?.data?.detail || 'Delete failed') }
  }

  const toggleActive = async (u) => {
    try {
      await usersApi.update(u.id, { is_active: !u.is_active })
      load()
    } catch { toast.error('Update failed') }
  }

  if (loading) return (
    <div className="flex justify-center pt-16">
      <div className="w-8 h-8 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">User Management</h1>
          <p className="text-gray-500 text-sm mt-1">
            Create users, assign roles, and control which sites each user can access
          </p>
        </div>
        <button onClick={() => { setEditUser(null); setShowModal(true) }}
          className="btn-primary flex items-center gap-2">
          <Plus size={15} /> New User
        </button>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-xs text-gray-400 uppercase tracking-wide">
                <th className="px-5 py-3">User</th>
                <th className="px-5 py-3">Role</th>
                <th className="px-5 py-3">Sites</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Last login</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const role = ROLE_BADGE[u.role] || ROLE_BADGE.viewer
                const RoleIcon = role.icon
                return (
                  <tr key={u.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-5 py-3">
                      <p className="font-medium text-gray-900 dark:text-gray-100">
                        {u.full_name || u.username}
                        {u.id === currentUser?.id && (
                          <span className="ml-2 text-xs text-teal-600">(you)</span>
                        )}
                      </p>
                      <p className="text-xs text-gray-400">@{u.username}{u.email ? ` · ${u.email}` : ''}</p>
                    </td>
                    <td className="px-5 py-3">
                      <span className={clsx('inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full', role.cls)}>
                        <RoleIcon size={11} /> {role.label}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-500 dark:text-gray-400 text-xs">
                      {u.role === 'admin'
                        ? <span className="italic">All sites</span>
                        : (u.allowed_sites?.length
                            ? u.allowed_sites.join(', ')
                            : <span className="text-gray-400">Local only</span>)}
                    </td>
                    <td className="px-5 py-3">
                      <button onClick={() => toggleActive(u)}
                        className={clsx('inline-flex items-center gap-1 text-xs',
                          u.is_active ? 'text-green-600' : 'text-gray-400')}>
                        {u.is_active ? <CheckCircle size={13} /> : <XCircle size={13} />}
                        {u.is_active ? 'Active' : 'Disabled'}
                      </button>
                    </td>
                    <td className="px-5 py-3 text-gray-400 text-xs">
                      {u.last_login ? formatTs(u.last_login, timezone, 'short') : 'Never'}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => { setEditUser(u); setShowModal(true) }}
                          title="Edit" className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
                          <Edit2 size={13} className="text-gray-400" />
                        </button>
                        <button onClick={() => setResetUser(u)}
                          title="Reset password" className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
                          <KeyRound size={13} className="text-amber-500" />
                        </button>
                        <button onClick={() => remove(u)}
                          title="Delete" disabled={u.id === currentUser?.id}
                          className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-30">
                          <Trash2 size={13} className="text-red-400" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Role legend */}
      <div className="card p-4 text-xs text-gray-500 dark:text-gray-400">
        <p className="font-medium text-gray-700 dark:text-gray-300 mb-2">Role permissions</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div><strong className="text-purple-600">Admin</strong> — full control: manage users, all devices, all sites, settings</div>
          <div><strong className="text-blue-600">Operator</strong> — add/edit/poll devices on assigned sites</div>
          <div><strong className="text-gray-600 dark:text-gray-300">Viewer</strong> — read-only access to assigned sites</div>
        </div>
      </div>

      {showModal && (
        <UserModal
          initial={editUser}
          sites={sites}
          onClose={() => { setShowModal(false); setEditUser(null) }}
          onSaved={() => { setShowModal(false); setEditUser(null); load() }}
        />
      )}
      {resetUser && (
        <ResetPwModal user={resetUser} onClose={() => setResetUser(null)} />
      )}
    </div>
  )
}
