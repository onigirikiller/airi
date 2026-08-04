/**
 * BotProxy: provides a mineflayer.Bot-compatible interface backed by WebSocket.
 *
 * Caches state from mod push events and translates method calls to WebSocket commands.
 */

import type {
  BlockData,
  EntityData,
  HealthState,
  InventoryItem,
  InventoryState,
  PositionState,
  TimeState,
} from './types'
import type { WsClient } from './ws-client'

import EventEmitter from 'eventemitter3'

import { useLogg } from '@guiiai/logg'

import { getFallbackCraftRecipeRequirements } from '../../utils/crafting-recipe-hints'
import { getItemId, getItemName } from '../../utils/mcdata'
import { buildCanonicalInventorySnapshot, rawSlotToMineflayerSlot, selectBestToolSlot } from '../inventory/policy'
import { clearSessionResumeSnapshot, loadSessionResumeSnapshot, saveSessionResumeSnapshot } from './session-resume'

/**
 * Minimal Vec3-like interface matching mineflayer's Vec3.
 */
export class Vec3Simple {
  constructor(public x: number, public y: number, public z: number) {}

  clone(): Vec3Simple {
    return new Vec3Simple(this.x, this.y, this.z)
  }

  distanceTo(other: Vec3Simple | { x: number, y: number, z: number }): number {
    const dx = this.x - other.x
    const dy = this.y - other.y
    const dz = this.z - other.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  offset(dx: number, dy: number, dz: number): Vec3Simple {
    return new Vec3Simple(this.x + dx, this.y + dy, this.z + dz)
  }

  plus(other: Vec3Simple | { x: number, y: number, z: number }): Vec3Simple {
    return new Vec3Simple(this.x + other.x, this.y + other.y, this.z + other.z)
  }

  floored(): Vec3Simple {
    return new Vec3Simple(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z))
  }

  toString(): string {
    return `(${this.x.toFixed(2)}, ${this.y.toFixed(2)}, ${this.z.toFixed(2)})`
  }
}

/**
 * Minimal Item-like interface.
 */
export interface BotItem {
  type: number
  count: number
  slot: number
  name: string
  maxDurability: number
  durability: number
}

/**
 * Minimal Block-like interface matching mineflayer's Block.
 */
export interface BotBlock {
  name: string
  position: Vec3Simple
  type: number
  diggable: boolean
  drops: number[]
  canHarvest: (itemId?: number | null) => boolean
}

interface CachedBotBlock {
  block: BotBlock
  updatedAt: number
}

/**
 * Strip the "minecraft:" namespace prefix from item/block names.
 * e.g. "minecraft:oak_log" → "oak_log"
 */
function stripNamespace(name: string): string {
  const idx = name.indexOf(':')
  return idx >= 0 ? name.substring(idx + 1) : name
}

function toNamespacedBlockName(name: string): string {
  const trimmed = String(name).trim()
  if (!trimmed) {
    return trimmed
  }
  return trimmed.includes(':') ? trimmed : `minecraft:${stripNamespace(trimmed)}`
}

const FIND_BLOCKS_REQUEST_TIMEOUT_MS = 1_500

function resolveCraftItemName(recipe: unknown): string {
  if (typeof recipe === 'string') {
    const trimmed = recipe.trim()
    if (/^\d+$/.test(trimmed)) {
      const itemName = getItemName(Number(trimmed))
      return stripNamespace(itemName || trimmed)
    }
    return stripNamespace(trimmed)
  }

  if (recipe && typeof recipe === 'object') {
    const candidate = recipe as Record<string, unknown>
    if (typeof candidate.output === 'string' && candidate.output.length > 0) {
      return stripNamespace(candidate.output)
    }
    if (typeof candidate.id === 'string' && candidate.id.length > 0) {
      return stripNamespace(candidate.id)
    }
  }

  return stripNamespace(String(recipe))
}

function countInventoryItems(items: InventoryItem[], itemName: string): number {
  const normalizedItemName = stripNamespace(itemName).toLowerCase()
  return items
    .filter(item => stripNamespace(item.name).toLowerCase().includes(normalizedItemName))
    .reduce((sum, item) => sum + item.count, 0)
}

function countMissingCraftIngredients(
  recipe: unknown,
  craftedItemName: string,
  count: number,
  inventoryItems: InventoryItem[],
): number {
  const craftIterations = Math.max(
    1,
    typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : 1,
  )
  let missingIngredients = 0

  if (recipe && typeof recipe === 'object' && Array.isArray((recipe as any).delta)) {
    for (const entry of (recipe as any).delta ?? []) {
      if (!entry || typeof entry !== 'object' || typeof entry.count !== 'number' || entry.count >= 0) {
        continue
      }

      const ingredientName = getItemName(entry.id)
      if (!ingredientName) {
        return Number.POSITIVE_INFINITY
      }

      const available = countInventoryItems(inventoryItems, ingredientName)
      const required = Math.abs(Math.floor(entry.count)) * craftIterations
      if (available < required) {
        missingIngredients += required - available
      }
    }

    return missingIngredients
  }

  const fallbackRequirements = getFallbackCraftRecipeRequirements(craftedItemName, craftIterations)
  if (fallbackRequirements.length <= 0) {
    return Number.POSITIVE_INFINITY
  }

  for (const requirement of fallbackRequirements) {
    const available = countInventoryItems(inventoryItems, requirement.itemName)
    if (available < requirement.count) {
      missingIngredients += requirement.count - available
    }
  }

  return missingIngredients
}

function consumeInventoryItemsMatchingQuery(
  items: InventoryItem[],
  itemQuery: string,
  count: number,
): InventoryItem[] {
  if (count <= 0 || items.length <= 0) {
    return items.map(item => ({ ...item }))
  }

  const normalizedQuery = stripNamespace(itemQuery).toLowerCase()
  const nextItems = items.map(item => ({ ...item }))
  const matchingIndexes = nextItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => stripNamespace(item.name).toLowerCase().includes(normalizedQuery))
    .sort((left, right) => right.item.count - left.item.count)

  let remaining = Math.floor(count)
  for (const { index } of matchingIndexes) {
    if (remaining <= 0) {
      break
    }

    const item = nextItems[index]
    if (!item) {
      continue
    }

    const consumedCount = Math.min(item.count, remaining)
    remaining -= consumedCount
    item.count -= consumedCount
  }

  return nextItems.filter(item => item.count > 0)
}

interface RecentCraftInventoryGuard {
  itemName: string
  minCount: number
  expiresAt: number
  confirmedVisibleSnapshots: number
  confirmedByBridgeInventory: boolean
  stickyUntilExpiry: boolean
}

function recentCraftInventoryGuardKey(itemName: string): string {
  return stripNamespace(itemName).toLowerCase()
}

function toolRank(itemName: string): number {
  const normalized = stripNamespace(itemName)
  if (normalized.startsWith('netherite_'))
    return 5
  if (normalized.startsWith('diamond_'))
    return 4
  if (normalized.startsWith('iron_'))
    return 3
  if (normalized.startsWith('stone_'))
    return 2
  if (normalized.startsWith('wooden_') || normalized.startsWith('golden_'))
    return 1
  return 0
}

function getPreferredToolKeyword(blockName: string): 'pickaxe' | 'axe' | 'shovel' | null {
  const normalized = stripNamespace(blockName)
  if (
    normalized === 'stone'
    || normalized === 'cobblestone'
    || normalized === 'obsidian'
    || normalized.includes('ore')
    || normalized.includes('deepslate')
  ) {
    return 'pickaxe'
  }
  if (
    normalized.endsWith('_log')
    || normalized.endsWith('_wood')
    || normalized.endsWith('_stem')
    || normalized.endsWith('_hyphae')
  ) {
    return 'axe'
  }
  if (
    normalized === 'dirt'
    || normalized === 'grass_block'
    || normalized === 'sand'
    || normalized === 'gravel'
    || normalized === 'clay'
  ) {
    return 'shovel'
  }
  return null
}

function matchesPreferredToolKeyword(itemName: string, preferredKeyword: 'pickaxe' | 'axe' | 'shovel' | null): boolean {
  if (!preferredKeyword) {
    return true
  }
  const normalized = stripNamespace(itemName)
  if (preferredKeyword === 'axe') {
    return normalized.includes('axe') && !normalized.includes('pickaxe')
  }
  return normalized.includes(preferredKeyword)
}

function makeBotBlock(name: string, position: Vec3Simple): BotBlock {
  const isAir = name === 'air' || name === 'cave_air' || name === 'void_air'
  const isBedrock = name === 'bedrock'
  return {
    name,
    position,
    type: 0,
    diggable: !isAir && !isBedrock,
    drops: isAir ? [] : [1],
    canHarvest: () => !isBedrock,
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildCapabilityHash(
  supportedCommands: Iterable<string>,
  unsupportedCommands: Iterable<string>,
): string {
  const supported = [...supportedCommands].sort().join('|') || 'none'
  const unsupported = [...unsupportedCommands].sort().join('|') || 'none'
  return `supported:${supported}::unsupported:${unsupported}`
}

export interface BridgeCommandCapabilitySnapshot {
  supportedCommands: string[]
  unsupportedCommands: string[]
  capabilityHash: string
  sourceKind: string
  updatedAt: number
}

export class BridgeUnsupportedCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly reason: string,
  ) {
    super(`Bridge command unsupported (${command}): ${reason}`)
    this.name = 'BridgeUnsupportedCommandError'
  }
}

/**
 * Response shape for furnace slot RPCs.
 */
interface FurnaceSlotsResponse {
  status: string
  inputItem?: { name: string, count: number, slot: number, maxDurability: number, durability: number }
  fuelItem?: { name: string, count: number, slot: number, maxDurability: number, durability: number }
  outputItem?: { name: string, count: number, slot: number, maxDurability: number, durability: number }
}

/**
 * Mineflayer-compatible furnace wrapper backed by FabricBridge RPCs.
 * Provides sync getters (from cached state) and async mutators.
 */
export class FabricFurnace {
  private _inputItem: BotItem | null = null
  private _fuelItem: BotItem | null = null
  private _outputItem: BotItem | null = null

  constructor(private ws: WsClient, initialSlots: FurnaceSlotsResponse) {
    this.applySlots(initialSlots)
  }

  private applySlots(slots: FurnaceSlotsResponse): void {
    this._inputItem = slots.inputItem ? this.toItem(slots.inputItem) : null
    this._fuelItem = slots.fuelItem ? this.toItem(slots.fuelItem) : null
    this._outputItem = slots.outputItem ? this.toItem(slots.outputItem) : null
  }

  private toItem(raw: { name: string, count: number, slot: number, maxDurability: number, durability: number }): BotItem {
    const name = stripNamespace(raw.name)
    return {
      type: getItemId(name),
      count: raw.count,
      slot: raw.slot,
      name,
      maxDurability: raw.maxDurability,
      durability: raw.durability,
    }
  }

  private async refreshSlots(): Promise<void> {
    await wait(100)
    const slots = await this.ws.request<FurnaceSlotsResponse>('getFurnaceSlots', {})
    this.applySlots(slots)
  }

