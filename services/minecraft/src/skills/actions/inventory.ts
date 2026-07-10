import type { Item } from 'prismarine-item'

import type { CanonicalInventorySnapshot, InventoryActionKind, InventoryTaskContext } from '../../libs/inventory/policy'
import type { Mineflayer } from '../../libs/mineflayer'

import { sleep } from '@moeru/std'

import { BridgeUnsupportedCommandError } from '../../libs/fabric-bridge/bot-proxy'
import {
  buildCanonicalInventorySnapshot,
  buildHotbarPolicy,
  describeInventoryTaskReadiness,
  formatCanonicalInventoryFacts,
  getSafeDiscardPlan,
  mineflayerSlotToRawSlot,
  normalizeInventoryItemName as normalizeCanonicalInventoryItemName,
  selectBestToolSlot,
} from '../../libs/inventory/policy'
import { useLogger } from '../../utils/logger'
import { getSelectedCraftRecipeRequirements } from '../crafting'
import { goToPlayer, goToPosition } from '../movement'
import { getNearestBlock } from '../world'

const logger = useLogger()
const MAX_DISCARD_ATTEMPTS = 32
const OPTIMISTIC_ITEM_TTL_MS = 30_000
const optimisticItemCounts = new Map<string, { count: number, updatedAt: number }>()

interface InventoryCountLike {
  name: string
  count: number
}

interface BridgeInventorySnapshot {
  items?: InventoryCountLike[]
  selectedSlot?: number
}

interface RawInventoryCountLike extends InventoryCountLike {
  slot?: number
  maxCount?: number
  durability?: number
  maxDurability?: number
}

interface InventoryStepLike {
  tool: string
  description?: string
  params: Record<string, unknown>
}

interface InventoryBotSlotLike {
  slot?: number
  name?: string
  count?: number
  maxDurability?: number
  durability?: number
}

interface BridgeCanonicalBot {
  heldItem?: InventoryBotSlotLike | null
  inventory: {
    selectedSlot?: number
    slots?: Array<InventoryBotSlotLike | null | undefined>
    items: () => RawInventoryCountLike[]
    emptySlotCount?: () => number
    findInventoryItem?: (itemType: number, metadata: unknown, notFull?: boolean) => InventoryBotSlotLike | null
  }
  getCanonicalInventorySnapshot?: () => CanonicalInventorySnapshot
  getStrictRawInventoryItems?: () => RawInventoryCountLike[]
  getRawInventoryItems?: () => RawInventoryCountLike[]
  refreshInventory?: () => Promise<void>
  moveSlotItem?: (fromSlot: number, toSlot: number) => Promise<void>
  selectHotbarSlot?: (slot: number) => Promise<void>
  compactInventory?: (maxOperations?: number) => Promise<void>
  getBridgeCapabilitySnapshot?: () => {
    unsupportedCommands?: string[]
  }
}

interface InventoryCapabilityFlags {
  canCompactInventory: boolean
  canSwapSlots: boolean
}

export interface InventoryPreflightResult {
  ok: boolean
  failureClass?: string
  task: InventoryTaskContext
  snapshot: CanonicalInventorySnapshot
  actions: string[]
  facts: string[]
}

export interface InventoryRecoveryResult {
  recovered: boolean
  failureClass: string
  actions: string[]
  snapshot: CanonicalInventorySnapshot
}

function normalizeItemName(itemName: string): string {
  return itemName.replace(/^minecraft:/, '').trim().toLowerCase()
}

function normalizeCraftRecipeName(recipeName: string): string {
  return normalizeItemName(recipeName).replace(/\s+/g, '_')
}

function resolveEnsureManagedCraftRecipe(
  recipeName: string,
  recipeCount: number,
): 'crafting_table' | 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'hoe' | undefined {
  const normalized = normalizeCraftRecipeName(recipeName)

  if (normalized === 'crafting_table') {
    return 'crafting_table'
  }

  if (normalized === 'pickaxe' || normalized === 'pick_axe') {
    return 'pickaxe'
  }
  if (normalized === 'axe') {
    return 'axe'
  }
  if (normalized === 'shovel') {
    return 'shovel'
  }
  if (normalized === 'sword') {
    return 'sword'
  }
  if (normalized === 'hoe') {
    return 'hoe'
  }

  if (normalized === 'wooden_pickaxe') {
    return 'pickaxe'
  }
  if (normalized === 'stone_pickaxe' && recipeCount === 1) {
    return 'pickaxe'
  }

  if (normalized.endsWith('_axe') && !normalized.endsWith('_pickaxe')) {
    return 'axe'
  }
  if (normalized.endsWith('_shovel')) {
    return 'shovel'
  }
  if (normalized.endsWith('_sword')) {
    return 'sword'
  }
  if (normalized.endsWith('_hoe')) {
    return 'hoe'
  }

  return undefined
}

function isAttackFallbackTool(itemName: string | undefined): boolean {
  const normalized = normalizeCanonicalInventoryItemName(itemName)
  return normalized.endsWith('_axe')
    || normalized.endsWith('_pickaxe')
    || normalized.endsWith('_shovel')
}

function isAttackReadySlot(slot: CanonicalInventorySnapshot['slots'][number] | null | undefined): boolean {
  return Boolean(
    slot?.itemName
    && slot.itemName !== 'shield'
    && (
      slot.categories.includes('weapon')
      || isAttackFallbackTool(slot.itemName)
    ),
  )
}

function canCollectBlockByHand(blockName: string): boolean {
  const normalized = normalizeItemName(blockName)
  return normalized === 'log'
    || normalized.endsWith('_log')
    || normalized.endsWith('_stem')
    || normalized.endsWith('_hyphae')
}

function getInventoryBot(mineflayer: Mineflayer): BridgeCanonicalBot {
  return mineflayer.bot as unknown as BridgeCanonicalBot
}

function getInventoryCapabilityFlags(mineflayer: Mineflayer): InventoryCapabilityFlags {
  const bot = getInventoryBot(mineflayer)
  const unsupportedCommands = new Set(bot.getBridgeCapabilitySnapshot?.().unsupportedCommands ?? [])

  return {
    canCompactInventory: typeof bot.compactInventory === 'function' && !unsupportedCommands.has('compactInventory'),
    canSwapSlots: typeof bot.moveSlotItem === 'function' && !unsupportedCommands.has('swapInventorySlots'),
  }
}

function isUnsupportedBridgeCommand(error: unknown, command: string): boolean {
  if (error instanceof BridgeUnsupportedCommandError) {
    return error.command === command
  }

  const message = error instanceof Error ? error.message : String(error)
  return message.includes(`Unknown command: ${command}`)
    || message.includes(`Bridge command unsupported (${command})`)
}

async function tryMoveSlotItem(
  mineflayer: Mineflayer,
  fromSlot: number,
  toSlot: number,
  actions: string[],
  reason: 'organize' | 'preflight',
): Promise<boolean> {
  const bot = getInventoryBot(mineflayer)
  if (typeof bot.moveSlotItem !== 'function') {
    return false
  }

  try {
    await bot.moveSlotItem(fromSlot, toSlot)
    return true
  }
  catch (error) {
    if (!isUnsupportedBridgeCommand(error, 'swapInventorySlots')) {
      throw error
    }

    actions.push(`swapInventorySlots:skipped:unsupported_capability:${fromSlot}->${toSlot}`)
    logger.withFields({
      command: 'swapInventorySlots',
      fromSlot,
      toSlot,
      failure_class: 'unsupported_capability',
      phase: reason,
    }).warn('Inventory flow skipped unsupported slot-swap command')
    return false
  }
}

async function trySelectHotbarSlot(
  mineflayer: Mineflayer,
  hotbarIndex: number,
  actions: string[],
): Promise<boolean> {
  const bot = getInventoryBot(mineflayer)
  if (typeof bot.selectHotbarSlot !== 'function') {
    return false
  }

  try {
    await bot.selectHotbarSlot(hotbarIndex)
    return true
  }
  catch (error) {
    if (!isUnsupportedBridgeCommand(error, 'selectHotbarSlot')) {
      throw error
    }

    actions.push(`selectHotbarSlot:skipped:unsupported_capability:${hotbarIndex}`)
    logger.withFields({
      command: 'selectHotbarSlot',
      hotbarIndex,
      failure_class: 'unsupported_capability',
      phase: 'preflight',
    }).warn('Inventory flow skipped unsupported hotbar-select command')
    return false
  }
}

