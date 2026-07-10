import type { Entity } from 'prismarine-entity'

import type { Mineflayer } from '../libs/mineflayer'

import pathfinder from 'mineflayer-pathfinder'

import { randomInt } from 'es-toolkit'
import { Vec3 } from 'vec3'

import { abortableSleep, ActionAbortedError, raceWithAbort, throwIfAborted } from '../libs/mineflayer/action-abort'
import { emitFallbackMonitor } from '../libs/monitor-event-bus'
import { useLogger } from '../utils/logger'
import { matchesEntityQuery, resolveBlockQueryTypes, resolveEntityQueryTypes } from '../utils/query-normalizer'
import { log } from './base'
import { getBlockAtAccurate, getNearestBlocksAccurate } from './block-access'
import { getNearestEntityWhere } from './world'

const logger = useLogger()
const { goals, Movements } = pathfinder
const MAX_MOVE_AWAY_POSITION_ATTEMPTS = 32
const GO_TO_BED_SLEEP_TIMEOUT_MS = 30_000
const SWIM_UPWARD_DURATION_MS = 4_000
const SUBMERGED_RELOCATION_TIMEOUT_MS = 180_000
const UNDERGROUND_RELOCATION_TIMEOUT_MS = 20_000
const SURFACE_RELOCATION_TIMEOUT_MS = 30_000
const HORIZONTAL_TARGET_APPROACH_RADIUS = 3
const MOVEMENT_SAFETY_POLL_MS = 500
const MAX_SURFACE_RELOCATION_DESCENT = 3
const MAX_RELOCATION_HEALTH_DROP = 4
const MIN_SAFE_RELOCATION_HEALTH = 10
const MANUAL_SWIM_TICK_MS = 200
const MANUAL_SWIM_TIMEOUT_MS = 12_000
const MANUAL_SWIM_ARRIVAL_DISTANCE = 1.5
const MANUAL_SWIM_NO_PROGRESS_LIMIT = 12
const UNSAFE_SURFACE_RELOCATION_SUPPORT_BLOCKS = [
  'air',
  'cave_air',
  'void_air',
  'water',
  'lava',
  'powder_snow',
  'fire',
  'soul_fire',
]

async function getWaterloggedProbe(mineflayer: Mineflayer): Promise<{ submerged: boolean, blockNames: string[] }> {
  if (typeof mineflayer.bot.blockAt !== 'function') {
    return { submerged: false, blockNames: [] }
  }

  const position = mineflayer.bot.entity.position
  const base = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
  const probes = [
    base,
    base.offset(0, 1, 0),
    base.offset(1, 0, 0),
    base.offset(-1, 0, 0),
    base.offset(0, 0, 1),
    base.offset(0, 0, -1),
  ]
  const syncBlocks = probes.map(probe => mineflayer.bot.blockAt(probe))
  const normalizeBlockName = (name: string | undefined): string => name?.replace(/^minecraft:/, '') ?? 'unknown'
  const syncNames = syncBlocks.map(block => normalizeBlockName(block?.name))

  if ((mineflayer.bot.oxygenLevel ?? 20) < 20 || syncNames.includes('water')) {
    return { submerged: true, blockNames: syncNames }
  }

  const accurateBlocks = await Promise.all(probes.map(probe => getBlockAtAccurate(mineflayer, probe)))
  const accurateNames = accurateBlocks.map(block => normalizeBlockName(block?.name))

  return {
    submerged: accurateNames.includes('water'),
    blockNames: accurateNames,
  }
}

function isOpenAirLike(name: string): boolean {
  return ['air', 'cave_air', 'void_air'].includes(name)
}

function looksConfinedAtCurrentElevation(blockNames: string[]): boolean {
  const solidOrUnknownSides = blockNames.filter(name => !isOpenAirLike(name) && name !== 'water').length
  return solidOrUnknownSides >= 4
}

function getFiniteBotMetric(value: unknown, fallback: number): number {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : fallback
}

function isSafeSurfaceRelocationSupportBlockName(name: string | undefined): boolean {
  return typeof name === 'string'
    && !UNSAFE_SURFACE_RELOCATION_SUPPORT_BLOCKS.includes(name.replace(/^minecraft:/, ''))
}

