import type { Block } from 'prismarine-block'

import type { Mineflayer } from '../libs/mineflayer'

import { Vec3 } from 'vec3'

import { getAllBlocks } from '../utils/mcdata'

type BlockPosition = Vec3 | { x: number, y: number, z: number }
type BlockLike = Block

function toVec3(position: BlockPosition): Vec3 {
  return new Vec3(
    Math.floor(position.x),
    Math.floor(position.y),
    Math.floor(position.z),
  )
}

function stripNamespace(name: string): string {
  return name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name
}

function matchesBlockName(name: string, blockNames: string[]): boolean {
  const normalized = stripNamespace(name)
  return blockNames.some(candidate =>
    normalized === candidate
    || normalized.includes(candidate)
    || name === `minecraft:${candidate}`,
  )
}

function resolveBlockQueryNames(blockNames: string[]): string[] {
  const resolved = new Set<string>()
  const allBlockNames = getAllBlocks().map((block: { name: string }) => stripNamespace(block.name))

  for (const candidate of blockNames.map(stripNamespace)) {
    let matched = false
    const exactMatch = allBlockNames.includes(candidate)
    if (exactMatch) {
      resolved.add(candidate)
      matched = true
      continue
    }

    for (const blockName of allBlockNames) {
      if (matchesBlockName(blockName, [candidate])) {
        resolved.add(blockName)
        matched = true
      }
    }

    if (!matched) {
      resolved.add(candidate)
    }
  }

  return [...resolved].slice(0, 96)
}

function distanceTo(origin: BlockPosition, target: BlockPosition): number {
  const dx = origin.x - target.x
  const dy = origin.y - target.y
  const dz = origin.z - target.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function isAirLike(block: BlockLike | null): boolean {
  if (!block) {
    return true
  }

  const normalizedName = stripNamespace(block.name)
  return normalizedName === 'air' || normalizedName === 'cave_air' || normalizedName === 'void_air'
}

function isMiningExposureBlock(block: BlockLike | null): boolean {
  if (isAirLike(block)) {
    return true
  }

  if (!block) {
    return false
  }

  const normalizedName = stripNamespace(block.name)
  return [
    'water',
    'flowing_water',
    'bubble_column',
    'kelp',
    'kelp_plant',
    'seagrass',
    'tall_seagrass',
  ].includes(normalizedName)
}

export type MiningExposureKind = 'sealed' | 'fluid' | 'air'

function overlapsPlayerFootprint(origin: Vec3, candidate: Vec3, size: number): boolean {
  const playerFootX = Math.floor(origin.x)
  const playerFootY = Math.floor(origin.y)
  const playerFootZ = Math.floor(origin.z)

  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) {
      const candidateX = candidate.x + x
      const candidateZ = candidate.z + z
      const sameColumn = candidateX === playerFootX && candidateZ === playerFootZ
      const sameBodyY = candidate.y === playerFootY || candidate.y === playerFootY + 1
      if (sameColumn && sameBodyY) {
        return true
      }
    }
  }

  return false
}

export async function getBlockAtAccurate(
  mineflayer: Mineflayer,
  position: BlockPosition,
): Promise<Block | null> {
  const vec = toVec3(position)
  if ('blockAtAsync' in mineflayer.bot) {
    const accurateBlock = await (mineflayer.bot as any).blockAtAsync(vec) as Block | null
    if (accurateBlock) {
      return accurateBlock
    }

    // NOTICE: FabricBridge can populate its sync block cache with an air block while the
    // initial async `blockAtAsync` call still resolves `null`. Re-read the sync cache so
    // higher-level recovery and world-state code does not misclassify breathable air as
    // `unknown` on the first probe.
    if (typeof mineflayer.bot.blockAt === 'function') {
      return mineflayer.bot.blockAt(vec) as Block | null
    }

    return null
  }

  return mineflayer.bot.blockAt(vec) as Block | null
}

export function invalidateBlockCache(mineflayer: Mineflayer, position: BlockPosition): void {
  if ('invalidateBlock' in mineflayer.bot) {
    ;(mineflayer.bot as any).invalidateBlock(toVec3(position))
  }
}