function sanitizeRawInventoryItems(items: RawInventoryCountLike[] | undefined): Array<Required<Pick<RawInventoryCountLike, 'slot'>> & RawInventoryCountLike> | undefined {
  if (!Array.isArray(items)) {
    return undefined
  }

  return items.filter((item): item is Array<Required<Pick<RawInventoryCountLike, 'slot'>> & RawInventoryCountLike>[number] =>
    typeof item?.slot === 'number'
    && typeof item?.name === 'string')
}

function toRawInventoryItem(item: InventoryBotSlotLike | null | undefined, fallbackSlot?: number): RawInventoryCountLike | null {
  if (!item) {
    return null
  }
  const rawSlot = typeof item.slot === 'number'
    ? mineflayerSlotToRawSlot(item.slot)
    : typeof fallbackSlot === 'number'
      ? fallbackSlot
      : null

  if (rawSlot === null || !item.name) {
    return null
  }

  return {
    slot: rawSlot,
    name: item.name,
    count: item.count ?? 1,
    maxCount: 64,
    durability: item.durability ?? 0,
    maxDurability: item.maxDurability ?? 0,
  }
}

function getFallbackCanonicalInventorySnapshot(mineflayer: Mineflayer, sourceKind: string): CanonicalInventorySnapshot {
  const bot = getInventoryBot(mineflayer)
  const strictItems = typeof bot.getStrictRawInventoryItems === 'function'
    ? bot.getStrictRawInventoryItems()
    : undefined
  const guardedItems = typeof bot.getRawInventoryItems === 'function'
    ? bot.getRawInventoryItems()
    : undefined
  const trackedItems = bot.inventory.items()
    .map(item => toRawInventoryItem(item))
    .filter((item): item is RawInventoryCountLike => item !== null)
  const armor = [5, 6, 7, 8]
    .map((slotIndex, index) => toRawInventoryItem(
      bot.inventory.slots?.[slotIndex] ?? null,
      [39, 38, 37, 36][index],
    ))
    .filter((item): item is RawInventoryCountLike => item !== null)
  const offhand = toRawInventoryItem(bot.inventory.slots?.[45] ?? null, 40)

  return buildCanonicalInventorySnapshot({
    strictItems: sanitizeRawInventoryItems(strictItems),
    guardedItems: sanitizeRawInventoryItems(guardedItems),
    trackedItems: sanitizeRawInventoryItems(trackedItems),
    selectedSlot: bot.inventory.selectedSlot ?? 0,
    armor: sanitizeRawInventoryItems(armor),
    offhand: offhand && typeof offhand.slot === 'number'
      ? {
          ...offhand,
          slot: offhand.slot,
        }
      : undefined,
    heldItem: bot.heldItem ?? null,
    sourceKind,
  })
}

export function getCanonicalInventorySnapshot(
  mineflayer: Mineflayer,
  sourceKind = 'skills.actions.inventory',
): CanonicalInventorySnapshot {
  const bot = getInventoryBot(mineflayer)
  if (typeof bot.getCanonicalInventorySnapshot === 'function') {
    return bot.getCanonicalInventorySnapshot()
  }
  return getFallbackCanonicalInventorySnapshot(mineflayer, sourceKind)
}

function getEquipDestination(itemName: string): 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand' {
  if (itemName.includes('leggings')) {
    return 'legs'
  }
  if (itemName.includes('boots')) {
    return 'feet'
  }
  if (itemName.includes('helmet')) {
    return 'head'
  }
  if (itemName.includes('chestplate') || itemName.includes('elytra')) {
    return 'torso'
  }
  if (itemName.includes('shield')) {
    return 'off-hand'
  }
  return 'hand'
}

function findSnapshotSlot(
  snapshot: CanonicalInventorySnapshot,
  predicate: (slot: CanonicalInventorySnapshot['slots'][number]) => boolean,
): CanonicalInventorySnapshot['slots'][number] | null {
  return snapshot.slots.find(slot => slot.itemName && predicate(slot)) ?? null
}

function getToolTier(itemName: string | null | undefined): number {
  const normalized = normalizeCanonicalInventoryItemName(itemName)
  if (normalized.includes('netherite_')) {
    return 5
  }
  if (normalized.includes('diamond_')) {
    return 4
  }
  if (normalized.includes('iron_')) {
    return 3
  }
  if (normalized.includes('stone_')) {
    return 2
  }
  if (normalized.includes('wooden_') || normalized.includes('golden_')) {
    return 1
  }
  return 0
}

function getRequiredMiningToolTier(blockName: string | null | undefined): number {
  const normalized = normalizeCanonicalInventoryItemName(blockName)
  if (!normalized) {
    return 0
  }
  if (normalized === 'obsidian') {
    return 4
  }
  if (
    normalized.includes('diamond_ore')
    || normalized.includes('emerald_ore')
    || normalized.includes('redstone_ore')
    || normalized.includes('gold_ore')
  ) {
    return 3
  }
  if (
    normalized.includes('iron_ore')
    || normalized.includes('lapis_ore')
    || normalized.includes('copper_ore')
    || normalized.includes('deepslate')
  ) {
    return 2
  }
  if (normalized === 'stone' || normalized === 'cobblestone' || normalized.includes('coal_ore')) {
    return 1
  }
  return 0
}

function isMiningToolUsableForTask(itemName: string | null | undefined, task: InventoryTaskContext): boolean {
  const normalizedItemName = normalizeCanonicalInventoryItemName(itemName)
  if (!normalizedItemName) {
    return false
  }
  if (task.preferredToolCategory && !normalizedItemName.includes(task.preferredToolCategory)) {
    return false
  }
  if (!task.preferredToolCategory && !normalizedItemName.includes('pickaxe') && !normalizedItemName.includes('axe') && !normalizedItemName.includes('shovel') && !normalizedItemName.includes('hoe')) {
    return false
  }
  const requiredPickaxeTier = getRequiredMiningToolTier(task.targetBlockName)
  if (requiredPickaxeTier > 0) {
    return normalizedItemName.includes('pickaxe') && getToolTier(normalizedItemName) >= requiredPickaxeTier
  }
  return true
}

function findTaskItemSlot(snapshot: CanonicalInventorySnapshot, task: InventoryTaskContext): CanonicalInventorySnapshot['slots'][number] | null {
  const normalizedTargetItem = normalizeCanonicalInventoryItemName(task.targetItemName)
  if (normalizedTargetItem) {
    return findSnapshotSlot(snapshot, slot => slot.itemName === normalizedTargetItem)
  }

  switch (task.actionKind) {
    case 'consume':
      return findSnapshotSlot(snapshot, slot => slot.categories.includes('food'))
    case 'attack':
      return findSnapshotSlot(snapshot, slot => slot.itemName !== 'shield' && slot.categories.includes('weapon'))
        ?? findSnapshotSlot(snapshot, slot => isAttackReadySlot(slot))
        ?? findSnapshotSlot(snapshot, slot => slot.itemName === 'shield')
    case 'place':
      return findSnapshotSlot(snapshot, slot => slot.categories.includes('block'))
    case 'mine': {
      const bestToolSlot = selectBestToolSlot(snapshot, task.targetBlockName)
      if (bestToolSlot?.itemName && isMiningToolUsableForTask(bestToolSlot.itemName, task)) {
        return bestToolSlot
      }
      return findSnapshotSlot(snapshot, slot => slot.itemName !== null && isMiningToolUsableForTask(slot.itemName, task))
    }
    case 'craft':
      return findSnapshotSlot(snapshot, slot =>
        slot.itemName === 'crafting_table'
        || slot.itemName === 'stick'
        || slot.categories.includes('crafting_material'))
    case 'smelt':
      return findSnapshotSlot(snapshot, slot =>
        slot.itemName === 'furnace'
        || slot.categories.includes('fuel')
        || slot.categories.includes('smelting_material'))
    default:
      return null
  }
}

function isShieldEquippedInOffhand(snapshot: CanonicalInventorySnapshot): boolean {
  return snapshot.offhand?.itemName === 'shield'
}

function findPreferredOffhandSlot(snapshot: CanonicalInventorySnapshot): CanonicalInventorySnapshot['slots'][number] | null {
  return findSnapshotSlot(snapshot, slot => slot.itemName === 'shield')
}

