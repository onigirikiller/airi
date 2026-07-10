import type { Block } from 'prismarine-block'

import type { Mineflayer } from '../../libs/mineflayer'

import pathfinder from 'mineflayer-pathfinder'

import { abortableSleep, ActionAbortedError, raceWithAbort, throwIfAborted } from '../../libs/mineflayer/action-abort'
import { useLogger } from '../../utils/logger'
import { getBlockTool } from '../../utils/mcdata'
import { normalizeQueryToken, resolveBlockQueryTypes } from '../../utils/query-normalizer'
import { getBlockAtAccurate, getMiningExposureKindAccurate, getNearestBlocksAccurate, invalidateBlockCache } from '../block-access'
import { breakBlockAt } from '../blocks'
import { goToPosition } from '../movement'
import { ensurePickaxe } from './ensure'
import { pickupNearbyItems } from './world-interactions'

const logger = useLogger()
const MAX_CONSECUTIVE_GOAL_CHANGED = 6
const MAX_CONSECUTIVE_COLLECTION_FAILURES = 4
const MAX_TARGET_ATTEMPTS_PER_CALL = 14
const MAX_DIG_TIMEOUTS_PER_CALL = 4
const EXPOSED_BLOCK_SCAN_LIMIT = 48
const AVOIDED_TARGET_TTL_MS = 90_000
const DIRECT_MINING_PROBE_DISTANCE = 4.5
const SHALLOW_STONE_PROBE_DISTANCE = 12
const SHALLOW_STONE_MAX_VERTICAL_DROP = 5
const SHALLOW_STONE_MAX_VERTICAL_RISE = 1
const SHALLOW_STONE_MAX_COVER_BLOCKS = 5
const SHALLOW_STONE_PROBE_SCAN_LIMIT = 48
const avoidedCollectTargets = new Map<string, number>()
interface ExposureCandidate { block: Block, exposureKind: 'air' | 'fluid' }
interface ShallowStoneProbeCandidate {
  block: Block
  coverBlocks: Block[]
  horizontalDistance: number
  verticalDelta: number
}
interface CollectCandidate {
  block: Block
  prepareBeforeMining?: () => Promise<void>
}

function blockMatchesAnyType(blockName: string, expectedTypes: string[]): boolean {
  const normalized = blockName.startsWith('minecraft:') ? blockName.slice('minecraft:'.length) : blockName
  return expectedTypes.some(type =>
    normalized === type
    || normalized.includes(type)
    || blockName === `minecraft:${type}`,
  )
}

function requiresExposedMiningCandidate(blockName: string): boolean {
  const normalized = blockName.replace(/^minecraft:/, '')
  return normalized.includes('ore') || normalized.includes('stone')
}

function isMessagable(err: unknown): err is { message: string } {
  return (err instanceof Error || (typeof err === 'object' && !!err && 'message' in err && typeof err.message === 'string'))
}

function isGoalChangedError(err: unknown): boolean {
  if (!isMessagable(err)) {
    return String(err).includes('GoalChanged')
  }
  return err.message.includes('GoalChanged')
}

function isDiggingTimeoutError(err: unknown): boolean {
  if (!isMessagable(err)) {
    return String(err).includes('Digging timed out')
  }
  return err.message.includes('Digging timed out')
}

function getHeldToolName(mineflayer: Mineflayer): string {
  return mineflayer.bot.heldItem?.name ?? ''
}

function getPickaxeTier(toolName: string): number {
  if (toolName.includes('netherite_pickaxe'))
    return 5
  if (toolName.includes('diamond_pickaxe'))
    return 4
  if (toolName.includes('iron_pickaxe'))
    return 3
  if (toolName.includes('stone_pickaxe'))
    return 2
  if (toolName.includes('wooden_pickaxe') || toolName.includes('golden_pickaxe'))
    return 1
  return 0
}

function requiredPickaxeTierForBlock(blockName: string): number {
  const normalized = blockName.replace(/^minecraft:/, '')
  if (normalized === 'obsidian')
    return 4
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
  if (
    normalized === 'stone'
    || normalized === 'cobblestone'
    || normalized.includes('coal_ore')
  ) {
    return 1
  }
  return 0
}