  async refresh(): Promise<void> {
    const slots = await this.ws.request<FurnaceSlotsResponse>('getFurnaceSlots', {})
    this.applySlots(slots)
  }

  inputItem(): BotItem | null {
    return this._inputItem
  }

  fuelItem(): BotItem | null {
    return this._fuelItem
  }

  outputItem(): BotItem | null {
    return this._outputItem
  }

  async putInput(itemType: number, _metadata: unknown, count: number): Promise<void> {
    const itemName = getItemName(itemType)
    await this.ws.request('furnacePutInput', { item: itemName, count })
    await this.refreshSlots()
  }

  async putFuel(itemType: number, _metadata: unknown, count: number): Promise<void> {
    const itemName = getItemName(itemType)
    await this.ws.request('furnacePutFuel', { item: itemName, count })
    await this.refreshSlots()
  }

  async takeOutput(): Promise<BotItem | null> {
    const resp = await this.ws.request<{ item?: { name: string, count: number, slot: number, maxDurability: number, durability: number } }>('furnaceTakeOutput', {})
    await this.refreshSlots()
    return resp.item ? this.toItem(resp.item) : null
  }

  async takeInput(): Promise<BotItem | null> {
    const resp = await this.ws.request<{ item?: { name: string, count: number, slot: number, maxDurability: number, durability: number } }>('furnaceTakeInput', {})
    await this.refreshSlots()
    return resp.item ? this.toItem(resp.item) : null
  }

  async takeFuel(): Promise<BotItem | null> {
    const resp = await this.ws.request<{ item?: { name: string, count: number, slot: number, maxDurability: number, durability: number } }>('furnaceTakeFuel', {})
    await this.refreshSlots()
    return resp.item ? this.toItem(resp.item) : null
  }

  async close(): Promise<void> {
    await this.ws.request('closeFurnace', {})
  }
}

/**
 * BotProxy emulates the subset of mineflayer.Bot used by skills.
 */
export class BotProxy extends EventEmitter {
  private static readonly RECENT_CRAFT_INVENTORY_GUARD_TTL_MS = 90_000
  private static readonly SESSION_RESUME_PERSIST_PREFIXES = [
    'fabric-getInventory',
    'fabric-state:inventory',
    'fabric-refreshInventory',
    'fabric-equip-response',
    'fabric-toss-response',
    'fabric-selectHotbarSlot',
    'fabric-swapInventorySlots',
    'fabric-compactInventory',
    'fabric-recent-craft-guard',
    'fabric-speculative-craft-guard',
  ]

  private ws: WsClient
  private logger = useLogg('FabricBridge:BotProxy').useGlobalConfig()
  private digCompletionTimeoutMs = 20_000
  private digAttemptIntervalMs = 250

  // ─── Cached State ────────────────────────────────────────────────────────

  entity = {
    position: new Vec3Simple(0, 0, 0),
    velocity: new Vec3Simple(0, 0, 0),
    yaw: 0,
    pitch: 0,
    onGround: true,
    username: '',
  }

  health = 20
  food = 20
  oxygenLevel = 20

  game = {
    dimension: 'minecraft:overworld' as string,
    gameMode: 'survival' as string,
    difficulty: 'normal' as string,
  }

  time = {
    timeOfDay: 0,
    day: 0,
    isDay: true,
    age: 0,
  }

  players: Record<string, { entity?: { position: Vec3Simple }, username: string, ping: number }> = {}

  // Entity cache from world
  entities: Record<number, EntityData & { position: Vec3Simple }> = {}

  // Inventory cache
  private strictRawInventoryItems: InventoryItem[] = []
  private rawInventoryItems: InventoryItem[] = []
  private inventoryItems: InventoryItem[] = []
  private armorItems: InventoryItem[] = []
  private offhandItem: InventoryItem | null = null
  private selectedSlot = 0
  private lastSessionResumeStateJson = ''
  private lastNonEmptyInventoryItems: InventoryItem[] = []
  private lastNonEmptyInventoryObservedAt = 0
  private consecutiveEmptyInventorySnapshots = 0
  private recentCraftInventoryGuards = new Map<string, RecentCraftInventoryGuard>()
  private supportedBridgeCommands = new Set<string>()
  private unsupportedBridgeCommands = new Set<string>()
  private bridgeCapabilityHash = buildCapabilityHash([], [])
  private bridgeCapabilitySourceKind = 'fabric-bridge:init'
  private bridgeCapabilitiesUpdatedAt = 0
  private canonicalInventorySnapshot = buildCanonicalInventorySnapshot({
    sourceKind: 'fabric-bridge:init',
  })

  inventory = {
    items: () => {
      this.updateCanonicalInventoryState('fabric-bridge:inventory.items')
      return this.canonicalInventorySnapshot.slots
        .filter(slot => slot.itemName)
        .map(slot => this.toBotItemFromCanonicalSlot(slot))
    },
    slots: [] as (BotItem | null)[],
    selectedSlot: 0,
    emptySlotCount: () => {
      this.updateCanonicalInventoryState('fabric-bridge:inventory.emptySlotCount')
      return this.canonicalInventorySnapshot.freeSlotCount
    },
    findInventoryItem: (itemType: number, _metadata: unknown, _notFull?: boolean) => {
      this.updateCanonicalInventoryState('fabric-bridge:inventory.findInventoryItem')
      const itemName = stripNamespace(getItemName(itemType))
      return this.inventory.items().find(item => item.name === itemName) ?? null
    },
  }

  // Pathfinder stub (will be replaced by pathfinder.ts via FabricBridge)
  pathfinder: any = {
    goto: async (_goal: unknown) => { throw new Error('Use FabricBridge pathfinder') },
    setGoal: (_goal: unknown, _dynamic?: boolean) => {},
    setMovements: (_movements: unknown) => {},
    isMoving: () => false,
    isMining: () => false,
    isBuilding: () => false,
    stop: () => {},
    getPathTo: async () => ({ status: 'success' }),
  }

  // PVP stub
  pvp = {
    attack: async (entity: unknown) => {
      const e = entity as EntityData
      await this.ws.request('pvpAttack', { entityId: e.id })
    },
    stop: () => {
      this.ws.send('stopAttack', {})
    },
    forceStop: () => {
      this.ws.send('stopAttack', {})
    },
  }

  // Block cache for sync blockAt lookups.
  private blockCache = new Map<string, CachedBotBlock>()
  private readonly blockCacheTtlMs = 15_000

  constructor(ws: WsClient, username: string) {
    super()
    this.ws = ws
    this.entity.username = username
    this.restoreSessionResumeSnapshot()

    // Listen for state push events
    ws.on('event', (event) => {
      this.handleEvent(event.type, event.data)
    })
  }

  get username(): string {
    return this.entity.username
  }

  // ─── Bot Methods (mineflayer-compatible) ─────────────────────────────────

  async chat(message: string): Promise<void> {
    await this.ws.request('chat', { message })
  }

  async lookAt(position: Vec3Simple, _force?: boolean): Promise<void> {
    const dx = position.x - this.entity.position.x
    const dy = position.y - (this.entity.position.y + 1.6) // eye height
    const dz = position.z - this.entity.position.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    const yaw = Math.atan2(-dx, dz) * 180 / Math.PI
    const pitch = -(Math.atan2(dy, dist) * 180 / Math.PI)

    await this.ws.request('look', { yaw, pitch })
  }

  async dig(block: BotBlock | { position: Vec3Simple }): Promise<void> {
    const pos = block.position
    const targetPos = new Vec3Simple(
      Math.floor(pos.x),
      Math.floor(pos.y),
      Math.floor(pos.z),
    )

    // Look at the target block before digging so the Fabric mod's dig handler
    // can interact with the correct block face.
    await this.lookAt(new Vec3Simple(targetPos.x + 0.5, targetPos.y + 0.5, targetPos.z + 0.5))
    await wait(100)

    const deadline = Date.now() + this.digCompletionTimeoutMs
    while (Date.now() <= deadline) {
      const digResult = await this.ws.request<{ status?: string }>('dig', {
        x: targetPos.x,
        y: targetPos.y,
        z: targetPos.z,
      }, 20_000)

      // Give the server a moment to propagate the block change before rechecking.
      await wait(Math.max(0, this.digAttemptIntervalMs))

      const currentBlock = await this.fetchBlock(targetPos)
      if (currentBlock === null) {
        this.cacheBlockAt(targetPos, 'air')
        return
      }

      if (digResult.status === 'digging') {
        continue
      }
    }

    this.invalidateBlock(targetPos)
    throw new Error(`Digging timed out at ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`)
  }

  async placeBlock(referenceBlock: BotBlock | { position: Vec3Simple }, faceVector: Vec3Simple): Promise<void> {
    const pos = referenceBlock.position
    const face = this.vectorToFace(faceVector)
    const placedItemName = this.heldItem?.name ?? null
    await this.ws.request('place', {
      x: Math.floor(pos.x) + faceVector.x,
      y: Math.floor(pos.y) + faceVector.y,
      z: Math.floor(pos.z) + faceVector.z,
      face,
    })
    const placedPos = new Vec3Simple(
      Math.floor(pos.x) + faceVector.x,
      Math.floor(pos.y) + faceVector.y,
      Math.floor(pos.z) + faceVector.z,
    )
    this.cacheBlockAt(placedPos, placedItemName ?? 'air')
    if (placedItemName) {
      this.consumeRecentCraftInventoryItem(placedItemName, 1)
      this.rawInventoryItems = consumeInventoryItemsMatchingQuery(this.rawInventoryItems, placedItemName, 1)
      this.inventoryItems = consumeInventoryItemsMatchingQuery(this.inventoryItems, placedItemName, 1)
      this.rawInventoryItems = this.applyRecentCraftGuardsToItems(this.rawInventoryItems, {
        confirmedOnly: true,
      })
      this.applyRecentCraftGuardToInventory()
    }
  }

  async equip(item: BotItem | number, destination: string): Promise<void> {
    const itemName = typeof item === 'number' ? String(item) : item.name
    const result = await this.ws.request<InventoryState>('equip', { item: itemName, slot: destination })

    if (Array.isArray(result.items)) {
      this.strictRawInventoryItems = result.items.map(current => ({ ...current }))
      this.rawInventoryItems = result.items.map(current => ({ ...current }))
      this.inventoryItems = result.items.map(current => ({ ...current }))
    }
    if (Array.isArray(result.armor)) {
      this.armorItems = result.armor.map(current => ({ ...current }))
    }
    if ('offhand' in result) {
      this.offhandItem = result.offhand ? { ...result.offhand } : null
    }
    if (typeof result.selectedSlot === 'number') {
      this.selectedSlot = result.selectedSlot
      this.inventory.selectedSlot = result.selectedSlot
    }
    this.updateCanonicalInventoryState('fabric-equip-response')

    if (destination === 'hand') {
      try {
        await this.refreshInventory()
      }
      catch {
        // NOTICE: Equip RPCs can succeed even when the immediate inventory refresh races the
        // bridge state push. Preserve the equip success instead of failing hand updates on sync lag.
      }
    }
  }

  async attack(entity: EntityData | { id: number }): Promise<void> {
    await this.ws.request('attack', { entityId: entity.id })
  }

