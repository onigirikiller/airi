import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import type { Recipe } from 'prismarine-recipe'

import type { Mineflayer } from '../libs/mineflayer'
import type { CraftIngredientRequirement } from '../utils/crafting-recipe-hints'

import { getFallbackCraftRecipeRequirements } from '../utils/crafting-recipe-hints'
import { useLogger } from '../utils/logger'
import { getItemIdForBot, getItemName } from '../utils/mcdata'
import { ensureCraftingTable } from './actions/ensure'
import { adjustOptimisticItemCount, confirmItemCount, consumeOptimisticItemsMatchingQuery, getActualItemCount, getBridgeActualItemCount, getItemCount, recordOptimisticItem, refreshInventoryState } from './actions/inventory'
import { getLastPlacedBlockRecord } from './actions/world-interactions'
import { getBlockAtAccurate, getNearestBlockAccurate, getNearestFreeSpaceAccurate, invalidateBlockCache } from './block-access'
import { collectBlock, placeBlock } from './blocks'
import { goToNearestBlock, goToPosition, moveAway } from './movement'
import { getInventoryCounts, getNearestBlock } from './world'

const logger = useLogger()

const LAST_CRAFT_DIAGNOSTIC_KEY = '__lastCraftRecipeDiagnostic'
const LAST_PLACED_CRAFTING_TABLE_KEY = '__lastPlacedCraftingTable'
const LAST_PLACED_FURNACE_KEY = '__lastPlacedFurnace'
const LAST_PLACED_BLOCK_TTL_MS = 15 * 60 * 1000
const RECENT_PLACED_BLOCK_OBSERVER_LAG_MS = 30_000
const MAX_PREFERRED_EXISTING_CRAFTING_TABLE_DISTANCE = 8
const CRAFTING_TABLE_INTERACTION_DISTANCE = 2.5
const FURNACE_INTERACTION_DISTANCE = 2.5
const FURNACE_OPEN_RETRY_ATTEMPTS = 3
const FURNACE_OPEN_RETRY_DELAY_MS = 750
type CraftRecipeCandidate = Recipe | string

export interface CraftRecipeDiagnostic {
  kind: 'inventory_sync_mismatch' | 'craft_exception' | 'invalid_item_name' | 'missing_recipe'
  itemName: string
  inventoryOnly: boolean
  at: number
  details?: string
}

interface CraftRecipeOptions {
  confirmationMinCountOverride?: number
}

function setLastCraftRecipeDiagnostic(
  mineflayer: Mineflayer,
  diagnostic: CraftRecipeDiagnostic | null,
): void {
  ;(mineflayer as any)[LAST_CRAFT_DIAGNOSTIC_KEY] = diagnostic
}

export function getLastCraftRecipeDiagnostic(
  mineflayer: Mineflayer,
): CraftRecipeDiagnostic | null {
  return ((mineflayer as any)[LAST_CRAFT_DIAGNOSTIC_KEY] ?? null) as CraftRecipeDiagnostic | null
}

export function clearLastCraftRecipeDiagnostic(mineflayer: Mineflayer): void {
  setLastCraftRecipeDiagnostic(mineflayer, null)
}

export interface CachedPlacedBlockPosition {
  x: number
  y: number
  z: number
  at: number
}

function setLastPlacedBlock(
  mineflayer: Mineflayer,
  key: string,
  position: { x: number, y: number, z: number } | null,
): void {
  ;(mineflayer as any)[key] = position
    ? { ...position, at: Date.now() }
    : null
}

function getLastPlacedBlock(mineflayer: Mineflayer, key: string): CachedPlacedBlockPosition | null {
  const cached = ((mineflayer as any)[key] ?? null) as CachedPlacedBlockPosition | null
  if (!cached) {
    return null
  }

  if ((Date.now() - cached.at) > LAST_PLACED_BLOCK_TTL_MS) {
    setLastPlacedBlock(mineflayer, key, null)
    return null
  }

  return cached
}

async function resolveCachedPlacedBlock(
  mineflayer: Mineflayer,
  key: string,
  blockName: string,
  options?: { allowApproximateWhenFreshMs?: number },
): Promise<Block | null> {
  const cached = getLastPlacedBlock(mineflayer, key)
  if (!cached) {
    return null
  }

  invalidateBlockCache(mineflayer, cached)
  const block = await getBlockAtAccurate(mineflayer, cached)
  if (block?.name === blockName || block?.name === `minecraft:${blockName}`) {
    return block
  }

  if (
    options?.allowApproximateWhenFreshMs
    && (Date.now() - cached.at) <= options.allowApproximateWhenFreshMs
  ) {
    logger.log(
      `Using cached ${blockName} at (${cached.x}, ${cached.y}, ${cached.z}) before the block scan catches up.`,
    )
    return makeApproximatePlacedBlock(blockName, cached)
  }

  setLastPlacedBlock(mineflayer, key, null)
  return null
}

function setLastPlacedCraftingTable(
  mineflayer: Mineflayer,
  position: { x: number, y: number, z: number } | null,
): void {
  setLastPlacedBlock(mineflayer, LAST_PLACED_CRAFTING_TABLE_KEY, position)
}

export function getLastPlacedCraftingTableRecord(mineflayer: Mineflayer): CachedPlacedBlockPosition | null {
  return getLastPlacedBlock(mineflayer, LAST_PLACED_CRAFTING_TABLE_KEY)
}

function setLastPlacedFurnace(
  mineflayer: Mineflayer,
  position: { x: number, y: number, z: number } | null,
): void {
  setLastPlacedBlock(mineflayer, LAST_PLACED_FURNACE_KEY, position)
}

function isWithinCraftingTableReach(
  mineflayer: Mineflayer,
  craftingTable: Block,
  maxDistance = CRAFTING_TABLE_INTERACTION_DISTANCE,
): boolean {
  return mineflayer.bot.entity.position.distanceTo(craftingTable.position) <= maxDistance
}

function getPortableCraftingTableCount(mineflayer: Mineflayer): number {
  const inventoryCount = mineflayer.bot.inventory
    .items()
    .filter(item => item.name === 'crafting_table')
    .reduce((sum, item) => sum + item.count, 0)

  return Math.max(inventoryCount, getActualItemCount(mineflayer, 'crafting_table'))
}

function shouldPreferPortableCraftingTable(
  mineflayer: Mineflayer,
  craftingTable: Block,
): boolean {
  if (getPortableCraftingTableCount(mineflayer) <= 0) {
    return false
  }

  return mineflayer.bot.entity.position.distanceTo(craftingTable.position)
    > MAX_PREFERRED_EXISTING_CRAFTING_TABLE_DISTANCE
}

async function resolveCachedCraftingTable(mineflayer: Mineflayer): Promise<Block | null> {
  return await resolveCachedPlacedBlock(mineflayer, LAST_PLACED_CRAFTING_TABLE_KEY, 'crafting_table')
}

async function resolveCachedFurnace(
  mineflayer: Mineflayer,
  options?: { allowApproximate?: boolean },
): Promise<Block | null> {
  return await resolveCachedPlacedBlock(
    mineflayer,
    LAST_PLACED_FURNACE_KEY,
    'furnace',
    options?.allowApproximate === false
      ? undefined
      : { allowApproximateWhenFreshMs: RECENT_PLACED_BLOCK_OBSERVER_LAG_MS },
  )
}