async function hasSafeMoveAwaySupport(
  mineflayer: Mineflayer,
  x: number,
  y: number,
  z: number,
  submerged: boolean,
  allowUnknownSupport: boolean,
): Promise<boolean> {
  if (submerged) {
    return true
  }

  const supportPosition = new Vec3(x, y - 1, z)
  const syncBlock = typeof mineflayer.bot.blockAt === 'function'
    ? mineflayer.bot.blockAt(supportPosition)
    : null
  if (syncBlock) {
    return isSafeSurfaceRelocationSupportBlockName(syncBlock.name)
  }

  const accurateBlock = await getBlockAtAccurate(mineflayer, supportPosition)
  if (!accurateBlock) {
    return allowUnknownSupport
  }

  return isSafeSurfaceRelocationSupportBlockName(accurateBlock?.name)
}

function getRelocationSafetyFailure(
  mineflayer: Mineflayer,
  startY: number,
  startHealth: number,
  label: string,
): string | null {
  const currentPosition = mineflayer.bot.entity?.position
  if (!currentPosition) {
    return null
  }

  if (startY >= 60 && currentPosition.y < startY - MAX_SURFACE_RELOCATION_DESCENT) {
    return `${label} descended from y=${startY.toFixed(1)} to y=${currentPosition.y.toFixed(1)}`
  }

  const health = getFiniteBotMetric(mineflayer.bot.health, startHealth)
  if (
    (startHealth > MIN_SAFE_RELOCATION_HEALTH && health <= MIN_SAFE_RELOCATION_HEALTH)
    || health < startHealth - MAX_RELOCATION_HEALTH_DROP
  ) {
    return `${label} health dropped from ${startHealth.toFixed(1)} to ${health.toFixed(1)}`
  }

  return null
}

async function gotoWithTimeout(
  mineflayer: Mineflayer,
  goal: unknown,
  timeoutMs: number,
  label: string,
  safetyCheck?: () => string | null,
): Promise<void> {
  const signal = mineflayer.currentActionSignal
  throwIfAborted(signal)
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let safetyHandle: ReturnType<typeof setInterval> | undefined
  let safetyReject: ((error: Error) => void) | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      try {
        mineflayer.bot.pathfinder.stop()
      }
      catch {
        // Ignore stop failures; the timeout still needs to return control to the caller.
      }
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  const safetyPromise = new Promise<never>((_, reject) => {
    safetyReject = reject
  })

  if (safetyCheck) {
    safetyHandle = setInterval(() => {
      const safetyFailure = safetyCheck()
      if (!safetyFailure) {
        return
      }

      try {
        mineflayer.bot.pathfinder.stop()
      }
      catch {
        // Ignore stop failures; the safety interrupt still needs to return control.
      }
      safetyReject?.(new Error(`${label} stopped for safety: ${safetyFailure}`))
    }, MOVEMENT_SAFETY_POLL_MS)
  }

  try {
    await raceWithAbort(Promise.race([
      mineflayer.bot.pathfinder.goto(goal as any),
      timeoutPromise,
      safetyPromise,
    ]), signal)
    throwIfAborted(signal)
  }
  finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
    if (safetyHandle) {
      clearInterval(safetyHandle)
    }
  }
}

