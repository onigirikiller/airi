export type MobilityState = 'open' | 'blocked' | 'shaft_trap' | 'submerged'

const SURFACE_ESCAPE_PASSABLE_BLOCKS = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'kelp',
  'kelp_plant',
  'seagrass',
  'tall_seagrass',
])

const SURFACE_ESCAPE_WATERLIKE_BLOCKS = new Set([
  'water',
  'kelp',
  'kelp_plant',
  'seagrass',
  'tall_seagrass',
])

const SURFACE_ESCAPE_SCAFFOLD_PRIORITY = [
  'cobblestone',
  'cobbled_deepslate',
  'dirt',
  'coarse_dirt',
  'netherrack',
  'stone',
  'andesite',
  'diorite',
  'granite',
  'gravel',
  'sand',
]

function normalizeSurfaceRecoveryToken(value: string | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
}

function parseImmediateTerrainMap(immediateTerrain: string[] | undefined): Map<string, string> {
  return new Map(
    (immediateTerrain ?? []).map((entry) => {
      const [label, rawName] = entry.toLowerCase().split(':', 2)
      return [label || 'unknown', normalizeSurfaceRecoveryToken(rawName)]
    }),
  )
}

export function isSurfaceEscapePassable(name: string | undefined): boolean {
  return SURFACE_ESCAPE_PASSABLE_BLOCKS.has(normalizeSurfaceRecoveryToken(name))
}

export function isFullySubmergedImmediateTerrain(immediateTerrain: string[] | undefined): boolean {
  const terrain = parseImmediateTerrainMap(immediateTerrain)
  return ['feet', 'head', 'north', 'south', 'east', 'west']
    .every(label => SURFACE_ESCAPE_WATERLIKE_BLOCKS.has(terrain.get(label) || ''))
}

export function looksLikeVerticalEscapeTrap(immediateTerrain: string[] | undefined): boolean {
  const terrain = parseImmediateTerrainMap(immediateTerrain)
  const blockedWalls = ['north', 'south', 'east', 'west']
    .filter(label => !isSurfaceEscapePassable(terrain.get(label)))
    .length
  const headBlocked = !isSurfaceEscapePassable(terrain.get('head'))

  return blockedWalls >= 3 || (blockedWalls >= 2 && headBlocked)
}

function isGenericSurfaceEscapeScaffold(itemName: string): boolean {
  const normalized = normalizeSurfaceRecoveryToken(itemName)
  return normalized.endsWith('_planks')
    || normalized.endsWith('_log')
    || normalized.endsWith('_wood')
    || normalized.endsWith('_stem')
    || normalized.endsWith('_hyphae')
}

export interface SurfaceEscapeScaffold {
  itemName: string
  count: number
}

export function selectSurfaceEscapeScaffoldFromInventory(
  inventory: Record<string, number>,
): SurfaceEscapeScaffold | null {
  for (const itemName of SURFACE_ESCAPE_SCAFFOLD_PRIORITY) {
    const count = inventory[itemName] ?? 0
    if (count > 0) {
      return { itemName, count }
    }
  }

  const fallback = Object.entries(inventory)
    .filter(([itemName, count]) => count > 0 && isGenericSurfaceEscapeScaffold(itemName))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]
  if (!fallback) {
    return null
  }

  return {
    itemName: fallback[0],
    count: fallback[1],
  }
}

export function describeSurfaceEscapeScaffold(inventory: Record<string, number>): string {
  const scaffold = selectSurfaceEscapeScaffoldFromInventory(inventory)
  if (!scaffold) {
    return 'none'
  }

  const readiness = scaffold.count >= 4 ? 'ready' : 'limited'
  return `${readiness}:${scaffold.itemName} x${scaffold.count}`
}

export function deriveMobilityState(
  terrainContext: string,
  immediateTerrain: string[] | undefined,
): MobilityState {
  if (isFullySubmergedImmediateTerrain(immediateTerrain)) {
    return 'submerged'
  }

  if (terrainContext === 'underground_cave' && looksLikeVerticalEscapeTrap(immediateTerrain)) {
    return 'shaft_trap'
  }

  if (terrainContext === 'underground_cave') {
    return 'blocked'
  }

  return 'open'
}
