import type { StructuredMemoryContext } from '../libs/mineflayer/memory'
import type { WorldFacts } from './preconditions'
import type { AutonomyDecisionContext } from './types'

export type ObjectiveDomain
  = | 'survival'
    | 'gather'
    | 'craft'
    | 'smelt'
    | 'mine'
    | 'explore'
    | 'combat'
    | 'base'
    | 'interior'
    | 'recovery'
    | 'social'

export interface TargetSpec {
  id: string
  description: string
  equipmentGoals: string[]
  survivalGoals: string[]
  baseGoals: string[]
  interiorGoals: string[]
  narrationQualityGoals: string[]
}

export interface ObjectiveProposal {
  objectiveId: string
  domain: ObjectiveDomain
  target: string
  whyNow: string
  urgency: number
  expectedProgressSignals: string[]
  successConditions: string[]
  prerequisites: string[]
  requiredCapabilities: string[]
  inventoryRequirements: string[]
  safetyRisks: string[]
  fallbackObjectives: string[]
  abandonConditions: string[]
  narrationGrounding: string[]
  blockedReason?: string
}

export interface GapReport {
  evaluator: string
  score: number
  urgency: number
  gaps: string[]
  blockers: string[]
  candidateObjectives: ObjectiveProposal[]
}

export interface ProgressReport {
  overallScore: number
  highPriorityGaps: string[]
  readyObjectives: ObjectiveProposal[]
  blockedObjectives: ObjectiveProposal[]
  baseScore: number
  interiorScore: number
  summary: string[]
}

export interface ObjectiveFramework {
  targetSpec: TargetSpec
  gapReports: GapReport[]
  progressReport: ProgressReport
}

export interface BaseStatusSummary {
  baseScore: number
  interiorScore: number
  utilities: string[]
  missingBaseFeatures: string[]
  missingInteriorFeatures: string[]
  functionalZones: string[]
  decorativeElements: string[]
  enclosureState: 'open' | 'partial' | 'enclosed'
  isHomeCandidate: boolean
}

interface TieredCraftGoal {
  itemName: string
  label: string
  cost: number
}

interface ObjectiveBuildContext {
  facts: WorldFacts | null
  memory: StructuredMemoryContext | undefined
  worldState: string
  inventoryItems: Set<string>
  nearbyBlocks: Set<string>
  notableBlocks: Set<string>
  inventoryAlerts: string[]
  bridgeUnsupportedCommands: Set<string>
  baseStatus: BaseStatusSummary
}

function withIndefiniteArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`
}

const DEFAULT_TARGET_SPEC: TargetSpec = {
  id: 'long-run-diamond-home',
  description: 'Progress from fresh survival to a sustainable diamond-era home base without brittle scripted routes.',
  equipmentGoals: ['full diamond armor', 'diamond pickaxe', 'shield'],
  survivalGoals: ['food buffer', 'light buffer', 'safe recovery from stalls and inventory failures'],
  baseGoals: ['safe home exists', 'bed available', 'storage available', 'crafting and smelting utilities placed', 'lighting coverage near the home anchor'],
  interiorGoals: ['sleep zone', 'storage zone', 'work/smelting zone', 'non-empty decor', 'walkable interior lanes'],
  narrationQualityGoals: ['grounded to state or plan deltas', 'no progress-faking during stalls'],
}

const IRON_GEAR_GOALS: TieredCraftGoal[] = [
  { itemName: 'iron_pickaxe', label: 'iron pickaxe', cost: 3 },
  { itemName: 'iron_sword', label: 'iron sword', cost: 2 },
  { itemName: 'shield', label: 'shield', cost: 1 },
]

const DIAMOND_LOADOUT_GOALS: TieredCraftGoal[] = [
  { itemName: 'diamond_pickaxe', label: 'diamond pickaxe', cost: 3 },
  { itemName: 'diamond_chestplate', label: 'diamond chestplate', cost: 8 },
  { itemName: 'diamond_leggings', label: 'diamond leggings', cost: 7 },
  { itemName: 'diamond_helmet', label: 'diamond helmet', cost: 5 },
  { itemName: 'diamond_boots', label: 'diamond boots', cost: 4 },
]

const DOMAIN_PRIORITY: ObjectiveDomain[] = [
  'recovery',
  'survival',
  'combat',
  'craft',
  'smelt',
  'mine',
  'gather',
  'base',
  'explore',
  'interior',
  'social',
]

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeToken(value: string | undefined): string {
  return String(value || '')
    .replace(/^minecraft:/, '')
    .replace(/\sx\d+$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeListItem(value: string): string {
  return normalizeToken(value)
    .replace(/^[a-z_]+:/i, '')
    .trim()
}

function parseWorldStateLine(worldState: string, prefix: string): string | undefined {
  const line = worldState
    .split(/\r?\n/)
    .find(entry => entry.startsWith(`${prefix}: `))
  return line?.slice(prefix.length + 2)?.trim()
}

function parseDelimitedWorldState(worldState: string, prefix: string, separator = ','): string[] {
  const value = parseWorldStateLine(worldState, prefix)
  if (!value || value === 'none' || value === 'empty' || value === 'unknown') {
    return []
  }

  return value
    .split(separator)
    .map(entry => normalizeListItem(entry))
    .filter(Boolean)
}

function parseSurfaceEscapeScaffold(value: string | undefined): {
  readiness: 'none' | 'limited' | 'ready'
  itemName: string | null
  count: number
} {
  if (!value || value === 'none') {
    return {
      readiness: 'none',
      itemName: null,
      count: 0,
    }
  }

  const match = value.match(/^(ready|limited):(\w+)\s+x(\d+)$/i)
  if (!match) {
    return {
      readiness: 'none',
      itemName: null,
      count: 0,
    }
  }

  return {
    readiness: match[1]?.toLowerCase() === 'limited' ? 'limited' : 'ready',
    itemName: normalizeToken(match[2]),
    count: Number.parseInt(match[3] || '0', 10) || 0,
  }
}

export function extractWorldStateItems(worldState: string): Set<string> {
  const items = new Set<string>()
  for (const item of parseDelimitedWorldState(worldState, 'inventory')) {
    items.add(item)
  }
  for (const item of parseDelimitedWorldState(worldState, 'equipped_armor')) {
    items.add(item)
  }
  const heldItem = normalizeListItem(parseWorldStateLine(worldState, 'held_item') || '')
  if (heldItem && heldItem !== 'empty') {
    items.add(heldItem)
  }
  return items
}

function extractNearbyBlocks(worldState: string): Set<string> {
  return new Set(parseDelimitedWorldState(worldState, 'nearby_blocks'))
}

function extractNotableBlocks(worldState: string): Set<string> {
  const entries = parseDelimitedWorldState(worldState, 'notable_blocks', '|')
  return new Set(entries.map(entry => normalizeToken(entry.split('@')[0])))
}

function extractInventoryAlerts(worldState: string): string[] {
  const raw = parseWorldStateLine(worldState, 'inventory_alerts')
  if (!raw) {
    return []
  }
  return raw
    .split(',')
    .map(entry => normalizeToken(entry))
    .filter(Boolean)
}

function extractBridgeUnsupportedCommands(worldState: string): Set<string> {
  const raw = parseWorldStateLine(worldState, 'bridge_capabilities')
  if (!raw) {
    return new Set()
  }

  const unsupportedSegment = raw
    .split(';')
    .map(entry => entry.trim())
    .find(entry => entry.startsWith('unsupported='))
  const unsupportedRaw = unsupportedSegment?.slice('unsupported='.length).trim()
  if (!unsupportedRaw || unsupportedRaw === 'none' || unsupportedRaw === 'unknown') {
    return new Set()
  }

  return new Set(
    unsupportedRaw
      .split(',')
      .map(entry => normalizeToken(entry))
      .filter(Boolean),
  )
}

function shouldDeprioritizeInventoryCleanup(context: ObjectiveBuildContext): boolean {
  if (!context.facts) {
    return false
  }

  const inventoryOrganizerFullyBlocked = context.bridgeUnsupportedCommands.has('compactInventory')
    && context.bridgeUnsupportedCommands.has('swapInventorySlots')

  return inventoryOrganizerFullyBlocked
    && (!context.facts.hasCraftingTable || !context.facts.hasPickaxe)
}

function shouldDelayInventoryCleanupForBootstrap(context: ObjectiveBuildContext): boolean {
  const facts = context.facts
  if (!facts) {
    return false
  }

  return !facts.hasCraftingTable
    || !facts.hasPickaxe
    || facts.pickaxeTier === 'wood'
    || (!facts.hasFurnace && facts.cobblestoneCount < 8)
    || (facts.foodItemCount === 0 && !facts.hasSword)
    || facts.torchCount < 4
}

function hasToken(tokens: Iterable<string>, ...needles: string[]): boolean {
  for (const token of tokens) {
    if (needles.some(needle => token === needle || token.includes(needle))) {
      return true
    }
  }
  return false
}

function hasDecor(tokens: Iterable<string>): boolean {
  return hasToken(tokens, 'lantern', 'banner', 'bookshelf', 'flower_pot', 'poppy', 'dandelion', 'painting', 'item_frame', 'carpet', 'azalea')
}

export function deriveBaseStatusFromObservation(observation: {
  worldState?: string
  inventoryItems?: Iterable<string>
  nearbyBlocks?: Iterable<string>
  notableBlocks?: Iterable<string>
  facts?: Pick<WorldFacts, 'foodItemCount' | 'torchCount' | 'nearbyHostileCount'>
  skyAccess?: string
  terrainContext?: string
}): BaseStatusSummary {
  const inventoryItems = observation.inventoryItems ? [...observation.inventoryItems].map(normalizeToken) : [...extractWorldStateItems(observation.worldState || '')]
  const nearbyBlocks = observation.nearbyBlocks ? [...observation.nearbyBlocks].map(normalizeToken) : [...extractNearbyBlocks(observation.worldState || '')]
  const notableBlocks = observation.notableBlocks ? [...observation.notableBlocks].map(normalizeToken) : [...extractNotableBlocks(observation.worldState || '')]
  const allTokens = new Set([...inventoryItems, ...nearbyBlocks, ...notableBlocks])

  const hasBed = hasToken(allTokens, 'bed')
  const hasStorage = hasToken(allTokens, 'chest', 'barrel')
  const hasCrafting = hasToken(allTokens, 'crafting_table')
  const hasFurnace = hasToken(allTokens, 'furnace', 'blast_furnace', 'smoker')
  const hasLighting = (observation.facts?.torchCount ?? 0) > 0 || hasToken(allTokens, 'torch', 'lantern')
  const hasFoodSupport = (observation.facts?.foodItemCount ?? 0) >= 4 || hasToken(allTokens, 'campfire', 'wheat', 'bread', 'meat')
  const decor = hasDecor(allTokens)

  const enclosureState: BaseStatusSummary['enclosureState'] = observation.skyAccess === 'enclosed'
    ? 'enclosed'
    : observation.skyAccess === 'partial_cover'
      ? 'partial'
      : 'open'
  const safeTerrain = observation.terrainContext !== 'underground_cave'
  const utilities = [
    hasCrafting ? 'crafting' : '',
    hasFurnace ? 'smelting' : '',
    hasStorage ? 'storage' : '',
    hasBed ? 'sleep' : '',
    hasLighting ? 'lighting' : '',
    hasFoodSupport ? 'food' : '',
  ].filter(Boolean)

  const functionalZones = [
    hasBed ? 'sleep' : '',
    hasStorage ? 'storage' : '',
    hasCrafting || hasFurnace ? 'work' : '',
    hasFoodSupport ? 'food' : '',
  ].filter(Boolean)

  let baseScore = 0
  if (enclosureState === 'enclosed')
    baseScore += 20
  else if (enclosureState === 'partial')
    baseScore += 10
  if (safeTerrain)
    baseScore += 10
  if (hasBed)
    baseScore += 15
  if (hasStorage)
    baseScore += 15
  if (hasCrafting)
    baseScore += 10
  if (hasFurnace)
    baseScore += 10
  if (hasLighting)
    baseScore += 10
  if (hasFoodSupport)
    baseScore += 10
  if ((observation.facts?.nearbyHostileCount ?? 0) === 0)
    baseScore += 5
  baseScore = Math.min(baseScore, 100)

  let interiorScore = functionalZones.length * 15
  if (hasLighting)
    interiorScore += 15
  if (decor)
    interiorScore += 20
  if (enclosureState !== 'open' && hasBed && (hasCrafting || hasFurnace) && hasStorage)
    interiorScore += 20
  interiorScore = Math.min(interiorScore, 100)

  const missingBaseFeatures = [
    enclosureState === 'open' ? 'enclosure' : '',
    !hasBed ? 'bed' : '',
    !hasStorage ? 'storage' : '',
    !hasCrafting ? 'crafting' : '',
    !hasFurnace ? 'smelting' : '',
    !hasLighting ? 'lighting' : '',
    !hasFoodSupport ? 'food-support' : '',
  ].filter(Boolean)

  const missingInteriorFeatures = [
    !functionalZones.includes('sleep') ? 'sleep-zone' : '',
    !functionalZones.includes('storage') ? 'storage-zone' : '',
    !functionalZones.includes('work') ? 'work-zone' : '',
    !functionalZones.includes('food') ? 'food-zone' : '',
    !decor ? 'decor' : '',
  ].filter(Boolean)

  return {
    baseScore,
    interiorScore,
    utilities,
    missingBaseFeatures,
    missingInteriorFeatures,
    functionalZones,
    decorativeElements: decor ? ['decor-present'] : [],
    enclosureState,
    isHomeCandidate: baseScore >= 35 || (utilities.length >= 2 && enclosureState !== 'open'),
  }
}

function createProposal(domain: ObjectiveDomain, target: string, urgency: number, partial?: Partial<ObjectiveProposal>): ObjectiveProposal {
  const objectiveId = `${domain}:${target.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
  return {
    objectiveId,
    domain,
    target,
    whyNow: partial?.whyNow || '',
    urgency: clamp(urgency),
    expectedProgressSignals: partial?.expectedProgressSignals || [],
    successConditions: partial?.successConditions || [],
    prerequisites: partial?.prerequisites || [],
    requiredCapabilities: partial?.requiredCapabilities || [],
    inventoryRequirements: partial?.inventoryRequirements || [],
    safetyRisks: partial?.safetyRisks || [],
    fallbackObjectives: partial?.fallbackObjectives || [],
    abandonConditions: partial?.abandonConditions || [],
    narrationGrounding: partial?.narrationGrounding || [],
    blockedReason: partial?.blockedReason,
  }
}

