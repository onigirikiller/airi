import type { AutonomyDecisionContext } from './types'

import { describe, expect, it } from 'vitest'

import { RuleBasedAutonomyDecisionProvider } from './decision-provider'

function createContext(overrides: Partial<AutonomyDecisionContext> = {}): AutonomyDecisionContext {
  return {
    nowIso: new Date().toISOString(),
    botName: 'AIra',
    activeGoal: null,
    activeGoalElapsedMs: 0,
    status: 'ok',
    worldState: [
      'dimension: overworld',
      'held_item: empty',
      'equipped_armor: none',
      'inventory: crafting_table x1, wooden_pickaxe x1, cobblestone x16',
    ].join('\n'),
    nearbyPlayers: [],
    recentActions: [],
    candidateSelfGoals: ['Gather wood and basic resources near spawn'],
    recentSignals: [],
    socialWeights: {
      selfGoal: 1,
      social: 0.7,
      comment: 0.25,
    },
    conversationContext: {
      recentViewerMessages: [],
      recentAssistantMessages: [],
      suggestedAdjustments: [],
    },
    worldFacts: {
      health: 20,
      food: 18,
      hasCraftingTable: true,
      hasFurnace: false,
      woodCount: 4,
      stoneCount: 16,
      cobblestoneCount: 16,
      ironIngotCount: 0,
      ironOreCount: 0,
      diamondCount: 0,
      coalCount: 0,
      foodItemCount: 8,
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
    },
    ...overrides,
  }
}

describe('rule-based autonomy decision provider', () => {
  it('prioritizes furnace setup once stone-tier progression is ready', async () => {
    const provider = new RuleBasedAutonomyDecisionProvider()

    const intent = await provider.decide(createContext({
      worldState: [
        'dimension: overworld',
        'held_item: stone_pickaxe x1',
        'equipped_armor: none',
        'inventory: crafting_table x1, stone_pickaxe x1, cobblestone x16',
      ].join('\n'),
      worldFacts: {
        ...createContext().worldFacts!,
        equipmentTier: 'stone',
        pickaxeTier: 'stone',
      },
    }))

    expect(intent.goal).toBe('Craft a furnace')
  })

  it('moves to the first iron objective after furnace and light prep are satisfied', async () => {
    const provider = new RuleBasedAutonomyDecisionProvider()

    const intent = await provider.decide(createContext({
      worldState: [
        'dimension: overworld',
        'held_item: stone_pickaxe x1',
        'equipped_armor: none',
        'inventory: crafting_table x1, furnace x1, stone_pickaxe x1, cobblestone x16, coal x8, torch x8',
      ].join('\n'),
      worldFacts: {
        ...createContext().worldFacts!,
        hasFurnace: true,
        coalCount: 8,
        torchCount: 8,
        equipmentTier: 'stone',
        pickaxeTier: 'stone',
      },
    }))

    expect(intent.goal).toBe('Mine iron ore')
  })

  it('prefers stone-tier bootstrap over inventory cleanup after a surfaced wooden-pickaxe checkpoint', async () => {
    const provider = new RuleBasedAutonomyDecisionProvider()

    const intent = await provider.decide(createContext({
      worldState: [
        'dimension: overworld',
        'sky_access: open_sky',
        'terrain_context: surface_forest',
        'held_item: wooden_pickaxe x1',
        'equipped_armor: none',
        'inventory: crafting_table x1, wooden_pickaxe x1, oak_log x79',
        'inventory_alerts: fragmented:oak_log',
        'nearby_blocks: grass_block, oak_log',
      ].join('\n'),
      worldFacts: {
        ...createContext().worldFacts!,
        woodCount: 79,
        cobblestoneCount: 0,
        foodItemCount: 0,
        torchCount: 0,
        hasSword: false,
        equipmentTier: 'wood',
        pickaxeTier: 'wood',
      },
    }))

    expect(intent.goal).toBe('Mine 16 cobblestone')
  })

  it('chooses the next diamond loadout craft from actual inventory state', async () => {
    const provider = new RuleBasedAutonomyDecisionProvider()

    const intent = await provider.decide(createContext({
      worldState: [
        'dimension: overworld',
        'held_item: iron_pickaxe x1',
        'equipped_armor: torso:iron_chestplate, legs:iron_leggings, head:iron_helmet, feet:iron_boots',
        'inventory: iron_pickaxe x1, iron_sword x1, shield x1, diamond x8',
      ].join('\n'),
      worldFacts: {
        health: 20,
        food: 18,
        hasCraftingTable: true,
        hasFurnace: true,
        woodCount: 8,
        stoneCount: 32,
        cobblestoneCount: 32,
        ironIngotCount: 0,
        ironOreCount: 0,
        diamondCount: 8,
        coalCount: 16,
        foodItemCount: 12,
        torchCount: 16,
        equipmentTier: 'iron',
        pickaxeTier: 'iron',
        hasPickaxe: true,
        hasIronPickaxe: true,
        hasDiamondPickaxe: false,
        hasAxe: true,
        hasSword: true,
        hasShield: true,
        hasDiamondHelmet: false,
        hasDiamondChestplate: false,
        hasDiamondLeggings: false,
        hasDiamondBoots: false,
        diamondArmorPieceCount: 0,
        timeOfDay: 'day',
        nearbyHostileCount: 0,
        dimension: 'overworld',
        position: { x: 0, y: 12, z: 0 },
        obsidianCount: 0,
        blazeRodCount: 0,
        blazePowderCount: 0,
        enderPearlCount: 0,
        enderEyeCount: 0,
        hasFlintAndSteel: false,
        hasBow: false,
        arrowCount: 0,
        runnerPhase: 'DIAMOND_MINING',
        runnerPhaseStep: 0,
      },
    }))

    expect(intent.goal).toBe('Craft a diamond pickaxe')
  })

  it('chooses a base-establishment objective once midgame survival is stable but no home anchor exists', async () => {
    const provider = new RuleBasedAutonomyDecisionProvider()

    const intent = await provider.decide(createContext({
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
      worldFacts: {
        ...createContext().worldFacts!,
        equipmentTier: 'iron',
        pickaxeTier: 'iron',
        hasFurnace: true,
        torchCount: 12,
        hasIronPickaxe: true,
      },
    }))

    expect(intent.goal).toBe('Establish a safe home base near the current work area')
  })
})
