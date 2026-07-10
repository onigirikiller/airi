import type { Mineflayer } from '../../libs/mineflayer'

import { sleep } from '@moeru/std'
import { Vec3 } from 'vec3'

import { abortableSleep, ActionAbortedError, raceWithAbort, throwIfAborted } from '../../libs/mineflayer/action-abort'
import { useLogger } from '../../utils/logger'
import { getBlockAtAccurate, getNearestBlocksAccurate } from '../block-access'
import { breakBlockAt } from '../blocks'
import { goToPosition, moveAway, moveToHorizontalTarget } from '../movement'
import { refreshInventoryState } from './inventory'
import { pickupNearbyItems } from './world-interactions'

const logger = useLogger()
const MAX_GATHER_WOOD_ATTEMPTS = 8
const MAX_GATHER_WOOD_NO_PROGRESS_ATTEMPTS = 3
const MAX_LOCAL_WOOD_HORIZONTAL_DISTANCE = 56
const MAX_LOCAL_WOOD_VERTICAL_DISTANCE = 10
const MAX_SURFACE_WOOD_DESCENT = 3
const MIN_WOOD_COLLECTION_SCAN_DISTANCE = 96
const MAX_RECOVERY_WOOD_HORIZONTAL_DISTANCE = 96
const MAX_RECOVERY_WOOD_VERTICAL_DISTANCE = 18
const MAX_UNRESOLVED_ELEVATED_WOOD_ASCENT = 4
const INITIAL_WOOD_OBSERVATION_COUNT = 24
const EXPANDED_WOOD_OBSERVATION_COUNT = 128
const MIN_DISTINCT_WOOD_OBSERVATIONS = 6
const WOOD_OBSERVATION_CLUSTER_RADIUS = 3
const UNRESOLVED_ELEVATED_WOOD_SCORE_PENALTY = 96
const BRIDGE_WOOD_MINING_RECOVERY_TIMEOUT_MS = 75_000
const BRIDGE_WOOD_MINING_INVENTORY_SETTLE_MS = 500
const BRIDGE_WOOD_PROGRESS_POLL_MS = 500
const MANUAL_WOOD_BREAK_SETTLE_MS = 250
const MANUAL_WOOD_PICKUP_SETTLE_MS = 500
const WOOD_TRUNK_BASE_PROBE_DEPTH = 24
const WOOD_TRUNK_BASE_PROBE_RADIUS = 6
const HIGH_ELEVATED_WOOD_TRUNK_BASE_PROBE_DEPTH = 12
const HIGH_ELEVATED_WOOD_TRUNK_BASE_PROBE_BLOCK_LIMIT = 360
const HIGH_ELEVATED_WOOD_LOCAL_PROBE_RADIUS = 2
const WIDE_WOOD_TRUNK_BASE_PROBE_MAX_HORIZONTAL_DISTANCE = 20
const MIN_WOOD_TRUNK_BASE_PROBE_DEPTH = 6
const ELEVATED_WOOD_SUPPORT_DEPTH = 8
const MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_SUPPORT_DEPTH = 2
const MAX_LOW_RAISED_WOOD_HORIZONTAL_APPROACH_ASCENT = 3
const MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_ASCENT = 6
const MAX_ELEVATED_WOOD_NO_SCAFFOLD_HORIZONTAL_APPROACH_DISTANCE = 6
const MAX_ELEVATED_WOOD_SCAFFOLD_BLOCKS = 10
const ELEVATED_WOOD_SUPPORT_APPROACH_DISTANCE = 1
const ELEVATED_WOOD_SCAFFOLD_BREAK_RANGE = 6
const ELEVATED_WOOD_SCAFFOLD_COLLECTION_DISTANCE = 5
const ELEVATED_ONLY_WOOD_CLUSTER_RELOCATION_DISTANCE = 32
const MAX_ELEVATED_ONLY_WOOD_CLUSTER_RELOCATIONS = 2
const ELEVATED_ONLY_WOOD_TARGET_RELOCATION_SCAN_DISTANCE = 160
const MAX_ELEVATED_ONLY_WOOD_TARGET_RELOCATION_CANDIDATES = 16
const FAR_WOOD_CLUSTER_STAGING_DISTANCE = WIDE_WOOD_TRUNK_BASE_PROBE_MAX_HORIZONTAL_DISTANCE - 2
const MIN_FAR_WOOD_CLUSTER_STAGING_ADVANCE = 8
const MIN_SAFE_SURFACE_RELOCATION_Y = 58
const MIN_WOOD_GATHERING_HEALTH = 12
const MIN_WOOD_GATHERING_FOOD = 4
const UNREACHABLE_WOOD_TARGET_MEMORY_TTL_MS = 5 * 60_000
const SCAFFOLD_BLOCK_PRIORITY = [
  'dirt',
  'cobblestone',
  'cobbled_deepslate',
  'stone',
  'deepslate',
  'sand',
  'gravel',
  'netherrack',
]
const REPLACEABLE_SURFACE_BLOCKS = [
  'air',
  'cave_air',
  'void_air',
  'short_grass',
  'grass',
  'tall_grass',
  'fern',
  'large_fern',
  'dead_bush',
  'snow',
]

type WoodColumnApproachMode = 'search' | 'collect'
type TerrainSupportApproachResult = 'unreached' | 'support-reached' | 'break-range'
interface RememberedUnreachableWoodTarget {
  expiresAt: number
  reason: string
}
interface WoodGatheringSurvivalStatus {
  reason: 'low_health' | 'low_food' | 'unsafe_footing' | 'confined_position' | 'unsafe_descent'
  health: number
  food: number
  supportBlock?: string
  surroundingBlocks?: string[]
  position?: { x: number, y: number, z: number }
  startY?: number
}

const rememberedUnreachableWoodTargets = new WeakMap<Mineflayer, Map<string, RememberedUnreachableWoodTarget>>()
const woodGatheringSurfaceStartY = new WeakMap<Mineflayer, number>()

function stripNamespace(name: string): string {
  return name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name
}

function isWoodLikeBlockName(name: string): boolean {
  const normalized = stripNamespace(name)
  return normalized.includes('log')
    || normalized.includes('_wood')
    || normalized.includes('_stem')
    || normalized.includes('hyphae')
}

export function isWoodLikeBlockQuery(name: string): boolean {
  const normalized = stripNamespace(name.trim().toLowerCase())
  return normalized === 'log'
    || isWoodLikeBlockName(normalized)
}

function matchesRequestedWoodType(itemName: string, requestedWoodType: string): boolean {
  const normalizedName = stripNamespace(itemName)
  const normalizedTarget = stripNamespace(requestedWoodType.trim().toLowerCase())

  if (normalizedTarget === 'log') {
    return isWoodLikeBlockName(normalizedName)
  }

  return normalizedName === normalizedTarget
}

function describeWoodTarget(requestedWoodType: string): string {
  const normalizedTarget = stripNamespace(requestedWoodType.trim().toLowerCase())
  return normalizedTarget === 'log' ? 'logs' : normalizedTarget
}

function positionKey(position: { x: number, y: number, z: number }): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function getRememberedUnreachableWoodTargets(mineflayer: Mineflayer): Map<string, RememberedUnreachableWoodTarget> {
  let targets = rememberedUnreachableWoodTargets.get(mineflayer)
  if (!targets) {
    targets = new Map()
    rememberedUnreachableWoodTargets.set(mineflayer, targets)
  }

  const now = Date.now()
  for (const [key, target] of targets) {
    if (target.expiresAt <= now) {
      targets.delete(key)
    }
  }

  return targets
}

function rememberUnreachableWoodTarget(
  mineflayer: Mineflayer,
  treeBaseKey: string,
  reason: string,
): void {
  getRememberedUnreachableWoodTargets(mineflayer).set(treeBaseKey, {
    expiresAt: Date.now() + UNREACHABLE_WOOD_TARGET_MEMORY_TTL_MS,
    reason,
  })
}

function forgetUnreachableWoodTarget(
  mineflayer: Mineflayer,
  treeBaseKey: string,
): void {
  rememberedUnreachableWoodTargets.get(mineflayer)?.delete(treeBaseKey)
}

function shouldSkipRememberedUnreachableWoodTarget(
  mineflayer: Mineflayer,
  treeBaseKey: string,
  currentPosition: { x: number, y: number, z: number },
  treeBase: { x: number, y: number, z: number },
  treeColumnLogs: Array<{ x: number, y: number, z: number }>,
): boolean {
  const rememberedTarget = getRememberedUnreachableWoodTargets(mineflayer).get(treeBaseKey)
  if (!rememberedTarget) {
    return false
  }

  if (!isUnresolvedElevatedWoodColumn(currentPosition, treeBase, treeColumnLogs)) {
    forgetUnreachableWoodTarget(mineflayer, treeBaseKey)
    return false
  }

  logger.withFields({
    treeBase,
    currentY: currentPosition.y,
    rememberedReason: rememberedTarget.reason,
  }).log('Skipping remembered unreachable elevated wood candidate.')
  return true
}

function scoreWoodCandidate(
  current: { x: number, y: number, z: number },
  target: { x: number, y: number, z: number },
): number {
  const dx = target.x - current.x
  const dz = target.z - current.z
  const horizontalDistance = Math.sqrt((dx ** 2) + (dz ** 2))
  const verticalDistance = Math.abs(target.y - current.y)
  const unresolvedElevatedPenalty = target.y > current.y + MAX_UNRESOLVED_ELEVATED_WOOD_ASCENT
    ? UNRESOLVED_ELEVATED_WOOD_SCORE_PENALTY
    : 0

  // NOTICE: Height differences are a stronger predictor of reachability than flat distance
  // for surface wood gathering. Favor trees that are closer to the bot's current elevation
  // so we stop wasting attempts on cliff-top or ravine-edge logs first.
  return (verticalDistance * 4) + horizontalDistance + unresolvedElevatedPenalty
}

function getHorizontalDistance(
  current: { x: number, y: number, z: number },
  target: { x: number, y: number, z: number },
): number {
  const dx = target.x - current.x
  const dz = target.z - current.z
  return Math.sqrt((dx ** 2) + (dz ** 2))
}

function getFiniteBotMetric(value: unknown, fallback: number): number {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : fallback
}

function getCurrentSupportBlockName(mineflayer: Mineflayer): string | null {
  const bot = mineflayer.bot as Mineflayer['bot'] & {
    blockAt?: (position: Vec3) => { name?: string } | null
  }
  if (typeof bot.blockAt !== 'function' || !bot.entity?.position) {
    return null
  }

  const position = bot.entity.position
  try {
    const supportBlock = bot.blockAt(new Vec3(
      Math.floor(position.x),
      Math.floor(position.y) - 1,
      Math.floor(position.z),
    ))
    return typeof supportBlock?.name === 'string' ? supportBlock.name : null
  }
  catch {
    return null
  }
}

function isUnsafeWoodGatheringSupportBlockName(name: string): boolean {
  return [
    'air',
    'cave_air',
    'void_air',
    'water',
    'lava',
    'powder_snow',
    'fire',
    'soul_fire',
  ].includes(stripNamespace(name))
}

function isOpenAirLikeBlockName(name: string): boolean {
  const normalized = stripNamespace(name)
  return normalized === 'water' || REPLACEABLE_SURFACE_BLOCKS.includes(normalized)
}

