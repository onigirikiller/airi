import type { Mineflayer } from '../../libs/mineflayer'
import type { Action } from '../../libs/mineflayer/action'
import type { ActionAgent, AgentConfig } from '../../libs/mineflayer/base-agent'
import type { PlanStep } from '../planning/adapter'

import { buildWorldStateSnapshot } from '../../libs/llm-agent/world-state'
import { ActionAbortedError, raceWithAbort, throwIfAborted } from '../../libs/mineflayer/action-abort'
import { AbstractAgent } from '../../libs/mineflayer/base-agent'
import { monitorBus } from '../../libs/monitor-event-bus'
import {
  preflightInventoryForAction,
  recoverInventoryFailure,
  stabilizeInventoryAfterAction,
  verifyInventoryPostflight,
} from '../../skills/actions/inventory'
import { getLastPlacedBlockRecord, pickupNearbyItems } from '../../skills/actions/world-interactions'
import { getNearestBlockAccurate } from '../../skills/block-access'
import { getInventoryCounts } from '../../skills/world'
import { matchesEntityQuery } from '../../utils/query-normalizer'
import { actionsList } from './tools'

const ACTION_TIMEOUT_MS = 90_000
const EXTENDED_ACTION_TIMEOUT_MS = 300_000
const SMELT_ITEM_BASE_TIMEOUT_MS = 45_000
const SMELT_ITEM_PER_ITEM_TIMEOUT_MS = 12_000
const SMELT_ITEM_MAX_TIMEOUT_MS = 8 * 60_000
const TOOL_TIER_VALUES: Record<string, number> = {
  wooden: 1,
  golden: 1,
  stone: 2,
  iron: 3,
  diamond: 4,
  netherite: 5,
}

function normalizeActionErrorMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function isRecoverableActionFailure(tool: string, errorMessage: string): boolean {
  const normalized = normalizeActionErrorMessage(errorMessage)
  if (
    tool === 'searchForEntity'
    || tool === 'searchForBlock'
    || tool === 'moveAway'
    || tool === 'goToCoordinates'
    || tool === 'recoverTowardSurface'
  ) {
    return true
  }

  return normalized.includes('could not find any')
    || normalized.includes('pathfinding timed out')
    || normalized.includes('digging timed out')
}

function getActionTimeoutMs(step: Pick<PlanStep, 'tool' | 'params'>): number {
  switch (step.tool) {
    case 'collectBlocks':
      // NOTICE: gatherWood/collectBlock already have their own internal recovery loops and
      // Baritone/manual fallbacks. The outer action timeout must stay above those retries,
      // otherwise early-game wood and ore collection is aborted before the recovery path can
      // finish and the planner thrashes on the same bootstrap goal forever.
      return EXTENDED_ACTION_TIMEOUT_MS
    case 'craftRecipe': {
      const recipeName = typeof step.params?.recipe_name === 'string'
        ? step.params.recipe_name.trim().toLowerCase()
        : ''
      if (
        recipeName === 'crafting_table'
        || recipeName === 'stick'
        || recipeName.endsWith('_planks')
        || recipeName === 'wooden_pickaxe'
        || recipeName === 'wooden_axe'
        || recipeName === 'wooden_shovel'
        || recipeName === 'wooden_sword'
        || recipeName === 'wooden_hoe'
        || recipeName === 'stone_pickaxe'
      ) {
        // NOTICE: Tool/table recipes call ensure helpers that can perform wood recovery.
        // Keep the wrapper timeout above those bounded recovery loops so the timed-out
        // promise does not keep running in the background and collide with recovery plans.
        return EXTENDED_ACTION_TIMEOUT_MS
      }
      return ACTION_TIMEOUT_MS
    }
    case 'smeltItem': {
      const requestedCount = Math.max(1, Number(step.params?.num ?? 1))
      return Math.min(
        SMELT_ITEM_MAX_TIMEOUT_MS,
        Math.max(
          ACTION_TIMEOUT_MS,
          SMELT_ITEM_BASE_TIMEOUT_MS + (requestedCount * SMELT_ITEM_PER_ITEM_TIMEOUT_MS),
        ),
      )
    }
    default:
      return ACTION_TIMEOUT_MS
  }
}

interface ActionState {
  executing: boolean
  label: string
  startTime: number
}

interface ActionSnapshot {
  position: { x: number, y: number, z: number }
  inventory: Record<string, number>
  heldItem: string
  selectedSlot: number
  equippedArmor: string[]
  offhandItem: string
  health: number
  food: number
  nearbyEntities: string[]
}

interface ActionVerificationResult {
  ok: boolean
  failureClass?: string
  expectedOutcome: string
  delta: Record<string, unknown>
}

