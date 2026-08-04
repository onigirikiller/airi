const FOOD_PRIORITY = [
  'golden_apple',
  'golden_carrot',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_chicken',
  'cooked_rabbit',
  'cooked_salmon',
  'cooked_cod',
  'bread',
  'baked_potato',
  'pumpkin_pie',
  'mushroom_stew',
  'rabbit_stew',
  'beetroot_soup',
  'suspicious_stew',
  'apple',
  'carrot',
  'potato',
  'beetroot',
  'melon_slice',
  'sweet_berries',
  'glow_berries',
  'dried_kelp',
  'cookie',
  'beef',
  'porkchop',
  'mutton',
  'chicken',
  'rabbit',
  'salmon',
  'cod',
] as const

const FOOD_PRIORITY_INDEX = new Map<string, number>(
  FOOD_PRIORITY.map((itemName, index) => [itemName, index]),
)

export function isFoodItemName(itemName: string): boolean {
  const normalized = itemName.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return normalized.startsWith('cooked_') || FOOD_PRIORITY_INDEX.has(normalized)
}

function getFoodPriority(itemName: string): number {
  const normalized = itemName.trim().toLowerCase()
  const explicitPriority = FOOD_PRIORITY_INDEX.get(normalized)
  if (typeof explicitPriority === 'number') {
    return explicitPriority
  }

  if (normalized.startsWith('cooked_')) {
    return FOOD_PRIORITY.length
  }

  return FOOD_PRIORITY.length + 100
}

export function findBestFoodItem<T extends { name: string }>(items: readonly T[]): T | undefined {
  const edibleItems = items.filter(item => isFoodItemName(item.name))
  if (edibleItems.length === 0) {
    return undefined
  }

  return [...edibleItems].sort((left, right) => {
    const priorityDelta = getFoodPriority(left.name) - getFoodPriority(right.name)
    if (priorityDelta !== 0) {
      return priorityDelta
    }

    return left.name.localeCompare(right.name)
  })[0]
}
