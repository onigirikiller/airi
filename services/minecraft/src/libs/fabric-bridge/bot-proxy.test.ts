import EventEmitter from 'eventemitter3'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getItemId } from '../../utils/mcdata'
import { BotProxy, Vec3Simple } from './bot-proxy'

const sessionResumeMock = vi.hoisted(() => ({
  loaded: null as null | {
    savedAt: number
    items: Array<{
      slot: number
      name: string
      count: number
      maxCount: number
      durability: number
      maxDurability: number
    }>
    armorItems: Array<{
      slot: number
      name: string
      count: number
      maxCount: number
      durability: number
      maxDurability: number
    }>
    offhandItem: null | {
      slot: number
      name: string
      count: number
      maxCount: number
      durability: number
      maxDurability: number
    }
    selectedSlot: number
  },
  saved: [] as Array<{ username: string, snapshot: Record<string, unknown> }>,
  cleared: [] as string[],
}))

vi.mock('./session-resume', () => ({
  loadSessionResumeSnapshot: vi.fn(() => sessionResumeMock.loaded),
  saveSessionResumeSnapshot: vi.fn((username: string, snapshot: Record<string, unknown>) => {
    sessionResumeMock.saved.push({ username, snapshot })
  }),
  clearSessionResumeSnapshot: vi.fn((username: string) => {
    sessionResumeMock.cleared.push(username)
  }),
}))

class MockWsClient extends EventEmitter {
  request = vi.fn(async (_command: string, _params: Record<string, unknown>) => ({}))
  send = vi.fn()
  disconnect = vi.fn()
}

function createProxy() {
  const ws = new MockWsClient()
  const proxy = new BotProxy(ws as any, 'AIRI')
  proxy.entity.position = new Vec3Simple(0, 64, 0)
  return { proxy, ws }
}

beforeEach(() => {
  sessionResumeMock.loaded = null
  sessionResumeMock.saved = []
  sessionResumeMock.cleared = []
})

