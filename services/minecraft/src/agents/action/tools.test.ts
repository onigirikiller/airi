import { Vec3 } from 'vec3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { actionsList } from './tools'

import * as skills from '../../skills'

const ensureMocks = vi.hoisted(() => ({
  ensureAxe: vi.fn(async () => true),
  ensureCraftingTable: vi.fn(async () => true),
  ensureHoe: vi.fn(async () => true),
  ensurePickaxe: vi.fn(async () => true),
  ensureStoneTierPickaxe: vi.fn(async () => true),
  ensureShovel: vi.fn(async () => true),
  ensureSword: vi.fn(async () => true),
  ensureTorches: vi.fn(async () => true),
}))
const collectMocks = vi.hoisted(() => ({
  approachNearestWoodTarget: vi.fn(async () => true),
  collectBlock: vi.fn(async () => true),
  gatherWood: vi.fn(async () => true),
  isWoodLikeBlockQuery: vi.fn((type: string) => type.includes('log')),
}))
const blockAccessMocks = vi.hoisted(() => ({
  getNearestBlocksAccurate: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
  getNearestFreeSpaceAccurate: vi.fn<(...args: any[]) => Promise<any>>(async () => undefined),
  getMiningExposureKindAccurate: vi.fn<(...args: any[]) => Promise<'sealed' | 'fluid' | 'air'>>(async () => 'air'),
}))
const worldInteractionMocks = vi.hoisted(() => ({
  activateNearestBlock: vi.fn(async () => true),
  placeBlock: vi.fn(async () => true),
}))
const worldStateMocks = vi.hoisted(() => ({
  getNotableBlockObservations: vi.fn<() => Array<{
    name: string
    distance: number
    position: { x: number, y: number, z: number }
  }>>(() => []),
}))
const runnerPhaseMocks = vi.hoisted(() => ({
  recoverTowardSurface: vi.fn(async () => true),
}))

vi.mock('../../skills', () => ({
  goToNearestBlock: vi.fn(async () => true),
  goToPosition: vi.fn(async () => true),
  goToNearestEntity: vi.fn(async () => true),
  moveAway: vi.fn(async () => true),
  craftRecipe: vi.fn(async () => true),
}))

vi.mock('../../skills/world', () => ({
  getInventoryCounts: vi.fn(() => ({ dirt: 3 })),
}))

vi.mock('../../skills/actions/collect-block', () => ({
  collectBlock: collectMocks.collectBlock,
}))

vi.mock('../../skills/actions/gather-wood', () => ({
  approachNearestWoodTarget: collectMocks.approachNearestWoodTarget,
  gatherWood: collectMocks.gatherWood,
  isWoodLikeBlockQuery: collectMocks.isWoodLikeBlockQuery,
}))

vi.mock('../../skills/block-access', () => ({
  getNearestBlocksAccurate: blockAccessMocks.getNearestBlocksAccurate,
  getNearestFreeSpaceAccurate: blockAccessMocks.getNearestFreeSpaceAccurate,
  getMiningExposureKindAccurate: blockAccessMocks.getMiningExposureKindAccurate,
}))

vi.mock('../../skills/actions/world-interactions', () => ({
  activateNearestBlock: worldInteractionMocks.activateNearestBlock,
  placeBlock: worldInteractionMocks.placeBlock,
}))

vi.mock('../../libs/llm-agent/world-state', () => ({
  getNotableBlockObservations: worldStateMocks.getNotableBlockObservations,
}))

vi.mock('../../runner/phases', () => ({
  recoverTowardSurface: runnerPhaseMocks.recoverTowardSurface,
}))

vi.mock('../../skills/actions/ensure', () => ensureMocks)

function createMineflayerStub() {
  return {
    status: {
      toOneLiner: () => 'position=(0,64,0)',
    },
    bot: {
      inventory: {
        slots: Array.from({ length: 9 }),
      },
      game: {
        gameMode: 'survival',
      },
    },
    emit: vi.fn(),
  }
}

