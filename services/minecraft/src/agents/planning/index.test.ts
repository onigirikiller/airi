import type { Plan } from '../../libs/mineflayer/base-agent'

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ActionAbortedError } from '../../libs/mineflayer/action-abort'
import { monitorBus } from '../../libs/monitor-event-bus'
import { PlanningAgentImpl } from './index'

function createAgentWithActions(actionNames: string[], bot?: any): PlanningAgentImpl {
  const agent = new PlanningAgentImpl({
    id: 'planning-test',
    type: 'planning',
    bot,
    llm: {
      agent: {} as any,
    },
  })

  const planner = agent as any
  planner.initialized = true
  planner.actionAgent = {
    getAvailableActions: () => actionNames.map(name => ({
      name,
      description: '',
      schema: z.object({}),
      perform: () => async () => '',
    })),
  }
  planner.llmHandler = {
    generatePlan: async () => [],
  }

  return agent
}

function createBotWithInventory(
  counts: Record<string, number>,
  options?: {
    capabilityHash?: string
    heldItem?: { name: string, count?: number }
    offhandItem?: { name: string, count?: number }
    armor?: Array<{ slot: number, name: string, count?: number }>
    food?: number
    health?: number
    entities?: Record<string, any>
    nearbyBlocks?: Array<{ x: number, y: number, z: number, distanceTo?: (other: { x: number, y: number, z: number }) => number }>
    blockAt?: (position: { x: number, y: number, z: number }) => { name: string, position?: { x: number, y: number, z: number } } | null
  },
): any {
  const slots = Array.from({ length: 46 }, () => null) as Array<any>
  const blockAt = options?.blockAt ?? ((position: { x: number, y: number, z: number }) => ({ name: 'air', position }))
  const findBlocks = (query?: { matching?: ((block: any) => boolean) | any[] }) => {
    const nearbyBlocks = options?.nearbyBlocks ?? []
    const matching = query?.matching
    if (typeof matching !== 'function') {
      return nearbyBlocks
    }

    return nearbyBlocks.filter((position) => {
      const block = blockAt(position)
      return block ? matching(block) : false
    })
  }
  if (options?.offhandItem) {
    slots[45] = { ...options.offhandItem, count: options.offhandItem.count ?? 1 }
  }
  for (const armorItem of options?.armor ?? []) {
    slots[armorItem.slot] = { ...armorItem, count: armorItem.count ?? 1 }
  }

  return {
    getBridgeDebugState: () => ({
      capabilitySnapshot: {
        capabilityHash: options?.capabilityHash ?? 'cap:test',
      },
    }),
    bot: {
      food: options?.food ?? 20,
      health: options?.health ?? 20,
      entity: {
        position: { x: 0, y: 64, z: 0 },
      },
      entities: options?.entities ?? {},
      heldItem: options?.heldItem ?? null,
      findBlocks,
      findBlocksAsync: async (query?: { matching?: ((block: any) => boolean) | any[] }) => findBlocks(query),
      blockAt,
      inventory: {
        selectedSlot: 0,
        slots,
        items: () => Object.entries(counts).map(([name, count]) => ({ name, count })),
      },
    },
  }
}

function createBotTrappedBelowSurfaceCue(counts: Record<string, number> = {}): any {
  return createBotWithInventory(counts, {
    nearbyBlocks: [{
      x: 1,
      y: 63,
      z: 0,
      distanceTo(other: { x: number, y: number, z: number }) {
        return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
      },
    }],
    blockAt: (position: { x: number, y: number, z: number }) => {
      if (position.x === 1 && position.y === 63 && position.z === 0) {
        return { name: 'grass_block', position }
      }
      if (
        Math.abs(position.x) <= 1
        && Math.abs(position.z) <= 1
        && position.y >= 66
        && position.y <= 76
      ) {
        return { name: 'stone', position }
      }
      if (
        Math.abs(position.x) + Math.abs(position.z) === 1
        && (position.y === 64 || position.y === 65)
      ) {
        return { name: 'stone', position }
      }
      if (position.y === 63 && Math.abs(position.x) <= 1 && Math.abs(position.z) <= 1) {
        return { name: 'dirt', position }
      }
      return { name: 'air', position }
    },
  })
}