  async activateBlock(block: BotBlock | { position: Vec3Simple }): Promise<void> {
    const pos = block.position
    await this.ws.request('activateBlock', {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
    })
  }

  private async sendCraftRequest(_craftedItemName: string, params: Record<string, unknown>): Promise<{
    status?: string
    message?: string
    crafted?: number
    item?: string
    inventory?: InventoryItem[]
    selectedSlot?: number
  }> {
    return await this.ws.request<{
      status?: string
      message?: string
      crafted?: number
      item?: string
      inventory?: InventoryItem[]
      selectedSlot?: number
    }>('craft', params)
  }

  async craft(recipe: unknown, count: number, craftingTable?: BotBlock | null): Promise<void> {
    const craftedItemName = resolveCraftItemName(recipe)
    // NOTICE: Send fully namespaced item names (e.g. "minecraft:oak_planks") to the
    // Fabric mod to prevent partial string matching. Without the namespace prefix,
    // "oak_planks" can match "dark_oak_planks" in the mod's recipe lookup.
    const params: Record<string, unknown> = { item: toNamespacedBlockName(craftedItemName), count }
    const hasLegacyItemFallback = stripNamespace(String(params.item)) !== String(params.item)

    const refreshInventorySnapshot = async (): Promise<void> => {
      try {
        const refresh = await this.ws.request<{
          items?: InventoryItem[]
          selectedSlot?: number
        }>('getInventory', {})
        if (Array.isArray(refresh.items)) {
          const visibleItems = this.resolveVisibleInventorySnapshot(refresh.items, 'craft-preflight:getInventory', {
            currentItems: this.strictRawInventoryItems,
          })
          this.strictRawInventoryItems = visibleItems.map(item => ({ ...item }))
          this.rawInventoryItems = this.resolveInventoryItemsWithRecentCraftGuard(visibleItems, 'craft-preflight:getInventory(raw)', {
            confirmedOnly: true,
            currentItems: this.rawInventoryItems,
            updateGuardVisibility: false,
          })
          if (!this.shouldKeepCurrentInventoryForRecentCraft(visibleItems)) {
            this.inventoryItems = visibleItems.map(item => ({ ...item }))
          }
        }
        if (typeof refresh.selectedSlot === 'number') {
          this.selectedSlot = refresh.selectedSlot
          this.inventory.selectedSlot = refresh.selectedSlot
        }
      }
      catch {
        // Non-fatal: proceed with cached inventory
      }
    }

    const countLocallyMissingCraftIngredients = (): number => countMissingCraftIngredients(
      recipe,
      craftedItemName,
      count,
      this.rawInventoryItems.length > 0
        ? this.rawInventoryItems
        : this.strictRawInventoryItems,
    )

    const shouldRetryAfterRefresh = (result: {
      status?: string
      message?: string
    }): boolean => {
      if (result.status !== 'error') {
        return false
      }

      if (result.message?.includes('did not produce output')) {
        return true
      }

      if (result.message?.includes('Not enough materials')) {
        return countLocallyMissingCraftIngredients() <= 0
      }

      return false
    }

    const shouldRetryWithoutNamespace = (result: {
      status?: string
      message?: string
    }): boolean => {
      if (!hasLegacyItemFallback || result.status !== 'error') {
        return false
      }

      if (result.message?.includes('did not produce output')) {
        return true
      }

      if (result.message?.includes('Not enough materials')) {
        return countLocallyMissingCraftIngredients() <= 0
      }

      return false
    }

    const countBefore = countInventoryItems(this.strictRawInventoryItems, craftedItemName)

    // NOTICE: Force an inventory refresh before crafting so the Fabric mod has an
    // up-to-date view of what the player actually holds. Without this, the mod-side
    // inventory can be stale and reject craft attempts with "did not produce output"
    // even though BotProxy's cached inventory shows the required materials.
    await refreshInventorySnapshot()
    const craftedDelta = Math.max(
      1,
      typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : 1,
    )
    if (craftingTable?.position) {
      params.craftingTable = {
        x: Math.floor(craftingTable.position.x),
        y: Math.floor(craftingTable.position.y),
        z: Math.floor(craftingTable.position.z),
      }
    }
    const legacyParams = stripNamespace(String(params.item)) !== String(params.item)
      ? { ...params, item: stripNamespace(String(params.item)) }
      : null

    // Attempt craft with one retry on transient "did not produce output" failures
    let result = await this.sendCraftRequest(craftedItemName, params)

    if (shouldRetryAfterRefresh(result)) {
      const missingIngredients = countLocallyMissingCraftIngredients()
      this.logger.warn(
        `Craft attempt may have failed with stale bridge state, retrying after refresh: ${craftedItemName}`,
        {
          message: result.message,
          locallyMissingIngredients: Number.isFinite(missingIngredients)
            ? missingIngredients
            : 'unknown',
        },
      )
      await wait(200)
      await refreshInventorySnapshot()
      result = await this.sendCraftRequest(craftedItemName, params)

      if (shouldRetryWithoutNamespace(result)) {
        const fallbackParams = legacyParams
        if (!fallbackParams) {
          throw new Error('Legacy craft retry was requested without fallback params')
        }
        const missingIngredientsAfterRefresh = countLocallyMissingCraftIngredients()
        // NOTICE: Newer bridge builds sometimes reject namespaced craft targets even though
        // recipe discovery still works. Retry once with the legacy unnamespaced item id so
        // log -> planks bootstrap does not deadlock on a bridge naming compatibility drift.
        this.logger.warn(
          `Craft attempt still failed after refresh, retrying without namespace: ${craftedItemName}`,
          {
            locallyMissingIngredients: Number.isFinite(missingIngredientsAfterRefresh)
              ? missingIngredientsAfterRefresh
              : 'unknown',
            requestedItem: params.item,
            fallbackItem: fallbackParams.item,
            message: result.message,
          },
        )
        await wait(200)
        await refreshInventorySnapshot()
        result = await this.sendCraftRequest(craftedItemName, fallbackParams)
      }
    }

    if (result.status === 'error') {
      if (result.message?.includes('did not produce output')) {
        // NOTICE: When craft grid fill still fails after both the namespaced and legacy item
        // request paths, emit the bridge-side inventory snapshot we actually retried with.
        // This keeps future live-debug iterations focused on the true remaining blocker.
        this.logger.warn(`Craft failed after all retry paths for ${craftedItemName}`, {
          selectedSlot: this.selectedSlot,
          inventoryItems: this.inventoryItems.map(item => ({
            slot: item.slot,
            name: item.name,
            count: item.count,
          })),
        })
      }
      throw new Error(result.message || `Bridge craft failed for ${craftedItemName}`)
    }
    if (typeof result.crafted !== 'number' || result.crafted <= 0) {
      throw new Error(`Bridge craft did not confirm any crafted output for ${craftedItemName}`)
    }
    // NOTICE: Bridge inventory refreshes after a successful follow-up craft can temporarily
    // omit inputs from the immediately previous craft. Apply the recipe's ingredient
    // consumption to active recent-craft guards first so stale snapshots preserve only the
    // correct remaining amount instead of either erasing the item or resurrecting too much.
    this.consumeRecentCraftInventoryIngredients(recipe, count, craftedItemName)
    if (Array.isArray(result.inventory)) {
      this.rawInventoryItems = result.inventory.map(item => ({ ...item }))
      this.inventoryItems = result.inventory.map(item => ({ ...item }))
    }
    if (typeof result.selectedSlot === 'number') {
      this.selectedSlot = result.selectedSlot
      this.inventory.selectedSlot = result.selectedSlot
    }

    // Reconcile with an explicit bridge inventory fetch so crafting success reflects
    // the real Minecraft-side inventory instead of an optimistic local merge.
    try {
      const refreshResult = await this.ws.request<{
        items?: InventoryItem[]
        selectedSlot?: number
      }>('getInventory', {})

      const refreshedItems = Array.isArray(refreshResult.items)
        ? this.resolveVisibleInventorySnapshot(refreshResult.items, `craft:getInventory:${craftedItemName}`, {
            currentItems: this.strictRawInventoryItems,
          })
        : null
      const craftedCountFromResponse = Array.isArray(result.inventory)
        ? countInventoryItems(result.inventory, craftedItemName)
        : 0
      const craftedCountFromRefresh = refreshedItems
        ? countInventoryItems(refreshedItems, craftedItemName)
        : 0
      const confirmedCraftedCount = Math.max(craftedCountFromResponse, craftedCountFromRefresh)
      const craftResponseAdvancedInventory = craftedCountFromResponse > countBefore
      const refreshLooksStale
        = craftResponseAdvancedInventory
          && craftedCountFromRefresh < craftedCountFromResponse

      const confirmedByExplicitRefresh = craftedCountFromRefresh > countBefore

      if (confirmedCraftedCount > countBefore) {
        this.rememberRecentCraftInventory(craftedItemName, confirmedCraftedCount, {
          // NOTICE: Only treat explicit `getInventory` visibility as confirmed raw inventory.
          // The craft RPC's inline `inventory` payload can be a partial delta view, and using
          // it as "actual inventory" causes false-positive craft confirmations where the next
          // dependent recipe still fails with "Not enough materials".
          confirmedByBridgeInventory: confirmedByExplicitRefresh,
        })
        // NOTICE: A stale `state:inventory` push can race between the craft response and
        // the recent-craft guard setup. Re-apply the confirmed craft result immediately
        // after arming the guard so the cached inventory cannot stay regressed until the
        // next explicit refresh.
        this.applyRecentCraftGuardToInventory()
      }
      else if (craftedCountFromRefresh <= countBefore) {
        const speculativeCount = countBefore + (typeof result.crafted === 'number' && result.crafted > 0
          ? Math.floor(result.crafted)
          : craftedDelta)
        this.applySpeculativeCraftInventory(craftedItemName, speculativeCount)
        this.rememberRecentCraftInventory(craftedItemName, speculativeCount)
        this.logger.warn(
          `Synthesizing crafted ${craftedItemName} in cached inventory because craft succeeded but both bridge inventory snapshots looked stale.`,
          {
            countBefore,
            craftedCountFromResponse,
            craftedCountFromRefresh,
            speculativeCount,
          },
        )
      }

      if (refreshedItems && !refreshLooksStale) {
        this.strictRawInventoryItems = refreshedItems.map(item => ({ ...item }))
        this.rawInventoryItems = this.resolveInventoryItemsWithRecentCraftGuard(refreshedItems, `craft:getInventory(raw:${craftedItemName})`, {
          confirmedOnly: true,
          currentItems: this.rawInventoryItems,
          updateGuardVisibility: false,
        })
        this.inventoryItems = refreshedItems
        if (this.recentCraftInventoryGuards.size > 0) {
          this.applyRecentCraftGuardToInventory()
        }
      }
      else if (refreshLooksStale) {
        if (refreshedItems) {
          this.strictRawInventoryItems = refreshedItems.map(item => ({ ...item }))
        }
        this.logger.warn(
          `Keeping craft response inventory for ${craftedItemName} because explicit refresh looked stale.`,
          {
            countBefore,
            craftedCountFromResponse,
            craftedCountFromRefresh,
          },
        )
      }

      if (typeof refreshResult.selectedSlot === 'number') {
        this.selectedSlot = refreshResult.selectedSlot
        this.inventory.selectedSlot = refreshResult.selectedSlot
      }
    }
    catch {
      if (Array.isArray(result.inventory)) {
        this.rawInventoryItems = result.inventory.map(item => ({ ...item }))
        this.inventoryItems = result.inventory.map(item => ({ ...item }))
      }
      const speculativeCount = countBefore + (typeof result.crafted === 'number' && result.crafted > 0
        ? Math.floor(result.crafted)
        : craftedDelta)
      if (countInventoryItems(this.inventoryItems, craftedItemName) <= countBefore) {
        this.applySpeculativeCraftInventory(craftedItemName, speculativeCount)
        this.rememberRecentCraftInventory(craftedItemName, speculativeCount)
      }
      if (typeof result.selectedSlot === 'number') {
        this.selectedSlot = result.selectedSlot
        this.inventory.selectedSlot = result.selectedSlot
      }
    }
  }