function proposalComparator(left: ObjectiveProposal, right: ObjectiveProposal): number {
  const urgencyDelta = right.urgency - left.urgency
  if (Math.abs(urgencyDelta) > 0.001) {
    return urgencyDelta
  }
  return DOMAIN_PRIORITY.indexOf(left.domain) - DOMAIN_PRIORITY.indexOf(right.domain)
}

function buildContext(context: AutonomyDecisionContext): ObjectiveBuildContext {
  const facts = context.worldFacts || null
  const inventoryItems = extractWorldStateItems(context.worldState)
  const nearbyBlocks = extractNearbyBlocks(context.worldState)
  const notableBlocks = extractNotableBlocks(context.worldState)
  const inventoryAlerts = extractInventoryAlerts(context.worldState)
  const bridgeUnsupportedCommands = extractBridgeUnsupportedCommands(context.worldState)
  const baseStatus = deriveBaseStatusFromObservation({
    worldState: context.worldState,
    inventoryItems,
    nearbyBlocks,
    notableBlocks,
    facts: facts
      ? {
          foodItemCount: facts.foodItemCount,
          torchCount: facts.torchCount,
          nearbyHostileCount: facts.nearbyHostileCount,
        }
      : undefined,
    skyAccess: parseWorldStateLine(context.worldState, 'sky_access'),
    terrainContext: parseWorldStateLine(context.worldState, 'terrain_context'),
  })

  return {
    facts,
    memory: context.structuredMemory,
    worldState: context.worldState,
    inventoryItems,
    nearbyBlocks,
    notableBlocks,
    inventoryAlerts,
    bridgeUnsupportedCommands,
    baseStatus,
  }
}

function buildRecoveryReport(context: ObjectiveBuildContext): GapReport {
  const lastFailure = normalizeToken(context.memory?.snapshot.lastFailureClass)
  const repeatedFailures = context.memory?.snapshot.repeatedFailures || []
  const mobilityState = normalizeToken(parseWorldStateLine(context.worldState, 'mobility_state'))
  const surfaceEscapeScaffold = parseSurfaceEscapeScaffold(parseWorldStateLine(context.worldState, 'surface_escape_scaffold'))
  const inventoryCleanupDeprioritized = shouldDeprioritizeInventoryCleanup(context)
  const candidateObjectives: ObjectiveProposal[] = []
  const gaps: string[] = []

  if (mobilityState === 'shaft_trap') {
    gaps.push('shaft-trap')
    candidateObjectives.push(createProposal(
      'recovery',
      surfaceEscapeScaffold.readiness === 'ready'
        ? 'Climb out of the enclosed shaft toward the surface'
        : 'Open a direct upward route out of the enclosed shaft',
      1,
      {
        whyNow: 'The current terrain looks like an enclosed vertical shaft, so generic wandering or local mining will not change the state.',
        expectedProgressSignals: ['elevation delta', 'sky access delta', 'new lateral view'],
        successConditions: ['current Y increases', 'terrain context leaves underground_cave or sky access opens'],
        inventoryRequirements: surfaceEscapeScaffold.itemName
          ? [`scaffold: ${surfaceEscapeScaffold.itemName} x${surfaceEscapeScaffold.count}`]
          : [],
        requiredCapabilities: ['surface recovery'],
        narrationGrounding: ['trap', 'recovery'],
      },
    ))
  }

  if (mobilityState === 'submerged') {
    gaps.push('submerged-trap')
    candidateObjectives.push(createProposal('recovery', 'Swim upward and break toward open air', 0.97, {
      whyNow: 'The bot is fully submerged, so deeper exploration or combat will compound the risk before oxygen is restored.',
      expectedProgressSignals: ['oxygen delta', 'sky access delta', 'position delta'],
      successConditions: ['oxygen stabilizes', 'surface air or open space becomes reachable'],
      narrationGrounding: ['danger', 'recovery'],
    }))
  }

  if (lastFailure === 'movement_stall' || repeatedFailures.some(entry => entry.includes('movement_stall'))) {
    gaps.push('movement-stall')
    candidateObjectives.push(createProposal('recovery', 'Reposition and rebuild the path from a safer angle', 0.99, {
      whyNow: 'Repeated movement stalls mean the current line of travel is no longer producing progress.',
      expectedProgressSignals: ['position delta', 'new line of sight', 'path reset'],
      successConditions: ['bot leaves the stalled coordinates', 'new movement objective becomes actionable'],
      narrationGrounding: ['failure', 'recovery'],
    }))
  }
  if (lastFailure === 'unsupported_capability' || repeatedFailures.some(entry => entry.includes('unsupported_capability'))) {
    gaps.push('blocked-capability')
    candidateObjectives.push(createProposal('recovery', 'Switch to a plan that avoids the blocked bridge capability', 1, {
      whyNow: 'The previous objective relied on a bridge capability that is unavailable in this session.',
      expectedProgressSignals: ['capability-aware replan', 'no repeated unsupported command'],
      successConditions: ['next objective avoids unsupported capability'],
      narrationGrounding: ['failure', 'recovery'],
    }))
  }
  if (lastFailure === 'full_inventory' || context.inventoryAlerts.some(entry => entry.includes('full_inventory_pressure'))) {
    gaps.push('inventory-pressure')
    candidateObjectives.push(createProposal('recovery', 'Organize inventory and reopen a quick-loot slot', inventoryCleanupDeprioritized ? 0.54 : 0.95, {
      whyNow: inventoryCleanupDeprioritized
        ? 'Inventory pressure is real, but bootstrap tool progression should stay ahead of a bridge-limited cleanup pass.'
        : 'Inventory pressure is blocking collection and follow-up crafting.',
      expectedProgressSignals: inventoryCleanupDeprioritized
        ? ['tool progression delta', 'free slot count delta']
        : ['free slot count delta', 'hotbar cleanup'],
      successConditions: ['at least one quick-loot slot is available'],
      narrationGrounding: ['failure', 'recovery'],
    }))
  }

  return {
    evaluator: 'RecoveryEvaluator',
    score: gaps.length === 0 ? 100 : clamp(100 - gaps.length * 30, 0, 100),
    urgency: candidateObjectives.length > 0 ? Math.max(...candidateObjectives.map(item => item.urgency)) : 0,
    gaps,
    blockers: [],
    candidateObjectives,
  }
}

