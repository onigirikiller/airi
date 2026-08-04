import type { Mineflayer } from '../libs/mineflayer'
import type { GameStateManager } from './state'

import { sleep } from '@moeru/std'
import { Vec3 } from 'vec3'

import { buildWorldStateSnapshot } from '../libs/llm-agent/world-state'
import { collectBlock } from '../skills/actions/collect-block'
import {
  ensureArrows,
  ensureAxe,
  ensureBow,
  ensureCoal,
  ensureCobblestone,
  ensureCraftingTable,
  ensureFurnaces,
  ensurePickaxe,
  ensureStoneTierPickaxe,
  ensureSword,
  ensureTorches,
} from '../skills/actions/ensure'
import { gatherWood } from '../skills/actions/gather-wood'
import { confirmItemCount, equip, getActualItemCount, getItemCount, refreshInventoryState } from '../skills/actions/inventory'
import { getBlockAtAccurate, getNearestBlocksAccurate } from '../skills/block-access'
import { breakBlockAt, placeBlock } from '../skills/blocks'
import { attackEntity, attackNearest, defendSelf, rangedAttack } from '../skills/combat'
import { craftRecipe, getLastCraftRecipeDiagnostic, smeltItem } from '../skills/crafting'
import { goToPosition, moveAway, moveToHorizontalTarget, swimTowardPositionManual, swimUpward } from '../skills/movement'
import { triangulateStronghold } from '../skills/navigation'
import { pillarUp } from '../skills/structures'
import { getInventoryCounts, getNearestBlock, getNearestBlocks, getNearestEntityWhere, getPosition } from '../skills/world'
import { useLogger } from '../utils/logger'
import {
  isSurfaceEscapePassable,
  looksLikeVerticalEscapeTrap,
  selectSurfaceEscapeScaffoldFromInventory,
} from '../utils/surface-recovery'
import { GamePhase } from './state'

const logger = useLogger()
const END_PORTAL_EYE_TARGET = 12
const STRONGHOLD_SEARCH_EYE_BUFFER = 2
const EARLY_GAME_COBBLESTONE_TARGET = 16
const SURFACE_ESCAPE_HAZARD_BLOCKS = new Set(['water', 'lava'])
const LOCAL_SURFACE_RECOVERY_CUE_QUERIES = [
  'grass_block',
  'dirt',
  'coarse_dirt',
  'podzol',
  'mycelium',
  'sand',
  'red_sand',
  'mud',
  'snow_block',
  'snow',
  'moss_block',
  'log',
  'leaves',
]
const PRIORITIZED_SURFACE_RECOVERY_CUE_QUERIES = ['grass_block', 'log', 'leaves', 'dirt', 'moss_block']

export interface PhaseResult {
  success: boolean
  message: string
  advance: boolean
}

function ok(message: string, advance = true): PhaseResult {
  return { success: true, message, advance }
}

function fail(message: string): PhaseResult {
  return { success: false, message, advance: false }
}

function progress(message: string): PhaseResult {
  return { success: true, message, advance: false }
}

function getRequiredEnderEyes(state: GameStateManager): number {
  return state.getLocation('stronghold')
    ? END_PORTAL_EYE_TARGET
    : END_PORTAL_EYE_TARGET + STRONGHOLD_SEARCH_EYE_BUFFER
}

function resumePrerequisitePhase(
  bot: Mineflayer,
  state: GameStateManager,
  currentPhase: GamePhase,
  message: string,
): PhaseResult {
  const fallbackPhase = determinePhase(bot, state)
  if (fallbackPhase !== currentPhase) {
    state.setPhase(fallbackPhase)
    return progress(message)
  }
  return fail(message)
}

function isBridgeCraftSyncBlocked(bot: Mineflayer): boolean {
  const diagnostic = getLastCraftRecipeDiagnostic(bot)
  if (!diagnostic) {
    return false
  }

  if (Date.now() - diagnostic.at > 15_000) {
    return false
  }

  return diagnostic.kind === 'inventory_sync_mismatch'
}

function hasOptimisticCraftedItemAwaitingSync(
  bot: Mineflayer,
  itemNames: string[],
  minCount = 1,
): boolean {
  if (isBridgeBuildRestartRequired(bot)) {
    return false
  }

  const diagnostic = getLastCraftRecipeDiagnostic(bot)
  if (!diagnostic || diagnostic.kind !== 'inventory_sync_mismatch') {
    return false
  }

  if (Date.now() - diagnostic.at > 15_000) {
    return false
  }

  if (!itemNames.includes(diagnostic.itemName)) {
    return false
  }

  if (itemNames.some(itemName => getItemCount(bot, itemName) >= minCount)) {
    return true
  }

  // NOTICE: FabricBridge can report a successful craft RPC while both the actual inventory
  // snapshot and the optimistic overlay remain briefly stale. Preserve the sync-lag state so
  // the runner does not immediately regress into another identical craft attempt.
  return true
}

type CraftConfirmationState = 'confirmed' | 'pending_sync' | 'failed'

async function craftRecipeWithActualConfirmation(
  bot: Mineflayer,
  itemName: string,
  count = 1,
  options?: {
    minActualCount?: number
    pendingAliases?: string[]
  },
): Promise<CraftConfirmationState> {
  const actualBefore = getActualItemCount(bot, itemName)
  const crafted = await craftRecipe(bot, itemName, count)
  await refreshInventoryState(bot)

  const minActualCount = options?.minActualCount ?? (actualBefore + Math.max(1, count))
  const confirmed = crafted
    && await confirmItemCount(bot, itemName, minActualCount, {
      attempts: 8,
      delayMs: 250,
      actualOnly: true,
    })
  if (confirmed) {
    return 'confirmed'
  }

  if (crafted && hasOptimisticCraftedItemAwaitingSync(bot, options?.pendingAliases ?? [itemName], Math.max(1, count))) {
    return 'pending_sync'
  }

  return 'failed'
}

async function relocationProducedMovement(
  bot: Mineflayer,
  relocate: () => Promise<boolean>,
  minDistance = 1,
): Promise<boolean> {
  const before = getPosition(bot)
  const relocated = await relocate()
  const after = getPosition(bot)
  return relocated && after.distanceTo(before) >= minDistance
}

async function verifySurfaceEscapeProgress(
  bot: Mineflayer,
  startPosition: Vec3,
  reason: string,
  options?: {
    allowPartialVerticalProgress?: boolean
  },
): Promise<boolean> {
  const currentPosition = bot.bot.entity.position
  const roseBy = currentPosition.y - startPosition.y
  const worldState = await buildWorldStateSnapshot(bot)
  const escapedSurface = worldState.terrainContext !== 'underground_cave'
    || !worldState.surfaceEscapeNeeded
    || worldState.skyAccess !== 'enclosed'
  const madeVerticalProgress = roseBy >= 4
  const acceptedVerticalProgress = options?.allowPartialVerticalProgress === true && madeVerticalProgress

  logger.withFields({
    reason,
    startY: startPosition.y,
    currentY: currentPosition.y,
    roseBy,
    skyAccess: worldState.skyAccess,
    terrainContext: worldState.terrainContext,
    surfaceEscapeNeeded: worldState.surfaceEscapeNeeded,
    escapedSurface,
    madeVerticalProgress,
    acceptedVerticalProgress,
  }).log('Surface-escape attempt verification')

  return escapedSurface || acceptedVerticalProgress
}

function selectSurfaceEscapeScaffold(bot: Mineflayer): { itemName: string, count: number } | null {
  const scaffold = selectSurfaceEscapeScaffoldFromInventory(getInventoryCounts(bot))
  if (scaffold) {
    return scaffold
  }

  const inventoryItems = bot.bot.inventory?.items?.() ?? []
  const fallbackCounts = inventoryItems.reduce<Record<string, number>>((counts, item) => {
    const itemName = String(item?.name ?? '').replace(/^minecraft:/, '')
    if (itemName) {
      counts[itemName] = (counts[itemName] ?? 0) + Number(item?.count ?? 0)
    }
    return counts
  }, {})
  return selectSurfaceEscapeScaffoldFromInventory(fallbackCounts)
}

async function clearPillarHeadroom(bot: Mineflayer): Promise<boolean> {
  const position = bot.bot.entity.position
  const baseX = Math.floor(position.x)
  const baseY = Math.floor(position.y)
  const baseZ = Math.floor(position.z)
  const targets = [
    { x: baseX, y: baseY + 1, z: baseZ, label: 'head' },
    { x: baseX, y: baseY + 2, z: baseZ, label: 'above' },
  ]

  for (const target of targets) {
    const block = await getBlockAtAccurate(bot, target)
    const blockName = normalizeBlockName(block?.name)
    if (isSurfaceEscapePassable(blockName)) {
      continue
    }
    if (blockName === 'unknown' || SURFACE_ESCAPE_HAZARD_BLOCKS.has(blockName)) {
      logger.withFields({
        ...target,
        block: blockName,
      }).log('Stopping pillar-based surface escape because the headroom is unsafe to clear')
      return false
    }
    const broken = await breakBlockAt(bot, target.x, target.y, target.z)
    if (!broken) {
      logger.withFields({
        ...target,
        block: blockName,
      }).log('Stopping pillar-based surface escape because the headroom could not be cleared')
      return false
    }
  }

  return true
}

async function tryPillarSurfaceEscape(
  bot: Mineflayer,
  reason: string,
  options?: {
    directVerticalExit?: { x: number, y: number, z: number } | null
    immediateTerrain?: string[]
  },
): Promise<boolean> {
  const directVerticalExit = options?.directVerticalExit ?? null
  if (!directVerticalExit && !looksLikeVerticalEscapeTrap(options?.immediateTerrain)) {
    return false
  }

  const scaffold = selectSurfaceEscapeScaffold(bot)
  if (!scaffold) {
    logger.withFields({ reason }).log('Skipping pillar-based surface escape because no disposable scaffold blocks were found')
    return false
  }

  if (!directVerticalExit && scaffold.count < 4) {
    logger.withFields({
      reason,
      scaffold: scaffold.itemName,
      count: scaffold.count,
    }).log('Skipping pillar-based surface escape because the scaffold stock is too small for a meaningful escape step')
    return false
  }

  const startPosition = bot.bot.entity.position.clone()
  const requestedSteps = directVerticalExit
    ? Math.max(1, Math.min(12, Math.ceil(directVerticalExit.y - startPosition.y)))
    : 4
  const maxSteps = Math.max(1, Math.min(scaffold.count, requestedSteps))

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    const headroomCleared = await clearPillarHeadroom(bot)
    if (!headroomCleared) {
      break
    }

    const beforeStepY = bot.bot.entity.position.y
    const climbed = await pillarUp(bot, scaffold.itemName, 1)
    if (!climbed) {
      break
    }

    const afterStepY = bot.bot.entity.position.y
    logger.withFields({
      reason,
      scaffold: scaffold.itemName,
      step: stepIndex + 1,
      maxSteps,
      beforeY: beforeStepY,
      afterY: afterStepY,
    }).log('Attempted pillar-based surface recovery step')

    if (await verifySurfaceEscapeProgress(bot, startPosition, 'pillar_surface_escape', {
      allowPartialVerticalProgress: true,
    })) {
      return true
    }

    if (afterStepY - beforeStepY < 0.75) {
      logger.withFields({
        reason,
        step: stepIndex + 1,
        beforeY: beforeStepY,
        afterY: afterStepY,
      }).log('Stopping pillar-based surface recovery because the last climb did not raise the bot')
      break
    }
  }

  return false
}

async function findLocalSurfaceRecoveryCue(
  bot: Mineflayer,
): Promise<{ x: number, y: number, z: number, name: string, horizontalDistance: number, verticalOffset: number } | null> {
  const position = bot.bot.entity.position
  const candidateBlocks: Array<{ name: string, position: Vec3 }> = []
  if (typeof bot.bot.findBlocks === 'function' && typeof bot.bot.blockAt === 'function') {
    const cachedPositions = bot.bot.findBlocks({
      matching: (block: { name?: string }) => {
        const name = normalizeBlockName(block?.name)
        return LOCAL_SURFACE_RECOVERY_CUE_QUERIES.some(query =>
          name === query
          || (query === 'log' && name.includes('log'))
          || (query === 'leaves' && name.includes('leaves')))
      },
      maxDistance: 16,
      count: 24,
    }) as Array<{ x: number, y: number, z: number }>

    for (const candidate of cachedPositions) {
      const cachedBlock = bot.bot.blockAt(new Vec3(
        Math.floor(candidate.x),
        Math.floor(candidate.y),
        Math.floor(candidate.z),
      ))
      if (cachedBlock) {
        candidateBlocks.push(cachedBlock)
      }
    }
  }

  if (candidateBlocks.length === 0) {
    candidateBlocks.push(...await getNearestBlocksAccurate(bot, PRIORITIZED_SURFACE_RECOVERY_CUE_QUERIES, 16, 16))
  }

  let bestCandidate: { x: number, y: number, z: number, name: string, horizontalDistance: number, verticalOffset: number, score: number } | null = null

  for (const block of candidateBlocks) {
    const horizontalDistance = Math.hypot(
      block.position.x - position.x,
      block.position.z - position.z,
    )
    const verticalOffset = block.position.y - position.y
    if (horizontalDistance < 1 || horizontalDistance > 12 || verticalOffset < -3 || verticalOffset > 8) {
      continue
    }

    const name = normalizeBlockName(block.name)
    const score = Math.max(0, 24 - horizontalDistance)
      + Math.max(0, verticalOffset + 2)
      + (name === 'grass_block' ? 8 : 0)
      + (name.includes('log') || name.includes('leaves') ? 4 : 0)

    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = {
        x: Math.floor(block.position.x),
        y: Math.floor(block.position.y),
        z: Math.floor(block.position.z),
        name,
        horizontalDistance,
        verticalOffset,
        score,
      }
    }
  }

  if (!bestCandidate) {
    return null
  }

  return {
    x: bestCandidate.x,
    y: bestCandidate.y,
    z: bestCandidate.z,
    name: bestCandidate.name,
    horizontalDistance: bestCandidate.horizontalDistance,
    verticalOffset: bestCandidate.verticalOffset,
  }
}

