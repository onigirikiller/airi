/**
 * WebSocket client with request/response correlation for the Fabric bridge.
 */

import type { BridgeCommand, BridgeError, BridgeEvent, BridgeResponse, FabricBridgeConfig } from './types'

import EventEmitter from 'eventemitter3'
import WebSocket from 'ws'

import { useLogg } from '@guiiai/logg'

export interface WsClientEvents {
  connected: () => void
  disconnected: () => void
  event: (event: BridgeEvent) => void
  error: (err: Error) => void
}

export class WsClient extends EventEmitter<WsClientEvents> {
  private ws: WebSocket | null = null
  private config: FabricBridgeConfig
  private pendingRequests = new Map<string, {
    resolve: (data: Record<string, unknown>) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  private requestIdCounter = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private logger = useLogg('FabricBridge:WS').useGlobalConfig()

  constructor(config: FabricBridgeConfig) {
    super()
    this.config = {
      reconnectInterval: 3000,
      maxReconnectAttempts: 50,
      ...config,
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(): void {
    if (this.ws) {
      try {
        this.ws.close()
      }
      catch {}
    }

    const url = `ws://${this.config.host}:${this.config.port}`
    this.logger.log(`Connecting to ${url}...`)

    this.ws = new WebSocket(url)

    this.ws.on('open', () => {
      this.logger.log('Connected to Fabric mod')
      this.reconnectAttempts = 0
      this.emit('connected')
    })

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString())
        this.handleMessage(msg)
      }
      catch {
        this.logger.error('Failed to parse message')
      }
    })

    this.ws.on('close', () => {
      this.logger.log('WebSocket connection closed')
      this.rejectPendingRequests(new Error('Connection closed'))
      this.emit('disconnected')
      if (!this.intentionalClose) {
        this.scheduleReconnect()
      }
    })

    this.ws.on('error', (err: Error) => {
      this.logger.error(`WebSocket error: ${err.message}`)
      this.emit('error', err)
    })
  }

  disconnect(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      }
      catch {}
      this.ws = null
    }
    this.rejectPendingRequests(new Error('Connection closed'))
  }

  /**
   * Send a command and wait for the response.
   */
  async request<T = Record<string, unknown>>(command: string, params: Record<string, unknown> = {}, timeout = 30000): Promise<T> {
    if (!this.connected) {
      throw new Error('Not connected to Fabric mod')
    }

    const id = `req_${++this.requestIdCounter}`

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timed out: ${command} (${id})`))
      }, timeout)

      this.pendingRequests.set(id, {
        resolve: resolve as (data: Record<string, unknown>) => void,
        reject,
        timer,
      })

      const msg: BridgeCommand = { id, command, params }
      this.ws!.send(JSON.stringify(msg))
    })
  }

  /**
   * Send a command without waiting for response (fire-and-forget).
   */
  send(command: string, params: Record<string, unknown> = {}): void {
    if (!this.connected)
      return

    const id = `fire_${++this.requestIdCounter}`
    const msg: BridgeCommand = { id, command, params }
    this.ws!.send(JSON.stringify(msg))
  }

  private handleMessage(msg: BridgeResponse | BridgeError | BridgeEvent): void {
    if (msg.type === 'response' || msg.type === 'error') {
      const pending = this.pendingRequests.get((msg as BridgeResponse | BridgeError).id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete((msg as BridgeResponse | BridgeError).id)

        if (msg.type === 'error') {
          pending.reject(new Error((msg as BridgeError).error))
        }
        else {
          pending.resolve((msg as BridgeResponse).data)
        }
      }
      return
    }

    // Push event from mod
    this.emit('event', msg as BridgeEvent)
  }

  private rejectPendingRequests(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts!) {
      this.logger.error('Max reconnect attempts reached')
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(this.config.reconnectInterval! * this.reconnectAttempts, 30000)
    this.logger.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`)

    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }
}
