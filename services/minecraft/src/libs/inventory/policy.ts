export type InventoryContainerKind = 'hotbar' | 'main' | 'armor' | 'offhand' | 'unknown'
export type InventoryItemCategory
  = | 'tool'
    | 'weapon'
    | 'food'
    | 'block'
    | 'utility'
    | 'crafting_material'
    | 'smelting_material'
    | 'fuel'
    | 'progression_critical'
    | 'low_value'

export type HotbarRole
  = | 'primary_mining_tool'
    | 'primary_weapon'
    | 'secondary_tool_or_task_utility'
    | 'food'
    | 'main_block'
    | 'light_source'
    | 'crafting_or_furnace_utility'
    | 'flexible_task_slot'
    | 'quick_loot'

export type InventoryActionKind
  = | 'mine'
    | 'attack'
    | 'place'
    | 'consume'
    | 'craft'
    | 'smelt'
    | 'equip'
    | 'use'
    | 'generic'

export interface InventoryLikeItem {
  slot: number
  name: string
  count: number
  maxCount?: number
  durability?: number
  maxDurability?: number
  nbt?: string
}

export interface InventoryHeldLike {
  name?: string
  count?: number
  durability?: number
  maxDurability?: number
}

export interface InventoryTaskContext {
  actionKind: InventoryActionKind
  targetItemName?: string
  targetBlockName?: string
  preferredToolCategory?: 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword'
  allowsEmptyHand?: boolean
  desiredHand?: 'hand' | 'offhand'
  desiredHotbarIndex?: number
  reserveQuickLootSlot?: boolean
  requiredFreeSlots?: number
}

export interface CanonicalInventoryInput {
  strictItems?: InventoryLikeItem[]
  guardedItems?: InventoryLikeItem[]
  trackedItems?: InventoryLikeItem[]
  selectedSlot?: number
  armor?: InventoryLikeItem[]
  offhand?: InventoryLikeItem | null
  heldItem?: InventoryHeldLike | null
  sourceTimestamp?: number
  sourceKind: string
}

export interface CanonicalInventorySlot {
  slotIndex: number
  mineflayerSlot: number
  container: InventoryContainerKind
  containerSlotIndex: number
  slotLabel: string
  itemId: string | null
  itemName: string | null
  count: number
  maxStack: number
  durability: number | null
  maxDurability: number | null
  stackable: boolean
  categories: InventoryItemCategory[]
}

export interface InventoryGroupedStack {
  itemName: string
  totalCount: number
  slotIndices: number[]
  partialSlotIndices: number[]
  maxStack: number
  stackable: boolean
  categories: InventoryItemCategory[]
}

export interface InventoryEssentialFacts {
  primaryTool: boolean
  weapon: boolean
  food: boolean
  buildingBlock: boolean
  lightSource: boolean
  craftingUtility: boolean
  furnaceUtility: boolean
  missing: string[]
}

export interface InventoryCompactnessFacts {
  fragmentedItemNames: string[]
  fragmentedBlockItemNames: string[]
  fragmentedStacks: number
  lowValueHotbarSlots: number[]
  duplicateHotbarItems: string[]
}

export interface InventoryCraftingFacts {
  craftableNow: string[]
  smeltableNow: string[]
  estimatedFuelCapacity: number
}

export interface InventoryInvariantFacts {
  selectedSlotMismatch: boolean
  heldItemMismatch: boolean
  guardedSelectedSlotMismatch: boolean
  trackedSelectedSlotMismatch: boolean
  desyncSuspected: boolean
  issues: string[]
}

export interface HotbarAssignment {
  hotbarIndex: number
  role: HotbarRole
  itemName: string | null
  rawSlotIndex: number | null
  location: string
  ready: boolean
}

export interface HotbarPolicy {
  assignments: HotbarAssignment[]
  violations: string[]
}

export interface TaskInventoryReadiness {
  taskLabel: string
  status: 'ready' | 'hotbar_needs_select' | 'inventory_needs_move' | 'missing' | 'not_applicable'
  itemName: string | null
  location: string
  desiredHotbarIndex: number | null
  failureClass?: string
}

export interface CanonicalInventorySnapshot {
  slots: CanonicalInventorySlot[]
  selectedSlot: number
  heldItem: CanonicalInventorySlot | null
  offhand: CanonicalInventorySlot | null
  armor: CanonicalInventorySlot[]
  freeSlotCount: number
  emptySlotIndices: number[]
  emptyHotbarSlotIndices: number[]
  groupedStacks: Record<string, InventoryGroupedStack>
  craftableFacts: InventoryCraftingFacts
  essentials: InventoryEssentialFacts
  compactness: InventoryCompactnessFacts
  invariants: InventoryInvariantFacts
  defaultHotbarPolicy: HotbarPolicy
  sourceTimestamp: number
  sourceKind: string
  sourcePriority: string
}

const HOTBAR_SLOT_COUNT = 9
const MAIN_INVENTORY_LAST_SLOT = 35
const ARMOR_RAW_SLOTS = [36, 37, 38, 39] as const
const OFFHAND_RAW_SLOT = 40
const TOOL_MATERIAL_RANK: Record<string, number> = {
  wooden: 1,
  golden: 1,
  stone: 2,
  iron: 3,
  diamond: 4,
  netherite: 5,
}
const FOOD_SCORES: Record<string, number> = {
  cooked_beef: 8,
  cooked_porkchop: 8,
  steak: 8,
  cooked_mutton: 6,
  cooked_chicken: 6,
  cooked_cod: 5,
  cooked_salmon: 6,
  bread: 5,
  baked_potato: 5,
  carrot: 3,
  potato: 1,
  apple: 4,
  sweet_berries: 2,
}
const LOW_VALUE_KEEP_LIMITS: Record<string, number> = {
  dirt: 32,
  coarse_dirt: 16,
  podzol: 16,
  gravel: 16,
  granite: 16,
  diorite: 16,
  andesite: 16,
  cobbled_deepslate: 64,
  rotten_flesh: 4,
  wheat_seeds: 8,
  sand: 16,
}
const BLOCK_PREFERENCE = [
  'cobblestone',
  'stone',
  'cobbled_deepslate',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'dirt',
] as const
const UTILITY_ITEM_NAMES = new Set([
  'crafting_table',
  'furnace',
  'water_bucket',
  'bucket',
  'lava_bucket',
  'shield',
  'chest',
  'white_bed',
  'bed',
])
const LIGHT_SOURCE_ITEM_NAMES = new Set([
  'torch',
  'lantern',
  'campfire',
])

function createSlotLabel(rawSlot: number): string {
  if (rawSlot >= 0 && rawSlot < HOTBAR_SLOT_COUNT) {
    return `hotbar_${rawSlot + 1}`
  }
  if (rawSlot >= HOTBAR_SLOT_COUNT && rawSlot <= MAIN_INVENTORY_LAST_SLOT) {
    return `main_${rawSlot - HOTBAR_SLOT_COUNT + 1}`
  }
  switch (rawSlot) {
    case 36:
      return 'armor_feet'
    case 37:
      return 'armor_legs'
    case 38:
      return 'armor_torso'
    case 39:
      return 'armor_head'
    case OFFHAND_RAW_SLOT:
      return 'offhand'
    default:
      return `slot_${rawSlot}`
  }
}

