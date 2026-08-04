import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureAxe, ensureCoal, ensureCobblestone, ensureCraftingTable, ensurePickaxe, ensurePlanks, ensureSticks, ensureSword, ensureTorches, resetEnsureTransientState } from './ensure'

const mocks = vi.hoisted(() => ({
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withError: vi.fn(),
    withFields: vi.fn(),
  },
  craftRecipe: vi.fn(async () => true),
  getLastCraftRecipeDiagnostic: vi.fn(() => null),
  getSelectedCraftRecipeRequirements: vi.fn(async () => null),
  smeltItem: vi.fn(async () => true),
  collectBlock: vi.fn(async () => true),
  gatherWood: vi.fn(async () => true),
  moveAway: vi.fn(async () => true),
  moveToHorizontalTarget: vi.fn(async () => true),
  getItemCount: vi.fn(() => 0),
  getActualItemCount: vi.fn(() => 0),
  getStrictVisibleItemCount: vi.fn(() => 0),
  getBridgeInventorySnapshot: vi.fn(async () => null),
  recordOptimisticItem: vi.fn(),
  discard: vi.fn(async () => true),
  confirmItemCount: vi.fn(async () => true),
  refreshInventoryState: vi.fn(async () => true),
  getNearestBlocksAccurate: vi.fn(async () => []),
  isBlockExposedAccurate: vi.fn(async () => true),
  pickupNearbyItems: vi.fn(async () => true),
}))

mocks.logger.withError.mockReturnValue(mocks.logger)
mocks.logger.withFields.mockReturnValue(mocks.logger)

function restoreDefaultStrictVisibleItemCountMock(): void {
  mocks.getStrictVisibleItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
    const normalizedItemName = itemName.replace(/^minecraft:/, '').trim().toLowerCase()
    const strictRawItems = _mineflayer?.bot?.getStrictRawInventoryItems?.()
    const visibleItems = Array.isArray(strictRawItems)
      ? strictRawItems
      : _mineflayer?.bot?.inventory?.items?.() ?? []
    const visibleCount = visibleItems
      .filter((item: { name?: string, count?: number } | null | undefined) =>
        item?.name?.replace(/^minecraft:/, '').trim().toLowerCase().includes(normalizedItemName))
      .reduce((total: number, item: { count?: number } | null | undefined) => total + (item?.count ?? 0), 0)

    if (visibleCount > 0) {
      return visibleCount
    }

    return (mocks.getActualItemCount as any)(_mineflayer, itemName)
  }) as any)
}

restoreDefaultStrictVisibleItemCountMock()

vi.mock('../../utils/logger', () => ({
  useLogger: () => mocks.logger,
}))

vi.mock('../crafting', () => ({
  craftRecipe: mocks.craftRecipe,
  getLastCraftRecipeDiagnostic: mocks.getLastCraftRecipeDiagnostic,
  getSelectedCraftRecipeRequirements: mocks.getSelectedCraftRecipeRequirements,
  smeltItem: mocks.smeltItem,
}))

vi.mock('./collect-block', () => ({
  collectBlock: mocks.collectBlock,
}))

vi.mock('./gather-wood', () => ({
  gatherWood: mocks.gatherWood,
}))

vi.mock('../movement', () => ({
  moveAway: mocks.moveAway,
  moveToHorizontalTarget: mocks.moveToHorizontalTarget,
}))

vi.mock('./inventory', () => ({
  discard: mocks.discard,
  getActualItemCount: mocks.getActualItemCount,
  getStrictVisibleItemCount: mocks.getStrictVisibleItemCount,
  getBridgeInventorySnapshot: mocks.getBridgeInventorySnapshot,
  getItemCount: mocks.getItemCount,
  recordOptimisticItem: mocks.recordOptimisticItem,
  confirmItemCount: mocks.confirmItemCount,
  refreshInventoryState: mocks.refreshInventoryState,
}))

vi.mock('../block-access', () => ({
  getNearestBlocksAccurate: mocks.getNearestBlocksAccurate,
  isBlockExposedAccurate: mocks.isBlockExposedAccurate,
}))

vi.mock('./world-interactions', () => ({
  pickupNearbyItems: mocks.pickupNearbyItems,
}))

describe('ensurePlanks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreDefaultStrictVisibleItemCountMock()
    vi.useFakeTimers()
    resetEnsureTransientState()
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue(null)
    mocks.getBridgeInventorySnapshot.mockResolvedValue(null)
    mocks.getSelectedCraftRecipeRequirements.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for delayed inventory sync after successful crafting', async () => {
    let crafted = false
    let postCraftReads = 0

    mocks.craftRecipe.mockImplementation(async () => {
      crafted = true
      return true
    })

    const mineflayer = {
      bot: {
        inventory: {
          items: () => {
            if (!crafted) {
              return [{ name: 'birch_log', count: 1 }]
            }

            postCraftReads++
            if (postCraftReads === 1) {
              return [{ name: 'birch_log', count: 1 }]
            }

            return [
              { name: 'birch_log', count: 1 },
              { name: 'birch_planks', count: 4 },
            ]
          },
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePlanks(mineflayer, 4)
    await vi.advanceTimersByTimeAsync(1000)

    await expect(resultPromise).resolves.toBe(true)
  })

  it('does not treat an unconfirmed plank craft RPC as progress', async () => {
    mocks.craftRecipe.mockResolvedValue(false)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'birch_log', count: 1 }],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePlanks(mineflayer, 4)
    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(false)
  })

  it('uses local plank stacks when strict bridge inventory is transiently empty during plank checks', async () => {
    const mineflayer = {
      bot: {
        getStrictRawInventoryItems: () => [],
        inventory: {
          items: () => [
            { name: 'birch_planks', count: 6 },
          ],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensurePlanks(mineflayer, 3)).resolves.toBe(true)
    expect(mocks.gatherWood).not.toHaveBeenCalled()
    expect(mocks.craftRecipe).not.toHaveBeenCalled()
  })

  it('accepts already-visible planks even when a previous plank failure is cooling down', async () => {
    const emptyInventoryBot = {
      bot: {
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensurePlanks(emptyInventoryBot, 4)).resolves.toBe(false)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [
            { name: 'oak_planks', count: 6 },
          ],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensurePlanks(mineflayer, 4)).resolves.toBe(true)
    expect(mocks.craftRecipe).not.toHaveBeenCalled()
  })

  it('re-records optimistic plank counts after a successful plank craft to avoid immediate re-crafting loops', async () => {
    mocks.craftRecipe.mockResolvedValue(true)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'birch_log', count: 1 }],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePlanks(mineflayer, 4)
    await vi.advanceTimersByTimeAsync(2000)

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.recordOptimisticItem).toHaveBeenCalledWith('birch_planks', 4)
  })

  it('does not treat tracked-only planks as enough when actual visible inventory is short', async () => {
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'planks') {
        return 6
      }
      return 0
    }) as any)

    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'planks') {
        return 2
      }
      return 0
    }) as any)

    const mineflayer = {
      bot: {
        getStrictRawInventoryItems: () => [
          { name: 'minecraft:oak_planks', count: 2, slot: 9 },
        ],
        inventory: {
          items: () => [
            { name: 'oak_planks', count: 6 },
          ],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePlanks(mineflayer, 5)
    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(false)
    expect(mocks.craftRecipe).not.toHaveBeenCalled()
    expect(mocks.logger.log).not.toHaveBeenCalledWith('Bot: Have enough planks.')
  })

  it('requests the minimal plank recipe repeat count instead of the raw plank shortfall', async () => {
    const state = {
      oak_log: 2,
      oak_planks: 0,
    }

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'planks') {
        return state.oak_planks
      }
      return 0
    }) as any)

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string, count: number = 1) => {
      if (itemName === 'oak_planks' && count === 2 && state.oak_log >= 2) {
        state.oak_log -= 2
        state.oak_planks += 8
        return true
      }

      return false
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => {
            const items = []
            if (state.oak_log > 0) {
              items.push({ name: 'oak_log', count: state.oak_log })
            }
            if (state.oak_planks > 0) {
              items.push({ name: 'oak_planks', count: state.oak_planks })
            }
            return items
          },
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensurePlanks(mineflayer, 8)).resolves.toBe(true)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'oak_planks', 2)
  })

  it('uses one plank recipe repeat when only one more plank is missing', async () => {
    const state = {
      oak_log: 3,
      oak_planks: 2,
    }

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'planks') {
        return state.oak_planks
      }
      return 0
    }) as any)

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string, count: number = 1) => {
      if (itemName === 'oak_planks' && count === 1 && state.oak_log >= 1) {
        state.oak_log -= 1
        state.oak_planks += 4
        return true
      }

      return false
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => {
            const items = []
            if (state.oak_log > 0) {
              items.push({ name: 'oak_log', count: state.oak_log })
            }
            if (state.oak_planks > 0) {
              items.push({ name: 'oak_planks', count: state.oak_planks })
            }
            return items
          },
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensurePlanks(mineflayer, 3)).resolves.toBe(true)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'oak_planks', 1)
  })
})