function scoreWoodBiome(biome: string): number {
  const normalizedBiome = biome.replace(/^minecraft:/, '')

  if (['forest', 'birch', 'taiga', 'jungle', 'cherry', 'grove', 'mangrove'].some(keyword => normalizedBiome.includes(keyword))) {
    return 4
  }
  if (['plains', 'savanna', 'swamp', 'meadow'].some(keyword => normalizedBiome.includes(keyword))) {
    return 2
  }
  if (['desert', 'badlands', 'ocean', 'river', 'beach', 'snowy_plains'].some(keyword => normalizedBiome.includes(keyword))) {
    return -3
  }

  return 0
}

async function relocateTowardWoodBiome(
  bot: Mineflayer,
  baseDistance: number,
  context?: { biome?: string, terrainContext?: string },
): Promise<boolean> {
  const world = (bot.bot as any).world
  if (!world || typeof world.getBiome !== 'function') {
    return false
  }

  const position = bot.bot.entity.position
  const waterLocked = context?.terrainContext === 'surface_water_edge'
    || context?.biome?.includes('ocean')
    || context?.biome?.includes('river')
    || context?.biome?.includes('beach')
  const distances = waterLocked
    ? [
        Math.max(baseDistance, 128),
        Math.min(baseDistance + 96, 224),
        Math.min(baseDistance + 160, 320),
      ]
    : [baseDistance, Math.min(baseDistance + 48, 224)]
  const directions = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 },
    { x: 1, z: 1 },
    { x: 1, z: -1 },
    { x: -1, z: 1 },
    { x: -1, z: -1 },
  ]

  let bestCandidate: { x: number, z: number, biome: string, score: number, distance: number } | null = null

  for (const distance of distances) {
    for (const direction of directions) {
      const length = Math.sqrt(direction.x ** 2 + direction.z ** 2)
      const x = Math.floor(position.x + ((distance * direction.x) / length))
      const z = Math.floor(position.z + ((distance * direction.z) / length))
      const ground = bot.bot.blockAt(new Vec3(x, Math.floor(position.y) - 1, z))
      if (ground?.name === 'water' || ground?.name === 'lava') {
        continue
      }

      let biome = 'unknown'
      try {
        biome = String(await Promise.resolve(world.getBiome(new Vec3(x, position.y, z))))
      }
      catch {
        continue
      }

      const score = scoreWoodBiome(biome)
      if (!bestCandidate
        || score > bestCandidate.score
        || (score === bestCandidate.score && waterLocked && distance > bestCandidate.distance)) {
        bestCandidate = { x, z, biome, score, distance }
      }
    }
  }

  if (!bestCandidate || bestCandidate.score < 0) {
    return false
  }

  logger.withFields({
    x: bestCandidate.x,
    z: bestCandidate.z,
    biome: bestCandidate.biome,
    score: bestCandidate.score,
    distance: bestCandidate.distance,
  }).log('Relocating toward a wood-friendly biome candidate')

  return await moveToHorizontalTarget(bot, bestCandidate.x, bestCandidate.z)
}

async function relocateTowardNearestWoodBlock(
  bot: Mineflayer,
  searchDistance: number,
): Promise<boolean> {
  const position = bot.bot.entity?.position ?? getPosition(bot)
  const candidates = await getNearestBlocksAccurate(bot, 'log', searchDistance, 24)
  const currentKey = `${Math.floor(position.x)},${Math.floor(position.z)}`
  const nearest = candidates
    .map(block => ({
      block,
      horizontalDistance: Math.sqrt(((block.position.x - position.x) ** 2) + ((block.position.z - position.z) ** 2)),
      verticalDistance: Math.abs(block.position.y - position.y),
    }))
    .filter(candidate =>
      candidate.horizontalDistance > 6
      && candidate.horizontalDistance <= Math.max(searchDistance, 24)
      && candidate.verticalDistance <= 24,
    )
    .sort((left, right) =>
      (left.verticalDistance * 4 + left.horizontalDistance)
      - (right.verticalDistance * 4 + right.horizontalDistance),
    )[0]

  if (!nearest) {
    return false
  }

  const targetKey = `${Math.floor(nearest.block.position.x)},${Math.floor(nearest.block.position.z)}`
  if (targetKey === currentKey) {
    return false
  }

  logger.withFields({
    x: nearest.block.position.x,
    y: nearest.block.position.y,
    z: nearest.block.position.z,
    name: nearest.block.name,
    horizontalDistance: nearest.horizontalDistance,
    verticalDistance: nearest.verticalDistance,
  }).log('Relocating toward nearest detected wood block')

  return await moveToHorizontalTarget(
    bot,
    Math.floor(nearest.block.position.x),
    Math.floor(nearest.block.position.z),
  )
}

async function escapeTowardSurface(
  bot: Mineflayer,
  context: {
    biome?: string
    immediateTerrain?: string[]
    position?: { y?: number }
  },
): Promise<boolean> {
  const normalizedImmediateTerrain = context.immediateTerrain?.map(entry => entry.toLowerCase()) ?? []
  const waterNearby = context.biome?.includes('ocean')
    || normalizedImmediateTerrain.some(entry => entry.includes('water'))
  const immediateShaftTrap = looksLikeVerticalEscapeTrap(context.immediateTerrain)
  const currentY = bot.bot.entity?.position?.y ?? context.position?.y ?? 64
  const nearSurfaceShaftTrap = immediateShaftTrap && Math.floor(currentY) >= 60
  const fullySubmerged = ['feet', 'head', 'north', 'south', 'east', 'west']
    .every((label) => {
      const terrainEntry = normalizedImmediateTerrain.find(entry => entry.startsWith(`${label}:`))
      return terrainEntry?.includes('water') ?? false
    })

  if (waterNearby) {
    const surfaced = await swimUpward(bot)
    if (surfaced) {
      return true
    }

    const dugEscapeRoute = await tryDigSwimEscape(bot)
    if (dugEscapeRoute) {
      return true
    }
  }

  if (!fullySubmerged && nearSurfaceShaftTrap) {
    logger.withFields({
      currentY,
      immediateTerrain: context.immediateTerrain ?? [],
    }).log('Trying immediate shaft-trap pillar recovery before deeper surface scanning')
    const pillaredImmediately = await tryPillarSurfaceEscape(bot, 'near_surface_shaft_trap_fast_path', {
      immediateTerrain: context.immediateTerrain,
    })
    if (pillaredImmediately) {
      return true
    }
  }

  if (!fullySubmerged) {
    logger.withFields({
      currentY: bot.bot.entity?.position?.y ?? currentY,
      nearSurfaceShaftTrap,
    }).log('Scanning nearby surface recovery cues')
    const localSurfaceCue = await findLocalSurfaceRecoveryCue(bot)
    if (localSurfaceCue) {
      logger.withFields(localSurfaceCue).log('Trying nearby surface-facing terrain cue before a longer escape climb')
      const startPosition = bot.bot.entity.position.clone()
      const reachedCue = await goToPosition(bot, localSurfaceCue.x, localSurfaceCue.y, localSurfaceCue.z, 4)
      const cueProgressDistance = bot.bot.entity.position.distanceTo(startPosition)
      if ((reachedCue || cueProgressDistance >= 2) && await verifySurfaceEscapeProgress(bot, startPosition, 'local_surface_cue', {
        allowPartialVerticalProgress: true,
      })) {
        return true
      }

      if (reachedCue || cueProgressDistance >= 2) {
        const currentPosition = bot.bot.entity.position
        const cueStandY = localSurfaceCue.y + 1
        const horizontalOffsetToCue = Math.hypot(
          currentPosition.x - localSurfaceCue.x,
          currentPosition.z - localSurfaceCue.z,
        )
        const cueStillUseful = cueStandY > currentPosition.y + 0.75
          || cueStandY > startPosition.y + 0.75

        if (horizontalOffsetToCue <= 4 && cueStillUseful) {
          logger.withFields({
            ...localSurfaceCue,
            cueProgressDistance,
            horizontalOffsetToCue,
            cueStandY,
          }).log('Trying direct ascent onto nearby surface cue before abandoning the cue route')
          const climbedToCue = await goToPosition(bot, localSurfaceCue.x, cueStandY, localSurfaceCue.z, 1)
          if (climbedToCue && await verifySurfaceEscapeProgress(bot, startPosition, 'local_surface_cue_ascent', {
            allowPartialVerticalProgress: true,
          })) {
            return true
          }
        }

        const retainedVerticalProgress = bot.bot.entity.position.y - startPosition.y >= 1
        if (!retainedVerticalProgress) {
          logger.withFields({
            ...localSurfaceCue,
            cueProgressDistance,
          }).log('Reorienting after nearby surface cue contact before deeper surface recovery')
          const reoriented = await moveAway(bot, 16)
          if (reoriented && await verifySurfaceEscapeProgress(bot, startPosition, 'local_surface_cue_reorient', {
            allowPartialVerticalProgress: true,
          })) {
            return true
          }
        }
        else {
          logger.withFields({
            ...localSurfaceCue,
            cueProgressDistance,
            startY: startPosition.y,
            currentY: bot.bot.entity.position.y,
          }).log('Keeping gained altitude after nearby surface cue contact before broader exit search')
        }
      }
    }

    logger.withFields({
      currentY: bot.bot.entity?.position?.y ?? currentY,
      nearSurfaceShaftTrap,
    }).log('Scanning nearby surface exits')
    const localExit = await findLocalSurfaceExit(bot)
    if (localExit) {
      logger.withFields(localExit).log('Trying local surface-exit candidate before long relocation')
      const startPosition = bot.bot.entity.position.clone()
      const reached = await moveToHorizontalTarget(bot, localExit.x, localExit.z)
      if (reached && await verifySurfaceEscapeProgress(bot, startPosition, 'local_surface_exit', {
        allowPartialVerticalProgress: true,
      })) {
        return true
      }
      if (reached) {
        const currentPosition = bot.bot.entity.position
        const horizontalOffsetToExit = Math.hypot(currentPosition.x - localExit.x, currentPosition.z - localExit.z)
        const targetRemainsAbove = localExit.y > currentPosition.y + 1
        if (horizontalOffsetToExit <= 4 && targetRemainsAbove) {
          logger.withFields({
            x: localExit.x,
            y: localExit.y,
            z: localExit.z,
            horizontalOffsetToExit,
          }).log('Trying direct ascent onto local surface-exit candidate after horizontal relocation')
          const climbedToExit = await goToPosition(bot, localExit.x, localExit.y, localExit.z, 1)
          if (climbedToExit && await verifySurfaceEscapeProgress(bot, startPosition, 'local_surface_exit_ascent', {
            allowPartialVerticalProgress: true,
          })) {
            return true
          }
        }
      }
    }
  }
  else {
    const localSwimExit = await findLocalSwimEscapeTarget(bot)
    if (localSwimExit) {
      logger.withFields(localSwimExit).log('Trying local swim-exit candidate before long relocation')
      let reached = await swimTowardPositionManual(bot, localSwimExit.x, localSwimExit.y, localSwimExit.z, {
        timeoutMs: 10_000,
        arrivalDistance: 1.2,
      })
      if (!reached) {
        const cleared = await tryClearSwimPathTowardTarget(bot, localSwimExit)
        if (cleared) {
          reached = await swimTowardPositionManual(bot, localSwimExit.x, localSwimExit.y, localSwimExit.z, {
            timeoutMs: 10_000,
            arrivalDistance: 1.2,
          })
        }
      }
      if (reached) {
        return true
      }
    }
    const dugEscapeRoute = await tryDigSwimEscape(bot)
    if (dugEscapeRoute) {
      return true
    }
    await probeBridgeCapabilities(bot)
    if (isBridgeMetadataMissing(bot)) {
      logger.warn('Bridge metadata is missing, but underwater relocation will continue because fallback movement may still be available')
    }
    if (isSubmergedBridgeCapabilityBlocked(bot)) {
      logger.warn('Skipping submerged pathfinding because the current bridge cannot reliably drive underwater relocation')
      return false
    }
    logger.log('Skipping vertical surface-exit probes because the bot is fully submerged and needs horizontal relocation.')
    return false
  }

  const currentPosition = bot.bot.entity?.position ?? { x: 0, y: context.position?.y ?? 64, z: 0 }
  logger.withFields({
    currentY: currentPosition.y,
    nearSurfaceShaftTrap,
  }).log('Scanning the current column for a direct vertical surface exit')
  const directVerticalExit = await findLocalSurfaceExit(bot, {
    maxRadius: 0,
    maxRise: 48,
    minUsefulRise: 4,
    includeCurrentColumn: true,
  })
  const shouldAttemptBlindVerticalProbe = directVerticalExit != null
    || Math.floor(currentPosition.y) < 63

  if (!shouldAttemptBlindVerticalProbe) {
    const pillaredTowardSurface = await tryPillarSurfaceEscape(bot, 'near_surface_vertical_trap', {
      directVerticalExit,
      immediateTerrain: context.immediateTerrain,
    })
    if (pillaredTowardSurface) {
      return true
    }
    logger.withFields({
      currentY: currentPosition.y,
      contextY: context.position?.y ?? null,
      skyAccess: 'enclosed',
    }).log('Skipping blind vertical surface probe near surface because no direct sky-exposed exit was detected')
    return false
  }
  const ascentTargets = directVerticalExit
    ? [
        Math.min(directVerticalExit.y, Math.max(Math.floor(currentPosition.y) + 8, 63)),
        Math.min(directVerticalExit.y, Math.max(Math.floor(currentPosition.y) + 16, 68)),
        directVerticalExit.y,
      ]
    : [
        Math.max(Math.floor(currentPosition.y) + 8, 63),
        Math.max(Math.floor(currentPosition.y) + 16, 68),
        Math.max(Math.floor(context.position?.y ?? currentPosition.y) + 24, 72),
      ]

  for (const targetY of new Set(ascentTargets)) {
    const startPosition = bot.bot.entity.position.clone()
    const reached = await goToPosition(
      bot,
      currentPosition.x,
      targetY,
      currentPosition.z,
      2,
    )
    if (reached && await verifySurfaceEscapeProgress(bot, startPosition, 'vertical_surface_probe', {
      allowPartialVerticalProgress: directVerticalExit != null,
    })) {
      return true
    }

    const currentY = bot.bot.entity.position.y
    if (currentY - startPosition.y < 1) {
      logger.withFields({
        targetY,
        startY: startPosition.y,
        currentY,
      }).log('Stopping repeated vertical surface probes because the first ascent attempt produced no vertical progress')
      break
    }

    if (!directVerticalExit) {
      logger.withFields({
        targetY,
        startY: startPosition.y,
        currentY,
      }).log('Stopping repeated vertical surface probes because the current column has no direct sky-exposed exit')
      break
    }
  }

  const pillaredTowardSurface = await tryPillarSurfaceEscape(bot, 'vertical_surface_probe_fallback', {
    directVerticalExit,
    immediateTerrain: context.immediateTerrain,
  })
  if (pillaredTowardSurface) {
    return true
  }

  return false
}

