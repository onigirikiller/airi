import type { Entity } from 'prismarine-entity'
import type { Item } from 'prismarine-item'

import type { Mineflayer } from '../libs/mineflayer'

import pathfinderModel from 'mineflayer-pathfinder'

import { sleep } from '@moeru/std'

import { useLogger } from '../utils/logger'
import { isHostile } from '../utils/mcdata'
import { matchesEntityQuery } from '../utils/query-normalizer'
import { pickupNearbyItems } from './actions/world-interactions'
import { log } from './base'
import { findBestFoodItem } from './food'
import { shootBow } from './items'
import { getNearbyEntities, getNearestEntityWhere } from './world'

const combatLogger = useLogger()

const { goals } = pathfinderModel
const ATTACK_ENTITY_TIMEOUT_MS = 30_000
const ATTACK_ENTITY_NO_PROGRESS_TIMEOUT_MS = 8_000
const AQUATIC_ATTACK_NO_PROGRESS_TIMEOUT_MS = 12_000
const ATTACK_PURSUIT_RETRY_MS = 1_500
const ATTACK_PURSUIT_TIMEOUT_MS = 4_000
const DEFEND_SELF_TIMEOUT_MS = 20_000
const DEFEND_SELF_NO_PROGRESS_TIMEOUT_MS = 6_000
const AQUATIC_FOOD_ENTITY_TYPES = new Set(['cod', 'salmon', 'tropical_fish'])
const WATERLIKE_BLOCKS = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column'])

interface WeaponItem extends Item {
  attackDamage: number
}

function normalizeEntityToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/\s+/g, '_')
}

function isAquaticFoodEntity(entity: Entity): boolean {
  const normalizedName = normalizeEntityToken(entity.name)
  const normalizedType = normalizeEntityToken(entity.type)
  return AQUATIC_FOOD_ENTITY_TYPES.has(normalizedName) || AQUATIC_FOOD_ENTITY_TYPES.has(normalizedType)
}

function isWaterLikeBlockName(name: unknown): boolean {
  return WATERLIKE_BLOCKS.has(normalizeEntityToken(name))
}

function isEntityInWater(mineflayer: Mineflayer, entity: Entity): boolean {
  if (!entity?.position || typeof mineflayer.bot.blockAt !== 'function') {
    return false
  }

  const feetBlock = mineflayer.bot.blockAt(entity.position.floored())
  const headBlock = mineflayer.bot.blockAt(entity.position.offset(0, 1, 0).floored())
  return isWaterLikeBlockName(feetBlock?.name) || isWaterLikeBlockName(headBlock?.name)
}

async function pursueAttackTarget(
  mineflayer: Mineflayer,
  entity: Entity,
  swimMode: boolean,
): Promise<boolean> {
  const trackedEntity = getTrackedEntity(mineflayer, entity) ?? entity
  const goal = new goals.GoalNear(
    trackedEntity.position.x,
    trackedEntity.position.y,
    trackedEntity.position.z,
    swimMode ? 2.5 : 3.5,
  ) as pathfinderModel.goals.GoalNear & { timeoutMs?: number, movementMode?: 'walk' | 'swim' }
  goal.timeoutMs = ATTACK_PURSUIT_TIMEOUT_MS
  goal.movementMode = swimMode ? 'swim' : 'walk'

  try {
    await mineflayer.bot.pathfinder.goto(goal)
    return true
  }
  catch {
    return false
  }
}

function getTrackedEntity(mineflayer: Mineflayer, entity: Entity): Entity | null {
  return mineflayer.bot.entities[entity.id] ?? null
}

function stopCombatActions(mineflayer: Mineflayer): void {
  try {
    mineflayer.bot.pvp.stop()
  }
  catch {
    /* noop */
  }

  try {
    mineflayer.bot.pathfinder.stop()
  }
  catch {
    /* noop */
  }
}

function removeInterruptHandler(mineflayer: Mineflayer, handler: () => void): void {
  if (typeof mineflayer.off === 'function') {
    mineflayer.off('interrupt', handler)
    return
  }
  if (typeof (mineflayer as any).removeListener === 'function') {
    (mineflayer as any).removeListener('interrupt', handler)
  }
}

