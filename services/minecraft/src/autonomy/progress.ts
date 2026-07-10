import type { WorldFacts } from './preconditions'

export type ProgressMilestone
  = | 'wood'
    | 'crafting-table'
    | 'stone-tools'
    | 'food-stable'
    | 'shelter'
    | 'furnace'
    | 'light-source'
    | 'iron-acquisition'
    | 'iron-smelting'
    | 'iron-pickaxe'
    | 'diamond-acquisition'
    | 'diamond-loadout'
    | 'obsidian-collection'
    | 'nether-access'
    | 'blaze-rods'
    | 'ender-pearls'
    | 'eyes-of-ender'

export interface ProgressionSnapshot {
  currentMilestone: ProgressMilestone
  completedMilestones: ProgressMilestone[]
  unresolvedNeeds: string[]
  blockers: string[]
  canCraft: string[]
  canSmelt: string[]
  canMine: string[]
  danger: string[]
  nextGoals: string[]
  score: number
  stateHash: string
}

interface ProgressObservation {
  at: number
  score: number
  stateHash: string
  goalKey: string
}

interface ProgressWatchdogOptions {
  windowMs?: number
  minObservations?: number
  minScoreGain?: number
}

const DEFAULT_WINDOW_MS = 5 * 60_000
const DEFAULT_MIN_OBSERVATIONS = 3
const DEFAULT_MIN_SCORE_GAIN = 1
const PROGRESSION_ORDER: ProgressMilestone[] = [
  'wood',
  'crafting-table',
  'stone-tools',
  'food-stable',
  'shelter',
  'furnace',
  'light-source',
  'iron-acquisition',
  'iron-smelting',
  'iron-pickaxe',
  'diamond-acquisition',
  'diamond-loadout',
  'obsidian-collection',
  'nether-access',
  'blaze-rods',
  'ender-pearls',
  'eyes-of-ender',
]

// 12 eyes comfortably covers stronghold triangulation plus portal filling.
const REQUIRED_ENDER_EYES = 12
const REQUIRED_OBSIDIAN = 10

function blazePowderEquivalent(facts: WorldFacts): number {
  return facts.blazePowderCount + facts.blazeRodCount * 2
}

