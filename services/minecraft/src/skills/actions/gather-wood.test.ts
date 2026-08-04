import { Vec3 } from 'vec3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getNearestBlocksAccurate: vi.fn(),
  getBlockAtAccurate: vi.fn(),
  breakBlockAt: vi.fn(),
  goToPosition: vi.fn(),
  moveToHorizontalTarget: vi.fn(),
  moveAway: vi.fn(),
  pickupNearbyItems: vi.fn(),
}))

vi.mock('../block-access', () => ({
  getNearestBlocksAccurate: mocks.getNearestBlocksAccurate,
  getBlockAtAccurate: mocks.getBlockAtAccurate,
}))

vi.mock('../blocks', () => ({
  breakBlockAt: mocks.breakBlockAt,
}))

vi.mock('../movement', () => ({
  goToPosition: mocks.goToPosition,
  moveToHorizontalTarget: mocks.moveToHorizontalTarget,
  moveAway: mocks.moveAway,
}))

vi.mock('./world-interactions', () => ({
  pickupNearbyItems: mocks.pickupNearbyItems,
}))

vi.mock('./inventory', () => ({
  refreshInventoryState: vi.fn(async () => true),
}))

const { approachNearestWoodTarget, gatherWood, getLogsCount, isWoodLikeBlockQuery } = await import('./gather-wood')

function createMineflayer() {
  return {
    bot: {
      chat: vi.fn(),
      entity: {
        position: new Vec3(0, 64, 0),
      },
      inventory: {
        items: () => [],
      },
      equip: vi.fn(async () => undefined),
      lookAt: vi.fn(async () => undefined),
      placeBlock: vi.fn(async () => undefined),
      setControlState: vi.fn(),
      pathfinder: {
        mine: vi.fn(async () => false),
        stop: vi.fn(),
      },
    },
  } as any
}