export async function recoverTowardSurface(
  bot: Mineflayer,
  reason: string = 'runner-recovery',
): Promise<boolean> {
  const worldState = await buildWorldStateSnapshot(bot)
  if (worldState.terrainContext !== 'underground_cave' && !worldState.surfaceEscapeNeeded) {
    logger.withFields({
      reason,
      biome: worldState.biome,
      position: worldState.position,
      skyAccess: worldState.skyAccess,
      terrainContext: worldState.terrainContext,
      surfaceEscapeNeeded: worldState.surfaceEscapeNeeded,
    }).log('Surface recovery already satisfied; continuing with the current plan')
    return true
  }

  logger.withFields({
    reason,
    biome: worldState.biome,
    position: worldState.position,
    skyAccess: worldState.skyAccess,
    terrainContext: worldState.terrainContext,
    surfaceEscapeNeeded: worldState.surfaceEscapeNeeded,
  }).log('Attempting surface recovery from runner recovery flow')

  return await escapeTowardSurface(bot, {
    biome: worldState.biome,
    immediateTerrain: worldState.immediateTerrain,
    position: worldState.position,
  })
}

async function findLocalSurfaceExit(
  bot: Mineflayer,
  options?: {
    maxRadius?: number
    maxRise?: number
    minUsefulRise?: number
    includeCurrentColumn?: boolean
  },
): Promise<{ x: number, y: number, z: number } | null> {
  const position = bot.bot.entity.position
  const baseX = Math.floor(position.x)
  const baseY = Math.floor(position.y)
  const baseZ = Math.floor(position.z)
  const maxRadius = options?.maxRadius ?? 6
  const maxRise = options?.maxRise ?? 20
  const minSkyExposure = 5
  const minUsefulRise = options?.minUsefulRise ?? (baseY < 48 ? 4 : 3)
  const includeCurrentColumn = options?.includeCurrentColumn ?? false

  const readBlockName = async (x: number, y: number, z: number): Promise<string> => {
    const syncBlock = typeof bot.bot.blockAt === 'function'
      ? bot.bot.blockAt(new Vec3(x, y, z))
      : null
    const syncName = syncBlock?.name
    if (syncName && syncName !== 'unknown') {
      return syncName
    }

    const accurateBlock = await getBlockAtAccurate(bot, { x, y, z })
    return accurateBlock?.name ?? 'unknown'
  }

  const isPassableColumnBlock = (name: string): boolean =>
    ['air', 'cave_air', 'void_air', 'water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(name)
  const isBreathableBlock = (name: string): boolean =>
    ['air', 'cave_air', 'void_air'].includes(name)
  const hasSolidSupport = (name: string): boolean =>
    !['air', 'cave_air', 'void_air', 'water', 'lava', 'unknown'].includes(name)

  const skyExposureAt = async (x: number, y: number, z: number): Promise<number> => {
    let openBlocks = 0
    let unknownBlocks = 0

    for (let offset = 2; offset <= 18; offset++) {
      const name = await readBlockName(x, y + offset, z)
      if (name === 'unknown') {
        unknownBlocks++
        break
      }
      if (!isPassableColumnBlock(name)) {
        break
      }
      openBlocks++
    }

    if (unknownBlocks > 0 && openBlocks < minSkyExposure) {
      return 0
    }

    return openBlocks
  }

  const hasReachableSideApproach = async (x: number, y: number, z: number): Promise<boolean> => {
    if (x === baseX && z === baseZ) {
      return true
    }

    const offsets = [
      { x: 1, z: 0 },
      { x: -1, z: 0 },
      { x: 0, z: 1 },
      { x: 0, z: -1 },
    ]

    for (const offset of offsets) {
      const adjacentX = x + offset.x
      const adjacentZ = z + offset.z
      const [sameFeet, sameHead, sameBelow, lowerFeet, lowerHead, lowerBelow] = await Promise.all([
        readBlockName(adjacentX, y, adjacentZ),
        readBlockName(adjacentX, y + 1, adjacentZ),
        readBlockName(adjacentX, y - 1, adjacentZ),
        readBlockName(adjacentX, y - 1, adjacentZ),
        readBlockName(adjacentX, y, adjacentZ),
        readBlockName(adjacentX, y - 2, adjacentZ),
      ])

      const sameLevelApproach = isBreathableBlock(sameFeet)
        && isBreathableBlock(sameHead)
        && hasSolidSupport(sameBelow)
      const stepUpApproach = isBreathableBlock(lowerFeet)
        && isBreathableBlock(lowerHead)
        && hasSolidSupport(lowerBelow)

      if (sameLevelApproach || stepUpApproach) {
        return true
      }
    }

    return false
  }

  let bestCandidate: { x: number, y: number, z: number, score: number, skyExposure: number } | null = null

  for (let radius = 0; radius <= maxRadius; radius++) {
    const positions: Array<{ x: number, z: number }> = []
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (radius > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
          continue
        }
        positions.push({ x: baseX + dx, z: baseZ + dz })
      }
    }

    for (const candidate of positions) {
      for (let dy = maxRise; dy >= minUsefulRise; dy--) {
        const x = candidate.x
        const y = baseY + dy
        const z = candidate.z
        const [feetName, headName, belowName] = await Promise.all([
          readBlockName(x, y, z),
          readBlockName(x, y + 1, z),
          readBlockName(x, y - 1, z),
        ])
        const breathableFeet = ['air', 'cave_air', 'void_air'].includes(feetName)
        const breathableHead = ['air', 'cave_air', 'void_air'].includes(headName)
        const solidBelow = !['air', 'cave_air', 'void_air', 'water', 'lava', 'unknown'].includes(belowName)

        if (!breathableFeet || !breathableHead || !solidBelow) {
          continue
        }

        if (!await hasReachableSideApproach(x, y, z)) {
          continue
        }

        const skyExposure = await skyExposureAt(x, y, z)
        if (skyExposure < minSkyExposure) {
          continue
        }

        if (!includeCurrentColumn && x === baseX && z === baseZ) {
          continue
        }

        const score = (skyExposure * 12) - (radius * 3) + Math.max(0, dy)
        if (!bestCandidate || score > bestCandidate.score) {
          bestCandidate = { x, y, z, score, skyExposure }
        }

        break
      }
    }
  }

  if (bestCandidate) {
    logger.withFields(bestCandidate).log('Found nearby surface-exit candidate with sky exposure')
    return { x: bestCandidate.x, y: bestCandidate.y, z: bestCandidate.z }
  }

  logger.log('No local surface-exit candidate found nearby.')
  return null
}

function normalizeBlockName(name: string | undefined): string {
  return name?.replace(/^minecraft:/, '') ?? 'unknown'
}

function isSwimmableEscapeBlock(name: string): boolean {
  return ['air', 'cave_air', 'void_air', 'water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(name)
}

function getBridgeDebugState(bot: Mineflayer): Record<string, unknown> | null {
  const bridgeStateGetter = (bot as any).getBridgeDebugState
    ?? (bot.bot as any)?.getBridgeDebugState
  if (typeof bridgeStateGetter !== 'function') {
    return null
  }

  try {
    const receiver = typeof (bot as any).getBridgeDebugState === 'function'
      ? bot
      : bot.bot
    return bridgeStateGetter.call(receiver) as Record<string, unknown>
  }
  catch {
    return null
  }
}

async function probeBridgeCapabilities(bot: Mineflayer): Promise<Record<string, unknown> | null> {
  const capabilityProbe = (bot as any).probeBridgeCapabilities
    ?? (bot.bot as any)?.probeBridgeCapabilities
  if (typeof capabilityProbe !== 'function') {
    return getBridgeDebugState(bot)
  }

  try {
    const receiver = typeof (bot as any).probeBridgeCapabilities === 'function'
      ? bot
      : bot.bot
    return await capabilityProbe.call(receiver) as Record<string, unknown>
  }
  catch {
    return getBridgeDebugState(bot)
  }
}

function isSubmergedBridgeCapabilityBlocked(bot: Mineflayer): boolean {
  const bridgeState = getBridgeDebugState(bot)
  const pathfinderState = bridgeState?.pathfinder as
    | { remoteMovementSupport?: string, baritoneAvailability?: string }
    | undefined

  return pathfinderState?.remoteMovementSupport === 'unsupported'
    && pathfinderState?.baritoneAvailability === 'unavailable'
}

function isBridgeMetadataMissing(bot: Mineflayer): boolean {
  const bridgeState = getBridgeDebugState(bot)
  if (!bridgeState) {
    return false
  }
  return bridgeState?.bridgeVersion == null || bridgeState?.bridgeBuildTimestamp == null
}

function isBridgeBuildRestartRequired(bot: Mineflayer): boolean {
  const bridgeState = getBridgeDebugState(bot)
  return bridgeState?.staleInstalledBridgeBuild === true
}

function isFullySubmergedImmediateTerrain(immediateTerrain: string[] | undefined): boolean {
  const normalizedImmediateTerrain = immediateTerrain?.map(entry => entry.toLowerCase()) ?? []
  return ['feet', 'head', 'north', 'south', 'east', 'west']
    .every((label) => {
      const terrainEntry = normalizedImmediateTerrain.find(entry => entry.startsWith(`${label}:`))
      return terrainEntry?.includes('water') ?? false
    })
}

const SOFT_SWIM_ESCAPE_BLOCKS = new Set([
  'gravel',
  'sand',
  'red_sand',
  'dirt',
  'coarse_dirt',
  'grass_block',
  'clay',
  'mud',
  'kelp',
  'kelp_plant',
  'seagrass',
  'tall_seagrass',
])

async function tryDigSwimEscape(bot: Mineflayer): Promise<boolean> {
  const position = bot.bot.entity.position
  const baseX = Math.floor(position.x)
  const baseY = Math.floor(position.y)
  const baseZ = Math.floor(position.z)
  const candidates = [
    { x: baseX, y: baseY + 1, z: baseZ, label: 'head' },
    { x: baseX, y: baseY + 2, z: baseZ, label: 'above' },
    { x: baseX + 1, y: baseY + 1, z: baseZ, label: 'east_head' },
    { x: baseX - 1, y: baseY + 1, z: baseZ, label: 'west_head' },
    { x: baseX, y: baseY + 1, z: baseZ + 1, label: 'south_head' },
    { x: baseX, y: baseY + 1, z: baseZ - 1, label: 'north_head' },
  ]
  const scannedBlocks: string[] = []

  for (const candidate of candidates) {
    const block = await getBlockAtAccurate(bot, candidate)
    const normalizedName = normalizeBlockName(block?.name)
    scannedBlocks.push(`${candidate.label}:${normalizedName}`)
    if (!SOFT_SWIM_ESCAPE_BLOCKS.has(normalizedName)) {
      continue
    }

    logger.withFields({ ...candidate, block: normalizedName }).log('Trying to break a soft block to escape the submerged trap')
    const broken = await breakBlockAt(bot, candidate.x, candidate.y, candidate.z)
    if (!broken) {
      continue
    }

    const surfaced = await swimUpward(bot, 2_500)
    if (surfaced) {
      return true
    }
  }

  logger.withFields({ scannedBlocks }).log('No soft blocks were available to dig for submerged escape recovery')
  return false
}

async function tryClearSwimPathTowardTarget(
  bot: Mineflayer,
  target: { x: number, y: number, z: number },
): Promise<boolean> {
  const position = bot.bot.entity.position
  const baseX = Math.floor(position.x)
  const baseY = Math.floor(position.y)
  const baseZ = Math.floor(position.z)
  const stepX = Math.sign(target.x - baseX)
  const stepZ = Math.sign(target.z - baseZ)
  const candidates = [
    { x: baseX + stepX, y: baseY, z: baseZ + stepZ, label: 'forward_feet' },
    { x: baseX + stepX, y: baseY + 1, z: baseZ + stepZ, label: 'forward_head' },
    { x: baseX + stepX, y: baseY + 2, z: baseZ + stepZ, label: 'forward_above' },
    { x: baseX + stepX, y: baseY, z: baseZ, label: 'step_x_feet' },
    { x: baseX, y: baseY, z: baseZ + stepZ, label: 'step_z_feet' },
    { x: baseX + stepX, y: baseY + 1, z: baseZ, label: 'step_x_head' },
    { x: baseX, y: baseY + 1, z: baseZ + stepZ, label: 'step_z_head' },
  ].filter(candidate => candidate.x !== baseX || candidate.z !== baseZ)

  const scannedBlocks: string[] = []

  for (const candidate of candidates) {
    const block = await getBlockAtAccurate(bot, candidate)
    const normalizedName = normalizeBlockName(block?.name)
    scannedBlocks.push(`${candidate.label}:${normalizedName}`)
    if (!SOFT_SWIM_ESCAPE_BLOCKS.has(normalizedName)) {
      continue
    }

    logger.withFields({ ...candidate, block: normalizedName }).log('Trying to clear a soft swim obstacle toward the local escape target')
    const broken = await breakBlockAt(bot, candidate.x, candidate.y, candidate.z)
    if (broken) {
      return true
    }
  }

  logger.withFields({ scannedBlocks }).log('No directional soft swim obstacles were available to clear toward the local escape target')
  return false
}

async function findLocalSwimEscapeTarget(bot: Mineflayer): Promise<{ x: number, y: number, z: number } | null> {
  const position = bot.bot.entity.position
  const baseX = Math.floor(position.x)
  const baseY = Math.floor(position.y)
  const baseZ = Math.floor(position.z)
  const maxRadius = 4
  const maxRise = 10

  const readBlockName = async (x: number, y: number, z: number): Promise<string> => {
    const syncBlock = typeof bot.bot.blockAt === 'function'
      ? bot.bot.blockAt(new Vec3(x, y, z))
      : null
    const syncName = normalizeBlockName(syncBlock?.name)
    if (syncName !== 'unknown') {
      return syncName
    }

    const accurateBlock = await getBlockAtAccurate(bot, { x, y, z })
    return normalizeBlockName(accurateBlock?.name)
  }

  let bestCandidate: { x: number, y: number, z: number, score: number } | null = null

  for (let radius = 0; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (radius > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
          continue
        }

        const x = baseX + dx
        const z = baseZ + dz
        for (let dy = 1; dy <= maxRise; dy++) {
          const y = baseY + dy
          const [feetName, headName] = await Promise.all([
            readBlockName(x, y, z),
            readBlockName(x, y + 1, z),
          ])

          if (!isSwimmableEscapeBlock(feetName) || !isSwimmableEscapeBlock(headName)) {
            continue
          }

          if (radius === 0 && feetName === 'water' && headName === 'water') {
            continue
          }

          let columnPassable = true
          for (let scanY = baseY + 1; scanY <= y + 1; scanY++) {
            const columnName = await readBlockName(x, scanY, z)
            if (!isSwimmableEscapeBlock(columnName)) {
              columnPassable = false
              break
            }
          }

          if (!columnPassable) {
            continue
          }

          const score = (dy * 10)
            + (feetName === 'air' ? 6 : 0)
            + (headName === 'air' ? 4 : 0)
            - radius

          if (!bestCandidate || score > bestCandidate.score) {
            bestCandidate = { x, y, z, score }
          }
        }
      }
    }
  }

  if (!bestCandidate) {
    return null
  }

  return { x: bestCandidate.x, y: bestCandidate.y, z: bestCandidate.z }
}

