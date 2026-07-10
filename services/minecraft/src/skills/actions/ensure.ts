import type { Mineflayer } from '../../libs/mineflayer'

import { sleep } from '@moeru/std'

import { abortableSleep, ActionAbortedError, raceWithAbort, throwIfAborted } from '../../libs/mineflayer/action-abort'
import { useLogger } from '../../utils/logger'
import { getNearestBlocksAccurate, isBlockExposedAccurate } from '../block-access'
import { craftRecipe, getLastCraftRecipeDiagnostic, getSelectedCraftRecipeRequirements, smeltItem } from '../crafting'
import { moveAway, moveToHorizontalTarget } from '../movement'
import { collectBlock } from './collect-block'
import { gatherWood } from './gather-wood'
import { confirmItemCount, discard, getActualItemCount, getBridgeInventorySnapshot, getItemCount, getStrictVisibleItemCount, recordOptimisticItem, refreshInventoryState } from './inventory'
import { pickupNearbyItems } from './world-interactions'

// Constants for crafting and gathering
const PLANKS_PER_LOG = 4
const STICKS_PER_PLANK = 2
const logger = useLogger()
const RETRY_DELAY_MS = 400
const MAX_CRAFTING_TABLE_ATTEMPTS = 3
const MAX_PLANK_ATTEMPTS = 4
const MAX_TOOL_ATTEMPTS = 6
const MAX_PICKAXE_RECOVERY_ATTEMPTS = 3
const MAX_COBBLESTONE_GATHER_ATTEMPTS = 6
const MAX_COAL_GATHER_ATTEMPTS = 8
const MAX_GATHER_NO_PROGRESS_ATTEMPTS = 3
const COBBLESTONE_COLLECTION_TARGET_PER_ATTEMPT = 8
const COLLECT_BLOCK_ATTEMPT_TIMEOUT_MS = 30_000
const CRAFTING_TABLE_NEARBY_SCAN_DISTANCE = 6
const CRAFTING_TABLE_REACHABLE_SCAN_DISTANCE = 64
const CRAFTING_TABLE_REACHABLE_VERTICAL_DISTANCE = 3
const BARITONE_STONE_MINING_TIMEOUT_MS = 120_000
const CRAFTING_TABLE_FAILURE_COOLDOWN_MS = 20_000
const PLANK_FAILURE_COOLDOWN_MS = 20_000
const WOOD_FUEL_SMELTS_PER_ITEM = 1.5
const PICKAXE_DROP_RECOVERY_DISTANCE = 8

let lastCraftingTableFailureAt = 0
let lastPlankFailureAt = 0
type NearestAccurateBlock = Awaited<ReturnType<typeof getNearestBlocksAccurate>>[number]
interface StoneRelocationCandidate {
  block: NearestAccurateBlock
  horizontalDistance: number
  verticalDistance: number
}

interface ActualInventoryRequirement {
  itemName: string
  minCount: number
}

interface CanonicalInventorySlotLike {
  slotIndex?: number
  itemName?: string | null
  count?: number
}

interface CanonicalInventorySnapshotLike {
  slots?: CanonicalInventorySlotLike[]
  heldItem?: CanonicalInventorySlotLike | null
  offhand?: CanonicalInventorySlotLike | null
  armor?: CanonicalInventorySlotLike[]
}

export function resetEnsureTransientState(): void {
  lastCraftingTableFailureAt = 0
  lastPlankFailureAt = 0
}

function getCobblestoneSearchRange(baseDistance: number, attempt: number): number {
  const attemptIndex = Math.max(0, attempt - 1)
  const searchRanges = [
    baseDistance,
    Math.max(baseDistance, 16),
    Math.max(baseDistance, 40),
    Math.max(baseDistance, 64),
  ]
  return searchRanges[Math.min(attemptIndex, searchRanges.length - 1)] ?? Math.max(baseDistance, 64)
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal)
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    const result = await raceWithAbort(Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ]), signal)
    throwIfAborted(signal)
    return result
  }
  finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}

async function hasNearbyPlacedCraftingTable(
  mineflayer: Mineflayer,
  maxDistance = CRAFTING_TABLE_NEARBY_SCAN_DISTANCE,
  options?: { maxVerticalDistance?: number },
): Promise<boolean> {
  const nearby = await getNearestBlocksAccurate(mineflayer, 'crafting_table', maxDistance, 4)
  if (nearby.length <= 0) {
    return false
  }

  const position = mineflayer.bot.entity?.position
  if (!position) {
    return false
  }

  const maxVerticalDistance = options?.maxVerticalDistance ?? 3
  return nearby.some((block) => {
    const dx = block.position.x - position.x
    const dy = block.position.y - position.y
    const dz = block.position.z - position.z
    const horizontalDistance = Math.sqrt((dx ** 2) + (dz ** 2))
    const verticalDistance = Math.abs(dy)
    return horizontalDistance <= (maxDistance + 0.75) && verticalDistance <= maxVerticalDistance
  })
}

async function hasReachablePlacedCraftingTable(mineflayer: Mineflayer): Promise<boolean> {
  return await hasNearbyPlacedCraftingTable(
    mineflayer,
    CRAFTING_TABLE_REACHABLE_SCAN_DISTANCE,
    { maxVerticalDistance: CRAFTING_TABLE_REACHABLE_VERTICAL_DISTANCE },
  )
}

async function relocateTowardStoneOutcrop(mineflayer: Mineflayer, searchDistance: number): Promise<boolean> {
  const position = mineflayer.bot.entity.position
  const candidates = await getNearestBlocksAccurate(mineflayer, ['cobblestone', 'stone'], searchDistance, 24)
  const inspectedCandidates = await Promise.all(candidates.map(async (block): Promise<StoneRelocationCandidate | null> => {
    const horizontalDistance = Math.sqrt(((block.position.x - position.x) ** 2) + ((block.position.z - position.z) ** 2))
    if (horizontalDistance <= 4 || horizontalDistance > searchDistance) {
      return null
    }
    const verticalDistance = Math.abs(block.position.y - position.y)
    if (verticalDistance > 24) {
      return null
    }
    const exposed = await isBlockExposedAccurate(mineflayer, block.position)
    if (!exposed) {
      return null
    }
    return {
      block,
      horizontalDistance,
      verticalDistance,
    }
  }))
  const viableCandidates = inspectedCandidates
    .filter((candidate): candidate is StoneRelocationCandidate => candidate !== null)
    .sort((left, right) =>
      (left.verticalDistance * 4 + left.horizontalDistance)
      - (right.verticalDistance * 4 + right.horizontalDistance),
    )
  const nearest = viableCandidates[0]

  if (!nearest) {
    return false
  }

  logger.withFields({
    searchDistance,
    x: nearest.block.position.x,
    y: nearest.block.position.y,
    z: nearest.block.position.z,
    name: nearest.block.name,
    horizontalDistance: nearest.horizontalDistance,
    verticalDistance: nearest.verticalDistance,
  }).log('Bot: Relocating toward exposed stone outcrop.')

  return await moveToHorizontalTarget(
    mineflayer,
    Math.floor(nearest.block.position.x),
    Math.floor(nearest.block.position.z),
  )
}

function logCraftConfirmationMismatch(itemName: string): void {
  logger.warn(
    `Bot: Craft RPC reported success for ${itemName}, but inventory refresh did not confirm it. `
    + 'This usually indicates a FabricBridge inventory sync problem or that the Minecraft client is still running an older bridge mod build.',
  )
}

function hasRecentBridgeCraftSyncMismatch(
  mineflayer: Mineflayer,
  expectedItems: string[] = [],
): boolean {
  const diagnostic = getLastCraftRecipeDiagnostic(mineflayer)
  if (!diagnostic) {
    return false
  }

  if (Date.now() - diagnostic.at > 15_000) {
    return false
  }

  if (diagnostic.kind !== 'inventory_sync_mismatch') {
    return false
  }

  if (expectedItems.length === 0) {
    return true
  }

  const normalizedDiagnosticItem = diagnostic.itemName.replace(/^minecraft:/, '').toLowerCase()
  return expectedItems.some((itemName) => {
    const normalizedExpected = itemName.replace(/^minecraft:/, '').toLowerCase()
    return normalizedDiagnosticItem === normalizedExpected
      || normalizedDiagnosticItem.includes(normalizedExpected)
      || normalizedExpected.includes(normalizedDiagnosticItem)
  })
}

function hasUnconfirmedOptimisticInventoryLead(
  mineflayer: Mineflayer,
  itemNames: string[],
): boolean {
  return itemNames.some(itemName => getItemCount(mineflayer, itemName) > getVisibleActualItemCount(mineflayer, itemName))
}

function normalizeInventoryRequirementItemName(itemName: string): string {
  const normalized = itemName.replace(/^minecraft:/, '').trim().toLowerCase()
  return normalized.endsWith('_planks') ? 'planks' : normalized
}

function doesRecentInventoryOnlyCraftSupportRequirement(
  requirementItemName: string,
  diagnosticItemName: string,
): boolean {
  const normalizedRequirement = normalizeInventoryRequirementItemName(requirementItemName)
  const normalizedDiagnostic = normalizeInventoryRequirementItemName(diagnosticItemName)

  if (
    normalizedDiagnostic === normalizedRequirement
    || normalizedDiagnostic.includes(normalizedRequirement)
    || normalizedRequirement.includes(normalizedDiagnostic)
  ) {
    return true
  }

  // NOTICE: Inventory-only stick/table crafts also mutate the remaining plank total,
  // so a recent sync mismatch on those outputs can still justify consuming the
  // tracked plank remainder as an intermediate input. Final tool success is still
  // gated on actual inventory visibility via `hasCraftedToolConfirmation`.
  if (normalizedRequirement === 'planks') {
    return normalizedDiagnostic === 'stick' || normalizedDiagnostic === 'crafting_table'
  }

  return false
}

function canProceedWithTrackedInventoryRequirements(
  mineflayer: Mineflayer,
  requirements: ActualInventoryRequirement[],
  context: string,
): boolean {
  const diagnostic = getLastCraftRecipeDiagnostic(mineflayer)
  if (!diagnostic?.inventoryOnly) {
    return false
  }

  if (Date.now() - diagnostic.at > 15_000) {
    return false
  }

  let reliedOnOptimisticInputs = false

  for (const requirement of requirements) {
    const trackedCount = getItemCount(mineflayer, requirement.itemName)
    if (trackedCount < requirement.minCount) {
      return false
    }

    const actualCount = getActualItemCount(mineflayer, requirement.itemName)
    if (actualCount >= requirement.minCount) {
      continue
    }

    if (trackedCount <= actualCount) {
      return false
    }

    if (!doesRecentInventoryOnlyCraftSupportRequirement(requirement.itemName, diagnostic.itemName)) {
      return false
    }

    reliedOnOptimisticInputs = true
  }

  if (!reliedOnOptimisticInputs) {
    return false
  }

  logger.warn(
    `Bot: ${context} inputs are only visible in optimistic inventory state, `
    + 'and tracked-only craft inputs are now rejected until the local inventory catches up.',
  )
  return false
}

function hasRecentInventoryOnlyCraftMismatchForRequirements(
  mineflayer: Mineflayer,
  requirements: ActualInventoryRequirement[],
): boolean {
  const diagnostic = getLastCraftRecipeDiagnostic(mineflayer)
  if (!diagnostic?.inventoryOnly) {
    return false
  }

  if (Date.now() - diagnostic.at > 15_000) {
    return false
  }

  return requirements.some(requirement =>
    doesRecentInventoryOnlyCraftSupportRequirement(requirement.itemName, diagnostic.itemName),
  )
}

function canProceedWithStableBridgeInventoryRequirements(
  mineflayer: Mineflayer,
  requirements: ActualInventoryRequirement[],
  context: string,
  stableInputsConfirmed: boolean,
): boolean {
  if (!stableInputsConfirmed) {
    return false
  }

  if (hasRecentInventoryOnlyCraftMismatchForRequirements(mineflayer, requirements)) {
    return false
  }

  logger.warn(
    `Bot: ${context} inputs are stable in bridge inventory; proceeding even though local inventory visibility is still catching up.`,
  )
  return true
}

function requiresStrictVisibleCraftInputs(requirements: ActualInventoryRequirement[]): boolean {
  return requirements.some(requirement =>
    requirement.itemName.replace(/^minecraft:/, '') === 'stick',
  )
}

function acceptOptimisticCraftConfirmation(
  mineflayer: Mineflayer,
  itemName: string,
  _minCount: number,
  context: string,
): boolean {
  const aliases = new Set<string>([itemName])
  if (itemName.endsWith('_pickaxe')) {
    aliases.add('pickaxe')
  }
  else if (itemName.endsWith('_axe')) {
    aliases.add('axe')
  }
  else if (itemName.endsWith('_shovel')) {
    aliases.add('shovel')
  }
  else if (itemName.endsWith('_sword')) {
    aliases.add('sword')
  }
  else if (itemName.endsWith('_hoe')) {
    aliases.add('hoe')
  }

  const aliasList = [...aliases]
  if (!hasRecentBridgeCraftSyncMismatch(mineflayer, aliasList)) {
    return false
  }

  logger.warn(
    `Bot: Refusing ${context} from optimistic inventory state `
    + `because ${itemName} is not actually visible yet and false-positive craft confirmations are disabled.`,
  )
  return false
}

