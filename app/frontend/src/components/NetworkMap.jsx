import { useEffect, useRef, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { settingsApi } from '../utils/api'
import { MapPin, Link2 } from 'lucide-react'
import clsx from 'clsx'
import { useStore } from '../store'

const STATUS_COLORS = {
  online: '#22c55e', offline: '#ef4444', warning: '#f59e0b', unknown: '#9ca3af'
}

let mapsPromise = null

// Module-level singleton — avoids injecting the Google Maps script more than
// once even if multiple components mount around the same time.
function loadGoogleMapsScript(apiKey) {
  if (window.google?.maps) return Promise.resolve(window.google.maps)
  if (mapsPromise) return mapsPromise

  mapsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-google-maps-loader]')
    if (existing) {
      // Tag already injected (e.g. HMR re-evaluated this module mid-load) —
      // its callback global may be gone, so poll for readiness instead.
      const poll = setInterval(() => {
        if (window.google?.maps) { clearInterval(poll); resolve(window.google.maps) }
      }, 100)
      setTimeout(() => {
        clearInterval(poll)
        if (!window.google?.maps) reject(new Error('Failed to load Google Maps script'))
      }, 15000)
      return
    }
    // Google's recommended pattern: loading=async + a callback that fires once
    // the API is fully ready (plain onload would race its internal bootstrap).
    window.__nmsGoogleMapsReady = () => {
      delete window.__nmsGoogleMapsReady
      resolve(window.google.maps)
    }
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async&callback=__nmsGoogleMapsReady`
    script.async = true
    script.dataset.googleMapsLoader = 'true'
    script.onerror = () => reject(new Error('Failed to load Google Maps script'))
    document.head.appendChild(script)
  })

  return mapsPromise
}

// Deterministic "random-looking" color per pair, stable across reloads.
function pairColor(key) {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i)
    hash |= 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 70%, 45%)`
}

function escapeHtml(value) {
  const div = document.createElement('div')
  div.textContent = String(value ?? '')
  return div.innerHTML
}