// ─── Inventory Helpers ───

function hasItem(bot: Mineflayer, name: string, count = 1): boolean {
  return getItemCount(bot, name) >= count
}

async function hasNearbyCraftingTable(bot: Mineflayer, maxDistance = 6): Promise<boolean> {
  const nearby = await getNearestBlocksAccurate(bot, 'crafting_table', maxDistance, 4)
  if (nearby.length <= 0) {
    return false
  }

  const position = bot.bot.entity.position
  return nearby.some((block) => {
    const dx = block.position.x - position.x
    const dy = block.position.y - position.y
    const dz = block.position.z - position.z
    const horizontalDistance = Math.sqrt((dx ** 2) + (dz ** 2))
    const verticalDistance = Math.abs(dy)
    return horizontalDistance <= (maxDistance + 0.75) && verticalDistance <= 3
  })
}

function hasActualItem(bot: Mineflayer, name: string, count = 1): boolean {
  return getActualItemCount(bot, name) >= count
}

function hasAnyActualPickaxe(bot: Mineflayer): boolean {
  return hasActualItem(bot, 'wooden_pickaxe')
    || hasActualItem(bot, 'stone_pickaxe')
    || hasActualItem(bot, 'iron_pickaxe')
    || hasActualItem(bot, 'diamond_pickaxe')
    || hasActualItem(bot, 'netherite_pickaxe')
}

function hasAnyPickaxeWithRecentSyncRecovery(bot: Mineflayer): boolean {
  if (hasAnyActualPickaxe(bot)) {
    return true
  }

  if (
    hasItem(bot, 'wooden_pickaxe')
    || hasItem(bot, 'stone_pickaxe')
    || hasItem(bot, 'iron_pickaxe')
    || hasItem(bot, 'diamond_pickaxe')
    || hasItem(bot, 'netherite_pickaxe')
    || hasItem(bot, 'pickaxe')
  ) {
    return true
  }

  return hasOptimisticCraftedItemAwaitingSync(
    bot,
    ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'pickaxe'],
  )
}

function hasAnySword(bot: Mineflayer): boolean {
  return hasItem(bot, 'wooden_sword')
    || hasItem(bot, 'stone_sword')
    || hasItem(bot, 'iron_sword')
    || hasItem(bot, 'diamond_sword')
    || hasItem(bot, 'netherite_sword')
}

function hasAnyActualSword(bot: Mineflayer): boolean {
  return hasActualItem(bot, 'wooden_sword')
    || hasActualItem(bot, 'stone_sword')
    || hasActualItem(bot, 'iron_sword')
    || hasActualItem(bot, 'diamond_sword')
    || hasActualItem(bot, 'netherite_sword')
}

function hasStoneTierActualPickaxe(bot: Mineflayer): boolean {
  return hasActualItem(bot, 'stone_pickaxe')
    || hasActualItem(bot, 'iron_pickaxe')
    || hasActualItem(bot, 'diamond_pickaxe')
    || hasActualItem(bot, 'netherite_pickaxe')
}

function hasStoneTierPickaxeWithRecentSyncRecovery(bot: Mineflayer): boolean {
  if (hasStoneTierActualPickaxe(bot)) {
    return true
  }

  if (
    hasItem(bot, 'stone_pickaxe')
    || hasItem(bot, 'iron_pickaxe')
    || hasItem(bot, 'diamond_pickaxe')
    || hasItem(bot, 'netherite_pickaxe')
  ) {
    return true
  }

  return hasOptimisticCraftedItemAwaitingSync(
    bot,
    ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'pickaxe'],
  )
}

function hasAnyAxe(bot: Mineflayer): boolean {
  return hasItem(bot, 'wooden_axe')
    || hasItem(bot, 'stone_axe')
    || hasItem(bot, 'iron_axe')
    || hasItem(bot, 'diamond_axe')
    || hasItem(bot, 'netherite_axe')
}

function hasDiamondPickaxe(bot: Mineflayer): boolean {
  return hasActualItem(bot, 'diamond_pickaxe')
}

const DIAMOND_LOADOUT_CRAFTS = [
  { name: 'diamond_pickaxe', cost: 3, label: 'diamond pickaxe' },
  { name: 'diamond_chestplate', cost: 8, label: 'diamond chestplate' },
  { name: 'diamond_leggings', cost: 7, label: 'diamond leggings' },
  { name: 'diamond_helmet', cost: 5, label: 'diamond helmet' },
  { name: 'diamond_boots', cost: 4, label: 'diamond boots' },
] as const
type DiamondLoadoutCraft = (typeof DIAMOND_LOADOUT_CRAFTS)[number]

function hasActualDiamondArmorSet(bot: Mineflayer): boolean {
  return hasActualItem(bot, 'diamond_helmet')
    && hasActualItem(bot, 'diamond_chestplate')
    && hasActualItem(bot, 'diamond_leggings')
    && hasActualItem(bot, 'diamond_boots')
}

function hasDiamondProgressionLoadout(bot: Mineflayer): boolean {
  return hasDiamondPickaxe(bot) && hasActualDiamondArmorSet(bot)
}

function getMissingDiamondLoadoutCrafts(bot: Mineflayer): DiamondLoadoutCraft[] {
  return DIAMOND_LOADOUT_CRAFTS.filter(craft => !hasActualItem(bot, craft.name))
}

function getCoalLikeFuelCount(bot: Mineflayer): number {
  return getItemCount(bot, 'coal') + getItemCount(bot, 'charcoal')
}

function hasBow(bot: Mineflayer): boolean {
  return hasItem(bot, 'bow')
}

function hasArrows(bot: Mineflayer): boolean {
  return hasItem(bot, 'arrow') || hasItem(bot, 'spectral_arrow') || hasItem(bot, 'tipped_arrow')
}

function getFoodCount(bot: Mineflayer): number {
  const foods = [
    'cooked_beef',
    'cooked_porkchop',
    'cooked_chicken',
    'cooked_mutton',
    'cooked_rabbit',
    'cooked_salmon',
    'cooked_cod',
    'bread',
    'golden_apple',
    'apple',
    'baked_potato',
    'golden_carrot',
    'sweet_berries',
    'melon_slice',
    'carrot',
    'potato',
    'beetroot',
    'dried_kelp',
    'cookie',
    'pumpkin_pie',
  ]
  return bot.bot.inventory.items()
    .filter(i => foods.includes(i.name))
    .reduce((sum, i) => sum + i.count, 0)
}

function getActualTorchCount(bot: Mineflayer): number {
  return getActualItemCount(bot, 'torch')
}

function hasEarlyGameActualKit(bot: Mineflayer): boolean {
  return hasStoneTierActualPickaxe(bot)
    && hasActualItem(bot, 'cobblestone', 8)
    && hasAnyActualSword(bot)
    && getActualTorchCount(bot) >= 8
}

function hasSafeMiningKit(bot: Mineflayer): boolean {
  return hasStoneTierActualPickaxe(bot)
    && hasAnyActualSword(bot)
    && getActualTorchCount(bot) >= 8
    && getFoodCount(bot) >= 8
}

function getRawFoodCount(bot: Mineflayer): number {
  const rawFoods = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'salmon', 'cod']
  return bot.bot.inventory.items()
    .filter(i => rawFoods.includes(i.name))
    .reduce((sum, i) => sum + i.count, 0)
}

function getImmediateEdibleFoodCount(bot: Mineflayer): number {
  return getFoodCount(bot) + getRawFoodCount(bot)
}

async function tryEatBeforeRiskyMining(bot: Mineflayer): Promise<boolean> {
  if (bot.bot.health >= 12 || bot.bot.food > 16 || getImmediateEdibleFoodCount(bot) <= 0) {
    return false
  }

  return await tryEat(bot)
}

function needsFoodBeforeRiskyMining(bot: Mineflayer): boolean {
  return bot.bot.health < 12
    && bot.bot.food <= 16
    && getImmediateEdibleFoodCount(bot) <= 0
}

async function huntNearestFoodAnimal(bot: Mineflayer, range: number): Promise<boolean> {
  const animals = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'cod', 'salmon']
  for (const animal of animals) {
    const entity = getNearestEntityWhere(bot, e => e.name === animal, range)
    if (!entity) {
      continue
    }

    logger.log(`Hunting ${animal} before risky mining...`)
    await attackNearest(bot, animal, true)
    await sleep(1000)
    return true
  }
  return false
}

function getLogsCount(bot: Mineflayer): number {
  return bot.bot.inventory.items()
    .filter(i => i.name.endsWith('_log') || i.name.endsWith('_wood'))
    .reduce((sum, i) => sum + i.count, 0)
}

// ─── Survival Check (runs before every phase step) ───

export async function survivalCheck(bot: Mineflayer): Promise<void> {
  // 1. Eat if hungry
  if (bot.bot.food < 14) {
    await tryEat(bot)
  }

  // 2. Defend against nearby hostile mobs
  const hostile = getNearestEntityWhere(bot, e => isHostileMob(e.name ?? ''), 8)
  if (hostile) {
    logger.log(`Hostile mob nearby: ${hostile.name}, defending...`)
    await defendSelf(bot, 12)
  }

  // 3. Sleep if night and we have a bed nearby
  if (isNightTime(bot)) {
    const bed = getNearestBlock(bot, 'white_bed', 32)
      || getNearestBlock(bot, 'red_bed', 32)
    if (bed) {
      try {
        await goToPosition(bot, bed.position.x, bed.position.y, bed.position.z, 2)
        await bot.bot.sleep(bed)
        while (bot.bot.isSleeping) await sleep(500)
      }
      catch {
        // Can't sleep, continue
      }
    }
  }
}

async function tryEat(bot: Mineflayer): Promise<boolean> {
  const foods = [
    'cooked_beef',
    'cooked_porkchop',
    'cooked_chicken',
    'cooked_mutton',
    'cooked_rabbit',
    'cooked_salmon',
    'cooked_cod',
    'bread',
    'golden_apple',
    'apple',
    'baked_potato',
    'golden_carrot',
    'sweet_berries',
    'melon_slice',
    'carrot',
    'potato',
    'beetroot',
    'dried_kelp',
    'cookie',
    'pumpkin_pie',
    'beef',
    'porkchop',
    'chicken',
    'mutton',
    'rabbit',
  ]
  for (const food of foods) {
    const item = bot.bot.inventory.items().find(i => i.name === food)
    if (item) {
      try {
        await bot.bot.equip(item, 'hand')
        await bot.bot.consume()
        logger.log(`Ate ${food}`)
        return true
      }
      catch {
        continue
      }
    }
  }
  return false
}

function isHostileMob(name: string): boolean {
  const hostiles = [
    'zombie',
    'skeleton',
    'creeper',
    'spider',
    'enderman',
    'witch',
    'slime',
    'phantom',
    'drowned',
    'husk',
    'stray',
    'cave_spider',
    'silverfish',
    'pillager',
    'vindicator',
    'ravager',
    'vex',
    'evoker',
    'blaze',
    'ghast',
    'magma_cube',
    'hoglin',
    'piglin_brute',
    'warden',
    'wither_skeleton',
  ]
  return hostiles.includes(name)
}

function isNightTime(bot: Mineflayer): boolean {
  const time = bot.bot.time.timeOfDay
  return time >= 12542 && time <= 23460
}

// ─── Phase Implementations ───

export async function executePhase(bot: Mineflayer, state: GameStateManager): Promise<PhaseResult> {
  const phase = state.phase

  switch (phase) {
    case GamePhase.EARLY_GAME:
      return await phaseEarlyGame(bot, state)
    case GamePhase.IRON_AGE:
      return await phaseIronAge(bot, state)
    case GamePhase.FOOD_SUPPLY:
      return await phaseFoodSupply(bot, state)
    case GamePhase.DIAMOND_MINING:
      return await phaseDiamondMining(bot, state)
    case GamePhase.NETHER_PREP:
      return await phaseNetherPrep(bot, state)
    case GamePhase.NETHER_PORTAL:
      return await phaseNetherPortal(bot, state)
    case GamePhase.NETHER_EXPLORE:
      return await phaseNetherExplore(bot, state)
    case GamePhase.BLAZE_HUNTING:
      return await phaseBlazeHunting(bot, state)
    case GamePhase.ENDERMAN_HUNTING:
      return await phaseEndermanHunting(bot, state)
    case GamePhase.EYE_CRAFTING:
      return await phaseEyeCrafting(bot, state)
    case GamePhase.STRONGHOLD:
      return await phaseStronghold(bot, state)
    case GamePhase.END_PORTAL:
      return await phaseEndPortal(bot, state)
    case GamePhase.DRAGON_FIGHT:
      return await phaseDragonFight(bot, state)
    case GamePhase.VICTORY:
      return ok('The Ender Dragon has been defeated!')
    default:
      return fail(`Unknown phase: ${phase}`)
  }
}