  async recipesFor(itemId: number, _metadata: unknown, _count: number, _craftingTable: unknown): Promise<unknown[]> {
    const itemName = stripNamespace(getItemName(itemId))
    if (!itemName) {
      return []
    }

    const result = await this.ws.request<{ recipes: Array<{ output?: string }> }>('recipesFor', { item: itemName })
    return (result.recipes || [])
      .map(recipe => typeof recipe?.output === 'string' ? stripNamespace(recipe.output) : null)
      .filter((recipe): recipe is string => Boolean(recipe))
  }

  async openFurnace(block: BotBlock | { position: Vec3Simple }): Promise<FabricFurnace> {
    const pos = block.position
    const slots = await this.ws.request<FurnaceSlotsResponse>('openFurnace', {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
    })
    return new FabricFurnace(this.ws, slots)
  }

  async consume(): Promise<void> {
    await this.ws.request('consume', {})
    // Wait for eating animation to complete (~1.6s + buffer)
    await wait(2500)
  }

  async toss(itemType: number, _metadata: unknown, count: number): Promise<void> {
    const itemName = stripNamespace(getItemName(itemType) || String(itemType))
    const result = await this.ws.request<InventoryState>('toss', { item: itemName, count })
    if (Array.isArray(result.items)) {
      this.strictRawInventoryItems = result.items.map(item => ({ ...item }))
      this.rawInventoryItems = result.items.map(item => ({ ...item }))
      this.inventoryItems = result.items.map(item => ({ ...item }))
    }
    if (Array.isArray(result.armor)) {
      this.armorItems = result.armor.map(item => ({ ...item }))
    }
    if ('offhand' in result) {
      this.offhandItem = result.offhand ? { ...result.offhand } : null
    }
    if (typeof result.selectedSlot === 'number') {
      this.selectedSlot = result.selectedSlot
      this.inventory.selectedSlot = result.selectedSlot
    }
    this.updateCanonicalInventoryState('fabric-toss-response')
  }

  async selectHotbarSlot(slot: number): Promise<void> {
    const normalizedSlot = Math.max(0, Math.min(8, Math.trunc(slot)))
    const result = await this.requestBridgeCommand<InventoryState>('selectHotbarSlot', { slot: normalizedSlot })
    if (Array.isArray(result.items)) {
      this.strictRawInventoryItems = result.items.map(item => ({ ...item }))
      this.rawInventoryItems = result.items.map(item => ({ ...item }))
      this.inventoryItems = result.items.map(item => ({ ...item }))
    }
    if (Array.isArray(result.armor)) {
      this.armorItems = result.armor.map(item => ({ ...item }))
    }
    if ('offhand' in result) {
      this.offhandItem = result.offhand ? { ...result.offhand } : null
    }
    this.selectedSlot = normalizedSlot
    this.inventory.selectedSlot = normalizedSlot
    this.updateCanonicalInventoryState('fabric-selectHotbarSlot')
  }

  async moveSlotItem(fromSlot: number, toSlot: number): Promise<void> {
    const result = await this.requestBridgeCommand<InventoryState>('swapInventorySlots', {
      fromSlot,
      toSlot,
    })
    if (Array.isArray(result.items)) {
      this.strictRawInventoryItems = result.items.map(item => ({ ...item }))
      this.rawInventoryItems = result.items.map(item => ({ ...item }))
      this.inventoryItems = result.items.map(item => ({ ...item }))
    }
    if (Array.isArray(result.armor)) {
      this.armorItems = result.armor.map(item => ({ ...item }))
    }
    if ('offhand' in result) {
      this.offhandItem = result.offhand ? { ...result.offhand } : null
    }
    if (typeof result.selectedSlot === 'number') {
      this.selectedSlot = result.selectedSlot
      this.inventory.selectedSlot = result.selectedSlot
    }
    this.updateCanonicalInventoryState('fabric-swapInventorySlots')
  }

  async compactInventory(maxOperations = 12): Promise<void> {
    const result = await this.requestBridgeCommand<InventoryState>('compactInventory', { maxOperations })
    if (Array.isArray(result.items)) {
      this.strictRawInventoryItems = result.items.map(item => ({ ...item }))
      this.rawInventoryItems = result.items.map(item => ({ ...item }))
      this.inventoryItems = result.items.map(item => ({ ...item }))
    }
    if (Array.isArray(result.armor)) {
      this.armorItems = result.armor.map(item => ({ ...item }))
    }
    if ('offhand' in result) {
      this.offhandItem = result.offhand ? { ...result.offhand } : null
    }
    if (typeof result.selectedSlot === 'number') {
      this.selectedSlot = result.selectedSlot
      this.inventory.selectedSlot = result.selectedSlot
    }
    this.updateCanonicalInventoryState('fabric-compactInventory')
  }

  async closeWindow(window: unknown): Promise<void> {
    if (window instanceof FabricFurnace) {
      await window.close()
    }
    else {
      // Generic close for other window types
      try {
        await this.ws.request('closeFurnace', {})
      }
      catch {
        // Ignore if no screen is open
      }
    }
  }

  async refreshInventory(): Promise<void> {
    const result = await this.getInventorySnapshot()

    if (Array.isArray(result.items)) {
      this.inventoryItems = result.items.map(current => ({ ...current }))
    }
    if (typeof result.selectedSlot === 'number') {
      this.selectedSlot = result.selectedSlot
      this.inventory.selectedSlot = result.selectedSlot
    }
    this.updateCanonicalInventoryState('fabric-refreshInventory')
  }

  getRawInventoryItems(): InventoryItem[] {
    return this.rawInventoryItems.map(item => ({ ...item }))
  }

  getStrictRawInventoryItems(): InventoryItem[] {
    return this.strictRawInventoryItems.map(item => ({ ...item }))
  }

  confirmVisibleInventoryItem(itemName: string, minCount: number): void {
    if (minCount <= 0) {
      return
    }

    this.rememberRecentCraftInventory(itemName, minCount, {
      confirmedByBridgeInventory: true,
      stickyUntilExpiry: true,
    })
    this.rawInventoryItems = this.applyRecentCraftGuardsToItems(this.rawInventoryItems, {
      confirmedOnly: true,
    })
    this.applyRecentCraftGuardToInventory()
  }

  async getInventorySnapshot(): Promise<{
    items?: InventoryItem[]
    selectedSlot?: number
    armor?: InventoryItem[]
    offhand?: InventoryItem
  }> {
    const result = await this.ws.request<InventoryState>('getInventory', {})

    if (Array.isArray(result.items)) {
      const visibleItems = this.resolveVisibleInventorySnapshot(result.items, 'getInventory', {
        currentItems: this.strictRawInventoryItems,
      })
      this.strictRawInventoryItems = visibleItems.map(item => ({ ...item }))
      this.rawInventoryItems = this.resolveInventoryItemsWithRecentCraftGuard(visibleItems, 'getInventory(raw)', {
        confirmedOnly: true,
        currentItems: this.rawInventoryItems,
        updateGuardVisibility: false,
      })
      if (Array.isArray(result.armor)) {
        this.armorItems = result.armor.map(item => ({ ...item }))
      }
      if ('offhand' in result) {
        this.offhandItem = result.offhand ? { ...result.offhand } : null
      }
      if (typeof result.selectedSlot === 'number') {
        this.selectedSlot = result.selectedSlot
        this.inventory.selectedSlot = result.selectedSlot
      }
      const guardedResult = {
        ...result,
        items: this.resolveInventoryItemsWithRecentCraftGuard(visibleItems, 'getInventory'),
      }
      this.inventoryItems = Array.isArray(guardedResult.items)
        ? guardedResult.items.map(item => ({ ...item }))
        : this.inventoryItems
      this.updateCanonicalInventoryState('fabric-getInventory-pull')
      return guardedResult
    }

    if (Array.isArray(result.armor)) {
      this.armorItems = result.armor.map(item => ({ ...item }))
    }
    if ('offhand' in result) {
      this.offhandItem = result.offhand ? { ...result.offhand } : null
    }
    if (typeof result.selectedSlot === 'number') {
      this.selectedSlot = result.selectedSlot
      this.inventory.selectedSlot = result.selectedSlot
    }
    this.updateCanonicalInventoryState('fabric-getInventory-pull')
    return result
  }

  async getStrictInventorySnapshot(): Promise<{
    items?: InventoryItem[]
    selectedSlot?: number
    armor?: InventoryItem[]
    offhand?: InventoryItem
  }> {
    const result = await this.ws.request<InventoryState>('getInventory', {})

    if (Array.isArray(result.items)) {
      this.strictRawInventoryItems = this.resolveVisibleInventorySnapshot(result.items, 'getInventory(strict)', {
        currentItems: this.strictRawInventoryItems,
      })
    }
    if (Array.isArray(result.armor)) {
      this.armorItems = result.armor.map(item => ({ ...item }))
    }
    if ('offhand' in result) {
      this.offhandItem = result.offhand ? { ...result.offhand } : null
    }
    if (typeof result.selectedSlot === 'number') {
      this.selectedSlot = result.selectedSlot
      this.inventory.selectedSlot = result.selectedSlot
    }
    this.updateCanonicalInventoryState('fabric-getInventory-strict-pull')

    return {
      ...result,
      items: Array.isArray(result.items)
        ? this.strictRawInventoryItems.map(item => ({ ...item }))
        : result.items,
    }
  }

  private resolveVisibleInventorySnapshot(
    items: InventoryItem[],
    source: string,
    options?: {
      currentItems?: InventoryItem[]
    },
  ): InventoryItem[] {
    if (items.length > 0) {
      const cloned = items.map(item => ({ ...item }))
      this.lastNonEmptyInventoryItems = cloned.map(item => ({ ...item }))
      this.lastNonEmptyInventoryObservedAt = Date.now()
      this.consecutiveEmptyInventorySnapshots = 0
      return cloned
    }

    const currentItems = options?.currentItems ?? this.inventoryItems
    const fallbackItems = currentItems.length > 0
      ? currentItems
      : this.lastNonEmptyInventoryItems
    const ageMs = this.lastNonEmptyInventoryObservedAt > 0
      ? Date.now() - this.lastNonEmptyInventoryObservedAt
      : 0
    const nextEmptyCount = this.consecutiveEmptyInventorySnapshots + 1
    const canPreserveRecentVisibleInventory = fallbackItems.length > 0 && this.health > 0

    this.consecutiveEmptyInventorySnapshots = nextEmptyCount
    if (!canPreserveRecentVisibleInventory) {
      return []
    }

    this.logger.warn(
      `Preserving recent visible inventory after empty ${source} snapshot without an explicit death event.`,
      {
        emptySnapshotCount: nextEmptyCount,
        preservedSlots: fallbackItems.length,
        ageMs,
      },
    )
    return fallbackItems.map(item => ({ ...item }))
  }