async function moveWithinInteractionDistance(
  mineflayer: Mineflayer,
  block: Block,
  maxDistance: number,
): Promise<boolean> {
  if (mineflayer.bot.entity.position.distanceTo(block.position) <= maxDistance) {
    return true
  }

  const reached = await goToPosition(
    mineflayer,
    block.position.x,
    block.position.y,
    block.position.z,
    maxDistance,
  )
  return reached || mineflayer.bot.entity.position.distanceTo(block.position) <= (maxDistance + 0.5)
}

async function refreshNearbyFurnaceTarget(
  mineflayer: Mineflayer,
  currentFurnace: Block,
  options?: { allowApproximate?: boolean },
): Promise<Block | null> {
  const range = Math.max(8, Math.ceil(mineflayer.bot.entity.position.distanceTo(currentFurnace.position) + 2))
  const nearestFurnace = await getNearestBlockAccurate(mineflayer, 'furnace', range)
  if (nearestFurnace) {
    return nearestFurnace
  }

  const allowApproximate = options?.allowApproximate !== false
  return await resolveRecentPlacedFurnace(mineflayer, { allowApproximate })
    ?? await resolveCachedFurnace(mineflayer, { allowApproximate })
}

async function openFurnaceWithRetries(
  mineflayer: Mineflayer,
  furnaceBlock: Block,
): Promise<{ furnaceBlock: Block, furnace: Awaited<ReturnType<Mineflayer['bot']['openFurnace']>> }> {
  let targetFurnace = furnaceBlock
  let lastError: Error | null = null

  for (let attempt = 0; attempt < FURNACE_OPEN_RETRY_ATTEMPTS; attempt++) {
    const reachedFurnace = await moveWithinInteractionDistance(
      mineflayer,
      targetFurnace,
      FURNACE_INTERACTION_DISTANCE,
    )
    if (!reachedFurnace) {
      throw new Error(
        `Failed to reach selected furnace at (${targetFurnace.position.x}, ${targetFurnace.position.y}, ${targetFurnace.position.z}).`,
      )
    }

    await mineflayer.bot.lookAt(targetFurnace.position)

    try {
      const furnace = await mineflayer.bot.openFurnace(targetFurnace)
      return { furnaceBlock: targetFurnace, furnace }
    }
    catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (
        !/furnace screen did not open/i.test(lastError.message)
        || attempt >= (FURNACE_OPEN_RETRY_ATTEMPTS - 1)
      ) {
        break
      }

      logger.log(
        `Furnace screen did not open at (${targetFurnace.position.x}, ${targetFurnace.position.y}, ${targetFurnace.position.z}); refreshing the target and retrying.`,
      )
      const refreshedTarget = await refreshNearbyFurnaceTarget(
        mineflayer,
        targetFurnace,
        { allowApproximate: !isApproximatePlacedBlock(targetFurnace) },
      )
      if (!refreshedTarget && isApproximatePlacedBlock(targetFurnace)) {
        break
      }

      targetFurnace = refreshedTarget ?? targetFurnace
      await new Promise(resolve => setTimeout(resolve, FURNACE_OPEN_RETRY_DELAY_MS))
    }
  }

  throw lastError ?? new Error('Furnace screen did not open')
}

function isInventoryOnlyRecipe(itemName: string): boolean {
  return itemName === 'crafting_table'
    || itemName === 'stick'
    || itemName === 'torch'
    || itemName === 'planks'
    || itemName.endsWith('_planks')
}

function inferOptimisticRecipeResultCount(itemName: string, recipe: CraftRecipeCandidate, num: number): number {
  const explicitResultCount = typeof (recipe as any)?.result?.count === 'number'
    ? Math.max(1, Number((recipe as any).result.count))
    : null
  if (explicitResultCount != null) {
    return explicitResultCount * Math.max(1, num)
  }

  if (itemName === 'stick' || itemName === 'torch' || itemName.endsWith('_planks')) {
    return 4 * Math.max(1, num)
  }

  return Math.max(1, num)
}

function optimisticCraftAliases(itemName: string): string[] {
  // NOTICE: Track optimistic counts on the concrete output item only.
  // Generic queries such as `planks` or `pickaxe` already match these concrete
  // names via substring counting, so storing extra alias entries would double
  // count a single successful craft and leave stale optimistic ingredients behind.
  return [itemName]
}

function consumeOptimisticRecipeIngredients(recipe: CraftRecipeCandidate, num: number): void {
  const craftIterations = Math.max(1, num)
  if (recipe && typeof recipe === 'object' && Array.isArray(recipe.delta)) {
    for (const entry of recipe.delta ?? []) {
      if (entry.count >= 0) {
        continue
      }

      const ingredientName = getItemName(entry.id)
      if (!ingredientName) {
        continue
      }

      adjustOptimisticItemCount(ingredientName, entry.count * craftIterations)
    }
    return
  }

  const fallbackRequirements = getFallbackCraftRecipeRequirements(
    resolveCraftRecipeOutputName(recipe ?? '') ?? '',
    craftIterations,
  )
  for (const requirement of fallbackRequirements) {
    consumeOptimisticItemsMatchingQuery(requirement.itemName, requirement.count)
  }
}

function normalizeCraftRecipeName(name: string): string {
  return name.replace(/^minecraft:/, '').trim().toLowerCase()
}

function resolvePlankRecipeFromWoodItemName(itemName: string): string | null {
  const normalized = normalizeCraftRecipeName(itemName)
  if (normalized.endsWith('_log')) {
    return normalized.replace(/_log$/u, '_planks')
  }
  if (normalized.endsWith('_wood')) {
    return normalized.replace(/_wood$/u, '_planks')
  }
  if (normalized.endsWith('_stem')) {
    return normalized.replace(/_stem$/u, '_planks')
  }
  if (normalized.endsWith('_hyphae')) {
    return normalized.replace(/_hyphae$/u, '_planks')
  }
  return null
}

function resolvePreferredInventoryPlankRecipe(
  mineflayer: Mineflayer,
  itemName: string,
): string {
  const normalized = normalizeCraftRecipeName(itemName)
  if (normalized !== 'oak_planks' && normalized !== 'planks') {
    return normalized
  }

  const inventory = getInventoryCounts(mineflayer)
  if ((inventory.oak_log ?? 0) > 0 || (inventory.oak_wood ?? 0) > 0) {
    return 'oak_planks'
  }

  const preferredVariant = Object.entries(inventory)
    .filter(([candidateName, count]) =>
      count > 0
      && /_log$|_wood$|_stem$|_hyphae$/u.test(candidateName),
    )
    .sort((left, right) => right[1] - left[1])
    .map(([candidateName]) => resolvePlankRecipeFromWoodItemName(candidateName))
    .find((candidate): candidate is string => Boolean(candidate))

  return preferredVariant ?? 'oak_planks'
}