describe('actionsList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    blockAccessMocks.getNearestFreeSpaceAccurate.mockResolvedValue(undefined)
    worldInteractionMocks.activateNearestBlock.mockResolvedValue(true)
    worldInteractionMocks.placeBlock.mockResolvedValue(true)
  })

  it('returns current status', () => {
    const mineflayer = createMineflayerStub()
    const statsAction = actionsList.find(action => action.name === 'stats')

    expect(statsAction).toBeDefined()

    const result = statsAction!.perform(mineflayer as any)()
    expect(result).toBe('position=(0,64,0)')
  })

  it('formats inventory data', () => {
    const mineflayer = createMineflayerStub()
    const inventoryAction = actionsList.find(action => action.name === 'inventory')

    expect(inventoryAction).toBeDefined()

    const result = inventoryAction!.perform(mineflayer as any)()
    expect(result).toContain('INVENTORY')
    expect(result).toContain('dirt: 3')
  })

  it('calls movement skill for coordinate action', async () => {
    const mineflayer = createMineflayerStub()
    const goToCoordinatesAction = actionsList.find(action => action.name === 'goToCoordinates')

    expect(goToCoordinatesAction).toBeDefined()

    const result = await goToCoordinatesAction!.perform(mineflayer as any)(10, 70, -3, 2)
    expect(result).toBe('Moving to coordinates...')
    expect(skills.goToPosition).toHaveBeenCalledOnce()
    expect(skills.goToPosition).toHaveBeenCalledWith(mineflayer, 10, 70, -3, 2)
  })

  it('routes surface recovery through the runner recovery helper', async () => {
    const mineflayer = createMineflayerStub()
    const recoverAction = actionsList.find(action => action.name === 'recoverTowardSurface')

    expect(recoverAction).toBeDefined()

    const result = await recoverAction!.perform(mineflayer as any)('surface-stall')
    expect(result).toBe('Recovering toward the surface...')
    expect(runnerPhaseMocks.recoverTowardSurface).toHaveBeenCalledOnce()
    expect(runnerPhaseMocks.recoverTowardSurface).toHaveBeenCalledWith(mineflayer, 'surface-stall')
  })

  it('emits interrupt event when stop action runs', async () => {
    const mineflayer = createMineflayerStub()
    const stopAction = actionsList.find(action => action.name === 'stop')

    expect(stopAction).toBeDefined()

    const result = await stopAction!.perform(mineflayer as any)()
    expect(result).toBe('Agent stopped.')
    expect(mineflayer.emit).toHaveBeenCalledOnce()
    expect(mineflayer.emit).toHaveBeenCalledWith('interrupt')
  })

  it('treats generic pickaxe recipe names as ensurePickaxe requests', async () => {
    const mineflayer = createMineflayerStub()
    const craftRecipeAction = actionsList.find(action => action.name === 'craftRecipe')

    expect(craftRecipeAction).toBeDefined()

    const result = await craftRecipeAction!.perform(mineflayer as any)('pickaxe', 1)

    expect(result).toBe('Pickaxe crafted/prepared.')
    expect(ensureMocks.ensurePickaxe).toHaveBeenCalledOnce()
    expect(ensureMocks.ensurePickaxe).toHaveBeenCalledWith(mineflayer, 1)
    expect(skills.craftRecipe).not.toHaveBeenCalled()
  })

  it('routes exact wooden pickaxe recipes through ensurePickaxe before any raw craft attempt', async () => {
    const mineflayer = createMineflayerStub()
    const craftRecipeAction = actionsList.find(action => action.name === 'craftRecipe')

    expect(craftRecipeAction).toBeDefined()

    const result = await craftRecipeAction!.perform(mineflayer as any)('wooden pickaxe', 1)

    expect(result).toBe('Pickaxe crafted/prepared.')
    expect(ensureMocks.ensurePickaxe).toHaveBeenCalledOnce()
    expect(ensureMocks.ensurePickaxe).toHaveBeenCalledWith(mineflayer, 1)
    expect(skills.craftRecipe).not.toHaveBeenCalled()
  })

  it('normalizes spaced exact stone pickaxe recipe names to stone-tier ensure flow', async () => {
    const mineflayer = createMineflayerStub()
    const craftRecipeAction = actionsList.find(action => action.name === 'craftRecipe')

    expect(craftRecipeAction).toBeDefined()

    const result = await craftRecipeAction!.perform(mineflayer as any)('stone pickaxe', 1)

    expect(result).toBe('Stone-tier pickaxe crafted/prepared.')
    expect(ensureMocks.ensureStoneTierPickaxe).toHaveBeenCalledOnce()
    expect(ensureMocks.ensureStoneTierPickaxe).toHaveBeenCalledWith(mineflayer)
    expect(skills.craftRecipe).not.toHaveBeenCalled()
  })

  it('routes wood-like block collection through gatherWood', async () => {
    const mineflayer = createMineflayerStub()
    const collectBlocksAction = actionsList.find(action => action.name === 'collectBlocks')

    expect(collectBlocksAction).toBeDefined()

    const result = await collectBlocksAction!.perform(mineflayer as any)('birch_log', 4)

    expect(result).toBe('Collecting wood...')
    expect(collectMocks.gatherWood).toHaveBeenCalledTimes(1)
    expect(collectMocks.gatherWood).toHaveBeenCalledWith(mineflayer, 4, 24, 'birch_log')
    expect(collectMocks.collectBlock).not.toHaveBeenCalled()
  })

  it('keeps non-wood block collection on the generic collectBlock path', async () => {
    const mineflayer = createMineflayerStub()
    const collectBlocksAction = actionsList.find(action => action.name === 'collectBlocks')
    collectMocks.isWoodLikeBlockQuery.mockReturnValueOnce(false)

    expect(collectBlocksAction).toBeDefined()

    const result = await collectBlocksAction!.perform(mineflayer as any)('stone', 3)

    expect(result).toBe('Collecting blocks...')
    expect(collectMocks.collectBlock).toHaveBeenCalledTimes(1)
    expect(collectMocks.collectBlock).toHaveBeenCalledWith(mineflayer, 'stone', 3, 24)
  })

  it('retries entity search with an expanded radius without doing an internal moveAway hop', async () => {
    const mineflayer = createMineflayerStub()
    const searchForEntityAction = actionsList.find(action => action.name === 'searchForEntity')
    vi.mocked(skills.goToNearestEntity)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    expect(searchForEntityAction).toBeDefined()

    const result = await searchForEntityAction!.perform(mineflayer as any)('animal', 64)

    expect(result).toBe('Searching for entity...')
    expect(skills.goToNearestEntity).toHaveBeenNthCalledWith(1, mineflayer, 'animal', 4, 64)
    expect(skills.goToNearestEntity).toHaveBeenNthCalledWith(2, mineflayer, 'animal', 4, 128)
    expect(skills.moveAway).not.toHaveBeenCalled()
  })

  it('routes wood-like block search through the trunk-aware wood approach helper', async () => {
    const mineflayer = createMineflayerStub()
    const searchForBlockAction = actionsList.find(action => action.name === 'searchForBlock')

    expect(searchForBlockAction).toBeDefined()

    const result = await searchForBlockAction!.perform(mineflayer as any)('log', 64)

    expect(result).toBe('Searching for block...')
    expect(collectMocks.approachNearestWoodTarget).toHaveBeenCalledWith(mineflayer, 'log', 64)
    expect(skills.goToNearestBlock).not.toHaveBeenCalled()
  })

  it('does not path wood search to a raw notable high-canopy coordinate when trunk-aware approach refuses it', async () => {
    const mineflayer = createMineflayerStub()
    const searchForBlockAction = actionsList.find(action => action.name === 'searchForBlock')
    collectMocks.approachNearestWoodTarget
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    worldStateMocks.getNotableBlockObservations.mockReturnValueOnce([
      {
        name: 'oak_log',
        distance: 10,
        position: { x: -321, y: 73, z: 138 },
      },
    ])

    expect(searchForBlockAction).toBeDefined()

    const result = await searchForBlockAction!.perform(mineflayer as any)('log', 64)

    expect(result).toBe('Wood search deferred to trunk-aware collection.')
    expect(collectMocks.approachNearestWoodTarget).toHaveBeenNthCalledWith(1, mineflayer, 'log', 64)
    expect(collectMocks.approachNearestWoodTarget).toHaveBeenNthCalledWith(2, mineflayer, 'log', 128)
    expect(skills.goToPosition).not.toHaveBeenCalled()
    expect(skills.moveAway).not.toHaveBeenCalled()
  })

  it('defers unresolved wood search to collection even when notable observations are empty', async () => {
    const mineflayer = createMineflayerStub()
    const searchForBlockAction = actionsList.find(action => action.name === 'searchForBlock')
    collectMocks.approachNearestWoodTarget
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    worldStateMocks.getNotableBlockObservations.mockReturnValueOnce([])

    expect(searchForBlockAction).toBeDefined()

    const result = await searchForBlockAction!.perform(mineflayer as any)('log', 64)

    expect(result).toBe('Wood search deferred to trunk-aware collection.')
    expect(collectMocks.approachNearestWoodTarget).toHaveBeenNthCalledWith(1, mineflayer, 'log', 64)
    expect(collectMocks.approachNearestWoodTarget).toHaveBeenNthCalledWith(2, mineflayer, 'log', 128)
    expect(skills.moveAway).not.toHaveBeenCalled()
  })

  it('prefers exposed mining targets when searching for stone', async () => {
    const mineflayer = createMineflayerStub()
    const searchForBlockAction = actionsList.find(action => action.name === 'searchForBlock')
    const buriedCandidates = Array.from({ length: 12 }, (_, index) => ({
      name: 'minecraft:stone',
      position: new Vec3(10 + index, 60, 10 + index),
    }))
    const exposedStone = {
      name: 'minecraft:stone',
      position: new Vec3(30, 58, 30),
    }

    blockAccessMocks.getNearestBlocksAccurate.mockResolvedValue([...buriedCandidates, exposedStone])
    blockAccessMocks.getMiningExposureKindAccurate.mockImplementation(async (_mineflayer, position) =>
      (position.x === exposedStone.position.x
        && position.y === exposedStone.position.y
        && position.z === exposedStone.position.z)
        ? 'air'
        : 'sealed')

    expect(searchForBlockAction).toBeDefined()

    const result = await searchForBlockAction!.perform(mineflayer as any)('stone', 64)

    expect(result).toBe('Searching for block...')
    expect(blockAccessMocks.getNearestBlocksAccurate).toHaveBeenCalledWith(mineflayer, ['stone'], 64, 48)
    expect(skills.goToPosition).toHaveBeenCalledWith(
      mineflayer,
      exposedStone.position.x,
      exposedStone.position.y,
      exposedStone.position.z,
      4,
    )
  })

  it('prefers air-exposed mining targets over fluid-exposed ones when searching for stone', async () => {
    const mineflayer = createMineflayerStub()
    const searchForBlockAction = actionsList.find(action => action.name === 'searchForBlock')
    const fluidStone = {
      name: 'minecraft:stone',
      position: new Vec3(10, 60, 10),
    }
    const airStone = {
      name: 'minecraft:stone',
      position: new Vec3(12, 60, 12),
    }

    blockAccessMocks.getNearestBlocksAccurate.mockResolvedValue([fluidStone, airStone])
    blockAccessMocks.getMiningExposureKindAccurate.mockImplementation(async (_mineflayer, position) =>
      position.x === airStone.position.x && position.z === airStone.position.z ? 'air' : 'fluid')

    expect(searchForBlockAction).toBeDefined()

    const result = await searchForBlockAction!.perform(mineflayer as any)('stone', 64)

    expect(result).toBe('Searching for block...')
    expect(skills.goToPosition).toHaveBeenCalledWith(
      mineflayer,
      airStone.position.x,
      airStone.position.y,
      airStone.position.z,
      4,
    )
  })

  it('places furnaces in a nearby safe free space instead of the player footprint', async () => {
    const mineflayer = createMineflayerStub()
    const placeAction = actionsList.find(action => action.name === 'placeHere')
    const safePlacement = { x: 3, y: 64, z: -2 }
    blockAccessMocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce(safePlacement)

    expect(placeAction).toBeDefined()

    const result = await placeAction!.perform(mineflayer as any)('furnace')

    expect(result).toBe('Placing block...')
    expect(blockAccessMocks.getNearestFreeSpaceAccurate).toHaveBeenCalledWith(mineflayer, 1, 8)
    expect(worldInteractionMocks.placeBlock).toHaveBeenCalledWith(
      mineflayer,
      'furnace',
      safePlacement.x,
      safePlacement.y,
      safePlacement.z,
    )
  })

  it('fails furnace placement when no safe free space is available', async () => {
    const mineflayer = createMineflayerStub()
    const placeAction = actionsList.find(action => action.name === 'placeHere')
    blockAccessMocks.getNearestFreeSpaceAccurate.mockResolvedValueOnce(undefined)

    expect(placeAction).toBeDefined()

    await expect(placeAction!.perform(mineflayer as any)('furnace'))
      .rejects
      .toThrow('no safe nearby free space')
    expect(worldInteractionMocks.placeBlock).not.toHaveBeenCalled()
  })

  it('falls back to notable block coordinates before random moveAway retries', async () => {
    const mineflayer = createMineflayerStub()
    const searchForBlockAction = actionsList.find(action => action.name === 'searchForBlock')

    blockAccessMocks.getNearestBlocksAccurate.mockResolvedValue([])
    worldStateMocks.getNotableBlockObservations.mockReturnValue([
      {
        name: 'iron_ore',
        distance: 18.4,
        position: { x: -12, y: 52, z: 7 },
      },
    ])
    vi.mocked(skills.goToPosition).mockResolvedValueOnce(true)

    expect(searchForBlockAction).toBeDefined()

    const result = await searchForBlockAction!.perform(mineflayer as any)('iron_ore', 64)

    expect(result).toBe('Searching for block...')
    expect(skills.goToPosition).toHaveBeenCalledWith(mineflayer, -12, 52, 7, 4)
    expect(skills.moveAway).not.toHaveBeenCalled()
  })
})
