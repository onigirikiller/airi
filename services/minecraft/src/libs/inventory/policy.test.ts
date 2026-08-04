import { describe, expect, it } from 'vitest'

import {
  buildCanonicalInventorySnapshot,
  describeInventoryTaskReadiness,
  formatCanonicalInventoryFacts,
  getSafeDiscardPlan,
} from './policy'

function createMessyInventorySnapshot() {
  return buildCanonicalInventorySnapshot({
    sourceKind: 'test:messy-fixture',
    selectedSlot: 5,
    strictItems: [
      { slot: 0, name: 'minecraft:dirt', count: 8, maxCount: 64 },
      { slot: 1, name: 'minecraft:cobblestone', count: 17, maxCount: 64 },
      { slot: 2, name: 'minecraft:raw_beef', count: 2, maxCount: 64 },
      { slot: 3, name: 'minecraft:stick', count: 5, maxCount: 64 },
      { slot: 4, name: 'minecraft:furnace', count: 1, maxCount: 64 },
      { slot: 5, name: 'minecraft:stone_pickaxe', count: 1, maxCount: 1, durability: 12, maxDurability: 131 },
      { slot: 6, name: 'minecraft:wooden_sword', count: 1, maxCount: 1, durability: 25, maxDurability: 59 },
      { slot: 7, name: 'minecraft:coal', count: 4, maxCount: 64 },
      { slot: 8, name: 'minecraft:gravel', count: 12, maxCount: 64 },
      { slot: 9, name: 'minecraft:cobblestone', count: 21, maxCount: 64 },
      { slot: 10, name: 'minecraft:dirt', count: 11, maxCount: 64 },
      { slot: 11, name: 'minecraft:bread', count: 5, maxCount: 64 },
      { slot: 12, name: 'minecraft:iron_pickaxe', count: 1, maxCount: 1, durability: 140, maxDurability: 250 },
      { slot: 13, name: 'minecraft:stone_sword', count: 1, maxCount: 1, durability: 110, maxDurability: 131 },
      { slot: 14, name: 'minecraft:torch', count: 12, maxCount: 64 },
      { slot: 15, name: 'minecraft:oak_planks', count: 24, maxCount: 64 },
      { slot: 16, name: 'minecraft:crafting_table', count: 1, maxCount: 64 },
      { slot: 17, name: 'minecraft:charcoal', count: 3, maxCount: 64 },
      { slot: 18, name: 'minecraft:cobblestone', count: 11, maxCount: 64 },
      { slot: 19, name: 'minecraft:gravel', count: 16, maxCount: 64 },
      { slot: 20, name: 'minecraft:oak_log', count: 7, maxCount: 64 },
      { slot: 21, name: 'minecraft:stone', count: 9, maxCount: 64 },
      { slot: 22, name: 'minecraft:apple', count: 1, maxCount: 64 },
      { slot: 23, name: 'minecraft:rotten_flesh', count: 7, maxCount: 64 },
      { slot: 24, name: 'minecraft:andesite', count: 22, maxCount: 64 },
      { slot: 25, name: 'minecraft:wheat_seeds', count: 14, maxCount: 64 },
      { slot: 26, name: 'minecraft:sand', count: 6, maxCount: 64 },
      { slot: 27, name: 'minecraft:oak_planks', count: 11, maxCount: 64 },
      { slot: 28, name: 'minecraft:coal', count: 5, maxCount: 64 },
      { slot: 29, name: 'minecraft:torch', count: 8, maxCount: 64 },
      { slot: 30, name: 'minecraft:furnace', count: 1, maxCount: 64 },
      { slot: 31, name: 'minecraft:stick', count: 4, maxCount: 64 },
      { slot: 32, name: 'minecraft:diorite', count: 19, maxCount: 64 },
      { slot: 33, name: 'minecraft:cobblestone', count: 6, maxCount: 64 },
      { slot: 34, name: 'minecraft:dirt', count: 7, maxCount: 64 },
    ],
    heldItem: {
      name: 'minecraft:stone_pickaxe',
      count: 1,
      durability: 12,
      maxDurability: 131,
    },
  })
}