async function equipHighestAttack(mineflayer: Mineflayer): Promise<void> {
  const weapons = mineflayer.bot.inventory.items().filter(item =>
    item.name.includes('sword')
    || (item.name.includes('axe') && !item.name.includes('pickaxe')),
  ) as WeaponItem[]

  if (weapons.length === 0) {
    const tools = mineflayer.bot.inventory.items().filter(item =>
      item.name.includes('pickaxe')
      || item.name.includes('shovel'),
    ) as WeaponItem[]

    if (tools.length === 0)
      return

    tools.sort((a, b) => b.attackDamage - a.attackDamage)
    const tool = tools[0]
    if (tool)
      await mineflayer.bot.equip(tool, 'hand')
    return
  }

  weapons.sort((a, b) => b.attackDamage - a.attackDamage)
  const weapon = weapons[0]
  if (weapon)
    await mineflayer.bot.equip(weapon, 'hand')
}

export async function attackNearest(
  mineflayer: Mineflayer,
  mobType: string,
  kill = true,
): Promise<boolean> {
  const normalizedType = normalizeEntityToken(mobType)
  const nearbyMatches = getNearbyEntities(mineflayer, 24)
    .filter(entity => matchesEntityQuery(mobType, entity))
    .sort((left, right) => {
      const leftDistance = mineflayer.bot.entity.position.distanceTo(left.position)
      const rightDistance = mineflayer.bot.entity.position.distanceTo(right.position)
      if (normalizedType === 'animal') {
        const aquaticDelta = Number(isAquaticFoodEntity(left)) - Number(isAquaticFoodEntity(right))
        if (aquaticDelta !== 0) {
          return aquaticDelta
        }
      }
      return leftDistance - rightDistance
    })
  const mob = nearbyMatches[0]

  if (mob) {
    return await attackEntity(mineflayer, mob, kill)
  }

  log(mineflayer, `Could not find any ${mobType} to attack.`)
  return false
}

export async function attackEntity(
  mineflayer: Mineflayer,
  entity: Entity,
  kill = true,
): Promise<boolean> {
  const pos = entity.position
  const aquaticTarget = isAquaticFoodEntity(entity) || isEntityInWater(mineflayer, entity)
  await equipHighestAttack(mineflayer)

  if (!kill) {
    if (mineflayer.bot.entity.position.distanceTo(pos) > 5) {
      await pursueAttackTarget(mineflayer, entity, aquaticTarget)
    }
    await mineflayer.bot.attack(entity)
    return true
  }

  let interrupted = false
  const onInterrupt = () => {
    interrupted = true
    stopCombatActions(mineflayer)
  }
  mineflayer.once('interrupt', onInterrupt)

  const startedAt = Date.now()
  let lastProgressAt = startedAt
  let bestDistance = mineflayer.bot.entity.position.distanceTo(pos)
  let lastPursuitAt = 0
  const noProgressTimeoutMs = aquaticTarget
    ? AQUATIC_ATTACK_NO_PROGRESS_TIMEOUT_MS
    : ATTACK_ENTITY_NO_PROGRESS_TIMEOUT_MS

  const maybePursueTarget = async (target: Entity): Promise<void> => {
    const now = Date.now()
    if ((now - lastPursuitAt) < ATTACK_PURSUIT_RETRY_MS) {
      return
    }

    lastPursuitAt = now
    const pursued = await pursueAttackTarget(mineflayer, target, aquaticTarget)
    if (!pursued) {
      return
    }

    const trackedTarget = getTrackedEntity(mineflayer, target) ?? target
    const distanceAfterPursuit = mineflayer.bot.entity.position.distanceTo(trackedTarget.position)
    if (distanceAfterPursuit + 0.25 < bestDistance) {
      bestDistance = distanceAfterPursuit
      lastProgressAt = Date.now()
    }
  }

  try {
    if (bestDistance > (aquaticTarget ? 3.5 : 4.5)) {
      await maybePursueTarget(entity)
    }

    mineflayer.bot.pvp.attack(entity)
    while (Date.now() - startedAt < ATTACK_ENTITY_TIMEOUT_MS) {
      if (interrupted) {
        log(mineflayer, `Attack on ${entity.name} was interrupted.`)
        return false
      }

      const trackedEntity = getTrackedEntity(mineflayer, entity)
      if (!trackedEntity) {
        await sleep(400)
        await pickupNearbyItems(mineflayer, 6)
        log(mineflayer, `Successfully killed ${entity.name}.`)
        return true
      }

      const distance = mineflayer.bot.entity.position.distanceTo(trackedEntity.position)
      if (distance + 0.5 < bestDistance) {
        bestDistance = distance
        lastProgressAt = Date.now()
      }

      if (distance > (aquaticTarget ? 3.25 : 4.5)) {
        await maybePursueTarget(trackedEntity)
      }

      if (distance <= 4) {
        try {
          await mineflayer.bot.lookAt(trackedEntity.position.offset(0, Math.max(0.5, (trackedEntity as { height?: number }).height ?? 0.6), 0), true)
          await mineflayer.bot.attack(trackedEntity)
        }
        catch {
          /* noop */
        }
      }

      if (Date.now() - lastProgressAt > noProgressTimeoutMs) {
        log(mineflayer, `Attack on ${entity.name} stalled due to no combat progress.`)
        return false
      }

      await sleep(500)
    }

    log(mineflayer, `Attack on ${entity.name} timed out.`)
    return false
  }
  finally {
    removeInterruptHandler(mineflayer, onInterrupt)
    stopCombatActions(mineflayer)
  }
}