interface ResourceDeltaSummary {
  gainedResources: string[]
  lostResources: string[]
}

function countObservedNearbyBlocks(result: unknown): number {
  const text = typeof result === 'string' ? result : ''
  if (!text.startsWith('NEARBY_BLOCKS')) {
    return 0
  }

  const trimmed = text.trim()
  if (/^NEARBY_BLOCKS:\s*none$/im.test(trimmed)) {
    return 0
  }

  return trimmed
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .length
}

function isInventoryManagedAction(step: Pick<PlanStep, 'tool'>): boolean {
  return [
    'collectBlocks',
    'attack',
    'placeHere',
    'consume',
    'craftRecipe',
    'smeltItem',
    'equip',
  ].includes(step.tool)
}

function getNewNearbyEntities(before: string[], after: string[]): string[] {
  const beforeCounts = new Map<string, number>()
  for (const entity of before) {
    beforeCounts.set(entity, (beforeCounts.get(entity) ?? 0) + 1)
  }

  const newEntities: string[] = []
  for (const entity of after) {
    const remaining = beforeCounts.get(entity) ?? 0
    if (remaining > 0) {
      beforeCounts.set(entity, remaining - 1)
      continue
    }
    newEntities.push(entity)
  }

  return newEntities
}

function getDistanceToTarget(
  position: { x: number, y: number, z: number },
  coords: Record<string, unknown>,
): number | null {
  const x = Number(coords.x)
  const y = Number(coords.y)
  const z = Number(coords.z)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null
  }

  return Math.hypot(
    position.x - x,
    position.y - y,
    position.z - z,
  )
}

function normalizeQueryToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/\s+/g, '_')
}

function isWoodSearchTarget(value: unknown): boolean {
  const normalized = normalizeQueryToken(value)
  return normalized === 'log'
    || normalized.endsWith('_log')
    || normalized.endsWith('_wood')
    || normalized.endsWith('_stem')
    || normalized.endsWith('_hyphae')
}

function isDeferredWoodSearchResult(result: unknown): boolean {
  return typeof result === 'string'
    && result.toLowerCase().includes('wood search deferred')
}

function getNearbyEntityObservationTokens(entity: unknown): string[] {
  if (!entity || typeof entity !== 'object') {
    return []
  }

  const rawName = String((entity as { name?: unknown }).name ?? '').trim()
  const rawType = String((entity as { type?: unknown }).type ?? '').trim()
  return [...new Set([rawName, rawType].filter(Boolean))]
}

function nearbyEntitiesMatchQuery(nearbyEntities: string[], query: string): boolean {
  const normalizedQuery = normalizeQueryToken(query)
  if (!normalizedQuery) {
    return false
  }

  return nearbyEntities.some(entity =>
    matchesEntityQuery(normalizedQuery, {
      name: entity,
      type: entity,
    }),
  )
}

function inventoryCountForQuery(inventory: Record<string, number>, query: string): number {
  const normalized = normalizeQueryToken(query)
  if (!normalized) {
    return 0
  }

  if (normalized === 'log') {
    return Object.entries(inventory).reduce((sum, [itemName, count]) =>
      sum + (/_log$|_wood$|_stem$|_hyphae$/i.test(itemName) ? count : 0), 0)
  }

  if (normalized === 'oak_planks' || normalized === 'planks') {
    return Object.entries(inventory).reduce((sum, [itemName, count]) =>
      sum + (itemName === 'planks' || itemName.endsWith('_planks') ? count : 0), 0)
  }

  if (normalized === 'stone') {
    return (inventory.stone ?? 0) + (inventory.cobblestone ?? 0)
  }

  if (normalized === 'iron_ore') {
    return (inventory.iron_ore ?? 0) + (inventory.deepslate_iron_ore ?? 0) + (inventory.raw_iron ?? 0) + (inventory.iron_ingot ?? 0)
  }

  if (normalized === 'coal_ore') {
    return (inventory.coal_ore ?? 0) + (inventory.deepslate_coal_ore ?? 0) + (inventory.coal ?? 0) + (inventory.charcoal ?? 0)
  }

  return Object.entries(inventory).reduce((sum, [itemName, count]) =>
    sum + (itemName === normalized || itemName.includes(normalized) ? count : 0), 0)
}

function isCharcoalSourceQuery(query: string): boolean {
  return /_log$|_wood$|_stem$|_hyphae$/i.test(query)
}