function hasCraftedToolConfirmation(
  mineflayer: Mineflayer,
  crafted: boolean,
  itemName: string,
  toolType: ToolType,
  quantity: number,
  context: string,
): boolean {
  if (!crafted) {
    return false
  }

  if (hasActualToolAccess(mineflayer, toolType, quantity)) {
    return true
  }

  if (acceptOptimisticCraftConfirmation(mineflayer, itemName, quantity, context)) {
    return true
  }

  if (hasRecentBridgeCraftSyncMismatch(mineflayer, [itemName])) {
    logger.warn(
      `Bot: Refusing ${context} from recent craft-sync mismatch diagnostic `
      + `because ${itemName} is not actually visible yet and false-positive craft confirmations are disabled.`,
    )
  }

  return false
}

function inCooldown(lastAt: number, cooldownMs: number): boolean {
  if (lastAt <= 0) {
    return false
  }

  return Date.now() - lastAt < cooldownMs
}

function cooldownRemainingMs(lastAt: number, cooldownMs: number): number {
  return Math.max(0, cooldownMs - (Date.now() - lastAt))
}

async function waitForCountIncrease(
  readCount: () => number,
  baseline: number,
  attempts: number = 5,
  delayMs: number = 150,
): Promise<number> {
  let count = readCount()
  if (count > baseline) {
    return count
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(delayMs)
    count = readCount()
    if (count > baseline) {
      return count
    }
  }

  return count
}

function countSnapshotItems(snapshotItems: Array<{ name: string, count: number }>, itemName: string): number {
  const normalizedQuery = itemName.replace(/^minecraft:/, '').trim().toLowerCase()
  return snapshotItems
    .filter(item => item.name.replace(/^minecraft:/, '').trim().toLowerCase().includes(normalizedQuery))
    .reduce((sum, item) => sum + item.count, 0)
}

function getCanonicalInventoryItemsForActualChecks(mineflayer: Mineflayer): Array<{ name: string, count: number, slot?: number }> {
  const bot = mineflayer.bot as typeof mineflayer.bot & {
    getCanonicalInventorySnapshot?: () => CanonicalInventorySnapshotLike
  }
  if (typeof bot.getCanonicalInventorySnapshot !== 'function') {
    return []
  }

  const snapshot = bot.getCanonicalInventorySnapshot()
  const bySlot = new Map<string, { name: string, count: number, slot?: number }>()
  const addSlot = (slot: CanonicalInventorySlotLike | null | undefined, fallbackKey: string): void => {
    if (!slot?.itemName || (slot.count ?? 0) <= 0) {
      return
    }

    const key = typeof slot.slotIndex === 'number'
      ? `slot:${slot.slotIndex}`
      : fallbackKey
    bySlot.set(key, {
      name: slot.itemName,
      count: slot.count ?? 1,
      ...(typeof slot.slotIndex === 'number' ? { slot: slot.slotIndex } : {}),
    })
  }

  for (const slot of snapshot.slots ?? []) {
    addSlot(slot, `slotless:${bySlot.size}`)
  }
  addSlot(snapshot.heldItem, 'held')
  addSlot(snapshot.offhand, 'offhand')
  for (const slot of snapshot.armor ?? []) {
    addSlot(slot, `armor:${bySlot.size}`)
  }

  return [...bySlot.values()]
}

function getVisibleActualItemCount(mineflayer: Mineflayer, itemName: string): number {
  return Math.max(
    getActualItemCount(mineflayer, itemName),
    countSnapshotItems(getVisibleInventoryItemsForActualChecks(mineflayer), itemName),
  )
}

async function confirmStableActualInventoryRequirements(
  mineflayer: Mineflayer,
  requirements: ActualInventoryRequirement[],
  context: string,
  attempts: number = 6,
  delayMs: number = 200,
  consecutiveSuccessesNeeded: number = 2,
): Promise<boolean> {
  let consecutiveSuccesses = 0

  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await getBridgeInventorySnapshot(mineflayer)
    const requirementsMet = requirements.every((requirement) => {
      const count = snapshot
        ? Math.max(
            countSnapshotItems(snapshot, requirement.itemName),
            getVisibleActualItemCount(mineflayer, requirement.itemName),
          )
        : getVisibleActualItemCount(mineflayer, requirement.itemName)
      return count >= requirement.minCount
    })

    if (requirementsMet) {
      consecutiveSuccesses++
      if (consecutiveSuccesses >= consecutiveSuccessesNeeded) {
        return true
      }
    }
    else {
      consecutiveSuccesses = 0
    }

    if (attempt < attempts - 1) {
      await refreshInventoryState(mineflayer)
      await sleep(delayMs)
    }
  }

  logger.warn(`Bot: ${context} inputs are not stable in bridge inventory yet.`)
  return false
}

async function confirmVisibleLocalInventoryRequirements(
  mineflayer: Mineflayer,
  requirements: ActualInventoryRequirement[],
  context: string,
  attempts: number = 8,
  delayMs: number = 200,
  consecutiveSuccessesNeeded: number = 2,
): Promise<boolean> {
  let consecutiveSuccesses = 0

  for (let attempt = 0; attempt < attempts; attempt++) {
    const requirementsMet = requirements.every(requirement =>
      Math.max(
        getStrictVisibleItemCount(mineflayer, requirement.itemName),
        countSnapshotItems(
          getCanonicalInventoryItemsForActualChecks(mineflayer),
          requirement.itemName,
        ),
      ) >= requirement.minCount,
    )

    if (requirementsMet) {
      consecutiveSuccesses++
      if (consecutiveSuccesses >= consecutiveSuccessesNeeded) {
        return true
      }
    }
    else {
      consecutiveSuccesses = 0
    }

    if (attempt < attempts - 1) {
      await refreshInventoryState(mineflayer)
      await sleep(delayMs)
    }
  }

  logger.warn(`Bot: ${context} inputs are not visible in local inventory yet.`)
  return false
}

function getLogsCount(mineflayer: Mineflayer): number {
  return getVisibleInventoryItemsForActualChecks(mineflayer)
    .filter(item => isWoodFuelItemName(item.name))
    .reduce((acc, item) => acc + item.count, 0)
}

function getPlanksCount(mineflayer: Mineflayer): number {
  return getVisibleInventoryItemsForActualChecks(mineflayer)
    .filter(item => item.name.includes('planks'))
    .reduce((acc, item) => acc + item.count, 0)
}

interface PickaxeRecoverySnapshot {
  logs: number
  planks: number
  sticks: number
  craftingTables: number
  toolCount: number
  toolRank: number
}

function getPickaxeRecoverySnapshot(mineflayer: Mineflayer): PickaxeRecoverySnapshot {
  return {
    logs: getLogsCount(mineflayer),
    planks: getPlanksCount(mineflayer),
    sticks: getVisibleActualItemCount(mineflayer, 'stick'),
    craftingTables: getVisibleActualItemCount(mineflayer, 'crafting_table'),
    toolCount: getActualToolCount(mineflayer, 'pickaxe'),
    toolRank: getBestToolRank(mineflayer, 'pickaxe'),
  }
}

function hasNearbyDroppedItem(mineflayer: Mineflayer, distance: number = PICKAXE_DROP_RECOVERY_DISTANCE): boolean {
  if (typeof mineflayer.bot.nearestEntity !== 'function') {
    return false
  }

  const nearestItem = mineflayer.bot.nearestEntity((entity: any) => {
    if (!entity || entity.name !== 'item') {
      return false
    }

    if ('onGround' in entity && entity.onGround === false) {
      return false
    }

    const entityDistance = typeof entity.distance === 'number'
      ? entity.distance
      : mineflayer.bot.entity?.position && entity.position && typeof entity.position.distanceTo === 'function'
        ? mineflayer.bot.entity.position.distanceTo(entity.position)
        : Infinity

    return entityDistance <= distance
  })

  return Boolean(nearestItem)
}

async function recoverPickaxeInputsFromNearbyDrops(
  mineflayer: Mineflayer,
  quantity: number,
): Promise<boolean> {
  if (!hasNearbyDroppedItem(mineflayer)) {
    return false
  }

  const before = getPickaxeRecoverySnapshot(mineflayer)
  logger.withFields({
    distance: PICKAXE_DROP_RECOVERY_DISTANCE,
    before,
  }).log('Bot: Attempting nearby dropped-item recovery before wood fallback for pickaxe ensure.')

  await pickupNearbyItems(mineflayer, PICKAXE_DROP_RECOVERY_DISTANCE)
  await refreshInventoryState(mineflayer)

  const after = getPickaxeRecoverySnapshot(mineflayer)
  if (hasActualToolAccess(mineflayer, 'pickaxe', quantity)) {
    logger.withFields({ after }).log('Bot: Nearby dropped-item recovery restored direct pickaxe access.')
    return true
  }

  const recoveredInputs = after.logs > before.logs
    || after.planks > before.planks
    || after.sticks > before.sticks
    || after.craftingTables > before.craftingTables
    || after.toolRank > before.toolRank

  if (!recoveredInputs) {
    logger.withFields({ after }).log('Bot: Nearby dropped-item recovery did not change pickaxe inputs.')
    return false
  }

  logger.withFields({ after }).log('Bot: Nearby dropped-item recovery found pickaxe inputs; retrying deterministic tool ensure.')
  return await ensureTool(mineflayer, 'pickaxe', quantity)
}

function isWoodFuelItemName(itemName: string): boolean {
  return itemName.endsWith('_log')
    || itemName.endsWith('_wood')
    || itemName.endsWith('_stem')
    || itemName.endsWith('_hyphae')
    || itemName === 'bamboo'
    || itemName === 'bamboo_block'
}

function getCoalLikeFuelCount(mineflayer: Mineflayer): number {
  return getItemCount(mineflayer, 'coal') + getItemCount(mineflayer, 'charcoal')
}

function isCharcoalSourceItemName(itemName: string): boolean {
  return itemName.endsWith('_log')
    || itemName.endsWith('_wood')
    || itemName.endsWith('_stem')
    || itemName.endsWith('_hyphae')
}

function getCharcoalSourceCount(mineflayer: Mineflayer): number {
  return mineflayer.bot.inventory
    .items()
    .filter(item => isCharcoalSourceItemName(item.name))
    .reduce((acc, item) => acc + item.count, 0)
}

function getCharcoalFallbackLogTarget(mineflayer: Mineflayer, coalShortage: number): number {
  if (coalShortage <= 0) {
    return getCharcoalSourceCount(mineflayer)
  }

  // NOTICE: Keep this aligned with skills/crafting.ts `isCharcoalSourceItemName`
  // and `getFuelBurnCapacity`, where wood-like fuel smelts 1.5 items. Charcoal
  // fallback needs enough log-like blocks for both furnace input and furnace fuel.
  const requiredFuelLogs = Math.ceil(coalShortage / WOOD_FUEL_SMELTS_PER_ITEM)
  return Math.max(
    getCharcoalSourceCount(mineflayer),
    coalShortage + requiredFuelLogs,
  )
}

function getToolStickRequirement(toolType: ToolType): number {
  switch (toolType) {
    case 'sword':
      return 1
    case 'pickaxe':
    case 'axe':
    case 'shovel':
    case 'hoe':
      return 2
    default:
      return 0
  }
}

function getMaterialIngredientItemName(material: MaterialType): string {
  switch (material) {
    case 'diamond':
      return 'diamond'
    case 'golden':
      return 'gold_ingot'
    case 'iron':
      return 'iron_ingot'
    case 'stone':
      return 'cobblestone'
    case 'wooden':
      return 'planks'
    default:
      return material
  }
}

function getToolCraftRequirements(
  material: MaterialType,
  toolType: ToolType,
  materialCount: number,
): ActualInventoryRequirement[] {
  const requirements: ActualInventoryRequirement[] = [{
    itemName: getMaterialIngredientItemName(material),
    minCount: materialCount,
  }]
  const stickRequirement = getToolStickRequirement(toolType)
  if (stickRequirement > 0) {
    requirements.push({
      itemName: 'stick',
      minCount: stickRequirement,
    })
  }

  return requirements
}

async function getRequiredPlanksForWoodenTool(
  mineflayer: Mineflayer,
  toolType: ToolType,
): Promise<number> {
  const materialPlanks = materialsForTool(toolType)
  const stickRequirement = getToolStickRequirement(toolType)
  const actualStickCount = getVisibleActualItemCount(mineflayer, 'stick')
  const missingSticks = Math.max(0, stickRequirement - actualStickCount)
  const stickPlanks = Math.ceil(missingSticks / 4) * 2
  const hasCraftingTableAccess = getVisibleActualItemCount(mineflayer, 'crafting_table') > 0
    || await hasNearbyPlacedCraftingTable(mineflayer)
  const craftingTablePlanks = hasCraftingTableAccess ? 0 : 4

  return materialPlanks + stickPlanks + craftingTablePlanks
}

