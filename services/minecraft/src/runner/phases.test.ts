import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Vec3 } from 'vec3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Vec3Simple } from '../libs/fabric-bridge/bot-proxy'
import { determinePhase, executePhase, recoverTowardSurface } from './phases'
import { GamePhase, GameStateManager } from './state'

const mocks = vi.hoisted(() => ({
  buildWorldStateSnapshot: vi.fn(),
  getBlockAtAccurate: vi.fn(async () => ({ name: 'stone' })),
  getNearestBlocksAccurate: vi.fn(async () => []),
  triangulateStronghold: vi.fn(),
  pillarUp: vi.fn(async () => false),
  rangedAttack: vi.fn(async () => true),
  getPosition: vi.fn(() => new Vec3(0, 64, 0)),
  getNearestBlock: vi.fn(() => undefined),
  getNearestBlocks: vi.fn(() => []),
  getInventoryCounts: vi.fn(() => ({})),
  getNearestEntityWhere: vi.fn(),
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withError: vi.fn(),
    withFields: vi.fn(),
  },
}))

mocks.logger.withError.mockReturnValue(mocks.logger)
mocks.logger.withFields.mockReturnValue(mocks.logger)

vi.mock('../skills/actions/collect-block', () => ({
  collectBlock: vi.fn(async () => true),
}))

vi.mock('../skills/actions/ensure', () => ({
  ensureAxe: vi.fn(async () => true),
  ensureArrows: vi.fn(async () => true),
  ensureCoal: vi.fn(async () => true),
  ensureBow: vi.fn(async () => true),
  ensureCobblestone: vi.fn(async () => true),
  ensureCraftingTable: vi.fn(async () => true),
  ensureFurnaces: vi.fn(async () => true),
  ensurePickaxe: vi.fn(async () => true),
  ensureStoneTierPickaxe: vi.fn(async () => true),
  ensureSword: vi.fn(async () => true),
  ensureTorches: vi.fn(async () => true),
}))

vi.mock('../skills/actions/gather-wood', () => ({
  gatherWood: vi.fn(async () => true),
}))

vi.mock('../libs/llm-agent/world-state', () => ({
  buildWorldStateSnapshot: mocks.buildWorldStateSnapshot,
}))

vi.mock('../skills/block-access', () => ({
  getBlockAtAccurate: mocks.getBlockAtAccurate,
  getNearestBlocksAccurate: mocks.getNearestBlocksAccurate,
}))

vi.mock('../skills/actions/inventory', () => ({
  confirmItemCount: vi.fn(async () => true),
  equip: vi.fn(async () => true),
  getActualItemCount: vi.fn(() => 0),
  getItemCount: vi.fn(() => 0),
  refreshInventoryState: vi.fn(async () => true),
}))

vi.mock('../skills/blocks', () => ({
  breakBlockAt: vi.fn(async () => true),
  placeBlock: vi.fn(async () => true),
}))

vi.mock('../skills/combat', () => ({
  attackEntity: vi.fn(async () => true),
  attackNearest: vi.fn(async () => true),
  defendSelf: vi.fn(async () => true),
  rangedAttack: mocks.rangedAttack,
}))

vi.mock('../skills/crafting', () => ({
  craftRecipe: vi.fn(async () => true),
  getLastCraftRecipeDiagnostic: vi.fn(() => null),
  smeltItem: vi.fn(async () => true),
}))

vi.mock('../skills/movement', () => ({
  goToPosition: vi.fn(async (_bot, x: number, y: number, z: number) => {
    const nextPosition = new Vec3(x, y, z)
    mocks.getPosition.mockReturnValue(nextPosition)
    if (_bot?.bot?.entity) {
      _bot.bot.entity.position = nextPosition
    }
    return true
  }),
  moveAway: vi.fn(async (_bot, distance: number) => {
    const current = mocks.getPosition()
    const nextPosition = current.offset(distance, 0, 0)
    mocks.getPosition.mockReturnValue(nextPosition)
    if (_bot?.bot?.entity) {
      _bot.bot.entity.position = nextPosition
    }
    return true
  }),
  moveToHorizontalTarget: vi.fn(async (_bot, x: number, z: number) => {
    const current = mocks.getPosition()
    const nextPosition = new Vec3(x, current.y, z)
    mocks.getPosition.mockReturnValue(nextPosition)
    if (_bot?.bot?.entity) {
      _bot.bot.entity.position = nextPosition
    }
    return true
  }),
  swimTowardPositionManual: vi.fn(async () => true),
  swimUpward: vi.fn(async () => false),
}))

vi.mock('../skills/navigation', () => ({
  triangulateStronghold: mocks.triangulateStronghold,
}))

vi.mock('../skills/structures', () => ({
  pillarUp: mocks.pillarUp,
}))

vi.mock('../skills/world', () => ({
  getInventoryCounts: mocks.getInventoryCounts,
  getNearestBlock: mocks.getNearestBlock,
  getNearestBlocks: mocks.getNearestBlocks,
  getNearestEntityWhere: mocks.getNearestEntityWhere,
  getPosition: mocks.getPosition,
}))

vi.mock('../utils/logger', () => ({
  useLogger: () => mocks.logger,
}))