function isUnresolvedLocalBlockName(name: string): boolean {
  return stripNamespace(name) === 'unknown'
}

function getWoodGatheringSurroundingBlockNames(mineflayer: Mineflayer): string[] | null {
  const bot = mineflayer.bot as Mineflayer['bot'] & {
    blockAt?: (position: Vec3) => { name?: string } | null
  }
  if (typeof bot.blockAt !== 'function' || !bot.entity?.position) {
    return null
  }

  const position = bot.entity.position
  const base = new Vec3(
    Math.floor(position.x),
    Math.floor(position.y),
    Math.floor(position.z),
  )
  const probes = [
    base,
    base.offset(0, 1, 0),
    base.offset(1, 0, 0),
    base.offset(-1, 0, 0),
    base.offset(0, 0, 1),
    base.offset(0, 0, -1),
  ]

  try {
    return probes.map(probe => stripNamespace(bot.blockAt!(probe)?.name ?? 'unknown'))
  }
  catch {
    return null
  }
}

function isConfinedWoodGatheringPosition(surroundingBlocks: string[]): boolean {
  if (surroundingBlocks.length < 6) {
    return false
  }

  const [feetBlock, headBlock, ...sideBlocks] = surroundingBlocks
  if (isUnresolvedLocalBlockName(feetBlock) || isUnresolvedLocalBlockName(headBlock)) {
    return false
  }

  if ((!isOpenAirLikeBlockName(feetBlock) && feetBlock !== 'water')
    || (!isOpenAirLikeBlockName(headBlock) && headBlock !== 'water')) {
    return true
  }

  const resolvedSideBlocks = sideBlocks.filter(name => !isUnresolvedLocalBlockName(name))
  if (resolvedSideBlocks.length < 4) {
    return false
  }

  const blockedSideBlocks = resolvedSideBlocks.filter(name => !isOpenAirLikeBlockName(name) && name !== 'water')
  if (blockedSideBlocks.length < 4) {
    return false
  }

  return blockedSideBlocks.every(name => [
    'stone',
    'cobblestone',
    'cobbled_deepslate',
    'deepslate',
    'tuff',
    'granite',
    'diorite',
    'andesite',
    'netherrack',
    'basalt',
    'blackstone',
  ].includes(stripNamespace(name)))
}

function getWoodGatheringSurvivalStatus(mineflayer: Mineflayer): WoodGatheringSurvivalStatus | null {
  const bot = mineflayer.bot as Mineflayer['bot'] & { food?: number, health?: number }
  const health = getFiniteBotMetric(bot.health, 20)
  const food = getFiniteBotMetric(bot.food, 20)
  const currentPosition = bot.entity?.position
    ? {
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z,
      }
    : undefined

  if (health <= MIN_WOOD_GATHERING_HEALTH) {
    return { reason: 'low_health', health, food, position: currentPosition }
  }

  const startY = woodGatheringSurfaceStartY.get(mineflayer)
  if (
    currentPosition
    && startY != null
    && startY >= 60
    && currentPosition.y < startY - MAX_SURFACE_WOOD_DESCENT
  ) {
    return { reason: 'unsafe_descent', health, food, position: currentPosition, startY }
  }

  if (food <= MIN_WOOD_GATHERING_FOOD) {
    return { reason: 'low_food', health, food, position: currentPosition }
  }

  const supportBlock = getCurrentSupportBlockName(mineflayer)
  if (supportBlock && isUnsafeWoodGatheringSupportBlockName(supportBlock)) {
    return {
      reason: 'unsafe_footing',
      health,
      food,
      supportBlock,
      position: currentPosition,
    }
  }

  const surroundingBlocks = getWoodGatheringSurroundingBlockNames(mineflayer)
  if (surroundingBlocks && isConfinedWoodGatheringPosition(surroundingBlocks)) {
    return {
      reason: 'confined_position',
      health,
      food,
      supportBlock: supportBlock ?? undefined,
      surroundingBlocks,
      position: currentPosition,
    }
  }

  return null
}

function stopWoodGatheringMovement(mineflayer: Mineflayer): void {
  try {
    ;(mineflayer.bot as any).pathfinder?.stop?.()
  }
  catch {
    // best-effort safety interrupt
  }

  try {
    ;(mineflayer.bot as any).clearControlStates?.()
  }
  catch {
    // best-effort safety interrupt
  }
}

function shouldReturnControlForWoodGatheringSurvival(
  mineflayer: Mineflayer,
  phase: string,
  requestedWoodType: string,
): boolean {
  const survivalStatus = getWoodGatheringSurvivalStatus(mineflayer)
  if (!survivalStatus) {
    return false
  }

  stopWoodGatheringMovement(mineflayer)
  logger.withFields({
    phase,
    requestedWoodType,
    reason: survivalStatus.reason,
    health: survivalStatus.health,
    food: survivalStatus.food,
    supportBlock: survivalStatus.supportBlock || '',
    surroundingBlocks: survivalStatus.surroundingBlocks ?? [],
    position: survivalStatus.position,
    startY: survivalStatus.startY,
  }).warn('Wood gathering is returning control because survival conditions are unsafe.')
  return true
}

function installWoodGatheringSurvivalInterrupt(
  mineflayer: Mineflayer,
  requestedWoodType: string,
): () => void {
  const bot = mineflayer.bot as Mineflayer['bot'] & {
    on?: (event: string, listener: () => void) => void
    off?: (event: string, listener: () => void) => void
    removeListener?: (event: string, listener: () => void) => void
  }
  if (typeof bot.on !== 'function') {
    return () => {}
  }

  let interrupted = false
  const interruptIfUnsafe = () => {
    if (interrupted) {
      return
    }
    if (!shouldReturnControlForWoodGatheringSurvival(mineflayer, 'health-event', requestedWoodType)) {
      return
    }
    interrupted = true
  }

  bot.on('health', interruptIfUnsafe)
  return () => {
    if (typeof bot.off === 'function') {
      bot.off('health', interruptIfUnsafe)
      return
    }
    bot.removeListener?.('health', interruptIfUnsafe)
  }
}

function getWoodClusterStagingPosition(
  current: { x: number, z: number },
  target: { x: number, z: number },
): { x: number, z: number } | null {
  const dx = target.x - current.x
  const dz = target.z - current.z
  const horizontalDistance = Math.sqrt((dx ** 2) + (dz ** 2))
  if (horizontalDistance <= FAR_WOOD_CLUSTER_STAGING_DISTANCE) {
    return null
  }

  const advanceDistance = horizontalDistance - FAR_WOOD_CLUSTER_STAGING_DISTANCE
  if (advanceDistance < MIN_FAR_WOOD_CLUSTER_STAGING_ADVANCE) {
    return null
  }

  const advanceRatio = advanceDistance / horizontalDistance
  return {
    x: Math.floor(current.x + (dx * advanceRatio)),
    z: Math.floor(current.z + (dz * advanceRatio)),
  }
}

function isPromisingWoodCandidate(
  current: { x: number, y: number, z: number },
  target: { x: number, y: number, z: number },
): boolean {
  const horizontalDistance = getHorizontalDistance(current, target)
  const verticalDistance = Math.abs(target.y - current.y)

  return horizontalDistance <= MAX_LOCAL_WOOD_HORIZONTAL_DISTANCE
    && verticalDistance <= MAX_LOCAL_WOOD_VERTICAL_DISTANCE
    && isSurfaceWoodCandidate(current, target)
}

function isSurfaceWoodCandidate(
  current: { y: number },
  target: { y: number },
): boolean {
  return target.y >= current.y - MAX_SURFACE_WOOD_DESCENT
}

function getDistance(
  current: { x: number, y: number, z: number },
  target: { x: number, y: number, z: number },
): number {
  const dx = target.x - current.x
  const dy = target.y - current.y
  const dz = target.z - current.z
  return Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2))
}

function isTreeColumnAlreadyInBreakRange(
  current: { x: number, y: number, z: number },
  logs: Array<{ x: number, y: number, z: number }>,
): boolean {
  return logs.some((log) => {
    if (getDistance(current, log) <= 4.5) {
      return true
    }

    return log.y >= current.y
      && log.y - current.y <= ELEVATED_WOOD_SCAFFOLD_BREAK_RANGE
      && getHorizontalDistance(current, log) <= 3
  })
}

function isUnresolvedElevatedWoodColumn(
  current: { x: number, y: number, z: number },
  treeBase: { x: number, y: number, z: number },
  treeColumnLogs: Array<{ x: number, y: number, z: number }>,
): boolean {
  const lowestLog = treeColumnLogs[0] ?? treeBase
  return lowestLog.y > current.y + MAX_UNRESOLVED_ELEVATED_WOOD_ASCENT
}

function isElevatedWoodWithinHorizontalApproachAscent(
  current: { y: number },
  lowestLog: { y: number },
): boolean {
  return lowestLog.y - current.y <= MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_ASCENT
}

function isTerrainSupportBlockName(name: string): boolean {
  const normalized = stripNamespace(name)
  return normalized !== 'air'
    && !normalized.includes('leaves')
    && normalized !== 'water'
    && normalized !== 'lava'
    && !isWoodLikeBlockName(normalized)
}

function isScaffoldReplaceableBlockName(name: string): boolean {
  return REPLACEABLE_SURFACE_BLOCKS.includes(stripNamespace(name))
}

function isScaffoldBlockName(name: string): boolean {
  return SCAFFOLD_BLOCK_PRIORITY.includes(stripNamespace(name))
}

async function canRelocateFromElevatedOnlyWoodCluster(mineflayer: Mineflayer): Promise<boolean> {
  const current = mineflayer.bot.entity?.position
  if (!current || current.y < MIN_SAFE_SURFACE_RELOCATION_Y) {
    return false
  }

  const x = Math.floor(current.x)
  const y = Math.floor(current.y)
  const z = Math.floor(current.z)
  const below = await getBlockAtAccurate(mineflayer, { x, y: y - 1, z })
  if (!below || !isTerrainSupportBlockName(below.name)) {
    return false
  }

  const feet = await getBlockAtAccurate(mineflayer, { x, y, z })
  if (feet && !isScaffoldReplaceableBlockName(feet.name)) {
    return false
  }

  const head = await getBlockAtAccurate(mineflayer, { x, y: y + 1, z })
  return !head || isScaffoldReplaceableBlockName(head.name)
}

function getScaffoldBlockItem(mineflayer: Mineflayer): { name: string, count: number } | null {
  const inventoryItems = mineflayer.bot.inventory?.items?.() ?? []
  for (const scaffoldName of SCAFFOLD_BLOCK_PRIORITY) {
    const item = inventoryItems.find(candidate =>
      isScaffoldBlockName(candidate.name) && stripNamespace(candidate.name) === scaffoldName && candidate.count > 0)
    if (item) {
      return item
    }
  }

  return null
}

function isCurrentSupportBlock(
  currentPosition: { x: number, y: number, z: number },
  blockPosition: { x: number, y: number, z: number },
): boolean {
  return Math.floor(currentPosition.x) === Math.floor(blockPosition.x)
    && Math.floor(currentPosition.z) === Math.floor(blockPosition.z)
    && Math.floor(currentPosition.y) - 1 === Math.floor(blockPosition.y)
}

