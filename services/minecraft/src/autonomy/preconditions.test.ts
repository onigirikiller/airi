import type { WorldFacts } from './preconditions'

import { describe, expect, it, vi } from 'vitest'

import { classifyGoalType, collectWorldFacts, computeAllowedGoals, describeGoalConstraint, validateGoalPreconditions } from './preconditions'

const { worldMocks } = vi.hoisted(() => ({
  worldMocks: {
    getNearestBlock: vi.fn(() => null as any),
    getInventoryCounts: vi.fn((mineflayer: any) => {
      const rawItems
        = mineflayer?.bot?.getStrictRawInventoryItems?.()
          ?? mineflayer?.bot?.getRawInventoryItems?.()
          ?? mineflayer?.bot?.inventory?.items?.()
          ?? []

      return rawItems.reduce((counts: Record<string, number>, item: { name?: string, count?: number }) => {
        const itemName = String(item?.name ?? '').replace(/^minecraft:/, '')
        if (!itemName) {
          return counts
        }

        counts[itemName] = (counts[itemName] ?? 0) + Number(item?.count ?? 0)
        return counts
      }, {})
    }),
  },
}))

vi.mock('../skills/world', () => ({
  getNearestBlock: worldMocks.getNearestBlock,
  getInventoryCounts: worldMocks.getInventoryCounts,
}))

function makeFacts(overrides: Partial<WorldFacts> = {}): WorldFacts {
  return {
    health: 20,
    food: 20,
    hasCraftingTable: true,
    hasFurnace: true,
    woodCount: 16,
    stoneCount: 32,
    cobblestoneCount: 32,
    ironIngotCount: 8,
    ironOreCount: 0,
    diamondCount: 0,
    coalCount: 16,
    foodItemCount: 8,
    torchCount: 16,
    equipmentTier: 'iron',
    pickaxeTier: 'iron',
    hasPickaxe: true,
    hasIronPickaxe: true,
    hasDiamondPickaxe: false,
    hasAxe: true,
    hasSword: true,
    hasShield: false,
    hasDiamondHelmet: false,
    hasDiamondChestplate: false,
    hasDiamondLeggings: false,
    hasDiamondBoots: false,
    diamondArmorPieceCount: 0,
    timeOfDay: 'day',
    nearbyHostileCount: 0,
    dimension: 'minecraft:overworld',
    position: { x: 0, y: 64, z: 0 },
    obsidianCount: 0,
    blazeRodCount: 0,
    blazePowderCount: 0,
    enderPearlCount: 0,
    enderEyeCount: 0,
    hasFlintAndSteel: false,
    hasBow: false,
    arrowCount: 0,
    runnerPhase: 'UNKNOWN',
    runnerPhaseStep: 0,
    ...overrides,
  }
}

describe('classifyGoalType', () => {
  it('classifies mining goals', () => {
    expect(classifyGoalType('Mine stone for building')).toBe('mine_stone')
    expect(classifyGoalType('Mine diamond ore deep underground')).toBe('mine_diamond')
    expect(classifyGoalType('Mine iron ore')).toBe('mine_iron')
  })

  it('classifies crafting and combat goals', () => {
    expect(classifyGoalType('Craft a wooden pickaxe')).toBe('craft_tool')
    expect(classifyGoalType('Fight the nearby zombie')).toBe('fight')
  })

  it('classifies direct surface recovery separately from cave exploration', () => {
    expect(classifyGoalType('Escape the underground cave to reach the surface')).toBe('surface_escape')
  })

  it('returns generic for unrecognized goals', () => {
    expect(classifyGoalType('Do something random')).toBe('generic')
  })
})