async function getSelectedCraftRequirements(
  mineflayer: Mineflayer,
  itemName: string,
  num: number,
): Promise<ActualInventoryRequirement[] | null> {
  const requirements = await getSelectedCraftRecipeRequirements(mineflayer, itemName, num)
  if (!requirements || requirements.length <= 0) {
    return null
  }

  return requirements.map(requirement => ({
    itemName: requirement.itemName,
    minCount: requirement.count,
  }))
}

async function trySmeltCharcoalFuel(mineflayer: Mineflayer, neededAmount: number): Promise<boolean> {
  if (getCoalLikeFuelCount(mineflayer) >= neededAmount) {
    return true
  }

  const hasFuelSource = mineflayer.bot.inventory.items().some(item => isWoodFuelItemName(item.name) && item.count > 0)
  if (!hasFuelSource) {
    return false
  }

  const furnaceEnsured = await ensureFurnaces(mineflayer, 1)
  if (!furnaceEnsured) {
    return false
  }

  for (let round = 0; round < 4 && getCoalLikeFuelCount(mineflayer) < neededAmount; round++) {
    const sourceItems = mineflayer.bot.inventory
      .items()
      .filter(item => isWoodFuelItemName(item.name) && item.count > 0)
      .sort((left, right) => right.count - left.count)

    let progressed = false
    for (const sourceItem of sourceItems) {
      const fuelShortage = neededAmount - getCoalLikeFuelCount(mineflayer)
      if (fuelShortage <= 0) {
        return true
      }

      const attemptCounts = [...new Set([
        Math.min(sourceItem.count, fuelShortage),
        1,
      ].filter(count => count > 0))]

      for (const count of attemptCounts) {
        const smelted = await smeltItem(mineflayer, sourceItem.name, count)
        if (!smelted) {
          continue
        }

        await refreshInventoryState(mineflayer)
        progressed = true
        if (getCoalLikeFuelCount(mineflayer) >= neededAmount) {
          return true
        }
        break
      }

      if (progressed) {
        break
      }
    }

    if (!progressed) {
      break
    }
  }

  return getCoalLikeFuelCount(mineflayer) >= neededAmount
}

interface PlankCraftCandidate {
  sourceName: string
  plankName: string
  count: number
}

interface TorchCraftDiscardRule {
  itemName: string
  keep: number
  drop: number
}

const TORCH_CRAFT_DISCARD_RULES: TorchCraftDiscardRule[] = [
  { itemName: 'rotten_flesh', keep: 0, drop: 64 },
  { itemName: 'dirt', keep: 16, drop: 64 },
  { itemName: 'gravel', keep: 16, drop: 64 },
  { itemName: 'cobblestone', keep: 160, drop: 64 },
  { itemName: 'cobbled_deepslate', keep: 160, drop: 64 },
  { itemName: 'andesite', keep: 16, drop: 64 },
  { itemName: 'diorite', keep: 16, drop: 64 },
  { itemName: 'granite', keep: 16, drop: 64 },
  { itemName: 'tuff', keep: 16, drop: 64 },
  { itemName: 'deepslate', keep: 16, drop: 64 },
  { itemName: 'crafting_table', keep: 1, drop: 8 },
  { itemName: 'furnace', keep: 1, drop: 8 },
]

const STARTER_PICKAXE_RECOVERY_DISCARD_RULES: TorchCraftDiscardRule[] = [
  { itemName: 'rotten_flesh', keep: 0, drop: 64 },
  { itemName: 'dirt', keep: 8, drop: 64 },
  { itemName: 'gravel', keep: 8, drop: 64 },
  { itemName: 'andesite', keep: 8, drop: 64 },
  { itemName: 'diorite', keep: 8, drop: 64 },
  { itemName: 'granite', keep: 8, drop: 64 },
  { itemName: 'tuff', keep: 8, drop: 64 },
  { itemName: 'deepslate', keep: 8, drop: 64 },
  // Keep a minimum stone stock, but allow dropping one full stack to unblock wood recovery.
  { itemName: 'cobblestone', keep: 64, drop: 64 },
  { itemName: 'cobbled_deepslate', keep: 64, drop: 64 },
]

function getMainInventoryFreeSlotCount(mineflayer: Mineflayer): number {
  const inventory = mineflayer.bot.inventory as typeof mineflayer.bot.inventory & {
    emptySlotCount?: () => number
  }
  if (typeof inventory.emptySlotCount === 'function') {
    return inventory.emptySlotCount()
  }

  const slots = mineflayer.bot.inventory?.slots ?? []
  if (slots.length >= 46) {
    return slots.slice(9, 45).filter(slot => !slot).length
  }

  const totalSlots = Math.max(0, slots.length)
  const usedSlots = mineflayer.bot.inventory.items().length
  return Math.max(0, totalSlots - usedSlots)
}

function hasInventoryStackRoomForItem(mineflayer: Mineflayer, itemName: string): boolean {
  return mineflayer.bot.inventory.items().some((item) => {
    const stackLimit = item.stackSize ?? 64
    return item.name === itemName && item.count < stackLimit
  })
}

async function ensureTorchCraftInventoryCapacity(mineflayer: Mineflayer): Promise<boolean> {
  if (getMainInventoryFreeSlotCount(mineflayer) > 0 || hasInventoryStackRoomForItem(mineflayer, 'torch')) {
    return true
  }

  for (const rule of TORCH_CRAFT_DISCARD_RULES) {
    const count = getActualItemCount(mineflayer, rule.itemName)
    if (count <= rule.keep) {
      continue
    }

    const dropAmount = Math.min(rule.drop, count - rule.keep)
    if (dropAmount <= 0) {
      continue
    }

    logger.withFields({
      itemName: rule.itemName,
      countBefore: count,
      dropAmount,
      keep: rule.keep,
    }).warn('Bot: Inventory is full before torch crafting, discarding low-priority items to free a slot.')

    await discard(mineflayer, rule.itemName, dropAmount)
    await refreshInventoryState(mineflayer)
    if (getMainInventoryFreeSlotCount(mineflayer) > 0 || hasInventoryStackRoomForItem(mineflayer, 'torch')) {
      return true
    }
  }

  return false
}

async function ensureStarterPickaxeRecoveryInventoryCapacity(mineflayer: Mineflayer): Promise<boolean> {
  if (getMainInventoryFreeSlotCount(mineflayer) > 0) {
    return true
  }

  for (const rule of STARTER_PICKAXE_RECOVERY_DISCARD_RULES) {
    const count = getActualItemCount(mineflayer, rule.itemName)
    if (count <= rule.keep) {
      continue
    }

    const dropAmount = Math.min(rule.drop, count - rule.keep)
    if (dropAmount <= 0) {
      continue
    }

    logger.withFields({
      itemName: rule.itemName,
      countBefore: count,
      dropAmount,
      keep: rule.keep,
    }).warn('Bot: Inventory is full while recovering starter pickaxe materials, discarding low-priority items to free a slot.')

    await discard(mineflayer, rule.itemName, dropAmount)
    await refreshInventoryState(mineflayer)
    if (getMainInventoryFreeSlotCount(mineflayer) > 0) {
      return true
    }
  }

  return false
}

function toPlankName(sourceItemName: string): string | null {
  if (sourceItemName.endsWith('_log')) {
    return `${sourceItemName.replace(/_log$/, '')}_planks`
  }
  if (sourceItemName.endsWith('_wood')) {
    return `${sourceItemName.replace(/_wood$/, '')}_planks`
  }
  if (sourceItemName.endsWith('_stem')) {
    return `${sourceItemName.replace(/_stem$/, '')}_planks`
  }
  if (sourceItemName === 'crimson_hyphae') {
    return 'crimson_planks'
  }
  if (sourceItemName === 'warped_hyphae') {
    return 'warped_planks'
  }
  if (sourceItemName === 'bamboo' || sourceItemName === 'bamboo_block') {
    return 'bamboo_planks'
  }

  return null
}

function toPlankSourceNames(plankName: string): string[] {
  if (!plankName.endsWith('_planks')) {
    return []
  }

  const material = plankName.replace(/_planks$/, '')
  if (material === 'crimson' || material === 'warped') {
    return [`${material}_stem`, `${material}_hyphae`]
  }

  if (material === 'bamboo') {
    return ['bamboo', 'bamboo_block']
  }

  return [`${material}_log`, `${material}_wood`]
}

function getPreferredWoodGatherTypeForPlank(plankName: string): string | null {
  const sourceNames = toPlankSourceNames(plankName)
  return sourceNames.find(sourceName =>
    sourceName.endsWith('_log')
    || sourceName.endsWith('_stem')
    || sourceName === 'bamboo',
  ) ?? sourceNames[0] ?? null
}

function getPlankCraftCandidates(mineflayer: Mineflayer): PlankCraftCandidate[] {
  return getVisibleInventoryItemsForActualChecks(mineflayer)
    .map((item) => {
      const plankName = toPlankName(item.name)
      if (!plankName) {
        return null
      }
      return {
        sourceName: item.name,
        plankName,
        count: item.count,
      }
    })
    .filter((item): item is PlankCraftCandidate => Boolean(item))
}

function getSpecificPlankCraftCandidates(
  mineflayer: Mineflayer,
  plankName: string,
): PlankCraftCandidate[] {
  return getPlankCraftCandidates(mineflayer)
    .filter(candidate => candidate.plankName === plankName)
}

function getPlankSourceCount(mineflayer: Mineflayer, plankName: string): number {
  const sourceNames = new Set(toPlankSourceNames(plankName))
  if (sourceNames.size <= 0) {
    return 0
  }

  return getVisibleInventoryItemsForActualChecks(mineflayer)
    .filter(item => sourceNames.has(item.name))
    .reduce((sum, item) => sum + item.count, 0)
}

async function ensureSpecificPlanks(
  mineflayer: Mineflayer,
  plankName: string,
  neededAmount: number,
): Promise<boolean> {
  logger.log(`Bot: Checking for ${plankName}...`)

  await refreshInventoryState(mineflayer)
  let plankCount = getVisibleActualItemCount(mineflayer, plankName)
  if (plankCount >= neededAmount) {
    logger.log(`Bot: Have enough ${plankName}.`)
    return true
  }

  for (let attempt = 0; attempt < MAX_PLANK_ATTEMPTS && plankCount < neededAmount; attempt++) {
    const shortfall = neededAmount - plankCount
    const recipeCraftCount = Math.max(1, Math.ceil(shortfall / PLANKS_PER_LOG))
    const exactSources = getSpecificPlankCraftCandidates(mineflayer, plankName)

    if (exactSources.length <= 0) {
      const gatherWoodType = getPreferredWoodGatherTypeForPlank(plankName)
      if (!gatherWoodType) {
        logger.warn(`Bot: Could not determine a wood source for ${plankName}.`)
        return false
      }

      const sourceCountBefore = getPlankSourceCount(mineflayer, plankName)
      logger.warn(`Bot: No ${plankName} source material in inventory, gathering ${gatherWoodType}...`)
      await gatherWood(mineflayer, recipeCraftCount, 80, gatherWoodType)
      await refreshInventoryState(mineflayer)
      const sourceCountAfter = getPlankSourceCount(mineflayer, plankName)
      if (sourceCountAfter <= sourceCountBefore) {
        logger.warn(`Bot: gatherWood did not add ${plankName} source material.`)
        return false
      }
      plankCount = getVisibleActualItemCount(mineflayer, plankName)
      continue
    }

    const source = [...exactSources].sort((left, right) => right.count - left.count)[0]
    if (!source) {
      break
    }

    const craftCount = Math.min(source.count, recipeCraftCount)
    logger.log(`Trying to make ${craftCount * PLANKS_PER_LOG} ${plankName} from ${source.sourceName}`)

    const crafted = await craftRecipe(mineflayer, plankName, craftCount)
    if (!crafted) {
      logger.warn(`Bot: Failed to craft ${plankName} from ${source.sourceName}.`)
      await sleep(RETRY_DELAY_MS)
      continue
    }

    await refreshInventoryState(mineflayer)
    plankCount = getVisibleActualItemCount(mineflayer, plankName)
  }

  if (plankCount < neededAmount) {
    logger.warn(`Bot: Could not ensure ${neededAmount} ${plankName}.`)
  }

  return plankCount >= neededAmount
}