export default function NetworkMap({ devices }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const overlaysRef = useRef([])
  const infoWindowRef = useRef(null)

  const { user, appMode, advanceFeaturesEnabled } = useStore()

  const getVisibleIp = (ip) => {
    if (appMode === 'desktop') {
      return advanceFeaturesEnabled ? ip : '*.*.*.*'
    }
    return user?.role === 'admin' ? ip : '*.*.*.*'
  }

  const links = useMemo(() => {
    const located = (devices || []).filter(d => d.latitude != null && d.longitude != null)
    const byId = new Map((devices || []).map(d => [d.id, d]))
    const list = []
    const drawn = new Set()

    located.forEach(d => {
      if (!d.associated_device_id) return
      const peer = byId.get(d.associated_device_id)
      if (!peer || peer.latitude == null || peer.longitude == null) return

      const pairKey = [d.id, peer.id].sort((a, b) => a - b).join('-')
      if (drawn.has(pairKey)) return
      drawn.add(pairKey)

      list.push({
        key: pairKey,
        deviceA: d,
        deviceB: peer,
        color: pairColor(pairKey)
      })
    })
    return list
  }, [devices])

  const handleSelectLink = (link) => {
    if (!mapRef.current || !window.google?.maps) return
    const maps = window.google.maps
    const map = mapRef.current
    const infoWindow = infoWindowRef.current

    const bounds = new maps.LatLngBounds()
    bounds.extend({ lat: link.deviceA.latitude, lng: link.deviceA.longitude })
    bounds.extend({ lat: link.deviceB.latitude, lng: link.deviceB.longitude })

    map.fitBounds(bounds, 80)

    const midLat = (link.deviceA.latitude + link.deviceB.latitude) / 2
    const midLng = (link.deviceA.longitude + link.deviceB.longitude) / 2

    infoWindow.setContent(`
      <div style="font-family:Inter,sans-serif;font-size:13px;padding:4px;min-width:180px">
        <div style="font-weight:600;margin-bottom:4px;color:#0f172a">Connected Link</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
          <div>
            <span style="font-weight:500">${escapeHtml(link.deviceA.name)}</span>
            <div style="font-size:10px;color:#6b7280;font-family:monospace">${escapeHtml(getVisibleIp(link.deviceA.ip_address))}</div>
          </div>
          <span style="color:#0d9488;font-weight:bold">↔</span>
          <div style="text-align:right">
            <span style="font-weight:500">${escapeHtml(link.deviceB.name)}</span>
            <div style="font-size:10px;color:#6b7280;font-family:monospace">${escapeHtml(getVisibleIp(link.deviceB.ip_address))}</div>
          </div>
        </div>
        <div style="font-size:11px;color:#475569;border-top:1px solid #e2e8f0;padding-top:4px;display:flex;justify-content:space-between">
          <span style="text-transform:capitalize;color:${STATUS_COLORS[link.deviceA.status] || '#9ca3af'}">${escapeHtml(link.deviceA.status)}</span>
          <span style="color:#94a3b8">·</span>
          <span style="text-transform:capitalize;color:${STATUS_COLORS[link.deviceB.status] || '#9ca3af'}">${escapeHtml(link.deviceB.status)}</span>
        </div>
      </div>
    `)
    infoWindow.setPosition({ lat: midLat, lng: midLng })
    infoWindow.open(map)
  }

  // undefined = loading settings, null = no key configured, string = key
  const [apiKey, setApiKey] = useState(undefined)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    settingsApi.get()
      .then(r => setApiKey(r.data?.custom?.google_maps_api_key || null))
      .catch(() => setApiKey(null))
  }, [])

  useEffect(() => {
    if (!apiKey || !containerRef.current) return
    let cancelled = false
    loadGoogleMapsScript(apiKey)
      .then(maps => { if (!cancelled) buildMap(maps) })
      .catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, devices])

  const buildMap = (maps) => {
    // Clear previous markers/lines before redrawing
    overlaysRef.current.forEach(o => o.setMap?.(null))
    overlaysRef.current = []

    const located = (devices || []).filter(d => d.latitude != null && d.longitude != null)
    const firstBuild = !mapRef.current

    if (firstBuild) {
      mapRef.current = new maps.Map(containerRef.current, {
        center: { lat: 20.5937, lng: 78.9629 }, // fallback view — roughly central India
        zoom: 5,
      })
      infoWindowRef.current = new maps.InfoWindow()
    }

    if (located.length === 0) return

    const map = mapRef.current
    const infoWindow = infoWindowRef.current
    const byId = new Map((devices || []).map(d => [d.id, d]))
    const bounds = new maps.LatLngBounds()

    located.forEach(d => {
      const position = { lat: d.latitude, lng: d.longitude }
      bounds.extend(position)

      const marker = new maps.Marker({
        position,
        map,
        title: d.name,
        icon: {
          path: maps.SymbolPath.CIRCLE,
          fillColor: STATUS_COLORS[d.status] || STATUS_COLORS.unknown,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
          scale: 8,
        },
      })
      marker.addListener('click', () => {
        infoWindow.setContent(`
          <div style="font-family:Inter,sans-serif;font-size:13px;min-width:160px">
            <div style="font-weight:600;margin-bottom:2px">${escapeHtml(d.name)}</div>
            <div style="color:#6b7280;font-family:monospace;font-size:12px">${escapeHtml(getVisibleIp(d.ip_address))}</div>
            <div style="margin-top:4px;text-transform:capitalize;color:#374151">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${STATUS_COLORS[d.status] || STATUS_COLORS.unknown};margin-right:5px"></span>
              ${escapeHtml(d.status)} · ${escapeHtml(d.device_type)}
            </div>
            <a href="/devices/${d.id}" style="color:#0d9488;font-size:12px;display:inline-block;margin-top:6px">View device →</a>
          </div>
        `)
        infoWindow.open(map, marker)
      })
      overlaysRef.current.push(marker)
    })

    // One straight, randomized-color line per associated pair (deduped both ways)
    const drawn = new Set()
    located.forEach(d => {
      if (!d.associated_device_id) return
      const peer = byId.get(d.associated_device_id)
      if (!peer || peer.latitude == null || peer.longitude == null) return

      const pairKey = [d.id, peer.id].sort((a, b) => a - b).join('-')
      if (drawn.has(pairKey)) return
      drawn.add(pairKey)

      const line = new maps.Polyline({
        path: [
          { lat: d.latitude, lng: d.longitude },
          { lat: peer.latitude, lng: peer.longitude },
        ],
        geodesic: false,
        strokeColor: pairColor(pairKey),
        strokeOpacity: 0.85,
        strokeWeight: 3,
        map,
      })
      overlaysRef.current.push(line)
    })

    // Only adjust the viewport on the first build so the user's pan/zoom
    // survives later refreshes of the `devices` prop.
    if (firstBuild) {
      if (located.length === 1) {
        map.setCenter({ lat: located[0].latitude, lng: located[0].longitude })
        map.setZoom(13)
      } else {
        map.fitBounds(bounds, 48)
        maps.event.addListenerOnce(map, 'bounds_changed', () => {
          if (map.getZoom() > 15) map.setZoom(15)
        })
      }
    }
  }

  // Clean up overlays/info window on unmount
  useEffect(() => () => {
    overlaysRef.current.forEach(o => o.setMap?.(null))
    infoWindowRef.current?.close()
  }, [])

  const locatedCount = (devices || []).filter(d => d.latitude != null && d.longitude != null).length

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
          <MapPin size={15} className="text-teal-500" /> Network Map
        </h3>
        {locatedCount > 0 && (
          <span className="text-xs text-gray-400">{locatedCount} device{locatedCount === 1 ? '' : 's'} located</span>
        )}
      </div>

      {apiKey === undefined ? (
        <div className="flex justify-center items-center h-72">
          <div className="w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : apiKey === null ? (
        <div className="flex flex-col items-center justify-center h-72 text-center px-4">
          <MapPin size={32} className="text-gray-300 mb-2" />
          <p className="text-sm text-gray-500">No Google Maps API key configured</p>
          <p className="text-xs text-gray-400 mt-1">
            <Link to="/settings" className="text-teal-600 underline">Set a Google Maps API key in Settings</Link> to enable the network map.
          </p>
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center justify-center h-72 text-center px-4">
          <MapPin size={32} className="text-red-300 mb-2" />
          <p className="text-sm text-red-500">Could not load Google Maps</p>
          <p className="text-xs text-gray-400 mt-1">Check that the API key is valid and the Maps JavaScript API is enabled.</p>
        </div>
      ) : (
        <div className={clsx("grid grid-cols-1 gap-4", links.length > 0 && "lg:grid-cols-4")}>
          <div className={clsx("w-full h-96 rounded-lg overflow-hidden", links.length > 0 ? "lg:col-span-3" : "w-full")} ref={containerRef} />
          {links.length > 0 && (
            <div className="lg:col-span-1 flex flex-col border border-gray-100 dark:border-gray-800 rounded-lg p-3 bg-gray-50/30 dark:bg-gray-950/10">
              <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2.5 flex items-center gap-1.5">
                <Link2 size={13} className="text-teal-500" />
                Active Links ({links.length})
              </h4>
              <div className="flex-1 space-y-2 overflow-y-auto pr-1 max-h-[340px] custom-scrollbar">
                {links.map(link => (
                  <button
                    key={link.key}
                    onClick={() => handleSelectLink(link)}
                    className="w-full text-left p-2.5 rounded-lg border border-gray-100 hover:border-teal-400/40 bg-white hover:bg-teal-50/10 dark:border-gray-800 dark:bg-gray-900/40 dark:hover:bg-gray-800/30 transition-all flex flex-col gap-1.5 focus:outline-none shadow-sm"
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-800 dark:text-gray-200">
                      <Link2 size={13} style={{ color: link.color }} />
                      <span className="truncate max-w-[85px]" title={link.deviceA.name}>{link.deviceA.name}</span>
                      <span className="text-gray-400 font-normal">↔</span>
                      <span className="truncate max-w-[85px]" title={link.deviceB.name}>{link.deviceB.name}</span>
                    </div>
                    <div className="flex items-center justify-between w-full text-[10px] text-gray-500">
                      <div className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATUS_COLORS[link.deviceA.status] || '#9ca3af' }} />
                        <span className="font-mono">{getVisibleIp(link.deviceA.ip_address)}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATUS_COLORS[link.deviceB.status] || '#9ca3af' }} />
                        <span className="font-mono">{getVisibleIp(link.deviceB.ip_address)}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {locatedCount === 0 && (
            <p className="text-xs text-gray-400 mt-2 lg:col-span-4">
              No devices have a location yet — edit a device to set its latitude/longitude.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
