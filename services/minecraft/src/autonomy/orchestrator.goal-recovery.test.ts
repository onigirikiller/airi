import { describe, expect, it, vi } from 'vitest'

import { AutonomousStreamOrchestrator } from './orchestrator'

vi.mock('../libs/llm-agent/output', () => ({
  publishAssistantMessageToAiri: vi.fn(),
}))

function createOrchestrator() {
  const bot = {
    username: 'AIra',
    ready: true,
    bot: {
      on: vi.fn(),
      off: vi.fn(),
      chat: vi.fn(),
      players: {},
      inventory: {
        items: () => [],
      },
      entity: {
        position: { x: 0, y: 64, z: 0 },
      },
      time: {
        timeOfDay: 6000,
      },
    },
    memory: {
      actions: [],
      chatHistory: [],
    },
    status: {
      toOneLiner: () => 'ok',
    },
  } as any

  const airiClient = {
    onEvent: vi.fn(),
    offEvent: vi.fn(),
    send: vi.fn(),
  } as any

  return new AutonomousStreamOrchestrator(bot, airiClient)
}

describe('autonomous stream orchestrator goal gating', () => {
  it('blocks repeated wood-bootstrap failure families instead of inventing a replacement goal', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.recentGoalFailures = [
      { goalKey: 'explore nearby terrain for useful resources', family: 'wood-bootstrap', at: now - 15_000 },
      { goalKey: 'improve safety around current base area', family: 'wood-bootstrap', at: now - 5_000 },
    ]

    const resolved = orchestrator.resolveExecutableGoal('Improve safety around current base area', 'test', now)

    expect(resolved).toBeNull()
    expect(orchestrator.signalBuffer.at(-1)?.text).toContain('goal-blocked:Improve safety around current base area')
  })

  it('rewrites underground bootstrap dead-ends into an explicit surface recovery goal', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.lastWorldState = [
      'dimension: overworld',
      'terrain_context: underground_cave',
      'wood_access: poor',
      'pickaxe_access: missing',
      'surface_escape_needed: true',
    ].join('\n')

    const resolved = orchestrator.resolveExecutableGoal('Explore nearby terrain for useful resources', 'test', now)

    expect(resolved).toEqual({
      goal: 'Escape to the surface to gather wood',
      reason: expect.stringContaining('goal-replaced: underground cave with poor wood access and missing mining bootstrap requires surfacing first'),
    })
  })

  it('keeps direct surface recovery goals executable instead of blocking them again', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.lastWorldState = [
      'dimension: overworld',
      'terrain_context: underground_cave',
      'wood_access: poor',
      'pickaxe_access: missing',
      'surface_escape_needed: true',
    ].join('\n')

    const resolved = orchestrator.resolveExecutableGoal('Dig upwards to reach the surface', 'test', now)

    expect(resolved).toEqual({
      goal: 'Dig upwards to reach the surface',
      reason: 'test',
    })
  })

  it('keeps surface recovery executable even when wood-bootstrap failures already accumulated', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.lastWorldState = [
      'dimension: overworld',
      'terrain_context: underground_cave',
      'wood_access: poor',
      'pickaxe_access: missing',
      'surface_escape_needed: true',
    ].join('\n')
    orchestrator.recentGoalFailures = [
      { goalKey: 'escape to the surface to gather wood', goalFamily: 'wood-bootstrap', family: 'wood-bootstrap', at: now - 15_000 },
      { goalKey: 'escape to the surface to gather wood', goalFamily: 'wood-bootstrap', family: 'wood-bootstrap', at: now - 5_000 },
    ]

    const resolved = orchestrator.resolveExecutableGoal('Smelt the raw iron using the furnace', 'test', now)

    expect(resolved).toEqual({
      goal: 'Escape to the surface to gather wood',
      reason: expect.stringContaining('goal-replaced: underground cave with poor wood access and missing mining bootstrap requires surfacing first'),
    })
  })

  it('does not force another surface-recovery rewrite when local wood bootstrap is already available', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.lastWorldState = [
      'dimension: overworld',
      'terrain_context: underground_cave',
      'wood_access: poor',
      'pickaxe_access: missing',
      'surface_escape_needed: true',
    ].join('\n')
    orchestrator.bot.bot.inventory.items = () => [
      { name: 'oak_log', count: 82 },
      { name: 'crafting_table', count: 1 },
    ]

    const resolved = orchestrator.resolveExecutableGoal('Explore nearby terrain for useful resources', 'test', now)

    expect(resolved).toEqual({
      goal: 'Explore nearby terrain for useful resources',
      reason: 'test',
    })
  })

  it('blocks immediate reselection of the same repeatedly failing goal', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.recentGoalFailures = [
      { goalKey: 'improve safety around current base area', family: 'generic', at: now - 20_000 },
      { goalKey: 'improve safety around current base area', family: 'generic', at: now - 5_000 },
    ]

    const resolved = orchestrator.resolveExecutableGoal('Improve safety around current base area', 'test', now)

    expect(resolved).toBeNull()
    expect(orchestrator.signalBuffer.at(-1)?.text).toContain('recent repeated failures')
  })

  it('keeps unrelated wood-bootstrap failure memory after a generic goal succeeds', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.recentGoalFailures = [
      { goalKey: 'explore nearby terrain for useful resources', family: 'wood-bootstrap', at: now - 15_000 },
      { goalKey: 'improve safety around current base area', family: 'safety-setup', at: now - 5_000 },
    ]

    orchestrator.recordGoalSuccess('Improve safety around current base area')

    expect(orchestrator.recentGoalFailures).toHaveLength(1)
    expect(orchestrator.recentGoalFailures[0].family).toBe('wood-bootstrap')
  })

  it('does not classify shelter goals with cobblestone as resource bootstrap failures', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.bot.bot.inventory.items = () => [
      { name: 'stone_pickaxe', count: 1 },
      { name: 'crafting_table', count: 1 },
      { name: 'cobblestone', count: 32 },
    ]
    orchestrator.recentGoalFailures = [
      { goalKey: 'mine iron ore', family: 'resource-bootstrap', at: now - 15_000 },
      { goalKey: 'mine coal ore', family: 'resource-bootstrap', at: now - 5_000 },
    ]

    const resolved = orchestrator.resolveExecutableGoal('Build a small temporary shelter using cobblestone', 'test', now)

    expect(resolved).toEqual({
      goal: 'Build a small temporary shelter using cobblestone',
      reason: 'test',
    })
  })

  it('does not mechanically rewrite abstract exploration goals when they are otherwise allowed', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()

    const resolved = orchestrator.resolveExecutableGoal('Explore nearby terrain for useful resources', 'test', now)

    expect(resolved).toEqual({
      goal: 'Explore nearby terrain for useful resources',
      reason: 'test',
    })
  })

  it('mechanically rewrites blocked mining goals into prerequisite wooden pickaxe crafting when materials are available', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.bot.bot.inventory.items = () => [
      { name: 'oak_log', count: 4 },
      { name: 'crafting_table', count: 1 },
    ]

    const resolved = orchestrator.resolveExecutableGoal('Mine stone blocks', 'test', now)

    expect(resolved).toEqual({
      goal: 'Craft a wooden pickaxe',
      reason: expect.stringContaining('goal-replaced: No pickaxe in inventory'),
    })
  })

  it('retargets stale mining goals to the latest notable block coordinates', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.bot.bot.inventory.items = () => [
      { name: 'stone_pickaxe', count: 1 },
      { name: 'crafting_table', count: 1 },
      { name: 'torch', count: 8 },
    ]
    orchestrator.lastWorldState = [
      'dimension: overworld',
      'terrain_context: surface_forest',
      'wood_access: good',
      'pickaxe_access: available',
      'surface_escape_needed: false',
      'notable_blocks: crafting_table @ 3.0m (2.0, 64.0, 0.0) | iron_ore @ 18.4m (-12.0, 52.0, 7.0)',
    ].join('\n')

    const resolved = orchestrator.resolveExecutableGoal('mine iron_ore at (-343, 55, 250)', 'test', now)

    expect(resolved).toEqual({
      goal: 'mine iron_ore at (-12, 52, 7)',
      reason: expect.stringContaining('goal-retargeted: refreshed iron_ore coordinates from current world scan'),
    })
  })

  it('rewrites repeated underground cave-prep food failures into a surface recovery goal', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.bot.bot.inventory.items = () => [
      { name: 'stone_pickaxe', count: 1 },
      { name: 'stone_sword', count: 1 },
      { name: 'torch', count: 8 },
      { name: 'bread', count: 2 },
    ]
    orchestrator.lastWorldState = [
      'dimension: overworld',
      'terrain_context: underground_cave',
      'wood_access: poor',
      'pickaxe_access: available',
      'surface_escape_needed: true',
    ].join('\n')
    orchestrator.recentGoalFailures = [
      { goalKey: 'prepare supplies (food, torches, sword) for cave exploration', goalFamily: 'safety-setup', family: 'combat-engagement', at: now - 15_000 },
      { goalKey: 'prepare supplies (food, torches, sword) for cave exploration', goalFamily: 'safety-setup', family: 'combat-engagement', at: now - 5_000 },
    ]

    const resolved = orchestrator.resolveExecutableGoal('Prepare supplies (food, torches, sword) for cave exploration', 'test', now)

    expect(resolved).toEqual({
      goal: 'Escape to the surface to gather wood',
      reason: expect.stringContaining('goal-replaced: repeated combat-engagement failures require a deterministic recovery objective'),
    })
  })

  it('rewrites iron-ready underground generic exploration into a surface resupply goal when cave supplies are too thin', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.bot.bot.inventory.items = () => [
      { name: 'iron_pickaxe', count: 1 },
      { name: 'shield', count: 1 },
      { name: 'torch', count: 6 },
      { name: 'bread', count: 2 },
    ]
    orchestrator.bot.bot.entities = {
      zombieA: {
        type: 'mob',
        name: 'zombie',
        position: { x: 4, y: 64, z: 0 },
      },
      zombieB: {
        type: 'mob',
        name: 'zombie',
        position: { x: 8, y: 64, z: 0 },
      },
      skeletonA: {
        type: 'mob',
        name: 'skeleton',
        position: { x: 0, y: 64, z: 6 },
      },
      creeperA: {
        type: 'mob',
        name: 'creeper',
        position: { x: -5, y: 64, z: 3 },
      },
    }
    orchestrator.lastWorldState = [
      'dimension: overworld',
      'terrain_context: underground_cave',
      'wood_access: poor',
      'pickaxe_access: available',
      'surface_escape_needed: true',
    ].join('\n')

    const resolved = orchestrator.resolveExecutableGoal('Explore nearby terrain for useful resources', 'test', now)

    expect(resolved).toEqual({
      goal: 'Escape to the surface to resupply food and torches for deeper mining',
      reason: expect.stringContaining('goal-replaced: iron-ready underground progression still lacks surface resupply buffers'),
    })
  })
})