function buildSurvivalReport(context: ObjectiveBuildContext): GapReport {
  const facts = context.facts
  const candidateObjectives: ObjectiveProposal[] = []
  const gaps: string[] = []
  const terrainContext = parseWorldStateLine(context.worldState, 'terrain_context')
  const surfaceEscapeNeeded = parseWorldStateLine(context.worldState, 'surface_escape_needed') === 'true'

  if (!facts) {
    return {
      evaluator: 'SurvivalEvaluator',
      score: 40,
      urgency: 0.5,
      gaps: ['world-facts-missing'],
      blockers: ['missing-world-facts'],
      candidateObjectives,
    }
  }

  if (facts.food <= 4 || facts.health <= 8) {
    const earlyBootstrapBlocked = !facts.hasCraftingTable || !facts.hasPickaxe
    const needsSurfaceResupply = facts.foodItemCount === 0
      && (terrainContext === 'underground_cave' || surfaceEscapeNeeded)
    gaps.push('survival-buffer-low')
    candidateObjectives.push(createProposal(
      'survival',
      needsSurfaceResupply
        ? 'Escape to the surface to gather wood'
        : facts.foodItemCount > 0
          ? 'Consume available food'
          : 'Collect nearby food',
      facts.food <= 2 || facts.health <= 6
        ? 0.98
        : earlyBootstrapBlocked
          ? 0.52
          : 0.92,
      {
        whyNow: needsSurfaceResupply
          ? 'Health or hunger is low and the current underground area is poor for immediate food recovery.'
          : 'Health or hunger is low enough to invalidate deeper progression goals.',
        expectedProgressSignals: needsSurfaceResupply
          ? ['position delta', 'terrain context change', 'food delta']
          : ['food delta', 'health delta'],
        successConditions: needsSurfaceResupply
          ? ['terrain context is no longer underground_cave', 'surface food or wood becomes reachable']
          : ['food >= 14 or food items are buffered'],
        narrationGrounding: ['danger', 'recovery'],
      },
    ))
  }

  const miningHungerBufferUnsafe = facts.hasPickaxe
    && facts.food > 4
    && facts.food <= 8
    && (facts.foodItemCount === 0 || facts.health <= 12)
  if (miningHungerBufferUnsafe) {
    const needsSurfaceResupply = facts.foodItemCount === 0
      && (terrainContext === 'underground_cave' || surfaceEscapeNeeded)
    gaps.push('mining-food-buffer-low')
    candidateObjectives.push(createProposal(
      'survival',
      facts.foodItemCount > 0
        ? 'Consume available food'
        : needsSurfaceResupply
          ? 'Escape to the surface to resupply food and torches for deeper mining'
          : 'Collect nearby food',
      needsSurfaceResupply ? 0.94 : 0.93,
      {
        whyNow: needsSurfaceResupply
          ? 'Mining cannot safely continue from the current underground position with depleted hunger and no recovery food.'
          : 'Mining cannot safely continue while hunger is depleted and no food buffer is ready.',
        expectedProgressSignals: needsSurfaceResupply
          ? ['terrain context change', 'food delta', 'torch delta']
          : ['food delta', 'health delta'],
        successConditions: needsSurfaceResupply
          ? ['terrain context is no longer underground_cave', 'food items or hunger improve before the next mine goal']
          : ['food >= 14 or food items are buffered'],
        narrationGrounding: ['danger', 'recovery'],
      },
    ))
  }

  const earlyUndergroundResupplyNeeded = facts.food > 4
    && facts.health > 8
    && facts.foodItemCount === 0
    && facts.torchCount < 4
    && !facts.hasSword
    && (terrainContext === 'underground_cave' || surfaceEscapeNeeded)
    && !['iron', 'diamond'].includes(facts.pickaxeTier)
  if (earlyUndergroundResupplyNeeded) {
    gaps.push('early-underground-resupply-needed')
    candidateObjectives.push(createProposal(
      'survival',
      'Escape to the surface to gather wood',
      facts.torchCount === 0 ? 0.87 : 0.82,
      {
        whyNow: 'Early underground progression is missing food, light, and combat basics, so a surface resupply loop is safer than forcing cave prep in place.',
        expectedProgressSignals: ['terrain context change', 'wood access delta', 'food delta', 'torch delta'],
        successConditions: ['terrain context is no longer underground_cave', 'wood or surface food becomes reachable'],
        narrationGrounding: ['recovery', 'plan'],
      },
    ))
  }

  const ironReadyUnderground = terrainContext === 'underground_cave'
    && ['iron', 'diamond'].includes(facts.pickaxeTier)
  const caveSupplyBufferLow = facts.foodItemCount < 4 || facts.torchCount < 8
  const hostilePressureHigh = facts.nearbyHostileCount >= 4
  if (ironReadyUnderground && (caveSupplyBufferLow || hostilePressureHigh)) {
    gaps.push('deep-mining-resupply-needed')
    candidateObjectives.push(createProposal(
      'survival',
      'Escape to the surface to resupply food and torches for deeper mining',
      caveSupplyBufferLow && hostilePressureHigh
        ? 0.96
        : hostilePressureHigh
          ? 0.93
          : 0.9,
      {
        whyNow: 'Iron-tier cave progression is already unlocked, but low supplies or hostile pressure make deeper mining too expensive from the current underground position.',
        expectedProgressSignals: ['terrain context change', 'food delta', 'torch delta'],
        successConditions: ['terrain context is no longer underground_cave', 'food items or torch count improve before the next deep cave push'],
        prerequisites: ['iron pickaxe or better'],
        safetyRisks: hostilePressureHigh ? ['hostiles-nearby'] : [],
        narrationGrounding: ['recovery', 'plan'],
      },
    ))
  }

  if (facts.timeOfDay === 'night' && context.baseStatus.baseScore < 45) {
    gaps.push('night-safety')
    candidateObjectives.push(createProposal('survival', 'Establish a lit temporary shelter before night combat escalates', 0.91, {
      whyNow: 'Night has started and there is no stable shelter anchor yet.',
      expectedProgressSignals: ['block placement delta', 'light placement delta'],
      successConditions: ['partial enclosure or safe retreat path exists'],
      narrationGrounding: ['danger', 'plan'],
    }))
  }

  if (facts.torchCount < 6 && facts.equipmentTier !== 'none') {
    gaps.push('light-buffer-low')
    const lightFuelObjective = facts.coalCount > 0
      ? 'Craft torches for safer cave travel'
      : facts.hasFurnace && facts.woodCount > 0
        ? 'Smelt charcoal using logs for torch and furnace fuel'
        : 'Gather fuel for torches and furnace work'
    candidateObjectives.push(createProposal('survival', lightFuelObjective, 0.74, {
      whyNow: 'Lighting is too low for safe long-form mining or base work.',
      expectedProgressSignals: ['torch count delta'],
      successConditions: ['torch count reaches at least 8'],
      narrationGrounding: ['plan', 'discovery'],
    }))
  }

  return {
    evaluator: 'SurvivalEvaluator',
    score: clamp(100 - gaps.length * 25, 0, 100),
    urgency: candidateObjectives.length > 0 ? Math.max(...candidateObjectives.map(item => item.urgency)) : 0,
    gaps,
    blockers: [],
    candidateObjectives,
  }
}