describe('runner phases', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.getBlockAtAccurate.mockResolvedValue({ name: 'stone' })
    mocks.getNearestBlocksAccurate.mockResolvedValue([])
    mocks.getPosition.mockReturnValue(new Vec3(0, 64, 0))
    mocks.getNearestBlock.mockReturnValue(undefined)
    mocks.getNearestBlocks.mockReturnValue([])
    mocks.pillarUp.mockResolvedValue(false)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:forest',
      skyAccess: 'open_sky',
      terrainContext: 'surface_forest',
      surfaceEscapeNeeded: false,
      woodAccess: 'good',
      position: { y: 64 },
    })
    const inventoryModule = await import('../skills/actions/inventory')
    vi.mocked(inventoryModule.confirmItemCount).mockResolvedValue(true)
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation(() => 0)
    vi.mocked(inventoryModule.getItemCount).mockImplementation(() => 0)

    const craftingModule = await import('../skills/crafting')
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue(null)
    vi.mocked(craftingModule.craftRecipe).mockResolvedValue(true)
  })

  afterEach(() => {
    const stateDir = join(tmpdir(), 'airi-minecraft-state')
    try {
      rmSync(stateDir, { recursive: true, force: true })
    }
    catch {
      // noop
    }
  })

  it('saves a triangulated stronghold estimate during the stronghold phase', async () => {
    mocks.triangulateStronghold.mockResolvedValue({ x: 1200, z: -800 })

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.STRONGHOLD)

    const bot = {
      bot: {
        inventory: {
          items: () => [{ name: 'ender_eye', count: 4 }],
        },
        chat: vi.fn(),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(state.getLocation('stronghold_estimate')).toMatchObject({
      x: 1200,
      z: -800,
      dimension: 'overworld',
    })
  })

  it('prefers ranged crystal destruction during the dragon fight when bow support exists', async () => {
    const { getItemCount } = await import('../skills/actions/inventory')
    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.DRAGON_FIGHT)

    mocks.getNearestEntityWhere
      .mockReturnValueOnce({ name: 'ender_dragon', position: new Vec3(30, 80, 0) })
      .mockReturnValueOnce({ name: 'end_crystal', position: new Vec3(10, 90, 0) })

    const bot = {
      bot: {
        inventory: {
          items: () => [{ name: 'bow', count: 1 }, { name: 'arrow', count: 16 }],
        },
        entity: {
          position: new Vec3(0, 64, 0),
        },
        chat: vi.fn(),
      },
    } as any

    vi.mocked(getItemCount).mockImplementation((_mineflayer, itemName) => {
      if (itemName === 'bow' || itemName === 'arrow') {
        return 1
      }
      return 0
    })

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(mocks.rangedAttack).toHaveBeenCalledWith(bot, 'end_crystal', 1)
  })

  it('returns to eye crafting when the end portal still needs more eyes than are available', async () => {
    const { getItemCount } = await import('../skills/actions/inventory')
    const remaining = { eyes: 1 }
    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.END_PORTAL)
    state.saveLocation('stronghold', {
      x: 0,
      y: 64,
      z: 0,
      dimension: 'overworld',
      label: 'Stronghold',
    })

    const emptyFrame = () => ({
      position: new Vec3(0, 64, 0),
      getProperties: () => ({ eye: 'false' }),
    })

    mocks.getNearestBlock.mockImplementation(((...args: unknown[]) => {
      const blockName = String(args[1] ?? '')
      if (blockName === 'end_portal_frame') {
        return { position: new Vec3(0, 64, 0), getProperties: () => ({ eye: 'false' }) }
      }
      return undefined
    }) as any)
    mocks.getNearestBlocks.mockReturnValue([emptyFrame(), emptyFrame(), emptyFrame()] as any)
    mocks.getInventoryCounts.mockReturnValue({
      blaze_powder: 8,
      ender_pearl: 12,
      ender_eye: 0,
    })
    vi.mocked(getItemCount).mockImplementation((_mineflayer, itemName) => {
      if (itemName === 'blaze_powder') {
        return 8
      }
      if (itemName === 'ender_pearl') {
        return 12
      }
      return 0
    })

    const bot = {
      bot: {
        game: {
          dimension: 'overworld',
        },
        inventory: {
          items: () => remaining.eyes > 0 ? [{ name: 'ender_eye', count: remaining.eyes }] : [],
        },
        entity: {
          position: new Vec3(0, 64, 0),
        },
        equip: vi.fn(async () => true),
        activateBlock: vi.fn(async () => {
          remaining.eyes = Math.max(0, remaining.eyes - 1)
        }),
        chat: vi.fn(),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('gathering more materials')
    expect(state.phase).toBe(GamePhase.EYE_CRAFTING)
    expect(bot.bot.activateBlock).toHaveBeenCalledTimes(1)
  })

  it('drops back to prerequisite gathering when eye crafting runs out of materials', async () => {
    const { craftRecipe } = await import('../skills/crafting')
    const { getItemCount } = await import('../skills/actions/inventory')

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EYE_CRAFTING)
    state.saveLocation('nether_portal', {
      x: 0,
      y: 64,
      z: 0,
      dimension: 'overworld',
      label: 'Nether Portal',
    })

    mocks.getInventoryCounts.mockReturnValue({
      blaze_rod: 0,
      ender_pearl: 4,
      blaze_powder: 0,
      ender_eye: 0,
    })
    vi.mocked(getItemCount).mockImplementation((_mineflayer, itemName) => {
      if (itemName === 'ender_pearl') {
        return 4
      }
      return 0
    })

    const bot = {
      bot: {
        game: {
          dimension: 'overworld',
        },
        inventory: {
          items: () => [],
        },
        entity: {
          position: new Vec3(0, 64, 0),
        },
        chat: vi.fn(),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('resuming prerequisite gathering')
    expect(state.phase).toBe(GamePhase.NETHER_EXPLORE)
    expect(craftRecipe).not.toHaveBeenCalled()
  })

  it('keeps crafting extra eyes before stronghold search so triangulation does not consume portal stock', async () => {
    const { craftRecipe } = await import('../skills/crafting')
    const { getItemCount } = await import('../skills/actions/inventory')

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EYE_CRAFTING)

    vi.mocked(getItemCount).mockImplementation((_mineflayer, itemName) => {
      if (itemName === 'ender_eye') {
        return 12
      }
      if (itemName === 'blaze_powder' || itemName === 'ender_pearl') {
        return 2
      }
      return 0
    })

    const bot = {
      bot: {
        game: {
          dimension: 'overworld',
        },
        inventory: {
          items: () => [{ name: 'ender_eye', count: 12 }],
        },
        entity: {
          position: new Vec3(0, 64, 0),
        },
        chat: vi.fn(),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Crafted 2 eyes of ender')
    expect(craftRecipe).toHaveBeenCalledWith(bot, 'ender_eye', 2)
  })

  it('waits for actual eye-of-ender inventory confirmation before reporting crafted eyes', async () => {
    const craftingModule = await import('../skills/crafting')
    const inventoryModule = await import('../skills/actions/inventory')

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EYE_CRAFTING)

    vi.mocked(inventoryModule.getItemCount).mockImplementation((_mineflayer, itemName) => {
      if (itemName === 'ender_eye') {
        return 12
      }
      if (itemName === 'blaze_powder' || itemName === 'ender_pearl') {
        return 2
      }
      return 0
    })
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_mineflayer, itemName) => {
      if (itemName === 'ender_eye') {
        return 12
      }
      return 0
    })
    vi.mocked(inventoryModule.confirmItemCount).mockResolvedValue(false)
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'ender_eye',
      inventoryOnly: false,
      at: Date.now(),
    })

    const bot = {
      bot: {
        game: {
          dimension: 'overworld',
        },
        inventory: {
          items: () => [{ name: 'ender_eye', count: 12 }],
        },
        entity: {
          position: new Vec3(0, 64, 0),
        },
        chat: vi.fn(),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('waiting for inventory sync')
  })

  it('relocates aggressively instead of pretending to progress when early-game wood gathering fails in poor terrain', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { moveAway, moveToHorizontalTarget } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      terrainContext: 'surface_desert',
      surfaceEscapeNeeded: false,
      woodAccess: 'poor',
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 58, 0),
        },
        inventory: {
          items: () => [],
        },
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Relocating to a biome with trees')
    expect(moveAway).toHaveBeenCalledWith(bot, 64)
    expect(moveToHorizontalTarget).not.toHaveBeenCalled()
  })

  it('still relocates when wood gathering fails even if biome heuristics look favorable', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { moveAway } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      terrainContext: 'surface_forest',
      surfaceEscapeNeeded: false,
      woodAccess: 'good',
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 58, 0),
        },
        inventory: {
          items: () => [],
        },
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.message).toContain('Relocating to a biome with trees')
    expect(moveAway).toHaveBeenCalledWith(bot, 64)
  })

  it('breaks soft blocks above the bot before giving up on a submerged wood bootstrap', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { swimUpward } = await import('../skills/movement')
    const { breakBlockAt } = await import('../skills/blocks')

    vi.mocked(gatherWood).mockResolvedValue(false)
    vi.mocked(swimUpward)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    vi.mocked(breakBlockAt).mockResolvedValue(true)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:ocean',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 53 },
      immediateTerrain: [
        'under:gravel',
        'feet:water',
        'head:water',
        'north:water',
        'south:water',
        'east:water',
        'west:water',
      ],
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as Vec3
      if (pos.x === 0 && pos.y === 55 && pos.z === 0) {
        return { name: 'gravel' }
      }
      return { name: 'water' }
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 53, 0),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => null),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Escaping underground')
    expect(breakBlockAt).toHaveBeenCalledWith(bot, 0, 55, 0)
  })

  it('prefers relocation toward a wood-friendly biome candidate when one is detectable nearby', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { moveAway, moveToHorizontalTarget } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:plains',
      skyAccess: 'open_sky',
      terrainContext: 'surface_open_land',
      surfaceEscapeNeeded: false,
      woodAccess: 'poor',
      position: { y: 64 },
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
        world: {
          getBiome: vi.fn(async (pos: Vec3) => (pos.x > 0 ? 'minecraft:forest' : 'minecraft:desert')),
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    const result = await executePhase(bot, state)

    expect(result.message).toContain('Relocating to a biome with trees')
    expect(moveToHorizontalTarget).toHaveBeenCalled()
    expect(moveAway).not.toHaveBeenCalled()
  })

  it('prefers relocation toward an actual wood block before biome-center hopping', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { moveAway, moveToHorizontalTarget } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    mocks.getNearestBlocksAccurate.mockResolvedValue([
      { name: 'oak_log', position: new Vec3(40, 68, 8) },
    ] as any)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:forest',
      skyAccess: 'enclosed',
      terrainContext: 'surface_forest',
      surfaceEscapeNeeded: false,
      woodAccess: 'poor',
      position: { y: 67 },
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 67, 0),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
        world: {
          getBiome: vi.fn(async () => 'minecraft:forest'),
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    const result = await executePhase(bot, state)

    expect(result.message).toContain('Relocating toward detected nearby wood')
    expect(moveToHorizontalTarget).toHaveBeenCalledWith(bot, 40, 8)
    expect(moveAway).not.toHaveBeenCalled()
  })

  it('treats low-elevation enclosed terrain as an underground escape case during wood recovery', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { goToPosition, moveAway, moveToHorizontalTarget } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:old_growth_birch_forest',
      skyAccess: 'partial_cover',
      terrainContext: 'surface_forest',
      surfaceEscapeNeeded: false,
      woodAccess: 'poor',
      position: { y: 58 },
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 58, 0),
        },
        inventory: {
          items: () => [],
        },
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.message).toContain('Escaping underground')
    expect(goToPosition).toHaveBeenCalled()
    expect(moveAway).not.toHaveBeenCalled()
    expect(moveToHorizontalTarget).not.toHaveBeenCalled()
  })

  it('tries to swim upward before random relocation when underground recovery is blocked by water terrain', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { swimUpward, moveAway } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    vi.mocked(swimUpward).mockResolvedValue(true)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:ocean',
      skyAccess: 'enclosed',
      terrainContext: 'underground_cave',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      immediateTerrain: ['feet:water', 'head:water'],
      position: { y: 53 },
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        inventory: {
          items: () => [],
        },
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.message).toContain('Escaping underground')
    expect(swimUpward).toHaveBeenCalled()
    expect(moveAway).not.toHaveBeenCalled()
  })

  it('tries a local swim exit before random relocation when fully submerged underground', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { swimTowardPositionManual, swimUpward, moveAway } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    vi.mocked(swimUpward).mockResolvedValue(false)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:ocean',
      skyAccess: 'enclosed',
      terrainContext: 'underground_cave',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      immediateTerrain: [
        'under:gravel',
        'feet:water',
        'head:water',
        'north:water',
        'south:water',
        'east:water',
        'west:water',
      ],
      position: { y: 53 },
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const position = args[1] as { x: number, y: number, z: number }
      if (position.y >= 56) {
        return { name: 'air' }
      }
      return { name: 'water' }
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 53, 0),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => null),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.message).toContain('Escaping underground')
    expect(swimTowardPositionManual).toHaveBeenCalled()
    expect(moveAway).not.toHaveBeenCalled()
  })

  it('fails the early-game step when underground relocation does not change position', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { swimTowardPositionManual, swimUpward, goToPosition, moveAway } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    vi.mocked(swimTowardPositionManual).mockResolvedValue(false)
    vi.mocked(swimUpward).mockResolvedValue(false)
    vi.mocked(goToPosition).mockResolvedValue(false)
    vi.mocked(moveAway).mockResolvedValue(false)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:ocean',
      skyAccess: 'enclosed',
      terrainContext: 'underground_cave',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      immediateTerrain: [
        'under:gravel',
        'feet:water',
        'head:water',
        'north:water',
        'south:water',
        'east:water',
        'west:water',
      ],
      position: { y: 53 },
    })
    mocks.getPosition.mockReturnValue(new Vec3(0, 53, 0))
    mocks.getBlockAtAccurate.mockResolvedValue({ name: 'water' })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 53, 0),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => null),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Unable to escape underground')
  })

  it('uses a stronger inland fallback when wood recovery stalls on water-edge terrain', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { moveAway } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    vi.mocked(moveAway).mockImplementation(async (_bot, distance: number) => {
      const current = mocks.getPosition()
      mocks.getPosition.mockReturnValue(current.offset(distance, 0, 0))
      return true
    })
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:ocean',
      skyAccess: 'open_sky',
      terrainContext: 'surface_water_edge',
      surfaceEscapeNeeded: false,
      woodAccess: 'poor',
      position: { y: 62 },
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        inventory: {
          items: () => [],
        },
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.message).toContain('Relocating to a biome with trees')
    expect(moveAway).toHaveBeenCalledWith(bot, 128)
  })

  it('fails early-game step 1 instead of pretending progress when crafting table ensure fails', async () => {
    const ensure = await import('../skills/actions/ensure')
    const inventory = await import('../skills/actions/inventory')

    vi.mocked(ensure.ensureCraftingTable).mockResolvedValue(false)
    vi.mocked(inventory.getActualItemCount).mockReturnValue(0)

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        inventory: {
          items: () => [{ name: 'oak_log', count: 16 }],
        },
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Could not make crafting table')
  })

  it('advances early-game crafting-table progress when ensure succeeds under bridge inventory lag', async () => {
    const ensure = await import('../skills/actions/ensure')
    const inventory = await import('../skills/actions/inventory')
    let craftingTableReads = 0

    vi.mocked(ensure.ensureCraftingTable).mockResolvedValue(true)
    vi.mocked(inventory.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        craftingTableReads++
        return craftingTableReads >= 3 ? 1 : 0
      }
      return 0
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        inventory: {
          items: () => [{ name: 'oak_log', count: 16 }],
        },
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Made crafting table')
  })

  it('fails early-game crafting-table progress when ensure succeeds but confirmation still fails', async () => {
    const ensure = await import('../skills/actions/ensure')
    const inventory = await import('../skills/actions/inventory')

    vi.mocked(ensure.ensureCraftingTable).mockResolvedValue(true)
    vi.mocked(inventory.getItemCount).mockImplementation((_bot, itemName) => itemName === 'crafting_table' ? 0 : 0)

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        inventory: {
          items: () => [{ name: 'oak_log', count: 16 }],
        },
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Could not make crafting table')
  })

  it('surfaces bridge craft-sync blocking when crafting table progress still cannot be observed', async () => {
    const ensure = await import('../skills/actions/ensure')
    const inventory = await import('../skills/actions/inventory')
    const crafting = await import('../skills/crafting')

    vi.mocked(ensure.ensureCraftingTable).mockResolvedValue(false)
    vi.mocked(inventory.getItemCount).mockReturnValue(0)
    vi.mocked(crafting.getLastCraftRecipeDiagnostic).mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'crafting_table',
      inventoryOnly: true,
      at: Date.now(),
    } as any)

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        inventory: {
          items: () => [{ name: 'oak_log', count: 16 }],
        },
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Bridge capability blocked craft sync: crafting table craft did not sync to bot state')
  })

  it('does not regress to full wood gathering once a crafting table already exists', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { getActualItemCount, getItemCount } = await import('../skills/actions/inventory')

    vi.mocked(getActualItemCount).mockImplementation((_mineflayer, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(getItemCount).mockImplementation((_mineflayer, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(gatherWood).mockResolvedValue(true)

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => Array.from({ length: 15 }, () => ({ name: 'birch_log', count: 1 })),
        },
      },
    } as any

    const result = await executePhase(bot, state)

    expect(vi.mocked(gatherWood)).not.toHaveBeenCalled()
    expect(result.message).not.toContain('Gathered wood')
  })

  it('gathers only the minimum bootstrap logs before crafting starter tools', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { getActualItemCount, getItemCount } = await import('../skills/actions/inventory')

    let logs = 0
    vi.mocked(getActualItemCount).mockReturnValue(0)
    vi.mocked(getItemCount).mockReturnValue(0)
    mocks.getNearestBlocksAccurate.mockResolvedValue([])
    vi.mocked(gatherWood).mockImplementation(async (_bot, targetLogs: number) => {
      logs = targetLogs
      return true
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => logs > 0 ? [{ name: 'oak_log', count: logs }] : [],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    await executePhase(bot, state)

    expect(vi.mocked(gatherWood)).toHaveBeenCalledWith(bot, 4, 80)
  })

  it('prefers the farther equally-good inland biome candidate when escaping water-edge terrain', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { moveToHorizontalTarget } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:ocean',
      skyAccess: 'open_sky',
      terrainContext: 'surface_water_edge',
      surfaceEscapeNeeded: false,
      woodAccess: 'poor',
      position: { y: 62 },
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => ({ name: 'sand' })),
        world: {
          getBiome: vi.fn(async (pos: Vec3) => (pos.x > 0 ? 'minecraft:plains' : 'minecraft:ocean')),
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    await executePhase(bot, state)

    expect(moveToHorizontalTarget).toHaveBeenCalled()
    expect(vi.mocked(moveToHorizontalTarget).mock.calls[0]?.[1]).toBeGreaterThanOrEqual(224)
  })

  it('fails fast when submerged escape is blocked by missing remote movement support', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const { moveAway, swimTowardPositionManual } = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    vi.mocked(swimTowardPositionManual).mockResolvedValue(false)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:ocean',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 53 },
      immediateTerrain: [
        'under:gravel',
        'feet:water',
        'head:water',
        'north:water',
        'south:water',
        'east:water',
        'west:water',
      ],
    })
    mocks.getBlockAtAccurate.mockResolvedValue({ name: 'water' })

    const state = new GameStateManager(`test-${Date.now()}`)
    let remoteMovementSupport: 'unknown' | 'unsupported' = 'unknown'
    let baritoneAvailability: 'unknown' | 'unavailable' = 'unknown'
    const bot = {
      bot: {
        getBridgeDebugState: () => ({
          bridgeVersion: null,
          bridgeBuildTimestamp: null,
          pathfinder: {
            remoteMovementSupport,
            baritoneAvailability,
          },
        }),
        probeBridgeCapabilities: vi.fn(async () => {
          remoteMovementSupport = 'unsupported'
          baritoneAvailability = 'unavailable'
          return {
            pathfinder: {
              remoteMovementSupport,
              baritoneAvailability,
            },
          }
        }),
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 53, 0),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => null),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(false)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Bridge capability blocked submerged escape')
    expect(moveAway).not.toHaveBeenCalled()
  })

  it('tries manual swim toward a nearby local exit before declaring the bridge blocked', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const movement = await import('../skills/movement')

    vi.mocked(gatherWood).mockResolvedValue(false)
    vi.mocked(movement.swimTowardPositionManual).mockResolvedValue(true)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:ocean',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 53 },
      immediateTerrain: [
        'under:gravel',
        'feet:water',
        'head:water',
        'north:water',
        'south:water',
        'east:water',
        'west:water',
      ],
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as { x: number, y: number, z: number }
      if (pos.x === 0 && pos.y === 54 && pos.z === 1) {
        return { name: 'water' }
      }
      if (pos.x === 0 && pos.y === 55 && pos.z === 1) {
        return { name: 'air' }
      }
      return { name: 'water' }
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        getBridgeDebugState: () => ({
          bridgeVersion: null,
          bridgeBuildTimestamp: null,
          pathfinder: {
            remoteMovementSupport: 'unsupported',
            baritoneAvailability: 'available',
          },
        }),
        probeBridgeCapabilities: vi.fn(async () => ({
          pathfinder: {
            remoteMovementSupport: 'unsupported',
            baritoneAvailability: 'available',
          },
        })),
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 53, 0),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => ({ name: 'water' })),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.message).toContain('Escaping underground')
    expect(movement.swimTowardPositionManual).toHaveBeenCalled()
  })

  it('clears a soft directional swim obstacle and retries the local swim exit', async () => {
    const { gatherWood } = await import('../skills/actions/gather-wood')
    const movement = await import('../skills/movement')
    const { breakBlockAt } = await import('../skills/blocks')

    vi.mocked(gatherWood).mockResolvedValue(false)
    vi.mocked(movement.swimTowardPositionManual)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:ocean',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 53 },
      immediateTerrain: [
        'under:gravel',
        'feet:water',
        'head:water',
        'north:water',
        'south:water',
        'east:water',
        'west:water',
      ],
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as { x: number, y: number, z: number }
      if (pos.x === 2031 && pos.y === 53 && pos.z === 160) {
        return { name: 'kelp_plant' }
      }
      if (pos.x === 2031 && pos.y === 61 && pos.z === 160) {
        return { name: 'water' }
      }
      if (pos.x === 2031 && pos.y === 62 && pos.z === 160) {
        return { name: 'air' }
      }
      return { name: 'water' }
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        getBridgeDebugState: () => ({
          bridgeVersion: null,
          bridgeBuildTimestamp: null,
          pathfinder: {
            remoteMovementSupport: 'unsupported',
            baritoneAvailability: 'available',
          },
        }),
        probeBridgeCapabilities: vi.fn(async () => ({
          pathfinder: {
            remoteMovementSupport: 'unsupported',
            baritoneAvailability: 'available',
          },
        })),
        chat: vi.fn(),
        entity: {
          position: new Vec3(2032, 53, 161),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => ({ name: 'water' })),
      },
    } as any

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(movement.swimTowardPositionManual).toHaveBeenCalledTimes(2)
    expect(breakBlockAt).toHaveBeenCalled()
  })

  it('escapes toward the surface before trying to craft a pickaxe underground', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:plains',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'good',
      position: { y: 40 },
      immediateTerrain: [
        'under:stone',
        'feet:air',
        'head:air',
        'north:air',
        'south:air',
        'east:air',
        'west:air',
      ],
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 40, 0),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => ({ name: 'stone' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Escaping underground to reach surface trees')
    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.moveAway)).toHaveBeenCalled()
  })

  it('skips same-block cave openings and falls back to a single vertical probe before relocating', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.getPosition.mockReturnValue(new Vec3(-670, 55, 408))
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:jagged_peaks',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 55 },
      immediateTerrain: [
        'under:stone',
        'feet:air',
        'head:air',
        'north:air',
        'south:air',
        'east:air',
        'west:air',
      ],
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as { x: number, y: number, z: number }
      if (pos.x === -670 && pos.z === 408) {
        if (pos.y === 54) {
          return { name: 'stone' }
        }
        if (pos.y >= 55 && pos.y <= 74) {
          return { name: 'air' }
        }
      }
      return { name: 'stone' }
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(-670, 55, 408),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'unknown' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Relocating toward cave exit before crafting starter tools')
    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.goToPosition)).not.toHaveBeenCalledWith(bot, -670, 55, 408, 0.25)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledWith(bot, -670, 63, 408, 2)
    expect(vi.mocked(movementModule.moveAway)).toHaveBeenCalled()
  })

  it('supports bridge-style positions when probing a vertical surface escape', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.getPosition.mockReturnValue(new Vec3(-673, 56, 424))
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:dripstone_caves',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 56 },
      immediateTerrain: [
        'under:diorite',
        'feet:air',
        'head:air',
        'north:air',
        'south:air',
        'east:air',
        'west:air',
      ],
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as { x: number, y: number, z: number }
      if (pos.x === -673 && pos.z === 424) {
        if (pos.y === 55) {
          return { name: 'stone' }
        }
        if (pos.y >= 56 && pos.y <= 73) {
          return { name: 'air' }
        }
      }
      return { name: 'stone' }
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3Simple(-673, 56, 424),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'unknown' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Relocating toward cave exit before crafting starter tools')
    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledWith(bot, -673, 64, 424, 2)
  })

  it('stops repeated blind vertical probes after the first cave climb without a visible direct sky exit', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.getPosition.mockReturnValue(new Vec3(-725, 62, 421))
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:dripstone_caves',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 62 },
      immediateTerrain: [
        'under:stone',
        'feet:air',
        'head:air',
        'north:stone',
        'south:air',
        'east:stone',
        'west:stone',
      ],
    })

    const goToPositionMock = vi.mocked(movementModule.goToPosition)
    goToPositionMock.mockImplementationOnce(async (_bot) => {
      const nextPosition = new Vec3(-725, 67, 421)
      mocks.getPosition.mockReturnValue(nextPosition)
      if (_bot?.bot?.entity) {
        _bot.bot.entity.position = nextPosition
      }
      return false
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(-725, 62, 421),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'unknown' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Relocating toward cave exit before crafting starter tools')
    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(goToPositionMock).toHaveBeenCalledTimes(1)
    expect(goToPositionMock).toHaveBeenCalledWith(bot, -725, 70, 421, 2)
    expect(vi.mocked(movementModule.moveAway)).toHaveBeenCalledWith(bot, 48)
  })

  it('pillars out of an enclosed shaft when vertical pathfinding cannot climb the current column', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const blocksModule = await import('../skills/blocks')
    const movementModule = await import('../skills/movement')
    const structuresModule = await import('../skills/structures')
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.getPosition.mockReturnValue(new Vec3(0, 37, 0))
    mocks.getInventoryCounts.mockReturnValue({ cobblestone: 32 })
    mocks.buildWorldStateSnapshot.mockImplementation(async (bot: any) => {
      const y = bot.bot.entity.position.y
      const surfaced = y >= 41
      return {
        biome: surfaced ? 'minecraft:forest' : 'minecraft:dripstone_caves',
        terrainContext: surfaced ? 'surface_forest' : 'underground_cave',
        skyAccess: surfaced ? 'open_sky' : 'enclosed',
        surfaceEscapeNeeded: !surfaced,
        woodAccess: surfaced ? 'good' : 'poor',
        position: { y },
        immediateTerrain: surfaced
          ? [
              'under:grass_block',
              'feet:air',
              'head:air',
              'north:air',
              'south:air',
              'east:air',
              'west:air',
            ]
          : [
              'under:stone',
              'feet:air',
              'head:stone',
              'north:stone',
              'south:stone',
              'east:stone',
              'west:air',
            ],
      }
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as { x: number, y: number, z: number }
      if (pos.x === 0 && pos.z === 0 && pos.y >= 38 && pos.y <= 39) {
        return { name: 'stone' }
      }
      return { name: 'stone' }
    })
    vi.mocked(movementModule.goToPosition).mockImplementation(async () => false)
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(structuresModule.pillarUp).mockImplementation(async (bot: any, _blockType: string, height: number) => {
      const nextPosition = bot.bot.entity.position.offset(0, height, 0)
      bot.bot.entity.position = nextPosition
      mocks.getPosition.mockReturnValue(nextPosition)
      return true
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 37, 0),
        },
        inventory: {
          items: () => [{ name: 'cobblestone', count: 32 }],
        },
        blockAt: vi.fn(() => ({ name: 'unknown' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Escaping underground')
    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(blocksModule.breakBlockAt)).toHaveBeenCalledWith(bot, 0, 38, 0)
    expect(vi.mocked(blocksModule.breakBlockAt)).toHaveBeenCalledWith(bot, 0, 39, 0)
    expect(vi.mocked(structuresModule.pillarUp)).toHaveBeenCalledWith(bot, 'cobblestone', 1)
  })

  it('skips blind vertical probes near surface height when no direct sky exit is detected', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.getPosition.mockReturnValue(new Vec3(-726, 64, 424))
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:dripstone_caves',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 64 },
      immediateTerrain: [
        'under:stone',
        'feet:air',
        'head:air',
        'north:air',
        'south:stone',
        'east:stone',
        'west:stone',
      ],
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(-726, 64, 424),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'unknown' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Relocating toward cave exit before crafting starter tools')
    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.goToPosition)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.moveAway)).toHaveBeenCalledWith(bot, 48)
  })

  it('attempts a direct ascent onto a nearby cave exit candidate before fallback relocation', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(-757, 32, 407),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'unknown' })),
      },
    } as any

    mocks.buildWorldStateSnapshot.mockImplementation(async () => {
      const y = bot.bot.entity.position.y
      const surfaced = y >= 40
      return {
        biome: surfaced ? 'minecraft:forest' : 'minecraft:dripstone_caves',
        terrainContext: surfaced ? 'surface_forest' : 'underground_cave',
        skyAccess: surfaced ? 'open_sky' : 'enclosed',
        surfaceEscapeNeeded: !surfaced,
        woodAccess: surfaced ? 'good' : 'poor',
        position: { y },
        immediateTerrain: [
          'under:stone',
          'feet:air',
          'head:air',
          'north:air',
          'south:air',
          'east:air',
          'west:air',
        ],
      }
    })
    mocks.getPosition.mockReturnValue(new Vec3(-757, 32, 407))
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as { x: number, y: number, z: number }
      if (pos.x === -761 && pos.z === 404) {
        if (pos.y === 39) {
          return { name: 'stone' }
        }
        if (pos.y === 40 || pos.y === 41) {
          return { name: 'air' }
        }
        if (pos.y >= 42 && pos.y <= 48) {
          return { name: 'air' }
        }
      }
      if (pos.x === -760 && pos.z === 404) {
        if (pos.y === 39) {
          return { name: 'stone' }
        }
        if (pos.y === 40 || pos.y === 41) {
          return { name: 'air' }
        }
      }
      return { name: 'stone' }
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.moveToHorizontalTarget)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(movementModule.moveToHorizontalTarget)).toHaveBeenCalledWith(bot, -761, 404)
    expect(vi.mocked(movementModule.goToPosition).mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledWith(bot, -761, 40, 404, 1)
    expect(vi.mocked(movementModule.moveAway)).toHaveBeenCalledWith(bot, 48)
    expect(result.message).toContain('Relocating toward cave exit before crafting starter tools')
  })

  it('crafts the starter pickaxe underground when the current inventory already makes it craftable', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')
    let craftedPickaxe = false

    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:forest',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'good',
      pickaxeAccess: 'craftable_from_inventory',
      position: { y: 65 },
      immediateTerrain: [
        'under:stone',
        'feet:air',
        'head:air',
        'north:stone',
        'south:stone',
        'east:stone',
        'west:stone',
      ],
    })

    vi.mocked(ensureModule.ensurePickaxe).mockImplementation(async () => {
      craftedPickaxe = true
      return true
    })
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      if (itemName === 'wooden_pickaxe') {
        return craftedPickaxe ? 1 : 0
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      if (itemName === 'wooden_pickaxe') {
        return craftedPickaxe ? 1 : 0
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(-382, 65, 149),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 16 }],
        },
        blockAt: vi.fn(() => ({ name: 'unknown' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Crafted pickaxe')
    expect(vi.mocked(ensureModule.ensurePickaxe)).toHaveBeenCalled()
    expect(vi.mocked(movementModule.goToPosition)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.moveAway)).not.toHaveBeenCalled()
  })

  it('ignores deep cave shafts that do not climb enough to count as a local surface exit', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.getPosition.mockReturnValue(new Vec3(-803, 17, 420))
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:dripstone_caves',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 17 },
      immediateTerrain: [
        'under:stone',
        'feet:air',
        'head:air',
        'north:air',
        'south:air',
        'east:air',
        'west:air',
      ],
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as { x: number, y: number, z: number }
      if (pos.x === -806 && pos.z === 417) {
        if (pos.y === 19) {
          return { name: 'stone' }
        }
        if (pos.y >= 20 && pos.y <= 38) {
          return { name: 'air' }
        }
      }
      return { name: 'stone' }
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(-803, 17, 420),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'unknown' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledWith(bot, -803, 63, 420, 2)
    expect(vi.mocked(movementModule.moveAway)).toHaveBeenCalled()
    expect(result.message).toContain('Relocating toward cave exit before crafting starter tools')
  })

  it('ignores shallow downward cave openings when they do not expose enough sky to justify dropping deeper', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.getPosition.mockReturnValue(new Vec3(-700, 40, 320))
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:dripstone_caves',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 40 },
      immediateTerrain: [
        'under:stone',
        'feet:air',
        'head:air',
        'north:air',
        'south:air',
        'east:air',
        'west:air',
      ],
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as { x: number, y: number, z: number }
      if (pos.x === -697 && pos.z === 320) {
        if (pos.y === 35) {
          return { name: 'stone' }
        }
        if (pos.y >= 36 && pos.y <= 44) {
          return { name: 'air' }
        }
      }
      return { name: 'stone' }
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(-700, 40, 320),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'unknown' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Relocating toward cave exit before crafting starter tools')
    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.goToPosition)).not.toHaveBeenCalledWith(bot, -697, 36, 320, 0.25)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledWith(bot, -700, 63, 320, 2)
  })

  it('ignores sky-exposed ledges that cannot be stepped onto from any adjacent block', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.getPosition.mockReturnValue(new Vec3(-683, 61, 442))
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:dripstone_caves',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'poor',
      position: { y: 61 },
      immediateTerrain: [
        'under:dripstone_block',
        'feet:air',
        'head:air',
        'north:air',
        'south:air',
        'east:air',
        'west:air',
      ],
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as { x: number, y: number, z: number }
      if (pos.x === -684 && pos.z === 442) {
        if (pos.y === 63) {
          return { name: 'dripstone_block' }
        }
        if (pos.y >= 64 && pos.y <= 82) {
          return { name: 'air' }
        }
      }
      return { name: 'dripstone_block' }
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(-683, 61, 442),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'unknown' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Relocating toward cave exit before crafting starter tools')
    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.moveToHorizontalTarget)).not.toHaveBeenCalledWith(bot, -684, 442)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledWith(bot, -683, 69, 442, 2)
    expect(vi.mocked(movementModule.moveAway)).toHaveBeenCalled()
  })

  it('surfaces a restart-required bridge block when starter tool crafting desyncs from inventory state', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(ensureModule.ensurePickaxe).mockResolvedValue(false)
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'stick',
      inventoryOnly: true,
      at: Date.now(),
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [
            { name: 'oak_log', count: 4 },
            { name: 'oak_planks', count: 4 },
          ],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(false)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Bridge capability blocked craft sync')
  })

  it('relocates to recover wood instead of failing immediately when starter pickaxe crafting fails', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const movementModule = await import('../skills/movement')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(ensureModule.ensurePickaxe).mockResolvedValue(false)
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue(null)
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:forest',
      skyAccess: 'open_sky',
      terrainContext: 'surface_forest',
      surfaceEscapeNeeded: false,
      woodAccess: 'good',
      pickaxeAccess: 'missing',
      position: { y: 64 },
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [
            { name: 'oak_log', count: 6 },
            { name: 'crafting_table', count: 1 },
          ],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Relocating to recover wood for pickaxe crafting')
    expect(vi.mocked(ensureModule.ensurePickaxe)).toHaveBeenCalledOnce()
    expect(vi.mocked(movementModule.moveAway)).toHaveBeenCalled()
  })

  it('continues into cobblestone gathering when a starter pickaxe only exists in optimistic inventory state', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table' || itemName === 'wooden_pickaxe' || itemName === 'pickaxe') {
        return 1
      }
      return 0
    })
    vi.mocked(ensureModule.ensurePickaxe).mockResolvedValue(true)
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'wooden_pickaxe',
      inventoryOnly: false,
      at: Date.now(),
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Mined cobblestone')
  })

  it('continues into cobblestone gathering when starter pickaxe recovery is only backed by the recent craft mismatch diagnostic', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(ensureModule.ensurePickaxe).mockResolvedValue(true)
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'wooden_pickaxe',
      inventoryOnly: false,
      at: Date.now(),
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Mined cobblestone')
  })

  it('stops cobblestone bootstrap once the stone tool kit is craftable', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table' || itemName === 'wooden_pickaxe') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table' || itemName === 'wooden_pickaxe') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        heldItem: { name: 'wooden_pickaxe', count: 1 },
        inventory: {
          items: () => [
            { name: 'oak_log', count: 2 },
            { name: 'crafting_table', count: 1 },
            { name: 'wooden_pickaxe', count: 1 },
          ],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Mined cobblestone')
    expect(vi.mocked(ensureModule.ensureCobblestone)).toHaveBeenCalledWith(bot, 16)
  })

  it('escapes for food recovery instead of mining starter cobblestone while injured without food', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const movementModule = await import('../skills/movement')

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table' || itemName === 'wooden_pickaxe') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table' || itemName === 'wooden_pickaxe' || itemName === 'pickaxe') {
        return 1
      }
      return 0
    })
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:dripstone_caves',
      skyAccess: 'enclosed',
      terrainContext: 'underground_cave',
      surfaceEscapeNeeded: true,
      woodAccess: 'good',
      pickaxeAccess: 'ready',
      position: { y: 57 },
      immediateTerrain: [
        'under:stone',
        'feet:air',
        'head:air',
        'north:stone',
        'south:stone',
        'east:stone',
        'west:stone',
      ],
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        health: 8,
        food: 14,
        entity: {
          position: new Vec3(0, 57, 0),
        },
        inventory: {
          items: () => [
            { name: 'oak_log', count: 2 },
            { name: 'crafting_table', count: 1 },
            { name: 'wooden_pickaxe', count: 1 },
          ],
        },
        blockAt: vi.fn(() => ({ name: 'stone' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toMatch(/food before stone mining|surface food/)
    expect(vi.mocked(ensureModule.ensureCobblestone)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalled()
  })

  it('continues from starter pickaxe sync recovery without re-crafting the wooden pickaxe', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 24
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table' || itemName === 'wooden_pickaxe' || itemName === 'pickaxe') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 24
      }
      return 0
    })
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'wooden_pickaxe',
      inventoryOnly: false,
      at: Date.now(),
    })
    vi.mocked(ensureModule.ensureStoneTierPickaxe).mockResolvedValue(true)

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(ensureModule.ensureStoneTierPickaxe)).toHaveBeenCalledOnce()
    expect(result.success).toBe(false)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Bridge capability blocked craft sync')
  })

  it('continues from optimistic starter pickaxe state even after the craft mismatch diagnostic is gone', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 24
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table' || itemName === 'wooden_pickaxe' || itemName === 'pickaxe') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 24
      }
      return 0
    })
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue(null)
    vi.mocked(ensureModule.ensureStoneTierPickaxe).mockResolvedValue(true)

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [{ name: 'oak_log', count: 4 }],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(vi.mocked(ensureModule.ensurePickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(ensureModule.ensureStoneTierPickaxe)).toHaveBeenCalledOnce()
    expect(result.success).toBe(false)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Could not craft stone pickaxe')
  })

  it('continues into stone-tool crafting when a stone pickaxe only exists in optimistic inventory state', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      if (itemName === 'wooden_pickaxe') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 24
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      if (itemName === 'wooden_pickaxe' || itemName === 'pickaxe') {
        return 1
      }
      if (itemName === 'stone_pickaxe') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 24
      }
      return 0
    })
    vi.mocked(ensureModule.ensureStoneTierPickaxe).mockResolvedValue(true)
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'stone_pickaxe',
      inventoryOnly: false,
      at: Date.now(),
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [
            { name: 'oak_log', count: 4 },
            { name: 'crafting_table', count: 1 },
            { name: 'wooden_pickaxe', count: 1 },
            { name: 'cobblestone', count: 16 },
          ],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(true)
    expect(result.message).toContain('Early game complete')
    expect(vi.mocked(ensureModule.ensureStoneTierPickaxe)).not.toHaveBeenCalled()
    expect(vi.mocked(ensureModule.ensureSword)).toHaveBeenCalledOnce()
  })

  it('surfaces an explicit Minecraft restart requirement when the running bridge build is stale', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      return 0
    })
    vi.mocked(ensureModule.ensurePickaxe).mockResolvedValue(false)
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'stick',
      inventoryOnly: true,
      at: Date.now(),
    })

    const bot = {
      getBridgeDebugState: vi.fn(() => ({
        bridgeVersion: '0.1.0',
        bridgeBuildTimestamp: '2026-03-02T01:07:27.865Z',
        staleInstalledBridgeBuild: true,
        pathfinder: {
          remoteMovementSupport: 'available',
          baritoneAvailability: 'available',
        },
      })),
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [
            { name: 'oak_log', count: 4 },
            { name: 'oak_planks', count: 4 },
          ],
        },
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Minecraft restart required')
  })

  it('continues climbing onto a nearby surface cue before reorienting away', async () => {
    const movementModule = await import('../skills/movement')

    mocks.buildWorldStateSnapshot
      .mockResolvedValueOnce({
        biome: 'minecraft:forest',
        skyAccess: 'enclosed',
        terrainContext: 'underground_cave',
        surfaceEscapeNeeded: true,
        immediateTerrain: [
          'head:stone',
          'north:stone',
          'south:stone',
          'east:stone',
          'west:stone',
          'feet:stone',
        ],
        position: { x: 0, y: 64, z: 0 },
      })
      .mockResolvedValueOnce({
        biome: 'minecraft:forest',
        skyAccess: 'enclosed',
        terrainContext: 'underground_cave',
        surfaceEscapeNeeded: true,
        immediateTerrain: [
          'head:stone',
          'north:stone',
          'south:stone',
          'east:stone',
          'west:stone',
          'feet:stone',
        ],
        position: { x: 6, y: 66, z: 0 },
      })
      .mockResolvedValueOnce({
        biome: 'minecraft:forest',
        skyAccess: 'open_sky',
        terrainContext: 'surface_forest',
        surfaceEscapeNeeded: false,
        immediateTerrain: [
          'head:air',
          'north:air',
          'south:air',
          'east:air',
          'west:air',
          'feet:grass_block',
        ],
        position: { x: 22, y: 64, z: 0 },
      })
    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([
      {
        name: 'grass_block',
        position: new Vec3(6, 64, 0),
      },
    ] as any)
    vi.mocked(movementModule.goToPosition)
      .mockImplementationOnce(async (_bot, x: number, _y: number, z: number) => {
        const nextPosition = new Vec3(x, 66, z)
        mocks.getPosition.mockReturnValue(nextPosition)
        if (_bot?.bot?.entity) {
          _bot.bot.entity.position = nextPosition
        }
        return true
      })
      .mockImplementationOnce(async (_bot, x: number, y: number, z: number) => {
        const nextPosition = new Vec3(x, y, z)
        mocks.getPosition.mockReturnValue(nextPosition)
        if (_bot?.bot?.entity) {
          _bot.bot.entity.position = nextPosition
        }
        return true
      })

    const bot = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [],
        },
      },
    } as any
    mocks.getPosition.mockReturnValue(new Vec3(0, 64, 0))

    const recovered = await recoverTowardSurface(bot, 'surface-stall')

    expect(recovered).toBe(true)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledWith(bot, 6, 64, 0, 4)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledWith(bot, 6, 65, 0, 1)
    expect(vi.mocked(movementModule.moveAway)).not.toHaveBeenCalled()
  })

  it('prefers immediate pillar recovery for near-surface shaft traps before cue scanning', async () => {
    const blocksModule = await import('../skills/blocks')
    const movementModule = await import('../skills/movement')
    const structuresModule = await import('../skills/structures')

    mocks.getInventoryCounts.mockReturnValue({ cobblestone: 8 })
    mocks.buildWorldStateSnapshot.mockImplementation(async (bot: any) => {
      const y = bot.bot.entity.position.y
      const surfaced = y >= 68
      return {
        biome: surfaced ? 'minecraft:forest' : 'minecraft:dripstone_caves',
        skyAccess: surfaced ? 'open_sky' : 'enclosed',
        terrainContext: surfaced ? 'surface_forest' : 'underground_cave',
        surfaceEscapeNeeded: !surfaced,
        immediateTerrain: surfaced
          ? [
              'head:air',
              'north:air',
              'south:air',
              'east:air',
              'west:air',
              'feet:grass_block',
            ]
          : [
              'head:stone',
              'north:stone',
              'south:stone',
              'east:stone',
              'west:stone',
              'feet:stone',
            ],
        position: { x: 0, y, z: 0 },
      }
    })
    mocks.getBlockAtAccurate.mockImplementation(async (...args: unknown[]) => {
      const pos = args[1] as { x: number, y: number, z: number }
      if (pos.x === 0 && pos.z === 0 && pos.y >= 65 && pos.y <= 66) {
        return { name: 'stone' }
      }
      return { name: 'stone' }
    })
    vi.mocked(structuresModule.pillarUp).mockImplementation(async (bot: any, _blockType: string, height: number) => {
      const nextPosition = bot.bot.entity.position.offset(0, height, 0)
      bot.bot.entity.position = nextPosition
      mocks.getPosition.mockReturnValue(nextPosition)
      return true
    })

    const bot = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [{ name: 'cobblestone', count: 8 }],
        },
      },
    } as any
    mocks.getPosition.mockReturnValue(new Vec3(0, 64, 0))

    const recovered = await recoverTowardSurface(bot, 'surface-stall')

    expect(recovered).toBe(true)
    expect(vi.mocked(blocksModule.breakBlockAt)).toHaveBeenCalledWith(bot, 0, 65, 0)
    expect(vi.mocked(blocksModule.breakBlockAt)).toHaveBeenCalledWith(bot, 0, 66, 0)
    expect(vi.mocked(structuresModule.pillarUp)).toHaveBeenCalledWith(bot, 'cobblestone', 1)
    expect(mocks.getNearestBlocksAccurate).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.goToPosition)).not.toHaveBeenCalled()
  })

  it('still reorients away when nearby surface cue ascent makes no vertical progress', async () => {
    const movementModule = await import('../skills/movement')

    mocks.buildWorldStateSnapshot
      .mockResolvedValueOnce({
        biome: 'minecraft:forest',
        skyAccess: 'enclosed',
        terrainContext: 'underground_cave',
        surfaceEscapeNeeded: true,
        immediateTerrain: [
          'head:stone',
          'north:stone',
          'south:stone',
          'east:stone',
          'west:stone',
          'feet:stone',
        ],
        position: { x: 0, y: 64, z: 0 },
      })
      .mockResolvedValueOnce({
        biome: 'minecraft:forest',
        skyAccess: 'enclosed',
        terrainContext: 'underground_cave',
        surfaceEscapeNeeded: true,
        immediateTerrain: [
          'head:stone',
          'north:stone',
          'south:stone',
          'east:stone',
          'west:stone',
          'feet:stone',
        ],
        position: { x: 6, y: 64, z: 0 },
      })
      .mockResolvedValueOnce({
        biome: 'minecraft:forest',
        skyAccess: 'open_sky',
        terrainContext: 'surface_forest',
        surfaceEscapeNeeded: false,
        immediateTerrain: [
          'head:air',
          'north:air',
          'south:air',
          'east:air',
          'west:air',
          'feet:grass_block',
        ],
        position: { x: 22, y: 64, z: 0 },
      })
    mocks.getNearestBlocksAccurate.mockResolvedValueOnce([
      {
        name: 'grass_block',
        position: new Vec3(6, 64, 0),
      },
    ] as any)
    vi.mocked(movementModule.goToPosition)
      .mockImplementationOnce(async (_bot, x: number, _y: number, z: number) => {
        const nextPosition = new Vec3(x, 64, z)
        mocks.getPosition.mockReturnValue(nextPosition)
        if (_bot?.bot?.entity) {
          _bot.bot.entity.position = nextPosition
        }
        return true
      })
      .mockImplementationOnce(async () => false)

    const bot = {
      bot: {
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [],
        },
      },
    } as any
    mocks.getPosition.mockReturnValue(new Vec3(0, 64, 0))

    const recovered = await recoverTowardSurface(bot, 'surface-stall')

    expect(recovered).toBe(true)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledWith(bot, 6, 64, 0, 4)
    expect(vi.mocked(movementModule.goToPosition)).toHaveBeenCalledWith(bot, 6, 65, 0, 1)
    expect(vi.mocked(movementModule.moveAway)).toHaveBeenCalledWith(bot, 16)
  })

  it('treats surface recovery as satisfied when the bot is already on surface terrain', async () => {
    const movementModule = await import('../skills/movement')
    mocks.buildWorldStateSnapshot.mockResolvedValueOnce({
      biome: 'minecraft:forest',
      skyAccess: 'open_sky',
      terrainContext: 'surface_forest',
      surfaceEscapeNeeded: false,
      immediateTerrain: [
        'head:air',
        'north:air',
        'south:short_grass',
        'east:grass_block',
        'west:dirt',
        'feet:grass_block',
      ],
      position: { x: 0, y: 68, z: 0 },
    })

    const bot = {
      bot: {
        entity: {
          position: new Vec3(0, 68, 0),
        },
        inventory: {
          items: () => [],
        },
      },
    } as any
    mocks.getPosition.mockReturnValue(new Vec3(0, 68, 0))

    const recovered = await recoverTowardSurface(bot, 'surface-recheck')

    expect(recovered).toBe(true)
    expect(vi.mocked(movementModule.goToPosition)).not.toHaveBeenCalled()
    expect(vi.mocked(movementModule.moveAway)).not.toHaveBeenCalled()
    expect(mocks.getNearestBlocksAccurate).not.toHaveBeenCalled()
  })

  it('keeps the runner in early game until the actual starter kit exists', async () => {
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.getInventoryCounts.mockReturnValue({
      cobblestone: 16,
      wooden_pickaxe: 1,
      stone_sword: 1,
      torch: 16,
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'cobblestone') {
        return 16
      }
      return 0
    })

    const bot = {
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
        inventory: {
          items: () => [],
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)

    expect(determinePhase(bot, state)).toBe(GamePhase.EARLY_GAME)
  })

  it('keeps the runner in early game when only a wooden pickaxe exists', async () => {
    const inventoryModule = await import('../skills/actions/inventory')

    mocks.getInventoryCounts.mockReturnValue({
      cobblestone: 16,
      wooden_pickaxe: 1,
      stone_sword: 1,
      torch: 16,
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'wooden_pickaxe') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 16
      }
      if (itemName === 'stone_sword') {
        return 1
      }
      if (itemName === 'torch') {
        return 16
      }
      return 0
    })

    const bot = {
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
        inventory: {
          items: () => [],
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)

    expect(determinePhase(bot, state)).toBe(GamePhase.EARLY_GAME)
  })

  it('stays in diamond mining until the diamond armor set is complete', async () => {
    const inventoryModule = await import('../skills/actions/inventory')

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'iron_pickaxe') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'diamond_pickaxe') {
        return 1
      }
      if (itemName === 'cooked_beef') {
        return 16
      }
      return 0
    })

    const bot = {
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
        inventory: {
          items: () => [
            { name: 'diamond_pickaxe', count: 1 },
            { name: 'cooked_beef', count: 16 },
          ],
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)

    expect(determinePhase(bot, state)).toBe(GamePhase.DIAMOND_MINING)
  })

  it('stays on eye crafting until it has extra eyes for triangulation when the stronghold is still unknown', async () => {
    mocks.getInventoryCounts.mockReturnValue({
      ender_eye: 12,
      blaze_powder: 2,
      ender_pearl: 2,
    })

    const bot = {
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
        inventory: {
          items: () => [],
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)

    expect(determinePhase(bot, state)).toBe(GamePhase.EYE_CRAFTING)
  })

  it('upgrades to a stone pickaxe before crafting the rest of the early-game kit', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    let hasStonePickaxe = false

    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'cobblestone') {
        return 24
      }
      return 0
    })
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      if (itemName === 'stone_pickaxe') {
        return hasStonePickaxe ? 1 : 0
      }
      if (itemName === 'wooden_pickaxe') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 24
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      if (itemName === 'stone_pickaxe') {
        return hasStonePickaxe ? 1 : 0
      }
      if (itemName === 'wooden_pickaxe') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 24
      }
      return 0
    })
    vi.mocked(ensureModule.ensureStoneTierPickaxe).mockImplementation(async () => {
      hasStonePickaxe = true
      return true
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [
            { name: 'oak_log', count: 2 },
            { name: 'crafting_table', count: 1 },
            { name: 'wooden_pickaxe', count: 1 },
            { name: 'cobblestone', count: 16 },
          ],
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('Crafted stone pickaxe')
    expect(vi.mocked(ensureModule.ensureStoneTierPickaxe)).toHaveBeenCalledOnce()
    expect(vi.mocked(ensureModule.ensureSword)).not.toHaveBeenCalled()
  })

  it('advances early game even when torch crafting is temporarily unavailable', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(ensureModule.ensureTorches).mockResolvedValue(false)
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue(null)
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'stone_pickaxe') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 16
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'crafting_table') {
        return 1
      }
      if (itemName === 'stone_pickaxe') {
        return 1
      }
      if (itemName === 'cobblestone') {
        return 16
      }
      if (itemName === 'stone_sword' || itemName === 'stone_axe') {
        return 1
      }
      if (itemName === 'furnace') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [
            { name: 'oak_log', count: 4 },
            { name: 'crafting_table', count: 1 },
            { name: 'stone_pickaxe', count: 1 },
            { name: 'cobblestone', count: 16 },
            { name: 'stone_sword', count: 1 },
            { name: 'stone_axe', count: 1 },
            { name: 'furnace', count: 1 },
          ],
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.EARLY_GAME)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(true)
    expect(result.message).toContain('Early game complete')
    expect(vi.mocked(ensureModule.ensureTorches)).toHaveBeenCalledWith(bot, 16)
  })

  it('continues iron-age progression when torch crafting fails due to missing fuel', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(ensureModule.ensureTorches).mockResolvedValue(false)
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue(null)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:forest',
      skyAccess: 'open_sky',
      terrainContext: 'surface_forest',
      surfaceEscapeNeeded: false,
      woodAccess: 'good',
      position: { y: 64 },
      immediateTerrain: [
        'under:grass_block',
        'feet:air',
        'head:air',
        'north:air',
        'south:air',
        'east:air',
        'west:air',
      ],
    })
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'stone_pickaxe' || itemName === 'stone_sword') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'coal') {
        return 16
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [
            { name: 'stone_pickaxe', count: 1 },
            { name: 'stone_sword', count: 1 },
            { name: 'coal', count: 16 },
          ],
        },
        blockAt: vi.fn(() => ({ name: 'stone' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.IRON_AGE)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.message).not.toContain('Could not prepare torches')
    expect(vi.mocked(ensureModule.ensureTorches)).toHaveBeenCalledWith(bot, 16)
  })

  it('treats charcoal as valid smelting fuel during iron age', async () => {
    const ensureModule = await import('../skills/actions/ensure')
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue(null)
    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:forest',
      skyAccess: 'open_sky',
      terrainContext: 'surface_forest',
      surfaceEscapeNeeded: false,
      woodAccess: 'good',
      position: { y: 64 },
      immediateTerrain: [
        'under:grass_block',
        'feet:air',
        'head:air',
        'north:air',
        'south:air',
        'east:air',
        'west:air',
      ],
    })
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'stone_pickaxe' || itemName === 'stone_sword') {
        return 1
      }
      if (itemName === 'torch') {
        return 8
      }
      return 0
    })
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'coal') {
        return 0
      }
      if (itemName === 'charcoal') {
        return 16
      }
      if (itemName === 'iron_ingot') {
        return 24
      }
      if (itemName === 'furnace') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 64, 0),
        },
        inventory: {
          items: () => [
            { name: 'stone_pickaxe', count: 1 },
            { name: 'stone_sword', count: 1 },
            { name: 'charcoal', count: 16 },
            { name: 'furnace', count: 1 },
          ],
        },
        blockAt: vi.fn(() => ({ name: 'stone' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.IRON_AGE)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(vi.mocked(ensureModule.ensureCoal)).not.toHaveBeenCalled()
  })

  it('escapes underground during iron age until it has a safer mining kit', async () => {
    const movementModule = await import('../skills/movement')
    const inventoryModule = await import('../skills/actions/inventory')
    const collectBlockModule = await import('../skills/actions/collect-block')

    mocks.buildWorldStateSnapshot.mockResolvedValue({
      biome: 'minecraft:plains',
      terrainContext: 'underground_cave',
      skyAccess: 'enclosed',
      surfaceEscapeNeeded: true,
      woodAccess: 'good',
      position: { y: 37 },
      immediateTerrain: [
        'under:stone',
        'feet:air',
        'head:air',
        'north:air',
        'south:air',
        'east:air',
        'west:air',
      ],
    })

    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'stone_pickaxe') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 37, 0),
        },
        inventory: {
          items: () => [],
        },
        blockAt: vi.fn(() => ({ name: 'stone' })),
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.IRON_AGE)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('before mining')
    expect(vi.mocked(movementModule.moveAway)).toHaveBeenCalled()
    expect(vi.mocked(collectBlockModule.collectBlock)).not.toHaveBeenCalled()
  })

  it('crafts diamond armor before leaving diamond mining', async () => {
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    mocks.getPosition.mockReturnValue(new Vec3(0, 12, 0))
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'diamond') {
        return 8
      }
      if (itemName === 'diamond_pickaxe') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'diamond_pickaxe') {
        return 1
      }
      return 0
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 12, 0),
        },
        inventory: {
          items: () => [{ name: 'diamond_pickaxe', count: 1 }, { name: 'diamond', count: 8 }],
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.DIAMOND_MINING)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('diamond chestplate')
    expect(vi.mocked(craftingModule.craftRecipe)).toHaveBeenCalledWith(bot, 'diamond_chestplate', 1)
  })

  it('waits for actual diamond armor confirmation before reporting the craft as complete', async () => {
    const inventoryModule = await import('../skills/actions/inventory')
    const craftingModule = await import('../skills/crafting')

    mocks.getPosition.mockReturnValue(new Vec3(0, 12, 0))
    vi.mocked(inventoryModule.getItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'diamond') {
        return 8
      }
      if (itemName === 'diamond_pickaxe') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.getActualItemCount).mockImplementation((_bot, itemName) => {
      if (itemName === 'diamond_pickaxe') {
        return 1
      }
      return 0
    })
    vi.mocked(inventoryModule.confirmItemCount).mockResolvedValue(false)
    vi.mocked(craftingModule.getLastCraftRecipeDiagnostic).mockReturnValue({
      kind: 'inventory_sync_mismatch',
      itemName: 'diamond_chestplate',
      inventoryOnly: false,
      at: Date.now(),
    })

    const bot = {
      bot: {
        chat: vi.fn(),
        entity: {
          position: new Vec3(0, 12, 0),
        },
        inventory: {
          items: () => [{ name: 'diamond_pickaxe', count: 1 }, { name: 'diamond', count: 8 }],
        },
      },
    } as any

    const state = new GameStateManager(`test-${Date.now()}`)
    state.setPhase(GamePhase.DIAMOND_MINING)

    const result = await executePhase(bot, state)

    expect(result.success).toBe(true)
    expect(result.advance).toBe(false)
    expect(result.message).toContain('waiting for inventory sync')
  })
})