// Helper function to ensure a crafting table
export async function ensureCraftingTable(
  mineflayer: Mineflayer,
  options?: { requirePortable?: boolean },
): Promise<boolean> {
  logger.log('Bot: Checking for a crafting table...')

  await refreshInventoryState(mineflayer)
  const hasNearbyTable = await hasReachablePlacedCraftingTable(mineflayer)
  if (hasNearbyTable && !options?.requirePortable) {
    logger.log('Bot: Reachable placed crafting table is available.')
    lastCraftingTableFailureAt = 0
    return true
  }

  if (inCooldown(lastCraftingTableFailureAt, CRAFTING_TABLE_FAILURE_COOLDOWN_MS)) {
    logger.withFields({
      remainingMs: cooldownRemainingMs(lastCraftingTableFailureAt, CRAFTING_TABLE_FAILURE_COOLDOWN_MS),
    }).warn('Bot: Skipping crafting table ensure due to recent failure cooldown.')
    return false
  }

  let hasCraftingTable = getVisibleActualItemCount(mineflayer, 'crafting_table') > 0
  let attempts = 0

  if (hasCraftingTable) {
    logger.log('Bot: Crafting table is available.')
    lastCraftingTableFailureAt = 0
    return true
  }

  while (!hasCraftingTable && attempts < MAX_CRAFTING_TABLE_ATTEMPTS) {
    attempts++
    const planksEnsured = await ensurePlanks(mineflayer, 4)
    if (!planksEnsured) {
      logger.error('Bot: Failed to ensure planks.')
      break
    }

    // Craft crafting table
    const crafted = await craftRecipe(mineflayer, 'crafting_table', 1)
    hasCraftingTable = false
    if (crafted) {
      hasCraftingTable = await confirmItemCount(mineflayer, 'crafting_table', 1, {
        attempts: 5,
        delayMs: 200,
        refresh: true,
        actualOnly: true,
        localVisibleOnly: true,
      })

      if (!hasCraftingTable) {
        const nearbyAfterCraft = await hasNearbyPlacedCraftingTable(mineflayer)
        if (nearbyAfterCraft) {
          hasCraftingTable = true
        }
      }

      if (!hasCraftingTable) {
        hasCraftingTable = acceptOptimisticCraftConfirmation(
          mineflayer,
          'crafting_table',
          1,
          'crafting table ensure',
        )
      }
    }
    if (hasCraftingTable) {
      mineflayer.bot.chat('I have made a crafting table.')
      logger.log('Bot: Crafting table crafted.')
    }
    else {
      logger.error('Bot: Failed to confirm crafted crafting table in inventory.')
      logCraftConfirmationMismatch('crafting_table')
      if (hasRecentBridgeCraftSyncMismatch(mineflayer, ['crafting_table'])) {
        break
      }
      await sleep(RETRY_DELAY_MS)
    }
  }

  if (!hasCraftingTable) {
    lastCraftingTableFailureAt = Date.now()
    logger.error(`Bot: Could not ensure crafting table after ${MAX_CRAFTING_TABLE_ATTEMPTS} attempts.`)
  }
  else {
    lastCraftingTableFailureAt = 0
  }

  return hasCraftingTable
}

// Helper function to ensure a specific amount of planks
export async function ensurePlanks(mineflayer: Mineflayer, neededAmount: number): Promise<boolean> {
  logger.log('Bot: Checking for planks...')

  let planksCount = getPlanksCount(mineflayer)
  let attempts = 0

  if (neededAmount <= planksCount) {
    logger.log('Bot: Have enough planks.')
    lastPlankFailureAt = 0
    return true
  }

  if (inCooldown(lastPlankFailureAt, PLANK_FAILURE_COOLDOWN_MS)) {
    logger.withFields({
      remainingMs: cooldownRemainingMs(lastPlankFailureAt, PLANK_FAILURE_COOLDOWN_MS),
    }).warn('Bot: Skipping plank crafting due to recent failure cooldown.')
    return false
  }

  while (neededAmount > planksCount && attempts < MAX_PLANK_ATTEMPTS) {
    attempts++
    const logsNeeded = Math.ceil((neededAmount - planksCount) / PLANKS_PER_LOG)
    const planksBeforeAttempt = planksCount

    // Get all available plank-craftable source items in inventory
    const plankSources = getPlankCraftCandidates(mineflayer)

    // If no source materials available, gather more wood
    if (plankSources.length === 0) {
      const logsBefore = getLogsCount(mineflayer)
      logger.warn('Bot: No plank source material in inventory, gathering wood...')
      await gatherWood(mineflayer, logsNeeded, 80)
      const logsAfter = getLogsCount(mineflayer)
      if (logsAfter <= logsBefore) {
        lastPlankFailureAt = Date.now()
        logger.warn('Bot: gatherWood did not add plank source material, aborting ensurePlanks early.')
        return false
      }
      planksCount = getPlanksCount(mineflayer)
      await sleep(RETRY_DELAY_MS)
      continue
    }

    // Iterate over each source material and try crafting planks
    for (const source of plankSources) {
      const recipeCraftCount = Math.min(
        source.count,
        Math.ceil((neededAmount - planksCount) / PLANKS_PER_LOG),
      )
      const planksToCraft = recipeCraftCount * PLANKS_PER_LOG
      if (recipeCraftCount <= 0 || planksToCraft <= 0) {
        continue
      }

      logger.log(
        `Trying to make ${planksToCraft} ${source.plankName} from ${source.sourceName}`,
      )
      logger.log(`NeededAmount: ${neededAmount}, while I have ${planksCount}`)

      const crafted = await craftRecipe(
        mineflayer,
        source.plankName,
        recipeCraftCount,
      )
      if (crafted) {
        const optimisticPlanksAfterCraft = planksBeforeAttempt + planksToCraft
        const syncedPlanksCount = await waitForCountIncrease(() => getPlanksCount(mineflayer), planksBeforeAttempt)
        if (syncedPlanksCount >= optimisticPlanksAfterCraft) {
          planksCount = syncedPlanksCount
        }
        else if (syncedPlanksCount > planksBeforeAttempt) {
          // NOTICE: FabricBridge can expose a partially stale inventory snapshot where the crafted
          // stack appears but its count is still behind the recipe output. Prefer the confirmed
          // recipe yield so we do not loop crafting the same planks again.
          planksCount = optimisticPlanksAfterCraft
        }
        else {
          // NOTICE: FabricBridge inventory push can lag behind a successful craft response.
          // We already know the craft RPC succeeded, so advance the local progress estimate
          // to avoid re-crafting the same planks indefinitely while the inventory snapshot catches up.
          planksCount += planksToCraft
        }
        recordOptimisticItem(source.plankName, planksCount)
        mineflayer.bot.chat(
          `I have crafted ${planksToCraft} planks.`,
        )
        logger.log(`Bot: ${source.plankName} crafted.`)
      }
      else {
        logger.warn(`Bot: Failed to craft ${source.plankName} from ${source.sourceName}. Trying other sources if available.`)
        await sleep(RETRY_DELAY_MS)
      }

      // Check if we have enough planks after crafting
      if (planksCount >= neededAmount)
        break
    }

    if (planksCount <= planksBeforeAttempt) {
      logger.warn('Bot: No plank progress in this attempt.')
      await sleep(RETRY_DELAY_MS)
    }
  }

  if (planksCount < neededAmount) {
    lastPlankFailureAt = Date.now()
    logger.error(`Bot: Could not ensure ${neededAmount} planks after ${MAX_PLANK_ATTEMPTS} attempts.`)
  }
  else {
    lastPlankFailureAt = 0
  }

  return planksCount >= neededAmount
};

// Helper function to ensure a specific amount of sticks
const MAX_STICK_ATTEMPTS = 4

export async function ensureSticks(mineflayer: Mineflayer, neededAmount: number): Promise<boolean> {
  logger.log('Bot: Checking for sticks...')

  await refreshInventoryState(mineflayer)
  let sticksCount = getVisibleActualItemCount(mineflayer, 'stick')

  if (neededAmount <= Math.max(sticksCount, getItemCount(mineflayer, 'stick'))) {
    const visibleStickCount = await confirmVisibleLocalInventoryRequirements(
      mineflayer,
      [{ itemName: 'stick', minCount: neededAmount }],
      'stick local inventory',
      5,
      200,
      1,
    )
    if (visibleStickCount) {
      logger.log('Bot: Have enough sticks.')
      return true
    }

    const bridgeStickCount = await confirmStableActualInventoryRequirements(
      mineflayer,
      [{ itemName: 'stick', minCount: neededAmount }],
      'stick bridge inventory',
      4,
      200,
      1,
    )
    if (canProceedWithStableBridgeInventoryRequirements(
      mineflayer,
      [{ itemName: 'stick', minCount: neededAmount }],
      'stick bridge inventory',
      bridgeStickCount,
    )) {
      logger.warn(
        'Bot: Stick count is bridge-confirmed but not yet visible in local inventory; waiting before treating sticks as confirmed.',
      )
      return false
    }

    if (hasUnconfirmedOptimisticInventoryLead(mineflayer, ['stick'])) {
      logger.warn(
        'Bot: Stick count is still only visible in tracked inventory state; waiting for local inventory sync before re-crafting sticks.',
      )
      return false
    }

    if (hasRecentBridgeCraftSyncMismatch(mineflayer, ['stick'])) {
      logger.warn(
        'Bot: Stick count is only present in optimistic inventory state; refusing to use it as a confirmed craft input.',
      )
      return false
    }

    sticksCount = getVisibleActualItemCount(mineflayer, 'stick')
  }

  let attempts = 0
  while (sticksCount < neededAmount && attempts < MAX_STICK_ATTEMPTS) {
    attempts++
    await refreshInventoryState(mineflayer)
    sticksCount = getVisibleActualItemCount(mineflayer, 'stick')
    if (Math.max(sticksCount, getItemCount(mineflayer, 'stick')) >= neededAmount) {
      const visibleStickCount = await confirmVisibleLocalInventoryRequirements(
        mineflayer,
        [{ itemName: 'stick', minCount: neededAmount }],
        'stick local inventory',
        4,
        200,
        1,
      )
      if (visibleStickCount) {
        logger.log('Bot: Have enough sticks.')
        return true
      }

      const bridgeStickCount = await confirmStableActualInventoryRequirements(
        mineflayer,
        [{ itemName: 'stick', minCount: neededAmount }],
        'stick bridge inventory',
        4,
        200,
        1,
      )
      if (canProceedWithStableBridgeInventoryRequirements(
        mineflayer,
        [{ itemName: 'stick', minCount: neededAmount }],
        'stick bridge inventory',
        bridgeStickCount,
      )) {
        logger.warn(
          'Bot: Stick count is bridge-confirmed but not yet visible in local inventory; waiting before treating sticks as confirmed.',
        )
        return false
      }

      if (hasUnconfirmedOptimisticInventoryLead(mineflayer, ['stick'])) {
        logger.warn(
          'Bot: Stick count is still only visible in tracked inventory state; waiting for local inventory sync before re-crafting sticks.',
        )
        return false
      }
    }

    const planksCount = Math.max(
      getVisibleActualItemCount(mineflayer, 'planks'),
      getItemCount(mineflayer, 'planks'),
    )
    const planksNeeded = Math.max(
      Math.ceil((neededAmount - sticksCount) / STICKS_PER_PLANK),
      2,
    )

    if (planksCount >= planksNeeded) {
      try {
        const craftCount = Math.max(1, Math.ceil((neededAmount - sticksCount) / 4))
        const crafted = await craftRecipe(mineflayer, 'stick', craftCount)
        if (!crafted) {
          logger.error('Bot: Failed to craft sticks.')
          return false
        }

        const confirmed = await confirmItemCount(mineflayer, 'stick', neededAmount, {
          attempts: 5,
          delayMs: 200,
          actualOnly: true,
          localVisibleOnly: true,
        })
        const accepted = confirmed || acceptOptimisticCraftConfirmation(
          mineflayer,
          'stick',
          neededAmount,
          'stick crafting',
        )
        if (!accepted) {
          logger.error('Bot: Stick craft reported success but inventory is still empty after refresh.')
          logCraftConfirmationMismatch('stick')
          return false
        }
        sticksCount = Math.max(
          neededAmount,
          getVisibleActualItemCount(mineflayer, 'stick'),
          getItemCount(mineflayer, 'stick'),
        )
        mineflayer.bot.chat(`I now have ${sticksCount} sticks.`)
        logger.log(`Bot: Sticks crafted.`)
      }
      catch (err) {
        logger.withError(err).error('Bot: Failed to craft sticks.')
        return false
      }
    }
    else {
      const planksEnsured = await ensurePlanks(mineflayer, planksNeeded)
      if (!planksEnsured) {
        logger.error('Bot: Not enough planks for sticks.')
        return false
      }
    }
  }

  return sticksCount >= neededAmount
}

// Ensure a specific number of chests
const MAX_CHEST_ATTEMPTS = 4