function buildInventoryReport(context: ObjectiveBuildContext): GapReport {
  const candidateObjectives: ObjectiveProposal[] = []
  const gaps: string[] = []
  const inventoryCleanupDeprioritized = shouldDeprioritizeInventoryCleanup(context)
  const bootstrapCleanupDeferred = shouldDelayInventoryCleanupForBootstrap(context)

  if (context.inventoryAlerts.some(entry => entry.includes('full_inventory_pressure'))) {
    gaps.push('full-inventory-pressure')
  }
  if (context.inventoryAlerts.some(entry => entry.includes('fragmented'))) {
    gaps.push('fragmented-stacks')
  }

  if (gaps.length > 0) {
    const hasFullInventoryPressure = gaps.includes('full-inventory-pressure')
    const cleanupUrgency = inventoryCleanupDeprioritized
      ? 0.34
      : bootstrapCleanupDeferred
        ? hasFullInventoryPressure
          ? 0.48
          : 0.22
        : hasFullInventoryPressure
          ? 0.88
          : 0.4
    candidateObjectives.push(createProposal('recovery', 'Organize inventory and keep a quick-loot slot open', cleanupUrgency, {
      whyNow: inventoryCleanupDeprioritized
        ? 'Inventory pressure exists, but bootstrap tools should be secured before a bridge-limited cleanup pass.'
        : bootstrapCleanupDeferred
          ? 'Inventory cleanup can wait until stone-tier tools and immediate survival buffers are stabilized.'
          : 'Inventory fragmentation or slot pressure is reducing execution reliability.',
      expectedProgressSignals: inventoryCleanupDeprioritized || bootstrapCleanupDeferred
        ? ['tool progression delta', 'inventory delta']
        : ['inventory delta', 'hotbar cleanup'],
      successConditions: ['quick-loot slot remains empty', 'pressure alerts are gone'],
      narrationGrounding: ['recovery', 'status'],
    }))
  }

  return {
    evaluator: 'InventoryEvaluator',
    score: clamp(100 - gaps.length * 30, 0, 100),
    urgency: candidateObjectives.length > 0 ? Math.max(...candidateObjectives.map(item => item.urgency)) : 0,
    gaps,
    blockers: [],
    candidateObjectives,
  }
}

