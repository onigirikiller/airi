import type { WorldFacts } from './preconditions'

import { describe, expect, it } from 'vitest'

import { buildProgressionSnapshot, buildStallRecoveryGoal, computeProgressScore, computeStateHash, ProgressWatchdog } from './progress'

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

describe('computeProgressScore', () => {
  it('increases with better equipment', () => {
    const none = computeProgressScore(makeFacts({ equipmentTier: 'none', pickaxeTier: 'none', hasIronPickaxe: false }))
    const wood = computeProgressScore(makeFacts({ equipmentTier: 'wood', pickaxeTier: 'wood', hasIronPickaxe: false }))
    const iron = computeProgressScore(makeFacts({ equipmentTier: 'iron', pickaxeTier: 'iron', hasIronPickaxe: true }))
    expect(wood).toBeGreaterThan(none)
    expect(iron).toBeGreaterThan(wood)
  })

  it('increases with more resources', () => {
    const low = computeProgressScore(makeFacts({ woodCount: 0, ironIngotCount: 0 }))
    const high = computeProgressScore(makeFacts({ woodCount: 32, ironIngotCount: 16 }))
    expect(high).toBeGreaterThan(low)
  })

  it('accounts for runner phase progression', () => {
    const early = computeProgressScore(makeFacts({ runnerPhase: 'EARLY_GAME', runnerPhaseStep: 0 }))
    const diamond = computeProgressScore(makeFacts({ runnerPhase: 'DIAMOND_MINING', runnerPhaseStep: 3 }))
    expect(diamond).toBeGreaterThan(early)
  })
})

describe('computeStateHash', () => {
  it('changes on material relocation', () => {
    const facts1 = makeFacts({ position: { x: 0, y: 64, z: 0 } })
    const facts2 = makeFacts({ position: { x: 200, y: 64, z: 200 } })
    expect(computeStateHash(facts1)).not.toBe(computeStateHash(facts2))
  })

  it('stays same for nearby positions in same bucket', () => {
    const facts1 = makeFacts({ position: { x: 1, y: 64, z: 1 } })
    const facts2 = makeFacts({ position: { x: 5, y: 64, z: 5 } })
    expect(computeStateHash(facts1)).toBe(computeStateHash(facts2))
  })

  it('changes when equipment tier changes', () => {
    const facts1 = makeFacts({ equipmentTier: 'wood', pickaxeTier: 'wood', hasIronPickaxe: false })
    const facts2 = makeFacts({ equipmentTier: 'iron', pickaxeTier: 'iron', hasIronPickaxe: true })
    expect(computeStateHash(facts1)).not.toBe(computeStateHash(facts2))
  })
})

describe('buildProgressionSnapshot', () => {
  it('does not regress back to the wood milestone after stone-tier progress already exists', () => {
    const snapshot = buildProgressionSnapshot(makeFacts({
      woodCount: 1,
      hasCraftingTable: false,
      hasFurnace: false,
      equipmentTier: 'stone',
      pickaxeTier: 'stone',
      hasIronPickaxe: false,
      cobblestoneCount: 40,
      stoneCount: 40,
      foodItemCount: 8,
      food: 20,
      timeOfDay: 'day',
      ironIngotCount: 0,
      ironOreCount: 0,
      coalCount: 0,
      torchCount: 0,
    }))

    expect(snapshot.completedMilestones).toContain('stone-tools')
    expect(snapshot.currentMilestone).toBe('furnace')
    expect(snapshot.nextGoals).toContain('Craft a furnace')
  })

  it('advances from iron pickaxe readiness into diamond acquisition goals', () => {
    const snapshot = buildProgressionSnapshot(makeFacts({
      ironIngotCount: 0,
      ironOreCount: 0,
      equipmentTier: 'iron',
      pickaxeTier: 'iron',
      hasIronPickaxe: true,
      hasFurnace: true,
      torchCount: 12,
      foodItemCount: 6,
    }))

    expect(snapshot.completedMilestones).toContain('iron-pickaxe')
    expect(snapshot.currentMilestone).toBe('diamond-acquisition')
    expect(snapshot.nextGoals).toContain('Mine diamonds from a safe cave route')
  })

  it('uses concrete diamond craft goals once diamonds are already in inventory', () => {
    const snapshot = buildProgressionSnapshot(makeFacts({
      diamondCount: 8,
      equipmentTier: 'iron',
      pickaxeTier: 'iron',
      hasIronPickaxe: true,
      hasDiamondPickaxe: false,
      hasShield: true,
    }))

    expect(snapshot.currentMilestone).toBe('diamond-loadout')
    expect(snapshot.nextGoals).toContain('Craft a diamond pickaxe')
  })

  it('prioritizes food recovery before low-health starter cobblestone mining', () => {
    const snapshot = buildProgressionSnapshot(makeFacts({
      health: 8,
      food: 14,
      foodItemCount: 0,
      hasCraftingTable: true,
      hasFurnace: false,
      woodCount: 4,
      cobblestoneCount: 0,
      stoneCount: 0,
      ironIngotCount: 0,
      coalCount: 0,
      torchCount: 0,
      equipmentTier: 'wood',
      pickaxeTier: 'wood',
      hasPickaxe: true,
      hasIronPickaxe: false,
      hasAxe: false,
      hasSword: false,
      hasShield: false,
      runnerPhase: 'EARLY_GAME',
      runnerPhaseStep: 2,
    }))

    expect(snapshot.blockers).toContain('unsafe-stone-mining')
    expect(snapshot.danger).toContain('no-recovery-food')
    expect(snapshot.nextGoals[0]).toBe('Collect nearby food')
    expect(snapshot.nextGoals.some(goal => goal.toLowerCase().includes('cobblestone'))).toBe(false)
  })
})