function resolveCraftRecipeOutputName(recipe: CraftRecipeCandidate): string | null {
  if (typeof recipe === 'string') {
    const normalized = normalizeCraftRecipeName(recipe)
    return normalized.length > 0 ? normalized : null
  }

  if (!recipe || typeof recipe !== 'object') {
    return null
  }

  const candidate = recipe as Recipe & {
    output?: string
    id?: number | string
  }
  const result = candidate.result as {
    id?: number | string
    name?: string
  } | undefined

  if (typeof candidate.output === 'string' && candidate.output.length > 0) {
    return normalizeCraftRecipeName(candidate.output)
  }

  if (typeof candidate.id === 'string' && candidate.id.length > 0) {
    return normalizeCraftRecipeName(candidate.id)
  }

  if (typeof candidate.id === 'number' && candidate.id > 0) {
    return normalizeCraftRecipeName(getItemName(candidate.id))
  }

  if (result) {
    if (typeof result.name === 'string' && result.name.length > 0) {
      return normalizeCraftRecipeName(result.name)
    }

    if (typeof result.id === 'string' && result.id.length > 0) {
      return normalizeCraftRecipeName(result.id)
    }

    if (typeof result.id === 'number' && result.id > 0) {
      return normalizeCraftRecipeName(getItemName(result.id))
    }
  }

  return null
}

function countRecipeMissingIngredients(
  mineflayer: Mineflayer,
  recipe: CraftRecipeCandidate,
  num: number,
  options?: {
    allowTrackedInventory?: boolean
  },
): number {
  const inventory = mineflayer.bot.inventory as typeof mineflayer.bot.inventory & {
    count?: (type: number, metadata?: number | null) => number
  }
  const craftIterations = Math.max(1, num)
  let missingIngredients = 0
  if (!recipe || typeof recipe !== 'object' || !Array.isArray(recipe.delta)) {
    const fallbackRequirements = getFallbackCraftRecipeRequirements(
      resolveCraftRecipeOutputName(recipe ?? '') ?? '',
      craftIterations,
    )
    if (fallbackRequirements.length <= 0) {
      return Number.POSITIVE_INFINITY
    }

    for (const requirement of fallbackRequirements) {
      const actualCount = getActualItemCount(mineflayer, requirement.itemName)
      const trackedCount = getItemCount(mineflayer, requirement.itemName)
      const available = options?.allowTrackedInventory
        ? Math.max(actualCount, trackedCount)
        : actualCount

      if (available < requirement.count) {
        missingIngredients += requirement.count - available
      }
    }

    return missingIngredients
  }

  for (const entry of recipe.delta ?? []) {
    if (entry.count >= 0) {
      continue
    }

    const ingredientName = getItemName(entry.id)
    const visibleCount = typeof inventory.count === 'function'
      ? inventory.count(entry.id, entry.metadata)
      : 0
    const actualCount = ingredientName
      ? getActualItemCount(mineflayer, ingredientName)
      : 0
    const trackedCount = ingredientName
      ? getItemCount(mineflayer, ingredientName)
      : 0
    const available = options?.allowTrackedInventory
      ? Math.max(visibleCount, actualCount, trackedCount)
      : Math.max(visibleCount, actualCount)
    const required = Math.abs(entry.count) * craftIterations

    if (available < required) {
      missingIngredients += required - available
    }
  }

  return missingIngredients
}

function selectCraftRecipe(
  mineflayer: Mineflayer,
  itemName: string,
  recipes: CraftRecipeCandidate[] | null,
  num: number,
): CraftRecipeCandidate | null {
  if (!recipes || recipes.length === 0) {
    return null
  }

  const normalizedItemName = normalizeCraftRecipeName(itemName)
  const rankedRecipes = recipes
    .map((recipe, index) => {
      const outputName = resolveCraftRecipeOutputName(recipe)
      return {
        recipe,
        index,
        outputName,
        exactOutputMatch: outputName === normalizedItemName,
        missingVisibleIngredients: countRecipeMissingIngredients(mineflayer, recipe, num, {
          allowTrackedInventory: false,
        }),
        missingTrackedIngredients: countRecipeMissingIngredients(mineflayer, recipe, num, {
          // NOTICE: Non-inventory crafts still require local-visible confirmation after the craft
          // completes. Tracked inventory is only used here to break ties between equivalent recipe
          // variants when FabricBridge has not yet surfaced the exact plank/ingredient subtype in
          // the local snapshot, which otherwise causes arbitrary recipe selection and repeated
          // "Not enough materials" failures despite the correct variant already existing.
          allowTrackedInventory: true,
        }),
      }
    })
    .sort((left, right) => {
      if (left.exactOutputMatch !== right.exactOutputMatch) {
        return left.exactOutputMatch ? -1 : 1
      }
      if (left.missingVisibleIngredients !== right.missingVisibleIngredients) {
        return left.missingVisibleIngredients - right.missingVisibleIngredients
      }
      if (left.missingTrackedIngredients !== right.missingTrackedIngredients) {
        return left.missingTrackedIngredients - right.missingTrackedIngredients
      }
      return left.index - right.index
    })

  const selectedRecipe = rankedRecipes[0]
  if (!selectedRecipe) {
    return null
  }

  if (selectedRecipe.index !== 0 && selectedRecipe.exactOutputMatch) {
    logger.log(
      `Selecting matching recipe candidate for ${itemName}: ${selectedRecipe.outputName}.`,
    )
  }

  return selectedRecipe.recipe
}

function getCraftRecipeRequirements(
  recipe: CraftRecipeCandidate,
  num: number,
): CraftIngredientRequirement[] {
  if (!recipe || typeof recipe !== 'object' || !Array.isArray(recipe.delta)) {
    return getFallbackCraftRecipeRequirements(resolveCraftRecipeOutputName(recipe ?? '') ?? '', num)
  }

  const requirements = new Map<string, number>()
  const craftIterations = Math.max(1, num)

  for (const entry of recipe.delta ?? []) {
    if (entry.count >= 0) {
      continue
    }

    const ingredientName = normalizeCraftRecipeName(getItemName(entry.id))
    if (!ingredientName) {
      continue
    }

    requirements.set(
      ingredientName,
      (requirements.get(ingredientName) ?? 0) + (Math.abs(entry.count) * craftIterations),
    )
  }

  return [...requirements.entries()].map(([itemName, count]) => ({
    itemName,
    count,
  }))
}

export async function getSelectedCraftRecipeRequirements(
  mineflayer: Mineflayer,
  incomingItemName: string,
  num = 1,
  craftingTable: Block | null = null,
): Promise<CraftIngredientRequirement[] | null> {
  let itemName = incomingItemName.replace(' ', '_').toLowerCase()

  if (itemName.endsWith('plank'))
    itemName += 's' // Correct common mistakes

  itemName = resolvePreferredInventoryPlankRecipe(mineflayer, itemName)

  const itemId = getItemIdForBot(mineflayer.bot, itemName)
  if (!itemId || typeof mineflayer.bot.recipesFor !== 'function') {
    return null
  }

  try {
    const recipes = await mineflayer.bot.recipesFor(itemId, null, 1, craftingTable)
    const recipe = selectCraftRecipe(mineflayer, itemName, recipes, num)
    if (!recipe) {
      return null
    }

    const requirements = getCraftRecipeRequirements(recipe, num)
    return requirements.length > 0 ? requirements : null
  }
  catch {
    return null
  }
}