export async function defendSelf(mineflayer: Mineflayer, range = 9): Promise<boolean> {
  let attacked = false
  let interrupted = false
  let lastProgressAt = Date.now()
  const startedAt = Date.now()
  let lastEnemyId: number | null = null
  let lastHostileCount = getNearbyEntities(mineflayer, range).filter(entity => isHostile(entity)).length
  const onInterrupt = () => {
    interrupted = true
    stopCombatActions(mineflayer)
  }

  mineflayer.once('interrupt', onInterrupt)

  try {
    while (Date.now() - startedAt < DEFEND_SELF_TIMEOUT_MS) {
      if (interrupted) {
        log(mineflayer, 'Defend self interrupted.')
        return false
      }
      const enemy = getNearestEntityWhere(mineflayer, entity => isHostile(entity), range)
      if (!enemy) {
        break
      }

      await equipHighestAttack(mineflayer)

      if (enemy.id !== lastEnemyId) {
        lastEnemyId = enemy.id
        lastProgressAt = Date.now()
      }

      if (mineflayer.bot.entity.position.distanceTo(enemy.position) >= 4
        && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
        try {
          const goal = new goals.GoalFollow(enemy, 3.5)
          await mineflayer.bot.pathfinder.goto(goal)
        }
        catch { /* might error if entity dies, ignore */ }
      }

      if (mineflayer.bot.entity.position.distanceTo(enemy.position) <= 2) {
        try {
          const followGoal = new goals.GoalFollow(enemy, 2)
          const invertedGoal = new goals.GoalInvert(followGoal)
          await mineflayer.bot.pathfinder.goto(invertedGoal)
        }
        catch { /* might error if entity dies, ignore */ }
      }

      mineflayer.bot.pvp.attack(enemy)
      attacked = true
      await sleep(500)

      const hostileCount = getNearbyEntities(mineflayer, range).filter(entity => isHostile(entity)).length
      if (hostileCount < lastHostileCount) {
        lastProgressAt = Date.now()
      }
      lastHostileCount = hostileCount

      if (Date.now() - lastProgressAt > DEFEND_SELF_NO_PROGRESS_TIMEOUT_MS) {
        log(mineflayer, 'Defend self stalled due to unreachable or persistent hostiles.')
        return false
      }
    }

    if (Date.now() - startedAt >= DEFEND_SELF_TIMEOUT_MS && getNearestEntityWhere(mineflayer, entity => isHostile(entity), range)) {
      log(mineflayer, 'Defend self timed out.')
      return false
    }

    if (attacked) {
      log(mineflayer, 'Successfully defended self.')
    }
    else {
      log(mineflayer, 'No enemies nearby to defend self from.')
    }
    return attacked
  }
  finally {
    removeInterruptHandler(mineflayer, onInterrupt)
    stopCombatActions(mineflayer)
  }
}

