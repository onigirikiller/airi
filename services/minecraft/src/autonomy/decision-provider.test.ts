import type { WorldFacts } from './preconditions'
import type { AutonomyDecisionContext } from './types'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GeminiAutonomyDecisionProvider, normalizeIntentGoalText, RuleBasedAutonomyDecisionProvider } from './decision-provider'

function makeFacts(overrides: Partial<WorldFacts> = {}): WorldFacts {
  return {
    health: 20,
    food: 20,
    hasCraftingTable: true,
    hasFurnace: false,
    woodCount: 10,
    stoneCount: 0,
    cobblestoneCount: 0,
    ironIngotCount: 0,
    ironOreCount: 0,
    diamondCount: 0,
    coalCount: 0,
    foodItemCount: 0,
    torchCount: 0,
    equipmentTier: 'none',
    pickaxeTier: 'none',
    hasPickaxe: false,
    hasIronPickaxe: false,
    hasDiamondPickaxe: false,
    hasAxe: false,
    hasSword: false,
    hasShield: false,
    hasDiamondHelmet: false,
    hasDiamondChestplate: false,
    hasDiamondLeggings: false,
    hasDiamondBoots: false,
    diamondArmorPieceCount: 0,
    timeOfDay: 'day',
    nearbyHostileCount: 0,
    dimension: 'minecraft:overworld',
    position: { x: 0, y: 64, z: 0 },
    obsidianCount: 0,
    blazeRodCount: 0,
    blazePowderCount: 0,
    enderPearlCount: 0,
    enderEyeCount: 0,
    hasFlintAndSteel: false,
    hasBow: false,
    arrowCount: 0,
    runnerPhase: 'UNKNOWN',
    runnerPhaseStep: 0,
    ...overrides,
  }
}

function makeContext(worldFacts: WorldFacts, worldState = 'inventory: oak_log x 10'): AutonomyDecisionContext {
  return {
    nowIso: new Date('2026-03-22T08:00:00+09:00').toISOString(),
    botName: 'AIra',
    activeGoal: null,
    activeGoalElapsedMs: 0,
    status: 'ok',
    worldState,
    nearbyPlayers: [],
    recentActions: [],
    candidateSelfGoals: [],
    recentSignals: [],
    socialWeights: {
      selfGoal: 1,
      social: 0.7,
      comment: 0.25,
    },
    conversationContext: {
      recentViewerMessages: [],
      recentAssistantMessages: [],
      suggestedAdjustments: [],
    },
    worldFacts,
  }
}

