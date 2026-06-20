import { useEffect, useState, useRef } from 'react'
import { mibsApi } from '../utils/api'
import { FileCode, Upload, Trash2, Search, TestTube, CheckCircle, XCircle, Database } from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'

export default function MIBs() {
  const [mibs, setMibs] = useState([])
  const [tab, setTab] = useState('library') // library | search | tester
  const [uploading, setUploading] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const fileRef = useRef()

  // OID tester state
  const [tester, setTester] = useState({ ip: '', oid: '', community: 'public', result: null, loading: false })

  const loadMibs = async () => {
    try { const r = await mibsApi.list(); setMibs(r.data) } catch {}
  }

  useEffect(() => { loadMibs() }, [])

  const handleUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const res = await mibsApi.upload(file)
      toast.success(`Loaded ${res.data.oid_count} OIDs from ${res.data.module_name}`)
      loadMibs()
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Upload failed')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const deleteMib = async (id) => {
    if (!confirm('Remove this MIB?')) return
    try { await mibsApi.delete(id); loadMibs(); toast.success('MIB removed') }
    catch (e) { toast.error(e.response?.data?.detail || 'Cannot delete') }
  }

  const doSearch = async () => {
    if (searchQ.length < 2) return
    setSearching(true)
    try { const r = await mibsApi.search(searchQ); setSearchResults(r.data) }
    catch { setSearchResults([]) }
    finally { setSearching(false) }
  }

  const testOid = async () => {
    if (!tester.ip || !tester.oid) return toast.error('Enter device IP and OID')
    setTester(t => ({ ...t, loading: true, result: null }))
    try {
      const r = await mibsApi.testOid({ ip: tester.ip, oid: tester.oid, community: tester.community })
      setTester(t => ({ ...t, loading: false, result: r.data }))
    } catch {
      setTester(t => ({ ...t, loading: false, result: { success: false, error: 'Request failed' } }))
    }
  }

  const totalOids = mibs.reduce((s, m) => s + (m.oid_count || 0), 0)

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">MIB Manager</h1>
          <p className="text-gray-500 text-sm mt-1">Import vendor MIBs · browse OIDs · test live values</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">
            <Database size={14} className="inline mr-1" />
            {totalOids.toLocaleString()} OIDs loaded
          </span>
          <button onClick={() => fileRef.current?.click()} disabled={uploading}
            className="btn-primary flex items-center gap-2">
            {uploading
              ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <Upload size={15} />}
            {uploading ? 'Parsing...' : 'Upload MIB'}
          </button>
          <input ref={fileRef} type="file" accept=".mib,.my,.txt" className="hidden" onChange={handleUpload} />
        </div>
      </div>

      {/* Upload drop hint */}
      <div
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { const dt = new DataTransfer(); dt.items.add(f); fileRef.current.files = dt.files; handleUpload({ target: fileRef.current }) } }}
        className="border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl p-6 text-center text-sm text-gray-400 hover:border-teal-400 transition-colors cursor-pointer"
        onClick={() => fileRef.current?.click()}
      >
        <Upload size={20} className="mx-auto mb-2 opacity-50" />
        Drag & drop a .mib or .my file here, or click to browse
        <br /><span className="text-xs">Supports standard MIB format files from Cisco, Ubiquiti, MikroTik, HP, etc.</span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {[['library','MIB Library'],['search','OID Search'],['tester','Live OID Tester']].map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            className={clsx('px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
              tab === k ? 'border-teal-600 text-teal-600' : 'border-transparent text-gray-500 hover:text-gray-700')}>
            {lbl}
          </button>
        ))}
      </div>

      {/* Library Tab */}
      {tab === 'library' && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {mibs.map(m => (
            <div key={m.id} className="card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <FileCode size={16} className="text-teal-600 flex-shrink-0" />
                    <p className="font-semibold text-gray-800 dark:text-gray-200 truncate">{m.name}</p>
                    {m.is_standard && <span className="badge bg-gray-100 text-gray-500 text-xs">Standard</span>}
                  </div>
                  <p className="text-xs text-gray-400 mt-1 truncate">{m.filename}</p>
                  {m.vendor && <p className="text-xs text-gray-500 mt-0.5">Vendor: {m.vendor}</p>}
                </div>
                {!m.is_standard && (
                  <button onClick={() => deleteMib(m.id)} className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 flex-shrink-0">
                    <Trash2 size={14} className="text-red-400" />
                  </button>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
                <span className="bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400 px-2 py-0.5 rounded font-medium">
                  {(m.oid_count || 0).toLocaleString()} OIDs
                </span>
                <span>{(m.file_size / 1024).toFixed(1)} KB</span>
              </div>
            </div>
          ))}
          {mibs.length === 0 && (
            <div className="col-span-3 card py-12 text-center text-gray-400">
              <FileCode size={36} className="mx-auto mb-3 opacity-30" />
              <p>No MIBs uploaded yet</p>
              <p className="text-xs mt-1">Upload vendor MIBs to get human-readable OID names in trap events</p>
            </div>
          )}
        </div>
      )}

      {/* Search Tab */}
      {tab === 'search' && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <input className="input flex-1" placeholder="Search by OID name or description... (e.g. cpu, toner, signal)"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()} />
            <button onClick={doSearch} disabled={searching} className="btn-primary flex items-center gap-2">
              {searching ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Search size={15} />}
              Search
            </button>
          </div>

          {searchResults.length > 0 && (
            <div className="card divide-y divide-gray-100 dark:divide-gray-700">
              {searchResults.map(r => (
                <div key={r.oid} className="flex items-start gap-4 p-4">
                  <code className="text-xs font-mono text-teal-600 bg-teal-50 dark:bg-teal-900/20 px-2 py-1 rounded flex-shrink-0 mt-0.5">
                    {r.oid}
                  </code>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-800 dark:text-gray-200">{r.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{r.description || 'No description'}</p>
                    {r.unit && <span className="text-xs bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded mt-1 inline-block">{r.unit}</span>}
                  </div>
                  <button onClick={() => { setTester(t => ({ ...t, oid: r.oid })); setTab('tester') }}
                    className="text-xs text-teal-600 hover:underline flex-shrink-0">
                    Test →
                  </button>
                </div>
              ))}
            </div>
          )}
          {searchQ.length >= 2 && !searching && searchResults.length === 0 && (
            <div className="card py-10 text-center text-gray-400 text-sm">No OIDs found matching "{searchQ}"</div>
          )}
        </div>
      )}

      {/* Tester Tab */}
      {tab === 'tester' && (
        <div className="max-w-xl space-y-4">
          <div className="card p-5 space-y-3">
            <h3 className="font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
              <TestTube size={16} className="text-teal-600" /> Live OID Tester
            </h3>
            <p className="text-xs text-gray-500">Fetch a real-time value from any device right now</p>

            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Device IP</label>
                <input className="input" value={tester.ip}
                  onChange={e => setTester(t => ({ ...t, ip: e.target.value }))}
                  placeholder="192.168.1.1" /></div>
              <div><label className="label">Community</label>
                <input className="input" value={tester.community}
                  onChange={e => setTester(t => ({ ...t, community: e.target.value }))}
                  placeholder="public" /></div>
            </div>
            <div><label className="label">OID to query</label>
              <input className="input font-mono text-xs" value={tester.oid}
                onChange={e => setTester(t => ({ ...t, oid: e.target.value }))}
                placeholder="1.3.6.1.2.1.1.1.0" /></div>

            {/* Quick OID shortcuts */}
            <div>
              <p className="text-xs text-gray-400 mb-1">Common OIDs:</p>
              <div className="flex flex-wrap gap-1">
                {[
                  ['sysDescr','1.3.6.1.2.1.1.1.0'],
                  ['sysName','1.3.6.1.2.1.1.5.0'],
                  ['sysUpTime','1.3.6.1.2.1.1.3.0'],
                  ['CPU','1.3.6.1.2.1.25.3.3.1.2.1'],
                ].map(([name, oid]) => (
                  <button key={oid} onClick={() => setTester(t => ({ ...t, oid }))}
                    className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded hover:bg-teal-50 dark:hover:bg-teal-900/30 text-gray-600 dark:text-gray-300">
                    {name}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={testOid} disabled={tester.loading} className="btn-primary flex items-center gap-2">
              {tester.loading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <TestTube size={14} />}
              {tester.loading ? 'Querying...' : 'Fetch Value'}
            </button>

            {tester.result && (
              <div className={clsx('rounded-lg p-4 text-sm', tester.result.success ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20')}>
                {tester.result.success ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-green-700 dark:text-green-300 font-medium">
                      <CheckCircle size={15} /> {tester.result.name}
                    </div>
                    <div className="font-mono text-lg font-bold text-gray-800 dark:text-gray-200">
                      {tester.result.value}{tester.result.unit ? ` ${tester.result.unit}` : ''}
                    </div>
                    <p className="text-xs text-gray-500">{tester.result.description}</p>
                    <p className="text-xs font-mono text-gray-400">{tester.result.oid}</p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                    <XCircle size={15} /> {tester.result.error}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