  private restoreSessionResumeSnapshot(): void {
    const snapshot = loadSessionResumeSnapshot(this.username)
    if (!snapshot) {
      return
    }

    this.strictRawInventoryItems = snapshot.items.map(item => ({ ...item }))
    this.rawInventoryItems = snapshot.items.map(item => ({ ...item }))
    this.inventoryItems = snapshot.items.map(item => ({ ...item }))
    this.armorItems = snapshot.armorItems.map(item => ({ ...item }))
    this.offhandItem = snapshot.offhandItem ? { ...snapshot.offhandItem } : null
    this.selectedSlot = snapshot.selectedSlot
    this.inventory.selectedSlot = snapshot.selectedSlot
    this.lastNonEmptyInventoryItems = snapshot.items.map(item => ({ ...item }))
    this.lastNonEmptyInventoryObservedAt = snapshot.savedAt
    this.updateCanonicalInventoryState('fabric-resume-cache')

    this.logger.log(
      `Loaded persisted bridge resume snapshot for ${this.username}.`,
      {
        savedAt: snapshot.savedAt,
        inventorySlots: snapshot.items.length,
        armorSlots: snapshot.armorItems.length,
        hasOffhand: Boolean(snapshot.offhandItem),
      },
    )
  }

  private clearSessionResumeState(): void {
    this.lastSessionResumeStateJson = ''
    clearSessionResumeSnapshot(this.username)
  }

  private clearInventoryStateAfterDeath(sourceKind: string): void {
    this.strictRawInventoryItems = []
    this.rawInventoryItems = []
    this.inventoryItems = []
    this.armorItems = []
    this.offhandItem = null
    this.selectedSlot = 0
    this.inventory.selectedSlot = 0
    this.lastNonEmptyInventoryItems = []
    this.lastNonEmptyInventoryObservedAt = 0
    this.consecutiveEmptyInventorySnapshots = 0
    this.recentCraftInventoryGuards.clear()
    this.updateCanonicalInventoryState(sourceKind)
    this.clearSessionResumeState()
  }

  private syncSessionResumeSnapshot(sourceKind: string): void {
    if (!BotProxy.SESSION_RESUME_PERSIST_PREFIXES.some(prefix => sourceKind.startsWith(prefix))) {
      return
    }

    const items = (this.strictRawInventoryItems.length > 0
      ? this.strictRawInventoryItems
      : this.rawInventoryItems.length > 0
        ? this.rawInventoryItems
        : this.lastNonEmptyInventoryItems)
      .map(item => ({ ...item }))
    const armorItems = this.armorItems.map(item => ({ ...item }))
    const offhandItem = this.offhandItem ? { ...this.offhandItem } : null
    const hasMeaningfulState = items.length > 0 || armorItems.length > 0 || Boolean(offhandItem)

    if (!hasMeaningfulState) {
      if (this.lastSessionResumeStateJson) {
        this.clearSessionResumeState()
      }
      return
    }

    const stableState = {
      items,
      armorItems,
      offhandItem,
      selectedSlot: this.selectedSlot,
    }
    const nextJson = JSON.stringify(stableState)
    if (nextJson === this.lastSessionResumeStateJson) {
      return
    }

    saveSessionResumeSnapshot(this.username, {
      savedAt: Date.now(),
      ...stableState,
    })
    this.lastSessionResumeStateJson = nextJson
  }

  private rememberRecentCraftInventory(
    itemName: string,
    minCount: number,
    options?: {
      confirmedByBridgeInventory?: boolean
      stickyUntilExpiry?: boolean
    },
  ): void {
    if (minCount <= 0) {
      return
    }

    const key = recentCraftInventoryGuardKey(itemName)
    const existing = this.recentCraftInventoryGuards.get(key)
    this.recentCraftInventoryGuards.set(key, {
      itemName,
      minCount: Math.max(existing?.minCount ?? 0, minCount),
      expiresAt: Math.max(
        existing?.expiresAt ?? 0,
        Date.now() + BotProxy.RECENT_CRAFT_INVENTORY_GUARD_TTL_MS,
      ),
      confirmedVisibleSnapshots: 0,
      confirmedByBridgeInventory:
        Boolean(options?.confirmedByBridgeInventory)
        || Boolean(existing?.confirmedByBridgeInventory),
      stickyUntilExpiry:
        Boolean(options?.stickyUntilExpiry)
        || Boolean(existing?.stickyUntilExpiry),
    })
  }

  private consumeRecentCraftInventoryIngredients(recipe: unknown, count: number, craftedItemName: string): void {
    const craftIterations = Math.max(
      1,
      typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : 1,
    )

    if (recipe && typeof recipe === 'object' && Array.isArray((recipe as any).delta)) {
      for (const entry of (recipe as any).delta ?? []) {
        if (!entry || typeof entry !== 'object' || typeof entry.count !== 'number' || entry.count >= 0) {
          continue
        }

        const ingredientName = getItemName(entry.id)
        if (!ingredientName) {
          continue
        }

        this.consumeRecentCraftInventoryMatchingQuery(
          ingredientName,
          Math.abs(Math.floor(entry.count)) * craftIterations,
        )
        this.rawInventoryItems = consumeInventoryItemsMatchingQuery(
          this.rawInventoryItems,
          ingredientName,
          Math.abs(Math.floor(entry.count)) * craftIterations,
        )
        this.inventoryItems = consumeInventoryItemsMatchingQuery(
          this.inventoryItems,
          ingredientName,
          Math.abs(Math.floor(entry.count)) * craftIterations,
        )
      }
      this.rawInventoryItems = this.applyRecentCraftGuardsToItems(this.rawInventoryItems, {
        confirmedOnly: true,
      })
      this.applyRecentCraftGuardToInventory()
      return
    }

    for (const requirement of getFallbackCraftRecipeRequirements(craftedItemName, craftIterations)) {
      this.consumeRecentCraftInventoryMatchingQuery(requirement.itemName, requirement.count)
      this.rawInventoryItems = consumeInventoryItemsMatchingQuery(
        this.rawInventoryItems,
        requirement.itemName,
        requirement.count,
      )
      this.inventoryItems = consumeInventoryItemsMatchingQuery(
        this.inventoryItems,
        requirement.itemName,
        requirement.count,
      )
    }
    this.rawInventoryItems = this.applyRecentCraftGuardsToItems(this.rawInventoryItems, {
      confirmedOnly: true,
    })
    this.applyRecentCraftGuardToInventory()
  }

  private consumeRecentCraftInventoryItem(itemName: string, count: number): void {
    if (count <= 0) {
      return
    }

    const key = recentCraftInventoryGuardKey(itemName)
    const guard = this.recentCraftInventoryGuards.get(key)
    if (!guard) {
      return
    }

    const nextMinCount = Math.max(0, guard.minCount - Math.floor(count))
    if (nextMinCount <= 0) {
      this.recentCraftInventoryGuards.delete(key)
      return
    }

    this.recentCraftInventoryGuards.set(key, {
      ...guard,
      minCount: nextMinCount,
      confirmedVisibleSnapshots: 0,
    })
  }

  private consumeRecentCraftInventoryMatchingQuery(itemQuery: string, count: number): void {
    if (count <= 0) {
      return
    }

    const normalizedQuery = stripNamespace(itemQuery).toLowerCase()
    const matchingGuards = [...this.recentCraftInventoryGuards.entries()]
      .filter(([, guard]) => stripNamespace(guard.itemName).toLowerCase().includes(normalizedQuery))
      .sort((left, right) => right[1].minCount - left[1].minCount)

    let remaining = Math.floor(count)
    for (const [key, guard] of matchingGuards) {
      if (remaining <= 0) {
        break
      }

      const consumedCount = Math.min(guard.minCount, remaining)
      const nextMinCount = Math.max(0, guard.minCount - consumedCount)
      remaining -= consumedCount

      if (nextMinCount <= 0) {
        this.recentCraftInventoryGuards.delete(key)
        continue
      }

      this.recentCraftInventoryGuards.set(key, {
        ...guard,
        minCount: nextMinCount,
        confirmedVisibleSnapshots: 0,
      })
    }
  }

  private getActiveRecentCraftInventoryGuards(options?: {
    confirmedOnly?: boolean
  }): RecentCraftInventoryGuard[] {
    const now = Date.now()
    for (const [key, guard] of this.recentCraftInventoryGuards.entries()) {
      if (guard.minCount <= 0 || now > guard.expiresAt) {
        this.recentCraftInventoryGuards.delete(key)
      }
    }

    return [...this.recentCraftInventoryGuards.values()]
      .filter(guard => !options?.confirmedOnly || guard.confirmedByBridgeInventory)
  }

  private applyRecentCraftGuardToInventory(): void {
    this.rawInventoryItems = this.applyRecentCraftGuardsToItems(this.rawInventoryItems, {
      confirmedOnly: true,
    })
    this.inventoryItems = this.applyRecentCraftGuardsToItems(this.inventoryItems)
    this.updateCanonicalInventoryState('fabric-recent-craft-guard')
  }

  private applyRecentCraftGuardsToItems(
    items: InventoryItem[],
    options?: {
      confirmedOnly?: boolean
    },
  ): InventoryItem[] {
    let guardedItems = items.map(item => ({ ...item }))
    for (const guard of this.getActiveRecentCraftInventoryGuards(options)) {
      guardedItems = this.applySpeculativeCraftInventoryToItems(
        guardedItems,
        guard.itemName,
        guard.minCount,
      )
    }

    return guardedItems
  }

  private applySpeculativeCraftInventory(itemName: string, minCount: number): void {
    this.inventoryItems = this.applySpeculativeCraftInventoryToItems(this.inventoryItems, itemName, minCount)
    this.updateCanonicalInventoryState('fabric-speculative-craft-guard')
  }

  private applySpeculativeCraftInventoryToItems(
    items: InventoryItem[],
    itemName: string,
    minCount: number,
  ): InventoryItem[] {
    if (minCount <= 0) {
      return items
    }

    const normalizedItemName = stripNamespace(itemName).toLowerCase()
    const existingIndex = items.findIndex(item =>
      stripNamespace(item.name).toLowerCase() === normalizedItemName,
    )

    if (existingIndex >= 0) {
      const existing = items[existingIndex]!
      const nextItems = items.map(item => ({ ...item }))
      nextItems[existingIndex] = {
        ...existing,
        count: Math.max(existing.count, minCount),
      }
      return nextItems
    }

    return [
      ...items.map(item => ({ ...item })),
      {
        slot: this.findFirstFreeInventorySlot(items),
        name: toNamespacedBlockName(itemName),
        count: minCount,
        maxCount: this.isSingletonInventoryItem(itemName) ? 1 : 64,
        durability: 0,
        maxDurability: 0,
      },
    ]
  }

