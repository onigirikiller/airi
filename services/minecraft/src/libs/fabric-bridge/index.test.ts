import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = {
  statSync: vi.fn(),
  autoConnect: true,
  bridgeStatus: {
    connected: false,
    username: 'AIra',
    bridgeVersion: '0.1.0',
    bridgeBuildTimestamp: '2026-03-03T10:24:59.048662600Z',
  },
  wsClients: [] as any[],
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: mocks.statSync,
  }
})

vi.mock('./ws-client', async () => {
  const { EventEmitter } = await import('node:events')

  class MockWsClient extends EventEmitter {
    public connected = false

    constructor(_config: unknown) {
      super()
      mocks.wsClients.push(this)
    }

    connect(): void {
      if (!mocks.autoConnect) {
        return
      }

      this.connected = true
      queueMicrotask(() => {
        this.emit('connected')
      })
    }

    disconnect(): void {
      this.connected = false
      this.emit('disconnected')
    }

    async request<T = Record<string, unknown>>(command: string): Promise<T> {
      if (command === 'getStatus') {
        return mocks.bridgeStatus as T
      }

      return {} as T
    }

    send(): void {}
  }

  return {
    WsClient: MockWsClient,
  }
})

const { FabricBridge, getInstalledBridgeJarPath, hasLikelyNewerInstalledBridgeBuild } = await import('./index')

describe('fabric bridge build mismatch detection', () => {
  const originalAppData = process.env.APPDATA
  let setIntervalSpy: ReturnType<typeof vi.spyOn>
  const intervalCallbacks: Array<() => void | Promise<void>> = []

  beforeEach(() => {
    vi.clearAllMocks()
    intervalCallbacks.length = 0
    mocks.autoConnect = true
    mocks.wsClients.length = 0
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    mocks.bridgeStatus = {
      connected: false,
      username: 'AIra',
      bridgeVersion: '0.1.0',
      bridgeBuildTimestamp: '2026-03-03T10:24:59.048662600Z',
    }
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: Parameters<typeof setInterval>[0]) => {
      if (typeof handler === 'function') {
        intervalCallbacks.push(handler as () => void | Promise<void>)
      }
      return intervalCallbacks.length as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env.APPDATA = originalAppData
    setIntervalSpy.mockRestore()
  })

  it('builds the installed bridge jar path from APPDATA and version', () => {
    expect(getInstalledBridgeJarPath('0.1.0')).toBe(
      'C:\\Users\\tester\\AppData\\Roaming\\.minecraft\\mods\\airi-mcbridge-0.1.0.jar',
    )
  })

  it('detects when the installed bridge jar is newer than the running build timestamp', () => {
    mocks.statSync.mockReturnValue({
      mtimeMs: Date.parse('2026-03-02T02:10:00.000Z'),
    })

    expect(hasLikelyNewerInstalledBridgeBuild('0.1.0', '2026-03-02T01:07:27.865Z')).toBe(true)
  })

  it('does not report a mismatch when the on-disk jar is not newer', () => {
    mocks.statSync.mockReturnValue({
      mtimeMs: Date.parse('2026-03-02T01:07:50.000Z'),
    })

    expect(hasLikelyNewerInstalledBridgeBuild('0.1.0', '2026-03-02T01:07:27.865Z')).toBe(false)
  })

  it('runs spawned hooks when the initial bridge status already has the player in-world', async () => {
    mocks.bridgeStatus.connected = true
    const plugin = {
      created: vi.fn(),
      spawned: vi.fn(),
    }

    const bridge = await FabricBridge.asyncBuild({
      username: 'AIra',
      wsConfig: {
        host: 'localhost',
        port: 8089,
      },
      plugins: [plugin as any],
    })

    expect(plugin.created).toHaveBeenCalledOnce()
    expect(plugin.spawned).toHaveBeenCalledOnce()

    await bridge.stop()
  })

  it('runs spawned hooks when the player spawns after plugins were created', async () => {
    const plugin = {
      created: vi.fn(),
      spawned: vi.fn(),
    }

    const bridge = await FabricBridge.asyncBuild({
      username: 'AIra',
      wsConfig: {
        host: 'localhost',
        port: 8089,
      },
      plugins: [plugin as any],
    })

    expect(plugin.created).toHaveBeenCalledOnce()
    expect(plugin.spawned).not.toHaveBeenCalled()

    bridge.bot.emit('spawn')
    await vi.waitFor(() => {
      expect(plugin.spawned).toHaveBeenCalledOnce()
    })

    await bridge.stop()
  })

  it('polls bridge status and runs spawned hooks when in-world readiness appears without a spawn event', async () => {
    const plugin = {
      created: vi.fn(),
      spawned: vi.fn(),
    }

    const bridge = await FabricBridge.asyncBuild({
      username: 'AIra',
      wsConfig: {
        host: 'localhost',
        port: 8089,
      },
      plugins: [plugin as any],
    })

    expect(plugin.created).toHaveBeenCalledOnce()
    expect(plugin.spawned).not.toHaveBeenCalled()

    mocks.bridgeStatus.connected = true
    for (const callback of intervalCallbacks) {
      await callback()
    }

    await vi.waitFor(() => {
      expect(plugin.spawned).toHaveBeenCalledOnce()
    })

    await bridge.stop()
  })

  it('continues startup in deferred-connect mode when the initial websocket bridge is absent', async () => {
    vi.useFakeTimers()
    mocks.autoConnect = false
    const plugin = {
      created: vi.fn(),
      spawned: vi.fn(),
    }

    const buildPromise = FabricBridge.asyncBuild({
      username: 'AIra',
      wsConfig: {
        host: 'localhost',
        port: 8089,
      },
      plugins: [plugin as any],
    })

    await vi.advanceTimersByTimeAsync(90_000)
    const bridge = await buildPromise

    expect(plugin.created).toHaveBeenCalledOnce()
    expect(plugin.spawned).not.toHaveBeenCalled()
    expect(bridge.ready).toBe(false)

    await bridge.stop()
  })

  it('runs spawned hooks after a late websocket attach in deferred-connect mode', async () => {
    vi.useFakeTimers()
    mocks.autoConnect = false
    mocks.bridgeStatus.connected = true
    const plugin = {
      created: vi.fn(),
      spawned: vi.fn(),
    }

    const buildPromise = FabricBridge.asyncBuild({
      username: 'AIra',
      wsConfig: {
        host: 'localhost',
        port: 8089,
      },
      plugins: [plugin as any],
    })

    await vi.advanceTimersByTimeAsync(90_000)
    const bridge = await buildPromise

    const wsClient = mocks.wsClients.at(-1)
    wsClient.connected = true
    wsClient.emit('connected')
    await vi.advanceTimersByTimeAsync(0)

    await vi.waitFor(() => {
      expect(plugin.spawned).toHaveBeenCalledOnce()
      expect(bridge.ready).toBe(true)
    })

    await bridge.stop()
  })
})