describe('ensureTorches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreDefaultStrictVisibleItemCountMock()
    vi.useFakeTimers()
    resetEnsureTransientState()
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue(null)
    mocks.getSelectedCraftRecipeRequirements.mockResolvedValue(null)
    mocks.getNearestBlocksAccurate.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('only requires one stick ingredient per four torches', async () => {
    let stickCount = 0
    let torchCount = 0

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string, num: number = 1) => {
      if (itemName === 'stick') {
        stickCount += 4 * num
        return true
      }

      if (itemName === 'torch') {
        if (stickCount < num) {
          throw new Error(`torch craft attempted without enough sticks: ${stickCount}`)
        }
        torchCount += 4 * num
        return true
      }

      return true
    }) as any)

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return stickCount
      }

      if (itemName === 'torch') {
        return torchCount
      }

      if (itemName === 'coal') {
        return 4
      }

      if (itemName === 'planks') {
        return 2
      }

      return 0
    }) as any)

    mocks.confirmItemCount.mockResolvedValue(true)

    const mineflayer = {
      bot: {
        inventory: {
          emptySlotCount: () => 4,
          items: () => [{ name: 'oak_planks', count: 2 }, { name: 'coal', count: 4 }],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureTorches(mineflayer, 16)).resolves.toBe(true)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'stick', 1)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'torch', 4)
  })

  it('frees one slot from low-priority blocks when inventory is full before torch crafting', async () => {
    let stickCount = 0
    let torchCount = 0
    let freeSlots = 0

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string, num: number = 1) => {
      if (itemName === 'stick') {
        stickCount += 4 * num
        return true
      }

      if (itemName === 'torch') {
        torchCount += 4 * num
        return true
      }

      return true
    }) as any)

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return stickCount
      }

      if (itemName === 'torch') {
        return torchCount
      }

      if (itemName === 'coal') {
        return 4
      }

      if (itemName === 'planks') {
        return 8
      }

      if (itemName === 'cobblestone') {
        return 192
      }

      return 0
    }) as any)

    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'cobblestone') {
        return 192
      }
      return 0
    }) as any)

    mocks.discard.mockImplementation(async () => {
      freeSlots = 1
      return true
    })

    const mineflayer = {
      bot: {
        inventory: {
          emptySlotCount: () => freeSlots,
          items: () => [{ name: 'oak_planks', count: 8 }, { name: 'coal', count: 4 }, { name: 'cobblestone', count: 64 }],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureTorches(mineflayer, 16)).resolves.toBe(true)
    expect(mocks.discard).toHaveBeenCalled()
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'torch', 4)
  })

  it('accepts charcoal as valid torch fuel', async () => {
    let stickCount = 0
    let torchCount = 0

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string, num: number = 1) => {
      if (itemName === 'stick') {
        stickCount += 4 * num
        return true
      }

      if (itemName === 'torch') {
        torchCount += 4 * num
        return true
      }

      return true
    }) as any)

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return stickCount
      }

      if (itemName === 'torch') {
        return torchCount
      }

      if (itemName === 'coal') {
        return 0
      }

      if (itemName === 'charcoal') {
        return 4
      }

      if (itemName === 'planks') {
        return 2
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          emptySlotCount: () => 4,
          items: () => [{ name: 'oak_planks', count: 2 }, { name: 'charcoal', count: 4 }],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureTorches(mineflayer, 16)).resolves.toBe(true)
    expect(mocks.smeltItem).not.toHaveBeenCalled()
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'torch', 4)
  })
})