// Determine which phase we should be in based on inventory
export function determinePhase(bot: Mineflayer, state: GameStateManager): GamePhase {
  const inv = getInventoryCounts(bot)
  const dim = bot.bot.game.dimension
  const actualIronIngots = getActualItemCount(bot, 'iron_ingot')
  const actualObsidian = getActualItemCount(bot, 'obsidian')
  const hasActualIronPickaxe = hasActualItem(bot, 'iron_pickaxe')
  const hasActualFlintAndSteel = hasActualItem(bot, 'flint_and_steel')
  const requiredEyes = getRequiredEnderEyes(state)
  const currentEyes = inv.ender_eye || 0
  const neededEyes = Math.max(0, requiredEyes - currentEyes)
  const availablePearls = inv.ender_pearl || 0
  const availablePowder = (inv.blaze_powder || 0) + ((inv.blaze_rod || 0) * 2)

  // If we're in the_end, we're fighting the dragon
  if (dim === 'the_end')
    return GamePhase.DRAGON_FIGHT

  // If we have eyes of ender and blaze rods, find stronghold
  if (currentEyes >= requiredEyes) {
    if (state.getLocation('stronghold'))
      return GamePhase.END_PORTAL
    return GamePhase.STRONGHOLD
  }

  // If we have blaze powder and ender pearls, craft eyes
  if (neededEyes > 0 && availablePowder >= neededEyes && availablePearls >= neededEyes)
    return GamePhase.EYE_CRAFTING

  // If we have enough blaze rods, hunt endermen
  if ((inv.blaze_rod || 0) >= 7)
    return GamePhase.ENDERMAN_HUNTING

  // If we're in the nether with good gear
  if (dim === 'the_nether') {
    const nearFortress = getNearestBlock(bot, 'nether_bricks', 64)
    if (nearFortress)
      return GamePhase.BLAZE_HUNTING
    return GamePhase.NETHER_EXPLORE
  }

  // If we have a nether portal location saved and we haven't been to nether yet
  if (state.getLocation('nether_portal') && !state.current.completedPhases.includes(GamePhase.NETHER_EXPLORE)) {
    return GamePhase.NETHER_EXPLORE
  }

  // Check for obsidian -> build portal once diamond progression gear is complete
  if (hasDiamondProgressionLoadout(bot) && actualObsidian >= 10 && hasActualFlintAndSteel)
    return GamePhase.NETHER_PORTAL

  // Check for diamond progression loadout -> mine obsidian
  if (hasDiamondProgressionLoadout(bot))
    return GamePhase.NETHER_PREP

  // Check for iron tools → mine diamonds
  if (hasActualIronPickaxe || actualIronIngots >= 3) {
    if (getFoodCount(bot) < 16)
      return GamePhase.FOOD_SUPPLY
    return GamePhase.DIAMOND_MINING
  }

  // Check for stone tools → get iron
  if (hasEarlyGameActualKit(bot)) {
    return GamePhase.IRON_AGE
  }

  return GamePhase.EARLY_GAME
}

// ─── Phase: Early Game (Wood + Stone tools) ───

async function phaseEarlyGame(bot: Mineflayer, state: GameStateManager): Promise<PhaseResult> {
  // Phase: Get wood and stone tools

  // Save spawn location
  if (!state.getLocation('spawn')) {
    const pos = getPosition(bot)
    state.saveLocation('spawn', { x: pos.x, y: pos.y, z: pos.z, dimension: 'overworld', label: 'Spawn Point' })
  }

  // Step 0: Gather wood
  await refreshInventoryState(bot)
  if (isBridgeBuildRestartRequired(bot) && !hasEarlyGameActualKit(bot)) {
    return fail('Bridge capability blocked craft sync: installed bridge jar is newer than the running Fabric mod build; Minecraft restart required')
  }
  const hasCraftingTableReady = hasItem(bot, 'crafting_table') || await hasNearbyCraftingTable(bot)
  const minimumBootstrapLogs = hasCraftingTableReady ? 2 : 4
  const targetLogs = minimumBootstrapLogs

  if (getLogsCount(bot) < minimumBootstrapLogs) {
    const attempt = state.getAttempts()
    const gatherDistance = Math.min(80 + (attempt * 32), 192)
    const relocateDistance = Math.min(64 + (attempt * 16), 160)
    logger.log('Gathering wood...')
    const gatheredWood = await gatherWood(bot, targetLogs, gatherDistance)
    const logsAfterGather = getLogsCount(bot)
    if (!gatheredWood && logsAfterGather < minimumBootstrapLogs) {
      const worldState = await buildWorldStateSnapshot(bot)
      const seemsUnderground = worldState.terrainContext === 'underground_cave'
        || worldState.surfaceEscapeNeeded
        || (((worldState.position?.y ?? 64) < 63) && worldState.skyAccess !== 'open_sky')

      logger.withFields({
        terrainContext: worldState.terrainContext,
        skyAccess: worldState.skyAccess,
        woodAccess: worldState.woodAccess,
        surfaceEscapeNeeded: worldState.surfaceEscapeNeeded,
        biome: worldState.biome,
        y: worldState.position?.y,
        immediateTerrain: worldState.immediateTerrain,
      }).log('Early-game wood recovery world-state')

      if (seemsUnderground) {
        const escapedTowardSurface = await escapeTowardSurface(bot, {
          biome: worldState.biome,
          immediateTerrain: worldState.immediateTerrain,
          position: worldState.position,
        })
        if (escapedTowardSurface) {
          return progress('Escaping underground to reach surface trees...')
        }

        const fullySubmerged = isFullySubmergedImmediateTerrain(worldState.immediateTerrain)
        if (fullySubmerged) {
          await probeBridgeCapabilities(bot)
          if (isBridgeMetadataMissing(bot)) {
            logger.warn('Bridge metadata is missing, but underwater relocation may continue because fallback movement could still be available')
          }
        }

        if (fullySubmerged && isSubmergedBridgeCapabilityBlocked(bot)) {
          return fail('Bridge capability blocked submerged escape: bridge underwater relocation support unavailable')
        }

        const relocated = await relocationProducedMovement(
          bot,
          () => moveAway(bot, Math.min(96 + (attempt * 24), 224)),
        )
        if (!relocated) {
          if (fullySubmerged && isSubmergedBridgeCapabilityBlocked(bot)) {
            return fail('Bridge capability blocked submerged escape: bridge underwater relocation support unavailable')
          }
          return fail('Unable to escape underground to reach surface trees')
        }
        return progress('Escaping underground to reach surface trees...')
      }

      const relocatedToWoodBlock = await relocateTowardNearestWoodBlock(bot, gatherDistance)
      if (relocatedToWoodBlock) {
        return progress('Relocating toward detected nearby wood...')
      }

      const relocatedToWoodBiome = await relocateTowardWoodBiome(bot, relocateDistance, {
        biome: worldState.biome,
        terrainContext: worldState.terrainContext,
      })
      if (!relocatedToWoodBiome) {
        const relocated = await relocationProducedMovement(
          bot,
          () => moveAway(bot, worldState.terrainContext === 'surface_water_edge'
            ? Math.max(relocateDistance * 2, 128)
            : relocateDistance),
        )
        if (!relocated) {
          return fail('Unable to relocate toward surface trees')
        }
      }
      return progress('Relocating to a biome with trees...')
    }

    return progress('Gathered wood')
  }

  // Step 1: Ensure crafting table
  await refreshInventoryState(bot)
  const hasCraftingTableInInventoryOrNearby = hasItem(bot, 'crafting_table') || await hasNearbyCraftingTable(bot)
  if (!hasCraftingTableInInventoryOrNearby) {
    const ensuredCraftingTable = await ensureCraftingTable(bot)
    await refreshInventoryState(bot)
    const confirmedCraftingTable = ensuredCraftingTable
      && (hasItem(bot, 'crafting_table') || await hasNearbyCraftingTable(bot))
    if (!confirmedCraftingTable) {
      if (isBridgeCraftSyncBlocked(bot)) {
        if (isBridgeBuildRestartRequired(bot)) {
          return fail('Bridge capability blocked craft sync: installed bridge jar is newer than the running Fabric mod build; Minecraft restart required')
        }
        return fail('Bridge capability blocked craft sync: crafting table craft did not sync to bot state')
      }
      return fail('Could not make crafting table')
    }
    return progress('Made crafting table')
  }

  // Step 2: Craft wooden pickaxe
  if (!hasAnyPickaxeWithRecentSyncRecovery(bot)) {
    const worldState = await buildWorldStateSnapshot(bot)
    const canCraftStarterPickaxeFromInventory = worldState.pickaxeAccess === 'craftable_from_inventory'
    const shouldEscapeToSurfaceBeforeCrafting = !canCraftStarterPickaxeFromInventory
      && (worldState.terrainContext === 'underground_cave' || worldState.surfaceEscapeNeeded)

    if (shouldEscapeToSurfaceBeforeCrafting) {
      const escapedTowardSurface = await escapeTowardSurface(bot, {
        biome: worldState.biome,
        immediateTerrain: worldState.immediateTerrain,
        position: worldState.position,
      })
      if (escapedTowardSurface) {
        return progress('Escaping cave before crafting starter tools...')
      }

      const relocated = await relocationProducedMovement(
        bot,
        () => moveAway(bot, 48),
      )
      if (relocated) {
        return progress('Relocating toward cave exit before crafting starter tools...')
      }
    }
  }

  if (!hasAnyPickaxeWithRecentSyncRecovery(bot)) {
    const ensuredPickaxe = await ensurePickaxe(bot)
    await refreshInventoryState(bot)
    if (!hasAnyPickaxeWithRecentSyncRecovery(bot)) {
      if (
        ensuredPickaxe
        && hasOptimisticCraftedItemAwaitingSync(
          bot,
          ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'pickaxe'],
        )
      ) {
        return progress('Crafted pickaxe; waiting for bridge inventory sync...')
      }
      if (isBridgeCraftSyncBlocked(bot)) {
        if (isBridgeBuildRestartRequired(bot)) {
          return fail('Bridge capability blocked craft sync: installed bridge jar is newer than the running Fabric mod build; Minecraft restart required')
        }
        return fail('Bridge capability blocked craft sync: inventory recipe craft did not sync to bot state')
      }

      if (!ensuredPickaxe) {
        const worldState = await buildWorldStateSnapshot(bot)
        const shouldEscapeToSurfaceForRecovery = worldState.terrainContext === 'underground_cave' || worldState.surfaceEscapeNeeded
        if (shouldEscapeToSurfaceForRecovery) {
          const escapedTowardSurface = await escapeTowardSurface(bot, {
            biome: worldState.biome,
            immediateTerrain: worldState.immediateTerrain,
            position: worldState.position,
          })
          if (escapedTowardSurface) {
            return progress('Escaping cave to recover wood for pickaxe crafting...')
          }
        }

        const relocated = await relocationProducedMovement(
          bot,
          () => moveAway(bot, 48),
        )
        if (relocated) {
          return progress('Relocating to recover wood for pickaxe crafting...')
        }
      }
      return fail('Could not craft pickaxe')
    }
    if (!ensuredPickaxe) {
      return fail('Could not craft pickaxe')
    }
    return progress('Crafted pickaxe')
  }

  // Step 3: Mine cobblestone
  if (getItemCount(bot, 'cobblestone') < EARLY_GAME_COBBLESTONE_TARGET) {
    const ateBeforeMining = await tryEatBeforeRiskyMining(bot)
    if (ateBeforeMining) {
      return progress('Ate before stone mining')
    }

    if (needsFoodBeforeRiskyMining(bot)) {
      const worldState = await buildWorldStateSnapshot(bot)
      const shouldEscapeForFood = worldState.terrainContext === 'underground_cave' || worldState.surfaceEscapeNeeded

      logger.withFields({
        health: bot.bot.health,
        food: bot.bot.food,
        carriedFood: getImmediateEdibleFoodCount(bot),
        terrainContext: worldState.terrainContext,
        surfaceEscapeNeeded: worldState.surfaceEscapeNeeded,
      }).warn('Pausing early cobblestone mining until food recovery is available')

      if (shouldEscapeForFood) {
        const escapedTowardSurface = await escapeTowardSurface(bot, {
          biome: worldState.biome,
          immediateTerrain: worldState.immediateTerrain,
          position: worldState.position,
        })
        if (escapedTowardSurface) {
          return progress('Escaping cave to recover food before stone mining...')
        }

        const relocated = await relocationProducedMovement(
          bot,
          () => moveAway(bot, 64),
        )
        if (relocated) {
          return progress('Relocating toward surface food before stone mining...')
        }

        return fail('Could not reach food recovery before stone mining')
      }

      const hunted = await huntNearestFoodAnimal(bot, 64)
      if (hunted) {
        return progress('Hunted food before stone mining')
      }

      const relocated = await relocationProducedMovement(
        bot,
        () => moveAway(bot, 80),
      )
      if (relocated) {
        return progress('Searching for food before stone mining...')
      }

      return fail('Could not find food recovery before stone mining')
    }

    const ensuredCobblestone = await ensureCobblestone(bot, EARLY_GAME_COBBLESTONE_TARGET)
    if (!ensuredCobblestone) {
      return fail('Could not mine cobblestone')
    }
    return progress('Mined cobblestone')
  }

  // Step 4: Upgrade to a stone-tier pickaxe before leaving the bootstrap phase.
  if (!hasStoneTierPickaxeWithRecentSyncRecovery(bot)) {
    const ensuredStonePickaxe = await ensureStoneTierPickaxe(bot)
    await refreshInventoryState(bot)
    if (!hasStoneTierPickaxeWithRecentSyncRecovery(bot)) {
      if (
        ensuredStonePickaxe
        && hasOptimisticCraftedItemAwaitingSync(
          bot,
          ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
        )
      ) {
        return progress('Crafted stone pickaxe; waiting for bridge inventory sync...')
      }
      if (isBridgeCraftSyncBlocked(bot)) {
        if (isBridgeBuildRestartRequired(bot)) {
          return fail('Bridge capability blocked craft sync: installed bridge jar is newer than the running Fabric mod build; Minecraft restart required')
        }
        return fail('Bridge capability blocked craft sync: inventory recipe craft did not sync to bot state')
      }
      return fail('Could not craft stone pickaxe')
    }
    if (!ensuredStonePickaxe) {
      return fail('Could not craft stone pickaxe')
    }
    return progress('Crafted stone pickaxe')
  }

  // Step 5: Craft stone tools
  if (!hasAnySword(bot)) {
    const ensuredSword = await ensureSword(bot)
    if (!ensuredSword) {
      return fail('Could not craft sword')
    }
  }
  if (!hasAnyAxe(bot)) {
    const ensuredAxe = await ensureAxe(bot)
    if (!ensuredAxe) {
      return fail('Could not craft axe')
    }
  }

  // Step 6: Craft furnace
  if (!hasItem(bot, 'furnace')) {
    const ensuredFurnace = await ensureFurnaces(bot)
    if (!ensuredFurnace) {
      return fail('Could not craft furnace')
    }
  }

  // Step 7: Craft torches
  if (getItemCount(bot, 'torch') < 16) {
    const ensuredTorches = await ensureTorches(bot, 16)
    if (!ensuredTorches) {
      logger.withFields({
        torchCount: getItemCount(bot, 'torch'),
      }).warn('Early-game torch preparation failed; continuing with low-light fallback progression')
    }
  }

  bot.bot.chat('[Early Game] Basic tools ready! Moving to iron age.')
  return ok('Early game complete', true)
}

