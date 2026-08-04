const WOOD_LOG_BLOCKS = [
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'crimson_stem',
  'warped_stem',
] as const

const ORE_BLOCKS = [
  'coal_ore',
  'deepslate_coal_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'copper_ore',
  'deepslate_copper_ore',
  'gold_ore',
  'deepslate_gold_ore',
  'diamond_ore',
  'deepslate_diamond_ore',
  'emerald_ore',
  'deepslate_emerald_ore',
  'lapis_ore',
  'deepslate_lapis_ore',
  'redstone_ore',
  'deepslate_redstone_ore',
  'nether_gold_ore',
  'nether_quartz_ore',
] as const

const FOOD_ANIMAL_ENTITY_TYPES = [
  'cow',
  'pig',
  'sheep',
  'chicken',
  'rabbit',
  'mooshroom',
  'cod',
  'salmon',
  'tropical_fish',
  // NOTICE: Pufferfish is technically edible but poisons the bot, so keep it
  // out of generic food-target queries.
] as const

const PASSIVE_ENTITY_TYPES = [
  ...FOOD_ANIMAL_ENTITY_TYPES,
  'horse',
  'donkey',
  'mule',
  'llama',
  'cat',
  'wolf',
] as const

export function normalizeQueryToken(raw: string): string {
  let normalized = raw.trim().toLowerCase()
  normalized = normalized.replace(/^["'`]+|["'`]+$/g, '')
  normalized = normalized.replace(/\s+/g, '_')
  normalized = normalized.replace(/^_+|_+$/g, '')
  return normalized
}

function normalizeEntityIdentifier(raw: string | undefined): string {
  return normalizeQueryToken(String(raw || '').replace(/^minecraft:/, ''))
}

export function resolveBlockQueryTypes(raw: string): string[] {
  const token = normalizeQueryToken(raw)
  if (!token) {
    return []
  }

  if (token === 'ore' || token === 'ores') {
    return [...ORE_BLOCKS]
  }

  if (token === 'wood' || token === 'log' || token === 'logs' || token === 'tree' || token === 'trees') {
    return [...WOOD_LOG_BLOCKS]
  }

  if (token.endsWith('_wood')) {
    return [token.replace(/_wood$/, '_log')]
  }

  if (token === 'dirt') {
    return ['dirt', 'grass_block']
  }

  if (token === 'cobblestone') {
    // Cobblestone is usually obtained by mining stone with a pickaxe.
    return ['cobblestone', 'stone']
  }

  return [token]
}

export function resolveEntityQueryTypes(raw: string): string[] {
  const token = normalizeQueryToken(raw)
  if (!token) {
    return []
  }

  if (token === 'animal' || token === 'animals') {
    return [...FOOD_ANIMAL_ENTITY_TYPES]
  }

  if (token === 'passive') {
    return [...PASSIVE_ENTITY_TYPES]
  }

  return [token]
}

export function matchesEntityQuery(
  raw: string,
  entity: {
    type?: string
    name?: string
  },
): boolean {
  const candidateTypes = resolveEntityQueryTypes(raw)
  if (candidateTypes.length === 0) {
    return false
  }

  const normalizedType = normalizeEntityIdentifier(entity.type)
  const normalizedName = normalizeEntityIdentifier(entity.name)

  return candidateTypes.some(candidate =>
    normalizedType === candidate
    || normalizedName === candidate,
  )
}