export function normalizeInventoryItemName(itemName: string | undefined | null): string {
  return String(itemName ?? '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
}

function getContainerKind(rawSlot: number): InventoryContainerKind {
  if (rawSlot >= 0 && rawSlot < HOTBAR_SLOT_COUNT) {
    return 'hotbar'
  }
  if (rawSlot >= HOTBAR_SLOT_COUNT && rawSlot <= MAIN_INVENTORY_LAST_SLOT) {
    return 'main'
  }
  if (ARMOR_RAW_SLOTS.includes(rawSlot as typeof ARMOR_RAW_SLOTS[number])) {
    return 'armor'
  }
  if (rawSlot === OFFHAND_RAW_SLOT) {
    return 'offhand'
  }
  return 'unknown'
}

function getContainerSlotIndex(rawSlot: number): number {
  const container = getContainerKind(rawSlot)
  switch (container) {
    case 'hotbar':
      return rawSlot
    case 'main':
      return rawSlot - HOTBAR_SLOT_COUNT
    case 'armor':
      return rawSlot - ARMOR_RAW_SLOTS[0]
    case 'offhand':
      return 0
    default:
      return rawSlot
  }
}

export function rawSlotToMineflayerSlot(rawSlot: number): number {
  if (rawSlot >= 0 && rawSlot < HOTBAR_SLOT_COUNT) {
    return 36 + rawSlot
  }
  if (rawSlot >= HOTBAR_SLOT_COUNT && rawSlot <= MAIN_INVENTORY_LAST_SLOT) {
    return rawSlot
  }
  switch (rawSlot) {
    case 36:
      return 8
    case 37:
      return 7
    case 38:
      return 6
    case 39:
      return 5
    case OFFHAND_RAW_SLOT:
      return 45
    default:
      return rawSlot
  }
}

export function mineflayerSlotToRawSlot(slot: number): number {
  if (slot >= 36 && slot <= 44) {
    return slot - 36
  }
  if (slot >= HOTBAR_SLOT_COUNT && slot <= MAIN_INVENTORY_LAST_SLOT) {
    return slot
  }
  switch (slot) {
    case 8:
      return 36
    case 7:
      return 37
    case 6:
      return 38
    case 5:
      return 39
    case 45:
      return OFFHAND_RAW_SLOT
    default:
      return slot
  }
}

function cloneInventoryItem(item: InventoryLikeItem): InventoryLikeItem {
  return {
    slot: item.slot,
    name: item.name,
    count: item.count,
    maxCount: item.maxCount ?? 64,
    durability: item.durability ?? 0,
    maxDurability: item.maxDurability ?? 0,
    ...(item.nbt ? { nbt: item.nbt } : {}),
  }
}

function dedupeItems(items: InventoryLikeItem[] | undefined): InventoryLikeItem[] {
  if (!Array.isArray(items)) {
    return []
  }

  const bySlot = new Map<number, InventoryLikeItem>()
  for (const item of items) {
    if (!item || typeof item.slot !== 'number' || !item.name) {
      continue
    }
    bySlot.set(item.slot, cloneInventoryItem(item))
  }
  return [...bySlot.values()]
}

function expandArmorItems(armor: InventoryLikeItem[] | undefined): InventoryLikeItem[] {
  if (!Array.isArray(armor)) {
    return []
  }

  return armor
    .filter(item => item && item.name)
    .map((item) => {
      const normalized = normalizeInventoryItemName(item.name)
      let slot = item.slot
      if (slot < 36 || slot > 39) {
        if (normalized.includes('boots')) {
          slot = 36
        }
        else if (normalized.includes('leggings')) {
          slot = 37
        }
        else if (normalized.includes('chestplate') || normalized.includes('elytra')) {
          slot = 38
        }
        else {
          slot = 39
        }
      }
      return cloneInventoryItem({ ...item, slot })
    })
}

function buildMergedItemMap(input: CanonicalInventoryInput): Map<number, InventoryLikeItem> {
  const merged = new Map<number, InventoryLikeItem>()
  const strictItems = dedupeItems(input.strictItems)
  const guardedItems = dedupeItems(input.guardedItems)
  const trackedItems = dedupeItems(input.trackedItems)
  const armorItems = expandArmorItems(input.armor)
  const offhandItems = input.offhand ? [cloneInventoryItem({ ...input.offhand, slot: OFFHAND_RAW_SLOT })] : []

  for (const item of strictItems) {
    merged.set(item.slot, item)
  }
  for (const item of guardedItems) {
    merged.set(item.slot, item)
  }
  for (const item of trackedItems) {
    if (!merged.has(item.slot)) {
      merged.set(item.slot, item)
    }
  }
  for (const item of armorItems) {
    if (!merged.has(item.slot)) {
      merged.set(item.slot, item)
    }
  }
  for (const item of offhandItems) {
    if (!merged.has(item.slot)) {
      merged.set(item.slot, item)
    }
  }

  return merged
}

function getToolCategory(itemName: string): 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword' | null {
  if (itemName.includes('pickaxe')) {
    return 'pickaxe'
  }
  if (itemName.includes('axe') && !itemName.includes('pickaxe')) {
    return 'axe'
  }
  if (itemName.includes('shovel')) {
    return 'shovel'
  }
  if (itemName.includes('hoe')) {
    return 'hoe'
  }
  if (itemName.includes('sword')) {
    return 'sword'
  }
  return null
}

function isAttackReadyItemName(itemName: string): boolean {
  const toolCategory = getToolCategory(itemName)
  return toolCategory === 'sword'
    || toolCategory === 'axe'
    || toolCategory === 'pickaxe'
    || toolCategory === 'shovel'
}

function getToolMaterialRank(itemName: string): number {
  for (const [material, rank] of Object.entries(TOOL_MATERIAL_RANK)) {
    if (itemName.startsWith(`${material}_`)) {
      return rank
    }
  }
  return 0
}

function isFoodItemName(itemName: string): boolean {
  return Object.hasOwn(FOOD_SCORES, itemName)
    || itemName.startsWith('cooked_')
    || itemName === 'bread'
    || itemName === 'apple'
    || itemName === 'carrot'
    || itemName === 'potato'
}

function isBlockItemName(itemName: string): boolean {
  if (itemName.endsWith('_ore') || itemName.startsWith('raw_')) {
    return false
  }
  if (UTILITY_ITEM_NAMES.has(itemName) || LIGHT_SOURCE_ITEM_NAMES.has(itemName)) {
    return false
  }
  if (itemName.includes('pickaxe') || itemName.includes('axe') || itemName.includes('shovel') || itemName.includes('hoe') || itemName.includes('sword')) {
    return false
  }
  return BLOCK_PREFERENCE.some(prefix => itemName === prefix || itemName.endsWith(prefix))
    || itemName.endsWith('_planks')
    || itemName.endsWith('_log')
    || itemName.endsWith('_wood')
    || itemName.endsWith('_stem')
    || itemName.endsWith('_hyphae')
    || itemName.endsWith('_leaves')
    || itemName.endsWith('_stone')
    || itemName.endsWith('_dirt')
    || itemName === 'dirt'
    || itemName === 'stone'
    || itemName === 'cobblestone'
}

