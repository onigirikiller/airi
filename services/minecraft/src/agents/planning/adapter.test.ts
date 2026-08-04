import { afterEach, describe, expect, it, vi } from 'vitest'

import { config } from '../../composables/config'
import { PlanningLLMHandler } from './adapter'

// Access private methods for testing via prototype
function parsePlanResponse(content: string, validToolNames: string[]) {
  const handler = new PlanningLLMHandler()
  return (handler as any).parsePlanResponse(content, validToolNames)
}

function buildUserPrompt(goal: string, sender: string, worldState: string, feedback?: string) {
  const handler = new PlanningLLMHandler()
  return (handler as any).buildUserPrompt(goal, sender, worldState, feedback)
}

function getFallbackPlan(goal: string, validToolNames: string[], worldStateHints?: any, feedback?: string) {
  const handler = new PlanningLLMHandler()
  return (handler as any).getFallbackPlan(goal, validToolNames, worldStateHints, feedback)
}

const VALID_TOOLS = ['searchForBlock', 'searchForEntity', 'collectBlocks', 'moveAway', 'goToCoordinates', 'stats', 'attack', 'craftRecipe', 'consume', 'smeltItem', 'placeHere']
const SURFACE_RECOVERY_TOOLS = ['recoverTowardSurface', ...VALID_TOOLS]
const ORIGINAL_AUTONOMY_CONFIG = { ...config.autonomyLlm }

afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(config.autonomyLlm, ORIGINAL_AUTONOMY_CONFIG)
})

describe('planningLLMHandler.parsePlanResponse', () => {
  describe('jSON parsing', () => {
    it('parses valid JSON with steps array', () => {
      const json = JSON.stringify({
        steps: [
          { description: 'Search for logs', tool: 'searchForBlock', params: { type: 'log', search_range: 64 } },
          { description: 'Collect logs', tool: 'collectBlocks', params: { type: 'log', num: 4 } },
        ],
      })

      const steps = parsePlanResponse(json, VALID_TOOLS)
      expect(steps).toHaveLength(2)
      expect(steps[0].tool).toBe('searchForBlock')
      expect(steps[0].params.type).toBe('log')
      expect(steps[1].tool).toBe('collectBlocks')
      expect(steps[1].params.num).toBe(4)
    })

    it('filters out steps with invalid tool names from JSON', () => {
      const json = JSON.stringify({
        steps: [
          { description: 'Valid step', tool: 'searchForBlock', params: {} },
          { description: 'Invalid tool', tool: 'inventedTool', params: {} },
          { description: 'Another valid', tool: 'moveAway', params: { distance: 10 } },
        ],
      })

      const steps = parsePlanResponse(json, VALID_TOOLS)
      expect(steps).toHaveLength(2)
      expect(steps[0].tool).toBe('searchForBlock')
      expect(steps[1].tool).toBe('moveAway')
    })

    it('caps at 3 steps from JSON', () => {
      const json = JSON.stringify({
        steps: [
          { description: 's1', tool: 'searchForBlock', params: {} },
          { description: 's2', tool: 'collectBlocks', params: {} },
          { description: 's3', tool: 'moveAway', params: {} },
          { description: 's4', tool: 'stats', params: {} },
        ],
      })

      const steps = parsePlanResponse(json, VALID_TOOLS)
      expect(steps).toHaveLength(3)
    })

    it('handles missing params gracefully', () => {
      const json = JSON.stringify({
        steps: [
          { description: 'Check stats', tool: 'stats' },
        ],
      })

      const steps = parsePlanResponse(json, VALID_TOOLS)
      expect(steps).toHaveLength(1)
      expect(steps[0].params).toEqual({})
    })

    it('handles bare array (no wrapping object)', () => {
      const json = JSON.stringify([
        { description: 'Move', tool: 'moveAway', params: { distance: 20 } },
      ])

      const steps = parsePlanResponse(json, VALID_TOOLS)
      expect(steps).toHaveLength(1)
      expect(steps[0].tool).toBe('moveAway')
    })

    it('extracts embedded JSON from fenced or prefixed content', () => {
      const text = `Plan draft:
\`\`\`json
{"steps":[{"description":"Search for logs","tool":"searchForBlock","params":{"type":"log","search_range":64}}]}
\`\`\``

      const steps = parsePlanResponse(text, VALID_TOOLS)
      expect(steps).toHaveLength(1)
      expect(steps[0].tool).toBe('searchForBlock')
      expect(steps[0].params.type).toBe('log')
    })
  })

  describe('text fallback parsing', () => {
    it('parses numbered text format', () => {
      const text = `1. Search for logs nearby
   Tool: searchForBlock
   Params:
     type: log
     search_range: 64

2. Collect 4 logs
   Tool: collectBlocks
   Params:
     type: log
     num: 4`

      const steps = parsePlanResponse(text, VALID_TOOLS)
      expect(steps).toHaveLength(2)
      expect(steps[0].tool).toBe('searchForBlock')
      expect(steps[0].params.type).toBe('log')
      expect(steps[1].tool).toBe('collectBlocks')
    })

    it('filters out invalid tool names in text format', () => {
      const text = `1. Do something
   Tool: 原木を探す
   Params:
     type: log

2. Move away
   Tool: moveAway
   Params:
     distance: 20`

      const steps = parsePlanResponse(text, VALID_TOOLS)
      expect(steps).toHaveLength(1)
      expect(steps[0].tool).toBe('moveAway')
    })

    it('filters out empty tool names', () => {
      const text = `1. Just a description without tool

2. Valid step
   Tool: stats
   Params:`

      const steps = parsePlanResponse(text, VALID_TOOLS)
      expect(steps).toHaveLength(1)
      expect(steps[0].tool).toBe('stats')
    })

    it('filters out tools not in validToolNames', () => {
      const text = `1. Search for block
   Tool: searchForBlock
   Params:
     type: log

2. Fake tool
   Tool: flyToMoon
   Params:`

      const steps = parsePlanResponse(text, VALID_TOOLS)
      expect(steps).toHaveLength(1)
      expect(steps[0].tool).toBe('searchForBlock')
    })
  })
})