async function getScaffoldBlockItemAfterPickup(
  mineflayer: Mineflayer,
): Promise<{ name: string, count: number } | null> {
  const existingScaffoldItem = getScaffoldBlockItem(mineflayer)
  if (existingScaffoldItem) {
    return existingScaffoldItem
  }

  await pickupNearbyItems(mineflayer)
  await sleep(MANUAL_WOOD_PICKUP_SETTLE_MS)
  await refreshInventoryState(mineflayer)

  const recoveredScaffoldItem = getScaffoldBlockItem(mineflayer)
  if (recoveredScaffoldItem) {
    logger.withFields({
      scaffoldBlock: recoveredScaffoldItem.name,
      count: recoveredScaffoldItem.count,
    }).log('Recovered nearby scaffold block items before elevated wood recovery.')
  }
  return recoveredScaffoldItem
}

async function collectNearbyScaffoldBlocksForElevatedWood(
  mineflayer: Mineflayer,
  requiredCount: number,
): Promise<{ name: string, count: number } | null> {
  let scaffoldItem = getScaffoldBlockItem(mineflayer)
  if (scaffoldItem && scaffoldItem.count >= requiredCount) {
    return scaffoldItem
  }

  const currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  const candidateBlockResult = await getNearestBlocksAccurate(
    mineflayer,
    SCAFFOLD_BLOCK_PRIORITY,
    ELEVATED_WOOD_SCAFFOLD_COLLECTION_DISTANCE,
    24,
  )
  const candidateBlocks = Array.isArray(candidateBlockResult) ? candidateBlockResult : []
  const candidates = candidateBlocks
    .filter(block =>
      isScaffoldBlockName(block.name)
      && !isCurrentSupportBlock(currentPosition, block.position)
      && Math.abs(block.position.y - currentPosition.y) <= 1)
    .sort((left, right) =>
      getDistance(currentPosition, left.position) - getDistance(currentPosition, right.position))

  for (const block of candidates) {
    scaffoldItem = getScaffoldBlockItem(mineflayer)
    if (scaffoldItem && scaffoldItem.count >= requiredCount) {
      return scaffoldItem
    }

    try {
      await breakBlockAt(mineflayer, block.position.x, block.position.y, block.position.z)
      await sleep(MANUAL_WOOD_BREAK_SETTLE_MS)
      await pickupNearbyItems(mineflayer)
      await sleep(MANUAL_WOOD_PICKUP_SETTLE_MS)
      await refreshInventoryState(mineflayer)
    }
    catch (error) {
      logger.withFields({
        blockName: block.name,
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
        error: error instanceof Error ? error.message : String(error),
      }).warn('Failed to collect nearby scaffold block for elevated wood recovery.')
    }
  }

  scaffoldItem = getScaffoldBlockItem(mineflayer)
  if (scaffoldItem && scaffoldItem.count > 0) {
    logger.withFields({
      scaffoldBlock: scaffoldItem.name,
      count: scaffoldItem.count,
      requiredCount,
    }).log('Collected nearby scaffold blocks for elevated wood recovery.')
  }
  return scaffoldItem
}

async function placeScaffoldBlockUnderFeet(
  mineflayer: Mineflayer,
  blockName: string,
): Promise<boolean> {
  const bot = mineflayer.bot as Mineflayer['bot'] & {
    equip?: (item: unknown, destination: string) => Promise<void>
    lookAt?: (position: Vec3, force?: boolean) => Promise<void>
    placeBlock?: (referenceBlock: unknown, faceVector: Vec3) => Promise<void>
    setControlState?: (control: string, state: boolean) => void
  }
  if (
    typeof bot.equip !== 'function'
    || typeof bot.lookAt !== 'function'
    || typeof bot.placeBlock !== 'function'
    || typeof bot.setControlState !== 'function'
  ) {
    return false
  }

  const scaffoldItem = mineflayer.bot.inventory.items().find(item => stripNamespace(item.name) === blockName && item.count > 0)
  if (!scaffoldItem) {
    return false
  }

  const startPosition = mineflayer.bot.entity.position
  const startY = startPosition.y

  try {
    await bot.equip(scaffoldItem, 'hand')
    bot.setControlState('jump', true)
    await sleep(430)

    const jumpPosition = mineflayer.bot.entity.position
    const targetPosition = new Vec3(
      Math.floor(jumpPosition.x),
      Math.max(Math.floor(startY), Math.floor(jumpPosition.y) - 1),
      Math.floor(jumpPosition.z),
    )
    const targetBlock = await getBlockAtAccurate(mineflayer, targetPosition)
    if (targetBlock && !isScaffoldReplaceableBlockName(targetBlock.name)) {
      logger.withFields({
        blockName,
        targetPosition,
        targetBlock: targetBlock.name,
      }).warn('Aborting scaffold placement because the underfoot target is occupied.')
      return false
    }

    const referenceBlock = await getBlockAtAccurate(mineflayer, targetPosition.offset(0, -1, 0))
    if (!referenceBlock || !isTerrainSupportBlockName(referenceBlock.name)) {
      return false
    }

    await bot.lookAt(referenceBlock.position, true)
    await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0))
    await sleep(900)

    const endY = mineflayer.bot.entity.position.y
    if (endY < startY + 0.65) {
      logger.withFields({
        blockName,
        startY,
        endY,
        x: targetPosition.x,
        y: targetPosition.y,
        z: targetPosition.z,
      }).warn('Scaffold placement did not raise the bot enough to continue elevated wood recovery.')
      return false
    }

    logger.withFields({
      blockName,
      startY,
      endY,
      x: targetPosition.x,
      y: targetPosition.y,
      z: targetPosition.z,
    }).log('Placed scaffold block underfoot while approaching elevated wood.')
    return true
  }
  catch (error) {
    logger.withFields({
      blockName,
      error: error instanceof Error ? error.message : String(error),
    }).warn('Failed to place scaffold block underfoot for elevated wood recovery.')
    return false
  }
  finally {
    bot.setControlState('jump', false)
  }
}

async function tryScaffoldIntoElevatedWoodRange(
  mineflayer: Mineflayer,
  treeBase: { x: number, y: number, z: number },
  treeColumnLogs: Array<{ x: number, y: number, z: number }>,
): Promise<boolean> {
  if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'before-scaffold-recovery', 'log')) {
    return false
  }

  const lowestLog = treeColumnLogs[0] ?? treeBase
  let currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  if (isTreeColumnAlreadyInBreakRange(currentPosition, treeColumnLogs)) {
    return true
  }

  const initialVerticalGap = lowestLog.y - currentPosition.y
  if (initialVerticalGap <= 0 || initialVerticalGap > MAX_ELEVATED_WOOD_SCAFFOLD_BLOCKS + ELEVATED_WOOD_SCAFFOLD_BREAK_RANGE) {
    return false
  }

  const initialHorizontalDistance = getHorizontalDistance(currentPosition, treeBase)
  if (initialHorizontalDistance > WIDE_WOOD_TRUNK_BASE_PROBE_MAX_HORIZONTAL_DISTANCE) {
    return false
  }

  const initialRequiredScaffoldBlocks = Math.max(
    0,
    Math.ceil(initialVerticalGap - ELEVATED_WOOD_SCAFFOLD_BREAK_RANGE),
  )
  if (initialRequiredScaffoldBlocks <= 0) {
    if (initialHorizontalDistance > MAX_ELEVATED_WOOD_NO_SCAFFOLD_HORIZONTAL_APPROACH_DISTANCE) {
      return false
    }

    if (initialHorizontalDistance > 2.5) {
      const reachedColumn = await moveToHorizontalTarget(mineflayer, treeBase.x, treeBase.z)
      if (!reachedColumn) {
        return false
      }
      currentPosition = mineflayer.bot.entity?.position ?? currentPosition
    }

    return isTreeColumnAlreadyInBreakRange(currentPosition, treeColumnLogs)
  }

  let scaffoldItem = getScaffoldBlockItem(mineflayer)
  if ((!scaffoldItem || scaffoldItem.count < initialRequiredScaffoldBlocks) && initialHorizontalDistance <= 3) {
    scaffoldItem = await getScaffoldBlockItemAfterPickup(mineflayer)
  }
  if (!scaffoldItem || scaffoldItem.count < initialRequiredScaffoldBlocks) {
    scaffoldItem = await collectNearbyScaffoldBlocksForElevatedWood(
      mineflayer,
      initialRequiredScaffoldBlocks,
    )
  }
  if (!scaffoldItem || scaffoldItem.count < initialRequiredScaffoldBlocks) {
    return false
  }

  if (initialHorizontalDistance > 2.5) {
    const reachedColumn = await moveToHorizontalTarget(mineflayer, treeBase.x, treeBase.z)
    if (!reachedColumn) {
      return false
    }
    currentPosition = mineflayer.bot.entity?.position ?? currentPosition
  }

  if (getHorizontalDistance(currentPosition, treeBase) > 3) {
    return false
  }

  const requiredScaffoldBlocks = Math.max(
    0,
    Math.ceil((lowestLog.y - currentPosition.y) - ELEVATED_WOOD_SCAFFOLD_BREAK_RANGE),
  )
  if (
    requiredScaffoldBlocks <= 0
    || requiredScaffoldBlocks > MAX_ELEVATED_WOOD_SCAFFOLD_BLOCKS
    || scaffoldItem.count < requiredScaffoldBlocks
  ) {
    return false
  }

  logger.withFields({
    treeBase,
    lowestLog,
    currentY: currentPosition.y,
    scaffoldBlock: scaffoldItem.name,
    requiredScaffoldBlocks,
  }).log('Attempting scaffold recovery for elevated wood candidate.')

  for (let placed = 0; placed < requiredScaffoldBlocks; placed++) {
    if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'during-scaffold-recovery', 'log')) {
      return false
    }

    const placedBlock = await placeScaffoldBlockUnderFeet(mineflayer, scaffoldItem.name)
    if (!placedBlock) {
      return false
    }

    currentPosition = mineflayer.bot.entity?.position ?? currentPosition
    if (isTreeColumnAlreadyInBreakRange(currentPosition, treeColumnLogs)) {
      logger.withFields({
        treeBase,
        lowestLog,
        currentY: currentPosition.y,
        placed: placed + 1,
      }).log('Scaffold recovery reached elevated wood break range.')
      return true
    }
  }

  return isTreeColumnAlreadyInBreakRange(
    mineflayer.bot.entity?.position ?? currentPosition,
    treeColumnLogs,
  )
}

async function getTerrainSupportDepthBelowElevatedWood(
  mineflayer: Mineflayer,
  lowestLog: { x: number, y: number, z: number },
): Promise<number | null> {
  for (let depth = 1; depth <= ELEVATED_WOOD_SUPPORT_DEPTH; depth++) {
    const below = await getBlockAtAccurate(mineflayer, {
      x: lowestLog.x,
      y: lowestLog.y - depth,
      z: lowestLog.z,
    })
    if (!below) {
      continue
    }
    if (isTerrainSupportBlockName(below.name)) {
      return depth
    }
  }

  return null
}

