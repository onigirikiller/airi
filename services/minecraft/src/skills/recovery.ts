import type { Mineflayer } from '../libs/mineflayer'

import { sleep } from '@moeru/std'

import { useLogger } from '../utils/logger'
import { log } from './base'
import { goToPosition } from './movement'

const logger = useLogger()

export interface DeathRecord {
  x: number
  y: number
  z: number
  dimension: string
}

async function waitForRespawnedAliveState(mineflayer: Mineflayer, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (mineflayer.bot.health > 0) {
      return true
    }
    await sleep(250)
  }

  return mineflayer.bot.health > 0
}

/**
 * Record the current position and dimension as a death position.
 */
export function recordDeathPosition(mineflayer: Mineflayer): DeathRecord {
  const pos = mineflayer.bot.entity.position
  const dimension = mineflayer.bot.game.dimension
  return {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z),
    dimension,
  }
}

/**
 * Recover after death: respawn and navigate back to death position.
 */
export async function recoverAfterDeath(mineflayer: Mineflayer, deathPos: DeathRecord): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any

    bot.pathfinder?.stop?.()
    bot.clearControlStates?.()

    // Respawn
    if ('respawn' in bot) {
      await bot.respawn()
    }
    const alive = await waitForRespawnedAliveState(mineflayer)
    if (!alive) {
      log(mineflayer, 'Respawn did not complete yet, delaying death recovery.')
      return false
    }

    // Check if we're in the same dimension
    const currentDim = bot.game?.dimension ?? ''
    if (currentDim !== deathPos.dimension) {
      log(mineflayer, `Cannot recover: died in ${deathPos.dimension} but respawned in ${currentDim}.`)
      return false
    }

    // Navigate back to death position
    await goToPosition(mineflayer, deathPos.x, deathPos.y, deathPos.z, 3)
    log(mineflayer, 'Returned to death position.')
    return true
  }
  catch (err) {
    logger.withError(err).error('recoverAfterDeath failed')
    return false
  }
}
