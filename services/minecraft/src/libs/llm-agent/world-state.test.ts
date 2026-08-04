import { Vec3 } from 'vec3'
import { describe, expect, it, vi } from 'vitest'

import { buildWorldStateSnapshot, formatWorldStateSnapshot, refreshWorldStateCaches } from './world-state'

function createBlockMap(entries: Array<[string, { name: string, position: Vec3 }]>) {
  return new Map(entries)
}

function keyOf(position: Vec3) {
  return `${position.x}:${position.y}:${position.z}`
}

describe('world state environment classification', () => {
  it('refreshes inventory alongside world caches when the bridge is ready', async () => {
    const refreshInventory = vi.fn(async () => {})
    const refreshEntities = vi.fn(async () => {})
    const scanNearbyBlocks = vi.fn(async () => {})

    const bot = {
      health: 20,
      bot: {
        refreshInventory,
        refreshEntities,
        scanNearbyBlocks,
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 64, 0) },
        entities: {},
        players: {},
        health: 20,
        food: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 9 }),
          items: () => [],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:plains'),
        },
        findBlocks: vi.fn(() => []),
        blockAt: vi.fn(() => null),
      },
    } as any

    await refreshWorldStateCaches(bot)

    expect(refreshInventory).toHaveBeenCalledOnce()
    expect(refreshEntities).toHaveBeenCalledOnce()
    expect(scanNearbyBlocks).toHaveBeenCalledOnce()
  })

  it('returns a safe placeholder snapshot before the bridge is ready', async () => {
    const scanNearbyBlocks = vi.fn(async () => {})
    const refreshEntities = vi.fn(async () => {})
    const worldGetBiome = vi.fn(async () => 'minecraft:plains')
    const findBlocks = vi.fn(() => [])
    const blockAt = vi.fn(() => null)

    const bot = {
      health: 20,
      getBridgeDebugState: vi.fn(() => ({
        connected: true,
        ready: false,
      })),
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(12, 64, -8) },
        entities: {},
        players: {},
        health: 20,
        food: 18,
        oxygenLevel: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 9 }),
          items: () => [],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: worldGetBiome,
        },
        findBlocks,
        blockAt,
        refreshEntities,
        scanNearbyBlocks,
      },
    } as any

    await refreshWorldStateCaches(bot)
    const snapshot = await buildWorldStateSnapshot(bot)

    expect(snapshot.terrainContext).toBe('awaiting_world')
    expect(snapshot.skyAccess).toBe('unknown')
    expect(snapshot.biome).toBe('unknown')
    expect(snapshot.nearbyBlocks).toEqual([])
    expect(snapshot.immediateTerrain).toContain('under:unknown')
    expect(refreshEntities).not.toHaveBeenCalled()
    expect(scanNearbyBlocks).not.toHaveBeenCalled()
    expect(worldGetBiome).not.toHaveBeenCalled()
    expect(findBlocks).not.toHaveBeenCalled()
    expect(blockAt).not.toHaveBeenCalled()
  })

  it('classifies enclosed stone surroundings as underground cave with poor wood access', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 29, 0)), { name: 'stone', position: new Vec3(0, 29, 0) }],
      [keyOf(new Vec3(0, 30, 0)), { name: 'air', position: new Vec3(0, 30, 0) }],
      [keyOf(new Vec3(0, 31, 0)), { name: 'cave_air', position: new Vec3(0, 31, 0) }],
      [keyOf(new Vec3(0, 32, 0)), { name: 'stone', position: new Vec3(0, 32, 0) }],
      [keyOf(new Vec3(1, 30, 0)), { name: 'stone', position: new Vec3(1, 30, 0) }],
      [keyOf(new Vec3(-1, 30, 0)), { name: 'stone', position: new Vec3(-1, 30, 0) }],
      [keyOf(new Vec3(0, 30, 1)), { name: 'stone', position: new Vec3(0, 30, 1) }],
      [keyOf(new Vec3(0, 30, -1)), { name: 'stone', position: new Vec3(0, 30, -1) }],
      [keyOf(new Vec3(2, 30, 2)), { name: 'deepslate_iron_ore', position: new Vec3(2, 30, 2) }],
    ])

    const bot = {
      health: 20,
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 30, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 9 }),
          items: () => [],
        },
        time: { timeOfDay: 18_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:lush_caves'),
        },
        findBlocks: vi.fn(() => [new Vec3(2, 30, 2)]),
        blockAt: vi.fn((position: Vec3) => blockMap.get(keyOf(position)) ?? { name: 'stone', position }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)
    const prompt = formatWorldStateSnapshot(snapshot)

    expect(snapshot.terrainContext).toBe('underground_cave')
    expect(snapshot.woodAccess).toBe('poor')
    expect(snapshot.pickaxeAccess).toBe('missing')
    expect(snapshot.surfaceEscapeNeeded).toBe(true)
    expect(snapshot.mobilityState).toBe('shaft_trap')
    expect(snapshot.surfaceEscapeScaffold).toBe('none')
    expect(prompt).toContain('terrain_context: underground_cave')
    expect(prompt).toContain('wood_access: poor')
    expect(prompt).toContain('mobility_state: shaft_trap')
  })

  it('surfaces scaffold availability when an enclosed shaft still has disposable blocks', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 29, 0)), { name: 'stone', position: new Vec3(0, 29, 0) }],
      [keyOf(new Vec3(0, 30, 0)), { name: 'air', position: new Vec3(0, 30, 0) }],
      [keyOf(new Vec3(0, 31, 0)), { name: 'stone', position: new Vec3(0, 31, 0) }],
      [keyOf(new Vec3(1, 30, 0)), { name: 'stone', position: new Vec3(1, 30, 0) }],
      [keyOf(new Vec3(-1, 30, 0)), { name: 'stone', position: new Vec3(-1, 30, 0) }],
      [keyOf(new Vec3(0, 30, 1)), { name: 'stone', position: new Vec3(0, 30, 1) }],
      [keyOf(new Vec3(0, 30, -1)), { name: 'stone', position: new Vec3(0, 30, -1) }],
    ])

    const bot = {
      health: 20,
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 30, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: { name: 'stone_pickaxe', count: 1 },
        inventory: {
          slots: Array.from({ length: 46 }),
          items: () => [
            { name: 'stone_pickaxe', count: 1, slot: 36 },
            { name: 'cobblestone', count: 64, slot: 12 },
            { name: 'birch_log', count: 5, slot: 13 },
          ],
        },
        time: { timeOfDay: 18_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:lush_caves'),
        },
        findBlocks: vi.fn(() => []),
        blockAt: vi.fn((position: Vec3) => blockMap.get(keyOf(position)) ?? { name: 'stone', position }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)
    const prompt = formatWorldStateSnapshot(snapshot)

    expect(snapshot.mobilityState).toBe('shaft_trap')
    expect(snapshot.surfaceEscapeScaffold).toBe('ready:cobblestone x64')
    expect(prompt).toContain('surface_escape_scaffold: ready:cobblestone x64')
  })

  it('treats an auto-equipped crafted pickaxe as available even before inventory items catch up', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 64, 0)), { name: 'stone', position: new Vec3(0, 64, 0) }],
      [keyOf(new Vec3(0, 65, 0)), { name: 'air', position: new Vec3(0, 65, 0) }],
      [keyOf(new Vec3(0, 66, 0)), { name: 'air', position: new Vec3(0, 66, 0) }],
    ])

    const bot = {
      health: 20,
      getLastCraftRecipeDiagnostic: vi.fn(() => ({
        at: Date.now(),
        kind: 'inventory_sync_mismatch',
        itemName: 'wooden_pickaxe',
      })),
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 65, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: { name: 'wooden_pickaxe', count: 1 },
        inventory: {
          slots: Array.from({ length: 46 }),
          items: () => [
            { name: 'oak_planks', count: 8 },
            { name: 'stick', count: 2 },
          ],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:forest'),
        },
        findBlocks: vi.fn(() => []),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 67) {
            return null
          }
          return blockMap.get(keyOf(position)) ?? { name: 'stone', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)

    expect(snapshot.pickaxeAccess).toBe('available')
    expect(snapshot.heldItem).toContain('wooden_pickaxe')
  })

  it('emits compact slot-aware inventory facts for planner prompts', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 64, 0)), { name: 'stone', position: new Vec3(0, 64, 0) }],
      [keyOf(new Vec3(0, 65, 0)), { name: 'air', position: new Vec3(0, 65, 0) }],
      [keyOf(new Vec3(0, 66, 0)), { name: 'air', position: new Vec3(0, 66, 0) }],
    ])

    const bot = {
      health: 20,
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 65, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: { name: 'stone_pickaxe', count: 1 },
        inventory: {
          selectedSlot: 5,
          slots: Array.from({ length: 46 }),
          items: () => [
            { name: 'stone_pickaxe', count: 1, slot: 41, durability: 20, maxDurability: 131 },
            { name: 'iron_pickaxe', count: 1, slot: 12, durability: 200, maxDurability: 250 },
            { name: 'bread', count: 4, slot: 20 },
            { name: 'torch', count: 8, slot: 21 },
            { name: 'dirt', count: 32, slot: 36 },
          ],
          emptySlotCount: () => 2,
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:forest'),
        },
        findBlocks: vi.fn(() => []),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 67) {
            return null
          }
          return blockMap.get(keyOf(position)) ?? { name: 'stone', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot, 'mine stone')
    const prompt = formatWorldStateSnapshot(snapshot)

    expect(snapshot.inventoryFacts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('inventory_selected_slot: 6'),
        expect.stringContaining('inventory_task_readiness: mine=inventory_needs_move:iron_pickaxe@main#4'),
      ]),
    )
    expect(snapshot.progressionFacts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('progress_milestone:'),
        expect.stringContaining('progress_needs:'),
        expect.stringContaining('progress_capabilities:'),
      ]),
    )
    expect(prompt).toContain('inventory_hotbar:')
    expect(prompt).toContain('inventory_desync:')
    expect(prompt).toContain('progress_milestone:')
    expect(prompt).toContain('progress_next_goals:')
  })

  it('emits bridge capability facts so planners can avoid unsupported commands', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 64, 0)), { name: 'stone', position: new Vec3(0, 64, 0) }],
      [keyOf(new Vec3(0, 65, 0)), { name: 'air', position: new Vec3(0, 65, 0) }],
      [keyOf(new Vec3(0, 66, 0)), { name: 'air', position: new Vec3(0, 66, 0) }],
    ])

    const bot = {
      health: 20,
      getBridgeDebugState: vi.fn(() => ({
        connected: true,
        ready: true,
        capabilitySnapshot: {
          capabilityHash: 'cap:test',
          supportedCommands: ['selectHotbarSlot'],
          unsupportedCommands: ['swapInventorySlots'],
        },
      })),
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 65, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: { name: 'stone_pickaxe', count: 1 },
        inventory: {
          selectedSlot: 0,
          slots: Array.from({ length: 46 }),
          items: () => [{ name: 'stone_pickaxe', count: 1, slot: 36 }],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:forest'),
        },
        findBlocks: vi.fn(() => []),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 67) {
            return null
          }
          return blockMap.get(keyOf(position)) ?? { name: 'stone', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot, 'mine stone')
    const prompt = formatWorldStateSnapshot(snapshot)

    expect(snapshot.bridgeFacts).toEqual(expect.arrayContaining([
      expect.stringContaining('bridge_capabilities: unsupported=swapInventorySlots; supported=selectHotbarSlot; hash=cap:test'),
    ]))
    expect(prompt).toContain('bridge_capabilities: unsupported=swapInventorySlots; supported=selectHotbarSlot; hash=cap:test')
  })

  it('emits base and interior status facts for long-run planning prompts', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 64, 0)), { name: 'oak_planks', position: new Vec3(0, 64, 0) }],
      [keyOf(new Vec3(0, 65, 0)), { name: 'air', position: new Vec3(0, 65, 0) }],
      [keyOf(new Vec3(0, 66, 0)), { name: 'air', position: new Vec3(0, 66, 0) }],
      [keyOf(new Vec3(2, 65, 1)), { name: 'crafting_table', position: new Vec3(2, 65, 1) }],
      [keyOf(new Vec3(3, 65, 1)), { name: 'furnace', position: new Vec3(3, 65, 1) }],
      [keyOf(new Vec3(1, 65, 2)), { name: 'chest', position: new Vec3(1, 65, 2) }],
    ])

    const bot = {
      health: 20,
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 65, 0) },
        entities: {},
        players: {},
        health: 20,
        food: 18,
        heldItem: { name: 'iron_pickaxe', count: 1 },
        inventory: {
          selectedSlot: 0,
          slots: Array.from({ length: 46 }),
          items: () => [
            { name: 'iron_pickaxe', count: 1, slot: 36 },
            { name: 'red_bed', count: 1, slot: 12 },
            { name: 'chest', count: 1, slot: 13 },
            { name: 'torch', count: 10, slot: 14 },
            { name: 'bread', count: 8, slot: 15 },
          ],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:plains'),
        },
        findBlocks: vi.fn(() => [new Vec3(2, 65, 1), new Vec3(3, 65, 1), new Vec3(1, 65, 2)]),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 67) {
            return null
          }
          return blockMap.get(keyOf(position)) ?? { name: 'oak_planks', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot, 'return home')
    const prompt = formatWorldStateSnapshot(snapshot)

    expect(snapshot.baseFacts).toEqual(expect.arrayContaining([
      expect.stringContaining('base_status:'),
      expect.stringContaining('interior_status:'),
    ]))
    expect(prompt).toContain('base_status:')
    expect(prompt).toContain('interior_status:')
  })

  it('prefers strict raw inventory over tracked inventory for tool bootstrap hints', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 64, 0)), { name: 'stone', position: new Vec3(0, 64, 0) }],
      [keyOf(new Vec3(0, 65, 0)), { name: 'air', position: new Vec3(0, 65, 0) }],
      [keyOf(new Vec3(0, 66, 0)), { name: 'air', position: new Vec3(0, 66, 0) }],
    ])

    const bot = {
      health: 20,
      bot: {
        getStrictRawInventoryItems: vi.fn(() => [
          { name: 'minecraft:cobblestone', count: 3 },
        ]),
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 65, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 46 }),
          items: () => [
            { name: 'oak_planks', count: 8 },
            { name: 'stick', count: 4 },
            { name: 'crafting_table', count: 1 },
          ],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:forest'),
        },
        findBlocks: vi.fn(() => []),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 67) {
            return null
          }
          return blockMap.get(keyOf(position)) ?? { name: 'stone', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)

    expect(snapshot.pickaxeAccess).toBe('missing')
    expect(snapshot.woodMaterials).toBe('logs=0, planks=0, sticks=0')
    expect(snapshot.inventorySummary).toContain('cobblestone x3')
    expect(snapshot.inventorySummary).not.toContain('oak_planks x8')
    expect(snapshot.inventorySummary).not.toContain('stick x4')
  })

  it('falls back to tracked inventory when strict raw inventory is transiently empty', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 64, 0)), { name: 'stone', position: new Vec3(0, 64, 0) }],
      [keyOf(new Vec3(0, 65, 0)), { name: 'air', position: new Vec3(0, 65, 0) }],
      [keyOf(new Vec3(0, 66, 0)), { name: 'air', position: new Vec3(0, 66, 0) }],
    ])

    const bot = {
      health: 20,
      bot: {
        getStrictRawInventoryItems: vi.fn(() => []),
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 65, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 46 }),
          items: () => [
            { name: 'oak_planks', count: 8 },
            { name: 'stick', count: 4 },
            { name: 'crafting_table', count: 1 },
          ],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:forest'),
        },
        findBlocks: vi.fn(() => []),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 67) {
            return null
          }
          return blockMap.get(keyOf(position)) ?? { name: 'stone', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)

    expect(snapshot.pickaxeAccess).toBe('craftable_from_inventory')
    expect(snapshot.woodMaterials).toBe('logs=0, planks=8, sticks=4')
    expect(snapshot.inventorySummary).toContain('oak_planks x8')
    expect(snapshot.inventorySummary).toContain('stick x4')
  })

  it('classifies open desert surface as surface_desert with poor wood access', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 69, 0)), { name: 'sand', position: new Vec3(0, 69, 0) }],
      [keyOf(new Vec3(0, 70, 0)), { name: 'air', position: new Vec3(0, 70, 0) }],
    ])

    const bot = {
      health: 20,
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 70, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 9 }),
          items: () => [],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:desert'),
        },
        findBlocks: vi.fn(() => [new Vec3(0, 69, 0)]),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 72) {
            return { name: 'air', position }
          }
          return blockMap.get(keyOf(position)) ?? { name: 'air', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)

    expect(snapshot.skyAccess).toBe('open_sky')
    expect(snapshot.terrainContext).toBe('surface_desert')
    expect(snapshot.woodAccess).toBe('poor')
    expect(snapshot.surfaceEscapeNeeded).toBe(false)
  })

  it('does not treat unknown overhead blocks as open sky', async () => {
    const bot = {
      health: 20,
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 53, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 9 }),
          items: () => [],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:ocean'),
        },
        findBlocks: vi.fn(() => []),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y === 52) {
            return { name: 'gravel', position }
          }
          if (position.y === 53 || position.y === 54) {
            return { name: 'water', position }
          }
          return null
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)

    expect(snapshot.skyAccess).toBe('enclosed')
    expect(snapshot.terrainContext).toBe('underground_cave')
    expect(snapshot.surfaceEscapeNeeded).toBe(true)
  })

  it('keeps forest ground with nearby logs on the surface even when overhead blocks are unknown', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 62, 0)), { name: 'grass_block', position: new Vec3(0, 62, 0) }],
      [keyOf(new Vec3(0, 63, 0)), { name: 'air', position: new Vec3(0, 63, 0) }],
      [keyOf(new Vec3(0, 64, 0)), { name: 'air', position: new Vec3(0, 64, 0) }],
      [keyOf(new Vec3(1, 63, 0)), { name: 'oak_log', position: new Vec3(1, 63, 0) }],
    ])

    const bot = {
      health: 20,
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 63, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 9 }),
          items: () => [],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:forest'),
        },
        findBlocks: vi.fn(() => [new Vec3(1, 63, 0)]),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 65) {
            return null
          }
          return blockMap.get(keyOf(position)) ?? { name: 'air', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)

    expect(snapshot.skyAccess).toBe('enclosed')
    expect(snapshot.terrainContext).toBe('surface_forest')
    expect(snapshot.surfaceEscapeNeeded).toBe(false)
    expect(snapshot.woodAccess).toBe('good')
  })

  it('keeps forest ground on the surface even when nearby stone and ore are visible', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 66, 0)), { name: 'grass_block', position: new Vec3(0, 66, 0) }],
      [keyOf(new Vec3(0, 67, 0)), { name: 'air', position: new Vec3(0, 67, 0) }],
      [keyOf(new Vec3(0, 68, 0)), { name: 'air', position: new Vec3(0, 68, 0) }],
      [keyOf(new Vec3(1, 67, 0)), { name: 'oak_log', position: new Vec3(1, 67, 0) }],
      [keyOf(new Vec3(3, 66, 0)), { name: 'cobblestone', position: new Vec3(3, 66, 0) }],
      [keyOf(new Vec3(4, 65, 0)), { name: 'iron_ore', position: new Vec3(4, 65, 0) }],
    ])

    const bot = {
      health: 20,
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 67, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 9 }),
          items: () => [],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:forest'),
        },
        findBlocks: vi.fn(() => [new Vec3(1, 67, 0), new Vec3(3, 66, 0), new Vec3(4, 65, 0)]),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 69) {
            return null
          }
          return blockMap.get(keyOf(position)) ?? { name: 'air', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)

    expect(snapshot.skyAccess).toBe('enclosed')
    expect(snapshot.terrainContext).toBe('surface_forest')
    expect(snapshot.surfaceEscapeNeeded).toBe(false)
  })

  it('does not classify open plains with only under-stone and nearby logs as underground', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 70, 0)), { name: 'stone', position: new Vec3(0, 70, 0) }],
      [keyOf(new Vec3(1, 71, 0)), { name: 'oak_log', position: new Vec3(1, 71, 0) }],
    ])

    const bot = {
      health: 20,
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 71, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 9 }),
          items: () => [],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:plains'),
        },
        findBlocks: vi.fn(() => [new Vec3(1, 71, 0)]),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 72) {
            return null
          }
          return blockMap.get(keyOf(position)) ?? { name: 'air', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)

    expect(snapshot.skyAccess).toBe('enclosed')
    expect(snapshot.terrainContext).toBe('surface_open_land')
    expect(snapshot.surfaceEscapeNeeded).toBe(false)
    expect(snapshot.woodAccess).toBe('good')
  })

  it('does not classify high plains with a single stone wall and nearby wood as underground', async () => {
    const blockMap = createBlockMap([
      [keyOf(new Vec3(0, 72, 0)), { name: 'grass_block', position: new Vec3(0, 72, 0) }],
      [keyOf(new Vec3(1, 73, 0)), { name: 'stone', position: new Vec3(1, 73, 0) }],
      [keyOf(new Vec3(-1, 73, 0)), { name: 'oak_log', position: new Vec3(-1, 73, 0) }],
    ])

    const bot = {
      health: 20,
      bot: {
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 73, 0) },
        entities: {},
        players: {},
        health: 20,
        heldItem: null,
        inventory: {
          slots: Array.from({ length: 9 }),
          items: () => [],
        },
        time: { timeOfDay: 6_000 },
        isRaining: false,
        thunderState: false,
        world: {
          getBiome: vi.fn(async () => 'minecraft:plains'),
        },
        findBlocks: vi.fn(() => [new Vec3(-1, 73, 0)]),
        blockAt: vi.fn((position: Vec3) => {
          if (position.y >= 74) {
            return null
          }
          return blockMap.get(keyOf(position)) ?? { name: 'air', position }
        }),
      },
    } as any

    const snapshot = await buildWorldStateSnapshot(bot)

    expect(snapshot.terrainContext).toBe('surface_open_land')
    expect(snapshot.surfaceEscapeNeeded).toBe(false)
    expect(snapshot.woodAccess).toBe('good')
  })
})
