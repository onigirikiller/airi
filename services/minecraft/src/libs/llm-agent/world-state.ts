import type { Mineflayer } from '../mineflayer'

import { Vec3 } from 'vec3'

import { deriveBaseStatusFromObservation } from '../../autonomy/objectives'
import { collectWorldFacts } from '../../autonomy/preconditions'
import { buildProgressionSnapshot } from '../../autonomy/progress'
import { getCanonicalInventorySnapshot } from '../../skills/actions/inventory'
import { getBlockAtAccurate } from '../../skills/block-access'
import { getInventoryCounts, getNearbyEntities, getNearbyPlayerNames, getNearestBlock } from '../../skills/world'
import { getAllBiomes } from '../../utils/mcdata'
import {
  deriveMobilityState,
  describeSurfaceEscapeScaffold,
} from '../../utils/surface-recovery'
import { deriveTaskContextFromGoal, formatCanonicalInventoryFacts } from '../inventory/policy'

export interface WorldStateSnapshot {
  dimension: string
  biome: string
  position: { x: number, y: number, z: number }
  health: number
  food: number
  oxygenLevel?: number
  weather: string
  timeOfDay: string
  skyAccess: string
  terrainContext: string
  woodAccess: string
  surfaceEscapeNeeded: boolean
  mobilityState: 'unknown' | 'open' | 'blocked' | 'shaft_trap' | 'submerged'
  surfaceEscapeScaffold: string
  pickaxeAccess: string
  axeAccess: string
  woodMaterials: string
  heldItem: string
  equippedArmor: string[]
  inventorySummary: string[]
  inventoryFacts: string[]
  bridgeFacts: string[]
  progressionFacts: string[]
  baseFacts: string[]
  nearbyPlayers: string[]
  nearbyEntities: string[]
  nearbyBlocks: string[]
  notableBlocks: string[]
  immediateTerrain: string[]
}

export interface NotableBlockObservation {
  name: string
  position: { x: number, y: number, z: number }
  distance: number
}

interface BridgeDebugState {
  connected?: boolean
  ready?: boolean
}

const DEFAULT_NOTABLE_BLOCK_TYPES = [
  'crafting_table',
  'furnace',
  'chest',
  'white_bed',
  'water',
  'lava',
  'oak_log',
  'birch_log',
  'spruce_log',
  'coal_ore',
  'iron_ore',
  'diamond_ore',
  'obsidian',
  'nether_portal',
]

function normalizeName(value: string | undefined): string {
  if (!value) {
    return 'unknown'
  }

  return value.replace(/^minecraft:/, '')
}

function normalizeDimension(value: string | undefined): string {
  const normalized = normalizeName(value)
  if (normalized === 'overworld')
    return normalized
  if (normalized === 'the_nether')
    return 'nether'
  if (normalized === 'the_end')
    return 'end'
  return normalized
}