/*
Possible Scenarios:

1. **Successful Craft Without Crafting Table**:
   - The bot attempts to craft the item without a crafting table and succeeds. The function returns `true`.

2. **Crafting Table Nearby**:
   - The bot tries to craft without a crafting table but fails.
   - The bot then checks for a nearby crafting table.
   - If a crafting table is found, the bot moves to it and successfully crafts the item, returning `true`.

3. **No Crafting Table Nearby, Place Crafting Table**:
   - The bot fails to craft without a crafting table and does not find a nearby crafting table.
   - The bot checks inventory for a crafting table, places it at a suitable location, and attempts crafting again.
   - If successful, the function returns `true`. If the bot cannot find a suitable position or fails to craft, it returns `false`.

4. **Insufficient Resources**:
   - At any point, if the bot does not have the required resources to craft the item, it logs an appropriate message and returns `false`.

5. **No Crafting Table and No Suitable Position**:
   - If the bot does not find a crafting table and cannot find a suitable position to place one, it moves away and returns `false`.

6. **Invalid Item Name**:
   - If the provided item name is invalid, the function logs the error and returns `false`.
*/
export async function craftRecipe(
  mineflayer: Mineflayer,
  incomingItemName: string,
  num = 1,
  options?: CraftRecipeOptions,
): Promise<boolean> {
  let itemName = incomingItemName.replace(' ', '_').toLowerCase()

  if (itemName.endsWith('plank'))
    itemName += 's' // Correct common mistakes

  itemName = resolvePreferredInventoryPlankRecipe(mineflayer, itemName)

  if (isInventoryOnlyRecipe(itemName) && num > 1) {
    clearLastCraftRecipeDiagnostic(mineflayer)
    const actualCountBefore = Math.max(
      getActualItemCount(mineflayer, itemName),
      (await getBridgeActualItemCount(mineflayer, itemName)) ?? 0,
    )
    const craftedOutputPerIteration = inferOptimisticRecipeResultCount(itemName, itemName, 1)
    for (let iteration = 0; iteration < num; iteration++) {
      const crafted = await craftRecipe(mineflayer, itemName, 1, {
        confirmationMinCountOverride:
          actualCountBefore + (craftedOutputPerIteration * (iteration + 1)),
      })
      if (!crafted) {
        return false
      }
    }
    return true
  }

  clearLastCraftRecipeDiagnostic(mineflayer)

  const itemId = getItemIdForBot(mineflayer.bot, itemName)
  if (!itemId) {
    logger.log(`Invalid item name: ${itemName}`)
    setLastCraftRecipeDiagnostic(mineflayer, {
      kind: 'invalid_item_name',
      itemName,
      inventoryOnly: isInventoryOnlyRecipe(itemName),
      at: Date.now(),
    })
    return false
  }

  // Helper function to attempt crafting
  async function attemptCraft(
    recipes: CraftRecipeCandidate[] | null,
    craftingTable: Block | null = null,
  ): Promise<boolean> {
    if (recipes && recipes.length > 0) {
      const recipe = selectCraftRecipe(mineflayer, itemName, recipes, num)
      if (!recipe) {
        setLastCraftRecipeDiagnostic(mineflayer, {
          kind: 'missing_recipe',
          itemName,
          inventoryOnly: isInventoryOnlyRecipe(itemName),
          at: Date.now(),
        })
        return false
      }
      const recipeRequirements = getCraftRecipeRequirements(recipe, num)
      if (recipeRequirements.length > 0) {
        logger.log(
          `Craft recipe inputs for ${itemName}: ${
            recipeRequirements
              .map(requirement =>
                `${requirement.itemName}=${requirement.count} `
                + `(actual=${getActualItemCount(mineflayer, requirement.itemName)}, `
                + `tracked=${getItemCount(mineflayer, requirement.itemName)})`)
              .join(', ')
          }`,
        )
      }
      try {
        await refreshInventoryState(mineflayer)
        const countBefore = Math.max(
          getActualItemCount(mineflayer, itemName),
          (await getBridgeActualItemCount(mineflayer, itemName)) ?? 0,
        )
        const optimisticCraftCount = inferOptimisticRecipeResultCount(itemName, recipe, num)
        const inventoryOnlyRecipe = isInventoryOnlyRecipe(itemName)
        await mineflayer.bot.craft(recipe as Recipe, num, craftingTable ?? undefined)
        const observedCountAfterCraft = getActualItemCount(mineflayer, itemName)
        const requiredConfirmedCount = Math.max(
          options?.confirmationMinCountOverride ?? 0,
          observedCountAfterCraft,
          countBefore + optimisticCraftCount,
        )
        const confirmed = await confirmItemCount(
          mineflayer,
          itemName,
          requiredConfirmedCount,
          {
            attempts: inventoryOnlyRecipe ? 12 : 6,
            delayMs: inventoryOnlyRecipe ? 300 : 200,
            refresh: true,
            actualOnly: true,
            localVisibleOnly: true,
            consecutiveSuccessesNeeded: inventoryOnlyRecipe ? 4 : 2,
          },
        )
        if (!confirmed) {
          logger.log(`Craft reported success but inventory did not confirm ${itemName}.`)
          setLastCraftRecipeDiagnostic(mineflayer, {
            kind: 'inventory_sync_mismatch',
            itemName,
            inventoryOnly: inventoryOnlyRecipe,
            at: Date.now(),
          })
          logger.warn(
            `Refusing ${itemName} craft success because crafted outputs must be visible `
            + 'in local inventory before they can be treated as complete.',
          )
          return false
        }
        // NOTICE: FabricBridge can momentarily confirm a craft and then regress on the next
        // inventory refresh. Preserve the confirmed result in the optimistic overlay so higher
        // level runner logic keeps the newly crafted tool/resource across that brief desync.
        const craftedOutputCount = Math.max(optimisticCraftCount, 1)
        const confirmedCount = Math.max(
          countBefore + optimisticCraftCount,
          getActualItemCount(mineflayer, itemName),
          getItemCount(mineflayer, itemName),
        )
        const botWithConfirmedInventoryPin = mineflayer.bot as typeof mineflayer.bot & {
          confirmVisibleInventoryItem?: (itemName: string, minCount: number) => void
        }
        botWithConfirmedInventoryPin.confirmVisibleInventoryItem?.(itemName, confirmedCount)
        consumeOptimisticRecipeIngredients(recipe, num)
        for (const alias of optimisticCraftAliases(itemName)) {
          recordOptimisticItem(alias, confirmedCount)
        }
        clearLastCraftRecipeDiagnostic(mineflayer)
        logger.log(
          `Successfully crafted ${craftedOutputCount} ${itemName}${
            craftedOutputCount !== num ? ` (${num} craft${num === 1 ? '' : 's'})` : ''
          }${
            craftingTable ? ' using crafting table' : ''
          }.`,
        )
        return true
      }
      catch (err) {
        logger.log(`Failed to craft ${itemName}: ${(err as Error).message}`)
        setLastCraftRecipeDiagnostic(mineflayer, {
          kind: 'craft_exception',
          itemName,
          inventoryOnly: isInventoryOnlyRecipe(itemName),
          at: Date.now(),
          details: (err as Error).message,
        })
        return false
      }
    }
    setLastCraftRecipeDiagnostic(mineflayer, {
      kind: 'missing_recipe',
      itemName,
      inventoryOnly: isInventoryOnlyRecipe(itemName),
      at: Date.now(),
    })
    return false
  }

  // Helper function to move to a crafting table and attempt crafting with retry logic
  async function moveToAndCraft(craftingTable: Block): Promise<boolean> {
    logger.log(`Crafting table found, moving to it.`)
    const maxRetries = 3
    let attempts = 0
    let success = false

    while (attempts < maxRetries && !success) {
      try {
        // On retries (attempts > 0) always force-move closer to the crafting table,
        // since the previous attempt likely failed because the player was out of
        // interaction range despite the position tracker thinking otherwise.
        const forceMove = attempts > 0
        if (forceMove || !isWithinCraftingTableReach(mineflayer, craftingTable)) {
          const reachedTable = await goToPosition(
            mineflayer,
            craftingTable.position.x,
            craftingTable.position.y,
            craftingTable.position.z,
            CRAFTING_TABLE_INTERACTION_DISTANCE,
          )

          if (!reachedTable && !isWithinCraftingTableReach(mineflayer, craftingTable)) {
            logger.log(
              `Attempt ${attempts + 1} could not reach crafting table closely enough to interact with it.`,
            )
            attempts++
            continue
          }
        }

        const recipes = await mineflayer.bot.recipesFor(itemId, null, 1, craftingTable)
        success = await attemptCraft(recipes, craftingTable)
      }
      catch (err) {
        logger.log(
          `Attempt ${attempts + 1} to move to crafting table failed: ${
            (err as Error).message
          }`,
        )
      }
      attempts++
    }

    return success
  }

  // Helper function to find and use or place a crafting table
  async function findAndUseCraftingTable(
    craftingTableRange: number,
    options?: {
      allowPlacement?: boolean
    },
  ): Promise<boolean> {
    const cachedCraftingTable = await resolveCachedCraftingTable(mineflayer)
    if (cachedCraftingTable) {
      logger.log(
        `Reusing cached crafting table at (${cachedCraftingTable.position.x}, ${cachedCraftingTable.position.y}, ${cachedCraftingTable.position.z}).`,
      )
      const craftedWithCachedTable = await moveToAndCraft(cachedCraftingTable)
      if (craftedWithCachedTable) {
        return true
      }
      logger.log('Cached crafting table could not be used; falling back to portable crafting-table placement.')
      setLastPlacedCraftingTable(mineflayer, null)
    }

    let craftingTable = await getNearestBlockAccurate(mineflayer, 'crafting_table', craftingTableRange)
    if (craftingTable) {
      if (shouldPreferPortableCraftingTable(mineflayer, craftingTable)) {
        logger.log(
          `Known crafting table at (${craftingTable.position.x}, ${craftingTable.position.y}, ${craftingTable.position.z}) `
          + 'is farther than the nearby placement preference, so placing the carried crafting table instead.',
        )
      }
      else {
        setLastPlacedCraftingTable(mineflayer, craftingTable.position)
        const craftedWithKnownTable = await moveToAndCraft(craftingTable)
        if (craftedWithKnownTable) {
          return true
        }
        logger.log(
          `Existing crafting table at (${craftingTable.position.x}, ${craftingTable.position.y}, ${craftingTable.position.z}) `
          + 'could not be used after movement retries; falling back to portable crafting-table placement.',
        )
        craftingTable = null
      }
    }

    if (!craftingTable || shouldPreferPortableCraftingTable(mineflayer, craftingTable)) {
      craftingTable = null
    }

    if (craftingTable) {
      setLastPlacedCraftingTable(mineflayer, craftingTable.position)
      return await moveToAndCraft(craftingTable)
    }

    if (options?.allowPlacement === false) {
      logger.log(`No nearby crafting table available for preferred crafting-table flow: ${itemName}.`)
      return false
    }

    logger.log('No usable crafting table nearby, attempting to place one.')
    const hasPortableCraftingTable = getPortableCraftingTableCount(mineflayer) > 0
      || await ensureCraftingTable(mineflayer, { requirePortable: true })
    if (!hasPortableCraftingTable) {
      logger.log(`Failed to ensure a portable crafting table to craft ${itemName}.`)
      return false
    }

    await moveAway(mineflayer, 4)
    const pos = await getNearestFreeSpaceAccurate(mineflayer, 1, 10)
    if (pos) {
      // NOTICE: Placement must be resolved after the sidestep. If we reuse the pre-move
      // free-space probe, cave/surface recoveries can leave us placing the table back at a
      // stale underground Y level even though the bot has already climbed into open terrain.
      logger.log(
        `Placing crafting table at position (${pos.x}, ${pos.y}, ${pos.z}).`,
      )
      await placeBlock(mineflayer, 'crafting_table', pos.x, pos.y, pos.z)
      setLastPlacedCraftingTable(mineflayer, pos)
      invalidateBlockCache(mineflayer, pos)
      craftingTable = await getNearestBlockAccurate(mineflayer, 'crafting_table', craftingTableRange)
      if (!craftingTable) {
        const placedTable = await getBlockAtAccurate(mineflayer, pos)
        if (placedTable?.name === 'crafting_table' || placedTable?.name === 'minecraft:crafting_table') {
          logger.log(
            `Using recently placed crafting table at (${pos.x}, ${pos.y}, ${pos.z}) before the nearby block scan catches up.`,
          )
          craftingTable = placedTable
        }
      }
      if (craftingTable) {
        return await moveToAndCraft(craftingTable)
      }
    }
    else {
      logger.log('No suitable position found to place the crafting table.')
      await moveAway(mineflayer, 5)
      return false
    }

    return false
  }

  // Step 1: Try to craft without a crafting table
  logger.log(`Step 1: Try to craft without a crafting table`)
  const recipes = await mineflayer.bot.recipesFor(itemId, null, 1, null)
  if (recipes && (await attemptCraft(recipes))) {
    return true
  }

  if (isInventoryOnlyRecipe(itemName)) {
    logger.log(`Could not craft ${itemName} in inventory (likely missing materials).`)
    logger.log(`Skipping crafting table flow for inventory recipe: ${itemName}.`)
    return false
  }

  // Step 2: Find and use a crafting table
  // Use a wider search range (64) so we can find crafting tables placed earlier
  // even if baritone mining moved the bot far from the placement site.
  logger.log(`Step 2: Find and use a crafting table`)
  const craftingTableRange = 64
  if (await findAndUseCraftingTable(craftingTableRange)) {
    return true
  }

  return false
}