function hasNetherEvidence(facts: WorldFacts): boolean {
  return facts.dimension.includes('nether')
    || facts.blazeRodCount > 0
    || facts.blazePowderCount > 0
    || facts.enderEyeCount > 0
    || ['NETHER', 'BLAZE', 'ENDERMAN', 'EYE', 'STRONGHOLD', 'END', 'DRAGON'].some(marker => facts.runnerPhase.includes(marker))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeGoalKey(goal: string | undefined): string {
  return String(goal || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function bucketCoordinate(value: number): number {
  return Math.floor(value / 8)
}

function hasStoneTierTools(facts: WorldFacts): boolean {
  return facts.hasPickaxe && ['stone', 'iron', 'diamond'].includes(facts.pickaxeTier)
}

function hasStableFood(facts: WorldFacts): boolean {
  return facts.food >= 14 || facts.foodItemCount >= 4
}

function needsRecoveryFoodBeforeMining(facts: WorldFacts): boolean {
  return facts.hasPickaxe
    && facts.foodItemCount <= 0
    && facts.health < 12
    && facts.food <= 16
}

function hasShelterReadiness(facts: WorldFacts): boolean {
  return facts.timeOfDay === 'day'
    || facts.foodItemCount >= 3
    || facts.cobblestoneCount >= 16
    || facts.woodCount >= 12
    || facts.torchCount >= 8
}

function hasFuelForSmelting(facts: WorldFacts): boolean {
  return facts.coalCount > 0 || facts.woodCount >= 2
}

function hasTorchEquivalent(facts: WorldFacts): boolean {
  return facts.torchCount >= 4 || (facts.coalCount > 0 && facts.woodCount > 0)
}

function hasIronPickaxeReady(facts: WorldFacts): boolean {
  return facts.hasIronPickaxe || facts.hasDiamondPickaxe || ['iron', 'diamond'].includes(facts.pickaxeTier)
}

function hasDiamondLoadout(facts: WorldFacts): boolean {
  return facts.hasDiamondPickaxe
    && facts.hasShield
    && facts.hasDiamondHelmet
    && facts.hasDiamondChestplate
    && facts.hasDiamondLeggings
    && facts.hasDiamondBoots
}

function getNextDiamondCraftGoal(facts: WorldFacts): string | null {
  if (!facts.hasDiamondPickaxe && facts.diamondCount >= 3) {
    return 'Craft a diamond pickaxe'
  }
  if (!facts.hasDiamondChestplate && facts.diamondCount >= 8) {
    return 'Craft a diamond chestplate'
  }
  if (!facts.hasDiamondLeggings && facts.diamondCount >= 7) {
    return 'Craft diamond leggings'
  }
  if (!facts.hasDiamondHelmet && facts.diamondCount >= 5) {
    return 'Craft a diamond helmet'
  }
  if (!facts.hasDiamondBoots && facts.diamondCount >= 4) {
    return 'Craft diamond boots'
  }
  if (!facts.hasShield) {
    if (facts.ironIngotCount >= 1 && facts.woodCount > 0 && facts.hasCraftingTable) {
      return 'Craft a shield'
    }
    if (facts.ironOreCount > 0 && facts.hasFurnace && hasFuelForSmelting(facts)) {
      return 'Smelt raw iron into iron ingots'
    }
    return 'Mine iron ore'
  }
  return null
}

function getCompletedMilestones(facts: WorldFacts): ProgressMilestone[] {
  const completed: ProgressMilestone[] = []

  if (facts.woodCount >= 4) {
    completed.push('wood')
  }
  if (facts.hasCraftingTable) {
    completed.push('crafting-table')
  }
  if (hasStoneTierTools(facts)) {
    completed.push('stone-tools')
  }
  if (hasStableFood(facts)) {
    completed.push('food-stable')
  }
  if (hasShelterReadiness(facts)) {
    completed.push('shelter')
  }
  if (facts.hasFurnace) {
    completed.push('furnace')
  }
  if (hasTorchEquivalent(facts)) {
    completed.push('light-source')
  }
  if (facts.ironOreCount > 0 || facts.ironIngotCount > 0 || hasIronPickaxeReady(facts) || facts.equipmentTier === 'iron' || facts.equipmentTier === 'diamond') {
    completed.push('iron-acquisition')
  }
  if (facts.ironIngotCount > 0 || hasIronPickaxeReady(facts) || facts.equipmentTier === 'iron' || facts.equipmentTier === 'diamond') {
    completed.push('iron-smelting')
  }
  if (hasIronPickaxeReady(facts)) {
    completed.push('iron-pickaxe')
  }
  if (facts.diamondCount > 0 || facts.hasDiamondPickaxe || facts.diamondArmorPieceCount > 0) {
    completed.push('diamond-acquisition')
  }
  if (hasDiamondLoadout(facts)) {
    completed.push('diamond-loadout')
  }
  if (facts.obsidianCount >= REQUIRED_OBSIDIAN || hasNetherEvidence(facts)) {
    completed.push('obsidian-collection')
  }
  if (hasNetherEvidence(facts)) {
    completed.push('nether-access')
  }
  if (blazePowderEquivalent(facts) + facts.enderEyeCount >= REQUIRED_ENDER_EYES) {
    completed.push('blaze-rods')
  }
  if (facts.enderPearlCount + facts.enderEyeCount >= REQUIRED_ENDER_EYES) {
    completed.push('ender-pearls')
  }
  if (facts.enderEyeCount >= REQUIRED_ENDER_EYES) {
    completed.push('eyes-of-ender')
  }

  return completed
}

function resolveCurrentMilestone(completed: ProgressMilestone[]): ProgressMilestone {
  if (completed.length === 0) {
    return 'wood'
  }

  let highestCompletedIndex = -1
  for (const milestone of completed) {
    const index = PROGRESSION_ORDER.indexOf(milestone)
    if (index > highestCompletedIndex) {
      highestCompletedIndex = index
    }
  }

  if (highestCompletedIndex < 0) {
    return 'wood'
  }

  return PROGRESSION_ORDER[Math.min(PROGRESSION_ORDER.length - 1, highestCompletedIndex + 1)] ?? 'diamond-loadout'
}

function buildCapabilities(facts: WorldFacts): Pick<ProgressionSnapshot, 'canCraft' | 'canSmelt' | 'canMine'> {
  const canCraft: string[] = []
  const canSmelt: string[] = []
  const canMine: string[] = []

  if (facts.woodCount >= 4) {
    canCraft.push('crafting_table')
  }
  if (facts.hasCraftingTable && facts.woodCount >= 3) {
    canCraft.push('wooden_pickaxe')
    canCraft.push('wooden_axe')
    canCraft.push('wooden_sword')
  }
  if (facts.hasCraftingTable && facts.cobblestoneCount >= 3) {
    canCraft.push('stone_pickaxe')
  }
  if (facts.hasCraftingTable && facts.cobblestoneCount >= 8) {
    canCraft.push('furnace')
  }
  if (facts.hasCraftingTable && facts.ironIngotCount >= 3) {
    canCraft.push('iron_pickaxe')
  }
  if (facts.hasCraftingTable && facts.ironIngotCount >= 2) {
    canCraft.push('iron_sword')
  }
  if (facts.hasCraftingTable && facts.ironIngotCount >= 1 && facts.woodCount > 0) {
    canCraft.push('shield')
  }
  if (facts.hasCraftingTable && facts.diamondCount >= 3) {
    canCraft.push('diamond_pickaxe')
  }
  if (facts.hasCraftingTable && facts.diamondCount >= 8) {
    canCraft.push('diamond_chestplate')
  }
  if (facts.hasCraftingTable && facts.diamondCount >= 7) {
    canCraft.push('diamond_leggings')
  }
  if (facts.hasCraftingTable && facts.diamondCount >= 5) {
    canCraft.push('diamond_helmet')
  }
  if (facts.hasCraftingTable && facts.diamondCount >= 4) {
    canCraft.push('diamond_boots')
  }

  if (facts.hasPickaxe) {
    canMine.push('stone')
    canMine.push('coal_ore')
  }
  if (hasStoneTierTools(facts)) {
    canMine.push('iron_ore')
  }
  if (hasIronPickaxeReady(facts)) {
    canMine.push('diamond_ore')
  }

  if (facts.blazeRodCount > 0) {
    canCraft.push('blaze_powder')
  }
  if (facts.blazePowderCount > 0 && facts.enderPearlCount > 0) {
    canCraft.push('ender_eye')
  }
  if (facts.hasCraftingTable && facts.ironIngotCount >= 1) {
    canCraft.push('flint_and_steel')
  }

  if (facts.hasDiamondPickaxe) {
    canMine.push('obsidian')
  }

  if (facts.hasFurnace && hasFuelForSmelting(facts)) {
    if (facts.ironOreCount > 0) {
      canSmelt.push('raw_iron')
    }
    if (facts.woodCount > 0) {
      canSmelt.push('charcoal')
    }
  }

  return { canCraft, canSmelt, canMine }
}

function buildNeedsAndBlockers(
  facts: WorldFacts,
  milestone: ProgressMilestone,
): Pick<ProgressionSnapshot, 'unresolvedNeeds' | 'blockers' | 'danger' | 'nextGoals'> {
  const unresolvedNeeds: string[] = []
  const blockers: string[] = []
  const danger: string[] = []
  const nextGoals: string[] = []

  if (facts.health <= 6) {
    danger.push('low-health')
  }
  if (facts.food <= 4) {
    danger.push('low-hunger')
  }
  if (facts.nearbyHostileCount > 0) {
    danger.push('hostiles-nearby')
  }
  if (needsRecoveryFoodBeforeMining(facts)) {
    danger.push('no-recovery-food')
  }
  if (facts.timeOfDay === 'night') {
    danger.push('night')
  }

  switch (milestone) {
    case 'wood':
      unresolvedNeeds.push('logs')
      nextGoals.push('Gather 4 logs near spawn')
      break
    case 'crafting-table':
      unresolvedNeeds.push('crafting-table')
      if (facts.woodCount < 4) {
        blockers.push('missing-logs')
        nextGoals.push('Gather 4 logs near spawn')
      }
      else {
        nextGoals.push('Craft a crafting table')
      }
      break
    case 'stone-tools':
      unresolvedNeeds.push('stone-pickaxe')
      if (!facts.hasPickaxe) {
        blockers.push('no-pickaxe')
        nextGoals.push(facts.hasCraftingTable ? 'Craft a wooden pickaxe' : 'Craft a crafting table')
      }
      else if (needsRecoveryFoodBeforeMining(facts)) {
        blockers.push('unsafe-stone-mining')
        nextGoals.push('Collect nearby food')
      }
      else if (facts.cobblestoneCount < 16) {
        blockers.push('missing-cobblestone')
        nextGoals.push('Mine 16 cobblestone')
      }
      else {
        nextGoals.push('Craft a stone pickaxe')
      }
      break
    case 'food-stable':
      unresolvedNeeds.push('food-buffer')
      nextGoals.push(facts.foodItemCount > 0 ? 'Consume available food' : 'Collect nearby food')
      break
    case 'shelter':
      unresolvedNeeds.push('night-survival')
      if (needsRecoveryFoodBeforeMining(facts) && facts.cobblestoneCount < 16 && facts.woodCount < 12) {
        blockers.push('unsafe-stone-mining')
        nextGoals.push('Collect nearby food')
      }
      else if (facts.cobblestoneCount >= 16 || facts.woodCount >= 12) {
        nextGoals.push('Build a small temporary shelter using cobblestone')
      }
      else {
        blockers.push('insufficient-building-blocks')
        nextGoals.push('Mine 16 cobblestone')
      }
      break
    case 'furnace':
      unresolvedNeeds.push('furnace')
      if (needsRecoveryFoodBeforeMining(facts) && facts.cobblestoneCount < 8) {
        blockers.push('unsafe-stone-mining')
        nextGoals.push('Collect nearby food')
      }
      else if (facts.cobblestoneCount < 8) {
        blockers.push('missing-cobblestone')
        nextGoals.push('Mine 8 cobblestone')
      }
      else {
        nextGoals.push('Craft a furnace')
      }
      break
    case 'light-source':
      unresolvedNeeds.push('torches')
      if (facts.coalCount <= 0 && facts.woodCount <= 0) {
        blockers.push('missing-fuel')
        nextGoals.push('Mine coal ore')
      }
      else if (facts.coalCount <= 0) {
        nextGoals.push('Smelt charcoal for torches')
      }
      else {
        nextGoals.push('Craft torches and prepare for caves')
      }
      break
    case 'iron-acquisition':
      unresolvedNeeds.push('iron-ore')
      if (!hasStoneTierTools(facts)) {
        blockers.push('stone-pickaxe-required')
        nextGoals.push('Craft a stone pickaxe')
      }
      else {
        nextGoals.push('Mine iron ore')
      }
      break
    case 'iron-smelting':
      unresolvedNeeds.push('iron-ingots')
      if (!facts.hasFurnace) {
        blockers.push('missing-furnace')
        nextGoals.push('Craft a furnace')
      }
      else if (!hasFuelForSmelting(facts)) {
        blockers.push('missing-fuel')
        nextGoals.push('Mine coal ore')
      }
      else if (facts.ironOreCount <= 0 && facts.ironIngotCount <= 0) {
        blockers.push('missing-iron-ore')
        nextGoals.push('Mine iron ore')
      }
      else if (facts.ironOreCount > 0) {
        nextGoals.push('Smelt raw iron into iron ingots')
      }
      break
    case 'iron-pickaxe':
      unresolvedNeeds.push('iron-pickaxe')
      if (hasIronPickaxeReady(facts)) {
        nextGoals.push('Mine diamonds from a safe cave route')
      }
      else if (facts.ironIngotCount >= 3 && facts.hasCraftingTable) {
        nextGoals.push('Craft an iron pickaxe')
      }
      else if (facts.ironOreCount > 0 && facts.hasFurnace && hasFuelForSmelting(facts)) {
        nextGoals.push('Smelt raw iron into iron ingots')
      }
      else {
        blockers.push('missing-iron-ingots')
        nextGoals.push('Mine iron ore')
      }
      break
    case 'diamond-acquisition':
      unresolvedNeeds.push('diamonds')
      if (!hasIronPickaxeReady(facts)) {
        blockers.push('missing-iron-pickaxe')
        nextGoals.push('Craft an iron pickaxe')
      }
      else if (facts.foodItemCount < 4 || facts.torchCount < 8) {
        blockers.push('cave-supplies-low')
        nextGoals.push('Prepare supplies (food, torches, sword) for cave exploration')
      }
      else {
        nextGoals.push('Mine diamonds from a safe cave route')
      }
      break
    case 'diamond-loadout': {
      if (hasDiamondLoadout(facts)) {
        nextGoals.push('Establish a safe home base near the current work area')
        break
      }

      unresolvedNeeds.push('diamond-loadout')
      const nextDiamondCraftGoal = getNextDiamondCraftGoal(facts)
      if (nextDiamondCraftGoal) {
        nextGoals.push(nextDiamondCraftGoal)
      }
      else {
        blockers.push('missing-diamonds')
        nextGoals.push('Mine diamonds from a safe cave route')
      }
      break
    }
    case 'obsidian-collection':
      unresolvedNeeds.push('obsidian')
      if (!facts.hasDiamondPickaxe) {
        blockers.push('missing-diamond-pickaxe')
        nextGoals.push(facts.diamondCount >= 3 ? 'Craft a diamond pickaxe' : 'Mine diamonds from a safe cave route')
      }
      else if (facts.obsidianCount < REQUIRED_OBSIDIAN) {
        nextGoals.push(`Mine ${REQUIRED_OBSIDIAN} obsidian with the diamond pickaxe`)
      }
      if (!facts.hasFlintAndSteel) {
        unresolvedNeeds.push('flint-and-steel')
        nextGoals.push('Craft a flint and steel')
      }
      break
    case 'nether-access':
      unresolvedNeeds.push('nether-portal')
      if (facts.obsidianCount < REQUIRED_OBSIDIAN) {
        blockers.push('missing-obsidian')
        nextGoals.push(`Mine ${REQUIRED_OBSIDIAN} obsidian with the diamond pickaxe`)
      }
      else if (!facts.hasFlintAndSteel) {
        blockers.push('missing-flint-and-steel')
        nextGoals.push('Craft a flint and steel')
      }
      else {
        nextGoals.push('Build a nether portal, light it, and enter the Nether')
      }
      break
    case 'blaze-rods':
      unresolvedNeeds.push('blaze-rods')
      if (!facts.dimension.includes('nether')) {
        nextGoals.push('Enter the Nether through the portal')
      }
      else {
        nextGoals.push('Find a nether fortress and hunt blazes for blaze rods')
      }
      break
    case 'ender-pearls':
      unresolvedNeeds.push('ender-pearls')
      nextGoals.push('Hunt endermen to collect ender pearls')
      break
    case 'eyes-of-ender':
      if (facts.enderEyeCount >= REQUIRED_ENDER_EYES) {
        unresolvedNeeds.push('stronghold')
        nextGoals.push('Throw an eye of ender and triangulate the stronghold')
        nextGoals.push('Find the End portal in the stronghold, activate it, and defeat the Ender Dragon')
      }
      else {
        unresolvedNeeds.push('eyes-of-ender')
        const missingEyes = REQUIRED_ENDER_EYES - facts.enderEyeCount
        if (facts.blazePowderCount < missingEyes && facts.blazeRodCount > 0) {
          nextGoals.push('Craft blaze powder from blaze rods')
        }
        else {
          nextGoals.push('Craft eyes of ender from blaze powder and ender pearls')
        }
      }
      break
  }

  if ((danger.includes('low-health') || danger.includes('low-hunger') || danger.includes('no-recovery-food')) && milestone !== 'food-stable') {
    nextGoals.unshift(facts.foodItemCount > 0 ? 'Consume available food' : 'Collect nearby food')
  }

  return {
    unresolvedNeeds,
    blockers,
    danger,
    nextGoals: Array.from(new Set(nextGoals)).slice(0, 3),
  }
}

export function computeProgressScore(facts: WorldFacts): number {
  const completed = getCompletedMilestones(facts)
  let score = completed.length * 20

  score += clamp(facts.woodCount, 0, 32) * 0.3
  score += clamp(facts.cobblestoneCount, 0, 32) * 0.35
  score += clamp(facts.ironIngotCount, 0, 24) * 1.2
  score += clamp(facts.diamondCount, 0, 24) * 2
  score += clamp(facts.coalCount, 0, 16) * 0.5
  score += clamp(facts.foodItemCount, 0, 12) * 0.5
  score += clamp(facts.torchCount, 0, 32) * 0.15

  if (facts.hasCraftingTable) {
    score += 8
  }
  if (facts.hasFurnace) {
    score += 10
  }
  if (facts.hasShield) {
    score += 5
  }
  score += facts.diamondArmorPieceCount * 6
  if (facts.hasDiamondPickaxe) {
    score += 18
  }
  score += clamp(facts.obsidianCount, 0, 12) * 1.5
  score += clamp(facts.blazeRodCount, 0, 8) * 3
  score += clamp(facts.enderPearlCount, 0, 16) * 2.5
  score += clamp(facts.enderEyeCount, 0, 16) * 4
  if (facts.hasFlintAndSteel) {
    score += 6
  }

  switch (facts.equipmentTier) {
    case 'wood':
      score += 6
      break
    case 'stone':
      score += 16
      break
    case 'iron':
      score += 32
      break
    case 'diamond':
      score += 48
      break
    default:
      break
  }

  const runnerPhaseBonus = clamp(facts.runnerPhaseStep, 0, 6) * 2
  const runnerPhaseBase = {
    UNKNOWN: 0,
    EARLY_GAME: 4,
    STONE_AGE: 12,
    IRON_AGE: 24,
    DIAMOND_MINING: 36,
    NETHER: 48,
    ENDGAME: 60,
  }[facts.runnerPhase] ?? 0

  score += runnerPhaseBase + runnerPhaseBonus
  if (facts.health <= 6) {
    score -= 8
  }
  if (facts.food <= 4) {
    score -= 8
  }

  return Math.round(score)
}

export function computeStateHash(facts: WorldFacts): string {
  const completed = getCompletedMilestones(facts)
  const currentMilestone = resolveCurrentMilestone(completed)

  return [
    currentMilestone,
    facts.equipmentTier,
    `pickaxe:${facts.pickaxeTier}`,
    facts.hasCraftingTable ? 'ct1' : 'ct0',
    facts.hasFurnace ? 'f1' : 'f0',
    facts.hasPickaxe ? 'p1' : 'p0',
    facts.timeOfDay,
    `x${bucketCoordinate(facts.position.x)}`,
    `z${bucketCoordinate(facts.position.z)}`,
    `wood${Math.min(3, Math.floor(facts.woodCount / 4))}`,
    `cobble${Math.min(3, Math.floor(facts.cobblestoneCount / 8))}`,
    `iron${Math.min(3, Math.floor(facts.ironIngotCount / 4))}`,
    `diamond${Math.min(3, Math.floor(facts.diamondCount / 4))}`,
    `diamond_armor${facts.diamondArmorPieceCount}`,
    `food${Math.min(3, Math.floor(facts.foodItemCount / 2))}`,
    `obsidian${Math.min(3, Math.floor(facts.obsidianCount / 4))}`,
    `blaze${Math.min(3, Math.floor(blazePowderEquivalent(facts) / 4))}`,
    `pearl${Math.min(3, Math.floor(facts.enderPearlCount / 4))}`,
    `eye${Math.min(3, Math.floor(facts.enderEyeCount / 4))}`,
  ].join('|')
}

export function buildProgressionSnapshot(facts: WorldFacts): ProgressionSnapshot {
  const completedMilestones = getCompletedMilestones(facts)
  const currentMilestone = resolveCurrentMilestone(completedMilestones)
  const capabilities = buildCapabilities(facts)
  const needs = buildNeedsAndBlockers(facts, currentMilestone)

  return {
    currentMilestone,
    completedMilestones,
    ...capabilities,
    ...needs,
    score: computeProgressScore(facts),
    stateHash: computeStateHash(facts),
  }
}

export function buildProgressionPrompt(snapshot: ProgressionSnapshot): string[] {
  return [
    `current_milestone: ${snapshot.currentMilestone}`,
    `unresolved_needs: ${snapshot.unresolvedNeeds.join(', ') || 'none'}`,
    `blockers: ${snapshot.blockers.join(', ') || 'none'}`,
    `danger: ${snapshot.danger.join(', ') || 'none'}`,
    `can_craft: ${snapshot.canCraft.join(', ') || 'none'}`,
    `can_smelt: ${snapshot.canSmelt.join(', ') || 'none'}`,
    `can_mine: ${snapshot.canMine.join(', ') || 'none'}`,
    `next_goals: ${snapshot.nextGoals.join(' | ') || 'none'}`,
  ]
}

export class ProgressWatchdog {
  private readonly windowMs: number
  private readonly minObservations: number
  private readonly minScoreGain: number
  private history: ProgressObservation[] = []

  constructor(options: ProgressWatchdogOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.minObservations = options.minObservations ?? DEFAULT_MIN_OBSERVATIONS
    this.minScoreGain = options.minScoreGain ?? DEFAULT_MIN_SCORE_GAIN
  }

  public observe(facts: WorldFacts, goal?: string, now = Date.now()): void {
    const entry: ProgressObservation = {
      at: now,
      score: computeProgressScore(facts),
      stateHash: computeStateHash(facts),
      goalKey: normalizeGoalKey(goal),
    }

    this.history = this.history
      .filter(existing => now - existing.at <= this.windowMs)
      .concat(entry)
      .slice(-12)
  }

  public isStalled(): { stalled: boolean, reason: string } {
    if (this.history.length < this.minObservations) {
      return { stalled: false, reason: 'not-enough-observations' }
    }

    const recent = this.history.slice(-this.minObservations)
    const baseline = recent[0]
    const latest = recent[recent.length - 1]

    if (!baseline || !latest) {
      return { stalled: false, reason: 'insufficient-history' }
    }

    const bestScore = Math.max(...recent.map(entry => entry.score))
    const scoreGain = bestScore - baseline.score
    const sameHash = recent.every(entry => entry.stateHash === latest.stateHash)
    const sameGoal = recent.every(entry => entry.goalKey === latest.goalKey)

    if (sameHash && scoreGain < this.minScoreGain) {
      const goalSuffix = sameGoal && latest.goalKey ? ` while repeating "${latest.goalKey}"` : ''
      return {
        stalled: true,
        reason: `progress stalled for ${recent.length} observations${goalSuffix}`,
      }
    }

    return { stalled: false, reason: 'progress-moving' }
  }

  public reset(): void {
    this.history = []
  }

  public getHistoryLength(): number {
    return this.history.length
  }
}

export function buildStallRecoveryGoal(facts: WorldFacts): string {
  const snapshot = buildProgressionSnapshot(facts)

  if (facts.health <= 6 && facts.foodItemCount > 0) {
    return 'Eat food and recover health'
  }
  if (facts.food <= 4) {
    return facts.foodItemCount > 0 ? 'Consume available food' : 'Collect nearby food'
  }
  if (needsRecoveryFoodBeforeMining(facts)) {
    return 'Collect nearby food'
  }

  if (snapshot.currentMilestone === 'wood') {
    return 'Gather wood near spawn'
  }

  if (snapshot.currentMilestone === 'crafting-table') {
    return snapshot.nextGoals[0] || 'Craft a crafting table'
  }

  if (snapshot.currentMilestone === 'stone-tools') {
    return snapshot.nextGoals[0] || 'Craft a stone pickaxe'
  }

  const lateGameMilestones: ProgressMilestone[] = [
    'iron-pickaxe',
    'diamond-acquisition',
    'diamond-loadout',
    'obsidian-collection',
    'nether-access',
    'blaze-rods',
    'ender-pearls',
    'eyes-of-ender',
  ]
  if (lateGameMilestones.includes(snapshot.currentMilestone)) {
    return snapshot.nextGoals[0] || 'Mine diamonds from a safe cave route'
  }

  const dangerNeedsRecovery = snapshot.danger.includes('night')
    || snapshot.danger.includes('hostiles-nearby')
    || snapshot.danger.includes('low-health')
    || snapshot.danger.includes('low-hunger')

  if (dangerNeedsRecovery || snapshot.blockers.length > 0) {
    return snapshot.nextGoals[0] || 'Recover to a safe state before continuing progression'
  }

  return 'Explore nearby terrain for useful resources'
}
