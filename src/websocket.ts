import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import type { WSMessage } from './types.js'

export function setupWebSocket(
  server: Server,
  connections: Map<number, Set<WebSocket>>
) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws, req) => {
    // Extract queue ID from URL: /ws?queueId=123
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const queueId = parseInt(url.searchParams.get('queueId') || '0', 10)

    if (!queueId) {
      ws.close(1008, 'Missing queueId parameter')
      return
    }

    // Add to connections for this queue
    if (!connections.has(queueId)) {
      connections.set(queueId, new Set())
    }
    connections.get(queueId)!.add(ws)

    console.log(`WebSocket connected to queue ${queueId}`)

    // Send initial connection confirmation
    ws.send(JSON.stringify({ type: 'connected', queueId }))

    // Handle disconnection
    ws.on('close', () => {
      const queueConnections = connections.get(queueId)
      if (queueConnections) {
        queueConnections.delete(ws)
        if (queueConnections.size === 0) {
          connections.delete(queueId)
        }
      }
      console.log(`WebSocket disconnected from queue ${queueId}`)
    })

    // Handle errors
    ws.on('error', (error) => {
      console.error(`WebSocket error on queue ${queueId}:`, error)
    })

    // Handle incoming messages (ping/pong for keepalive)
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
        }
      } catch {
        // Ignore invalid messages
      }
    })
  })

  // Heartbeat to detect stale connections
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any).isAlive === false) {
        return ws.terminate()
      }
      (ws as any).isAlive = false
      ws.ping()
    })
  }, 30000)

  wss.on('close', () => {
    clearInterval(interval)
  })

  return wss
}

export function createBroadcast(connections: Map<number, Set<WebSocket>>) {
  return (queueId: number, message: WSMessage) => {
    const queueConnections = connections.get(queueId)
    if (!queueConnections) return

    const payload = JSON.stringify(message)

    queueConnections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload)
      }
    })
  }
}
