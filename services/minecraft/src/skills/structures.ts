import type { Mineflayer } from '../libs/mineflayer'

import { sleep } from '@moeru/std'

import { useLogger } from '../utils/logger'
import { log } from './base'
import { placeBlock } from './blocks'
import { useFlintAndSteel } from './items'
import { goToPosition } from './movement'

const logger = useLogger()

/**
 * Build a nether portal frame using obsidian.
 * Standard portal: 4 wide x 5 tall, corners optional (10 obsidian minimum).
 */
export async function buildNetherPortal(
  mineflayer: Mineflayer,
  baseX: number,
  baseY: number,
  baseZ: number,
  facing: 'north' | 'south' | 'east' | 'west' = 'north',
): Promise<boolean> {
  try {
    // Portal frame positions relative to base (4 wide x 5 tall, no corners)
    // facing north/south: portal extends along X axis
    // facing east/west: portal extends along Z axis
    const positions: Array<{ dx: number, dy: number, dz: number }> = []

    const isNS = facing === 'north' || facing === 'south'

    // Bottom row (2 blocks, no corners)
    for (let i = 1; i <= 2; i++) {
      positions.push({ dx: isNS ? i : 0, dy: 0, dz: isNS ? 0 : i })
    }
    // Left column
    for (let j = 1; j <= 3; j++) {
      positions.push({ dx: 0, dy: j, dz: 0 })
    }
    // Right column
    for (let j = 1; j <= 3; j++) {
      positions.push({ dx: isNS ? 3 : 0, dy: j, dz: isNS ? 0 : 3 })
    }
    // Top row (2 blocks, no corners)
    for (let i = 1; i <= 2; i++) {
      positions.push({ dx: isNS ? i : 0, dy: 4, dz: isNS ? 0 : i })
    }

    // Move near the build site
    await goToPosition(mineflayer, baseX, baseY, baseZ, 3)

    for (const pos of positions) {
      const px = baseX + pos.dx
      const py = baseY + pos.dy
      const pz = baseZ + pos.dz
      await placeBlock(mineflayer, 'obsidian', px, py, pz)
      await sleep(200)
    }

    log(mineflayer, 'Nether portal frame built.')
    return true
  }
  catch (err) {
    logger.withError(err).error('buildNetherPortal failed')
    return false
  }
}

/**
 * Light a nether portal by using flint and steel on the interior.
 */
export async function lightPortal(
  mineflayer: Mineflayer,
  interiorX: number,
  interiorY: number,
  interiorZ: number,
): Promise<boolean> {
  try {
    await goToPosition(mineflayer, interiorX, interiorY, interiorZ, 3)
    const result = await useFlintAndSteel(mineflayer, interiorX, interiorY, interiorZ)
    if (result) {
      log(mineflayer, 'Portal lit.')
    }
    return result
  }
  catch (err) {
    logger.withError(err).error('lightPortal failed')
    return false
  }
}

/**
 * Enter a portal and wait for dimension change.
 */
export async function enterPortal(
  mineflayer: Mineflayer,
  portalX: number,
  portalY: number,
  portalZ: number,
  timeoutMs: number = 15000,
): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any

    const dimensionChanged = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        bot.removeListener?.('dimensionChange', onDimChange)
        resolve(false)
      }, timeoutMs)

      function onDimChange() {
        clearTimeout(timer)
        resolve(true)
      }

      if ('on' in bot) {
        bot.on('dimensionChange', onDimChange)
      }
    })

    // Walk into the portal
    await goToPosition(mineflayer, portalX, portalY, portalZ, 0)

    const changed = await dimensionChanged
    if (changed) {
      log(mineflayer, 'Successfully traveled through portal.')
    }
    else {
      log(mineflayer, 'Portal travel timed out.')
    }
    return changed
  }
  catch (err) {
    logger.withError(err).error('enterPortal failed')
    return false
  }
}

/**
 * Pillar up by jumping and placing blocks beneath.
 */
export async function pillarUp(
  mineflayer: Mineflayer,
  blockType: string,
  height: number,
): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any

    for (let i = 0; i < height; i++) {
      // Jump
      bot.setControlState('jump', true)
      await sleep(350)
      bot.setControlState('jump', false)
      await sleep(100)

      // Place block at feet position
      const pos = bot.entity.position
      await placeBlock(mineflayer, blockType, Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z))
      await sleep(200)
    }

    log(mineflayer, `Pillared up ${height} blocks.`)
    return true
  }
  catch (err) {
    logger.withError(err).error('pillarUp failed')
    return false
  }
}

/**
 * Bridge build: sneak and place blocks horizontally.
 */
export async function bridgeBuild(
  mineflayer: Mineflayer,
  blockType: string,
  direction: 'north' | 'south' | 'east' | 'west',
  length: number,
): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any
    const dirMap: Record<string, { dx: number, dz: number }> = {
      north: { dx: 0, dz: -1 },
      south: { dx: 0, dz: 1 },
      east: { dx: 1, dz: 0 },
      west: { dx: -1, dz: 0 },
    }

    const dir = dirMap[direction]
    bot.setControlState('sneak', true)
    await sleep(200)

    const startPos = bot.entity.position
    for (let i = 0; i < length; i++) {
      const px = Math.floor(startPos.x) + dir.dx * (i + 1)
      const py = Math.floor(startPos.y) - 1
      const pz = Math.floor(startPos.z) + dir.dz * (i + 1)

      await placeBlock(mineflayer, blockType, px, py, pz)
      await sleep(300)

      // Move forward one block
      await goToPosition(mineflayer, px, py + 1, pz, 0)
      await sleep(200)
    }

    bot.setControlState('sneak', false)
    log(mineflayer, `Built bridge ${length} blocks ${direction}.`)
    return true
  }
  catch (err) {
    const bot = mineflayer.bot as any
    bot.setControlState?.('sneak', false)
    logger.withError(err).error('bridgeBuild failed')
    return false
  }
}
