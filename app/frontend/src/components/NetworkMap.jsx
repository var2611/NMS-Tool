import { useEffect, useRef, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { MapPin, Link2 } from 'lucide-react'
import clsx from 'clsx'
import { useStore } from '../store'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Robust interop resolution for UMD/CJS default exports inside ES6 bundlers
const Leaflet = L.map ? L : (L.default || L)

// Custom Leaflet TileLayer that forces no-referrer POLICY to prevent custom-scheme (tauri://) blocks on tile servers
const ReferrerFreeTileLayer = Leaflet.TileLayer.extend({
  createTile: function(coords, done) {
    const tile = Leaflet.TileLayer.prototype.createTile.call(this, coords, done);
    tile.setAttribute('referrerpolicy', 'no-referrer');
    return tile;
  }
});

const STATUS_COLORS = {
  online: '#22c55e', offline: '#ef4444', warning: '#f59e0b', unknown: '#9ca3af'
}

// Deterministic color per link pair
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

  const { user, appMode, advanceFeaturesEnabled } = useStore()

  const getVisibleIp = (ip) => {
    if (appMode === 'desktop') {
      return advanceFeaturesEnabled ? ip : '*.*.*.*'
    }
    return user?.role === 'admin' ? ip : '*.*.*.*'
  }

  const links = useMemo(() => {
    const located = (devices || []).filter(d => 
      d.latitude !== null && d.latitude !== undefined && d.latitude !== '' &&
      d.longitude !== null && d.longitude !== undefined && d.longitude !== ''
    )
    const byId = new Map((devices || []).map(d => [d.id, d]))
    const list = []
    const drawn = new Set()

    located.forEach(d => {
      if (!d.associated_device_id) return
      const peer = byId.get(d.associated_device_id)
      if (
        !peer ||
        peer.latitude === null || peer.latitude === undefined || peer.latitude === '' ||
        peer.longitude === null || peer.longitude === undefined || peer.longitude === ''
      ) return

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

  // Build/update map when ready or devices change
  useEffect(() => {
    if (!containerRef.current) return

    // Clear previous overlays
    overlaysRef.current.forEach(o => {
      if (mapRef.current) mapRef.current.removeLayer(o)
    })
    overlaysRef.current = []

    const located = (devices || []).filter(d => 
      d.latitude !== null && d.latitude !== undefined && d.latitude !== '' &&
      d.longitude !== null && d.longitude !== undefined && d.longitude !== ''
    )
    const firstBuild = !mapRef.current

    if (firstBuild) {
      mapRef.current = Leaflet.map(containerRef.current, {
        center: [20.5937, 78.9629],
        zoom: 5,
        zoomControl: true,
        attributionControl: true,
      })

      new ReferrerFreeTileLayer('https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 20,
        subdomains: 'abcd',
      }).addTo(mapRef.current)

      // Invalidate Leaflet map size to fix dynamic size/hidden layout rendering issues
      setTimeout(() => {
        if (mapRef.current) {
          mapRef.current.invalidateSize()
        }
      }, 300)
    }

    if (located.length === 0) return

    const map = mapRef.current
    const byId = new Map((devices || []).map(d => [d.id, d]))
    const bounds = Leaflet.latLngBounds()

    // Add circle markers for each located device
    located.forEach(d => {
      const latlng = [d.latitude, d.longitude]
      bounds.extend(latlng)

      const marker = Leaflet.circleMarker(latlng, {
        radius: 8,
        fillColor: STATUS_COLORS[d.status] || STATUS_COLORS.unknown,
        fillOpacity: 1,
        color: '#ffffff',
        weight: 2,
      }).addTo(map)

      marker.bindPopup(`
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

      overlaysRef.current.push(marker)
    })

    // Draw link polylines between associated device pairs
    const drawn = new Set()
    located.forEach(d => {
      if (!d.associated_device_id) return
      const peer = byId.get(d.associated_device_id)
      if (
        !peer ||
        peer.latitude === null || peer.latitude === undefined || peer.latitude === '' ||
        peer.longitude === null || peer.longitude === undefined || peer.longitude === ''
      ) return

      const pairKey = [d.id, peer.id].sort((a, b) => a - b).join('-')
      if (drawn.has(pairKey)) return
      drawn.add(pairKey)

      const line = Leaflet.polyline(
        [[d.latitude, d.longitude], [peer.latitude, peer.longitude]],
        { color: pairColor(pairKey), weight: 3, opacity: 0.85 }
      ).addTo(map)

      overlaysRef.current.push(line)
    })

    // Fit bounds on first build
    if (firstBuild) {
      if (located.length === 1) {
        map.setView([located[0].latitude, located[0].longitude], 13)
      } else {
        map.fitBounds(bounds, { padding: [48, 48] })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices])

  // Cleanup on unmount
  useEffect(() => () => {
    if (mapRef.current) {
      mapRef.current.remove()
      mapRef.current = null
    }
  }, [])

  const handleSelectLink = (link) => {
    if (!mapRef.current) return
    const map = mapRef.current

    const bounds = Leaflet.latLngBounds([
      [link.deviceA.latitude, link.deviceA.longitude],
      [link.deviceB.latitude, link.deviceB.longitude],
    ])
    map.fitBounds(bounds, { padding: [80, 80] })

    const midLat = (link.deviceA.latitude + link.deviceB.latitude) / 2
    const midLng = (link.deviceA.longitude + link.deviceB.longitude) / 2

    Leaflet.popup()
      .setLatLng([midLat, midLng])
      .setContent(`
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
      .openOn(map)
  }

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
    </div>
  )
}