// ─── Phase: Iron Age ───

async function phaseIronAge(bot: Mineflayer, state: GameStateManager): Promise<PhaseResult> {
  // Phase: Find and smelt iron
  const worldState = await buildWorldStateSnapshot(bot)
  const currentY = worldState.position?.y ?? 64
  const attempts = state.getAttempts()
  // After 5 failed attempts, or if near surface (y>=58), skip escape requirement
  // to avoid infinite loop of failed surface-exit pathfinding
  const escapeAttemptsExhausted = attempts >= 5
  const nearSurface = currentY >= 58
  const shouldEscapeToSurfaceBeforeMining = (worldState.terrainContext === 'underground_cave' || worldState.surfaceEscapeNeeded)
    && !hasSafeMiningKit(bot)
    && (!escapeAttemptsExhausted || !nearSurface)

  if (shouldEscapeToSurfaceBeforeMining) {
    const escapedTowardSurface = await escapeTowardSurface(bot, {
      biome: worldState.biome,
      immediateTerrain: worldState.immediateTerrain,
      position: worldState.position,
    })
    if (escapedTowardSurface) {
      return progress('Escaping cave before mining with a safer starter kit...')
    }

    const relocated = await relocationProducedMovement(
      bot,
      () => moveAway(bot, 64),
    )
    if (relocated) {
      return progress('Relocating toward safer surface terrain before mining...')
    }

    return fail('Could not reach safer surface terrain before mining')
  }

  if (escapeAttemptsExhausted && nearSurface) {
    logger.withFields({
      attempts,
      currentY,
      terrainContext: worldState.terrainContext,
    }).warn('Skipping surface escape after repeated failures (near surface, proceeding to mine)')
  }

  if (!hasAnyActualSword(bot)) {
    const ensuredSword = await ensureSword(bot)
    await refreshInventoryState(bot)
    if (!ensuredSword || !hasAnyActualSword(bot)) {
      if (
        ensuredSword
        && hasOptimisticCraftedItemAwaitingSync(
          bot,
          ['wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword'],
        )
      ) {
        return progress('Crafted sword before cave mining; waiting for bridge inventory sync...')
      }
      if (isBridgeCraftSyncBlocked(bot)) {
        if (isBridgeBuildRestartRequired(bot)) {
          return fail('Bridge capability blocked craft sync: installed bridge jar is newer than the running Fabric mod build; Minecraft restart required')
        }
        return fail('Bridge capability blocked craft sync: combat starter craft did not sync to bot state')
      }
      return fail('Could not craft sword before cave mining')
    }
    return progress('Crafted sword before cave mining')
  }

  // Need smelting fuel before iron processing.
  // After many attempts, reduce fuel requirement to avoid blocking iron progression
  const fuelRequirement = attempts >= 8 ? 1 : 16
  if (getCoalLikeFuelCount(bot) < fuelRequirement) {
    logger.log('Securing smelting fuel...')
    const fuelEnsured = await ensureCoal(bot, fuelRequirement, 64)
    await refreshInventoryState(bot)
    if (fuelEnsured && getCoalLikeFuelCount(bot) >= fuelRequirement) {
      return progress('Secured smelting fuel')
    }
    if (attempts >= 10) {
      logger.warn('Skipping fuel requirement after many failed attempts, proceeding to mine iron directly')
    }
    else {
      await moveAway(bot, 40)
      return progress('Searching for smelting fuel...')
    }
  }

  // Prepare torches when possible, but do not hard-block iron progression if fuel is scarce.
  if (getActualTorchCount(bot) < 8) {
    const ensuredTorches = await ensureTorches(bot, 16)
    await refreshInventoryState(bot)
    if (ensuredTorches && getActualTorchCount(bot) >= 8) {
      return progress('Prepared torches before cave mining')
    }
    if (
      ensuredTorches
      && hasOptimisticCraftedItemAwaitingSync(bot, ['torch'], 8)
    ) {
      return progress('Prepared torches before cave mining; waiting for bridge inventory sync...')
    }
    if (isBridgeCraftSyncBlocked(bot)) {
      if (isBridgeBuildRestartRequired(bot)) {
        return fail('Bridge capability blocked craft sync: installed bridge jar is newer than the running Fabric mod build; Minecraft restart required')
      }
      return fail('Bridge capability blocked craft sync: torch craft did not sync to bot state')
    }

    logger.withFields({
      torchCount: getActualTorchCount(bot),
      coalCount: getItemCount(bot, 'coal'),
      charcoalCount: getItemCount(bot, 'charcoal'),
      terrainContext: worldState.terrainContext,
      surfaceEscapeNeeded: worldState.surfaceEscapeNeeded,
    }).warn('Torches are still unavailable; continuing iron-age progression with low-light fallback')
  }

  // Mine iron ore
  const rawIronCount = getItemCount(bot, 'raw_iron')
  const ironIngots = getItemCount(bot, 'iron_ingot')

  if (rawIronCount + ironIngots < 24) {
    logger.log('Mining iron ore...')
    const needed = 24 - rawIronCount - ironIngots
    const found = await collectBlock(bot, 'iron_ore', needed, 64)
    if (!found) {
      // Try deeper - mine down
      await mineDownward(bot, 10)
      return progress('Mining deeper for iron...')
    }
    return progress('Mined iron ore')
  }

  // Smelt iron
  if (rawIronCount > 0 && ironIngots < 20) {
    logger.log('Smelting iron...')
    // Ensure furnace is placed
    if (!hasItem(bot, 'furnace') && !getNearestBlock(bot, 'furnace', 32)) {
      await ensureFurnaces(bot)
    }
    await smeltItem(bot, 'raw_iron', Math.min(rawIronCount, 16))
    return progress('Smelted iron')
  }

  // Craft iron tools and armor
  const ironUtilityCrafts = [
    { itemName: 'iron_pickaxe', label: 'iron pickaxe', cost: 3 },
    { itemName: 'iron_sword', label: 'iron sword', cost: 2 },
    { itemName: 'bucket', label: 'bucket', cost: 3 },
    { itemName: 'shield', label: 'shield', cost: 2 },
  ] as const

  for (const craft of ironUtilityCrafts) {
    if (ironIngots < craft.cost || hasActualItem(bot, craft.itemName)) {
      continue
    }

    if (hasOptimisticCraftedItemAwaitingSync(bot, [craft.itemName])) {
      return progress(`Crafted ${craft.label}; waiting for bridge inventory sync...`)
    }

    const craftState = await craftRecipeWithActualConfirmation(bot, craft.itemName, 1)
    if (craftState === 'confirmed') {
      return progress(`Crafted ${craft.label}`)
    }
    if (craftState === 'pending_sync') {
      return progress(`Crafted ${craft.label}; waiting for bridge inventory sync...`)
    }
    return fail(`Could not craft ${craft.label}`)
  }

  const ironArmorCrafts = [
    { itemName: 'iron_chestplate', label: 'iron chestplate', cost: 8 },
    { itemName: 'iron_leggings', label: 'iron leggings', cost: 7 },
    { itemName: 'iron_helmet', label: 'iron helmet', cost: 5 },
    { itemName: 'iron_boots', label: 'iron boots', cost: 4 },
  ] as const

  for (const craft of ironArmorCrafts) {
    if (ironIngots < craft.cost || hasActualItem(bot, craft.itemName)) {
      continue
    }

    if (hasOptimisticCraftedItemAwaitingSync(bot, [craft.itemName])) {
      return progress(`Crafted ${craft.label}; waiting for bridge inventory sync...`)
    }

    const craftState = await craftRecipeWithActualConfirmation(bot, craft.itemName, 1)
    if (craftState === 'confirmed') {
      return progress(`Crafted ${craft.label}`)
    }
    if (craftState === 'pending_sync') {
      return progress(`Crafted ${craft.label}; waiting for bridge inventory sync...`)
    }
    return fail(`Could not craft ${craft.label}`)
  }

  // Equip iron armor
  await equipBestArmor(bot)

  // Craft flint and steel for later
  if (!hasActualItem(bot, 'flint_and_steel') && hasItem(bot, 'flint') && ironIngots >= 1) {
    if (hasOptimisticCraftedItemAwaitingSync(bot, ['flint_and_steel'])) {
      return progress('Crafted flint and steel; waiting for bridge inventory sync...')
    }
    const craftState = await craftRecipeWithActualConfirmation(bot, 'flint_and_steel', 1)
    if (craftState === 'confirmed') {
      return progress('Crafted flint and steel')
    }
    if (craftState === 'pending_sync') {
      return progress('Crafted flint and steel; waiting for bridge inventory sync...')
    }
    return fail('Could not craft flint and steel')
  }

  // Get flint from gravel if needed
  if (!hasItem(bot, 'flint') && !hasItem(bot, 'flint_and_steel')) {
    const gravel = getNearestBlock(bot, 'gravel', 64)
    if (gravel) {
      await collectBlock(bot, 'gravel', 10, 64)
      // Flint drops from gravel ~10% of the time
    }
  }

  bot.bot.chat('[Iron Age] Iron equipment ready!')
  return ok('Iron age complete', true)
}

// ─── Phase: Food Supply ───

async function phaseFoodSupply(bot: Mineflayer, _state: GameStateManager): Promise<PhaseResult> {
  // Phase: Gather food

  // Kill animals for food
  const rawFood = getRawFoodCount(bot)
  const cookedFood = getFoodCount(bot)

  if (cookedFood >= 32) {
    bot.bot.chat('[Food] Food supply secured!')
    return ok('Food supply ready', true)
  }

  // Hunt animals
  if (rawFood < 16) {
    const animals = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'cod', 'salmon']
    let killed = false
    for (const animal of animals) {
      if (killed)
        break
      const entity = getNearestEntityWhere(bot, e => e.name === animal, 64)
      if (entity) {
        logger.log(`Hunting ${animal}...`)
        await attackNearest(bot, animal, true)
        killed = true
      }
    }
    if (!killed) {
      await moveAway(bot, 80)
      return progress('Searching for animals...')
    }
    // Pick up drops
    await sleep(1000)
    return progress('Hunted animals')
  }

  // Cook food
  if (rawFood > 0) {
    const rawFoods = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon']
    for (const food of rawFoods) {
      const count = getItemCount(bot, food)
      if (count > 0) {
        await smeltItem(bot, food, count)
        return progress(`Cooked ${food}`)
      }
    }
  }

  bot.bot.chat('[Food] Food supply ready!')
  return ok('Food supply ready', true)
}

// ─── Phase: Diamond Mining ───

async function phaseDiamondMining(bot: Mineflayer, _state: GameStateManager): Promise<PhaseResult> {
  // Phase: Mine enough diamonds for the pickaxe plus full armor set.
  const diamonds = getItemCount(bot, 'diamond')
  const missingCrafts = getMissingDiamondLoadoutCrafts(bot)
  const totalMissingCost = missingCrafts.reduce((sum, craft) => sum + craft.cost, 0)

  if (missingCrafts.length === 0) {
    if (!hasDiamondProgressionLoadout(bot)) {
      return progress('Crafted diamond loadout; waiting for inventory sync...')
    }
    await equipBestArmor(bot)
    bot.bot.chat('[Diamond Mining] Diamond loadout ready!')
    return ok('Diamond loadout complete', true)
  }

  const nextCraft = missingCrafts.find(craft => diamonds >= craft.cost)
  if (nextCraft) {
    if (hasOptimisticCraftedItemAwaitingSync(bot, [nextCraft.name])) {
      return progress(`Crafted ${nextCraft.label}; waiting for inventory sync...`)
    }

    const craftState = await craftRecipeWithActualConfirmation(bot, nextCraft.name, 1)
    if (craftState === 'failed') {
      return fail(`Could not craft ${nextCraft.label}`)
    }
    if (nextCraft.name !== 'diamond_pickaxe' && craftState === 'confirmed') {
      await equipBestArmor(bot)
    }
    return progress(
      craftState === 'confirmed'
        ? `Crafted ${nextCraft.label}`
        : `Crafted ${nextCraft.label}; waiting for inventory sync...`,
    )
  }

  // Mine down to diamond level (Y=-58 to Y=16)
  const pos = getPosition(bot)
  if (pos.y > 16) {
    logger.log('Mining down to diamond level...')
    await mineDownward(bot, Math.min(Math.floor(pos.y - 10), 40))
    return progress('Mining to diamond level...')
  }

  // At diamond level, strip mine
  logger.log('Strip mining for diamonds...')
  const found = await collectBlock(bot, 'diamond_ore', Math.max(1, totalMissingCost - diamonds), 32)
  if (!found) {
    // Branch mine - dig a tunnel
    await branchMine(bot, 20)
    return progress('Branch mining for diamonds...')
  }

  return progress('Found diamonds for loadout progress!')
}