export async function goToPosition(
  mineflayer: Mineflayer,
  x: number,
  y: number,
  z: number,
  minDistance = 2,
): Promise<boolean> {
  if (x == null || y == null || z == null) {
    log(mineflayer, `Missing coordinates, given x:${x} y:${y} z:${z}`)
    return false
  }

  if (mineflayer.allowCheats) {
    mineflayer.bot.chat(`/tp @s ${x} ${y} ${z}`)
    log(mineflayer, `Teleported to ${x}, ${y}, ${z}.`)
    return true
  }

  try {
    const waterloggedProbe = await getWaterloggedProbe(mineflayer)
    const confined = looksConfinedAtCurrentElevation(waterloggedProbe.blockNames)
    const underground = mineflayer.bot.entity.position.y < 60
    const startY = getFiniteBotMetric(mineflayer.bot.entity.position.y, y)
    const startHealth = getFiniteBotMetric(mineflayer.bot.health, 20)
    const goal = new goals.GoalNear(x, y, z, minDistance)
    ;(goal as pathfinder.goals.GoalNear & { timeoutMs?: number, movementMode?: 'walk' | 'swim' }).timeoutMs = waterloggedProbe.submerged
      ? SUBMERGED_RELOCATION_TIMEOUT_MS
      : underground || confined
        ? UNDERGROUND_RELOCATION_TIMEOUT_MS
        : SURFACE_RELOCATION_TIMEOUT_MS
    ;(goal as pathfinder.goals.GoalNear & { timeoutMs?: number, movementMode?: 'walk' | 'swim' }).movementMode = waterloggedProbe.submerged
      ? 'swim'
      : 'walk'
    await gotoWithTimeout(
      mineflayer,
      goal,
      (goal as pathfinder.goals.GoalNear & { timeoutMs: number }).timeoutMs,
      'goToPosition',
      () => getRelocationSafetyFailure(mineflayer, startY, startHealth, 'goToPosition'),
    )
    log(mineflayer, `You have reached ${x}, ${y}, ${z}.`)
    return true
  }
  catch (err) {
    if (err instanceof ActionAbortedError) {
      throw err
    }
    log(mineflayer, `I failed to reach ${x}, ${y}, ${z}: ${(err as Error).message}`)
    return false
  }
}

export async function goToNearestBlock(
  mineflayer: Mineflayer,
  blockType: string,
  minDistance = 2,
  range = 64,
): Promise<boolean> {
  const MAX_RANGE = 512
  if (range > MAX_RANGE) {
    log(mineflayer, `Maximum search range capped at ${MAX_RANGE}.`)
    range = MAX_RANGE
  }

  const candidateTypes = resolveBlockQueryTypes(blockType)
  if (candidateTypes.length === 0) {
    log(mineflayer, `Invalid block query: ${blockType}.`)
    return false
  }
  const block = (await getNearestBlocksAccurate(mineflayer, candidateTypes, range, 1))[0]
  if (!block) {
    log(mineflayer, `Could not find any ${blockType} in ${range} blocks.`)
    return false
  }

  log(mineflayer, `Found ${block.name} at ${block.position}.`)
  await goToPosition(mineflayer, block.position.x, block.position.y, block.position.z, minDistance)
  return true
}

export async function goToNearestEntity(
  mineflayer: Mineflayer,
  entityType: string,
  minDistance = 2,
  range = 64,
): Promise<boolean> {
  const candidateTypes = resolveEntityQueryTypes(entityType)
  if (candidateTypes.length === 0) {
    log(mineflayer, `Invalid entity query: ${entityType}.`)
    return false
  }
  const entity = getNearestEntityWhere(
    mineflayer,
    entity => matchesEntityQuery(entityType, entity),
    range,
  )

  if (!entity) {
    log(mineflayer, `Could not find any ${entityType} in ${range} blocks.`)
    return false
  }

  const distance = mineflayer.bot.entity.position.distanceTo(entity.position)
  log(mineflayer, `Found ${entityType} ${distance} blocks away.`)
  await goToPosition(
    mineflayer,
    entity.position.x,
    entity.position.y,
    entity.position.z,
    minDistance,
  )
  return true
}

export async function goToPlayer(
  mineflayer: Mineflayer,
  username: string,
  distance = 3,
): Promise<boolean> {
  const signal = mineflayer.currentActionSignal
  throwIfAborted(signal)
  if (mineflayer.allowCheats) {
    mineflayer.bot.chat(`/tp @s ${username}`)
    log(mineflayer, `Teleported to ${username}.`)
    return true
  }

  const player = mineflayer.bot.players[username]?.entity
  if (!player) {
    log(mineflayer, `Could not find ${username}.`)
    return false
  }

  await raceWithAbort(mineflayer.bot.pathfinder.goto(new goals.GoalFollow(player, distance)), signal)
  throwIfAborted(signal)
  log(mineflayer, `You have reached ${username}.`)
  return true
}