export async function ensureChests(mineflayer: Mineflayer, quantity: number = 1): Promise<boolean> {
  logger.log(`Bot: Checking for ${quantity} chest(s)...`)

  // Count the number of chests the bot already has
  let chestCount = getItemCount(mineflayer, 'chest')

  if (chestCount >= quantity) {
    logger.log(`Bot: Already has ${quantity} or more chest(s).`)
    return true
  }

  let attempts = 0
  while (chestCount < quantity && attempts < MAX_CHEST_ATTEMPTS) {
    attempts++
    const planksEnsured = await ensurePlanks(mineflayer, 8 * (quantity - chestCount)) // 8 planks per chest
    if (!planksEnsured) {
      logger.error('Bot: Failed to ensure planks for chest(s).')
      return false
    }

    // Craft the chest(s)
    const crafted = await craftRecipe(mineflayer, 'chest', quantity - chestCount)
    if (crafted) {
      chestCount = getItemCount(mineflayer, 'chest')
      mineflayer.bot.chat(`I have crafted ${quantity} chest(s).`)
      logger.log(`Bot: ${quantity} chest(s) crafted.`)
    }
    else {
      logger.error('Bot: Failed to craft chest(s).')
      await sleep(RETRY_DELAY_MS)
    }
  }
  return chestCount >= quantity
}

// Ensure a specific number of furnaces
const MAX_FURNACE_ATTEMPTS = 4

export async function ensureFurnaces(mineflayer: Mineflayer, quantity: number = 1): Promise<boolean> {
  logger.log(`Bot: Checking for ${quantity} furnace(s)...`)

  // Count the number of furnaces the bot already has
  let furnaceCount = getItemCount(mineflayer, 'furnace')

  if (furnaceCount >= quantity) {
    logger.log(`Bot: Already has ${quantity} or more furnace(s).`)
    return true
  }

  let attempts = 0
  while (furnaceCount < quantity && attempts < MAX_FURNACE_ATTEMPTS) {
    attempts++
    const stoneEnsured = await ensureCobblestone(mineflayer, 8 * (quantity - furnaceCount)) // 8 stone blocks per furnace
    if (!stoneEnsured) {
      logger.error('Bot: Failed to ensure stone for furnace(s).')
      return false
    }

    // Craft the furnace(s)
    const crafted = await craftRecipe(mineflayer, 'furnace', quantity - furnaceCount)
    if (crafted) {
      furnaceCount = getItemCount(mineflayer, 'furnace')
      mineflayer.bot.chat(`I have crafted ${quantity} furnace(s).`)
      logger.log(`Bot: ${quantity} furnace(s) crafted.`)
    }
    else {
      logger.error('Bot: Failed to craft furnace(s).')
      await sleep(RETRY_DELAY_MS)
    }
  }
  return furnaceCount >= quantity
}

// Ensure a specific number of torches
const MAX_TORCH_ATTEMPTS = 4

export async function ensureTorches(mineflayer: Mineflayer, quantity: number = 1): Promise<boolean> {
  logger.log(`Bot: Checking for ${quantity} torch(es)...`)

  // Count the number of torches the bot already has
  let torchCount = getItemCount(mineflayer, 'torch')

  if (torchCount >= quantity) {
    logger.log(`Bot: Already has ${quantity} or more torch(es).`)
    return true
  }

  let attempts = 0
  while (torchCount < quantity && attempts < MAX_TORCH_ATTEMPTS) {
    attempts++
    const torchesNeeded = quantity - torchCount
    const craftOperationsNeeded = Math.max(1, Math.ceil(torchesNeeded / 4))
    const sticksEnsured = await ensureSticks(
      mineflayer,
      craftOperationsNeeded,
    )
    const fuelEnsured = await ensureCoal(
      mineflayer,
      craftOperationsNeeded,
    ) // 1 coal or charcoal per 4 torches

    if (!sticksEnsured || !fuelEnsured) {
      logger.error('Bot: Failed to ensure sticks or coal-like fuel for torch(es).')
      return false
    }

    const hasCraftCapacity = await ensureTorchCraftInventoryCapacity(mineflayer)
    if (!hasCraftCapacity) {
      logger.error('Bot: Inventory is full and no disposable stack could be cleared for torch crafting.')
      return false
    }

    // Craft the torch(es)
    const crafted = await craftRecipe(mineflayer, 'torch', craftOperationsNeeded)
    if (crafted) {
      torchCount = getItemCount(mineflayer, 'torch')
      mineflayer.bot.chat(`I have crafted ${quantity} torch(es).`)
      logger.log(`Bot: ${quantity} torch(es) crafted.`)
    }
    else {
      logger.error('Bot: Failed to craft torch(es).')
      await sleep(RETRY_DELAY_MS)
    }
  }
  return torchCount >= quantity
}

// Ensure a campfire
// Todo: rework
export async function ensureCampfire(mineflayer: Mineflayer): Promise<boolean> {
  logger.log('Bot: Checking for a campfire...')

  const hasCampfire = getItemCount(mineflayer, 'campfire') > 0

  if (hasCampfire) {
    logger.log('Bot: Campfire is already available.')
    return true
  }

  const logsEnsured = await ensurePlanks(mineflayer, 3) // Need 3 logs for a campfire
  const sticksEnsured = await ensureSticks(mineflayer, 3) // Need 3 sticks for a campfire
  const coalEnsured = await ensureCoal(mineflayer, 1) // Need 1 coal or charcoal for a campfire

  if (!logsEnsured || !sticksEnsured || !coalEnsured) {
    logger.error('Bot: Failed to ensure resources for campfire.')
  }

  const crafted = await craftRecipe(mineflayer, 'campfire', 1)
  if (crafted) {
    mineflayer.bot.chat('I have crafted a campfire.')
    logger.log('Bot: Campfire crafted.')
    return true
  }
  else {
    logger.error('Bot: Failed to craft campfire.')
  }

  return hasCampfire
}

// Helper function to gather cobblestone
export async function ensureCobblestone(mineflayer: Mineflayer, requiredCobblestone: number, maxDistance: number = 4): Promise<boolean> {
  throwIfAborted(mineflayer.currentActionSignal)
  let cobblestoneCount = getItemCount(mineflayer, 'cobblestone')
  if (cobblestoneCount >= requiredCobblestone) {
    return true
  }

  // Proactively ensure we have a pickaxe BEFORE attempting to mine stone/cobblestone.
  // Without this, Baritone wastes 120s trying to mine stone without a pickaxe,
  // then the collectBlock fallback fails with "right tools", and ensurePickaxe is
  // called reactively while the bot may already be in a bad position (e.g. water).
  if (!hasActualToolAccess(mineflayer, 'pickaxe')) {
    logger.log('Bot: No pickaxe found — crafting one before cobblestone mining...')
    const pickaxeReady = await ensurePickaxe(mineflayer)
    if (!pickaxeReady) {
      logger.error('Bot: Could not ensure pickaxe for cobblestone mining.')
      return false
    }
  }

  let attempts = 0
  let noProgressAttempts = 0
  let baritoneFallbackUsed = false

  while (cobblestoneCount < requiredCobblestone && attempts < MAX_COBBLESTONE_GATHER_ATTEMPTS) {
    throwIfAborted(mineflayer.currentActionSignal)
    attempts++
    logger.log('Bot: Gathering more cobblestone...')
    const beforeCount = cobblestoneCount
    const searchRange = getCobblestoneSearchRange(maxDistance, attempts)
    const collectionTarget = Math.min(
      requiredCobblestone - cobblestoneCount,
      COBBLESTONE_COLLECTION_TARGET_PER_ATTEMPT,
    )

    // Prefer baritone_mine when available — collectBlock uses the dig RPC which
    // deadlocks on older Fabric mod builds. Baritone handles mining natively.
    const pathfinder = mineflayer.bot.pathfinder as { mine?: (blockNames: string[]) => Promise<boolean> } | undefined
    const hasBaritoneMine = typeof pathfinder?.mine === 'function'

    if (hasBaritoneMine && !baritoneFallbackUsed) {
      logger.log('Bot: Using baritone to mine stone (preferred path)...')
      try {
        const mined = await raceWithAbort(Promise.race<boolean>([
          pathfinder!.mine!(['stone', 'cobblestone']),
          abortableSleep(BARITONE_STONE_MINING_TIMEOUT_MS, mineflayer.currentActionSignal).then(() => false),
        ]), mineflayer.currentActionSignal)
        if (!mined) {
          logger.warn('Bot: Baritone stone mining did not complete; trying collectBlock fallback.')
        }
      }
      catch (err) {
        if (err instanceof ActionAbortedError) {
          throw err
        }
        logger.withFields({ error: err instanceof Error ? err.message : String(err) })
          .warn('Bot: Baritone stone mining threw (likely timeout); checking inventory for partial progress.')
      }
      // Always refresh inventory — baritone may have mined some blocks before timeout
      await abortableSleep(2000, mineflayer.currentActionSignal)
      await refreshInventoryState(mineflayer)
      cobblestoneCount = getItemCount(mineflayer, 'cobblestone')
      logger.log(`Bot: After baritone stone mining, cobblestone count: ${cobblestoneCount}`)
      if (cobblestoneCount > beforeCount) {
        noProgressAttempts = 0
        continue
      }
      // Baritone didn't help — fall through to collectBlock on subsequent attempts
      baritoneFallbackUsed = true
    }

    try {
      const success = await withTimeout(
        collectBlock(
          mineflayer,
          'cobblestone',
          collectionTarget,
          searchRange,
        ),
        COLLECT_BLOCK_ATTEMPT_TIMEOUT_MS,
        'collect cobblestone attempt',
        mineflayer.currentActionSignal,
      )
      if (!success) {
        noProgressAttempts++
        logger.withFields({
          noProgressAttempts,
          maxNoProgressAttempts: MAX_GATHER_NO_PROGRESS_ATTEMPTS,
          searchRange,
        }).warn('Bot: Cobblestone collection attempt found no reachable exposed stone.')
        if (noProgressAttempts >= MAX_GATHER_NO_PROGRESS_ATTEMPTS) {
          break
        }
        const relocated = await relocateTowardStoneOutcrop(mineflayer, Math.max(searchRange * 2, 24))
        if (!relocated) {
          await moveAway(mineflayer, 30)
        }
        continue
      }
    }
    catch (err) {
      if (err instanceof ActionAbortedError) {
        throw err
      }
      if (err instanceof Error && err.message.includes('right tools')) {
        await ensurePickaxe(mineflayer)
        continue
      }
      else {
        logger.withFields({
          searchRange,
          attempt: attempts,
        }).withError(err).error('Error collecting cobblestone')
        // If collectBlock fails, try baritone again on next loop
        baritoneFallbackUsed = false
        await moveAway(mineflayer, 30)
        continue
      }
    }

    cobblestoneCount = getItemCount(mineflayer, 'cobblestone')
    if (cobblestoneCount <= beforeCount) {
      noProgressAttempts++
      logger.withFields({
        noProgressAttempts,
        maxNoProgressAttempts: MAX_GATHER_NO_PROGRESS_ATTEMPTS,
      }).warn('Bot: No cobblestone progress in this attempt.')
      if (noProgressAttempts >= MAX_GATHER_NO_PROGRESS_ATTEMPTS) {
        break
      }
    }
    else {
      noProgressAttempts = 0
    }
  }

  if (cobblestoneCount < requiredCobblestone) {
    logger.withFields({
      requiredCobblestone,
      currentCobblestone: cobblestoneCount,
      attempts,
      maxAttempts: MAX_COBBLESTONE_GATHER_ATTEMPTS,
    }).error('Bot: Could not ensure enough cobblestone.')
    return false
  }

  logger.log('Bot: Collected enough cobblestone.')
  return true
}