function isAirLike(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function isWoodLike(name: string): boolean {
  return name.includes('log')
    || name.includes('wood')
    || name.includes('stem')
    || name.includes('hyphae')
    || name.includes('leaves')
}

function isStoneLike(name: string): boolean {
  return name.includes('stone')
    || name.includes('deepslate')
    || name.includes('tuff')
    || name.includes('granite')
    || name.includes('andesite')
    || name.includes('diorite')
    || name.includes('dripstone')
    || name.includes('ore')
}

function isSurfaceGroundLike(name: string): boolean {
  return name === 'grass_block'
    || name === 'dirt'
    || name === 'coarse_dirt'
    || name === 'podzol'
    || name === 'mycelium'
    || name === 'sand'
    || name === 'red_sand'
    || name === 'gravel'
    || name === 'mud'
    || name === 'snow_block'
    || name === 'snow'
    || name === 'moss_block'
}

function formatDistance(dx: number, dy: number, dz: number): string {
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return distance.toFixed(1)
}

function formatPosition(x: number, y: number, z: number): string {
  return `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`
}

function getWeather(bot: Mineflayer): string {
  if (bot.bot.thunderState) {
    return 'thunder'
  }
  if (bot.bot.isRaining) {
    return 'rain'
  }
  return 'clear'
}

function canQueryWorldState(bot: Mineflayer): boolean {
  const bridgeStateGetter = (bot as any).getBridgeDebugState
  if (typeof bridgeStateGetter !== 'function') {
    return true
  }

  try {
    const bridgeState = bridgeStateGetter.call(bot) as BridgeDebugState | null
    if (!bridgeState) {
      return true
    }
    return bridgeState.connected === true && bridgeState.ready === true
  }
  catch {
    return true
  }
}

function getTimeOfDay(bot: Mineflayer): string {
  const time = bot.bot.time?.timeOfDay ?? 0
  if (time < 6000)
    return 'morning'
  if (time < 12000)
    return 'afternoon'
  if (time < 18000)
    return 'evening'
  return 'night'
}

function getHeldItem(bot: Mineflayer): string {
  const snapshot = getCanonicalInventorySnapshot(bot, 'world-state:held-item')
  const held = snapshot.heldItem
  if (!held?.itemName) {
    const fallbackHeld = bot.bot.heldItem
    if (!fallbackHeld?.name) {
      return 'empty'
    }
    return `${normalizeName(fallbackHeld.name)} x${fallbackHeld.count ?? 1}`
  }

  return `${normalizeName(held.itemName)} x${held.count}`
}

function getEquippedArmor(bot: Mineflayer): string[] {
  const snapshot = getCanonicalInventorySnapshot(bot, 'world-state:armor')
  return snapshot.armor
    .map((slot) => {
      switch (slot.slotIndex) {
        case 39:
          return `head:${normalizeName(slot.itemName ?? '')}`
        case 38:
          return `torso:${normalizeName(slot.itemName ?? '')}`
        case 37:
          return `legs:${normalizeName(slot.itemName ?? '')}`
        case 36:
          return `feet:${normalizeName(slot.itemName ?? '')}`
        default:
          return ''
      }
    })
    .filter(Boolean)
}

function getInventorySummary(bot: Mineflayer): string[] {
  const snapshot = getCanonicalInventorySnapshot(bot, 'world-state:inventory-summary')
  if (Object.keys(snapshot.groupedStacks).length === 0) {
    return Object.entries(getInventoryCounts(bot))
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 20)
      .map(([name, count]) => `${normalizeName(name)} x${count}`)
  }
  return Object.values(snapshot.groupedStacks)
    .map(group => [group.itemName, group.totalCount] as const)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 20)
    .map(([name, count]) => `${normalizeName(name)} x${count}`)
}