async function hasConnectedWoodBelowObservation(
  mineflayer: Mineflayer,
  woodPosition: { x: number, y: number, z: number },
  currentPosition: { y: number },
): Promise<boolean> {
  const x = Math.floor(woodPosition.x)
  const z = Math.floor(woodPosition.z)
  const minProbeY = Math.max(
    Math.floor(currentPosition.y) - MAX_SURFACE_WOOD_DESCENT,
    Math.floor(woodPosition.y) - WOOD_TRUNK_BASE_PROBE_DEPTH,
  )

  for (let y = Math.floor(woodPosition.y) - 1; y >= minProbeY; y--) {
    const block = await getBlockAtAccurate(mineflayer, { x, y, z })
    if (!block) {
      continue
    }

    if (isWoodLikeBlockName(block.name)) {
      return true
    }
  }

  return false
}

async function shouldSkipDeepSupportedRaisedObservationBeforeTrunkProbe(
  mineflayer: Mineflayer,
  woodBlock: { position: { x: number, y: number, z: number } },
  currentPosition: { x: number, y: number, z: number },
  phase: 'collection' | 'search',
): Promise<boolean> {
  if (woodBlock.position.y <= currentPosition.y + MAX_LOW_RAISED_WOOD_HORIZONTAL_APPROACH_ASCENT) {
    return false
  }

  const horizontalDistance = getHorizontalDistance(currentPosition, woodBlock.position)
  if (horizontalDistance <= WIDE_WOOD_TRUNK_BASE_PROBE_MAX_HORIZONTAL_DISTANCE) {
    return false
  }

  if (await hasConnectedWoodBelowObservation(mineflayer, woodBlock.position, currentPosition)) {
    logger.withFields({
      woodBlock: woodBlock.position,
      currentY: currentPosition.y,
      phase,
    }).log('Keeping raised wood observation for trunk probing because connected wood continues downward.')
    return false
  }

  const terrainSupportDepth = await getTerrainSupportDepthBelowElevatedWood(mineflayer, woodBlock.position)
  if (terrainSupportDepth == null || terrainSupportDepth <= MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_SUPPORT_DEPTH) {
    return false
  }

  logger.withFields({
    woodBlock: woodBlock.position,
    currentY: currentPosition.y,
    terrainSupportDepth,
    phase,
  }).log('Skipping deep terrain-supported raised wood observation before trunk probing.')
  return true
}

async function tryApproachTerrainSupportForElevatedWood(
  mineflayer: Mineflayer,
  treeBase: { x: number, y: number, z: number },
  lowestLog: { x: number, y: number, z: number },
  treeColumnLogs: Array<{ x: number, y: number, z: number }>,
  terrainSupportDepth: number,
): Promise<TerrainSupportApproachResult> {
  const currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  const supportBlockY = lowestLog.y - terrainSupportDepth
  if (currentPosition.y >= supportBlockY + 0.5) {
    return 'unreached'
  }

  logger.withFields({
    treeBase,
    lowestLog,
    supportBlockY,
    currentY: currentPosition.y,
    terrainSupportDepth,
  }).log('Attempting to climb to terrain support beneath elevated wood.')

  const reachedSupport = await goToPosition(
    mineflayer,
    treeBase.x,
    supportBlockY + 1,
    treeBase.z,
    ELEVATED_WOOD_SUPPORT_APPROACH_DISTANCE,
  )
  const updatedPosition = mineflayer.bot.entity?.position ?? currentPosition
  const reachedSupportElevation = updatedPosition.y >= supportBlockY + 0.5
  if (!reachedSupport || !reachedSupportElevation) {
    logger.withFields({
      treeBase,
      lowestLog,
      supportBlockY,
      startY: currentPosition.y,
      endY: updatedPosition.y,
      reachedSupport,
      terrainSupportDepth,
    }).warn('Failed to climb onto terrain support beneath elevated wood.')
    return 'unreached'
  }

  if (isTreeColumnAlreadyInBreakRange(updatedPosition, treeColumnLogs)) {
    logger.withFields({
      treeBase,
      lowestLog,
      supportBlockY,
      currentY: updatedPosition.y,
      terrainSupportDepth,
    }).log('Terrain support climb reached elevated wood break range.')
    return 'break-range'
  }

  logger.withFields({
    treeBase,
    lowestLog,
    supportBlockY,
    currentY: updatedPosition.y,
    terrainSupportDepth,
  }).log('Climbed onto terrain support beneath elevated wood; additional scaffold may still be needed.')
  return 'support-reached'
}

function clusterWoodObservations(
  current: { x: number, y: number, z: number },
  observations: Array<{ name: string, position: { x: number, y: number, z: number } }>,
): Array<{ name: string, position: { x: number, y: number, z: number }, clusterSize: number }> {
  const sortedObservations = [...observations]
    .sort((left, right) =>
      scoreWoodCandidate(current, left.position) - scoreWoodCandidate(current, right.position)
      || left.position.y - right.position.y)
  const clusters: Array<Array<{ name: string, position: { x: number, y: number, z: number } }>> = []

  // NOTICE: Coastal forests can return dozens of nearby canopy hits from the same tree while
  // hiding lower trunk candidates just beyond the first query budget. Collapse nearby hits into
  // a single representative so later retries widen the search across distinct trees instead of
  // re-walking the same canopy over and over.
  for (const observation of sortedObservations) {
    const cluster = clusters.find(entries =>
      entries.some(entry =>
        getHorizontalDistance(entry.position, observation.position) <= WOOD_OBSERVATION_CLUSTER_RADIUS))
    if (cluster) {
      cluster.push(observation)
      continue
    }

    clusters.push([observation])
  }

  return clusters
    .map((cluster) => {
      const representative = [...cluster]
        .sort((left, right) =>
          left.position.y - right.position.y
          || scoreWoodCandidate(current, left.position) - scoreWoodCandidate(current, right.position))[0]

      return {
        name: representative?.name ?? cluster[0]!.name,
        position: representative?.position ?? cluster[0]!.position,
        clusterSize: cluster.length,
      }
    })
    .sort((left, right) =>
      scoreWoodCandidate(current, left.position) - scoreWoodCandidate(current, right.position)
      || left.position.y - right.position.y
      || right.clusterSize - left.clusterSize)
}

async function getWoodObservationRepresentatives(
  mineflayer: Mineflayer,
  requestedWoodType: string,
  maxDistance: number,
): Promise<Array<{ name: string, position: { x: number, y: number, z: number }, clusterSize: number }>> {
  const currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  const initialObservationResult = await getNearestBlocksAccurate(
    mineflayer,
    requestedWoodType,
    maxDistance,
    INITIAL_WOOD_OBSERVATION_COUNT,
  )
  const initialObservations = Array.isArray(initialObservationResult) ? initialObservationResult : []
  let representatives = clusterWoodObservations(currentPosition, initialObservations)

  const shouldExpandSparseSingleTreeScan = representatives.length <= 1 && initialObservations.length > 0
  const shouldExpandSparseElevatedScan = initialObservations.length > 0
    && representatives.length > 0
    && representatives.length < MIN_DISTINCT_WOOD_OBSERVATIONS
    && representatives.every(representative =>
      representative.position.y > currentPosition.y + MAX_UNRESOLVED_ELEVATED_WOOD_ASCENT)
  if (
    representatives.length < MIN_DISTINCT_WOOD_OBSERVATIONS
    && (
      initialObservations.length >= INITIAL_WOOD_OBSERVATION_COUNT
      || shouldExpandSparseSingleTreeScan
      || shouldExpandSparseElevatedScan
    )
  ) {
    const expandedObservationResult = await getNearestBlocksAccurate(
      mineflayer,
      requestedWoodType,
      maxDistance,
      EXPANDED_WOOD_OBSERVATION_COUNT,
    )
    const expandedObservations = Array.isArray(expandedObservationResult) ? expandedObservationResult : []
    const expandedRepresentatives = clusterWoodObservations(currentPosition, expandedObservations)

    if (expandedRepresentatives.length > representatives.length) {
      logger.withFields({
        initialObservationCount: initialObservations.length,
        initialDistinctTrees: representatives.length,
        expandedObservationCount: expandedObservations.length,
        expandedDistinctTrees: expandedRepresentatives.length,
        expansionReason: initialObservations.length >= INITIAL_WOOD_OBSERVATION_COUNT
          ? 'budget-saturated'
          : shouldExpandSparseElevatedScan
            ? 'all-elevated-sparse'
            : 'single-sparse-tree',
      }).log('Expanded wood scan to widen distinct tree candidates after canopy-heavy observations.')
      representatives = expandedRepresentatives
    }
  }

  return representatives
}

async function getWoodRecoveryCandidates(
  mineflayer: Mineflayer,
  requestedWoodType: string,
  maxDistance: number,
): Promise<Array<{ name: string, position: { x: number, y: number, z: number }, clusterSize: number }>> {
  const currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  const allNearbyWoodBlocks = await getWoodObservationRepresentatives(mineflayer, requestedWoodType, maxDistance)
  const surfaceWoodBlocks = allNearbyWoodBlocks
    .filter(block => isSurfaceWoodCandidate(currentPosition, block.position))
  const nearbyWoodBlocks = surfaceWoodBlocks
    .filter(block => isPromisingWoodCandidate(currentPosition, block.position))
  const recoveryWoodBlocks = surfaceWoodBlocks.filter((block) => {
    const horizontalDistance = getHorizontalDistance(currentPosition, block.position)
    const verticalDistance = Math.abs(block.position.y - currentPosition.y)
    return horizontalDistance <= MAX_RECOVERY_WOOD_HORIZONTAL_DISTANCE
      && verticalDistance <= MAX_RECOVERY_WOOD_VERTICAL_DISTANCE
  })
  const seenPositions = new Set<string>()
  return [...nearbyWoodBlocks, ...recoveryWoodBlocks]
    .filter((block) => {
      const key = positionKey(block.position)
      if (seenPositions.has(key)) {
        return false
      }
      seenPositions.add(key)
      return true
    })
    .sort((left, right) =>
      scoreWoodCandidate(currentPosition, left.position) - scoreWoodCandidate(currentPosition, right.position)
      || left.position.y - right.position.y
      || right.clusterSize - left.clusterSize)
}