// ─── Phase: Nether Prep ───

async function phaseNetherPrep(bot: Mineflayer, _state: GameStateManager): Promise<PhaseResult> {
  // Phase: Prepare for the nether

  // Ensure diamond pickaxe
  if (!hasDiamondPickaxe(bot) && getItemCount(bot, 'diamond') >= 3) {
    if (hasOptimisticCraftedItemAwaitingSync(bot, ['diamond_pickaxe'])) {
      return progress('Crafted diamond pickaxe; waiting for inventory sync...')
    }
    const craftState = await craftRecipeWithActualConfirmation(bot, 'diamond_pickaxe', 1)
    if (craftState === 'confirmed') {
      return progress('Crafted diamond pickaxe')
    }
    if (craftState === 'pending_sync') {
      return progress('Crafted diamond pickaxe; waiting for inventory sync...')
    }
    return fail('Could not craft diamond pickaxe')
  }

  // Get flint and steel
  if (!hasItem(bot, 'flint_and_steel')) {
    if (!hasItem(bot, 'flint')) {
      await collectBlock(bot, 'gravel', 15, 64)
      // Check if we got flint
      if (!hasItem(bot, 'flint')) {
        await collectBlock(bot, 'gravel', 15, 64)
      }
    }
    if (hasItem(bot, 'flint') && hasItem(bot, 'iron_ingot')) {
      if (hasOptimisticCraftedItemAwaitingSync(bot, ['flint_and_steel'])) {
        return progress('Crafted flint and steel; waiting for inventory sync...')
      }
      const craftState = await craftRecipeWithActualConfirmation(bot, 'flint_and_steel', 1)
      if (craftState === 'confirmed') {
        return progress('Crafted flint and steel')
      }
      if (craftState === 'pending_sync') {
        return progress('Crafted flint and steel; waiting for inventory sync...')
      }
      return fail('Could not craft flint and steel')
    }
    return progress('Getting flint and steel...')
  }

  // Get obsidian (need 10)
  const obsidian = getItemCount(bot, 'obsidian')
  if (obsidian < 10) {
    if (!hasDiamondPickaxe(bot)) {
      return fail('Need diamond pickaxe for obsidian')
    }

    // Try to find existing obsidian
    const found = await collectBlock(bot, 'obsidian', 10 - obsidian, 64)
    if (!found) {
      // Create obsidian with water bucket + lava
      await createObsidian(bot, 10 - obsidian)
    }
    return progress(`Gathering obsidian (${obsidian + 1}/10)...`)
  }

  // Ensure enough food
  if (getFoodCount(bot) < 20) {
    return progress('Need more food before Nether')
  }

  bot.bot.chat('[Nether Prep] Ready to build Nether portal!')
  return ok('Nether prep complete', true)
}

// ─── Phase: Nether Portal ───

async function phaseNetherPortal(bot: Mineflayer, state: GameStateManager): Promise<PhaseResult> {
  // Phase: Build nether portal

  // Build the portal
  const pos = getPosition(bot)
  const portalBase = new Vec3(Math.floor(pos.x) + 2, Math.floor(pos.y), Math.floor(pos.z))

  // Build 4x5 frame (no corners needed = 10 obsidian)
  const portalBlocks = getPortalFramePositions(portalBase)

  for (const p of portalBlocks) {
    const block = bot.bot.blockAt(p)
    if (block && block.name !== 'obsidian') {
      await placeBlock(bot, 'obsidian', p.x, p.y, p.z)
      await sleep(300)
    }
  }

  // Light the portal with flint and steel
  const insideBlock = bot.bot.blockAt(portalBase.offset(1, 1, 0))
  if (insideBlock && insideBlock.name !== 'nether_portal') {
    try {
      const flint = bot.bot.inventory.items().find(i => i.name === 'flint_and_steel')
      if (flint) {
        await bot.bot.equip(flint, 'hand')
        const lowerInside = bot.bot.blockAt(portalBase.offset(1, 1, 0))
        if (lowerInside) {
          await goToPosition(bot, portalBase.x + 1, portalBase.y, portalBase.z - 1, 1)
          await bot.bot.activateBlock(lowerInside)
        }
      }
    }
    catch (err) {
      logger.withError(err).warn('Failed to light portal')
    }
  }

  // Save portal location
  state.saveLocation('nether_portal', {
    x: portalBase.x,
    y: portalBase.y,
    z: portalBase.z,
    dimension: 'overworld',
    label: 'Nether Portal',
  })

  bot.bot.chat('[Portal] Nether portal built! Entering...')

  // Enter the portal
  await goToPosition(bot, portalBase.x + 1, portalBase.y, portalBase.z, 0)
  await sleep(5000) // Wait for portal teleport

  return ok('Nether portal built and entered', true)
}

function getPortalFramePositions(base: Vec3): Vec3[] {
  // 4-wide, 5-tall portal frame (no corners)
  const positions: Vec3[] = []
  // Bottom row (2 blocks)
  positions.push(base.offset(1, 0, 0))
  positions.push(base.offset(2, 0, 0))
  // Left column
  for (let y = 1; y <= 3; y++) positions.push(base.offset(0, y, 0))
  // Right column
  for (let y = 1; y <= 3; y++) positions.push(base.offset(3, y, 0))
  // Top row
  positions.push(base.offset(1, 4, 0))
  positions.push(base.offset(2, 4, 0))
  return positions
}

// ─── Phase: Nether Explore ───

async function phaseNetherExplore(bot: Mineflayer, state: GameStateManager): Promise<PhaseResult> {
  // Phase: Find nether fortress

  const dim = bot.bot.game.dimension
  if (dim !== 'the_nether') {
    // Need to go through portal
    const portalLoc = state.getLocation('nether_portal')
    if (portalLoc) {
      await goToPosition(bot, portalLoc.x + 1, portalLoc.y, portalLoc.z, 0)
      await sleep(5000)
      return progress('Entering Nether portal...')
    }
    return fail('No Nether portal location saved')
  }

  // Save nether spawn
  if (!state.getLocation('nether_spawn')) {
    const pos = getPosition(bot)
    state.saveLocation('nether_spawn', { x: pos.x, y: pos.y, z: pos.z, dimension: 'the_nether', label: 'Nether Spawn' })
  }

  // Look for nether fortress (nether_bricks block)
  const fortress = getNearestBlock(bot, 'nether_bricks', 128)
  if (fortress) {
    state.saveLocation('fortress', {
      x: fortress.position.x,
      y: fortress.position.y,
      z: fortress.position.z,
      dimension: 'the_nether',
      label: 'Nether Fortress',
    })
    bot.bot.chat('[Nether] Found a Nether Fortress!')
    return ok('Found fortress', true)
  }

  // Navigate in one direction to find fortress
  // Fortresses generate along the Z axis in the nether
  const pos = getPosition(bot)
  const targetX = pos.x + 100
  try {
    await goToPosition(bot, targetX, pos.y, pos.z, 5)
  }
  catch {
    // Pathfinding in nether can be tricky, try moving manually
    await moveAway(bot, 30)
  }

  return progress('Searching for Nether Fortress...')
}

// ─── Phase: Blaze Hunting ───

async function phaseBlazeHunting(bot: Mineflayer, state: GameStateManager): Promise<PhaseResult> {
  // Phase: Hunt blazes

  const blazeRods = getItemCount(bot, 'blaze_rod')
  if (blazeRods >= 7) {
    bot.bot.chat('[Blaze] Got enough blaze rods! Heading back...')
    // Return to overworld
    const netherSpawn = state.getLocation('nether_spawn')
    if (netherSpawn) {
      await goToPosition(bot, netherSpawn.x, netherSpawn.y, netherSpawn.z, 3)
      await sleep(5000)
    }
    return ok('Blaze hunting complete', true)
  }

  // Go to fortress if we know where it is
  const fortressLoc = state.getLocation('fortress')
  if (fortressLoc) {
    const pos = getPosition(bot)
    if (pos.distanceTo(new Vec3(fortressLoc.x, fortressLoc.y, fortressLoc.z)) > 20) {
      await goToPosition(bot, fortressLoc.x, fortressLoc.y, fortressLoc.z, 5)
    }
  }

  // Find and kill blazes
  const blaze = getNearestEntityWhere(bot, e => e.name === 'blaze', 32)
  if (blaze) {
    logger.log('Found a blaze! Attacking...')
    await attackEntity(bot, blaze, true)
    await sleep(1000)
    return progress(`Killed blaze (rods: ${blazeRods + 1}/7)`)
  }

  // Look for blaze spawner
  const spawner = getNearestBlock(bot, 'spawner', 32)
  if (spawner) {
    await goToPosition(bot, spawner.position.x, spawner.position.y, spawner.position.z, 5)
    await sleep(3000) // Wait for spawns
    return progress('Waiting near spawner for blazes...')
  }

  // Explore fortress more
  await moveAway(bot, 20)
  return progress('Exploring fortress for blazes...')
}

// ─── Phase: Enderman Hunting ───

async function phaseEndermanHunting(bot: Mineflayer, state: GameStateManager): Promise<PhaseResult> {
  // Phase: Hunt endermen

  const pearlTarget = getRequiredEnderEyes(state)
  const pearls = getItemCount(bot, 'ender_pearl')
  if (pearls >= pearlTarget) {
    bot.bot.chat('[Enderman] Got enough ender pearls!')
    return ok('Enderman hunting complete', true)
  }

  // Make sure we're in overworld
  if (bot.bot.game.dimension !== 'overworld') {
    const netherSpawn = state.getLocation('nether_spawn')
    if (netherSpawn) {
      await goToPosition(bot, netherSpawn.x, netherSpawn.y, netherSpawn.z, 3)
      await sleep(5000)
    }
    return progress('Returning to overworld...')
  }

  // Hunt endermen - they're more common at night and in deserts/plains
  const enderman = getNearestEntityWhere(bot, e => e.name === 'enderman', 64)
  if (enderman) {
    logger.log('Found enderman! Attacking...')
    // Equip best weapon
    await equipBestWeapon(bot)
    await attackEntity(bot, enderman, true)
    await sleep(1000)
    return progress(`Killed enderman (pearls: ${pearls}/${pearlTarget})`)
  }

  // Wait for night for more enderman spawns
  if (!isNightTime(bot)) {
    // Move to an open area (plains/desert)
    await moveAway(bot, 40)
    return progress('Searching for endermen... (waiting for night)')
  }

  // At night, wander around open areas looking for endermen
  await moveAway(bot, 30)
  return progress(`Hunting endermen at night (pearls: ${pearls}/${pearlTarget})`)
}

// ─── Phase: Eye of Ender Crafting ───

async function phaseEyeCrafting(bot: Mineflayer, _state: GameStateManager): Promise<PhaseResult> {
  // Phase: Craft eyes of ender
  const requiredEyes = getRequiredEnderEyes(_state)
  const eyes = getItemCount(bot, 'ender_eye')
  const neededEyes = Math.max(0, requiredEyes - eyes)

  // Craft blaze powder from blaze rods
  if (neededEyes > 0 && getItemCount(bot, 'blaze_powder') < neededEyes) {
    const rods = getItemCount(bot, 'blaze_rod')
    if (rods > 0) {
      const powderBefore = getActualItemCount(bot, 'blaze_powder')
      const craftCount = Math.min(rods, Math.ceil((neededEyes - getItemCount(bot, 'blaze_powder')) / 2))
      if (hasOptimisticCraftedItemAwaitingSync(bot, ['blaze_powder'])) {
        return progress('Crafted blaze powder; waiting for inventory sync...')
      }
      const craftState = await craftRecipeWithActualConfirmation(bot, 'blaze_powder', craftCount, {
        minActualCount: powderBefore + Math.max(1, craftCount),
      })
      if (craftState === 'confirmed') {
        return progress('Crafted blaze powder')
      }
      if (craftState === 'pending_sync') {
        return progress('Crafted blaze powder; waiting for inventory sync...')
      }
      return fail('Could not craft blaze powder')
    }
  }

  // Craft eyes of ender
  if (neededEyes > 0) {
    const powder = getItemCount(bot, 'blaze_powder')
    const pearls = getItemCount(bot, 'ender_pearl')
    const canCraft = Math.min(powder, pearls, neededEyes)
    if (canCraft > 0) {
      const eyesBefore = getActualItemCount(bot, 'ender_eye')
      if (hasOptimisticCraftedItemAwaitingSync(bot, ['ender_eye'], canCraft)) {
        return progress(`Crafted ${canCraft} eyes of ender; waiting for inventory sync...`)
      }
      const craftState = await craftRecipeWithActualConfirmation(bot, 'ender_eye', canCraft, {
        minActualCount: eyesBefore + canCraft,
      })
      if (craftState === 'confirmed') {
        return progress(`Crafted ${canCraft} eyes of ender`)
      }
      if (craftState === 'pending_sync') {
        return progress(`Crafted ${canCraft} eyes of ender; waiting for inventory sync...`)
      }
      return fail('Could not craft eyes of ender')
    }
    return resumePrerequisitePhase(
      bot,
      _state,
      GamePhase.EYE_CRAFTING,
      'Not enough eye materials; resuming prerequisite gathering',
    )
  }

  bot.bot.chat('[Eyes] Eyes of ender ready!')
  return ok('Eye crafting complete', true)
}

// ─── Phase: Find Stronghold ───

