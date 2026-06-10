import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { settingsApi } from '../utils/api'
import { MapPin } from 'lucide-react'

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
            <div style="color:#6b7280;font-family:monospace;font-size:12px">${escapeHtml(d.ip_address)}</div>
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
        <>
          <div ref={containerRef} className="w-full h-96 rounded-lg overflow-hidden" />
          {locatedCount === 0 && (
            <p className="text-xs text-gray-400 mt-2">
              No devices have a location yet — edit a device to set its latitude/longitude.
            </p>
          )}
        </>
      )}
    </div>
  )
}