export async function followPlayer(
  mineflayer: Mineflayer,
  username: string,
  distance = 4,
): Promise<boolean> {
  const signal = mineflayer.currentActionSignal
  throwIfAborted(signal)
  const player = mineflayer.bot.players[username]?.entity
  if (!player) {
    return false
  }

  log(mineflayer, `I am now actively following player ${username}.`)

  const movements = new Movements(mineflayer.bot)
  mineflayer.bot.pathfinder.setMovements(movements)
  mineflayer.bot.pathfinder.setGoal(new goals.GoalFollow(player, distance), true)
  throwIfAborted(signal)

  mineflayer.once('interrupt', () => {
    mineflayer.bot.pathfinder.stop()
  })

  return true
}

export async function moveAway(mineflayer: Mineflayer, distance: number): Promise<boolean> {
  try {
    const pos = mineflayer.bot.entity.position
    const startY = pos.y
    const startHealth = getFiniteBotMetric(mineflayer.bot.health, 20)
    const waterloggedProbe = await getWaterloggedProbe(mineflayer)
    const submerged = waterloggedProbe.submerged
    const underground = mineflayer.bot.entity.position.y < 60
    const confined = looksConfinedAtCurrentElevation(waterloggedProbe.blockNames)
    let newX: number = 0
    let newZ: number = 0
    let suitableGoal = false

    for (let attempt = 0; attempt < MAX_MOVE_AWAY_POSITION_ATTEMPTS; attempt++) {
      throwIfAborted(mineflayer.currentActionSignal)
      const rand1 = randomInt(0, 2)
      const rand2 = randomInt(0, 2)
      const bigRand1 = randomInt(0, 101)
      const bigRand2 = randomInt(0, 101)

      newX = Math.floor(
        pos.x + ((distance * bigRand1) / 100) * (rand1 ? 1 : -1),
      )
      newZ = Math.floor(
        pos.z + ((distance * bigRand2) / 100) * (rand2 ? 1 : -1),
      )

      if (await hasSafeMoveAwaySupport(mineflayer, newX, Math.floor(pos.y), newZ, submerged, underground)) {
        suitableGoal = true
        break
      }
    }

    if (!suitableGoal) {
      const fallbackOffsets = [
        new Vec3(distance, 0, 0),
        new Vec3(-distance, 0, 0),
        new Vec3(0, 0, distance),
        new Vec3(0, 0, -distance),
      ]

      for (const offset of fallbackOffsets) {
        throwIfAborted(mineflayer.currentActionSignal)
        const fallbackX = Math.floor(pos.x + offset.x)
        const fallbackZ = Math.floor(pos.z + offset.z)
        if (await hasSafeMoveAwaySupport(mineflayer, fallbackX, Math.floor(pos.y), fallbackZ, submerged, underground)) {
          newX = fallbackX
          newZ = fallbackZ
          suitableGoal = true
          break
        }
      }
    }

    if (!suitableGoal) {
      if (!submerged) {
        logger.withFields({ distance }).warn('moveAway aborted after exhausting safe surface destination sampling')
        emitFallbackMonitor({
          scope: 'skills.moveAway',
          reason: 'safe-surface-destination-sampling-exhausted',
          detail: `moveAway aborted after exhausting safe surface destination sampling (distance=${distance}).`,
          from: 'safe-destination-sampling',
          to: 'abort-unsafe-relocation',
          recoverable: true,
        }, { throttleMs: 10_000 })
        return false
      }

      newX = Math.floor(pos.x + distance)
      newZ = Math.floor(pos.z)
      logger.withFields({ distance, newX, newZ }).warn('moveAway fallback used after exhausting safe destination sampling')
      emitFallbackMonitor({
        scope: 'skills.moveAway',
        reason: 'safe-destination-sampling-exhausted',
        detail: `moveAway fallback used after exhausting safe destination sampling (distance=${distance}).`,
        from: 'safe-destination-sampling',
        to: 'forced-axis-offset',
        recoverable: true,
      }, { throttleMs: 10_000 })
    }

    if (submerged || underground || confined) {
      logger.withFields({
        submerged,
        confined,
        y: mineflayer.bot.entity.position.y,
        blockNames: waterloggedProbe.blockNames,
      }).log('moveAway waterlogged probe')
    }
    const relocationTimeoutMs = submerged
      ? SUBMERGED_RELOCATION_TIMEOUT_MS
      : underground || confined
        ? UNDERGROUND_RELOCATION_TIMEOUT_MS
        : SURFACE_RELOCATION_TIMEOUT_MS
    const farGoal = submerged
      ? new pathfinder.goals.GoalXZ(newX, newZ)
      : new pathfinder.goals.GoalNear(newX, Math.floor(startY), newZ, 3)
    ;(farGoal as (pathfinder.goals.GoalXZ | pathfinder.goals.GoalNear) & { timeoutMs?: number, movementMode?: 'walk' | 'swim' }).timeoutMs = relocationTimeoutMs
    ;(farGoal as (pathfinder.goals.GoalXZ | pathfinder.goals.GoalNear) & { timeoutMs?: number, movementMode?: 'walk' | 'swim' }).movementMode = submerged
      ? 'swim'
      : 'walk'

    await gotoWithTimeout(
      mineflayer,
      farGoal,
      relocationTimeoutMs,
      'moveAway',
      () => getRelocationSafetyFailure(mineflayer, startY, startHealth, 'moveAway'),
    )
    const newPos = mineflayer.bot.entity.position
    logger.log(`I moved away from nearest entity to ${newPos}.`)
    await abortableSleep(500, mineflayer.currentActionSignal)
    return true
  }
  catch (err) {
    if (err instanceof ActionAbortedError) {
      throw err
    }
    logger.log(`I failed to move away: ${(err as Error).message}`)
    return false
  }
}

