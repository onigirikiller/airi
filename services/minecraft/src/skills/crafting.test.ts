import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getItemId } from '../utils/mcdata'
import { craftRecipe, getLastCraftRecipeDiagnostic, smeltItem } from './crafting'

function createPosition(x: number, y: number, z: number) {
  return {
    x,
    y,
    z,
    distanceTo(target: { x: number, y: number, z: number }) {
      return Math.sqrt(((x - target.x) ** 2) + ((y - target.y) ** 2) + ((z - target.z) ** 2))
    },
  }
}

const mocks = vi.hoisted(() => ({
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
  },
  ensureCraftingTable: vi.fn(async () => true),
  adjustOptimisticItemCount: vi.fn(),
  confirmItemCount: vi.fn(async () => true),
  consumeOptimisticItemsMatchingQuery: vi.fn(),
  getActualItemCount: vi.fn(() => 0),
  getBridgeActualItemCount: vi.fn(async () => null),
  getItemCount: vi.fn(() => 0),
  recordOptimisticItem: vi.fn(),
  refreshInventoryState: vi.fn(async () => true),
  confirmVisibleInventoryItem: vi.fn(),
  getNearestBlockAccurate: vi.fn(async () => null),
  getBlockAtAccurate: vi.fn(async () => null),
  invalidateBlockCache: vi.fn(),
  getNearestFreeSpaceAccurate: vi.fn(async () => null),
  placeBlock: vi.fn(async () => true),
  getLastPlacedBlockRecord: vi.fn((): any => null),
  goToNearestBlock: vi.fn(async () => true),
  goToPosition: vi.fn(async () => true),
  moveAway: vi.fn(async () => true),
  getInventoryCounts: vi.fn(() => ({})),
  getNearestBlock: vi.fn(() => null),
}))

vi.mock('../utils/logger', () => ({
  useLogger: () => mocks.logger,
}))

vi.mock('./actions/ensure', () => ({
  ensureCraftingTable: mocks.ensureCraftingTable,
}))

vi.mock('./actions/inventory', () => ({
  adjustOptimisticItemCount: mocks.adjustOptimisticItemCount,
  confirmItemCount: mocks.confirmItemCount,
  consumeOptimisticItemsMatchingQuery: mocks.consumeOptimisticItemsMatchingQuery,
  getActualItemCount: mocks.getActualItemCount,
  getBridgeActualItemCount: mocks.getBridgeActualItemCount,
  getItemCount: mocks.getItemCount,
  recordOptimisticItem: mocks.recordOptimisticItem,
  refreshInventoryState: mocks.refreshInventoryState,
}))

vi.mock('./block-access', () => ({
  getBlockAtAccurate: mocks.getBlockAtAccurate,
  getNearestBlockAccurate: mocks.getNearestBlockAccurate,
  invalidateBlockCache: mocks.invalidateBlockCache,
  getNearestFreeSpaceAccurate: mocks.getNearestFreeSpaceAccurate,
}))

vi.mock('./blocks', () => ({
  collectBlock: vi.fn(async () => true),
  placeBlock: mocks.placeBlock,
}))

vi.mock('./actions/world-interactions', () => ({
  getLastPlacedBlockRecord: mocks.getLastPlacedBlockRecord,
}))

vi.mock('./movement', () => ({
  goToNearestBlock: mocks.goToNearestBlock,
  goToPosition: mocks.goToPosition,
  moveAway: mocks.moveAway,
}))

vi.mock('./world', () => ({
  getInventoryCounts: mocks.getInventoryCounts,
  getNearestBlock: mocks.getNearestBlock,
}))

