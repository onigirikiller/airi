import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'

import type { Mineflayer } from '../../libs/mineflayer'

import pathfinder from 'mineflayer-pathfinder'

import { sleep } from '@moeru/std'
import { Vec3 } from 'vec3'

import { useLogger } from '../../utils/logger'
import { makeItem } from '../../utils/mcdata'
import { getBlockAtAccurate, getNearestBlockAccurate } from '../block-access'
import { goToPosition } from '../movement'
import { getActualItemCount, getCanonicalInventorySnapshot, refreshInventoryState } from './inventory'

const logger = useLogger()
const MAX_PICKUP_ATTEMPTS = 10
const MAX_PICKUP_NO_PROGRESS_ATTEMPTS = 3
const LAST_PLACED_BLOCK_RECORD_KEY = '__lastPlacedBlockRecord'
const LAST_PLACED_BLOCK_RECORD_TTL_MS = 15_000

export interface LastPlacedBlockRecord {
  type: string
  position: { x: number, y: number, z: number }
  at: number
}

function setLastPlacedBlockRecord(
  mineflayer: Mineflayer,
  type: string,
  position: { x: number, y: number, z: number },
): void {
  ;(mineflayer as any)[LAST_PLACED_BLOCK_RECORD_KEY] = {
    type,
    position,
    at: Date.now(),
  } satisfies LastPlacedBlockRecord
}

export function getLastPlacedBlockRecord(mineflayer: Mineflayer): LastPlacedBlockRecord | null {
  const record = ((mineflayer as any)[LAST_PLACED_BLOCK_RECORD_KEY] ?? null) as LastPlacedBlockRecord | null
  if (!record) {
    return null
  }

  if ((Date.now() - record.at) > LAST_PLACED_BLOCK_RECORD_TTL_MS) {
    ;(mineflayer as any)[LAST_PLACED_BLOCK_RECORD_KEY] = null
    return null
  }

  return record
}

function normalizePlacementItemName(name: string): string {
  return name.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
}

function placementItemMatches(heldItemName: string, blockType: string): boolean {
  const held = normalizePlacementItemName(heldItemName)
  const target = normalizePlacementItemName(blockType)
  return held === target || held.includes(target)
}

function getHeldPlacementItemName(mineflayer: Mineflayer): string {
  const snapshot = getCanonicalInventorySnapshot(mineflayer, 'place-block:held-check')
  return String(snapshot.heldItem?.itemName ?? mineflayer.bot.heldItem?.name ?? '')
}

async function ensureRequestedBlockInHand(
  mineflayer: Mineflayer,
  blockType: string,
): Promise<boolean> {
  let heldItemName = getHeldPlacementItemName(mineflayer)
  if (placementItemMatches(heldItemName, blockType)) {
    return true
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(150)
    await refreshInventoryState(mineflayer).catch(() => false)
    heldItemName = getHeldPlacementItemName(mineflayer)
    if (placementItemMatches(heldItemName, blockType)) {
      return true
    }
  }

  logger.log(
    `Refusing to place ${blockType}: hand still has ${heldItemName || 'empty'} after equip.`,
  )
  return false
}

function isDroppedItemEntity(entity: unknown): boolean {
  if (!entity || typeof entity !== 'object') {
    return false
  }

  const name = String((entity as { name?: unknown }).name ?? '').trim().toLowerCase()
  const type = String((entity as { type?: unknown }).type ?? '').trim().toLowerCase()
  const entityType = String((entity as { entityType?: unknown }).entityType ?? '').trim().toLowerCase()

  if (name !== 'item' && type !== 'minecraft:item' && entityType !== 'minecraft:item') {
    return false
  }

  return !('onGround' in entity) || (entity as { onGround?: unknown }).onGround !== false
}