async function findReachableWoodRelocationTarget(
  mineflayer: Mineflayer,
  requestedWoodType: string,
  maxDistance: number,
  avoidedTargets: Set<string>,
): Promise<{
  woodBlock: { name: string, position: { x: number, y: number, z: number }, clusterSize: number }
  treeBase: { x: number, y: number, z: number }
  treeColumnLogs: Array<{ x: number, y: number, z: number }>
} | null> {
  const currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  const relocationCandidates = await getWoodObservationRepresentatives(mineflayer, requestedWoodType, maxDistance)
  let inspectedCandidates = 0

  for (const woodBlock of relocationCandidates) {
    if (inspectedCandidates >= MAX_ELEVATED_ONLY_WOOD_TARGET_RELOCATION_CANDIDATES) {
      break
    }

    const horizontalDistance = getHorizontalDistance(currentPosition, woodBlock.position)
    const verticalDistance = Math.abs(woodBlock.position.y - currentPosition.y)
    if (
      horizontalDistance > maxDistance
      || verticalDistance > MAX_RECOVERY_WOOD_VERTICAL_DISTANCE
      || !isSurfaceWoodCandidate(currentPosition, woodBlock.position)
    ) {
      continue
    }

    if (woodBlock.position.y > currentPosition.y + MAX_LOW_RAISED_WOOD_HORIZONTAL_APPROACH_ASCENT) {
      const shouldProbeNearbyRaisedObservation = horizontalDistance <= WIDE_WOOD_TRUNK_BASE_PROBE_MAX_HORIZONTAL_DISTANCE
        || await hasConnectedWoodBelowObservation(mineflayer, woodBlock.position, currentPosition)
      if (shouldProbeNearbyRaisedObservation) {
        logger.withFields({
          woodBlock: woodBlock.position,
          currentY: currentPosition.y,
          horizontalDistance,
        }).log('Keeping raised raw wood relocation observation for bounded trunk probing.')
      }
      else {
        logger.withFields({
          woodBlock: woodBlock.position,
          currentY: currentPosition.y,
        }).log('Skipping raised raw wood observation as a relocation target before trunk probing.')
        continue
      }
    }

    inspectedCandidates++
    const treeBase = await resolveWoodCandidateBase(mineflayer, woodBlock)
    const treeBaseKey = positionKey(treeBase)
    if (avoidedTargets.has(treeBaseKey) || !isSurfaceWoodCandidate(currentPosition, treeBase)) {
      continue
    }

    const treeColumnLogs = await resolveTreeColumnLogs(mineflayer, treeBase)
    if (treeColumnLogs.length === 0) {
      continue
    }

    if (shouldSkipRememberedUnreachableWoodTarget(
      mineflayer,
      treeBaseKey,
      currentPosition,
      treeBase,
      treeColumnLogs,
    )) {
      continue
    }

    const lowestLog = treeColumnLogs[0] ?? treeBase
    const raisedAscent = lowestLog.y - currentPosition.y
    if (raisedAscent > 0) {
      const terrainSupportDepth = await getTerrainSupportDepthBelowElevatedWood(mineflayer, lowestLog)
      if (
        raisedAscent > MAX_LOW_RAISED_WOOD_HORIZONTAL_APPROACH_ASCENT
        && terrainSupportDepth != null
        && terrainSupportDepth > MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_SUPPORT_DEPTH
      ) {
        logger.withFields({
          treeBase,
          lowestLog,
          currentY: currentPosition.y,
          terrainSupportDepth,
        }).log('Skipping raised wood candidate as a relocation target because exact-height pathing would be unsafe.')
        continue
      }
    }

    if (isUnresolvedElevatedWoodColumn(currentPosition, treeBase, treeColumnLogs)) {
      const terrainSupportDepth = await getTerrainSupportDepthBelowElevatedWood(mineflayer, lowestLog)
      const shallowSupportedElevation = terrainSupportDepth != null
        && terrainSupportDepth <= MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_SUPPORT_DEPTH
        && isElevatedWoodWithinHorizontalApproachAscent(currentPosition, lowestLog)
      if (!shallowSupportedElevation) {
        logger.withFields({
          treeBase,
          lowestLog,
          currentY: currentPosition.y,
          terrainSupportDepth,
        }).log('Skipping elevated wood candidate as a relocation target because it still needs unsafe vertical recovery.')
        continue
      }
    }

    return { woodBlock, treeBase, treeColumnLogs }
  }

  return null
}

async function findWoodClusterStagingTarget(
  mineflayer: Mineflayer,
  requestedWoodType: string,
  maxDistance: number,
): Promise<{
  woodBlock: { name: string, position: { x: number, y: number, z: number }, clusterSize: number }
  stagingPosition: { x: number, z: number }
  horizontalDistance: number
} | null> {
  const currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  const relocationCandidates = await getWoodObservationRepresentatives(mineflayer, requestedWoodType, maxDistance)
  let inspectedCandidates = 0

  for (const woodBlock of relocationCandidates) {
    if (inspectedCandidates >= MAX_ELEVATED_ONLY_WOOD_TARGET_RELOCATION_CANDIDATES) {
      break
    }

    const horizontalDistance = getHorizontalDistance(currentPosition, woodBlock.position)
    const verticalDistance = Math.abs(woodBlock.position.y - currentPosition.y)
    if (
      horizontalDistance <= WIDE_WOOD_TRUNK_BASE_PROBE_MAX_HORIZONTAL_DISTANCE
      || horizontalDistance > maxDistance
      || verticalDistance > MAX_RECOVERY_WOOD_VERTICAL_DISTANCE
      || woodBlock.position.y <= currentPosition.y + MAX_LOW_RAISED_WOOD_HORIZONTAL_APPROACH_ASCENT
      || !isSurfaceWoodCandidate(currentPosition, woodBlock.position)
    ) {
      continue
    }

    inspectedCandidates++
    const stagingPosition = getWoodClusterStagingPosition(currentPosition, woodBlock.position)
    if (!stagingPosition) {
      continue
    }

    return {
      woodBlock,
      stagingPosition,
      horizontalDistance,
    }
  }

  return null
}

async function relocateTowardReachableWoodCandidate(
  mineflayer: Mineflayer,
  requestedWoodType: string,
  maxDistance: number,
  avoidedTargets: Set<string>,
): Promise<boolean> {
  const relocationTarget = await findReachableWoodRelocationTarget(
    mineflayer,
    requestedWoodType,
    maxDistance,
    avoidedTargets,
  )
  if (!relocationTarget) {
    const stagingTarget = await findWoodClusterStagingTarget(
      mineflayer,
      requestedWoodType,
      maxDistance,
    )
    if (!stagingTarget) {
      logger.withFields({
        requestedWoodType,
        maxDistance,
      }).warn('No reachable wood candidate found for targeted elevated-cluster relocation.')
      return false
    }

    const reachedStagingTarget = await moveToHorizontalTarget(
      mineflayer,
      stagingTarget.stagingPosition.x,
      stagingTarget.stagingPosition.z,
    )
    if (!reachedStagingTarget) {
      avoidedTargets.add(positionKey(stagingTarget.woodBlock.position))
      logger.withFields({
        blockName: stagingTarget.woodBlock.name,
        woodBlock: stagingTarget.woodBlock.position,
        stagingPosition: stagingTarget.stagingPosition,
      }).warn('Targeted elevated-cluster staging found a far wood cluster, but pathing could not reach the staging point.')
      return false
    }

    logger.withFields({
      blockName: stagingTarget.woodBlock.name,
      woodBlock: stagingTarget.woodBlock.position,
      stagingPosition: stagingTarget.stagingPosition,
      horizontalDistance: stagingTarget.horizontalDistance,
    }).log('Relocated horizontally toward a far wood cluster for a closer trunk rescan.')
    return true
  }

  const reachedRelocationTarget = await moveIntoWoodColumnRange(
    mineflayer,
    relocationTarget.treeBase,
    relocationTarget.treeColumnLogs,
  )
  if (!reachedRelocationTarget) {
    avoidedTargets.add(positionKey(relocationTarget.treeBase))
    logger.withFields({
      blockName: relocationTarget.woodBlock.name,
      treeBase: relocationTarget.treeBase,
    }).warn('Targeted elevated-cluster relocation found a wood candidate, but pathing could not reach it.')
    return false
  }

  logger.withFields({
    blockName: relocationTarget.woodBlock.name,
    treeBase: relocationTarget.treeBase,
  }).log('Relocated toward a reachable wood candidate after elevated-only scan results.')
  return true
}

async function moveIntoWoodColumnRange(
  mineflayer: Mineflayer,
  treeBase: { x: number, y: number, z: number },
  treeColumnLogs: Array<{ x: number, y: number, z: number }>,
  mode: WoodColumnApproachMode = 'collect',
): Promise<boolean> {
  let currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  if (isTreeColumnAlreadyInBreakRange(currentPosition, treeColumnLogs)) {
    return true
  }

  const lowestLog = treeColumnLogs[0] ?? treeBase
  const elevatedColumn = lowestLog.y > currentPosition.y + 2

  // NOTICE: Surface forest scans can correctly find a mineable log column that is already
  // within arm's reach, or slightly overhead on sloped ground. Requiring an exact `y`
  // navigation goal there causes needless path failures before the dig phase even starts.
  if (elevatedColumn) {
    const elevatedTerrainSupportDepth = await getTerrainSupportDepthBelowElevatedWood(mineflayer, lowestLog)
    if (
      lowestLog.y > currentPosition.y + MAX_LOW_RAISED_WOOD_HORIZONTAL_APPROACH_ASCENT
      && elevatedTerrainSupportDepth != null
      && elevatedTerrainSupportDepth > MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_SUPPORT_DEPTH
    ) {
      if (mode === 'collect') {
        const scaffoldRecovered = await tryScaffoldIntoElevatedWoodRange(
          mineflayer,
          treeBase,
          treeColumnLogs,
        )
        if (scaffoldRecovered) {
          return true
        }
      }

      logger.withFields({
        treeBase,
        lowestLog,
        currentY: currentPosition.y,
        terrainSupportDepth: elevatedTerrainSupportDepth,
      }).log('Skipping deep terrain-supported elevated wood candidate before horizontal approach.')
      return false
    }

    if (isUnresolvedElevatedWoodColumn(currentPosition, treeBase, treeColumnLogs)) {
      const horizontalDistance = getHorizontalDistance(currentPosition, treeBase)
      const terrainSupportDepth = elevatedTerrainSupportDepth
      if (mode === 'search') {
        if (terrainSupportDepth != null) {
          if (!isElevatedWoodWithinHorizontalApproachAscent(currentPosition, lowestLog)) {
            logger.withFields({
              treeBase,
              lowestLog,
              currentY: currentPosition.y,
              terrainSupportDepth,
            }).log('Skipping terrain-supported elevated wood candidate above horizontal approach reach during search.')
            return false
          }

          const reachedColumnHorizontally = await moveToHorizontalTarget(
            mineflayer,
            treeBase.x,
            treeBase.z,
          )
          if (reachedColumnHorizontally) {
            const updatedPosition = mineflayer.bot.entity?.position ?? currentPosition
            if (isTreeColumnAlreadyInBreakRange(updatedPosition, treeColumnLogs)) {
              logger.withFields({
                treeBase,
                lowestLog,
                currentY: updatedPosition.y,
                terrainSupportDepth,
              }).log('Approached terrain-supported elevated wood candidate horizontally for a closer rescan.')
              return true
            }

            logger.withFields({
              treeBase,
              lowestLog,
              currentY: updatedPosition.y,
              terrainSupportDepth,
            }).log('Search reached terrain-supported elevated wood horizontally, but the column remains out of break range.')
            return false
          }
        }

        logger.withFields({
          treeBase,
          lowestLog,
          currentY: currentPosition.y,
        }).log('Skipping unresolved elevated wood candidate during search approach.')
        return false
      }

      if (terrainSupportDepth != null && terrainSupportDepth > MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_SUPPORT_DEPTH) {
        const scaffoldRecovered = await tryScaffoldIntoElevatedWoodRange(
          mineflayer,
          treeBase,
          treeColumnLogs,
        )
        if (scaffoldRecovered) {
          return true
        }

        logger.withFields({
          treeBase,
          lowestLog,
          currentY: currentPosition.y,
          terrainSupportDepth,
        }).log('Skipping deep terrain-supported elevated wood candidate before terrain-support climb.')
        return false
      }

      if (terrainSupportDepth != null) {
        const supportApproach = await tryApproachTerrainSupportForElevatedWood(
          mineflayer,
          treeBase,
          lowestLog,
          treeColumnLogs,
          terrainSupportDepth,
        )
        if (supportApproach === 'break-range') {
          return true
        }
        if (supportApproach === 'support-reached') {
          currentPosition = mineflayer.bot.entity?.position ?? currentPosition
        }
      }

      const scaffoldRecovered = await tryScaffoldIntoElevatedWoodRange(
        mineflayer,
        treeBase,
        treeColumnLogs,
      )
      if (scaffoldRecovered) {
        return true
      }

      if (terrainSupportDepth == null) {
        logger.withFields({
          treeBase,
          lowestLog,
          currentY: currentPosition.y,
        }).log('Skipping unsupported elevated wood candidate before collection approach.')
        return false
      }

      if (terrainSupportDepth > MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_SUPPORT_DEPTH) {
        logger.withFields({
          treeBase,
          lowestLog,
          currentY: currentPosition.y,
          terrainSupportDepth,
        }).log('Skipping deep terrain-supported elevated wood candidate before collection approach.')
        return false
      }

      if (!isElevatedWoodWithinHorizontalApproachAscent(currentPosition, lowestLog)) {
        logger.withFields({
          treeBase,
          lowestLog,
          currentY: currentPosition.y,
          terrainSupportDepth,
        }).log('Skipping terrain-supported elevated wood candidate above horizontal approach reach before collection approach.')
        return false
      }

      if (horizontalDistance > 6) {
        return goToPosition(
          mineflayer,
          treeBase.x,
          treeBase.y,
          treeBase.z,
          2,
        )
      }

      logger.withFields({
        treeBase,
        lowestLog,
        currentY: currentPosition.y,
      }).log('Skipping unresolved elevated wood candidate before horizontal approach.')
      return false
    }

    const reachedColumnHorizontally = await moveToHorizontalTarget(
      mineflayer,
      treeBase.x,
      treeBase.z,
    )
    if (reachedColumnHorizontally) {
      const updatedPosition = mineflayer.bot.entity?.position ?? currentPosition
      if (isTreeColumnAlreadyInBreakRange(updatedPosition, treeColumnLogs)) {
        return true
      }

      if (mode === 'search') {
        const terrainSupportDepth = await getTerrainSupportDepthBelowElevatedWood(mineflayer, lowestLog)
        logger.withFields({
          treeBase,
          lowestLog,
          currentY: updatedPosition.y,
          terrainSupportDepth,
        }).log('Search reached horizontal wood-candidate contact, but the column remains out of break range.')
        return false
      }
    }
  }

  if (treeBase.y > currentPosition.y) {
    const terrainSupportDepth = await getTerrainSupportDepthBelowElevatedWood(mineflayer, lowestLog)
    const horizontalDistance = getHorizontalDistance(currentPosition, treeBase)
    if (
      (
        treeBase.y > currentPosition.y + MAX_LOW_RAISED_WOOD_HORIZONTAL_APPROACH_ASCENT
        || horizontalDistance > 6
      )
      && terrainSupportDepth != null
      && terrainSupportDepth > MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_SUPPORT_DEPTH
    ) {
      logger.withFields({
        treeBase,
        lowestLog,
        currentY: currentPosition.y,
        terrainSupportDepth,
        horizontalDistance,
      }).log('Skipping raised wood candidate with deep or missing terrain support before exact-height pathing.')
      return false
    }
  }

  return goToPosition(
    mineflayer,
    treeBase.x,
    treeBase.y,
    treeBase.z,
    2,
  )
}