describe('ensureCoal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreDefaultStrictVisibleItemCountMock()
    resetEnsureTransientState()
    mocks.getSelectedCraftRecipeRequirements.mockResolvedValue(null)
  })

  it('smelts logs into charcoal before trying to mine coal ore', async () => {
    let charcoalCount = 0

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'coal') {
        return 0
      }
      if (itemName === 'charcoal') {
        return charcoalCount
      }
      if (itemName === 'furnace') {
        return 1
      }
      return 0
    }) as any)
    mocks.smeltItem.mockImplementation((async (_mineflayer: any, itemName: string, count: number) => {
      if (itemName === 'oak_log') {
        charcoalCount += count
        return true
      }
      return false
    }) as any)

    const mineflayer = {
      bot: {
        heldItem: { name: 'stone_pickaxe', count: 1 },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }, { name: 'furnace', count: 1 }],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureCoal(mineflayer, 2)).resolves.toBe(true)
    expect(mocks.smeltItem).toHaveBeenCalledWith(mineflayer, 'oak_log', 2)
    expect(mocks.collectBlock).not.toHaveBeenCalled()
  })

  it('gathers only the remaining logs needed for charcoal fallback after partial smelting progress', async () => {
    let charcoalCount = 0
    let logCount = 2

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'coal') {
        return 0
      }
      if (itemName === 'charcoal') {
        return charcoalCount
      }
      if (itemName === 'furnace') {
        return 1
      }
      return 0
    }) as any)
    mocks.collectBlock.mockResolvedValue(false)
    mocks.gatherWood.mockImplementation((async (_mineflayer: any, targetLogs: number) => {
      logCount = targetLogs
      return true
    }) as any)
    mocks.smeltItem.mockImplementation((async (_mineflayer: any, itemName: string, count: number) => {
      if (itemName !== 'oak_log') {
        return false
      }

      const requiredFuelLogs = Math.ceil(count / 1.5)
      if (logCount < count + requiredFuelLogs) {
        return false
      }

      logCount -= count + requiredFuelLogs
      charcoalCount += count
      return true
    }) as any)

    const mineflayer = {
      bot: {
        heldItem: { name: 'stone_pickaxe', count: 1 },
        inventory: {
          items: () => [
            ...(logCount > 0 ? [{ name: 'oak_log', count: logCount }] : []),
            { name: 'furnace', count: 1 },
          ],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureCoal(mineflayer, 2)).resolves.toBe(true)
    expect(mocks.collectBlock).toHaveBeenCalledTimes(3)
    expect(mocks.gatherWood).toHaveBeenCalledWith(mineflayer, 2, 64)
    expect(mocks.smeltItem).toHaveBeenLastCalledWith(mineflayer, 'oak_log', 1)
  })
})

describe('ensureSticks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreDefaultStrictVisibleItemCountMock()
    vi.useFakeTimers()
    mocks.getSelectedCraftRecipeRequirements.mockResolvedValue(null)
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue(null)
    mocks.getBridgeInventorySnapshot.mockResolvedValue(null)
    mocks.getActualItemCount.mockReturnValue(0)
    mocks.getItemCount.mockReturnValue(0)
    mocks.confirmItemCount.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes inventory after crafting sticks and stops once sticks are visible', async () => {
    let hasSticks = false

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        hasSticks = true
      }
      return true
    }) as any)

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return hasSticks ? 4 : 0
      }

      if (itemName === 'planks') {
        return 4
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return hasSticks ? 4 : 0
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'oak_planks', count: 4 }],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureSticks(mineflayer, 2)).resolves.toBe(true)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'stick', 1)
    expect(mocks.confirmItemCount).toHaveBeenCalledWith(mineflayer, 'stick', 2, expect.objectContaining({
      actualOnly: true,
      localVisibleOnly: true,
    }))
  })

  it('can bootstrap stick crafting from two planks instead of requiring four', async () => {
    let hasSticks = false

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        hasSticks = true
      }
      return true
    }) as any)

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return hasSticks ? 4 : 0
      }

      if (itemName === 'planks') {
        return 2
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return hasSticks ? 4 : 0
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureSticks(mineflayer, 2)).resolves.toBe(true)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'stick', 1)
    expect(mocks.confirmItemCount).toHaveBeenCalledWith(mineflayer, 'stick', 2, expect.objectContaining({
      actualOnly: true,
      localVisibleOnly: true,
    }))
  })

  it('fails fast when stick crafting reports a bridge inventory sync mismatch', async () => {
    mocks.craftRecipe.mockResolvedValue(false)
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'stick',
      inventoryOnly: true,
      at: Date.now(),
    } as any)

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return 0
      }

      if (itemName === 'planks') {
        return 2
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureSticks(mineflayer, 2)).resolves.toBe(false)
    expect(mocks.craftRecipe).toHaveBeenCalledTimes(1)
  })

  it('does not accept optimistic stick state after the current stick craft succeeds but sync still lags', async () => {
    let craftedSticks = false

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        craftedSticks = true
      }
      return true
    }) as any)
    mocks.confirmItemCount.mockResolvedValue(false)
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'stick',
      inventoryOnly: true,
      at: Date.now(),
    } as any)

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return craftedSticks ? 4 : 0
      }

      if (itemName === 'planks') {
        return 2
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureSticks(mineflayer, 2)).resolves.toBe(false)
  })

  it('does not treat optimistic-only sticks from an earlier mismatch as confirmed craft inputs', async () => {
    mocks.confirmItemCount.mockResolvedValue(false)
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'stick',
      inventoryOnly: true,
      at: Date.now(),
    } as any)

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return 4
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return 0
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensureSticks(mineflayer, 2)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(false)
    expect(mocks.craftRecipe).not.toHaveBeenCalled()
  })

  it('does not treat a single visible stick as satisfying ensureSticks(2)', async () => {
    let craftedSticks = false

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        craftedSticks = true
      }
      return true
    }) as any)
    mocks.confirmItemCount.mockImplementation((async (_mineflayer: any, itemName: string, minCount: number) => {
      return itemName === 'stick' && minCount <= 1
    }) as any)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return craftedSticks ? 4 : 0
      }

      if (itemName === 'planks') {
        return 2
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return craftedSticks ? 1 : 0
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureSticks(mineflayer, 2)).resolves.toBe(false)
  })

  it('does not treat bridge-confirmed sticks as usable until they become locally visible', async () => {
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue(null)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return 4
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return 0
      }

      return 0
    }) as any)
    mocks.getStrictVisibleItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick') {
        return 0
      }

      return 0
    }) as any)
    mocks.getBridgeInventorySnapshot.mockResolvedValue([
      { name: 'minecraft:stick', count: 4 },
    ] as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensureSticks(mineflayer, 2)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(false)
    expect(mocks.craftRecipe).not.toHaveBeenCalled()
  })
})

describe('ensureCraftingTable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreDefaultStrictVisibleItemCountMock()
    vi.useFakeTimers()
    resetEnsureTransientState()
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue(null)
    mocks.getSelectedCraftRecipeRequirements.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not accept optimistic crafting-table state after a bridge inventory sync mismatch', async () => {
    let craftingTableReads = 0

    mocks.craftRecipe.mockResolvedValue(true)
    mocks.confirmItemCount.mockResolvedValue(false)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table') {
        craftingTableReads++
        return craftingTableReads >= 2 ? 1 : 0
      }

      if (itemName === 'planks') {
        return 4
      }

      return 0
    }) as any)
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'crafting_table',
      inventoryOnly: true,
      at: Date.now(),
    } as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [{ name: 'oak_planks', count: 4 }],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureCraftingTable(mineflayer)).resolves.toBe(false)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'crafting_table', 1)
  })

  it('accepts a reachable placed crafting table instead of crafting another portable table', async () => {
    mocks.getNearestBlocksAccurate.mockResolvedValue([
      {
        name: 'crafting_table',
        position: { x: 24, y: 66, z: 0 },
      },
    ] as any)

    const mineflayer = {
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          items: () => [{ name: 'oak_planks', count: 10 }],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureCraftingTable(mineflayer)).resolves.toBe(true)
    expect(mocks.craftRecipe).not.toHaveBeenCalled()
  })
})