export async function placeBlock(
  mineflayer: Mineflayer,
  blockType: string,
  x: number,
  y: number,
  z: number,
  placeOn: string = 'bottom',
): Promise<boolean> {
  // if (!gameData.getBlockId(blockType)) {
  //   logger.log(`Invalid block type: ${blockType}.`);
  //   return false;
  // }

  const targetDest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))

  let block = mineflayer.bot.inventory
    .items()
    .find(item => item.name.includes(blockType))
  if (!block && mineflayer.bot.game.gameMode === 'creative') {
    // TODO: Rework
    await mineflayer.bot.creative.setInventorySlot(36, makeItem(blockType, 1)) // 36 is first hotbar slot
    block = mineflayer.bot.inventory.items().find(item => item.name.includes(blockType))
  }
  if (!block) {
    logger.log(`Don't have any ${blockType} to place.`)
    return false
  }

  const targetBlock = await getBlockAtAccurate(mineflayer, targetDest)
  const targetBlockName = targetBlock?.name ?? 'air'
  const targetBlockPosition = targetBlock?.position ?? targetDest

  if (targetBlockName === blockType) {
    logger.log(`${blockType} already at ${targetBlockPosition}.`)
    return false
  }

  const emptyBlocks = [
    'air',
    'water',
    'lava',
    'grass',
    'tall_grass',
    'snow',
    'dead_bush',
    'fern',
  ]
  if (!emptyBlocks.includes(targetBlockName)) {
    logger.log(
      `${targetBlockName} is in the way at ${targetBlockPosition}.`,
    )
    const removed = await breakBlockAt(mineflayer, x, y, z)
    if (!removed) {
      logger.log(
        `Cannot place ${blockType} at ${targetBlockPosition}: block in the way.`,
      )
      return false
    }
    await new Promise(resolve => setTimeout(resolve, 200)) // Wait for block to break
  }

  // Determine the build-off block and face vector
  const dirMap: { [key: string]: Vec3 } = {
    top: new Vec3(0, 1, 0),
    bottom: new Vec3(0, -1, 0),
    north: new Vec3(0, 0, -1),
    south: new Vec3(0, 0, 1),
    east: new Vec3(1, 0, 0),
    west: new Vec3(-1, 0, 0),
  }

  const dirs: Vec3[] = []
  if (placeOn === 'side') {
    dirs.push(dirMap.north, dirMap.south, dirMap.east, dirMap.west)
  }
  else if (dirMap[placeOn]) {
    dirs.push(dirMap[placeOn])
  }
  else {
    dirs.push(dirMap.bottom)
    logger.log(`Unknown placeOn value "${placeOn}". Defaulting to bottom.`)
  }

  // Add remaining directions
  dirs.push(...Object.values(dirMap).filter(d => !dirs.includes(d)))

  let buildOffBlock: Block | null = null
  let faceVec: Vec3 | null = null

  for (const d of dirs) {
    const adjacentBlock = await getBlockAtAccurate(mineflayer, targetDest.plus(d))
    if (adjacentBlock && !emptyBlocks.includes(adjacentBlock.name)) {
      buildOffBlock = adjacentBlock
      faceVec = d.scaled(-1) // Invert direction
      break
    }
  }

  if (!buildOffBlock || !faceVec) {
    logger.log(
      `Cannot place ${blockType} at ${targetBlockPosition}: nothing to place on.`,
    )
    return false
  }

  // Move away if too close
  const pos = mineflayer.bot.entity.position
  const posAbove = pos.offset(0, 1, 0)
  const dontMoveFor = [
    'torch',
    'redstone_torch',
    'redstone',
    'lever',
    'button',
    'rail',
    'detector_rail',
    'powered_rail',
    'activator_rail',
    'tripwire_hook',
    'tripwire',
    'water_bucket',
  ]
  if (
    !dontMoveFor.includes(blockType)
    && (pos.distanceTo(targetBlockPosition) < 1
      || posAbove.distanceTo(targetBlockPosition) < 1)
  ) {
    const goal = new pathfinder.goals.GoalInvert(
      new pathfinder.goals.GoalNear(
        targetBlockPosition.x,
        targetBlockPosition.y,
        targetBlockPosition.z,
        2,
      ),
    )
    // bot.pathfinder.setMovements(new pf.Movements(bot));
    await mineflayer.bot.pathfinder.goto(goal)
  }

  // Move closer if too far
  if (mineflayer.bot.entity.position.distanceTo(targetBlockPosition) > 4.5) {
    await goToPosition(
      mineflayer,
      targetBlockPosition.x,
      targetBlockPosition.y,
      targetBlockPosition.z,
      4,
    )
  }

  const beforeBlockCount = getActualItemCount(mineflayer, blockType)
  await mineflayer.bot.equip(block, 'hand')
  if (!await ensureRequestedBlockInHand(mineflayer, blockType)) {
    return false
  }

  await mineflayer.bot.lookAt(buildOffBlock.position)
  await sleep(500)

  try {
    await mineflayer.bot.placeBlock(buildOffBlock, faceVec)
    await refreshInventoryState(mineflayer).catch(() => false)
    const placedBlock = await getBlockAtAccurate(mineflayer, targetDest).catch(() => null)
    const afterBlockCount = getActualItemCount(mineflayer, blockType)
    const placedRequestedBlock = placedBlock?.name === blockType
    const consumedRequestedBlock = afterBlockCount < beforeBlockCount

    if (!placedRequestedBlock && !consumedRequestedBlock) {
      logger.log(
        `Placement of ${blockType} at ${targetDest} was not confirmed: `
        + `target now has ${placedBlock?.name ?? 'unknown'} and inventory count stayed `
        + `${beforeBlockCount}->${afterBlockCount}.`,
      )
      return false
    }

    setLastPlacedBlockRecord(mineflayer, blockType, {
      x: targetDest.x,
      y: targetDest.y,
      z: targetDest.z,
    })
    logger.log(`Placed ${blockType} at ${targetDest}.`)
    await new Promise(resolve => setTimeout(resolve, 200))
    return true
  }
  catch (err) {
    if (err instanceof Error) {
      logger.log(
        `Failed to place ${blockType} at ${targetDest}: ${err.message}`,
      )
    }
    else {
      logger.log(
        `Failed to place ${blockType} at ${targetDest}: ${String(err)}`,
      )
    }
    return false
  }
}