export async function getNearestBlocksAccurate(
  mineflayer: Mineflayer,
  blockTypes: string[] | string,
  distance = 16,
  count = 128,
): Promise<Block[]> {
  const blockNames = resolveBlockQueryNames(Array.isArray(blockTypes) ? blockTypes : [blockTypes])
  const maxCount = Math.max(1, Math.min(count, 256))

  if ('findBlocksAsync' in mineflayer.bot) {
    const positions = await (mineflayer.bot as any).findBlocksAsync({
      matching: 0,
      maxDistance: distance,
      count: maxCount,
      blockNames,
    }) as BlockPosition[]

    const deduped = new Map<string, BlockPosition>()
    for (const position of positions) {
      const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
      if (!deduped.has(key)) {
        deduped.set(key, position)
      }
    }

    const blocks = await Promise.all(
      [...deduped.values()].map(async (position) => {
        const block = await getBlockAtAccurate(mineflayer, position)
        if (!block || !matchesBlockName(block.name, blockNames)) {
          invalidateBlockCache(mineflayer, position)
          return null
        }
        return block
      }),
    )

    return blocks
      .filter((block): block is Block => block !== null)
      .sort((left, right) =>
        distanceTo(mineflayer.bot.entity.position, left.position)
        - distanceTo(mineflayer.bot.entity.position, right.position),
      )
  }

  const positions = mineflayer.bot.findBlocks({
    matching: (block: BlockLike) => matchesBlockName(block.name, blockNames),
    maxDistance: distance,
    count: maxCount,
  }) as BlockPosition[]

  return positions
    .map(position => mineflayer.bot.blockAt(toVec3(position)) as BlockLike | null)
    .filter((block): block is BlockLike => block !== null)
    .sort((left, right) =>
      distanceTo(mineflayer.bot.entity.position, left.position)
      - distanceTo(mineflayer.bot.entity.position, right.position),
    )
}

export async function getNearestBlockAccurate(
  mineflayer: Mineflayer,
  blockType: string,
  distance = 16,
): Promise<Block | null> {
  const [block] = await getNearestBlocksAccurate(mineflayer, blockType, distance, 1)
  return block ?? null
}

export async function isBlockExposedAccurate(
  mineflayer: Mineflayer,
  position: BlockPosition,
): Promise<boolean> {
  return (await getMiningExposureKindAccurate(mineflayer, position)) !== 'sealed'
}

export async function getMiningExposureKindAccurate(
  mineflayer: Mineflayer,
  position: BlockPosition,
): Promise<MiningExposureKind> {
  const origin = toVec3(position)
  const neighborOffsets = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 1, 0),
    new Vec3(0, -1, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ]
  let hasFluidExposure = false

  for (const offset of neighborOffsets) {
    const neighbor = await getBlockAtAccurate(mineflayer, origin.plus(offset))
    if (isAirLike(neighbor)) {
      return 'air'
    }
    if (isMiningExposureBlock(neighbor)) {
      hasFluidExposure = true
    }
  }

  return hasFluidExposure ? 'fluid' : 'sealed'
}

export async function getNearestFreeSpaceAccurate(
  mineflayer: Mineflayer,
  size = 1,
  distance = 8,
): Promise<Vec3 | undefined> {
  const origin = toVec3(mineflayer.bot.entity.position)
  const candidates: Vec3[] = []

  for (let dx = -distance; dx <= distance; dx++) {
    for (let dz = -distance; dz <= distance; dz++) {
      for (const dy of [0, -1, 1]) {
        candidates.push(origin.offset(dx, dy, dz))
      }
    }
  }

  candidates.sort((left, right) => left.distanceTo(origin) - right.distanceTo(origin))

  for (const candidate of candidates) {
    if (overlapsPlayerFootprint(origin, candidate, size)) {
      continue
    }

    let empty = true

    for (let x = 0; x < size && empty; x++) {
      for (let z = 0; z < size; z++) {
        const top = await getBlockAtAccurate(mineflayer, candidate.offset(x, 0, z))
        const bottom = await getBlockAtAccurate(mineflayer, candidate.offset(x, -1, z))
        if (!isAirLike(top) || isAirLike(bottom) || !bottom?.diggable) {
          empty = false
          break
        }
      }
    }

    if (empty) {
      return candidate
    }
  }

  return undefined
}