function buildEquipmentReport(context: ObjectiveBuildContext): GapReport {
  const facts = context.facts
  const candidateObjectives: ObjectiveProposal[] = []
  const gaps: string[] = []

  if (!facts) {
    return {
      evaluator: 'EquipmentEvaluator',
      score: 50,
      urgency: 0.3,
      gaps: ['world-facts-missing'],
      blockers: ['missing-world-facts'],
      candidateObjectives,
    }
  }

  const hasItem = (itemName: string) => context.inventoryItems.has(itemName)

  if (!facts.hasCraftingTable) {
    gaps.push('crafting-table-missing')
    candidateObjectives.push(createProposal('craft', facts.woodCount >= 4 ? 'Craft a crafting table' : 'Gather 4 logs near spawn', 0.83, {
      whyNow: 'Most durable progression requires a crafting table.',
      expectedProgressSignals: ['inventory delta', 'crafting table availability'],
      successConditions: ['crafting table is in inventory or placed nearby'],
      narrationGrounding: ['plan', 'progress'],
    }))
  }

  if (!facts.hasPickaxe) {
    gaps.push('pickaxe-missing')
    candidateObjectives.push(createProposal('craft', facts.hasCraftingTable ? 'Craft a wooden pickaxe' : 'Craft a crafting table', 0.9, {
      whyNow: 'Mining progression is blocked without a pickaxe.',
      expectedProgressSignals: ['held item delta', 'tool tier delta'],
      successConditions: ['pickaxe is present and equip-ready'],
      narrationGrounding: ['plan', 'progress'],
    }))
  }

  const needsStoneTierBootstrap = facts.hasPickaxe && facts.pickaxeTier === 'wood'
  if (needsStoneTierBootstrap) {
    if (facts.cobblestoneCount < 16) {
      gaps.push('stone-tier-bootstrap-needed')
      candidateObjectives.push(createProposal('mine', 'Mine 16 cobblestone', 0.84, {
        whyNow: 'Wood-tier tools are ready, and the next stable unlock is enough cobblestone for stone tools plus a furnace.',
        expectedProgressSignals: ['cobblestone delta', 'stone-tier ingredients ready'],
        successConditions: ['cobblestone count reaches at least 16'],
        prerequisites: ['wooden pickaxe'],
        narrationGrounding: ['plan', 'progress'],
      }))
    }
    else if (!hasItem('stone_pickaxe')) {
      gaps.push('stone-pickaxe-missing')
      candidateObjectives.push(createProposal('craft', 'Craft a stone pickaxe', 0.83, {
        whyNow: 'Stone-tier mining unlocks furnace prep, iron acquisition, and more reliable combat recovery.',
        expectedProgressSignals: ['inventory delta', 'tool tier delta'],
        successConditions: ['stone_pickaxe is present in inventory or equipped'],
        prerequisites: ['cobblestone x3', 'stick x2', 'crafting table access'],
        narrationGrounding: ['plan', 'progress'],
      }))
    }
  }

  if (
    facts.pickaxeTier === 'stone'
    || facts.pickaxeTier === 'iron'
    || facts.pickaxeTier === 'diamond'
    || facts.ironIngotCount > 0
    || facts.ironOreCount > 0
  ) {
    for (const craft of IRON_GEAR_GOALS) {
      if (!hasItem(craft.itemName) && facts.ironIngotCount >= craft.cost) {
        gaps.push(`missing-${craft.itemName}`)
        candidateObjectives.push(createProposal('craft', `Craft ${withIndefiniteArticle(craft.label)}`, 0.76, {
          whyNow: 'Immediate combat and mining reliability improve with core iron equipment.',
          expectedProgressSignals: ['inventory delta', 'equipment tier delta'],
          successConditions: [`${craft.itemName} is present in inventory or equipped`],
          narrationGrounding: ['plan', 'progress'],
        }))
      }
    }
  }

  if (facts.pickaxeTier === 'stone' && facts.ironOreCount === 0 && facts.ironIngotCount < 3) {
    gaps.push('iron-upgrade-needed')
    candidateObjectives.push(createProposal('mine', 'Mine iron ore', 0.71, {
      whyNow: 'Stone-tier tools are ready and the next durable equipment upgrade depends on iron.',
      expectedProgressSignals: ['iron ore delta', 'cave progress delta'],
      successConditions: ['iron ore is collected'],
      prerequisites: ['stone pickaxe', 'basic food or torch buffer'],
      narrationGrounding: ['plan', 'discovery'],
    }))
  }

  if (facts.pickaxeTier === 'iron' || facts.pickaxeTier === 'diamond' || facts.diamondCount > 0 || facts.diamondArmorPieceCount > 0) {
    let missingDiamondGoal = false
    for (const craft of DIAMOND_LOADOUT_GOALS) {
      if (!hasItem(craft.itemName)) {
        missingDiamondGoal = true
        if (facts.diamondCount >= craft.cost) {
          candidateObjectives.push(createProposal('craft', `Craft ${withIndefiniteArticle(craft.label)}`, 0.78, {
            whyNow: 'The target spec requires a diamond loadout, and current resources already satisfy this item.',
            expectedProgressSignals: ['inventory delta', 'equipment delta'],
            successConditions: [`${craft.itemName} is present in inventory or equipped`],
            narrationGrounding: ['plan', 'progress'],
          }))
        }
      }
    }
    if (missingDiamondGoal && facts.diamondCount < 3 && ['iron', 'diamond'].includes(facts.pickaxeTier)) {
      gaps.push('diamond-loadout-incomplete')
      candidateObjectives.push(createProposal('mine', 'Mine diamonds from a safe cave route', 0.66, {
        whyNow: 'Iron-tier gear is ready for a deeper resource push toward the target spec.',
        expectedProgressSignals: ['position delta', 'diamond count delta', 'milestone delta'],
        successConditions: ['diamond count increases or deeper mine anchor is established'],
        prerequisites: ['iron pickaxe', 'food buffer', 'light buffer'],
        narrationGrounding: ['plan', 'discovery'],
      }))
    }
  }

  return {
    evaluator: 'EquipmentEvaluator',
    score: clamp(100 - gaps.length * 20, 0, 100),
    urgency: candidateObjectives.length > 0 ? Math.max(...candidateObjectives.map(item => item.urgency)) : 0,
    gaps,
    blockers: [],
    candidateObjectives,
  }
}

function buildCraftingAndSmeltingReports(context: ObjectiveBuildContext): GapReport[] {
  const facts = context.facts
  const craftingObjectives: ObjectiveProposal[] = []
  const craftingGaps: string[] = []
  const smeltingObjectives: ObjectiveProposal[] = []
  const smeltingGaps: string[] = []

  if (!facts) {
    return [
      { evaluator: 'CraftingEvaluator', score: 50, urgency: 0, gaps: ['world-facts-missing'], blockers: ['missing-world-facts'], candidateObjectives: [] },
      { evaluator: 'SmeltingEvaluator', score: 50, urgency: 0, gaps: ['world-facts-missing'], blockers: ['missing-world-facts'], candidateObjectives: [] },
    ]
  }

  if (facts.hasCraftingTable && facts.cobblestoneCount >= 8 && !facts.hasFurnace) {
    craftingGaps.push('furnace-missing')
    craftingObjectives.push(createProposal('craft', 'Craft a furnace', 0.76, {
      whyNow: 'Smelting and food prep are blocked until a furnace is available.',
      expectedProgressSignals: ['inventory delta', 'furnace availability'],
      successConditions: ['furnace is present in inventory or placed nearby'],
      narrationGrounding: ['plan', 'progress'],
    }))
  }

  if (facts.ironOreCount > 0) {
    if (!facts.hasFurnace) {
      smeltingGaps.push('furnace-missing-for-smelt')
    }
    else if (facts.coalCount > 0 || facts.woodCount > 0) {
      smeltingGaps.push('iron-ready-to-smelt')
      smeltingObjectives.push(createProposal('smelt', 'Smelt raw iron into iron ingots', 0.84, {
        whyNow: 'The ore is already collected; smelting converts it into immediate equipment progress.',
        expectedProgressSignals: ['iron ingot delta'],
        successConditions: ['iron ingot count increases'],
        narrationGrounding: ['plan', 'progress'],
      }))
    }
    else {
      smeltingGaps.push('fuel-missing-for-smelt')
      smeltingObjectives.push(createProposal('gather', 'Gather fuel for furnace work', 0.7, {
        whyNow: 'Smelting is blocked on fuel, not ore availability.',
        expectedProgressSignals: ['fuel delta'],
        successConditions: ['coal or charcoal becomes available'],
        narrationGrounding: ['plan', 'discovery'],
      }))
    }
  }

  return [
    {
      evaluator: 'CraftingEvaluator',
      score: clamp(100 - craftingGaps.length * 20, 0, 100),
      urgency: craftingObjectives.length > 0 ? Math.max(...craftingObjectives.map(item => item.urgency)) : 0,
      gaps: craftingGaps,
      blockers: [],
      candidateObjectives: craftingObjectives,
    },
    {
      evaluator: 'SmeltingEvaluator',
      score: clamp(100 - smeltingGaps.length * 20, 0, 100),
      urgency: smeltingObjectives.length > 0 ? Math.max(...smeltingObjectives.map(item => item.urgency)) : 0,
      gaps: smeltingGaps,
      blockers: [],
      candidateObjectives: smeltingObjectives,
    },
  ]
}