async function ensurePreferredOffhandItem(
  mineflayer: Mineflayer,
  snapshot: CanonicalInventorySnapshot,
  actions: string[],
): Promise<CanonicalInventorySnapshot> {
  if (isShieldEquippedInOffhand(snapshot)) {
    return snapshot
  }

  const shieldSlot = findPreferredOffhandSlot(snapshot)
  if (!shieldSlot) {
    return snapshot
  }

  const shieldItem = mineflayer.bot.inventory.items().find(item =>
    normalizeCanonicalInventoryItemName(item.name) === 'shield')
  if (!shieldItem) {
    return snapshot
  }

  await mineflayer.bot.equip(shieldItem as Item, 'off-hand')
  actions.push('equip-offhand:shield')
  return refreshCanonicalInventorySnapshot(mineflayer, 'inventory-offhand:shield')
}

function getInventoryOrganizerTargetFreeSlots(
  snapshot: CanonicalInventorySnapshot,
  task: InventoryTaskContext,
): number {
  const baselineFreeSlots = Math.max(task.requiredFreeSlots ?? 1, task.reserveQuickLootSlot === false ? 1 : 2)

  // NOTICE: `inventory_alerts` starts flagging pressure at <= 2 free slots.
  // Keep one extra slot available so the organizer can clear the alert instead
  // of hovering at the same threshold and retriggering recovery every loop.
  return snapshot.freeSlotCount <= 2
    ? Math.max(baselineFreeSlots, 3)
    : baselineFreeSlots
}

function shouldRunInventoryOrganizer(
  mineflayer: Mineflayer,
  snapshot: CanonicalInventorySnapshot,
  task: InventoryTaskContext,
): boolean {
  const capabilityFlags = getInventoryCapabilityFlags(mineflayer)
  const quickLootBlocked = Boolean(
    (task.reserveQuickLootSlot ?? false)
    && snapshot.slots.find(slot => slot.slotIndex === 8)?.itemName,
  )
  const targetFreeSlots = getInventoryOrganizerTargetFreeSlots(snapshot, task)
  const pressureReliefAvailable = snapshot.freeSlotCount < targetFreeSlots
    && getSafeDiscardPlan(snapshot, targetFreeSlots).length > 0
  const slotShuffleUseful = capabilityFlags.canSwapSlots
    && (
      snapshot.compactness.lowValueHotbarSlots.length > 0
      || snapshot.defaultHotbarPolicy.violations.length > 0
      || quickLootBlocked
    )

  return (snapshot.compactness.fragmentedStacks > 0 && capabilityFlags.canCompactInventory)
    || slotShuffleUseful
    || pressureReliefAvailable
}

function deriveInventoryTaskContextFromStep(step: InventoryStepLike): InventoryTaskContext {
  switch (step.tool) {
    case 'collectBlocks': {
      const targetBlockName = normalizeItemName(String(step.params.type ?? ''))
      const allowsEmptyHand = canCollectBlockByHand(targetBlockName)
      const preferredToolCategory = targetBlockName.includes('log')
        || targetBlockName.includes('wood')
        || targetBlockName.includes('stem')
        || targetBlockName.includes('hyphae')
        ? 'axe'
        : 'pickaxe'
      return {
        actionKind: 'mine',
        targetBlockName,
        preferredToolCategory,
        allowsEmptyHand,
        desiredHotbarIndex: 0,
        reserveQuickLootSlot: true,
        requiredFreeSlots: 1,
      }
    }
    case 'attack':
      return {
        actionKind: 'attack',
        preferredToolCategory: 'sword',
        desiredHotbarIndex: 1,
        requiredFreeSlots: 0,
      }
    case 'placeHere':
      return {
        actionKind: 'place',
        targetItemName: String(step.params.type ?? ''),
        desiredHotbarIndex: 4,
        reserveQuickLootSlot: false,
        requiredFreeSlots: 0,
      }
    case 'consume':
      return {
        actionKind: 'consume',
        targetItemName: String(step.params.item_name ?? ''),
        desiredHotbarIndex: 3,
        requiredFreeSlots: 0,
      }
    case 'craftRecipe':
      return {
        actionKind: 'craft',
        targetItemName: String(step.params.recipe_name ?? ''),
        desiredHotbarIndex: 6,
        reserveQuickLootSlot: true,
        requiredFreeSlots: 1,
      }
    case 'smeltItem':
      return {
        actionKind: 'smelt',
        targetItemName: String(step.params.item_name ?? ''),
        desiredHotbarIndex: 6,
        reserveQuickLootSlot: true,
        requiredFreeSlots: 1,
      }
    case 'equip':
      return {
        actionKind: 'equip',
        targetItemName: String(step.params.item_name ?? ''),
        desiredHotbarIndex: 0,
        requiredFreeSlots: 0,
      }
    default:
      return {
        actionKind: 'generic',
        targetItemName: String(step.params.item_name ?? step.params.type ?? ''),
        reserveQuickLootSlot: true,
        requiredFreeSlots: 0,
      }
  }
}

function isItemEquippedForTask(snapshot: CanonicalInventorySnapshot, task: InventoryTaskContext): boolean {
  const targetItemName = normalizeCanonicalInventoryItemName(task.targetItemName)
  if (!targetItemName) {
    return task.actionKind === 'generic'
  }

  if (task.actionKind === 'equip') {
    if (targetItemName.includes('leggings')) {
      return snapshot.armor.some(slot => slot.itemName === targetItemName && slot.slotIndex === 37)
    }
    if (targetItemName.includes('boots')) {
      return snapshot.armor.some(slot => slot.itemName === targetItemName && slot.slotIndex === 36)
    }
    if (targetItemName.includes('helmet')) {
      return snapshot.armor.some(slot => slot.itemName === targetItemName && slot.slotIndex === 39)
    }
    if (targetItemName.includes('chestplate') || targetItemName.includes('elytra')) {
      return snapshot.armor.some(slot => slot.itemName === targetItemName && slot.slotIndex === 38)
    }
    if (targetItemName.includes('shield')) {
      return snapshot.offhand?.itemName === targetItemName
    }
  }

  return snapshot.heldItem?.itemName === targetItemName
}

function isHeldItemUsableForTask(snapshot: CanonicalInventorySnapshot, task: InventoryTaskContext): boolean {
  const heldItem = snapshot.heldItem
  if (!heldItem?.itemName) {
    return false
  }

  const targetItemName = normalizeCanonicalInventoryItemName(task.targetItemName)
  switch (task.actionKind) {
    case 'mine':
      return heldItem.categories.includes('tool') && isMiningToolUsableForTask(heldItem.itemName, task)
    case 'attack':
      return heldItem.itemName !== 'shield'
        && (heldItem.categories.includes('weapon') || isAttackFallbackTool(heldItem.itemName))
    case 'consume':
      return targetItemName
        ? heldItem.itemName === targetItemName
        : heldItem.categories.includes('food')
    case 'place':
      return targetItemName
        ? heldItem.itemName === targetItemName
        : heldItem.categories.includes('block')
    case 'use':
      return targetItemName
        ? heldItem.itemName === targetItemName
        : heldItem.categories.includes('utility')
    default:
      return false
  }
}

function isLiveHeldItemUsableForTask(
  mineflayer: Mineflayer,
  snapshot: CanonicalInventorySnapshot,
  task: InventoryTaskContext,
): boolean {
  const liveHeldItemName = normalizeCanonicalInventoryItemName(mineflayer.bot.heldItem?.name)
  if (!liveHeldItemName) {
    return false
  }

  const observedSlot = snapshot.slots.find(slot => slot.itemName === liveHeldItemName) ?? null
  const targetItemName = normalizeCanonicalInventoryItemName(task.targetItemName)
  switch (task.actionKind) {
    case 'mine':
      return (observedSlot?.categories.includes('tool') ?? false) && isMiningToolUsableForTask(liveHeldItemName, task)
    case 'attack':
      return liveHeldItemName !== 'shield'
        && (observedSlot?.categories.includes('weapon') ?? isAttackFallbackTool(liveHeldItemName))
    case 'consume':
      return targetItemName
        ? liveHeldItemName === targetItemName
        : observedSlot?.categories.includes('food') ?? false
    case 'place':
      return targetItemName
        ? liveHeldItemName === targetItemName
        : observedSlot?.categories.includes('block') ?? false
    case 'use':
      return targetItemName
        ? liveHeldItemName === targetItemName
        : observedSlot?.categories.includes('utility') ?? false
    default:
      return false
  }
}

