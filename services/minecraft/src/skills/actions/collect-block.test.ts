import { Vec3 } from 'vec3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getNearestBlocksAccurate: vi.fn(),
  getBlockAtAccurate: vi.fn(),
  getMiningExposureKindAccurate: vi.fn(),
  invalidateBlockCache: vi.fn(),
  breakBlockAt: vi.fn(),
  goToPosition: vi.fn(),
  pickupNearbyItems: vi.fn(),
  ensurePickaxe: vi.fn(),
}))

vi.mock('../block-access', () => ({
  getNearestBlocksAccurate: mocks.getNearestBlocksAccurate,
  getBlockAtAccurate: mocks.getBlockAtAccurate,
  getMiningExposureKindAccurate: mocks.getMiningExposureKindAccurate,
  invalidateBlockCache: mocks.invalidateBlockCache,
}))

vi.mock('../blocks', () => ({
  breakBlockAt: mocks.breakBlockAt,
}))

vi.mock('../movement', () => ({
  goToPosition: mocks.goToPosition,
}))

vi.mock('./world-interactions', () => ({
  pickupNearbyItems: mocks.pickupNearbyItems,
}))

vi.mock('./ensure', () => ({
  ensurePickaxe: mocks.ensurePickaxe,
}))

const { collectBlock } = await import('./collect-block')

function createBlock(name: string, x: number, y: number, z: number) {
  return {
    name,
    position: new Vec3(x, y, z),
    canHarvest: () => true,
  }
}