export async function breakBlockAt(
  mineflayer: Mineflayer,
  x: number,
  y: number,
  z: number,
): Promise<boolean> {
  if (x == null || y == null || z == null) {
    throw new Error('Invalid position to break block at.')
  }
  const blockPos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  const block = await getBlockAtAccurate(mineflayer, blockPos)
  if (!block) {
    logger.log(`No block found at position ${blockPos}.`)
    return false
  }
  if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
    if (mineflayer.bot.entity.position.distanceTo(block.position) > 4.5) {
      await goToPosition(mineflayer, x, y, z)
    }
    if (mineflayer.bot.game.gameMode !== 'creative') {
      await mineflayer.bot.tool.equipForBlock(block)
      const itemId = mineflayer.bot.heldItem ? mineflayer.bot.heldItem.type : null
      if (typeof block.canHarvest === 'function' && !block.canHarvest(itemId)) {
        logger.log(`Don't have right tools to break ${block.name}.`)
        return false
      }
    }
    if (typeof mineflayer.bot.canDigBlock === 'function' && !mineflayer.bot.canDigBlock(block)) {
      logger.log(`Cannot break ${block.name} at ${blockPos}.`)
      return false
    }
    await mineflayer.bot.lookAt(block.position, true) // Ensure the bot has finished turning
    await sleep(500)
    try {
      await mineflayer.bot.dig(block, true)
      logger.log(
        `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(
          1,
        )}, z:${z.toFixed(1)}.`,
      )
      return true
    }
    catch (err) {
      console.error(`Failed to dig the block: ${err}`)
      return false
    }
  }
  else {
    logger.log(
      `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(
        1,
      )} because it is ${block.name}.`,
    )
    return false
  }
}

export async function activateNearestBlock(mineflayer: Mineflayer, type: string) {
  /**
   * Activate the nearest block of the given type.
   * @param {string} type, the type of block to activate.
   * @returns {Promise<boolean>} true if the block was activated, false otherwise.
   * @example
   * await skills.activateNearestBlock( "lever");
   *
   */
  const block = await getNearestBlockAccurate(mineflayer, type, 16)
  if (!block) {
    logger.log(`Could not find any ${type} to activate.`)
    return false
  }
  if (mineflayer.bot.entity.position.distanceTo(block.position) > 4.5) {
    const pos = block.position
    // bot.pathfinder.setMovements(new pf.Movements(bot));
    await mineflayer.bot.pathfinder.goto(new pathfinder.goals.GoalNear(pos.x, pos.y, pos.z, 4))
  }
  await mineflayer.bot.activateBlock(block)
  logger.log(
    `Activated ${type} at x:${block.position.x.toFixed(
      1,
    )}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`,
  )
  return true
}