function hasSnapshotItemForTask(snapshot: CanonicalInventorySnapshot, task: InventoryTaskContext): boolean {
  const targetItemName = normalizeCanonicalInventoryItemName(task.targetItemName)
  if (!targetItemName) {
    return Boolean(findTaskItemSlot(snapshot, task))
  }

  return countSnapshotItemsForRequirement(snapshot, targetItemName) > 0
}

function canUseBareHandMiningWithoutHotbarReorder(snapshot: CanonicalInventorySnapshot, task: InventoryTaskContext): boolean {
  return Boolean(task.actionKind === 'mine' && task.allowsEmptyHand && !findTaskItemSlot(snapshot, task))
}

async function refreshCanonicalInventorySnapshot(
  mineflayer: Mineflayer,
  sourceKind: string,
): Promise<CanonicalInventorySnapshot> {
  await refreshInventoryState(mineflayer)
  return getCanonicalInventorySnapshot(mineflayer, sourceKind)
}

function countMatchingItems(items: InventoryCountLike[], itemName: string): number {
  const normalizedQuery = normalizeItemName(itemName)
  return items
    .filter(item => normalizeItemName(item.name).includes(normalizedQuery))
    .reduce((acc, item) => acc + item.count, 0)
}

function getStrictVisibleInventoryItems(
  mineflayer: Mineflayer,
): RawInventoryCountLike[] | null {
  const bot = mineflayer.bot as typeof mineflayer.bot & {
    getStrictRawInventoryItems?: () => RawInventoryCountLike[]
    getRawInventoryItems?: () => RawInventoryCountLike[]
  }

  if (typeof bot.getStrictRawInventoryItems === 'function') {
    const strictRawItems = bot.getStrictRawInventoryItems()
    if (Array.isArray(strictRawItems)) {
      return strictRawItems
    }
  }

  if (typeof bot.getRawInventoryItems === 'function') {
    const rawItems = bot.getRawInventoryItems()
    if (Array.isArray(rawItems)) {
      return rawItems
    }
  }

  return null
}

function getOptimisticItemCount(itemName: string): number {
  const normalizedQuery = normalizeItemName(itemName)
  let total = 0
  const now = Date.now()

  for (const [name, entry] of optimisticItemCounts.entries()) {
    if (now - entry.updatedAt > OPTIMISTIC_ITEM_TTL_MS) {
      optimisticItemCounts.delete(name)
      continue
    }
    if (name.includes(normalizedQuery)) {
      total += entry.count
    }
  }

  return total
}

function reconcileOptimisticItems(mineflayer: Mineflayer): void {
  const now = Date.now()

  for (const [name, entry] of optimisticItemCounts.entries()) {
    if (now - entry.updatedAt > OPTIMISTIC_ITEM_TTL_MS) {
      optimisticItemCounts.delete(name)
      continue
    }

    if (getActualItemCount(mineflayer, name) >= entry.count) {
      optimisticItemCounts.delete(name)
    }
  }
}

export function recordOptimisticItem(itemName: string, count: number): void {
  if (count <= 0) {
    return
  }

  const normalizedName = normalizeItemName(itemName)
  const existing = optimisticItemCounts.get(normalizedName)
  optimisticItemCounts.set(normalizedName, {
    count: Math.max(existing?.count ?? 0, count),
    updatedAt: Date.now(),
  })
}

export function adjustOptimisticItemCount(itemName: string, delta: number): void {
  if (delta === 0) {
    return
  }

  const normalizedName = normalizeItemName(itemName)
  const existing = optimisticItemCounts.get(normalizedName)
  const nextCount = (existing?.count ?? 0) + delta

  if (nextCount <= 0) {
    optimisticItemCounts.delete(normalizedName)
    return
  }

  optimisticItemCounts.set(normalizedName, {
    count: nextCount,
    updatedAt: Date.now(),
  })
}

export function consumeOptimisticItemsMatchingQuery(itemQuery: string, count: number): void {
  if (count <= 0) {
    return
  }

  const normalizedQuery = normalizeItemName(itemQuery)
  const matchingEntries = [...optimisticItemCounts.entries()]
    .filter(([name]) => name.includes(normalizedQuery))
    .sort((left, right) => right[1].count - left[1].count)

  let remaining = Math.floor(count)
  for (const [name, entry] of matchingEntries) {
    if (remaining <= 0) {
      break
    }

    const consumedCount = Math.min(entry.count, remaining)
    remaining -= consumedCount
    const nextCount = entry.count - consumedCount

    if (nextCount <= 0) {
      optimisticItemCounts.delete(name)
      continue
    }

    optimisticItemCounts.set(name, {
      count: nextCount,
      updatedAt: Date.now(),
    })
  }
}

export function clearOptimisticItems(itemName?: string): void {
  if (!itemName) {
    optimisticItemCounts.clear()
    return
  }

  const normalizedQuery = normalizeItemName(itemName)
  for (const name of optimisticItemCounts.keys()) {
    if (name.includes(normalizedQuery)) {
      optimisticItemCounts.delete(name)
    }
  }
}

export async function refreshInventoryState(mineflayer: Mineflayer): Promise<boolean> {
  const bot = mineflayer.bot as typeof mineflayer.bot & {
    refreshInventory?: () => Promise<void>
  }

  if (typeof bot.refreshInventory !== 'function') {
    return false
  }

  await bot.refreshInventory()
  reconcileOptimisticItems(mineflayer)
  return true
}

export async function getBridgeInventorySnapshot(mineflayer: Mineflayer): Promise<InventoryCountLike[] | null> {
  const bot = mineflayer.bot as typeof mineflayer.bot & {
    getStrictInventorySnapshot?: () => Promise<BridgeInventorySnapshot>
    getStrictRawInventoryItems?: () => RawInventoryCountLike[]
    getInventorySnapshot?: () => Promise<BridgeInventorySnapshot>
  }

  if (typeof bot.getStrictInventorySnapshot === 'function') {
    try {
      const snapshot = await bot.getStrictInventorySnapshot()
      return Array.isArray(snapshot.items) ? snapshot.items : []
    }
    catch {
      return null
    }
  }

  if (typeof bot.getStrictRawInventoryItems === 'function') {
    const strictRawItems = bot.getStrictRawInventoryItems()
    if (Array.isArray(strictRawItems)) {
      return strictRawItems
    }
  }

  if (typeof bot.getInventorySnapshot !== 'function') {
    return null
  }

  try {
    const snapshot = await bot.getInventorySnapshot()
    return Array.isArray(snapshot.items) ? snapshot.items : []
  }
  catch {
    return null
  }
}

export async function getBridgeActualItemCount(mineflayer: Mineflayer, itemName: string): Promise<number | null> {
  const snapshot = await getBridgeInventorySnapshot(mineflayer)
  if (!snapshot) {
    return null
  }

  return countMatchingItems(snapshot, itemName)
}

async function getBestActualItemCount(mineflayer: Mineflayer, itemName: string): Promise<number> {
  const bridgeCount = await getBridgeActualItemCount(mineflayer, itemName)
  const localActualCount = getActualItemCount(mineflayer, itemName)

  // NOTICE: FabricBridge's explicit snapshot can lag behind the in-memory inventory view
  // immediately after a successful craft. Treat the higher of the two actual sources as the
  // confirmed count so we do not stall on stale bridge snapshots while still avoiding
  // optimistic-overlay false positives.
  return Math.max(localActualCount, bridgeCount ?? 0)
}

export async function confirmItemCount(
  mineflayer: Mineflayer,
  itemName: string,
  minCount: number = 1,
  options?: {
    attempts?: number
    delayMs?: number
    refresh?: boolean
    actualOnly?: boolean
    localVisibleOnly?: boolean
    consecutiveSuccessesNeeded?: number
  },
): Promise<boolean> {
  const attempts = options?.attempts ?? 4
  const delayMs = options?.delayMs ?? 150
  const refresh = options?.refresh ?? true
  const actualOnly = options?.actualOnly ?? false
  const localVisibleOnly = options?.localVisibleOnly ?? false
  const consecutiveSuccessesNeeded = Math.max(1, options?.consecutiveSuccessesNeeded ?? 1)
  let consecutiveSuccesses = 0
  const readCount = async (): Promise<number> => {
    if (actualOnly) {
      if (localVisibleOnly) {
        return getStrictVisibleItemCount(mineflayer, itemName)
      }

      return await getBestActualItemCount(mineflayer, itemName)
    }

    return getItemCount(mineflayer, itemName)
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await readCount() >= minCount) {
      consecutiveSuccesses++
      if (consecutiveSuccesses >= consecutiveSuccessesNeeded) {
        return true
      }
    }
    else {
      consecutiveSuccesses = 0
    }

    if (attempt < attempts - 1) {
      if (refresh) {
        await refreshInventoryState(mineflayer)
      }
      await sleep(delayMs)
    }
  }

  return false
}

