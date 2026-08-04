import type { Mineflayer } from '../libs/mineflayer'

import { sleep } from '@moeru/std'

import { useLogger } from '../utils/logger'
import { log } from './base'

const logger = useLogger()

export async function useBucket(mineflayer: Mineflayer, bucketType: string, x: number, y: number, z: number): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any
    const item = bot.inventory.items().find((i: any) => i.name.includes(bucketType))
    if (!item) {
      log(mineflayer, `No ${bucketType} found in inventory.`)
      return false
    }

    await bot.equip(item, 'hand')
    await sleep(200)

    if ('lookAtPosition' in bot) {
      await bot.lookAtPosition(x, y, z)
    }
    else {
      const { Vec3Simple } = await import('../libs/fabric-bridge/bot-proxy')
      await bot.lookAt(new Vec3Simple(x, y, z))
    }
    await sleep(100)

    if ('useItemOnBlock' in bot) {
      await bot.useItemOnBlock({ x, y, z })
    }
    else {
      const block = bot.blockAt({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) })
      if (block) {
        await bot.activateBlock(block)
      }
    }

    log(mineflayer, `Used ${bucketType} at (${x}, ${y}, ${z}).`)
    return true
  }
  catch (err) {
    logger.withError(err).error('useBucket failed')
    return false
  }
}

export async function useFlintAndSteel(mineflayer: Mineflayer, x: number, y: number, z: number): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any
    const item = bot.inventory.items().find((i: any) => i.name === 'flint_and_steel')
    if (!item) {
      log(mineflayer, 'No flint and steel found in inventory.')
      return false
    }

    await bot.equip(item, 'hand')
    await sleep(200)

    if ('lookAtPosition' in bot) {
      await bot.lookAtPosition(x, y, z)
    }
    else {
      const { Vec3Simple } = await import('../libs/fabric-bridge/bot-proxy')
      await bot.lookAt(new Vec3Simple(x, y, z))
    }
    await sleep(100)

    if ('useItemOnBlock' in bot) {
      await bot.useItemOnBlock({ x, y, z })
    }

    log(mineflayer, `Used flint and steel at (${x}, ${y}, ${z}).`)
    return true
  }
  catch (err) {
    logger.withError(err).error('useFlintAndSteel failed')
    return false
  }
}

export async function shootBow(mineflayer: Mineflayer, targetX: number, targetY: number, targetZ: number, chargeMs: number = 1200): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any
    const bow = bot.inventory.items().find((i: any) => i.name === 'bow')
    if (!bow) {
      log(mineflayer, 'No bow found in inventory.')
      return false
    }

    const arrows = bot.inventory.items().find((i: any) => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow')
    if (!arrows) {
      log(mineflayer, 'No arrows found in inventory.')
      return false
    }

    await bot.equip(bow, 'hand')
    await sleep(200)

    if ('lookAtPosition' in bot) {
      await bot.lookAtPosition(targetX, targetY, targetZ)
    }
    else {
      const { Vec3Simple } = await import('../libs/fabric-bridge/bot-proxy')
      await bot.lookAt(new Vec3Simple(targetX, targetY, targetZ))
    }
    await sleep(100)

    if ('startUseItem' in bot) {
      await bot.startUseItem()
      await sleep(chargeMs)
      await bot.stopUseItem()
    }

    log(mineflayer, `Shot bow at (${targetX}, ${targetY}, ${targetZ}).`)
    return true
  }
  catch (err) {
    logger.withError(err).error('shootBow failed')
    return false
  }
}

export async function throwItem(mineflayer: Mineflayer, itemName: string): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any
    const item = bot.inventory.items().find((i: any) => i.name === itemName)
    if (!item) {
      log(mineflayer, `No ${itemName} found in inventory.`)
      return false
    }

    await bot.equip(item, 'hand')
    await sleep(200)

    if ('useItem' in bot) {
      await bot.useItem()
    }

    log(mineflayer, `Threw ${itemName}.`)
    return true
  }
  catch (err) {
    logger.withError(err).error('throwItem failed')
    return false
  }
}