const SMELTABLE_FOODS = [
  'beef',
  'chicken',
  'cod',
  'mutton',
  'porkchop',
  'rabbit',
  'salmon',
  'tropical_fish',
] as const

interface SmeltingFuelPlanEntry {
  item: Item
  itemTypeId: number
  count: number
}

interface SmeltItemOptions {
  allowOccupiedFurnaceFallback?: boolean
}

const SMELT_CHECK_INTERVAL_MS = 10_000
const SMELT_SETTLE_DELAY_MS = 200

function isCharcoalSourceItemName(itemName: string): boolean {
  return itemName.endsWith('_log')
    || itemName.endsWith('_wood')
    || itemName.endsWith('_stem')
    || itemName.endsWith('_hyphae')
}

function isGenericLogItemQuery(itemName: string): boolean {
  return itemName === 'log'
}

function resolveGenericLogSmeltInput(mineflayer: Mineflayer): string | null {
  const matchingItem = mineflayer.bot.inventory
    .items()
    .find(item => isCharcoalSourceItemName((item.name ?? '').replace(/^minecraft:/, '')))

  return matchingItem?.name?.replace(/^minecraft:/, '') ?? null
}

function getFuelBurnCapacity(itemName: string): number {
  if (itemName === 'coal_block') {
    return 80
  }
  if (itemName === 'blaze_rod') {
    return 12
  }
  if (itemName === 'dried_kelp_block') {
    return 20
  }
  if (itemName === 'coal' || itemName === 'charcoal') {
    return 8
  }
  if (
    itemName.endsWith('_planks')
    || itemName.endsWith('_log')
    || itemName.endsWith('_wood')
    || itemName.endsWith('_stem')
    || itemName.endsWith('_hyphae')
    || itemName === 'crafting_table'
    || itemName === 'bamboo_block'
  ) {
    return 1.5
  }
  if (itemName === 'stick' || itemName === 'bamboo') {
    return 0.5
  }
  return 0
}