function getEquippedUtilityItemNames(bot: Mineflayer): string[] {
  return [
    bot.bot.heldItem,
    bot.bot.inventory?.slots?.[45],
  ]
    .map(item => item?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

function matchesToolCategory(itemName: string, toolCategory: 'pickaxe' | 'axe'): boolean {
  if (toolCategory === 'pickaxe') {
    return itemName.includes('pickaxe')
  }

  return itemName.includes('axe') && !itemName.includes('pickaxe')
}

function getToolAccess(bot: Mineflayer, toolCategory: 'pickaxe' | 'axe'): string {
  const inventoryItems = bot.bot.inventory.items()
  const hasTool = inventoryItems.some(item => matchesToolCategory(item.name, toolCategory))
    || getEquippedUtilityItemNames(bot).some(itemName => matchesToolCategory(itemName, toolCategory))

  if (hasTool) {
    return 'available'
  }

  const inventory = getInventoryCounts(bot)
  const hasLogs = Object.entries(inventory).some(([name, count]) =>
    (name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_stem') || name.endsWith('hyphae'))
    && count > 0,
  )
  const hasPlanks = Object.entries(inventory).some(([name, count]) =>
    (name === 'planks' || name.endsWith('_planks'))
    && count > 0,
  )
  const hasSticks = (inventory.stick ?? 0) > 0

  if (hasLogs || (hasPlanks && hasSticks)) {
    return 'craftable_from_inventory'
  }

  return 'missing'
}

function getWoodMaterialsSummary(bot: Mineflayer): string {
  const inventory = getInventoryCounts(bot)
  const logs = Object.entries(inventory)
    .filter(([name]) => name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_stem') || name.endsWith('hyphae'))
    .reduce((sum, [, count]) => sum + count, 0)
  const planks = Object.entries(inventory)
    .filter(([name]) => name === 'planks' || name.endsWith('_planks'))
    .reduce((sum, [, count]) => sum + count, 0)
  const sticks = inventory.stick ?? 0

  return `logs=${logs}, planks=${planks}, sticks=${sticks}`
}

function getProgressionFacts(bot: Mineflayer): string[] {
  try {
    const snapshot = buildProgressionSnapshot(collectWorldFacts(bot))
    const capabilityLine = [
      `craft=${snapshot.canCraft.slice(0, 4).join(', ') || 'none'}`,
      `smelt=${snapshot.canSmelt.slice(0, 3).join(', ') || 'none'}`,
      `mine=${snapshot.canMine.slice(0, 4).join(', ') || 'none'}`,
    ].join(' | ')

    return [
      `progress_milestone: ${snapshot.currentMilestone}`,
      `progress_needs: ${snapshot.unresolvedNeeds.join(', ') || 'none'}`,
      `progress_blockers: ${snapshot.blockers.join(', ') || 'none'}`,
      `progress_next_goals: ${snapshot.nextGoals.slice(0, 2).join(' | ') || 'none'}`,
      `progress_capabilities: ${capabilityLine}`,
    ]
  }
  catch {
    return []
  }
}

function getBridgeFacts(bot: Mineflayer): string[] {
  const bridgeStateGetter = (bot as any).getBridgeDebugState
  if (typeof bridgeStateGetter !== 'function') {
    return []
  }

  try {
    const debugState = bridgeStateGetter.call(bot) as {
      capabilitySnapshot?: {
        capabilityHash?: string
        supportedCommands?: string[]
        unsupportedCommands?: string[]
      }
    } | null
    const capabilitySnapshot = debugState?.capabilitySnapshot
    if (!capabilitySnapshot) {
      return []
    }

    const supported = Array.isArray(capabilitySnapshot.supportedCommands) && capabilitySnapshot.supportedCommands.length > 0
      ? capabilitySnapshot.supportedCommands.join('|')
      : 'none'
    const unsupported = Array.isArray(capabilitySnapshot.unsupportedCommands) && capabilitySnapshot.unsupportedCommands.length > 0
      ? capabilitySnapshot.unsupportedCommands.join('|')
      : 'none'

    return [`bridge_capabilities: unsupported=${unsupported}; supported=${supported}; hash=${capabilitySnapshot.capabilityHash || 'unknown'}`]
  }
  catch {
    return []
  }
}

function getBaseFacts(bot: Mineflayer, snapshot: Pick<WorldStateSnapshot, 'inventorySummary' | 'nearbyBlocks' | 'notableBlocks' | 'skyAccess' | 'terrainContext'>): string[] {
  try {
    const worldFacts = collectWorldFacts(bot)
    const summary = deriveBaseStatusFromObservation({
      inventoryItems: snapshot.inventorySummary.map(entry => entry.split(' x')[0] || entry),
      nearbyBlocks: snapshot.nearbyBlocks,
      notableBlocks: snapshot.notableBlocks.map(entry => entry.split(' @ ')[0] || entry),
      facts: {
        foodItemCount: worldFacts.foodItemCount,
        torchCount: worldFacts.torchCount,
        nearbyHostileCount: worldFacts.nearbyHostileCount,
      },
      skyAccess: snapshot.skyAccess,
      terrainContext: snapshot.terrainContext,
    })

    return [
      `base_status: score=${summary.baseScore}, enclosure=${summary.enclosureState}, utilities=${summary.utilities.join('|') || 'none'}, missing=${summary.missingBaseFeatures.join('|') || 'none'}`,
      `interior_status: score=${summary.interiorScore}, zones=${summary.functionalZones.join('|') || 'none'}, missing=${summary.missingInteriorFeatures.join('|') || 'none'}, decor=${summary.decorativeElements.join('|') || 'none'}`,
      `base_readiness: home_candidate=${summary.isHomeCandidate}`,
    ]
  }
  catch {
    return []
  }
}

function buildPendingWorldStateSnapshot(bot: Mineflayer): WorldStateSnapshot {
  const position = bot.bot.entity.position
  return {
    dimension: normalizeDimension(bot.bot.game?.dimension),
    biome: 'unknown',
    position: {
      x: position.x,
      y: position.y,
      z: position.z,
    },
    health: bot.bot.health ?? bot.health.value ?? 0,
    food: (bot.bot as any).food ?? 0,
    oxygenLevel: (bot.bot as any).oxygenLevel,
    weather: getWeather(bot),
    timeOfDay: getTimeOfDay(bot),
    skyAccess: 'unknown',
    terrainContext: 'awaiting_world',
    woodAccess: 'unknown',
    surfaceEscapeNeeded: false,
    mobilityState: 'unknown',
    surfaceEscapeScaffold: 'none',
    pickaxeAccess: getToolAccess(bot, 'pickaxe'),
    axeAccess: getToolAccess(bot, 'axe'),
    woodMaterials: getWoodMaterialsSummary(bot),
    heldItem: getHeldItem(bot),
    equippedArmor: getEquippedArmor(bot),
    inventorySummary: getInventorySummary(bot),
    inventoryFacts: [],
    bridgeFacts: [],
    progressionFacts: [],
    baseFacts: [],
    nearbyPlayers: getNearbyPlayerNames(bot).slice(0, 8),
    nearbyEntities: [],
    nearbyBlocks: [],
    notableBlocks: [],
    immediateTerrain: [
      'under:unknown',
      'feet:unknown',
      'head:unknown',
      'north:unknown',
      'south:unknown',
      'east:unknown',
      'west:unknown',
    ],
  }
}

function isDroppedItemEntity(entity: unknown): boolean {
  const candidate = entity as { type?: string, name?: string, objectType?: string | number } | null
  if (!candidate) {
    return false
  }

  return candidate.type === 'object'
    && (candidate.name === 'item' || candidate.objectType === 'item')
}

function getNearbyEntitiesSummary(bot: Mineflayer): string[] {
  const position = bot.bot.entity.position
  return getNearbyEntities(bot, 24)
    .filter(entity => !isDroppedItemEntity(entity))
    .slice(0, 12)
    .map((entity) => {
      const label = entity.type === 'player'
        ? entity.username || entity.name || 'player'
        : entity.name || entity.type || 'entity'
      const dx = entity.position.x - position.x
      const dy = entity.position.y - position.y
      const dz = entity.position.z - position.z
      return `${normalizeName(label)} @ ${formatDistance(dx, dy, dz)}m`
    })
}

function getNearbyBlocksSummary(bot: Mineflayer): string[] {
  const positions = bot.bot.findBlocks?.({
    matching: (block: { name?: string } | null) => {
      const name = normalizeName(block?.name)
      return name !== 'air' && name !== 'cave_air' && name !== 'void_air'
    },
    maxDistance: 16,
    count: 64,
  }) || []

  const names = positions
    .map((position: { x: number, y: number, z: number }) => bot.bot.blockAt(new Vec3(position.x, position.y, position.z)))
    .filter((block): block is NonNullable<typeof block> => Boolean(block?.name))
    .map(block => normalizeName(block.name))

  return [...new Set(names)].slice(0, 24)
}

async function getImmediateTerrain(bot: Mineflayer): Promise<string[]> {
  const position = bot.bot.entity.position
  const baseX = Math.floor(position.x)
  const baseY = Math.floor(position.y)
  const baseZ = Math.floor(position.z)

  const offsets = [
    ['under', { x: baseX, y: baseY - 1, z: baseZ }],
    ['feet', { x: baseX, y: baseY, z: baseZ }],
    ['head', { x: baseX, y: baseY + 1, z: baseZ }],
    ['north', { x: baseX, y: baseY, z: baseZ - 1 }],
    ['south', { x: baseX, y: baseY, z: baseZ + 1 }],
    ['east', { x: baseX + 1, y: baseY, z: baseZ }],
    ['west', { x: baseX - 1, y: baseY, z: baseZ }],
  ] as const

  const entries = await Promise.all(offsets.map(async ([label, pos]) => {
    const block = await getBlockAtAccurate(bot, new Vec3(pos.x, pos.y, pos.z))
    return `${label}:${normalizeName(block?.name || 'unknown')}`
  }))

  return entries
}

async function getBlockNameAt(bot: Mineflayer, x: number, y: number, z: number): Promise<string> {
  return normalizeName((await getBlockAtAccurate(bot, new Vec3(x, y, z)))?.name || 'unknown')
}

async function detectSkyAccess(bot: Mineflayer): Promise<string> {
  const position = bot.bot.entity.position
  const baseX = Math.floor(position.x)
  const baseY = Math.floor(position.y)
  const baseZ = Math.floor(position.z)

  let openBlocks = 0
  let unknownBlocks = 0
  for (let offset = 2; offset <= 18; offset++) {
    const name = await getBlockNameAt(bot, baseX, baseY + offset, baseZ)
    if (!name || name === 'unknown') {
      unknownBlocks++
      break
    }
    if (isAirLike(name)) {
      openBlocks++
      continue
    }
    break
  }

  if (unknownBlocks > 0 && openBlocks < 5) {
    return 'enclosed'
  }
  if (openBlocks >= 12) {
    return 'open_sky'
  }
  if (openBlocks >= 5) {
    return 'partial_cover'
  }
  return 'enclosed'
}

async function getBiomeName(bot: Mineflayer): Promise<string> {
  const world = (bot.bot as any).world
  if (!world || typeof world.getBiome !== 'function') {
    return 'unknown'
  }

  try {
    const rawBiome = await Promise.resolve(world.getBiome(bot.bot.entity.position))
    if (typeof rawBiome === 'string') {
      return normalizeName(rawBiome)
    }
    if (typeof rawBiome === 'number') {
      return normalizeName(getAllBiomes()[rawBiome]?.name)
    }
  }
  catch {
    return 'unknown'
  }

  return 'unknown'
}

function classifyWoodAccess(biome: string, skyAccess: string, nearbyBlocks: string[], notableBlocks: string[]): string {
  const blockNames = [...nearbyBlocks, ...notableBlocks.map(entry => entry.split(' @ ')[0] || entry)]
  if (blockNames.some(name => isWoodLike(normalizeName(name)))) {
    return 'good'
  }

  const normalizedBiome = normalizeName(biome)
  const forestBiomes = ['forest', 'birch', 'taiga', 'jungle', 'cherry', 'grove', 'mangrove']
  const sparseWoodBiomes = ['plains', 'savanna', 'swamp', 'meadow']
  const barrenBiomes = ['desert', 'badlands', 'ocean', 'river', 'beach', 'snowy_plains']

  if (skyAccess === 'enclosed') {
    return 'poor'
  }
  if (forestBiomes.some(keyword => normalizedBiome.includes(keyword))) {
    return 'good'
  }
  if (sparseWoodBiomes.some(keyword => normalizedBiome.includes(keyword))) {
    return 'limited'
  }
  if (barrenBiomes.some(keyword => normalizedBiome.includes(keyword))) {
    return 'poor'
  }

  return skyAccess === 'open_sky' ? 'limited' : 'poor'
}

function classifyTerrainContext(snapshot: {
  dimension: string
  biome: string
  position: { y: number }
  skyAccess: string
  nearbyBlocks: string[]
  notableBlocks: string[]
  immediateTerrain: string[]
}): string {
  if (snapshot.dimension === 'nether') {
    return snapshot.skyAccess === 'enclosed' ? 'nether_enclosed' : 'nether_open'
  }
  if (snapshot.dimension === 'end') {
    return 'end'
  }

  const normalizedBiome = normalizeName(snapshot.biome)
  const immediateEntries = snapshot.immediateTerrain.map((entry) => {
    const [rawLabel, rawName] = entry.split(':', 2)
    return {
      label: rawLabel || 'unknown',
      name: normalizeName(rawName || entry),
    }
  })
  const immediateNames = immediateEntries.map(entry => entry.name)
  const nearbyNames = [
    ...snapshot.nearbyBlocks.map(normalizeName),
    ...snapshot.notableBlocks.map(entry => normalizeName(entry.split(' @ ')[0] || entry)),
    ...immediateNames,
  ]
  const immediateStoneWalls = immediateEntries.filter(({ label, name }) =>
    label !== 'under' && isStoneLike(name),
  ).length
  const undergroundByImmediateTerrain = immediateStoneWalls >= 2
  const undergroundStoneSignals = nearbyNames.filter(name => isStoneLike(name)).length
  const surfaceGroundNearby = nearbyNames.some(name => isSurfaceGroundLike(name))
  const woodNearby = nearbyNames.some(name => isWoodLike(name))
  const surfaceBiomeLikely = [
    'plains',
    'forest',
    'taiga',
    'jungle',
    'grove',
    'cherry',
    'savanna',
    'meadow',
  ].some(keyword => normalizedBiome.includes(keyword))
  const waterLogged = snapshot.immediateTerrain.some((entry) => {
    const normalized = normalizeName(entry.split(':')[1] || entry)
    return normalized === 'water' || normalized === 'kelp' || normalized === 'seagrass'
  })
  const likelySurfaceDespiteUnknownCeiling = snapshot.skyAccess === 'enclosed'
    && snapshot.position.y >= 64
    && !waterLogged
    && immediateStoneWalls <= 1
    && (surfaceGroundNearby || woodNearby || surfaceBiomeLikely)
  const undergroundByNearbyStone = undergroundStoneSignals >= 3
    && !surfaceGroundNearby
    && !woodNearby
  const underground = (snapshot.skyAccess === 'enclosed' || (waterLogged && snapshot.position.y < 60))
    && (snapshot.position.y < 58 || undergroundByImmediateTerrain || undergroundByNearbyStone)

  if (underground && !likelySurfaceDespiteUnknownCeiling) {
    return 'underground_cave'
  }
  if (normalizedBiome.includes('desert') || normalizedBiome.includes('badlands')) {
    return 'surface_desert'
  }
  if (normalizedBiome.includes('forest') || normalizedBiome.includes('taiga') || normalizedBiome.includes('jungle') || normalizedBiome.includes('grove') || normalizedBiome.includes('cherry')) {
    return 'surface_forest'
  }
  if (normalizedBiome.includes('ocean') || normalizedBiome.includes('river') || normalizedBiome.includes('beach') || normalizedBiome.includes('swamp')) {
    return 'surface_water_edge'
  }
  if (normalizedBiome.includes('mountain') || normalizedBiome.includes('peak') || normalizedBiome.includes('slope') || normalizedBiome.includes('windswept') || normalizedBiome.includes('stony')) {
    return 'surface_mountain'
  }
  return 'surface_open_land'
}

export function getNotableBlockObservations(bot: Mineflayer, maxDistance = 32): NotableBlockObservation[] {
  const position = bot.bot.entity.position
  const seen = new Set<string>()
  const observations: NotableBlockObservation[] = []

  for (const blockType of DEFAULT_NOTABLE_BLOCK_TYPES) {
    const block = getNearestBlock(bot, blockType, maxDistance)
    if (!block) {
      continue
    }

    const normalizedName = normalizeName(block.name)
    if (seen.has(normalizedName)) {
      continue
    }

    seen.add(normalizedName)
    const dx = block.position.x - position.x
    const dy = block.position.y - position.y
    const dz = block.position.z - position.z
    observations.push({
      name: normalizedName,
      position: {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
      },
      distance: Number.parseFloat(formatDistance(dx, dy, dz)),
    })
  }

  return observations
}

function getNotableBlocks(bot: Mineflayer): string[] {
  return getNotableBlockObservations(bot).map(observation =>
    `${observation.name} @ ${observation.distance.toFixed(1)}m (${formatPosition(observation.position.x, observation.position.y, observation.position.z)})`)
}

export async function refreshWorldStateCaches(bot: Mineflayer): Promise<void> {
  if (!canQueryWorldState(bot)) {
    return
  }

  const tasks: Array<Promise<unknown>> = []
  const proxiedBot = bot.bot as any

  if (typeof proxiedBot.refreshInventory === 'function') {
    tasks.push(proxiedBot.refreshInventory())
  }
  if (typeof proxiedBot.refreshEntities === 'function') {
    tasks.push(proxiedBot.refreshEntities(24))
  }
  if (typeof proxiedBot.scanNearbyBlocks === 'function') {
    tasks.push(proxiedBot.scanNearbyBlocks(24))
  }

  if (tasks.length === 0) {
    return
  }

  await Promise.allSettled(tasks)
}

export async function buildWorldStateSnapshot(bot: Mineflayer, goal?: string): Promise<WorldStateSnapshot> {
  if (!canQueryWorldState(bot)) {
    return buildPendingWorldStateSnapshot(bot)
  }

  const position = bot.bot.entity.position
  const dimension = normalizeDimension(bot.bot.game?.dimension)
  const biome = await getBiomeName(bot)
  const nearbyBlocks = getNearbyBlocksSummary(bot)
  const notableBlocks = getNotableBlocks(bot)
  const immediateTerrain = await getImmediateTerrain(bot)
  const skyAccess = await detectSkyAccess(bot)
  const terrainContext = classifyTerrainContext({
    dimension,
    biome,
    position: {
      y: position.y,
    },
    skyAccess,
    nearbyBlocks,
    notableBlocks,
    immediateTerrain,
  })
  const woodAccess = classifyWoodAccess(biome, skyAccess, nearbyBlocks, notableBlocks)
  const inventoryCounts = getInventoryCounts(bot)
  const mobilityState = deriveMobilityState(terrainContext, immediateTerrain)
  const pickaxeAccess = getToolAccess(bot, 'pickaxe')
  const axeAccess = getToolAccess(bot, 'axe')
  const inventorySnapshot = getCanonicalInventorySnapshot(bot, 'world-state:snapshot')
  const inventorySummary = getInventorySummary(bot)
  const inventoryFacts = formatCanonicalInventoryFacts(
    inventorySnapshot,
    goal ? deriveTaskContextFromGoal(goal) : undefined,
  )
  const bridgeFacts = getBridgeFacts(bot)
  const progressionFacts = getProgressionFacts(bot)
  const baseFacts = getBaseFacts(bot, {
    inventorySummary,
    nearbyBlocks,
    notableBlocks,
    skyAccess,
    terrainContext,
  })

  return {
    dimension,
    biome,
    position: {
      x: position.x,
      y: position.y,
      z: position.z,
    },
    health: bot.bot.health ?? bot.health.value ?? 0,
    food: (bot.bot as any).food ?? 0,
    oxygenLevel: (bot.bot as any).oxygenLevel,
    weather: getWeather(bot),
    timeOfDay: getTimeOfDay(bot),
    skyAccess,
    terrainContext,
    woodAccess,
    surfaceEscapeNeeded: terrainContext === 'underground_cave',
    mobilityState,
    surfaceEscapeScaffold: describeSurfaceEscapeScaffold(inventoryCounts),
    pickaxeAccess,
    axeAccess,
    woodMaterials: getWoodMaterialsSummary(bot),
    heldItem: getHeldItem(bot),
    equippedArmor: getEquippedArmor(bot),
    inventorySummary,
    inventoryFacts,
    bridgeFacts,
    progressionFacts,
    baseFacts,
    nearbyPlayers: getNearbyPlayerNames(bot).slice(0, 8),
    nearbyEntities: getNearbyEntitiesSummary(bot),
    nearbyBlocks,
    notableBlocks,
    immediateTerrain,
  }
}

export function formatWorldStateSnapshot(snapshot: WorldStateSnapshot): string {
  return [
    `dimension: ${snapshot.dimension}`,
    `biome: ${snapshot.biome}`,
    `position: ${formatPosition(snapshot.position.x, snapshot.position.y, snapshot.position.z)}`,
    `health: ${Math.round(snapshot.health)}/20`,
    `food: ${Math.round(snapshot.food)}/20`,
    snapshot.oxygenLevel !== undefined ? `oxygen: ${Math.round(snapshot.oxygenLevel)}/20` : '',
    `weather: ${snapshot.weather}`,
    `time: ${snapshot.timeOfDay}`,
    `sky_access: ${snapshot.skyAccess}`,
    `terrain_context: ${snapshot.terrainContext}`,
    `wood_access: ${snapshot.woodAccess}`,
    `surface_escape_needed: ${snapshot.surfaceEscapeNeeded}`,
    `mobility_state: ${snapshot.mobilityState}`,
    `surface_escape_scaffold: ${snapshot.surfaceEscapeScaffold}`,
    `pickaxe_access: ${snapshot.pickaxeAccess}`,
    `axe_access: ${snapshot.axeAccess}`,
    `wood_materials: ${snapshot.woodMaterials}`,
    `held_item: ${snapshot.heldItem}`,
    `equipped_armor: ${snapshot.equippedArmor.join(', ') || 'none'}`,
    `inventory: ${snapshot.inventorySummary.join(', ') || 'empty'}`,
    ...snapshot.inventoryFacts,
    ...snapshot.bridgeFacts,
    ...snapshot.progressionFacts,
    ...snapshot.baseFacts,
    `nearby_players: ${snapshot.nearbyPlayers.join(', ') || 'none'}`,
    `nearby_entities: ${snapshot.nearbyEntities.join(', ') || 'none'}`,
    `nearby_blocks: ${snapshot.nearbyBlocks.join(', ') || 'none'}`,
    `notable_blocks: ${snapshot.notableBlocks.join(' | ') || 'none'}`,
    `immediate_terrain: ${snapshot.immediateTerrain.join(', ') || 'unknown'}`,
  ].filter(Boolean).join('\n')
}

export async function generateWorldStatePrompt(bot: Mineflayer, goal?: string): Promise<string> {
  await refreshWorldStateCaches(bot)
  return formatWorldStateSnapshot(await buildWorldStateSnapshot(bot, goal))
}
