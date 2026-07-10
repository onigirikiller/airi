import type { SafeBlock } from 'mineflayer-pathfinder'

import type { Mineflayer } from '../libs/mineflayer'
import type { BlockFace } from './base'

import pathfinderModel from 'mineflayer-pathfinder'

import { sleep } from '@moeru/std'
import { Vec3 } from 'vec3'

import { ActionAbortedError, raceWithAbort, throwIfAborted } from '../libs/mineflayer/action-abort'
import { getBlockId, makeItem } from '../utils/mcdata'
import { getItemCount, refreshInventoryState } from './actions/inventory'
import { log } from './base'
import { getBlockAtAccurate, getNearestBlockAccurate } from './block-access'
import { goToPosition } from './movement'
import { getNearestBlocks, getPosition, shouldPlaceTorch } from './world'

const { goals, Movements } = pathfinderModel
const BLOCK_BREAK_MOVE_TIMEOUT_MS = 20_000
const BLOCK_DIG_TIMEOUT_MS = 15_000

function createPathMovementsOrNull(mineflayer: Mineflayer): InstanceType<typeof Movements> | null {
  const registry = (mineflayer.bot as any).registry
  if (!registry?.blocksByName) {
    return null
  }

  try {
    return new Movements(mineflayer.bot)
  }
  catch {
    return null
  }
}

/**
 * Place a torch if needed
 */
async function autoLight(mineflayer: Mineflayer): Promise<boolean> {
  if (shouldPlaceTorch(mineflayer)) {
    try {
      const pos = getPosition(mineflayer)
      return await placeBlock(mineflayer, 'torch', pos.x, pos.y, pos.z, 'bottom', true)
    }
    catch {
      return false
    }
  }
  return false
}

/**
 * Break a block at the specified position
 */
export async function breakBlockAt(
  mineflayer: Mineflayer,
  x: number,
  y: number,
  z: number,
): Promise<boolean> {
  const signal = mineflayer.currentActionSignal
  throwIfAborted(signal)
  validatePosition(x, y, z)

  const block = await getBlockAtAccurate(mineflayer, new Vec3(x, y, z))
  if (!block || isUnbreakableBlock(block))
    return false

  if (mineflayer.allowCheats) {
    return breakWithCheats(mineflayer, x, y, z)
  }

  await moveIntoRange(mineflayer, block)
  throwIfAborted(signal)

  if (mineflayer.isCreative) {
    return breakInCreative(mineflayer, block, x, y, z)
  }

  return breakInSurvival(mineflayer, block, x, y, z)
}

function validatePosition(x: number, y: number, z: number) {
  if (x == null || y == null || z == null) {
    throw new Error('Invalid position to break block at.')
  }
}

function isUnbreakableBlock(block: any): boolean {
  if (!block)
    return true
  return block.name === 'air' || block.name === 'water' || block.name === 'lava'
}

async function breakWithCheats(mineflayer: Mineflayer, x: number, y: number, z: number): Promise<boolean> {
  mineflayer.bot.chat(`/setblock ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} air`)
  log(mineflayer, `Used /setblock to break block at ${x}, ${y}, ${z}.`)
  return true
}

async function moveIntoRange(mineflayer: Mineflayer, block: any) {
  // Use a tighter threshold (3.5) because FabricBridge position tracking can
  // lag behind the real player position, causing the bot to think it's close
  // enough when the actual Minecraft player is slightly out of reach.
  if (mineflayer.bot.entity.position.distanceTo(block.position) > 3.5) {
    const pos = block.position
    const movements = createPathMovementsOrNull(mineflayer)
    if (movements) {
      movements.allowParkour = false
      movements.allowSprinting = false
      mineflayer.bot.pathfinder.setMovements(movements)
    }
    await withTimeout(
      mineflayer.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)),
      BLOCK_BREAK_MOVE_TIMEOUT_MS,
      `Pathing to ${block.name} at ${pos.x}, ${pos.y}, ${pos.z}`,
      mineflayer.currentActionSignal,
      () => mineflayer.bot.pathfinder.stop?.(),
    )
  }
}