describe('progressWatchdog', () => {
  it('detects stall when score unchanged for 3 observations', () => {
    const watchdog = new ProgressWatchdog({ windowMs: 300_000, minObservations: 3 })
    const facts = makeFacts()

    watchdog.observe(facts, undefined, 1000)
    watchdog.observe(facts, undefined, 2000)
    watchdog.observe(facts, undefined, 3000)

    const result = watchdog.isStalled()
    expect(result.stalled).toBe(true)
    expect(result.reason).toContain('stalled')
  })

  it('does NOT fire stall when score increases', () => {
    const watchdog = new ProgressWatchdog({ windowMs: 300_000, minObservations: 3 })

    watchdog.observe(makeFacts({ ironIngotCount: 0 }), undefined, 1000)
    watchdog.observe(makeFacts({ ironIngotCount: 5 }), undefined, 2000)
    watchdog.observe(makeFacts({ ironIngotCount: 10 }), undefined, 3000)

    // Position changes between observations mean different hashes
    const result = watchdog.isStalled()
    expect(result.stalled).toBe(false)
  })

  it('does NOT fire with fewer than minObservations', () => {
    const watchdog = new ProgressWatchdog({ windowMs: 300_000, minObservations: 3 })
    const facts = makeFacts()

    watchdog.observe(facts, undefined, 1000)
    watchdog.observe(facts, undefined, 2000)

    const result = watchdog.isStalled()
    expect(result.stalled).toBe(false)
  })

  it('resets history correctly', () => {
    const watchdog = new ProgressWatchdog({ windowMs: 300_000, minObservations: 3 })
    const facts = makeFacts()

    watchdog.observe(facts, undefined, 1000)
    watchdog.observe(facts, undefined, 2000)
    watchdog.observe(facts, undefined, 3000)

    watchdog.reset()

    const result = watchdog.isStalled()
    expect(result.stalled).toBe(false)
    expect(watchdog.getHistoryLength()).toBe(0)
  })
})

describe('buildStallRecoveryGoal', () => {
  it('prioritizes healing when HP is low with food', () => {
    const goal = buildStallRecoveryGoal(makeFacts({ health: 4, foodItemCount: 3 }))
    expect(goal.toLowerCase()).toContain('eat')
  })

  it('prioritizes gathering wood when no wood and no pickaxe', () => {
    const goal = buildStallRecoveryGoal(makeFacts({
      woodCount: 0,
      hasPickaxe: false,
      hasCraftingTable: false,
      hasFurnace: false,
      equipmentTier: 'none',
      pickaxeTier: 'none',
      stoneCount: 0,
      cobblestoneCount: 0,
      ironIngotCount: 0,
      coalCount: 0,
      food: 8,
      foodItemCount: 1,
      torchCount: 0,
      timeOfDay: 'night',
      hasIronPickaxe: false,
    }))
    expect(goal.toLowerCase()).toContain('wood')
  })

  it('keeps wood bootstrap ahead of food stockpiling when hunger is stable', () => {
    const goal = buildStallRecoveryGoal(makeFacts({
      woodCount: 0,
      hasPickaxe: false,
      hasCraftingTable: false,
      hasFurnace: false,
      equipmentTier: 'none',
      pickaxeTier: 'none',
      stoneCount: 0,
      cobblestoneCount: 0,
      ironIngotCount: 0,
      coalCount: 0,
      food: 12,
      foodItemCount: 0,
      torchCount: 0,
      timeOfDay: 'night',
      hasIronPickaxe: false,
      hasAxe: false,
      hasSword: false,
      hasShield: false,
      runnerPhase: 'EARLY_GAME',
      runnerPhaseStep: 0,
    }))

    expect(goal.toLowerCase()).toContain('wood')
  })

  it('uses food recovery instead of starter cobblestone mining when injured with no food buffer', () => {
    const goal = buildStallRecoveryGoal(makeFacts({
      health: 8,
      food: 14,
      foodItemCount: 0,
      hasCraftingTable: true,
      hasFurnace: false,
      woodCount: 4,
      stoneCount: 0,
      cobblestoneCount: 0,
      ironIngotCount: 0,
      coalCount: 0,
      torchCount: 0,
      equipmentTier: 'wood',
      pickaxeTier: 'wood',
      hasPickaxe: true,
      hasIronPickaxe: false,
      hasAxe: false,
      hasSword: false,
      hasShield: false,
      runnerPhase: 'EARLY_GAME',
      runnerPhaseStep: 2,
    }))

    expect(goal).toBe('Collect nearby food')
  })

  it('prioritizes crafting pickaxe when no pickaxe but has wood', () => {
    const goal = buildStallRecoveryGoal(makeFacts({
      hasPickaxe: false,
      equipmentTier: 'none',
      pickaxeTier: 'none',
      hasCraftingTable: true,
      hasFurnace: false,
      woodCount: 8,
      stoneCount: 0,
      cobblestoneCount: 0,
      ironIngotCount: 0,
      coalCount: 0,
      food: 8,
      foodItemCount: 1,
      torchCount: 0,
      timeOfDay: 'night',
      hasIronPickaxe: false,
    }))
    expect(goal.toLowerCase()).toContain('pickaxe')
  })

  it('continues diamond acquisition when iron-pickaxe progression is ready', () => {
    const goal = buildStallRecoveryGoal(makeFacts())
    expect(goal.toLowerCase()).toContain('diamond')
  })
})

