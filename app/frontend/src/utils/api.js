import axios from 'axios'

const tauriAdapter = async (config) => {
  return new Promise(async (resolve, reject) => {
    try {
      const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
      if (!invoke) {
        // Fallback to normal HTTP requests if running outside Tauri
        const httpAdapter = axios.defaults.adapter;
        if (typeof httpAdapter === 'function') {
          return httpAdapter(config).then(resolve).catch(reject);
        } else {
          const fetchAdapter = (await import('axios/lib/adapters/xhr.js')).default;
          return fetchAdapter(config).then(resolve).catch(reject);
        }
      }

      // Format path: remove base URL if present
      let urlPath = config.url;
      if (urlPath.startsWith('/api/v1')) {
        urlPath = urlPath.replace('/api/v1', '');
      } else if (urlPath.startsWith(config.baseURL || '')) {
        urlPath = urlPath.replace(config.baseURL || '', '');
      }

      // Invoke the Tauri command
      const responseData = await invoke("handle_api_request", {
        url: urlPath,
        method: config.method.toUpperCase(),
        params: config.params || {},
        data: config.data ? JSON.parse(JSON.stringify(config.data)) : null
      });

      resolve({
        data: responseData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config
      });
    } catch (err) {
      console.error("Tauri IPC API error:", err);
      reject({
        response: {
          data: { detail: err.toString() },
          status: 400,
          statusText: 'Bad Request',
          headers: {},
          config
        }
      });
    }
  });
};

const api = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
  adapter: tauriAdapter
})

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
  purge: (id) => api.delete(`/devices/${id}/purge`),
  listDeleted: () => api.get('/devices/deleted'),
  restore: (id) => api.post(`/devices/${id}/restore`),
  cloudDevices: () => api.get('/sync/cloud-devices'),
  recoverFromCloud: (ip) => api.post('/sync/recover', { ip_address: ip }),
  poll: (id) => api.post(`/devices/${id}/poll`),
  metrics: (id, hours=24) => api.get(`/devices/${id}/metrics`, { params: { hours } }),
  summary: () => api.get('/devices/summary'),
  getInterfaces: (id) => api.get(`/devices/${id}/interfaces`),
  saveInterfaces: (id, indexes) => api.post(`/devices/${id}/interfaces`, { indexes }),
  saveMibMetrics: (id, metrics) => api.post(`/devices/${id}/mib-metrics`, { metrics }),
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
  testOid:  (data) => api.post('/mibs/test-oid',  data),
  walkOid:  (data) => api.post('/mibs/walk-oid',  data),
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
  saveSnmp: (data) => api.put('/settings/snmp', data),
  saveCustom: (key, value) => api.put(`/settings/custom/${encodeURIComponent(key)}`, null, { params: { value } }),
  syncSites: () => api.get('/sync/sites'),
  syncLog: (limit = 30) => api.get('/sync/log', { params: { limit } }),
  syncFailedQueue: () => api.get('/sync/queue/failed'),
  syncRetryFailed: () => api.post('/sync/queue/retry'),
}

export const usersApi = {
  me:            () => api.get('/auth/me'),
  list:          () => api.get('/auth/users'),
  create:        (data) => api.post('/auth/users', data),
  update:        (id, data) => api.put(`/auth/users/${id}`, data),
  resetPassword: (id, new_password) => api.post(`/auth/users/${id}/reset-password`, { new_password }),
  delete:        (id) => api.delete(`/auth/users/${id}`),
}

export const updateApi = {
  status: () => api.get('/update/status'),
  check:  () => api.post('/update/check'),
  apply:  () => api.post('/update/apply'),
}