describe('ensurePickaxe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreDefaultStrictVisibleItemCountMock()
    vi.useFakeTimers()
    resetEnsureTransientState()
    mocks.getBridgeInventorySnapshot.mockResolvedValue(null)
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue(null)
    mocks.getSelectedCraftRecipeRequirements.mockResolvedValue(null)
    mocks.pickupNearbyItems.mockResolvedValue(true)
    mocks.getNearestBlocksAccurate.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns false when bridge craft sync is already known to be blocked', async () => {
    mocks.craftRecipe.mockResolvedValue(false)
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'stick',
      inventoryOnly: true,
      at: Date.now(),
    } as any)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'stick' || itemName === 'pickaxe') {
        return 0
      }

      if (itemName === 'planks') {
        return 4
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(false)
  })

  it('accepts optimistic pickaxe state while bridge inventory sync catches up', async () => {
    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => itemName === 'wooden_pickaxe') as any)
    mocks.confirmItemCount.mockResolvedValue(false)
    mocks.getLastCraftRecipeDiagnostic.mockImplementation(() => ({
      kind: 'inventory_sync_mismatch',
      itemName: 'wooden_pickaxe',
      inventoryOnly: false,
      at: Date.now(),
    } as any))
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table' || itemName === 'pickaxe' || itemName === 'wooden_pickaxe') {
        return 1
      }

      if (itemName === 'stick') {
        return 2
      }

      if (itemName === 'planks') {
        return 4
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table' || itemName === 'pickaxe' || itemName === 'wooden_pickaxe') {
        return 1
      }

      if (itemName === 'stick') {
        return 2
      }

      if (itemName === 'planks') {
        return 4
      }

      return 0
    }) as any)
    mocks.getBridgeInventorySnapshot.mockResolvedValue(null)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
  })

  it('does not accept an optimistic generic pickaxe alias when the exact wooden tool name is still missing', async () => {
    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => itemName === 'wooden_pickaxe') as any)
    mocks.confirmItemCount.mockResolvedValue(false)
    mocks.getLastCraftRecipeDiagnostic.mockImplementation(() => ({
      kind: 'inventory_sync_mismatch',
      itemName: 'wooden_pickaxe',
      inventoryOnly: false,
      at: Date.now(),
    } as any))
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table' || itemName === 'stick' || itemName === 'planks') {
        return itemName === 'stick' ? 2 : itemName === 'planks' ? 4 : 1
      }

      if (itemName === 'pickaxe') {
        return 1
      }

      if (itemName === 'wooden_pickaxe') {
        return 0
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table' || itemName === 'stick' || itemName === 'planks') {
        return itemName === 'stick' ? 2 : itemName === 'planks' ? 4 : 1
      }

      if (itemName === 'pickaxe') {
        return 1
      }

      if (itemName === 'wooden_pickaxe') {
        return 0
      }

      return 0
    }) as any)
    mocks.getBridgeInventorySnapshot.mockResolvedValue(null)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(false)
  })

  it('ensures total wooden-tool plank requirements before crafting sticks for a pickaxe', async () => {
    const counts = {
      crafting_table: 1,
      oak_log: 1,
      oak_planks: 4,
      stick: 0,
      wooden_pickaxe: 0,
      pickaxe: 0,
      planks: 4,
    }

    const syncGenericCounts = (): void => {
      counts.planks = counts.oak_planks
      counts.pickaxe = counts.wooden_pickaxe
    }

    syncGenericCounts()

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => {
      if (itemName === 'oak_planks' && counts.oak_log >= 1) {
        counts.oak_log -= 1
        counts.oak_planks += 4
        syncGenericCounts()
        return true
      }

      if (itemName === 'stick' && counts.oak_planks >= 2) {
        counts.oak_planks -= 2
        counts.stick += 4
        syncGenericCounts()
        return true
      }

      if (itemName === 'wooden_pickaxe' && counts.oak_planks >= 3 && counts.stick >= 2) {
        counts.oak_planks -= 3
        counts.stick -= 2
        counts.wooden_pickaxe += 1
        syncGenericCounts()
        return true
      }

      return false
    }) as any)

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName in counts) {
        return counts[itemName as keyof typeof counts]
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName in counts) {
        return counts[itemName as keyof typeof counts]
      }

      return 0
    }) as any)
    mocks.confirmItemCount.mockImplementation((async (_mineflayer: any, itemName: string, minCount: number) => {
      if (itemName in counts) {
        return counts[itemName as keyof typeof counts] >= minCount
      }

      return false
    }) as any)
    mocks.getBridgeInventorySnapshot.mockResolvedValue(null)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => {
            const items = []
            if (counts.oak_log > 0) {
              items.push({ name: 'oak_log', count: counts.oak_log })
            }
            if (counts.oak_planks > 0) {
              items.push({ name: 'oak_planks', count: counts.oak_planks })
            }
            if (counts.stick > 0) {
              items.push({ name: 'stick', count: counts.stick })
            }
            if (counts.crafting_table > 0) {
              items.push({ name: 'crafting_table', count: counts.crafting_table })
            }
            if (counts.wooden_pickaxe > 0) {
              items.push({ name: 'wooden_pickaxe', count: counts.wooden_pickaxe })
            }
            return items
          },
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'oak_planks', 1)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'stick', 1)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'wooden_pickaxe', 1)
  })

  it('tops up the exact plank variant selected for a wooden pickaxe instead of relying on mixed plank totals', async () => {
    const counts = {
      crafting_table: 1,
      oak_log: 1,
      oak_planks: 2,
      birch_planks: 3,
      stick: 0,
      wooden_pickaxe: 0,
      pickaxe: 0,
      planks: 5,
    }

    const syncGenericCounts = (): void => {
      counts.planks = counts.oak_planks + counts.birch_planks
      counts.pickaxe = counts.wooden_pickaxe
    }

    syncGenericCounts()

    mocks.getSelectedCraftRecipeRequirements.mockImplementation((async (_mineflayer: any, itemName: string) => {
      if (itemName === 'wooden_pickaxe') {
        return [
          { itemName: 'oak_planks', count: 3 },
          { itemName: 'stick', count: 2 },
        ]
      }

      return null
    }) as any)

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string, count: number = 1) => {
      if (itemName === 'stick' && counts.oak_planks >= 2) {
        counts.oak_planks -= 2
        counts.stick += 4
        syncGenericCounts()
        return true
      }

      if (itemName === 'oak_planks' && count === 1 && counts.oak_log >= 1) {
        counts.oak_log -= 1
        counts.oak_planks += 4
        syncGenericCounts()
        return true
      }

      if (itemName === 'wooden_pickaxe' && counts.oak_planks >= 3 && counts.stick >= 2) {
        counts.oak_planks -= 3
        counts.stick -= 2
        counts.wooden_pickaxe += 1
        syncGenericCounts()
        return true
      }

      return false
    }) as any)

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName in counts) {
        return counts[itemName as keyof typeof counts]
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName in counts) {
        return counts[itemName as keyof typeof counts]
      }

      return 0
    }) as any)
    mocks.confirmItemCount.mockImplementation((async (_mineflayer: any, itemName: string, minCount: number) => {
      if (itemName in counts) {
        return counts[itemName as keyof typeof counts] >= minCount
      }

      return false
    }) as any)
    mocks.getBridgeInventorySnapshot.mockResolvedValue(null)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => {
            const items = []
            if (counts.oak_log > 0) {
              items.push({ name: 'oak_log', count: counts.oak_log })
            }
            if (counts.oak_planks > 0) {
              items.push({ name: 'oak_planks', count: counts.oak_planks })
            }
            if (counts.birch_planks > 0) {
              items.push({ name: 'birch_planks', count: counts.birch_planks })
            }
            if (counts.stick > 0) {
              items.push({ name: 'stick', count: counts.stick })
            }
            if (counts.crafting_table > 0) {
              items.push({ name: 'crafting_table', count: counts.crafting_table })
            }
            if (counts.wooden_pickaxe > 0) {
              items.push({ name: 'wooden_pickaxe', count: counts.wooden_pickaxe })
            }
            return items
          },
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'stick', 1)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'oak_planks', 1)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'wooden_pickaxe', 1)
  })

  it('treats a crafted pickaxe in the held slot as success even when inventory.items is stale', async () => {
    vi.useRealTimers()
    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => itemName === 'wooden_pickaxe') as any)
    mocks.confirmItemCount.mockResolvedValue(false)
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue(null)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table') {
        return 1
      }

      if (itemName === 'stick') {
        return 2
      }

      if (itemName === 'planks') {
        return 4
      }

      return 0
    }) as any)

    const mineflayer = {
      bot: {
        heldItem: { name: 'wooden_pickaxe', count: 1 },
        inventory: {
          items: () => [],
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensurePickaxe(mineflayer, 1)).resolves.toBe(true)
  })

  it('does not double-count a visible held pickaxe stack when the raw inventory already includes the selected slot', async () => {
    const state = {
      woodenPickaxe: 0,
    }

    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => {
      if (itemName === 'wooden_pickaxe') {
        state.woodenPickaxe = 1
        return true
      }

      return true
    }) as any)
    mocks.confirmItemCount.mockImplementation((async (_mineflayer: any, itemName: string, minCount: number) => {
      if (itemName === 'wooden_pickaxe') {
        return state.woodenPickaxe >= minCount
      }

      return true
    }) as any)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      switch (itemName) {
        case 'crafting_table':
          return 1
        case 'stick':
          return 2
        case 'planks':
          return 4
        case 'pickaxe':
        case 'wooden_pickaxe':
          return state.woodenPickaxe
        default:
          return 0
      }
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      switch (itemName) {
        case 'crafting_table':
          return 1
        case 'stick':
          return 2
        case 'planks':
          return 4
        case 'pickaxe':
        case 'wooden_pickaxe':
          return state.woodenPickaxe
        default:
          return 0
      }
    }) as any)

    const mineflayer = {
      bot: {
        getStrictRawInventoryItems: () => {
          const items = [
            { name: 'minecraft:oak_planks', count: 4, slot: 9 },
            { name: 'minecraft:stick', count: 2, slot: 10 },
            { name: 'minecraft:crafting_table', count: 1, slot: 11 },
          ]
          if (state.woodenPickaxe > 0) {
            items.push({ name: 'minecraft:wooden_pickaxe', count: 1, slot: 36 })
          }
          return items
        },
        inventory: {
          selectedSlot: 0,
          items: () => {
            const items = [
              { name: 'oak_planks', count: 4, slot: 9 },
              { name: 'stick', count: 2, slot: 10 },
              { name: 'crafting_table', count: 1, slot: 11 },
            ]
            if (state.woodenPickaxe > 0) {
              items.push({ name: 'wooden_pickaxe', count: 1, slot: 36 })
            }
            return items
          },
          slots: [],
        },
        get heldItem() {
          if (state.woodenPickaxe <= 0) {
            return undefined
          }

          return { name: 'wooden_pickaxe', count: 1 }
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mineflayer.bot.chat).toHaveBeenCalledWith('I have crafted a wooden pickaxe. Total pickaxe(s): 1/1')
  })

  it('does not report success from optimistic-only planks after a plank sync mismatch', async () => {
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'birch_planks',
      inventoryOnly: true,
      at: Date.now(),
    } as any)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'planks') {
        return 4
      }

      if (itemName === 'stick') {
        return 2
      }

      if (itemName === 'crafting_table') {
        return 1
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'planks') {
        return 2
      }

      if (itemName === 'stick') {
        return 2
      }

      if (itemName === 'crafting_table') {
        return 1
      }

      return 0
    }) as any)
    mocks.confirmItemCount.mockImplementation((async (_mineflayer: any, itemName: string, _count: number, options?: { actualOnly?: boolean }) => {
      if (itemName === 'planks' && options?.actualOnly) {
        return false
      }
      return false
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [
            { name: 'birch_planks', count: 2 },
            { name: 'stick', count: 2 },
            { name: 'crafting_table', count: 1 },
          ],
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(false)
    expect(mocks.craftRecipe).not.toHaveBeenCalled()
    expect(mocks.gatherWood).not.toHaveBeenCalled()
  })

  it('accepts local actual plank inputs when the bridge snapshot lags behind for a wooden pickaxe', async () => {
    mocks.confirmItemCount.mockResolvedValue(true)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table') {
        return 1
      }

      if (itemName === 'stick') {
        return 4
      }

      if (itemName === 'planks') {
        return 6
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table') {
        return 1
      }

      if (itemName === 'stick') {
        return 4
      }

      if (itemName === 'planks') {
        return 6
      }

      return 0
    }) as any)
    mocks.getBridgeInventorySnapshot.mockResolvedValue([
      { name: 'minecraft:birch_planks', count: 2 },
      { name: 'minecraft:stick', count: 4 },
      { name: 'minecraft:crafting_table', count: 1 },
    ] as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [
            { name: 'birch_planks', count: 6 },
            { name: 'stick', count: 4 },
            { name: 'crafting_table', count: 1 },
          ],
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'wooden_pickaxe', 1)
  })

  it('uses preserved canonical inventory inputs when bridge raw snapshots are transiently empty for a wooden pickaxe', async () => {
    mocks.confirmItemCount.mockResolvedValue(true)
    mocks.getBridgeInventorySnapshot.mockResolvedValue([] as any)
    mocks.getActualItemCount.mockReturnValue(0)
    mocks.getItemCount.mockReturnValue(0)

    const mineflayer = {
      bot: {
        getStrictRawInventoryItems: () => [],
        getRawInventoryItems: () => [],
        getCanonicalInventorySnapshot: () => ({
          slots: [
            { slotIndex: 4, itemName: 'birch_planks', count: 4 },
            { slotIndex: 10, itemName: 'stick', count: 3 },
            { slotIndex: 11, itemName: 'crafting_table', count: 1 },
          ],
          heldItem: { slotIndex: 0, itemName: 'dirt', count: 14 },
          offhand: null,
          armor: [],
        }),
        inventory: {
          selectedSlot: 0,
          items: () => [],
          slots: [],
        },
        heldItem: { name: 'dirt', count: 14 },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.gatherWood).not.toHaveBeenCalled()
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'wooden_pickaxe', 1)
    expect(mocks.craftRecipe).not.toHaveBeenCalledWith(mineflayer, 'stick', expect.anything())
  })

  it('waits for local plank and stick visibility before crafting a wooden pickaxe after recent input crafts', async () => {
    const state = {
      trackedPlanks: 6,
      trackedSticks: 4,
      actualPlanks: 0,
      actualSticks: 0,
      actualPickaxe: 0,
      craftingTable: 1,
      refreshCount: 0,
    }

    mocks.getLastCraftRecipeDiagnostic.mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'stick',
      inventoryOnly: true,
      at: Date.now(),
    } as any)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      switch (itemName) {
        case 'crafting_table':
          return state.craftingTable
        case 'planks':
          return state.trackedPlanks
        case 'stick':
          return state.trackedSticks
        case 'pickaxe':
        case 'wooden_pickaxe':
          return state.actualPickaxe
        default:
          return 0
      }
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      switch (itemName) {
        case 'crafting_table':
          return state.craftingTable
        case 'planks':
          return state.actualPlanks
        case 'stick':
          return state.actualSticks
        case 'pickaxe':
        case 'wooden_pickaxe':
          return state.actualPickaxe
        default:
          return 0
      }
    }) as any)
    mocks.refreshInventoryState.mockImplementation((async () => {
      state.refreshCount++
      if (state.refreshCount >= 5) {
        state.actualPlanks = 6
        state.actualSticks = 4
      }
      return true
    }) as any)
    mocks.confirmItemCount.mockImplementation((async (_mineflayer: any, itemName: string, minCount: number, options?: { actualOnly?: boolean }) => {
      if (itemName === 'planks' && options?.actualOnly) {
        return state.actualPlanks >= minCount
      }

      if (itemName === 'stick' && options?.actualOnly) {
        return state.actualSticks >= minCount
      }

      if (itemName === 'wooden_pickaxe') {
        return state.actualPickaxe >= minCount
      }

      return false
    }) as any)
    let localInputsVisibleOnCraft = false
    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => {
      if (itemName === 'wooden_pickaxe') {
        localInputsVisibleOnCraft = state.actualPlanks >= 3 && state.actualSticks >= 2
        if (!localInputsVisibleOnCraft) {
          throw new Error('wooden_pickaxe craft attempted before local inventory sync')
        }
        state.actualPickaxe = 1
        return true
      }

      return true
    }) as any)
    mocks.getBridgeInventorySnapshot.mockResolvedValue([
      { name: 'minecraft:oak_planks', count: 6 },
      { name: 'minecraft:stick', count: 4 },
      { name: 'minecraft:crafting_table', count: 1 },
    ] as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => {
            const items = []
            if (state.craftingTable > 0) {
              items.push({ name: 'crafting_table', count: state.craftingTable })
            }
            if (state.actualPlanks > 0) {
              items.push({ name: 'oak_planks', count: state.actualPlanks })
            }
            if (state.actualSticks > 0) {
              items.push({ name: 'stick', count: state.actualSticks })
            }
            if (state.actualPickaxe > 0) {
              items.push({ name: 'wooden_pickaxe', count: state.actualPickaxe })
            }
            return items
          },
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(localInputsVisibleOnCraft).toBe(true)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'wooden_pickaxe', 1)
  })

  it('does not continue a wooden pickaxe craft until bridge-confirmed sticks become locally visible', async () => {
    const state = {
      craftingTable: 1,
      actualPlanks: 6,
      trackedPlanks: 6,
      actualSticks: 0,
      trackedSticks: 4,
      actualPickaxe: 0,
    }

    mocks.getLastCraftRecipeDiagnostic.mockReturnValue(null)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      switch (itemName) {
        case 'crafting_table':
          return state.craftingTable
        case 'planks':
          return state.trackedPlanks
        case 'stick':
          return state.trackedSticks
        case 'pickaxe':
        case 'wooden_pickaxe':
          return state.actualPickaxe
        default:
          return 0
      }
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      switch (itemName) {
        case 'crafting_table':
          return state.craftingTable
        case 'planks':
          return state.actualPlanks
        case 'stick':
          return state.actualSticks
        case 'pickaxe':
        case 'wooden_pickaxe':
          return state.actualPickaxe
        default:
          return 0
      }
    }) as any)
    mocks.confirmItemCount.mockImplementation((async (_mineflayer: any, itemName: string, minCount: number) => {
      if (itemName === 'planks') {
        return state.actualPlanks >= minCount
      }
      if (itemName === 'wooden_pickaxe') {
        return state.actualPickaxe >= minCount
      }
      return false
    }) as any)
    mocks.getBridgeInventorySnapshot.mockResolvedValue([
      { name: 'minecraft:oak_planks', count: 6 },
      { name: 'minecraft:stick', count: 4 },
      { name: 'minecraft:crafting_table', count: 1 },
    ] as any)
    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => {
      if (itemName === 'wooden_pickaxe') {
        state.actualPickaxe = 1
        return true
      }
      return false
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [
            { name: 'oak_planks', count: state.actualPlanks },
            { name: 'crafting_table', count: state.craftingTable },
          ],
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(false)
    expect(mocks.craftRecipe).not.toHaveBeenCalledWith(mineflayer, 'wooden_pickaxe', 1)
    expect(mocks.craftRecipe).not.toHaveBeenCalledWith(mineflayer, 'stick', expect.anything())
  })

  it('does not enter wood recovery when pickaxe inputs remain optimistic-only without a fresh bridge diagnostic', async () => {
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table') {
        return 1
      }

      if (itemName === 'stick') {
        return 2
      }

      if (itemName === 'planks') {
        return 6
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'crafting_table') {
        return 1
      }

      if (itemName === 'stick') {
        return 2
      }

      if (itemName === 'planks') {
        return 2
      }

      return 0
    }) as any)
    mocks.confirmItemCount.mockImplementation((async (_mineflayer: any, itemName: string, _count: number, options?: { actualOnly?: boolean }) => {
      if (itemName === 'planks' && options?.actualOnly) {
        return false
      }

      return false
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => [
            { name: 'birch_planks', count: 2 },
            { name: 'stick', count: 2 },
            { name: 'crafting_table', count: 1 },
          ],
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(false)
    expect(mocks.gatherWood).not.toHaveBeenCalled()
    expect(mocks.craftRecipe).not.toHaveBeenCalled()
  })

  it('recovers nearby dropped pickaxe inputs before falling back to wood gathering', async () => {
    const state = {
      oak_planks: 0,
      stick: 0,
      crafting_table: 0,
      wooden_pickaxe: 0,
      pickaxe: 0,
    }

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName in state) {
        return state[itemName as keyof typeof state]
      }

      if (itemName === 'planks') {
        return state.oak_planks
      }

      return 0
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName in state) {
        return state[itemName as keyof typeof state]
      }

      if (itemName === 'planks') {
        return state.oak_planks
      }

      return 0
    }) as any)
    mocks.confirmItemCount.mockImplementation((async (_mineflayer: any, itemName: string, minCount: number) => {
      if (itemName in state) {
        return state[itemName as keyof typeof state] >= minCount
      }

      if (itemName === 'planks') {
        return state.oak_planks >= minCount
      }

      return false
    }) as any)
    mocks.pickupNearbyItems.mockImplementation((async () => {
      state.oak_planks = 4
      state.stick = 2
      state.crafting_table = 1
      return true
    }) as any)
    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string) => {
      if (itemName === 'wooden_pickaxe' && state.oak_planks >= 3 && state.stick >= 2) {
        state.oak_planks -= 3
        state.stick -= 2
        state.wooden_pickaxe += 1
        state.pickaxe = 1
        return true
      }

      return false
    }) as any)

    const mineflayer = {
      bot: {
        entity: {
          position: {
            distanceTo: () => 3,
          },
        },
        nearestEntity: vi.fn(() => ({
          id: 1,
          name: 'item',
          onGround: true,
          distance: 3,
          position: {
            distanceTo: () => 3,
          },
        })),
        inventory: {
          items: () => {
            const items = []
            if (state.oak_planks > 0) {
              items.push({ name: 'oak_planks', count: state.oak_planks })
            }
            if (state.stick > 0) {
              items.push({ name: 'stick', count: state.stick })
            }
            if (state.crafting_table > 0) {
              items.push({ name: 'crafting_table', count: state.crafting_table })
            }
            if (state.wooden_pickaxe > 0) {
              items.push({ name: 'wooden_pickaxe', count: state.wooden_pickaxe })
            }
            return items
          },
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensurePickaxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.pickupNearbyItems).toHaveBeenCalledWith(mineflayer, 8)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'wooden_pickaxe', 1)
    expect(mocks.gatherWood).not.toHaveBeenCalled()
  })
})

