import type { Mineflayer } from '../libs/mineflayer'

import { sleep } from '@moeru/std'

import { useLogger } from '../utils/logger'
import { log } from './base'
import { goToPosition } from './movement'
import { getNearestBlock } from './world'

const logger = useLogger()

/**
 * Brew a potion at the nearest brewing stand (or place one).
 */
export async function brewPotion(
  mineflayer: Mineflayer,
  ingredient: string,
  baseBottles: string = 'glass_bottle',
  count: number = 3,
): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any

    // Find or place brewing stand
    let stand = getNearestBlock(mineflayer, 'brewing_stand', 32)
    if (!stand) {
      // Try to place one from inventory
      const hasStand = bot.inventory.items().some((i: any) => i.name === 'brewing_stand')
      if (!hasStand) {
        log(mineflayer, 'No brewing stand found nearby or in inventory.')
        return false
      }

      const pos = bot.entity.position
      const { placeBlock } = await import('./blocks')
      await placeBlock(mineflayer, 'brewing_stand', Math.floor(pos.x) + 1, Math.floor(pos.y), Math.floor(pos.z))
      await sleep(500)
      stand = getNearestBlock(mineflayer, 'brewing_stand', 32)
    }

    if (!stand) {
      log(mineflayer, 'Could not find or place brewing stand.')
      return false
    }

    // Move to the stand
    await goToPosition(mineflayer, stand.position.x, stand.position.y, stand.position.z, 3)
    await sleep(200)

    // Use the brewing method via FabricBridge
    if ('brew' in bot) {
      const bottles = Array.from({ length: Math.min(count, 3) }, () => baseBottles)
      await bot.brew(stand.position, ingredient, 'blaze_powder', bottles)
      log(mineflayer, `Brewed potion with ${ingredient}.`)
      return true
    }

    log(mineflayer, 'Brewing not supported in current bot mode.')
    return false
  }
  catch (err) {
    logger.withError(err).error('brewPotion failed')
    return false
  }
}