export async function ensureCoal(mineflayer: Mineflayer, neededAmount: number, maxDistance: number = 4): Promise<boolean> {
  throwIfAborted(mineflayer.currentActionSignal)
  logger.log('Bot: Checking for coal or charcoal...')
  let coalCount = getCoalLikeFuelCount(mineflayer)
  if (coalCount >= neededAmount) {
    return true
  }

  // Proactively ensure pickaxe before attempting to mine coal ore
  if (!hasActualToolAccess(mineflayer, 'pickaxe')) {
    logger.log('Bot: No pickaxe found — crafting one before coal mining...')
    await ensurePickaxe(mineflayer)
  }

  let attempts = 0
  let noProgressAttempts = 0

  while (coalCount < neededAmount && attempts < MAX_COAL_GATHER_ATTEMPTS) {
    throwIfAborted(mineflayer.currentActionSignal)
    attempts++
    const beforeCount = coalCount

    const smeltedCharcoal = await trySmeltCharcoalFuel(mineflayer, neededAmount)
    coalCount = getCoalLikeFuelCount(mineflayer)
    if (smeltedCharcoal && coalCount > beforeCount) {
      noProgressAttempts = 0
      continue
    }

    logger.log('Bot: Gathering more smelting fuel...')
    const coalShortage = neededAmount - coalCount

    try {
      const success = await collectBlock(mineflayer, 'coal_ore', coalShortage, maxDistance)
      if (!success) {
        noProgressAttempts++
        logger.withFields({
          noProgressAttempts,
          maxNoProgressAttempts: MAX_GATHER_NO_PROGRESS_ATTEMPTS,
        }).warn('Bot: Coal collection attempt made no progress.')
        if (noProgressAttempts >= MAX_GATHER_NO_PROGRESS_ATTEMPTS) {
          // Before giving up on coal, try gathering wood for charcoal
          logger.log('Bot: No coal ore found nearby, trying charcoal fallback (gathering wood)...')
          const charcoalFallbackLogTarget = getCharcoalFallbackLogTarget(mineflayer, coalShortage)
          const woodGathered = getCharcoalSourceCount(mineflayer) >= charcoalFallbackLogTarget
            || await gatherWood(mineflayer, charcoalFallbackLogTarget, 64)
          if (woodGathered) {
            await refreshInventoryState(mineflayer)
            const charcoalSmelted = await trySmeltCharcoalFuel(mineflayer, neededAmount)
            coalCount = getCoalLikeFuelCount(mineflayer)
            if (charcoalSmelted && coalCount >= neededAmount) {
              break
            }
            if (coalCount > beforeCount) {
              noProgressAttempts = 0
              continue
            }
          }
          break
        }
        await moveAway(mineflayer, 30)
        continue
      }
    }
    catch (err) {
      if (err instanceof ActionAbortedError) {
        throw err
      }
      if (err instanceof Error && err.message.includes('right tools')) {
        await ensurePickaxe(mineflayer)
        continue
      }
      else {
        logger.withError(err).error('Error collecting coal:')
        await moveAway(mineflayer, 30)
        continue
      }
    }

    // Wait for item pickup + refresh inventory to ensure FabricBridge has synced
    await abortableSleep(500, mineflayer.currentActionSignal)
    await refreshInventoryState(mineflayer)
    coalCount = getCoalLikeFuelCount(mineflayer)
    if (coalCount <= beforeCount) {
      noProgressAttempts++
      logger.withFields({
        noProgressAttempts,
        maxNoProgressAttempts: MAX_GATHER_NO_PROGRESS_ATTEMPTS,
      }).warn('Bot: No coal or charcoal progress in this attempt.')
      if (noProgressAttempts >= MAX_GATHER_NO_PROGRESS_ATTEMPTS) {
        break
      }
    }
    else {
      noProgressAttempts = 0
    }
  }

  if (coalCount < neededAmount) {
    logger.withFields({
      neededAmount,
      currentCoal: getItemCount(mineflayer, 'coal'),
      currentCharcoal: getItemCount(mineflayer, 'charcoal'),
      attempts,
      maxAttempts: MAX_COAL_GATHER_ATTEMPTS,
    }).error('Bot: Could not ensure enough coal or charcoal.')
    return false
  }

  logger.log('Bot: Collected enough coal or charcoal.')
  return true
}

// Define the valid tool types as a union type
type ToolType = 'pickaxe' | 'sword' | 'axe' | 'shovel' | 'hoe'

// Define the valid materials as a union type
type MaterialType = 'diamond' | 'golden' | 'iron' | 'stone' | 'wooden'

const MATERIAL_RANK: Record<MaterialType, number> = {
  wooden: 1,
  golden: 1,
  stone: 2,
  iron: 3,
  diamond: 4,
}

// Constants for crafting tools
const TOOLS_MATERIALS: MaterialType[] = [
  'diamond',
  'golden',
  'iron',
  'stone',
  'wooden',
]

export function materialsForTool(tool: ToolType): number {
  switch (tool) {
    case 'pickaxe':
    case 'axe':
      return 3
    case 'sword':
    case 'hoe':
      return 2
    case 'shovel':
      return 1
    default:
      return 0
  }
}

function getBestToolRank(mineflayer: Mineflayer, toolType: ToolType): number {
  let bestRank = 0

  for (const material of TOOLS_MATERIALS) {
    const toolName = `${material}_${toolType}`
    if (getItemCount(mineflayer, toolName) > 0) {
      bestRank = Math.max(bestRank, MATERIAL_RANK[material])
    }
  }

  return bestRank
}

function getVisibleInventoryItemsForActualChecks(mineflayer: Mineflayer): Array<{ name: string, count: number, slot?: number }> {
  const bot = mineflayer.bot as typeof mineflayer.bot & {
    getStrictRawInventoryItems?: () => Array<{ name: string, count: number, slot?: number }>
    getRawInventoryItems?: () => Array<{ name: string, count: number, slot?: number }>
  }
  const localInventoryItems = mineflayer.bot.inventory.items()

  if (typeof bot.getStrictRawInventoryItems === 'function') {
    const strictRawItems = bot.getStrictRawInventoryItems()
    if (Array.isArray(strictRawItems) && strictRawItems.length > 0) {
      return strictRawItems
    }
  }

  if (typeof bot.getRawInventoryItems === 'function') {
    const rawItems = bot.getRawInventoryItems()
    if (Array.isArray(rawItems) && rawItems.length > 0) {
      return rawItems
    }
  }

  if (localInventoryItems.length > 0) {
    return localInventoryItems
  }

  const canonicalItems = getCanonicalInventoryItemsForActualChecks(mineflayer)
  if (canonicalItems.length > 0) {
    return canonicalItems
  }

  return localInventoryItems
}

function getActualToolCount(mineflayer: Mineflayer, toolType: ToolType): number {
  const matchesToolType = (itemName: string): boolean => {
    switch (toolType) {
      case 'pickaxe':
        return itemName.includes('pickaxe')
      case 'axe':
        return itemName.includes('axe') && !itemName.includes('pickaxe')
      default:
        return itemName.includes(toolType)
    }
  }

  const visibleItems = getVisibleInventoryItemsForActualChecks(mineflayer)
  let count = visibleItems
    .filter(item => matchesToolType(item.name))
    .reduce((total, item) => total + item.count, 0)

  const inventory = mineflayer.bot.inventory as {
    selectedSlot?: number
    slots?: Array<{ name?: string, count?: number } | null | undefined>
  }
  const selectedSlot = inventory.selectedSlot ?? 0
  const heldSlot = selectedSlot + 36
  const heldItem = mineflayer.bot.heldItem
  const visibleHeldTool = visibleItems.some(item =>
    matchesToolType(item.name)
    && (
      item.slot === heldSlot
      || item.slot === selectedSlot
      || item.name === heldItem?.name
    ),
  )
  if (heldItem?.name && matchesToolType(heldItem.name) && !visibleHeldTool) {
    count += heldItem.count ?? 1
  }

  const visibleOffhandTool = visibleItems.some(item => matchesToolType(item.name) && item.slot === 45)
  const offhandItem = inventory?.slots?.[45]
  if (offhandItem?.name && matchesToolType(offhandItem.name) && !visibleOffhandTool) {
    count += offhandItem.count ?? 1
  }

  return count
}

function hasActualToolAccess(mineflayer: Mineflayer, toolType: ToolType, quantity: number = 1): boolean {
  return getActualToolCount(mineflayer, toolType) >= quantity || getBestToolRank(mineflayer, toolType) > 0
}

