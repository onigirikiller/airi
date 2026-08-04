import { Vec3 } from 'vec3'
import { describe, expect, it, vi } from 'vitest'

import { getBlockAtAccurate } from './block-access'
import { goToNearestEntity, goToPosition, moveAway, moveToHorizontalTarget, swimTowardPositionManual } from './movement'

vi.mock('./block-access', () => ({
  getBlockAtAccurate: vi.fn(async () => ({ name: 'water' })),
}))

describe('moveAway', () => {
  it('falls back to a deterministic destination after exhausting safe sampling', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'water' } as any)
    const goto = vi.fn(async () => {})
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        blockAt: vi.fn(() => ({ name: 'water' })),
        pathfinder: {
          goto,
        },
      },
    } as any

    const success = await moveAway(mineflayer, 16)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledTimes(1)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 180000,
      movementMode: 'swim',
    }))
  })

  it('caps underground recovery walks with a shorter timeout', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue(null as any)
    const goto = vi.fn(async () => {})
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 56, 0),
        },
        blockAt: vi.fn(() => null),
        pathfinder: {
          goto,
        },
      },
    } as any

    const success = await moveAway(mineflayer, 16)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 20000,
      movementMode: 'walk',
    }))
  })

  it('caps confined recovery walks even when the shaft sits above y60', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'stone' } as any)
    const goto = vi.fn(async () => {})
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        blockAt: vi.fn(() => ({ name: 'stone' })),
        pathfinder: {
          goto,
        },
      },
    } as any

    const success = await moveAway(mineflayer, 16)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 20000,
      movementMode: 'walk',
    }))
  })

  it('caps normal surface recovery walks so pathfinder cannot stall an action indefinitely', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'air' } as any)
    const goto = vi.fn(async () => {})
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        blockAt: vi.fn((position: Vec3) => position.y === 63 ? { name: 'grass_block' } : { name: 'air' }),
        pathfinder: {
          goto,
        },
      },
    } as any

    const success = await moveAway(mineflayer, 16)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 30000,
      movementMode: 'walk',
    }))
  })

  it('refuses blind surface relocation when sampled destinations have no support', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'air' } as any)
    const goto = vi.fn(async () => {})
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        blockAt: vi.fn(() => ({ name: 'air' })),
        pathfinder: {
          goto,
        },
      },
    } as any

    const success = await moveAway(mineflayer, 16)

    expect(success).toBe(false)
    expect(goto).not.toHaveBeenCalled()
  })

  it('stops surface relocation when the bot drops below the safe descent band', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'water' } as any)
      const goto = vi.fn(() => new Promise<void>(() => {}))
      const stop = vi.fn()
      const mineflayer = {
        bot: {
          health: 20,
          chat: vi.fn(),
          entity: {
            position: new Vec3(0, 64, 0),
          },
          blockAt: vi.fn(() => ({ name: 'water' })),
          pathfinder: {
            goto,
            stop,
          },
        },
      } as any

      const successPromise = moveAway(mineflayer, 16)
      await vi.advanceTimersByTimeAsync(1)
      mineflayer.bot.entity.position = new Vec3(0, 60, 0)
      await vi.advanceTimersByTimeAsync(500)

      await expect(successPromise).resolves.toBe(false)
      expect(stop).toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('allows low-health retreat to continue while health remains stable', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'water' } as any)
    const goto = vi.fn(async () => {})
    const stop = vi.fn()
    const mineflayer = {
      bot: {
        health: 6,
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        blockAt: vi.fn(() => ({ name: 'water' })),
        pathfinder: {
          goto,
          stop,
        },
      },
    } as any

    await expect(moveAway(mineflayer, 16)).resolves.toBe(true)
    expect(stop).not.toHaveBeenCalled()
  })
})

