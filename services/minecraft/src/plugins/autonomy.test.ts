import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AutonomyPlugin } from './autonomy'

const { orchestratorStart, orchestratorStop } = vi.hoisted(() => ({
  orchestratorStart: vi.fn(),
  orchestratorStop: vi.fn(),
}))

vi.mock('../autonomy/orchestrator', () => ({
  AutonomousStreamOrchestrator: class {
    start = orchestratorStart
    stop = orchestratorStop
  },
}))

describe('autonomy plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts the stream orchestrator when spawned', async () => {
    const plugin = AutonomyPlugin({} as any)
    const mineflayer = {
      username: 'AIRI',
      bot: { on: vi.fn(), off: vi.fn() },
    } as any

    await plugin.created?.(mineflayer)
    await plugin.spawned?.(mineflayer)

    expect(orchestratorStart).toHaveBeenCalledOnce()

    await plugin.beforeCleanup?.(mineflayer)
    expect(orchestratorStop).toHaveBeenCalledOnce()
  })

  it('starts the orchestrator from the spawn fallback when the plugin spawn hook is missed', async () => {
    const spawnHandlers: Array<() => void> = []
    const plugin = AutonomyPlugin({} as any)
    const mineflayer = {
      username: 'AIRI',
      bot: {
        on: vi.fn((event: string, handler: () => void) => {
          if (event === 'spawn') {
            spawnHandlers.push(handler)
          }
        }),
        off: vi.fn(),
      },
    } as any

    await plugin.created?.(mineflayer)

    expect(orchestratorStart).not.toHaveBeenCalled()
    expect(spawnHandlers).toHaveLength(1)

    spawnHandlers[0]?.()

    expect(orchestratorStart).toHaveBeenCalledOnce()

    await plugin.beforeCleanup?.(mineflayer)
    expect(orchestratorStop).toHaveBeenCalledOnce()
  })
})
