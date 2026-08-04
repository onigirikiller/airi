import type { Mineflayer } from '../libs/mineflayer'

import { sleep } from '@moeru/std'

import { useLogger } from '../utils/logger'
import { log } from './base'
import { goToPosition } from './movement'

const logger = useLogger()
const MIN_LONG_DISTANCE_EXPLORE_HEALTH = 12
const MIN_LONG_DISTANCE_EXPLORE_Y = 60
const MAX_LONG_DISTANCE_EXPLORE_DESCENT = 4

export interface EyeOfEnderResult {
  direction: { x: number, z: number }
  endPos: { x: number, y: number, z: number }
}

function stopLongDistanceMovement(mineflayer: Mineflayer): void {
  try {
    ;(mineflayer.bot as any).pathfinder?.stop?.()
  }
  catch {
    // best-effort travel safety stop
  }

  try {
    ;(mineflayer.bot as any).clearControlStates?.()
  }
  catch {
    // best-effort travel safety stop
  }
}

function getExploreRisk(
  mineflayer: Mineflayer,
  startY: number,
): { reason: string, health: number, y: number } | null {
  const health = Number((mineflayer.bot as any).health ?? 20)
  const y = Number(mineflayer.bot.entity?.position?.y ?? startY)
  if (Number.isFinite(health) && health < MIN_LONG_DISTANCE_EXPLORE_HEALTH) {
    return { reason: 'low_health', health, y }
  }
  if (Number.isFinite(y) && (y < MIN_LONG_DISTANCE_EXPLORE_Y || y < startY - MAX_LONG_DISTANCE_EXPLORE_DESCENT)) {
    return { reason: 'unsafe_descent', health, y }
  }
  return null
}

/**
 * Throw and track an eye of ender to determine stronghold direction.
 */
export async function throwAndTrackEyeOfEnder(mineflayer: Mineflayer): Promise<EyeOfEnderResult | null> {
  try {
    const bot = mineflayer.bot as any

    // Equip ender eye
    const eye = bot.inventory.items().find((i: any) => i.name === 'ender_eye')
    if (!eye) {
      log(mineflayer, 'No ender eye found in inventory.')
      return null
    }
    await bot.equip(eye, 'hand')
    await sleep(200)

    if ('throwEyeOfEnder' in bot) {
      const result = await bot.throwEyeOfEnder()
      log(mineflayer, `Eye of ender flew toward direction (${result.direction.x.toFixed(2)}, ${result.direction.z.toFixed(2)}).`)
      return {
        direction: result.direction,
        endPos: result.endPos,
      }
    }

    // Fallback: just use the item
    if ('useItem' in bot) {
      await bot.useItem()
    }
    log(mineflayer, 'Threw ender eye (no tracking available).')
    return null
  }
  catch (err) {
    logger.withError(err).error('throwAndTrackEyeOfEnder failed')
    return null
  }
}

/**
 * Triangulate stronghold position using two eye of ender throws.
 * Moves ~400 blocks perpendicular to first throw direction, then throws again.
 * Calculates intersection of the two direction lines.
 */