function getSmeltOutputQuery(source: string): string {
  switch (normalizeQueryToken(source)) {
    case 'raw_iron':
      return 'iron_ingot'
    case 'raw_gold':
      return 'gold_ingot'
    case 'raw_copper':
      return 'copper_ingot'
    case 'beef':
      return 'cooked_beef'
    case 'chicken':
      return 'cooked_chicken'
    case 'cod':
      return 'cooked_cod'
    case 'mutton':
      return 'cooked_mutton'
    case 'porkchop':
      return 'cooked_porkchop'
    case 'rabbit':
      return 'cooked_rabbit'
    case 'salmon':
      return 'cooked_salmon'
    case 'tropical_fish':
      return 'cooked_cod'
    default:
      return isCharcoalSourceQuery(source) ? 'charcoal' : normalizeQueryToken(source)
  }
}

function getToolRecipeRequirement(recipe: string): { category: string, requiredTier: number } | null {
  const match = normalizeQueryToken(recipe).match(/^(wooden|golden|stone|iron|diamond|netherite)_(pickaxe|axe|shovel|hoe|sword)$/)
  if (!match) {
    return null
  }

  const [, material, category] = match
  return {
    category,
    requiredTier: TOOL_TIER_VALUES[material] ?? 0,
  }
}

function getBestToolTierFromInventory(inventory: Record<string, number>, category: string): number {
  const suffix = `_${category}`
  let bestTier = 0

  for (const [itemName, count] of Object.entries(inventory)) {
    if (count <= 0 || !itemName.endsWith(suffix)) {
      continue
    }

    const material = itemName.slice(0, Math.max(0, itemName.length - suffix.length))
    bestTier = Math.max(bestTier, TOOL_TIER_VALUES[material] ?? 0)
  }

  return bestTier
}

function isToolRecipeSatisfiedByInventory(inventory: Record<string, number>, recipe: string): boolean {
  const requirement = getToolRecipeRequirement(recipe)
  if (!requirement) {
    return false
  }

  return getBestToolTierFromInventory(inventory, requirement.category) >= requirement.requiredTier
}

async function captureActionSnapshot(mineflayer: Mineflayer): Promise<ActionSnapshot> {
  try {
    await (mineflayer.bot as any)?.refreshInventory?.()
  }
  catch {
    // best-effort refresh only
  }

  const position = mineflayer.bot.entity?.position
  let inventory: Record<string, number> = {}
  try {
    inventory = getInventoryCounts(mineflayer as any)
  }
  catch {
    inventory = {}
  }
  const heldItem = String((mineflayer.bot as any)?.heldItem?.name || '')
  const selectedSlot = Number((mineflayer.bot as any)?.inventory?.selectedSlot ?? 0)
  const armorSlots = ((mineflayer.bot as any)?.inventory?.slots ?? []) as Array<{ name?: string } | null | undefined>
  const equippedArmor = [
    armorSlots[5]?.name ? `head:${String(armorSlots[5]?.name)}` : '',
    armorSlots[6]?.name ? `torso:${String(armorSlots[6]?.name)}` : '',
    armorSlots[7]?.name ? `legs:${String(armorSlots[7]?.name)}` : '',
    armorSlots[8]?.name ? `feet:${String(armorSlots[8]?.name)}` : '',
  ].filter(Boolean)
  const offhandItem = String(armorSlots[45]?.name || '')
  const nearbyEntities = Object.values((mineflayer.bot as any)?.entities ?? {})
    .flatMap((entity: unknown) => getNearbyEntityObservationTokens(entity))

  return {
    position: {
      x: Number(position?.x ?? 0),
      y: Number(position?.y ?? 0),
      z: Number(position?.z ?? 0),
    },
    inventory,
    heldItem,
    selectedSlot,
    equippedArmor,
    offhandItem,
    health: Number((mineflayer.bot as any)?.health ?? 20),
    food: Number((mineflayer.bot as any)?.food ?? 20),
    nearbyEntities,
  }
}

function summarizeResourceDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): ResourceDeltaSummary {
  const changes = new Map<string, number>()
  const itemNames = new Set([...Object.keys(before), ...Object.keys(after)])

  for (const itemName of itemNames) {
    const delta = (after[itemName] ?? 0) - (before[itemName] ?? 0)
    if (delta !== 0) {
      changes.set(itemName, delta)
    }
  }

  const sorted = [...changes.entries()]
    .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]) || left[0].localeCompare(right[0]))
    .slice(0, 6)

  return {
    gainedResources: sorted
      .filter(([, delta]) => delta > 0)
      .map(([itemName, delta]) => `${itemName} x${delta}`),
    lostResources: sorted
      .filter(([, delta]) => delta < 0)
      .map(([itemName, delta]) => `${itemName} x${Math.abs(delta)}`),
  }
}