describe('validateGoalPreconditions', () => {
  it('returns ok=false for mine_stone without pickaxe', () => {
    const facts = makeFacts({ hasPickaxe: false, hasIronPickaxe: false, pickaxeTier: 'none' })
    const result = validateGoalPreconditions('Mine stone blocks', facts)
    expect(result.ok).toBe(false)
    expect(result.reasons[0]).toContain('No pickaxe')
  })

  it('returns ok=false for mine_diamond without iron pickaxe', () => {
    const facts = makeFacts({ equipmentTier: 'stone', pickaxeTier: 'stone', hasPickaxe: true, hasIronPickaxe: false })
    const result = validateGoalPreconditions('Mine diamond ore', facts)
    expect(result.ok).toBe(false)
    expect(result.reasons.some(r => r.includes('iron pickaxe'))).toBe(true)
  })

  it('still blocks diamond mining when only an iron sword is present', () => {
    const facts = makeFacts({
      equipmentTier: 'iron',
      pickaxeTier: 'stone',
      hasPickaxe: true,
      hasIronPickaxe: false,
      hasSword: true,
    })
    const result = validateGoalPreconditions('Mine diamond ore', facts)

    expect(result.ok).toBe(false)
    expect(result.reasons.some(r => r.includes('iron pickaxe'))).toBe(true)
  })

  it('returns ok=true when all preconditions are met', () => {
    const result = validateGoalPreconditions('Mine stone blocks', makeFacts())
    expect(result).toEqual({ ok: true, reasons: [] })
  })

  it('blocks mining when HP is low and no recovery food is available', () => {
    const result = validateGoalPreconditions('Mine 16 cobblestone', makeFacts({
      health: 8,
      food: 14,
      foodItemCount: 0,
      hasPickaxe: true,
      pickaxeTier: 'wood',
      hasIronPickaxe: false,
    }))

    expect(result.ok).toBe(false)
    expect(result.reasons.some(reason => reason.includes('no recovery food'))).toBe(true)
  })

  it('blocks mining when hunger is depleted and no recovery food is buffered', () => {
    const result = validateGoalPreconditions('Mine iron ore', makeFacts({
      health: 12,
      food: 6,
      foodItemCount: 0,
      hasPickaxe: true,
      pickaxeTier: 'stone',
      hasIronPickaxe: false,
    }))

    expect(result.ok).toBe(false)
    expect(result.reasons.some(reason => reason.includes('Food 6 with no recovery food'))).toBe(true)
  })

  it('treats a nearby crafting table as satisfying 3x3 crafting access', () => {
    worldMocks.getNearestBlock.mockReturnValueOnce({ name: 'crafting_table' })

    const facts = collectWorldFacts({
      bot: {
        health: 20,
        food: 20,
        inventory: { items: () => [] },
        entity: { position: { x: 0, y: 64, z: 0 } },
        entities: {},
        time: { timeOfDay: 0 },
        game: { dimension: 'minecraft:overworld' },
      },
    })

    expect(facts.hasCraftingTable).toBe(true)
    expect(validateGoalPreconditions('Craft a wooden pickaxe', facts).ok).toBe(true)
  })

  it('treats a reachable placed crafting table as satisfying 3x3 crafting access', () => {
    worldMocks.getNearestBlock.mockReturnValueOnce({
      name: 'crafting_table',
      position: { x: 24, y: 66, z: 0 },
    })

    const facts = collectWorldFacts({
      bot: {
        health: 20,
        food: 20,
        inventory: { items: () => [{ name: 'oak_planks', count: 10 }, { name: 'stick', count: 4 }] },
        entity: { position: { x: 0, y: 64, z: 0 } },
        entities: {},
        time: { timeOfDay: 0 },
        game: { dimension: 'minecraft:overworld' },
      },
    })

    expect(facts.hasCraftingTable).toBe(true)
    expect(validateGoalPreconditions('Craft a wooden pickaxe', facts).ok).toBe(true)
  })

  it('counts beef as a real food item in collected world facts', () => {
    const facts = collectWorldFacts({
      bot: {
        health: 20,
        food: 8,
        inventory: { items: () => [{ name: 'beef', count: 2 }] },
        entity: { position: { x: 0, y: 64, z: 0 } },
        entities: {},
        time: { timeOfDay: 0 },
        game: { dimension: 'minecraft:overworld' },
      },
    })

    expect(facts.foodItemCount).toBe(2)
  })

  it('reads furnace and pickaxe facts from raw bridge inventory when inventory.items is stale', () => {
    const facts = collectWorldFacts({
      bot: {
        health: 20,
        food: 20,
        inventory: { items: () => [] },
        getRawInventoryItems: () => [
          { name: 'minecraft:furnace', count: 1 },
          { name: 'minecraft:stone_pickaxe', count: 1 },
          { name: 'minecraft:oak_log', count: 4 },
        ],
        entity: { position: { x: 0, y: 64, z: 0 } },
        entities: {},
        time: { timeOfDay: 0 },
        game: { dimension: 'minecraft:overworld' },
      },
    })

    expect(facts.hasFurnace).toBe(true)
    expect(facts.hasPickaxe).toBe(true)
    expect(facts.equipmentTier).toBe('stone')
    expect(facts.pickaxeTier).toBe('stone')
    expect(facts.woodCount).toBe(4)
  })
})