  private findFirstFreeInventorySlot(items: InventoryItem[] = this.inventoryItems): number {
    const occupiedSlots = new Set(items.map(item => item.slot))
    for (let slot = 9; slot <= 44; slot++) {
      if (!occupiedSlots.has(slot)) {
        return slot
      }
    }

    return items.length > 0
      ? Math.max(...items.map(item => item.slot)) + 1
      : 9
  }

  private isSingletonInventoryItem(itemName: string): boolean {
    const normalized = stripNamespace(itemName)
    return normalized.includes('pickaxe')
      || normalized.includes('axe')
      || normalized.includes('shovel')
      || normalized.includes('sword')
      || normalized.includes('hoe')
      || normalized === 'shield'
      || normalized === 'bow'
      || normalized === 'crossbow'
      || normalized === 'flint_and_steel'
      || normalized === 'bucket'
      || normalized === 'water_bucket'
      || normalized === 'lava_bucket'
  }

  private resolveInventoryItemsWithRecentCraftGuard(
    items: InventoryItem[],
    source: string,
    options?: {
      confirmedOnly?: boolean
      currentItems?: InventoryItem[]
      updateGuardVisibility?: boolean
    },
  ): InventoryItem[] {
    const currentItems = options?.currentItems ?? this.inventoryItems
    const updateGuardVisibility = options?.updateGuardVisibility ?? true

    if (this.shouldKeepCurrentInventoryForRecentCraft(items, {
      confirmedOnly: options?.confirmedOnly,
      currentItems,
    })) {
      const guards = this.getActiveRecentCraftInventoryGuards({
        confirmedOnly: options?.confirmedOnly,
      })
      this.logger.warn(
        `Keeping cached inventory because ${source} regressed a recently crafted item.`,
        {
          craftedItems: guards.map(guard => ({
            itemName: guard.itemName,
            cachedCount: countInventoryItems(currentItems, guard.itemName),
            refreshedCount: countInventoryItems(items, guard.itemName),
            minCount: guard.minCount,
          })),
        },
      )
      return this.applyRecentCraftGuardsToItems(currentItems, {
        confirmedOnly: options?.confirmedOnly,
      })
    }

    if (updateGuardVisibility) {
      this.clearRecentCraftInventoryGuardIfSatisfied(items)
    }
    return items.map(item => ({ ...item }))
  }

  private shouldKeepCurrentInventoryForRecentCraft(
    refreshedItems: InventoryItem[],
    options?: {
      confirmedOnly?: boolean
      currentItems?: InventoryItem[]
    },
  ): boolean {
    const guards = this.getActiveRecentCraftInventoryGuards({
      confirmedOnly: options?.confirmedOnly,
    })
    if (guards.length <= 0) {
      return false
    }

    const currentItems = options?.currentItems ?? this.inventoryItems
    return guards.some((guard) => {
      const refreshedCount = countInventoryItems(refreshedItems, guard.itemName)
      const cachedCount = countInventoryItems(currentItems, guard.itemName)

      // NOTICE: The bridge can briefly return an older inventory snapshot after a successful craft.
      // Preserve the known-good post-craft inventory long enough for getInventory to catch up.
      return cachedCount >= guard.minCount && refreshedCount < guard.minCount
    })
  }

  private clearRecentCraftInventoryGuardIfSatisfied(items: InventoryItem[]): void {
    const now = Date.now()
    for (const [key, guard] of this.recentCraftInventoryGuards.entries()) {
      if (guard.minCount <= 0 || now > guard.expiresAt) {
        this.recentCraftInventoryGuards.delete(key)
        continue
      }

      if (countInventoryItems(items, guard.itemName) >= guard.minCount) {
        const nextConfirmedVisibleSnapshots = guard.confirmedVisibleSnapshots + 1
        if (!guard.stickyUntilExpiry && nextConfirmedVisibleSnapshots >= 2) {
          this.recentCraftInventoryGuards.delete(key)
          continue
        }

        this.recentCraftInventoryGuards.set(key, {
          ...guard,
          confirmedVisibleSnapshots: nextConfirmedVisibleSnapshots,
        })
        continue
      }

      if (guard.confirmedVisibleSnapshots > 0) {
        this.recentCraftInventoryGuards.set(key, {
          ...guard,
          confirmedVisibleSnapshots: 0,
        })
      }
    }
  }

  // ─── Item Usage Methods ─────────────────────────────────────────────────

  async useItem(hand?: 'main' | 'off'): Promise<{ item: string }> {
    return await this.ws.request<{ item: string }>('useItem', { hand: hand ?? 'main' })
  }

  async useItemOnBlock(pos: { x: number, y: number, z: number }, face?: string, hand?: 'main' | 'off'): Promise<void> {
    await this.ws.request('useItemOnBlock', {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
      face: face ?? 'UP',
      hand: hand ?? 'main',
    })
  }

  async startUseItem(hand?: 'main' | 'off'): Promise<void> {
    await this.ws.request('startUseItem', { hand: hand ?? 'main' })
  }

  async stopUseItem(): Promise<void> {
    await this.ws.request('stopUseItem', {})
  }

  async lookAtPosition(x: number, y: number, z: number): Promise<void> {
    await this.ws.request('lookAt', { x, y, z })
  }

  // ─── Combat Methods ─────────────────────────────────────────────────────

  async criticalAttack(entityId: number): Promise<void> {
    await this.ws.request('criticalAttack', { entityId })
  }

  async shieldBlock(active: boolean): Promise<void> {
    await this.ws.request('shieldBlock', { active })
  }

  // ─── Eye of Ender ───────────────────────────────────────────────────────

  async throwEyeOfEnder(): Promise<{ direction: { x: number, z: number }, startPos: { x: number, y: number, z: number }, endPos: { x: number, y: number, z: number } }> {
    return await this.ws.request('throwEyeOfEnder', {}, 10000)
  }

  // ─── Brewing & Enchanting ──────────────────────────────────────────────

  async brew(pos: { x: number, y: number, z: number }, ingredient: string, fuel?: string, bottles?: string[]): Promise<void> {
    await this.ws.request('brew', {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
      ingredient,
      ...(fuel ? { fuel } : {}),
      ...(bottles ? { bottles } : {}),
    }, 30000)
  }

  async enchant(pos: { x: number, y: number, z: number }, itemName: string, level: number): Promise<void> {
    await this.ws.request('enchant', {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
      item: itemName,
      level,
    }, 5000)
  }

  // ─── World Methods ────────────────────────────────────────────────────

  async respawn(): Promise<void> {
    await this.ws.request('respawn', {})
  }

  async getDimension(): Promise<string> {
    const result = await this.ws.request<{ dimension: string }>('getDimension', {})
    return result.dimension
  }

  // ─── Block Finding (async over WebSocket) ────────────────────────────────

  /**
   * findBlocks - finds blocks matching criteria.
   * Supports both predicate-based and ID-based matching (mineflayer-compatible).
   *
   * When called with a predicate, scans common block types via WebSocket.
   * When called with numeric IDs, queries the mod directly.
   */
  findBlocks(options: {
    matching: number | number[] | ((block: BotBlock) => boolean)
    maxDistance?: number
    count?: number
  }): Vec3Simple[] {
    // For sync compatibility, return from cache and trigger async scan
    const maxDist = options.maxDistance ?? 64
    const count = options.count ?? 100

    if (typeof options.matching === 'function') {
      // Predicate-based: search block cache
      const predicate = options.matching
      const results: Vec3Simple[] = []
      const pos = this.entity.position

      for (const [, entry] of this.blockCache) {
        const block = this.getCachedBlock(entry.block.position)
        if (!block) {
          continue
        }
        if (predicate(block) && pos.distanceTo(block.position) <= maxDist) {
          results.push(block.position)
          if (results.length >= count)
            break
        }
      }

      // Trigger background scan if cache is sparse
      if (results.length === 0) {
        this.scanNearbyBlocks(maxDist).catch(() => {})
      }

      return results
    }

    // Numeric ID-based: also return from cache, trigger async scan
    // Since we can't easily map IDs to names over WebSocket, return empty and scan
    this.scanNearbyBlocks(maxDist).catch(() => {})
    return []
  }

  /**
   * Async version of findBlocks - actually queries the mod.
   * Use this when you need guaranteed results.
   */
  async findBlocksAsync(options: {
    matching: number | number[] | ((block: BotBlock) => boolean)
    maxDistance?: number
    count?: number
    blockNames?: string[]
  }): Promise<Vec3Simple[]> {
    const maxDist = options.maxDistance ?? 64
    const count = options.count ?? 100

    if (typeof options.matching === 'function') {
      // Scan for common blocks and apply predicate
      await this.scanNearbyBlocks(maxDist)
      const predicate = options.matching
      const results: Vec3Simple[] = []
      const pos = this.entity.position

      for (const [, entry] of this.blockCache) {
        const block = this.getCachedBlock(entry.block.position)
        if (!block) {
          continue
        }
        if (predicate(block) && pos.distanceTo(block.position) <= maxDist) {
          results.push(block.position)
          if (results.length >= count)
            break
        }
      }
      return results
    }

    // Numeric ID matching - query specific blocks
    const matching = Array.isArray(options.matching) ? options.matching : [options.matching]
    const blockNames = options.blockNames || matching.map(String)

    const allPositions: Vec3Simple[] = []
    const foundKeys = new Set<string>()
    const trackedBlockNames = new Set(blockNames.map(stripNamespace))
    for (const name of blockNames) {
      try {
        const blockQueryName = toNamespacedBlockName(String(name))
        const result = await this.ws.request<{ positions: Array<{ x: number, y: number, z: number }> }>('findBlocks', {
          block: blockQueryName,
          maxDistance: Math.min(maxDist, 64),
          count,
        }, FIND_BLOCKS_REQUEST_TIMEOUT_MS)
        for (const p of result.positions || []) {
          const key = `${p.x},${p.y},${p.z}`
          foundKeys.add(key)
          this.cacheBlockAt(new Vec3Simple(p.x, p.y, p.z), blockQueryName)
          allPositions.push(new Vec3Simple(p.x, p.y, p.z))
        }
        if (allPositions.length >= count) {
          break
        }
      }
      catch (error) {
        this.logger.withError(error).warn(`findBlocksAsync skipped stalled query for ${name}`)
      }
    }
    this.evictMissingScannedBlocks(foundKeys, trackedBlockNames, this.entity.position, Math.min(maxDist, 64))
    return allPositions
  }