// Helper function to ensure a specific tool, checking from best materials to wood
async function ensureTool(mineflayer: Mineflayer, toolType: ToolType, quantity: number = 1): Promise<boolean> {
  logger.log(`Bot: Checking for ${quantity} ${toolType}(s)...`)

  const neededMaterials = materialsForTool(toolType)

  // Check how many of the tool the bot currently has
  await refreshInventoryState(mineflayer)
  let toolCount = getActualToolCount(mineflayer, toolType)

  if (toolCount >= quantity) {
    logger.log(`Bot: Already has ${quantity} or more ${toolType}(s).`)
    return true
  }

  let attempts = 0
  while (toolCount < quantity && attempts < MAX_TOOL_ATTEMPTS) {
    attempts++
    let progressed = false
    let fatalFailure = false
    let attemptedToolCraft = false

    // Iterate over the tool materials from best (diamond) to worst (wooden)
    for (const material of TOOLS_MATERIALS) {
      const toolRecipe = `${material}_${toolType}` // Craft tool name like diamond_pickaxe, iron_sword
      const requiredWoodenPlanks = material === 'wooden'
        ? await getRequiredPlanksForWoodenTool(mineflayer, toolType)
        : 0
      const bridgeWoodenPlanksConfirmed = material === 'wooden'
        ? canProceedWithStableBridgeInventoryRequirements(
            mineflayer,
            [{ itemName: 'planks', minCount: requiredWoodenPlanks }],
            `wooden ${toolType} plank total`,
            await confirmStableActualInventoryRequirements(
              mineflayer,
              [{ itemName: 'planks', minCount: requiredWoodenPlanks }],
              `wooden ${toolType} plank total`,
              4,
              200,
              1,
            ),
          )
        : false
      const hasResources = material === 'wooden'
        ? getVisibleActualItemCount(mineflayer, 'planks') >= requiredWoodenPlanks || bridgeWoodenPlanksConfirmed
        : await hasResourcesForTool(mineflayer, material, neededMaterials)

      // Check if we have enough material for the current tool
      if (hasResources) {
        let usedOptimisticToolInputs = false
        if (material === 'wooden' && getVisibleActualItemCount(mineflayer, 'planks') < requiredWoodenPlanks) {
          const woodenPlankRequirements: ActualInventoryRequirement[] = [{ itemName: 'planks', minCount: requiredWoodenPlanks }]
          const actualTotalPlanksConfirmed = await confirmItemCount(mineflayer, 'planks', requiredWoodenPlanks, {
            attempts: 5,
            delayMs: 200,
            actualOnly: true,
            localVisibleOnly: true,
          })
          const trackedTotalPlanksConfirmed = canProceedWithTrackedInventoryRequirements(
            mineflayer,
            woodenPlankRequirements,
            `wooden ${toolType} plank total`,
          )
          if (!actualTotalPlanksConfirmed && !trackedTotalPlanksConfirmed && !bridgeWoodenPlanksConfirmed) {
            logger.warn(
              `Bot: Wooden ${toolType} needs ${requiredWoodenPlanks} confirmed planks before stick/tool crafting; waiting for bridge inventory sync.`,
            )
            if (hasUnconfirmedOptimisticInventoryLead(mineflayer, ['planks'])) {
              logger.warn(
                `Bot: Wooden ${toolType} plank total is still only present in optimistic inventory state; aborting this ensure cycle instead of consuming stale materials.`,
              )
              fatalFailure = true
              break
            }
            if (hasRecentBridgeCraftSyncMismatch(mineflayer, ['planks'])) {
              fatalFailure = true
              break
            }
            continue
          }
        }

        const optimisticToolReady = getItemCount(mineflayer, toolRecipe) >= quantity
          || getItemCount(mineflayer, toolType) >= quantity
        if (material === 'wooden' && !optimisticToolReady && getVisibleActualItemCount(mineflayer, 'planks') < neededMaterials) {
          const woodenToolRequirements: ActualInventoryRequirement[] = [{ itemName: 'planks', minCount: neededMaterials }]
          const actualPlanksConfirmed = await confirmItemCount(mineflayer, 'planks', neededMaterials, {
            attempts: 5,
            delayMs: 200,
            actualOnly: true,
            localVisibleOnly: true,
          })
          const trackedToolPlanksConfirmed = canProceedWithTrackedInventoryRequirements(
            mineflayer,
            woodenToolRequirements,
            `wooden ${toolType}`,
          )
          const bridgeToolPlanksConfirmed = canProceedWithStableBridgeInventoryRequirements(
            mineflayer,
            woodenToolRequirements,
            `wooden ${toolType}`,
            await confirmStableActualInventoryRequirements(
              mineflayer,
              woodenToolRequirements,
              `wooden ${toolType}`,
              4,
              200,
              1,
            ),
          )
          if (!actualPlanksConfirmed && !trackedToolPlanksConfirmed && !bridgeToolPlanksConfirmed) {
            logger.warn(
              `Bot: Wooden ${toolType} inputs are not confirmed in actual inventory yet; waiting for plank sync before crafting.`,
            )
            if (hasUnconfirmedOptimisticInventoryLead(mineflayer, ['planks'])) {
              logger.warn(
                `Bot: Wooden ${toolType} planks are still only present in optimistic inventory state; aborting this ensure cycle instead of re-crafting inputs.`,
              )
              fatalFailure = true
              break
            }
            if (hasRecentBridgeCraftSyncMismatch(mineflayer, ['planks'])) {
              fatalFailure = true
              break
            }
            continue
          }
        }

        const hasCraftingTable = await ensureCraftingTable(mineflayer)
        if (!hasCraftingTable) {
          logger.error(`Bot: Failed to ensure crafting table for ${material} ${toolType}.`)
          continue
        }

        const stickRequirements: ActualInventoryRequirement[] = [{ itemName: 'stick', minCount: 2 }]
        const sticksEnsured = getVisibleActualItemCount(mineflayer, 'stick') >= 2
          || canProceedWithTrackedInventoryRequirements(
            mineflayer,
            stickRequirements,
            `${material} ${toolType} stick precheck`,
          )
          || await ensureSticks(mineflayer, 2)

        if (!sticksEnsured) {
          logger.error(
            `Bot: Failed to ensure planks or sticks for wooden ${toolType}.`,
          )
          if (hasRecentBridgeCraftSyncMismatch(mineflayer, ['stick', 'crafting_table'])) {
            fatalFailure = true
            break
          }
          continue
        }

        let toolCraftRequirements = getToolCraftRequirements(material, toolType, neededMaterials)
        const selectedToolCraftRequirements = await getSelectedCraftRequirements(
          mineflayer,
          toolRecipe,
          1,
        )
        if (selectedToolCraftRequirements && selectedToolCraftRequirements.length > 0) {
          toolCraftRequirements = selectedToolCraftRequirements
        }
        const exactPlankRequirement = material === 'wooden'
          ? toolCraftRequirements.find(requirement => requirement.itemName.endsWith('_planks'))
          : undefined
        if (exactPlankRequirement) {
          const exactPlanksEnsured = await ensureSpecificPlanks(
            mineflayer,
            exactPlankRequirement.itemName,
            exactPlankRequirement.minCount,
          )
          if (!exactPlanksEnsured) {
            logger.error(
              `Bot: Failed to ensure ${exactPlankRequirement.itemName} for wooden ${toolType}.`,
            )
            continue
          }
        }
        const stableInputsConfirmed = await confirmStableActualInventoryRequirements(
          mineflayer,
          toolCraftRequirements,
          `${material} ${toolType} craft`,
        )
        const bridgeInputsConfirmed = canProceedWithStableBridgeInventoryRequirements(
          mineflayer,
          toolCraftRequirements,
          `${material} ${toolType} craft`,
          stableInputsConfirmed,
        )
        if (!stableInputsConfirmed) {
          usedOptimisticToolInputs = canProceedWithTrackedInventoryRequirements(
            mineflayer,
            toolCraftRequirements,
            `${material} ${toolType} craft`,
          )
        }
        if (!stableInputsConfirmed && !usedOptimisticToolInputs) {
          if (hasUnconfirmedOptimisticInventoryLead(mineflayer, ['planks', 'stick'])) {
            logger.warn(
              `Bot: ${material} ${toolType} inputs are still only visible in optimistic inventory state; aborting this ensure cycle instead of re-crafting the same materials.`,
            )
            fatalFailure = true
            break
          }
          if (hasRecentBridgeCraftSyncMismatch(
            mineflayer,
            [getMaterialIngredientItemName(material), 'stick', toolRecipe],
          )) {
            fatalFailure = true
            break
          }
          continue
        }

        const visibleInputsConfirmed = await confirmVisibleLocalInventoryRequirements(
          mineflayer,
          toolCraftRequirements,
          `${material} ${toolType} craft`,
          8,
          200,
          2,
        )
        const inputNames = toolCraftRequirements.map(requirement => requirement.itemName)
        if (!visibleInputsConfirmed) {
          if (bridgeInputsConfirmed && !requiresStrictVisibleCraftInputs(toolCraftRequirements)) {
            logger.warn(
              `Bot: ${material} ${toolType} inputs are bridge-confirmed; attempting craft before local inventory catches up.`,
            )
          }
          else {
            if (bridgeInputsConfirmed) {
              logger.warn(
                `Bot: ${material} ${toolType} still requires strict local inventory visibility for ${inputNames.join(', ')} before invoking craft RPC.`,
              )
            }
            if (hasUnconfirmedOptimisticInventoryLead(mineflayer, inputNames)) {
              logger.warn(
                `Bot: ${material} ${toolType} inputs are only confirmed by tracked inventory right now; waiting for local inventory visibility before invoking craft RPC.`,
              )
              break
            }
            if (hasRecentBridgeCraftSyncMismatch(
              mineflayer,
              [...inputNames, toolRecipe],
            )) {
              break
            }
            continue
          }
        }

        if (
          hasUnconfirmedOptimisticInventoryLead(mineflayer, inputNames)
          && !usedOptimisticToolInputs
          && !bridgeInputsConfirmed
        ) {
          logger.warn(
            `Bot: ${material} ${toolType} still has tracked-only craft inputs without bridge confirmation; refusing to invoke craft RPC.`,
          )
          fatalFailure = true
          break
        }

        // Craft the tool
        attemptedToolCraft = true
        const crafted = await craftRecipe(mineflayer, toolRecipe, 1)
        const confirmed = crafted
          ? await confirmItemCount(mineflayer, toolRecipe, 1, {
              attempts: 5,
              delayMs: 200,
              actualOnly: true,
              localVisibleOnly: true,
            })
          : false
        if (confirmed || hasCraftedToolConfirmation(
          mineflayer,
          crafted,
          toolRecipe,
          toolType,
          quantity,
          `${material} ${toolType} ensure`,
        )) {
          progressed = true
          toolCount = Math.max(
            quantity,
            getActualToolCount(mineflayer, toolType),
            getItemCount(mineflayer, toolRecipe),
            getItemCount(mineflayer, toolType),
          )
          mineflayer.bot.chat(
            `I have crafted a ${material} ${toolType}. Total ${toolType}(s): ${toolCount}/${quantity}`,
          )
          logger.log(
            `Bot: ${material} ${toolType} crafted. Total ${toolCount}/${quantity}`,
          )
          if (toolCount >= quantity)
            return true
        }
        else if (crafted) {
          logger.error(`Bot: Failed to confirm crafted ${material} ${toolType}.`)
          logCraftConfirmationMismatch(toolRecipe)
          if (
            usedOptimisticToolInputs
            || hasRecentBridgeCraftSyncMismatch(mineflayer, [toolRecipe])
          ) {
            fatalFailure = true
            break
          }
        }
        else {
          logger.error(`Bot: Failed to craft ${material} ${toolType}.`)
          if (usedOptimisticToolInputs) {
            fatalFailure = true
            break
          }
        }
      }
      else if (material === 'wooden') {
        const trackedPlanks = getItemCount(mineflayer, 'planks')
        if (trackedPlanks >= requiredWoodenPlanks) {
          const visibleTrackedPlanks = await confirmVisibleLocalInventoryRequirements(
            mineflayer,
            [{ itemName: 'planks', minCount: requiredWoodenPlanks }],
            `wooden ${toolType} plank total`,
            8,
            200,
            2,
          )
          if (visibleTrackedPlanks) {
            progressed = true
            break
          }

          logger.warn(
            `Bot: Wooden ${toolType} still has ${trackedPlanks} tracked planks but only `
            + `${getPlanksCount(mineflayer)} are locally visible; refusing to gather more wood until inventory visibility catches up.`,
          )
          fatalFailure = true
          break
        }

        // Crafting planks if we don't have enough resources for wooden tools
        logger.log(`Bot: Crafting planks for ${material} ${toolType}...`)
        const planksEnsured = await ensurePlanks(mineflayer, requiredWoodenPlanks)
        if (!planksEnsured) {
          logger.error(`Bot: Failed to ensure planks for wooden ${toolType}.`)
          fatalFailure = true
          break
        }
        progressed = true
      }
    }

    if (toolCount >= quantity) {
      return true
    }

    if (fatalFailure) {
      return false
    }

    if (progressed && !attemptedToolCraft) {
      attempts = Math.max(0, attempts - 1)
      continue
    }

    if (!progressed) {
      logger.error(`Bot: No crafting progress for ${toolType} (attempt ${attempts}/${MAX_TOOL_ATTEMPTS}).`)
      await sleep(RETRY_DELAY_MS)
    }
  }

  if (toolCount < quantity) {
    logger.error(`Bot: Could not ensure ${quantity} ${toolType}(s) after ${MAX_TOOL_ATTEMPTS} attempts.`)
  }

  return toolCount >= quantity
}

async function recoverPickaxeFromWood(mineflayer: Mineflayer, quantity: number): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_PICKAXE_RECOVERY_ATTEMPTS; attempt++) {
    throwIfAborted(mineflayer.currentActionSignal)
    const moveDistance = 24 + (attempt * 16)
    const searchDistance = 80 + (attempt * 32)

    if (getLogsCount(mineflayer) <= 0 && getPlanksCount(mineflayer) <= 0) {
      if (getMainInventoryFreeSlotCount(mineflayer) <= 0) {
        const freedSlot = await ensureStarterPickaxeRecoveryInventoryCapacity(mineflayer)
        if (!freedSlot) {
          logger.warn('Bot: Starter pickaxe recovery could not free inventory space for wood collection.')
          continue
        }
      }
      await moveAway(mineflayer, moveDistance)
      const gathered = await gatherWood(mineflayer, 4, searchDistance)
      if (!gathered) {
        continue
      }
    }

    const requiredPlanks = await getRequiredPlanksForWoodenTool(mineflayer, 'pickaxe')
    const planksEnsured = await ensurePlanks(mineflayer, requiredPlanks)
    if (!planksEnsured) {
      continue
    }

    const sticksEnsured = await ensureSticks(mineflayer, 2)
    if (!sticksEnsured) {
      continue
    }

    const hasCraftingTable = await ensureCraftingTable(mineflayer)
    if (!hasCraftingTable) {
      continue
    }

    let starterPickaxeRequirements = getToolCraftRequirements('wooden', 'pickaxe', materialsForTool('pickaxe'))
    const selectedStarterPickaxeRequirements = await getSelectedCraftRequirements(
      mineflayer,
      'wooden_pickaxe',
      1,
    )
    if (selectedStarterPickaxeRequirements && selectedStarterPickaxeRequirements.length > 0) {
      starterPickaxeRequirements = selectedStarterPickaxeRequirements
    }
    const exactPlankRequirement = starterPickaxeRequirements
      .find(requirement => requirement.itemName.endsWith('_planks'))
    if (exactPlankRequirement) {
      const exactPlanksEnsured = await ensureSpecificPlanks(
        mineflayer,
        exactPlankRequirement.itemName,
        exactPlankRequirement.minCount,
      )
      if (!exactPlanksEnsured) {
        continue
      }
    }
    const stableInputsConfirmed = await confirmStableActualInventoryRequirements(
      mineflayer,
      starterPickaxeRequirements,
      'starter pickaxe craft',
    )
    const bridgeInputsConfirmed = canProceedWithStableBridgeInventoryRequirements(
      mineflayer,
      starterPickaxeRequirements,
      'starter pickaxe craft',
      stableInputsConfirmed,
    )
    if (!stableInputsConfirmed && !canProceedWithTrackedInventoryRequirements(
      mineflayer,
      starterPickaxeRequirements,
      'starter pickaxe craft',
    )) {
      continue
    }

    const visibleInputsConfirmed = await confirmVisibleLocalInventoryRequirements(
      mineflayer,
      starterPickaxeRequirements,
      'starter pickaxe craft',
      8,
      200,
      2,
    )
    if (!visibleInputsConfirmed) {
      if (!bridgeInputsConfirmed || requiresStrictVisibleCraftInputs(starterPickaxeRequirements)) {
        if (bridgeInputsConfirmed) {
          logger.warn(
            'Bot: Starter pickaxe still requires strict local stick visibility before invoking craft RPC.',
          )
        }
        continue
      }
      logger.warn('Bot: Starter pickaxe inputs are bridge-confirmed; attempting craft before local inventory catches up.')
    }

    const starterInputNames = starterPickaxeRequirements.map(requirement => requirement.itemName)
    if (
      hasUnconfirmedOptimisticInventoryLead(mineflayer, starterInputNames)
      && !bridgeInputsConfirmed
    ) {
      logger.warn('Bot: Starter pickaxe still only has tracked-only inputs without bridge confirmation; refusing to invoke craft RPC.')
      continue
    }

    const crafted = await craftRecipe(mineflayer, 'wooden_pickaxe', quantity)
    const confirmed = crafted && await confirmItemCount(mineflayer, 'wooden_pickaxe', quantity, {
      attempts: 5,
      delayMs: 200,
      actualOnly: true,
      localVisibleOnly: true,
    })
    if (confirmed || hasCraftedToolConfirmation(
      mineflayer,
      crafted,
      'wooden_pickaxe',
      'pickaxe',
      quantity,
      'starter pickaxe ensure',
    )) {
      return true
    }

    if (crafted && hasRecentBridgeCraftSyncMismatch(mineflayer, ['wooden_pickaxe'])) {
      logCraftConfirmationMismatch('wooden_pickaxe')
      return false
    }
  }

  return false
}

// Helper function to check if the bot has enough materials to craft a tool of a specific material
export async function hasResourcesForTool(
  mineflayer: Mineflayer,
  material: MaterialType,
  num = 3, // Number of resources needed for most tools
): Promise<boolean> {
  switch (material) {
    case 'diamond':
      return getVisibleActualItemCount(mineflayer, 'diamond') >= num
    case 'golden':
      return getVisibleActualItemCount(mineflayer, 'gold_ingot') >= num
    case 'iron':
      return getVisibleActualItemCount(mineflayer, 'iron_ingot') >= num
    case 'stone':
      return getVisibleActualItemCount(mineflayer, 'cobblestone') >= num
    case 'wooden':
      return getVisibleActualItemCount(mineflayer, 'planks') >= num
    default:
      return false
  }
}

// Helper functions for specific tools:

