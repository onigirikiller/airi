import { Vec3 } from 'vec3'
import { describe, expect, it, vi } from 'vitest'

import { getBlockAtAccurate, getNearestBlocksAccurate, getNearestFreeSpaceAccurate, isBlockExposedAccurate } from './block-access'

describe('block access query expansion', () => {
  it('expands generic log queries into concrete block names for async FabricBridge scans', async () => {
    const findBlocksAsync = vi.fn(async ({ blockNames }: { blockNames: string[] }) => {
      expect(blockNames).toContain('oak_log')
      expect(blockNames).toContain('birch_log')
      expect(blockNames).not.toContain('log')
      return [new Vec3(2, 64, 2)]
    })

    const blockAtAsync = vi.fn(async () => ({
      name: 'minecraft:oak_log',
      position: new Vec3(2, 64, 2),
    }))

    const bot = {
      entity: {
        position: new Vec3(0, 64, 0),
      },
      findBlocksAsync,
      blockAtAsync,
    }

    const result = await getNearestBlocksAccurate({ bot } as any, 'log', 32, 8)

    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('minecraft:oak_log')
  })

  it('reuses the sync cache when an async FabricBridge air probe resolves null', async () => {
    let cachedAirVisible = false
    const position = new Vec3(0, 65, 0)
    const blockAtAsync = vi.fn(async () => {
      cachedAirVisible = true
      return null
    })
    const blockAt = vi.fn(() => cachedAirVisible
      ? { name: 'minecraft:air', position }
      : null)

    const bot = {
      blockAtAsync,
      blockAt,
    }

    const block = await getBlockAtAccurate({ bot } as any, position)

    expect(block?.name).toBe('minecraft:air')
    expect(blockAtAsync).toHaveBeenCalledOnce()
    expect(blockAt).toHaveBeenCalledOnce()
  })

  it('treats stone with an adjacent air block as exposed', async () => {
    const blockAtAsync = vi.fn(async (position: Vec3) => {
      if (position.x === 3 && position.y === 64 && position.z === 2) {
        return { name: 'minecraft:air', position }
      }

      return { name: 'minecraft:stone', position }
    })

    const bot = {
      blockAtAsync,
    }

    const exposed = await isBlockExposedAccurate({ bot } as any, new Vec3(2, 64, 2))

    expect(exposed).toBe(true)
  })

  it('treats stone with adjacent water as exposed for mining scans', async () => {
    const blockAtAsync = vi.fn(async (position: Vec3) => {
      if (position.x === 2 && position.y === 65 && position.z === 2) {
        return { name: 'minecraft:water', position }
      }

      return { name: 'minecraft:stone', position }
    })

    const bot = {
      blockAtAsync,
    }

    const exposed = await isBlockExposedAccurate({ bot } as any, new Vec3(2, 64, 2))

    expect(exposed).toBe(true)
  })

  it('does not return the bot body column as free placement space', async () => {
    const blockAtAsync = vi.fn(async (position: Vec3) => {
      const key = `${position.x},${position.y},${position.z}`
      const solidKeys = new Set([
        '0,63,0',
        '1,63,0',
      ])

      if (solidKeys.has(key)) {
        return { name: 'minecraft:stone', position, diggable: true }
      }

      return { name: 'minecraft:air', position }
    })

    const bot = {
      entity: {
        position: new Vec3(0.2, 64, 0.2),
      },
      blockAtAsync,
    }

    const freeSpace = await getNearestFreeSpaceAccurate({ bot } as any, 1, 1)

    expect(freeSpace).toEqual(new Vec3(1, 64, 0))
  })
})