describe('endgame progression toward the ender dragon', () => {
  const diamondLoadout = {
    hasDiamondPickaxe: true,
    hasShield: true,
    hasDiamondHelmet: true,
    hasDiamondChestplate: true,
    hasDiamondLeggings: true,
    hasDiamondBoots: true,
    diamondArmorPieceCount: 4,
    diamondCount: 3,
    equipmentTier: 'diamond' as const,
    pickaxeTier: 'diamond' as const,
  }

  it('targets obsidian after the diamond loadout is complete', () => {
    const snapshot = buildProgressionSnapshot(makeFacts(diamondLoadout))
    expect(snapshot.currentMilestone).toBe('obsidian-collection')
    expect(snapshot.nextGoals.join(' ').toLowerCase()).toContain('obsidian')
  })

  it('targets the nether portal once obsidian and flint-and-steel are ready', () => {
    const snapshot = buildProgressionSnapshot(makeFacts({
      ...diamondLoadout,
      obsidianCount: 10,
      hasFlintAndSteel: true,
    }))
    expect(snapshot.currentMilestone).toBe('nether-access')
    expect(snapshot.nextGoals.join(' ').toLowerCase()).toContain('nether portal')
  })

  it('hunts blazes while in the nether without enough rods', () => {
    const snapshot = buildProgressionSnapshot(makeFacts({
      ...diamondLoadout,
      obsidianCount: 0,
      hasFlintAndSteel: true,
      dimension: 'the_nether',
    }))
    expect(snapshot.currentMilestone).toBe('blaze-rods')
    expect(snapshot.nextGoals.join(' ').toLowerCase()).toContain('blaze')
  })

  it('moves to ender pearls once blaze powder is covered', () => {
    const snapshot = buildProgressionSnapshot(makeFacts({
      ...diamondLoadout,
      blazeRodCount: 7,
      hasFlintAndSteel: true,
    }))
    expect(snapshot.currentMilestone).toBe('ender-pearls')
    expect(snapshot.nextGoals.join(' ').toLowerCase()).toContain('ender')
  })

  it('crafts eyes of ender and then heads for the stronghold', () => {
    const crafting = buildProgressionSnapshot(makeFacts({
      ...diamondLoadout,
      blazeRodCount: 7,
      enderPearlCount: 12,
    }))
    expect(crafting.currentMilestone).toBe('eyes-of-ender')
    expect(crafting.canCraft).toContain('blaze_powder')

    const ready = buildProgressionSnapshot(makeFacts({
      ...diamondLoadout,
      enderEyeCount: 12,
    }))
    expect(ready.currentMilestone).toBe('eyes-of-ender')
    expect(ready.nextGoals.join(' ').toLowerCase()).toContain('stronghold')
    expect(ready.nextGoals.join(' ').toLowerCase()).toContain('dragon')
  })

  it('keeps the progress score rising through the endgame', () => {
    const overworld = computeProgressScore(makeFacts(diamondLoadout))
    const withRods = computeProgressScore(makeFacts({ ...diamondLoadout, blazeRodCount: 7 }))
    const withEyes = computeProgressScore(makeFacts({ ...diamondLoadout, blazeRodCount: 7, enderEyeCount: 12 }))
    expect(withRods).toBeGreaterThan(overworld)
    expect(withEyes).toBeGreaterThan(withRods)
  })
})