export async function moveToHorizontalTarget(
  mineflayer: Mineflayer,
  x: number,
  z: number,
): Promise<boolean> {
  try {
    const waterloggedProbe = await getWaterloggedProbe(mineflayer)
    const submerged = waterloggedProbe.submerged
    const underground = mineflayer.bot.entity.position.y < 60
    const confined = looksConfinedAtCurrentElevation(waterloggedProbe.blockNames)
    const startY = getFiniteBotMetric(mineflayer.bot.entity.position.y, 64)
    const startHealth = getFiniteBotMetric(mineflayer.bot.health, 20)
    if (submerged || underground || confined) {
      logger.withFields({
        submerged,
        confined,
        y: mineflayer.bot.entity.position.y,
        blockNames: waterloggedProbe.blockNames,
      }).log('moveToHorizontalTarget waterlogged probe')
    }
    const relocationTimeoutMs = submerged
      ? SUBMERGED_RELOCATION_TIMEOUT_MS
      : underground || confined
        ? UNDERGROUND_RELOCATION_TIMEOUT_MS
        : SURFACE_RELOCATION_TIMEOUT_MS
    const goal = new pathfinder.goals.GoalNearXZ(
      Math.floor(x),
      Math.floor(z),
      HORIZONTAL_TARGET_APPROACH_RADIUS,
    )
    ;(goal as pathfinder.goals.GoalNearXZ & { timeoutMs?: number, movementMode?: 'walk' | 'swim' }).timeoutMs = relocationTimeoutMs
    ;(goal as pathfinder.goals.GoalNearXZ & { timeoutMs?: number, movementMode?: 'walk' | 'swim' }).movementMode = submerged
      ? 'swim'
      : 'walk'
    await gotoWithTimeout(
      mineflayer,
      goal,
      relocationTimeoutMs,
      'moveToHorizontalTarget',
      () => getRelocationSafetyFailure(mineflayer, startY, startHealth, 'moveToHorizontalTarget'),
    )
    const newPos = mineflayer.bot.entity.position
    logger.log(`I moved toward relocation target ${Math.floor(x)}, ${Math.floor(z)} and reached ${newPos}.`)
    await abortableSleep(500, mineflayer.currentActionSignal)
    return true
  }
  catch (err) {
    if (err instanceof ActionAbortedError) {
      throw err
    }
    logger.log(`I failed to move toward relocation target: ${(err as Error).message}`)
    return false
  }
}