/**
 * Ranged attack: shoot bow at a target entity multiple times.
 */
export async function rangedAttack(
  mineflayer: Mineflayer,
  entityType: string,
  maxShots: number = 5,
): Promise<boolean> {
  try {
    for (let shot = 0; shot < maxShots; shot++) {
      const target = getNearbyEntities(mineflayer, 48).find(entity =>
        matchesEntityQuery(entityType, entity),
      )

      if (!target) {
        log(mineflayer, `No ${entityType} target found.`)
        return shot > 0
      }

      const pos = target.position ?? (target as any)
      const targetX = pos.x ?? 0
      const targetY = (pos.y ?? 0) + ((target as any).height ?? 1.0)
      const targetZ = pos.z ?? 0

      const success = await shootBow(mineflayer, targetX, targetY, targetZ, 1000)
      if (!success) {
        log(mineflayer, 'Failed to shoot bow.')
        return shot > 0
      }

      await sleep(500)
    }

    log(mineflayer, `Fired ${maxShots} arrows at ${entityType}.`)
    return true
  }
  catch (err) {
    combatLogger.withError(err).error('rangedAttack failed')
    return false
  }
}

/**
 * Critical attack: jump and hit while falling for bonus damage.
 */
export async function criticalAttackEntity(
  mineflayer: Mineflayer,
  entity: Entity,
): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any
    await equipHighestAttack(mineflayer)

    // Move to attack range
    if (bot.entity.position.distanceTo(entity.position) > 4) {
      const goal = new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 3)
      await bot.pathfinder.goto(goal)
    }

    if ('criticalAttack' in bot) {
      await bot.criticalAttack(entity.id)
      log(mineflayer, `Critical attack on ${entity.name}.`)
      return true
    }

    // Fallback: regular attack
    await bot.attack(entity)
    return true
  }
  catch (err) {
    combatLogger.withError(err).error('criticalAttack failed')
    return false
  }
}

/**
 * Block with shield for a duration.
 */
export async function shieldBlock(mineflayer: Mineflayer, durationMs: number = 2000): Promise<boolean> {
  try {
    const bot = mineflayer.bot as any

    if (!('shieldBlock' in bot)) {
      log(mineflayer, 'Shield blocking not supported.')
      return false
    }

    const shield = bot.inventory.items().find((i: any) => i.name === 'shield')
    if (!shield) {
      log(mineflayer, 'No shield in inventory.')
      return false
    }

    // Equip shield to offhand
    await bot.equip(shield, 'off-hand')
    await sleep(200)

    await bot.shieldBlock(true)
    await sleep(durationMs)
    await bot.shieldBlock(false)

    log(mineflayer, `Blocked with shield for ${durationMs}ms.`)
    return true
  }
  catch (err) {
    combatLogger.withError(err).error('shieldBlock failed')
    const bot = mineflayer.bot as any
    if ('shieldBlock' in bot) {
      await bot.shieldBlock(false).catch(() => {})
    }
    return false
  }
}

/**
 * Auto-eat: consume food when hunger is below threshold.
 */
export async function autoEat(mineflayer: Mineflayer, threshold: number = 14): Promise<boolean> {
  try {
    const bot = mineflayer.bot

    if (bot.food >= threshold) {
      return true
    }

    const foodItem = findBestFoodItem(bot.inventory.items())
    if (!foodItem) {
      log(mineflayer, 'No food available to eat.')
      return false
    }

    await bot.equip(foodItem, 'hand')
    await sleep(200)
    await bot.consume()
    await sleep(1800) // Wait for eating animation

    log(mineflayer, `Ate ${foodItem.name}.`)
    return true
  }
  catch (err) {
    combatLogger.withError(err).error('autoEat failed')
    return false
  }
}