function isFuelItemName(itemName: string): boolean {
  return itemName === 'coal'
    || itemName === 'charcoal'
    || itemName === 'stick'
    || itemName === 'lava_bucket'
    || itemName.endsWith('_planks')
    || itemName.endsWith('_log')
    || itemName.endsWith('_wood')
    || itemName.endsWith('_stem')
    || itemName.endsWith('_hyphae')
}

function isSmeltableItemName(itemName: string): boolean {
  return itemName.startsWith('raw_')
    || itemName.endsWith('_ore')
    || itemName === 'sand'
    || itemName.endsWith('_log')
    || itemName.endsWith('_wood')
    || itemName.endsWith('_stem')
    || itemName.endsWith('_hyphae')
}

function isCraftingMaterialItemName(itemName: string): boolean {
  return itemName === 'stick'
    || itemName.endsWith('_planks')
    || itemName.endsWith('_log')
    || itemName.endsWith('_wood')
    || itemName.endsWith('_stem')
    || itemName.endsWith('_hyphae')
    || itemName.endsWith('_ingot')
    || itemName.startsWith('raw_')
    || itemName === 'cobblestone'
    || itemName === 'string'
    || itemName === 'coal'
    || itemName === 'charcoal'
}

function isLowValueItemName(itemName: string): boolean {
  return Object.hasOwn(LOW_VALUE_KEEP_LIMITS, itemName)
}

function isProgressionCriticalItemName(itemName: string): boolean {
  return itemName.includes('pickaxe')
    || itemName.includes('sword')
    || itemName.includes('axe')
    || itemName === 'shield'
    || isFoodItemName(itemName)
    || LIGHT_SOURCE_ITEM_NAMES.has(itemName)
    || itemName === 'crafting_table'
    || itemName === 'furnace'
    || itemName === 'coal'
    || itemName === 'charcoal'
    || itemName === 'stick'
    || itemName.endsWith('_planks')
    || itemName.endsWith('_log')
    || itemName.endsWith('_wood')
    || itemName.endsWith('_ingot')
    || itemName.startsWith('raw_')
}

function categorizeItem(itemName: string): InventoryItemCategory[] {
  const categories = new Set<InventoryItemCategory>()
  if (!itemName) {
    return []
  }

  const toolCategory = getToolCategory(itemName)
  if (toolCategory && toolCategory !== 'sword') {
    categories.add('tool')
  }
  if (isPrimaryWeaponItemName(itemName) || isShieldItemName(itemName)) {
    categories.add('weapon')
  }
  if (isFoodItemName(itemName)) {
    categories.add('food')
  }
  if (isBlockItemName(itemName)) {
    categories.add('block')
  }
  if (UTILITY_ITEM_NAMES.has(itemName) || LIGHT_SOURCE_ITEM_NAMES.has(itemName)) {
    categories.add('utility')
  }
  if (isCraftingMaterialItemName(itemName)) {
    categories.add('crafting_material')
  }
  if (isSmeltableItemName(itemName)) {
    categories.add('smelting_material')
  }
  if (isFuelItemName(itemName)) {
    categories.add('fuel')
  }
  if (isProgressionCriticalItemName(itemName)) {
    categories.add('progression_critical')
  }
  if (isLowValueItemName(itemName)) {
    categories.add('low_value')
  }
  return [...categories]
}

function createEmptySlot(rawSlot: number): CanonicalInventorySlot {
  return {
    slotIndex: rawSlot,
    mineflayerSlot: rawSlotToMineflayerSlot(rawSlot),
    container: getContainerKind(rawSlot),
    containerSlotIndex: getContainerSlotIndex(rawSlot),
    slotLabel: createSlotLabel(rawSlot),
    itemId: null,
    itemName: null,
    count: 0,
    maxStack: 64,
    durability: null,
    maxDurability: null,
    stackable: true,
    categories: [],
  }
}

function createOccupiedSlot(item: InventoryLikeItem): CanonicalInventorySlot {
  const itemName = normalizeInventoryItemName(item.name)
  const maxStack = Math.max(1, Number(item.maxCount ?? 64))
  return {
    slotIndex: item.slot,
    mineflayerSlot: rawSlotToMineflayerSlot(item.slot),
    container: getContainerKind(item.slot),
    containerSlotIndex: getContainerSlotIndex(item.slot),
    slotLabel: createSlotLabel(item.slot),
    itemId: itemName,
    itemName,
    count: Math.max(0, Math.trunc(item.count)),
    maxStack,
    durability: typeof item.maxDurability === 'number' && item.maxDurability > 0
      ? Math.max(0, Math.trunc(item.durability ?? 0))
      : null,
    maxDurability: typeof item.maxDurability === 'number' && item.maxDurability > 0
      ? Math.max(0, Math.trunc(item.maxDurability))
      : null,
    stackable: maxStack > 1,
    categories: categorizeItem(itemName),
  }
}

function createObservedHeldSlot(
  heldItem: InventoryHeldLike | null | undefined,
  selectedSlot: number,
  mergedItems: Map<number, InventoryLikeItem>,
): CanonicalInventorySlot | null {
  const heldItemName = normalizeInventoryItemName(heldItem?.name)
  if (!heldItemName) {
    return null
  }

  const matchedInventoryItem = [...mergedItems.values()].find(item =>
    normalizeInventoryItemName(item.name) === heldItemName)

  return createOccupiedSlot({
    slot: selectedSlot,
    name: heldItemName,
    count: Math.max(0, Math.trunc(heldItem?.count ?? matchedInventoryItem?.count ?? 1)),
    maxCount: matchedInventoryItem?.maxCount ?? (Math.max(0, Math.trunc(heldItem?.count ?? 1)) > 1 ? 64 : 1),
    durability: heldItem?.durability ?? matchedInventoryItem?.durability,
    maxDurability: heldItem?.maxDurability ?? matchedInventoryItem?.maxDurability,
  })
}

function buildGroupedStacks(slots: CanonicalInventorySlot[]): Record<string, InventoryGroupedStack> {
  return slots
    .filter(slot => slot.itemName)
    .reduce((groups, slot) => {
      const itemName = slot.itemName!
      const existing = groups[itemName]
      const partialSlotIndices = slot.stackable && slot.count < slot.maxStack ? [slot.slotIndex] : []
      if (!existing) {
        groups[itemName] = {
          itemName,
          totalCount: slot.count,
          slotIndices: [slot.slotIndex],
          partialSlotIndices,
          maxStack: slot.maxStack,
          stackable: slot.stackable,
          categories: [...slot.categories],
        }
        return groups
      }

      existing.totalCount += slot.count
      existing.slotIndices.push(slot.slotIndex)
      existing.partialSlotIndices.push(...partialSlotIndices)
      for (const category of slot.categories) {
        if (!existing.categories.includes(category)) {
          existing.categories.push(category)
        }
      }
      return groups
    }, {} as Record<string, InventoryGroupedStack>)
}

