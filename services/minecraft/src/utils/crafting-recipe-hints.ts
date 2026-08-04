export interface CraftIngredientRequirement {
  itemName: string
  count: number
}

const TOOL_HEAD_COUNTS: Record<string, number> = {
  axe: 3,
  hoe: 2,
  pickaxe: 3,
  shovel: 1,
  sword: 2,
}

const ARMOR_COUNTS: Record<string, number> = {
  boots: 4,
  chestplate: 8,
  helmet: 5,
  leggings: 7,
}

const TOOL_MATERIALS: Record<string, string> = {
  diamond: 'diamond',
  golden: 'gold_ingot',
  iron: 'iron_ingot',
  stone: 'cobblestone',
  wooden: 'planks',
}

function normalizeItemName(itemName: string): string {
  return itemName.replace(/^minecraft:/, '').trim().toLowerCase()
}

function multiplyRequirements(
  requirements: CraftIngredientRequirement[],
  craftIterations: number,
): CraftIngredientRequirement[] {
  return requirements.map(requirement => ({
    itemName: requirement.itemName,
    count: requirement.count * craftIterations,
  }))
}

export function getFallbackCraftRecipeRequirements(
  outputItemName: string,
  craftIterations = 1,
): CraftIngredientRequirement[] {
  const normalizedOutput = normalizeItemName(outputItemName)
  const normalizedCraftIterations = Math.max(1, Math.floor(craftIterations))

  if (normalizedOutput.endsWith('_planks')) {
    const woodType = normalizedOutput.slice(0, -'_planks'.length)
    return multiplyRequirements([{ itemName: `${woodType}_log`, count: 1 }], normalizedCraftIterations)
  }

  if (normalizedOutput === 'stick') {
    return multiplyRequirements([{ itemName: 'planks', count: 2 }], normalizedCraftIterations)
  }

  if (normalizedOutput === 'crafting_table') {
    return multiplyRequirements([{ itemName: 'planks', count: 4 }], normalizedCraftIterations)
  }

  if (normalizedOutput === 'torch') {
    return multiplyRequirements([
      { itemName: 'coal', count: 1 },
      { itemName: 'stick', count: 1 },
    ], normalizedCraftIterations)
  }

  if (normalizedOutput === 'chest') {
    return multiplyRequirements([{ itemName: 'planks', count: 8 }], normalizedCraftIterations)
  }

  if (normalizedOutput === 'furnace') {
    return multiplyRequirements([{ itemName: 'cobblestone', count: 8 }], normalizedCraftIterations)
  }

  if (normalizedOutput === 'bucket') {
    return multiplyRequirements([{ itemName: 'iron_ingot', count: 3 }], normalizedCraftIterations)
  }

  if (normalizedOutput === 'shield') {
    return multiplyRequirements([
      { itemName: 'planks', count: 6 },
      { itemName: 'iron_ingot', count: 1 },
    ], normalizedCraftIterations)
  }

  const toolMatch = normalizedOutput.match(/^(wooden|stone|iron|golden|diamond)_(axe|hoe|pickaxe|shovel|sword)$/)
  if (toolMatch) {
    const [, materialKey, toolType] = toolMatch
    const materialQuery = TOOL_MATERIALS[materialKey]
    const headCount = TOOL_HEAD_COUNTS[toolType]
    if (materialQuery && headCount) {
      return multiplyRequirements([
        { itemName: materialQuery, count: headCount },
        { itemName: 'stick', count: 2 },
      ], normalizedCraftIterations)
    }
  }

  const armorMatch = normalizedOutput.match(/^(iron|golden|diamond)_(boots|chestplate|helmet|leggings)$/)
  if (armorMatch) {
    const [, materialKey, armorType] = armorMatch
    const materialQuery = TOOL_MATERIALS[materialKey]
    const armorCount = ARMOR_COUNTS[armorType]
    if (materialQuery && armorCount) {
      return multiplyRequirements([{ itemName: materialQuery, count: armorCount }], normalizedCraftIterations)
    }
  }

  return []
}