// Ensure a pickaxe
export async function ensurePickaxe(mineflayer: Mineflayer, quantity: number = 1): Promise<boolean> {
  throwIfAborted(mineflayer.currentActionSignal)
  const recoveredFromNearbyDrops = await recoverPickaxeInputsFromNearbyDrops(mineflayer, quantity)
  throwIfAborted(mineflayer.currentActionSignal)
  if (recoveredFromNearbyDrops) {
    return true
  }

  const ensured = await ensureTool(mineflayer, 'pickaxe', quantity)
  throwIfAborted(mineflayer.currentActionSignal)
  if (ensured) {
    return true
  }

  const recoveredAfterEnsureFailure = await recoverPickaxeInputsFromNearbyDrops(mineflayer, quantity)
  if (recoveredAfterEnsureFailure) {
    return true
  }

  if (hasUnconfirmedOptimisticInventoryLead(mineflayer, ['planks', 'stick', 'crafting_table'])) {
    logger.error('Bot: Skipping wood recovery because wooden pickaxe inputs are still only visible in optimistic inventory state.')
    return false
  }

  if (hasRecentBridgeCraftSyncMismatch(mineflayer, ['stick', 'planks', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe'])) {
    logger.error('Bot: Skipping wood recovery because bridge craft sync is currently blocked.')
    return false
  }

  return await recoverPickaxeFromWood(mineflayer, quantity)
};

export async function ensureStoneTierPickaxe(mineflayer: Mineflayer): Promise<boolean> {
  await refreshInventoryState(mineflayer)
  if (getBestToolRank(mineflayer, 'pickaxe') >= MATERIAL_RANK.stone) {
    return true
  }

  const cobblestoneReady = await ensureCobblestone(mineflayer, 3)
  if (!cobblestoneReady) {
    return false
  }

  const sticksReady = await ensureSticks(mineflayer, 2)
  if (!sticksReady) {
    return false
  }

  const hasCraftingTable = await ensureCraftingTable(mineflayer)
  if (!hasCraftingTable) {
    return false
  }

  const crafted = await craftRecipe(mineflayer, 'stone_pickaxe', 1)
  if (!crafted) {
    return false
  }

  await refreshInventoryState(mineflayer)
  return getBestToolRank(mineflayer, 'pickaxe') >= MATERIAL_RANK.stone
}

// Ensure a sword
export async function ensureSword(mineflayer: Mineflayer, quantity: number = 1): Promise<boolean> {
  return await ensureTool(mineflayer, 'sword', quantity)
};

// Ensure an axe
export async function ensureAxe(mineflayer: Mineflayer, quantity: number = 1): Promise<boolean> {
  return await ensureTool(mineflayer, 'axe', quantity)
};

// Ensure a shovel
export async function ensureShovel(mineflayer: Mineflayer, quantity: number = 1): Promise<boolean> {
  return await ensureTool(mineflayer, 'shovel', quantity)
};

export async function ensureHoe(mineflayer: Mineflayer, quantity: number = 1): Promise<boolean> {
  return await ensureTool(mineflayer, 'hoe', quantity)
}

// ─── Dragon-Quest Ensure Functions ──────────────────────────────────────

export async function ensureBucket(mineflayer: Mineflayer): Promise<boolean> {
  logger.log('Bot: Checking for bucket...')
  const count = getItemCount(mineflayer, 'bucket')
    + getItemCount(mineflayer, 'water_bucket')
    + getItemCount(mineflayer, 'lava_bucket')

  if (count > 0) {
    logger.log('Bot: Already has a bucket.')
    return true
  }

  // Need 3 iron ingots
  const ironCount = getItemCount(mineflayer, 'iron_ingot')
  if (ironCount < 3) {
    logger.log('Bot: Not enough iron ingots for bucket.')
    return false
  }

  const crafted = await craftRecipe(mineflayer, 'bucket', 1)
  if (crafted) {
    logger.log('Bot: Bucket crafted.')
    return true
  }
  logger.error('Bot: Failed to craft bucket.')
  return false
}

export async function ensureBow(mineflayer: Mineflayer): Promise<boolean> {
  logger.log('Bot: Checking for bow...')
  const hasBow = mineflayer.bot.inventory.items().some(i => i.name === 'bow')
  if (hasBow) {
    logger.log('Bot: Already has a bow.')
    return true
  }

  const sticksReady = await ensureSticks(mineflayer, 3)
  if (!sticksReady)
    return false

  const stringCount = getItemCount(mineflayer, 'string')
  if (stringCount < 3) {
    logger.log('Bot: Not enough string for bow.')
    return false
  }

  const crafted = await craftRecipe(mineflayer, 'bow', 1)
  if (crafted) {
    logger.log('Bot: Bow crafted.')
    return true
  }
  logger.error('Bot: Failed to craft bow.')
  return false
}

export async function ensureArrows(mineflayer: Mineflayer, count: number = 16): Promise<boolean> {
  logger.log(`Bot: Checking for ${count} arrows...`)
  const arrowCount = getItemCount(mineflayer, 'arrow')
  if (arrowCount >= count) {
    logger.log('Bot: Have enough arrows.')
    return true
  }

  const needed = Math.ceil((count - arrowCount) / 4) // 1 craft = 4 arrows
  const flintCount = getItemCount(mineflayer, 'flint')
  const stickCount = getItemCount(mineflayer, 'stick')
  const featherCount = getItemCount(mineflayer, 'feather')

  if (flintCount < needed || featherCount < needed) {
    logger.log('Bot: Not enough flint or feathers for arrows.')
    return false
  }
  if (stickCount < needed) {
    const sticksReady = await ensureSticks(mineflayer, needed)
    if (!sticksReady)
      return false
  }

  const crafted = await craftRecipe(mineflayer, 'arrow', needed)
  if (crafted) {
    logger.log('Bot: Arrows crafted.')
    return true
  }
  logger.error('Bot: Failed to craft arrows.')
  return false
}

export async function ensureFlintAndSteel(mineflayer: Mineflayer): Promise<boolean> {
  logger.log('Bot: Checking for flint and steel...')
  const has = mineflayer.bot.inventory.items().some(i => i.name === 'flint_and_steel')
  if (has) {
    logger.log('Bot: Already has flint and steel.')
    return true
  }

  const ironCount = getItemCount(mineflayer, 'iron_ingot')
  const flintCount = getItemCount(mineflayer, 'flint')
  if (ironCount < 1 || flintCount < 1) {
    logger.log('Bot: Not enough iron or flint for flint and steel.')
    return false
  }

  const crafted = await craftRecipe(mineflayer, 'flint_and_steel', 1)
  if (crafted) {
    logger.log('Bot: Flint and steel crafted.')
    return true
  }
  logger.error('Bot: Failed to craft flint and steel.')
  return false
}

export async function ensureDiamondPickaxe(mineflayer: Mineflayer): Promise<boolean> {
  logger.log('Bot: Checking for diamond pickaxe...')
  const has = mineflayer.bot.inventory.items().some(i => i.name === 'diamond_pickaxe')
  if (has) {
    logger.log('Bot: Already has diamond pickaxe.')
    return true
  }

  const diamondCount = getItemCount(mineflayer, 'diamond')
  if (diamondCount < 3) {
    logger.log('Bot: Not enough diamonds for diamond pickaxe.')
    return false
  }

  const sticksReady = await ensureSticks(mineflayer, 2)
  if (!sticksReady)
    return false

  const crafted = await craftRecipe(mineflayer, 'diamond_pickaxe', 1)
  if (crafted) {
    logger.log('Bot: Diamond pickaxe crafted.')
    return true
  }
  logger.error('Bot: Failed to craft diamond pickaxe.')
  return false
}

export async function ensureObsidian(mineflayer: Mineflayer, count: number = 10): Promise<boolean> {
  logger.log(`Bot: Checking for ${count} obsidian...`)
  let obsidianCount = getItemCount(mineflayer, 'obsidian')
  if (obsidianCount >= count) {
    logger.log('Bot: Have enough obsidian.')
    return true
  }

  // Need diamond pickaxe to mine obsidian
  const hasDiaPick = await ensureDiamondPickaxe(mineflayer)
  if (!hasDiaPick) {
    logger.log('Bot: Cannot mine obsidian without diamond pickaxe.')
    return false
  }

  // Try to collect obsidian
  const needed = count - obsidianCount
  try {
    const success = await collectBlock(mineflayer, 'obsidian', needed, 64)
    if (success) {
      obsidianCount = getItemCount(mineflayer, 'obsidian')
    }
  }
  catch {
    logger.warn('Bot: Failed to collect obsidian nearby.')
  }

  return obsidianCount >= count
}

export async function ensureEyesOfEnder(mineflayer: Mineflayer, count: number = 12): Promise<boolean> {
  logger.log(`Bot: Checking for ${count} eyes of ender...`)
  const eyeCount = getItemCount(mineflayer, 'ender_eye')
  if (eyeCount >= count) {
    logger.log('Bot: Have enough eyes of ender.')
    return true
  }

  const needed = count - eyeCount
  const pearlCount = getItemCount(mineflayer, 'ender_pearl')
  const powderCount = getItemCount(mineflayer, 'blaze_powder')

  if (pearlCount < needed || powderCount < needed) {
    logger.log(`Bot: Not enough ender pearls (${pearlCount}) or blaze powder (${powderCount}) for ${needed} eyes.`)
    return false
  }

  const crafted = await craftRecipe(mineflayer, 'ender_eye', needed)
  if (crafted) {
    logger.log('Bot: Eyes of ender crafted.')
    return true
  }
  logger.error('Bot: Failed to craft eyes of ender.')
  return false
}

export async function ensureBlazePowder(mineflayer: Mineflayer, count: number = 6): Promise<boolean> {
  logger.log(`Bot: Checking for ${count} blaze powder...`)
  let powderCount = getItemCount(mineflayer, 'blaze_powder')
  if (powderCount >= count) {
    logger.log('Bot: Have enough blaze powder.')
    return true
  }

  // Craft from blaze rods (1 rod = 2 powder)
  const rodCount = getItemCount(mineflayer, 'blaze_rod')
  const rodsNeeded = Math.ceil((count - powderCount) / 2)

  if (rodCount < rodsNeeded) {
    logger.log(`Bot: Not enough blaze rods (${rodCount}) for ${rodsNeeded} needed.`)
    return false
  }

  const crafted = await craftRecipe(mineflayer, 'blaze_powder', rodsNeeded)
  if (crafted) {
    powderCount = getItemCount(mineflayer, 'blaze_powder')
    logger.log(`Bot: Blaze powder crafted. Have ${powderCount}.`)
    return powderCount >= count
  }
  logger.error('Bot: Failed to craft blaze powder.')
  return false
}

export async function ensureBrewingStand(mineflayer: Mineflayer): Promise<boolean> {
  logger.log('Bot: Checking for brewing stand...')
  const has = getItemCount(mineflayer, 'brewing_stand') > 0
  if (has) {
    logger.log('Bot: Already has brewing stand.')
    return true
  }

  const rodCount = getItemCount(mineflayer, 'blaze_rod')
  if (rodCount < 1) {
    logger.log('Bot: Not enough blaze rods for brewing stand.')
    return false
  }

  const cobble = await ensureCobblestone(mineflayer, 3)
  if (!cobble)
    return false

  const crafted = await craftRecipe(mineflayer, 'brewing_stand', 1)
  if (crafted) {
    logger.log('Bot: Brewing stand crafted.')
    return true
  }
  logger.error('Bot: Failed to craft brewing stand.')
  return false
}

export async function ensureGlassBottles(mineflayer: Mineflayer, count: number = 3): Promise<boolean> {
  logger.log(`Bot: Checking for ${count} glass bottles...`)
  const bottleCount = getItemCount(mineflayer, 'glass_bottle')
  if (bottleCount >= count) {
    logger.log('Bot: Have enough glass bottles.')
    return true
  }

  // 3 glass = 3 bottles
  const glassCount = getItemCount(mineflayer, 'glass')
  const craftSets = Math.ceil((count - bottleCount) / 3)
  if (glassCount < craftSets * 3) {
    logger.log('Bot: Not enough glass for bottles.')
    return false
  }

  const crafted = await craftRecipe(mineflayer, 'glass_bottle', craftSets)
  if (crafted) {
    logger.log('Bot: Glass bottles crafted.')
    return true
  }
  logger.error('Bot: Failed to craft glass bottles.')
  return false
}

export async function ensureShield(mineflayer: Mineflayer): Promise<boolean> {
  logger.log('Bot: Checking for shield...')
  const has = mineflayer.bot.inventory.items().some(i => i.name === 'shield')
  if (has) {
    logger.log('Bot: Already has shield.')
    return true
  }

  const ironCount = getItemCount(mineflayer, 'iron_ingot')
  if (ironCount < 1) {
    logger.log('Bot: Not enough iron for shield.')
    return false
  }

  const planksReady = await ensurePlanks(mineflayer, 6)
  if (!planksReady)
    return false

  const crafted = await craftRecipe(mineflayer, 'shield', 1)
  if (crafted) {
    logger.log('Bot: Shield crafted.')
    return true
  }
  logger.error('Bot: Failed to craft shield.')
  return false
}
