import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BridgeUnsupportedCommandError } from '../../libs/fabric-bridge/bot-proxy'
import { buildCanonicalInventorySnapshot } from '../../libs/inventory/policy'
import {
  clearOptimisticItems,
  confirmItemCount,
  getActualItemCount,
  getItemCount,
  organizeInventory,
  preflightInventoryForAction,
  recordOptimisticItem,
  recoverInventoryFailure,
  refreshInventoryState,
  verifyInventoryPostflight,
} from './inventory'

describe('inventory optimistic items', () => {
  beforeEach(() => {
    clearOptimisticItems()
  })

  it('surfaces recently crafted items even when the live inventory snapshot is stale', () => {
    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
      },
    } as any

    recordOptimisticItem('crafting_table', 1)

    expect(getItemCount(mineflayer, 'crafting_table')).toBe(1)
  })

  it('keeps actual inventory reads separate from optimistic item tracking', () => {
    const mineflayer = {
      bot: {
        inventory: {
          items: () => [],
        },
      },
    } as any

    recordOptimisticItem('crafting_table', 1)

    expect(getActualItemCount(mineflayer, 'crafting_table')).toBe(0)
    expect(getItemCount(mineflayer, 'crafting_table')).toBe(1)
  })

  it('uses the raw bridge-visible inventory for actual counts when the guarded cache is ahead', () => {
    const mineflayer = {
      bot: {
        getRawInventoryItems: () => [{
          slot: 10,
          name: 'minecraft:oak_planks',
          count: 4,
        }],
        inventory: {
          selectedSlot: 0,
          items: () => [{ name: 'oak_planks', count: 8 }],
          slots: [],
        },
      },
    } as any

    expect(getActualItemCount(mineflayer, 'planks')).toBe(4)
    expect(getItemCount(mineflayer, 'planks')).toBe(4)
  })

  it('prefers confirmed guarded bridge inventory over stale strict raw counts for actual reads', () => {
    const mineflayer = {
      bot: {
        getStrictRawInventoryItems: () => [{
          slot: 10,
          name: 'minecraft:oak_planks',
          count: 2,
        }],
        getRawInventoryItems: () => [{
          slot: 10,
          name: 'minecraft:oak_planks',
          count: 6,
        }],
        inventory: {
          selectedSlot: 0,
          items: () => [{ name: 'oak_planks', count: 6 }],
          slots: [],
        },
      },
    } as any

    expect(getActualItemCount(mineflayer, 'planks')).toBe(6)
  })

  it('does not let guarded raw inventory override a newer strict bridge snapshot when local visibility is also stale', () => {
    const mineflayer = {
      bot: {
        getStrictRawInventoryItems: () => [],
        getRawInventoryItems: () => [{
          slot: 10,
          name: 'minecraft:oak_planks',
          count: 6,
        }],
        inventory: {
          selectedSlot: 0,
          items: () => [],
          slots: [],
        },
      },
    } as any

    expect(getActualItemCount(mineflayer, 'planks')).toBe(0)
  })

  it('keeps optimistic items after a bridge inventory refresh when the snapshot is still stale', async () => {
    const refreshInventory = vi.fn(async () => undefined)
    const mineflayer = {
      bot: {
        refreshInventory,
        inventory: {
          items: () => [],
        },
      },
    } as any

    recordOptimisticItem('crafting_table', 1)
    expect(getItemCount(mineflayer, 'crafting_table')).toBe(1)

    await expect(refreshInventoryState(mineflayer)).resolves.toBe(true)
    expect(getItemCount(mineflayer, 'crafting_table')).toBe(1)
  })

  it('clears optimistic items once the refreshed inventory reflects the crafted item', async () => {
    let refreshed = false
    const mineflayer = {
      bot: {
        refreshInventory: vi.fn(async () => {
          refreshed = true
        }),
        inventory: {
          items: () => refreshed ? [{ name: 'crafting_table', count: 1 }] : [],
        },
      },
    } as any

    recordOptimisticItem('crafting_table', 1)
    expect(getItemCount(mineflayer, 'crafting_table')).toBe(1)

    await expect(refreshInventoryState(mineflayer)).resolves.toBe(true)
    expect(getItemCount(mineflayer, 'crafting_table')).toBe(1)
    expect(getActualItemCount(mineflayer, 'crafting_table')).toBe(1)
  })

  it('confirms item presence after a delayed bridge refresh', async () => {
    let refreshed = false
    const inventoryItems = () => refreshed
      ? [{ name: 'crafting_table', count: 1 }]
      : []

    const mineflayer = {
      bot: {
        refreshInventory: vi.fn(async () => {
          refreshed = true
        }),
        inventory: {
          items: inventoryItems,
        },
      },
    } as any

    await expect(confirmItemCount(mineflayer, 'crafting_table', 1, { attempts: 2, delayMs: 1 })).resolves.toBe(true)
  })

  it('returns false when neither optimistic state nor bridge refresh confirms the item', async () => {
    const mineflayer = {
      bot: {
        refreshInventory: vi.fn(async () => undefined),
        inventory: {
          items: () => [],
        },
      },
    } as any

    await expect(confirmItemCount(mineflayer, 'wooden_pickaxe', 1, { attempts: 2, delayMs: 1 })).resolves.toBe(false)
  })

  it('can require actual inventory confirmation instead of optimistic counts', async () => {
    const mineflayer = {
      bot: {
        refreshInventory: vi.fn(async () => undefined),
        inventory: {
          items: () => [],
        },
      },
    } as any

    recordOptimisticItem('crafting_table', 1)

    await expect(confirmItemCount(mineflayer, 'crafting_table', 1, {
      attempts: 2,
      delayMs: 1,
      actualOnly: true,
    })).resolves.toBe(false)
  })

  it('treats an equipped crafted tool as actual confirmation when the inventory list is stale', async () => {
    const mineflayer = {
      bot: {
        heldItem: { name: 'wooden_pickaxe', count: 1 },
        refreshInventory: vi.fn(async () => undefined),
        inventory: {
          items: () => [],
          slots: [],
        },
      },
    } as any

    await expect(confirmItemCount(mineflayer, 'wooden_pickaxe', 1, {
      attempts: 1,
      delayMs: 1,
      actualOnly: true,
      refresh: false,
    })).resolves.toBe(true)
  })

  it('uses the freshest actual count across bridge snapshots and local inventory items', async () => {
    const mineflayer = {
      bot: {
        getInventorySnapshot: vi.fn(async () => ({
          items: [{ name: 'minecraft:birch_planks', count: 2 }],
          selectedSlot: 0,
        })),
        refreshInventory: vi.fn(async () => undefined),
        inventory: {
          items: () => [{ name: 'birch_planks', count: 6 }],
        },
      },
    } as any

    await expect(confirmItemCount(mineflayer, 'planks', 6, {
      attempts: 1,
      delayMs: 1,
      actualOnly: true,
      refresh: false,
    })).resolves.toBe(true)
  })

  it('still accepts bridge snapshots when they are ahead of the local inventory view', async () => {
    const mineflayer = {
      bot: {
        getInventorySnapshot: vi.fn(async () => ({
          items: [{ name: 'minecraft:birch_planks', count: 6 }],
          selectedSlot: 0,
        })),
        refreshInventory: vi.fn(async () => undefined),
        inventory: {
          items: () => [{ name: 'birch_planks', count: 2 }],
        },
      },
    } as any

    await expect(confirmItemCount(mineflayer, 'planks', 6, {
      attempts: 1,
      delayMs: 1,
      actualOnly: true,
      refresh: false,
    })).resolves.toBe(true)
  })

  it('can require local inventory visibility even when the bridge snapshot is ahead', async () => {
    const mineflayer = {
      bot: {
        getInventorySnapshot: vi.fn(async () => ({
          items: [{ name: 'minecraft:birch_planks', count: 6 }],
          selectedSlot: 0,
        })),
        refreshInventory: vi.fn(async () => undefined),
        inventory: {
          items: () => [{ name: 'birch_planks', count: 2 }],
        },
      },
    } as any

    await expect(confirmItemCount(mineflayer, 'planks', 6, {
      attempts: 1,
      delayMs: 1,
      actualOnly: true,
      localVisibleOnly: true,
      refresh: false,
    })).resolves.toBe(false)
  })

  it('does not treat guarded inventory as local-visible confirmation when strict raw still regressed the craft', async () => {
    const mineflayer = {
      bot: {
        getStrictRawInventoryItems: () => [{
          slot: 10,
          name: 'minecraft:oak_planks',
          count: 2,
        }],
        getRawInventoryItems: () => [{
          slot: 10,
          name: 'minecraft:oak_planks',
          count: 6,
        }],
        refreshInventory: vi.fn(async () => undefined),
        inventory: {
          selectedSlot: 0,
          items: () => [{ name: 'oak_planks', count: 6 }],
          slots: [],
        },
      },
    } as any

    await expect(confirmItemCount(mineflayer, 'oak_planks', 6, {
      attempts: 1,
      delayMs: 1,
      actualOnly: true,
      localVisibleOnly: true,
      refresh: false,
    })).resolves.toBe(false)
  })

  it('still treats an equipped item as local-visible when strict raw inventory lags behind the hotbar state', async () => {
    const mineflayer = {
      bot: {
        heldItem: { name: 'wooden_pickaxe', count: 1 },
        getStrictRawInventoryItems: () => [],
        refreshInventory: vi.fn(async () => undefined),
        inventory: {
          selectedSlot: 0,
          items: () => [],
          slots: [{ name: 'wooden_pickaxe', count: 1 }],
        },
      },
    } as any

    await expect(confirmItemCount(mineflayer, 'wooden_pickaxe', 1, {
      attempts: 1,
      delayMs: 1,
      actualOnly: true,
      localVisibleOnly: true,
      refresh: false,
    })).resolves.toBe(true)
  })

  it('can require consecutive local-visible confirmations to reject one-frame craft flickers', async () => {
    let refreshes = 0
    const mineflayer = {
      bot: {
        refreshInventory: vi.fn(async () => {
          refreshes++
        }),
        getRawInventoryItems: () => {
          if (refreshes === 0) {
            return []
          }
          if (refreshes === 1) {
            return [{ slot: 10, name: 'minecraft:oak_planks', count: 4 }]
          }
          return []
        },
        inventory: {
          selectedSlot: 0,
          items: () => [],
          slots: [],
        },
      },
    } as any

    await expect(confirmItemCount(mineflayer, 'oak_planks', 4, {
      attempts: 3,
      delayMs: 1,
      actualOnly: true,
      localVisibleOnly: true,
      consecutiveSuccessesNeeded: 2,
    })).resolves.toBe(false)
  })

  it('does not let a final single visible read satisfy a multi-read confirmation requirement', async () => {
    const mineflayer = {
      bot: {
        getRawInventoryItems: () => [{
          slot: 10,
          name: 'minecraft:oak_planks',
          count: 4,
        }],
        inventory: {
          selectedSlot: 0,
          items: () => [],
          slots: [],
        },
      },
    } as any

    await expect(confirmItemCount(mineflayer, 'oak_planks', 4, {
      attempts: 1,
      delayMs: 1,
      refresh: false,
      actualOnly: true,
      localVisibleOnly: true,
      consecutiveSuccessesNeeded: 2,
    })).resolves.toBe(false)
  })

  function createInventoryAutomationFixture(options?: { unsupportedCompactInventory?: boolean, unsupportedSwapInventorySlots?: boolean, unsupportedSelectHotbarSlot?: boolean }) {
    const state = {
      selectedSlot: 5,
      equippedHandSlot: null as number | null,
      offhandItem: null as null | { slot: number, name: string, count: number, maxCount: number, durability: number, maxDurability: number },
      rawItems: [
        { slot: 0, name: 'minecraft:dirt', count: 8, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 1, name: 'minecraft:cobblestone', count: 17, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 2, name: 'minecraft:raw_beef', count: 2, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 3, name: 'minecraft:stick', count: 5, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 4, name: 'minecraft:furnace', count: 1, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 5, name: 'minecraft:stone_pickaxe', count: 1, maxCount: 1, durability: 12, maxDurability: 131 },
        { slot: 6, name: 'minecraft:wooden_sword', count: 1, maxCount: 1, durability: 25, maxDurability: 59 },
        { slot: 7, name: 'minecraft:coal', count: 4, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 8, name: 'minecraft:gravel', count: 12, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 9, name: 'minecraft:cobblestone', count: 21, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 10, name: 'minecraft:dirt', count: 11, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 11, name: 'minecraft:bread', count: 5, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 12, name: 'minecraft:iron_pickaxe', count: 1, maxCount: 1, durability: 140, maxDurability: 250 },
        { slot: 13, name: 'minecraft:stone_sword', count: 1, maxCount: 1, durability: 110, maxDurability: 131 },
        { slot: 14, name: 'minecraft:torch', count: 12, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 15, name: 'minecraft:oak_planks', count: 24, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 16, name: 'minecraft:crafting_table', count: 1, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 17, name: 'minecraft:charcoal', count: 3, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 18, name: 'minecraft:cobblestone', count: 11, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 19, name: 'minecraft:gravel', count: 16, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 20, name: 'minecraft:oak_log', count: 7, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 21, name: 'minecraft:stone', count: 9, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 22, name: 'minecraft:apple', count: 1, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 23, name: 'minecraft:rotten_flesh', count: 7, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 24, name: 'minecraft:andesite', count: 22, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 25, name: 'minecraft:wheat_seeds', count: 14, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 26, name: 'minecraft:sand', count: 6, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 27, name: 'minecraft:oak_planks', count: 11, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 28, name: 'minecraft:coal', count: 5, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 29, name: 'minecraft:torch', count: 8, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 30, name: 'minecraft:furnace', count: 1, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 31, name: 'minecraft:stick', count: 4, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 32, name: 'minecraft:diorite', count: 19, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 33, name: 'minecraft:cobblestone', count: 6, maxCount: 64, durability: 0, maxDurability: 0 },
        { slot: 34, name: 'minecraft:dirt', count: 7, maxCount: 64, durability: 0, maxDurability: 0 },
      ],
    }

    const toBotItem = (item: typeof state.rawItems[number]) => ({
      type: item.slot + 1,
      name: item.name.replace(/^minecraft:/, ''),
      count: item.count,
      slot: item.slot < 9 ? item.slot + 36 : item.slot,
      durability: item.durability,
      maxDurability: item.maxDurability,
    })
    const findRawItem = (slot: number) => state.rawItems.find(item => item.slot === slot) ?? null
    const getSelectedHeldItem = () => {
      const held = findRawItem(state.equippedHandSlot ?? state.selectedSlot)
      return held
        ? {
            name: held.name.replace(/^minecraft:/, ''),
            count: held.count,
            slot: held.slot < 9 ? held.slot + 36 : held.slot,
            durability: held.durability,
            maxDurability: held.maxDurability,
          }
        : null
    }

    let bot: any

    const compactInventory = vi.fn(async function (this: typeof bot) {
      if (this !== bot) {
        throw new Error('compactInventory lost its bot binding')
      }
      if (options?.unsupportedCompactInventory) {
        throw new Error('Unknown command: compactInventory')
      }
      const groupedSlots = new Map<string, number[]>()
      for (const item of state.rawItems) {
        if (item.maxCount <= 1 || item.slot >= 36) {
          continue
        }
        const key = item.name
        groupedSlots.set(key, [...(groupedSlots.get(key) ?? []), item.slot])
      }

      for (const slots of groupedSlots.values()) {
        slots.sort((left, right) => left - right)
        for (let targetIndex = 0; targetIndex < slots.length; targetIndex++) {
          const target = findRawItem(slots[targetIndex])
          if (!target || target.count >= target.maxCount) {
            continue
          }
          for (let sourceIndex = slots.length - 1; sourceIndex > targetIndex; sourceIndex--) {
            const source = findRawItem(slots[sourceIndex])
            if (!source || source.slot === target.slot) {
              continue
            }
            const moved = Math.min(target.maxCount - target.count, source.count)
            target.count += moved
            source.count -= moved
            if (source.count <= 0) {
              state.rawItems = state.rawItems.filter(item => item !== source)
            }
            if (target.count >= target.maxCount) {
              break
            }
          }
        }
      }
    })

    const swapRawSlots = (fromSlot: number, toSlot: number) => {
      const fromItem = findRawItem(fromSlot)
      const toItem = findRawItem(toSlot)
      if (fromItem) {
        fromItem.slot = toSlot
      }
      if (toItem) {
        toItem.slot = fromSlot
      }
    }

    const moveSlotItem = vi.fn(async (fromSlot: number, toSlot: number) => {
      if (options?.unsupportedSwapInventorySlots) {
        throw new BridgeUnsupportedCommandError('swapInventorySlots', 'Unknown command: swapInventorySlots')
      }
      swapRawSlots(fromSlot, toSlot)
    })

    const selectHotbarSlot = vi.fn(async (slot: number) => {
      if (options?.unsupportedSelectHotbarSlot) {
        throw new BridgeUnsupportedCommandError('selectHotbarSlot', 'Unknown command: selectHotbarSlot')
      }
      state.selectedSlot = slot
      state.equippedHandSlot = null
    })

    const equip = vi.fn(async (item: { slot?: number }, destination: string) => {
      const rawSlot = typeof item.slot === 'number'
        ? item.slot >= 36 ? item.slot - 36 : item.slot
        : null
      if (destination === 'off-hand') {
        if (rawSlot === null) {
          return
        }
        const equippedItem = findRawItem(rawSlot)
        if (!equippedItem) {
          return
        }
        state.offhandItem = {
          ...equippedItem,
          slot: 40,
        }
        state.rawItems = state.rawItems.filter(candidate => candidate.slot !== rawSlot)
        return
      }
      if (destination !== 'hand') {
        return
      }
      if (rawSlot !== null) {
        state.equippedHandSlot = rawSlot
        if (rawSlot >= 0 && rawSlot < 9) {
          state.selectedSlot = rawSlot
        }
      }
    })

    const toss = vi.fn(async (itemType: number, _metadata: unknown, count: number) => {
      const matched = state.rawItems.find(item => item.slot + 1 === itemType)
      if (!matched) {
        return
      }
      matched.count -= count
      if (matched.count <= 0) {
        state.rawItems = state.rawItems.filter(item => item !== matched)
      }
    })

    bot = {
      inventory: {
        get selectedSlot() {
          return state.selectedSlot
        },
        set selectedSlot(value: number) {
          state.selectedSlot = value
        },
        get slots() {
          return Array.from({ length: 46 }, (_value, index) => {
            if (index === 45) {
              return state.offhandItem ? toBotItem(state.offhandItem) : null
            }
            const rawSlot = index >= 36 ? index - 36 : index
            const item = findRawItem(rawSlot)
            return item ? toBotItem(item) : null
          })
        },
        items: () => [
          ...state.rawItems.map(item => toBotItem(item)),
          ...(state.offhandItem ? [toBotItem(state.offhandItem)] : []),
        ],
      },
      get heldItem() {
        return getSelectedHeldItem()
      },
      getCanonicalInventorySnapshot: () => buildCanonicalInventorySnapshot({
        sourceKind: 'test:fixture',
        strictItems: state.rawItems.map(item => ({ ...item })),
        guardedItems: state.rawItems.map(item => ({ ...item })),
        trackedItems: state.rawItems.map(item => ({ ...item })),
        selectedSlot: state.selectedSlot,
        offhand: state.offhandItem
          ? { ...state.offhandItem }
          : undefined,
        heldItem: getSelectedHeldItem() ?? undefined,
      }),
      refreshInventory: vi.fn(async () => {}),
      getBridgeCapabilitySnapshot: () => ({
        unsupportedCommands: [
          ...(options?.unsupportedCompactInventory ? ['compactInventory'] : []),
          ...(options?.unsupportedSwapInventorySlots ? ['swapInventorySlots'] : []),
          ...(options?.unsupportedSelectHotbarSlot ? ['selectHotbarSlot'] : []),
        ],
      }),
      moveSlotItem,
      selectHotbarSlot,
      equip,
      compactInventory,
      toss,
      players: {},
      lookAt: vi.fn(async () => {}),
      openContainer: vi.fn(async () => ({
        deposit: vi.fn(async () => {}),
        withdraw: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        containerItems: () => [],
      })),
      chat: vi.fn(),
      registry: {
        isNewerOrEqualTo: () => true,
      },
    }

    return {
      mineflayer: { bot } as any,
      state,
      moveSlotItem,
      selectHotbarSlot,
      equip,
      compactInventory,
      toss,
    }
  }

  it('rebuilds a messy hotbar into deterministic survival roles and preserves a quick-loot slot', async () => {
    const { mineflayer, moveSlotItem, compactInventory } = createInventoryAutomationFixture()

    const result = await organizeInventory(mineflayer, {
      actionKind: 'mine',
      targetBlockName: 'stone',
      preferredToolCategory: 'pickaxe',
      desiredHotbarIndex: 0,
      reserveQuickLootSlot: true,
      requiredFreeSlots: 2,
    })

    expect(result.recovered).toBe(true)
    expect(compactInventory).toHaveBeenCalled()
    expect(moveSlotItem).toHaveBeenCalled()
    expect(result.snapshot.slots.find(slot => slot.slotIndex === 0)?.itemName).toBe('iron_pickaxe')
    expect(result.snapshot.slots.find(slot => slot.slotIndex === 1)?.itemName).toBe('stone_sword')
    expect(result.snapshot.slots.find(slot => slot.slotIndex === 3)?.itemName).toBe('bread')
    expect(result.snapshot.slots.find(slot => slot.slotIndex === 8)?.itemName ?? null).toBeNull()
    expect(result.snapshot.freeSlotCount).toBeGreaterThanOrEqual(2)
  })

  it('equips shield to offhand while keeping a sword immediately available on the hotbar', async () => {
    const { mineflayer, equip, state } = createInventoryAutomationFixture()
    state.rawItems.push({
      slot: 35,
      name: 'minecraft:shield',
      count: 1,
      maxCount: 1,
      durability: 180,
      maxDurability: 336,
    })

    const result = await organizeInventory(mineflayer, {
      actionKind: 'attack',
      desiredHotbarIndex: 1,
      reserveQuickLootSlot: true,
      requiredFreeSlots: 1,
    })

    expect(result.recovered).toBe(true)
    expect(equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'shield' }), 'off-hand')
    expect(result.actions).toContain('equip-offhand:shield')
    expect(result.snapshot.offhand?.itemName).toBe('shield')
    expect(result.snapshot.slots.find(slot => slot.slotIndex === 1)?.itemName).toBe('stone_sword')
  })

  it('preflights mining actions by moving the best tool onto the hotbar and selecting it', async () => {
    const { mineflayer, moveSlotItem, selectHotbarSlot } = createInventoryAutomationFixture()

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'collectBlocks',
      description: 'collect stone',
      params: { type: 'stone', num: 8 },
    })

    expect(result.ok).toBe(true)
    expect(moveSlotItem).toHaveBeenCalledWith(12, 0)
    expect(selectHotbarSlot).toHaveBeenCalledWith(0)
    expect(result.snapshot.selectedSlot).toBe(0)
    expect(result.snapshot.heldItem?.itemName).toBe('iron_pickaxe')
  })

  it('allows log collection preflight to proceed bare-handed when no axe is available', async () => {
    const { mineflayer, moveSlotItem, selectHotbarSlot, equip, state } = createInventoryAutomationFixture()
    state.rawItems = state.rawItems.filter(item =>
      !item.name.endsWith('_pickaxe')
      && !item.name.endsWith('_axe')
      && !item.name.endsWith('_shovel')
      && !item.name.endsWith('_hoe'))
    state.selectedSlot = 2
    state.equippedHandSlot = null

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'collectBlocks',
      description: 'collect logs',
      params: { type: 'log', num: 2 },
    })

    expect(result.ok).toBe(true)
    expect(result.failureClass).toBeUndefined()
    expect(moveSlotItem).not.toHaveBeenCalled()
    expect(selectHotbarSlot).not.toHaveBeenCalled()
    expect(equip).not.toHaveBeenCalled()
    expect(result.facts).toContain('inventory_task_readiness: mine=ready')
  })

  it('preflights attack actions with sword in hand and shield in offhand', async () => {
    const { mineflayer, equip, state } = createInventoryAutomationFixture()
    state.rawItems.push({
      slot: 35,
      name: 'minecraft:shield',
      count: 1,
      maxCount: 1,
      durability: 180,
      maxDurability: 336,
    })
    state.selectedSlot = 0
    state.equippedHandSlot = null

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'attack',
      description: 'attack hostile mob',
      params: {},
    })

    expect(result.ok).toBe(true)
    expect(equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'shield' }), 'off-hand')
    expect(result.snapshot.offhand?.itemName).toBe('shield')
    expect(result.snapshot.heldItem?.itemName).toBe('stone_sword')
    expect(result.snapshot.selectedSlot).toBe(1)
  })

  it('preflights attack actions with a pickaxe fallback when no weapon is available', async () => {
    const { mineflayer, equip, state } = createInventoryAutomationFixture()
    state.rawItems = state.rawItems.filter(item =>
      !item.name.endsWith('_sword')
      && !item.name.endsWith('_axe'))
    state.selectedSlot = 0
    state.equippedHandSlot = null

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'attack',
      description: 'attack animal for food',
      params: { type: 'animal' },
    })

    expect(result.ok).toBe(true)
    expect(result.failureClass).toBeUndefined()
    expect(equip).not.toHaveBeenCalled()
    expect(result.snapshot.heldItem?.itemName).toBe('iron_pickaxe')
    expect(result.snapshot.selectedSlot).toBe(0)
  })

  it('skips optional bridge compaction when the command is unsupported and still rebuilds the hotbar', async () => {
    const { mineflayer, moveSlotItem, compactInventory } = createInventoryAutomationFixture({
      unsupportedCompactInventory: true,
    })

    const result = await organizeInventory(mineflayer, {
      actionKind: 'mine',
      targetBlockName: 'stone',
      preferredToolCategory: 'pickaxe',
      desiredHotbarIndex: 0,
      reserveQuickLootSlot: true,
      requiredFreeSlots: 2,
    })

    expect(result.recovered).toBe(true)
    expect(compactInventory).not.toHaveBeenCalled()
    expect(moveSlotItem).toHaveBeenCalled()
    expect(result.actions).toContain('hotbar:iron_pickaxe:12->0')
    expect(result.actions).not.toContain('compactInventory')
  })

  it('degrades gracefully when slot swaps are unsupported and avoids futile hotbar reordering during craft preflight', async () => {
    const { mineflayer, moveSlotItem } = createInventoryAutomationFixture({
      unsupportedSwapInventorySlots: true,
    })

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'craftRecipe',
      description: 'craft torches',
      params: { recipe_name: 'torch', num: 1 },
    })

    expect(result.ok).toBe(true)
    expect(moveSlotItem).not.toHaveBeenCalled()
    expect(result.actions.some(action => action.includes('swapInventorySlots:skipped:unsupported_capability'))).toBe(false)
  })

  it('allows generic sword ensure recipes to pass craft preflight before exact ingredients are locally visible', async () => {
    const { mineflayer, state } = createInventoryAutomationFixture()
    state.rawItems = state.rawItems.filter(item => !item.name.endsWith('_sword'))

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'craftRecipe',
      description: 'craft a sword for survival',
      params: { recipe_name: 'sword', num: 1 },
    })

    expect(result.ok).toBe(true)
    expect(result.failureClass).toBeUndefined()
  })

  it('falls back to equipping the actual mining tool when slot swaps are unsupported', async () => {
    const { mineflayer, moveSlotItem, equip, state } = createInventoryAutomationFixture({
      unsupportedSwapInventorySlots: true,
    })
    state.selectedSlot = 0
    state.equippedHandSlot = null
    const hotbarPickaxe = state.rawItems.find(item => item.slot === 5)
    if (hotbarPickaxe) {
      hotbarPickaxe.name = 'minecraft:coal'
      hotbarPickaxe.count = 1
      hotbarPickaxe.maxCount = 64
      hotbarPickaxe.durability = 0
      hotbarPickaxe.maxDurability = 0
    }

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'collectBlocks',
      description: 'collect stone',
      params: { type: 'stone', num: 8 },
    })

    expect(result.ok).toBe(true)
    expect(moveSlotItem).not.toHaveBeenCalled()
    expect(equip).toHaveBeenCalled()
    expect(result.actions).toContain('equip-hand:iron_pickaxe')
    expect(result.snapshot.heldItem?.itemName).toBe('iron_pickaxe')
  })

  it('degrades gracefully when hotbar selection is unsupported and keeps the mining tool equipped', async () => {
    const { mineflayer, selectHotbarSlot, equip, state } = createInventoryAutomationFixture({
      unsupportedSelectHotbarSlot: true,
    })

    state.selectedSlot = 6
    state.equippedHandSlot = null

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'collectBlocks',
      description: 'collect stone',
      params: { type: 'stone', num: 8 },
    })

    expect(result.ok).toBe(true)
    expect(selectHotbarSlot).toHaveBeenCalledWith(0)
    expect(result.actions).toContain('selectHotbarSlot:skipped:unsupported_capability:0')
    expect(equip).toHaveBeenCalled()
    expect(result.actions).toContain('equip-hand:iron_pickaxe')
    expect(result.snapshot.heldItem?.itemName).toBe('iron_pickaxe')
  })

  it('does not accept a held low-tier pickaxe for ore mining when hotbar selection is unsupported', async () => {
    const { mineflayer, selectHotbarSlot, equip, state } = createInventoryAutomationFixture({
      unsupportedSelectHotbarSlot: true,
    })
    state.rawItems = state.rawItems.filter(item => item.slot !== 12)
    const selectedTool = state.rawItems.find(item => item.slot === 6)
    if (selectedTool) {
      selectedTool.name = 'minecraft:wooden_pickaxe'
      selectedTool.durability = 40
      selectedTool.maxDurability = 59
    }
    state.selectedSlot = 6
    state.equippedHandSlot = null

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'collectBlocks',
      description: 'collect iron ore',
      params: { type: 'iron_ore', num: 1 },
    })

    expect(result.ok).toBe(true)
    expect(selectHotbarSlot).toHaveBeenCalled()
    expect(equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'stone_pickaxe' }), 'hand')
    expect(result.actions).toContain('equip-hand:stone_pickaxe')
    expect(result.snapshot.heldItem?.itemName).toBe('stone_pickaxe')
  })

  it('allows furnace placement to proceed when the furnace is visible but equip confirmation is stale', async () => {
    const { mineflayer, state, moveSlotItem, selectHotbarSlot } = createInventoryAutomationFixture({
      unsupportedSwapInventorySlots: true,
      unsupportedSelectHotbarSlot: true,
    })
    state.rawItems = state.rawItems.filter(item => item.slot !== 4)
    state.selectedSlot = 1
    state.equippedHandSlot = null
    mineflayer.bot.equip = vi.fn(async () => undefined)

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'placeHere',
      description: 'place furnace',
      params: { type: 'furnace' },
    })

    expect(result.ok).toBe(true)
    expect(result.failureClass).toBeUndefined()
    expect(moveSlotItem).not.toHaveBeenCalled()
    expect(selectHotbarSlot).toHaveBeenCalled()
    expect(result.facts.some(fact =>
      fact.startsWith('inventory_task_readiness: place=inventory_needs_move:furnace@main#'))).toBe(true)
  })

  it('accepts placement postflight after the placed block is no longer held or carried', async () => {
    const { mineflayer, state } = createInventoryAutomationFixture()
    state.rawItems = state.rawItems.filter(item => !item.name.endsWith('furnace'))
    state.selectedSlot = 1
    state.equippedHandSlot = null

    const result = await verifyInventoryPostflight(mineflayer, {
      tool: 'placeHere',
      description: 'place furnace',
      params: { type: 'furnace' },
    })

    expect(result.ok).toBe(true)
    expect(result.failureClass).toBeUndefined()
  })

  it('accepts generic log smelting preflight when concrete logs are available', async () => {
    const { mineflayer, state } = createInventoryAutomationFixture()
    state.rawItems = state.rawItems.filter(item => item.slot !== 20)
    state.rawItems.push({
      slot: 20,
      name: 'minecraft:oak_log',
      count: 7,
      maxCount: 64,
      durability: 0,
      maxDurability: 0,
    })

    const result = await preflightInventoryForAction(mineflayer, {
      tool: 'smeltItem',
      description: 'smelt a log into charcoal',
      params: { item_name: 'log', num: 1 },
    })

    expect(result.ok).toBe(true)
    expect(result.failureClass).toBeUndefined()
  })

  it('accepts mining postflight when the tool remains available after the held slot drifts', async () => {
    const { mineflayer, state } = createInventoryAutomationFixture({
      unsupportedSwapInventorySlots: true,
    })

    state.selectedSlot = 7
    state.equippedHandSlot = null

    const result = await verifyInventoryPostflight(mineflayer, {
      tool: 'collectBlocks',
      description: 'collect stone',
      params: { type: 'stone', num: 8 },
    })

    expect(result.ok).toBe(true)
    expect(result.failureClass).toBeUndefined()
  })

  it('recovers full inventory pressure via deterministic organization and low-value pressure relief', async () => {
    const { mineflayer, toss, compactInventory } = createInventoryAutomationFixture()

    const recovery = await recoverInventoryFailure(mineflayer, {
      tool: 'collectBlocks',
      description: 'collect more stone',
      params: { type: 'stone', num: 4 },
    }, 'full_inventory')

    expect(recovery.recovered).toBe(true)
    expect(recovery.actions).toContain('compactInventory')
    expect(compactInventory).toHaveBeenCalled()
    expect(toss.mock.calls.length).toBeLessThanOrEqual(1)
    expect(recovery.snapshot.freeSlotCount).toBeGreaterThanOrEqual(2)
    expect(recovery.snapshot.groupedStacks.furnace?.totalCount).toBeGreaterThan(0)
    expect(recovery.snapshot.groupedStacks.iron_pickaxe?.totalCount).toBe(1)
  })

  it('clears pressure at the two-slot threshold instead of oscillating there when inventory reshaping is unavailable', async () => {
    const { mineflayer, state, toss, moveSlotItem } = createInventoryAutomationFixture({
      unsupportedCompactInventory: true,
      unsupportedSwapInventorySlots: true,
    })
    state.rawItems = state.rawItems.filter(item => item.slot !== 34)

    const result = await organizeInventory(mineflayer, {
      actionKind: 'mine',
      targetBlockName: 'stone',
      preferredToolCategory: 'pickaxe',
      desiredHotbarIndex: 0,
      reserveQuickLootSlot: true,
      requiredFreeSlots: 1,
    })

    expect(result.recovered).toBe(true)
    expect(moveSlotItem).not.toHaveBeenCalled()
    expect(toss).toHaveBeenCalled()
    expect(result.actions.some(action => action.startsWith('discard:'))).toBe(true)
    expect(result.snapshot.freeSlotCount).toBeGreaterThanOrEqual(3)
    expect(result.snapshot.groupedStacks.iron_pickaxe?.totalCount).toBe(1)
  })
})