function canHarvestWithExplicitRules(mineflayer: Mineflayer, blockName: string): boolean {
  const requiredTier = requiredPickaxeTierForBlock(blockName)
  if (requiredTier <= 0) {
    return true
  }

  const heldToolName = getHeldToolName(mineflayer)
  return getPickaxeTier(heldToolName) >= requiredTier
}

function getBestInventoryPickaxeTier(mineflayer: Mineflayer): number {
  return mineflayer.bot.inventory
    .items()
    .reduce((bestTier, item) => Math.max(bestTier, getPickaxeTier(item.name)), 0)
}

function hasRequiredInventoryTool(mineflayer: Mineflayer, blockName: string): boolean {
  const requiredTier = requiredPickaxeTierForBlock(blockName)
  if (requiredTier <= 0) {
    return true
  }

  return getBestInventoryPickaxeTier(mineflayer) >= requiredTier
}

function blockNeedsPickaxe(blockName: string): boolean {
  return requiredPickaxeTierForBlock(blockName) > 0
    || (getBlockTool(blockName.replace(/^minecraft:/, ''))?.includes('pickaxe') ?? false)
}

function blockPositionKey(position: { x: number, y: number, z: number }): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function distanceTo(origin: { x: number, y: number, z: number }, target: { x: number, y: number, z: number }): number {
  const dx = origin.x - target.x
  const dy = origin.y - target.y
  const dz = origin.z - target.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function horizontalDistanceTo(origin: { x: number, z: number }, target: { x: number, z: number }): number {
  const dx = origin.x - target.x
  const dz = origin.z - target.z
  return Math.sqrt(dx * dx + dz * dz)
}

function getBotPosition(mineflayer: Mineflayer): { x: number, y: number, z: number } {
  return mineflayer.bot.entity?.position ?? { x: 0, y: 0, z: 0 }
}

function stripNamespace(name: string): string {
  return name.replace(/^minecraft:/, '')
}

function isAirLikeBlockName(name: string | null | undefined): boolean {
  const normalized = stripNamespace(name ?? '')
  return normalized === 'air' || normalized === 'cave_air' || normalized === 'void_air'
}

function isShallowStoneBlockName(name: string): boolean {
  const normalized = stripNamespace(name)
  return normalized === 'stone' || normalized === 'cobblestone'
}

function isStoneCollectionTarget(blockTypes: string[]): boolean {
  return blockTypes.length > 0 && blockTypes.every(isShallowStoneBlockName)
}

function isClearableSurfaceCoverBlock(block: Block | null): boolean {
  if (!block || isAirLikeBlockName(block.name)) {
    return false
  }

  const normalized = stripNamespace(block.name)
  return [
    'clay',
    'coarse_dirt',
    'dirt',
    'grass_block',
    'gravel',
    'podzol',
    'rooted_dirt',
    'sand',
    'snow_block',
  ].includes(normalized)
}

function pruneAvoidedCollectTargets(now = Date.now()): void {
  for (const [key, expiresAt] of avoidedCollectTargets) {
    if (expiresAt <= now) {
      avoidedCollectTargets.delete(key)
    }
  }
}

function markCollectTargetAvoided(position: { x: number, y: number, z: number }, ttlMs = AVOIDED_TARGET_TTL_MS): void {
  avoidedCollectTargets.set(blockPositionKey(position), Date.now() + ttlMs)
}

function isCollectTargetAvoided(position: { x: number, y: number, z: number }): boolean {
  const expiresAt = avoidedCollectTargets.get(blockPositionKey(position))
  if (!expiresAt) {
    return false
  }
  if (expiresAt <= Date.now()) {
    avoidedCollectTargets.delete(blockPositionKey(position))
    return false
  }
  return true
}

async function getShallowStoneCoverBlocks(mineflayer: Mineflayer, block: Block): Promise<Block[] | null> {
  const coverBlocks: Block[] = []

  for (let offset = 1; offset <= SHALLOW_STONE_MAX_COVER_BLOCKS + 1; offset++) {
    const position = {
      x: block.position.x,
      y: block.position.y + offset,
      z: block.position.z,
    }
    const above = await getBlockAtAccurate(mineflayer, position)
    if (isAirLikeBlockName(above?.name)) {
      return coverBlocks.length > 0 ? coverBlocks.reverse() : null
    }

    if (offset > SHALLOW_STONE_MAX_COVER_BLOCKS || !above || !isClearableSurfaceCoverBlock(above)) {
      return null
    }

    coverBlocks.push(above)
  }

  return null
}

async function findShallowStoneProbeCandidate(
  mineflayer: Mineflayer,
  blocks: Block[],
  blockTypes: string[],
): Promise<ShallowStoneProbeCandidate | null> {
  if (!isStoneCollectionTarget(blockTypes)) {
    return null
  }

  const origin = getBotPosition(mineflayer)
  const nearbyBlocks = blocks.slice(0, SHALLOW_STONE_PROBE_SCAN_LIMIT)
  const candidates = await Promise.all(nearbyBlocks.map(async (block): Promise<ShallowStoneProbeCandidate | null> => {
    if (!isShallowStoneBlockName(block.name) || isCollectTargetAvoided(block.position)) {
      return null
    }

    const verticalDelta = block.position.y - origin.y
    if (verticalDelta > SHALLOW_STONE_MAX_VERTICAL_RISE || verticalDelta < -SHALLOW_STONE_MAX_VERTICAL_DROP) {
      return null
    }

    const horizontalDistance = horizontalDistanceTo(origin, block.position)
    if (horizontalDistance > SHALLOW_STONE_PROBE_DISTANCE) {
      return null
    }

    const coverBlocks = await getShallowStoneCoverBlocks(mineflayer, block)
    if (!coverBlocks || coverBlocks.length === 0) {
      return null
    }

    return {
      block,
      coverBlocks,
      horizontalDistance,
      verticalDelta,
    }
  }))

  return candidates
    .filter((candidate): candidate is ShallowStoneProbeCandidate => candidate !== null)
    .sort((left, right) =>
      (left.coverBlocks.length * 8 + Math.abs(left.verticalDelta) * 2 + left.horizontalDistance)
      - (right.coverBlocks.length * 8 + Math.abs(right.verticalDelta) * 2 + right.horizontalDistance),
    )[0] ?? null
}

async function clearShallowStoneCover(mineflayer: Mineflayer, candidate: ShallowStoneProbeCandidate): Promise<void> {
  for (const coverBlock of candidate.coverBlocks) {
    throwIfAborted(mineflayer.currentActionSignal)
    const currentCover = await getBlockAtAccurate(mineflayer, coverBlock.position)
    if (!currentCover) {
      throw new Error('Shallow stone cover disappeared before mining.')
    }
    if (isAirLikeBlockName(currentCover.name)) {
      continue
    }
    if (!isClearableSurfaceCoverBlock(currentCover)) {
      throw new Error(`Shallow stone cover changed to ${currentCover?.name ?? 'unknown'} before mining.`)
    }

    const cleared = await breakBlockAt(
      mineflayer,
      currentCover.position.x,
      currentCover.position.y,
      currentCover.position.z,
    )
    if (!cleared) {
      throw new Error(`Failed to clear shallow cover ${currentCover.name}.`)
    }
    invalidateBlockCache(mineflayer, currentCover.position)
  }

  invalidateBlockCache(mineflayer, candidate.block.position)
}

export async function collectBlock(
  mineflayer: Mineflayer,
  blockType: string,
  num = 1,
  range = 16,
): Promise<boolean> {
  if (num < 1) {
    logger.log(`Invalid number of blocks to collect: ${num}.`)
    return false
  }

  const normalizedType = normalizeQueryToken(blockType)
  // NOTICE: A cobblestone collection request means "obtain cobblestone" in
  // survival. Natural surface/cave stone drops cobblestone, while literal
  // cobblestone nearby is often temporary bridge/scaffold material and can trap
  // the bot in vertical pathing loops.
  const effectiveBlockType = normalizedType === 'cobblestone' ? 'stone' : normalizedType
  const blockTypes = resolveBlockQueryTypes(effectiveBlockType)

  // Add block variants
  if (
    [
      'coal',
      'diamond',
      'emerald',
      'iron',
      'gold',
      'lapis_lazuli',
      'redstone',
      'copper',
    ].includes(normalizedType)
  ) {
    blockTypes.push(`${normalizedType}_ore`, `deepslate_${normalizedType}_ore`)
  }
  if (normalizedType.endsWith('ore')) {
    blockTypes.push(`deepslate_${normalizedType}`)
  }
  const uniqueBlockTypes = [...new Set(blockTypes)]
  if (blockTypes.length === 0) {
    logger.log(`Invalid block type: ${blockType}.`)
    return false
  }

  let collected = 0
  let consecutiveGoalChanged = 0
  let consecutiveFailures = 0
  let toolRecoveryAttempted = false
  let targetAttempts = 0
  let diggingTimeouts = 0

  while (collected < num) {
    throwIfAborted(mineflayer.currentActionSignal)
    if (targetAttempts >= MAX_TARGET_ATTEMPTS_PER_CALL) {
      logger.withFields({
        blockType,
        targetAttempts,
        threshold: MAX_TARGET_ATTEMPTS_PER_CALL,
      }).warn('Aborting collectBlock due to excessive target attempts in one call')
      break
    }
    pruneAvoidedCollectTargets()
    const needsExposureFiltering = uniqueBlockTypes.some(requiresExposedMiningCandidate)
    const candidateScanLimit = needsExposureFiltering ? EXPOSED_BLOCK_SCAN_LIMIT : 12
    const blocks = await getNearestBlocksAccurate(mineflayer, uniqueBlockTypes, range, candidateScanLimit)
    const exposedCandidates = await Promise.all(blocks.map(async (block): Promise<ExposureCandidate | null> => {
      if (!requiresExposedMiningCandidate(block.name)) {
        return { block, exposureKind: 'air' }
      }

      const exposureKind = await getMiningExposureKindAccurate(mineflayer, block.position)
      return exposureKind === 'sealed' ? null : { block, exposureKind }
    }))
    const rankedCandidates = exposedCandidates
      .filter((entry): entry is ExposureCandidate => entry !== null)
      .filter(entry => !isCollectTargetAvoided(entry.block.position))
    const candidates: CollectCandidate[] = [
      ...rankedCandidates.filter(entry => entry.exposureKind === 'air'),
      ...rankedCandidates.filter(entry => entry.exposureKind === 'fluid'),
    ].map(entry => ({ block: entry.block }))
    const directProbeCandidate = needsExposureFiltering
      ? blocks.find(block =>
          !isCollectTargetAvoided(block.position)
          && distanceTo(getBotPosition(mineflayer), block.position) <= DIRECT_MINING_PROBE_DISTANCE)
      : undefined
    if (candidates.length === 0) {
      if (directProbeCandidate) {
        logger.withFields({
          blockType,
          position: directProbeCandidate.position,
          distance: distanceTo(getBotPosition(mineflayer), directProbeCandidate.position),
        }).warn('No exposed candidate passed filtering, probing the nearby target directly before aborting collection')
        candidates.push({ block: directProbeCandidate })
      }
      else if (needsExposureFiltering) {
        const shallowStoneProbeCandidate = await findShallowStoneProbeCandidate(mineflayer, blocks, uniqueBlockTypes)
        if (shallowStoneProbeCandidate) {
          logger.withFields({
            blockType,
            position: shallowStoneProbeCandidate.block.position,
            coverBlocks: shallowStoneProbeCandidate.coverBlocks.map(block => block.name).join(','),
            horizontalDistance: shallowStoneProbeCandidate.horizontalDistance,
            verticalDelta: shallowStoneProbeCandidate.verticalDelta,
          }).warn('No exposed stone candidate passed filtering, opening a shallow covered stone probe before aborting collection')
          candidates.push({
            block: shallowStoneProbeCandidate.block,
            prepareBeforeMining: () => clearShallowStoneCover(mineflayer, shallowStoneProbeCandidate),
          })
        }
      }
    }

    if (candidates.length === 0) {
      if (blocks.length > 0 && needsExposureFiltering) {
        logger.withFields({
          blockType,
          rawCandidateCount: blocks.length,
          searchRange: range,
        }).log('No exposed collectible blocks remained after filtering buried mining candidates')
      }
      if (collected === 0)
        logger.log(`No ${blockType} nearby to collect.`)
      else logger.log(`No more ${blockType} nearby to collect.`)
      break
    }

    let collectedThisPass = false
    let goalChangedThisPass = false
    let abortedForToolRecovery = false
    let abortedForDigging = false

    for (const candidate of candidates) {
      throwIfAborted(mineflayer.currentActionSignal)
      const block = candidate.block
      targetAttempts++
      if (targetAttempts > MAX_TARGET_ATTEMPTS_PER_CALL) {
        break
      }
      try {
        // Equip appropriate tool
        if (mineflayer.bot.game.gameMode !== 'creative') {
          await mineflayer.bot.tool.equipForBlock(block)
          const itemId = mineflayer.bot.heldItem ? mineflayer.bot.heldItem.type : null
          const canHarvest = typeof block.canHarvest === 'function' ? block.canHarvest(itemId) : true
          const explicitHarvestAllowed = canHarvestWithExplicitRules(mineflayer, block.name)
          const inventoryToolAvailable = hasRequiredInventoryTool(mineflayer, block.name)
          const missingRequiredInventoryTool = blockNeedsPickaxe(block.name) && !inventoryToolAvailable

          if (missingRequiredInventoryTool) {
            logger.log(`Don't have right tools to harvest ${block.name}.`)
            if (toolRecoveryAttempted) {
              throw new Error('Tool recovery already attempted for this collect request.')
            }

            toolRecoveryAttempted = true
            const ensured = await ensurePickaxe(mineflayer)
            if (!ensured) {
              throw new Error('Tool recovery failed: could not ensure pickaxe.')
            }

            await mineflayer.bot.tool.equipForBlock(block)
            const recoveredItemId = mineflayer.bot.heldItem ? mineflayer.bot.heldItem.type : null
            const recoveredCanHarvest = typeof block.canHarvest === 'function'
              ? block.canHarvest(recoveredItemId)
              : true
            const recoveredExplicitHarvestAllowed = canHarvestWithExplicitRules(mineflayer, block.name)
            const recoveredInventoryToolAvailable = hasRequiredInventoryTool(mineflayer, block.name)
            if (!recoveredInventoryToolAvailable) {
              throw new Error(`Tool recovery failed: still cannot harvest ${block.name}.`)
            }
            if (!recoveredCanHarvest || !recoveredExplicitHarvestAllowed) {
              logger.withFields({
                blockName: block.name,
                heldToolName: getHeldToolName(mineflayer),
                bestInventoryPickaxeTier: getBestInventoryPickaxeTier(mineflayer),
              }).warn('Proceeding with block collection because pickaxe recovery succeeded but held-item harvest checks still look stale')
            }
          }
          else if (blockNeedsPickaxe(block.name) && (!canHarvest || !explicitHarvestAllowed) && inventoryToolAvailable) {
            logger.withFields({
              blockName: block.name,
              heldToolName: getHeldToolName(mineflayer),
              bestInventoryPickaxeTier: getBestInventoryPickaxeTier(mineflayer),
            }).warn('Proceeding with block collection because the required pickaxe exists in inventory despite stale held-item harvest checks')
          }
          else if (!canHarvest) {
            logger.log(`Don't have right tools to harvest ${block.name}.`)
            throw new Error('Don\'t have right tools to harvest block.')
          }
        }

        // NOTICE: Ore and wall blocks are mined from an adjacent reachable tile, not by
        // standing inside the target block's coordinates. Using GoalNear keeps cave mining
        // viable when the exposed block is above, beside, or partially embedded in terrain.
        const goal = new pathfinder.goals.GoalNear(
          block.position.x,
          block.position.y,
          block.position.z,
          4,
        )
        const signal = mineflayer.currentActionSignal
        throwIfAborted(signal)
        await raceWithAbort(mineflayer.bot.pathfinder.goto(goal), signal)
        throwIfAborted(signal)

        if (candidate.prepareBeforeMining) {
          await candidate.prepareBeforeMining()
        }

        const resolvedBlock = await getBlockAtAccurate(mineflayer, block.position)
        if (!resolvedBlock || !blockMatchesAnyType(resolvedBlock.name, uniqueBlockTypes)) {
          invalidateBlockCache(mineflayer, block.position)
          markCollectTargetAvoided(block.position)
          throw new Error('Target block disappeared before collection.')
        }

        await mineAndCollect(mineflayer, resolvedBlock)

        collected++
        consecutiveGoalChanged = 0
        consecutiveFailures = 0
        toolRecoveryAttempted = false
        collectedThisPass = true

        if (typeof mineflayer.bot.inventory.emptySlotCount === 'function' && mineflayer.bot.inventory.emptySlotCount() === 0) {
          logger.log('Inventory is full, cannot collect more items.')
          return collected > 0
        }

        break
      }
      catch (err) {
        if (err instanceof ActionAbortedError) {
          throw err
        }
        logger.log(`Failed to collect ${blockType}: ${err}.`)

        if (isMessagable(err) && err.message.startsWith('Tool recovery failed')) {
          logger.withFields({ blockType }).warn('Aborting collectBlock because tool recovery failed')
          abortedForToolRecovery = true
          break
        }

        if (isMessagable(err) && err.message.startsWith('Tool recovery already attempted')) {
          logger.withFields({ blockType }).warn('Aborting collectBlock after repeated unharvestable block detection')
          abortedForToolRecovery = true
          break
        }

        if (isGoalChangedError(err)) {
          goalChangedThisPass = true
          continue
        }

        if (isDiggingTimeoutError(err)) {
          diggingTimeouts++
          markCollectTargetAvoided(block.position)
          if (diggingTimeouts >= MAX_DIG_TIMEOUTS_PER_CALL) {
            logger.withFields({
              blockType,
              diggingTimeouts,
              threshold: MAX_DIG_TIMEOUTS_PER_CALL,
            }).warn('Aborting collectBlock due to repeated digging timeouts')
            abortedForDigging = true
            break
          }
          continue
        }

        if (isMessagable(err) && err.message.includes('Digging aborted')) {
          abortedForDigging = true
          break
        }

        invalidateBlockCache(mineflayer, block.position)
        markCollectTargetAvoided(block.position)
      }
    }

    if (collectedThisPass) {
      continue
    }

    if (abortedForToolRecovery || abortedForDigging) {
      break
    }

    if (goalChangedThisPass) {
      consecutiveGoalChanged++
      logger.withFields({
        blockType,
        consecutiveGoalChanged,
        consecutiveFailures,
      }).warn('GoalChanged detected during collectBlock')

      mineflayer.bot.pathfinder.stop()
      await abortableSleep(200, mineflayer.currentActionSignal)

      if (consecutiveGoalChanged >= MAX_CONSECUTIVE_GOAL_CHANGED) {
        logger.withFields({
          blockType,
          threshold: MAX_CONSECUTIVE_GOAL_CHANGED,
        }).warn('Aborting collectBlock due to repeated GoalChanged errors')
        break
      }
      continue
    }

    consecutiveFailures++
    if (consecutiveFailures >= MAX_CONSECUTIVE_COLLECTION_FAILURES) {
      logger.withFields({
        blockType,
        threshold: MAX_CONSECUTIVE_COLLECTION_FAILURES,
      }).warn('Aborting collectBlock due to repeated collection failures')
      break
    }
  }

  logger.log(`Collected ${collected} ${blockType}(s).`)
  return collected > 0
}

// Helper function to mine a block and collect drops
async function mineAndCollect(mineflayer: Mineflayer, block: Block): Promise<void> {
  throwIfAborted(mineflayer.currentActionSignal)
  // Break the block
  const brokeBlock = await breakBlockAt(mineflayer, block.position.x, block.position.y, block.position.z)
  throwIfAborted(mineflayer.currentActionSignal)
  if (!brokeBlock) {
    throw new Error(`Failed to break ${block.name} at ${block.position.x}, ${block.position.y}, ${block.position.z}.`)
  }
  try {
    await goToPosition(mineflayer, block.position.x, block.position.y, block.position.z, 1)
  }
  catch (error) {
    if (error instanceof ActionAbortedError) {
      throw error
    }
    // best-effort drop pickup reposition only
  }
  await abortableSleep(250, mineflayer.currentActionSignal)
  // Use your existing function to pick up nearby items
  await pickupNearbyItems(mineflayer, 5)
}
