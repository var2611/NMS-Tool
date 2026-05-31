import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import toast from 'react-hot-toast'

export function useWebSocket() {
  const ws = useRef(null)
  const { setWsConnected, updateDeviceStatus, addAlert, addTrap } = useStore()

  useEffect(() => {
    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const host = window.location.host
      ws.current = new WebSocket(`${protocol}://${host}/ws`)

      ws.current.onopen = () => {
        setWsConnected(true)
        // Keep-alive ping
        const ping = setInterval(() => {
          if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send('ping')
          }
        }, 30000)
        ws.current._pingInterval = ping
      }

      ws.current.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg === 'pong') return

          switch (msg.type) {
            case 'device_update':
              updateDeviceStatus(msg.data.device_id, msg.data.status, msg.data.metrics || {})
              break

            case 'new_alert':
              addAlert({ ...msg.data, timestamp: msg.ts })
              if (msg.data.severity === 'critical') {
                toast.error(`🚨 ${msg.data.title}: ${msg.data.message}`, { duration: 8000 })
              } else if (msg.data.severity === 'warning') {
                toast(`⚠️ ${msg.data.title}`, { duration: 5000 })
              }
              break

            case 'trap_received':
              addTrap({ ...msg.data, timestamp: msg.ts })
              if (msg.data.severity === 'critical') {
                toast.error(`Trap: ${msg.data.plain_english}`, { duration: 6000 })
              }
              break
          }
        } catch (err) {
          // ignore malformed messages
        }
      }

      ws.current.onclose = () => {
        setWsConnected(false)
        clearInterval(ws.current?._pingInterval)
        // Reconnect after 3 seconds
        setTimeout(connect, 3000)
      }

      ws.current.onerror = () => {
        ws.current?.close()
      }
    }

    connect()
    return () => {
      clearInterval(ws.current?._pingInterval)
      ws.current?.close()
    }
  }, [])
}