describe('inventory policy', () => {
  it('builds slot-aware canonical facts for a fragmented early-survival inventory', () => {
    const snapshot = createMessyInventorySnapshot()

    expect(snapshot.freeSlotCount).toBe(1)
    expect(snapshot.compactness.fragmentedItemNames).toEqual(
      expect.arrayContaining(['cobblestone', 'dirt', 'torch', 'oak_planks']),
    )
    expect(snapshot.defaultHotbarPolicy.violations).toEqual(
      expect.arrayContaining(['quick_loot_blocked', 'hotbar_contains_low_value_items']),
    )
    expect(snapshot.defaultHotbarPolicy.assignments[0]).toMatchObject({
      role: 'primary_mining_tool',
      itemName: 'iron_pickaxe',
      rawSlotIndex: 12,
    })
    expect(snapshot.defaultHotbarPolicy.assignments[1]).toMatchObject({
      role: 'primary_weapon',
      itemName: 'stone_sword',
      rawSlotIndex: 13,
    })
    expect(snapshot.defaultHotbarPolicy.assignments[3]).toMatchObject({
      role: 'food',
      itemName: 'bread',
      rawSlotIndex: 11,
    })
  })

  it('produces task readiness and discard plans without dropping progression-critical items', () => {
    const snapshot = createMessyInventorySnapshot()
    const miningReadiness = describeInventoryTaskReadiness(snapshot, {
      actionKind: 'mine',
      targetBlockName: 'stone',
      preferredToolCategory: 'pickaxe',
      desiredHotbarIndex: 0,
      reserveQuickLootSlot: true,
      requiredFreeSlots: 1,
    })
    const discardPlan = getSafeDiscardPlan(snapshot, 3)

    expect(miningReadiness.status).toBe('inventory_needs_move')
    expect(miningReadiness.itemName).toBe('iron_pickaxe')
    expect(discardPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemName: 'gravel', reason: 'inventory_pressure_low_value' }),
      ]),
    )
    expect(discardPlan.some(candidate => candidate.itemName === 'furnace')).toBe(false)
    expect(discardPlan.some(candidate => candidate.itemName === 'iron_pickaxe')).toBe(false)
  })

  it('formats compact planner facts instead of dumping raw slots', () => {
    const snapshot = createMessyInventorySnapshot()
    const lines = formatCanonicalInventoryFacts(snapshot, {
      actionKind: 'mine',
      targetBlockName: 'stone',
      preferredToolCategory: 'pickaxe',
      desiredHotbarIndex: 0,
      reserveQuickLootSlot: true,
      requiredFreeSlots: 1,
    })

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('inventory_selected_slot: 6'),
        expect.stringContaining('inventory_free_slots: 1/36'),
        expect.stringContaining('inventory_hotbar:'),
        expect.stringContaining('inventory_alerts:'),
        expect.stringContaining('inventory_task_readiness: mine=inventory_needs_move:iron_pickaxe@main#4'),
      ]),
    )
  })

  it('keeps observed held item separate from selected-slot contents and flags the mismatch', () => {
    const snapshot = buildCanonicalInventorySnapshot({
      sourceKind: 'test:held-item-mismatch',
      selectedSlot: 0,
      strictItems: [
        { slot: 0, name: 'minecraft:dirt', count: 8, maxCount: 64 },
        { slot: 12, name: 'minecraft:iron_pickaxe', count: 1, maxCount: 1, durability: 140, maxDurability: 250 },
      ],
      heldItem: {
        name: 'minecraft:iron_pickaxe',
        count: 1,
        durability: 140,
        maxDurability: 250,
      },
    })

    expect(snapshot.selectedSlot).toBe(0)
    expect(snapshot.heldItem?.itemName).toBe('iron_pickaxe')
    expect(snapshot.invariants.issues).toContain('held_item_mismatch')
  })

  it('keeps a sword in the primary weapon slot and leaves shield for offhand use', () => {
    const snapshot = buildCanonicalInventorySnapshot({
      sourceKind: 'test:combat-loadout',
      selectedSlot: 0,
      strictItems: [
        { slot: 1, name: 'minecraft:shield', count: 1, maxCount: 1, durability: 180, maxDurability: 336 },
        { slot: 12, name: 'minecraft:stone_sword', count: 1, maxCount: 1, durability: 110, maxDurability: 131 },
        { slot: 13, name: 'minecraft:bread', count: 4, maxCount: 64 },
      ],
    })

    expect(snapshot.defaultHotbarPolicy.assignments[1]).toMatchObject({
      role: 'primary_weapon',
      itemName: 'stone_sword',
      rawSlotIndex: 12,
    })
    expect(snapshot.essentials.weapon).toBe(true)
  })
})