export async function approachNearestWoodTarget(
  mineflayer: Mineflayer,
  requestedWoodType = 'log',
  maxDistance = 64,
): Promise<boolean> {
  const candidates = await getWoodRecoveryCandidates(mineflayer, requestedWoodType, maxDistance)
  const attemptedTreeBases = new Set<string>()
  let attemptedReachableCandidate = false

  for (const woodBlock of candidates) {
    const currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
    if (await shouldSkipDeepSupportedRaisedObservationBeforeTrunkProbe(mineflayer, woodBlock, currentPosition, 'search')) {
      if (!attemptedReachableCandidate) {
        break
      }
      continue
    }

    const treeBase = await resolveWoodCandidateBase(mineflayer, woodBlock)
    const treeBaseKey = positionKey(treeBase)
    if (attemptedTreeBases.has(treeBaseKey)) {
      continue
    }
    attemptedTreeBases.add(treeBaseKey)
    const treeColumnLogs = await resolveTreeColumnLogs(mineflayer, treeBase)
    if (treeColumnLogs.length === 0) {
      continue
    }

    if (shouldSkipRememberedUnreachableWoodTarget(
      mineflayer,
      treeBaseKey,
      currentPosition,
      treeBase,
      treeColumnLogs,
    )) {
      continue
    }

    const destinationReached = await moveIntoWoodColumnRange(
      mineflayer,
      treeBase,
      treeColumnLogs,
      'search',
    )
    if (destinationReached) {
      return true
    }

    const updatedPosition = mineflayer.bot.entity?.position ?? { x: treeBase.x, y: treeBase.y, z: treeBase.z }
    if (isUnresolvedElevatedWoodColumn(updatedPosition, treeBase, treeColumnLogs) && !attemptedReachableCandidate) {
      rememberUnreachableWoodTarget(mineflayer, treeBaseKey, 'search-elevated-unreachable')
      logger.withFields({
        requestedWoodType,
        candidateCount: candidates.length,
        treeBase,
      }).warn('Wood search is returning control after the nearest candidates were elevated and unreachable.')
      break
    }
    attemptedReachableCandidate = true
  }

  return false
}

type WoodTrunkProbePattern = 'full' | 'high-elevated-sparse'

function getCandidateColumnProbeOffsets(pattern: WoodTrunkProbePattern): Array<{ x: number, z: number }> {
  const offsets: Array<{ x: number, z: number }> = []
  const seenOffsets = new Set<string>()

  const addOffset = (x: number, z: number): void => {
    const key = `${x},${z}`
    if (seenOffsets.has(key)) {
      return
    }
    seenOffsets.add(key)
    offsets.push({ x, z })
  }

  if (pattern === 'high-elevated-sparse') {
    addOffset(0, 0)

    for (let radius = 1; radius <= WOOD_TRUNK_BASE_PROBE_RADIUS; radius++) {
      addOffset(radius, 0)
      addOffset(-radius, 0)
      addOffset(0, radius)
      addOffset(0, -radius)
    }

    for (let radius = 1; radius <= HIGH_ELEVATED_WOOD_LOCAL_PROBE_RADIUS; radius++) {
      for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
          if (Math.max(Math.abs(x), Math.abs(z)) !== radius) {
            continue
          }
          addOffset(x, z)
        }
      }
    }

    return offsets
  }

  for (let radius = 0; radius <= WOOD_TRUNK_BASE_PROBE_RADIUS; radius++) {
    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== radius) {
          continue
        }
        addOffset(x, z)
      }
    }
  }

  return offsets
}

async function resolveWoodCandidateBase(
  mineflayer: Mineflayer,
  candidate: { name: string, position: { x: number, y: number, z: number } },
): Promise<{ x: number, y: number, z: number }> {
  const currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  const baseX = Math.floor(candidate.position.x)
  const baseY = Math.floor(candidate.position.y)
  const baseZ = Math.floor(candidate.position.z)
  const verticalAscent = baseY - currentPosition.y
  const horizontalDistance = getHorizontalDistance(currentPosition, candidate.position)
  const isHighElevatedCandidate = verticalAscent > MAX_ELEVATED_WOOD_HORIZONTAL_APPROACH_ASCENT
  const useWideOffsetProbe = verticalAscent <= MAX_UNRESOLVED_ELEVATED_WOOD_ASCENT
    || horizontalDistance <= WIDE_WOOD_TRUNK_BASE_PROBE_MAX_HORIZONTAL_DISTANCE
  const maxProbeDepth = isHighElevatedCandidate
    ? HIGH_ELEVATED_WOOD_TRUNK_BASE_PROBE_DEPTH
    : WOOD_TRUNK_BASE_PROBE_DEPTH
  const probeDepth = Math.max(
    MIN_WOOD_TRUNK_BASE_PROBE_DEPTH,
    Math.min(
      maxProbeDepth,
      Math.ceil(Math.max(0, verticalAscent) + MAX_SURFACE_WOOD_DESCENT + 2),
    ),
  )
  const probeHeights = Array.from({ length: probeDepth + 2 }, (_, index) => 1 - index)
  const probePattern: WoodTrunkProbePattern = isHighElevatedCandidate ? 'high-elevated-sparse' : 'full'
  const probeOffsets = useWideOffsetProbe ? getCandidateColumnProbeOffsets(probePattern) : [{ x: 0, z: 0 }]
  const probeBlockLimit = useWideOffsetProbe && isHighElevatedCandidate
    ? HIGH_ELEVATED_WOOD_TRUNK_BASE_PROBE_BLOCK_LIMIT
    : Number.POSITIVE_INFINITY
  let probedBlocks = 0
  let reachedProbeBlockLimit = false
  const columnCandidates: Array<{ x: number, y: number, z: number, droppedLevels: number, offsetDistance: number }> = []

  // NOTICE: Forest scans often surface branch or canopy logs first. If we path directly to that
  // elevated block, the bot can fail to reach the tree even though the trunk is a couple of
  // blocks over and starts several blocks lower. Probe a small radius around the canopy hit
  // and prefer the deepest connected wood column so the bot walks to the trunk base instead.
  // High elevated hits are usually canopy-only clusters; use cardinal rays and a hard block
  // budget so one unreachable tree cannot spend a minute on thousands of block RPCs.
  for (const offset of probeOffsets) {
    if (reachedProbeBlockLimit) {
      break
    }

    const x = baseX + offset.x
    const z = baseZ + offset.z
    let detectedWoodY: number | null = null

    for (const yOffset of probeHeights) {
      if (probedBlocks >= probeBlockLimit) {
        reachedProbeBlockLimit = true
        break
      }

      probedBlocks++
      const probeY = baseY + yOffset
      const block = await getBlockAtAccurate(mineflayer, { x, y: probeY, z })
      if (!block || !isWoodLikeBlockName(block.name)) {
        continue
      }

      detectedWoodY = Math.floor(block.position.y)
      break
    }

    if (reachedProbeBlockLimit && detectedWoodY == null) {
      break
    }

    if (detectedWoodY == null) {
      continue
    }

    let resolvedY = detectedWoodY
    for (let depth = 0; depth < 12; depth++) {
      const below = await getBlockAtAccurate(mineflayer, { x, y: resolvedY - 1, z })
      if (!below || !isWoodLikeBlockName(below.name)) {
        break
      }
      resolvedY = Math.floor(below.position.y)
    }

    columnCandidates.push({
      x,
      y: resolvedY,
      z,
      droppedLevels: detectedWoodY - resolvedY,
      offsetDistance: Math.sqrt((offset.x ** 2) + (offset.z ** 2)),
    })

    if (useWideOffsetProbe && resolvedY <= currentPosition.y + 1) {
      break
    }
  }

  if (columnCandidates.length === 0) {
    return { x: baseX, y: baseY, z: baseZ }
  }

  columnCandidates.sort((left, right) =>
    right.droppedLevels - left.droppedLevels
    || left.offsetDistance - right.offsetDistance
    || left.y - right.y)

  const selectedColumn = columnCandidates[0]
  return { x: selectedColumn.x, y: selectedColumn.y, z: selectedColumn.z }
}