function countItem(groups: Record<string, InventoryGroupedStack>, itemName: string): number {
  return groups[normalizeInventoryItemName(itemName)]?.totalCount ?? 0
}

function estimateFuelCapacity(groups: Record<string, InventoryGroupedStack>): number {
  let capacity = 0
  for (const [itemName, group] of Object.entries(groups)) {
    if (itemName === 'coal' || itemName === 'charcoal') {
      capacity += group.totalCount * 8
      continue
    }
    if (itemName === 'stick') {
      capacity += Math.floor(group.totalCount / 2)
      continue
    }
    if (itemName === 'lava_bucket') {
      capacity += group.totalCount * 100
      continue
    }
    if (itemName.endsWith('_planks') || itemName.endsWith('_log') || itemName.endsWith('_wood') || itemName.endsWith('_stem') || itemName.endsWith('_hyphae')) {
      capacity += group.totalCount
    }
  }
  return capacity
}

function buildCraftingFacts(groups: Record<string, InventoryGroupedStack>): InventoryCraftingFacts {
  const totalPlanks = Object.entries(groups)
    .filter(([name]) => name.endsWith('_planks'))
    .reduce((sum, [, group]) => sum + group.totalCount, 0)
  const totalLogs = Object.entries(groups)
    .filter(([name]) => name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_stem') || name.endsWith('_hyphae'))
    .reduce((sum, [, group]) => sum + group.totalCount, 0)
  const craftableNow: string[] = []
  if (totalLogs > 0) {
    craftableNow.push('planks')
  }
  if (totalPlanks >= 2) {
    craftableNow.push('stick')
  }
  if (totalPlanks >= 4) {
    craftableNow.push('crafting_table')
  }
  if (countItem(groups, 'cobblestone') >= 8) {
    craftableNow.push('furnace')
  }
  if ((countItem(groups, 'coal') + countItem(groups, 'charcoal')) > 0 && countItem(groups, 'stick') > 0) {
    craftableNow.push('torch')
  }

  const smeltableNow = Object.entries(groups)
    .filter(([name]) => isSmeltableItemName(name))
    .map(([name, group]) => `${name}(${group.totalCount})`)
    .slice(0, 6)

  return {
    craftableNow,
    smeltableNow,
    estimatedFuelCapacity: estimateFuelCapacity(groups),
  }
}

function findBestSlot(
  slots: CanonicalInventorySlot[],
  usedRawSlots: Set<number>,
  predicate: (slot: CanonicalInventorySlot) => boolean,
  score: (slot: CanonicalInventorySlot) => number,
): CanonicalInventorySlot | null {
  const candidates = slots
    .filter(slot => slot.itemName && !usedRawSlots.has(slot.slotIndex) && predicate(slot))
    .sort((left, right) => {
      const scoreDelta = score(right) - score(left)
      if (scoreDelta !== 0) {
        return scoreDelta
      }
      const hotbarDelta = Number(left.container === 'hotbar') - Number(right.container === 'hotbar')
      if (hotbarDelta !== 0) {
        return hotbarDelta
      }
      return left.slotIndex - right.slotIndex
    })
  return candidates[0] ?? null
}

function getFoodScore(itemName: string): number {
  return FOOD_SCORES[itemName] ?? (itemName.startsWith('cooked_') ? 5 : 0)
}

function getDurabilityScore(slot: CanonicalInventorySlot): number {
  if (!slot.maxDurability || !slot.durability) {
    return 0
  }
  return Math.round((slot.durability / slot.maxDurability) * 100)
}

function isShieldItemName(itemName: string): boolean {
  return itemName === 'shield'
}

function isPrimaryWeaponItemName(itemName: string): boolean {
  const toolCategory = getToolCategory(itemName)
  return toolCategory === 'sword'
    || toolCategory === 'axe'
    || itemName.includes('bow')
    || itemName.includes('crossbow')
    || itemName.includes('trident')
}

function getPrimaryBlockScore(slot: CanonicalInventorySlot): number {
  const itemName = slot.itemName ?? ''
  const blockPreferenceRank = BLOCK_PREFERENCE.findIndex(name => name === itemName)
  const preferred = blockPreferenceRank >= 0 ? BLOCK_PREFERENCE.length - blockPreferenceRank : 0
  return (preferred * 1000) + slot.count
}

function getWeaponScore(slot: CanonicalInventorySlot): number {
  const itemName = slot.itemName ?? ''
  if (isShieldItemName(itemName)) {
    return 25 + getDurabilityScore(slot)
  }
  const materialRank = getToolMaterialRank(itemName)
  const swordBonus = itemName.includes('sword') ? 20 : itemName.includes('axe') ? 10 : itemName.includes('bow') ? 8 : 0
  return (materialRank * 100) + swordBonus + getDurabilityScore(slot)
}

function getToolScore(slot: CanonicalInventorySlot, toolCategory: 'pickaxe' | 'axe' | 'shovel' | 'hoe'): number {
  const itemName = slot.itemName ?? ''
  if (getToolCategory(itemName) !== toolCategory) {
    return -1
  }
  return (getToolMaterialRank(itemName) * 100) + getDurabilityScore(slot)
}

function getUtilityScore(slot: CanonicalInventorySlot): number {
  const itemName = slot.itemName ?? ''
  if (itemName === 'crafting_table') {
    return 300 + slot.count
  }
  if (itemName === 'furnace') {
    return 250 + slot.count
  }
  if (itemName === 'water_bucket' || itemName === 'bucket') {
    return 200
  }
  if (itemName === 'shield') {
    return 180
  }
  if (itemName === 'torch') {
    return 150 + slot.count
  }
  return slot.count
}

export function selectBestToolSlot(snapshot: CanonicalInventorySnapshot, blockName?: string): CanonicalInventorySlot | null {
  const normalizedBlockName = normalizeInventoryItemName(blockName)
  const toolCategory: 'pickaxe' | 'axe' | 'shovel' | 'hoe'
    = normalizedBlockName.endsWith('_log') || normalizedBlockName.endsWith('_wood') || normalizedBlockName.endsWith('_stem') || normalizedBlockName.endsWith('_hyphae')
      ? 'axe'
      : normalizedBlockName.includes('dirt') || normalizedBlockName.includes('sand') || normalizedBlockName.includes('gravel')
        ? 'shovel'
        : 'pickaxe'
  const candidates = snapshot.slots.filter(slot => slot.itemName && ['hotbar', 'main'].includes(slot.container))
  return findBestSlot(
    candidates,
    new Set<number>(),
    slot => getToolCategory(slot.itemName ?? '') === toolCategory,
    slot => getToolScore(slot, toolCategory),
  )
}

function buildHotbarAssignment(
  hotbarIndex: number,
  role: HotbarRole,
  slot: CanonicalInventorySlot | null,
  actualHotbarSlots: Map<number, CanonicalInventorySlot>,
): HotbarAssignment {
  const actual = actualHotbarSlots.get(hotbarIndex) ?? null
  const expectedName = slot?.itemName ?? null
  const ready = expectedName === null
    ? actual?.itemName == null
    : actual?.itemName === expectedName
  return {
    hotbarIndex,
    role,
    itemName: expectedName,
    rawSlotIndex: slot?.slotIndex ?? null,
    location: slot ? `${slot.container}#${slot.containerSlotIndex + 1}` : 'empty',
    ready,
  }
}

export function buildHotbarPolicy(snapshot: CanonicalInventorySnapshot, task?: InventoryTaskContext): HotbarPolicy {
  const usableSlots = snapshot.slots.filter(slot => slot.itemName && (slot.container === 'hotbar' || slot.container === 'main'))
  const actualHotbarSlots = new Map<number, CanonicalInventorySlot>()
  for (const slot of snapshot.slots.filter(entry => entry.container === 'hotbar')) {
    actualHotbarSlots.set(slot.containerSlotIndex, slot.itemName ? slot : createEmptySlot(slot.slotIndex))
  }

  const usedRawSlots = new Set<number>()
  const assignments: HotbarAssignment[] = []
  const reserveQuickLootSlot = task?.reserveQuickLootSlot ?? true
  const desiredMiningCategory = task?.preferredToolCategory && task.preferredToolCategory !== 'sword'
    ? task.preferredToolCategory
    : (task?.targetBlockName && selectBestToolSlot(snapshot, task.targetBlockName)
        ? getToolCategory(selectBestToolSlot(snapshot, task.targetBlockName)?.itemName ?? '') ?? 'pickaxe'
        : 'pickaxe')

  const miningTool = findBestSlot(
    usableSlots,
    usedRawSlots,
    slot => getToolCategory(slot.itemName ?? '') === desiredMiningCategory,
    slot => getToolScore(slot, desiredMiningCategory as 'pickaxe' | 'axe' | 'shovel' | 'hoe'),
  )
  if (miningTool) {
    usedRawSlots.add(miningTool.slotIndex)
  }
  assignments.push(buildHotbarAssignment(0, 'primary_mining_tool', miningTool, actualHotbarSlots))

  const primaryWeapon = findBestSlot(
    usableSlots,
    usedRawSlots,
    slot => Boolean(slot.itemName && isPrimaryWeaponItemName(slot.itemName)),
    getWeaponScore,
  )
  const fallbackShield = primaryWeapon
    ? null
    : findBestSlot(
        usableSlots,
        usedRawSlots,
        slot => slot.itemName === 'shield',
        getWeaponScore,
      )
  const selectedWeapon = primaryWeapon ?? fallbackShield
  if (selectedWeapon) {
    usedRawSlots.add(selectedWeapon.slotIndex)
  }
  assignments.push(buildHotbarAssignment(1, 'primary_weapon', selectedWeapon, actualHotbarSlots))

  let taskUtility: CanonicalInventorySlot | null = null
  if (task?.targetItemName) {
    taskUtility = findBestSlot(
      usableSlots,
      usedRawSlots,
      slot => slot.itemName === normalizeInventoryItemName(task.targetItemName),
      slot => getUtilityScore(slot) + slot.count,
    )
  }
  const secondaryTool = taskUtility ?? findBestSlot(
    usableSlots,
    usedRawSlots,
    slot => ['axe', 'shovel', 'hoe'].includes(getToolCategory(slot.itemName ?? '') ?? '') || slot.categories.includes('utility'),
    (slot) => {
      const toolCategory = getToolCategory(slot.itemName ?? '')
      if (toolCategory === 'axe' || toolCategory === 'shovel' || toolCategory === 'hoe') {
        return getToolScore(slot, toolCategory)
      }
      return getUtilityScore(slot)
    },
  )
  if (secondaryTool) {
    usedRawSlots.add(secondaryTool.slotIndex)
  }
  assignments.push(buildHotbarAssignment(2, 'secondary_tool_or_task_utility', secondaryTool, actualHotbarSlots))

  const desiredFoodName = task?.actionKind === 'consume' && task.targetItemName
    ? normalizeInventoryItemName(task.targetItemName)
    : null
  const food = findBestSlot(
    usableSlots,
    usedRawSlots,
    slot => slot.categories.includes('food') && (!desiredFoodName || slot.itemName === desiredFoodName),
    slot => (getFoodScore(slot.itemName ?? '') * 100) + slot.count,
  )
  if (food) {
    usedRawSlots.add(food.slotIndex)
  }
  assignments.push(buildHotbarAssignment(3, 'food', food, actualHotbarSlots))

  const desiredPlaceItemName = task?.actionKind === 'place' && task.targetItemName
    ? normalizeInventoryItemName(task.targetItemName)
    : null
  const primaryBlock = findBestSlot(
    usableSlots,
    usedRawSlots,
    slot => slot.categories.includes('block') && (!desiredPlaceItemName || slot.itemName === desiredPlaceItemName),
    getPrimaryBlockScore,
  )
  if (primaryBlock) {
    usedRawSlots.add(primaryBlock.slotIndex)
  }
  assignments.push(buildHotbarAssignment(4, 'main_block', primaryBlock, actualHotbarSlots))

  const lightSource = findBestSlot(
    usableSlots,
    usedRawSlots,
    slot => LIGHT_SOURCE_ITEM_NAMES.has(slot.itemName ?? '') || slot.itemName === 'coal' || slot.itemName === 'charcoal',
    slot => (LIGHT_SOURCE_ITEM_NAMES.has(slot.itemName ?? '') ? 200 : 100) + slot.count,
  )
  if (lightSource) {
    usedRawSlots.add(lightSource.slotIndex)
  }
  assignments.push(buildHotbarAssignment(5, 'light_source', lightSource, actualHotbarSlots))

  const craftingUtility = findBestSlot(
    usableSlots,
    usedRawSlots,
    slot => slot.itemName === 'crafting_table' || slot.itemName === 'furnace' || slot.itemName === 'water_bucket' || slot.itemName === 'bucket',
    getUtilityScore,
  )
  if (craftingUtility) {
    usedRawSlots.add(craftingUtility.slotIndex)
  }
  assignments.push(buildHotbarAssignment(6, 'crafting_or_furnace_utility', craftingUtility, actualHotbarSlots))

  const flexible = taskUtility && secondaryTool?.slotIndex !== taskUtility.slotIndex
    ? taskUtility
    : findBestSlot(
        usableSlots,
        usedRawSlots,
        slot => slot.categories.includes('utility')
          || slot.categories.includes('food')
          || slot.categories.includes('block')
          || (slot.categories.includes('weapon') && slot.itemName !== 'shield'),
        slot => getUtilityScore(slot) + getWeaponScore(slot) + slot.count,
      )
  if (flexible) {
    usedRawSlots.add(flexible.slotIndex)
  }
  assignments.push(buildHotbarAssignment(7, 'flexible_task_slot', flexible, actualHotbarSlots))

  assignments.push(buildHotbarAssignment(8, 'quick_loot', reserveQuickLootSlot ? null : flexible, actualHotbarSlots))

  const violations: string[] = []
  for (const assignment of assignments) {
    if (!assignment.ready && assignment.role !== 'quick_loot') {
      violations.push(`hotbar_${assignment.hotbarIndex + 1}_${assignment.role}`)
    }
  }
  const quickLootSlot = actualHotbarSlots.get(8)
  if (reserveQuickLootSlot && quickLootSlot?.itemName) {
    violations.push('quick_loot_blocked')
  }
  if (snapshot.compactness.lowValueHotbarSlots.length > 0) {
    violations.push('hotbar_contains_low_value_items')
  }
  if (snapshot.compactness.duplicateHotbarItems.length > 0) {
    violations.push('hotbar_contains_duplicate_items')
  }

  return {
    assignments,
    violations,
  }
}

function buildEssentialFacts(snapshotSlots: CanonicalInventorySlot[], groups: Record<string, InventoryGroupedStack>): InventoryEssentialFacts {
  const primaryTool = snapshotSlots.some(slot => slot.itemName && getToolCategory(slot.itemName) === 'pickaxe')
  const weapon = snapshotSlots.some(slot => slot.itemName && isPrimaryWeaponItemName(slot.itemName))
  const food = snapshotSlots.some(slot => slot.itemName && slot.categories.includes('food'))
  const buildingBlock = snapshotSlots.some(slot => slot.itemName && slot.categories.includes('block'))
  const lightSource = snapshotSlots.some(slot => slot.itemName && LIGHT_SOURCE_ITEM_NAMES.has(slot.itemName))
  const craftingUtility = countItem(groups, 'crafting_table') > 0 || buildCraftingFacts(groups).craftableNow.includes('crafting_table')
  const furnaceUtility = countItem(groups, 'furnace') > 0 || buildCraftingFacts(groups).craftableNow.includes('furnace')
  const missing: string[] = []
  if (!primaryTool) {
    missing.push('pickaxe')
  }
  if (!weapon) {
    missing.push('weapon')
  }
  if (!food) {
    missing.push('food')
  }
  if (!buildingBlock) {
    missing.push('building_block')
  }
  if (!lightSource) {
    missing.push('light_source')
  }
  return {
    primaryTool,
    weapon,
    food,
    buildingBlock,
    lightSource,
    craftingUtility,
    furnaceUtility,
    missing,
  }
}

function buildCompactnessFacts(snapshotSlots: CanonicalInventorySlot[], groups: Record<string, InventoryGroupedStack>): InventoryCompactnessFacts {
  const fragmentedItemNames = Object.values(groups)
    .filter(group => group.stackable && group.partialSlotIndices.length > 1)
    .map(group => group.itemName)
  const fragmentedBlockItemNames = Object.values(groups)
    .filter(group => group.stackable && group.partialSlotIndices.length > 1 && group.categories.includes('block'))
    .map(group => group.itemName)
  const lowValueHotbarSlots = snapshotSlots
    .filter(slot => slot.container === 'hotbar' && slot.itemName && slot.categories.includes('low_value'))
    .map(slot => slot.slotIndex)
  const duplicateHotbarItems = snapshotSlots
    .filter(slot => slot.container === 'hotbar' && slot.itemName)
    .reduce((duplicates, slot) => {
      const itemName = slot.itemName!
      duplicates[itemName] = (duplicates[itemName] ?? 0) + 1
      return duplicates
    }, {} as Record<string, number>)

  return {
    fragmentedItemNames,
    fragmentedBlockItemNames,
    fragmentedStacks: fragmentedItemNames.length,
    lowValueHotbarSlots,
    duplicateHotbarItems: Object.entries(duplicateHotbarItems)
      .filter(([, count]) => count > 1)
      .map(([itemName]) => itemName),
  }
}

function buildInvariantFacts(
  input: CanonicalInventoryInput,
  mergedItems: Map<number, InventoryLikeItem>,
  heldItem: CanonicalInventorySlot | null,
): InventoryInvariantFacts {
  const issues: string[] = []
  const selectedSlot = Number.isFinite(input.selectedSlot) ? Math.max(0, Math.min(8, Math.trunc(input.selectedSlot ?? 0))) : 0
  const strictSelectedItemName = normalizeInventoryItemName(dedupeItems(input.strictItems).find(item => item.slot === selectedSlot)?.name)
  const guardedSelectedItemName = normalizeInventoryItemName(dedupeItems(input.guardedItems).find(item => item.slot === selectedSlot)?.name)
  const trackedSelectedItemName = normalizeInventoryItemName(dedupeItems(input.trackedItems).find(item => item.slot === selectedSlot)?.name)
  const heldItemName = normalizeInventoryItemName(input.heldItem?.name ?? heldItem?.itemName)
  const mergedSelectedItemName = normalizeInventoryItemName(mergedItems.get(selectedSlot)?.name)
  const selectedSlotMismatch = (input.selectedSlot ?? 0) < 0 || (input.selectedSlot ?? 0) > 8
  const heldItemMismatch = Boolean(heldItemName && heldItemName !== mergedSelectedItemName)
  const guardedSelectedSlotMismatch = Boolean(strictSelectedItemName && guardedSelectedItemName && strictSelectedItemName !== guardedSelectedItemName)
  const trackedSelectedSlotMismatch = Boolean(strictSelectedItemName && trackedSelectedItemName && strictSelectedItemName !== trackedSelectedItemName)

  if (selectedSlotMismatch) {
    issues.push('selected_slot_out_of_range')
  }
  if (heldItemMismatch) {
    issues.push('held_item_mismatch')
  }
  if (guardedSelectedSlotMismatch) {
    issues.push('guarded_selected_slot_mismatch')
  }
  if (trackedSelectedSlotMismatch) {
    issues.push('tracked_selected_slot_mismatch')
  }
  if (!strictSelectedItemName && heldItemName && heldItemName !== mergedSelectedItemName) {
    issues.push('selected_slot_missing_from_strict')
  }

  return {
    selectedSlotMismatch,
    heldItemMismatch,
    guardedSelectedSlotMismatch,
    trackedSelectedSlotMismatch,
    desyncSuspected: issues.length > 0,
    issues,
  }
}

export function buildCanonicalInventorySnapshot(input: CanonicalInventoryInput): CanonicalInventorySnapshot {
  const mergedItems = buildMergedItemMap(input)
  const slots: CanonicalInventorySlot[] = []
  for (let rawSlot = 0; rawSlot <= OFFHAND_RAW_SLOT; rawSlot++) {
    const item = mergedItems.get(rawSlot)
    slots.push(item ? createOccupiedSlot(item) : createEmptySlot(rawSlot))
  }

  const selectedSlot = Number.isFinite(input.selectedSlot) ? Math.max(0, Math.min(8, Math.trunc(input.selectedSlot ?? 0))) : 0
  const heldItem = createObservedHeldSlot(input.heldItem, selectedSlot, mergedItems)
    ?? slots.find(slot => slot.slotIndex === selectedSlot && slot.itemName)
    ?? null
  const armor = slots.filter(slot => slot.container === 'armor' && slot.itemName)
  const offhand = slots.find(slot => slot.slotIndex === OFFHAND_RAW_SLOT && slot.itemName) ?? null
  const carrySlots = slots.filter(slot => slot.container === 'hotbar' || slot.container === 'main')
  const emptySlotIndices = carrySlots.filter(slot => !slot.itemName).map(slot => slot.slotIndex)
  const emptyHotbarSlotIndices = slots.filter(slot => slot.container === 'hotbar' && !slot.itemName).map(slot => slot.slotIndex)
  const groupedStacks = buildGroupedStacks(carrySlots.filter(slot => slot.itemName))
  const craftableFacts = buildCraftingFacts(groupedStacks)
  const essentials = buildEssentialFacts(carrySlots, groupedStacks)
  const compactness = buildCompactnessFacts(carrySlots, groupedStacks)
  const invariants = buildInvariantFacts(input, mergedItems, heldItem)

  const baseSnapshot: Omit<CanonicalInventorySnapshot, 'defaultHotbarPolicy'> = {
    slots,
    selectedSlot,
    heldItem,
    offhand,
    armor,
    freeSlotCount: emptySlotIndices.length,
    emptySlotIndices,
    emptyHotbarSlotIndices,
    groupedStacks,
    craftableFacts,
    essentials,
    compactness,
    invariants,
    sourceTimestamp: input.sourceTimestamp ?? Date.now(),
    sourceKind: input.sourceKind,
    sourcePriority: 'guarded_raw > strict_raw > tracked_cache',
  }
  const snapshot: CanonicalInventorySnapshot = {
    ...baseSnapshot,
    defaultHotbarPolicy: {
      assignments: [],
      violations: [],
    },
  }
  snapshot.defaultHotbarPolicy = buildHotbarPolicy(snapshot)
  return snapshot
}

export function deriveTaskContextFromGoal(goal: string): InventoryTaskContext {
  const normalized = goal.toLowerCase().replace(/^minecraft:/g, '').replace(/\s+/g, ' ').trim()
  if (/^(?:eat|consume)\b/.test(normalized) || /食べ|食料/.test(goal)) {
    return {
      actionKind: 'consume',
      targetItemName: normalized.includes('bread') ? 'bread' : undefined,
      desiredHotbarIndex: 3,
      requiredFreeSlots: 0,
    }
  }
  if (/\bplace\b/.test(normalized) || /置/.test(goal)) {
    const itemMatch = normalized.match(/\b(furnace|crafting_table|torch|cobblestone|dirt|oak_planks)\b/)
    return {
      actionKind: 'place',
      targetItemName: itemMatch?.[1],
      desiredHotbarIndex: 4,
      requiredFreeSlots: 0,
    }
  }
  if (/\bsmelt\b|\bcook\b/.test(normalized) || /精錬|焼/.test(goal)) {
    return {
      actionKind: 'smelt',
      desiredHotbarIndex: 6,
      requiredFreeSlots: 1,
    }
  }
  if (/\bcraft\b|\bmake\b|\bbuild\b|\bcreate\b/.test(normalized) || /クラフト|作/.test(goal)) {
    const recipeMatch = normalized.match(/\b(crafting_table|furnace|torch|pickaxe|axe|shovel|sword)\b/)
    return {
      actionKind: 'craft',
      targetItemName: recipeMatch?.[1],
      desiredHotbarIndex: 6,
      requiredFreeSlots: 1,
    }
  }
  if (/\battack\b|\bkill\b|\bfight\b/.test(normalized) || /戦闘|攻撃|倒/.test(goal)) {
    return {
      actionKind: 'attack',
      preferredToolCategory: 'sword',
      desiredHotbarIndex: 1,
      requiredFreeSlots: 0,
    }
  }
  const mineMatch = normalized.match(/\b(log|stone|cobblestone|coal_ore|iron_ore|diamond_ore|ore)\b/)
  if (/\bmine\b|\bcollect\b|\bgather\b|\bdig\b/.test(normalized) || /採掘|掘|集め/.test(goal) || mineMatch) {
    return {
      actionKind: 'mine',
      targetBlockName: mineMatch?.[1] ?? 'stone',
      preferredToolCategory: mineMatch?.[1] === 'log' ? 'axe' : 'pickaxe',
      desiredHotbarIndex: 0,
      reserveQuickLootSlot: true,
      requiredFreeSlots: 1,
    }
  }
  return {
    actionKind: 'generic',
    reserveQuickLootSlot: true,
    requiredFreeSlots: 0,
  }
}

export function describeInventoryTaskReadiness(snapshot: CanonicalInventorySnapshot, task: InventoryTaskContext): TaskInventoryReadiness {
  const desiredHotbarIndex = task.desiredHotbarIndex ?? null
  const taskLabel = task.actionKind
  const normalizedTargetItem = normalizeInventoryItemName(task.targetItemName)
  const matchingSlots = snapshot.slots.filter((slot) => {
    if (!slot.itemName) {
      return false
    }
    if (normalizedTargetItem) {
      return slot.itemName === normalizedTargetItem
    }
    switch (task.actionKind) {
      case 'consume':
        return slot.categories.includes('food')
      case 'attack':
        return slot.itemName !== 'shield' && (
          slot.categories.includes('weapon')
          || isAttackReadyItemName(slot.itemName)
        )
      case 'place':
        return slot.categories.includes('block')
      case 'mine':
        return task.preferredToolCategory
          ? getToolCategory(slot.itemName) === task.preferredToolCategory
          : slot.categories.includes('tool')
      case 'equip':
      case 'use':
        return normalizedTargetItem
          ? slot.itemName === normalizedTargetItem
          : slot.categories.includes('utility')
      case 'craft':
        return slot.itemName === 'crafting_table'
          || slot.itemName === 'stick'
          || slot.categories.includes('crafting_material')
      case 'smelt':
        return slot.itemName === 'furnace'
          || slot.categories.includes('smelting_material')
          || slot.categories.includes('fuel')
      default:
        return false
    }
  })
  const preferredSlot = task.actionKind === 'mine'
    ? selectBestToolSlot(snapshot, task.targetBlockName)
    : task.actionKind === 'attack'
      ? findBestSlot(
          matchingSlots,
          new Set<number>(),
          slot => Boolean(slot.itemName),
          getWeaponScore,
        )
      : matchingSlots[0] ?? null
  if (!preferredSlot) {
    if (task.actionKind === 'mine' && task.allowsEmptyHand) {
      return {
        taskLabel,
        status: 'ready',
        itemName: null,
        location: 'hand',
        desiredHotbarIndex,
      }
    }
    return {
      taskLabel,
      status: task.actionKind === 'generic' ? 'not_applicable' : 'missing',
      itemName: null,
      location: 'missing',
      desiredHotbarIndex,
      failureClass: task.actionKind === 'generic' ? undefined : 'ingredient_missing',
    }
  }
  const location = `${preferredSlot.container}#${preferredSlot.containerSlotIndex + 1}`
  if (preferredSlot.container === 'hotbar' && preferredSlot.containerSlotIndex === snapshot.selectedSlot) {
    return {
      taskLabel,
      status: 'ready',
      itemName: preferredSlot.itemName,
      location,
      desiredHotbarIndex,
    }
  }
  if (preferredSlot.container === 'hotbar') {
    return {
      taskLabel,
      status: 'hotbar_needs_select',
      itemName: preferredSlot.itemName,
      location,
      desiredHotbarIndex,
      failureClass: 'selected_slot_mismatch',
    }
  }
  return {
    taskLabel,
    status: 'inventory_needs_move',
    itemName: preferredSlot.itemName,
    location,
    desiredHotbarIndex,
    failureClass: 'equip_not_observed',
  }
}

export function getSafeDiscardPlan(snapshot: CanonicalInventorySnapshot, minimumFreeSlots = 1): Array<{ itemName: string, dropCount: number, reason: string }> {
  if (snapshot.freeSlotCount >= minimumFreeSlots) {
    return []
  }

  const requiredSlots = minimumFreeSlots - snapshot.freeSlotCount
  let slotsToFree = requiredSlots
  const plan: Array<{ itemName: string, dropCount: number, reason: string }> = []
  const totalCounts = Object.fromEntries(
    Object.entries(snapshot.groupedStacks).map(([itemName, group]) => [itemName, group.totalCount]),
  ) as Record<string, number>
  const candidates = snapshot.slots
    .filter(slot =>
      slot.itemName
      && (slot.container === 'hotbar' || slot.container === 'main')
      && isLowValueItemName(slot.itemName))
    .sort((left, right) =>
      right.container === 'hotbar' ? 1 : left.container === 'hotbar' ? -1 : left.count - right.count)

  for (const candidate of candidates) {
    if (slotsToFree <= 0) {
      break
    }

    const itemName = candidate.itemName!
    const keepLimit = LOW_VALUE_KEEP_LIMITS[itemName] ?? 0
    const currentTotal = totalCounts[itemName] ?? 0
    if ((currentTotal - candidate.count) < keepLimit) {
      continue
    }

    plan.push({
      itemName,
      dropCount: candidate.count,
      reason: 'inventory_pressure_low_value',
    })
    totalCounts[itemName] = currentTotal - candidate.count
    slotsToFree--
  }

  return plan
}

function formatLocation(slot: CanonicalInventorySlot | null): string {
  if (!slot) {
    return 'missing'
  }
  return `${slot.container}#${slot.containerSlotIndex + 1}`
}

function findFirstByCategory(snapshot: CanonicalInventorySnapshot, category: InventoryItemCategory): CanonicalInventorySlot | null {
  return snapshot.slots.find(slot => slot.itemName && slot.categories.includes(category)) ?? null
}

function getLowDurabilityRisks(snapshot: CanonicalInventorySnapshot): string[] {
  return snapshot.slots
    .filter(slot =>
      slot.itemName
      && slot.maxDurability
      && slot.durability !== null
      && slot.maxDurability > 0
      && (slot.durability / slot.maxDurability) <= 0.15,
    )
    .sort((left, right) => (left.durability ?? 0) - (right.durability ?? 0))
    .slice(0, 3)
    .map(slot => `${slot.itemName}:${slot.durability}/${slot.maxDurability}`)
}

export function formatCanonicalInventoryFacts(snapshot: CanonicalInventorySnapshot, task?: InventoryTaskContext): string[] {
  const hotbarSummary = snapshot.defaultHotbarPolicy.assignments
    .map((assignment) => {
      const label = assignment.itemName ?? 'empty'
      return `${assignment.hotbarIndex + 1}=${label}[${assignment.role}]`
    })
    .join('; ')
  const alerts: string[] = []
  if (snapshot.freeSlotCount <= 2) {
    alerts.push('full_inventory_pressure')
  }
  if (snapshot.compactness.fragmentedStacks > 0) {
    alerts.push(`fragmented:${snapshot.compactness.fragmentedItemNames.join('|')}`)
  }
  if (snapshot.defaultHotbarPolicy.violations.length > 0) {
    alerts.push(`hotbar_policy:${snapshot.defaultHotbarPolicy.violations.join('|')}`)
  }
  const durabilityRisks = getLowDurabilityRisks(snapshot)
  if (durabilityRisks.length > 0) {
    alerts.push(`durability:${durabilityRisks.join('|')}`)
  }
  if (snapshot.essentials.missing.length > 0) {
    alerts.push(`missing:${snapshot.essentials.missing.join('|')}`)
  }
  const taskReadiness = task ? describeInventoryTaskReadiness(snapshot, task) : null
  const bestMiningTool = selectBestToolSlot(snapshot, task?.targetBlockName)
  const bestWeapon = findFirstByCategory(snapshot, 'weapon')
  const bestFood = findFirstByCategory(snapshot, 'food')
  const bestBlock = findFirstByCategory(snapshot, 'block')
  const bestLight = snapshot.slots.find(slot => slot.itemName && LIGHT_SOURCE_ITEM_NAMES.has(slot.itemName)) ?? null

  return [
    `inventory_selected_slot: ${snapshot.selectedSlot + 1}`,
    `inventory_held_item: ${snapshot.heldItem?.itemName ? `${snapshot.heldItem.itemName} x${snapshot.heldItem.count}` : 'empty'}`,
    `inventory_free_slots: ${snapshot.freeSlotCount}/36`,
    `inventory_hotbar: ${hotbarSummary || 'empty'}`,
    `inventory_ready_items: mining=${bestMiningTool?.itemName ?? 'missing'}@${formatLocation(bestMiningTool)}, weapon=${bestWeapon?.itemName ?? 'missing'}@${formatLocation(bestWeapon)}, food=${bestFood?.itemName ?? 'missing'}@${formatLocation(bestFood)}, block=${bestBlock?.itemName ?? 'missing'}@${formatLocation(bestBlock)}, light=${bestLight?.itemName ?? 'missing'}@${formatLocation(bestLight)}`,
    `inventory_capabilities: craft=${snapshot.craftableFacts.craftableNow.join('|') || 'none'}, smelt=${snapshot.craftableFacts.smeltableNow.join('|') || 'none'}, fuel_capacity=${snapshot.craftableFacts.estimatedFuelCapacity}`,
    `inventory_alerts: ${alerts.join(', ') || 'none'}`,
    `inventory_desync: ${snapshot.invariants.desyncSuspected ? `suspected(${snapshot.invariants.issues.join('|')})` : 'clear'}`,
    taskReadiness
      ? `inventory_task_readiness: ${taskReadiness.taskLabel}=${taskReadiness.status}${taskReadiness.itemName ? `:${taskReadiness.itemName}@${taskReadiness.location}` : ''}`
      : '',
  ].filter(Boolean)
}