export async function swimUpward(
  mineflayer: Mineflayer,
  durationMs = SWIM_UPWARD_DURATION_MS,
): Promise<boolean> {
  const startY = mineflayer.bot.entity.position.y

  try {
    mineflayer.bot.setControlState('jump', true)
    await abortableSleep(durationMs, mineflayer.currentActionSignal)
  }
  catch (err) {
    if (err instanceof ActionAbortedError) {
      throw err
    }
    logger.log(`I failed to swim upward: ${(err as Error).message}`)
    return false
  }
  finally {
    mineflayer.bot.setControlState('jump', false)
  }

  const endY = mineflayer.bot.entity.position.y
  const roseBy = endY - startY
  logger.withFields({ startY, endY, roseBy }).log('Swim upward attempt completed')
  return roseBy >= 2
}

export async function swimTowardPositionManual(
  mineflayer: Mineflayer,
  x: number,
  y: number,
  z: number,
  options?: {
    timeoutMs?: number
    arrivalDistance?: number
  },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? MANUAL_SWIM_TIMEOUT_MS
  const arrivalDistance = options?.arrivalDistance ?? MANUAL_SWIM_ARRIVAL_DISTANCE
  const target = new Vec3(x, y, z)
  const toVec3 = (position: { x: number, y: number, z: number }) =>
    new Vec3(position.x, position.y, position.z)
  const start = toVec3(mineflayer.bot.entity.position)
  const startTime = Date.now()
  const startDistance = start.distanceTo(target)
  let lastPosition = start
  let noProgressTicks = 0
  let bestDistance = startDistance
  let bestY = start.y

  const clearControls = () => {
    mineflayer.bot.setControlState('forward', false)
    mineflayer.bot.setControlState('left', false)
    mineflayer.bot.setControlState('right', false)
    mineflayer.bot.setControlState('sprint', false)
    mineflayer.bot.setControlState('jump', false)
  }

  try {
    while (Date.now() - startTime < timeoutMs) {
      throwIfAborted(mineflayer.currentActionSignal)
      const currentPosition = mineflayer.bot.entity.position
      const currentVec = toVec3(currentPosition)
      const distance = currentVec.distanceTo(target)
      bestDistance = Math.min(bestDistance, distance)
      bestY = Math.max(bestY, currentVec.y)
      if (distance <= arrivalDistance) {
        logger.withFields({ x, y, z, distance }).log('Manual swim reached local escape target')
        return true
      }

      const stagedTarget = new Vec3(
        target.x,
        Math.min(target.y, currentVec.y + 1.5),
        target.z,
      )
      await mineflayer.bot.lookAt(stagedTarget, true)
      mineflayer.bot.setControlState('forward', true)
      mineflayer.bot.setControlState('sprint', true)
      mineflayer.bot.setControlState('jump', true)

      const yaw = mineflayer.bot.entity.yaw ?? 0
      const xzDistance = Math.hypot(target.x - currentPosition.x, target.z - currentPosition.z)
      if (xzDistance < 0.8) {
        mineflayer.bot.setControlState('left', false)
        mineflayer.bot.setControlState('right', false)
      }
      else {
        const targetYaw = Math.atan2(-(target.x - currentPosition.x), target.z - currentPosition.z)
        const deltaYaw = Math.atan2(Math.sin(targetYaw - yaw), Math.cos(targetYaw - yaw))
        const alternatingStrafe = noProgressTicks >= 4
          ? (noProgressTicks % 2 === 0 ? 'left' : 'right')
          : null
        mineflayer.bot.setControlState('left', alternatingStrafe === 'left' || deltaYaw > 0.35)
        mineflayer.bot.setControlState('right', alternatingStrafe === 'right' || deltaYaw < -0.35)
      }

      await abortableSleep(MANUAL_SWIM_TICK_MS, mineflayer.currentActionSignal)

      const nextPosition = toVec3(mineflayer.bot.entity.position)
      const movedBy = nextPosition.distanceTo(lastPosition)
      if (movedBy < 0.05) {
        noProgressTicks++
      }
      else {
        noProgressTicks = 0
        lastPosition = nextPosition
      }

      if (noProgressTicks >= MANUAL_SWIM_NO_PROGRESS_LIMIT) {
        const madeMeaningfulProgress = bestY >= start.y + 1 || bestDistance <= startDistance - 1
        logger.withFields({ x, y, z, noProgressTicks, bestY, bestDistance, startDistance, madeMeaningfulProgress }).warn('Manual swim stalled before reaching local escape target')
        return madeMeaningfulProgress
      }
    }
  }
  catch (err) {
    if (err instanceof ActionAbortedError) {
      throw err
    }
    logger.log(`Manual swim failed: ${(err as Error).message}`)
    return false
  }
  finally {
    clearControls()
  }

  const finalDistance = mineflayer.bot.entity.position.distanceTo(target)
  const madeMeaningfulProgress = bestY >= start.y + 1 || bestDistance <= startDistance - 1
  logger.withFields({ x, y, z, finalDistance, bestY, bestDistance, startDistance, madeMeaningfulProgress }).warn('Manual swim timed out before reaching local escape target')
  return madeMeaningfulProgress
}