describe('ensureAxe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreDefaultStrictVisibleItemCountMock()
    vi.useFakeTimers()
    resetEnsureTransientState()
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue(null)
    mocks.getBridgeInventorySnapshot.mockResolvedValue(null)
    mocks.getSelectedCraftRecipeRequirements.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries the actual axe craft after a last-chance plank recovery instead of exhausting attempts early', async () => {
    const state = {
      oak_log: 1,
      oak_planks: 14,
      stick: 0,
      crafting_table: 1,
      wooden_axe: 0,
      recovered: false,
    }
    let failedAxeCraftsBeforeRecovery = 0

    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      switch (itemName) {
        case 'planks':
          return state.oak_planks
        case 'stick':
          return state.stick
        case 'crafting_table':
          return state.crafting_table
        case 'axe':
        case 'wooden_axe':
          return state.wooden_axe
        case 'oak_log':
          return state.oak_log
        default:
          return 0
      }
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      switch (itemName) {
        case 'planks':
          return state.oak_planks
        case 'stick':
          return state.stick
        case 'crafting_table':
          return state.crafting_table
        case 'axe':
        case 'wooden_axe':
          return state.wooden_axe
        case 'oak_log':
          return state.oak_log
        default:
          return 0
      }
    }) as any)
    mocks.confirmItemCount.mockImplementation((async (_mineflayer: any, itemName: string, minCount: number) => {
      switch (itemName) {
        case 'planks':
          return state.oak_planks >= minCount
        case 'stick':
          return state.stick >= minCount
        case 'crafting_table':
          return state.crafting_table >= minCount
        case 'wooden_axe':
        case 'axe':
          return state.wooden_axe >= minCount
        default:
          return false
      }
    }) as any)
    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string, count: number = 1) => {
      if (itemName === 'stick' && state.oak_planks >= (count * 2)) {
        state.oak_planks -= count * 2
        state.stick += count * 4
        return true
      }

      if (itemName === 'oak_planks' && state.oak_log >= count) {
        state.oak_log -= count
        state.oak_planks += count * 4
        state.recovered = true
        return true
      }

      if (itemName === 'wooden_axe') {
        if (!state.recovered) {
          failedAxeCraftsBeforeRecovery++
          state.stick = 0
          return false
        }

        if (state.oak_planks >= 3 && state.stick >= 2) {
          state.oak_planks -= 3
          state.stick -= 2
          state.wooden_axe += count
          return true
        }
      }

      return false
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => {
            const items = []
            if (state.oak_log > 0) {
              items.push({ name: 'oak_log', count: state.oak_log })
            }
            if (state.oak_planks > 0) {
              items.push({ name: 'oak_planks', count: state.oak_planks })
            }
            if (state.stick > 0) {
              items.push({ name: 'stick', count: state.stick })
            }
            if (state.crafting_table > 0) {
              items.push({ name: 'crafting_table', count: state.crafting_table })
            }
            if (state.wooden_axe > 0) {
              items.push({ name: 'wooden_axe', count: state.wooden_axe })
            }
            return items
          },
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensureAxe(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(failedAxeCraftsBeforeRecovery).toBeGreaterThan(0)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'oak_planks', 1)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'wooden_axe', 1)
  })
})

