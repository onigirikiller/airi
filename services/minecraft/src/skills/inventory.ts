import type { Mineflayer } from '../libs/mineflayer'

import { discard as deterministicDiscard, equip as deterministicEquip } from './actions/inventory'
import { log } from './base'
import { findBestFoodItem } from './food'
import { goToPlayer, goToPosition } from './movement'
import { getNearestBlock } from './world'

export async function equip(mineflayer: Mineflayer, itemName: string): Promise<boolean> {
  const equipped = await deterministicEquip(mineflayer, itemName)
  if (equipped) {
    log(mineflayer, `Equipped ${itemName}.`)
  }
  return equipped
}

export async function discard(mineflayer: Mineflayer, itemName: string, num = -1): Promise<boolean> {
  const discarded = await deterministicDiscard(mineflayer, itemName, num)
  if (discarded) {
    log(mineflayer, `Discarded ${num === -1 ? 'all' : num} ${itemName}.`)
  }
  return discarded
}

export async function putInChest(mineflayer: Mineflayer, itemName: string, num = -1): Promise<boolean> {
  const chest = getNearestBlock(mineflayer, 'chest', 32)
  if (!chest) {
    log(mineflayer, 'Could not find a chest nearby.')
    return false
  }

  const item = mineflayer.bot.inventory.items().find(item => item.name === itemName)
  if (!item) {
    log(mineflayer, `You do not have any ${itemName} to put in the chest.`)
    return false
  }

  const toPut = num === -1 ? item.count : Math.min(num, item.count)
  await goToPosition(mineflayer, chest.position.x, chest.position.y, chest.position.z, 2)

  const chestContainer = await mineflayer.bot.openContainer(chest)
  await chestContainer.deposit(item.type, null, toPut)
  await chestContainer.close()

  log(mineflayer, `Successfully put ${toPut} ${itemName} in the chest.`)
  return true
}

export async function takeFromChest(mineflayer: Mineflayer, itemName: string, num = -1): Promise<boolean> {
  const chest = getNearestBlock(mineflayer, 'chest', 32)
  if (!chest) {
    log(mineflayer, 'Could not find a chest nearby.')
    return false
  }

  await goToPosition(mineflayer, chest.position.x, chest.position.y, chest.position.z, 2)
  const chestContainer = await mineflayer.bot.openContainer(chest)

  const item = chestContainer.containerItems().find(item => item.name === itemName)
  if (!item) {
    log(mineflayer, `Could not find any ${itemName} in the chest.`)
    await chestContainer.close()
    return false
  }

  const toTake = num === -1 ? item.count : Math.min(num, item.count)
  await chestContainer.withdraw(item.type, null, toTake)
  await chestContainer.close()

  log(mineflayer, `Successfully took ${toTake} ${itemName} from the chest.`)
  return true
}

export async function viewChest(mineflayer: Mineflayer): Promise<boolean> {
  const chest = getNearestBlock(mineflayer, 'chest', 32)
  if (!chest) {
    log(mineflayer, 'Could not find a chest nearby.')
    return false
  }

  await goToPosition(mineflayer, chest.position.x, chest.position.y, chest.position.z, 2)
  const chestContainer = await mineflayer.bot.openContainer(chest)
  const items = chestContainer.containerItems()

  if (items.length === 0) {
    log(mineflayer, 'The chest is empty.')
  }
  else {
    log(mineflayer, 'The chest contains:')
    for (const item of items) {
      log(mineflayer, `${item.count} ${item.name}`)
    }
  }

  await chestContainer.close()
  return true
}

export async function consume(mineflayer: Mineflayer, itemName = ''): Promise<boolean> {
  const normalizedRequestedName = itemName.trim().toLowerCase()
  const shouldAutoSelectFood = normalizedRequestedName.length === 0
    || normalizedRequestedName === 'food'
    || normalizedRequestedName === 'food_item'
  const inventoryItems = mineflayer.bot.inventory.items()
  let item
  let name = normalizedRequestedName || 'food'

  if (!shouldAutoSelectFood) {
    item = inventoryItems.find(item => item.name === normalizedRequestedName)
    name = normalizedRequestedName
  }

  if (!item) {
    if (shouldAutoSelectFood) {
      item = findBestFoodItem(inventoryItems)
      name = item?.name ?? 'food'
    }
  }

  if (!item) {
    log(mineflayer, `You do not have any ${name} to eat.`)
    return false
  }

  await mineflayer.bot.equip(item, 'hand')
  await mineflayer.bot.consume()
  log(mineflayer, `Consumed ${item.name}.`)
  return true
}

export async function giveToPlayer(
  mineflayer: Mineflayer,
  itemType: string,
  username: string,
  num = 1,
): Promise<boolean> {
  const player = mineflayer.bot.players[username]?.entity
  if (!player) {
    log(mineflayer, `Could not find ${username}.`)
    return false
  }

  // Move to player position
  await goToPlayer(mineflayer, username, 3)

  // Look at player before dropping items
  await mineflayer.bot.lookAt(player.position)

  // Drop items and wait for collection
  const success = await dropItemsAndWaitForCollection(mineflayer, itemType, username, num)
  if (!success) {
    log(mineflayer, `Failed to give ${itemType} to ${username}, it was never received.`)
    return false
  }

  return true
}

async function dropItemsAndWaitForCollection(
  mineflayer: Mineflayer,
  itemType: string,
  username: string,
  num: number,
): Promise<boolean> {
  if (!await discard(mineflayer, itemType, num)) {
    return false
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Clean up playerCollect listener when timeout occurs
      // eslint-disable-next-line ts/no-use-before-define
      mineflayer.bot.removeListener('playerCollect', onCollect)
      resolve(false)
    }, 3000)

    const onCollect = (collector: any, _collected: any) => {
      if (collector.username === username) {
        log(mineflayer, `${username} received ${itemType}.`)
        clearTimeout(timeout)
        resolve(true)
      }
    }

    const onInterrupt = () => {
      clearTimeout(timeout)
      // Clean up playerCollect listener when interrupted
      mineflayer.bot.removeListener('playerCollect', onCollect)
      resolve(false)
    }

    mineflayer.bot.once('playerCollect', onCollect)
    mineflayer.once('interrupt', onInterrupt)
  })
}