function resolveInventoryItemTypeId(
  mineflayer: Mineflayer,
  item: Pick<Item, 'name' | 'type'>,
): number | null {
  if (typeof item.type === 'number' && item.type > 0) {
    return item.type
  }

  if (typeof item.name !== 'string' || item.name.length === 0) {
    return null
  }

  return getItemIdForBot(mineflayer.bot, item.name)
}

function getFuelPreference(itemName: string, prioritizeWoodFuel: boolean): number {
  const woodLike = itemName.endsWith('_planks')
    || itemName.endsWith('_log')
    || itemName.endsWith('_wood')
    || itemName.endsWith('_stem')
    || itemName.endsWith('_hyphae')
    || itemName === 'crafting_table'
    || itemName === 'bamboo_block'

  if (prioritizeWoodFuel) {
    if (itemName.endsWith('_planks')) {
      return 0
    }
    if (itemName === 'stick' || itemName === 'bamboo') {
      return 1
    }
    if (woodLike) {
      return 2
    }
    if (itemName === 'charcoal' || itemName === 'coal') {
      return 3
    }
    if (itemName === 'dried_kelp_block') {
      return 4
    }
    if (itemName === 'blaze_rod') {
      return 5
    }
    if (itemName === 'coal_block') {
      return 6
    }
    return 10
  }

  if (itemName === 'coal_block') {
    return 0
  }
  if (itemName === 'coal' || itemName === 'charcoal') {
    return 1
  }
  if (itemName === 'blaze_rod') {
    return 2
  }
  if (itemName === 'dried_kelp_block') {
    return 3
  }
  if (woodLike) {
    return 4
  }
  if (itemName === 'stick' || itemName === 'bamboo') {
    return 5
  }
  return 10
}

function buildSmeltingFuelPlan(
  mineflayer: Mineflayer,
  inputItemName: string,
  requiredSmelts: number,
): SmeltingFuelPlanEntry[] | null {
  if (requiredSmelts <= 0) {
    return []
  }

  const prioritizeWoodFuel = isCharcoalSourceItemName(inputItemName)
  const candidates = mineflayer.bot.inventory.items()
    .map((item) => {
      const availableCount = item.name === inputItemName
        ? Math.max(0, item.count - requiredSmelts)
        : item.count
      const itemTypeId = resolveInventoryItemTypeId(mineflayer, item)
      return {
        item,
        itemTypeId,
        availableCount,
        burnCapacity: getFuelBurnCapacity(item.name),
      }
    })
    .filter(candidate => candidate.availableCount > 0 && candidate.burnCapacity > 0 && candidate.itemTypeId != null)
    .sort((left, right) => {
      const preference = getFuelPreference(left.item.name, prioritizeWoodFuel) - getFuelPreference(right.item.name, prioritizeWoodFuel)
      if (preference !== 0) {
        return preference
      }
      return right.burnCapacity - left.burnCapacity
    })

  const plan: SmeltingFuelPlanEntry[] = []
  let remainingSmelts = requiredSmelts
  for (const candidate of candidates) {
    if (remainingSmelts <= 0) {
      break
    }

    const neededCount = Math.min(
      candidate.availableCount,
      Math.ceil(remainingSmelts / candidate.burnCapacity),
    )
    if (neededCount <= 0) {
      continue
    }

    plan.push({
      item: candidate.item,
      itemTypeId: candidate.itemTypeId!,
      count: neededCount,
    })
    remainingSmelts -= candidate.burnCapacity * neededCount
  }

  if (remainingSmelts > 0) {
    return null
  }

  return plan
}

function getExpectedSmeltOutputName(itemName: string): string | null {
  switch (itemName) {
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
      return isCharcoalSourceItemName(itemName) ? 'charcoal' : null
  }
}

function getFurnaceItemCount(
  item: Item | null,
  options: {
    expectedTypeId?: number | null
    expectedName?: string | null
  },
): number {
  if (!item) {
    return 0
  }

  if (options.expectedTypeId != null && item.type === options.expectedTypeId) {
    return item.count
  }

  const normalizedName = (item.name ?? '').replace(/^minecraft:/, '')
  if (options.expectedName && normalizedName === options.expectedName) {
    return item.count
  }

  return 0
}

function matchesBlockName(block: Block | null, expectedName: string): boolean {
  return block?.name === expectedName || block?.name === `minecraft:${expectedName}`
}

function makeApproximatePlacedBlock(
  blockName: string,
  position: { x: number, y: number, z: number },
): Block {
  // NOTICE: FabricBridge block scans can lag behind successful `place` RPCs.
  // Smelting needs to bind to the exact furnace we just placed even before the
  // block observer catches up, so we create a minimal position-backed block.
  return {
    name: blockName,
    position,
    __approximatePlacedBlock: true,
  } as unknown as Block
}

function isApproximatePlacedBlock(block: Block): boolean {
  return Boolean((block as Block & { __approximatePlacedBlock?: boolean }).__approximatePlacedBlock)
}

async function resolveRecentPlacedFurnace(
  mineflayer: Mineflayer,
  options?: { allowApproximate?: boolean },
): Promise<Block | null> {
  const recentPlacement = getLastPlacedBlockRecord(mineflayer)
  if (!recentPlacement || recentPlacement.type !== 'furnace') {
    return null
  }

  const placedBlock = await getBlockAtAccurate(mineflayer, recentPlacement.position)
  if (matchesBlockName(placedBlock, 'furnace')) {
    setLastPlacedFurnace(mineflayer, recentPlacement.position)
    return placedBlock
  }

  if (options?.allowApproximate === false) {
    return null
  }

  logger.log(
    `Using recently placed furnace at (${recentPlacement.position.x}, ${recentPlacement.position.y}, ${recentPlacement.position.z}) `
    + 'before the nearby block scan catches up.',
  )
  setLastPlacedFurnace(mineflayer, recentPlacement.position)
  return makeApproximatePlacedBlock('furnace', recentPlacement.position)
}