async function breakInCreative(mineflayer: Mineflayer, block: any, x: number, y: number, z: number): Promise<boolean> {
  await digBlockWithTimeout(mineflayer, block, x, y, z)
  log(mineflayer, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`)
  return true
}

async function breakInSurvival(mineflayer: Mineflayer, block: any, x: number, y: number, z: number): Promise<boolean> {
  await mineflayer.bot.tool.equipForBlock(block)

  let itemId = mineflayer.bot.heldItem?.type
  // canHarvest may not exist on FabricBridge blocks - skip check if not available
  if (typeof block.canHarvest === 'function' && !block.canHarvest(itemId)) {
    // NOTICE: FabricBridge can lag for one inventory tick after equipForBlock, so refresh
    // once before declaring the tool missing.
    await refreshInventoryState(mineflayer)
    await mineflayer.bot.tool.equipForBlock(block)
    itemId = mineflayer.bot.heldItem?.type
    if (!block.canHarvest(itemId)) {
      log(mineflayer, `Don't have right tools to break ${block.name}.`)
      return false
    }
  }

  await digBlockWithTimeout(mineflayer, block, x, y, z)
  log(mineflayer, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`)
  return true
}

async function digBlockWithTimeout(
  mineflayer: Mineflayer,
  block: any,
  x: number,
  y: number,
  z: number,
): Promise<void> {
  await withTimeout(
    mineflayer.bot.dig(block, true),
    BLOCK_DIG_TIMEOUT_MS,
    `Digging ${block.name} at ${x}, ${y}, ${z}`,
    mineflayer.currentActionSignal,
    () => mineflayer.bot.stopDigging?.(),
  )
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  signal: AbortSignal | undefined,
  onTimeout?: () => void,
): Promise<T> {
  throwIfAborted(signal)
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.()
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    const result = await raceWithAbort(Promise.race([operation, timeout]), signal)
    throwIfAborted(signal)
    return result
  }
  finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

/**
 * Place a block at the specified position
 */
export async function placeBlock(
  mineflayer: Mineflayer,
  blockType: string,
  x: number,
  y: number,
  z: number,
  placeOn: BlockFace = 'bottom',
  dontCheat = false,
): Promise<boolean> {
  if (!getBlockId(blockType)) {
    log(mineflayer, `Invalid block type: ${blockType}.`)
    return false
  }

  const targetDest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))

  if (mineflayer.allowCheats && !dontCheat) {
    return placeWithCheats(mineflayer, blockType, targetDest, placeOn)
  }

  return placeWithoutCheats(mineflayer, blockType, targetDest, placeOn)
}

function getBlockState(blockType: string, placeOn: BlockFace): string {
  const face = getInvertedFace(placeOn as 'north' | 'south' | 'east' | 'west')
  let blockState = blockType

  if (blockType.includes('torch') && placeOn !== 'bottom') {
    blockState = handleTorchState(blockType, placeOn, face)
  }

  if (blockType.includes('button') || blockType === 'lever') {
    blockState = handleButtonLeverState(blockState, placeOn, face)
  }

  if (needsFacingState(blockType)) {
    blockState += `[facing=${face}]`
  }

  return blockState
}

function getInvertedFace(placeOn: BlockFace): string {
  const faceMap: Record<string, string> = {
    north: 'south',
    south: 'north',
    east: 'west',
    west: 'east',
  }

  return faceMap[placeOn] || placeOn
}

function handleTorchState(blockType: string, placeOn: BlockFace, face: string): string {
  let state = blockType.replace('torch', 'wall_torch')
  if (placeOn !== 'side' && placeOn !== 'top') {
    state += `[facing=${face}]`
  }
  return state
}

function handleButtonLeverState(blockState: string, placeOn: BlockFace, face: string): string {
  if (placeOn === 'top') {
    return `${blockState}[face=ceiling]`
  }
  if (placeOn === 'bottom') {
    return `${blockState}[face=floor]`
  }
  return `${blockState}[facing=${face}]`
}

function needsFacingState(blockType: string): boolean {
  return blockType === 'ladder'
    || blockType === 'repeater'
    || blockType === 'comparator'
    || blockType.includes('stairs')
}

async function placeWithCheats(
  mineflayer: Mineflayer,
  blockType: string,
  targetDest: Vec3,
  placeOn: BlockFace,
): Promise<boolean> {
  const blockState = getBlockState(blockType, placeOn)

  mineflayer.bot.chat(`/setblock ${targetDest.x} ${targetDest.y} ${targetDest.z} ${blockState}`)

  if (blockType.includes('door')) {
    mineflayer.bot.chat(`/setblock ${targetDest.x} ${targetDest.y + 1} ${targetDest.z} ${blockState}[half=upper]`)
  }

  if (blockType.includes('bed')) {
    mineflayer.bot.chat(`/setblock ${targetDest.x} ${targetDest.y} ${targetDest.z - 1} ${blockState}[part=head]`)
  }

  log(mineflayer, `Used /setblock to place ${blockType} at ${targetDest}.`)
  return true
}

async function placeWithoutCheats(
  mineflayer: Mineflayer,
  blockType: string,
  targetDest: Vec3,
  placeOn: BlockFace,
): Promise<boolean> {
  const itemName = blockType === 'redstone_wire' ? 'redstone' : blockType

  let block = mineflayer.bot.inventory.items().find(item => item.name === itemName)
  const hasOptimisticItem = getItemCount(mineflayer, itemName) > 0
  if (!block && mineflayer.isCreative) {
    await mineflayer.bot.creative.setInventorySlot(36, makeItem(itemName, 1))
    block = mineflayer.bot.inventory.items().find(item => item.name === itemName)
  }

  if (!block && hasOptimisticItem) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(200)
      await refreshInventoryState(mineflayer)
      block = mineflayer.bot.inventory.items().find(item => item.name === itemName)
      if (block) {
        break
      }
    }
  }

  if (!block) {
    log(mineflayer, `Don't have any ${blockType} to place.`)
    return false
  }

  const targetBlock = await getBlockAtAccurate(mineflayer, targetDest)
  const targetBlockName = targetBlock?.name ?? 'air'
  const targetBlockPosition = targetBlock?.position ?? targetDest

  if (targetBlockName === blockType) {
    log(mineflayer, `${blockType} already at ${targetBlockPosition}.`)
    return false
  }

  const emptyBlocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern']
  if (!emptyBlocks.includes(targetBlockName)) {
    if (!await clearBlockSpace(mineflayer, targetBlock, blockType)) {
      return false
    }
  }

  const { buildOffBlock, faceVec } = await findPlacementSpot(mineflayer, targetDest, placeOn, emptyBlocks)
  if (!buildOffBlock) {
    log(mineflayer, `Cannot place ${blockType} at ${targetBlockPosition}: nothing to place on.`)
    return false
  }

  if (!faceVec) {
    log(mineflayer, `Cannot place ${blockType} at ${targetBlockPosition}: no valid face to place on.`)
    return false
  }

  await moveIntoPosition(mineflayer, blockType, targetBlockPosition)
  return await tryPlaceBlock(mineflayer, block, buildOffBlock, faceVec, blockType, targetDest)
}

