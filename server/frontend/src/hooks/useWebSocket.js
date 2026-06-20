import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import toast from 'react-hot-toast'

export function useWebSocket() {
  const ws = useRef(null)
  const { setWsConnected, updateDeviceStatus, addAlert, addTrap } = useStore()

  useEffect(() => {
    // Check if running in Tauri
    const isTauri = !!(window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke);

    if (isTauri) {
      setWsConnected(true);
      let unlisteners = [];

      const setupTauriListeners = async () => {
        try {
          const listen = window.__TAURI__?.event?.listen;
          if (listen) {
            const unlistenDevice = await listen('device_update', (event) => {
              const data = event.payload;
              updateDeviceStatus(data.device_id, data.status, data.metrics || {});
            });
            unlisteners.push(unlistenDevice);

            const unlistenAlert = await listen('new_alert', (event) => {
              const data = event.payload.data;
              const ts = event.payload.ts;
              addAlert({ ...data, timestamp: ts });
              if (data.severity === 'critical') {
                toast.error(`🚨 ${data.title}: ${data.message}`, { duration: 8000 });
              } else if (data.severity === 'warning') {
                toast(`⚠️ ${data.title}`, { duration: 5000 });
              }
            });
            unlisteners.push(unlistenAlert);

            const unlistenTrap = await listen('trap_received', (event) => {
              const data = event.payload.data;
              const ts = event.payload.ts;
              addTrap({ ...data, timestamp: ts });
              if (data.severity === 'critical') {
                toast.error(`Trap: ${data.plain_english}`, { duration: 6000 });
              }
            });
            unlisteners.push(unlistenTrap);
          }
        } catch (err) {
          console.error("Failed to setup Tauri native listeners:", err);
        }
      };

      setupTauriListeners();

      return () => {
        for (const unlisten of unlisteners) {
          unlisten();
        }
      };
    } else {
      // Standard browser WebSocket mode
      const connect = () => {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const host = window.location.host
        ws.current = new WebSocket(`${protocol}://${host}/ws`)

        ws.current.onopen = () => {
          setWsConnected(true)
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
            // ignore
          }
        }

        ws.current.onclose = () => {
          setWsConnected(false)
          clearInterval(ws.current?._pingInterval)
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
    }
  }, [])
}