function buildExplorationReport(context: ObjectiveBuildContext): GapReport {
  const facts = context.facts
  const candidateObjectives: ObjectiveProposal[] = []
  const gaps: string[] = []

  if (!facts) {
    return {
      evaluator: 'ExplorationEvaluator',
      score: 50,
      urgency: 0,
      gaps: ['world-facts-missing'],
      blockers: ['missing-world-facts'],
      candidateObjectives: [],
    }
  }

  if (facts.woodCount < 4 && parseWorldStateLine(context.worldState, 'terrain_context') === 'underground_cave') {
    gaps.push('surface-wood-needed')
    candidateObjectives.push(createProposal('explore', 'Return to the surface and scout for wood', 0.8, {
      whyNow: 'Wood is required for tools, fuel, or emergency crafting and the current area is underground.',
      expectedProgressSignals: ['position delta', 'wood access delta'],
      successConditions: ['wood becomes reachable or collected'],
      narrationGrounding: ['plan', 'recovery'],
    }))
  }

  if (facts.pickaxeTier === 'stone' && facts.torchCount >= 8 && facts.foodItemCount >= 4 && facts.ironOreCount === 0) {
    gaps.push('iron-route-needed')
    candidateObjectives.push(createProposal('explore', 'Scout a safe cave route for iron and coal', 0.64, {
      whyNow: 'Current gear is ready for a deeper cave trip but iron has not been located yet.',
      expectedProgressSignals: ['position delta', 'discovery delta', 'iron ore delta'],
      successConditions: ['iron ore or cave anchor is discovered'],
      narrationGrounding: ['plan', 'discovery'],
    }))
  }

  return {
    evaluator: 'ExplorationEvaluator',
    score: clamp(100 - gaps.length * 20, 0, 100),
    urgency: candidateObjectives.length > 0 ? Math.max(...candidateObjectives.map(item => item.urgency)) : 0,
    gaps,
    blockers: [],
    candidateObjectives,
  }
}

function buildBaseReport(context: ObjectiveBuildContext): GapReport {
  const facts = context.facts
  const candidateObjectives: ObjectiveProposal[] = []
  const gaps = [...context.baseStatus.missingBaseFeatures]
  const blockers: string[] = []

  if (facts && (facts.food <= 4 || facts.health <= 8)) {
    blockers.push('survival-not-stable')
  }

  const needsStructuralHome = context.baseStatus.missingBaseFeatures.includes('enclosure')
    || context.baseStatus.baseScore < 35

  if (needsStructuralHome) {
    candidateObjectives.push(createProposal('base', 'Establish a safe home base near the current work area', blockers.length > 0 ? 0.4 : 0.68, {
      whyNow: 'Long-horizon progression needs a reusable anchor for storage, smelting, and safe returns.',
      expectedProgressSignals: ['base score delta', 'utility placement delta'],
      successConditions: ['base score reaches at least 45'],
      fallbackObjectives: ['Establish a lit temporary shelter before night combat escalates'],
      blockedReason: blockers[0],
      narrationGrounding: ['plan', 'progress'],
    }))
  }

  if (context.baseStatus.baseScore >= 35) {
    if (context.baseStatus.missingBaseFeatures.includes('bed')) {
      candidateObjectives.push(createProposal('base', 'Add a bed to the home anchor', blockers.length > 0 ? 0.38 : 0.62, {
        whyNow: 'A respawn point reduces loss and supports night-cycle control.',
        expectedProgressSignals: ['bed placement delta'],
        successConditions: ['bed is present in the base area'],
        blockedReason: blockers[0],
        narrationGrounding: ['plan', 'progress'],
      }))
    }
    if (context.baseStatus.missingBaseFeatures.includes('storage')) {
      candidateObjectives.push(createProposal('base', 'Add storage near the home anchor', blockers.length > 0 ? 0.38 : 0.6, {
        whyNow: 'Storage is required to keep mining kits and building supplies stable over long runs.',
        expectedProgressSignals: ['chest placement delta'],
        successConditions: ['storage utility exists at the home anchor'],
        blockedReason: blockers[0],
        narrationGrounding: ['plan', 'progress'],
      }))
    }
    if (context.baseStatus.missingBaseFeatures.includes('lighting')) {
      candidateObjectives.push(createProposal('base', 'Light the home perimeter and work area', blockers.length > 0 ? 0.36 : 0.58, {
        whyNow: 'Lighting reduces hostile pressure and protects the return path.',
        expectedProgressSignals: ['light placement delta'],
        successConditions: ['base lighting coverage improves'],
        blockedReason: blockers[0],
        narrationGrounding: ['plan', 'progress'],
      }))
    }
  }

  return {
    evaluator: 'BaseEvaluator',
    score: context.baseStatus.baseScore,
    urgency: candidateObjectives.length > 0 ? Math.max(...candidateObjectives.map(item => item.urgency)) : 0,
    gaps,
    blockers,
    candidateObjectives,
  }
}

function buildInteriorReport(context: ObjectiveBuildContext): GapReport {
  const candidateObjectives: ObjectiveProposal[] = []
  const blockers: string[] = []
  const gaps = [...context.baseStatus.missingInteriorFeatures]

  if (context.baseStatus.baseScore < 45) {
    blockers.push('base-not-stable')
  }

  if (context.baseStatus.baseScore >= 45 && context.baseStatus.interiorScore < 45) {
    candidateObjectives.push(createProposal('interior', 'Furnish the home with clear sleep, storage, and work zones', blockers.length > 0 ? 0.3 : 0.46, {
      whyNow: 'The home shell exists, but long unattended runs benefit from functional zoning inside the base.',
      expectedProgressSignals: ['interior score delta', 'utility placement delta'],
      successConditions: ['interior score reaches at least 50'],
      blockedReason: blockers[0],
      narrationGrounding: ['plan', 'progress'],
    }))
  }

  if (context.baseStatus.baseScore >= 55 && context.baseStatus.interiorScore >= 45 && context.baseStatus.decorativeElements.length === 0) {
    candidateObjectives.push(createProposal('interior', 'Upgrade the home interior with decorative details from available materials', blockers.length > 0 ? 0.25 : 0.34, {
      whyNow: 'The target spec calls for a home that is more than an empty functional shell.',
      expectedProgressSignals: ['interior score delta', 'decor placement delta'],
      successConditions: ['decorative elements are present in the interior'],
      blockedReason: blockers[0],
      narrationGrounding: ['plan', 'progress'],
    }))
  }

  return {
    evaluator: 'InteriorEvaluator',
    score: context.baseStatus.interiorScore,
    urgency: candidateObjectives.length > 0 ? Math.max(...candidateObjectives.map(item => item.urgency)) : 0,
    gaps,
    blockers,
    candidateObjectives,
  }
}

