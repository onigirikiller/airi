import superjson from 'superjson'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Client } from './client'

const { webSocketInstances, FakeWebSocket } = vi.hoisted(() => {
  const instances: FakeWebSocket[] = []

  class FakeWebSocket {
    static OPEN = 1
    static CLOSED = 3

    readonly sent: string[] = []
    readyState = 0
    onopen?: () => void
    onclose?: () => void
    onerror?: (event: any) => void
    onmessage?: (event: { data: string }) => void

    constructor(public readonly url: string) {
      instances.push(this)
    }

    send(data: string): void {
      this.sent.push(data)
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.()
    }

    ping(): void {}

    pong(): void {}

    emitOpen(): void {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    }

    emitMessage(data: Record<string, unknown>): void {
      this.onmessage?.({ data: superjson.stringify(data) })
    }
  }

  return {
    webSocketInstances: instances,
    FakeWebSocket,
  }
})

vi.mock('crossws/websocket', () => ({
  default: FakeWebSocket,
}))

function getSentTypes(socket: InstanceType<typeof FakeWebSocket>): string[] {
  return socket.sent.map((payload) => {
    const parsed = superjson.parse<{ type: string }>(payload)
    return parsed.type
  })
}

describe('server-sdk client', () => {
  beforeEach(() => {
    webSocketInstances.length = 0
  })

  it('queues output messages until the websocket connection is ready', async () => {
    const client = new Client({
      name: 'minecraft-bot',
      autoConnect: false,
      autoReconnect: false,
    })

    client.send({
      type: 'output:gen-ai:chat:message',
      data: {
        message: {
          role: 'assistant',
          content: 'hello from queue',
        },
      },
    } as any)

    expect(webSocketInstances).toHaveLength(1)

    const socket = webSocketInstances[0]!
    socket.emitOpen()
    await Promise.resolve()

    expect(getSentTypes(socket)).toContain('output:gen-ai:chat:message')
    client.close()
  })

  it('flushes queued messages after module authentication succeeds', async () => {
    const client = new Client({
      name: 'minecraft-bot',
      token: 'secret-token',
      autoConnect: false,
      autoReconnect: false,
    })

    client.send({
      type: 'output:gen-ai:chat:message',
      data: {
        message: {
          role: 'assistant',
          content: 'speak after auth',
        },
      },
    } as any)

    const socket = webSocketInstances[0]!
    socket.emitOpen()
    await Promise.resolve()

    expect(getSentTypes(socket)).not.toContain('output:gen-ai:chat:message')

    socket.emitMessage({
      type: 'module:authenticated',
      data: { authenticated: true },
      metadata: { event: { id: 'auth-ok' } },
    })
    await Promise.resolve()

    const sentTypes = getSentTypes(socket)
    expect(sentTypes).toContain('module:announce')
    expect(sentTypes).toContain('output:gen-ai:chat:message')
    client.close()
  })
})