/**
 * Equip an item from the bot's inventory.
 * @param mineflayer The mineflayer instance.
 * @param itemName The name of the item to equip.
 * @returns Whether the item was successfully equipped.
 */
export async function equip(mineflayer: Mineflayer, itemName: string): Promise<boolean> {
  const normalizedItemName = normalizeItemName(itemName)
  const item = mineflayer.bot.inventory
    .items()
    .find(item => normalizeItemName(item.name).includes(normalizedItemName))
  if (!item) {
    logger.log(`You do not have any ${itemName} to equip.`)
    return false
  }

  await mineflayer.bot.equip(item, getEquipDestination(normalizedItemName))
  const verification = await verifyInventoryPostflight(mineflayer, {
    tool: 'equip',
    params: { item_name: normalizedItemName },
  })
  return verification.ok
}

/**
 * Discard an item from the bot's inventory.
 * @param mineflayer The mineflayer instance.
 * @param itemName The name of the item to discard.
 * @param num The number of items to discard. Default is -1 for all.
 * @returns Whether the item was successfully discarded.
 */
export async function discard(mineflayer: Mineflayer, itemName: string, num = -1): Promise<boolean> {
  let discarded = 0
  let attempts = 0
  while (attempts < MAX_DISCARD_ATTEMPTS) {
    attempts++
    const item = mineflayer.bot.inventory
      .items()
      .find(item => item.name.includes(itemName))
    if (!item) {
      break
    }
    const toDiscard
      = num === -1 ? item.count : Math.min(num - discarded, item.count)
    await mineflayer.bot.toss(item.type, null, toDiscard)
    discarded += toDiscard
    if (num !== -1 && discarded >= num) {
      break
    }
  }
  if (attempts >= MAX_DISCARD_ATTEMPTS) {
    logger.log(`Discard loop hit safety limit for ${itemName}.`)
  }
  if (discarded === 0) {
    logger.log(`You do not have any ${itemName} to discard.`)
    return false
  }
  logger.log(`Successfully discarded ${discarded} ${itemName}.`)
  return true
}

export async function putInChest(mineflayer: Mineflayer, itemName: string, num = -1): Promise<boolean> {
  const chest = getNearestBlock(mineflayer, 'chest', 32)
  if (!chest) {
    logger.log(`Could not find a chest nearby.`)
    return false
  }
  const item = mineflayer.bot.inventory
    .items()
    .find(item => item.name.includes(itemName))
  if (!item) {
    logger.log(`You do not have any ${itemName} to put in the chest.`)
    return false
  }
  const toPut = num === -1 ? item.count : Math.min(num, item.count)
  await goToPosition(mineflayer, chest.position.x, chest.position.y, chest.position.z)
  const chestContainer = await mineflayer.bot.openContainer(chest)
  await chestContainer.deposit(item.type, null, toPut)
  await chestContainer.close()
  logger.log(`Successfully put ${toPut} ${itemName} in the chest.`)
  return true
}

export async function takeFromChest(
  mineflayer: Mineflayer,
  itemName: string,
  num = -1,
): Promise<boolean> {
  const chest = getNearestBlock(mineflayer, 'chest', 32)
  if (!chest) {
    logger.log(`Could not find a chest nearby.`)
    return false
  }
  await goToPosition(mineflayer, chest.position.x, chest.position.y, chest.position.z)
  const chestContainer = await mineflayer.bot.openContainer(chest)
  const item = chestContainer
    .containerItems()
    .find(item => item.name.includes(itemName))
  if (!item) {
    logger.log(`Could not find any ${itemName} in the chest.`)
    await chestContainer.close()
    return false
  }
  const toTake = num === -1 ? item.count : Math.min(num, item.count)
  await chestContainer.withdraw(item.type, null, toTake)
  await chestContainer.close()
  logger.log(`Successfully took ${toTake} ${itemName} from the chest.`)
  return true
}

/**
 * View the contents of a chest near the bot.
 * @param mineflayer The mineflayer instance.
 * @returns Whether the chest was successfully viewed.
 */
export async function viewChest(mineflayer: Mineflayer): Promise<boolean> {
  const chest = getNearestBlock(mineflayer, 'chest', 32)
  if (!chest) {
    logger.log(`Could not find a chest nearby.`)
    return false
  }
  await goToPosition(mineflayer, chest.position.x, chest.position.y, chest.position.z)
  const chestContainer = await mineflayer.bot.openContainer(chest)
  const items = chestContainer.containerItems()
  if (items.length === 0) {
    logger.log(`The chest is empty.`)
  }
  else {
    logger.log(`The chest contains:`)
    for (const item of items) {
      logger.log(`${item.count} ${item.name}`)
    }
  }
  await chestContainer.close()
  return true
}

/**
 * Ask to bot to eat a food item from its inventory.
 * @param mineflayer The mineflayer instance.
 * @param foodName The name of the food item to eat.
 * @returns Whether the food was successfully eaten.
 */
export async function eat(mineflayer: Mineflayer, foodName = ''): Promise<boolean> {
  let item: Item | undefined
  let name: string
  if (foodName) {
    item = mineflayer.bot.inventory.items().find(item => item.name.includes(foodName))
    name = foodName
  }
  else {
    // @ts-expect-error -- ?
    item = mineflayer.bot.inventory.items().find(item => item.foodPoints > 0)
    name = 'food'
  }
  if (!item) {
    logger.log(`You do not have any ${name} to eat.`)
    return false
  }
  await mineflayer.bot.equip(item, 'hand')
  await mineflayer.bot.consume()
  logger.log(`Successfully ate ${item.name}.`)
  return true
}

/**
 * Give an item to a player.
 * @param mineflayer The mineflayer instance.
 * @param itemType The name of the item to give.
 * @param username The username of the player to give the item to.
 * @param num The number of items to give.
 * @returns Whether the item was successfully given.
 */
export async function giveToPlayer(
  mineflayer: Mineflayer,
  itemType: string,
  username: string,
  num = 1,
): Promise<boolean> {
  const player = mineflayer.bot.players[username]?.entity
  if (!player) {
    logger.log(`Could not find a player with username: ${username}.`)
    return false
  }
  await goToPlayer(mineflayer, username)
  await mineflayer.bot.lookAt(player.position)
  await discard(mineflayer, itemType, num)
  return true
}

/**
 * List the items in the bot's inventory.
 * @param mineflayer The mineflayer instance.
 * @returns An array of items in the bot's inventory.
 */
export async function listInventory(mineflayer: Mineflayer): Promise<{ name: string, count: number }[]> {
  const items = await mineflayer.bot.inventory.items()
  // sayItems(mineflayer, items)

  return items.map(item => ({
    name: item.name,
    count: item.count,
  }))
}

export async function checkForItem(mineflayer: Mineflayer, itemName: string): Promise<void> {
  const items = await mineflayer.bot.inventory.items()
  const searchableItems = items.filter(item => item.name.includes(itemName))
  sayItems(mineflayer, searchableItems)
}

export async function sayItems(mineflayer: Mineflayer, items: Array<Item> | null = null) {
  if (!items) {
    items = mineflayer.bot.inventory.items()
    if (mineflayer.bot.registry.isNewerOrEqualTo('1.9') && mineflayer.bot.inventory.slots[45])
      items.push(mineflayer.bot.inventory.slots[45])
  }
  const output = items.map(item => `${item.name} x ${item.count}`).join(', ')
  if (output) {
    mineflayer.bot.chat(`My inventory contains: ${output}`)
  }
  else {
    mineflayer.bot.chat('My inventory is empty.')
  }
}

/**
 * Find the number of free slots in the bot's inventory.
 * @param mineflayer The mineflayer instance.
 * @returns The number of free slots in the bot's inventory.
 */