describe('gatherWood', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getNearestBlocksAccurate.mockReset()
    mocks.getBlockAtAccurate.mockReset()
    mocks.breakBlockAt.mockReset()
    mocks.goToPosition.mockReset()
    mocks.moveToHorizontalTarget.mockReset()
    mocks.moveAway.mockReset()
    mocks.pickupNearbyItems.mockReset()
    mocks.getBlockAtAccurate.mockResolvedValue(null)
  })

  it('detects both generic and species-specific wood queries', () => {
    expect(isWoodLikeBlockQuery('log')).toBe(true)
    expect(isWoodLikeBlockQuery('birch_log')).toBe(true)
    expect(isWoodLikeBlockQuery('stone')).toBe(false)
  })

  it('counts only the requested wood species when the target is specific', () => {
    const mineflayer = createMineflayer()
    mineflayer.bot.inventory.items = () => [
      { name: 'oak_log', count: 8 },
      { name: 'birch_log', count: 2 },
      { name: 'crimson_stem', count: 1 },
    ]

    expect(getLogsCount(mineflayer, 'log')).toBe(11)
    expect(getLogsCount(mineflayer, 'birch_log')).toBe(2)
    expect(getLogsCount(mineflayer, 'crimson_stem')).toBe(1)
  })

  it('returns control before scanning wood when health is unsafe', async () => {
    const mineflayer = createMineflayer()
    mineflayer.bot.health = 6
    mineflayer.bot.food = 17

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mineflayer.bot.pathfinder.stop).toHaveBeenCalled()
    expect(mocks.getNearestBlocksAccurate).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('returns control before scanning wood when health falls below recovery threshold', async () => {
    const mineflayer = createMineflayer()
    mineflayer.bot.health = 12
    mineflayer.bot.food = 16

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mineflayer.bot.pathfinder.stop).toHaveBeenCalled()
    expect(mocks.getNearestBlocksAccurate).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('returns control before scanning wood when footing is unsafe', async () => {
    const mineflayer = createMineflayer()
    mineflayer.bot.blockAt = vi.fn(() => ({ name: 'air' }))

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mineflayer.bot.pathfinder.stop).toHaveBeenCalled()
    expect(mocks.getNearestBlocksAccurate).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('returns control before scanning wood when the bot is boxed into a cave pocket', async () => {
    const mineflayer = createMineflayer()
    mineflayer.bot.blockAt = vi.fn((position: Vec3) => {
      if (position.y === 63) {
        return { name: 'stone' }
      }
      if (position.y === 64 && (Math.abs(position.x) === 1 || Math.abs(position.z) === 1)) {
        return { name: 'stone' }
      }
      return { name: 'air' }
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mineflayer.bot.pathfinder.stop).toHaveBeenCalled()
    expect(mocks.getNearestBlocksAccurate).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('does not treat unresolved local block probes as a cave confinement signal', async () => {
    const mineflayer = createMineflayer()
    mineflayer.bot.blockAt = vi.fn(() => null)
    mocks.getNearestBlocksAccurate.mockResolvedValue([])

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mineflayer.bot.pathfinder.stop).not.toHaveBeenCalled()
    expect(mocks.getNearestBlocksAccurate).toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('keeps scanning for wood when standing in short grass on safe surface terrain', async () => {
    const mineflayer = createMineflayer()
    mineflayer.bot.blockAt = vi.fn((position: Vec3) => {
      if (position.y === 63) {
        return { name: 'grass_block' }
      }
      if (position.y === 64) {
        return { name: 'short_grass' }
      }
      return { name: 'air' }
    })
    mocks.getNearestBlocksAccurate.mockResolvedValue([])

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mineflayer.bot.pathfinder.stop).not.toHaveBeenCalled()
    expect(mocks.getNearestBlocksAccurate).toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('keeps scanning on an open surface slope with dirt and grass beside the bot', async () => {
    const mineflayer = createMineflayer()
    mineflayer.bot.blockAt = vi.fn((position: Vec3) => {
      if (position.y === 65) {
        return { name: 'cobblestone' }
      }
      if (position.y === 66 && (Math.abs(position.x) === 1 || Math.abs(position.z) === 1)) {
        return { name: position.z === 1 ? 'grass_block' : 'dirt' }
      }
      return { name: 'air' }
    })
    mineflayer.bot.entity = { position: new Vec3(0, 66, 0) }
    mocks.getNearestBlocksAccurate.mockResolvedValue([])

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mineflayer.bot.pathfinder.stop).not.toHaveBeenCalled()
    expect(mocks.getNearestBlocksAccurate).toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('returns false immediately when no wood blocks are detectable nearby', async () => {
    mocks.getNearestBlocksAccurate.mockResolvedValue([])

    const success = await gatherWood(createMineflayer(), 4, 64)

    expect(success).toBe(false)
    expect(mocks.moveAway).not.toHaveBeenCalled()
  })

  it('tries another candidate when the first wood block is unreachable', async () => {
    const firstBlock = { name: 'oak_log', position: new Vec3(10, 64, 10) }
    const secondBlock = { name: 'oak_log', position: new Vec3(15, 64, 15) }

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([firstBlock, secondBlock])
      .mockResolvedValueOnce([secondBlock])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 64 && position.z === 10) {
        return firstBlock
      }
      if (position.x === 15 && position.y === 64 && position.z === 15) {
        return secondBlock
      }
      return null
    })
    mocks.goToPosition
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    mocks.breakBlockAt.mockImplementation(async (mineflayer: any) => {
      mineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 4 }]
    })

    const success = await gatherWood(createMineflayer(), 4, 64)

    expect(success).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledTimes(2)
    expect(mocks.breakBlockAt).toHaveBeenCalled()
  })

  it('returns control after a failed wood approach pulls the bot below the surface safety band', async () => {
    const firstBlock = { name: 'oak_log', position: new Vec3(10, 64, 0) }
    const secondBlock = { name: 'oak_log', position: new Vec3(15, 64, 0) }
    const mineflayer = createMineflayer()

    mocks.getNearestBlocksAccurate.mockResolvedValue([firstBlock, secondBlock])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 64 && position.z === 0) {
        return firstBlock
      }
      if (position.x === 15 && position.y === 64 && position.z === 0) {
        return secondBlock
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.entity.position = new Vec3(3, 60, 0)
      return false
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mineflayer.bot.pathfinder.stop).toHaveBeenCalled()
    expect(mocks.goToPosition).toHaveBeenCalledTimes(1)
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('moves to a distant tree before doing the local tree scan', async () => {
    const distantBlock = { name: 'oak_log', position: new Vec3(9, 64, 0) }
    const mineflayer = createMineflayer()

    mocks.getNearestBlocksAccurate.mockImplementation(async (_mineflayer: any, _blockName: string, distance: number) => {
      if (distance > 6) {
        return [distantBlock]
      }

      const position = mineflayer.bot.entity.position
      return position.distanceTo(distantBlock.position) <= 2.5 ? [distantBlock] : []
    })
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 9 && position.y === 64 && position.z === 0) {
        return distantBlock
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, y, z)
      return true
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 4 }]
    })

    const success = await gatherWood(mineflayer, 4, 64)

    expect(success).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 9, 64, 0, 2)
    expect(mocks.breakBlockAt).toHaveBeenCalled()
  })

  it('uses a wider recovery scan when a short collection radius would miss reachable trees', async () => {
    const distantGroundLog = { name: 'oak_log', position: new Vec3(80, 64, 0) }
    const mineflayer = createMineflayer()

    mocks.getNearestBlocksAccurate.mockImplementation(async (_mineflayer: any, _blockName: string, distance: number) => {
      return distance >= 96 ? [distantGroundLog] : []
    })
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 80 && position.y === 64 && position.z === 0) {
        return distantGroundLog
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, y, z)
      return true
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 24)

    expect(success).toBe(true)
    expect(mocks.getNearestBlocksAccurate).toHaveBeenCalledWith(mineflayer, 'log', 96, expect.any(Number))
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 80, 64, 0, 2)
  })

  it('falls back to bridge mining when direct log breaking times out', async () => {
    const nearbyLog = { name: 'oak_log', position: new Vec3(4, 64, 0) }
    const mineflayer = createMineflayer()

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([nearbyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 4 && position.y === 64 && position.z === 0) {
        return nearbyLog
      }
      return null
    })
    mocks.goToPosition.mockResolvedValue(true)
    mocks.breakBlockAt.mockRejectedValue(new Error('Digging timed out at 4, 64, 0'))
    mineflayer.bot.pathfinder.mine.mockImplementation(async () => {
      mineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 4 }]
      return true
    })

    const success = await gatherWood(mineflayer, 4, 64)

    expect(success).toBe(true)
    expect(mineflayer.bot.pathfinder.mine).toHaveBeenCalledWith(['oak_log'])
  })

  it('prefers manual trunk-aware wood breaking before generic baritone mining', async () => {
    const nearbyLog = { name: 'oak_log', position: new Vec3(4, 64, 0) }
    const mineflayer = createMineflayer()

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([nearbyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 4 && position.y === 64 && position.z === 0) {
        return nearbyLog
      }
      return null
    })
    mocks.goToPosition.mockResolvedValue(true)
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 32)

    expect(success).toBe(true)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 4, 64, 0)
    expect(mineflayer.bot.pathfinder.mine).not.toHaveBeenCalled()
  })

  it('stops baritone mining once the requested log count has been reached', async () => {
    const nearbyLog = { name: 'oak_log', position: new Vec3(4, 64, 0) }
    const mineflayer = createMineflayer()

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([nearbyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 4 && position.y === 64 && position.z === 0) {
        return nearbyLog
      }
      return null
    })
    mineflayer.bot.pathfinder.mine.mockImplementation(async () => {
      setTimeout(() => {
        mineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }, 50)
      return await new Promise<boolean>(() => {})
    })

    const success = await gatherWood(mineflayer, 1, 32)

    expect(success).toBe(true)
    expect(mineflayer.bot.pathfinder.mine).toHaveBeenCalledWith(['oak_log'])
    expect(mineflayer.bot.pathfinder.stop).toHaveBeenCalled()
  })

  it('does not treat a completed baritone mining run as success when the requested log count was not actually collected', async () => {
    const nearbyLog = { name: 'oak_log', position: new Vec3(4, 64, 0) }
    const mineflayer = createMineflayer()

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([nearbyLog])
      .mockResolvedValueOnce([])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 4 && position.y === 64 && position.z === 0) {
        return nearbyLog
      }
      return null
    })
    mocks.goToPosition.mockResolvedValue(false)
    mineflayer.bot.pathfinder.mine.mockResolvedValue(true)

    const success = await gatherWood(mineflayer, 4, 64)

    expect(success).toBe(false)
    expect(mineflayer.bot.pathfinder.mine).toHaveBeenCalledWith(['oak_log'])
  })

  it('does not treat other wood species as satisfying a species-specific gather request', async () => {
    const birchLog = { name: 'birch_log', position: new Vec3(4, 64, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 8 }]

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([birchLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 4 && position.y === 64 && position.z === 0) {
        return birchLog
      }
      return null
    })
    mocks.goToPosition.mockResolvedValue(true)
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [
        { name: 'oak_log', count: 8 },
        { name: 'birch_log', count: 2 },
      ]
    })

    const success = await gatherWood(mineflayer, 2, 32, 'birch_log')

    expect(success).toBe(true)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 4, 64, 0)
  })

  it('continues a species-specific trunk pass until the requested species count is reached', async () => {
    const birchBase = { name: 'birch_log', position: new Vec3(4, 64, 0) }
    const birchTop = { name: 'birch_log', position: new Vec3(4, 65, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 8 }]

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([birchBase])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 4 && position.y === 64 && position.z === 0) {
        return birchBase
      }
      if (position.x === 4 && position.y === 65 && position.z === 0) {
        return birchTop
      }
      return null
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, _x: number, y: number) => {
      if (y === 64) {
        targetMineflayer.bot.inventory.items = () => [
          { name: 'oak_log', count: 8 },
          { name: 'birch_log', count: 1 },
        ]
      }
      if (y === 65) {
        targetMineflayer.bot.inventory.items = () => [
          { name: 'oak_log', count: 8 },
          { name: 'birch_log', count: 2 },
        ]
      }
    })

    const success = await gatherWood(mineflayer, 2, 32, 'birch_log')

    expect(success).toBe(true)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(1, mineflayer, 4, 64, 0)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(2, mineflayer, 4, 65, 0)
  })

  it('walks to the base of the detected tree before breaking logs', async () => {
    const canopyLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const baseLog = { name: 'oak_log', position: new Vec3(10, 66, 10) }
    const midLog = { name: 'oak_log', position: new Vec3(10, 67, 10) }

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([canopyLog])
      .mockResolvedValueOnce([canopyLog, baseLog, midLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      const y = position.y
      if (y === 69)
        return midLog
      if (y === 66)
        return baseLog
      return null
    })
    mocks.goToPosition.mockResolvedValue(true)
    mocks.breakBlockAt.mockImplementation(async (mineflayer: any) => {
      mineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 4 }]
    })

    const mineflayer = createMineflayer()
    const success = await gatherWood(mineflayer, 4, 64)

    expect(success).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 10, 66, 10, 2)
  }, 10000)

  it('keeps harvesting the selected trunk column instead of drifting to a nearby tree', async () => {
    const selectedCanopyLog = { name: 'oak_log', position: new Vec3(10, 68, 10) }
    const selectedMidLog = { name: 'oak_log', position: new Vec3(10, 67, 10) }
    const selectedBaseLog = { name: 'oak_log', position: new Vec3(10, 66, 10) }
    const nearbyOtherTreeLog = { name: 'oak_log', position: new Vec3(13, 66, 15) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([selectedCanopyLog, nearbyOtherTreeLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.z === 10 && position.y === 67)
        return selectedMidLog
      if (position.x === 10 && position.z === 10 && position.y === 66)
        return selectedBaseLog
      if (position.x === 10 && position.z === 10 && position.y === 68)
        return selectedCanopyLog
      return null
    })
    mocks.goToPosition.mockResolvedValue(true)
    mocks.breakBlockAt.mockImplementation(async (mineflayer: any, x: number, y: number, z: number) => {
      if (x === 10 && z === 10 && y === 68) {
        mineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 4 }]
      }
    })

    const mineflayer = createMineflayer()
    const success = await gatherWood(mineflayer, 4, 64)

    expect(success).toBe(true)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(1, mineflayer, 10, 66, 10)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(2, mineflayer, 10, 67, 10)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(3, mineflayer, 10, 68, 10)
    expect(mocks.breakBlockAt).not.toHaveBeenCalledWith(mineflayer, 13, 66, 15)
  }, 10000)

  it('reroutes branch-first detections onto an adjacent trunk column before pathing', async () => {
    const branchLog = { name: 'oak_log', position: new Vec3(11, 68, 10) }
    const trunkTop = { name: 'oak_log', position: new Vec3(10, 68, 10) }
    const trunkMid = { name: 'oak_log', position: new Vec3(10, 67, 10) }
    const trunkBase = { name: 'oak_log', position: new Vec3(10, 66, 10) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([branchLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 11 && position.y === 68 && position.z === 10)
        return branchLog
      if (position.x === 10 && position.z === 10 && position.y === 68)
        return trunkTop
      if (position.x === 10 && position.z === 10 && position.y === 67)
        return trunkMid
      if (position.x === 10 && position.z === 10 && position.y === 66)
        return trunkBase
      return null
    })
    mocks.goToPosition.mockResolvedValue(true)
    mocks.breakBlockAt.mockImplementation(async (mineflayer: any, x: number, y: number, z: number) => {
      if (x === 10 && z === 10 && y === 68) {
        mineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 4 }]
      }
    })

    const mineflayer = createMineflayer()
    const success = await gatherWood(mineflayer, 4, 64)

    expect(success).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 10, 66, 10, 2)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(1, mineflayer, 10, 66, 10)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(2, mineflayer, 10, 67, 10)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(3, mineflayer, 10, 68, 10)
  }, 10000)

  it('reroutes canopy-only detections onto a trunk that is two blocks away and lower down', async () => {
    const canopyLog = { name: 'oak_log', position: new Vec3(12, 68, 10) }
    const trunkTop = { name: 'oak_log', position: new Vec3(10, 68, 10) }
    const trunkUpperMid = { name: 'oak_log', position: new Vec3(10, 67, 10) }
    const trunkLowerMid = { name: 'oak_log', position: new Vec3(10, 66, 10) }
    const trunkLower = { name: 'oak_log', position: new Vec3(10, 65, 10) }
    const trunkBase = { name: 'oak_log', position: new Vec3(10, 64, 10) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([canopyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 12 && position.y === 68 && position.z === 10)
        return canopyLog
      if (position.x === 10 && position.z === 10 && position.y === 68)
        return trunkTop
      if (position.x === 10 && position.z === 10 && position.y === 67)
        return trunkUpperMid
      if (position.x === 10 && position.z === 10 && position.y === 66)
        return trunkLowerMid
      if (position.x === 10 && position.z === 10 && position.y === 65)
        return trunkLower
      if (position.x === 10 && position.z === 10 && position.y === 64)
        return trunkBase
      return null
    })
    mocks.goToPosition.mockResolvedValue(true)
    mocks.breakBlockAt.mockImplementation(async (mineflayer: any, x: number, y: number, z: number) => {
      if (x === 10 && z === 10 && y === 68) {
        mineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 4 }]
      }
    })

    const mineflayer = createMineflayer()
    const success = await gatherWood(mineflayer, 4, 64)

    expect(success).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 10, 64, 10, 2)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(1, mineflayer, 10, 64, 10)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(2, mineflayer, 10, 65, 10)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(3, mineflayer, 10, 66, 10)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(4, mineflayer, 10, 67, 10)
    expect(mocks.breakBlockAt).toHaveBeenNthCalledWith(5, mineflayer, 10, 68, 10)
  }, 10000)

  it('prefers wood candidates that are closer in elevation before cliff-top logs', async () => {
    const highBlock = { name: 'oak_log', position: new Vec3(12, 90, 12) }
    const lowBlock = { name: 'oak_log', position: new Vec3(14, 65, 14) }

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([highBlock, lowBlock])
      .mockResolvedValueOnce([lowBlock])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 14 && position.y === 65 && position.z === 14) {
        return lowBlock
      }
      return null
    })
    mocks.goToPosition.mockResolvedValue(true)
    mocks.breakBlockAt.mockImplementation(async (mineflayer: any) => {
      mineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 4 }]
    })

    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(10, 64, 10) }

    const success = await gatherWood(mineflayer, 4, 64)

    expect(success).toBe(true)
    expect(mocks.goToPosition).toHaveBeenNthCalledWith(1, mineflayer, 14, 65, 14, 2)
    expect(mocks.goToPosition).not.toHaveBeenCalledWith(mineflayer, 12, 90, 12, 2)
  })

  it('refuses to chase only steep or far wood candidates and returns recovery control', async () => {
    const steepBlock = { name: 'oak_log', position: new Vec3(70, 90, 0) }
    const ravineBlock = { name: 'oak_log', position: new Vec3(8, 88, 8) }

    mocks.getNearestBlocksAccurate.mockResolvedValue([steepBlock, ravineBlock])

    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    const success = await gatherWood(mineflayer, 4, 96)

    expect(success).toBe(false)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mocks.moveAway).not.toHaveBeenCalled()
  })

  it('uses a moderate-height recovery probe when only uphill trees are nearby', async () => {
    const hillTree = { name: 'birch_log', position: new Vec3(18, 70, 6) }

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([hillTree])
      .mockResolvedValueOnce([hillTree])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 18 && position.y === 70 && position.z === 6) {
        return hillTree
      }
      if (position.x === 18 && position.y === 69 && position.z === 6) {
        return { name: 'grass_block', position: new Vec3(18, 69, 6) }
      }
      return null
    })
    mocks.goToPosition.mockResolvedValue(true)
    mocks.breakBlockAt.mockImplementation(async (mineflayer: any) => {
      mineflayer.bot.inventory.items = () => [{ name: 'birch_log', count: 4 }]
    })

    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    const success = await gatherWood(mineflayer, 4, 96)

    expect(success).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 18, 70, 6, 2)
  })

  it('harvests an elevated reachable log column without insisting on an exact height match first', async () => {
    const overheadLog = { name: 'oak_log', position: new Vec3(0, 68, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 65, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([overheadLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 0 && position.y === 68 && position.z === 0) {
        return overheadLog
      }
      return null
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 32)

    expect(success).toBe(true)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 0, 68, 0)
  })

  it('moves horizontally under an elevated log when it is already within vertical break range', async () => {
    const elevatedLog = { name: 'oak_log', position: new Vec3(0, 69, 5) }
    const groundSupport = { name: 'grass_block', position: new Vec3(0, 64, 5) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 0 && position.y === 69 && position.z === 5) {
        return elevatedLog
      }
      if (position.x === 0 && position.y === 64 && position.z === 5) {
        return groundSupport
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.entity.position = new Vec3(0, 64, 3)
      return true
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 32)

    expect(success).toBe(true)
    expect(mocks.moveToHorizontalTarget).toHaveBeenCalledWith(mineflayer, 0, 5)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 0, 69, 5)
  })

  it('uses scaffold blocks to reach an otherwise unreachable elevated log column', async () => {
    const elevatedLog = { name: 'oak_log', position: new Vec3(0, 74, 0) }
    const mineflayer = createMineflayer()
    const placedBlocks = new Set<string>()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.inventory.items = () => [
      { name: 'dirt', count: 8 },
    ]
    mineflayer.bot.placeBlock.mockImplementation(async (referenceBlock: { position: Vec3 }) => {
      const target = referenceBlock.position.offset(0, 1, 0)
      placedBlocks.add(`${target.x},${target.y},${target.z}`)
      mineflayer.bot.entity.position = new Vec3(0, mineflayer.bot.entity.position.y + 1, 0)
    })

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      const key = `${position.x},${position.y},${position.z}`
      if (position.x === 0 && position.y === 74 && position.z === 0) {
        return elevatedLog
      }
      if (placedBlocks.has(key)) {
        return { name: 'dirt', position: new Vec3(position.x, position.y, position.z) }
      }
      if (position.x === 0 && position.y === 63 && position.z === 0) {
        return { name: 'grass_block', position: new Vec3(0, 63, 0) }
      }
      return { name: 'air', position: new Vec3(position.x, position.y, position.z) }
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 32)

    expect(success).toBe(true)
    expect(mineflayer.bot.placeBlock).toHaveBeenCalled()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 0, 74, 0)
  }, 10000)

  it('counts player reach from eye height when deciding scaffold blocks for elevated logs', async () => {
    const elevatedLog = { name: 'oak_log', position: new Vec3(0, 74, 0) }
    const mineflayer = createMineflayer()
    const placedBlocks = new Set<string>()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.inventory.items = () => [
      { name: 'dirt', count: 4 },
    ]
    mineflayer.bot.placeBlock.mockImplementation(async (referenceBlock: { position: Vec3 }) => {
      const target = referenceBlock.position.offset(0, 1, 0)
      placedBlocks.add(`${target.x},${target.y},${target.z}`)
      mineflayer.bot.entity.position = new Vec3(0, mineflayer.bot.entity.position.y + 1, 0)
    })

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      const key = `${position.x},${position.y},${position.z}`
      if (position.x === 0 && position.y === 74 && position.z === 0) {
        return elevatedLog
      }
      if (placedBlocks.has(key)) {
        return { name: 'dirt', position: new Vec3(position.x, position.y, position.z) }
      }
      if (position.x === 0 && position.y === 63 && position.z === 0) {
        return { name: 'grass_block', position: new Vec3(0, 63, 0) }
      }
      return { name: 'air', position: new Vec3(position.x, position.y, position.z) }
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mineflayer.bot.placeBlock).toHaveBeenCalledTimes(4)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 0, 74, 0)
  }, 10000)

  it('skips deep terrain support before scaffolding to a high hillside log', async () => {
    const elevatedLog = { name: 'oak_log', position: new Vec3(10, 76, 10) }
    const terrainSupport = { name: 'grass_block', position: new Vec3(10, 68, 10) }
    const mineflayer = createMineflayer()
    const placedBlocks = new Set<string>()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.inventory.items = () => [
      { name: 'dirt', count: 8 },
    ]
    mineflayer.bot.placeBlock.mockImplementation(async (referenceBlock: { position: Vec3 }) => {
      const target = referenceBlock.position.offset(0, 1, 0)
      placedBlocks.add(`${target.x},${target.y},${target.z}`)
      mineflayer.bot.entity.position = new Vec3(10, mineflayer.bot.entity.position.y + 1, 10)
    })

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      const key = `${position.x},${position.y},${position.z}`
      if (position.x === 10 && position.y === 76 && position.z === 10) {
        return elevatedLog
      }
      if (position.x === 10 && position.y === 68 && position.z === 10) {
        return terrainSupport
      }
      if (placedBlocks.has(key)) {
        return { name: 'dirt', position: new Vec3(position.x, position.y, position.z) }
      }
      return { name: 'air', position: new Vec3(position.x, position.y, position.z) }
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 10 && y === 69 && z === 10) {
        targetMineflayer.bot.entity.position = new Vec3(10, 69, 10)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mineflayer.bot.placeBlock).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  }, 10000)

  it('picks up dropped scaffold blocks for an unsupported elevated log column', async () => {
    const elevatedLog = { name: 'oak_log', position: new Vec3(0, 74, 0) }
    const mineflayer = createMineflayer()
    const placedBlocks = new Set<string>()
    let inventoryItems: Array<{ name: string, count: number }> = []
    mineflayer.bot.entity = { position: new Vec3(0, 66, 0) }
    mineflayer.bot.inventory.items = () => inventoryItems
    mineflayer.bot.placeBlock.mockImplementation(async (referenceBlock: { position: Vec3 }) => {
      const target = referenceBlock.position.offset(0, 1, 0)
      placedBlocks.add(`${target.x},${target.y},${target.z}`)
      mineflayer.bot.entity.position = new Vec3(0, mineflayer.bot.entity.position.y + 1, 0)
    })

    mocks.pickupNearbyItems.mockImplementation(async () => {
      inventoryItems = [{ name: 'dirt', count: 8 }]
    })
    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      const key = `${position.x},${position.y},${position.z}`
      if (position.x === 0 && position.y === 74 && position.z === 0) {
        return elevatedLog
      }
      if (placedBlocks.has(key)) {
        return { name: 'dirt', position: new Vec3(position.x, position.y, position.z) }
      }
      if (position.x === 0 && position.y === 65 && position.z === 0) {
        return { name: 'grass_block', position: new Vec3(0, 65, 0) }
      }
      return { name: 'air', position: new Vec3(position.x, position.y, position.z) }
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.pickupNearbyItems).toHaveBeenCalled()
    expect(mineflayer.bot.placeBlock).toHaveBeenCalled()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 0, 74, 0)
  }, 10000)

  it('collects a nearby dirt block as scaffold for an elevated log column', async () => {
    const elevatedLog = { name: 'oak_log', position: new Vec3(0, 72, 0) }
    const adjacentDirt = { name: 'dirt', position: new Vec3(1, 64, 0) }
    const mineflayer = createMineflayer()
    const placedBlocks = new Set<string>()
    let inventoryItems: Array<{ name: string, count: number }> = []
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.inventory.items = () => inventoryItems
    mineflayer.bot.placeBlock.mockImplementation(async (referenceBlock: { position: Vec3 }) => {
      const target = referenceBlock.position.offset(0, 1, 0)
      placedBlocks.add(`${target.x},${target.y},${target.z}`)
      mineflayer.bot.entity.position = new Vec3(0, mineflayer.bot.entity.position.y + 1, 0)
    })

    mocks.getNearestBlocksAccurate.mockImplementation(async (_mineflayer: any, blockTypes: string | string[]) => {
      if (Array.isArray(blockTypes)) {
        return [adjacentDirt]
      }
      return [elevatedLog]
    })
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      const key = `${position.x},${position.y},${position.z}`
      if (position.x === 0 && position.y === 72 && position.z === 0) {
        return elevatedLog
      }
      if (position.x === 1 && position.y === 64 && position.z === 0) {
        return adjacentDirt
      }
      if (placedBlocks.has(key)) {
        return { name: 'dirt', position: new Vec3(position.x, position.y, position.z) }
      }
      if (position.x === 0 && position.y === 63 && position.z === 0) {
        return { name: 'grass_block', position: new Vec3(0, 63, 0) }
      }
      return { name: 'air', position: new Vec3(position.x, position.y, position.z) }
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 1 && y === 64 && z === 0) {
        inventoryItems = [{ name: 'dirt', count: 2 }]
        return
      }
      if (x === 0 && y === 72 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 1, 64, 0)
    expect(mineflayer.bot.placeBlock).toHaveBeenCalled()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 0, 72, 0)
  }, 10000)

  it('stops scaffold recovery when placement does not raise the bot', async () => {
    const elevatedLog = { name: 'oak_log', position: new Vec3(0, 74, 0) }
    const mineflayer = createMineflayer()
    const placedBlocks = new Set<string>()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.inventory.items = () => [
      { name: 'dirt', count: 8 },
    ]
    mineflayer.bot.placeBlock.mockImplementation(async (referenceBlock: { position: Vec3 }) => {
      const target = referenceBlock.position.offset(0, 1, 0)
      placedBlocks.add(`${target.x},${target.y},${target.z}`)
    })

    mocks.getNearestBlocksAccurate.mockResolvedValue([elevatedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      const key = `${position.x},${position.y},${position.z}`
      if (position.x === 0 && position.y === 74 && position.z === 0) {
        return elevatedLog
      }
      if (placedBlocks.has(key)) {
        return { name: 'dirt', position: new Vec3(position.x, position.y, position.z) }
      }
      if (position.x === 0 && position.y === 63 && position.z === 0) {
        return { name: 'grass_block', position: new Vec3(0, 63, 0) }
      }
      return { name: 'air', position: new Vec3(position.x, position.y, position.z) }
    })

    const success = await gatherWood(mineflayer, 1, 32)

    expect(success).toBe(false)
    expect(mineflayer.bot.placeBlock).toHaveBeenCalledTimes(1)
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  }, 10000)

  it('skips baritone recovery when a reachable elevated log produces no inventory progress', async () => {
    const overheadLog = { name: 'oak_log', position: new Vec3(0, 68, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 65, 0) }

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([overheadLog])
      .mockResolvedValueOnce([overheadLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 0 && position.y === 68 && position.z === 0) {
        return overheadLog
      }
      return null
    })
    mocks.breakBlockAt.mockResolvedValue(undefined)

    const success = await gatherWood(mineflayer, 1, 32)

    expect(success).toBe(false)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 0, 68, 0)
    expect(mineflayer.bot.pathfinder.mine).not.toHaveBeenCalled()
    expect(mocks.moveAway).not.toHaveBeenCalled()
  })

  it('continues to a grounded tree after an elevated reachable log produces no inventory progress', async () => {
    const overheadLog = { name: 'oak_log', position: new Vec3(0, 68, 0) }
    const groundedLog = { name: 'oak_log', position: new Vec3(20, 64, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 65, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([overheadLog, groundedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 0 && position.y === 68 && position.z === 0) {
        return overheadLog
      }
      if (position.x === 20 && position.y === 64 && position.z === 0) {
        return groundedLog
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, y, z)
      return true
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 20 && y === 64 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 32)

    expect(success).toBe(true)
    expect(mineflayer.bot.pathfinder.mine).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 0, 68, 0)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 20, 64, 0)
  })

  it('falls back to horizontal tree-column positioning when an elevated log column is not yet in range', async () => {
    const elevatedLog = { name: 'oak_log', position: new Vec3(10, 68, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 68 && position.z === 10) {
        return elevatedLog
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 65, z)
      return true
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 32)

    expect(success).toBe(true)
    expect(mocks.moveToHorizontalTarget).toHaveBeenCalledWith(mineflayer, 10, 10)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 10, 68, 10)
  })

  it('skips an unresolved elevated canopy hit instead of forcing a vertical ascent loop', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const reachableGroundLog = { name: 'oak_log', position: new Vec3(4, 64, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 63, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedCanopyLog, reachableGroundLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 70 && position.z === 10) {
        return elevatedCanopyLog
      }
      if (position.x === 4 && position.y === 64 && position.z === 0) {
        return reachableGroundLog
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 63, z)
      return true
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 4 && y === 64 && z === 0) {
        targetMineflayer.bot.entity.position = new Vec3(x, y, z)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 4 && y === 64 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalledWith(mineflayer, 10, 10)
    expect(mocks.goToPosition).not.toHaveBeenCalledWith(mineflayer, 10, 70, 10, 2)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 4, 64, 0)
  })

  it('keeps recovery-range ground trees after skipping nearer unresolved canopy hits', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const distantGroundLog = { name: 'oak_log', position: new Vec3(64, 64, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 63, 0) }
    mineflayer.bot.pathfinder.mine = undefined

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedCanopyLog, distantGroundLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 70 && position.z === 10) {
        return elevatedCanopyLog
      }
      if (position.x === 64 && position.y === 64 && position.z === 0) {
        return distantGroundLog
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 64 && y === 64 && z === 0) {
        targetMineflayer.bot.entity.position = new Vec3(x, y, z)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 64 && y === 64 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 96)

    expect(success).toBe(true)
    expect(mocks.goToPosition).not.toHaveBeenCalledWith(mineflayer, 10, 70, 10, 2)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 64, 64, 0, 2)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 64, 64, 0)
    expect(mocks.moveAway).not.toHaveBeenCalled()
  })

  it('skips below-surface wood candidates during surface collection', async () => {
    const belowSurfaceLog = { name: 'oak_log', position: new Vec3(10, 58, 0) }
    const surfaceLog = { name: 'oak_log', position: new Vec3(20, 65, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([belowSurfaceLog, surfaceLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 58 && position.z === 0) {
        return belowSurfaceLog
      }
      if (position.x === 20 && position.y === 65 && position.z === 0) {
        return surfaceLog
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 20 && y === 65 && z === 0) {
        targetMineflayer.bot.entity.position = new Vec3(x, y, z)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 20 && y === 65 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 96)

    expect(success).toBe(true)
    expect(mocks.goToPosition).not.toHaveBeenCalledWith(mineflayer, 10, 58, 0, expect.any(Number))
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 20, 65, 0, 2)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 20, 65, 0)
  })

  it('approaches the trunk base when wood search starts from a canopy hit', async () => {
    const canopyLog = { name: 'oak_log', position: new Vec3(12, 68, 10) }
    const trunkTop = { name: 'oak_log', position: new Vec3(10, 68, 10) }
    const trunkMid = { name: 'oak_log', position: new Vec3(10, 67, 10) }
    const trunkBase = { name: 'oak_log', position: new Vec3(10, 66, 10) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([canopyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 12 && position.y === 68 && position.z === 10)
        return canopyLog
      if (position.x === 10 && position.z === 10 && position.y === 68)
        return trunkTop
      if (position.x === 10 && position.z === 10 && position.y === 67)
        return trunkMid
      if (position.x === 10 && position.z === 10 && position.y === 66)
        return trunkBase
      return null
    })
    mocks.goToPosition.mockResolvedValue(true)

    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    const reached = await approachNearestWoodTarget(mineflayer, 'log', 64)

    expect(reached).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 10, 66, 10, 2)
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
  })

  it('approaches terrain-supported elevated wood horizontally during search when it becomes breakable', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const groundSupport = { name: 'grass_block', position: new Vec3(10, 68, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedCanopyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 70 && position.z === 10) {
        return elevatedCanopyLog
      }
      if (position.x === 10 && position.y === 68 && position.z === 10) {
        return groundSupport
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 66, z)
      return true
    })

    const reached = await approachNearestWoodTarget(mineflayer, 'log', 64)

    expect(reached).toBe(true)
    expect(mocks.moveToHorizontalTarget).toHaveBeenCalledWith(mineflayer, 10, 10)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
  })

  it('does not walk to terrain-supported elevated wood above horizontal approach reach during search', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 72, 10) }
    const groundSupport = { name: 'grass_block', position: new Vec3(10, 71, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedCanopyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 72 && position.z === 10) {
        return elevatedCanopyLog
      }
      if (position.x === 10 && position.y === 71 && position.z === 10) {
        return groundSupport
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 64, z)
      return true
    })

    const reached = await approachNearestWoodTarget(mineflayer, 'log', 64)

    expect(reached).toBe(false)
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
    expect(mocks.goToPosition).not.toHaveBeenCalled()
  })

  it('does not walk to deep terrain-supported elevated wood during search', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const groundSupport = { name: 'stone', position: new Vec3(10, 64, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedCanopyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 70 && position.z === 10) {
        return elevatedCanopyLog
      }
      if (position.x === 10 && position.y === 64 && position.z === 10) {
        return groundSupport
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 64, z)
      return true
    })

    const reached = await approachNearestWoodTarget(mineflayer, 'log', 64)

    expect(reached).toBe(false)
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
    expect(mocks.goToPosition).not.toHaveBeenCalled()
  })

  it('does not path to a raised log when its terrain support is far below the log height', async () => {
    const raisedLog = { name: 'birch_log', position: new Vec3(20, 69, 0) }
    const deepSupport = { name: 'stone', position: new Vec3(20, 63, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 68, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([raisedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 20 && position.y === 69 && position.z === 0) {
        return raisedLog
      }
      if (position.x === 20 && position.y === 63 && position.z === 0) {
        return deepSupport
      }
      return null
    })

    const reached = await approachNearestWoodTarget(mineflayer, 'log', 64)

    expect(reached).toBe(false)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
  })

  it('does not move horizontally under a deep-supported elevated column near the current height', async () => {
    const raisedLog = { name: 'oak_log', position: new Vec3(10, 71, 10) }
    const deepSupport = { name: 'stone', position: new Vec3(10, 64, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 67, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([raisedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 71 && position.z === 10) {
        return raisedLog
      }
      if (position.x === 10 && position.y === 64 && position.z === 10) {
        return deepSupport
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockResolvedValue(true)

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('approaches a low raised deep-supported trunk when horizontal contact puts it in break range', async () => {
    const raisedLog = { name: 'oak_log', position: new Vec3(10, 67, 10) }
    const deepSupport = { name: 'stone', position: new Vec3(10, 63, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([raisedLog])
      .mockResolvedValueOnce([raisedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 67 && position.z === 10) {
        return raisedLog
      }
      if (position.x === 10 && position.y === 63 && position.z === 10) {
        return deepSupport
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 64, z)
      return true
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.moveToHorizontalTarget).toHaveBeenCalledWith(mineflayer, 10, 10)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 10, 67, 10)
  })

  it('resolves a raised same-column trunk before applying deep terrain-support skipping', async () => {
    const topObservedLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([topObservedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.z === 10 && position.y >= 64 && position.y <= 70) {
        return { name: 'oak_log', position: new Vec3(10, position.y, 10) }
      }
      if (position.x === 10 && position.y === 63 && position.z === 10) {
        return { name: 'stone', position: new Vec3(10, 63, 10) }
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, y, z)
      return true
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 10, 64, 10, 2)
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 10, 64, 10)
  })

  it('resolves a nearby deep-supported canopy hit to an offset trunk before skipping it', async () => {
    const canopyHit = { name: 'oak_log', position: new Vec3(10, 73, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([canopyHit])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 73 && position.z === 10) {
        return canopyHit
      }
      if (position.x === 10 && position.y === 68 && position.z === 10) {
        return { name: 'stone', position: new Vec3(10, 68, 10) }
      }
      if (position.x === 15 && position.z === 10 && position.y >= 64 && position.y <= 70) {
        return { name: 'oak_log', position: new Vec3(15, position.y, 10) }
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, y, z)
      return true
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any) => {
      targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 15, 64, 10, 2)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 15, 64, 10)
  })

  it('does not treat an unresolved elevated wood candidate as a successful search target', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 75, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([elevatedCanopyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 75 && position.z === 10) {
        return elevatedCanopyLog
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 64, z)
      return true
    })

    const reached = await approachNearestWoodTarget(mineflayer, 'log', 64)

    expect(reached).toBe(false)
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
    expect(mocks.goToPosition).not.toHaveBeenCalled()
  })

  it('returns control from wood search without scanning every elevated candidate', async () => {
    const firstElevatedLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const secondElevatedLog = { name: 'oak_log', position: new Vec3(30, 73, 30) }
    const deepSupport = { name: 'stone', position: new Vec3(10, 64, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    let queriedSecondCandidate = false

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([firstElevatedLog, secondElevatedLog])
      .mockResolvedValueOnce([firstElevatedLog, secondElevatedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 30 || position.z === 30) {
        queriedSecondCandidate = true
      }
      if (position.x === 10 && position.y === 70 && position.z === 10) {
        return firstElevatedLog
      }
      if (position.x === 30 && position.y === 73 && position.z === 30) {
        return secondElevatedLog
      }
      if (position.x === 10 && position.y === 64 && position.z === 10) {
        return deepSupport
      }
      return null
    })

    const reached = await approachNearestWoodTarget(mineflayer, 'log', 64)

    expect(reached).toBe(false)
    expect(queriedSecondCandidate).toBe(false)
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
    expect(mocks.goToPosition).not.toHaveBeenCalled()
  })

  it('expands canopy-heavy scans into distinct tree candidates instead of retrying the same canopy cluster', async () => {
    const canopyHits = Array.from({ length: 24 }, (_, index) => ({
      name: 'oak_log',
      position: new Vec3(10 + (index % 3), 72 + (index % 2), 10 + (Math.floor(index / 6) % 3)),
    }))
    const distantGroundLog = { name: 'oak_log', position: new Vec3(52, 64, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.pathfinder.mine = undefined

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce(canopyHits)
      .mockResolvedValueOnce([...canopyHits, distantGroundLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      const canopyMatch = canopyHits.find(block =>
        block.position.x === position.x
        && block.position.y === position.y
        && block.position.z === position.z)
      if (canopyMatch) {
        return canopyMatch
      }
      if (position.x === 52 && position.y === 64 && position.z === 0) {
        return distantGroundLog
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 64, z)
      return true
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 52 && y === 64 && z === 0) {
        targetMineflayer.bot.entity.position = new Vec3(x, y, z)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 52 && y === 64 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.getNearestBlocksAccurate).toHaveBeenCalledTimes(2)
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 52, 64, 0, 2)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 52, 64, 0)
  })

  it('expands sparse single-tree scans before committing to the same canopy-only shoreline tree', async () => {
    const sparseCanopyHits = Array.from({ length: 8 }, (_, index) => ({
      name: 'oak_log',
      position: new Vec3(10 + (index % 2), 72 + (index % 2), 10 + Math.floor(index / 4)),
    }))
    const distantGroundLog = { name: 'oak_log', position: new Vec3(52, 64, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.pathfinder.mine = undefined

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce(sparseCanopyHits)
      .mockResolvedValueOnce([...sparseCanopyHits, distantGroundLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      const canopyMatch = sparseCanopyHits.find(block =>
        block.position.x === position.x
        && block.position.y === position.y
        && block.position.z === position.z)
      if (canopyMatch) {
        return canopyMatch
      }
      if (position.x === 52 && position.y === 64 && position.z === 0) {
        return distantGroundLog
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 64, z)
      return true
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 52 && y === 64 && z === 0) {
        targetMineflayer.bot.entity.position = new Vec3(x, y, z)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 52 && y === 64 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.getNearestBlocksAccurate).toHaveBeenCalledTimes(2)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 52, 64, 0)
  })

  it('expands sparse elevated multi-tree scans and prioritizes a lower reachable trunk', async () => {
    const elevatedCanopyHits = [
      { name: 'oak_log', position: new Vec3(8, 72, 0) },
      { name: 'oak_log', position: new Vec3(16, 71, 4) },
    ]
    const distantGroundLog = { name: 'oak_log', position: new Vec3(52, 64, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.pathfinder.mine = undefined

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce(elevatedCanopyHits)
      .mockResolvedValueOnce([...elevatedCanopyHits, distantGroundLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      const canopyMatch = elevatedCanopyHits.find(block =>
        block.position.x === position.x
        && block.position.y === position.y
        && block.position.z === position.z)
      if (canopyMatch) {
        return canopyMatch
      }
      if (position.x === 52 && position.y === 64 && position.z === 0) {
        return distantGroundLog
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 52 && y === 64 && z === 0) {
        targetMineflayer.bot.entity.position = new Vec3(x, y, z)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 52 && y === 64 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.getNearestBlocksAccurate).toHaveBeenCalledTimes(2)
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 52, 64, 0, 2)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 52, 64, 0)
  })

  it('resolves a high canopy hit to an offset low trunk before declaring it elevated-only', async () => {
    const canopyHit = { name: 'oak_log', position: new Vec3(10, 77, 10) }
    const offsetTrunkBase = { name: 'oak_log', position: new Vec3(15, 64, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.pathfinder.mine = undefined

    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([canopyHit])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 77 && position.z === 10) {
        return canopyHit
      }
      if (position.x === 15 && position.z === 10 && position.y >= 64 && position.y <= 70) {
        return { ...offsetTrunkBase, position: new Vec3(15, position.y, 10) }
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 15 && y === 64 && z === 10) {
        targetMineflayer.bot.entity.position = new Vec3(x, y, z)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 15 && y === 64 && z === 10) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.getBlockAtAccurate.mock.calls.length).toBeLessThan(360)
    expect(mocks.moveAway).not.toHaveBeenCalled()
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 15, 64, 10, 2)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 15, 64, 10)
  })

  it('returns control instead of relocating after a deep terrain-supported elevated wood column', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const groundSupport = { name: 'grass_block', position: new Vec3(10, 64, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([elevatedCanopyLog])
      .mockResolvedValueOnce([elevatedCanopyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 70 && position.z === 10) {
        return elevatedCanopyLog
      }
      if (position.x === 10 && position.y === 64 && position.z === 10) {
        return groundSupport
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 64, z)
      return true
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mocks.moveToHorizontalTarget).not.toHaveBeenCalled()
    expect(mocks.moveAway).not.toHaveBeenCalled()
    expect(mineflayer.bot.pathfinder.mine).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('bounds nearby offset trunk probing before skipping a deep-supported canopy hit', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const groundSupport = { name: 'stone', position: new Vec3(10, 64, 10) }
    const offsetTrunk = { name: 'oak_log', position: new Vec3(15, 64, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    let queriedOffsetTrunk = false

    mocks.getNearestBlocksAccurate.mockResolvedValue([elevatedCanopyLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 15 && position.z === 10) {
        queriedOffsetTrunk = true
        if (position.y === 64) {
          return offsetTrunk
        }
      }
      if (position.x === 10 && position.y === 70 && position.z === 10) {
        return elevatedCanopyLog
      }
      if (position.x === 10 && position.y === 64 && position.z === 10) {
        return groundSupport
      }
      return null
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(queriedOffsetTrunk).toBe(true)
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mineflayer.bot.pathfinder.mine).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('relocates toward reachable wood when nearby scans only see deep elevated canopy candidates', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const elevatedSupport = { name: 'grass_block', position: new Vec3(10, 64, 10) }
    const safeSurface = { name: 'grass_block', position: new Vec3(0, 63, 0) }
    const reachableGroundLog = { name: 'oak_log', position: new Vec3(42, 64, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.pathfinder.mine = undefined
    let woodScanCount = 0

    mocks.getNearestBlocksAccurate.mockImplementation(async () => {
      woodScanCount++
      return woodScanCount <= 2 ? [elevatedCanopyLog] : [reachableGroundLog]
    })
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 70 && position.z === 10) {
        return elevatedCanopyLog
      }
      if (position.x === 10 && position.y === 64 && position.z === 10) {
        return elevatedSupport
      }
      if (position.x === 0 && position.y === 63 && position.z === 0) {
        return safeSurface
      }
      if (position.x === 42 && position.y === 64 && position.z === 0) {
        return reachableGroundLog
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 42 && y === 64 && z === 0) {
        targetMineflayer.bot.entity.position = new Vec3(x, y, z)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 42 && y === 64 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.moveAway).not.toHaveBeenCalled()
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 42, 64, 0, 2)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 42, 64, 0)
  })

  it('stages horizontally toward a far raised wood cluster before the next trunk rescan', async () => {
    const farRaisedLog = { name: 'oak_log', position: new Vec3(42, 73, 0) }
    const reachableTrunkBase = { name: 'oak_log', position: new Vec3(42, 64, 0) }
    const safeSurface = { name: 'grass_block', position: new Vec3(0, 63, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.pathfinder.mine = undefined

    mocks.getNearestBlocksAccurate.mockImplementation(async (targetMineflayer: any) => {
      return targetMineflayer.bot.entity.position.x >= 20
        ? [reachableTrunkBase]
        : [farRaisedLog]
    })
    mocks.getBlockAtAccurate.mockImplementation(async (targetMineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 0 && position.y === 63 && position.z === 0) {
        return safeSurface
      }
      if (
        targetMineflayer.bot.entity.position.x >= 20
        && position.x === 42
        && position.y === 64
        && position.z === 0
      ) {
        return reachableTrunkBase
      }
      if (position.x === 42 && position.y === 73 && position.z === 0) {
        return farRaisedLog
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 64, z)
      return true
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 42 && y === 64 && z === 0) {
        targetMineflayer.bot.entity.position = new Vec3(x, y, z)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 42 && y === 64 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(true)
    expect(mocks.moveToHorizontalTarget).toHaveBeenCalledWith(mineflayer, 24, 0)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 42, 64, 0, 2)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 42, 64, 0)
    expect(mocks.moveAway).not.toHaveBeenCalled()
  })

  it('returns control without scanning every elevated candidate after a terrain-only miss', async () => {
    const firstElevatedLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const secondElevatedLog = { name: 'oak_log', position: new Vec3(30, 73, 30) }
    const deepSupport = { name: 'stone', position: new Vec3(10, 64, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    let queriedSecondCandidate = false

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([firstElevatedLog, secondElevatedLog])
      .mockResolvedValueOnce([firstElevatedLog, secondElevatedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 30 || position.z === 30) {
        queriedSecondCandidate = true
      }
      if (position.x === 10 && position.y === 70 && position.z === 10) {
        return firstElevatedLog
      }
      if (position.x === 30 && position.y === 73 && position.z === 30) {
        return secondElevatedLog
      }
      if (position.x === 10 && position.y === 64 && position.z === 10) {
        return deepSupport
      }
      return null
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(queriedSecondCandidate).toBe(false)
    expect(mocks.pickupNearbyItems).not.toHaveBeenCalled()
    expect(mocks.moveAway).not.toHaveBeenCalled()
    expect(mineflayer.bot.pathfinder.mine).not.toHaveBeenCalled()
    expect(mocks.breakBlockAt).not.toHaveBeenCalled()
  })

  it('keeps far elevated canopy base probing bounded before returning control', async () => {
    const farElevatedLog = { name: 'oak_log', position: new Vec3(42, 73, 0) }
    const deepSupport = { name: 'stone', position: new Vec3(42, 64, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([farElevatedLog])
      .mockResolvedValueOnce([farElevatedLog])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 42 && position.y === 73 && position.z === 0) {
        return farElevatedLog
      }
      if (position.x === 42 && position.y === 64 && position.z === 0) {
        return deepSupport
      }
      return null
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mocks.getBlockAtAccurate.mock.calls.length).toBeLessThan(160)
    expect(mocks.pickupNearbyItems).not.toHaveBeenCalled()
    expect(mocks.moveAway).not.toHaveBeenCalled()
  })

  it('does not hand an unresolved elevated canopy candidate to baritone or unsafe relocation', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 70, 10) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 63, 0) }

    mocks.getNearestBlocksAccurate
      .mockResolvedValueOnce([elevatedCanopyLog])
      .mockResolvedValueOnce([elevatedCanopyLog])
      .mockResolvedValueOnce([])
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 70 && position.z === 10) {
        return elevatedCanopyLog
      }
      return null
    })
    mocks.moveToHorizontalTarget.mockImplementation(async (targetMineflayer: any, x: number, z: number) => {
      targetMineflayer.bot.entity.position = new Vec3(x, 63, z)
      return true
    })

    const success = await gatherWood(mineflayer, 1, 64)

    expect(success).toBe(false)
    expect(mineflayer.bot.pathfinder.mine).not.toHaveBeenCalled()
    expect(mocks.goToPosition).not.toHaveBeenCalled()
    expect(mocks.moveAway).not.toHaveBeenCalled()
  })

  it('skips a remembered elevated-only tree during the wider fallback scan', async () => {
    const elevatedCanopyLog = { name: 'oak_log', position: new Vec3(10, 73, 10) }
    const reachableSupportedLog = { name: 'oak_log', position: new Vec3(90, 70, 0) }
    const supportBelowReachableLog = { name: 'grass_block', position: new Vec3(90, 69, 0) }
    const mineflayer = createMineflayer()
    mineflayer.bot.entity = { position: new Vec3(0, 64, 0) }
    mineflayer.bot.pathfinder.mine = undefined
    let woodScanCount = 0

    mocks.getNearestBlocksAccurate.mockImplementation(async (_mineflayer: any, blockTypes: string | string[]) => {
      if (Array.isArray(blockTypes)) {
        return []
      }
      woodScanCount++
      return woodScanCount <= 2
        ? [elevatedCanopyLog]
        : [elevatedCanopyLog, reachableSupportedLog]
    })
    mocks.getBlockAtAccurate.mockImplementation(async (_mineflayer: any, position: Vec3 | { x: number, y: number, z: number }) => {
      if (position.x === 10 && position.y === 73 && position.z === 10) {
        return elevatedCanopyLog
      }
      if (position.x === 90 && position.y === 70 && position.z === 0) {
        return reachableSupportedLog
      }
      if (position.x === 90 && position.y === 69 && position.z === 0) {
        return supportBelowReachableLog
      }
      return null
    })
    mocks.goToPosition.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 90 && y === 70 && z === 0) {
        targetMineflayer.bot.entity.position = new Vec3(x, y, z)
        return true
      }
      return false
    })
    mocks.breakBlockAt.mockImplementation(async (targetMineflayer: any, x: number, y: number, z: number) => {
      if (x === 90 && y === 70 && z === 0) {
        targetMineflayer.bot.inventory.items = () => [{ name: 'oak_log', count: 1 }]
      }
    })

    const firstAttempt = await gatherWood(mineflayer, 1, 24)
    const fallbackAttempt = await gatherWood(mineflayer, 1, 64)

    expect(firstAttempt).toBe(false)
    expect(fallbackAttempt).toBe(true)
    expect(mocks.goToPosition).toHaveBeenCalledTimes(1)
    expect(mocks.goToPosition).toHaveBeenCalledWith(mineflayer, 90, 70, 0, 1)
    expect(mocks.breakBlockAt).toHaveBeenCalledWith(mineflayer, 90, 70, 0)
    expect(mocks.moveAway).not.toHaveBeenCalled()
  })
})