describe('ensureSword', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreDefaultStrictVisibleItemCountMock()
    vi.useFakeTimers()
    resetEnsureTransientState()
    mocks.getLastCraftRecipeDiagnostic.mockReturnValue(null)
    mocks.getBridgeInventorySnapshot.mockResolvedValue(null)
    mocks.getSelectedCraftRecipeRequirements.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('budgets enough planks for the crafting table and sticks before crafting a wooden sword', async () => {
    const state = {
      oak_log: 2,
      oak_planks: 0,
      stick: 0,
      crafting_table: 0,
      wooden_sword: 0,
    }

    mocks.confirmItemCount.mockResolvedValue(true)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      switch (itemName) {
        case 'planks':
          return state.oak_planks
        case 'stick':
          return state.stick
        case 'crafting_table':
          return state.crafting_table
        case 'sword':
        case 'wooden_sword':
          return state.wooden_sword
        default:
          return 0
      }
    }) as any)
    mocks.getActualItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      switch (itemName) {
        case 'planks':
          return state.oak_planks
        case 'stick':
          return state.stick
        case 'crafting_table':
          return state.crafting_table
        case 'sword':
        case 'wooden_sword':
          return state.wooden_sword
        default:
          return 0
      }
    }) as any)
    mocks.craftRecipe.mockImplementation((async (_mineflayer: any, itemName: string, count: number) => {
      if (itemName === 'oak_planks') {
        if (state.oak_log < count) {
          return false
        }
        state.oak_log -= count
        state.oak_planks += count * 4
        return true
      }

      if (itemName === 'crafting_table' && state.oak_planks >= 4) {
        state.oak_planks -= 4
        state.crafting_table += count
        return true
      }

      if (itemName === 'stick' && state.oak_planks >= (count * 2)) {
        state.oak_planks -= count * 2
        state.stick += count * 4
        return true
      }

      if (itemName === 'wooden_sword' && state.oak_planks >= 2 && state.stick >= 1) {
        state.oak_planks -= 2
        state.stick -= 1
        state.wooden_sword += count
        return true
      }

      return false
    }) as any)

    const mineflayer = {
      bot: {
        inventory: {
          items: () => {
            const items = []
            if (state.oak_log > 0) {
              items.push({ name: 'oak_log', count: state.oak_log })
            }
            if (state.oak_planks > 0) {
              items.push({ name: 'oak_planks', count: state.oak_planks })
            }
            if (state.stick > 0) {
              items.push({ name: 'stick', count: state.stick })
            }
            if (state.crafting_table > 0) {
              items.push({ name: 'crafting_table', count: state.crafting_table })
            }
            if (state.wooden_sword > 0) {
              items.push({ name: 'wooden_sword', count: state.wooden_sword })
            }
            return items
          },
          slots: [],
        },
        chat: vi.fn(),
      },
    } as any

    const resultPromise = ensureSword(mineflayer, 1)
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe(true)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'oak_planks', 2)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'crafting_table', 1)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'stick', 1)
    expect(mocks.craftRecipe).toHaveBeenCalledWith(mineflayer, 'wooden_sword', 1)
  })
})