  /**
   * findBlock (singular) - finds the nearest block matching a predicate.
   * This is the mineflayer-compatible sync version.
   * Returns cached result or null. Triggers async scan for next call.
   */
  findBlock(options: {
    matching: ((block: BotBlock) => boolean) | number | number[]
    maxDistance?: number
    count?: number
  }): BotBlock | null {
    const maxDist = options.maxDistance ?? 64
    const pos = this.entity.position

    if (typeof options.matching === 'function') {
      const predicate = options.matching

      // Search block cache
      let nearest: BotBlock | null = null
      let nearestDist = Infinity

      for (const [, entry] of this.blockCache) {
        const block = this.getCachedBlock(entry.block.position)
        if (!block) {
          continue
        }
        if (predicate(block)) {
          const dist = pos.distanceTo(block.position)
          if (dist <= maxDist && dist < nearestDist) {
            nearest = block
            nearestDist = dist
          }
        }
      }

      // Trigger background scan if nothing found
      if (!nearest) {
        this.scanNearbyBlocks(maxDist).catch(() => {})
      }

      return nearest
    }

    return null
  }

  /**
   * Async version of findBlock - actually queries the mod.
   * Use when you need guaranteed results from gather-wood etc.
   */
  async findBlockAsync(options: {
    matching: ((block: BotBlock) => boolean)
    maxDistance?: number
    blockNames?: string[]
  }): Promise<BotBlock | null> {
    const maxDist = options.maxDistance ?? 64

    // Scan for blocks
    await this.scanNearbyBlocks(maxDist, options.blockNames)

    // Now search cache
    const pos = this.entity.position
    let nearest: BotBlock | null = null
    let nearestDist = Infinity

    for (const [, entry] of this.blockCache) {
      const block = this.getCachedBlock(entry.block.position)
      if (!block) {
        continue
      }
      if (options.matching(block)) {
        const dist = pos.distanceTo(block.position)
        if (dist <= maxDist && dist < nearestDist) {
          nearest = block
          nearestDist = dist
        }
      }
    }

    return nearest
  }

  /**
   * blockAt - returns block at position.
   * Mineflayer's is sync; ours returns from cache or fetches async.
   */
  blockAt(position: Vec3Simple | { x: number, y: number, z: number }): BotBlock | null {
    const cached = this.getCachedBlock(position)
    if (cached) {
      return cached
    }

    // Trigger async fetch for cache population
    this.fetchBlock(position).catch(() => {})
    return null
  }

  /**
   * Async blockAt - guaranteed to return a result (or null for air/error).
   */
  async blockAtAsync(position: Vec3Simple | { x: number, y: number, z: number }): Promise<BotBlock | null> {
    return this.fetchBlock(position)
  }

  nearestEntity(predicate?: (entity: EntityData) => boolean): EntityData | null {
    let nearest: EntityData | null = null
    let minDist = Infinity

    for (const entity of Object.values(this.entities)) {
      if (predicate && !predicate(entity))
        continue
      if (entity.distance < minDist) {
        minDist = entity.distance
        nearest = entity
      }
    }
    return nearest
  }

  async refreshEntities(maxDistance = 32): Promise<void> {
    const result = await this.ws.request<{ entities: EntityData[] }>('getEntities', { maxDistance })
    this.entities = {}
    for (const e of result.entities || []) {
      this.entities[e.id] = {
        ...e,
        position: new Vec3Simple(e.x, e.y, e.z),
      }
    }
  }

  // Compatibility: bot.world.getBiome
  world = {
    getBiome: async (pos: Vec3Simple) => {
      const result = await this.ws.request<{ biome: string }>('getBiome', {
        x: Math.floor(pos.x),
        y: Math.floor(pos.y),
        z: Math.floor(pos.z),
      })
      return result.biome
    },
  }

  // ─── Sync Properties (mineflayer-compatible) ──────────────────────────

  get heldItem(): BotItem | null {
    this.updateCanonicalInventoryState('fabric-bridge:heldItem')
    return this.canonicalInventorySnapshot.heldItem
      ? this.toBotItemFromCanonicalSlot(this.canonicalInventorySnapshot.heldItem)
      : null
  }

  get isRaining(): boolean { return false }
  get thunderState(): number { return 0 }
  get isSleeping(): boolean { return false }

  // ─── tool stub (mineflayer-tool plugin) ──────────────────────────────

  tool = {
    equipForBlock: async (block: unknown) => {
      this.updateCanonicalInventoryState('fabric-bridge:tool.equipForBlock')
      const blockName = typeof block === 'object' && block && 'name' in (block as Record<string, unknown>)
        ? String((block as Record<string, unknown>).name ?? '')
        : ''
      const tryEquipTool = async (item: BotItem, source: 'canonical' | 'tracked'): Promise<boolean> => {
        try {
          await this.equip(item, 'hand')
          return true
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.logger.withFields({
            blockName,
            itemName: item.name,
            source,
            error: message,
          }).warn('Tool auto-equip candidate failed; trying the next available tool')
          return false
        }
      }

      const preferredTool = selectBestToolSlot(this.canonicalInventorySnapshot, blockName)
      if (preferredTool?.itemName) {
        const equipped = await tryEquipTool(this.toBotItemFromCanonicalSlot(preferredTool), 'canonical')
        if (equipped) {
          return
        }
      }

      const preferredKeyword = getPreferredToolKeyword(blockName)
      const tools = this.inventoryItems
        .filter(i =>
          (i.name.includes('pickaxe') || i.name.includes('axe') || i.name.includes('shovel'))
          && matchesPreferredToolKeyword(i.name, preferredKeyword),
        )
        .sort((left, right) => {
          const leftMatches = Number(matchesPreferredToolKeyword(left.name, preferredKeyword))
          const rightMatches = Number(matchesPreferredToolKeyword(right.name, preferredKeyword))
          if (leftMatches !== rightMatches) {
            return rightMatches - leftMatches
          }
          return toolRank(right.name) - toolRank(left.name)
        })
      for (const tool of tools) {
        const equipped = await tryEquipTool(this.toItem(tool), 'tracked')
        if (equipped) {
          return
        }
      }
    },
  }

  // ─── collectBlock stub (mineflayer-collectblock plugin) ──────────────

  collectBlock = {
    collect: async (block: BotBlock | { position: Vec3Simple }) => {
      await this.dig(block)
    },
  }

  // ─── creative stub ───────────────────────────────────────────────────

  creative = {
    setInventorySlot: async (_slot: number, _item: unknown) => {},
  }

  // ─── openContainer stub ──────────────────────────────────────────────

  async openContainer(block: BotBlock | { position: Vec3Simple }): Promise<{ slots: unknown[], close: () => void }> {
    await this.activateBlock(block)
    return { slots: [], close: () => {} }
  }

  async sleep(_bed: BotBlock | { position: Vec3Simple }): Promise<void> {}

  // ─── No-op stubs for compatibility ───────────────────────────────────

  acceptResourcePack(): void {}
  loadPlugin(_plugin: unknown): void {}
  quit(): void {
    this.ws.disconnect()
  }

  setControlState(control: string, state: boolean): void {
    this.ws.send('setControlState', { control, state })
  }

  clearControlStates(): void {
    this.ws.send('stopMovement', {})
  }

  swingArm(_hand?: string): void {}

  // ─── Block Scanning ──────────────────────────────────────────────────

  private scanningInProgress = false

  /**
   * Scan nearby blocks via WebSocket and populate cache.
   */
  async scanNearbyBlocks(maxDistance: number = 32, extraBlockNames?: string[]): Promise<void> {
    if (this.scanningInProgress)
      return
    this.scanningInProgress = true
    try {
      const blockNames = [
        // Wood
        'oak_log',
        'birch_log',
        'spruce_log',
        'jungle_log',
        'acacia_log',
        'dark_oak_log',
        'mangrove_log',
        'cherry_log',
        // Stone
        'stone',
        'cobblestone',
        'dirt',
        'grass_block',
        'sand',
        'gravel',
        // Ores
        'coal_ore',
        'iron_ore',
        'diamond_ore',
        'gold_ore',
        'copper_ore',
        // Functional
        'crafting_table',
        'furnace',
        'chest',
        // Beds
        'white_bed',
        'red_bed',
        'blue_bed',
        'green_bed',
        'yellow_bed',
        'black_bed',
        'orange_bed',
        'cyan_bed',
        'purple_bed',
        'pink_bed',
        'gray_bed',
        'light_gray_bed',
        'brown_bed',
        'lime_bed',
        'light_blue_bed',
        'magenta_bed',
        ...(extraBlockNames || []),
      ]

      const searchDist = Math.min(maxDistance, 64)

      const foundKeys = new Set<string>()
      const trackedBlockNames = new Set(blockNames.map(stripNamespace))

      for (const blockName of blockNames) {
        try {
          const result = await this.ws.request<{ positions: Array<{ x: number, y: number, z: number }> }>('findBlocks', {
            block: blockName.includes(':') ? blockName : `minecraft:${blockName}`,
            maxDistance: searchDist,
            count: 20,
          }, 5000)

          for (const p of result.positions || []) {
            const key = `${p.x},${p.y},${p.z}`
            const fullName = blockName.includes(':') ? blockName : `minecraft:${blockName}`
            foundKeys.add(key)
            this.cacheBlockAt(new Vec3Simple(p.x, p.y, p.z), fullName)
          }
        }
        catch {
          // Some blocks may not exist nearby, that's fine
        }
      }

      this.evictMissingScannedBlocks(foundKeys, trackedBlockNames, this.entity.position, searchDist)

      // Evict old cache entries if too large
      if (this.blockCache.size > 2000) {
        const entries = [...this.blockCache.entries()]
        const toRemove = entries.slice(0, entries.length - 1000)
        for (const [key] of toRemove) {
          this.blockCache.delete(key)
        }
      }
    }
    finally {
      this.scanningInProgress = false
    }
  }

  private async fetchBlock(position: Vec3Simple | { x: number, y: number, z: number }): Promise<BotBlock | null> {
    const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
    try {
      const result = await this.ws.request<BlockData>('blockAt', {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
      }, 5000)

      if (result.isAir) {
        this.cacheBlockAt(new Vec3Simple(
          Math.floor(position.x),
          Math.floor(position.y),
          Math.floor(position.z),
        ), 'air')
        return null
      }

      const block = this.cacheBlockAt(
        new Vec3Simple(result.position.x, result.position.y, result.position.z),
        result.name,
      )
      return block
    }
    catch {
      this.blockCache.delete(key)
      return null
    }
  }