export async function triangulateStronghold(mineflayer: Mineflayer): Promise<{ x: number, z: number } | null> {
  try {
    const bot = mineflayer.bot

    // First throw
    const posA = { x: bot.entity.position.x, z: bot.entity.position.z }
    const resultA = await throwAndTrackEyeOfEnder(mineflayer)
    if (!resultA) {
      log(mineflayer, 'First eye of ender throw failed.')
      return null
    }
    const dirA = resultA.direction

    // Move ~400 blocks perpendicular to the direction
    const perpX = -dirA.z
    const perpZ = dirA.x
    const moveDistance = 400
    const targetX = posA.x + perpX * moveDistance
    const targetZ = posA.z + perpZ * moveDistance

    log(mineflayer, `Moving to second triangulation point (${Math.floor(targetX)}, ${Math.floor(targetZ)})...`)
    await goToPosition(mineflayer, targetX, bot.entity.position.y, targetZ, 5)

    // Second throw
    const posB = { x: bot.entity.position.x, z: bot.entity.position.z }
    const resultB = await throwAndTrackEyeOfEnder(mineflayer)
    if (!resultB) {
      log(mineflayer, 'Second eye of ender throw failed.')
      return null
    }
    const dirB = resultB.direction

    // Calculate intersection of two rays
    // Ray A: posA + t * dirA
    // Ray B: posB + s * dirB
    // posA.x + t * dirA.x = posB.x + s * dirB.x
    // posA.z + t * dirA.z = posB.z + s * dirB.z
    const det = dirA.x * dirB.z - dirA.z * dirB.x
    if (Math.abs(det) < 0.001) {
      log(mineflayer, 'Lines are parallel, cannot triangulate.')
      return null
    }

    const dx = posB.x - posA.x
    const dz = posB.z - posA.z
    const t = (dx * dirB.z - dz * dirB.x) / det

    const strongholdX = Math.floor(posA.x + t * dirA.x)
    const strongholdZ = Math.floor(posA.z + t * dirA.z)

    log(mineflayer, `Stronghold estimated at (${strongholdX}, ${strongholdZ}).`)
    return { x: strongholdX, z: strongholdZ }
  }
  catch (err) {
    logger.withError(err).error('triangulateStronghold failed')
    return null
  }
}

/**
 * Travel a long distance in a specified direction.
 * Used for nether fortress exploration and other long-range travel.
 */
export async function exploreLongDistance(
  mineflayer: Mineflayer,
  direction: 'north' | 'south' | 'east' | 'west',
  distance: number,
  stopCondition?: (mineflayer: Mineflayer) => boolean,
): Promise<boolean> {
  try {
    const bot = mineflayer.bot
    const pos = bot.entity.position
    const startY = pos.y

    const dirMap: Record<string, { dx: number, dz: number }> = {
      north: { dx: 0, dz: -1 },
      south: { dx: 0, dz: 1 },
      east: { dx: 1, dz: 0 },
      west: { dx: -1, dz: 0 },
    }

    const dir = dirMap[direction]
    const segmentLength = 64 // Navigate in 64-block segments
    let traveled = 0

    while (traveled < distance) {
      const preMoveRisk = getExploreRisk(mineflayer, startY)
      if (preMoveRisk) {
        stopLongDistanceMovement(mineflayer)
        logger.withFields(preMoveRisk).warn('Stopping long-distance exploration before movement because survival conditions are unsafe.')
        return false
      }

      if (stopCondition && stopCondition(mineflayer)) {
        log(mineflayer, 'Stop condition met during long-distance travel.')
        return true
      }

      const remaining = distance - traveled
      const segment = Math.min(segmentLength, remaining)
      const targetX = pos.x + dir.dx * (traveled + segment)
      const targetZ = pos.z + dir.dz * (traveled + segment)

      const reachedSegment = await goToPosition(mineflayer, targetX, Math.max(bot.entity.position.y, startY), targetZ, 3)
      if (!reachedSegment) {
        stopLongDistanceMovement(mineflayer)
        logger.withFields({ direction, traveled, segment }).warn('Stopping long-distance exploration because a segment path failed.')
        return false
      }
      traveled += segment
      await sleep(500)

      const postMoveRisk = getExploreRisk(mineflayer, startY)
      if (postMoveRisk) {
        stopLongDistanceMovement(mineflayer)
        logger.withFields({ ...postMoveRisk, direction, traveled }).warn('Stopping long-distance exploration after movement because survival conditions became unsafe.')
        return false
      }
    }

    log(mineflayer, `Traveled ${distance} blocks ${direction}.`)
    return true
  }
  catch (err) {
    logger.withError(err).error('exploreLongDistance failed')
    return false
  }
}