describe('ensureCobblestone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreDefaultStrictVisibleItemCountMock()
    resetEnsureTransientState()
    mocks.getSelectedCraftRecipeRequirements.mockResolvedValue(null)
  })

  it('collects cobblestone by querying both stone and cobblestone blocks', async () => {
    let cobblestone = 0

    mocks.collectBlock.mockImplementation((async (_mineflayer: any, blockType: string) => {
      if (blockType === 'cobblestone') {
        cobblestone = 3
        return true
      }
      return false
    }) as any)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'cobblestone') {
        return cobblestone
      }
      return 0
    }) as any)

    const mineflayer = {
      bot: {
        heldItem: { name: 'stone_pickaxe', count: 1 },
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureCobblestone(mineflayer, 3, 4)).resolves.toBe(true)
    expect(mocks.collectBlock).toHaveBeenCalledWith(mineflayer, 'cobblestone', 3, 4)
  })

  it('relocates toward exposed stone after repeated empty local scans', async () => {
    let cobblestone = 0
    let attempts = 0

    mocks.collectBlock.mockImplementation((async (_mineflayer: any, _blockType: string, _num: number, range: number) => {
      attempts++
      if (attempts === 1) {
        expect(range).toBe(4)
        return false
      }
      expect(range).toBe(16)
      cobblestone = 3
      return true
    }) as any)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'cobblestone') {
        return cobblestone
      }
      return 0
    }) as any)
    mocks.getNearestBlocksAccurate.mockResolvedValue([
      {
        name: 'stone',
        position: { x: 18, y: 64, z: 0 },
      },
    ] as any)
    mocks.isBlockExposedAccurate.mockResolvedValue(true)

    const mineflayer = {
      bot: {
        heldItem: { name: 'stone_pickaxe', count: 1 },
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureCobblestone(mineflayer, 3, 4)).resolves.toBe(true)
    expect(mocks.moveToHorizontalTarget).toHaveBeenCalledWith(mineflayer, 18, 0)
    expect(mocks.moveAway).not.toHaveBeenCalled()
  })

  it('widens the third local cobblestone scan enough to reach mid-range surface stone', async () => {
    let attempts = 0
    const ranges: number[] = []

    mocks.collectBlock.mockImplementation((async (_mineflayer: any, _blockType: string, _num: number, range: number) => {
      attempts++
      ranges.push(range)
      return attempts >= 3
    }) as any)
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'cobblestone') {
        return attempts >= 3 ? 3 : 0
      }
      return 0
    }) as any)
    mocks.getNearestBlocksAccurate.mockResolvedValue([])

    const mineflayer = {
      bot: {
        heldItem: { name: 'stone_pickaxe', count: 1 },
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureCobblestone(mineflayer, 3, 4)).resolves.toBe(true)
    expect(ranges).toEqual([4, 16, 40])
  })

  it('fails fast after repeated empty cobblestone scans instead of wandering indefinitely', async () => {
    mocks.collectBlock.mockResolvedValue(false)
    mocks.getNearestBlocksAccurate.mockResolvedValue([])
    mocks.getItemCount.mockImplementation(((_mineflayer: any, itemName: string) => {
      if (itemName === 'cobblestone') {
        return 0
      }
      return 0
    }) as any)

    const mineflayer = {
      bot: {
        heldItem: { name: 'stone_pickaxe', count: 1 },
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          items: () => [],
        },
        chat: vi.fn(),
      },
    } as any

    await expect(ensureCobblestone(mineflayer, 3, 4)).resolves.toBe(false)
    expect(mocks.collectBlock).toHaveBeenCalledTimes(3)
    expect(mocks.moveAway).toHaveBeenCalledTimes(2)
  })
})
