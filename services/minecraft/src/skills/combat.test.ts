import { Vec3 } from 'vec3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let now = 0

vi.mock('@moeru/std', () => ({
  sleep: vi.fn(async (duration = 0) => {
    now += duration
  }),
}))

const { attackEntity, attackNearest, defendSelf } = await import('./combat')

function createMineflayer() {
  const interruptHandlers = new Set<() => void>()
  const entity = {
    id: 7,
    name: 'zombie',
    type: 'mob',
    position: new Vec3(10, 64, 10),
  }

  const mineflayer = {
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'interrupt') {
        interruptHandlers.add(handler)
      }
    }),
    off: vi.fn((event: string, handler: () => void) => {
      if (event === 'interrupt') {
        interruptHandlers.delete(handler)
      }
    }),
    bot: {
      chat: vi.fn(),
      entity: {
        position: new Vec3(0, 64, 0),
      },
      blockAt: vi.fn(() => ({ name: 'air' })),
      lookAt: vi.fn(async () => {}),
      inventory: {
        items: () => [],
      },
      entities: {
        7: entity,
      },
      equip: vi.fn(async () => {}),
      attack: vi.fn(async () => {}),
      pvp: {
        attack: vi.fn(),
        stop: vi.fn(),
      },
      pathfinder: {
        goto: vi.fn(async () => {}),
        stop: vi.fn(),
      },
      nearestEntity: vi.fn((predicate: (entity: any) => boolean) => predicate(entity) ? entity : null),
    },
  } as any

  return {
    entity,
    interruptHandlers,
    mineflayer,
  }
}

describe('combat safeguards', () => {
  beforeEach(() => {
    now = 0
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })

  it('stops stalled kill attacks instead of waiting forever', async () => {
    const { mineflayer } = createMineflayer()

    const success = await attackEntity(mineflayer, mineflayer.bot.entities[7], true)

    expect(success).toBe(false)
    expect(mineflayer.bot.pvp.attack).toHaveBeenCalledOnce()
    expect(mineflayer.bot.pvp.stop).toHaveBeenCalled()
  })

  it('cleans up when defendSelf is interrupted', async () => {
    const { interruptHandlers, mineflayer } = createMineflayer()
    let triggered = false
    mineflayer.bot.pathfinder.goto.mockImplementation(async () => {
      if (!triggered) {
        triggered = true
        for (const handler of [...interruptHandlers]) {
          handler()
        }
      }
    })

    const success = await defendSelf(mineflayer, 12)

    expect(success).toBe(false)
    expect(mineflayer.bot.pvp.stop).toHaveBeenCalled()
    expect(mineflayer.off).toHaveBeenCalled()
  })

  it('matches localized food animals by entity type when attacking nearby targets', async () => {
    const { mineflayer } = createMineflayer()
    mineflayer.bot.entities[7] = {
      id: 7,
      name: 'ウサギ',
      type: 'minecraft:rabbit',
      position: new Vec3(2, 64, 0),
    }
    mineflayer.bot.pvp.attack.mockImplementation(() => {
      delete mineflayer.bot.entities[7]
    })

    const success = await attackNearest(mineflayer, 'animal', true)

    expect(success).toBe(true)
    expect(mineflayer.bot.pvp.attack).toHaveBeenCalledOnce()
  })

  it('prefers non-aquatic animals over fish for generic food attacks', async () => {
    const { mineflayer } = createMineflayer()
    mineflayer.bot.entities[7] = {
      id: 7,
      name: 'サケ',
      type: 'minecraft:salmon',
      position: new Vec3(2, 63, 0),
    }
    mineflayer.bot.entities[8] = {
      id: 8,
      name: 'ウサギ',
      type: 'minecraft:rabbit',
      position: new Vec3(4, 64, 0),
    }
    mineflayer.bot.pvp.attack.mockImplementation((target: { id: number }) => {
      delete mineflayer.bot.entities[target.id]
    })

    const success = await attackNearest(mineflayer, 'animal', true)

    expect(success).toBe(true)
    expect(mineflayer.bot.pvp.attack).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }))
  })

  it('uses swim-aware pursuit for aquatic food targets before attacking', async () => {
    const { mineflayer } = createMineflayer()
    mineflayer.bot.entities[7] = {
      id: 7,
      name: 'サケ',
      type: 'minecraft:salmon',
      position: new Vec3(10, 62, 10),
    }
    mineflayer.bot.blockAt.mockReturnValue({ name: 'water' })
    mineflayer.bot.pathfinder.goto.mockImplementation(async () => {
      mineflayer.bot.entity.position = new Vec3(9, 62, 9)
    })
    mineflayer.bot.pvp.attack.mockImplementation((target: { id: number }) => {
      delete mineflayer.bot.entities[target.id]
    })

    const success = await attackEntity(mineflayer, mineflayer.bot.entities[7], true)

    expect(success).toBe(true)
    expect(mineflayer.bot.pathfinder.goto).toHaveBeenCalledWith(expect.objectContaining({
      movementMode: 'swim',
      timeoutMs: 4000,
    }))
  })
})