export function checkFreeSpace(mineflayer: Mineflayer): number {
  const freeSlots = getCanonicalInventorySnapshot(mineflayer, 'inventory-free-space').freeSlotCount
  logger.log(`You have ${freeSlots} free slots in your inventory.`)
  return freeSlots
}

/**
 * Transfer all items from the bot's inventory to a chest.
 * @param mineflayer The mineflayer instance.
 * @returns Whether the items were successfully transferred.
 */
export async function transferAllToChest(mineflayer: Mineflayer): Promise<boolean> {
  const chest = getNearestBlock(mineflayer, 'chest', 32)
  if (!chest) {
    logger.log(`Could not find a chest nearby.`)
    return false
  }
  await goToPosition(mineflayer, chest.position.x, chest.position.y, chest.position.z)
  const chestContainer = await mineflayer.bot.openContainer(chest)

  for (const item of mineflayer.bot.inventory.items()) {
    await chestContainer.deposit(item.type, null, item.count)
    logger.log(`Put ${item.count} ${item.name} in the chest.`)
  }

  await chestContainer.close()
  return true
}

/**
 * Utility function to get item count in inventory
 * @param mineflayer The mineflayer instance.
 * @param itemName - The name of the item to count.
 * @returns number of items in inventory
 */
export function getItemCount(mineflayer: Mineflayer, itemName: string): number {
  const actualCount = getActualItemCount(mineflayer, itemName)
  const optimisticCount = getOptimisticItemCount(itemName)
  return Math.max(actualCount, optimisticCount)
}

export function getActualItemCount(mineflayer: Mineflayer, itemName: string): number {
  const bot = getInventoryBot(mineflayer)
  const inventory = mineflayer.bot.inventory as BridgeCanonicalBot['inventory']
  const strictRawItems = typeof bot.getStrictRawInventoryItems === 'function'
    ? bot.getStrictRawInventoryItems()
    : undefined
  const rawItems = !strictRawItems && typeof bot.getRawInventoryItems === 'function'
    ? bot.getRawInventoryItems()
    : undefined
  const localInventoryItems = inventory.items()
  const visibleActualCount = Array.isArray(strictRawItems)
    ? Math.max(
        countMatchingItems(strictRawItems, itemName),
        countMatchingItems(localInventoryItems, itemName),
      )
    : Array.isArray(rawItems)
      ? countMatchingItems(rawItems, itemName)
      : countMatchingItems(localInventoryItems, itemName)
  const snapshot = getCanonicalInventorySnapshot(mineflayer, 'inventory-count')
  const heldItemCount = snapshot.heldItem?.itemName?.includes(normalizeItemName(itemName))
    ? snapshot.heldItem.count
    : mineflayer.bot.heldItem?.name?.includes(itemName)
      ? mineflayer.bot.heldItem.count ?? 1
      : 0
  const offhandItemCount = snapshot.offhand?.itemName?.includes(normalizeItemName(itemName))
    ? snapshot.offhand.count
    : inventory.slots?.[45]?.name?.includes(itemName)
      ? inventory.slots[45]?.count ?? 1
      : 0

  // NOTICE: FabricBridge can surface a freshly crafted tool in the equipped slot before
  // the main inventory snapshot catches up. Treat equipped matches as visible actual state
  // for confirmation reads, but avoid summing them on top of inventory.items() to prevent
  // double-counting the same stack when mineflayer already exposes the hotbar entry there.
  return Math.max(visibleActualCount, heldItemCount, offhandItemCount)
}

export function getStrictVisibleItemCount(mineflayer: Mineflayer, itemName: string): number {
  const inventory = mineflayer.bot.inventory as BridgeCanonicalBot['inventory']
  const visibleItems = getStrictVisibleInventoryItems(mineflayer)
  const visibleActualCount = visibleItems
    ? countMatchingItems(visibleItems, itemName)
    : countMatchingItems(mineflayer.bot.inventory.items(), itemName)
  const snapshot = getCanonicalInventorySnapshot(mineflayer, 'inventory-strict-count')
  const heldItemCount = snapshot.heldItem?.itemName?.includes(normalizeItemName(itemName))
    ? snapshot.heldItem.count
    : mineflayer.bot.heldItem?.name?.includes(itemName)
      ? mineflayer.bot.heldItem.count ?? 1
      : 0
  const offhandItemCount = snapshot.offhand?.itemName?.includes(normalizeItemName(itemName))
    ? snapshot.offhand.count
    : inventory.slots?.[45]?.name?.includes(itemName)
      ? inventory.slots[45]?.count ?? 1
      : 0

  return Math.max(visibleActualCount, heldItemCount, offhandItemCount)
}

async function selectTaskItem(
  mineflayer: Mineflayer,
  snapshot: CanonicalInventorySnapshot,
  task: InventoryTaskContext,
  actions: string[],
): Promise<CanonicalInventorySnapshot> {
  const bot = getInventoryBot(mineflayer)
  const capabilityFlags = getInventoryCapabilityFlags(mineflayer)
  const itemSlot = findTaskItemSlot(snapshot, task)
  if (!itemSlot) {
    return snapshot
  }

  if (task.actionKind === 'equip') {
    const exactItem = mineflayer.bot.inventory.items().find(item =>
      normalizeCanonicalInventoryItemName(item.name).includes(normalizeCanonicalInventoryItemName(task.targetItemName)))
    if (exactItem) {
      await mineflayer.bot.equip(exactItem as Item, getEquipDestination(normalizeCanonicalInventoryItemName(exactItem.name)))
      actions.push(`equip:${normalizeCanonicalInventoryItemName(exactItem.name)}`)
      return refreshCanonicalInventorySnapshot(mineflayer, 'inventory-preflight:equip')
    }
    return snapshot
  }

  const desiredHotbarIndex = task.desiredHotbarIndex ?? snapshot.selectedSlot
  if (capabilityFlags.canSwapSlots && itemSlot.slotIndex !== desiredHotbarIndex && itemSlot.container !== 'hotbar') {
    const moved = await tryMoveSlotItem(mineflayer, itemSlot.slotIndex, desiredHotbarIndex, actions, 'preflight')
    if (moved) {
      actions.push(`move:${itemSlot.itemName}:${itemSlot.slotIndex}->${desiredHotbarIndex}`)
      snapshot = await refreshCanonicalInventorySnapshot(mineflayer, 'inventory-preflight:move')
    }
    else if (task.actionKind !== 'craft' && task.actionKind !== 'smelt') {
      const fallbackItemName = normalizeCanonicalInventoryItemName(itemSlot.itemName ?? task.targetItemName)
      const exactItem = mineflayer.bot.inventory.items().find(item =>
        normalizeCanonicalInventoryItemName(item.name) === fallbackItemName)
      if (exactItem) {
        await mineflayer.bot.equip(exactItem as Item, getEquipDestination(normalizeCanonicalInventoryItemName(exactItem.name)))
        actions.push(`equip-hand:${normalizeCanonicalInventoryItemName(exactItem.name)}`)
        snapshot = await refreshCanonicalInventorySnapshot(mineflayer, 'inventory-preflight:equip-hand')
      }
    }
  }

  const refreshedItemSlot = findTaskItemSlot(snapshot, task)
  const hotbarIndex = refreshedItemSlot?.container === 'hotbar'
    ? refreshedItemSlot.containerSlotIndex
    : desiredHotbarIndex
  if (typeof bot.selectHotbarSlot === 'function' && hotbarIndex !== snapshot.selectedSlot) {
    const selected = await trySelectHotbarSlot(mineflayer, hotbarIndex, actions)
    if (selected) {
      actions.push(`select:${hotbarIndex}`)
      snapshot = await refreshCanonicalInventorySnapshot(mineflayer, 'inventory-preflight:select')
    }
    else if (task.actionKind !== 'craft' && task.actionKind !== 'smelt' && !isLiveHeldItemUsableForTask(mineflayer, snapshot, task)) {
      const fallbackItemName = normalizeCanonicalInventoryItemName(refreshedItemSlot?.itemName ?? itemSlot.itemName ?? task.targetItemName)
      const exactItem = mineflayer.bot.inventory.items().find(item =>
        normalizeCanonicalInventoryItemName(item.name) === fallbackItemName)
      if (exactItem) {
        await mineflayer.bot.equip(exactItem as Item, getEquipDestination(normalizeCanonicalInventoryItemName(exactItem.name)))
        actions.push(`equip-hand:${normalizeCanonicalInventoryItemName(exactItem.name)}`)
        snapshot = await refreshCanonicalInventorySnapshot(mineflayer, 'inventory-preflight:equip-hand-fallback')
      }
    }
  }

  if (
    task.actionKind !== 'craft'
    && task.actionKind !== 'smelt'
    && !isHeldItemUsableForTask(snapshot, task)
    && !isLiveHeldItemUsableForTask(mineflayer, snapshot, task)
  ) {
    const fallbackItemName = normalizeCanonicalInventoryItemName(
      findTaskItemSlot(snapshot, task)?.itemName ?? itemSlot.itemName ?? task.targetItemName,
    )
    const exactItem = mineflayer.bot.inventory.items().find(item =>
      normalizeCanonicalInventoryItemName(item.name) === fallbackItemName)
    if (exactItem && getEquipDestination(normalizeCanonicalInventoryItemName(exactItem.name)) === 'hand') {
      await mineflayer.bot.equip(exactItem as Item, 'hand')
      actions.push(`equip-hand:${normalizeCanonicalInventoryItemName(exactItem.name)}`)
      snapshot = await refreshCanonicalInventorySnapshot(mineflayer, 'inventory-preflight:equip-hand-guard')
    }
  }

  return snapshot
}