describe('craftRecipe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureCraftingTable.mockResolvedValue(true)
    mocks.confirmItemCount.mockResolvedValue(true)
    mocks.getActualItemCount.mockReturnValue(0)
    mocks.getBridgeActualItemCount.mockResolvedValue(null)
    mocks.getItemCount.mockReturnValue(0)
    mocks.getNearestBlockAccurate.mockReset()
    mocks.getNearestBlockAccurate.mockResolvedValue(null)
    mocks.getBlockAtAccurate.mockReset()
    mocks.getBlockAtAccurate.mockResolvedValue(null)
    mocks.getNearestFreeSpaceAccurate.mockReset()
    mocks.getNearestFreeSpaceAccurate.mockResolvedValue(null)
    mocks.placeBlock.mockReset()
    mocks.placeBlock.mockResolvedValue(true)
    mocks.getLastPlacedBlockRecord.mockReset()
    mocks.getLastPlacedBlockRecord.mockReturnValue(null)
    mocks.goToNearestBlock.mockReset()
    mocks.goToNearestBlock.mockResolvedValue(true)
    mocks.goToPosition.mockReset()
    mocks.goToPosition.mockResolvedValue(true)
    mocks.moveAway.mockReset()
    mocks.moveAway.mockResolvedValue(true)
    mocks.getInventoryCounts.mockReset()
    mocks.getInventoryCounts.mockReturnValue({})
    mocks.getNearestBlock.mockReset()
    mocks.getNearestBlock.mockReturnValue(null)
  })

  it('reuses the just-placed crafting table when the nearby scan is still stale', async () => {
    const craft = vi.fn(async (_recipe, _count, craftingTable) => {
      if (!craftingTable) {
        throw new Error('Recipe requires 3x3 crafting table but no craftingTable position provided')
      }
    })
    const recipesFor = vi.fn(async (_itemId: number, _metadata, _count: number, craftingTable) => {
      if (!craftingTable) {
        return [{ result: { count: 1 }, delta: [] }]
      }
      return [{ result: { count: 1 }, delta: [] }]
    })
    const placedTableBlock = { name: 'crafting_table', position: { x: 1, y: 64, z: 1 } }

    mocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce({ x: 1, y: 64, z: 1 } as any)
    mocks.getBlockAtAccurate.mockResolvedValueOnce(placedTableBlock as any)

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'oak_planks', count: 3 },
            { name: 'stick', count: 2 },
          ],
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'wooden_pickaxe', 1)

    expect(crafted).toBe(true)
    expect(mocks.placeBlock).toHaveBeenCalledWith(mineflayer, 'crafting_table', 1, 64, 1)
    expect(mocks.getBlockAtAccurate).toHaveBeenCalledWith(mineflayer, { x: 1, y: 64, z: 1 })
    expect(craft).toHaveBeenCalledWith(expect.anything(), 1, placedTableBlock)
  })

  it('crafts immediately when already within interaction range of the placed crafting table', async () => {
    const craft = vi.fn(async (_recipe, _count, craftingTable) => {
      if (!craftingTable) {
        throw new Error('Recipe requires 3x3 crafting table but no craftingTable position provided')
      }
    })
    const recipesFor = vi.fn(async (_itemId: number, _metadata, _count: number, craftingTable) => {
      if (!craftingTable) {
        return [{ result: { count: 1 }, delta: [] }]
      }
      return [{ result: { count: 1 }, delta: [] }]
    })
    const placedTableBlock = { name: 'crafting_table', position: { x: -311, y: 69, z: 69 } }

    mocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce({ x: -311, y: 69, z: 69 } as any)
    mocks.getBlockAtAccurate.mockResolvedValueOnce(placedTableBlock as any)

    const mineflayer = {
      bot: {
        entity: { position: createPosition(-309.7, 68, 70.7) },
        inventory: {
          items: () => [
            { name: 'oak_planks', count: 3 },
            { name: 'stick', count: 2 },
          ],
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'wooden_pickaxe', 1)

    expect(crafted).toBe(true)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(craft).toHaveBeenCalledWith(expect.anything(), 1, placedTableBlock)
  })

  it('reuses a cached placed crafting table across later craft retries', async () => {
    const craft = vi.fn(async (_recipe, _count, craftingTable) => {
      if (!craftingTable) {
        throw new Error('Recipe requires 3x3 crafting table but no craftingTable position provided')
      }
    })
    const recipesFor = vi.fn(async () => [{ result: { count: 1 }, delta: [] }])
    const placedTableBlock = { name: 'crafting_table', position: { x: 1, y: 64, z: 1 } }

    mocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce({ x: 1, y: 64, z: 1 } as any)
    mocks.getBlockAtAccurate
      .mockResolvedValueOnce(placedTableBlock as any)
      .mockResolvedValueOnce(placedTableBlock as any)

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'oak_planks', count: 3 },
            { name: 'stick', count: 2 },
          ],
        },
        recipesFor,
        craft,
      },
    } as any

    const craftedOnce = await craftRecipe(mineflayer, 'wooden_pickaxe', 1)
    const craftedTwice = await craftRecipe(mineflayer, 'wooden_pickaxe', 1)

    expect(craftedOnce).toBe(true)
    expect(craftedTwice).toBe(true)
    expect(mocks.placeBlock).toHaveBeenCalledTimes(1)
    expect(craft).toHaveBeenCalledTimes(4)
    expect(craft).toHaveBeenNthCalledWith(2, expect.anything(), 1, placedTableBlock)
    expect(craft).toHaveBeenNthCalledWith(4, expect.anything(), 1, placedTableBlock)
  })

  it('prefers placing the carried crafting table instead of pathing to a distant known one', async () => {
    const craft = vi.fn(async (_recipe, _count, craftingTable) => {
      if (!craftingTable) {
        throw new Error('Recipe requires 3x3 crafting table but no craftingTable position provided')
      }
    })
    const recipesFor = vi.fn(async (_itemId: number, _metadata, _count: number, craftingTable) => {
      if (!craftingTable) {
        return [{ result: { count: 1 }, delta: [] }]
      }
      return [{ result: { count: 1 }, delta: [] }]
    })
    const distantTableBlock = { name: 'crafting_table', position: { x: 24, y: 64, z: 0 } }
    const placedTableBlock = { name: 'crafting_table', position: { x: 1, y: 64, z: 0 } }

    mocks.getNearestBlockAccurate
      .mockResolvedValueOnce(distantTableBlock as any)
      .mockResolvedValueOnce(null)
    mocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce({ x: 1, y: 64, z: 0 } as any)
    mocks.getBlockAtAccurate.mockResolvedValueOnce(placedTableBlock as any)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table') {
        return 1
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'crafting_table', count: 1 },
            { name: 'oak_planks', count: 3 },
            { name: 'stick', count: 2 },
          ],
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'wooden_pickaxe', 1)

    expect(crafted).toBe(true)
    expect(mocks.placeBlock).toHaveBeenCalledWith(mineflayer, 'crafting_table', 1, 64, 0)
    expect(mocks.goToPosition).not.toHaveBeenCalledWith(mineflayer, 24, 64, 0, 1)
    expect(craft).toHaveBeenCalledWith(expect.anything(), 1, placedTableBlock)
  })

  it('recomputes the crafting-table placement slot after moving away from an underground pocket', async () => {
    const craft = vi.fn(async (_recipe, _count, craftingTable) => {
      if (!craftingTable) {
        throw new Error('Recipe requires 3x3 crafting table but no craftingTable position provided')
      }
    })
    const recipesFor = vi.fn(async (_itemId: number, _metadata, _count: number, craftingTable) => {
      if (!craftingTable) {
        return [{ result: { count: 1 }, delta: [] }]
      }
      return [{ result: { count: 1 }, delta: [] }]
    })
    const placedTableBlock = { name: 'crafting_table', position: { x: -332, y: 63, z: 262 } }

    ;(mocks.moveAway as any).mockImplementationOnce(async (mineflayer: any) => {
      mineflayer.bot.entity.position = createPosition(-334.84, 63, 263.51)
      return true
    })
    ;(mocks.getNearestFreeSpaceAccurate as any).mockImplementationOnce(async (mineflayer: any) => {
      return mineflayer.bot.entity.position.y >= 60
        ? ({ x: -332, y: 63, z: 262 } as any)
        : ({ x: -332, y: 20, z: 262 } as any)
    })
    mocks.getBlockAtAccurate.mockResolvedValueOnce(placedTableBlock as any)

    const mineflayer = {
      bot: {
        entity: { position: createPosition(-332, 21, 262) },
        inventory: {
          items: () => [
            { name: 'cobblestone', count: 3 },
            { name: 'stick', count: 2 },
          ],
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'stone_pickaxe', 1)

    expect(crafted).toBe(true)
    expect(mocks.placeBlock).toHaveBeenCalledWith(mineflayer, 'crafting_table', -332, 63, 262)
    expect(mocks.placeBlock).not.toHaveBeenCalledWith(mineflayer, 'crafting_table', -332, 20, 262)
    expect(craft).toHaveBeenCalledWith(expect.anything(), 1, placedTableBlock)
  })

  it('uses the crafting interaction distance when pathing to a nearby crafting table', async () => {
    const craft = vi.fn(async (_recipe, _count, craftingTable) => {
      if (!craftingTable) {
        throw new Error('Recipe requires 3x3 crafting table but no craftingTable position provided')
      }
    })
    const recipesFor = vi.fn(async (_itemId: number, _metadata, _count: number, craftingTable) => {
      if (!craftingTable) {
        return [{ result: { count: 1 }, delta: [] }]
      }
      return [{ result: { count: 1 }, delta: [] }]
    })
    const nearbyTableBlock = { name: 'crafting_table', position: { x: 4, y: 64, z: 0 } }

    mocks.getNearestBlockAccurate.mockResolvedValueOnce(nearbyTableBlock as any)

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'oak_planks', count: 3 },
            { name: 'stick', count: 2 },
          ],
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'wooden_pickaxe', 1)

    expect(crafted).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 4, 64, 0, 2.5)
    expect(craft).toHaveBeenCalledWith(expect.anything(), 1, nearbyTableBlock)
  })

  it('crafts and places a portable crafting table after an existing nearby table stays unusable', async () => {
    const craftingTableId = getItemId('crafting_table')
    const woodenPickaxeId = getItemId('wooden_pickaxe')
    const blockedTableBlock = { name: 'crafting_table', position: { x: 8, y: 64, z: 0 } }
    const placedTableBlock = { name: 'crafting_table', position: { x: 1, y: 64, z: 0 } }
    const craft = vi.fn(async (recipe: any, _count, craftingTable) => {
      if (recipe?.__target === 'wooden_pickaxe' && !craftingTable) {
        throw new Error('Recipe requires 3x3 crafting table but no craftingTable position provided')
      }
    })
    const recipesFor = vi.fn(async (itemId: number, _metadata, _count: number, craftingTable) => {
      if (itemId === craftingTableId) {
        return [{ result: { count: 1 }, delta: [], __target: 'crafting_table' }]
      }
      if (itemId === woodenPickaxeId) {
        if (!craftingTable) {
          return [{ result: { count: 1 }, delta: [], __target: 'wooden_pickaxe' }]
        }
        return [{ result: { count: 1 }, delta: [], __target: 'wooden_pickaxe' }]
      }
      return []
    })

    mocks.getNearestBlockAccurate
      .mockResolvedValueOnce(blockedTableBlock as any)
      .mockResolvedValueOnce(null)
    mocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce({ x: 1, y: 64, z: 0 } as any)
    mocks.getBlockAtAccurate.mockResolvedValueOnce(placedTableBlock as any)
    mocks.goToPosition.mockImplementation((async (_mineflayer: any, x: number) => x !== 8) as any)

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'oak_planks', count: 7 },
            { name: 'stick', count: 2 },
          ],
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'wooden_pickaxe', 1)

    expect(crafted).toBe(true)
    expect(mocks.placeBlock).toHaveBeenCalledWith(mineflayer, 'crafting_table', 1, 64, 0)
    expect(craft).toHaveBeenCalledWith(expect.objectContaining({ __target: 'wooden_pickaxe' }), 1, placedTableBlock)
    expect(mocks.ensureCraftingTable).toHaveBeenCalledWith(mineflayer, { requirePortable: true })
  })

  it('supports async recipesFor implementations used by FabricBridge', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async () => ['birch_planks'])

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        confirmVisibleInventoryItem: mocks.confirmVisibleInventoryItem,
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'birch_planks', 1)

    expect(crafted).toBe(true)
    expect(recipesFor).toHaveBeenCalled()
    expect(craft).toHaveBeenCalledWith('birch_planks', 1, undefined)
    expect(mocks.refreshInventoryState).toHaveBeenCalledWith(mineflayer)
    expect(mocks.confirmItemCount).toHaveBeenCalledWith(
      mineflayer,
      'birch_planks',
      4,
      expect.objectContaining({
        refresh: true,
        actualOnly: true,
        localVisibleOnly: true,
        attempts: 12,
        delayMs: 300,
        consecutiveSuccessesNeeded: 4,
      }),
    )
    expect(mocks.confirmVisibleInventoryItem).toHaveBeenCalledWith('birch_planks', 4)
    expect(mocks.recordOptimisticItem).toHaveBeenCalledWith('birch_planks', 4)
  })

  it('consumes generic plank optimistic counts for string-only recipes', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async () => ['crafting_table'])

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        confirmVisibleInventoryItem: mocks.confirmVisibleInventoryItem,
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'crafting_table', 1)

    expect(crafted).toBe(true)
    expect(mocks.consumeOptimisticItemsMatchingQuery).toHaveBeenCalledWith('planks', 4)
    expect(mocks.recordOptimisticItem).toHaveBeenCalledWith('crafting_table', 1)
  })

  it('crafts plank recipes in the player inventory before considering nearby crafting tables', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async (_itemId: number, _metadata, _count: number, craftingTable) => {
      if (!craftingTable) {
        return ['oak_planks']
      }
      return ['oak_planks']
    })

    mocks.getNearestBlockAccurate.mockResolvedValueOnce({
      name: 'crafting_table',
      position: { x: 4, y: 69, z: 0 },
    } as any)

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [{ name: 'oak_log', count: 1 }],
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'oak_planks', 1)

    expect(crafted).toBe(true)
    expect(mocks.getNearestBlockAccurate).not.toHaveBeenCalled()
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(recipesFor).toHaveBeenCalledWith(getItemId('oak_planks'), null, 1, null)
    expect(craft).toHaveBeenCalledWith('oak_planks', 1, undefined)
  })

  it('uses the full expected post-craft count for a single inventory-only craft when the bridge only surfaces part of the crafted stack', async () => {
    let crafted = false
    const craft = vi.fn(async () => {
      crafted = true
    })
    const recipesFor = vi.fn(async () => ['oak_planks'])
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      return _mineflayer.bot.inventory
        .items()
        .filter((item: { name: string, count: number }) => item.name.includes(itemName))
        .reduce((sum: number, item: { count: number }) => sum + item.count, 0)
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => crafted
            ? [{ name: 'oak_planks', count: 3 }]
            : [{ name: 'oak_planks', count: 2 }, { name: 'oak_log', count: 4 }],
        },
        recipesFor,
        craft,
      },
    } as any

    const craftedResult = await craftRecipe(mineflayer, 'oak_planks', 1)

    expect(craftedResult).toBe(true)
    expect(mocks.confirmItemCount).toHaveBeenCalledWith(
      mineflayer,
      'oak_planks',
      6,
      expect.objectContaining({ refresh: true, actualOnly: true }),
    )
  })

  it('bases inventory-only confirmation on strict actual counts instead of guarded inventory counts', async () => {
    let actualCount = 10
    const craft = vi.fn(async () => {
      actualCount = 14
    })
    const recipesFor = vi.fn(async () => ['oak_planks'])
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      return itemName === 'oak_planks' ? actualCount : 0
    }) as any)
    mocks.getBridgeActualItemCount.mockImplementation((async (_mineflayer: any, itemName: string) => {
      return itemName === 'oak_planks' ? actualCount : null
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'oak_planks', count: 14 }, { name: 'oak_log', count: 4 }],
        },
        recipesFor,
        craft,
      },
    } as any

    const craftedResult = await craftRecipe(mineflayer, 'oak_planks', 1)

    expect(craftedResult).toBe(true)
    expect(mocks.confirmItemCount).toHaveBeenCalledWith(
      mineflayer,
      'oak_planks',
      14,
      expect.objectContaining({ refresh: true, actualOnly: true, localVisibleOnly: true }),
    )
  })

  it('requires full confirmation for four-output inventory crafts even when FabricBridge only returns a string recipe', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async () => ['birch_planks'])
    mocks.confirmItemCount.mockResolvedValueOnce(false)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'birch_log', count: 1 }],
          count: vi.fn(() => 1),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'birch_planks', 1)

    expect(crafted).toBe(false)
    expect(mocks.confirmItemCount).toHaveBeenCalledWith(
      mineflayer,
      'birch_planks',
      4,
      expect.objectContaining({
        refresh: true,
        actualOnly: true,
        localVisibleOnly: true,
        attempts: 12,
        delayMs: 300,
        consecutiveSuccessesNeeded: 4,
      }),
    )
    expect(mocks.recordOptimisticItem).not.toHaveBeenCalled()
  })

  it('serializes multi-craft inventory-only recipes into single confirmed crafts', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async () => ['oak_planks'])

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'oak_log', count: 2 }],
          count: vi.fn(() => 2),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'oak_planks', 2)

    expect(crafted).toBe(true)
    expect(craft).toHaveBeenCalledTimes(2)
    expect(craft).toHaveBeenNthCalledWith(1, 'oak_planks', 1, undefined)
    expect(craft).toHaveBeenNthCalledWith(2, 'oak_planks', 1, undefined)
    expect(mocks.confirmItemCount).toHaveBeenNthCalledWith(
      1,
      mineflayer,
      'oak_planks',
      4,
      expect.objectContaining({ refresh: true, actualOnly: true }),
    )
    expect(mocks.confirmItemCount).toHaveBeenNthCalledWith(
      2,
      mineflayer,
      'oak_planks',
      8,
      expect.objectContaining({ refresh: true, actualOnly: true }),
    )
  })

  it('prefers the exact requested recipe when FabricBridge returns mismatched plank outputs first', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async () => ['dark_oak_planks', 'oak_planks'])
    const oakLogId = getItemId('oak_log')
    const darkOakLogId = getItemId('dark_oak_log')

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'oak_log', count: 1 }],
          count: vi.fn((itemId: number) => {
            if (itemId === oakLogId) {
              return 1
            }
            if (itemId === darkOakLogId) {
              return 0
            }
            return 0
          }),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'oak_planks', 1)

    expect(crafted).toBe(true)
    expect(craft).toHaveBeenCalledWith('oak_planks', 1, undefined)
    expect(craft).not.toHaveBeenCalledWith('dark_oak_planks', 1, undefined)
  })

  it('adapts the default oak plank bootstrap recipe to the visible log family in inventory', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async () => ['birch_planks'])
    const birchPlanksId = getItemId('birch_planks')
    mocks.getInventoryCounts.mockReturnValue({ birch_log: 6 })

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'birch_log', count: 6 }],
          count: vi.fn(() => 0),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'oak_planks', 1)

    expect(crafted).toBe(true)
    expect(recipesFor).toHaveBeenCalledWith(birchPlanksId, null, 1, null)
    expect(craft).toHaveBeenCalledWith('birch_planks', 1, undefined)
    expect(mocks.confirmItemCount).toHaveBeenCalledWith(
      mineflayer,
      'birch_planks',
      4,
      expect.objectContaining({ refresh: true, actualOnly: true }),
    )
  })

  it('prefers the visible plank recipe over one supported only by optimistic tracked counts', async () => {
    const craft = vi.fn(async () => undefined)
    const oakPlanksId = getItemId('oak_planks')
    const birchPlanksId = getItemId('birch_planks')
    const stickId = getItemId('stick')
    const oakRecipe = {
      result: { count: 1 },
      delta: [
        { id: oakPlanksId, metadata: null, count: -3 },
        { id: stickId, metadata: null, count: -2 },
      ],
    }
    const birchRecipe = {
      result: { count: 1 },
      delta: [
        { id: birchPlanksId, metadata: null, count: -3 },
        { id: stickId, metadata: null, count: -2 },
      ],
    }
    const recipesFor = vi.fn(async () => [oakRecipe, birchRecipe])

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'oak_planks') {
        return 3
      }

      if (itemName === 'stick') {
        return 2
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [
            { name: 'birch_planks', count: 3 },
            { name: 'stick', count: 2 },
          ],
          count: vi.fn((itemId: number) => {
            if (itemId === birchPlanksId) {
              return 3
            }
            if (itemId === stickId) {
              return 2
            }
            return 0
          }),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'wooden_pickaxe', 1)

    expect(crafted).toBe(true)
    expect(craft).toHaveBeenCalledWith(birchRecipe, 1, undefined)
    expect(craft).not.toHaveBeenCalledWith(oakRecipe, 1, undefined)
  })

  it('prefers the tracked exact plank variant when local exact counts are stale for tool recipes', async () => {
    const craft = vi.fn(async () => undefined)
    const oakPlanksId = getItemId('oak_planks')
    const birchPlanksId = getItemId('birch_planks')
    const stickId = getItemId('stick')
    const birchRecipe = {
      result: { count: 1 },
      delta: [
        { id: birchPlanksId, metadata: null, count: -3 },
        { id: stickId, metadata: null, count: -2 },
      ],
    }
    const oakRecipe = {
      result: { count: 1 },
      delta: [
        { id: oakPlanksId, metadata: null, count: -3 },
        { id: stickId, metadata: null, count: -2 },
      ],
    }
    const recipesFor = vi.fn(async () => [birchRecipe, oakRecipe])

    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return 2
      }

      return 0
    }) as any)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'oak_planks') {
        return 3
      }

      if (itemName === 'stick') {
        return 2
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'stick', count: 2 }],
          count: vi.fn((itemId: number) => {
            if (itemId === stickId) {
              return 2
            }
            return 0
          }),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'wooden_pickaxe', 1)

    expect(crafted).toBe(true)
    expect(craft).toHaveBeenCalledWith(oakRecipe, 1, undefined)
    expect(craft).not.toHaveBeenCalledWith(birchRecipe, 1, undefined)
  })

  it('rejects inventory-only recipe mismatches even when the craft RPC succeeds', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async () => [{
      result: { count: 4 },
      delta: [{ id: 5, metadata: null, count: -2 }],
    }])
    mocks.confirmItemCount.mockResolvedValueOnce(false)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'oak_planks', count: 2 }],
          count: vi.fn(() => 2),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'stick', 1)

    expect(crafted).toBe(false)
    expect(mocks.recordOptimisticItem).not.toHaveBeenCalled()
    expect(getLastCraftRecipeDiagnostic(mineflayer)).toMatchObject({
      kind: 'inventory_sync_mismatch',
      itemName: 'stick',
      inventoryOnly: true,
    })
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('crafted outputs must be visible in local inventory'),
    )
  })

  it('rejects non-inventory craft success when the crafted output never becomes locally visible', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async () => [{
      result: { count: 1 },
      delta: [
        { id: 1, metadata: null, count: -3 },
        { id: 2, metadata: null, count: -2 },
      ],
    }])
    mocks.confirmItemCount.mockResolvedValue(false)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [
            { name: 'oak_planks', count: 3 },
            { name: 'stick', count: 2 },
          ],
          count: vi.fn((itemId: number) => {
            if (itemId === 1) {
              return 3
            }
            if (itemId === 2) {
              return 2
            }
            return 0
          }),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'wooden_pickaxe', 1)

    expect(crafted).toBe(false)
    expect(mocks.recordOptimisticItem).not.toHaveBeenCalledWith('wooden_pickaxe', 1)
    expect(getLastCraftRecipeDiagnostic(mineflayer)).toMatchObject({
      kind: 'inventory_sync_mismatch',
      itemName: 'wooden_pickaxe',
      inventoryOnly: false,
    })
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('crafted outputs must be visible in local inventory'),
    )
  })

  it('consumes optimistic ingredient counts after a successful craft', async () => {
    const craft = vi.fn(async () => undefined)
    const oakPlanksId = getItemId('oak_planks')
    const recipesFor = vi.fn(async () => [{
      result: { count: 1 },
      delta: [{ id: oakPlanksId, metadata: null, count: -4 }],
    }])

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'oak_planks', count: 4 }],
          count: vi.fn((itemId: number) => itemId === oakPlanksId ? 4 : 0),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'crafting_table', 1)

    expect(crafted).toBe(true)
    expect(mocks.adjustOptimisticItemCount).toHaveBeenCalledWith('oak_planks', -4)
  })

  it('rejects optimistic inventory-only craft success when the visible inputs were absent', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async () => [{
      result: { count: 4 },
      delta: [{ id: 5, metadata: null, count: -2 }],
    }])
    mocks.confirmItemCount.mockResolvedValueOnce(false)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
          count: vi.fn(() => 0),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'stick', 1)

    expect(crafted).toBe(false)
    expect(mocks.recordOptimisticItem).not.toHaveBeenCalled()
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('crafted outputs must be visible in local inventory'),
    )
  })

  it('still rejects inventory-only craft success when only tracked optimistic inputs exist', async () => {
    const craft = vi.fn(async () => undefined)
    const recipesFor = vi.fn(async () => [{
      result: { count: 4 },
      delta: [{ id: 25, metadata: null, count: -2 }],
    }])
    mocks.confirmItemCount.mockResolvedValueOnce(false)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'birch_planks') {
        return 4
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
          count: vi.fn(() => 0),
        },
        recipesFor,
        craft,
      },
    } as any

    const crafted = await craftRecipe(mineflayer, 'stick', 1)

    expect(crafted).toBe(false)
    expect(mocks.recordOptimisticItem).not.toHaveBeenCalled()
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('crafted outputs must be visible in local inventory'),
    )
  })
})