describe('collectBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMiningExposureKindAccurate.mockResolvedValue('air')
    mocks.breakBlockAt.mockResolvedValue(true)
    mocks.goToPosition.mockResolvedValue(true)
    mocks.pickupNearbyItems.mockResolvedValue(true)
    mocks.ensurePickaxe.mockResolvedValue(true)
  })

  it('tries another nearby candidate when the first block is unreachable', async () => {
    const firstBlock = createBlock('minecraft:oak_log', 10, 64, 10)
    const secondBlock = createBlock('minecraft:oak_log', 12, 64, 12)

    mocks.getNearestBlocksAccurate.mockResolvedValue([firstBlock, secondBlock])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer, position) => {
      if (position.x === secondBlock.position.x && position.y === secondBlock.position.y && position.z === secondBlock.position.z) {
        return secondBlock
      }
      return firstBlock
    })

    const goto = vi.fn()
      .mockRejectedValueOnce(new Error('path blocked'))
      .mockResolvedValue(undefined)

    const mineflayer = {
      bot: {
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(),
        },
        heldItem: { type: 1 },
        pathfinder: {
          goto,
          stop: vi.fn(),
        },
        inventory: {
          emptySlotCount: () => 5,
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'log', 1, 32)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledTimes(2)
    expect(mocks.invalidateBlockCache).toHaveBeenCalledWith(mineflayer, firstBlock.position)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 12, 64, 12)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 12, 64, 12, 1)
    expect(mocks.pickupNearbyItems).toHaveBeenCalledWith(mineflayer, 5)
  })

  it('skips buried stone candidates and chooses an exposed one instead', async () => {
    const buriedStone = createBlock('minecraft:stone', 8, 64, 8)
    const exposedStone = createBlock('minecraft:stone', 9, 64, 9)

    mocks.getNearestBlocksAccurate.mockResolvedValue([buriedStone, exposedStone])
    mocks.getMiningExposureKindAccurate.mockImplementation(async (_mineflayer, position) =>
      position.x === exposedStone.position.x && position.z === exposedStone.position.z ? 'air' : 'sealed')
    mocks.getBlockAtAccurate.mockResolvedValue(exposedStone)

    const goto = vi.fn().mockResolvedValue(undefined)

    const mineflayer = {
      bot: {
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(),
        },
        heldItem: { type: 1, name: 'wooden_pickaxe' },
        pathfinder: {
          goto,
          stop: vi.fn(),
        },
        inventory: {
          items: () => [{ name: 'wooden_pickaxe', count: 1 }],
          emptySlotCount: () => 5,
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'stone', 1, 32)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledTimes(1)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      x: exposedStone.position.x,
      y: exposedStone.position.y,
      z: exposedStone.position.z,
      rangeSq: 16,
    }))
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 9, 64, 9)
  })

  it('scans beyond the first buried stone cluster to find an exposed candidate', async () => {
    const buriedCandidates = Array.from({ length: 12 }, (_, index) =>
      createBlock('minecraft:stone', 40 + index, 60, 40 + index))
    const exposedStone = createBlock('minecraft:stone', 80, 58, 80)

    mocks.getNearestBlocksAccurate.mockResolvedValue([...buriedCandidates, exposedStone])
    mocks.getMiningExposureKindAccurate.mockImplementation(async (_mineflayer, position) =>
      (position.x === exposedStone.position.x
        && position.y === exposedStone.position.y
        && position.z === exposedStone.position.z)
        ? 'air'
        : 'sealed')
    mocks.getBlockAtAccurate.mockResolvedValue(exposedStone)

    const goto = vi.fn().mockResolvedValue(undefined)
    const mineflayer = {
      bot: {
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(),
        },
        heldItem: { type: 1, name: 'wooden_pickaxe' },
        pathfinder: {
          goto,
          stop: vi.fn(),
        },
        inventory: {
          items: () => [{ name: 'wooden_pickaxe', count: 1 }],
          emptySlotCount: () => 5,
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'stone', 1, 32)

    expect(success).toBe(true)
    expect(mocks.getNearestBlocksAccurate).toHaveBeenCalledWith(mineflayer, ['stone'], 32, 48)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(
      mineflayer,
      exposedStone.position.x,
      exposedStone.position.y,
      exposedStone.position.z,
    )
  })

  it('approaches elevated ore from mining range instead of targeting the ore block itself', async () => {
    const elevatedIronOre = createBlock('minecraft:iron_ore', -355, 11, 268)

    mocks.getNearestBlocksAccurate.mockResolvedValue([elevatedIronOre])
    mocks.getBlockAtAccurate.mockResolvedValue(elevatedIronOre)

    const goto = vi.fn().mockResolvedValue(undefined)

    const mineflayer = {
      bot: {
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(),
        },
        heldItem: { type: 1, name: 'stone_pickaxe' },
        inventory: {
          items: () => [{ name: 'stone_pickaxe', count: 1 }],
          emptySlotCount: () => 5,
        },
        pathfinder: {
          goto,
          stop: vi.fn(),
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'iron_ore', 1, 64)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      x: elevatedIronOre.position.x,
      y: elevatedIronOre.position.y,
      z: elevatedIronOre.position.z,
      rangeSq: 16,
    }))
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(
      mineflayer,
      elevatedIronOre.position.x,
      elevatedIronOre.position.y,
      elevatedIronOre.position.z,
    )
  })

  it('directly probes a nearby ore block when exposure filtering stays stale at close range', async () => {
    const nearbyCoalOre = createBlock('minecraft:coal_ore', -345, 58, 255)

    mocks.getNearestBlocksAccurate.mockResolvedValue([nearbyCoalOre])
    mocks.getMiningExposureKindAccurate.mockResolvedValue('sealed')
    mocks.getBlockAtAccurate.mockResolvedValue(nearbyCoalOre)

    const goto = vi.fn().mockResolvedValue(undefined)
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(-347, 60, 255),
        },
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(),
        },
        heldItem: { type: 1, name: 'stone_pickaxe' },
        inventory: {
          items: () => [{ name: 'stone_pickaxe', count: 1 }],
          emptySlotCount: () => 5,
        },
        pathfinder: {
          goto,
          stop: vi.fn(),
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'coal_ore', 1, 24)

    expect(success).toBe(true)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(
      mineflayer,
      nearbyCoalOre.position.x,
      nearbyCoalOre.position.y,
      nearbyCoalOre.position.z,
    )
  })

  it('opens shallow surface cover before mining sealed stone when no exposed candidate exists', async () => {
    const buriedCluster = Array.from({ length: 20 }, (_, index) =>
      createBlock('minecraft:stone', 30 + index, 59, 30 + index))
    const coveredStone = createBlock('minecraft:stone', 6, 59, 0)
    const coverBlocks = [
      createBlock('minecraft:dirt', 6, 60, 0),
      createBlock('minecraft:dirt', 6, 61, 0),
      createBlock('minecraft:dirt', 6, 62, 0),
      createBlock('minecraft:grass_block', 6, 63, 0),
    ]
    const surfaceAir = createBlock('minecraft:air', 6, 64, 0)

    mocks.getNearestBlocksAccurate.mockResolvedValue([...buriedCluster, coveredStone])
    mocks.getMiningExposureKindAccurate.mockResolvedValue('sealed')
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer, position) => {
      const coverBlock = coverBlocks.find(block =>
        position.x === block.position.x && position.y === block.position.y && position.z === block.position.z)
      if (coverBlock) {
        return coverBlock
      }
      if (position.x === surfaceAir.position.x && position.y === surfaceAir.position.y && position.z === surfaceAir.position.z) {
        return surfaceAir
      }
      if (position.x === coveredStone.position.x && position.y === coveredStone.position.y && position.z === coveredStone.position.z) {
        return coveredStone
      }
      return surfaceAir
    })

    const goto = vi.fn().mockResolvedValue(undefined)
    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(),
        },
        heldItem: { type: 1, name: 'wooden_pickaxe' },
        inventory: {
          items: () => [{ name: 'wooden_pickaxe', count: 1 }],
          emptySlotCount: () => 5,
        },
        pathfinder: {
          goto,
          stop: vi.fn(),
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'cobblestone', 1, 24)

    expect(success).toBe(true)
    expect(mocks.getNearestBlocksAccurate).toHaveBeenCalledWith(mineflayer, ['stone'], 24, 48)
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({
      x: coveredStone.position.x,
      y: coveredStone.position.y,
      z: coveredStone.position.z,
      rangeSq: 16,
    }))
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(1, mineflayer, 6, 63, 0)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(2, mineflayer, 6, 62, 0)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(3, mineflayer, 6, 61, 0)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(4, mineflayer, 6, 60, 0)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(5, mineflayer, 6, 59, 0)
  })

  it('does not open shallow cover for distant sealed ore candidates', async () => {
    const coveredIronOre = createBlock('minecraft:iron_ore', 8, 62, 0)
    const surfaceCover = createBlock('minecraft:grass_block', 8, 63, 0)
    const surfaceAir = createBlock('minecraft:air', 8, 64, 0)

    mocks.getNearestBlocksAccurate.mockResolvedValue([coveredIronOre])
    mocks.getMiningExposureKindAccurate.mockResolvedValue('sealed')
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer, position) => {
      if (position.x === surfaceCover.position.x && position.y === surfaceCover.position.y && position.z === surfaceCover.position.z) {
        return surfaceCover
      }
      if (position.x === surfaceAir.position.x && position.y === surfaceAir.position.y && position.z === surfaceAir.position.z) {
        return surfaceAir
      }
      if (position.x === coveredIronOre.position.x && position.y === coveredIronOre.position.y && position.z === coveredIronOre.position.z) {
        return coveredIronOre
      }
      return surfaceAir
    })

    const mineflayer = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(),
        },
        heldItem: { type: 1, name: 'stone_pickaxe' },
        inventory: {
          items: () => [{ name: 'stone_pickaxe', count: 1 }],
          emptySlotCount: () => 5,
        },
        pathfinder: {
          goto: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'iron_ore', 1, 24)

    expect(success).toBe(false)
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('forces pickaxe recovery before mining stone when the held item is not a pickaxe', async () => {
    const exposedStone = createBlock('minecraft:stone', 9, 64, 9)
    let heldItem: { type: number, name: string } | null = { type: 2, name: 'wooden_axe' }
    let inventoryItems = [{ name: 'wooden_axe', count: 1 }]

    mocks.getNearestBlocksAccurate.mockResolvedValue([exposedStone])
    mocks.getBlockAtAccurate.mockResolvedValue(exposedStone)
    mocks.ensurePickaxe.mockImplementation(async () => {
      heldItem = { type: 3, name: 'wooden_pickaxe' }
      inventoryItems = [{ name: 'wooden_pickaxe', count: 1 }]
      return true
    })

    const equipForBlock = vi.fn(async () => {})
    const goto = vi.fn().mockResolvedValue(undefined)

    const mineflayer = {
      bot: {
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock,
        },
        get heldItem() {
          return heldItem
        },
        pathfinder: {
          goto,
          stop: vi.fn(),
        },
        inventory: {
          items: () => inventoryItems,
          emptySlotCount: () => 5,
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'stone', 1, 32)

    expect(success).toBe(true)
    expect(mocks.ensurePickaxe).toHaveBeenCalledOnce()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 9, 64, 9)
  })

  it('continues mining when a valid pickaxe exists in inventory but held-item state is stale', async () => {
    const exposedStone = {
      ...createBlock('minecraft:stone', 9, 64, 9),
      canHarvest: vi.fn(() => true),
    }

    mocks.getNearestBlocksAccurate.mockResolvedValue([exposedStone])
    mocks.getBlockAtAccurate.mockResolvedValue(exposedStone)

    const mineflayer = {
      bot: {
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(async () => {}),
        },
        heldItem: null,
        inventory: {
          items: () => [{ name: 'wooden_pickaxe', count: 1 }],
          emptySlotCount: () => 5,
        },
        pathfinder: {
          goto: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'stone', 1, 32)

    expect(success).toBe(true)
    expect(mocks.ensurePickaxe).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 9, 64, 9)
  })

  it('does not trigger tool recovery when harvest checks are stale but a valid pickaxe exists in inventory', async () => {
    const exposedStone = {
      ...createBlock('minecraft:stone', 9, 64, 9),
      canHarvest: vi.fn(() => false),
    }

    mocks.getNearestBlocksAccurate.mockResolvedValue([exposedStone])
    mocks.getBlockAtAccurate.mockResolvedValue(exposedStone)

    const mineflayer = {
      bot: {
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(async () => {}),
        },
        heldItem: null,
        inventory: {
          items: () => [{ name: 'wooden_pickaxe', count: 1 }],
          emptySlotCount: () => 5,
        },
        pathfinder: {
          goto: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'stone', 1, 32)

    expect(success).toBe(true)
    expect(mocks.ensurePickaxe).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 9, 64, 9)
  })

  it('does not count collection as success when the target block was not actually broken', async () => {
    const exposedStone = createBlock('minecraft:stone', 9, 64, 9)

    mocks.getNearestBlocksAccurate.mockResolvedValue([exposedStone])
    mocks.getBlockAtAccurate.mockResolvedValue(exposedStone)
    mocks.breakBlockAt.mockResolvedValue(false)

    const mineflayer = {
      bot: {
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(async () => {}),
        },
        heldItem: { type: 1, name: 'wooden_pickaxe' },
        inventory: {
          items: () => [{ name: 'wooden_pickaxe', count: 1 }],
          emptySlotCount: () => 5,
        },
        pathfinder: {
          goto: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'stone', 1, 32)

    expect(success).toBe(false)
    expect(mocks.pickupNearbyItems).not.toHaveBeenCalled()
  })

  it('aborts quickly when digging keeps timing out across candidates', async () => {
    const timeoutCandidates = Array.from({ length: 12 }, (_, index) =>
      createBlock('minecraft:stone', 30 + index, 64, 30 + index))

    mocks.getNearestBlocksAccurate.mockResolvedValue(timeoutCandidates)
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer, position) =>
      timeoutCandidates.find(block =>
        block.position.x === position.x
        && block.position.y === position.y
        && block.position.z === position.z),
    )
    mocks.breakBlockAt.mockRejectedValue(new Error('Digging timed out at 30, 64, 30'))

    const goto = vi.fn().mockResolvedValue(undefined)
    const mineflayer = {
      bot: {
        game: { gameMode: 'survival' },
        tool: {
          equipForBlock: vi.fn(async () => {}),
        },
        heldItem: { type: 1, name: 'wooden_pickaxe' },
        inventory: {
          items: () => [{ name: 'wooden_pickaxe', count: 1 }],
          emptySlotCount: () => 5,
        },
        pathfinder: {
          goto,
          stop: vi.fn(),
        },
      },
    } as any

    const success = await collectBlock(mineflayer, 'cobblestone', 1, 32)

    expect(success).toBe(false)
    expect(mocks.getNearestBlocksAccurate).toHaveBeenCalledWith(mineflayer, ['stone'], 32, 48)
    expect(mocks.breakBlockAt).toHaveBeenCalledTimes(4)
    expect(goto).toHaveBeenCalledTimes(4)
  })
})