function countSnapshotItemsForRequirement(snapshot: CanonicalInventorySnapshot, itemName: string): number {
  const normalized = normalizeCanonicalInventoryItemName(itemName)
  if (!normalized) {
    return 0
  }
  if (normalized === 'log') {
    return Object.entries(snapshot.groupedStacks)
      .filter(([groupName]) =>
        groupName.endsWith('_log')
        || groupName.endsWith('_wood')
        || groupName.endsWith('_stem')
        || groupName.endsWith('_hyphae'))
      .reduce((total, [, group]) => total + group.totalCount, 0)
  }
  if (normalized === 'planks') {
    return Object.entries(snapshot.groupedStacks)
      .filter(([groupName]) => groupName.endsWith('_planks'))
      .reduce((total, [, group]) => total + group.totalCount, 0)
  }
  return snapshot.groupedStacks[normalized]?.totalCount ?? 0
}

function isCraftRecipeVisibleInSnapshot(snapshot: CanonicalInventorySnapshot, recipeName: string): boolean {
  const normalized = normalizeCanonicalInventoryItemName(recipeName)
  if (!normalized) {
    return false
  }
  if (snapshot.craftableFacts.craftableNow.includes(normalized)) {
    return true
  }
  if (normalized.endsWith('_planks') && snapshot.craftableFacts.craftableNow.includes('planks')) {
    return true
  }
  return false
}

async function canProceedWithCraftTask(
  mineflayer: Mineflayer,
  snapshot: CanonicalInventorySnapshot,
  step: InventoryStepLike,
  task: InventoryTaskContext,
): Promise<{ ok: boolean, failureClass?: string }> {
  const recipeName = normalizeCanonicalInventoryItemName(task.targetItemName)
  if (!recipeName) {
    return { ok: false, failureClass: 'ingredient_missing' }
  }

  const recipeCount = Math.max(1, Number(step.params.num ?? 1))
  if (resolveEnsureManagedCraftRecipe(recipeName, recipeCount)) {
    return { ok: true }
  }

  if (isCraftRecipeVisibleInSnapshot(snapshot, recipeName)) {
    return { ok: true }
  }

  const requirements = await getSelectedCraftRecipeRequirements(mineflayer, recipeName, recipeCount)
  if (!requirements || requirements.length === 0) {
    return { ok: false, failureClass: 'ingredient_missing' }
  }

  const hasAllRequirements = requirements.every(requirement =>
    countSnapshotItemsForRequirement(snapshot, requirement.itemName) >= requirement.count)

  return {
    ok: hasAllRequirements,
    failureClass: hasAllRequirements ? undefined : 'ingredient_missing',
  }
}