async function closeFurnaceWindow(mineflayer: Mineflayer, furnace: unknown): Promise<void> {
  try {
    await mineflayer.bot.closeWindow(furnace as any)
  }
  catch {
    // NOTICE: Smelting cleanup must stay best-effort. The bridge can already
    // consider the window closed after an interruption, and that should not
    // mask the original failure classification.
  }
}

async function placePortableFurnaceForSmelting(
  mineflayer: Mineflayer,
  searchDistance: number,
): Promise<Block | null> {
  const pos = await getNearestFreeSpaceAccurate(mineflayer, 1, searchDistance)
  if (!pos) {
    logger.log('No suitable position found to place the furnace.')
    return null
  }

  if (!await placeBlock(mineflayer, 'furnace', pos.x, pos.y, pos.z)) {
    return null
  }

  setLastPlacedFurnace(mineflayer, pos)
  return await resolveCachedFurnace(mineflayer)
    ?? await getNearestBlockAccurate(mineflayer, 'furnace', Math.max(8, searchDistance))
    ?? makeApproximatePlacedBlock('furnace', pos)
}

async function cleanupPortableFurnace(mineflayer: Mineflayer, placedFurnace: boolean): Promise<void> {
  if (!placedFurnace) {
    return
  }

  setLastPlacedFurnace(mineflayer, null)
  await collectBlock(mineflayer, 'furnace', 1)
}

export async function smeltItem(
  mineflayer: Mineflayer,
  itemName: string,
  num = 1,
  options?: SmeltItemOptions,
): Promise<boolean> {
  itemName = itemName.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  if (isGenericLogItemQuery(itemName)) {
    const concreteLogItemName = resolveGenericLogSmeltInput(mineflayer)
    if (!concreteLogItemName) {
      logger.log('Cannot smelt generic log because no log-like item is available.')
      return false
    }
    itemName = concreteLogItemName
  }

  if (!itemName.includes('raw') && !SMELTABLE_FOODS.includes(itemName as typeof SMELTABLE_FOODS[number]) && !isCharcoalSourceItemName(itemName)) {
    logger.log(
      `Cannot smelt ${itemName}, must be a raw item, a cookable food, or a log-like block for charcoal.`,
    )
    return false
  } // TODO: allow cobblestone, sand, clay, etc.

  let placedFurnace = false
  let furnaceBlock = await resolveRecentPlacedFurnace(mineflayer)
  if (!furnaceBlock) {
    furnaceBlock = await resolveCachedFurnace(mineflayer)
  }
  if (!furnaceBlock) {
    furnaceBlock = await getNearestBlockAccurate(mineflayer, 'furnace', 32)
  }
  if (!furnaceBlock) {
    // Try to place furnace
    const hasFurnace = getInventoryCounts(mineflayer).furnace > 0
    if (hasFurnace) {
      furnaceBlock = await placePortableFurnaceForSmelting(mineflayer, 32)
      placedFurnace = true
    }
  }
  if (!furnaceBlock) {
    logger.log(`There is no furnace nearby and I have no furnace.`)
    return false
  }

  logger.log('smelting...')
  let openResult: Awaited<ReturnType<typeof openFurnaceWithRetries>> | null = null
  try {
    openResult = await openFurnaceWithRetries(mineflayer, furnaceBlock)
  }
  catch (error) {
    logger.log(error instanceof Error ? error.message : String(error))
    if (!placedFurnace && getInventoryCounts(mineflayer).furnace > 0) {
      logger.log('Selected furnace could not be opened; placing a dedicated furnace for smelting instead.')
      const dedicatedFurnace = await placePortableFurnaceForSmelting(mineflayer, 12)
      if (dedicatedFurnace) {
        placedFurnace = true
        try {
          openResult = await openFurnaceWithRetries(mineflayer, dedicatedFurnace)
        }
        catch (retryError) {
          logger.log(retryError instanceof Error ? retryError.message : String(retryError))
          await cleanupPortableFurnace(mineflayer, placedFurnace)
          return false
        }
      }
      else {
        await cleanupPortableFurnace(mineflayer, placedFurnace)
        return false
      }
    }
    else {
      await cleanupPortableFurnace(mineflayer, placedFurnace)
      return false
    }
  }
  if (!openResult) {
    await cleanupPortableFurnace(mineflayer, placedFurnace)
    return false
  }
  furnaceBlock = openResult.furnaceBlock
  let furnace = openResult.furnace
  const itemId = getItemIdForBot(mineflayer.bot, itemName)
  const outputItemName = getExpectedSmeltOutputName(itemName)
  const outputItemId = outputItemName
    ? getItemIdForBot(mineflayer.bot, outputItemName)
    : null
  // Check if the furnace is already smelting something
  let inputItem = furnace.inputItem()
  while (
    inputItem
    && inputItem.type !== itemId
    && inputItem.count > 0
  ) {
    const busyInputName = getItemName(inputItem.type)
    logger.log(
      `The furnace is currently smelting ${busyInputName}.`,
    )
    await closeFurnaceWindow(mineflayer, furnace)
    if (
      options?.allowOccupiedFurnaceFallback === false
      || placedFurnace
      || getInventoryCounts(mineflayer).furnace <= 0
    ) {
      await cleanupPortableFurnace(mineflayer, placedFurnace)
      return false
    }

    logger.log(
      `Selected furnace is busy with ${busyInputName}; placing a dedicated furnace for ${itemName} instead.`,
    )
    const dedicatedFurnace = await placePortableFurnaceForSmelting(mineflayer, 12)
    if (!dedicatedFurnace) {
      await cleanupPortableFurnace(mineflayer, placedFurnace)
      return false
    }

    placedFurnace = true
    furnaceBlock = dedicatedFurnace

    logger.log('Retrying smelting with a dedicated furnace.')
    try {
      openResult = await openFurnaceWithRetries(mineflayer, furnaceBlock)
    }
    catch (error) {
      logger.log(error instanceof Error ? error.message : String(error))
      await cleanupPortableFurnace(mineflayer, placedFurnace)
      return false
    }
    furnaceBlock = openResult.furnaceBlock
    furnace = openResult.furnace
    inputItem = furnace.inputItem()
  }
  // Check if the bot has enough items to smelt
  const invCounts = getInventoryCounts(mineflayer)
  const existingInputCount = getFurnaceItemCount(inputItem, {
    expectedTypeId: itemId,
    expectedName: itemName,
  })
  const existingOutputCount = getFurnaceItemCount(
    furnace.outputItem(),
    {
      expectedTypeId: outputItemId,
      expectedName: outputItemName,
    },
  )
  const availableInventoryInputCount = Math.max(0, invCounts[itemName] ?? 0)
  const inputToLoadCount = Math.min(
    availableInventoryInputCount,
    Math.max(0, num - existingInputCount),
  )
  const targetCollectCount = existingOutputCount + existingInputCount + inputToLoadCount

  if (targetCollectCount <= 0) {
    logger.log(`I do not have enough ${itemName} to smelt.`)
    await closeFurnaceWindow(mineflayer, furnace)
    await cleanupPortableFurnace(mineflayer, placedFurnace)
    return false
  }

  const existingFuelItem = furnace.fuelItem()
  const existingFuelCapacity = existingFuelItem
    ? getFuelBurnCapacity(getItemName(existingFuelItem.type)) * existingFuelItem.count
    : 0
  const fuelPlan = buildSmeltingFuelPlan(
    mineflayer,
    itemName,
    Math.max(0, (existingInputCount + inputToLoadCount) - existingFuelCapacity),
  )
  if (fuelPlan === null) {
    logger.log(
      `I do not have enough usable furnace fuel to smelt ${existingInputCount + inputToLoadCount} ${itemName}.`,
    )
    await closeFurnaceWindow(mineflayer, furnace)
    await cleanupPortableFurnace(mineflayer, placedFurnace)
    return false
  }
  const remainingFuelPlan = [...fuelPlan]
  // Put the items in the furnace before fuel so same-family wood smelting
  // cannot leave the input slot empty while consuming the only visible stack as fuel.
  if (!itemId) {
    logger.log(`Invalid item name: ${itemName}`)
    await closeFurnaceWindow(mineflayer, furnace)
    await cleanupPortableFurnace(mineflayer, placedFurnace)
    return false
  }
  if (inputToLoadCount > 0) {
    await furnace.putInput(itemId, null, inputToLoadCount)
  }

  const putNextFuelBatch = async (): Promise<boolean> => {
    const nextFuel = remainingFuelPlan.shift()
    if (!nextFuel) {
      return false
    }
    await furnace.putFuel(nextFuel.itemTypeId, null, nextFuel.count)
    logger.log(
      `Added ${nextFuel.count} ${nextFuel.item.name} to furnace fuel.`,
    )
    return true
  }
  if (!furnace.fuelItem() && remainingFuelPlan.length > 0) {
    const addedFuel = await putNextFuelBatch()
    if (!addedFuel) {
      await closeFurnaceWindow(mineflayer, furnace)
      await cleanupPortableFurnace(mineflayer, placedFurnace)
      return false
    }
  }
  // Wait for the items to smelt
  let total = 0
  let idleChecks = 0
  let lastSmeltedTypeId = outputItemId ?? itemId ?? 0
  const collectReadyOutput = async (): Promise<number> => {
    let collectedThisCheck = 0
    while (true) {
      const readyOutput = furnace.outputItem()
      const readyCount = getFurnaceItemCount(readyOutput, {
        expectedTypeId: outputItemId,
        expectedName: outputItemName,
      })
      if (readyCount <= 0) {
        break
      }

      const smeltedItem = await furnace.takeOutput()
      if (!smeltedItem) {
        break
      }

      lastSmeltedTypeId = smeltedItem.type
      total += smeltedItem.count
      collectedThisCheck += smeltedItem.count
      logger.log(
        `Collected ${smeltedItem.count} ${getItemName(smeltedItem.type)} from furnace.`,
      )
      if (typeof (furnace as any).refresh === 'function') {
        await (furnace as any).refresh()
      }
    }

    return collectedThisCheck
  }

  await new Promise(resolve => setTimeout(resolve, SMELT_SETTLE_DELAY_MS))
  await collectReadyOutput()
  while (true) {
    if (total >= targetCollectCount) {
      break
    }

    await new Promise(resolve => setTimeout(resolve, SMELT_CHECK_INTERVAL_MS))
    // Refresh cached slot data for FabricBridge furnace wrapper
    if (typeof (furnace as any).refresh === 'function') {
      await (furnace as any).refresh()
    }
    if (!furnace.fuelItem() && remainingFuelPlan.length > 0) {
      await putNextFuelBatch()
    }
    logger.log('checking...')

    const collectedThisCheck = await collectReadyOutput()
    if (collectedThisCheck > 0) {
      idleChecks = 0
      continue
    }

    const remainingInputCount = getFurnaceItemCount(
      furnace.inputItem(),
      {
        expectedTypeId: itemId,
        expectedName: itemName,
      },
    )
    const pendingOutputCount = getFurnaceItemCount(
      furnace.outputItem(),
      {
        expectedTypeId: outputItemId,
        expectedName: outputItemName,
      },
    )
    if (remainingInputCount <= 0 && pendingOutputCount <= 0) {
      idleChecks++
      if (idleChecks >= 2) {
        break
      }
      continue
    }
  }
  await closeFurnaceWindow(mineflayer, furnace)
  await cleanupPortableFurnace(mineflayer, placedFurnace)
  if (total === 0) {
    logger.log(`Failed to smelt ${itemName}.`)
    return false
  }
  if (total < targetCollectCount) {
    logger.log(
      `Only smelted ${total}/${targetCollectCount} ${getItemName(lastSmeltedTypeId)}.`,
    )
    return false
  }
  logger.log(
    `Successfully smelted ${itemName}, got ${total} ${getItemName(
      lastSmeltedTypeId,
    )}.`,
  )
  return true
}