async function clearBlockSpace(
  mineflayer: Mineflayer,
  targetBlock: any,
  blockType: string,
): Promise<boolean> {
  if (!targetBlock) {
    return true
  }

  const removed = await breakBlockAt(mineflayer, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z,
  )
  if (!removed) {
    log(mineflayer, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`)
    return false
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  return true
}

async function findPlacementSpot(mineflayer: Mineflayer, targetDest: Vec3, placeOn: BlockFace, emptyBlocks: string[]) {
  const dirMap = {
    top: new Vec3(0, 1, 0),
    bottom: new Vec3(0, -1, 0),
    north: new Vec3(0, 0, -1),
    south: new Vec3(0, 0, 1),
    east: new Vec3(1, 0, 0),
    west: new Vec3(-1, 0, 0),
  }

  const dirs = getPlacementDirections(placeOn, dirMap)

  for (const d of dirs) {
    const block = await getBlockAtAccurate(mineflayer, targetDest.plus(d))
    if (!emptyBlocks.includes(block?.name ?? '')) {
      return {
        buildOffBlock: block,
        faceVec: new Vec3(-d.x, -d.y, -d.z),
      }
    }
  }

  return { buildOffBlock: null, faceVec: null }
}

function getPlacementDirections(placeOn: BlockFace, dirMap: Record<string, Vec3>): Vec3[] {
  const directions: Vec3[] = []
  if (placeOn === 'side') {
    directions.push(dirMap.north, dirMap.south, dirMap.east, dirMap.west)
  }
  else if (dirMap[placeOn]) {
    directions.push(dirMap[placeOn])
  }
  else {
    directions.push(dirMap.bottom)
  }

  directions.push(...Object.values(dirMap).filter(d => !directions.includes(d)))
  return directions
}

async function moveIntoPosition(mineflayer: Mineflayer, blockType: string, targetBlockPosition: Vec3) {
  const dontMoveFor = [
    'torch',
    'redstone_torch',
    'redstone_wire',
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

  const pos = mineflayer.bot.entity.position
  const posAbove = pos.plus(new Vec3(0, 1, 0))

  if (!dontMoveFor.includes(blockType)
    && (pos.distanceTo(targetBlockPosition) < 1
      || posAbove.distanceTo(targetBlockPosition) < 1)) {
    await moveAwayFromBlock(mineflayer, targetBlockPosition)
  }

  if (mineflayer.bot.entity.position.distanceTo(targetBlockPosition) > 4.5) {
    await moveToBlock(mineflayer, targetBlockPosition)
  }
}

async function moveAwayFromBlock(mineflayer: Mineflayer, targetBlockPosition: Vec3) {
  const goal = new goals.GoalNear(
    targetBlockPosition.x,
    targetBlockPosition.y,
    targetBlockPosition.z,
    2,
  )
  const invertedGoal = new goals.GoalInvert(goal)
  const movements = createPathMovementsOrNull(mineflayer)
  if (movements) {
    mineflayer.bot.pathfinder.setMovements(movements)
  }
  await mineflayer.bot.pathfinder.goto(invertedGoal)
}

async function moveToBlock(mineflayer: Mineflayer, targetBlockPosition: Vec3) {
  const pos = targetBlockPosition
  const movements = createPathMovementsOrNull(mineflayer)
  if (movements) {
    mineflayer.bot.pathfinder.setMovements(movements)
  }
  await mineflayer.bot.pathfinder.goto(
    new goals.GoalNear(pos.x, pos.y, pos.z, 4),
  )
}

async function tryPlaceBlock(
  mineflayer: Mineflayer,
  block: any,
  buildOffBlock: any,
  faceVec: Vec3,
  blockType: string,
  targetDest: Vec3,
): Promise<boolean> {
  await mineflayer.bot.equip(block, 'hand')
  await mineflayer.bot.lookAt(buildOffBlock.position)

  try {
    await mineflayer.bot.placeBlock(buildOffBlock, faceVec)
    log(mineflayer, `Placed ${blockType} at ${targetDest}.`)
    await new Promise(resolve => setTimeout(resolve, 200))
    return true
  }
  catch {
    log(mineflayer, `Failed to place ${blockType} at ${targetDest}.`)
    return false
  }
}

/**
 * Use a door at the specified position
 */
export async function useDoor(mineflayer: Mineflayer, doorPos: Vec3 | null = null): Promise<boolean> {
  doorPos = doorPos || await findNearestDoor(mineflayer)

  if (!doorPos) {
    log(mineflayer, 'Could not find a door to use.')
    return false
  }

  await goToPosition(mineflayer, doorPos.x, doorPos.y, doorPos.z, 1)
  while (mineflayer.bot.pathfinder.isMoving()) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  return await operateDoor(mineflayer, doorPos)
}

async function findNearestDoor(mineflayer: Mineflayer): Promise<Vec3 | null> {
  const doorTypes = [
    'oak_door',
    'spruce_door',
    'birch_door',
    'jungle_door',
    'acacia_door',
    'dark_oak_door',
    'mangrove_door',
    'cherry_door',
    'bamboo_door',
    'crimson_door',
    'warped_door',
  ]

  for (const doorType of doorTypes) {
    const block = await getNearestBlockAccurate(mineflayer, doorType, 16)
    if (block) {
      return block.position
    }
  }
  return null
}

async function operateDoor(mineflayer: Mineflayer, doorPos: Vec3): Promise<boolean> {
  const doorBlock = await getBlockAtAccurate(mineflayer, doorPos)
  await mineflayer.bot.lookAt(doorPos)

  if (!doorBlock) {
    log(mineflayer, `Cannot find door at ${doorPos}.`)
    return false
  }

  if (!doorBlock.getProperties().open) {
    await mineflayer.bot.activateBlock(doorBlock)
  }

  mineflayer.bot.setControlState('forward', true)
  await new Promise(resolve => setTimeout(resolve, 600))
  mineflayer.bot.setControlState('forward', false)
  await mineflayer.bot.activateBlock(doorBlock)

  mineflayer.bot.setControlState('forward', true)
  await new Promise(resolve => setTimeout(resolve, 600))
  mineflayer.bot.setControlState('forward', false)
  await mineflayer.bot.activateBlock(doorBlock)

  log(mineflayer, `Used door at ${doorPos}.`)
  return true
}

export async function tillAndSow(
  mineflayer: Mineflayer,
  x: number,
  y: number,
  z: number,
  seedType: string | null = null,
): Promise<boolean> {
  const pos = { x: Math.round(x), y: Math.round(y), z: Math.round(z) }

  const block = await getBlockAtAccurate(mineflayer, new Vec3(pos.x, pos.y, pos.z))

  if (!block) {
    log(mineflayer, `Cannot till, no block at ${pos}.`)
    return false
  }

  if (!canTillBlock(block)) {
    log(mineflayer, `Cannot till ${block.name}, must be grass_block or dirt.`)
    return false
  }

  const above = await getBlockAtAccurate(mineflayer, new Vec3(pos.x, pos.y + 1, pos.z))

  if (!above) {
    log(mineflayer, `Cannot till, no block above the block.`)
    return false
  }

  if (!isBlockClear(above)) {
    log(mineflayer, `Cannot till, there is ${above.name} above the block.`)
    return false
  }

  await moveIntoRange(mineflayer, block)

  if (!await tillBlock(mineflayer, block, pos)) {
    return false
  }

  if (seedType) {
    return await sowSeeds(mineflayer, block, seedType, pos)
  }

  return true
}

function canTillBlock(block: any): boolean {
  return block.name === 'grass_block' || block.name === 'dirt' || block.name === 'farmland'
}

function isBlockClear(block: any): boolean {
  return block.name === 'air'
}

async function tillBlock(mineflayer: Mineflayer, block: any, pos: any): Promise<boolean> {
  if (block.name === 'farmland') {
    return true
  }

  const hoe = mineflayer.bot.inventory.items().find(item => item.name.includes('hoe'))
  if (!hoe) {
    log(mineflayer, 'Cannot till, no hoes.')
    return false
  }

  await mineflayer.bot.equip(hoe, 'hand')
  await mineflayer.bot.activateBlock(block)
  log(mineflayer, `Tilled block x:${pos.x.toFixed(1)}, y:${pos.y.toFixed(1)}, z:${pos.z.toFixed(1)}.`)
  return true
}

async function sowSeeds(mineflayer: Mineflayer, block: any, seedType: string, pos: any): Promise<boolean> {
  seedType = fixSeedName(seedType)

  const seeds = mineflayer.bot.inventory.items().find(item => item.name === seedType)
  if (!seeds) {
    log(mineflayer, `No ${seedType} to plant.`)
    return false
  }

  await mineflayer.bot.equip(seeds, 'hand')
  await mineflayer.bot.placeBlock(block, new Vec3(0, -1, 0))
  log(mineflayer, `Planted ${seedType} at x:${pos.x.toFixed(1)}, y:${pos.y.toFixed(1)}, z:${pos.z.toFixed(1)}.`)
  return true
}

function fixSeedName(seedType: string): string {
  if (seedType.endsWith('seed') && !seedType.endsWith('seeds')) {
    return `${seedType}s` // Fix common mistake
  }
  return seedType
}

export async function activateNearestBlock(mineflayer: Mineflayer, type: string): Promise<boolean> {
  const block = await getNearestBlockAccurate(mineflayer, type, 16)
  if (!block) {
    log(mineflayer, `Could not find any ${type} to activate.`)
    return false
  }

  await moveIntoRange(mineflayer, block)
  await mineflayer.bot.activateBlock(block)
  log(mineflayer, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`)
  return true
}

export async function collectBlock(
  mineflayer: Mineflayer,
  blockType: string,
  num: number = 1,
  exclude: Vec3[] | null = null,
): Promise<boolean> {
  if (num < 1) {
    log(mineflayer, `Invalid number of blocks to collect: ${num}.`)
    return false
  }

  const blocktypes = getBlockTypes(blockType)
  let collected = 0

  mineflayer.once('interrupt', () => {
    collected = -1
  })

  for (let i = 0; i < num && collected >= 0; i++) {
    throwIfAborted(mineflayer.currentActionSignal)
    const blocks = getValidBlocks(mineflayer, blocktypes, exclude)

    if (blocks.length === 0) {
      logNoBlocksMessage(mineflayer, blockType, collected)
      break
    }

    const block = blocks[0]
    if (!await canHarvestBlock(mineflayer, block, blockType)) {
      return false
    }

    if (!await tryCollectBlock(mineflayer, block, blockType)) {
      break
    }

    collected++
  }

  if (collected < 0) {
    log(mineflayer, 'Collection interrupted.')
    return false
  }

  log(mineflayer, `Collected ${collected} ${blockType}.`)
  return collected > 0
}

function getBlockTypes(blockType: string): string[] {
  const blocktypes: string[] = [blockType]

  const ores = ['coal', 'diamond', 'emerald', 'iron', 'gold', 'lapis_lazuli', 'redstone']
  if (ores.includes(blockType)) {
    blocktypes.push(`${blockType}_ore`)
  }
  if (blockType.endsWith('ore')) {
    blocktypes.push(`deepslate_${blockType}`)
  }
  if (blockType === 'dirt') {
    blocktypes.push('grass_block')
  }

  return blocktypes
}

function getValidBlocks(mineflayer: Mineflayer, blocktypes: string[], exclude: Vec3[] | null): any[] {
  let blocks = getNearestBlocks(mineflayer, blocktypes, 64)

  if (exclude) {
    blocks = blocks.filter(
      block => !exclude.some(pos =>
        pos.x === block.position.x
        && pos.y === block.position.y
        && pos.z === block.position.z,
      ),
    )
  }

  const movements = createPathMovementsOrNull(mineflayer)
  if (!movements) {
    return blocks
  }

  movements.dontMineUnderFallingBlock = false
  return blocks.filter(block => movements.safeToBreak(block as SafeBlock))
}

function logNoBlocksMessage(mineflayer: Mineflayer, blockType: string, collected: number): void {
  log(mineflayer, collected === 0
    ? `No ${blockType} nearby to collect.`
    : `No more ${blockType} nearby to collect.`)
}

async function canHarvestBlock(mineflayer: Mineflayer, block: any, blockType: string): Promise<boolean> {
  await mineflayer.bot.tool.equipForBlock(block)
  const itemId = mineflayer.bot.heldItem ? mineflayer.bot.heldItem.type : null

  if (!block.canHarvest(itemId)) {
    log(mineflayer, `Don't have right tools to harvest ${blockType}.`)
    return false
  }
  return true
}

async function tryCollectBlock(mineflayer: Mineflayer, block: any, blockType: string): Promise<boolean> {
  try {
    const signal = mineflayer.currentActionSignal
    throwIfAborted(signal)
    await raceWithAbort(mineflayer.bot.collectBlock.collect(block), signal)
    throwIfAborted(signal)
    await autoLight(mineflayer)
    return true
  }
  catch (err) {
    if (err instanceof ActionAbortedError) {
      throw err
    }
    if (err instanceof Error && err.name === 'NoChests') {
      log(mineflayer, `Failed to collect ${blockType}: Inventory full, no place to deposit.`)
      return false
    }
    log(mineflayer, `Failed to collect ${blockType}: ${err}.`)
    return true
  }
}
