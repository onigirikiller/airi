import type { Mineflayer } from '../libs/mineflayer'

import { sleep } from '@moeru/std'

import { useLogger } from '../utils/logger'
import { ensurePickaxe, ensureTorches } from './actions/ensure'
import { log } from './base'
import { placeBlock } from './blocks'
import { goToPosition } from './movement'

const logger = useLogger()

/**
 * Perform branch mining at a target Y level.
 * Digs a main tunnel and periodic branches to the sides.
 */
export async function branchMine(
  mineflayer: Mineflayer,
  targetY: number,
  mainLength: number,
  branchLength: number,
  branchSpacing: number = 3,
): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any
    const startPos = bot.entity.position

    // Ensure we have a pickaxe
    await ensurePickaxe(mineflayer)

    // Step 1: Dig down to target Y via stairs
    let currentX = Math.floor(startPos.x)
    let currentY = Math.floor(startPos.y)
    const currentZ = Math.floor(startPos.z)

    while (currentY > targetY) {
      // Dig staircase: move forward and down
      currentX += 1
      currentY -= 1

      // Dig the block at (currentX, currentY, currentZ) and (currentX, currentY+1, currentZ)
      const block1 = await getBlockAt(bot, currentX, currentY, currentZ)
      if (block1 && block1.diggable) {
        await bot.dig(block1)
      }
      const block2 = await getBlockAt(bot, currentX, currentY + 1, currentZ)
      if (block2 && block2.diggable) {
        await bot.dig(block2)
      }

      await goToPosition(mineflayer, currentX, currentY, currentZ, 0)
      await sleep(100)
    }

    // Step 2: Dig main tunnel
    const mainStartX = currentX

    for (let i = 0; i < mainLength; i++) {
      currentX = mainStartX + i + 1

      // Dig 1x2 tunnel forward
      const block1 = await getBlockAt(bot, currentX, currentY, currentZ)
      if (block1 && block1.diggable) {
        await bot.dig(block1)
      }
      const block2 = await getBlockAt(bot, currentX, currentY + 1, currentZ)
      if (block2 && block2.diggable) {
        await bot.dig(block2)
      }

      await goToPosition(mineflayer, currentX, currentY, currentZ, 0)

      // Place torch every 8 blocks
      if (i > 0 && i % 8 === 0) {
        const hasTorches = await ensureTorches(mineflayer, 1)
        if (hasTorches) {
          await placeBlock(mineflayer, 'torch', currentX, currentY + 1, currentZ)
        }
      }

      // Step 3: Dig branches at intervals
      if (i > 0 && i % branchSpacing === 0) {
        // Left branch
        await digBranch(mineflayer, bot, currentX, currentY, currentZ, 0, 1, branchLength)
        // Right branch
        await digBranch(mineflayer, bot, currentX, currentY, currentZ, 0, -1, branchLength)

        // Return to main tunnel
        await goToPosition(mineflayer, currentX, currentY, currentZ, 0)
      }

      await sleep(50)
    }

    log(mineflayer, `Branch mining complete: ${mainLength} main tunnel, ${branchLength} branches every ${branchSpacing} blocks.`)
    return true
  }
  catch (err) {
    logger.withError(err).error('branchMine failed')
    return false
  }
}

async function digBranch(
  mineflayer: Mineflayer,
  bot: any,
  startX: number,
  startY: number,
  startZ: number,
  _dx: number,
  dz: number,
  length: number,
): Promise<void> {
  for (let j = 1; j <= length; j++) {
    const bx = startX
    const bz = startZ + dz * j

    const block1 = await getBlockAt(bot, bx, startY, bz)
    if (block1 && block1.diggable) {
      await bot.dig(block1)
    }
    const block2 = await getBlockAt(bot, bx, startY + 1, bz)
    if (block2 && block2.diggable) {
      await bot.dig(block2)
    }

    await goToPosition(mineflayer, bx, startY, bz, 0)
    await sleep(50)
  }
}

async function getBlockAt(bot: any, x: number, y: number, z: number): Promise<any> {
  if ('blockAtAsync' in bot) {
    return await bot.blockAtAsync({ x, y, z })
  }
  return bot.blockAt({ x, y, z })
}