describe('smeltItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.getNearestBlockAccurate.mockReset()
    mocks.getNearestBlockAccurate.mockResolvedValue(null)
    mocks.getBlockAtAccurate.mockReset()
    mocks.getBlockAtAccurate.mockResolvedValue(null)
    mocks.getNearestFreeSpaceAccurate.mockReset()
    mocks.getNearestFreeSpaceAccurate.mockResolvedValue(null)
    mocks.placeBlock.mockReset()
    mocks.placeBlock.mockResolvedValue(true)
    mocks.getLastPlacedBlockRecord.mockReset()
    mocks.getLastPlacedBlockRecord.mockReturnValue(null)
    mocks.goToNearestBlock.mockReset()
    mocks.goToNearestBlock.mockResolvedValue(true)
    mocks.goToPosition.mockReset()
    mocks.goToPosition.mockResolvedValue(true)
    mocks.moveAway.mockReset()
    mocks.moveAway.mockResolvedValue(true)
    mocks.getInventoryCounts.mockReset()
    mocks.getInventoryCounts.mockReturnValue({})
    mocks.getNearestBlock.mockReset()
    mocks.getNearestBlock.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses the just-placed furnace when the nearby scan is still stale', async () => {
    const furnaceBlock = { name: 'furnace', position: { x: 2, y: 64, z: 0 } }
    let fuelLoaded = false
    let inputCount = 0
    let outputCount = 0
    const furnace = {
      inputItem: () => inputCount > 0 ? { type: getItemId('raw_iron'), count: inputCount } : null,
      fuelItem: () => fuelLoaded ? { type: getItemId('coal'), count: 1 } : null,
      putFuel: vi.fn(async () => {
        fuelLoaded = true
      }),
      putInput: vi.fn(async (_type: number, _metadata: null, count: number) => {
        inputCount += count
      }),
      outputItem: () => outputCount > 0 ? { type: getItemId('iron_ingot'), count: outputCount } : null,
      takeOutput: vi.fn(async () => {
        const count = outputCount
        outputCount = 0
        return count > 0 ? { type: getItemId('iron_ingot'), count } : null
      }),
      refresh: vi.fn(async () => {
        if (inputCount > 0 && outputCount === 0) {
          outputCount = inputCount
          inputCount = 0
        }
      }),
    }

    mocks.getNearestBlockAccurate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
    mocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce({ x: 2, y: 64, z: 0 } as any)
    mocks.getBlockAtAccurate.mockResolvedValueOnce(furnaceBlock as any)
    mocks.getInventoryCounts.mockReturnValue({
      furnace: 1,
      raw_iron: 1,
      coal: 1,
    })

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'furnace', type: getItemId('furnace'), count: 1 },
            { name: 'raw_iron', type: getItemId('raw_iron'), count: 1 },
            { name: 'coal', type: getItemId('coal'), count: 1 },
          ],
        },
        lookAt: vi.fn(async () => undefined),
        openFurnace: vi.fn(async () => furnace),
        closeWindow: vi.fn(async () => undefined),
      },
    } as any

    const resultPromise = smeltItem(mineflayer, 'raw_iron', 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.placeBlock).toHaveBeenCalledWith(mineflayer, 'furnace', 2, 64, 0)
    expect(mocks.getBlockAtAccurate).toHaveBeenCalledWith(mineflayer, expect.objectContaining({ x: 2, y: 64, z: 0 }))
    expect(mineflayer.bot.openFurnace).toHaveBeenCalledWith(furnaceBlock)
  })

  it('uses a freshly placed furnace cache when the block scan is still stale', async () => {
    let fuelLoaded = false
    let inputCount = 0
    let outputCount = 0
    const furnace = {
      inputItem: () => inputCount > 0 ? { type: getItemId('oak_log'), count: inputCount } : null,
      fuelItem: () => fuelLoaded ? { type: getItemId('oak_log'), count: 1 } : null,
      putFuel: vi.fn(async () => {
        fuelLoaded = true
      }),
      putInput: vi.fn(async (_type: number, _metadata: null, count: number) => {
        inputCount += count
      }),
      outputItem: () => outputCount > 0 ? { type: getItemId('charcoal'), count: outputCount } : null,
      takeOutput: vi.fn(async () => {
        const count = outputCount
        outputCount = 0
        return count > 0 ? { type: getItemId('charcoal'), count } : null
      }),
      refresh: vi.fn(async () => {
        if (inputCount > 0 && outputCount === 0) {
          outputCount = inputCount
          inputCount = 0
        }
      }),
    }

    mocks.getNearestBlockAccurate.mockResolvedValueOnce(null)
    mocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce({ x: 2, y: 64, z: 0 } as any)
    mocks.getBlockAtAccurate.mockResolvedValue(null)
    mocks.getInventoryCounts.mockReturnValue({
      furnace: 1,
      oak_log: 4,
    })

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'furnace', type: getItemId('furnace'), count: 1 },
            { name: 'oak_log', type: getItemId('oak_log'), count: 4 },
          ],
        },
        lookAt: vi.fn(async () => undefined),
        openFurnace: vi.fn(async () => furnace),
        closeWindow: vi.fn(async () => undefined),
      },
    } as any

    const resultPromise = smeltItem(mineflayer, 'log', 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.placeBlock).toHaveBeenCalledWith(mineflayer, 'furnace', 2, 64, 0)
    expect(mineflayer.bot.openFurnace).toHaveBeenCalledWith(expect.objectContaining({
      name: 'furnace',
      position: expect.objectContaining({ x: 2, y: 64, z: 0 }),
    }))
    expect(furnace.putInput).toHaveBeenCalledWith(getItemId('oak_log'), null, 1)
    expect(furnace.putInput.mock.invocationCallOrder[0]).toBeLessThan(furnace.putFuel.mock.invocationCallOrder[0])
  })

  it('places a dedicated furnace when a recent approximate furnace cannot be opened', async () => {
    const recentPlacedPosition = { x: 1, y: 64, z: 0 }
    const dedicatedPosition = { x: 3, y: 64, z: 0 }
    let fuelLoaded = false
    let inputCount = 0
    let outputCount = 0
    const furnace = {
      inputItem: () => inputCount > 0 ? { type: getItemId('raw_iron'), count: inputCount } : null,
      fuelItem: () => fuelLoaded ? { type: getItemId('coal'), count: 1 } : null,
      putFuel: vi.fn(async () => {
        fuelLoaded = true
      }),
      putInput: vi.fn(async (_type: number, _metadata: null, count: number) => {
        inputCount += count
      }),
      outputItem: () => outputCount > 0 ? { type: getItemId('iron_ingot'), count: outputCount } : null,
      takeOutput: vi.fn(async () => {
        const count = outputCount
        outputCount = 0
        return count > 0 ? { type: getItemId('iron_ingot'), count } : null
      }),
      refresh: vi.fn(async () => {
        if (inputCount > 0 && outputCount === 0) {
          outputCount = inputCount
          inputCount = 0
        }
      }),
    }

    mocks.getLastPlacedBlockRecord.mockReturnValue({
      type: 'furnace',
      position: recentPlacedPosition,
      at: Date.now(),
    })
    mocks.getBlockAtAccurate.mockResolvedValue(null)
    mocks.getNearestBlockAccurate.mockResolvedValue(null)
    mocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce(dedicatedPosition as any)
    mocks.getInventoryCounts.mockReturnValue({
      furnace: 1,
      raw_iron: 1,
      coal: 1,
    })

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'furnace', type: getItemId('furnace'), count: 1 },
            { name: 'raw_iron', type: getItemId('raw_iron'), count: 1 },
            { name: 'coal', type: getItemId('coal'), count: 1 },
          ],
        },
        lookAt: vi.fn(async () => undefined),
        openFurnace: vi.fn()
          .mockRejectedValueOnce(new Error('Furnace screen did not open'))
          .mockResolvedValueOnce(furnace),
        closeWindow: vi.fn(async () => undefined),
      },
    } as any

    const resultPromise = smeltItem(mineflayer, 'raw_iron', 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.placeBlock).toHaveBeenCalledWith(mineflayer, 'furnace', 3, 64, 0)
    expect(mineflayer.bot.openFurnace).toHaveBeenCalledTimes(2)
    expect(mineflayer.bot.openFurnace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        name: 'furnace',
        position: recentPlacedPosition,
      }),
    )
    expect(mineflayer.bot.openFurnace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        name: 'furnace',
        position: expect.objectContaining(dedicatedPosition),
      }),
    )
  })

  it('prefers the recent placeHere furnace record over an older nearby furnace', async () => {
    const recentPlacedPosition = { x: 1, y: 64, z: 0 }
    let fuelLoaded = false
    let inputCount = 0
    let outputCount = 0
    const furnace = {
      inputItem: () => inputCount > 0 ? { type: getItemId('raw_iron'), count: inputCount } : null,
      fuelItem: () => fuelLoaded ? { type: getItemId('coal'), count: 1 } : null,
      putFuel: vi.fn(async () => {
        fuelLoaded = true
      }),
      putInput: vi.fn(async (_type: number, _metadata: null, count: number) => {
        inputCount += count
      }),
      outputItem: () => outputCount > 0 ? { type: getItemId('iron_ingot'), count: outputCount } : null,
      takeOutput: vi.fn(async () => {
        const count = outputCount
        outputCount = 0
        return count > 0 ? { type: getItemId('iron_ingot'), count } : null
      }),
      refresh: vi.fn(async () => {
        if (inputCount > 0 && outputCount === 0) {
          outputCount = inputCount
          inputCount = 0
        }
      }),
    }

    mocks.getLastPlacedBlockRecord.mockReturnValue({
      type: 'furnace',
      position: recentPlacedPosition,
      at: Date.now(),
    })
    mocks.getBlockAtAccurate.mockResolvedValueOnce(null)
    mocks.getInventoryCounts.mockReturnValue({
      raw_iron: 1,
      coal: 1,
    })

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'raw_iron', type: getItemId('raw_iron'), count: 1 },
            { name: 'coal', type: getItemId('coal'), count: 1 },
          ],
        },
        lookAt: vi.fn(async () => undefined),
        openFurnace: vi.fn(async () => furnace),
        closeWindow: vi.fn(async () => undefined),
      },
    } as any

    const resultPromise = smeltItem(mineflayer, 'raw_iron', 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.getNearestBlockAccurate).not.toHaveBeenCalled()
    expect(mocks.goToNearestBlock).not.toHaveBeenCalled()
    expect(mineflayer.bot.openFurnace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'furnace',
        position: recentPlacedPosition,
      }),
    )
  })

  it('resumes smelting from furnace input when the raw item is already loaded and inventory is empty', async () => {
    const furnaceBlock = { name: 'furnace', position: { x: 2, y: 64, z: 0 } }
    let outputReady = false
    let outputTaken = false
    const furnace = {
      inputItem: () => ({ type: getItemId('raw_iron'), count: 1 }),
      fuelItem: () => ({ type: getItemId('coal'), count: 1 }),
      putFuel: vi.fn(async () => undefined),
      putInput: vi.fn(async () => undefined),
      outputItem: () => {
        if (outputTaken) {
          return null
        }
        return outputReady ? { type: getItemId('iron_ingot'), count: 1 } : null
      },
      takeOutput: vi.fn(async () => {
        outputTaken = true
        return { type: getItemId('iron_ingot'), count: 1 }
      }),
      refresh: vi.fn(async () => {
        outputReady = true
      }),
    }

    mocks.getNearestBlockAccurate.mockResolvedValue(furnaceBlock as any)
    mocks.getInventoryCounts.mockReturnValue({
      raw_iron: 0,
      coal: 0,
    })

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [],
        },
        lookAt: vi.fn(async () => undefined),
        openFurnace: vi.fn(async () => furnace),
        closeWindow: vi.fn(async () => undefined),
      },
    } as any

    const resultPromise = smeltItem(mineflayer, 'raw_iron', 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(furnace.putInput).not.toHaveBeenCalled()
    expect(furnace.takeOutput).toHaveBeenCalled()
  })

  it('retries furnace opening after refreshing the nearby target when the screen does not open', async () => {
    const initialFurnaceBlock = { name: 'furnace', position: { x: 4, y: 64, z: 0 } }
    const refreshedFurnaceBlock = { name: 'furnace', position: { x: 3, y: 64, z: 0 } }
    let fuelLoaded = false
    let inputCount = 0
    let outputCount = 0
    const furnace = {
      inputItem: () => inputCount > 0 ? { type: getItemId('raw_iron'), count: inputCount } : null,
      fuelItem: () => fuelLoaded ? { type: getItemId('coal'), count: 1 } : null,
      putFuel: vi.fn(async () => {
        fuelLoaded = true
      }),
      putInput: vi.fn(async (_type: number, _metadata: null, count: number) => {
        inputCount += count
      }),
      outputItem: () => outputCount > 0 ? { type: getItemId('iron_ingot'), count: outputCount } : null,
      takeOutput: vi.fn(async () => {
        const count = outputCount
        outputCount = 0
        return count > 0 ? { type: getItemId('iron_ingot'), count } : null
      }),
      refresh: vi.fn(async () => {
        if (inputCount > 0 && outputCount === 0) {
          outputCount = inputCount
          inputCount = 0
        }
      }),
    }

    mocks.getNearestBlockAccurate
      .mockResolvedValueOnce(initialFurnaceBlock as any)
      .mockResolvedValueOnce(refreshedFurnaceBlock as any)
    mocks.getInventoryCounts.mockReturnValue({
      raw_iron: 1,
      coal: 1,
    })

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'raw_iron', type: getItemId('raw_iron'), count: 1 },
            { name: 'coal', type: getItemId('coal'), count: 1 },
          ],
        },
        lookAt: vi.fn(async () => undefined),
        openFurnace: vi.fn()
          .mockRejectedValueOnce(new Error('Furnace screen did not open'))
          .mockResolvedValueOnce(furnace),
        closeWindow: vi.fn(async () => undefined),
      },
    } as any

    const resultPromise = smeltItem(mineflayer, 'raw_iron', 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mineflayer.bot.openFurnace).toHaveBeenNthCalledWith(1, initialFurnaceBlock)
    expect(mineflayer.bot.openFurnace).toHaveBeenNthCalledWith(2, refreshedFurnaceBlock)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 4, 64, 0, 2.5)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 3, 64, 0, 2.5)
    expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining('Furnace screen did not open'))
  })

  it('places a dedicated furnace when the selected one is busy with a different input', async () => {
    const occupiedFurnaceBlock = { name: 'furnace', position: { x: 5, y: 64, z: 0 } }
    const retryFurnacePosition = { x: 2, y: 64, z: 0 }
    let retryFuelLoaded = false
    let retryInputCount = 0
    let retryOutputCount = 0
    let placementLookups = 0
    const occupiedFurnace = {
      inputItem: () => ({ type: getItemId('birch_log'), count: 1 }),
      fuelItem: () => null,
      putFuel: vi.fn(async () => undefined),
      putInput: vi.fn(async () => undefined),
      outputItem: () => null,
      takeOutput: vi.fn(async () => null),
    }
    const retryFurnace = {
      inputItem: () => retryInputCount > 0 ? { type: getItemId('raw_iron'), count: retryInputCount } : null,
      fuelItem: () => retryFuelLoaded ? { type: getItemId('coal'), count: 1 } : null,
      putFuel: vi.fn(async () => {
        retryFuelLoaded = true
      }),
      putInput: vi.fn(async (_type: number, _metadata: null, count: number) => {
        retryInputCount += count
      }),
      outputItem: () => retryOutputCount > 0 ? { type: getItemId('iron_ingot'), count: retryOutputCount } : null,
      takeOutput: vi.fn(async () => {
        const count = retryOutputCount
        retryOutputCount = 0
        return count > 0 ? { type: getItemId('iron_ingot'), count } : null
      }),
      refresh: vi.fn(async () => {
        if (retryInputCount > 0 && retryOutputCount === 0) {
          retryOutputCount = retryInputCount
          retryInputCount = 0
        }
      }),
    }

    mocks.getLastPlacedBlockRecord.mockImplementation(() => {
      placementLookups++
      return placementLookups >= 2
        ? {
            type: 'furnace',
            position: retryFurnacePosition,
            at: Date.now(),
          }
        : null
    })
    mocks.getNearestBlockAccurate.mockResolvedValueOnce(occupiedFurnaceBlock as any)
    mocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce({ x: 2, y: 64, z: 0 } as any)
    mocks.getBlockAtAccurate.mockResolvedValueOnce(null)
    mocks.getInventoryCounts.mockReturnValue({
      furnace: 1,
      raw_iron: 1,
      coal: 1,
    })

    const mineflayer = {
      bot: {
        entity: { position: createPosition(5, 64, 0) },
        inventory: {
          items: () => [
            { name: 'furnace', type: getItemId('furnace'), count: 1 },
            { name: 'raw_iron', type: getItemId('raw_iron'), count: 1 },
            { name: 'coal', type: getItemId('coal'), count: 1 },
          ],
        },
        lookAt: vi.fn(async () => undefined),
        openFurnace: vi.fn()
          .mockResolvedValueOnce(occupiedFurnace)
          .mockResolvedValueOnce(retryFurnace),
        closeWindow: vi.fn(async () => undefined),
      },
    } as any

    const resultPromise = smeltItem(mineflayer, 'raw_iron', 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.placeBlock).toHaveBeenCalledWith(mineflayer, 'furnace', 2, 64, 0)
    expect(mineflayer.bot.closeWindow).toHaveBeenCalledTimes(2)
    expect(mineflayer.bot.openFurnace).toHaveBeenNthCalledWith(1, occupiedFurnaceBlock)
    expect(mineflayer.bot.openFurnace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        name: 'furnace',
        position: expect.objectContaining(retryFurnacePosition),
      }),
    )
  })

  it('resolves furnace fuel ids from item names when bridge inventory omits stack types', async () => {
    const furnaceBlock = { name: 'furnace', position: { x: 2, y: 64, z: 0 } }
    let fuelLoaded = false
    let inputCount = 0
    let outputCount = 0
    const furnace = {
      inputItem: () => inputCount > 0 ? { type: getItemId('raw_iron'), count: inputCount } : null,
      fuelItem: () => fuelLoaded ? { type: getItemId('coal'), count: 1 } : null,
      putFuel: vi.fn(async () => {
        fuelLoaded = true
      }),
      putInput: vi.fn(async (_type: number, _metadata: null, count: number) => {
        inputCount += count
      }),
      outputItem: () => outputCount > 0 ? { type: getItemId('iron_ingot'), count: outputCount } : null,
      takeOutput: vi.fn(async () => {
        const count = outputCount
        outputCount = 0
        return count > 0 ? { type: getItemId('iron_ingot'), count } : null
      }),
      refresh: vi.fn(async () => {
        if (inputCount > 0 && outputCount === 0) {
          outputCount = inputCount
          inputCount = 0
        }
      }),
    }

    mocks.getNearestBlockAccurate.mockReset()
    mocks.getNearestBlockAccurate.mockResolvedValue(furnaceBlock as any)
    mocks.getInventoryCounts.mockReturnValue({
      raw_iron: 1,
      coal: 1,
    })

    const mineflayer = {
      bot: {
        entity: { position: createPosition(0, 64, 0) },
        inventory: {
          items: () => [
            { name: 'raw_iron', type: getItemId('raw_iron'), count: 1 },
            { name: 'coal', count: 1 },
          ],
        },
        lookAt: vi.fn(async () => undefined),
        openFurnace: vi.fn(async () => furnace),
        closeWindow: vi.fn(async () => undefined),
      },
    } as any

    const resultPromise = smeltItem(mineflayer, 'raw_iron', 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(furnace.putFuel).toHaveBeenCalledWith(getItemId('coal'), null, 1)
  })
})