describe('planningLLMHandler environment-aware prompting', () => {
  it('uses native Ollama chat with thinking disabled for planning requests', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: {
        content: '{"steps":[{"description":"Search for logs","tool":"searchForBlock","params":{"type":"log","search_range":64}}]}',
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    const steps = await handler.generatePlan('Collect 1 log', [
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
    ] as any, 'autonomy')

    const [url, init] = (fetchMock as any).mock.calls[0] as [string, any]
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>

    expect(url).toBe('http://localhost:11434/api/chat')
    expect(body.think).toBe(false)
    expect(body.stream).toBe(false)
    expect(body.format).toBeTruthy()
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'system' })
    expect(messages[1]).toMatchObject({ role: 'user' })
    expect(steps).toHaveLength(1)
    expect(steps[0].tool).toBe('searchForBlock')
  })

  it('uses OpenAI-compatible json_object mode for official OpenAI planning requests', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-terra',
    })

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"steps":[{"description":"Search for logs","tool":"searchForBlock","params":{"type":"log","search_range":64}}]}',
        },
      }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    const steps = await handler.generatePlan('Collect 1 log', [
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
    ] as any, 'autonomy')

    const init = (fetchMock as any).mock.calls[0]?.[1] as any
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>

    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.reasoning_effort).toBe('none')
    expect(body.max_completion_tokens).toBe(1024)
    expect(body.max_tokens).toBeUndefined()
    expect(steps).toHaveLength(1)
    expect(steps[0].tool).toBe('searchForBlock')
  })

  it('uses Gemini native generateContent for Google-hosted planning requests', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'Gemini 2.5 Flash',
    })

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: '{"steps":[{"description":"Search for logs","tool":"searchForBlock","params":{"type":"log","search_range":64}}]}',
          }],
        },
      }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    const steps = await handler.generatePlan('Collect 1 log', [
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
    ] as any, 'autonomy')

    const [url, init] = (fetchMock as any).mock.calls[0] as [string, any]
    const body = JSON.parse(init?.body ?? '{}') as Record<string, any>

    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gemini-key')
    expect(init?.headers?.authorization).toBeUndefined()
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(String(body.contents[0].parts[0].text)).toContain('Return only JSON')
    expect(steps).toHaveLength(1)
    expect(steps[0].tool).toBe('searchForBlock')
  })

  it('repairs invalid prose-only planner output into JSON before falling back', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemma-4-31b-it',
    })

    const fetchMock = vi.fn(async (_url, init: any) => {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, any>
      const promptText = String(body?.contents?.[0]?.parts?.[0]?.text ?? '')
      if (promptText.includes('Fix the previous invalid Minecraft bot plan')) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: '{"steps":[{"description":"Search for logs","tool":"searchForBlock","params":{"type":"log","search_range":64}}]}',
              }],
            },
          }],
        }), { status: 200 })
      }

      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: '* Goal: Collect nearby oak logs.\n* Current State: Inventory empty.\n* Nearby Blocks: oak_log.',
            }],
          },
        }],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    const steps = await handler.generatePlan('Collect nearby oak logs', [
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
      {
        name: 'collectBlocks',
        description: 'Collect nearby blocks',
        schema: { shape: { type: {}, num: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(steps).toHaveLength(1)
    expect(steps[0].tool).toBe('searchForBlock')
  })

  it('short-circuits to a deterministic bootstrap fallback before calling the planner LLM', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    vi.spyOn(handler as any, 'buildWorldStatePrompt').mockResolvedValue([
      'terrain_context: surface_forest',
      'wood_access: good',
      'pickaxe_access: missing',
      'surface_escape_needed: false',
    ].join('\n'))

    const steps = await handler.generatePlan('近くの原木を伐採して原木を集め、作業台と木ツールを作成する', [
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
      {
        name: 'collectBlocks',
        description: 'Collect nearby blocks',
        schema: { shape: { type: {}, num: {} } },
      },
      {
        name: 'craftRecipe',
        description: 'Craft a recipe',
        schema: { shape: { recipe_name: {}, num: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(steps).toHaveLength(2)
    expect(steps[0].tool).toBe('searchForBlock')
    expect(steps[1].tool).toBe('collectBlocks')
  })

  it('short-circuits english starter log goals to the same bootstrap fallback', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    vi.spyOn(handler as any, 'buildWorldStatePrompt').mockResolvedValue([
      'terrain_context: surface_forest',
      'wood_access: good',
      'pickaxe_access: missing',
      'surface_escape_needed: false',
    ].join('\n'))

    const steps = await handler.generatePlan('Gather 4 logs near spawn', [
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
      {
        name: 'collectBlocks',
        description: 'Collect nearby blocks',
        schema: { shape: { type: {}, num: {} } },
      },
      {
        name: 'craftRecipe',
        description: 'Craft a recipe',
        schema: { shape: { recipe_name: {}, num: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(steps).toHaveLength(2)
    expect(steps[0].tool).toBe('searchForBlock')
    expect(steps[1].tool).toBe('collectBlocks')
    expect(steps[1].params.num).toBe(4)
  })

  it('short-circuits underground surface recovery goals before calling the planner LLM', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    vi.spyOn(handler as any, 'buildWorldStatePrompt').mockResolvedValue([
      'terrain_context: underground_cave',
      'wood_access: poor',
      'pickaxe_access: missing',
      'surface_escape_needed: true',
    ].join('\n'))

    const steps = await handler.generatePlan('Escape to the surface to gather wood', [
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
      {
        name: 'collectBlocks',
        description: 'Collect nearby blocks',
        schema: { shape: { type: {}, num: {} } },
      },
      {
        name: 'moveAway',
        description: 'Move away',
        schema: { shape: { distance: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(steps).toHaveLength(3)
    expect(steps[0].tool).toBe('searchForBlock')
    expect(steps[0].params.type).toBe('grass_block')
    expect(steps[1].tool).toBe('moveAway')
    expect(steps[1].params.distance).toBe(32)
    expect(steps[2].tool).toBe('collectBlocks')
    expect(steps[2].params.type).toBe('log')
  })

  it('prefers recoverTowardSurface for surface escape goals when the tool exists', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    vi.spyOn(handler as any, 'buildWorldStatePrompt').mockResolvedValue([
      'terrain_context: underground_cave',
      'wood_access: poor',
      'pickaxe_access: missing',
      'surface_escape_needed: true',
    ].join('\n'))

    const steps = await handler.generatePlan('Escape to the surface to gather wood', [
      {
        name: 'recoverTowardSurface',
        description: 'Recover toward the surface',
        schema: { shape: { reason: {} } },
      },
      {
        name: 'collectBlocks',
        description: 'Collect nearby blocks',
        schema: { shape: { type: {}, num: {} } },
      },
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(steps).toHaveLength(2)
    expect(steps[0].tool).toBe('recoverTowardSurface')
    expect(steps[0].params.reason).toBe('surface_recovery_goal')
    expect(steps[1].tool).toBe('collectBlocks')
    expect(steps[1].params.type).toBe('log')
  })

  it('short-circuits iron mining goals to deterministic mining steps', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    vi.spyOn(handler as any, 'buildWorldStatePrompt').mockResolvedValue('')

    const steps = await handler.generatePlan('Mine iron ore', [
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
      {
        name: 'collectBlocks',
        description: 'Collect nearby blocks',
        schema: { shape: { type: {}, num: {} } },
      },
      {
        name: 'craftRecipe',
        description: 'Craft a recipe',
        schema: { shape: { recipe_name: {}, num: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(steps).toHaveLength(3)
    expect(steps[0].tool).toBe('craftRecipe')
    expect(steps[0].params.recipe_name).toBe('stone_pickaxe')
    expect(steps[1].tool).toBe('searchForBlock')
    expect(steps[1].params.type).toBe('iron_ore')
    expect(steps[2].tool).toBe('collectBlocks')
    expect(steps[2].params.type).toBe('iron_ore')
  })

  it('short-circuits stone mining goals to a wooden-pickaxe bootstrap instead of requiring stone tools first', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    vi.spyOn(handler as any, 'buildWorldStatePrompt').mockResolvedValue('')

    const steps = await handler.generatePlan('Mine cobblestone from nearby stone blocks', [
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
      {
        name: 'collectBlocks',
        description: 'Collect nearby blocks',
        schema: { shape: { type: {}, num: {} } },
      },
      {
        name: 'craftRecipe',
        description: 'Craft a recipe',
        schema: { shape: { recipe_name: {}, num: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(steps).toHaveLength(3)
    expect(steps[0].tool).toBe('craftRecipe')
    expect(steps[0].params.recipe_name).toBe('wooden_pickaxe')
    expect(steps[1].params.type).toBe('stone')
    expect(steps[2].params.type).toBe('stone')
  })

  it('keeps coordinate-targeted mining goals scoped to one block instead of parsing the coordinates as item count', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    vi.spyOn(handler as any, 'buildWorldStatePrompt').mockResolvedValue('')

    const steps = await handler.generatePlan('Mine the iron ore at (-404.0, 44.0, 191.0)', [
      {
        name: 'searchForBlock',
        description: 'Search for a nearby block',
        schema: { shape: { type: {}, search_range: {} } },
      },
      {
        name: 'goToCoordinates',
        description: 'Move to known coordinates',
        schema: { shape: { x: {}, y: {}, z: {}, closeness: {} } },
      },
      {
        name: 'collectBlocks',
        description: 'Collect nearby blocks',
        schema: { shape: { type: {}, num: {} } },
      },
      {
        name: 'craftRecipe',
        description: 'Craft a recipe',
        schema: { shape: { recipe_name: {}, num: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(steps).toHaveLength(3)
    expect(steps[1].tool).toBe('goToCoordinates')
    expect(steps[1].params).toMatchObject({ x: -404, y: 44, z: 191, closeness: 4 })
    expect(steps[2].tool).toBe('collectBlocks')
    expect(steps[2].params.type).toBe('iron_ore')
    expect(steps[2].params.num).toBe(1)
  })

  it('short-circuits smelt goals to deterministic furnace steps', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    vi.spyOn(handler as any, 'buildWorldStatePrompt').mockResolvedValue('')

    const steps = await handler.generatePlan('Smelt the raw iron using the furnace', [
      {
        name: 'craftRecipe',
        description: 'Craft a recipe',
        schema: { shape: { recipe_name: {}, num: {} } },
      },
      {
        name: 'smeltItem',
        description: 'Smelt an item',
        schema: { shape: { item_name: {}, num: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(steps).toHaveLength(2)
    expect(steps[0].tool).toBe('craftRecipe')
    expect(steps[0].params.recipe_name).toBe('furnace')
    expect(steps[1].tool).toBe('smeltItem')
    expect(steps[1].params.item_name).toBe('raw_iron')
  })

  it('uses shelter-specific fallback steps instead of wood tool bootstrap', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler()
    vi.spyOn(handler as any, 'buildWorldStatePrompt').mockResolvedValue('')

    const steps = await handler.generatePlan('Build a small cobblestone shelter to survive the night', [
      {
        name: 'placeHere',
        description: 'Place a block here',
        schema: { shape: { type: {} } },
      },
      {
        name: 'moveAway',
        description: 'Move away',
        schema: { shape: { distance: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(steps).toHaveLength(3)
    expect(steps[0].tool).toBe('placeHere')
    expect(steps[0].params.type).toBe('cobblestone')
    expect(steps[1].tool).toBe('placeHere')
    expect(steps[1].params.type).toBe('cobblestone')
    expect(steps[2].tool).toBe('moveAway')
  })

  it('prefers currently held shelter blocks for generic night-shelter fallback goals', async () => {
    Object.assign(config.autonomyLlm, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma4:e4b',
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handler = new PlanningLLMHandler({
      bot: {
        inventory: {
          items: () => [
            { name: 'oak_log', count: 56 },
            { name: 'dirt', count: 3 },
          ],
        },
      },
    } as any)
    vi.spyOn(handler as any, 'buildWorldStatePrompt').mockResolvedValue('')

    const steps = await handler.generatePlan('Establish a lit temporary shelter before night combat escalates', [
      {
        name: 'placeHere',
        description: 'Place a block here',
        schema: { shape: { type: {} } },
      },
      {
        name: 'moveAway',
        description: 'Move away',
        schema: { shape: { distance: {} } },
      },
    ] as any, 'autonomy')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(steps).toHaveLength(3)
    expect(steps[0].tool).toBe('placeHere')
    expect(steps[0].params.type).toBe('dirt')
    expect(steps[1].tool).toBe('placeHere')
    expect(steps[1].params.type).toBe('dirt')
    expect(steps[2].tool).toBe('moveAway')
  })

  it('injects underground recovery guidance into the user prompt', () => {
    const prompt = buildUserPrompt(
      'Explore nearby terrain for useful resources',
      'autonomy',
      [
        'terrain_context: underground_cave',
        'wood_access: poor',
        'pickaxe_access: missing',
        'surface_escape_needed: true',
      ].join('\n'),
    )

    expect(prompt).toContain('Do not search for logs in place')
    expect(prompt).toContain('Do not continue cave exploration or ore mining')
    expect(prompt).toContain('Surface escape is needed')
  })

  it('preserves compact progression facts in the planner prompt', () => {
    const prompt = buildUserPrompt(
      'Mine iron ore',
      'autonomy',
      [
        'terrain_context: underground_cave',
        'inventory_hotbar: slot1=stone_pickaxe, slot4=bread',
        'progress_milestone: iron-acquisition',
        'progress_needs: iron-ore, torches',
        'progress_blockers: none',
        'progress_next_goals: Mine iron ore | Craft torches and prepare for caves',
        'progress_capabilities: craft=stone_pickaxe | smelt=charcoal | mine=iron_ore',
      ].join('\n'),
    )

    expect(prompt).toContain('progress_milestone: iron-acquisition')
    expect(prompt).toContain('progress_needs: iron-ore, torches')
    expect(prompt).toContain('progress_next_goals: Mine iron ore | Craft torches and prepare for caves')
  })

  it('uses moveAway as fallback when underground bootstrap is blocked', () => {
    const steps = getFallbackPlan(
      'Explore nearby terrain for useful resources',
      VALID_TOOLS,
      {
        terrainContext: 'underground_cave',
        woodAccess: 'poor',
        pickaxeAccess: 'missing',
        surfaceEscapeNeeded: true,
      },
    )

    expect(steps).toHaveLength(1)
    expect(steps[0].tool).toBe('moveAway')
    expect(steps[0].params.distance).toBe(48)
  })

  it('uses recoverTowardSurface as fallback when underground bootstrap is blocked and the tool exists', () => {
    const steps = getFallbackPlan(
      'Explore nearby terrain for useful resources',
      SURFACE_RECOVERY_TOOLS,
      {
        terrainContext: 'underground_cave',
        woodAccess: 'poor',
        pickaxeAccess: 'missing',
        surfaceEscapeNeeded: true,
      },
    )

    expect(steps).toHaveLength(1)
    expect(steps[0].tool).toBe('recoverTowardSurface')
    expect(steps[0].params.reason).toBe('underground_bootstrap_blocked')
  })

  it('does not inflate fallback collection counts beyond the explicit goal amount', () => {
    const steps = getFallbackPlan(
      'Move to the nearby oak log and collect 1 log before crafting a table',
      VALID_TOOLS,
    )

    expect(steps).toHaveLength(2)
    expect(steps[0].tool).toBe('searchForBlock')
    expect(steps[1].tool).toBe('collectBlocks')
    expect(steps[1].params.num).toBe(1)
  })

  it('uses real combat tools for food fallback goals', () => {
    const steps = getFallbackPlan(
      'Collect nearby food',
      VALID_TOOLS,
    )

    expect(steps).toHaveLength(2)
    expect(steps[0].tool).toBe('searchForEntity')
    expect(steps[0].params.type).toBe('animal')
    expect(steps[1].tool).toBe('attack')
    expect(steps[1].params.type).toBe('animal')
  })

  it('uses consume when the fallback goal is to eat available food', () => {
    const steps = getFallbackPlan(
      'Consume available food',
      VALID_TOOLS,
    )

    expect(steps).toHaveLength(1)
    expect(steps[0].tool).toBe('consume')
    expect(steps[0].params.item_name).toBe('')
  })

  it('builds exact craftRecipe fallback steps for explicit craft goals', () => {
    const steps = getFallbackPlan(
      'Craft a diamond pickaxe',
      VALID_TOOLS,
    )

    expect(steps).toHaveLength(1)
    expect(steps[0].tool).toBe('craftRecipe')
    expect(steps[0].params.recipe_name).toBe('diamond_pickaxe')
  })

  it('uses iron-specific fallback steps for mine iron ore goals', () => {
    const steps = getFallbackPlan(
      'Mine iron ore',
      VALID_TOOLS,
    )

    expect(steps).toHaveLength(3)
    expect(steps[0].tool).toBe('craftRecipe')
    expect(steps[0].params.recipe_name).toBe('stone_pickaxe')
    expect(steps[1].tool).toBe('searchForBlock')
    expect(steps[1].params.type).toBe('iron_ore')
    expect(steps[2].tool).toBe('collectBlocks')
    expect(steps[2].params.type).toBe('iron_ore')
  })

  it('does not treat mining coordinates as fallback quantities', () => {
    const steps = getFallbackPlan(
      'Mine the iron ore at (-404.0, 44.0, 191.0)',
      VALID_TOOLS,
    )

    expect(steps).toHaveLength(3)
    expect(steps[1].tool).toBe('goToCoordinates')
    expect(steps[1].params).toMatchObject({ x: -404, y: 44, z: 191, closeness: 4 })
    expect(steps[2].tool).toBe('collectBlocks')
    expect(steps[2].params.type).toBe('iron_ore')
    expect(steps[2].params.num).toBe(1)
  })

  it('prioritizes the still-missing mining target when fallback is guided by feedback', () => {
    const steps = getFallbackPlan(
      'Mine nearby coal and iron ores',
      VALID_TOOLS,
      undefined,
      'Goal was executed but coal is still missing from inventory.',
    )

    expect(steps).toHaveLength(3)
    expect(steps[0].tool).toBe('craftRecipe')
    expect(steps[0].params.recipe_name).toBe('wooden_pickaxe')
    expect(steps[1].tool).toBe('searchForBlock')
    expect(steps[1].params.type).toBe('coal_ore')
    expect(steps[2].tool).toBe('collectBlocks')
    expect(steps[2].params.type).toBe('coal_ore')
  })
})