function canProceedWithSmeltTask(
  snapshot: CanonicalInventorySnapshot,
  task: InventoryTaskContext,
): { ok: boolean, failureClass?: string } {
  const targetItemName = normalizeCanonicalInventoryItemName(task.targetItemName)
  if (!targetItemName) {
    return { ok: false, failureClass: 'ingredient_missing' }
  }

  const smeltableNow = targetItemName === 'log'
    ? snapshot.craftableFacts.smeltableNow.some(item =>
        /(?:_log|_wood|_stem|_hyphae)\(/.test(item))
    : snapshot.craftableFacts.smeltableNow.some(item => item.startsWith(`${targetItemName}(`))
  const hasFuelCapacity = snapshot.craftableFacts.estimatedFuelCapacity > 0
  return {
    ok: smeltableNow && hasFuelCapacity,
    failureClass: smeltableNow ? 'ingredient_missing' : 'ingredient_missing',
  }
}

export async function organizeInventory(
  mineflayer: Mineflayer,
  task?: InventoryTaskContext,
): Promise<InventoryRecoveryResult> {
  let snapshot = await refreshCanonicalInventorySnapshot(mineflayer, 'inventory-organize:start')
  const effectiveTask = task ?? {
    actionKind: 'generic' as InventoryActionKind,
    reserveQuickLootSlot: true,
    requiredFreeSlots: 1,
  }
  const actions: string[] = []
  const bot = getInventoryBot(mineflayer)
  const capabilityFlags = getInventoryCapabilityFlags(mineflayer)

  if (!snapshot.slots.some(slot => slot.itemName)) {
    logger.log('Inventory is empty, nothing to organize.')
    return {
      recovered: false,
      failureClass: 'inventory_empty',
      actions,
      snapshot,
    }
  }

  if (
    snapshot.compactness.fragmentedStacks > 0
    && capabilityFlags.canCompactInventory
  ) {
    try {
      if (typeof bot.compactInventory !== 'function') {
        throw new TypeError('compactInventory capability disappeared during inventory organization')
      }
      await bot.compactInventory(Math.min(12, Math.max(4, snapshot.compactness.fragmentedStacks * 2)))
      actions.push('compactInventory')
      snapshot = await refreshCanonicalInventorySnapshot(mineflayer, 'inventory-organize:compact')
    }
    catch (error) {
      if (!isUnsupportedBridgeCommand(error, 'compactInventory')) {
        throw error
      }
      actions.push('compactInventory:skipped:unsupported_capability')
      logger.withFields({
        command: 'compactInventory',
        failure_class: 'unsupported_capability',
      }).warn('Inventory organizer skipped unsupported bridge compaction command')
    }
  }

  const skipHotbarReorder = canUseBareHandMiningWithoutHotbarReorder(snapshot, effectiveTask)
  for (let moveIndex = 0; moveIndex < 16; moveIndex++) {
    if (!capabilityFlags.canSwapSlots || skipHotbarReorder) {
      break
    }
    const policy = buildHotbarPolicy(snapshot, effectiveTask)
    const nextAssignment = policy.assignments.find(assignment =>
      assignment.role !== 'quick_loot'
      && assignment.itemName
      && assignment.rawSlotIndex !== null
      && assignment.rawSlotIndex !== assignment.hotbarIndex,
    )
    if (!nextAssignment) {
      break
    }

    const moved = await tryMoveSlotItem(mineflayer, nextAssignment.rawSlotIndex!, nextAssignment.hotbarIndex, actions, 'organize')
    if (!moved) {
      break
    }
    actions.push(`hotbar:${nextAssignment.itemName}:${nextAssignment.rawSlotIndex}->${nextAssignment.hotbarIndex}`)
    snapshot = await refreshCanonicalInventorySnapshot(mineflayer, 'inventory-organize:hotbar')
  }

  const quickLootSlot = snapshot.slots.find(slot => slot.slotIndex === 8) ?? null
  const emptyMainSlot = snapshot.slots.find(slot => slot.container === 'main' && !slot.itemName) ?? null
  if ((effectiveTask.reserveQuickLootSlot ?? true) && quickLootSlot?.itemName && emptyMainSlot && capabilityFlags.canSwapSlots && !skipHotbarReorder) {
    const moved = await tryMoveSlotItem(mineflayer, 8, emptyMainSlot.slotIndex, actions, 'organize')
    if (moved) {
      actions.push(`quick_loot_clear:${quickLootSlot.itemName}:8->${emptyMainSlot.slotIndex}`)
      snapshot = await refreshCanonicalInventorySnapshot(mineflayer, 'inventory-organize:quick-loot')
    }
  }

  snapshot = await ensurePreferredOffhandItem(mineflayer, snapshot, actions)

  const minimumFreeSlots = getInventoryOrganizerTargetFreeSlots(snapshot, effectiveTask)
  const discardPlan = getSafeDiscardPlan(snapshot, minimumFreeSlots)
  for (const discardCandidate of discardPlan) {
    const dropped = await discard(mineflayer, discardCandidate.itemName, discardCandidate.dropCount)
    if (dropped) {
      actions.push(`discard:${discardCandidate.itemName}x${discardCandidate.dropCount}:${discardCandidate.reason}`)
    }
  }

  if (discardPlan.length > 0) {
    snapshot = await refreshCanonicalInventorySnapshot(mineflayer, 'inventory-organize:discard')
  }

  snapshot = await ensurePreferredOffhandItem(mineflayer, snapshot, actions)

  logger.withFields({
    actions,
    inventoryFacts: formatCanonicalInventoryFacts(snapshot, effectiveTask),
  }).log('Inventory organizer applied deterministic policy')

  return {
    recovered: actions.length > 0,
    failureClass: actions.length > 0 ? 'inventory_organized' : 'inventory_stable',
    actions,
    snapshot,
  }
}

export async function preflightInventoryForAction(
  mineflayer: Mineflayer,
  step: InventoryStepLike,
): Promise<InventoryPreflightResult> {
  const task = deriveInventoryTaskContextFromStep(step)
  const actions: string[] = []
  let snapshot = await refreshCanonicalInventorySnapshot(mineflayer, `inventory-preflight:${step.tool}:refresh`)

  if (snapshot.invariants.desyncSuspected) {
    snapshot = await refreshCanonicalInventorySnapshot(mineflayer, `inventory-preflight:${step.tool}:resync`)
    actions.push('refreshInventory')
  }

  if (snapshot.invariants.desyncSuspected) {
    const recovery = await organizeInventory(mineflayer, task)
    actions.push(...recovery.actions)
    snapshot = recovery.snapshot
  }

  if (shouldRunInventoryOrganizer(mineflayer, snapshot, task)) {
    const recovery = await organizeInventory(mineflayer, task)
    actions.push(...recovery.actions)
    snapshot = recovery.snapshot
  }

  snapshot = await selectTaskItem(mineflayer, snapshot, task, actions)
  snapshot = await ensurePreferredOffhandItem(mineflayer, snapshot, actions)
  const readiness = describeInventoryTaskReadiness(snapshot, task)
  const craftReadiness = task.actionKind === 'craft'
    ? await canProceedWithCraftTask(mineflayer, snapshot, step, task)
    : null
  const smeltReadiness = task.actionKind === 'smelt'
    ? canProceedWithSmeltTask(snapshot, task)
    : null
  const failureClass = snapshot.invariants.desyncSuspected
    ? 'inventory_desync'
    : snapshot.freeSlotCount < Math.max(0, task.requiredFreeSlots ?? 0)
      ? 'full_inventory'
      : task.actionKind === 'craft'
        ? craftReadiness?.failureClass
        : task.actionKind === 'smelt'
          ? smeltReadiness?.failureClass
          : readiness.failureClass

  const ok = task.actionKind === 'generic'
    ? !snapshot.invariants.desyncSuspected
    : task.actionKind === 'equip'
      ? isItemEquippedForTask(snapshot, task)
      : task.actionKind === 'craft'
        ? !snapshot.invariants.desyncSuspected
        && snapshot.freeSlotCount >= Math.max(0, task.requiredFreeSlots ?? 0)
        && Boolean(craftReadiness?.ok)
        : task.actionKind === 'smelt'
          ? !snapshot.invariants.desyncSuspected
          && snapshot.freeSlotCount >= Math.max(0, task.requiredFreeSlots ?? 0)
          && Boolean(smeltReadiness?.ok)
          : task.actionKind === 'place'
            ? !snapshot.invariants.desyncSuspected
            && (readiness.status === 'ready' || hasSnapshotItemForTask(snapshot, task))
            : readiness.status === 'ready'
              || (task.actionKind === 'mine' && task.allowsEmptyHand)
              || isHeldItemUsableForTask(snapshot, task)
              || isLiveHeldItemUsableForTask(mineflayer, snapshot, task)

  return {
    ok,
    failureClass: ok ? undefined : failureClass ?? 'equip_not_observed',
    task,
    snapshot,
    actions,
    facts: formatCanonicalInventoryFacts(snapshot, task),
  }
}

export async function verifyInventoryPostflight(
  mineflayer: Mineflayer,
  step: InventoryStepLike,
): Promise<InventoryPreflightResult> {
  const task = deriveInventoryTaskContextFromStep(step)
  const snapshot = await refreshCanonicalInventorySnapshot(mineflayer, `inventory-postflight:${step.tool}`)
  const readiness = describeInventoryTaskReadiness(snapshot, task)
  const ok = task.actionKind === 'generic'
    ? !snapshot.invariants.desyncSuspected
    : task.actionKind === 'equip'
      ? isItemEquippedForTask(snapshot, task)
      : task.actionKind === 'craft' || task.actionKind === 'smelt'
        ? !snapshot.invariants.desyncSuspected
        : task.actionKind === 'place'
          ? !snapshot.invariants.desyncSuspected
          : task.actionKind === 'mine'
            ? !snapshot.invariants.desyncSuspected
            && (
              readiness.status !== 'missing'
              || task.allowsEmptyHand
              || isHeldItemUsableForTask(snapshot, task)
              || isLiveHeldItemUsableForTask(mineflayer, snapshot, task)
            )
            : readiness.status === 'ready'
              || isHeldItemUsableForTask(snapshot, task)
              || isLiveHeldItemUsableForTask(mineflayer, snapshot, task)

  return {
    ok,
    failureClass: ok
      ? undefined
      : snapshot.invariants.desyncSuspected
        ? 'inventory_desync'
        : readiness.failureClass ?? 'held_item_mismatch',
    task,
    snapshot,
    actions: [],
    facts: formatCanonicalInventoryFacts(snapshot, task),
  }
}

export async function recoverInventoryFailure(
  mineflayer: Mineflayer,
  step: InventoryStepLike,
  failureClass: string,
): Promise<InventoryRecoveryResult> {
  const task = deriveInventoryTaskContextFromStep(step)
  const actions: string[] = []
  let snapshot = getCanonicalInventorySnapshot(mineflayer, `inventory-recovery:${failureClass}:initial`)

  switch (failureClass) {
    case 'inventory_desync':
    case 'selected_slot_mismatch':
    case 'held_item_mismatch':
    case 'equip_not_observed':
    case 'full_inventory': {
      const recovery = await organizeInventory(mineflayer, task)
      actions.push(...recovery.actions)
      snapshot = recovery.snapshot
      break
    }
    case 'broken_tool': {
      const recovery = await organizeInventory(mineflayer, {
        ...task,
        reserveQuickLootSlot: true,
      })
      actions.push(...recovery.actions)
      snapshot = recovery.snapshot
      break
    }
    default:
      snapshot = await refreshCanonicalInventorySnapshot(mineflayer, `inventory-recovery:${failureClass}:refresh`)
      actions.push('refreshInventory')
      break
  }

  return {
    recovered: actions.length > 0,
    failureClass,
    actions,
    snapshot,
  }
}

export async function stabilizeInventoryAfterAction(
  mineflayer: Mineflayer,
  step: InventoryStepLike,
): Promise<CanonicalInventorySnapshot> {
  const task = deriveInventoryTaskContextFromStep(step)
  let snapshot = getCanonicalInventorySnapshot(mineflayer, `inventory-stabilize:${step.tool}:initial`)
  if (
    step.tool === 'collectBlocks'
    || step.tool === 'craftRecipe'
    || step.tool === 'smeltItem'
    || shouldRunInventoryOrganizer(mineflayer, snapshot, task)
  ) {
    snapshot = (await organizeInventory(mineflayer, task)).snapshot
  }
  return snapshot
}

export function getActionInventoryTask(step: InventoryStepLike): InventoryTaskContext {
  return deriveInventoryTaskContextFromStep(step)
}