async function resolveTreeColumnLogs(
  mineflayer: Mineflayer,
  treeBase: { x: number, y: number, z: number },
): Promise<Array<{ x: number, y: number, z: number }>> {
  const logs: Array<{ x: number, y: number, z: number }> = []
  let startedTree = false

  // NOTICE: After reaching a selected tree we only want logs from that trunk column first.
  // A broad local re-scan can jump to a neighboring tree or branch and send the bot to an
  // unrelated, often unreachable, block. Staying on the selected column keeps early-game
  // wood gathering deterministic enough to bootstrap the rest of the run.
  for (let offset = 0; offset < 16; offset++) {
    const block = await getBlockAtAccurate(mineflayer, {
      x: treeBase.x,
      y: treeBase.y + offset,
      z: treeBase.z,
    })

    if (!block || !isWoodLikeBlockName(block.name)) {
      if (startedTree) {
        break
      }
      continue
    }

    startedTree = true
    logs.push({
      x: Math.floor(block.position.x),
      y: Math.floor(block.position.y),
      z: Math.floor(block.position.z),
    })
  }

  return logs
}

async function tryBridgeWoodMiningRecovery(
  mineflayer: Mineflayer,
  blockName: string,
  requestedWoodType: string,
  targetCount: number,
): Promise<boolean> {
  const pathfinder = mineflayer.bot.pathfinder as {
    mine?: (blockNames: string[]) => Promise<boolean>
    stop?: () => void
  } | undefined

  if (typeof pathfinder?.mine !== 'function') {
    return false
  }

  // NOTICE: The Fabric bridge dig RPC can fail to complete a real survival break even
  // when the bot is standing at the tree. When Baritone is available through the bridge,
  // prefer its native mining process as a recovery path instead of accepting fake success.
  // Baritone's mine(0, blocks) mines indefinitely, so stop it as soon as the requested
  // inventory target is reached instead of waiting for the bridge timeout.
  try {
    const signal = mineflayer.currentActionSignal
    throwIfAborted(signal)
    const miningPromise = pathfinder.mine([blockName])
      .then(result => ({ result, error: null as Error | null }))
      .catch((error: Error) => ({ result: false, error }))
    const deadline = Date.now() + BRIDGE_WOOD_MINING_RECOVERY_TIMEOUT_MS

    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const miningResult = await raceWithAbort(Promise.race([
        miningPromise,
        abortableSleep(BRIDGE_WOOD_PROGRESS_POLL_MS, signal).then(() => null),
      ]), signal)

      if (getLogsCount(mineflayer, requestedWoodType) >= targetCount) {
        pathfinder.stop?.()
        await abortableSleep(BRIDGE_WOOD_MINING_INVENTORY_SETTLE_MS, signal)
        return true
      }

      if (miningResult) {
        await refreshInventoryState(mineflayer)
        const currentLogsCount = getLogsCount(mineflayer, requestedWoodType)
        if (currentLogsCount >= targetCount) {
          return true
        }

        if (miningResult.error) {
          logger.withFields({ blockName, error: miningResult.error.message })
            .warn('Bridge wood-mining recovery threw (likely timeout); baritone may have mined some blocks.')
        }
        if (!miningResult.result) {
          logger.withFields({ blockName }).warn('Bridge wood-mining recovery did not complete successfully.')
        }
        else {
          logger.withFields({ blockName, currentLogsCount, targetCount })
            .warn('Bridge wood-mining recovery finished without reaching the requested log count.')
        }
        return false
      }
    }

    pathfinder.stop?.()
    await refreshInventoryState(mineflayer)
    if (getLogsCount(mineflayer, requestedWoodType) >= targetCount) {
      return true
    }
    logger.withFields({ blockName, targetCount }).warn('Bridge wood-mining recovery timed out before reaching the requested log count.')
    return false
  }
  catch (error) {
    if (error instanceof ActionAbortedError) {
      throw error
    }
    logger.withFields({ blockName, error: error instanceof Error ? error.message : String(error) })
      .warn('Bridge wood-mining recovery threw (likely timeout); baritone may have mined some blocks.')
    return false
  }
}

/**
 * Gather wood blocks nearby to collect logs.
 *
 * @param mineflayer The mineflayer instance.
 * @param num The number of wood logs to gather.
 * @param maxDistance The maximum distance to search for wood blocks.
 * @returns Whether the wood gathering was successful.
 */