function classifyActionFailure(tool: string, errorMessage: string): string {
  const normalized = normalizeActionErrorMessage(errorMessage)
  const verificationMatch = errorMessage.match(/Action verification failed \([^)]+\):\s*(\w+)/i)
  if (verificationMatch?.[1]) {
    return normalizeQueryToken(verificationMatch[1])
  }
  if (normalized.includes('unknown command') || normalized.includes('unsupported_capability') || normalized.includes('bridge command unsupported')) {
    return 'unsupported_capability'
  }
  if (normalized.includes('timed out')) {
    return 'timeout'
  }
  if (normalized.includes('repeated failing action aborted')) {
    return 'repeated_failure'
  }
  if (normalized.includes('verification failed')) {
    return 'verification_failed'
  }
  if (tool === 'searchForEntity' || tool === 'searchForBlock') {
    return 'target_not_found'
  }
  if (tool === 'moveAway' || tool === 'goToCoordinates' || tool === 'recoverTowardSurface') {
    if (normalized.includes('coordinates unchanged') || normalized.includes('stuck-recovery')) {
      return 'coordinate_stall'
    }
    return 'movement_stall'
  }
  return 'execution_failed'
}

async function verifyActionOutcome(
  mineflayer: Mineflayer,
  step: PlanStep,
  before: ActionSnapshot,
  after: ActionSnapshot,
  result?: unknown,
): Promise<ActionVerificationResult> {
  const positionDelta = Math.hypot(
    after.position.x - before.position.x,
    after.position.y - before.position.y,
    after.position.z - before.position.z,
  )

  switch (step.tool) {
    case 'collectBlocks': {
      const target = normalizeQueryToken(step.params.type)
      const requestedCount = Math.max(1, Number(step.params.num ?? 1))
      const beforeCount = inventoryCountForQuery(before.inventory, target)
      let afterCount = inventoryCountForQuery(after.inventory, target)
      const afterCountBeforePickup = afterCount
      const newNearbyEntities = getNewNearbyEntities(before.nearbyEntities, after.nearbyEntities)
      const pickupRecoveryEligible = afterCount <= beforeCount
      let pickupRecoveryAttempted = false
      let pickupRecoveryCount = afterCount
      let pickupRecovered = false

      if (pickupRecoveryEligible) {
        pickupRecoveryAttempted = true
        await pickupNearbyItems(mineflayer, 6)
        const recoveredAfterPickup = await captureActionSnapshot(mineflayer)
        pickupRecoveryCount = inventoryCountForQuery(recoveredAfterPickup.inventory, target)
        pickupRecovered = pickupRecoveryCount > beforeCount
        afterCount = Math.max(afterCount, pickupRecoveryCount)
      }

      const ok = afterCount > beforeCount
        || (beforeCount >= requestedCount && afterCount >= requestedCount)
      return {
        ok,
        failureClass: ok
          ? undefined
          : pickupRecoveryAttempted && pickupRecoveryCount > afterCountBeforePickup
            ? 'drop_uncollected'
            : pickupRecoveryAttempted && newNearbyEntities.length > 0
              ? 'drop_uncollected'
              : 'inventory_unchanged',
        expectedOutcome: `inventory for ${target} should increase or already satisfy x${requestedCount}`,
        delta: {
          beforeCount,
          afterCount,
          requestedCount,
          target,
          newNearbyEntities,
          pickupRecoveryAttempted,
          pickupRecoveryCount,
          pickupRecovered,
        },
      }
    }
    case 'craftRecipe': {
      const recipe = normalizeQueryToken(step.params.recipe_name)
      const beforeCount = inventoryCountForQuery(before.inventory, recipe)
      const afterCount = inventoryCountForQuery(after.inventory, recipe)
      const toolRecipeSatisfied = isToolRecipeSatisfiedByInventory(after.inventory, recipe)
      let nearbyCraftingTable = false
      if (recipe === 'crafting_table') {
        try {
          await (mineflayer.bot as any)?.scanNearbyBlocks?.(6, ['crafting_table'])
        }
        catch {
          // best-effort visibility refresh only
        }
        nearbyCraftingTable = Boolean(await getNearestBlockAccurate(mineflayer, 'crafting_table', 6))
      }
      const ok = afterCount > beforeCount
        || toolRecipeSatisfied
        || (recipe === 'crafting_table' && nearbyCraftingTable)
      return {
        ok,
        failureClass: ok ? undefined : 'craft_output_missing',
        expectedOutcome: `${recipe} should appear in inventory`,
        delta: { beforeCount, afterCount, recipe, heldItem: after.heldItem, nearbyCraftingTable, toolRecipeSatisfied },
      }
    }
    case 'smeltItem': {
      const source = normalizeQueryToken(step.params.item_name)
      const output = getSmeltOutputQuery(source)
      const beforeCount = inventoryCountForQuery(before.inventory, output)
      const afterCount = inventoryCountForQuery(after.inventory, output)
      return {
        ok: afterCount > beforeCount,
        failureClass: afterCount > beforeCount ? undefined : 'smelt_output_missing',
        expectedOutcome: `${output} should increase after smelting`,
        delta: { beforeCount, afterCount, output },
      }
    }
    case 'equip': {
      const itemName = normalizeQueryToken(step.params.item_name)
      const ok = itemName.includes('leggings')
        ? after.equippedArmor.some(item => item.includes(itemName))
        : itemName.includes('boots')
          ? after.equippedArmor.some(item => item.includes(itemName))
          : itemName.includes('helmet')
            ? after.equippedArmor.some(item => item.includes(itemName))
            : itemName.includes('chestplate') || itemName.includes('elytra')
              ? after.equippedArmor.some(item => item.includes(itemName))
              : itemName.includes('shield')
                ? after.offhandItem.includes(itemName)
                : after.heldItem.includes(itemName) && after.selectedSlot >= 0
      return {
        ok,
        failureClass: ok ? undefined : 'equip_not_observed',
        expectedOutcome: `equipment should switch to ${itemName}`,
        delta: {
          beforeHeldItem: before.heldItem,
          afterHeldItem: after.heldItem,
          beforeSlot: before.selectedSlot,
          afterSlot: after.selectedSlot,
          beforeArmor: before.equippedArmor,
          afterArmor: after.equippedArmor,
          beforeOffhand: before.offhandItem,
          afterOffhand: after.offhandItem,
        },
      }
    }
    case 'consume': {
      const itemName = normalizeQueryToken(step.params.item_name)
      const beforeCount = inventoryCountForQuery(before.inventory, itemName)
      const afterCount = inventoryCountForQuery(after.inventory, itemName)
      const ok = after.food > before.food || afterCount < beforeCount
      return {
        ok,
        failureClass: ok ? undefined : 'consume_not_observed',
        expectedOutcome: 'food should increase or consumed item should decrease',
        delta: { beforeFood: before.food, afterFood: after.food, beforeCount, afterCount },
      }
    }
    case 'searchForEntity': {
      const target = normalizeQueryToken(step.params.type)
      const targetSeen = nearbyEntitiesMatchQuery(after.nearbyEntities, target)
      return {
        ok: targetSeen || positionDelta >= 3,
        failureClass: targetSeen || positionDelta >= 3 ? undefined : 'search_target_not_locked',
        expectedOutcome: `target ${target} should become visible or position should change`,
        delta: { targetSeen, positionDelta },
      }
    }
    case 'nearbyBlocks': {
      const observedBlocks = countObservedNearbyBlocks(result)
      const ok = observedBlocks > 0
      return {
        ok,
        failureClass: ok ? undefined : 'observation_empty',
        expectedOutcome: 'nearby block scan should observe at least one actionable block',
        delta: {
          observedBlocks,
          positionDelta,
        },
      }
    }
    case 'searchForBlock':
    {
      const target = normalizeQueryToken(step.params.type)
      let targetSeen = false
      let targetDistance: number | null = null
      const rawSearchRange = Number(step.params.search_range ?? 8)
      const searchRange = Number.isFinite(rawSearchRange) && rawSearchRange > 0 ? rawSearchRange : 8
      try {
        await (mineflayer.bot as any)?.scanNearbyBlocks?.(Math.min(searchRange, 16), [target])
      }
      catch {
        // best-effort refresh only
      }
      try {
        const block = await getNearestBlockAccurate(mineflayer, target, searchRange)
        if (block?.position) {
          targetSeen = true
          targetDistance = Math.hypot(
            block.position.x - after.position.x,
            block.position.y - after.position.y,
            block.position.z - after.position.z,
          )
        }
      }
      catch {
        targetSeen = false
        targetDistance = null
      }
      const deferredWoodSearch = isWoodSearchTarget(target) && isDeferredWoodSearchResult(result)
      return {
        ok: targetSeen || positionDelta >= 2 || deferredWoodSearch,
        failureClass: targetSeen || positionDelta >= 2 || deferredWoodSearch ? undefined : 'search_target_not_locked',
        expectedOutcome: `target ${target} should become visible or position should change`,
        delta: { targetSeen, targetDistance, positionDelta, deferredWoodSearch },
      }
    }
    case 'moveAway':
    case 'goToCoordinates':
    case 'recoverTowardSurface':
    case 'goToPlayer':
    case 'followPlayer':
    {
      const requestedDistance = Number(step.params.distance ?? 0)
      const minimumPositionDelta = step.tool === 'moveAway' && requestedDistance > 0 && requestedDistance <= 12
        ? 1.25
        : step.tool === 'recoverTowardSurface'
          ? 1
          : 2
      const requestedCloseness = Number(step.params.closeness ?? 4)
      const closenessThreshold = Number.isFinite(requestedCloseness) && requestedCloseness > 0 ? requestedCloseness : 4
      const targetDistance = step.tool === 'goToCoordinates'
        ? getDistanceToTarget(after.position, step.params)
        : null
      const arrivalSatisfied = targetDistance !== null && targetDistance <= closenessThreshold
      const verticalDelta = after.position.y - before.position.y
      let surfaceRecoveryAlreadySatisfied = false
      if (step.tool === 'recoverTowardSurface' && positionDelta < minimumPositionDelta && verticalDelta < 1) {
        try {
          const worldState = await buildWorldStateSnapshot(mineflayer)
          surfaceRecoveryAlreadySatisfied = worldState.terrainContext !== 'underground_cave'
            && !worldState.surfaceEscapeNeeded
        }
        catch {
          surfaceRecoveryAlreadySatisfied = false
        }
      }
      const ok = positionDelta >= minimumPositionDelta
        || arrivalSatisfied
        || (step.tool === 'recoverTowardSurface' && verticalDelta >= 1)
        || surfaceRecoveryAlreadySatisfied
      return {
        ok,
        failureClass: ok ? undefined : 'movement_stall',
        expectedOutcome: step.tool === 'goToCoordinates'
          ? 'position should change or target coordinates should be reached'
          : step.tool === 'recoverTowardSurface'
            ? 'position should change, elevation should increase, or surface recovery should already be satisfied'
            : 'position should change',
        delta: {
          positionDelta,
          verticalDelta,
          minimumPositionDelta,
          targetDistance,
          closenessThreshold,
          arrivalSatisfied,
          surfaceRecoveryAlreadySatisfied,
        },
      }
    }
    case 'placeHere': {
      const target = normalizeQueryToken(step.params.type)
      const beforeCount = inventoryCountForQuery(before.inventory, target)
      const afterCount = inventoryCountForQuery(after.inventory, target)
      let placedNearby = false
      let placedRecently = false
      try {
        await (mineflayer.bot as any)?.scanNearbyBlocks?.(8, [target])
      }
      catch {
        // best-effort refresh only
      }
      try {
        placedNearby = Boolean(await getNearestBlockAccurate(mineflayer, target, 6))
      }
      catch {
        placedNearby = false
      }
      const placementRecord = getLastPlacedBlockRecord(mineflayer)
      placedRecently = Boolean(
        placementRecord
        && normalizeQueryToken(placementRecord.type) === target,
      )
      return {
        ok: afterCount < beforeCount || placedNearby || placedRecently,
        failureClass: afterCount < beforeCount || placedNearby || placedRecently ? undefined : 'placement_not_observed',
        expectedOutcome: `${target} should decrease after placement or appear nearby`,
        delta: { beforeCount, afterCount, target, placedNearby, placedRecently },
      }
    }
    default:
      return {
        ok: true,
        expectedOutcome: 'no postcondition rule',
        delta: { positionDelta },
      }
  }
}