describe('goToPosition', () => {
  it('stops normal destination travel when surface health drops sharply', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'air' } as any)
      const goto = vi.fn(() => new Promise<void>(() => {}))
      const stop = vi.fn()
      const mineflayer = {
        allowCheats: false,
        bot: {
          health: 20,
          chat: vi.fn(),
          entity: {
            position: new Vec3(0, 64, 0),
          },
          blockAt: vi.fn((position: Vec3) => position.y === 63 ? { name: 'grass_block' } : { name: 'air' }),
          pathfinder: {
            goto,
            stop,
          },
        },
      } as any

      const successPromise = goToPosition(mineflayer, 12, 64, 0, 4)
      await vi.advanceTimersByTimeAsync(1)
      mineflayer.bot.health = 9
      await vi.advanceTimersByTimeAsync(500)

      await expect(successPromise).resolves.toBe(false)
      expect(stop).toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('moveToHorizontalTarget', () => {
  it('marks horizontal relocation as swim mode when the bot is submerged', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'water' } as any)
    const goto = vi.fn(async () => {})
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        blockAt: vi.fn(() => null),
        pathfinder: {
          goto,
        },
      },
    } as any

    const success = await moveToHorizontalTarget(mineflayer, 24, 12)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 180000,
      movementMode: 'swim',
    }))
  })

  it('caps underground horizontal relocation with the underground timeout', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue(null as any)
    const goto = vi.fn(async () => {})
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 58, 0),
        },
        blockAt: vi.fn(() => null),
        pathfinder: {
          goto,
        },
      },
    } as any

    const success = await moveToHorizontalTarget(mineflayer, 24, 12)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 20000,
      movementMode: 'walk',
    }))
  })

  it('caps confined horizontal relocation even when the bot is near surface y-levels', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'stone' } as any)
    const goto = vi.fn(async () => {})
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        blockAt: vi.fn(() => ({ name: 'stone' })),
        pathfinder: {
          goto,
        },
      },
    } as any

    const success = await moveToHorizontalTarget(mineflayer, 24, 12)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 20000,
      movementMode: 'walk',
    }))
  })

  it('caps normal surface horizontal relocation so wood staging can yield quickly', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'air' } as any)
    const goto = vi.fn(async () => {})
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        blockAt: vi.fn(() => ({ name: 'air' })),
        pathfinder: {
          goto,
        },
      },
    } as any

    const success = await moveToHorizontalTarget(mineflayer, 24, 12)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      x: 24,
      z: 12,
      rangeSq: 9,
      timeoutMs: 30000,
      movementMode: 'walk',
    }))
  })

  it('stops a surface horizontal relocation when pathfinder does not resolve', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'air' } as any)
      const goto = vi.fn(() => new Promise<void>(() => {}))
      const stop = vi.fn()
      const mineflayer = {
        bot: {
          entity: {
            position: new Vec3(0, 64, 0),
          },
          blockAt: vi.fn(() => ({ name: 'air' })),
          pathfinder: {
            goto,
            stop,
          },
        },
      } as any

      const successPromise = moveToHorizontalTarget(mineflayer, 24, 12)
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(successPromise).resolves.toBe(false)
      expect(stop).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('stops surface horizontal relocation when health drops sharply', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'air' } as any)
      const goto = vi.fn(() => new Promise<void>(() => {}))
      const stop = vi.fn()
      const mineflayer = {
        bot: {
          health: 20,
          entity: {
            position: new Vec3(0, 64, 0),
          },
          blockAt: vi.fn((position: Vec3) => position.y === 63 ? { name: 'grass_block' } : { name: 'air' }),
          pathfinder: {
            goto,
            stop,
          },
        },
      } as any

      const successPromise = moveToHorizontalTarget(mineflayer, 24, 12)
      await vi.advanceTimersByTimeAsync(1)
      mineflayer.bot.health = 9
      await vi.advanceTimersByTimeAsync(500)

      await expect(successPromise).resolves.toBe(false)
      expect(stop).toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('goToNearestEntity', () => {
  it('matches food animals by namespaced type when the display name is localized', async () => {
    vi.mocked(getBlockAtAccurate).mockResolvedValue({ name: 'air' } as any)
    const goto = vi.fn(async () => {})
    const entity = {
      name: 'ウサギ',
      type: 'minecraft:rabbit',
      position: new Vec3(10, 64, 0),
    }
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        chat: vi.fn(),
        blockAt: vi.fn(() => null),
        nearestEntity: vi.fn((predicate: (candidate: typeof entity) => boolean) => predicate(entity) ? entity : null),
        pathfinder: {
          goto,
        },
      },
    } as any

    const success = await goToNearestEntity(mineflayer, 'animal', 4, 64)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledOnce()
  })
})

describe('swimTowardPositionManual', () => {
  it('uses direct control states to make progress toward a nearby swim target', async () => {
    const controlStates = new Map<string, boolean>()
    const position = new Vec3(0, 53, 0)
    const mineflayer = {
      bot: {
        entity: {
          position,
          yaw: 0,
        },
        lookAt: vi.fn(async (target: Vec3) => {
          const dx = target.x - position.x
          const dz = target.z - position.z
          if (dx !== 0 || dz !== 0) {
            ;(mineflayer.bot.entity as any).yaw = Math.atan2(-dx, dz)
          }
        }),
        setControlState: vi.fn((control: string, state: boolean) => {
          controlStates.set(control, state)
          if (control === 'forward' && state) {
            position.x += 0.6
            position.y += 0.2
          }
        }),
      },
    } as any

    const reached = await swimTowardPositionManual(mineflayer, 2, 54, 0, {
      timeoutMs: 1000,
      arrivalDistance: 0.8,
    })

    expect(reached).toBe(true)
    expect(mineflayer.bot.lookAt).toHaveBeenCalled()
    expect(controlStates.get('forward')).toBe(false)
    expect(controlStates.get('jump')).toBe(false)
  })
})