describe('botProxy block cache', () => {
  it('clones bridge positions with Vec3-compatible semantics', () => {
    const position = new Vec3Simple(12.5, 64, -3.25)

    const cloned = position.clone()

    expect(cloned).not.toBe(position)
    expect(cloned).toEqual(position)
    expect(cloned.distanceTo(position)).toBe(0)
  })

  it('evicts stale scanned blocks that no longer exist nearby', async () => {
    const { proxy, ws } = createProxy()
    ;(proxy as any).cacheBlockAt(new Vec3Simple(5, 64, 5), 'minecraft:oak_log')

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'findBlocks') {
        return { positions: [] }
      }
      return {}
    })

    await proxy.scanNearbyBlocks(32, ['oak_log'])

    expect((proxy as any).blockCache.has('5,64,5')).toBe(false)
  })

  it('namespaces async block queries for the Fabric bridge block scanner', async () => {
    const { proxy, ws } = createProxy()

    ws.request.mockImplementation(async (command: string, params: Record<string, unknown>, timeout?: number) => {
      if (command === 'findBlocks') {
        expect(params).toMatchObject({
          block: 'minecraft:stone',
          maxDistance: 24,
          count: 5,
        })
        expect(timeout).toBe(1500)
        return {
          positions: [{ x: 3, y: 64, z: 7 }],
        }
      }
      return {}
    })

    const positions = await proxy.findBlocksAsync({
      matching: 0,
      maxDistance: 24,
      count: 5,
      blockNames: ['stone'],
    })

    expect(positions).toHaveLength(1)
    expect(positions[0]).toEqual(new Vec3Simple(3, 64, 7))
  })

  it('continues async block queries after a stalled block request times out', async () => {
    const { proxy, ws } = createProxy()

    ws.request.mockImplementation(async (_command: string, params: Record<string, unknown>, timeout?: number) => {
      expect(timeout).toBe(1500)
      if (params.block === 'minecraft:stone') {
        throw new Error('Request timed out: findBlocks (req_1)')
      }
      if (params.block === 'minecraft:dirt') {
        return {
          positions: [{ x: 2, y: 64, z: 1 }],
        }
      }
      return {
        positions: [],
      }
    })

    const positions = await proxy.findBlocksAsync({
      matching: 0,
      maxDistance: 24,
      count: 5,
      blockNames: ['stone', 'dirt'],
    })

    expect(positions).toEqual([new Vec3Simple(2, 64, 1)])
    expect(ws.request).toHaveBeenCalledTimes(2)
  })

  it('falls back to a tracked matching tool when canonical auto-equip points at a stale tool', async () => {
    const { proxy, ws } = createProxy()
    const woodenPickaxe = {
      slot: 6,
      name: 'minecraft:wooden_pickaxe',
      count: 1,
      maxCount: 1,
      durability: 40,
      maxDurability: 59,
    }
    ;(proxy as any).strictRawInventoryItems = [{
      slot: 5,
      name: 'minecraft:stone_pickaxe',
      count: 1,
      maxCount: 1,
      durability: 80,
      maxDurability: 131,
    }]
    ;(proxy as any).rawInventoryItems = [{
      slot: 5,
      name: 'minecraft:stone_pickaxe',
      count: 1,
      maxCount: 1,
      durability: 80,
      maxDurability: 131,
    }]
    ;(proxy as any).inventoryItems = [woodenPickaxe]

    ws.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'equip') {
        if (params.item === 'stone_pickaxe') {
          throw new Error('Item not found in inventory: stone_pickaxe')
        }
        if (params.item === 'wooden_pickaxe') {
          return { items: [woodenPickaxe], selectedSlot: 6 }
        }
      }
      if (command === 'getInventory') {
        return { items: [woodenPickaxe], selectedSlot: 6 }
      }
      return {}
    })

    await proxy.tool.equipForBlock({ name: 'coal_ore' })

    expect(ws.request).toHaveBeenCalledWith('equip', { item: 'stone_pickaxe', slot: 'hand' })
    expect(ws.request).toHaveBeenCalledWith('equip', { item: 'wooden_pickaxe', slot: 'hand' })
    expect(proxy.heldItem?.name).toBe('wooden_pickaxe')
  })

  it('does not equip a pickaxe as an axe fallback for hand-collectible logs', async () => {
    const { proxy, ws } = createProxy()
    ;(proxy as any).inventoryItems = [{
      slot: 5,
      name: 'minecraft:wooden_pickaxe',
      count: 1,
      maxCount: 1,
      durability: 40,
      maxDurability: 59,
    }]

    await proxy.tool.equipForBlock({ name: 'oak_log' })

    expect(ws.request).not.toHaveBeenCalledWith('equip', expect.anything())
  })

  it('hydrates entity refreshes with Vec3-compatible positions', async () => {
    const { proxy, ws } = createProxy()

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'getEntities') {
        return {
          entities: [
            {
              id: 11,
              type: 'minecraft:pig',
              name: 'ブタ',
              x: 3,
              y: 65,
              z: -2,
              distance: 4.5,
              isHostile: false,
              isPassive: true,
              isPlayer: false,
            },
          ],
        }
      }
      return {}
    })

    await proxy.refreshEntities(32)

    expect(proxy.entities[11]?.position).toEqual(new Vec3Simple(3, 65, -2))
    expect(proxy.entities[11]?.position.distanceTo(new Vec3Simple(0, 64, 0))).toBeGreaterThan(0)
  })

  it('marks dug blocks as air in the cache', async () => {
    const { proxy, ws } = createProxy()
    ws.request.mockImplementation(async (command: string) => {
      if (command === 'dig') {
        return {}
      }
      if (command === 'blockAt') {
        return {
          name: 'minecraft:air',
          isAir: true,
          isSolid: false,
          position: { x: 1, y: 65, z: 2 },
        }
      }
      return {}
    })

    await proxy.dig({ position: new Vec3Simple(1, 65, 2) } as any)

    expect(proxy.blockAt(new Vec3Simple(1, 65, 2))?.name).toBe('air')
  })

  it('keeps issuing dig commands until the block is actually gone', async () => {
    const { proxy, ws } = createProxy()
    let blockChecks = 0
    ;(proxy as any).digAttemptIntervalMs = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'dig') {
        return {}
      }
      if (command === 'blockAt') {
        blockChecks++
        if (blockChecks < 3) {
          return {
            name: 'minecraft:oak_log',
            isAir: false,
            isSolid: true,
            position: { x: 1, y: 65, z: 2 },
          }
        }
        return {
          name: 'minecraft:air',
          isAir: true,
          isSolid: false,
          position: { x: 1, y: 65, z: 2 },
        }
      }
      return {}
    })

    await proxy.dig({ position: new Vec3Simple(1, 65, 2) } as any)

    expect(ws.request.mock.calls.filter(([command]) => command === 'dig')).toHaveLength(3)
    expect(proxy.blockAt(new Vec3Simple(1, 65, 2))?.name).toBe('air')
  })

  it('fails dig requests that never result in an actual block break', async () => {
    const { proxy, ws } = createProxy()
    ;(proxy as any).digAttemptIntervalMs = 0
    ;(proxy as any).digCompletionTimeoutMs = 5

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'dig') {
        return {}
      }
      if (command === 'blockAt') {
        return {
          name: 'minecraft:oak_log',
          isAir: false,
          isSolid: true,
          position: { x: 1, y: 65, z: 2 },
        }
      }
      return {}
    })

    await expect(proxy.dig({ position: new Vec3Simple(1, 65, 2) } as any))
      .rejects
      .toThrow('Digging timed out at 1, 65, 2')
  })

  it('updates the placed block position in the cache', async () => {
    const { proxy, ws } = createProxy()
    ws.request.mockResolvedValue({})
    ;(proxy as any).inventoryItems = [{
      slot: 0,
      name: 'minecraft:torch',
      count: 1,
      maxCount: 64,
      durability: 0,
      maxDurability: 0,
    }]
    ;(proxy as any).selectedSlot = 0

    await proxy.placeBlock(
      { position: new Vec3Simple(10, 64, 10) } as any,
      new Vec3Simple(0, 1, 0),
    )

    expect(proxy.blockAt(new Vec3Simple(10, 65, 10))?.name).toBe('torch')
  })

  it('queries recipes using item names instead of numeric ids', async () => {
    const { proxy, ws } = createProxy()
    ws.request.mockResolvedValue({
      recipes: [
        { output: 'minecraft:birch_planks' },
      ],
    })

    const recipes = await proxy.recipesFor(getItemId('birch_planks'), null, 1, null)

    expect(ws.request).toHaveBeenCalledWith('recipesFor', { item: 'birch_planks' })
    expect(recipes).toEqual(['birch_planks'])
  })

  it('can read a raw inventory snapshot without mutating the cached inventory', async () => {
    const { proxy, ws } = createProxy()
    ;(proxy as any).inventoryItems = [{
      slot: 9,
      name: 'minecraft:birch_planks',
      count: 6,
      maxCount: 64,
      durability: 0,
      maxDurability: 0,
    }]
    ws.request.mockResolvedValue({
      items: [{
        slot: 9,
        name: 'minecraft:birch_planks',
        count: 2,
        maxCount: 64,
        durability: 0,
        maxDurability: 0,
      }],
      selectedSlot: 0,
    })

    const snapshot = await proxy.getInventorySnapshot()

    expect(snapshot.items?.[0]?.count).toBe(2)
    expect(proxy.inventory.items()[0]?.count).toBe(2)
  })

  it('returns a guarded inventory snapshot when getInventory regresses a recent craft', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 1,
          item: 'minecraft:wooden_pickaxe',
          inventory: [
            {
              slot: 11,
              name: 'minecraft:wooden_pickaxe',
              count: 1,
              maxCount: 1,
              durability: 0,
              maxDurability: 59,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'getInventory') {
        inventoryReads++
        if (inventoryReads === 1) {
          return {
            items: [
              {
                slot: 9,
                name: 'minecraft:oak_log',
                count: 3,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 3,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('wooden_pickaxe', 1)
    const snapshot = await proxy.getInventorySnapshot()

    expect(snapshot.items?.find(item => item.name === 'minecraft:wooden_pickaxe')?.count).toBe(1)
    expect(proxy.inventory.items().find(item => item.name === 'wooden_pickaxe')?.count ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('preserves multiple recent crafted items when a later stale inventory refresh regresses an earlier craft', async () => {
    const { proxy, ws } = createProxy()
    let craftCalls = 0
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'craft') {
        craftCalls++
        if (craftCalls === 1) {
          expect(params).toMatchObject({ item: 'minecraft:oak_planks', count: 1 })
          return {
            crafted: 4,
            item: 'minecraft:oak_planks',
            inventory: [
              {
                slot: 9,
                name: 'minecraft:oak_planks',
                count: 4,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        expect(params).toMatchObject({ item: 'minecraft:stick', count: 1 })
        return {
          crafted: 4,
          item: 'minecraft:stick',
          inventory: [
            {
              slot: 10,
              name: 'minecraft:stick',
              count: 4,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      if (command === 'getInventory') {
        inventoryReads++
        if (inventoryReads === 1) {
          return {
            items: [
              {
                slot: 9,
                name: 'minecraft:oak_log',
                count: 1,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        if (inventoryReads === 2 || inventoryReads === 3) {
          return {
            items: [
              {
                slot: 9,
                name: 'minecraft:oak_planks',
                count: 4,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        return {
          items: [
            {
              slot: 10,
              name: 'minecraft:stick',
              count: 4,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      return {}
    })

    await proxy.craft('oak_planks', 1)
    await proxy.craft('stick', 1)
    const snapshot = await proxy.getInventorySnapshot()

    expect(snapshot.items?.find(item => item.name === 'minecraft:oak_planks')?.count).toBe(2)
    expect(snapshot.items?.find(item => item.name === 'minecraft:stick')?.count).toBe(4)
    expect(proxy.inventory.items().find(item => item.name === 'oak_planks')?.count).toBe(2)
    expect(proxy.inventory.items().find(item => item.name === 'stick')?.count).toBe(4)
  })

  it('keeps confirmed raw inventory craft results when a later stale refresh drops one of the chained outputs', async () => {
    const { proxy, ws } = createProxy()
    let craftCalls = 0
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'craft') {
        craftCalls++
        if (craftCalls === 1) {
          expect(params).toMatchObject({ item: 'minecraft:oak_planks', count: 1 })
          return {
            crafted: 4,
            item: 'minecraft:oak_planks',
            inventory: [
              {
                slot: 9,
                name: 'minecraft:oak_planks',
                count: 4,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        expect(params).toMatchObject({ item: 'minecraft:stick', count: 1 })
        return {
          crafted: 4,
          item: 'minecraft:stick',
          inventory: [
            {
              slot: 10,
              name: 'minecraft:stick',
              count: 4,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      if (command === 'getInventory') {
        inventoryReads++
        if (inventoryReads === 1) {
          return {
            items: [
              {
                slot: 8,
                name: 'minecraft:oak_log',
                count: 1,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        if (inventoryReads === 2 || inventoryReads === 3) {
          return {
            items: [
              {
                slot: 9,
                name: 'minecraft:oak_planks',
                count: 4,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        return {
          items: [
            {
              slot: 10,
              name: 'minecraft:stick',
              count: 4,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      return {}
    })

    await proxy.craft('oak_planks', 1)
    await proxy.craft('stick', 1)
    await proxy.refreshInventory()

    const rawItems = proxy.getRawInventoryItems()
    const strictRawItems = proxy.getStrictRawInventoryItems()
    expect(rawItems.find(item => item.name === 'minecraft:oak_planks')?.count).toBe(2)
    expect(rawItems.find(item => item.name === 'minecraft:stick')?.count).toBe(4)
    expect(strictRawItems.find(item => item.name === 'minecraft:oak_planks')).toBeUndefined()
    expect(strictRawItems.find(item => item.name === 'minecraft:stick')?.count).toBe(4)
  })

  it('preserves the remaining recent craft inputs when a later craft refresh omits them after one good snapshot', async () => {
    const { proxy, ws } = createProxy()
    let craftCalls = 0
    let inventoryReads = 0

    const oakLogId = getItemId('oak_log')
    const oakPlanksId = getItemId('oak_planks')
    const stickId = getItemId('stick')
    const oakPlanksRecipe = {
      output: 'minecraft:oak_planks',
      delta: [
        { id: oakLogId, count: -1, metadata: 0 },
        { id: oakPlanksId, count: 4, metadata: 0 },
      ],
      result: { id: oakPlanksId, count: 4 },
    }
    const stickRecipe = {
      output: 'minecraft:stick',
      delta: [
        { id: oakPlanksId, count: -2, metadata: 0 },
        { id: stickId, count: 4, metadata: 0 },
      ],
      result: { id: stickId, count: 4 },
    }

    ws.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'craft') {
        craftCalls++
        if (craftCalls === 1) {
          expect(params).toMatchObject({ item: 'minecraft:oak_planks', count: 1 })
          return {
            crafted: 4,
            item: 'minecraft:oak_planks',
            inventory: [
              {
                slot: 10,
                name: 'minecraft:oak_planks',
                count: 4,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        expect(params).toMatchObject({ item: 'minecraft:stick', count: 1 })
        return {
          crafted: 4,
          item: 'minecraft:stick',
          inventory: [
            {
              slot: 11,
              name: 'minecraft:stick',
              count: 4,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      if (command === 'getInventory') {
        inventoryReads++
        if (inventoryReads === 1) {
          return {
            items: [
              {
                slot: 9,
                name: 'minecraft:oak_log',
                count: 1,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        if (inventoryReads === 2 || inventoryReads === 3) {
          return {
            items: [
              {
                slot: 10,
                name: 'minecraft:oak_planks',
                count: 4,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        return {
          items: [
            {
              slot: 11,
              name: 'minecraft:stick',
              count: 4,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      return {}
    })

    await proxy.craft(oakPlanksRecipe as any, 1)
    await proxy.craft(stickRecipe as any, 1)
    await proxy.refreshInventory()

    expect(proxy.inventory.items().find(item => item.name === 'oak_planks')?.count).toBe(2)
    expect(proxy.inventory.items().find(item => item.name === 'stick')?.count).toBe(4)
  })

  it('uses strict raw inventory as the pre-craft baseline instead of a guarded cached count', async () => {
    const { proxy, ws } = createProxy()
    ;(proxy as any).strictRawInventoryItems = [
      {
        slot: 9,
        name: 'minecraft:oak_planks',
        count: 10,
        maxCount: 64,
        durability: 0,
        maxDurability: 0,
      },
    ]
    ;(proxy as any).rawInventoryItems = [
      {
        slot: 9,
        name: 'minecraft:oak_planks',
        count: 14,
        maxCount: 64,
        durability: 0,
        maxDurability: 0,
      },
    ]
    ;(proxy as any).inventoryItems = [
      {
        slot: 9,
        name: 'minecraft:oak_planks',
        count: 14,
        maxCount: 64,
        durability: 0,
        maxDurability: 0,
      },
    ]
    ;(proxy as any).rememberRecentCraftInventory('oak_planks', 14, {
      confirmedByBridgeInventory: true,
    })

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 4,
          item: 'minecraft:oak_planks',
          inventory: [
            {
              slot: 9,
              name: 'minecraft:oak_planks',
              count: 14,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      if (command === 'getInventory') {
        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_planks',
              count: 14,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      return {}
    })

    await proxy.craft('oak_planks', 1)

    expect(proxy.getStrictRawInventoryItems().find(item => item.name === 'minecraft:oak_planks')?.count).toBe(14)
    expect(proxy.getRawInventoryItems().find(item => item.name === 'minecraft:oak_planks')?.count).toBe(14)
  })

  it('crafts by resolved output item name for FabricBridge recipe descriptors', async () => {
    const { proxy, ws } = createProxy()
    ws.request.mockResolvedValue({
      crafted: 8,
      inventory: [
        {
          slot: 9,
          name: 'minecraft:birch_planks',
          count: 4,
          maxCount: 64,
          durability: 0,
          maxDurability: 0,
        },
      ],
      selectedSlot: 1,
    })

    await proxy.craft({ id: 'minecraft:oak_planks', output: 'minecraft:birch_planks' }, 2)

    expect(ws.request).toHaveBeenCalledWith('craft', { item: 'minecraft:birch_planks', count: 2 })
    expect(proxy.inventory.items()[0]?.name).toBe('birch_planks')
    expect(proxy.inventory.selectedSlot).toBe(1)
  })

  it('throws when the Fabric bridge reports a craft error instead of fabricating success', async () => {
    const { proxy, ws } = createProxy()
    ws.request.mockResolvedValue({
      status: 'error',
      message: 'Not enough materials for: minecraft:sticky_piston',
    })

    await expect(proxy.craft('sticky_piston', 1)).rejects.toThrow(
      'Not enough materials for: minecraft:sticky_piston',
    )
    expect(proxy.inventory.items()).toHaveLength(0)
  })

  it('retries craft requests without a namespace when the bridge rejects the namespaced target', async () => {
    const { proxy, ws } = createProxy()

    ws.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'getInventory') {
        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 1,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'craft') {
        if (params.item === 'minecraft:oak_planks') {
          return {
            status: 'error',
            message: 'Crafting grid did not produce output for: minecraft:oak_planks (recipeFill=false)',
          }
        }
        if (params.item === 'oak_planks') {
          return {
            crafted: 4,
            item: 'minecraft:oak_planks',
            inventory: [
              {
                slot: 9,
                name: 'minecraft:oak_planks',
                count: 4,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }
      }
      return {}
    })

    await proxy.craft('oak_planks', 1)

    expect(ws.request).toHaveBeenCalledWith('craft', { item: 'minecraft:oak_planks', count: 1 })
    expect(ws.request).toHaveBeenCalledWith('craft', { item: 'oak_planks', count: 1 })
    expect(proxy.inventory.items().find(item => item.name === 'oak_planks')?.count).toBe(4)
  })

  it('retries craft requests without a namespace when the bridge falsely reports missing materials', async () => {
    const { proxy, ws } = createProxy()

    ws.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'getInventory') {
        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 1,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'craft') {
        if (params.item === 'minecraft:oak_planks') {
          return {
            status: 'error',
            message: 'Not enough materials for: minecraft:oak_planks',
          }
        }
        if (params.item === 'oak_planks') {
          return {
            crafted: 4,
            item: 'minecraft:oak_planks',
            inventory: [
              {
                slot: 9,
                name: 'minecraft:oak_planks',
                count: 4,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }
      }
      return {}
    })

    await proxy.craft('oak_planks', 1)

    expect(ws.request).toHaveBeenCalledWith('craft', { item: 'minecraft:oak_planks', count: 1 })
    expect(ws.request).toHaveBeenCalledWith('craft', { item: 'oak_planks', count: 1 })
    expect(proxy.inventory.items().find(item => item.name === 'oak_planks')?.count).toBe(4)
  })

  it('preserves crafting table coordinates when retrying a 3x3 craft without a namespace', async () => {
    const { proxy, ws } = createProxy()
    const craftingTable = {
      position: new Vec3Simple(3, 64, 4),
    }

    ws.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'getInventory') {
        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_planks',
              count: 3,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
            {
              slot: 10,
              name: 'minecraft:stick',
              count: 2,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'craft') {
        if (params.item === 'minecraft:wooden_pickaxe') {
          expect(params).toMatchObject({
            item: 'minecraft:wooden_pickaxe',
            count: 1,
            craftingTable: { x: 3, y: 64, z: 4 },
          })
          return {
            status: 'error',
            message: 'Not enough materials for: minecraft:wooden_pickaxe',
          }
        }
        if (params.item === 'wooden_pickaxe') {
          expect(params).toMatchObject({
            item: 'wooden_pickaxe',
            count: 1,
            craftingTable: { x: 3, y: 64, z: 4 },
          })
          return {
            crafted: 1,
            item: 'minecraft:wooden_pickaxe',
            inventory: [
              {
                slot: 11,
                name: 'minecraft:wooden_pickaxe',
                count: 1,
                maxCount: 1,
                durability: 0,
                maxDurability: 59,
              },
            ],
            selectedSlot: 0,
          }
        }
      }
      return {}
    })

    await proxy.craft('wooden_pickaxe', 1, craftingTable as any)

    expect(ws.request).toHaveBeenCalledWith('craft', {
      item: 'minecraft:wooden_pickaxe',
      count: 1,
      craftingTable: { x: 3, y: 64, z: 4 },
    })
    expect(ws.request).toHaveBeenCalledWith('craft', {
      item: 'wooden_pickaxe',
      count: 1,
      craftingTable: { x: 3, y: 64, z: 4 },
    })
    expect(proxy.inventory.items().find(item => item.name === 'wooden_pickaxe')?.count).toBe(1)
  })

  it('refreshes inventory after crafting so bridge state wins over stale craft snapshots', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 1,
          item: 'minecraft:crafting_table',
          inventory: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 2,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
        }
      }
      if (command === 'getInventory') {
        inventoryReads++
        // First call is pre-craft refresh (return empty/stale state),
        // second call is post-craft reconcile (return real state)
        if (inventoryReads <= 1) {
          return { items: [], selectedSlot: 0 }
        }
        return {
          items: [
            {
              slot: 11,
              name: 'minecraft:crafting_table',
              count: 1,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('crafting_table', 1)

    expect(proxy.inventory.items().find(item => item.name === 'crafting_table')?.count).toBe(1)
    expect(inventoryReads).toBeGreaterThanOrEqual(2)
  })

  it('keeps the craft response inventory when the immediate refresh is older than the craft result', async () => {
    const { proxy, ws } = createProxy()
    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 4,
          item: 'minecraft:birch_planks',
          inventory: [
            {
              slot: 9,
              name: 'minecraft:birch_planks',
              count: 4,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
        }
      }
      if (command === 'getInventory') {
        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:birch_log',
              count: 1,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('birch_planks', 1)

    expect(proxy.inventory.items().find(item => item.name === 'birch_planks')?.count).toBe(4)
  })

  it('consumes stale plank guards after a later string-only craft spends them', async () => {
    const { proxy, ws } = createProxy()
    let oakPlanksCrafted = false

    ws.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'getInventory') {
        if (!oakPlanksCrafted) {
          return {
            items: [
              {
                slot: 9,
                name: 'minecraft:oak_log',
                count: 1,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        return {
          items: [
            {
              slot: 11,
              name: 'minecraft:crafting_table',
              count: 1,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      if (command === 'craft' && params.item === 'minecraft:oak_planks') {
        oakPlanksCrafted = true
        return {
          crafted: 4,
          item: 'minecraft:oak_planks',
          inventory: [
            {
              slot: 9,
              name: 'minecraft:oak_planks',
              count: 4,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      if (command === 'craft' && params.item === 'minecraft:crafting_table') {
        return {
          crafted: 1,
          item: 'minecraft:crafting_table',
          inventory: [
            {
              slot: 11,
              name: 'minecraft:crafting_table',
              count: 1,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      return {}
    })

    await proxy.craft('oak_planks', 1)
    proxy.confirmVisibleInventoryItem('oak_planks', 4)

    await proxy.craft('crafting_table', 1)

    expect(proxy.inventory.items().find(item => item.name === 'oak_planks')).toBeUndefined()
    expect(proxy.inventory.items().find(item => item.name === 'crafting_table')?.count).toBe(2)
  })

  it('restores the crafted item when a stale inventory push races before the recent-craft guard is armed', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 1,
          item: 'minecraft:crafting_table',
          inventory: [
            {
              slot: 11,
              name: 'minecraft:crafting_table',
              count: 1,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'getInventory') {
        inventoryReads++
        if (inventoryReads === 2) {
          ws.emit('event', {
            type: 'state:inventory',
            data: {
              items: [
                {
                  slot: 9,
                  name: 'minecraft:oak_log',
                  count: 2,
                  maxCount: 64,
                  durability: 0,
                  maxDurability: 0,
                },
              ],
              selectedSlot: 0,
            },
          })
        }

        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 2,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('crafting_table', 1)
    await proxy.refreshInventory()

    expect(proxy.inventory.items().find(item => item.name === 'crafting_table')?.count).toBe(1)
  })

  it('does not let a later stale refresh erase a recently crafted tool', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 1,
          item: 'minecraft:wooden_pickaxe',
          inventory: [
            {
              slot: 11,
              name: 'minecraft:wooden_pickaxe',
              count: 1,
              maxCount: 1,
              durability: 0,
              maxDurability: 59,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'getInventory') {
        inventoryReads++
        if (inventoryReads === 1) {
          return {
            items: [
              {
                slot: 9,
                name: 'minecraft:oak_log',
                count: 3,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 3,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('wooden_pickaxe', 1)
    await proxy.refreshInventory()

    expect(proxy.inventory.items().find(item => item.name === 'wooden_pickaxe')?.count ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('does not expose craft-response-only tool outputs through raw inventory reads', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 1,
          item: 'minecraft:wooden_pickaxe',
          inventory: [
            {
              slot: 11,
              name: 'minecraft:wooden_pickaxe',
              count: 1,
              maxCount: 1,
              durability: 0,
              maxDurability: 59,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'getInventory') {
        inventoryReads++
        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 3,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('wooden_pickaxe', 1)
    await proxy.refreshInventory()

    expect(inventoryReads).toBeGreaterThanOrEqual(2)
    expect(proxy.inventory.items().find(item => item.name === 'wooden_pickaxe')?.count).toBe(1)
    expect(proxy.getRawInventoryItems().find(item => item.name === 'minecraft:wooden_pickaxe')).toBeUndefined()
  })

  it('keeps a recently crafted tool when only the post-craft refresh advanced the inventory', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 1,
          item: 'minecraft:wooden_pickaxe',
          inventory: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 3,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'getInventory') {
        inventoryReads++
        if (inventoryReads <= 2) {
          return {
            items: [
              {
                slot: 11,
                name: 'minecraft:wooden_pickaxe',
                count: 1,
                maxCount: 1,
                durability: 0,
                maxDurability: 59,
              },
            ],
            selectedSlot: 0,
          }
        }

        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 3,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('wooden_pickaxe', 1)
    await proxy.refreshInventory()

    expect(proxy.inventory.items().find(item => item.name === 'wooden_pickaxe')?.count ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('does not let a stale state inventory push erase a recently crafted tool', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 1,
          item: 'minecraft:wooden_pickaxe',
          inventory: [
            {
              slot: 11,
              name: 'minecraft:wooden_pickaxe',
              count: 1,
              maxCount: 1,
              durability: 0,
              maxDurability: 59,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'getInventory') {
        inventoryReads++
        if (inventoryReads === 1) {
          return {
            items: [
              {
                slot: 9,
                name: 'minecraft:oak_log',
                count: 3,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        return {
          items: [
            {
              slot: 11,
              name: 'minecraft:wooden_pickaxe',
              count: 1,
              maxCount: 1,
              durability: 0,
              maxDurability: 59,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('wooden_pickaxe', 1)
    ws.emit('event', {
      type: 'state:inventory',
      data: {
        items: [
          {
            slot: 9,
            name: 'minecraft:oak_log',
            count: 3,
            maxCount: 64,
            durability: 0,
            maxDurability: 0,
          },
        ],
        selectedSlot: 0,
      },
    })

    expect(proxy.inventory.items().find(item => item.name === 'wooden_pickaxe')?.count).toBe(1)
  })

  it('synthesizes crafted inventory state when craft succeeds but both inventory snapshots stay stale', async () => {
    const { proxy, ws } = createProxy()

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 1,
          item: 'minecraft:wooden_pickaxe',
        }
      }
      if (command === 'getInventory') {
        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 3,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('wooden_pickaxe', 1)
    await proxy.refreshInventory()

    expect(proxy.inventory.items().find(item => item.name === 'wooden_pickaxe')?.count).toBe(1)
  })

  it('does not expose speculative recent-craft synthesis through raw inventory reads', async () => {
    const { proxy, ws } = createProxy()

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 1,
          item: 'minecraft:wooden_pickaxe',
        }
      }
      if (command === 'getInventory') {
        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 3,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('wooden_pickaxe', 1)
    await proxy.refreshInventory()

    expect(proxy.inventory.items().find(item => item.name === 'wooden_pickaxe')?.count).toBe(1)
    expect(proxy.getRawInventoryItems().find(item => item.name === 'minecraft:wooden_pickaxe')).toBeUndefined()
  })

  it('keeps guarded crafted inventory through stale refreshes beyond one runner loop', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-03T02:43:39.000Z'))

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 1,
          item: 'minecraft:wooden_pickaxe',
          inventory: [
            {
              slot: 11,
              name: 'minecraft:wooden_pickaxe',
              count: 1,
              maxCount: 1,
              durability: 0,
              maxDurability: 59,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'getInventory') {
        inventoryReads++
        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_log',
              count: 3,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    try {
      await proxy.craft('wooden_pickaxe', 1)
      vi.setSystemTime(new Date('2026-03-03T02:44:39.000Z'))

      await proxy.refreshInventory()

      expect(inventoryReads).toBeGreaterThanOrEqual(2)
      expect(proxy.inventory.items().find(item => item.name === 'wooden_pickaxe')?.count).toBe(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps a locally confirmed inventory-only craft through later stale refreshes after earlier good snapshots', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'craft') {
        return {
          crafted: 4,
          item: 'minecraft:stick',
          inventory: [
            {
              slot: 10,
              name: 'minecraft:stick',
              count: 4,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      if (command === 'getInventory') {
        inventoryReads++
        if (inventoryReads === 1) {
          return {
            items: [
              {
                slot: 9,
                name: 'minecraft:oak_planks',
                count: 2,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        if (inventoryReads <= 4) {
          return {
            items: [
              {
                slot: 10,
                name: 'minecraft:stick',
                count: 4,
                maxCount: 64,
                durability: 0,
                maxDurability: 0,
              },
            ],
            selectedSlot: 0,
          }
        }

        return {
          items: [
            {
              slot: 9,
              name: 'minecraft:oak_planks',
              count: 2,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }
      return {}
    })

    await proxy.craft('stick', 1)
    proxy.confirmVisibleInventoryItem('stick', 4)
    await proxy.refreshInventory()
    await proxy.refreshInventory()
    await proxy.refreshInventory()

    expect(inventoryReads).toBeGreaterThanOrEqual(5)
    expect(proxy.inventory.items().find(item => item.name === 'stick')?.count).toBe(4)
    expect(proxy.getRawInventoryItems().find(item => item.name === 'minecraft:stick')?.count).toBe(4)
  })

  it('refreshes inventory explicitly from the bridge when requested', async () => {
    const { proxy, ws } = createProxy()
    ws.request.mockResolvedValue({
      items: [
        {
          slot: 11,
          name: 'minecraft:crafting_table',
          count: 1,
          maxCount: 64,
          durability: 0,
          maxDurability: 0,
        },
      ],
      selectedSlot: 2,
    })

    await proxy.refreshInventory()

    expect(ws.request).toHaveBeenCalledWith('getInventory', {})
    expect(proxy.inventory.items()[0]?.name).toBe('crafting_table')
    expect(proxy.inventory.selectedSlot).toBe(2)
  })

  it('preserves the last visible inventory through a transient empty bridge refresh', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command !== 'getInventory') {
        return {}
      }

      inventoryReads++
      if (inventoryReads === 1) {
        return {
          items: [
            {
              slot: 11,
              name: 'minecraft:birch_log',
              count: 5,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      return {
        items: [],
        selectedSlot: 0,
      }
    })

    await proxy.refreshInventory()
    await proxy.refreshInventory()

    expect(proxy.inventory.items().find(item => item.name === 'birch_log')?.count).toBe(5)
    expect(proxy.getStrictRawInventoryItems().find(item => item.name === 'minecraft:birch_log')?.count).toBe(5)
  })

  it('clears recent craft guards after a death event so respawn inventory is not resurrected', async () => {
    const { proxy, ws } = createProxy()
    proxy.confirmVisibleInventoryItem('crafting_table', 1)
    proxy.confirmVisibleInventoryItem('oak_planks', 6)

    ws.request.mockResolvedValue({
      items: [],
      selectedSlot: 0,
    })

    ws.emit('event', {
      type: 'event:death',
      data: {},
    })
    await proxy.refreshInventory()

    expect(proxy.inventory.items()).toHaveLength(0)
    expect(proxy.getRawInventoryItems()).toHaveLength(0)
    expect(proxy.getStrictRawInventoryItems()).toHaveLength(0)
    expect(sessionResumeMock.cleared).toContain('AIRI')
  })

  it('clears recent craft guards when a health snapshot reports death before the death event arrives', async () => {
    const { proxy, ws } = createProxy()
    proxy.confirmVisibleInventoryItem('stick', 4)
    proxy.confirmVisibleInventoryItem('crafting_table', 1)

    ws.request.mockResolvedValue({
      items: [],
      selectedSlot: 0,
    })

    ws.emit('event', {
      type: 'state:health',
      data: {
        health: 0,
        food: 0,
      },
    })
    await proxy.refreshInventory()

    expect(proxy.inventory.items()).toHaveLength(0)
    expect(proxy.getRawInventoryItems()).toHaveLength(0)
    expect(proxy.getStrictRawInventoryItems()).toHaveLength(0)
  })

  it('restores a recent persisted inventory snapshot before the bridge publishes a fresh one', () => {
    sessionResumeMock.loaded = {
      savedAt: Date.now(),
      items: [{
        slot: 11,
        name: 'minecraft:iron_pickaxe',
        count: 1,
        maxCount: 1,
        durability: 180,
        maxDurability: 250,
      }],
      armorItems: [{
        slot: 39,
        name: 'minecraft:iron_helmet',
        count: 1,
        maxCount: 1,
        durability: 120,
        maxDurability: 165,
      }],
      offhandItem: {
        slot: 40,
        name: 'minecraft:shield',
        count: 1,
        maxCount: 1,
        durability: 250,
        maxDurability: 336,
      },
      selectedSlot: 2,
    }

    const { proxy } = createProxy()
    const snapshot = proxy.getCanonicalInventorySnapshot()

    expect(snapshot.slots.find(slot => slot.itemName === 'iron_pickaxe')?.slotIndex).toBe(11)
    expect(snapshot.armor[0]?.itemName).toBe('iron_helmet')
    expect(snapshot.offhand?.itemName).toBe('shield')
    expect(proxy.inventory.selectedSlot).toBe(2)
  })

  it('preserves visible inventory across repeated empty bridge refreshes while still alive', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command !== 'getInventory') {
        return {}
      }

      inventoryReads++
      if (inventoryReads === 1) {
        return {
          items: [
            {
              slot: 11,
              name: 'minecraft:birch_log',
              count: 5,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 0,
        }
      }

      return {
        items: [],
        selectedSlot: 0,
      }
    })

    await proxy.refreshInventory()
    await proxy.refreshInventory()
    await proxy.refreshInventory()
    await proxy.refreshInventory()
    await proxy.refreshInventory()

    expect(proxy.inventory.items().find(item => item.name === 'birch_log')?.count).toBe(5)
    expect(proxy.getStrictRawInventoryItems().find(item => item.name === 'minecraft:birch_log')?.count).toBe(5)
  })

  it('persists the latest visible inventory snapshot after a successful bridge refresh', async () => {
    const { proxy, ws } = createProxy()

    ws.request.mockResolvedValue({
      items: [
        {
          slot: 9,
          name: 'minecraft:crafting_table',
          count: 1,
          maxCount: 64,
          durability: 0,
          maxDurability: 0,
        },
      ],
      selectedSlot: 0,
      armor: [
        {
          slot: 39,
          name: 'minecraft:iron_helmet',
          count: 1,
          maxCount: 1,
          durability: 90,
          maxDurability: 165,
        },
      ],
      offhand: {
        slot: 40,
        name: 'minecraft:shield',
        count: 1,
        maxCount: 1,
        durability: 220,
        maxDurability: 336,
      },
    })

    await proxy.refreshInventory()

    expect(sessionResumeMock.saved).toHaveLength(1)
    expect(sessionResumeMock.saved[0]?.username).toBe('AIRI')
    expect((sessionResumeMock.saved[0]?.snapshot.items as Array<{ name: string }>)[0]?.name).toBe('minecraft:crafting_table')
    expect((sessionResumeMock.saved[0]?.snapshot.armorItems as Array<{ name: string }>)[0]?.name).toBe('minecraft:iron_helmet')
  })

  it('refreshes selected slot and held item after equipping to hand', async () => {
    const { proxy, ws } = createProxy()
    let inventoryReads = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'equip') {
        return {}
      }
      if (command === 'getInventory') {
        inventoryReads++
        return {
          items: [
            {
              slot: 2,
              name: 'minecraft:wooden_pickaxe',
              count: 1,
              maxCount: 1,
              durability: 0,
              maxDurability: 59,
            },
          ],
          selectedSlot: 2,
        }
      }
      return {}
    })

    await proxy.equip({ type: 0, count: 1, slot: 10, name: 'wooden_pickaxe', maxDurability: 59, durability: 0 }, 'hand')

    expect(inventoryReads).toBe(1)
    expect(proxy.inventory.selectedSlot).toBe(2)
    expect(proxy.heldItem?.name).toBe('wooden_pickaxe')
  })

  it('updates the canonical snapshot from pushed inventory state including armor and offhand', () => {
    const { proxy, ws } = createProxy()

    ws.emit('event', {
      type: 'state:inventory',
      data: {
        items: [
          {
            slot: 0,
            name: 'minecraft:iron_pickaxe',
            count: 1,
            maxCount: 1,
            durability: 210,
            maxDurability: 250,
          },
        ],
        selectedSlot: 0,
        armor: [
          {
            slot: 39,
            name: 'minecraft:iron_helmet',
            count: 1,
            maxCount: 1,
            durability: 160,
            maxDurability: 165,
          },
        ],
        offhand: {
          slot: 40,
          name: 'minecraft:shield',
          count: 1,
          maxCount: 1,
          durability: 300,
          maxDurability: 336,
        },
      },
    })

    const snapshot = proxy.getCanonicalInventorySnapshot()
    expect(snapshot.selectedSlot).toBe(0)
    expect(snapshot.heldItem?.itemName).toBe('iron_pickaxe')
    expect(snapshot.armor[0]?.itemName).toBe('iron_helmet')
    expect(snapshot.offhand?.itemName).toBe('shield')
    expect(proxy.inventory.slots[36]?.name).toBe('iron_pickaxe')
    expect(proxy.inventory.slots[45]?.name).toBe('shield')
  })

  it('uses the selected raw hotbar slot instead of stale tracked cache for held item', () => {
    const { proxy } = createProxy()
    ;(proxy as any).selectedSlot = 0
    ;(proxy as any).inventory.selectedSlot = 0
    ;(proxy as any).strictRawInventoryItems = [
      {
        slot: 0,
        name: 'minecraft:furnace',
        count: 1,
        maxCount: 64,
        durability: 0,
        maxDurability: 0,
      },
    ]
    ;(proxy as any).rawInventoryItems = [
      {
        slot: 0,
        name: 'minecraft:furnace',
        count: 1,
        maxCount: 64,
        durability: 0,
        maxDurability: 0,
      },
    ]
    ;(proxy as any).inventoryItems = [
      {
        slot: 0,
        name: 'minecraft:dirt',
        count: 16,
        maxCount: 64,
        durability: 0,
        maxDurability: 0,
      },
    ]

    const snapshot = proxy.getCanonicalInventorySnapshot()

    expect(snapshot.heldItem?.itemName).toBe('furnace')
    expect(snapshot.invariants.issues).not.toContain('held_item_mismatch')
    expect(proxy.heldItem?.name).toBe('furnace')
  })

  it('does not treat raw armor slots as selected hotbar fallback held items', () => {
    const { proxy, ws } = createProxy()

    ws.emit('event', {
      type: 'state:inventory',
      data: {
        items: [
          {
            slot: 36,
            name: 'minecraft:iron_boots',
            count: 1,
            maxCount: 1,
            durability: 120,
            maxDurability: 195,
          },
        ],
        selectedSlot: 0,
        armor: [
          {
            slot: 36,
            name: 'minecraft:iron_boots',
            count: 1,
            maxCount: 1,
            durability: 120,
            maxDurability: 195,
          },
        ],
      },
    })

    const snapshot = proxy.getCanonicalInventorySnapshot()

    expect(snapshot.heldItem).toBeNull()
    expect(snapshot.armor[0]?.itemName).toBe('iron_boots')
    expect(proxy.heldItem).toBeNull()
  })

  it('clears persisted resume state when the player dies', () => {
    sessionResumeMock.loaded = {
      savedAt: Date.now(),
      items: [{
        slot: 0,
        name: 'minecraft:iron_pickaxe',
        count: 1,
        maxCount: 1,
        durability: 180,
        maxDurability: 250,
      }],
      armorItems: [],
      offhandItem: null,
      selectedSlot: 0,
    }

    const { proxy, ws } = createProxy()
    ws.emit('event', {
      type: 'event:death',
      data: {},
    })

    expect(proxy.inventory.items()).toHaveLength(0)
    expect(sessionResumeMock.cleared).toContain('AIRI')
  })

  it('supports deterministic hotbar selection and slot swaps through the bridge', async () => {
    const { proxy, ws } = createProxy()

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'swapInventorySlots') {
        return {
          items: [
            {
              slot: 0,
              name: 'minecraft:iron_pickaxe',
              count: 1,
              maxCount: 1,
              durability: 210,
              maxDurability: 250,
            },
            {
              slot: 12,
              name: 'minecraft:dirt',
              count: 8,
              maxCount: 64,
              durability: 0,
              maxDurability: 0,
            },
          ],
          selectedSlot: 5,
          armor: [],
        }
      }
      if (command === 'selectHotbarSlot') {
        return {
          items: [
            {
              slot: 0,
              name: 'minecraft:iron_pickaxe',
              count: 1,
              maxCount: 1,
              durability: 210,
              maxDurability: 250,
            },
          ],
          selectedSlot: 0,
          armor: [],
        }
      }
      return {}
    })

    await proxy.moveSlotItem(12, 0)
    await proxy.selectHotbarSlot(0)

    expect(ws.request).toHaveBeenCalledWith('swapInventorySlots', { fromSlot: 12, toSlot: 0 }, undefined)
    expect(ws.request).toHaveBeenCalledWith('selectHotbarSlot', { slot: 0 }, undefined)
    expect(proxy.heldItem?.name).toBe('iron_pickaxe')
    expect(proxy.inventory.selectedSlot).toBe(0)
  })

  it('marks unsupported bridge commands once and refuses to blind retry them in the same session', async () => {
    const { proxy, ws } = createProxy()
    let compactCalls = 0

    ws.request.mockImplementation(async (command: string) => {
      if (command === 'compactInventory') {
        compactCalls++
        throw new Error('Unknown command: compactInventory')
      }
      return {}
    })

    await expect(proxy.compactInventory(4)).rejects.toThrow('Bridge command unsupported (compactInventory)')
    await expect(proxy.compactInventory(4)).rejects.toThrow('cached unsupported capability')

    expect(compactCalls).toBe(1)
    expect(proxy.getBridgeCapabilitySnapshot().unsupportedCommands).toContain('compactInventory')
  })

  it('forwards remote movement stop events without logging them as unknown', () => {
    const { proxy, ws } = createProxy()
    const onStop = vi.fn()
    proxy.on('remoteMovementStopped', onStop)

    ws.emit('event', {
      type: 'event:remoteMovementStopped',
      data: { reason: 'arrived', mode: 'walk' },
    })

    expect(onStop).toHaveBeenCalledWith({ reason: 'arrived', mode: 'walk' })
  })
})
