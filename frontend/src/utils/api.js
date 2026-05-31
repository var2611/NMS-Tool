import axios from 'axios'

const api = axios.create({ baseURL: '/api/v1', timeout: 30000 })

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('nms_token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('nms_token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api

// Convenience methods
export const devicesApi = {
  list: (params) => api.get('/devices', { params }),
  get: (id) => api.get(`/devices/${id}`),
  create: (data) => api.post('/devices', data),
  update: (id, data) => api.put(`/devices/${id}`, data),
  delete: (id) => api.delete(`/devices/${id}`),
  poll: (id) => api.post(`/devices/${id}/poll`),
  metrics: (id, hours=24) => api.get(`/devices/${id}/metrics`, { params: { hours } }),
  summary: () => api.get('/devices/summary'),
}

export const discoveryApi = {
  startScan: (data) => api.post('/discovery/scan', data),
  getScan: (id) => api.get(`/discovery/scan/${id}`),
  saveDevices: (scanId, ips) => api.post(`/discovery/scan/${scanId}/save`, ips),
}

export const trapsApi = {
  events: (params) => api.get('/traps/events', { params }),
  stats: () => api.get('/traps/events/stats'),
  rules: () => api.get('/traps/rules'),
  createRule: (data) => api.post('/traps/rules', data),
  updateRule: (id, data) => api.put(`/traps/rules/${id}`, data),
  toggleRule: (id) => api.patch(`/traps/rules/${id}/toggle`),
  deleteRule: (id) => api.delete(`/traps/rules/${id}`),
  sendTest: (data) => api.post('/traps/test', data),
  standardTypes: () => api.get('/traps/standard-types'),
}

export const alertsApi = {
  list: (params) => api.get('/alerts', { params }),
  summary: () => api.get('/alerts/summary'),
  acknowledge: (id, data) => api.post(`/alerts/${id}/acknowledge`, data),
  resolve: (id) => api.post(`/alerts/${id}/resolve`),
}

export const mibsApi = {
  list: () => api.get('/mibs'),
  upload: (file) => { const fd = new FormData(); fd.append('file', file); return api.post('/mibs/upload', fd) },
  delete: (id) => api.delete(`/mibs/${id}`),
  search: (q) => api.get('/mibs/search', { params: { q } }),
  resolve: (oid) => api.get(`/mibs/resolve/${oid}`),
  testOid: (data) => api.post('/mibs/test-oid', data),
}

export const reportsApi = {
  summary: (days=7) => api.get('/reports/summary', { params: { days } }),
  uptime: () => api.get('/reports/uptime'),
}

export const settingsApi = {
  get: () => api.get('/settings'),
  configurSync: (data) => api.post('/settings/sync', data),
  testSync: () => api.post('/settings/sync/test'),
  testSmtp: (data) => api.post('/settings/smtp/test', data),
}