export interface ActionAgentConfig extends AgentConfig {
  bot?: Mineflayer
}

/**
 * ActionAgentImpl implements the ActionAgent interface to handle action execution
 * Manages action lifecycle, state tracking and error handling
 */
export class ActionAgentImpl extends AbstractAgent implements ActionAgent {
  public readonly type = 'action' as const
  private actions: Map<string, Action>
  private mineflayer: Mineflayer
  private currentActionState: ActionState
  private repeatedFailures = new Map<string, number>()

  constructor(config: ActionAgentConfig) {
    super(config)
    this.actions = new Map()
    if (!config.bot) {
      throw new Error('Action agent requires bot instance')
    }
    this.mineflayer = config.bot
    this.currentActionState = {
      executing: false,
      label: '',
      startTime: 0,
    }
  }

  protected async initializeAgent(): Promise<void> {
    this.logger.log('Initializing action agent')
    actionsList.forEach(action => this.actions.set(action.name, action))

    // Set up event listeners
    this.on('message', async ({ sender, message }) => {
      await this.handleAgentMessage(sender, message)
    })
  }

  protected async destroyAgent(): Promise<void> {
    this.actions.clear()
    this.removeAllListeners()
  }

  public async performAction(step: PlanStep): Promise<string> {
    if (!this.initialized) {
      throw new Error('Action agent not initialized')
    }

    const action = this.actions.get(step.tool)
    if (!action) {
      throw new Error(`Unknown action: ${step.tool}`)
    }

    this.logger.withFields({
      action: step.tool,
      description: step.description,
      params: step.params,
    }).log('Performing action')

    // Update action state
    this.updateActionState(true, step.description)
    monitorBus.emitMonitor('action:started', { tool: step.tool, description: step.description, params: step.params })

    const actionSignal = this.mineflayer.beginAction(`${step.tool}: ${step.description}`)
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const timeoutMs = getActionTimeoutMs(step)

    try {
      throwIfAborted(actionSignal)
      const capabilitySnapshotHash = String((this.mineflayer.getBridgeDebugState?.() as Record<string, any> | null)?.capabilitySnapshot?.capabilityHash ?? '')
      if (isInventoryManagedAction(step)) {
        const preflight = await preflightInventoryForAction(this.mineflayer, step)
        throwIfAborted(actionSignal)
        this.logger.withFields({
          action_name: step.tool,
          capability_snapshot_hash: capabilitySnapshotHash,
          inventory_preflight: preflight.facts,
          inventory_actions: preflight.actions,
          inventory_result: preflight.ok ? 'ready' : 'failed',
          failure_class: preflight.failureClass || '',
        }).log('Inventory preflight summary')
        if (!preflight.ok) {
          throw new Error(`Inventory preflight failed (${preflight.failureClass || 'inventory_preflight_failed'})`)
        }
      }

      const before = await captureActionSnapshot(this.mineflayer)
      throwIfAborted(actionSignal)
      // Execute action with a timeout that aborts the underlying skill loop and physical primitives.
      const actionPromise = action.perform(this.mineflayer)(...Object.values(step.params))
      timeoutHandle = setTimeout(() => {
        this.mineflayer.abortCurrentAction(`Action "${step.tool}" timed out after ${timeoutMs / 1000}s`)
      }, timeoutMs)

      const result = await raceWithAbort(Promise.resolve(actionPromise), actionSignal)
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
      throwIfAborted(actionSignal)
      const after = await captureActionSnapshot(this.mineflayer)
      if (isInventoryManagedAction(step)) {
        const postflight = await verifyInventoryPostflight(this.mineflayer, step)
        this.logger.withFields({
          action_name: step.tool,
          inventory_postflight: postflight.facts,
          inventory_result: postflight.ok ? 'ready' : 'failed',
          failure_class: postflight.failureClass || '',
        }).log('Inventory postflight summary')
        if (!postflight.ok) {
          const recovery = await recoverInventoryFailure(this.mineflayer, step, postflight.failureClass || 'held_item_mismatch')
          this.logger.withFields({
            action_name: step.tool,
            inventory_recovery: recovery.actions,
            failure_class: recovery.failureClass,
          }).warn('Inventory recovery applied after failed postflight')
          const recoveredPostflight = await verifyInventoryPostflight(this.mineflayer, step)
          if (!recoveredPostflight.ok) {
            throw new Error(`Inventory postflight failed (${recoveredPostflight.failureClass || 'held_item_mismatch'})`)
          }
        }
      }
      const verification = await verifyActionOutcome(this.mineflayer, step, before, after, result)
      const resourceDelta = summarizeResourceDelta(before.inventory, after.inventory)
      this.logger.withFields({
        goal_id: step.meta?.goalId || '',
        subgoal_id: step.meta?.subgoalId || '',
        current_milestone: step.meta?.currentMilestone || '',
        planner_source: step.meta?.plannerSource || '',
        action_name: step.tool,
        normalized_params: JSON.stringify(step.params),
        capability_snapshot_hash: capabilitySnapshotHash,
        preconditions: action.preconditions ?? {},
        expected_outcome: verification.expectedOutcome,
        observed_before: before,
        observed_after: after,
        delta: verification.delta,
        result: verification.ok ? 'verified' : 'verification_failed',
        failure_class: verification.failureClass || '',
      }).log('Action verification summary')
      if (!verification.ok) {
        throw new Error(`Action verification failed (${step.tool}): ${verification.failureClass || 'postcondition_not_met'}`)
      }
      if (isInventoryManagedAction(step)) {
        await stabilizeInventoryAfterAction(this.mineflayer, step)
      }
      this.mineflayer.memory?.recordActionOutcome?.({
        actionName: step.tool,
        result: 'verified',
        goalId: step.meta?.goalId,
        subgoalId: step.meta?.subgoalId || step.description,
        currentMilestone: step.meta?.currentMilestone,
        gainedResources: resourceDelta.gainedResources,
        lostResources: resourceDelta.lostResources,
      })
      this.clearFailure(step)
      monitorBus.emitMonitor('action:completed', { tool: step.tool, result: typeof result === 'string' ? result.slice(0, 200) : '' })
      return this.formatActionOutput({
        message: result,
        timedout: false,
        interrupted: false,
      })
    }
    catch (error) {
      if (error instanceof ActionAbortedError) {
        const isTimeout = error.reason.includes('timed out')
        monitorBus.emitMonitor(isTimeout ? 'action:timeout' : 'action:interrupted', {
          tool: step.tool,
          error: error.message,
          reason: error.reason,
        })
        this.logger.withError(error).warn(isTimeout ? 'Action timed out and was aborted' : 'Action interrupted')
        throw error
      }
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.mineflayer.abortCurrentAction(`Action failed: ${errorMsg}`)
      try {
        this.mineflayer.emit?.('interrupt')
      }
      catch {
        // best-effort cleanup
      }
      const isTimeout = errorMsg.includes('timed out')
      const inventoryFailureMatch = errorMsg.match(/\(([^)]+)\)/)
      const failureClass = errorMsg.startsWith('Inventory ')
        ? (inventoryFailureMatch?.[1] || 'inventory_failure')
        : classifyActionFailure(step.tool, errorMsg)
      const structuredResult = isTimeout
        ? 'timeout'
        : errorMsg.includes('Action verification failed')
          ? 'verification_failed'
          : 'failed'
      const repeatedCount = this.recordFailure(step, failureClass)
      this.mineflayer.memory?.recordActionOutcome?.({
        actionName: step.tool,
        result: structuredResult,
        failureClass,
        goalId: step.meta?.goalId,
        subgoalId: step.meta?.subgoalId || step.description,
        currentMilestone: step.meta?.currentMilestone,
      })
      let recoveryActions: string[] = []
      if (isInventoryManagedAction(step)) {
        try {
          const recovery = await recoverInventoryFailure(this.mineflayer, step, failureClass)
          recoveryActions = recovery.actions
        }
        catch (recoveryError) {
          this.logger.withError(recoveryError).warn('Inventory recovery failed after action error')
        }
      }
      monitorBus.emitMonitor(isTimeout ? 'action:timeout' : 'action:failed', {
        tool: step.tool,
        error: errorMsg,
        failureClass,
        repeatedCount,
        recoveryActions,
        capabilitySnapshotHash: String((this.mineflayer.getBridgeDebugState?.() as Record<string, any> | null)?.capabilitySnapshot?.capabilityHash ?? ''),
      })
      if (isRecoverableActionFailure(step.tool, errorMsg)) {
        this.logger.withError(error).warn('Action failed (recoverable)')
      }
      else {
        this.logger.withError(error).error('Action failed')
      }
      if (repeatedCount >= 3) {
        throw new Error(`Repeated failing action aborted (${failureClass})`)
      }
      throw error
    }
    finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
      this.mineflayer.completeAction(actionSignal)
      this.updateActionState(false)
    }
  }

  public getAvailableActions(): Action[] {
    return Array.from(this.actions.values())
  }

  private recordFailure(step: PlanStep, failureClass: string): number {
    const key = `${step.meta?.subgoalId || step.description}:${step.tool}:${failureClass}`
    const count = (this.repeatedFailures.get(key) ?? 0) + 1
    this.repeatedFailures.set(key, count)
    return count
  }

  private clearFailure(step: PlanStep, failureClass?: string): void {
    if (failureClass) {
      this.repeatedFailures.delete(`${step.meta?.subgoalId || step.description}:${step.tool}:${failureClass}`)
      return
    }

    for (const key of this.repeatedFailures.keys()) {
      if (key.startsWith(`${step.meta?.subgoalId || step.description}:${step.tool}:`)) {
        this.repeatedFailures.delete(key)
      }
    }
  }

  private async handleAgentMessage(sender: string, message: string): Promise<void> {
    if (sender === 'system' && message.includes('interrupt') && this.currentActionState.executing) {
      // Handle interruption
      this.logger.log('Received interrupt request')
      // Additional interrupt handling logic here
    }
  }

  private updateActionState(executing: boolean, label = ''): void {
    this.currentActionState = {
      executing,
      label,
      startTime: executing ? Date.now() : this.currentActionState.startTime,
    }
  }

  private formatActionOutput(result: { message: string | null, timedout: boolean, interrupted: boolean }): string {
    if (result.timedout) {
      return 'Action timed out'
    }
    if (result.interrupted) {
      return 'Action was interrupted'
    }
    return result.message || 'Action completed successfully'
  }
}
