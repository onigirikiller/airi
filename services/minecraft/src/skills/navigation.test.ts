import { Vec3 } from 'vec3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  goToPosition: vi.fn(),
  sleep: vi.fn(),
}))

vi.mock('./movement', () => ({
  goToPosition: mocks.goToPosition,
}))

vi.mock('@moeru/std', () => ({
  sleep: mocks.sleep,
}))

const { exploreLongDistance } = await import('./navigation')

function createMineflayer(options: { health?: number, y?: number } = {}) {
  return {
    bot: {
      chat: vi.fn(),
      health: options.health ?? 20,
      entity: {
        position: new Vec3(0, options.y ?? 64, 0),
      },
      pathfinder: {
        stop: vi.fn(),
      },
      clearControlStates: vi.fn(),
    },
  } as any
}

describe('exploreLongDistance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.goToPosition.mockResolvedValue(true)
    mocks.sleep.mockResolvedValue(undefined)
  })

  it('refuses long-distance travel when health is already unsafe', async () => {
    const mineflayer = createMineflayer({ health: 7 })

    const success = await exploreLongDistance(mineflayer, 'north', 100)

    expect(success).toBe(false)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mineflayer.bot.pathfinder.stop).toHaveBeenCalledOnce()
    expect(mineflayer.bot.clearControlStates).toHaveBeenCalledOnce()
  })

  it('stops after a travel segment drops into underground elevations', async () => {
    const mineflayer = createMineflayer({ health: 20, y: 64 })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.entity.position = new Vec3(0, 57, -64)
      return true
    })

    const success = await exploreLongDistance(mineflayer, 'north', 100)

    expect(success).toBe(false)
    expect(mocks.goToPosition).toHaveBeenCalledOnce()
    expect(mineflayer.bot.pathfinder.stop).toHaveBeenCalledOnce()
  })

  it('fails the travel action when a segment path cannot be reached', async () => {
    const mineflayer = createMineflayer({ health: 20, y: 64 })
    mocks.goToPosition.mockResolvedValue(false)

    const success = await exploreLongDistance(mineflayer, 'north', 100)

    expect(success).toBe(false)
    expect(mocks.goToPosition).toHaveBeenCalledOnce()
    expect(mineflayer.bot.pathfinder.stop).toHaveBeenCalledOnce()
  })
})
