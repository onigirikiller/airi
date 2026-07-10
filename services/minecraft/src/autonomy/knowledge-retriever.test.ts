import type { WorldFacts } from './preconditions'

import { describe, expect, it } from 'vitest'

import { retrieveRelevantKnowledge } from './knowledge-retriever'

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
    runnerPhase: 'IRON_AGE',
    runnerPhaseStep: 2,
    ...overrides,
  }
}

describe('retrieveRelevantKnowledge', () => {
  it('returns relevant recipes for mine_iron with no pickaxe deficit', () => {
    const facts = makeFacts({ hasPickaxe: false, hasIronPickaxe: false, pickaxeTier: 'none' })
    const result = retrieveRelevantKnowledge(facts, ['Mine iron ore'], ['no_pickaxe'])

    expect(result).toContain('pickaxe')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns empty string when no deficits and generic goal', () => {
    const facts = makeFacts()
    const result = retrieveRelevantKnowledge(facts, ['Walk around'])

    expect(result).toBe('')
  })

  it('output stays under 1200 character limit', () => {
    // Request everything to test max length
    const facts = makeFacts({
      hasPickaxe: false,
      hasIronPickaxe: false,
      pickaxeTier: 'none',
      hasAxe: false,
      hasSword: false,
      hasCraftingTable: false,
      hasFurnace: false,
      foodItemCount: 0,
      torchCount: 0,
      woodCount: 0,
      health: 4,
    })
    const result = retrieveRelevantKnowledge(
      facts,
      ['Mine diamond ore', 'Explore cave', 'Fight zombie', 'Smelt iron'],
    )

    expect(result.length).toBeLessThanOrEqual(1200)
  })

  it('returns mining requirements for relevant goals', () => {
    const facts = makeFacts()
    const result = retrieveRelevantKnowledge(facts, ['Mine iron ore'])

    expect(result).toContain('iron_ore')
    expect(result).toContain('stone_pickaxe')
  })
})