describe('describeGoalConstraint', () => {
  it('blocks unsafe goals without replacing them', () => {
    const facts = makeFacts({ hasPickaxe: false, hasIronPickaxe: false, pickaxeTier: 'none', woodCount: 0 })
    const constraint = describeGoalConstraint('Mine stone blocks', facts)

    expect(constraint.blocked).toBe(true)
    expect(constraint.goalType).toBe('mine_stone')
    expect(constraint.reason).toContain('No pickaxe')
    expect(constraint.reason).toContain('recommended preparation')
    expect(constraint.redirect).toContain('pickaxe')
  })

  it('reports temporary bans as blocks', () => {
    const bans = new Map([['mine_stone', Date.now() + 60_000]])
    const constraint = describeGoalConstraint('Mine stone blocks', makeFacts(), bans)

    expect(constraint.blocked).toBe(true)
    expect(constraint.source).toBe('ban')
    expect(constraint.reason).toContain('temporarily banned')
  })

  it('passes through safe goals unchanged', () => {
    const constraint = describeGoalConstraint('Gather wood nearby', makeFacts())

    expect(constraint.blocked).toBe(false)
    expect(constraint.goalType).toBe('gather_wood')
  })

  it('redirects low-health gathering and crafting goals to food recovery', () => {
    const constraint = describeGoalConstraint('Gather materials and craft a sword', makeFacts({
      health: 7,
      food: 16,
      foodItemCount: 0,
      hasCraftingTable: true,
    }))

    expect(constraint.blocked).toBe(true)
    expect(constraint.goalType).toBe('craft_tool')
    expect(constraint.reason).toContain('no recovery food')
    expect(constraint.redirect).toBe('Collect nearby food')
  })

  it('does not force cave-exploration prep for direct surface escape goals', () => {
    const constraint = describeGoalConstraint('Escape the underground cave to reach the surface', makeFacts({
      hasPickaxe: false,
      hasIronPickaxe: false,
      pickaxeTier: 'none',
      hasSword: false,
      foodItemCount: 0,
      torchCount: 0,
    }))

    expect(constraint.blocked).toBe(false)
    expect(constraint.goalType).toBe('surface_escape')
  })

  it('redirects injured mining goals to food recovery before continuing', () => {
    const constraint = describeGoalConstraint('Mine 16 cobblestone', makeFacts({
      health: 8,
      food: 14,
      foodItemCount: 0,
      hasPickaxe: true,
      pickaxeTier: 'wood',
      hasIronPickaxe: false,
    }))

    expect(constraint.blocked).toBe(true)
    expect(constraint.goalType).toBe('mine_stone')
    expect(constraint.reason).toContain('no recovery food')
    expect(constraint.redirect).toBe('Find food and recover health')
  })

  it('redirects depleted-hunger mining goals to immediate food collection', () => {
    const constraint = describeGoalConstraint('Mine iron ore', makeFacts({
      health: 12,
      food: 6,
      foodItemCount: 0,
      hasPickaxe: true,
      pickaxeTier: 'stone',
      hasIronPickaxe: false,
    }))

    expect(constraint.blocked).toBe(true)
    expect(constraint.goalType).toBe('mine_iron')
    expect(constraint.reason).toContain('Food 6 with no recovery food')
    expect(constraint.redirect).toBe('Collect nearby food')
  })
})

describe('computeAllowedGoals', () => {
  it('excludes banned goals', () => {
    const bans = new Map([['fight', Date.now() + 60_000]])
    const result = computeAllowedGoals(makeFacts(), bans)

    expect(result.allowedGoalTypes.has('fight')).toBe(false)
    expect(result.blocked.some(entry => entry.goalType === 'fight')).toBe(true)
  })
})