  /**
   * Pre-fetch blocks around a position to populate cache.
   */
  async prefetchBlocks(center: Vec3Simple, radius = 4): Promise<void> {
    const promises: Promise<BotBlock | null>[] = []
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          promises.push(this.fetchBlock(center.offset(dx, dy, dz)))
        }
      }
    }
    await Promise.all(promises)
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private handleEvent(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'state:position': {
        const pos = data as unknown as PositionState
        this.entity.position = new Vec3Simple(pos.x, pos.y, pos.z)
        this.entity.velocity = new Vec3Simple(pos.velocity_x, pos.velocity_y, pos.velocity_z)
        this.entity.yaw = pos.yaw
        this.entity.pitch = pos.pitch
        this.entity.onGround = pos.onGround
        break
      }
      case 'state:health': {
        const h = data as unknown as HealthState
        this.health = h.health
        this.food = h.food
        this.emit('health')
        if (h.health <= 0) {
          this.clearInventoryStateAfterDeath('fabric-state:health-death')
          this.emit('death')
        }
        break
      }
      case 'state:inventory': {
        const inv = data as unknown as InventoryState
        const visibleItems = this.resolveVisibleInventorySnapshot(inv.items, 'state:inventory', {
          currentItems: this.strictRawInventoryItems,
        })
        this.strictRawInventoryItems = visibleItems.map(item => ({ ...item }))
        this.rawInventoryItems = this.resolveInventoryItemsWithRecentCraftGuard(visibleItems, 'state:inventory(raw)', {
          confirmedOnly: true,
          currentItems: this.rawInventoryItems,
          updateGuardVisibility: false,
        })
        this.inventoryItems = this.resolveInventoryItemsWithRecentCraftGuard(visibleItems, 'state:inventory')
        this.armorItems = Array.isArray(inv.armor)
          ? inv.armor.map(item => ({ ...item }))
          : this.armorItems
        this.offhandItem = 'offhand' in inv
          ? (inv.offhand ? { ...inv.offhand } : null)
          : this.offhandItem
        this.selectedSlot = inv.selectedSlot
        this.inventory.selectedSlot = inv.selectedSlot
        this.updateCanonicalInventoryState('fabric-state:inventory-push')
        break
      }
      case 'state:time': {
        const t = data as unknown as TimeState
        this.time.timeOfDay = t.timeOfDay
        this.time.day = t.day
        this.time.isDay = t.isDay
        this.emit('time')
        break
      }
      case 'event:chat': {
        const msg = data as { username?: string, message?: string }
        if (msg.username && msg.message) {
          this.emit('chat', msg.username, msg.message)
        }
        break
      }
      case 'event:death': {
        this.clearInventoryStateAfterDeath('fabric-event:death')
        this.emit('death')
        break
      }
      case 'event:spawn': {
        this.lastNonEmptyInventoryItems = []
        this.lastNonEmptyInventoryObservedAt = 0
        this.consecutiveEmptyInventorySnapshots = 0
        this.blockCache.clear()
        this.emit('spawn')
        break
      }
      case 'event:pathComplete': {
        this.emit('pathComplete')
        break
      }
      case 'event:remoteMovementStopped': {
        this.emit('remoteMovementStopped', data)
        break
      }
      case 'event:dimensionChange': {
        const dimData = data as { from?: string, to?: string }
        if (dimData.from && dimData.to) {
          this.blockCache.clear()
          this.game.dimension = dimData.to
          this.emit('dimensionChange', dimData.from, dimData.to)
        }
        break
      }
      default:
        this.logger.log(`Unknown event: ${type}`)
    }
  }

  private toItem(item: InventoryItem): BotItem {
    return {
      type: 0,
      count: item.count,
      slot: rawSlotToMineflayerSlot(item.slot),
      name: stripNamespace(item.name),
      maxDurability: item.maxDurability,
      durability: item.durability,
    }
  }

  private toBotItemFromCanonicalSlot(slot: {
    count: number
    durability: number | null
    itemName: string | null
    maxDurability: number | null
    mineflayerSlot: number
  }): BotItem {
    const itemName = slot.itemName ?? ''
    return {
      type: itemName ? getItemId(itemName) : 0,
      count: slot.count,
      slot: slot.mineflayerSlot,
      name: itemName,
      maxDurability: slot.maxDurability ?? 0,
      durability: slot.durability ?? 0,
    }
  }

  private buildCanonicalGuardedItems(): InventoryItem[] {
    const guardedItems = this.rawInventoryItems.map(item => ({ ...item }))
    if (guardedItems.length <= 0 || this.inventoryItems.length <= 0) {
      return guardedItems
    }

    const guardedCraftNames = new Set(
      this.getActiveRecentCraftInventoryGuards().map(guard => stripNamespace(guard.itemName).toLowerCase()),
    )
    if (guardedCraftNames.size <= 0) {
      return guardedItems
    }

    const guardedBySlot = new Map(guardedItems.map(item => [item.slot, item] as const))
    for (const trackedItem of this.inventoryItems) {
      const guardedItem = guardedBySlot.get(trackedItem.slot)
      if (!guardedItem) {
        continue
      }

      const guardedName = stripNamespace(guardedItem.name).toLowerCase()
      const trackedName = stripNamespace(trackedItem.name).toLowerCase()
      if (guardedName !== trackedName || !guardedCraftNames.has(trackedName) || trackedItem.count <= guardedItem.count) {
        continue
      }

      guardedItem.count = trackedItem.count
      guardedItem.maxCount = trackedItem.maxCount
      guardedItem.durability = trackedItem.durability
      guardedItem.maxDurability = trackedItem.maxDurability
    }

    return guardedItems
  }

  applyBridgeCapabilitySnapshot(snapshot: {
    supportedCommands?: string[]
    capabilityHash?: string
    sourceKind?: string
  }): void {
    const supportedCommands = Array.isArray(snapshot.supportedCommands)
      ? snapshot.supportedCommands
          .map(command => String(command).trim())
          .filter(Boolean)
      : []
    if (supportedCommands.length > 0) {
      this.supportedBridgeCommands = new Set(supportedCommands)
      for (const command of this.unsupportedBridgeCommands) {
        if (this.supportedBridgeCommands.has(command)) {
          this.unsupportedBridgeCommands.delete(command)
        }
      }
    }
    this.bridgeCapabilitySourceKind = snapshot.sourceKind || 'fabric-bridge:getStatus'
    this.bridgeCapabilitiesUpdatedAt = Date.now()
    this.bridgeCapabilityHash = snapshot.capabilityHash?.trim()
      || buildCapabilityHash(this.supportedBridgeCommands, this.unsupportedBridgeCommands)
  }

  markBridgeCommandUnsupported(command: string, reason: string): void {
    const normalized = String(command).trim()
    if (!normalized) {
      return
    }
    this.unsupportedBridgeCommands.add(normalized)
    this.bridgeCapabilitySourceKind = 'fabric-bridge:session-blocked'
    this.bridgeCapabilitiesUpdatedAt = Date.now()
    this.bridgeCapabilityHash = buildCapabilityHash(this.supportedBridgeCommands, this.unsupportedBridgeCommands)
    this.logger.withFields({
      command: normalized,
      reason,
      capabilityHash: this.bridgeCapabilityHash,
    }).warn('Bridge command marked unsupported for this session')
  }

  getBridgeCapabilitySnapshot(): BridgeCommandCapabilitySnapshot {
    return {
      supportedCommands: [...this.supportedBridgeCommands].sort(),
      unsupportedCommands: [...this.unsupportedBridgeCommands].sort(),
      capabilityHash: this.bridgeCapabilityHash,
      sourceKind: this.bridgeCapabilitySourceKind,
      updatedAt: this.bridgeCapabilitiesUpdatedAt,
    }
  }

  isBridgeCommandSupported(command: string): boolean {
    const normalized = String(command).trim()
    if (!normalized) {
      return false
    }
    if (this.unsupportedBridgeCommands.has(normalized)) {
      return false
    }
    if (this.supportedBridgeCommands.size <= 0) {
      return true
    }
    return this.supportedBridgeCommands.has(normalized)
  }

  private async requestBridgeCommand<T>(
    command: string,
    params: Record<string, unknown> = {},
    timeout?: number,
  ): Promise<T> {
    if (!this.isBridgeCommandSupported(command)) {
      throw new BridgeUnsupportedCommandError(command, 'cached unsupported capability for this session')
    }

    try {
      return await this.ws.request<T>(command, params, timeout)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes(`Unknown command: ${command}`)) {
        this.markBridgeCommandUnsupported(command, message)
        throw new BridgeUnsupportedCommandError(command, message)
      }
      throw error
    }
  }

  private updateCanonicalInventoryState(sourceKind: string): void {
    const canonicalGuardedItems = this.buildCanonicalGuardedItems()
    const selectedRawSlot = Number.isFinite(this.selectedSlot)
      ? Math.max(0, Math.min(8, Math.trunc(this.selectedSlot)))
      : 0
    const trackedHeld = canonicalGuardedItems.find(item => item.slot === selectedRawSlot)
      ?? this.strictRawInventoryItems.find(item => item.slot === selectedRawSlot)
      ?? this.inventoryItems.find(item => item.slot === selectedRawSlot)

    this.canonicalInventorySnapshot = buildCanonicalInventorySnapshot({
      strictItems: this.strictRawInventoryItems,
      guardedItems: canonicalGuardedItems,
      trackedItems: this.inventoryItems,
      selectedSlot: this.selectedSlot,
      armor: this.armorItems,
      offhand: this.offhandItem,
      heldItem: trackedHeld
        ? {
            name: trackedHeld.name,
            count: trackedHeld.count,
            durability: trackedHeld.durability,
            maxDurability: trackedHeld.maxDurability,
          }
        : null,
      sourceKind,
    })
    this.inventory.selectedSlot = this.canonicalInventorySnapshot.selectedSlot
    this.inventory.slots = Array.from({ length: 46 }, () => null)
    for (const slot of this.canonicalInventorySnapshot.slots) {
      if (!slot.itemName) {
        continue
      }
      this.inventory.slots[slot.mineflayerSlot] = this.toBotItemFromCanonicalSlot(slot)
    }
    this.syncSessionResumeSnapshot(sourceKind)
  }

  getCanonicalInventorySnapshot() {
    this.updateCanonicalInventoryState('fabric-bridge:getCanonicalInventorySnapshot')
    return this.canonicalInventorySnapshot
  }

  private vectorToFace(vec: Vec3Simple): string {
    if (vec.y === 1)
      return 'UP'
    if (vec.y === -1)
      return 'DOWN'
    if (vec.x === 1)
      return 'EAST'
    if (vec.x === -1)
      return 'WEST'
    if (vec.z === 1)
      return 'SOUTH'
    if (vec.z === -1)
      return 'NORTH'
    return 'UP'
  }

  invalidateBlock(position: Vec3Simple | { x: number, y: number, z: number }): void {
    const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
    this.blockCache.delete(key)
  }

  private cacheBlockAt(position: Vec3Simple | { x: number, y: number, z: number }, name: string): BotBlock {
    const block = makeBotBlock(name, new Vec3Simple(
      Math.floor(position.x),
      Math.floor(position.y),
      Math.floor(position.z),
    ))
    const key = `${block.position.x},${block.position.y},${block.position.z}`
    this.blockCache.set(key, {
      block,
      updatedAt: Date.now(),
    })
    return block
  }

  private getCachedBlock(position: Vec3Simple | { x: number, y: number, z: number }): BotBlock | null {
    const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
    const entry = this.blockCache.get(key)
    if (!entry) {
      return null
    }

    if (Date.now() - entry.updatedAt > this.blockCacheTtlMs) {
      this.blockCache.delete(key)
      return null
    }

    return entry.block
  }

  private evictMissingScannedBlocks(
    foundKeys: Set<string>,
    trackedBlockNames: Set<string>,
    center: Vec3Simple,
    maxDistance: number,
  ): void {
    for (const [key, entry] of this.blockCache) {
      const block = entry.block
      if (block.position.distanceTo(center) > maxDistance) {
        continue
      }

      if (!trackedBlockNames.has(stripNamespace(block.name))) {
        continue
      }

      if (!foundKeys.has(key)) {
        this.blockCache.delete(key)
      }
    }
  }
}