function buildNarrationReport(context: ObjectiveBuildContext): GapReport {
  const gaps: string[] = []
  if (!context.memory?.snapshot.lastActionOutcome) {
    gaps.push('thin-grounding')
  }
  return {
    evaluator: 'NarrationEvaluator',
    score: gaps.length === 0 ? 100 : 70,
    urgency: 0.1,
    gaps,
    blockers: [],
    candidateObjectives: [],
  }
}

export function buildObjectiveFramework(context: AutonomyDecisionContext): ObjectiveFramework {
  const build = buildContext(context)
  const reports = [
    buildRecoveryReport(build),
    buildSurvivalReport(build),
    buildInventoryReport(build),
    buildEquipmentReport(build),
    ...buildCraftingAndSmeltingReports(build),
    buildExplorationReport(build),
    buildBaseReport(build),
    buildInteriorReport(build),
    buildNarrationReport(build),
  ]

  const readyObjectives = reports
    .flatMap(report => report.candidateObjectives)
    .filter(objective => !objective.blockedReason)
    .sort(proposalComparator)
  const blockedObjectives = reports
    .flatMap(report => report.candidateObjectives)
    .filter(objective => Boolean(objective.blockedReason))
    .sort(proposalComparator)

  const overallScore = Math.round(reports.reduce((sum, report) => sum + report.score, 0) / reports.length)
  const highPriorityGaps = reports
    .filter(report => report.urgency >= 0.6 || report.score < 60)
    .flatMap(report => report.gaps.map(gap => `${report.evaluator}:${gap}`))
    .slice(0, 8)

  return {
    targetSpec: DEFAULT_TARGET_SPEC,
    gapReports: reports,
    progressReport: {
      overallScore,
      highPriorityGaps,
      readyObjectives,
      blockedObjectives,
      baseScore: build.baseStatus.baseScore,
      interiorScore: build.baseStatus.interiorScore,
      summary: [
        `overall_score=${overallScore}`,
        `base_score=${build.baseStatus.baseScore}`,
        `interior_score=${build.baseStatus.interiorScore}`,
      ],
    },
  }
}

export function formatObjectiveFrameworkFacts(framework: ObjectiveFramework, maxObjectives = 5): string[] {
  const recommendedObjective = getRecommendedObjective(framework)
  const topObjectives = framework.progressReport.readyObjectives
    .slice(0, maxObjectives)
    .map(objective => `[${objective.domain}] ${objective.target} (u=${objective.urgency.toFixed(2)})`)
  const topBlocked = framework.progressReport.blockedObjectives
    .slice(0, 3)
    .map(objective => `[${objective.domain}] ${objective.target} -> ${objective.blockedReason}`)
  const reportFacts = framework.gapReports
    .filter(report => report.urgency > 0 || report.gaps.length > 0)
    .slice(0, 6)
    .map((report) => {
      const gaps = report.gaps.join(', ') || 'none'
      const blockers = report.blockers.join(', ') || 'none'
      return `objective_gap_${report.evaluator}: score=${report.score} urgency=${report.urgency.toFixed(2)} gaps=${gaps} blockers=${blockers}`
    })

  return [
    `target_spec: ${framework.targetSpec.id}`,
    `target_equipment_goals: ${framework.targetSpec.equipmentGoals.join(', ')}`,
    `target_base_goals: ${framework.targetSpec.baseGoals.join(', ')}`,
    `target_interior_goals: ${framework.targetSpec.interiorGoals.join(', ')}`,
    `objective_overall_score: ${framework.progressReport.overallScore}`,
    `objective_base_score: ${framework.progressReport.baseScore}`,
    `objective_interior_score: ${framework.progressReport.interiorScore}`,
    `objective_high_priority_gaps: ${framework.progressReport.highPriorityGaps.join(' | ') || 'none'}`,
    `objective_recommended: ${recommendedObjective ? `[${recommendedObjective.domain}] ${recommendedObjective.target} (u=${recommendedObjective.urgency.toFixed(2)})` : 'none'}`,
    `objective_candidates: ${topObjectives.join(' | ') || 'none'}`,
    `objective_blocked: ${topBlocked.join(' | ') || 'none'}`,
    ...reportFacts,
  ]
}

export function getRecommendedObjective(framework: ObjectiveFramework): ObjectiveProposal | null {
  return framework.progressReport.readyObjectives[0] ?? framework.progressReport.blockedObjectives[0] ?? null
}

export function chooseFallbackObjective(framework: ObjectiveFramework): ObjectiveProposal | null {
  return getRecommendedObjective(framework)
}

export function inferSuggestionDomains(suggestion: string): ObjectiveDomain[] {
  const normalized = suggestion.toLowerCase()
  const domains = new Set<ObjectiveDomain>()

  if (/家|拠点|base|home|bed|storage|chest|furnace|crafting/.test(normalized))
    domains.add('base')
  if (/内装|interior|decorate|room|zone|furnish/.test(normalized))
    domains.add('interior')
  if (/食料|food|hunger|eat|cook|bread|meat/.test(normalized))
    domains.add('survival')
  if (/鉄|iron|ダイヤ|diamond|mine|採掘|cave|洞窟/.test(normalized)) {
    domains.add('mine')
    domains.add('explore')
  }
  if (/craft|作|tool|pickaxe|axe|sword|shield/.test(normalized))
    domains.add('craft')
  if (/recover|stall|stuck|replan|回復|復旧/.test(normalized))
    domains.add('recovery')

  return domains.size > 0 ? [...domains] : ['explore']
}

export function chooseObjectiveForDomains(framework: ObjectiveFramework, domains: ObjectiveDomain[]): ObjectiveProposal | null {
  const match = framework.progressReport.readyObjectives.find(objective => domains.includes(objective.domain))
  if (match) {
    return match
  }
  return chooseFallbackObjective(framework)
}