export async function tillAndSow(
  mineflayer: Mineflayer,
  x: number,
  y: number,
  z: number,
  seedType: string | null = null,
): Promise<boolean> {
  x = Math.round(x)
  y = Math.round(y)
  z = Math.round(z)
  const blockPos = new Vec3(x, y, z)
  const block = mineflayer.bot.blockAt(blockPos)
  if (!block) {
    logger.log(`No block found at ${blockPos}.`)
    return false
  }
  if (
    block.name !== 'grass_block'
    && block.name !== 'dirt'
    && block.name !== 'farmland'
  ) {
    logger.log(`Cannot till ${block.name}, must be grass_block or dirt.`)
    return false
  }
  const above = mineflayer.bot.blockAt(blockPos.offset(0, 1, 0))
  if (above && above.name !== 'air') {
    logger.log(`Cannot till, there is ${above.name} above the block.`)
    return false
  }
  // Move closer if too far
  if (mineflayer.bot.entity.position.distanceTo(block.position) > 4.5) {
    await goToPosition(mineflayer, x, y, z, 4)
  }
  if (block.name !== 'farmland') {
    const hoe = mineflayer.bot.inventory.items().find(item => item.name.includes('hoe'))
    if (!hoe) {
      logger.log(`Cannot till, no hoes.`)
      return false
    }
    await mineflayer.bot.equip(hoe, 'hand')
    await mineflayer.bot.activateBlock(block)
    logger.log(
      `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`,
    )
  }

  if (seedType) {
    if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
      seedType += 's' // Fixes common mistake
    const seeds = mineflayer.bot.inventory
      .items()
      .find(item => item.name.includes(seedType || 'seed'))
    if (!seeds) {
      logger.log(`No ${seedType} to plant.`)
      return false
    }
    await mineflayer.bot.equip(seeds, 'hand')
    await mineflayer.bot.placeBlock(block, new Vec3(0, -1, 0))
    logger.log(
      `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(
        1,
      )}, z:${z.toFixed(1)}.`,
    )
  }
  return true
}

export async function pickupNearbyItems(
  mineflayer: Mineflayer,
  distance = 8,
): Promise<boolean> {
  const getNearestItem = (bot: Bot) =>
    bot.nearestEntity(
      entity =>
        isDroppedItemEntity(entity)
        && bot.entity.position.distanceTo(entity.position) < distance,
    )

  let pickedUp = 0
  let noProgressAttempts = 0
  const avoidedItems = new Set<string>()

  for (let attempt = 0; attempt < MAX_PICKUP_ATTEMPTS; attempt++) {
    const nearestItem = getNearestItem(mineflayer.bot)
    if (!nearestItem) {
      break
    }

    const itemKey = `${nearestItem.id}:${nearestItem.position.x.toFixed(1)}:${nearestItem.position.y.toFixed(1)}:${nearestItem.position.z.toFixed(1)}`
    if (avoidedItems.has(itemKey)) {
      noProgressAttempts++
      if (noProgressAttempts >= MAX_PICKUP_NO_PROGRESS_ATTEMPTS) {
        break
      }
      continue
    }

    try {
      // bot.pathfinder.setMovements(new pf.Movements(bot));
      await mineflayer.bot.pathfinder.goto(
        new pathfinder.goals.GoalFollow(nearestItem, 0.8),
      )
    }
    catch {
      avoidedItems.add(itemKey)
      noProgressAttempts++
      if (noProgressAttempts >= MAX_PICKUP_NO_PROGRESS_ATTEMPTS) {
        break
      }
      continue
    }

    await sleep(500)
    const nextNearestItem = getNearestItem(mineflayer.bot)
    if (!nextNearestItem || nextNearestItem.id !== nearestItem.id) {
      pickedUp++
      noProgressAttempts = 0
      continue
    }

    avoidedItems.add(itemKey)
    noProgressAttempts++
    if (noProgressAttempts >= MAX_PICKUP_NO_PROGRESS_ATTEMPTS) {
      break
    }
  }
  logger.log(`Picked up ${pickedUp} items.`)
  return true
}