/**
 * Enchant an item at an enchanting table.
 */
export async function enchantItem(
  mineflayer: Mineflayer,
  itemName: string,
  level: 1 | 2 | 3 = 1,
): Promise<boolean> {
  const bot = mineflayer.bot as any

  // Find enchanting table
  const table = getNearestBlock(mineflayer, 'enchanting_table', 32)
  if (!table) {
    logger.log('No enchanting table found nearby.')
    return false
  }

  // Move to table
  if (bot.entity.position.distanceTo(table.position) > 4) {
    await goToNearestBlock(mineflayer, 'enchanting_table', 3, 32)
  }

  if ('enchant' in bot) {
    try {
      await bot.enchant(table.position, itemName, level)
      logger.log(`Successfully enchanted ${itemName} at level ${level}.`)
      return true
    }
    catch (err) {
      logger.log(`Failed to enchant ${itemName}: ${(err as Error).message}`)
      return false
    }
  }

  logger.log('Enchanting not supported in current bot mode.')
  return false
}

export async function clearNearestFurnace(mineflayer: Mineflayer): Promise<boolean> {
  const furnaceBlock = getNearestBlock(mineflayer, 'furnace', 6)
  if (!furnaceBlock) {
    logger.log(`There is no furnace nearby.`)
    return false
  }

  logger.log('clearing furnace...')
  const furnace = await mineflayer.bot.openFurnace(furnaceBlock)
  logger.log('opened furnace...')
  // Take the items out of the furnace
  let smeltedItem: Item | null = null
  let inputItem: Item | null = null
  let fuelItem: Item | null = null
  if (furnace.outputItem())
    smeltedItem = await furnace.takeOutput()
  if (furnace.inputItem())
    inputItem = await furnace.takeInput()
  if (furnace.fuelItem())
    fuelItem = await furnace.takeFuel()
  logger.log(smeltedItem, inputItem, fuelItem)
  const smeltedName = smeltedItem
    ? `${smeltedItem.count} ${smeltedItem.name}`
    : `0 smelted items`
  const inputName = inputItem
    ? `${inputItem.count} ${inputItem.name}`
    : `0 input items`
  const fuelName = fuelItem
    ? `${fuelItem.count} ${fuelItem.name}`
    : `0 fuel items`
  logger.log(
    `Cleared furnace, received ${smeltedName}, ${inputName}, and ${fuelName}.`,
  )
  await mineflayer.bot.closeWindow(furnace)
  return true
}