function createLogger() {
  const logger: any = {
    log: vi.fn(),
    warn: vi.fn(),
    withFields: vi.fn(),
    withField: vi.fn(),
    withError: vi.fn(),
  }
  logger.withFields.mockImplementation(() => logger)
  logger.withField.mockImplementation(() => logger)
  logger.withError.mockImplementation(() => logger)
  return logger
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('ruleBasedAutonomyDecisionProvider', () => {
  it('maps shorthand surface recovery goal ids into executable text goals', () => {
    expect(normalizeIntentGoalText('surface_escape')).toBe('Escape to the surface to gather wood')
    expect(normalizeIntentGoalText('dig_upwards_to_reach_surface')).toBe('Dig upwards to reach the surface')
  })

  it('keeps early bootstrap on wooden pickaxe before mild hunger recovery', async () => {
    const provider = new RuleBasedAutonomyDecisionProvider()

    const intent = await provider.decide(makeContext(makeFacts({
      food: 4,
      health: 10,
      hasCraftingTable: true,
      hasPickaxe: false,
      woodCount: 10,
    })))

    expect(intent.goal).toBe('Craft a wooden pickaxe')
  })

  it('still prioritizes food when hunger is critical before early bootstrap is complete', async () => {
    const provider = new RuleBasedAutonomyDecisionProvider()

    const intent = await provider.decide(makeContext(makeFacts({
      food: 2,
      health: 5,
      hasCraftingTable: true,
      hasPickaxe: false,
      woodCount: 10,
    })))

    expect(intent.goal).toBe('Collect nearby food')
  })

  it('consumes held food before asking for more when hunger recovery is needed', async () => {
    const provider = new RuleBasedAutonomyDecisionProvider()

    const intent = await provider.decide(makeContext(makeFacts({
      food: 3,
      health: 8,
      hasCraftingTable: true,
      hasPickaxe: true,
      foodItemCount: 2,
    })))

    expect(intent.goal).toBe('Consume available food')
  })

  it('chooses iron smelting once ore, furnace, and fuel are ready', async () => {
    const provider = new RuleBasedAutonomyDecisionProvider()

    const intent = await provider.decide(makeContext(makeFacts({
      hasCraftingTable: true,
      hasFurnace: true,
      hasPickaxe: true,
      equipmentTier: 'stone',
      pickaxeTier: 'stone',
      cobblestoneCount: 24,
      coalCount: 6,
      torchCount: 8,
      ironOreCount: 5,
      ironIngotCount: 0,
      foodItemCount: 6,
    }), 'inventory: crafting_table x 1, furnace x 1, stone_pickaxe x 1, raw_iron x 5, coal x 6, torch x 8'))

    expect(intent.goal).toBe('Smelt raw iron into iron ingots')
  })

  it('prefers surface resupply when iron-tier cave progression is ready but supplies are too thin underground', async () => {
    const provider = new RuleBasedAutonomyDecisionProvider()

    const intent = await provider.decide(makeContext(makeFacts({
      hasFurnace: true,
      hasPickaxe: true,
      hasIronPickaxe: true,
      hasSword: true,
      hasShield: true,
      equipmentTier: 'iron',
      pickaxeTier: 'iron',
      ironIngotCount: 9,
      coalCount: 31,
      torchCount: 4,
      foodItemCount: 0,
      nearbyHostileCount: 6,
      position: { x: -463, y: 64, z: 255 },
    }), [
      'dimension: overworld',
      'sky_access: enclosed',
      'terrain_context: underground_cave',
      'surface_escape_needed: true',
      'held_item: iron_pickaxe x1',
      'equipped_armor: none',
      'inventory: iron_pickaxe x1, iron_sword x1, shield x1, birch_log x5, crafting_table x1, furnace x1, torch x4, iron_ingot x9, coal x31',
      'nearby_entities: zombie @ 5.0m, skeleton @ 7.0m',
    ].join('\n')))

    expect(intent.goal).toBe('Escape to the surface to resupply food and torches for deeper mining')
  })
})

describe('geminiAutonomyDecisionProvider ollama extraction', () => {
  it('salvages a json object from ollama thinking when content is empty', async () => {
    const provider = new GeminiAutonomyDecisionProvider({
      enabled: true,
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
      liveModel: '',
      useLiveApi: false,
      temperature: 0.1,
      maxOutputTokens: 512,
      logger: createLogger(),
    })

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      model: 'gemma4:e4b',
      message: {
        role: 'assistant',
        content: '',
        thinking: 'analysis... {"goal":"Collect nearby food","focus":"self","confidence":0.62,"reason":"thinking-json"}',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any

    const intent = await provider.decide(makeContext(makeFacts()))

    expect(intent.goal).toBe('Collect nearby food')
    expect(intent.reason).toBe('thinking-json')
  })

  it('retries ollama decisions with a larger token budget after thinking-only responses', async () => {
    const logger = createLogger()
    const provider = new GeminiAutonomyDecisionProvider({
      enabled: true,
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
      liveModel: '',
      useLiveApi: false,
      temperature: 0.1,
      maxOutputTokens: 512,
      logger,
    })

    const seenBudgets: number[] = []
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      expect(payload.think).toBe(false)
      seenBudgets.push(payload.options.num_predict)
      const firstAttempt = seenBudgets.length === 1
      return new Response(JSON.stringify({
        model: 'gemma4:e4b',
        message: {
          role: 'assistant',
          content: firstAttempt
            ? ''
            : '{"goal":"Craft a wooden pickaxe","focus":"self","confidence":0.7,"reason":"retry-success"}',
          thinking: firstAttempt ? 'long analysis without final json yet' : '',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as any

    const intent = await provider.decide(makeContext(makeFacts()))

    expect(intent.goal).toBe('Craft a wooden pickaxe')
    expect(seenBudgets).toEqual([128, 512])
    expect(logger.warn).toHaveBeenCalled()
  })

  it('skips slow json repair retries for non-social ollama gameplay decisions', async () => {
    const logger = createLogger()
    const provider = new GeminiAutonomyDecisionProvider({
      enabled: true,
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:8b-no-think',
      liveModel: '',
      useLiveApi: false,
      temperature: 0.1,
      maxOutputTokens: 512,
      logger,
    })

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      model: 'qwen3:8b-no-think',
      message: {
        role: 'assistant',
        content: 'goal: gather wood first',
        thinking: '',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    globalThis.fetch = fetchMock as any

    const intent = await provider.decide(makeContext(makeFacts()))

    expect(intent.goal).toBeUndefined()
    expect(intent.speak).toBeUndefined()
    expect(intent.reason).toContain('non-parseable intent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries Gemini native HTTP decisions once after an abort and still returns a parsed intent', async () => {
    const logger = createLogger()
    const provider = new GeminiAutonomyDecisionProvider({
      enabled: true,
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash',
      liveModel: '',
      useLiveApi: false,
      temperature: 0.1,
      maxOutputTokens: 512,
      logger,
    })

    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        const error = new Error('This operation was aborted')
        ;(error as Error & { name: string }).name = 'AbortError'
        throw error
      }

      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{ text: '{"goal":"Mine iron ore","focus":"self","confidence":0.66,"reason":"retry-success"}' }],
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const intent = await provider.decide(makeContext(makeFacts({
      hasCraftingTable: true,
      hasPickaxe: true,
      cobblestoneCount: 20,
    })))

    expect(intent.goal).toBe('Mine iron ore')
    expect(intent.reason).toBe('retry-success')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('injects compact structured memory facts into decision prompts instead of raw histories', async () => {
    const logger = createLogger()
    const provider = new GeminiAutonomyDecisionProvider({
      enabled: true,
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash',
      liveModel: '',
      useLiveApi: false,
      temperature: 0.1,
      maxOutputTokens: 512,
      logger,
    })

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      const promptText = String(payload?.contents?.[0]?.parts?.[0]?.text ?? '')
      expect(promptText).toContain('memory_active_milestone: iron-acquisition')
      expect(promptText).toContain('memory_last_action: collectBlocks:failed:movement_stall')
      expect(promptText).toContain('memory_repeated_failures: movement_stall x2 @ Reach cave mouth')
      expect(promptText).toContain('target_spec: long-run-diamond-home')
      expect(promptText).toContain('objective_recommended:')
      expect(promptText).toContain('objective_candidates:')

      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: '{"goal":"Mine iron ore","focus":"self","confidence":0.7,"reason":"memory-aware"}',
            }],
          },
        }],
      }), { status: 200 })
    })
    globalThis.fetch = fetchMock as any

    const intent = await provider.decide({
      ...makeContext(makeFacts({
        hasPickaxe: true,
        equipmentTier: 'stone',
        pickaxeTier: 'stone',
        cobblestoneCount: 24,
        torchCount: 8,
      })),
      structuredMemory: {
        snapshot: {
          activeGoals: ['Mine iron ore'],
          recentSubgoals: ['Reach cave mouth'],
          lastActionOutcome: 'collectBlocks:failed:movement_stall',
          lastFailureClass: 'movement_stall',
          repeatedFailures: ['movement_stall x2 @ Reach cave mouth'],
          discoveries: ['coal x3'],
          unresolvedNeeds: ['iron-ore', 'torches'],
          activeMilestone: 'iron-acquisition',
          abandonedPlan: '',
          gainedResources: ['coal x3'],
          lostResources: [],
          recentMotifFamilies: ['failure:movement_stall'],
        },
        plannerFacts: [
          'memory_active_goals: Mine iron ore',
          'memory_last_action: collectBlocks:failed:movement_stall',
          'memory_repeated_failures: movement_stall x2 @ Reach cave mouth',
          'memory_active_milestone: iron-acquisition',
        ],
        narrationFacts: [],
      },
    })

    expect(intent.goal).toBe('Mine iron ore')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('realigns generic self-goals to the top recommended objective under urgent underground supply gaps', async () => {
    const logger = createLogger()
    const provider = new GeminiAutonomyDecisionProvider({
      enabled: true,
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
      liveModel: '',
      useLiveApi: false,
      temperature: 0.1,
      maxOutputTokens: 512,
      logger,
    })

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      model: 'gemma4:e4b',
      message: {
        role: 'assistant',
        content: '{"goal":"近くの地形を探り有用な資源を見つける","focus":"self","confidence":0.61,"reason":"generic-self-goal"}',
        thinking: '',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any

    const intent = await provider.decide({
      ...makeContext(makeFacts({
        hasFurnace: true,
        hasPickaxe: true,
        hasIronPickaxe: true,
        hasSword: true,
        hasShield: true,
        equipmentTier: 'iron',
        pickaxeTier: 'iron',
        ironIngotCount: 9,
        coalCount: 31,
        torchCount: 4,
        foodItemCount: 0,
        nearbyHostileCount: 6,
        position: { x: -463, y: 64, z: 255 },
      }), [
        'dimension: overworld',
        'sky_access: enclosed',
        'terrain_context: underground_cave',
        'surface_escape_needed: true',
        'held_item: iron_pickaxe x1',
        'equipped_armor: none',
        'inventory: iron_pickaxe x1, iron_sword x1, shield x1, birch_log x5, crafting_table x1, furnace x1, torch x4, iron_ingot x9, coal x31',
        'nearby_entities: zombie @ 5.0m, skeleton @ 7.0m',
      ].join('\n')),
      candidateSelfGoals: ['近くの地形を探り有用な資源を見つける'],
    })

    expect(intent.goal).toBe('Escape to the surface to resupply food and torches for deeper mining')
    expect(intent.reason).toContain('generic-self-goal')
    expect(intent.reason).toContain('Re-aligned to the top survival objective')
  })
})