async function phaseStronghold(bot: Mineflayer, state: GameStateManager): Promise<PhaseResult> {
  // Phase: Find stronghold
  const eyeItem = bot.bot.inventory.items().find(i => i.name === 'ender_eye')
  if (!eyeItem) {
    return fail('No eyes of ender!')
  }

  const pos = getPosition(bot)
  const attempts = state.getAttempts()
  const strongholdEstimate = state.getLocation('stronghold_estimate')

  const nearbyStrongholdBlock = getNearestBlock(bot, 'stone_bricks', 48)
    || getNearestBlock(bot, 'mossy_stone_bricks', 48)
    || getNearestBlock(bot, 'cracked_stone_bricks', 48)
    || getNearestBlock(bot, 'infested_stone_bricks', 48)

  if (nearbyStrongholdBlock) {
    state.saveLocation('stronghold', {
      x: nearbyStrongholdBlock.position.x,
      y: nearbyStrongholdBlock.position.y,
      z: nearbyStrongholdBlock.position.z,
      dimension: 'overworld',
      label: 'Stronghold',
    })
    bot.bot.chat('[Stronghold] Found the stronghold!')
    return ok('Found stronghold', true)
  }

  if (!strongholdEstimate && attempts <= 2) {
    const estimated = await triangulateStronghold(bot)
    if (estimated) {
      state.saveLocation('stronghold_estimate', {
        x: estimated.x,
        y: pos.y,
        z: estimated.z,
        dimension: 'overworld',
        label: 'Stronghold Estimate',
      })
      bot.bot.chat(`[Stronghold] Estimated at ${estimated.x}, ${estimated.z}`)
      return progress('Triangulated stronghold estimate')
    }
  }

  if (strongholdEstimate) {
    const estimatePos = new Vec3(strongholdEstimate.x, strongholdEstimate.y, strongholdEstimate.z)
    const horizontalDistance = pos.distanceTo(estimatePos)

    if (horizontalDistance > 24) {
      await goToPosition(bot, strongholdEstimate.x, strongholdEstimate.y, strongholdEstimate.z, 8)
      return progress('Traveling toward triangulated stronghold estimate...')
    }

    bot.bot.chat('[Stronghold] Near estimated location, digging to locate the structure...')
    await mineDownward(bot, 40)

    const located = getNearestBlock(bot, 'stone_bricks', 48)
      || getNearestBlock(bot, 'mossy_stone_bricks', 48)
      || getNearestBlock(bot, 'cracked_stone_bricks', 48)
      || getNearestBlock(bot, 'infested_stone_bricks', 48)

    if (located) {
      state.saveLocation('stronghold', {
        x: located.position.x,
        y: located.position.y,
        z: located.position.z,
        dimension: 'overworld',
        label: 'Stronghold',
      })
      bot.bot.chat('[Stronghold] Found the stronghold!')
      return ok('Found stronghold', true)
    }

    await moveAway(bot, 24)
    return progress('Repositioning around stronghold estimate...')
  }

  await moveAway(bot, 64)
  return progress(`Searching for a better stronghold triangulation point (attempt ${attempts + 1})...`)
}

// ─── Phase: End Portal ───

async function phaseEndPortal(bot: Mineflayer, state: GameStateManager): Promise<PhaseResult> {
  // Phase: Activate end portal

  const strongholdLoc = state.getLocation('stronghold')
  if (!strongholdLoc)
    return fail('No stronghold location')

  // Navigate to stronghold
  const pos = getPosition(bot)
  if (pos.distanceTo(new Vec3(strongholdLoc.x, strongholdLoc.y, strongholdLoc.z)) > 10) {
    await goToPosition(bot, strongholdLoc.x, strongholdLoc.y, strongholdLoc.z, 3)
  }

  // Find end portal frame
  const portalFrame = getNearestBlock(bot, 'end_portal_frame', 64)
  if (!portalFrame) {
    // Search more of the stronghold
    await moveAway(bot, 15)
    return progress('Searching for End portal room...')
  }

  // Go to portal frame area
  await goToPosition(bot, portalFrame.position.x, portalFrame.position.y, portalFrame.position.z, 3)

  // Place eyes of ender in empty frames
  const frames = getNearestBlocks(bot, 'end_portal_frame', 16, 12)
  const countEyesInInventory = () => bot.bot.inventory.items()
    .filter(item => item.name === 'ender_eye')
    .reduce((total, item) => total + item.count, 0)
  const emptyFrames = frames.filter((frame) => {
    const props = frame.getProperties()
    return !props.eye || props.eye === 'false'
  })
  let filled = 0
  for (const frame of emptyFrames) {
    const eye = bot.bot.inventory.items().find(i => i.name === 'ender_eye')
    if (!eye) {
      break
    }
    try {
      await bot.bot.equip(eye, 'hand')
      await goToPosition(bot, frame.position.x, frame.position.y, frame.position.z, 2)
      await bot.bot.activateBlock(frame)
      filled++
      await sleep(500)
    }
    catch (err) {
      logger.withError(err).warn('Failed to place eye in frame')
    }
  }

  if (filled > 0) {
    bot.bot.chat(`[End Portal] Placed ${filled} eyes of ender`)
  }

  await refreshInventoryState(bot)

  // Check if portal is active
  const activePortal = getNearestBlock(bot, 'end_portal', 10)
  if (activePortal) {
    bot.bot.chat('[End Portal] Portal activated! Jumping in!')
    await goToPosition(bot, activePortal.position.x, activePortal.position.y, activePortal.position.z, 0)
    await sleep(3000)
    return ok('Entered The End', true)
  }

  const currentEyes = countEyesInInventory()
  const minimumFramesStillEmpty = Math.max(0, emptyFrames.length - filled)
  if (minimumFramesStillEmpty > 0 && currentEyes < minimumFramesStillEmpty) {
    const missingPortalEyes = minimumFramesStillEmpty - currentEyes
    const availablePowder = getItemCount(bot, 'blaze_powder') + (getItemCount(bot, 'blaze_rod') * 2)
    const availablePearls = getItemCount(bot, 'ender_pearl')
    if (availablePowder >= missingPortalEyes && availablePearls >= missingPortalEyes) {
      state.setPhase(GamePhase.EYE_CRAFTING)
      return progress('Portal still needs more eyes of ender; gathering more materials before retrying')
    }
    return resumePrerequisitePhase(
      bot,
      state,
      GamePhase.END_PORTAL,
      'Portal still needs more eyes of ender; gathering more materials before retrying',
    )
  }

  return progress('Activating portal...')
}

// ─── Phase: Dragon Fight ───

async function phaseDragonFight(bot: Mineflayer, state: GameStateManager): Promise<PhaseResult> {
  // Phase: Fight the ender dragon

  // Equip best gear
  await equipBestArmor(bot)
  await equipBestWeapon(bot)
  if (!hasBow(bot)) {
    await ensureBow(bot)
  }
  if (hasBow(bot) && !hasArrows(bot)) {
    await ensureArrows(bot, 24)
  }

  // Find the dragon
  const dragon = getNearestEntityWhere(bot, e => e.name === 'ender_dragon', 200)

  if (!dragon) {
    // Check if dragon is defeated (experience orbs, dragon egg, etc.)
    const dragonEgg = getNearestBlock(bot, 'dragon_egg', 200)
    if (dragonEgg) {
      bot.bot.chat('THE ENDER DRAGON HAS BEEN DEFEATED!')
      state.setPhase(GamePhase.VICTORY)
      return ok('Ender Dragon defeated!', false)
    }

    // Also check for end_gateway which appears after dragon death
    const gateway = getNearestBlock(bot, 'end_gateway', 200)
    if (gateway) {
      bot.bot.chat('THE ENDER DRAGON HAS BEEN DEFEATED!')
      state.setPhase(GamePhase.VICTORY)
      return ok('Ender Dragon defeated!', false)
    }

    // Wait for dragon to appear
    await sleep(2000)
    return progress('Waiting for dragon to appear...')
  }

  // Destroy end crystals first
  const crystal = getNearestEntityWhere(bot, e => e.name === 'end_crystal', 64)
  if (crystal) {
    logger.log('Destroying end crystal...')
    try {
      if (hasBow(bot) && hasArrows(bot)) {
        await rangedAttack(bot, 'end_crystal', 1)
      }
      else {
        await attackEntity(bot, crystal, false)
      }
    }
    catch {
      // Crystal might explode before we reach it
    }
    return progress('Destroying end crystals...')
  }

  // Attack the dragon when it's close
  const distance = bot.bot.entity.position.distanceTo(dragon.position)
  if (distance < 10) {
    try {
      await bot.bot.attack(dragon)
    }
    catch {
      // Dragon might move
    }
  }
  else if (hasBow(bot) && hasArrows(bot)) {
    try {
      await rangedAttack(bot, 'ender_dragon', 1)
    }
    catch {
      // Dragon might move or be out of view
    }
  }
  else {
    // Move toward the center of the end island (0, ~64, 0)
    try {
      await goToPosition(bot, 0, 64, 0, 10)
    }
    catch {
      await moveAway(bot, 5)
    }
  }

  return progress(`Fighting dragon (distance: ${distance.toFixed(0)})...`)
}

// ─── Utility Functions ───

async function mineDownward(bot: Mineflayer, blocks: number): Promise<void> {
  for (let i = 0; i < blocks; i++) {
    // Get fresh position each iteration
    const currentPos = getPosition(bot)
    const targetY = Math.floor(currentPos.y) - 1
    if (targetY < -60)
      break

    // Staircase pattern: alternate X offset for safe descent
    const x = Math.floor(currentPos.x) + (i % 2)
    const z = Math.floor(currentPos.z)
    try {
      // Break block below and the one at foot level
      await breakBlockAt(bot, x, targetY, z)
      if (i % 2 === 1) {
        // On alternate steps, also break the block at head height for the next position
        await breakBlockAt(bot, x, targetY + 1, z)
      }
      await goToPosition(bot, x, targetY, z, 0)

      // Place torch periodically
      if (i % 5 === 0 && getItemCount(bot, 'torch') > 0) {
        try {
          await placeBlock(bot, 'torch', x, targetY + 2, z, 'bottom', true)
        }
        catch { /* torch placement is optional */ }
      }
    }
    catch {
      break
    }
  }
}

async function branchMine(bot: Mineflayer, length: number): Promise<void> {
  const startPos = getPosition(bot)
  const startX = Math.floor(startPos.x)
  const y = Math.floor(startPos.y)
  const z = Math.floor(startPos.z)

  for (let i = 1; i <= length; i++) {
    try {
      // Mine a 1x2 tunnel forward
      await breakBlockAt(bot, startX + i, y, z)
      await breakBlockAt(bot, startX + i, y + 1, z)
      await goToPosition(bot, startX + i, y, z, 0)

      if (i % 6 === 0 && getItemCount(bot, 'torch') > 0) {
        try {
          await placeBlock(bot, 'torch', startX + i, y + 1, z, 'bottom', true)
        }
        catch { /* torch placement optional */ }
      }
    }
    catch {
      break
    }
  }
}

async function createObsidian(bot: Mineflayer, count: number): Promise<void> {
  // Strategy: find lava source, place water on it to create obsidian
  const bucket = bot.bot.inventory.items().find(i => i.name === 'bucket' || i.name === 'water_bucket')
  if (!bucket) {
    logger.log('No bucket for obsidian creation')
    return
  }

  // If we don't have water, get it
  if (bucket.name === 'bucket') {
    const water = getNearestBlock(bot, 'water', 32)
    if (water) {
      await goToPosition(bot, water.position.x, water.position.y, water.position.z, 2)
      await bot.bot.equip(bucket, 'hand')
      try {
        const waterBlock = bot.bot.blockAt(water.position)
        if (waterBlock)
          await bot.bot.activateBlock(waterBlock)
      }
      catch { /* continue */ }
    }
  }

  // Find lava
  const lava = getNearestBlock(bot, 'lava', 64)
  if (!lava) {
    // Mine down to find lava (below Y=10)
    const pos = getPosition(bot)
    if (pos.y > 15) {
      await mineDownward(bot, Math.floor(pos.y) - 10)
    }
    return
  }

  // Pour water adjacent to lava to create obsidian
  await goToPosition(bot, lava.position.x, lava.position.y, lava.position.z, 3)
  const waterBucket = bot.bot.inventory.items().find(i => i.name === 'water_bucket')
  if (waterBucket) {
    await bot.bot.equip(waterBucket, 'hand')
    await bot.bot.lookAt(lava.position)
    try {
      await bot.bot.activateItem()
      await sleep(2000)
      // Pick up water again
      const waterBlock = getNearestBlock(bot, 'water', 8)
      if (waterBlock) {
        const emptyBucket = bot.bot.inventory.items().find(i => i.name === 'bucket')
        if (emptyBucket) {
          await bot.bot.equip(emptyBucket, 'hand')
          await bot.bot.activateBlock(waterBlock)
        }
      }
    }
    catch { /* continue */ }
  }

  // Mine the obsidian
  await collectBlock(bot, 'obsidian', count, 16)
}

async function equipBestArmor(bot: Mineflayer): Promise<void> {
  const armorPriority = [
    ['diamond_helmet', 'iron_helmet', 'chainmail_helmet', 'golden_helmet', 'leather_helmet'],
    ['diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'leather_chestplate'],
    ['diamond_leggings', 'iron_leggings', 'chainmail_leggings', 'golden_leggings', 'leather_leggings'],
    ['diamond_boots', 'iron_boots', 'chainmail_boots', 'golden_boots', 'leather_boots'],
  ]

  for (const tier of armorPriority) {
    for (const armorName of tier) {
      const item = bot.bot.inventory.items().find(i => i.name === armorName)
      if (item) {
        try {
          await equip(bot, armorName)
        }
        catch {
          /* already equipped or error */
        }
        break
      }
    }
  }
}

async function equipBestWeapon(bot: Mineflayer): Promise<void> {
  const weaponPriority = [
    'diamond_sword',
    'iron_sword',
    'stone_sword',
    'wooden_sword',
    'diamond_axe',
    'iron_axe',
    'stone_axe',
  ]
  for (const weapon of weaponPriority) {
    const item = bot.bot.inventory.items().find(i => i.name === weapon)
    if (item) {
      try {
        await bot.bot.equip(item, 'hand')
      }
      catch {
        /* continue */
      }
      return
    }
  }
}
