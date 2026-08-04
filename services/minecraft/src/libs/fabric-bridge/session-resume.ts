import type { InventoryItem } from './types'

import process from 'node:process'

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface FabricBridgeSessionResumeSnapshot {
  savedAt: number
  items: InventoryItem[]
  armorItems: InventoryItem[]
  offhandItem: InventoryItem | null
  selectedSlot: number
}

const SESSION_RESUME_DIR_ENV = 'MINECRAFT_SESSION_RESUME_DIR'
const SESSION_RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000

function getSessionResumeDir(): string {
  const override = process.env[SESSION_RESUME_DIR_ENV]?.trim()
  if (override) {
    return resolve(override)
  }

  return resolve(process.cwd(), 'runtime', 'session-resume')
}

function sanitizeSessionResumeKey(username: string): string {
  const normalized = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'default'
}

function getSessionResumePath(username: string): string {
  return resolve(getSessionResumeDir(), `${sanitizeSessionResumeKey(username)}.json`)
}

function cloneInventoryItem(item: InventoryItem): InventoryItem {
  return {
    slot: item.slot,
    name: item.name,
    count: item.count,
    maxCount: item.maxCount,
    durability: item.durability,
    maxDurability: item.maxDurability,
    ...(item.nbt ? { nbt: item.nbt } : {}),
  }
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

function isValidInventoryItem(value: unknown): value is InventoryItem {
  if (!value || typeof value !== 'object') {
    return false
  }

  const item = value as Record<string, unknown>
  return isFiniteInteger(item.slot)
    && typeof item.name === 'string'
    && isFiniteInteger(item.count)
    && isFiniteInteger(item.maxCount)
    && isFiniteInteger(item.durability)
    && isFiniteInteger(item.maxDurability)
    && (item.nbt === undefined || typeof item.nbt === 'string')
}

function sanitizeInventoryItems(items: unknown): InventoryItem[] {
  if (!Array.isArray(items)) {
    return []
  }

  return items
    .filter(isValidInventoryItem)
    .map(cloneInventoryItem)
}

function sanitizeSelectedSlot(value: unknown): number {
  if (!isFiniteInteger(value)) {
    return 0
  }

  return Math.max(0, Math.min(8, value))
}

export function loadSessionResumeSnapshot(username: string): FabricBridgeSessionResumeSnapshot | null {
  const path = getSessionResumePath(username)
  if (!existsSync(path)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const savedAt = typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt)
      ? parsed.savedAt
      : 0
    if (savedAt <= 0 || Date.now() - savedAt > SESSION_RESUME_MAX_AGE_MS) {
      clearSessionResumeSnapshot(username)
      return null
    }

    return {
      savedAt,
      items: sanitizeInventoryItems(parsed.items),
      armorItems: sanitizeInventoryItems(parsed.armorItems),
      offhandItem: isValidInventoryItem(parsed.offhandItem) ? cloneInventoryItem(parsed.offhandItem) : null,
      selectedSlot: sanitizeSelectedSlot(parsed.selectedSlot),
    }
  }
  catch {
    clearSessionResumeSnapshot(username)
    return null
  }
}

export function saveSessionResumeSnapshot(username: string, snapshot: FabricBridgeSessionResumeSnapshot): void {
  const path = getSessionResumePath(username)
  mkdirSync(getSessionResumeDir(), { recursive: true })

  const payload: FabricBridgeSessionResumeSnapshot = {
    savedAt: snapshot.savedAt,
    items: snapshot.items.map(cloneInventoryItem),
    armorItems: snapshot.armorItems.map(cloneInventoryItem),
    offhandItem: snapshot.offhandItem ? cloneInventoryItem(snapshot.offhandItem) : null,
    selectedSlot: sanitizeSelectedSlot(snapshot.selectedSlot),
  }

  writeFileSync(path, JSON.stringify(payload), 'utf8')
}

export function clearSessionResumeSnapshot(username: string): void {
  const path = getSessionResumePath(username)
  try {
    if (existsSync(path)) {
      unlinkSync(path)
    }
  }
  catch {
    // noop
  }
}