export async function gatherWood(
  mineflayer: Mineflayer,
  num: number,
  maxDistance = 64,
  requestedWoodType = 'log',
): Promise<boolean> {
  const targetDescription = describeWoodTarget(requestedWoodType)
  logger.log(`Gathering wood... I need to collect ${num} ${targetDescription}.`)
  mineflayer.bot.chat(`Gathering wood... I need to collect ${num} ${targetDescription}.`)

  const startY = getFiniteBotMetric(mineflayer.bot.entity?.position?.y, 64)
  woodGatheringSurfaceStartY.set(mineflayer, startY)
  const uninstallSurvivalInterrupt = installWoodGatheringSurvivalInterrupt(mineflayer, requestedWoodType)
  try {
    await refreshInventoryState(mineflayer)
    let logsCount = getLogsCount(mineflayer, requestedWoodType)
    logger.log(`I currently have ${logsCount} ${targetDescription}.`)
    let attempts = 0
    let noProgressAttempts = 0
    const avoidedTargets = new Set<string>()
    const effectiveMaxDistance = Math.max(maxDistance, MIN_WOOD_COLLECTION_SCAN_DISTANCE)
    let elevatedOnlyRelocations = 0

    if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'preflight', requestedWoodType)) {
      return false
    }

    while (logsCount < num && attempts < MAX_GATHER_WOOD_ATTEMPTS && noProgressAttempts < MAX_GATHER_WOOD_NO_PROGRESS_ATTEMPTS) {
      throwIfAborted(mineflayer.currentActionSignal)
      attempts++
      if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'attempt-start', requestedWoodType)) {
        return false
      }

      // Gather 1 extra log to account for any failures
      logger.log(`Looking for wood blocks nearby...`, logsCount, num)
      const logsBeforeAttempt = logsCount
      const allNearbyWoodBlocks = await getWoodRecoveryCandidates(mineflayer, requestedWoodType, effectiveMaxDistance)
      if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'after-wood-scan', requestedWoodType)) {
        return false
      }

      const recoveryProbeCandidates = allNearbyWoodBlocks
      const bridgeRecoveryCandidates: string[] = []
      let skippedOnlyUnresolvedElevatedCandidates = false
      let skippedNoProgressElevatedCandidates = false
      let skippedRememberedUnreachableCandidates = false
      let attemptedReachableCandidate = false
      let stoppedAfterElevatedOnlyCandidates = false
      let relocatedFromElevatedOnlyCluster = false
      let stoppedForSurvival = false

      if (recoveryProbeCandidates.length === 0) {
        logger.withFields({
          totalCandidates: allNearbyWoodBlocks.length,
          maxHorizontalDistance: MAX_LOCAL_WOOD_HORIZONTAL_DISTANCE,
          maxVerticalDistance: MAX_LOCAL_WOOD_VERTICAL_DISTANCE,
        }).log('No reachable wood candidates found nearby.')
        noProgressAttempts++
        break
      }

      let gatheredThisAttempt = false

      // NOTICE: Generic `baritone mine(log)` often latches onto the nearest canopy hit and can
      // spend a whole recovery window blacklisting unreachable leaves/branches. The trunk-aware
      // manual pass is now the primary path so wood gathering stays grounded to a specific tree
      // column. Baritone remains the fallback when direct breaking still fails.
      for (const woodBlock of recoveryProbeCandidates) {
        throwIfAborted(mineflayer.currentActionSignal)
        if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'candidate-start', requestedWoodType)) {
          stoppedForSurvival = true
          break
        }

        const currentPosition = mineflayer.bot.entity?.position ?? { x: 0, y: 64, z: 0 }
        if (await shouldSkipDeepSupportedRaisedObservationBeforeTrunkProbe(mineflayer, woodBlock, currentPosition, 'collection')) {
          skippedOnlyUnresolvedElevatedCandidates = true
          avoidedTargets.add(positionKey(woodBlock.position))
          if (!attemptedReachableCandidate) {
            if (
              elevatedOnlyRelocations < MAX_ELEVATED_ONLY_WOOD_CLUSTER_RELOCATIONS
              && await canRelocateFromElevatedOnlyWoodCluster(mineflayer)
            ) {
              const relocationDistance = ELEVATED_ONLY_WOOD_CLUSTER_RELOCATION_DISTANCE + (elevatedOnlyRelocations * 16)
              const relocationScanDistance = Math.max(
                effectiveMaxDistance,
                ELEVATED_ONLY_WOOD_TARGET_RELOCATION_SCAN_DISTANCE,
              )
              elevatedOnlyRelocations++
              logger.withFields({
                requestedWoodType,
                candidateCount: recoveryProbeCandidates.length,
                treeBase: woodBlock.position,
                relocationDistance,
                relocationScanDistance,
                relocationAttempt: elevatedOnlyRelocations,
              }).warn('Searching for a reachable wood target before elevated-only cluster relocation.')
              relocatedFromElevatedOnlyCluster = await relocateTowardReachableWoodCandidate(
                mineflayer,
                requestedWoodType,
                relocationScanDistance,
                avoidedTargets,
              )
              if (!relocatedFromElevatedOnlyCluster) {
                stoppedAfterElevatedOnlyCandidates = true
                logger.withFields({
                  requestedWoodType,
                  candidateCount: recoveryProbeCandidates.length,
                  treeBase: woodBlock.position,
                  relocationScanDistance,
                }).warn('Wood gathering is returning control after targeted relocation found no reachable surface wood candidate.')
              }
            }
            else {
              stoppedAfterElevatedOnlyCandidates = true
              logger.withFields({
                requestedWoodType,
                candidateCount: recoveryProbeCandidates.length,
                treeBase: woodBlock.position,
              }).warn('Wood gathering is returning control after the nearest candidates were elevated and unreachable.')
            }
            break
          }
          continue
        }

        const treeBase = await resolveWoodCandidateBase(mineflayer, woodBlock)
        const treeBaseKey = positionKey(treeBase)
        if (avoidedTargets.has(treeBaseKey)) {
          continue
        }
        if (!isSurfaceWoodCandidate(currentPosition, treeBase)) {
          avoidedTargets.add(treeBaseKey)
          logger.withFields({
            treeBase,
            currentY: currentPosition.y,
            descent: currentPosition.y - treeBase.y,
          }).log('Skipping below-surface wood candidate during surface wood collection.')
          continue
        }
        const aTree = await resolveTreeColumnLogs(mineflayer, treeBase)
        if (aTree.length === 0) {
          avoidedTargets.add(treeBaseKey)
          logger.log('No wood blocks found nearby.')
          continue
        }

        if (shouldSkipRememberedUnreachableWoodTarget(
          mineflayer,
          treeBaseKey,
          currentPosition,
          treeBase,
          aTree,
        )) {
          skippedRememberedUnreachableCandidates = true
          avoidedTargets.add(treeBaseKey)
          continue
        }

        const destinationReached = await moveIntoWoodColumnRange(
          mineflayer,
          treeBase,
          aTree,
        )

        if (!destinationReached) {
          if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'after-destination-failure', requestedWoodType)) {
            stoppedForSurvival = true
            break
          }

          const updatedPosition = mineflayer.bot.entity?.position ?? { x: treeBase.x, y: treeBase.y, z: treeBase.z }
          const unresolvedElevatedColumn = isUnresolvedElevatedWoodColumn(updatedPosition, treeBase, aTree)
          if (unresolvedElevatedColumn) {
            const lowestLog = aTree[0] ?? treeBase
            const terrainSupportDepth = await getTerrainSupportDepthBelowElevatedWood(mineflayer, lowestLog)
            const horizontalDistance = getHorizontalDistance(updatedPosition, treeBase)
            if (terrainSupportDepth != null && horizontalDistance <= 3) {
              logger.withFields({
                treeBase,
                lowestLog,
                currentY: updatedPosition.y,
                terrainSupportDepth,
                horizontalDistance,
              }).log('Terrain-supported elevated wood stayed out of break range after horizontal rescan; relocating before the next wood scan.')
            }
            else {
              skippedOnlyUnresolvedElevatedCandidates = true
            }
            rememberUnreachableWoodTarget(mineflayer, treeBaseKey, 'collect-elevated-unreachable')
          }
          avoidedTargets.add(treeBaseKey)
          if (!unresolvedElevatedColumn) {
            attemptedReachableCandidate = true
            bridgeRecoveryCandidates.push(woodBlock.name)
          }
          logger.log('Unable to reach the wood block.')
          if (unresolvedElevatedColumn && !attemptedReachableCandidate) {
            if (
              elevatedOnlyRelocations < MAX_ELEVATED_ONLY_WOOD_CLUSTER_RELOCATIONS
              && await canRelocateFromElevatedOnlyWoodCluster(mineflayer)
            ) {
              const relocationDistance = ELEVATED_ONLY_WOOD_CLUSTER_RELOCATION_DISTANCE + (elevatedOnlyRelocations * 16)
              const relocationScanDistance = Math.max(
                effectiveMaxDistance,
                ELEVATED_ONLY_WOOD_TARGET_RELOCATION_SCAN_DISTANCE,
              )
              elevatedOnlyRelocations++
              logger.withFields({
                requestedWoodType,
                candidateCount: recoveryProbeCandidates.length,
                treeBase,
                relocationDistance,
                relocationScanDistance,
                relocationAttempt: elevatedOnlyRelocations,
              }).warn('Searching for a reachable wood target before elevated-only cluster relocation.')
              relocatedFromElevatedOnlyCluster = await relocateTowardReachableWoodCandidate(
                mineflayer,
                requestedWoodType,
                relocationScanDistance,
                avoidedTargets,
              )
              if (!relocatedFromElevatedOnlyCluster) {
                stoppedAfterElevatedOnlyCandidates = true
                logger.withFields({
                  requestedWoodType,
                  candidateCount: recoveryProbeCandidates.length,
                  treeBase,
                  relocationScanDistance,
                }).warn('Wood gathering is returning control after targeted relocation found no reachable surface wood candidate.')
              }
            }
            else {
              stoppedAfterElevatedOnlyCandidates = true
              logger.withFields({
                requestedWoodType,
                candidateCount: recoveryProbeCandidates.length,
                treeBase,
              }).warn('Wood gathering is returning control after the nearest candidates were elevated and unreachable.')
            }
            break
          }
          continue
        }

        if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'before-direct-break', requestedWoodType)) {
          stoppedForSurvival = true
          break
        }

        attemptedReachableCandidate = true
        try {
          for (const aLog of aTree) {
            throwIfAborted(mineflayer.currentActionSignal)
            if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'during-direct-break', requestedWoodType)) {
              stoppedForSurvival = true
              break
            }

            await breakBlockAt(mineflayer, aLog.x, aLog.y, aLog.z)
            await abortableSleep(MANUAL_WOOD_BREAK_SETTLE_MS, mineflayer.currentActionSignal)
            if (getLogsCount(mineflayer, requestedWoodType) >= num) {
              break
            }
          }
          if (stoppedForSurvival) {
            break
          }

          await pickupNearbyItems(mineflayer)
          await abortableSleep(MANUAL_WOOD_PICKUP_SETTLE_MS, mineflayer.currentActionSignal)
          await refreshInventoryState(mineflayer)
          logsCount = getLogsCount(mineflayer, requestedWoodType)
          logger.log(`Collected wood. Total ${targetDescription} now: ${logsCount}.`)
          if (logsCount > logsBeforeAttempt) {
            gatheredThisAttempt = true
            break
          }
          const positionAfterAttempt = mineflayer.bot.entity?.position ?? { x: treeBase.x, y: treeBase.y, z: treeBase.z }
          const lowestLog = aTree[0] ?? treeBase
          const elevatedNoProgressCandidate = lowestLog.y > positionAfterAttempt.y + 2
          const unresolvedNoProgressCandidate = isUnresolvedElevatedWoodColumn(positionAfterAttempt, treeBase, aTree)
          if (elevatedNoProgressCandidate || unresolvedNoProgressCandidate) {
            skippedNoProgressElevatedCandidates = true
            logger.withFields({
              blockName: woodBlock.name,
              treeBase,
              lowestLog,
              currentY: positionAfterAttempt.y,
              logsBeforeAttempt,
              logsCount,
            }).warn('Direct wood break produced no inventory progress; skipping bridge recovery for elevated candidate.')
            rememberUnreachableWoodTarget(mineflayer, treeBaseKey, 'collect-elevated-no-progress')
          }
          else {
            bridgeRecoveryCandidates.push(woodBlock.name)
          }
          avoidedTargets.add(treeBaseKey)
        }
        catch (digError) {
          if (digError instanceof ActionAbortedError) {
            throw digError
          }
          logger.withFields({
            blockName: woodBlock.name,
            x: woodBlock.position.x,
            y: woodBlock.position.y,
            z: woodBlock.position.z,
            error: digError instanceof Error ? digError.message : String(digError),
          }).warn('Direct wood breaking failed; trying bridge mining recovery.')

          const recoveredByBridgeMining = await tryBridgeWoodMiningRecovery(
            mineflayer,
            woodBlock.name,
            requestedWoodType,
            num,
          )
          if (!recoveredByBridgeMining) {
            avoidedTargets.add(treeBaseKey)
            console.error('Failed to break the wood block:', digError)
            continue
          }

          await pickupNearbyItems(mineflayer)
          await abortableSleep(MANUAL_WOOD_PICKUP_SETTLE_MS, mineflayer.currentActionSignal)
          await refreshInventoryState(mineflayer)
          logsCount = getLogsCount(mineflayer, requestedWoodType)
          logger.log(`Bridge wood-mining recovery finished. Total ${targetDescription} now: ${logsCount}.`)
          if (logsCount > logsBeforeAttempt) {
            gatheredThisAttempt = true
            break
          }
          avoidedTargets.add(treeBaseKey)
        }
      }

      if (stoppedForSurvival) {
        return false
      }

      if (!gatheredThisAttempt) {
        if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'before-bridge-recovery', requestedWoodType)) {
          return false
        }

        const hasBaritoneMine = typeof (mineflayer.bot.pathfinder as any)?.mine === 'function'
        const woodBlockName = bridgeRecoveryCandidates[0]
        if (hasBaritoneMine && woodBlockName) {
          logger.log(`Using baritone to mine ${woodBlockName} as a recovery path`)
          const baritoneMined = await tryBridgeWoodMiningRecovery(
            mineflayer,
            woodBlockName,
            requestedWoodType,
            num,
          )
          // Always refresh inventory after baritone attempt — even on timeout/failure,
          // baritone may have mined some logs before the error occurred.
          if (baritoneMined) {
            await abortableSleep(BRIDGE_WOOD_MINING_INVENTORY_SETTLE_MS, mineflayer.currentActionSignal)
          }
          await refreshInventoryState(mineflayer)
          logsCount = getLogsCount(mineflayer, requestedWoodType)
          logger.log(`Baritone wood mining ${baritoneMined ? 'finished' : 'partially completed'}. Total ${targetDescription} now: ${logsCount}.`)
          if (logsCount > logsBeforeAttempt) {
            gatheredThisAttempt = true
          }
        }
        else if (hasBaritoneMine && recoveryProbeCandidates.length > 0) {
          logger.withFields({
            candidateCount: recoveryProbeCandidates.length,
            requestedWoodType,
          }).log('Skipping global baritone wood recovery because visible candidates are unresolved elevated columns or already exhausted.')
        }
      }

      if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'attempt-end', requestedWoodType)) {
        return false
      }

      if (gatheredThisAttempt) {
        noProgressAttempts = 0
      }
      else {
        noProgressAttempts++
        if (relocatedFromElevatedOnlyCluster) {
          continue
        }
        if (
          (
            skippedOnlyUnresolvedElevatedCandidates
            && !attemptedReachableCandidate
          )
          || (stoppedAfterElevatedOnlyCandidates && !attemptedReachableCandidate)
          || (skippedRememberedUnreachableCandidates && !attemptedReachableCandidate)
          || (skippedNoProgressElevatedCandidates && bridgeRecoveryCandidates.length === 0)
        ) {
          logger.withFields({
            requestedWoodType,
            candidateCount: recoveryProbeCandidates.length,
          }).warn('Wood gathering saw only elevated or no-progress canopy candidates; returning control without unsafe relocation.')
          break
        }
        await moveAway(mineflayer, 16 + (attempts * 8))
        if (shouldReturnControlForWoodGatheringSurvival(mineflayer, 'after-move-away', requestedWoodType)) {
          return false
        }
      }
    }

    if (logsCount < num) {
      logger.withFields({
        logsCount,
        neededLogs: num,
        requestedWoodType,
        attempts,
        noProgressAttempts,
      }).warn('Wood gathering stopped before reaching target amount.')
      return false
    }

    logger.log(`Wood gathering complete! Total ${targetDescription} collected: ${logsCount}.`)
    return true
  }
  catch (error) {
    if (error instanceof ActionAbortedError) {
      throw error
    }
    console.error('Failed to gather wood:', error)
    return false
  }
  finally {
    uninstallSurvivalInterrupt()
    woodGatheringSurfaceStartY.delete(mineflayer)
  }
}

/**
 * Helper function to count the number of logs in the inventory.
 * @returns The total number of logs.
 */
export function getLogsCount(mineflayer: Mineflayer, requestedWoodType = 'log'): number {
  return mineflayer.bot.inventory
    .items()
    .filter(item => matchesRequestedWoodType(item.name, requestedWoodType))
    .reduce((acc, item) => acc + item.count, 0)
}