export async function moveAwayFromEntity(
  mineflayer: Mineflayer,
  entity: Entity,
  distance = 16,
): Promise<boolean> {
  const goal = new goals.GoalFollow(entity, distance)
  const invertedGoal = new goals.GoalInvert(goal)
  const signal = mineflayer.currentActionSignal
  throwIfAborted(signal)
  await raceWithAbort(mineflayer.bot.pathfinder.goto(invertedGoal), signal)
  throwIfAborted(signal)
  return true
}

export async function stay(mineflayer: Mineflayer, seconds = 30): Promise<boolean> {
  const start = Date.now()
  const targetTime = seconds === -1 ? Infinity : start + seconds * 1000

  while (Date.now() < targetTime) {
    await abortableSleep(500, mineflayer.currentActionSignal)
  }

  log(mineflayer, `I stayed for ${(Date.now() - start) / 1000} seconds.`)
  return true
}

export async function goToBed(mineflayer: Mineflayer): Promise<boolean> {
  let beds = mineflayer.bot.findBlocks({
    matching: (block: any) => block.name.includes('bed'),
    maxDistance: 32,
    count: 1,
  })

  // FabricBridge: try async scan if sync returned empty
  if (beds.length === 0 && 'findBlocksAsync' in mineflayer.bot) {
    beds = await (mineflayer.bot as any).findBlocksAsync({
      matching: (block: any) => block.name.includes('bed'),
      maxDistance: 32,
      count: 1,
    })
  }

  if (beds.length === 0) {
    log(mineflayer, 'I could not find a bed to sleep in.')
    return false
  }

  const loc = beds[0]
  await goToPosition(mineflayer, loc.x, loc.y, loc.z)

  let bed = mineflayer.bot.blockAt(loc)
  if (!bed && 'blockAtAsync' in mineflayer.bot) {
    bed = await (mineflayer.bot as any).blockAtAsync(loc)
  }
  if (!bed) {
    log(mineflayer, 'I could not find a bed to sleep in.')
    return false
  }

  try {
    throwIfAborted(mineflayer.currentActionSignal)
    await mineflayer.bot.sleep(bed)
    throwIfAborted(mineflayer.currentActionSignal)
  }
  catch (error) {
    if (error instanceof ActionAbortedError) {
      throw error
    }
    log(mineflayer, `I could not sleep in the bed: ${(error as Error).message}`)
    return false
  }
  log(mineflayer, 'I am in bed.')

  const sleepStartedAt = Date.now()
  while (mineflayer.bot.isSleeping) {
    throwIfAborted(mineflayer.currentActionSignal)
    if (Date.now() - sleepStartedAt > GO_TO_BED_SLEEP_TIMEOUT_MS) {
      try {
        if (typeof (mineflayer.bot as any).wake === 'function') {
          await (mineflayer.bot as any).wake()
        }
      }
      catch {
        /* noop */
      }
      log(mineflayer, 'Sleeping timed out before wake-up was observed.')
      return false
    }
    await abortableSleep(500, mineflayer.currentActionSignal)
  }

  log(mineflayer, 'I have woken up.')
  return true
}
