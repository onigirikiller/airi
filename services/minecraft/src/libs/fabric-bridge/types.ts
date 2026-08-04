/**
 * Protocol types for the Fabric Mod ↔ Node.js WebSocket bridge.
 */

// ─── Outgoing Commands (Node.js → Mod) ───────────────────────────────────────

export interface BridgeCommand {
  id: string
  command: string
  params: Record<string, unknown>
}

export interface BridgeResponse {
  type: 'response'
  id: string
  data: Record<string, unknown>
}

export interface BridgeError {
  type: 'error'
  id: string
  error: string
}

// ─── Incoming Events (Mod → Node.js) ─────────────────────────────────────────

export interface BridgeEvent {
  type: string
  data: Record<string, unknown>
}

// ─── State Payloads ──────────────────────────────────────────────────────────

export interface PositionState {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  onGround: boolean
  velocity_x: number
  velocity_y: number
  velocity_z: number
}

export interface HealthState {
  health: number
  maxHealth: number
  food: number
  saturation: number
  armor: number
  isOnFire: boolean
  air: number
  effects: StatusEffect[]
}

export interface StatusEffect {
  id: string
  duration: number
  amplifier: number
}

export interface InventoryItem {
  slot: number
  name: string
  count: number
  maxCount: number
  durability: number
  maxDurability: number
  nbt?: string
}

export interface InventoryState {
  items: InventoryItem[]
  selectedSlot: number
  armor: InventoryItem[]
  offhand?: InventoryItem
}

export interface TimeState {
  timeOfDay: number
  day: number
  isDay: boolean
}

// ─── Entity ──────────────────────────────────────────────────────────────────

export interface EntityData {
  id: number
  type: string
  name: string
  x: number
  y: number
  z: number
  distance: number
  isHostile: boolean
  isPassive: boolean
  isPlayer: boolean
  health?: number
  maxHealth?: number
}

// ─── Block ───────────────────────────────────────────────────────────────────

export interface BlockData {
  name: string
  isAir: boolean
  isSolid: boolean
  position: { x: number, y: number, z: number }
}

// ─── Command Params ──────────────────────────────────────────────────────────

export interface GotoParams {
  x: number
  y: number
  z: number
}

export interface LookParams {
  yaw: number
  pitch: number
}

export interface ControlStateParams {
  control: 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sneak' | 'sprint'
  state: boolean
}

export interface AttackParams {
  entityId: number
}

export interface DigParams {
  x: number
  y: number
  z: number
}

export interface PlaceParams {
  x: number
  y: number
  z: number
  face?: string
}

export interface FindBlocksParams {
  block: string
  maxDistance?: number
  count?: number
}

export interface BlockAtParams {
  x: number
  y: number
  z: number
}

export interface EquipParams {
  item: string
  slot?: string
}

export interface ChatParams {
  message: string
}

// ─── Bridge Config ───────────────────────────────────────────────────────────

export interface FabricBridgeConfig {
  host: string
  port: number
  reconnectInterval?: number
  maxReconnectAttempts?: number
}
