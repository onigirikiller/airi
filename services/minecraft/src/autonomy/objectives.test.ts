import type { WorldFacts } from './preconditions'
import type { AutonomyDecisionContext } from './types'

import { describe, expect, it } from 'vitest'

import { buildObjectiveFramework, chooseFallbackObjective, deriveBaseStatusFromObservation } from './objectives'

function createFacts(overrides: Partial<WorldFacts> = {}): WorldFacts {
  return {
    health: 20,
    food: 18,
    hasCraftingTable: true,
    hasFurnace: false,
    woodCount: 8,
    stoneCount: 16,
    cobblestoneCount: 16,
    ironIngotCount: 0,
    ironOreCount: 0,
    diamondCount: 0,
    coalCount: 0,
    foodItemCount: 6,
    torchCount: 0,
    equipmentTier: 'wood',
    pickaxeTier: 'wood',
    hasPickaxe: true,
    hasIronPickaxe: false,
    hasDiamondPickaxe: false,
    hasAxe: false,
    hasSword: false,
    hasShield: false,
    hasDiamondHelmet: false,
    hasDiamondChestplate: false,
    hasDiamondLeggings: false,
    hasDiamondBoots: false,
    diamondArmorPieceCount: 0,
    timeOfDay: 'day',
    nearbyHostileCount: 0,
    dimension: 'overworld',
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

function createContext(overrides: Partial<AutonomyDecisionContext> = {}): AutonomyDecisionContext {
  return {
    nowIso: new Date('2026-04-17T18:30:00+09:00').toISOString(),
    botName: 'AIra',
    activeGoal: null,
    activeGoalElapsedMs: 0,
    status: 'ok',
    worldState: [
      'dimension: overworld',
      'sky_access: open_sky',
      'terrain_context: surface_open_land',
      'held_item: stone_pickaxe x1',
      'equipped_armor: none',
      'inventory: crafting_table x1, stone_pickaxe x1, bread x6, cobblestone x16',
      'nearby_blocks: grass_block, oak_log',
      'notable_blocks: none',
    ].join('\n'),
    nearbyPlayers: [],
    recentActions: [],
    candidateSelfGoals: [],
    recentSignals: [],
    socialWeights: {
      selfGoal: 1,
      social: 0.5,
      comment: 0.2,
    },
    conversationContext: {
      recentViewerMessages: [],
      recentAssistantMessages: [],
      suggestedAdjustments: [],
    },
    worldFacts: createFacts(),
    ...overrides,
  }
}

describe('objective framework', () => {
  it('derives base and interior status from observed utilities instead of a fixed blueprint', () => {
    const summary = deriveBaseStatusFromObservation({
      worldState: [
        'sky_access: enclosed',
        'terrain_context: surface_open_land',
        'inventory: crafting_table x1, furnace x1, chest x1, red_bed x1, torch x8, lantern x2',
        'nearby_blocks: chest, crafting_table, furnace, torch',
        'notable_blocks: red_bed @ 2.0m | chest @ 1.5m',
      ].join('\n'),
      facts: {
        foodItemCount: 8,
        torchCount: 8,
        nearbyHostileCount: 0,
      },
    })

    expect(summary.baseScore).toBeGreaterThanOrEqual(70)
    expect(summary.interiorScore).toBeGreaterThanOrEqual(60)
    expect(summary.functionalZones).toEqual(expect.arrayContaining(['sleep', 'storage', 'work']))
    expect(summary.isHomeCandidate).toBe(true)
  })

  it('keeps early fallback on tool progression when the pickaxe gap is the biggest blocker', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        hasPickaxe: false,
        equipmentTier: 'none',
        pickaxeTier: 'none',
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: open_sky',
        'terrain_context: surface_open_land',
        'held_item: empty',
        'equipped_armor: none',
        'inventory: crafting_table x1, oak_planks x8, stick x2, bread x4',
        'nearby_blocks: grass_block, oak_log',
        'notable_blocks: none',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Craft a wooden pickaxe')
  })

  it('deprioritizes bridge-limited inventory cleanup while bootstrap tools are still missing', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        hasCraftingTable: false,
        hasPickaxe: false,
        equipmentTier: 'none',
        pickaxeTier: 'none',
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: open_sky',
        'terrain_context: surface_open_land',
        'held_item: empty',
        'equipped_armor: none',
        'inventory: oak_log x24, dirt x8, cobblestone x59',
        'inventory_alerts: full_inventory_pressure, fragmented_stacks',
        'bridge_capabilities: unsupported=swapInventorySlots,compactInventory; supported=selectHotbarSlot; hash=cap:test',
        'nearby_blocks: grass_block, oak_log',
        'notable_blocks: none',
      ].join('\n'),
    }))

    const recoveryReport = framework.gapReports.find(report => report.evaluator === 'RecoveryEvaluator')
    const inventoryReport = framework.gapReports.find(report => report.evaluator === 'InventoryEvaluator')

    expect(chooseFallbackObjective(framework)?.target).toBe('Craft a crafting table')
    expect(recoveryReport?.candidateObjectives.find(objective => objective.target.includes('Organize inventory'))?.urgency).toBeLessThan(0.9)
    expect(inventoryReport?.candidateObjectives.find(objective => objective.target.includes('Organize inventory'))?.urgency).toBeLessThan(0.5)
  })

  it('switches to a base objective once furnace-ready survival is stable but no home anchor exists', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        equipmentTier: 'iron',
        pickaxeTier: 'iron',
        hasFurnace: true,
        coalCount: 8,
        torchCount: 12,
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: open_sky',
        'terrain_context: surface_open_land',
        'held_item: iron_pickaxe x1',
        'equipped_armor: torso:iron_chestplate',
        'inventory: crafting_table x1, furnace x1, iron_pickaxe x1, bread x8, torch x12, cobblestone x32',
        'nearby_blocks: grass_block, oak_log',
        'notable_blocks: none',
      ].join('\n'),
    }))

    const baseReport = framework.gapReports.find(report => report.evaluator === 'BaseEvaluator')
    expect(baseReport?.candidateObjectives[0]?.target).toBe('Establish a safe home base near the current work area')
  })

  it('prefers charcoal smelting over generic fuel gathering when logs and a furnace already exist', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        equipmentTier: 'stone',
        pickaxeTier: 'stone',
        hasFurnace: true,
        hasCraftingTable: true,
        woodCount: 29,
        coalCount: 0,
        torchCount: 0,
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: open_sky',
        'terrain_context: surface_open_land',
        'held_item: stone_pickaxe x1',
        'equipped_armor: none',
        'inventory: stone_pickaxe x1, crafting_table x1, furnace x1, oak_log x29, cobblestone x43',
        'nearby_blocks: crafting_table, furnace',
        'notable_blocks: none',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Smelt charcoal using logs for torch and furnace fuel')
  })

  it('promotes deterministic recovery objectives above normal progression after repeated stalls', () => {
    const framework = buildObjectiveFramework(createContext({
      structuredMemory: {
        snapshot: {
          activeGoals: ['Mine iron ore'],
          recentSubgoals: ['Reach cave mouth'],
          lastActionOutcome: 'moveTo:failed:movement_stall',
          lastFailureClass: 'movement_stall',
          repeatedFailures: ['movement_stall x2 @ Reach cave mouth'],
          discoveries: [],
          unresolvedNeeds: ['iron-ore'],
          activeMilestone: 'iron-acquisition',
          abandonedPlan: '',
          gainedResources: [],
          lostResources: [],
          recentMotifFamilies: [],
        },
        plannerFacts: [],
        narrationFacts: [],
      },
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Reposition and rebuild the path from a safer angle')
  })

  it('proposes diamond crafting from current inventory instead of a fixed milestone script', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        equipmentTier: 'iron',
        pickaxeTier: 'iron',
        hasFurnace: true,
        diamondCount: 8,
        coalCount: 12,
        torchCount: 16,
        hasIronPickaxe: true,
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: open_sky',
        'terrain_context: surface_open_land',
        'held_item: iron_pickaxe x1',
        'equipped_armor: torso:iron_chestplate, legs:iron_leggings, head:iron_helmet, feet:iron_boots',
        'inventory: iron_pickaxe x1, iron_sword x1, shield x1, diamond x8, crafting_table x1, furnace x1',
        'nearby_blocks: crafting_table, furnace',
        'notable_blocks: none',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Craft a diamond pickaxe')
  })

  it('does not unlock diamond mining from an iron sword alone when the pickaxe is still stone-tier', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        equipmentTier: 'iron',
        pickaxeTier: 'stone',
        hasIronPickaxe: false,
        hasSword: true,
        hasPickaxe: true,
        diamondCount: 0,
        ironIngotCount: 3,
        hasFurnace: true,
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: open_sky',
        'terrain_context: surface_open_land',
        'held_item: stone_pickaxe x1',
        'equipped_armor: none',
        'inventory: stone_pickaxe x1, iron_sword x1, iron_ingot x3, crafting_table x1, furnace x1',
        'nearby_blocks: crafting_table, furnace',
        'notable_blocks: none',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Craft an iron pickaxe')
  })

  it('prefers surface recovery over underground food search when hunger is low and the cave is a dead end', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        food: 3,
        foodItemCount: 0,
        health: 8,
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: enclosed',
        'terrain_context: underground_cave',
        'surface_escape_needed: true',
        'held_item: stone_pickaxe x1',
        'equipped_armor: none',
        'inventory: stone_pickaxe x1, cobblestone x16',
        'nearby_blocks: stone, cobblestone',
        'notable_blocks: none',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Escape to the surface to gather wood')
  })

  it('promotes a shaft-specific surface recovery objective when trapped with scaffold blocks', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        food: 20,
        health: 20,
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: enclosed',
        'terrain_context: underground_cave',
        'surface_escape_needed: true',
        'mobility_state: shaft_trap',
        'surface_escape_scaffold: ready:cobblestone x64',
        'held_item: stone_pickaxe x1',
        'equipped_armor: none',
        'inventory: stone_pickaxe x1, cobblestone x64, birch_log x5, crafting_table x1, furnace x1',
        'nearby_blocks: stone, cobblestone',
        'notable_blocks: none',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Climb out of the enclosed shaft toward the surface')
  })

  it('prefers surface resupply over generic underground exploration when iron-ready cave supplies are thin under hostile pressure', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        equipmentTier: 'iron',
        pickaxeTier: 'iron',
        hasPickaxe: true,
        hasIronPickaxe: true,
        hasSword: true,
        hasShield: true,
        hasFurnace: true,
        ironIngotCount: 9,
        coalCount: 31,
        torchCount: 4,
        foodItemCount: 0,
        nearbyHostileCount: 8,
        position: { x: -463, y: 64, z: 255 },
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: enclosed',
        'terrain_context: underground_cave',
        'surface_escape_needed: true',
        'held_item: iron_pickaxe x1',
        'equipped_armor: none',
        'inventory: iron_pickaxe x1, iron_sword x1, shield x1, birch_log x5, crafting_table x1, furnace x1, cobblestone x64, torch x4, iron_ingot x9, coal x31',
        'nearby_entities: zombie @ 5.0m, skeleton @ 7.0m, creeper @ 9.0m',
        'nearby_blocks: stone, cobblestone',
        'notable_blocks: furnace @ 1.5m',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Escape to the surface to resupply food and torches for deeper mining')
  })

  it('prefers early surface resupply over cave prep when stone-tier underground supplies are empty', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        food: 10,
        health: 12,
        foodItemCount: 0,
        torchCount: 0,
        hasSword: false,
        equipmentTier: 'stone',
        pickaxeTier: 'stone',
        hasFurnace: true,
        woodCount: 29,
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: enclosed',
        'terrain_context: underground_cave',
        'surface_escape_needed: true',
        'held_item: stone_pickaxe x1',
        'equipped_armor: none',
        'inventory: stone_pickaxe x1, crafting_table x1, furnace x1, charcoal x1, oak_log x29, cobblestone x44, stick x2',
        'nearby_blocks: stone, dirt, grass_block',
        'notable_blocks: furnace @ 1.5m',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Escape to the surface to gather wood')
  })

  it('prefers surface resupply over iron mining when hunger is depleted underground', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        food: 6,
        health: 12,
        foodItemCount: 0,
        torchCount: 4,
        equipmentTier: 'stone',
        pickaxeTier: 'stone',
        hasFurnace: true,
        hasSword: false,
        ironOreCount: 0,
        ironIngotCount: 0,
        woodCount: 5,
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: enclosed',
        'terrain_context: underground_cave',
        'surface_escape_needed: true',
        'held_item: stone_pickaxe x1',
        'equipped_armor: none',
        'inventory: stone_pickaxe x1, crafting_table x1, furnace x1, torch x4, oak_log x5',
        'nearby_blocks: stone, coal_ore, iron_ore',
        'notable_blocks: iron_ore @ 6.3m',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Escape to the surface to resupply food and torches for deeper mining')
  })

  it('prefers food collection over iron mining when hunger is depleted on the surface', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        food: 6,
        health: 12,
        foodItemCount: 0,
        torchCount: 4,
        equipmentTier: 'stone',
        pickaxeTier: 'stone',
        hasFurnace: true,
        hasSword: false,
        ironOreCount: 0,
        ironIngotCount: 0,
        woodCount: 5,
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: open_sky',
        'terrain_context: surface_water_edge',
        'surface_escape_needed: false',
        'held_item: stone_pickaxe x1',
        'equipped_armor: none',
        'inventory: stone_pickaxe x1, crafting_table x1, furnace x1, torch x4, oak_log x5',
        'nearby_blocks: grass_block, water, cod, salmon',
        'notable_blocks: salmon @ 8.0m',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Collect nearby food')
  })

  it('prefers stone-tier bootstrap over low-signal inventory cleanup after a surfaced wooden-pickaxe recovery', () => {
    const framework = buildObjectiveFramework(createContext({
      worldFacts: createFacts({
        food: 18,
        health: 20,
        foodItemCount: 0,
        torchCount: 0,
        hasSword: false,
        equipmentTier: 'wood',
        pickaxeTier: 'wood',
        hasPickaxe: true,
        woodCount: 79,
        cobblestoneCount: 0,
      }),
      worldState: [
        'dimension: overworld',
        'sky_access: open_sky',
        'terrain_context: surface_forest',
        'held_item: wooden_pickaxe x1',
        'equipped_armor: none',
        'inventory: wooden_pickaxe x1, crafting_table x1, oak_log x79',
        'inventory_alerts: fragmented:oak_log',
        'nearby_blocks: grass_block, oak_log',
        'notable_blocks: crafting_table @ 2.0m',
      ].join('\n'),
    }))

    expect(chooseFallbackObjective(framework)?.target).toBe('Mine 16 cobblestone')
  })
})
