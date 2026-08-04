import { Vec3 } from 'vec3'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@moeru/std', () => ({
  sleep: vi.fn(async () => {}),
}))

const blockAccessMocks = vi.hoisted(() => ({
  getBlockAtAccurate: vi.fn(),
  getNearestBlockAccurate: vi.fn(),
}))

vi.mock('../block-access', () => ({
  getBlockAtAccurate: blockAccessMocks.getBlockAtAccurate,
  getNearestBlockAccurate: blockAccessMocks.getNearestBlockAccurate,
}))

const { getLastPlacedBlockRecord, pickupNearbyItems, placeBlock } = await import('./world-interactions')

describe('pickupNearbyItems', () => {
  it('stops retrying the same unreachable item forever', async () => {
    const item = {
      id: 1,
      name: 'item',
      onGround: true,
      position: new Vec3(2, 64, 2),
    }

    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        nearestEntity: vi.fn((predicate: (entity: any) => boolean) => predicate(item) ? item : null),
        pathfinder: {
          goto: vi.fn(async () => {
            throw new Error('unreachable')
          }),
        },
      },
    } as any

    const success = await pickupNearbyItems(mineflayer, 8)

    expect(success).toBe(true)
    expect(mineflayer.bot.pathfinder.goto).toHaveBeenCalledTimes(1)
  })

  it('recognizes Fabric bridge dropped items by minecraft:item type and localized display name', async () => {
    let itemPresent = true
    const item = {
      id: 2,
      name: '鉄の原石',
      type: 'minecraft:item',
      position: new Vec3(2, 64, 2),
    }

    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        nearestEntity: vi.fn((predicate: (entity: any) => boolean) => itemPresent && predicate(item) ? item : null),
        pathfinder: {
          goto: vi.fn(async () => {
            itemPresent = false
          }),
        },
      },
    } as any

    const success = await pickupNearbyItems(mineflayer, 8)

    expect(success).toBe(true)
    expect(mineflayer.bot.pathfinder.goto).toHaveBeenCalledTimes(1)
  })

  it('refuses to place a requested block when the hand still holds a different item after equip', async () => {
    const target = new Vec3(1, 64, 1)
    const support = new Vec3(1, 63, 1)

    blockAccessMocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, pos: Vec3) => {
      if (pos.equals(target)) {
        return { name: 'air', position: target }
      }
      if (pos.equals(support)) {
        return { name: 'grass_block', position: support }
      }
      return { name: 'air', position: pos }
    })

    const placeBlockImpl = vi.fn(async () => {})
    const mineflayer = {
      bot: {
        game: {
          gameMode: 'survival',
        },
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          selectedSlot: 0,
          slots: [],
          items: vi.fn(() => [
            { name: 'furnace', count: 1 },
            { name: 'dirt', count: 17 },
          ]),
        },
        heldItem: { name: 'dirt', count: 17 },
        equip: vi.fn(async () => {}),
        lookAt: vi.fn(async () => {}),
        placeBlock: placeBlockImpl,
        pathfinder: {
          goto: vi.fn(async () => {}),
        },
      },
    } as any

    const success = await placeBlock(mineflayer, 'furnace', target.x, target.y, target.z)

    expect(success).toBe(false)
    expect(placeBlockImpl).not.toHaveBeenCalled()
    expect(getLastPlacedBlockRecord(mineflayer)).toBeNull()
  })
})