describe('planning fallback behavior', () => {
  it('forces fallback steps for imperative japanese free-form goals', async () => {
    const planner = createAgentWithActions(['nearbyBlocks', 'searchForBlock', 'collectBlocks', 'moveAway'])
    const goal = '\u306A\u3093\u304B\u597D\u304D\u306A\u3053\u3068\u3057\u3066\u3066'
    const handler = vi.fn()
    monitorBus.onMonitor(handler)

    const plan = await planner.createPlan(goal)
    monitorBus.offMonitor(handler)

    expect(plan.requiresAction).toBe(true)
    expect(plan.status).toBe('pending')
    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.steps.some(step => step.tool === 'moveAway')).toBe(true)
    const fallbackEvents = handler.mock.calls
      .map(call => call[0])
      .filter(event => event.type === 'fallback:used')
    expect(fallbackEvents).toHaveLength(1)
    expect(fallbackEvents[0].data.scope).toBe('planning.normalizePlan')
  })

  it('treats direct surface recovery goals as actionable plans', async () => {
    const planner = createAgentWithActions(['searchForBlock', 'collectBlocks', 'moveAway'])
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => ([
      {
        description: 'Search for grass blocks or open terrain to climb toward the surface',
        tool: 'searchForBlock',
        params: { type: 'grass_block', search_range: 48 },
      },
      {
        description: 'Move away from the cave interior to look for a surface exit',
        tool: 'moveAway',
        params: { distance: 32 },
      },
    ]))
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Dig upwards to reach the surface')

    expect(plan.requiresAction).toBe(true)
    expect(plan.status).toBe('pending')
    expect(plan.steps.map(step => step.tool)).toEqual(['searchForBlock', 'moveAway'])
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('tries observation-driven surface cues before a blind vertical climb during surface recovery', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'moveAway', 'goToCoordinates'],
      {
        bot: {
          entity: {
            position: { x: -242.3, y: 50.4, z: 155.8 },
          },
        },
      },
    )

    const plan = await planner.createPlan('Escape to the surface to gather wood')

    expect(plan.requiresAction).toBe(true)
    expect(plan.status).toBe('pending')
    expect(plan.steps.map(step => step.tool)).toEqual(['searchForBlock', 'moveAway', 'goToCoordinates'])
    expect(plan.steps[2]?.description).toContain('direct surface cues stay blocked')
  })

  it('prefers recoverTowardSurface when the direct surface-recovery action exists', async () => {
    const planner = createAgentWithActions(['recoverTowardSurface', 'collectBlocks', 'searchForBlock', 'moveAway'])
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => ([]))
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Escape to the surface to gather wood')

    expect(plan.requiresAction).toBe(true)
    expect(plan.status).toBe('pending')
    expect(plan.steps.map(step => step.tool)).toEqual(['recoverTowardSurface', 'collectBlocks'])
    expect(plan.steps[1]?.params.type).toBe('log')
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('probes nearby surface cues before recoverTowardSurface when local grass is already visible', async () => {
    const planner = createAgentWithActions(
      ['recoverTowardSurface', 'collectBlocks', 'searchForBlock', 'moveAway'],
      {
        getBridgeDebugState: () => ({
          capabilitySnapshot: {
            capabilityHash: 'cap:test',
          },
        }),
        bot: {
          entity: {
            position: { x: -242.3, y: 64, z: 155.8 },
          },
          inventory: {
            items: () => [],
          },
          findBlocks: () => [{
            x: -241,
            y: 63,
            z: 156,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }],
          blockAt: (position: { x: number, y: number, z: number }) => ({
            name: position.x === -241 && position.y === 63 && position.z === 156 ? 'grass_block' : 'stone',
            position,
          }),
        },
      },
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => ([]))
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Escape to the surface to gather wood')

    expect(plan.requiresAction).toBe(true)
    expect(plan.status).toBe('pending')
    expect(plan.steps.map(step => step.tool)).toEqual(['searchForBlock', 'recoverTowardSurface', 'collectBlocks'])
    expect(plan.steps[0]?.params.search_range).toBe(64)
    expect(plan.steps[2]?.params.type).toBe('log')
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('routes food collection through surface recovery when the bot is trapped underground near a surface cue', async () => {
    const planner = createAgentWithActions(
      ['recoverTowardSurface', 'searchForBlock', 'moveAway', 'searchForEntity', 'attack'],
      {
        getBridgeDebugState: () => ({
          capabilitySnapshot: {
            capabilityHash: 'cap:test',
          },
        }),
        bot: {
          entity: {
            position: { x: 0, y: 64, z: 0 },
          },
          inventory: {
            items: () => [],
          },
          findBlocks: () => [{
            x: 1,
            y: 63,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }],
          blockAt: (position: { x: number, y: number, z: number }) => {
            if (position.x === 1 && position.y === 63 && position.z === 0) {
              return { name: 'grass_block', position }
            }
            if (
              Math.abs(position.x) <= 1
              && Math.abs(position.z) <= 1
              && position.y >= 66
              && position.y <= 76
            ) {
              return { name: 'dirt', position }
            }
            if (
              Math.abs(position.x) + Math.abs(position.z) === 1
              && (position.y === 64 || position.y === 65)
            ) {
              return { name: 'stone', position }
            }
            return { name: 'air', position }
          },
        },
      },
    )

    const plan = await planner.createPlan('Collect nearby food')

    expect(plan.requiresAction).toBe(true)
    expect(plan.steps.map(step => step.tool)).toEqual([
      'searchForBlock',
      'recoverTowardSurface',
      'searchForEntity',
      'attack',
    ])
  })

  it('routes crafting-table wood bootstrap through surface recovery when trapped below visible surface cues', async () => {
    const planner = createAgentWithActions(
      ['recoverTowardSurface', 'searchForBlock', 'moveAway', 'collectBlocks', 'craftRecipe'],
      createBotTrappedBelowSurfaceCue(),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Craft a crafting table')

    expect(plan.requiresAction).toBe(true)
    expect(plan.steps.map(step => step.tool)).toEqual([
      'searchForBlock',
      'recoverTowardSurface',
      'collectBlocks',
      'craftRecipe',
      'craftRecipe',
    ])
    expect(plan.steps[0]?.params.type).toBe('grass_block')
    expect(plan.steps[2]?.params.type).toBe('log')
    expect(plan.steps[3]?.params.recipe_name).toBe('oak_planks')
    expect(plan.steps[4]?.params.recipe_name).toBe('crafting_table')
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('does not inject wood surface recovery when already standing on forest surface under canopy', async () => {
    const planner = createAgentWithActions(
      ['recoverTowardSurface', 'searchForBlock', 'moveAway', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({}, {
        nearbyBlocks: [
          {
            x: 0,
            y: 63,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          },
          {
            x: 3,
            y: 64,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          },
        ],
        blockAt: (position: { x: number, y: number, z: number }) => {
          if (position.x === 3 && position.y === 64 && position.z === 0) {
            return { name: 'oak_log', position }
          }
          if (position.y === 63 && Math.abs(position.x) <= 1 && Math.abs(position.z) <= 1) {
            return { name: 'grass_block', position }
          }
          if (position.x === 0 && position.z === 0 && position.y === 66) {
            return { name: 'oak_leaves', position }
          }
          if (position.y === 64 || position.y === 65) {
            if (position.x === 1 || position.z === 1) {
              return { name: 'air', position }
            }
            if (position.x === -1 || position.z === -1) {
              return { name: 'dirt', position }
            }
          }
          return { name: 'air', position }
        },
      }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Craft a crafting table')

    expect(plan.steps.map(step => step.tool)).toEqual([
      'collectBlocks',
      'craftRecipe',
      'craftRecipe',
    ])
    expect(plan.steps.some(step => step.tool === 'recoverTowardSurface')).toBe(false)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('treats temporary shelter goals as actionable and uses the shelter fast path', async () => {
    const planner = createAgentWithActions(['placeHere', 'moveAway'], createBotWithInventory({
      cobblestone: 8,
      torch: 2,
    }))
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Establish a lit temporary shelter before night combat escalates')

    expect(plan.requiresAction).toBe(true)
    expect(plan.status).toBe('pending')
    expect(plan.steps.map(step => `${step.tool}:${step.params.type ?? step.params.distance}`)).toEqual([
      'moveAway:12',
      'placeHere:cobblestone',
      'placeHere:torch',
    ])
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('does not plan impossible torch placement when shelter inventory has no torches', async () => {
    const planner = createAgentWithActions(['placeHere', 'moveAway'], createBotWithInventory({
      cobblestone: 24,
      oak_log: 5,
    }))
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('近くにいるピリジャーを避けつつ、安全な場所に囲いを作って夜をしのぐ')

    expect(plan.steps.map(step => `${step.tool}:${step.params.type ?? step.params.distance}`)).toEqual([
      'moveAway:12',
      'placeHere:cobblestone',
    ])
    expect(plan.steps.some(step => step.params.type === 'torch')).toBe(false)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('keeps small-talk goals as no-action plans', async () => {
    const planner = createAgentWithActions(['nearbyBlocks', 'searchForBlock', 'collectBlocks', 'moveAway'])
    const goal = '\u3053\u3093\u306B\u3061\u306F'

    const plan = await planner.createPlan(goal)

    expect(plan.requiresAction).toBe(false)
    expect(plan.status).toBe('completed')
    expect(plan.steps).toEqual([])
  })

  it('sanitizes food plan placeholders and injects movement step', async () => {
    const planner = createAgentWithActions(['searchForEntity', 'consume', 'moveAway', 'attack'])
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => ([
        {
          description: '食料を探す',
          tool: 'searchForEntity',
          params: { type: 'food', search_range: 10 },
        },
        {
          description: '食べる',
          tool: 'consume',
          params: { item_name: 'food_item  // placeholder' },
        },
      ]),
    }

    const plan = await planner.createPlan('Collect food and keep survival stable')

    expect(plan.requiresAction).toBe(true)
    expect(plan.steps.some(step => step.tool === 'moveAway')).toBe(true)
    expect(plan.steps.some(step => step.tool === 'consume')).toBe(false)
    const searchStep = plan.steps.find(step => step.tool === 'searchForEntity')
    expect(searchStep?.params.type).toBe('animal')
    expect(Number(searchStep?.params.search_range)).toBeGreaterThanOrEqual(32)
  })

  it('keeps generic consume food requests for food recovery goals', async () => {
    const planner = createAgentWithActions(['consume'])
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => ([{
        description: 'Eat available food',
        tool: 'consume',
        params: { item_name: 'food' },
      }]),
    }

    const plan = await planner.createPlan('Consume available food to recover hunger')

    expect(plan.requiresAction).toBe(true)
    expect(plan.steps).toEqual([expect.objectContaining({
      tool: 'consume',
      params: { item_name: 'food' },
    })])
  })

  it('normalizes generic and spaced craft recipe tool names', async () => {
    const planner = createAgentWithActions(['craftRecipe'])
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => ([
        {
          description: 'Craft a mining tool',
          tool: 'craftRecipe',
          params: { recipe_name: 'pick axe', num: 1 },
        },
        {
          description: 'Craft a better mining tool',
          tool: 'craftRecipe',
          params: { recipe_name: 'stone pickaxe', num: 1 },
        },
        {
          description: 'Craft planks from nearby oak logs',
          tool: 'craftRecipe',
          params: { recipe_name: 'planks', num: 4 },
        },
        {
          description: 'Craft sticks for the next tool',
          tool: 'craftRecipe',
          params: { recipe_name: 'sticks', num: 1 },
        },
      ]),
    }

    const plan = await planner.createPlan('Explore nearby terrain for useful resources')

    expect(plan.steps[0]?.params.recipe_name).toBe('pickaxe')
    expect(plan.steps[1]?.params.recipe_name).toBe('stone_pickaxe')
    expect(plan.steps[2]?.params.recipe_name).toBe('oak_planks')
    expect(plan.steps[3]?.params.recipe_name).toBe('stick')
  })

  it('expands composite tool-set recipes into concrete craft steps', async () => {
    const planner = createAgentWithActions(['craftRecipe'])
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => ([
        {
          description: 'Craft a basic wooden tool set',
          tool: 'craftRecipe',
          params: { recipe_name: 'wooden_tools_set', num: 1 },
        },
      ]),
    }

    const plan = await planner.createPlan('Craft a basic wooden tool set')

    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.params.recipe_name).toBe('wooden_pickaxe')
    expect(plan.steps[1]?.params.recipe_name).toBe('wooden_axe')
  })

  it('expands plain composite tool recipe ids into concrete craft steps', async () => {
    const planner = createAgentWithActions(['craftRecipe'])
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => ([
        {
          description: 'Craft wooden tools',
          tool: 'craftRecipe',
          params: { recipe_name: 'wooden_tools', num: 1 },
        },
      ]),
    }

    const plan = await planner.createPlan('Craft wooden tools')

    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.params.recipe_name).toBe('wooden_pickaxe')
    expect(plan.steps[1]?.params.recipe_name).toBe('wooden_axe')
  })

  it('recovers omitted craft steps from movement-only craft descriptions', async () => {
    const planner = createAgentWithActions(['goToCoordinates', 'craftRecipe'])
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => ([
        {
          description: 'Go to the nearby crafting table to craft a wooden pickaxe and wooden axe',
          tool: 'goToCoordinates',
          params: { x: 12, y: 64, z: -3, closeness: 2 },
        },
      ]),
    }

    const plan = await planner.createPlan('Craft a wooden pickaxe and wooden axe')

    expect(plan.steps).toHaveLength(3)
    expect(plan.steps[0]?.tool).toBe('goToCoordinates')
    expect(plan.steps[1]?.tool).toBe('craftRecipe')
    expect(plan.steps[1]?.params.recipe_name).toBe('wooden_pickaxe')
    expect(plan.steps[2]?.tool).toBe('craftRecipe')
    expect(plan.steps[2]?.params.recipe_name).toBe('wooden_axe')
  })

  it('does not duplicate explicit craft steps already present later in the plan', async () => {
    const planner = createAgentWithActions(['goToCoordinates', 'craftRecipe'])
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => ([
        {
          description: 'Go to the nearby crafting table to craft a wooden pickaxe',
          tool: 'goToCoordinates',
          params: { x: 12, y: 64, z: -3, closeness: 2 },
        },
        {
          description: 'Craft one wooden pickaxe',
          tool: 'craftRecipe',
          params: { recipe_name: 'wooden_pickaxe', num: 1 },
        },
      ]),
    }

    const plan = await planner.createPlan('Craft a wooden pickaxe')
    const craftSteps = plan.steps.filter(step => step.tool === 'craftRecipe')

    expect(craftSteps).toHaveLength(1)
    expect(craftSteps[0]?.params.recipe_name).toBe('wooden_pickaxe')
  })

  it('appends missing goal-implied craft requirements when the plan only crafts part of a tool set', async () => {
    const planner = createAgentWithActions(['goToCoordinates', 'craftRecipe'])
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => ([
        {
          description: 'Go to the nearby crafting table',
          tool: 'goToCoordinates',
          params: { x: -350, y: 64, z: 171, closeness: 2 },
        },
        {
          description: 'Craft one wooden axe',
          tool: 'craftRecipe',
          params: { recipe_name: 'wooden_axe', num: 1 },
        },
      ]),
    }

    const plan = await planner.createPlan('Craft a basic wooden tool set')
    const craftSteps = plan.steps.filter(step => step.tool === 'craftRecipe')

    expect(craftSteps).toHaveLength(2)
    expect(craftSteps[0]?.params.recipe_name).toBe('wooden_axe')
    expect(craftSteps[1]?.params.recipe_name).toBe('wooden_pickaxe')
  })

  it('builds a structured crafting-table plan from current inventory without redundant wood collection', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({ oak_log: 10, oak_planks: 3 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => ([
      {
        description: 'Collect 1 log',
        tool: 'collectBlocks',
        params: { type: 'log', num: 1 },
      },
      {
        description: 'Craft planks from the log',
        tool: 'craftRecipe',
        params: { recipe_name: 'oak_planks', num: 1 },
      },
      {
        description: 'Craft a crafting table',
        tool: 'craftRecipe',
        params: { recipe_name: 'crafting_table', num: 1 },
      },
    ]))
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Craft a crafting table')

    expect(plan.steps.map(step => `${step.tool}:${String(step.params.recipe_name ?? step.params.type ?? '')}`)).toEqual([
      'craftRecipe:oak_planks',
      'craftRecipe:crafting_table',
    ])
    expect(plan.steps.some(step => step.tool === 'collectBlocks')).toBe(false)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('builds a structured stone-pickaxe plan without redundant gathering when materials already exist', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({ crafting_table: 1, cobblestone: 3, stick: 2 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Craft a stone pickaxe')

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.tool).toBe('craftRecipe')
    expect(plan.steps[0]?.params.recipe_name).toBe('stone_pickaxe')
    expect(plan.steps.some(step => step.tool === 'collectBlocks')).toBe(false)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('reserves shared plank inputs when building a structured wooden-pickaxe plan', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({ crafting_table: 1 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Craft a wooden pickaxe')
    const totalLogCollection = plan.steps
      .filter(step => step.tool === 'collectBlocks' && step.params.type === 'log')
      .reduce((sum, step) => sum + Number(step.params.num ?? 0), 0)
    const totalPlankCrafts = plan.steps
      .filter(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'oak_planks')
      .reduce((sum, step) => sum + Number(step.params.num ?? 0), 0)

    expect(totalLogCollection).toBe(2)
    expect(totalPlankCrafts).toBe(2)
    expect(plan.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'stick')).toBe(true)
    expect(plan.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'wooden_pickaxe')).toBe(true)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('uses a reachable placed crafting table for wooden-pickaxe planning instead of crafting another table', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        { oak_planks: 10, stick: 4 },
        {
          nearbyBlocks: [{
            x: 24,
            y: 66,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }] as any,
          blockAt: position => ({
            name: position.x === 24 && position.y === 66 && position.z === 0 ? 'crafting_table' : 'air',
            position,
          }),
        },
      ),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Craft a wooden pickaxe')

    expect(plan.steps).toEqual([expect.objectContaining({
      tool: 'craftRecipe',
      params: { recipe_name: 'wooden_pickaxe', num: 1 },
    })])
    expect(plan.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'crafting_table')).toBe(false)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('batches empty-inventory wooden-pickaxe bootstrap logs before crafting', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({}),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Craft a wooden pickaxe')

    expect(plan.steps.map(step => `${step.tool}:${String(step.params.recipe_name ?? step.params.type ?? '')}:${String(step.params.num ?? '')}`)).toEqual([
      'collectBlocks:log:3',
      'craftRecipe:oak_planks:3',
      'craftRecipe:crafting_table:1',
      'craftRecipe:stick:1',
      'craftRecipe:wooden_pickaxe:1',
    ])
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('uses structured wooden-pickaxe planning for generic pickaxe bootstrap goals', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({ birch_log: 1 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Gather wood to craft a pickaxe')
    const totalLogCollection = plan.steps
      .filter(step => step.tool === 'collectBlocks' && step.params.type === 'log')
      .reduce((sum, step) => sum + Number(step.params.num ?? 0), 0)

    expect(totalLogCollection).toBe(3)
    expect(plan.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'crafting_table')).toBe(true)
    expect(plan.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'wooden_pickaxe')).toBe(true)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('targets two total logs for wooden-pickaxe planning when one log and a nearby table already exist', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        { birch_log: 1 },
        {
          nearbyBlocks: [{
            x: 1,
            y: 64,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }],
          blockAt: position => ({
            name: position.x === 1 && position.y === 64 && position.z === 0 ? 'crafting_table' : 'air',
            position,
          }),
        },
      ),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Gather wood to craft a pickaxe')
    const logStep = plan.steps.find(step => step.tool === 'collectBlocks' && step.params.type === 'log')

    expect(logStep?.params.num).toBe(2)
    expect(plan.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'crafting_table')).toBe(false)
    expect(plan.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'wooden_pickaxe')).toBe(true)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('mines stone directly for cobblestone goals without a blocking pre-search', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks'],
      createBotWithInventory({ wooden_pickaxe: 1 }),
    )

    const plan = await planner.createPlan('Mine 16 cobblestone')

    expect(plan.steps).toEqual([
      expect.objectContaining({
        description: 'Mine 16 stone for cobblestone',
        tool: 'collectBlocks',
        params: { type: 'stone', num: 16 },
      }),
    ])
  })

  it('keeps furnace crafting in mixed crafting-table-and-furnace goals', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory({ oak_log: 1, cobblestone: 8 }),
    )

    const plan = await planner.createPlan('Craft a crafting table and then a furnace using the collected cobblestone')

    expect(plan.steps.map(step => step.tool)).toEqual([
      'craftRecipe',
      'craftRecipe',
      'craftRecipe',
    ])
    expect(plan.steps.map(step => step.params.recipe_name)).toEqual([
      'oak_planks',
      'crafting_table',
      'furnace',
    ])
  })

  it('does not treat vertically unreachable crafting tables as current crafting access', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        { oak_log: 3 },
        {
          nearbyBlocks: [{
            x: 0,
            y: 69,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }] as any,
          blockAt: position => ({
            name: position.x === 0 && position.y === 69 && position.z === 0 ? 'crafting_table' : 'air',
            position,
          }),
        },
      ),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Craft a wooden pickaxe')

    expect(plan.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'crafting_table')).toBe(true)
    expect(plan.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'wooden_pickaxe')).toBe(true)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('builds a structured torch plan for cave-prep goals', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({ stick: 1, coal: 1 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Craft torches and prepare for caves')

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.tool).toBe('craftRecipe')
    expect(plan.steps[0]?.params.recipe_name).toBe('torch')
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('builds a structured full-diamond-armor plan from explicit goal text without LLM fallback', async () => {
    const planner = createAgentWithActions(
      ['craftRecipe'],
      createBotWithInventory({ crafting_table: 1, diamond: 24 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Craft full diamond armor')

    expect(plan.steps.map(step => `${step.tool}:${String(step.params.recipe_name ?? '')}`)).toEqual([
      'craftRecipe:diamond_chestplate',
      'craftRecipe:diamond_leggings',
      'craftRecipe:diamond_helmet',
      'craftRecipe:diamond_boots',
    ])
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('builds a structured cave-prep plan that includes sword craft, torch prep, and food search', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'searchForEntity', 'attack', 'craftRecipe'],
      createBotWithInventory({ coal: 1, stick: 2 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Prepare supplies (food, torches, sword) for cave exploration')

    expect(plan.steps.map(step => `${step.tool}:${String(step.params.recipe_name ?? step.params.type ?? '')}`)).toEqual([
      'craftRecipe:sword',
      'craftRecipe:torch',
      'moveAway:',
      'searchForEntity:animal',
      'attack:animal',
    ])
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('expands a generic sword craft goal into visible wood bootstrap steps when collection is available', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory({}),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Gather materials and craft a sword')

    expect(plan.steps.map(step => `${step.tool}:${String(step.params.recipe_name ?? step.params.type ?? '')}`)).toEqual([
      'collectBlocks:log',
      'craftRecipe:oak_planks',
      'craftRecipe:crafting_table',
      'craftRecipe:stick',
      'craftRecipe:wooden_sword',
    ])
    expect(plan.steps.find(step => step.tool === 'collectBlocks' && step.params.type === 'log')?.params.num).toBe(2)
    expect(plan.steps.some(step =>
      step.tool === 'craftRecipe'
      && step.params.recipe_name === 'sword',
    )).toBe(false)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('adds sword preparation before structured food hunting when wood is already available', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'searchForEntity', 'attack', 'craftRecipe'],
      createBotWithInventory({ oak_log: 4 }),
    )
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const plan = await planner.createPlan('Collect nearby food')

    expect(plan.steps.map(step => `${step.tool}:${String(step.params.recipe_name ?? step.params.type ?? '')}`)).toEqual([
      'craftRecipe:sword',
      'moveAway:',
      'searchForEntity:animal',
      'attack:animal',
    ])
  })

  it('adds immediate eating after structured food hunting when hunger is unsafe', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'searchForEntity', 'attack', 'consume', 'craftRecipe'],
      createBotWithInventory({ oak_log: 4 }, { food: 5, health: 11 }),
    )
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const plan = await planner.createPlan('食料を確保して生存を安定させる')

    expect(plan.steps.map(step => `${step.tool}:${String(step.params.recipe_name ?? step.params.type ?? step.params.item_name ?? '')}`)).toEqual([
      'craftRecipe:sword',
      'moveAway:',
      'searchForEntity:animal',
      'attack:animal',
      'consume:food',
    ])
  })

  it('does not spend critical health on blind food-search relocation', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'searchForEntity', 'attack', 'consume'],
      createBotWithInventory({}, { food: 16, health: 7 }),
    )
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const plan = await planner.createPlan('Collect nearby food')

    expect(plan.steps.map(step => `${step.tool}:${String(step.params.type ?? step.params.item_name ?? '')}`)).toEqual([
      'searchForEntity:animal',
      'attack:animal',
      'consume:food',
    ])
  })

  it('does not inject surface-recovery food steps when the bot is already on the surface under tree cover', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'searchForEntity', 'attack', 'searchForBlock', 'recoverTowardSurface'],
      createBotWithInventory({}, {
        nearbyBlocks: [{
          x: 1,
          y: 63,
          z: 0,
          distanceTo(other: { x: number, y: number, z: number }) {
            return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
          },
        }],
        blockAt: (position: { x: number, y: number, z: number }) => {
          if (position.x === 1 && position.y === 63 && position.z === 0) {
            return { name: 'grass_block', position }
          }
          if (position.x === 0 && position.z === 0 && position.y === 66) {
            return { name: 'oak_leaves', position }
          }
          if (position.y >= 67) {
            return { name: 'air', position }
          }
          if (position.y === 63) {
            return { name: 'grass_block', position }
          }
          return { name: 'air', position }
        },
      }),
    )
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const plan = await planner.createPlan('Collect nearby food')

    expect(plan.steps.map(step => step.tool)).toEqual(['moveAway', 'searchForEntity', 'attack'])
  })

  it('builds a structured smelting plan without invoking the planner LLM', async () => {
    const planner = createAgentWithActions(
      ['placeHere', 'smeltItem'],
      createBotWithInventory({ furnace: 1, raw_iron: 9, coal: 7 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Place furnace and smelt raw iron into iron ingots')

    expect(plan.steps.map(step => step.tool)).toEqual(['placeHere', 'smeltItem'])
    expect(plan.steps[0]?.params.type).toBe('furnace')
    expect(plan.steps[1]?.params.item_name).toBe('raw_iron')
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('builds a structured wood-fueled iron smelting plan for furnace-coordinate goals', async () => {
    const planner = createAgentWithActions(
      ['placeHere', 'smeltItem'],
      createBotWithInventory({ furnace: 1, raw_iron: 1, oak_log: 4 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Move to the furnace at (-373.0, 63.0, 268.0) and smelt the raw iron')

    expect(plan.steps.map(step => step.tool)).toEqual(['placeHere', 'smeltItem'])
    expect(plan.steps[0]?.params.type).toBe('furnace')
    expect(plan.steps[1]?.params.item_name).toBe('raw_iron')
    expect(plan.steps[1]?.params.num).toBe(1)
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('builds a structured placement-plus-crafting plan for mixed furnace goals', async () => {
    const planner = createAgentWithActions(
      ['placeHere', 'craftRecipe'],
      createBotWithInventory({ furnace: 1, oak_planks: 7 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Place furnace and craft sticks')

    expect(plan.steps.map(step => step.tool)).toEqual(['placeHere', 'craftRecipe'])
    expect(plan.steps[0]?.params.type).toBe('furnace')
    expect(plan.steps[1]?.params.recipe_name).toBe('stick')
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('builds a structured charcoal-and-torch plan for explicit create-torches goals', async () => {
    const planner = createAgentWithActions(
      ['placeHere', 'smeltItem', 'craftRecipe'],
      createBotWithInventory({ furnace: 1, oak_log: 8, stick: 2 }),
    )
    const plannerAny = planner as any
    const llmGeneratePlan = vi.fn(async () => [])
    plannerAny.llmHandler = {
      generatePlan: llmGeneratePlan,
    }

    const plan = await planner.createPlan('Smelt charcoal using the furnace and oak logs to create torches')

    expect(plan.steps.map(step => step.tool)).toEqual(['placeHere', 'smeltItem', 'craftRecipe'])
    expect(plan.steps[0]?.params.type).toBe('furnace')
    expect(plan.steps[1]?.params.item_name).toBe('oak_log')
    expect(plan.steps[2]?.params.recipe_name).toBe('torch')
    expect(llmGeneratePlan).not.toHaveBeenCalled()
  })

  it('uses the requested wood family instead of hardcoding oak planks in torch recovery plans', async () => {
    const planner = createAgentWithActions(
      ['placeHere', 'smeltItem', 'craftRecipe'],
      createBotWithInventory({ furnace: 1, birch_log: 8 }),
    )
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const plan = await planner.createPlan('Smelt charcoal using the furnace and birch logs to create torches')

    expect(plan.steps.map(step => step.tool)).toEqual(['craftRecipe', 'placeHere', 'smeltItem', 'craftRecipe', 'craftRecipe'])
    expect(plan.steps[0]?.params.recipe_name).toBe('birch_planks')
    expect(plan.steps[2]?.params.item_name).toBe('birch_log')
    expect(plan.steps[3]?.params.recipe_name).toBe('stick')
    expect(plan.steps[4]?.params.recipe_name).toBe('torch')
  })

  it('crafts plank fuel before charcoal smelting when only logs are available', async () => {
    const planner = createAgentWithActions(
      ['placeHere', 'smeltItem', 'craftRecipe'],
      createBotWithInventory({ furnace: 1, birch_log: 4 }),
    )
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const plan = await planner.createPlan('Smelt charcoal using logs for torch and furnace fuel')

    expect(plan.steps.map(step => step.tool)).toEqual(['craftRecipe', 'placeHere', 'smeltItem', 'craftRecipe', 'craftRecipe'])
    expect(plan.steps[0]?.params.recipe_name).toBe('birch_planks')
    expect(plan.steps[2]?.params.item_name).toBe('birch_log')
    expect(plan.steps[3]?.params.recipe_name).toBe('stick')
    expect(plan.steps[4]?.params.recipe_name).toBe('torch')
  })

  it('uses a visible furnace and existing logs for charcoal torches instead of collecting more underground wood', async () => {
    const furnacePosition = {
      x: 8,
      y: 64,
      z: 0,
      distanceTo(other: { x: number, y: number, z: number }) {
        return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
      },
    }
    const planner = createAgentWithActions(
      ['searchForBlock', 'smeltItem', 'craftRecipe', 'collectBlocks'],
      createBotWithInventory(
        { oak_log: 1, oak_planks: 7, stone_pickaxe: 1 },
        {
          nearbyBlocks: [furnacePosition],
          blockAt: (position: { x: number, y: number, z: number }) => {
            if (position.x === furnacePosition.x && position.y === furnacePosition.y && position.z === furnacePosition.z) {
              return { name: 'furnace', position }
            }
            return { name: 'air', position }
          },
        },
      ),
    )
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const plan = await planner.createPlan('Smelt charcoal using logs for torch and furnace fuel')

    expect(plan.steps.map(step => `${step.tool}:${step.params.type ?? step.params.item_name ?? step.params.recipe_name}`)).toEqual([
      'searchForBlock:furnace',
      'smeltItem:oak_log',
      'craftRecipe:stick',
      'craftRecipe:torch',
    ])
    expect(plan.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'log')).toBe(false)
  })

  it('uses charcoal instead of chasing an unsafe subsurface coal coordinate from the surface', async () => {
    const bot = createBotWithInventory({ furnace: 1, oak_planks: 7, stick: 2, wooden_pickaxe: 1 })
    bot.bot.entity.position = { x: -274.5, y: 63, z: 256.5 }
    const planner = createAgentWithActions(
      ['goToCoordinates', 'searchForBlock', 'collectBlocks', 'placeHere', 'smeltItem', 'craftRecipe'],
      bot,
    )
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: vi.fn(async () => [
        { description: 'Unsafe coal coordinate', tool: 'goToCoordinates', params: { x: -275, y: 50, z: 253, closeness: 4 } },
      ]),
    }

    const plan = await planner.createPlan('mine coal_ore at (-275, 50, 253)')
    const labels = plan.steps.map(step => `${step.tool}:${step.params.type ?? step.params.item_name ?? step.params.recipe_name}`)

    expect(plannerAny.llmHandler.generatePlan).not.toHaveBeenCalled()
    expect(labels).toEqual([
      'searchForBlock:log',
      'collectBlocks:log',
      'placeHere:furnace',
      'smeltItem:log',
    ])
    expect(plan.steps.some(step => step.tool === 'goToCoordinates')).toBe(false)
    expect(plan.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'coal_ore')).toBe(false)
  })

  it('uses charcoal for surface coal-and-torch goals before falling back to shelter-only planning', async () => {
    const bot = createBotWithInventory({ furnace: 1, oak_planks: 7, stick: 1, wooden_pickaxe: 1, stone_sword: 1 })
    bot.bot.entity.position = { x: -274.5, y: 63, z: 256.5 }
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'placeHere', 'smeltItem', 'craftRecipe', 'moveAway'],
      bot,
    )
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: vi.fn(async () => [
        { description: 'Place shelter block', tool: 'placeHere', params: { type: 'cobblestone' } },
        { description: 'Craft torch too early', tool: 'craftRecipe', params: { recipe_name: 'torch', num: 1 } },
      ]),
    }

    const plan = await planner.createPlan('近くの石炭を採掘して松明を作成し、拠点を明るくする')
    const labels = plan.steps.map(step => `${step.tool}:${step.params.type ?? step.params.item_name ?? step.params.recipe_name}`)

    expect(plannerAny.llmHandler.generatePlan).not.toHaveBeenCalled()
    expect(labels).toEqual([
      'searchForBlock:log',
      'collectBlocks:log',
      'placeHere:furnace',
      'smeltItem:log',
      'craftRecipe:torch',
    ])
    expect(plan.steps.some(step => step.tool === 'placeHere' && step.params.type === 'cobblestone')).toBe(false)
    expect(plan.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'coal_ore')).toBe(false)
  })

  it('recovers toward the surface before gathering missing logs for charcoal smelting', async () => {
    const planner = createAgentWithActions(
      ['recoverTowardSurface', 'searchForBlock', 'collectBlocks', 'placeHere', 'smeltItem', 'craftRecipe'],
      createBotTrappedBelowSurfaceCue({ furnace: 1, oak_planks: 2 }),
    )
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const plan = await planner.createPlan('Smelt charcoal using logs for torch and furnace fuel')

    const labels = plan.steps.map(step => `${step.tool}:${step.params.type ?? step.params.reason ?? step.params.item_name ?? step.params.recipe_name}`)
    expect(labels).toContain('recoverTowardSurface:surface_recovery_goal')
    expect(labels.indexOf('recoverTowardSurface:surface_recovery_goal')).toBeLessThan(labels.indexOf('collectBlocks:log'))
  })

  it('does not reinsert already completed prefix steps when adjusting', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'searchForBlock', 'collectBlocks', 'craftRecipe'],
      {
        bot: {
          inventory: {
            items: () => [],
          },
        },
      },
    )
    const plannerAny = planner as any
    plannerAny.context = {
      goal: 'Recover tool progression',
      currentStep: 1,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
    }
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const adjusted = await planner.adjustPlan({
      goal: 'Recover tool progression',
      status: 'in_progress',
      requiresAction: true,
      steps: [
        { description: 'completed move', tool: 'moveAway', params: { distance: 8 } },
        { description: 'failed craft', tool: 'craftRecipe', params: { recipe_name: 'wooden_pickaxe', num: 1 } },
        { description: 'future search', tool: 'searchForBlock', params: { type: 'coal_ore', search_range: 32 } },
      ],
    }, 'ensurePickaxe(x1) failed: ensurePickaxe(x1) failed', 'system')

    expect(adjusted.steps.some(step => step.description === 'completed move')).toBe(false)
    expect(adjusted.steps.some(step => step.tool === 'searchForBlock' && step.params.type === 'log')).toBe(false)
    expect(adjusted.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'log')).toBe(true)
  })

  it('recovers a failed crafting-table bootstrap through wood inputs before retrying the table', async () => {
    const planner = createAgentWithActions(['moveAway', 'collectBlocks', 'craftRecipe'])
    const plannerAny = planner as any
    const plan = {
      goal: 'Craft a crafting table',
      status: 'in_progress' as const,
      requiresAction: true,
      steps: [
        { description: 'Craft crafting table', tool: 'craftRecipe', params: { recipe_name: 'crafting_table', num: 1 } },
      ],
    }

    plannerAny.context = plannerAny.initializeContext(plan.goal)
    plannerAny.context.currentStep = 0
    plannerAny.llmHandler = {
      generatePlan: vi.fn(async () => [
        { description: 'Retry crafting table directly', tool: 'craftRecipe', params: { recipe_name: 'crafting_table', num: 1 } },
      ]),
    }

    const adjusted = await planner.adjustPlan(plan, 'ensureCraftingTable failed: ensureCraftingTable failed', 'system')
    const tableCraftIndex = adjusted.steps.findIndex(step =>
      step.tool === 'craftRecipe' && step.params.recipe_name === 'crafting_table',
    )
    const logCollectIndex = adjusted.steps.findIndex(step =>
      step.tool === 'collectBlocks' && step.params.type === 'log',
    )

    expect(plannerAny.llmHandler.generatePlan).not.toHaveBeenCalled()
    expect(logCollectIndex).toBeGreaterThanOrEqual(0)
    expect(tableCraftIndex).toBeGreaterThan(logCollectIndex)
    expect(adjusted.steps.some(step =>
      step.tool === 'craftRecipe' && step.params.recipe_name === 'wooden_pickaxe',
    )).toBe(false)
  })

  it('suppresses blocked fast-path craft steps after an unsupported capability failure and keeps alternate recovery work', async () => {
    const bot = createBotWithInventory({
      crafting_table: 1,
      cobblestone: 3,
      stick: 2,
    }, {
      capabilityHash: 'cap:compact-blocked',
    })
    const planner = createAgentWithActions(['craftRecipe', 'moveAway'], bot)
    const plannerAny = planner as any
    const blockedStep = {
      description: 'Craft stone pickaxe',
      tool: 'craftRecipe',
      params: { recipe_name: 'stone_pickaxe', num: 1 },
    }
    const stateKey = plannerAny.getPlannerStateKey()
    plannerAny.context = {
      goal: 'Craft a stone pickaxe',
      currentStep: 0,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
      blockedSteps: [{
        fingerprint: `${plannerAny.planStepSuppressionFingerprint(blockedStep)}|unsupported_capability|cap:compact-blocked|craft a stone pickaxe|${stateKey}`,
        stepFingerprint: plannerAny.planStepSuppressionFingerprint(blockedStep),
        goalKey: 'craft a stone pickaxe',
        capabilityHash: 'cap:compact-blocked',
        failureClass: 'unsupported_capability',
        stateKey,
        blockedAt: Date.now(),
        reason: 'Unknown command: compactInventory',
      }],
      lastCapabilityHash: 'cap:compact-blocked',
      lastStateKey: stateKey,
    }
    plannerAny.llmHandler = {
      generatePlan: async () => ([
        {
          description: 'Move away and regroup before retrying another milestone',
          tool: 'moveAway',
          params: { distance: 12 },
        },
      ]),
    }

    const plan = await planner.createPlan('Craft a stone pickaxe')

    expect(plan.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'stone_pickaxe')).toBe(false)
    expect(plan.steps).toEqual([
      expect.objectContaining({
        tool: 'moveAway',
        meta: expect.objectContaining({
          plannerSource: 'llm',
        }),
      }),
    ])
  })

  it('keeps the failed block target during search recovery instead of falling back to logs', async () => {
    const planner = createAgentWithActions(['moveAway', 'searchForBlock', 'collectBlocks'])
    const plannerAny = planner as any
    plannerAny.context = {
      goal: 'Mine coal ore at (-372.0, 65.0, 260.0)',
      currentStep: 1,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
    }
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const adjusted = await planner.adjustPlan({
      goal: 'Mine coal ore at (-372.0, 65.0, 260.0)',
      status: 'in_progress',
      requiresAction: true,
      steps: [
        { description: 'ensure pickaxe', tool: 'craftRecipe', params: { recipe_name: 'wooden_pickaxe', num: 1 } },
        { description: 'search coal', tool: 'searchForBlock', params: { type: 'coal_ore', search_range: 64 } },
        { description: 'collect coal', tool: 'collectBlocks', params: { type: 'coal_ore', num: 1 } },
      ],
    }, 'searchForBlock(coal_ore) failed', 'system')

    const recoverySearch = adjusted.steps.find(step =>
      step.tool === 'searchForBlock'
      && step.params.type === 'coal_ore'
      && step.params.search_range === 96,
    )

    expect(recoverySearch).toBeDefined()
    expect(adjusted.steps.some(step => step.tool === 'searchForBlock' && step.params.type === 'log')).toBe(false)
  })

  it('emits planning completed only once even after repeated adjustments', async () => {
    const planner = createAgentWithActions(['craftRecipe'])
    const plannerAny = planner as any
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const actionError = new Error('ensurePickaxe(x1) failed: ensurePickaxe(x1) failed')
    plannerAny.actionAgent = {
      getAvailableActions: () => [{
        name: 'craftRecipe',
        description: '',
        schema: z.object({}),
        perform: () => async () => '',
      }],
      performAction: vi.fn(async () => { throw actionError }),
    }

    const plan = await planner.createPlan('Recover crafting')
    plan.steps = [{
      description: 'Craft a wooden pickaxe',
      tool: 'craftRecipe',
      params: { recipe_name: 'wooden_pickaxe', num: 1 },
    }]
    plan.requiresAction = true

    const handler = vi.fn()
    monitorBus.onMonitor(handler)

    await expect(planner.executePlan(plan)).rejects.toThrow('ensurePickaxe')

    monitorBus.offMonitor(handler)
    const completedEvents = handler.mock.calls
      .map(call => call[0])
      .filter(event => event.type === 'planning:completed')

    expect(completedEvents).toHaveLength(1)
    expect(completedEvents[0].data.status).toBe('failed')
  })

  it('marks an aborted plan as interrupted without retrying or adjusting it', async () => {
    const planner = createAgentWithActions(['moveAway'])
    const plannerAny = planner as any
    const adjustPlan = vi.spyOn(planner, 'adjustPlan')
    plannerAny.actionAgent = {
      getAvailableActions: () => [{
        name: 'moveAway',
        description: '',
        schema: z.object({}),
        perform: () => async () => '',
      }],
      performAction: vi.fn(async () => {
        throw new ActionAbortedError('recovery interrupt')
      }),
    }
    const plan: Plan = {
      goal: 'Move somewhere safe',
      status: 'pending',
      requiresAction: true,
      steps: [{ description: 'move', tool: 'moveAway', params: { distance: 8 } }],
    }

    await expect(planner.executePlan(plan)).rejects.toMatchObject({
      name: 'ActionAbortedError',
      reason: 'recovery interrupt',
    })

    expect(plan.status).toBe('interrupted')
    expect(adjustPlan).not.toHaveBeenCalled()
  })

  it('escalates wood recovery distance after repeated collect failures', async () => {
    const planner = createAgentWithActions(['moveAway', 'searchForBlock', 'collectBlocks'])
    const plannerAny = planner as any
    const normalizedFeedback = plannerAny.normalizeFailureFeedback('collectBlocks failed: log x4 not found or unreachable')
    plannerAny.context = {
      goal: 'Recover wood access',
      currentStep: 1,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: 0,
      failureCounts: {
        [normalizedFeedback]: 2,
      },
      isGenerating: false,
      pendingSteps: [],
    }

    const adjusted = await planner.adjustPlan({
      goal: 'Recover wood access',
      status: 'in_progress',
      requiresAction: true,
      steps: [
        { description: 'search', tool: 'searchForBlock', params: { type: 'log', search_range: 32 } },
        { description: 'collect', tool: 'collectBlocks', params: { type: 'log', num: 4 } },
      ],
    }, 'collectBlocks failed: log x4 not found or unreachable', 'system')

    const moveSteps = adjusted.steps.filter(step => step.tool === 'moveAway')
    expect(moveSteps[0]?.params.distance).toBe(96)
    expect(adjusted.steps.some(step => step.tool === 'searchForBlock' && step.params.type === 'log')).toBe(false)
    expect(adjusted.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'log')).toBe(true)
  })

  it('routes low-health wood recovery through emergency food before retrying logs', async () => {
    const planner = createAgentWithActions(
      ['searchForEntity', 'attack', 'consume', 'collectBlocks'],
      createBotWithInventory({}, { health: 7, food: 16 }),
    )
    const plannerAny = planner as any
    plannerAny.context = {
      goal: 'Gather materials and craft a sword',
      currentStep: 0,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
    }

    const adjusted = await planner.adjustPlan({
      goal: 'Gather materials and craft a sword',
      status: 'in_progress',
      requiresAction: true,
      steps: [
        { description: 'collect logs', tool: 'collectBlocks', params: { type: 'log', num: 4 } },
        { description: 'craft planks', tool: 'craftRecipe', params: { recipe_name: 'oak_planks', num: 1 } },
      ],
    }, 'collectBlocks failed: log x4 not found or unreachable', 'system')

    expect(adjusted.steps.slice(0, 3).map(step => step.tool)).toEqual([
      'searchForEntity',
      'attack',
      'consume',
    ])
    expect(adjusted.steps.some(step => step.tool === 'moveAway')).toBe(false)
  })

  it('keeps recovery log collection after a planned reposition even when the same state blocked collection', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({}),
    )
    const plannerAny = planner as any
    const blockedStep = { description: 'Collect logs', tool: 'collectBlocks', params: { type: 'log', num: 4 } }
    const stateKey = plannerAny.getPlannerStateKey()
    plannerAny.context = {
      goal: 'Craft a wooden pickaxe',
      currentStep: 0,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
      blockedSteps: [{
        fingerprint: `${plannerAny.planStepSuppressionFingerprint(blockedStep)}|wood-search-or-collect|cap:test|craft a wooden pickaxe|${stateKey}`,
        stepFingerprint: plannerAny.planStepSuppressionFingerprint(blockedStep),
        goalKey: 'craft a wooden pickaxe',
        capabilityHash: 'cap:test',
        failureClass: 'wood-search-or-collect',
        stateKey,
        blockedAt: Date.now(),
        reason: 'collectBlocks failed: log x4 not found or unreachable',
      }],
      lastCapabilityHash: 'cap:test',
      lastStateKey: stateKey,
    }

    const adjusted = await planner.adjustPlan({
      goal: 'Craft a wooden pickaxe',
      status: 'in_progress',
      requiresAction: true,
      steps: [
        { description: 'collect logs', tool: 'collectBlocks', params: { type: 'log', num: 1 } },
        { description: 'craft planks', tool: 'craftRecipe', params: { recipe_name: 'oak_planks', num: 1 } },
      ],
    }, 'collectBlocks failed: log x1 not found or unreachable', 'system')

    expect(adjusted.steps[0]?.tool).toBe('moveAway')
    expect(adjusted.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'log')).toBe(true)
  })

  it('keeps ore recovery collection after a planned reposition when verification saw no inventory delta', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({ stone_pickaxe: 1, stick: 4, crafting_table: 1, furnace: 1 }),
    )
    const plannerAny = planner as any
    const blockedStep = { description: 'Collect coal ore', tool: 'collectBlocks', params: { type: 'coal_ore', num: 1 } }
    const stateKey = plannerAny.getPlannerStateKey()
    plannerAny.context = {
      goal: 'Smelt charcoal and craft torches',
      currentStep: 0,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
      blockedSteps: [{
        fingerprint: `${plannerAny.planStepSuppressionFingerprint(blockedStep)}|action verification failed: inventory_unchanged|cap:test|smelt charcoal and craft torches|${stateKey}`,
        stepFingerprint: plannerAny.planStepSuppressionFingerprint(blockedStep),
        goalKey: 'smelt charcoal and craft torches',
        capabilityHash: 'cap:test',
        failureClass: 'action verification failed: inventory_unchanged',
        stateKey,
        blockedAt: Date.now(),
        reason: 'Action verification failed (collectBlocks): inventory_unchanged',
      }],
      lastCapabilityHash: 'cap:test',
      lastStateKey: stateKey,
    }

    const adjusted = await planner.adjustPlan({
      goal: 'Smelt charcoal and craft torches',
      status: 'in_progress',
      requiresAction: true,
      steps: [
        blockedStep,
        { description: 'Craft torches', tool: 'craftRecipe', params: { recipe_name: 'torch', num: 1 } },
      ],
    }, 'Action verification failed (collectBlocks): inventory_unchanged', 'system')

    const stepLabels = adjusted.steps.map(step => `${step.tool}:${String(step.params.type ?? step.params.recipe_name ?? '')}`)
    expect(stepLabels).toContain('moveAway:')
    expect(stepLabels).toContain('searchForBlock:coal_ore')
    expect(stepLabels).toContain('collectBlocks:coal_ore')
    expect(stepLabels.at(-1)).toBe('craftRecipe:torch')
  })

  it('suppresses wood tool crafting when blocked log collection was the missing prerequisite', () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory({}),
    )
    const plannerAny = planner as any
    const blockedStep = { description: 'Collect logs', tool: 'collectBlocks', params: { type: 'log', num: 4 } }
    const stateKey = plannerAny.getPlannerStateKey()
    plannerAny.context = {
      goal: 'Mine 16 cobblestone',
      currentStep: 0,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
      blockedSteps: [{
        fingerprint: `${plannerAny.planStepSuppressionFingerprint(blockedStep)}|wood-search-or-collect|cap:test|mine 16 cobblestone|${stateKey}`,
        stepFingerprint: plannerAny.planStepSuppressionFingerprint(blockedStep),
        goalKey: 'mine 16 cobblestone',
        capabilityHash: 'cap:test',
        failureClass: 'wood-search-or-collect',
        stateKey,
        blockedAt: Date.now(),
        reason: 'collectBlocks failed: log x4 not found or unreachable',
      }],
      lastCapabilityHash: 'cap:test',
      lastStateKey: stateKey,
    }

    const filtered = plannerAny.filterBlockedSteps('Mine 16 cobblestone', [
      blockedStep,
      { description: 'Craft planks', tool: 'craftRecipe', params: { recipe_name: 'oak_planks', num: 1 } },
      { description: 'Craft sticks', tool: 'craftRecipe', params: { recipe_name: 'stick', num: 1 } },
      { description: 'Craft wooden pickaxe', tool: 'craftRecipe', params: { recipe_name: 'wooden_pickaxe', num: 1 } },
    ], 'llm')

    expect(filtered).toEqual([])
  })

  it('treats craft ingredient preflight failures as deterministic wood bootstrap work', async () => {
    const planner = createAgentWithActions(['moveAway', 'collectBlocks', 'craftRecipe'])
    const plannerAny = planner as any
    const plan = {
      goal: 'Craft a wooden pickaxe',
      status: 'in_progress' as const,
      requiresAction: true,
      steps: [
        { description: 'Craft planks', tool: 'craftRecipe', params: { recipe_name: 'oak_planks', num: 1 } },
        { description: 'Craft stick', tool: 'craftRecipe', params: { recipe_name: 'stick', num: 1 } },
        { description: 'Craft wooden pickaxe', tool: 'craftRecipe', params: { recipe_name: 'wooden_pickaxe', num: 1 } },
      ],
    }
    plannerAny.context = plannerAny.initializeContext(plan.goal)
    plannerAny.context.currentStep = 0
    plannerAny.llmHandler = {
      generatePlan: vi.fn(async () => [
        { description: 'Retry wooden pickaxe directly', tool: 'craftRecipe', params: { recipe_name: 'wooden_pickaxe', num: 1 } },
      ]),
    }

    const adjusted = await planner.adjustPlan(plan, 'Inventory preflight failed (ingredient_missing)', 'system')

    expect(plannerAny.llmHandler.generatePlan).not.toHaveBeenCalled()
    expect(adjusted.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'log')).toBe(true)
    expect(adjusted.steps.some(step => step.tool === 'craftRecipe' && step.params.recipe_name === 'oak_planks')).toBe(true)
  })

  it('recovers missing torch ingredients with coal collection instead of wooden pickaxe bootstrap', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({ stone_pickaxe: 1, stick: 4, furnace: 1 }),
    )
    const plannerAny = planner as any
    const plan = {
      goal: 'Craft torches',
      status: 'in_progress' as const,
      requiresAction: true,
      steps: [
        { description: 'Craft torches', tool: 'craftRecipe', params: { recipe_name: 'torch', num: 1 } },
      ],
    }
    plannerAny.context = plannerAny.initializeContext(plan.goal)
    plannerAny.context.currentStep = 0
    plannerAny.llmHandler = {
      generatePlan: vi.fn(async () => [
        { description: 'Fallback wooden pickaxe', tool: 'craftRecipe', params: { recipe_name: 'wooden_pickaxe', num: 1 } },
      ]),
    }

    const adjusted = await planner.adjustPlan(plan, 'Inventory preflight failed (ingredient_missing)', 'system')

    expect(plannerAny.llmHandler.generatePlan).not.toHaveBeenCalled()
    expect(adjusted.steps.some(step =>
      step.tool === 'craftRecipe' && step.params.recipe_name === 'wooden_pickaxe',
    )).toBe(false)
    expect(adjusted.steps.some(step => step.tool === 'searchForBlock' && step.params.type === 'coal_ore')).toBe(true)
    expect(adjusted.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'coal_ore')).toBe(true)
    expect(adjusted.steps.at(-1)).toMatchObject({
      tool: 'craftRecipe',
      params: { recipe_name: 'torch' },
    })
  })

  it('switches failed surface coal recovery to charcoal instead of retrying buried coal ore', async () => {
    const bot = createBotWithInventory({ furnace: 1, oak_planks: 7, stick: 2, wooden_pickaxe: 1 })
    bot.bot.entity.position = { x: -274.5, y: 63, z: 256.5 }
    const planner = createAgentWithActions(
      ['moveAway', 'searchForBlock', 'collectBlocks', 'placeHere', 'smeltItem', 'craftRecipe'],
      bot,
    )
    const plannerAny = planner as any
    const plan = {
      goal: 'mine coal_ore at (-275, 50, 253)',
      status: 'in_progress' as const,
      requiresAction: true,
      steps: [
        { description: 'Collect coal ore', tool: 'collectBlocks', params: { type: 'coal_ore', num: 1 } },
      ],
    }
    plannerAny.context = plannerAny.initializeContext(plan.goal)
    plannerAny.context.currentStep = 0
    plannerAny.llmHandler = {
      generatePlan: vi.fn(async () => [
        { description: 'Retry coal ore', tool: 'collectBlocks', params: { type: 'coal_ore', num: 1 } },
      ]),
    }

    const adjusted = await planner.adjustPlan(plan, 'collectBlocks failed: coal_ore x1 not found or unreachable', 'system')
    const labels = adjusted.steps.map(step => `${step.tool}:${step.params.type ?? step.params.item_name ?? step.params.recipe_name}`)

    expect(plannerAny.llmHandler.generatePlan).not.toHaveBeenCalled()
    expect(labels).toEqual([
      'searchForBlock:log',
      'collectBlocks:log',
      'placeHere:furnace',
      'smeltItem:log',
    ])
    expect(adjusted.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'coal_ore')).toBe(false)
  })

  it('turns failed underground log collection into surface recovery before retrying logs', async () => {
    const planner = createAgentWithActions(
      ['recoverTowardSurface', 'moveAway', 'searchForBlock', 'collectBlocks'],
      createBotTrappedBelowSurfaceCue(),
    )
    const plannerAny = planner as any
    const plan = {
      goal: 'Recover wood access',
      status: 'in_progress' as const,
      requiresAction: true,
      steps: [
        { description: 'search', tool: 'searchForBlock', params: { type: 'log', search_range: 32 } },
        { description: 'collect', tool: 'collectBlocks', params: { type: 'log', num: 4 } },
      ],
    }

    plannerAny.context = plannerAny.initializeContext(plan.goal)
    plannerAny.context.currentStep = 1

    const adjusted = await planner.adjustPlan(plan, 'collectBlocks failed: log x4 not found or unreachable', 'system')

    expect(adjusted.steps.map(step => step.tool)).toEqual([
      'searchForBlock',
      'recoverTowardSurface',
      'collectBlocks',
    ])
    expect(adjusted.steps[0]?.params.type).toBe('grass_block')
    expect(adjusted.steps[2]?.params.type).toBe('log')
  })

  it('treats open natural ground as surface wood recovery and relocates instead of resurfacing', async () => {
    const planner = createAgentWithActions(
      ['recoverTowardSurface', 'moveAway', 'searchForBlock', 'collectBlocks'],
      createBotWithInventory({}, {
        nearbyBlocks: [{
          x: 1,
          y: 63,
          z: 0,
          distanceTo(other: { x: number, y: number, z: number }) {
            return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
          },
        }],
        blockAt: (position: { x: number, y: number, z: number }) => {
          if (position.y <= 63) {
            return { name: 'grass_block', position }
          }
          return { name: 'air', position }
        },
      }),
    )
    const plannerAny = planner as any
    const plan = {
      goal: 'Recover wood access',
      status: 'in_progress' as const,
      requiresAction: true,
      steps: [
        { description: 'collect', tool: 'collectBlocks', params: { type: 'log', num: 4 } },
      ],
    }

    plannerAny.context = plannerAny.initializeContext(plan.goal)
    plannerAny.context.currentStep = 0

    const adjusted = await planner.adjustPlan(plan, 'collectBlocks failed: log x4 not found or unreachable', 'system')

    expect(adjusted.steps[0]?.tool).toBe('moveAway')
    expect(adjusted.steps.some(step => step.tool === 'recoverTowardSurface')).toBe(false)
    expect(adjusted.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'log')).toBe(true)
  })

  it('switches repeated surface-level wood failures from surface probes to relocation', async () => {
    const planner = createAgentWithActions(
      ['recoverTowardSurface', 'moveAway', 'searchForBlock', 'collectBlocks'],
      createBotTrappedBelowSurfaceCue(),
    )
    const plannerAny = planner as any
    const normalizedFeedback = plannerAny.normalizeFailureFeedback('collectBlocks failed: log x4 not found or unreachable')
    const plan = {
      goal: 'Recover wood access',
      status: 'in_progress' as const,
      requiresAction: true,
      steps: [
        { description: 'collect', tool: 'collectBlocks', params: { type: 'log', num: 4 } },
      ],
    }

    plannerAny.context = plannerAny.initializeContext(plan.goal)
    plannerAny.context.currentStep = 0
    plannerAny.context.failureCounts[normalizedFeedback] = 1

    const adjusted = await planner.adjustPlan(plan, 'collectBlocks failed: log x4 not found or unreachable', 'system')

    expect(adjusted.steps[0]?.tool).toBe('moveAway')
    expect(adjusted.steps.some(step => step.tool === 'recoverTowardSurface')).toBe(false)
    expect(adjusted.steps.some(step => step.tool === 'collectBlocks' && step.params.type === 'log')).toBe(true)
  })

  it('does not bootstrap a new pickaxe when mining recovery already has a sufficient pickaxe in inventory', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory({ stone_pickaxe: 1, cobblestone: 1, stick: 2, oak_planks: 6 }),
    )
    ;(planner as any).context = {
      goal: 'Mine 7 more cobblestone',
      currentStep: 2,
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
    }

    const adjusted = await planner.adjustPlan({
      goal: 'Mine 7 more cobblestone',
      status: 'in_progress',
      requiresAction: true,
      steps: [
        { description: 'ensure pickaxe', tool: 'craftRecipe', params: { recipe_name: 'wooden_pickaxe', num: 1 } },
        { description: 'search stone', tool: 'searchForBlock', params: { type: 'stone', search_range: 64 } },
        { description: 'collect stone', tool: 'collectBlocks', params: { type: 'stone', num: 7 } },
      ],
    }, 'Action verification failed (collectBlocks): inventory_unchanged', 'system')

    expect(adjusted.steps.some(step =>
      step.tool === 'craftRecipe' && step.params.recipe_name === 'wooden_pickaxe',
    )).toBe(false)
    expect(adjusted.steps.some(step => step.tool === 'moveAway')).toBe(true)
    expect(adjusted.steps.some(step => step.tool === 'searchForBlock')).toBe(false)
    expect(adjusted.steps.some(step =>
      step.tool === 'collectBlocks'
      && step.params.type === 'stone'
      && step.params.num === 2,
    )).toBe(true)
  })

  it('uses deterministic move-away recovery for blocked furnace placement', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'placeHere', 'smeltItem'],
      createBotWithInventory({ furnace: 1, raw_iron: 1, coal: 1 }),
    )
    const plannerAny = planner as any
    const generatePlan = vi.fn(async () => [])
    plannerAny.llmHandler = { generatePlan }
    plannerAny.context = {
      goal: 'Place furnace and smelt raw iron into iron ingots',
      currentStep: 0,
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
    }

    const adjusted = await planner.adjustPlan({
      goal: 'Place furnace and smelt raw iron into iron ingots',
      status: 'in_progress',
      requiresAction: true,
      steps: [
        { description: 'Place the furnace before smelting', tool: 'placeHere', params: { type: 'furnace' } },
        { description: 'Smelt raw iron into iron ingots', tool: 'smeltItem', params: { item_name: 'raw_iron', num: 1 } },
      ],
    }, 'placeHere(furnace) failed: placeHere(furnace) failed', 'system')

    expect(generatePlan).not.toHaveBeenCalled()
    expect(adjusted.steps[0]).toMatchObject({
      tool: 'moveAway',
      params: { distance: 12 },
    })
    expect(adjusted.steps[1]).toMatchObject({
      tool: 'placeHere',
      params: { type: 'furnace' },
    })
  })

  it('places a fresh furnace before retrying smelting when a portable furnace remains available', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'placeHere', 'smeltItem'],
      createBotWithInventory({ furnace: 1, raw_iron: 1, coal: 1 }),
    )
    const plannerAny = planner as any
    const generatePlan = vi.fn(async () => [])
    plannerAny.llmHandler = { generatePlan }
    plannerAny.context = {
      goal: 'Place furnace and smelt raw iron into iron ingots',
      currentStep: 1,
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
    }

    const adjusted = await planner.adjustPlan({
      goal: 'Place furnace and smelt raw iron into iron ingots',
      status: 'in_progress',
      requiresAction: true,
      steps: [
        { description: 'Place the furnace before smelting', tool: 'placeHere', params: { type: 'furnace' } },
        { description: 'Smelt raw iron into iron ingots', tool: 'smeltItem', params: { item_name: 'raw_iron', num: 1 } },
      ],
    }, 'smeltItem(raw_ironx1) failed: Furnace screen did not open', 'system')

    expect(generatePlan).not.toHaveBeenCalled()
    expect(adjusted.steps[0]).toMatchObject({
      tool: 'moveAway',
      params: { distance: 12 },
    })
    expect(adjusted.steps[1]).toMatchObject({
      tool: 'placeHere',
      params: { type: 'furnace' },
    })
    expect(adjusted.steps[2]).toMatchObject({
      tool: 'smeltItem',
      params: { item_name: 'raw_iron', num: 1 },
    })
  })

  it('normalizes equivalent combat failures into the same retry bucket', () => {
    const planner = createAgentWithActions(['attack', 'searchForEntity'])
    const plannerAny = planner as any

    const attackBucket = plannerAny.normalizeFailureFeedback('attack(zombie) failed')
    const searchBucket = plannerAny.normalizeFailureFeedback('searchForEntity(zombie) failed')

    expect(attackBucket).toBe('failure:combat-engagement')
    expect(searchBucket).toBe('failure:combat-engagement')
  })

  it('treats cow and generic animal search retries as the same blocked food-search family', () => {
    const planner = createAgentWithActions(['searchForEntity'])
    const plannerAny = planner as any

    const cowFingerprint = plannerAny.planStepSuppressionFingerprint({
      description: 'Search for a cow to collect food',
      tool: 'searchForEntity',
      params: { type: 'cow', search_range: 64 },
    })
    const animalFingerprint = plannerAny.planStepSuppressionFingerprint({
      description: 'Fallback to generic animal search',
      tool: 'searchForEntity',
      params: { type: 'animal', search_range: 160 },
    })

    expect(cowFingerprint).toBe('searchForEntity:type=food-animal')
    expect(animalFingerprint).toBe(cowFingerprint)
  })

  it('treats fish food search retries as the same blocked food-search family', () => {
    const planner = createAgentWithActions(['searchForEntity'])
    const plannerAny = planner as any

    const codFingerprint = plannerAny.planStepSuppressionFingerprint({
      description: 'Search for cod to collect food',
      tool: 'searchForEntity',
      params: { type: 'cod', search_range: 64 },
    })
    const animalFingerprint = plannerAny.planStepSuppressionFingerprint({
      description: 'Fallback to generic animal search',
      tool: 'searchForEntity',
      params: { type: 'animal', search_range: 160 },
    })

    expect(codFingerprint).toBe('searchForEntity:type=food-animal')
    expect(animalFingerprint).toBe(codFingerprint)
  })

  it('suppresses replay-like animal search retries after the food-search family is already blocked', async () => {
    const planner = createAgentWithActions(['moveAway', 'searchForEntity', 'attack'], createBotWithInventory({ beef: 0 }))
    const plannerAny = planner as any
    plannerAny.context = {
      goal: 'Search for animals to collect food',
      currentStep: 1,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: 0,
      failureCounts: {
        'failure:combat-engagement': 1,
      },
      isGenerating: false,
      pendingSteps: [],
      blockedSteps: [],
      lastCapabilityHash: 'cap:test',
      lastStateKey: plannerAny.getPlannerStateKey(),
    }
    plannerAny.llmHandler = {
      generatePlan: async () => [],
    }

    const plan = {
      goal: 'Search for animals to collect food',
      status: 'in_progress' as const,
      requiresAction: true,
      steps: [
        { description: 'Move a bit to re-scan mob spawn area', tool: 'moveAway', params: { distance: 24 } },
        { description: 'Search for a cow to collect food', tool: 'searchForEntity', params: { type: 'cow', search_range: 64 } },
        { description: 'Attack the cow to get food', tool: 'attack', params: { type: 'cow' } },
      ],
    }

    plannerAny.rememberBlockedStep(plan.steps[1], 'combat-engagement', 'searchForEntity(cow) failed')
    const adjusted = await planner.adjustPlan(plan, 'searchForEntity(animal) failed', 'system')

    expect(adjusted.steps).toEqual([
      expect.objectContaining({
        tool: 'moveAway',
        params: expect.objectContaining({ distance: 48 }),
      }),
    ])
  })

  it('turns failed underground animal search into a surface-recovery recovery plan', async () => {
    const planner = createAgentWithActions(
      ['recoverTowardSurface', 'searchForBlock', 'moveAway', 'searchForEntity', 'attack'],
      {
        getBridgeDebugState: () => ({
          capabilitySnapshot: {
            capabilityHash: 'cap:test',
          },
        }),
        bot: {
          entity: {
            position: { x: 0, y: 64, z: 0 },
          },
          inventory: {
            items: () => [],
          },
          findBlocks: () => [{
            x: 1,
            y: 63,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }],
          blockAt: (position: { x: number, y: number, z: number }) => {
            if (position.x === 1 && position.y === 63 && position.z === 0) {
              return { name: 'grass_block', position }
            }
            if (
              Math.abs(position.x) <= 1
              && Math.abs(position.z) <= 1
              && position.y >= 66
              && position.y <= 76
            ) {
              return { name: 'dirt', position }
            }
            if (
              Math.abs(position.x) + Math.abs(position.z) === 1
              && (position.y === 64 || position.y === 65)
            ) {
              return { name: 'stone', position }
            }
            return { name: 'air', position }
          },
        },
      },
    )
    const plannerAny = planner as any
    const plan = {
      goal: 'Collect nearby food',
      status: 'in_progress' as const,
      requiresAction: true,
      steps: [
        { description: 'Search for nearby animals that can provide food', tool: 'searchForEntity', params: { type: 'animal', search_range: 96 } },
        { description: 'Hunt a nearby animal for food', tool: 'attack', params: { type: 'animal' } },
      ],
    }

    plannerAny.context = plannerAny.initializeContext(plan.goal)
    plannerAny.context.currentStep = 0

    const adjusted = await planner.adjustPlan(plan, 'searchForEntity(animal) failed', 'system')

    expect(adjusted.steps.map(step => step.tool)).toEqual([
      'searchForBlock',
      'recoverTowardSurface',
      'searchForEntity',
      'attack',
    ])
  })

  it('treats goal verification as incomplete when no bot is available', async () => {
    const planner = createAgentWithActions(['collectBlocks'])

    await expect((planner as any).verifyGoalCompletion('Collect cobblestone', {
      goal: 'Collect cobblestone',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(false)
  })

  it('treats goal verification as incomplete when inventory access throws', async () => {
    const planner = createAgentWithActions(['collectBlocks'], {
      inventory: {
        items: () => {
          throw new Error('inventory unavailable')
        },
      },
    })

    await expect((planner as any).verifyGoalCompletion('Collect cobblestone', {
      goal: 'Collect cobblestone',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(false)
  })

  it('verifies mixed gather-and-craft goals using the crafted output instead of consumed ingredients', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory({ crafting_table: 1 }),
    )

    await expect((planner as any).verifyGoalCompletion('Gather wood and craft a crafting table', {
      goal: 'Gather wood and craft a crafting table',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('treats a held crafted pickaxe as satisfying craft verification before inventory catches up', async () => {
    const planner = createAgentWithActions(
      ['craftRecipe'],
      createBotWithInventory(
        { oak_planks: 8, stick: 2 },
        {
          heldItem: { name: 'wooden_pickaxe', count: 1 },
        },
      ),
    )

    await expect((planner as any).verifyGoalCompletion('Craft a wooden pickaxe', {
      goal: 'Craft a wooden pickaxe',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('verifies material-specific sword goals from the exact crafted sword', async () => {
    const planner = createAgentWithActions(
      ['craftRecipe'],
      createBotWithInventory({ stone_sword: 1 }),
    )

    await expect((planner as any).verifyGoalCompletion('Craft a stone sword', {
      goal: 'Craft a stone sword',
      steps: [
        { description: 'Craft sword', tool: 'craftRecipe', params: { recipe_name: 'sword', num: 1 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('does not verify stone sword goals from a weaker wooden sword', async () => {
    const planner = createAgentWithActions(
      ['craftRecipe'],
      createBotWithInventory({ wooden_sword: 1 }),
    )

    await expect((planner as any).verifyGoalCompletion('Craft a stone sword', {
      goal: 'Craft a stone sword',
      steps: [
        { description: 'Craft sword', tool: 'craftRecipe', params: { recipe_name: 'sword', num: 1 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(false)
  })

  it('treats a recent crafting-table sync mismatch as satisfied verification for the just-crafted goal', async () => {
    const bot = createBotWithInventory({})
    ;(bot as any).__lastCraftRecipeDiagnostic = {
      at: Date.now(),
      kind: 'inventory_sync_mismatch',
      itemName: 'crafting_table',
      inventoryOnly: true,
    }
    const planner = createAgentWithActions(['craftRecipe'], bot)

    await expect((planner as any).verifyGoalCompletion('Craft a crafting table', {
      goal: 'Craft a crafting table',
      steps: [
        { description: 'Craft a crafting table', tool: 'craftRecipe', params: { recipe_name: 'crafting_table', num: 1 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('does not verify mixed crafting-table-and-furnace goals after crafting only the table', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory({ crafting_table: 1 }),
    )

    await expect((planner as any).verifyGoalCompletion('Craft a crafting table and then a furnace using the collected cobblestone', {
      goal: 'Craft a crafting table and then a furnace using the collected cobblestone',
      steps: [
        { description: 'Craft a crafting table', tool: 'craftRecipe', params: { recipe_name: 'crafting_table', num: 1 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(false)
  })

  it('does not require iron ingots when a furnace craft goal only mentions preparing for smelting', async () => {
    const planner = createAgentWithActions(
      ['craftRecipe', 'smeltItem'],
      createBotWithInventory({ furnace: 1 }),
    )

    await expect((planner as any).verifyGoalCompletion('Craft a furnace using the cobblestone in my inventory to prepare for smelting iron.', {
      goal: 'Craft a furnace using the cobblestone in my inventory to prepare for smelting iron.',
      steps: [
        { description: 'Craft a furnace', tool: 'craftRecipe', params: { recipe_name: 'furnace', num: 1 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('counts equipped diamond armor toward full diamond armor verification', async () => {
    const planner = createAgentWithActions(
      ['craftRecipe'],
      createBotWithInventory(
        {},
        {
          armor: [
            { slot: 5, name: 'diamond_helmet' },
            { slot: 6, name: 'diamond_chestplate' },
            { slot: 7, name: 'diamond_leggings' },
            { slot: 8, name: 'diamond_boots' },
          ],
        },
      ),
    )

    await expect((planner as any).verifyGoalCompletion('Craft full diamond armor', {
      goal: 'Craft full diamond armor',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('treats nearby crafting-table access as satisfying autonomy craft-table bootstrap goals', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        {},
        {
          nearbyBlocks: [{
            x: 1,
            y: 64,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }] as any,
          blockAt: position => ({
            name: position.x === 1 && position.y === 64 && position.z === 0 ? 'crafting_table' : 'air',
            position,
          }),
        },
      ),
    )

    await expect((planner as any).verifyGoalCompletion('Gather wood and craft a crafting table', {
      goal: 'Gather wood and craft a crafting table',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('returns a completed plan when a crafting table is already accessible before planning', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        {},
        {
          nearbyBlocks: [{
            x: 1,
            y: 64,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }] as any,
          blockAt: position => ({
            name: position.x === 1 && position.y === 64 && position.z === 0 ? 'crafting_table' : 'air',
            position,
          }),
        },
      ),
    )

    const plan = await planner.createPlan('Craft a crafting table')

    expect(plan).toMatchObject({
      goal: 'Craft a crafting table',
      status: 'completed',
      requiresAction: false,
      steps: [],
    })
  })

  it('approaches a visible crafting table instead of rebuilding one from wood', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        {},
        {
          nearbyBlocks: [{
            x: 12,
            y: 64,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }] as any,
          blockAt: position => ({
            name: position.x === 12 && position.y === 64 && position.z === 0 ? 'crafting_table' : 'air',
            position,
          }),
        },
      ),
    )

    const plan = await planner.createPlan('Craft a crafting table')

    expect(plan.steps).toEqual([expect.objectContaining({
      tool: 'searchForBlock',
      params: { type: 'crafting_table', search_range: 24 },
    })])
  })

  it('retreats before approaching a visible crafting table when low-health hostiles are nearby', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        {},
        {
          health: 6,
          entities: {
            zombie1: {
              type: 'mob',
              name: 'zombie',
              position: { x: 3, y: 64, z: 0 },
            },
          },
          nearbyBlocks: [{
            x: 12,
            y: 64,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }] as any,
          blockAt: position => ({
            name: position.x === 12 && position.y === 64 && position.z === 0 ? 'crafting_table' : 'air',
            position,
          }),
        },
      ),
    )

    const plan = await planner.createPlan('Craft a crafting table')

    expect(plan.steps).toEqual([
      expect.objectContaining({
        tool: 'moveAway',
        params: { distance: 24 },
      }),
      expect.objectContaining({
        tool: 'searchForBlock',
        params: { type: 'crafting_table', search_range: 24 },
      }),
    ])
  })

  it('treats the recently placed crafting table cache as satisfying craft-table verification', async () => {
    const bot = createBotWithInventory({})
    ;(bot as any).__lastPlacedCraftingTable = {
      x: 1,
      y: 64,
      z: 0,
      at: Date.now(),
    }
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      bot,
    )

    await expect((planner as any).verifyGoalCompletion('Gather wood and craft a crafting table', {
      goal: 'Gather wood and craft a crafting table',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('treats a visible crafting table within normal interaction reach as satisfying verification', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        {},
        {
          nearbyBlocks: [{
            x: 4,
            y: 64,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }] as any,
          blockAt: position => ({
            name: position.x === 4 && position.y === 64 && position.z === 0 ? 'crafting_table' : 'air',
            position,
          }),
        },
      ),
    )

    await expect((planner as any).verifyGoalCompletion('Craft a crafting table', {
      goal: 'Craft a crafting table',
      steps: [
        { description: 'Move to the visible crafting table', tool: 'searchForBlock', params: { type: 'crafting_table', search_range: 24 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('does not treat a nearby crafting table as satisfying Japanese wooden-tool bootstrap goals', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        {},
        {
          nearbyBlocks: [{
            x: 1,
            y: 64,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }] as any,
          blockAt: position => ({
            name: position.x === 1 && position.y === 64 && position.z === 0 ? 'crafting_table' : 'air',
            position,
          }),
        },
      ),
    )

    const plan = await planner.createPlan('近くのオークの原木を伐採して、作業台と木製ツールを作成する')

    expect(plan).toMatchObject({
      status: 'pending',
      requiresAction: true,
    })
    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'collectBlocks',
        params: { type: 'log', num: expect.any(Number) },
      }),
      expect.objectContaining({
        tool: 'craftRecipe',
        params: { recipe_name: 'wooden_pickaxe', num: 1 },
      }),
    ]))
  })

  it('does not treat a nearby crafting table as satisfying bare Japanese wood acquisition goals', async () => {
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        {},
        {
          nearbyBlocks: [{
            x: 1,
            y: 64,
            z: 0,
            distanceTo(other: { x: number, y: number, z: number }) {
              return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
            },
          }] as any,
          blockAt: position => ({
            name: position.x === 1 && position.y === 64 && position.z === 0 ? 'crafting_table' : 'air',
            position,
          }),
        },
      ),
    )

    const plan = await planner.createPlan('近くの木を入手して作業台を作成し、夜間の安全を確保する')

    expect(plan).toMatchObject({
      status: 'pending',
      requiresAction: true,
    })
    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'collectBlocks',
        params: { type: 'log', num: expect.any(Number) },
      }),
    ]))
    expect(plan.steps).not.toEqual([
      expect.objectContaining({
        tool: 'searchForBlock',
        params: { type: 'crafting_table', search_range: 24 },
      }),
    ])
  })

  it('prepends an immediate hostile disengage step for low-health structured crafting work', async () => {
    const planner = createAgentWithActions(
      ['moveAway', 'collectBlocks', 'craftRecipe'],
      createBotWithInventory(
        {},
        {
          health: 6,
          entities: {
            zombie1: {
              type: 'mob',
              name: 'zombie',
              position: { x: 3, y: 64, z: 0 },
            },
          },
        },
      ),
    )

    const plan = await planner.createPlan('Craft a crafting table')

    expect(plan.steps[0]).toMatchObject({
      tool: 'moveAway',
      params: { distance: 24 },
    })
  })

  it('keeps post-craft collection requirements when a goal continues after crafting', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory({ wooden_pickaxe: 1 }),
    )

    await expect((planner as any).verifyGoalCompletion('Craft a wooden pickaxe and mine 3 cobblestone', {
      goal: 'Craft a wooden pickaxe and mine 3 cobblestone',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(false)
  })

  it('verifies craft-and-mine goals only after both crafted and collected outputs exist', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory({ wooden_pickaxe: 1, cobblestone: 3 }),
    )

    await expect((planner as any).verifyGoalCompletion('Craft a wooden pickaxe and mine 3 cobblestone', {
      goal: 'Craft a wooden pickaxe and mine 3 cobblestone',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('does not treat quick-loot inventory goals as missing-item collection work during verification', async () => {
    const planner = createAgentWithActions(['discard'])

    await expect((planner as any).verifyGoalCompletion('Organize inventory and keep a quick-loot slot open', {
      goal: 'Organize inventory and keep a quick-loot slot open',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('does not fail abstract base-safety goals when no concrete item target is present', async () => {
    const planner = createAgentWithActions(['moveAway'], createBotWithInventory({}))

    await expect((planner as any).verifyGoalCompletion('現在の拠点まわりの安全を整える', {
      goal: '現在の拠点まわりの安全を整える',
      steps: [
        { description: 'Move to a safer nearby area', tool: 'moveAway', params: { distance: 16 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('verification replans only the remaining cobblestone after partial mining progress', async () => {
    const counts = { stone_pickaxe: 1, cobblestone: 8 }
    const planner = createAgentWithActions(
      ['searchForBlock', 'collectBlocks', 'craftRecipe'],
      {
        bot: {
          inventory: {
            items: () => Object.entries(counts).map(([name, count]) => ({ name, count })),
          },
        },
      },
    )
    const plannerAny = planner as any
    const performAction = vi.fn(async (step: any) => {
      if (step.tool === 'collectBlocks') {
        counts.cobblestone = 16
      }
    })
    plannerAny.actionAgent = {
      getAvailableActions: () => ['searchForBlock', 'collectBlocks', 'craftRecipe'].map(name => ({
        name,
        description: '',
        schema: z.object({}),
        perform: () => async () => '',
      })),
      performAction,
    }
    plannerAny.generatePlanSteps = vi.fn(async () => [])

    await expect(plannerAny.verifyGoalCompletion('Mine 16 cobblestone', {
      goal: 'Mine 16 cobblestone',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)

    expect(performAction).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'collectBlocks',
      params: expect.objectContaining({
        type: 'stone',
        num: 8,
      }),
    }))
    expect(plannerAny.generatePlanSteps).not.toHaveBeenCalled()
  })

  it('aborts verification additions after a failed wood prerequisite before crafting-table retry', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory({}),
    )
    const plannerAny = planner as any
    const performAction = vi.fn(async (step: any) => {
      if (step.tool === 'collectBlocks') {
        throw new Error('collectBlocks failed: log x4 not found or unreachable')
      }
    })
    plannerAny.actionAgent = {
      getAvailableActions: () => ['collectBlocks', 'craftRecipe'].map(name => ({
        name,
        description: '',
        schema: z.object({}),
        perform: () => async () => '',
      })),
      performAction,
    }
    plannerAny.generatePlanSteps = vi.fn(async () => [
      { description: 'Craft crafting table directly', tool: 'craftRecipe', params: { recipe_name: 'crafting_table', num: 1 } },
    ])

    await expect(plannerAny.verifyGoalCompletion('Craft a crafting table', {
      goal: 'Craft a crafting table',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(false)

    expect(performAction).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'collectBlocks',
      params: expect.objectContaining({ type: 'log' }),
    }))
    expect(performAction.mock.calls.some(([step]) => step.tool === 'craftRecipe')).toBe(false)
  })

  it('treats real edible items as satisfying generic food collection goals', async () => {
    const planner = createAgentWithActions(
      ['searchForEntity', 'attack'],
      createBotWithInventory({ beef: 2 }),
    )

    await expect((planner as any).verifyGoalCompletion('Collect nearby food', {
      goal: 'Collect nearby food',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('does not treat full hunger as collected food for generic food collection goals', async () => {
    const planner = createAgentWithActions(
      ['searchForEntity', 'attack'],
      createBotWithInventory({}, { food: 20, health: 20 }),
    )

    await expect((planner as any).verifyGoalCompletion('Collect nearby food', {
      goal: 'Collect nearby food',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(false)
  })

  it('does not verify low-hunger food recovery just because edible food is still in inventory', async () => {
    const planner = createAgentWithActions(
      ['searchForEntity', 'attack'],
      createBotWithInventory({ salmon: 1 }, { food: 5, health: 11 }),
    )

    await expect((planner as any).verifyGoalCompletion('食料を確保して生存を安定させる', {
      goal: '食料を確保して生存を安定させる',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(false)
  })

  it('consumes available food during low-hunger verification until hunger is stable', async () => {
    const counts = { salmon: 4 }
    const bot = createBotWithInventory(counts, { food: 5, health: 11 })
    const planner = createAgentWithActions(['consume', 'searchForEntity', 'attack'], bot)
    const plannerAny = planner as any
    const performAction = vi.fn(async (step: any) => {
      if (step.tool !== 'consume') {
        return
      }
      counts.salmon = Math.max(0, counts.salmon - 1)
      bot.bot.food = Math.min(20, bot.bot.food + 5)
    })
    plannerAny.actionAgent = {
      getAvailableActions: () => ['consume', 'searchForEntity', 'attack'].map(name => ({
        name,
        description: '',
        schema: z.object({}),
        perform: () => async () => '',
      })),
      performAction,
    }

    await expect(plannerAny.verifyGoalCompletion('食料を確保して生存を安定させる', {
      goal: '食料を確保して生存を安定させる',
      steps: [],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)

    expect(performAction).toHaveBeenCalledTimes(3)
    expect(performAction).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'consume',
      params: { item_name: 'food' },
    }))
  })

  it('treats mined ore drops as satisfying ore collection goals', async () => {
    const ironPlanner = createAgentWithActions(
      ['collectBlocks'],
      createBotWithInventory({ raw_iron: 2 }),
    )
    const coalPlanner = createAgentWithActions(
      ['collectBlocks'],
      createBotWithInventory({ coal: 2 }),
    )

    await expect((ironPlanner as any).verifyGoalCompletion('Mine iron ore', {
      goal: 'Mine iron ore',
      steps: [
        { description: 'Collect iron ore', tool: 'collectBlocks', params: { type: 'iron_ore', num: 3 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)

    await expect((coalPlanner as any).verifyGoalCompletion('Mine the nearby coal ore', {
      goal: 'Mine the nearby coal ore',
      steps: [
        { description: 'Collect coal ore', tool: 'collectBlocks', params: { type: 'coal_ore', num: 3 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)

    await expect((coalPlanner as any).verifyGoalCompletion('mine coal_ore at (-347.0, 46.0, 301.0)', {
      goal: 'mine coal_ore at (-347.0, 46.0, 301.0)',
      steps: [
        { description: 'Collect coal ore', tool: 'collectBlocks', params: { type: 'coal_ore', num: 1 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('keeps torch-creation goals incomplete until torch output exists', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks', 'craftRecipe'],
      createBotWithInventory({ coal: 2 }),
    )

    await expect((planner as any).verifyGoalCompletion('Mine the nearby coal ore to create torches', {
      goal: 'Mine the nearby coal ore to create torches',
      steps: [
        { description: 'Collect coal ore', tool: 'collectBlocks', params: { type: 'coal_ore', num: 3 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(false)
  })

  it('accepts any visible log variant when the active plan intentionally collects generic logs', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks'],
      createBotWithInventory({ oak_log: 4 }),
    )

    await expect((planner as any).verifyGoalCompletion('Collect 4 birch logs from nearby blocks', {
      goal: 'Collect 4 birch logs from nearby blocks',
      steps: [
        { description: 'Search for logs', tool: 'searchForBlock', params: { type: 'log', search_range: 64 } },
        { description: 'Collect logs', tool: 'collectBlocks', params: { type: 'log', num: 4 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(true)
  })

  it('still requires the exact wood variant when the plan did not generalize collection to generic logs', async () => {
    const planner = createAgentWithActions(
      ['collectBlocks'],
      createBotWithInventory({ oak_log: 4 }),
    )

    await expect((planner as any).verifyGoalCompletion('Collect 4 birch logs from nearby blocks', {
      goal: 'Collect 4 birch logs from nearby blocks',
      steps: [
        { description: 'Collect birch logs', tool: 'collectBlocks', params: { type: 'birch_log', num: 4 } },
      ],
      status: 'pending',
      requiresAction: true,
    })).resolves.toBe(false)
  })

  it('fails execution when goal verification still reports missing requirements', async () => {
    const planner = createAgentWithActions(['collectBlocks'])
    const plannerAny = planner as any
    plannerAny.verifyGoalCompletion = vi.fn(async () => false)
    plannerAny.actionAgent = {
      getAvailableActions: () => [{
        name: 'collectBlocks',
        description: '',
        schema: z.object({}),
        perform: () => async () => '',
      }],
      performAction: vi.fn(async () => {}),
    }

    const plan = {
      goal: 'Collect cobblestone',
      steps: [
        { description: 'Collect one cobblestone', tool: 'collectBlocks', params: { type: 'cobblestone', num: 1 } },
      ],
      status: 'pending',
      requiresAction: true,
    } as any

    await expect(planner.executePlan(plan)).rejects.toThrow('Goal verification failed')
  })
})
