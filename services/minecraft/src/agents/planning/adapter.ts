import type { Agent } from 'neuri'

import type { Mineflayer } from '../../libs/mineflayer'
import type { Action } from '../../libs/mineflayer/action'

import { agent } from 'neuri'

import { runInInferenceLane } from '../../autonomy/inference-lane'
import { config } from '../../composables/config'
import { withSerializedGpuTask } from '../../libs/gpu-coordinator'
import { generateWorldStatePrompt } from '../../libs/llm-agent/world-state'
import { assertOpenAITokenBudget, isTokenBudgetError, recordOpenAIResponseUsage } from '../../libs/llm-usage/token-budget'
import { emitFallbackMonitor } from '../../libs/monitor-event-bus'
import { useLogger } from '../../utils/logger'

export async function createPlanningNeuriAgent(): Promise<Agent> {
  return agent('planning').build()
}

export interface PlanStep {
  description: string
  tool: string
  params: Record<string, unknown>
  meta?: {
    goalId?: string
    subgoalId?: string
    currentMilestone?: string
    retryBudget?: number
    plannerSource?: 'llm' | 'deterministic-fast-path' | 'deterministic-coal-charcoal-fallback' | 'recovery' | 'cache'
    blockedReason?: string
  }
}

interface WorldStateHints {
  terrainContext: string
  woodAccess: string
  pickaxeAccess: string
  surfaceEscapeNeeded: boolean
  mobilityState: string
  surfaceEscapeScaffold: string
}

interface PlanJsonSchema {
  type: 'object'
  properties: {
    steps: {
      type: 'array'
      maxItems: number
      items: {
        type: 'object'
        properties: {
          description: { type: 'string' }
          tool: { enum: string[] }
          params: { type: 'object' }
        }
        required: string[]
      }
    }
  }
  required: string[]
}

function compactCsvItems(raw: string, maxItems: number): string {
  const items = raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)

  if (items.length <= maxItems) {
    return items.join(', ') || 'none'
  }

  return `${items.slice(0, maxItems).join(', ')}, ... (+${items.length - maxItems} more)`
}

function compactNotableBlocks(raw: string, maxItems: number): string {
  const items = raw
    .split('|')
    .map(item => item.trim())
    .filter(Boolean)
    .map((item) => {
      const compacted = item.replace(/\s*\([^)]*\)\s*$/, '').trim()
      return compacted || item
    })

  if (items.length <= maxItems) {
    return items.join(' | ') || 'none'
  }

  return `${items.slice(0, maxItems).join(' | ')} | ... (+${items.length - maxItems} more)`
}

function compactPlanningWorldState(worldState: string): string {
  const keepKeys = new Set([
    'dimension',
    'biome',
    'position',
    'health',
    'food',
    'oxygen',
    'sky_access',
    'terrain_context',
    'wood_access',
    'surface_escape_needed',
    'mobility_state',
    'surface_escape_scaffold',
    'pickaxe_access',
    'axe_access',
    'wood_materials',
    'held_item',
    'equipped_armor',
    'inventory',
    'inventory_selected_slot',
    'inventory_held_item',
    'inventory_free_slots',
    'inventory_hotbar',
    'inventory_ready_items',
    'inventory_capabilities',
    'inventory_alerts',
    'inventory_desync',
    'inventory_task_readiness',
    'bridge_capabilities',
    'progress_milestone',
    'progress_needs',
    'progress_blockers',
    'progress_next_goals',
    'progress_capabilities',
    'nearby_players',
    'nearby_entities',
    'nearby_blocks',
    'notable_blocks',
    'immediate_terrain',
  ])

  const compactedLines = worldState
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const separatorIndex = line.indexOf(':')
      if (separatorIndex < 0) {
        return []
      }

      const key = line.slice(0, separatorIndex).trim()
      const value = line.slice(separatorIndex + 1).trim()
      if (!keepKeys.has(key)) {
        return []
      }

      switch (key) {
        case 'inventory':
        case 'progress_needs':
        case 'progress_blockers':
          return [`${key}: ${compactCsvItems(value, 10)}`]
        case 'nearby_entities':
          return [`${key}: ${compactCsvItems(value, 6)}`]
        case 'nearby_blocks':
          return [`${key}: ${compactCsvItems(value, 12)}`]
        case 'notable_blocks':
        case 'progress_next_goals':
          return [`${key}: ${compactNotableBlocks(value, 6)}`]
        default:
          return [line]
      }
    })

  return compactedLines
    .slice(0, Math.max(4, config.autonomy.maxPlannerContextItems))
    .join('\n')
}

function isEarlyWoodBootstrapGoal(goal: string, worldStateHints?: WorldStateHints): boolean {
  if (!worldStateHints) {
    return false
  }

  const normalizedGoal = normalizeFallbackGoalText(goal)
  const isBareStarterLogGoal = /(?:^| )gather \d+ logs?(?: near spawn)?(?: |$)/.test(normalizedGoal)
  const wantsWood = [
    'wood',
    'log',
    'tree',
    '原木',
    '木材',
    '丸太',
  ].some(keyword => goal.includes(keyword) || normalizedGoal.includes(keyword))
  const wantsWorkbenchOrWoodenTools = [
    'crafting_table',
    'crafting table',
    'tool',
    'wooden',
    '作業台',
    '木ツール',
    '木のツール',
  ].some(keyword => goal.includes(keyword) || normalizedGoal.includes(keyword))

  if (!wantsWood || (!wantsWorkbenchOrWoodenTools && !isBareStarterLogGoal)) {
    return false
  }

  const hasSafeWoodAccess = worldStateHints.woodAccess === 'good' && !worldStateHints.surfaceEscapeNeeded
  const needsStarterTools = worldStateHints.pickaxeAccess === 'missing' || worldStateHints.pickaxeAccess === 'craftable_from_inventory'
  return hasSafeWoodAccess && needsStarterTools
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function isLikelyOllamaBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  return normalized.includes('127.0.0.1:11434')
    || normalized.includes('localhost:11434')
    || normalized.includes('ollama')
}

function isGeminiNativeBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  return normalized.includes('generativelanguage.googleapis.com') && !normalized.includes('/openai')
}

function isOpenAICompatibleBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  if (!normalized) {
    return false
  }

  if (normalized.includes('generativelanguage.googleapis.com') && normalized.includes('/openai')) {
    return true
  }

  return normalized.endsWith('/openai')
    || normalized.endsWith('/openai/v1')
    || normalized.endsWith('/v1')
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  return normalized.includes('api.openai.com')
}

function normalizeGoogleHostedModelName(model: string): string {
  const trimmed = model.trim()
  const normalized = trimmed.toLowerCase()

  switch (normalized) {
    case 'gemma 4 26b':
    case 'gemma4:e4b':
    case 'gemma4:e2b':
      return 'gemma-4-26b-a4b-it'
    case 'gemma 4 31b':
      return 'gemma-4-31b-it'
    case 'gemini 2.5 flash':
      return 'gemini-2.5-flash'
    case 'gemini 3.1 flash lite':
      return 'gemini-3.1-flash-lite-preview'
    default:
      return trimmed
  }
}

interface PlannerMessage {
  role: 'system' | 'user'
  content: string
}

function normalizeModelForBaseUrl(baseUrl: string, model: string): string {
  if (!normalizeBaseUrl(baseUrl).toLowerCase().includes('generativelanguage.googleapis.com')) {
    return model.trim()
  }

  return normalizeGoogleHostedModelName(model)
}

function shouldSendAuthorizationHeader(baseUrl: string): boolean {
  return !isLikelyOllamaBaseUrl(baseUrl) && !isGeminiNativeBaseUrl(baseUrl)
}

function isOllamaModelLoadFailureBody(body: string): boolean {
  const normalized = body.toLowerCase()
  return normalized.includes('model failed to load')
    || normalized.includes('resource limitations')
}

const DEFAULT_OLLAMA_NUM_CTX = 4096
const FALLBACK_OLLAMA_NUM_CTX = 2048
const OLLAMA_KEEP_ALIVE = '0'
const OLLAMA_PLAN_NUM_PREDICT = 256
const OLLAMA_PLAN_REQUEST_TIMEOUT_MS = 20_000
const OPENAI_PLAN_REQUEST_TIMEOUT_MS = 60_000
const OLLAMA_PLAN_MAX_ATTEMPTS = 2
const OPENAI_PLAN_MAX_ATTEMPTS = 2

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'AbortError'
  }

  if (!(error instanceof Error)) {
    return false
  }

  return error.name === 'AbortError'
    || error.message.toLowerCase().includes('aborted')
    || error.message.toLowerCase().includes('timeout')
}

function extractContentFromResponse(data: any): string {
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string')
    return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }
  return ''
}

function removeCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) {
    return trimmed
  }

  const firstNewLine = trimmed.indexOf('\n')
  if (firstNewLine < 0) {
    return trimmed
  }

  const closingFence = trimmed.lastIndexOf('```')
  if (closingFence <= firstNewLine) {
    return trimmed
  }

  return trimmed.slice(firstNewLine + 1, closingFence).trim()
}

function extractJsonLiteral(text: string): unknown {
  const normalized = removeCodeFence(text)
  try {
    return JSON.parse(normalized)
  }
  catch {
    // Fall through to substring extraction.
  }

  const candidates: Array<{ open: string, close: string }> = [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
  ]

  for (const { open, close } of candidates) {
    const first = normalized.indexOf(open)
    const last = normalized.lastIndexOf(close)
    if (first < 0 || last <= first) {
      continue
    }

    try {
      return JSON.parse(normalized.slice(first, last + 1))
    }
    catch {
      // Keep trying the next candidate shape.
    }
  }

  return null
}

function buildPlanJsonSchema(toolNames: string[]): PlanJsonSchema {
  return {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            tool: { enum: toolNames },
            params: { type: 'object' },
          },
          required: ['description', 'tool'],
        },
      },
    },
    required: ['steps'],
  }
}

function extractWorldStateHints(worldState: string): WorldStateHints {
  const read = (key: string): string => {
    const line = worldState
      .split('\n')
      .find(entry => entry.toLowerCase().startsWith(`${key.toLowerCase()}:`))
    return line ? line.slice(line.indexOf(':') + 1).trim() : ''
  }

  return {
    terrainContext: read('terrain_context'),
    woodAccess: read('wood_access'),
    pickaxeAccess: read('pickaxe_access'),
    surfaceEscapeNeeded: read('surface_escape_needed') === 'true',
    mobilityState: read('mobility_state'),
    surfaceEscapeScaffold: read('surface_escape_scaffold'),
  }
}

function compactHttpErrorBody(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500)
}

/* eslint-disable regexp/no-dupe-disjunctions */
// NOTICE: Planner fallback only needs the first explicit quantity in the goal.
// The regex is intentionally permissive because the goal text may mix English and Japanese unit suffixes.
function inferRequestedCount(goal: string, fallbackCount: number): number {
  const sanitizedGoal = goal
    .replace(/\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/g, ' ')
    .replace(/\b[xyz]\s*[=:]\s*-?\d+(?:\.\d+)?\b/gi, ' ')
  const match = sanitizedGoal.match(/(\d{1,3})\s*(?:[本個つ枚台回]|logs?|log|ores?|ore|blocks?|block|stones?|stone|wood|trees?)?/i)
  if (!match) {
    return fallbackCount
  }

  const parsed = Number.parseInt(match[1] || '', 10)
  if (Number.isNaN(parsed)) {
    return fallbackCount
  }

  return Math.max(1, Math.min(64, parsed))
}
/* eslint-enable regexp/no-dupe-disjunctions */

function hasSpecificBlockTarget(goal: string): boolean {
  return /\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/.test(goal)
}

function extractTargetCoordinates(goal: string): { x: number, y: number, z: number } | null {
  const match = goal.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/)
  if (!match) {
    return null
  }

  const [, rawX, rawY, rawZ] = match
  const x = Number.parseFloat(rawX || '')
  const y = Number.parseFloat(rawY || '')
  const z = Number.parseFloat(rawZ || '')
  if (![x, y, z].every(Number.isFinite)) {
    return null
  }

  return { x, y, z }
}

function inferMiningTargetCount(goal: string, fallbackCount: number): number {
  return inferRequestedCount(goal, hasSpecificBlockTarget(goal) ? 1 : fallbackCount)
}

function normalizeFallbackGoalText(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/pick[\s_-]*axe/g, 'pickaxe')
    .replace(/crafting\s+table/g, 'crafting_table')
    .replace(/dark\s+oak/g, 'dark_oak')
    .replace(/[^a-z0-9_ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildPlanRepairPrompt(
  originalSystemPrompt: string,
  originalUserPrompt: string,
  brokenOutput: string,
  validToolNames: string[],
): string {
  const clippedOutput = brokenOutput.replace(/\s+/g, ' ').trim().slice(0, 1400)
  const clippedUserPrompt = originalUserPrompt.slice(-2200)
  const allowedTools = validToolNames.join(', ') || '(none)'

  return [
    'Fix the previous invalid Minecraft bot plan into one valid JSON object.',
    'Return JSON only. No markdown and no explanation.',
    'Schema: {"steps":[{"description":"...","tool":"...","params":{...}}]}',
    'Use 1 to 3 actionable steps only.',
    `Allowed tools: ${allowedTools}`,
    'tool must be exactly one allowed tool name.',
    'Do not echo Goal:, Current State:, or any world-state summary.',
    'Use the original goal and world state to produce the steps again.',
    '',
    `broken_output: ${clippedOutput || '(empty)'}`,
    '',
    `original_system_prompt:\n${originalSystemPrompt.slice(0, 2000)}`,
    '',
    `original_user_prompt:\n${clippedUserPrompt}`,
  ].join('\n')
}

function extractPrioritizedMiningTargets(goal: string, feedback?: string): string[] {
  const resolved: string[] = []
  const pushUnique = (target: string): void => {
    if (!resolved.includes(target)) {
      resolved.push(target)
    }
  }

  const sources = [
    feedback || '',
    goal,
  ]

  for (const source of sources) {
    const normalized = normalizeFallbackGoalText(source)
    if (!normalized) {
      continue
    }

    if (normalized.includes('coal')) {
      pushUnique('coal_ore')
    }
    if (normalized.includes('iron') || normalized.includes('raw_iron')) {
      pushUnique('iron_ore')
    }
    if (normalized.includes('diamond')) {
      pushUnique('diamond_ore')
    }
    if (normalized.includes('cobblestone') || normalized.includes('stone')) {
      pushUnique('stone')
    }
  }

  return resolved
}

function getRequiredPickaxeRecipeForTarget(target: string): string | undefined {
  if (target === 'diamond_ore' || target === 'gold_ore' || target === 'redstone_ore' || target === 'emerald_ore') {
    return 'iron_pickaxe'
  }

  if (target === 'iron_ore' || target === 'deepslate_iron_ore' || target === 'lapis_ore') {
    return 'stone_pickaxe'
  }

  if (
    target === 'stone'
    || target === 'cobblestone'
    || target === 'coal_ore'
    || target === 'deepslate_coal_ore'
    || target === 'copper_ore'
    || target === 'deepslate_copper_ore'
  ) {
    return 'wooden_pickaxe'
  }

  return undefined
}

function inferLeadingCraftRecipe(goal: string): string | undefined {
  const normalized = normalizeFallbackGoalText(goal)
  if (!/^(?:craft|make|build|create|assemble|prepare|forge)\b/.test(normalized)) {
    return undefined
  }

  const underscored = normalized.replace(/\s+/g, '_')
  if (underscored.includes('crafting_table')) {
    return 'crafting_table'
  }

  if (underscored.includes('furnace')) {
    return 'furnace'
  }

  const exactItemMatch = underscored.match(/(?:^|_)(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots)(?:_|$)/)
  if (!exactItemMatch) {
    return undefined
  }

  return `${exactItemMatch[1]}_${exactItemMatch[2]}`
}

function buildFoodFallbackPlan(goal: string, toolSet: Set<string>): PlanStep[] {
  if (toolSet.has('searchForEntity') && toolSet.has('attack')) {
    return [
      { description: 'Search for nearby animals that drop food', tool: 'searchForEntity', params: { type: 'animal', search_range: 64 } },
      { description: 'Attack a nearby animal for food', tool: 'attack', params: { type: 'animal' } },
    ]
  }

  if (toolSet.has('searchForBlock') && toolSet.has('collectBlocks')) {
    return [
      { description: 'Search for nearby edible crops', tool: 'searchForBlock', params: { type: 'wheat', search_range: 64 } },
      { description: 'Collect edible crops', tool: 'collectBlocks', params: { type: 'wheat', num: inferRequestedCount(goal, 3) } },
    ]
  }

  if (toolSet.has('collectBlocks')) {
    return [{ description: 'Collect edible crops', tool: 'collectBlocks', params: { type: 'wheat', num: inferRequestedCount(goal, 3) } }]
  }

  return []
}

function buildConsumeFallbackPlan(toolSet: Set<string>): PlanStep[] {
  if (!toolSet.has('consume')) {
    return []
  }

  return [
    {
      description: 'Consume the best available food item',
      tool: 'consume',
      params: { item_name: '' },
    },
  ]
}

function buildSmeltFallbackPlan(goal: string, toolSet: Set<string>): PlanStep[] {
  const normalized = normalizeFallbackGoalText(goal)
  if (!/^(?:smelt|cook)\b/.test(normalized)) {
    return []
  }

  if (!normalized.includes('raw_iron') && !normalized.includes('iron_ingot') && !normalized.includes('raw iron') && !normalized.includes('iron ingot')) {
    return []
  }

  const steps: PlanStep[] = []
  if (toolSet.has('craftRecipe')) {
    steps.push({
      description: 'Ensure a furnace is available',
      tool: 'craftRecipe',
      params: { recipe_name: 'furnace', num: 1 },
    })
  }
  if (toolSet.has('smeltItem')) {
    steps.push({
      description: 'Smelt raw iron into iron ingots',
      tool: 'smeltItem',
      params: { item_name: 'raw_iron', num: inferRequestedCount(goal, 8) },
    })
  }

  return steps
}

function isSurfaceRecoveryGoal(goal: string, worldStateHints?: WorldStateHints): boolean {
  if (!worldStateHints) {
    return false
  }

  const normalized = normalizeFallbackGoalText(goal)
  const underground = worldStateHints.surfaceEscapeNeeded || worldStateHints.terrainContext === 'underground_cave'
  if (!underground) {
    return false
  }

  const wantsSurface = normalized.includes('surface')
    || normalized.includes('cave exit')
    || normalized.includes('escape')
    || normalized.includes('open terrain')
    || goal.includes('地上')
    || goal.includes('脱出')
    || goal.includes('出口')
  const wantsWoodAfterRecovery = normalized.includes('wood')
    || normalized.includes('log')
    || normalized.includes('tree')
    || goal.includes('木')
    || goal.includes('原木')

  return wantsSurface || wantsWoodAfterRecovery
}

function buildSurfaceRecoveryPlan(goal: string, toolSet: Set<string>): PlanStep[] {
  const normalized = normalizeFallbackGoalText(goal)
  const wantsWoodAfterRecovery = normalized.includes('wood')
    || normalized.includes('log')
    || normalized.includes('tree')
    || goal.includes('木')
    || goal.includes('原木')
  const steps: PlanStep[] = []

  if (toolSet.has('recoverTowardSurface')) {
    steps.push({
      description: 'Recover toward the surface before resuming the broader goal',
      tool: 'recoverTowardSurface',
      params: { reason: 'surface_recovery_goal' },
    })

    if (wantsWoodAfterRecovery && toolSet.has('collectBlocks')) {
      steps.push({
        description: 'Collect nearby logs after reaching the surface',
        tool: 'collectBlocks',
        params: { type: 'log', num: inferRequestedCount(goal, 4) },
      })
    }
    else if (wantsWoodAfterRecovery && toolSet.has('searchForBlock')) {
      steps.push({
        description: 'Search for nearby logs once you reach the surface',
        tool: 'searchForBlock',
        params: { type: 'log', search_range: 64 },
      })
    }

    return steps.slice(0, 3)
  }

  if (toolSet.has('searchForBlock')) {
    steps.push({
      description: 'Search for grass blocks or open terrain to climb toward the surface',
      tool: 'searchForBlock',
      params: { type: 'grass_block', search_range: 48 },
    })
  }
  if (toolSet.has('moveAway')) {
    steps.push({
      description: 'Move away from the cave interior to look for a surface exit',
      tool: 'moveAway',
      params: { distance: 32 },
    })
  }

  if (wantsWoodAfterRecovery && toolSet.has('collectBlocks')) {
    steps.push({
      description: 'Collect nearby logs after reaching the surface',
      tool: 'collectBlocks',
      params: { type: 'log', num: inferRequestedCount(goal, 4) },
    })
  }
  else if (wantsWoodAfterRecovery && toolSet.has('searchForBlock')) {
    steps.push({
      description: 'Search for nearby logs once you reach the surface',
      tool: 'searchForBlock',
      params: { type: 'log', search_range: 64 },
    })
  }

  return steps.slice(0, 3)
}

function isShelterGoal(goal: string): boolean {
  const normalized = normalizeFallbackGoalText(goal)
  return normalized.includes('shelter')
    || normalized.includes('survive the night')
    || normalized.includes('night')
    || normalized.includes('safe')
    || normalized.includes('fortify')
    || normalized.includes('house')
    || normalized.includes('base')
    || goal.includes('拠点')
    || goal.includes('家')
    || goal.includes('夜')
    || goal.includes('避難')
}

function normalizeShelterInventoryItemName(itemName: string): string {
  return itemName
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/\s+/g, '_')
}

function isGenericShelterBlockGoal(goal: string): boolean {
  const normalized = normalizeFallbackGoalText(goal)
  return !normalized.includes('dirt')
    && !normalized.includes('oak_planks')
    && !normalized.includes('planks')
    && !normalized.includes('stone')
    && !normalized.includes('cobblestone')
    && !goal.includes('石')
}

function getShelterInventoryBlockCandidates(bot?: Mineflayer): Array<{ itemName: string, count: number }> {
  const inventoryItems = bot?.bot?.inventory?.items?.() ?? []

  return inventoryItems
    .map(item => ({
      itemName: normalizeShelterInventoryItemName(String(item?.name ?? '')),
      count: Math.max(0, Number(item?.count ?? 0)),
    }))
    .filter(({ itemName, count }) => {
      if (count <= 0 || !itemName) {
        return false
      }

      if (itemName === 'dirt' || itemName === 'cobblestone' || itemName === 'cobbled_deepslate') {
        return true
      }

      if (itemName === 'planks' || itemName.endsWith('_planks')) {
        return true
      }

      return /_log$|_wood$|_stem$|_hyphae$/u.test(itemName)
    })
    .sort((left, right) => {
      const score = (itemName: string): number => {
        if (itemName === 'cobblestone' || itemName === 'cobbled_deepslate') {
          return 4
        }
        if (itemName === 'dirt') {
          return 3
        }
        if (itemName === 'planks' || itemName.endsWith('_planks')) {
          return 2
        }
        return 1
      }

      const leftReady = Number(left.count >= 2)
      const rightReady = Number(right.count >= 2)
      if (rightReady !== leftReady) {
        return rightReady - leftReady
      }

      const scoreDelta = score(right.itemName) - score(left.itemName)
      if (scoreDelta !== 0) {
        return scoreDelta
      }

      return right.count - left.count
    })
}

function inferShelterPlacement(goal: string, bot?: Mineflayer): { blockType: string, placementCount: number } {
  const normalized = normalizeFallbackGoalText(goal)
  if (normalized.includes('dirt')) {
    return { blockType: 'dirt', placementCount: 2 }
  }

  if (normalized.includes('oak_planks') || normalized.includes('planks')) {
    return { blockType: 'oak_planks', placementCount: 2 }
  }

  if (normalized.includes('stone') || normalized.includes('cobblestone') || goal.includes('石')) {
    return { blockType: 'cobblestone', placementCount: 2 }
  }

  if (isGenericShelterBlockGoal(goal)) {
    const inventoryCandidate = getShelterInventoryBlockCandidates(bot)[0]
    if (inventoryCandidate) {
      return {
        blockType: inventoryCandidate.itemName,
        placementCount: Math.max(1, Math.min(2, inventoryCandidate.count)),
      }
    }
  }

  return { blockType: 'cobblestone', placementCount: 2 }
}

function buildShelterFallbackPlan(goal: string, toolSet: Set<string>, bot?: Mineflayer): PlanStep[] {
  const steps: PlanStep[] = []
  const { blockType, placementCount } = inferShelterPlacement(goal, bot)

  if (toolSet.has('placeHere') && placementCount >= 1) {
    steps.push({
      description: `Place ${blockType.replace(/_/g, ' ')} to fortify the current position`,
      tool: 'placeHere',
      params: { type: blockType },
    })
    if (placementCount >= 2) {
      steps.push({
        description: `Reinforce the shelter with another ${blockType.replace(/_/g, ' ')}`,
        tool: 'placeHere',
        params: { type: blockType },
      })
    }
  }

  if (toolSet.has('moveAway')) {
    steps.push({
      description: 'Reposition slightly so the shelter area is not blocking movement',
      tool: 'moveAway',
      params: { distance: 4 },
    })
  }

  return steps.slice(0, 3)
}

export class PlanningLLMHandler {
  private logger = useLogger()

  constructor(
    private readonly bot?: Mineflayer,
  ) {}

  public async generatePlan(
    goal: string,
    availableActions: Action[],
    sender: string,
    feedback?: string,
  ): Promise<PlanStep[]> {
    const baseUrl = normalizeBaseUrl(config.autonomyLlm.baseUrl)
    const model = normalizeModelForBaseUrl(baseUrl, config.autonomyLlm.model)
    const apiKey = config.autonomyLlm.apiKey?.trim() ?? ''

    if (!baseUrl || !model) {
      throw new Error('Gameplay planner baseUrl or model not configured')
    }

    const toolNames = availableActions.map(a => a.name)
    const worldState = await this.buildWorldStatePrompt(goal)
    const worldStateHints = extractWorldStateHints(worldState)
    const toolSet = new Set(toolNames)
    const fastPathPlan = this.getDeterministicFastPathPlan(goal, toolSet, worldStateHints, feedback)
    if (fastPathPlan.length > 0) {
      this.logger.withFields({ goal, steps: fastPathPlan.length }).log('Using deterministic fast-path plan')
      emitFallbackMonitor({
        scope: 'planning.adapter',
        reason: 'deterministic-fast-path',
        goal,
        detail: `Using deterministic plan with ${fastPathPlan.length} steps.`,
        from: 'llm-plan',
        to: 'hardcoded-plan',
        recoverable: true,
      }, {
        throttleMs: 5_000,
      })
      return fastPathPlan
    }

    const systemPrompt = this.buildSystemPrompt(availableActions)
    const userPrompt = this.buildUserPrompt(goal, sender, worldState, feedback)
    const schema = buildPlanJsonSchema(toolNames)
    const fastFallbackPlan = isEarlyWoodBootstrapGoal(goal, worldStateHints)
      ? this.getFallbackPlan(goal, toolNames, worldStateHints)
      : []

    if (fastFallbackPlan.length > 0) {
      this.logger.withFields({ goal, steps: fastFallbackPlan.length }).log('Using immediate bootstrap fallback plan')
      emitFallbackMonitor({
        scope: 'planning.adapter',
        reason: 'bootstrap-fast-path',
        goal,
        detail: `Using immediate hardcoded bootstrap plan with ${fastFallbackPlan.length} steps.`,
        from: 'llm-plan',
        to: 'hardcoded-plan',
        recoverable: true,
      }, {
        throttleMs: 5_000,
      })
      return fastFallbackPlan
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (apiKey && shouldSendAuthorizationHeader(baseUrl)) {
      headers.authorization = `Bearer ${apiKey}`
    }

    const isOllama = isLikelyOllamaBaseUrl(baseUrl)
    const isGeminiNative = isGeminiNativeBaseUrl(baseUrl)
    const isOpenAICompatible = isOpenAICompatibleBaseUrl(baseUrl)
    const isOpenAI = isOfficialOpenAIBaseUrl(baseUrl)

    const messages: PlannerMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]

    const requestTimeoutMs = isOllama ? OLLAMA_PLAN_REQUEST_TIMEOUT_MS : OPENAI_PLAN_REQUEST_TIMEOUT_MS
    const maxAttempts = isOllama ? OLLAMA_PLAN_MAX_ATTEMPTS : OPENAI_PLAN_MAX_ATTEMPTS
    let ollamaNumCtx = DEFAULT_OLLAMA_NUM_CTX

    const buildRequest = (plannerMessages: PlannerMessage[]): { endpoint: string, payload: Record<string, unknown> } => {
      if (isOllama) {
        // Use Ollama native API for proper `format` (JSON schema) enforcement.
        // The /v1/chat/completions endpoint ignores the `format` field.
        const ollamaBase = baseUrl.replace(/\/v1\/?$/, '')
        return {
          endpoint: `${ollamaBase}/api/chat`,
          payload: {
            model,
            think: false,
            messages: plannerMessages,
            format: schema,
            stream: false,
            keep_alive: OLLAMA_KEEP_ALIVE,
            options: {
              temperature: 0.2,
              num_predict: OLLAMA_PLAN_NUM_PREDICT,
              num_ctx: ollamaNumCtx,
            },
          },
        }
      }

      if (isGeminiNative) {
        const versionPrefix = baseUrl.includes('/v1beta')
          ? baseUrl
          : `${baseUrl}/v1beta`
        return {
          endpoint: `${versionPrefix}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          payload: {
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 512,
              responseMimeType: 'application/json',
            },
            contents: [{
              role: 'user',
              parts: [{
                text: [
                  ...plannerMessages.map(message => `${message.role.toUpperCase()}:\n${message.content}`),
                  '',
                  'Return only JSON in the shape {"steps":[{"description":"...","tool":"...","params":{...}}]}.',
                  'Never output Goal:, Current State:, bullet summaries, or analysis.',
                  'Use 1 to 3 steps.',
                ].join('\n\n'),
              }],
            }],
          },
        }
      }

      if (isOpenAI) {
        return {
          endpoint: `${baseUrl}/chat/completions`,
          payload: {
            model,
            messages: plannerMessages,
            reasoning_effort: 'none',
            response_format: { type: 'json_object' },
            max_completion_tokens: 1024,
          },
        }
      }

      if (isOpenAICompatible) {
        return {
          endpoint: `${baseUrl}/chat/completions`,
          payload: {
            model,
            messages: plannerMessages,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            max_tokens: 512,
          },
        }
      }

      throw new Error(`Gameplay planner does not support baseUrl: ${baseUrl}`)
    }

    const requestPlanContent = async (
      plannerMessages: PlannerMessage[],
      phase: 'plan' | 'repair',
      attempt: number,
    ): Promise<string> => {
      const { endpoint, payload } = buildRequest(plannerMessages)
      const abortController = new AbortController()
      const abortTimer = setTimeout(() => abortController.abort(), requestTimeoutMs)

      try {
        assertOpenAITokenBudget(baseUrl, `planning.${phase}`, model)
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          signal: abortController.signal,
          body: JSON.stringify(payload),
        })

        if (!response.ok) {
          const errorText = await response.text().catch(() => '')
          recordOpenAIResponseUsage({
            baseUrl,
            model,
            scope: `planning.${phase}`,
            promptText: JSON.stringify(payload),
            completionText: errorText,
          })
          this.logger.withFields({
            phase,
            status: response.status,
            attempt,
            body: compactHttpErrorBody(errorText),
          }).warn('Plan generation HTTP error')
          if (isOllama && ollamaNumCtx !== FALLBACK_OLLAMA_NUM_CTX && isOllamaModelLoadFailureBody(errorText)) {
            ollamaNumCtx = FALLBACK_OLLAMA_NUM_CTX
            this.logger.withFields({
              model,
              numCtx: FALLBACK_OLLAMA_NUM_CTX,
            }).warn('Planner retrying Ollama load with reduced context window')
          }
          return ''
        }

        const data = await response.json() as any
        recordOpenAIResponseUsage({
          baseUrl,
          model,
          scope: `planning.${phase}`,
          usage: data?.usage,
          promptText: JSON.stringify(payload),
          completionText: JSON.stringify(data),
        })
        const content = isOllama
          ? (typeof data?.message?.content === 'string' ? data.message.content.trim() : '')
          : isGeminiNative
            ? (Array.isArray(data?.candidates?.[0]?.content?.parts)
                ? data.candidates[0].content.parts
                    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
                    .join('')
                    .trim()
                : '')
            : extractContentFromResponse(data)

        this.logger.withFields({
          phase,
          usage: data?.usage,
          content: content.slice(0, 200),
        }).log(phase === 'repair' ? 'Generated repaired plan content' : 'Generated plan content')

        return content
      }
      finally {
        clearTimeout(abortTimer)
      }
    }

    const generatePlanWithRetries = async (): Promise<PlanStep[]> => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const content = await requestPlanContent(messages, 'plan', attempt)
          if (!content) {
            continue
          }

          const steps = this.parsePlanResponse(content, toolNames)
          if (steps.length > 0) {
            return steps
          }

          const repairMessages: PlannerMessage[] = [
            {
              role: 'system',
              content: 'You repair invalid Minecraft bot planner outputs into strict JSON.',
            },
            {
              role: 'user',
              content: buildPlanRepairPrompt(systemPrompt, userPrompt, content, toolNames),
            },
          ]
          const repairedContent = await requestPlanContent(repairMessages, 'repair', attempt)
          if (repairedContent) {
            const repairedSteps = this.parsePlanResponse(repairedContent, toolNames)
            if (repairedSteps.length > 0) {
              this.logger.withFields({ attempt }).log('Recovered valid plan steps after JSON repair')
              return repairedSteps
            }

            this.logger.withFields({ attempt }).warn('Planner output remained invalid after JSON repair, falling back without another retry')
            break
          }

          this.logger.withFields({ attempt }).warn('Parsed plan had 0 valid steps, retrying')
        }
        catch (err) {
          if (isTokenBudgetError(err)) {
            throw err
          }
          this.logger.withFields({
            error: err instanceof Error ? err.message : String(err),
            attempt,
          }).warn('Plan generation error')
          if (isAbortLikeError(err) && attempt < maxAttempts - 1) {
            this.logger.withFields({
              attempt,
              nextAttempt: attempt + 1,
              timeoutMs: requestTimeoutMs,
            }).warn('Planner request aborted or timed out, retrying once before falling back')
          }
        }
      }

      return []
    }

    const runPlannerInference = async (): Promise<PlanStep[]> => {
      return isOllama
        ? await withSerializedGpuTask('ollama:planning', this.logger, generatePlanWithRetries)
        : await generatePlanWithRetries()
    }

    const plannedSteps = config.autonomy.singleInferenceLane
      ? await runInInferenceLane(
          `planner:${normalizeFallbackGoalText(goal) || 'goal'}`,
          this.logger,
          runPlannerInference,
          { priority: 'critical' },
        )
      : await runPlannerInference()
    if (plannedSteps.length > 0) {
      return plannedSteps
    }

    // NOTICE: Planner fallback must remain a conservative helper for the current goal.
    // Inflating counts here would mechanically override the LLM's intent.
    this.logger.warn('LLM plan generation failed, using fallback plan')
    const fallback = this.getFallbackPlan(goal, toolNames, worldStateHints, feedback)
    if (fallback.length > 0) {
      emitFallbackMonitor({
        scope: 'planning.adapter',
        reason: 'llm-plan-generation-failed',
        goal,
        detail: `Using hardcoded fallback plan with ${fallback.length} steps.`,
        from: 'llm-plan',
        to: 'hardcoded-plan',
        recoverable: true,
      }, {
        throttleMs: 5_000,
      })
      return fallback
    }

    throw new Error('Failed to generate plan after retries')
  }

  /**
   * Hardcoded fallback plans for common goals when LLM is unavailable/slow.
   */
  private getFallbackPlan(
    goal: string,
    validToolNames: string[],
    worldStateHints?: WorldStateHints,
    feedback?: string,
  ): PlanStep[] {
    const toolSet = new Set(validToolNames)
    const g = goal.toLowerCase()
    const normalizedGoal = normalizeFallbackGoalText(goal)

    const undergroundBootstrapBlocked = worldStateHints
      && (worldStateHints.terrainContext === 'underground_cave' || worldStateHints.surfaceEscapeNeeded)
      && worldStateHints.woodAccess === 'poor'
      && worldStateHints.pickaxeAccess === 'missing'

    if (undergroundBootstrapBlocked && toolSet.has('recoverTowardSurface')) {
      return [
        {
          description: 'Recover toward the surface before gathering wood or mining deeper',
          tool: 'recoverTowardSurface',
          params: { reason: 'underground_bootstrap_blocked' },
        },
      ]
    }

    if (undergroundBootstrapBlocked && toolSet.has('moveAway')) {
      return [
        {
          description: 'Move toward open terrain or a cave exit before gathering wood or mining deeper',
          tool: 'moveAway',
          params: { distance: 48 },
        },
      ]
    }

    if (/^(?:consume|eat)\b/.test(normalizedGoal)) {
      const consumeFallback = buildConsumeFallbackPlan(toolSet)
      if (consumeFallback.length > 0) {
        return consumeFallback
      }
    }

    const smeltFallback = buildSmeltFallbackPlan(goal, toolSet)
    if (smeltFallback.length > 0) {
      return smeltFallback
    }

    const leadingCraftRecipe = inferLeadingCraftRecipe(goal)
    if (leadingCraftRecipe && toolSet.has('craftRecipe')) {
      return [
        {
          description: `Craft ${leadingCraftRecipe.replace(/_/g, ' ')}`,
          tool: 'craftRecipe',
          params: { recipe_name: leadingCraftRecipe, num: 1 },
        },
      ]
    }

    const miningIntent = /\b(?:mine|collect|get|gather|find|search)\b/.test(normalizedGoal)
      || /採掘|掘|集め|探/.test(goal)
      || Boolean(feedback && /missing|ない/.test(feedback))
    const prioritizedMiningTargets = miningIntent
      ? extractPrioritizedMiningTargets(goal, feedback)
      : []
    const primaryMiningTarget = prioritizedMiningTargets[0]

    const hasCoordinateMiningAccess = hasSpecificBlockTarget(goal) && toolSet.has('goToCoordinates')
    if (primaryMiningTarget && toolSet.has('collectBlocks') && (toolSet.has('searchForBlock') || hasCoordinateMiningAccess)) {
      const steps: PlanStep[] = []
      const requiredPickaxeRecipe = getRequiredPickaxeRecipeForTarget(primaryMiningTarget)
      if (requiredPickaxeRecipe && toolSet.has('craftRecipe')) {
        steps.push({
          description: `Ensure pickaxe for mining ${primaryMiningTarget.replace(/_/g, ' ')}`,
          tool: 'craftRecipe',
          params: { recipe_name: requiredPickaxeRecipe, num: 1 },
        })
      }
      const targetCoordinates = extractTargetCoordinates(goal)
      if (targetCoordinates && toolSet.has('goToCoordinates')) {
        steps.push({
          description: `Move to the known ${primaryMiningTarget.replace(/_/g, ' ')} location`,
          tool: 'goToCoordinates',
          params: {
            x: targetCoordinates.x,
            y: targetCoordinates.y,
            z: targetCoordinates.z,
            closeness: 4,
          },
        })
      }
      else {
        steps.push({
          description: `Search for ${primaryMiningTarget.replace(/_/g, ' ')}`,
          tool: 'searchForBlock',
          params: { type: primaryMiningTarget, search_range: 64 },
        })
      }
      steps.push({
        description: `Collect ${primaryMiningTarget.replace(/_/g, ' ')}`,
        tool: 'collectBlocks',
        params: { type: primaryMiningTarget, num: inferMiningTargetCount(goal, 3) },
      })
      return steps
    }

    const plans: Array<{ keywords: string[], steps: PlanStep[] }> = [
      {
        keywords: ['wood', 'log', '木', '原木', '材木', 'tree'],
        steps: [
          { description: 'Search for logs', tool: 'searchForBlock', params: { type: 'log', search_range: 64 } },
          { description: 'Collect logs', tool: 'collectBlocks', params: { type: 'log', num: inferRequestedCount(goal, 1) } },
        ],
      },
      {
        keywords: ['craft', '作業台', 'table', 'tool', 'ツール', '道具'],
        steps: [
          { description: 'Collect logs', tool: 'collectBlocks', params: { type: 'log', num: inferRequestedCount(goal, 2) } },
          { description: 'Craft a crafting table', tool: 'craftRecipe', params: { recipe_name: 'crafting_table', num: 1 } },
        ],
      },
      {
        keywords: ['food', '食料', '食べ', 'hunger', 'animal', '動物'],
        steps: buildFoodFallbackPlan(goal, toolSet),
      },
      {
        keywords: ['shelter', '拠点', 'safe', '安全', 'house', '家', '夜'],
        steps: buildShelterFallbackPlan(goal, toolSet),
      },
      {
        keywords: ['stone', '石', 'cobble', 'cobblestone'],
        steps: [
          { description: 'Ensure pickaxe for mining stone', tool: 'craftRecipe', params: { recipe_name: 'wooden_pickaxe', num: 1 } },
          { description: 'Search for stone', tool: 'searchForBlock', params: { type: 'stone', search_range: 32 } },
          { description: 'Collect stone', tool: 'collectBlocks', params: { type: 'stone', num: inferMiningTargetCount(goal, 3) } },
        ],
      },
      {
        keywords: ['iron', '鉄'],
        steps: [
          { description: 'Ensure pickaxe for mining iron', tool: 'craftRecipe', params: { recipe_name: 'stone_pickaxe', num: 1 } },
          { description: 'Search for iron', tool: 'searchForBlock', params: { type: 'iron_ore', search_range: 64 } },
          { description: 'Collect iron ore', tool: 'collectBlocks', params: { type: 'iron_ore', num: inferMiningTargetCount(goal, 3) } },
        ],
      },
      {
        keywords: ['diamond', 'ダイヤ'],
        steps: [
          { description: 'Ensure iron pickaxe for mining diamonds', tool: 'craftRecipe', params: { recipe_name: 'iron_pickaxe', num: 1 } },
          { description: 'Search for diamonds', tool: 'searchForBlock', params: { type: 'diamond_ore', search_range: 64 } },
          { description: 'Collect diamond ore', tool: 'collectBlocks', params: { type: 'diamond_ore', num: inferMiningTargetCount(goal, 1) } },
        ],
      },
      {
        keywords: ['explore', '探索', '探検', 'nearby', 'resource', '資源'],
        steps: [
          { description: 'Explore and collect resources', tool: 'collectBlocks', params: { type: 'log', num: inferRequestedCount(goal, 1) } },
        ],
      },
    ]

    // Find matching fallback plan
    for (const plan of plans) {
      if (plan.keywords.some(kw => g.includes(kw))) {
        // Filter to only valid tools
        const valid = plan.steps.filter(step => toolSet.has(step.tool))
        if (valid.length > 0) {
          return valid
        }
      }
    }

    // Ultimate fallback: collect wood (always a safe action)
    if (toolSet.has('collectBlocks')) {
      return [{ description: 'Gather nearby resources', tool: 'collectBlocks', params: { type: 'log', num: inferRequestedCount(goal, 1) } }]
    }

    return []
  }

  private getDeterministicFastPathPlan(
    goal: string,
    toolSet: Set<string>,
    worldStateHints?: WorldStateHints,
    feedback?: string,
  ): PlanStep[] {
    if (isSurfaceRecoveryGoal(goal, worldStateHints)) {
      return buildSurfaceRecoveryPlan(goal, toolSet)
    }

    const smeltFallback = buildSmeltFallbackPlan(goal, toolSet)
    if (smeltFallback.length > 0) {
      return smeltFallback
    }

    const normalizedGoal = normalizeFallbackGoalText(goal)
    const directMiningIntent = /\b(?:mine|collect|get|gather|find|search)\b/.test(normalizedGoal)
      || /採掘|掘|集め|探/.test(goal)
      || Boolean(feedback && /missing|ない/.test(feedback))
    if (directMiningIntent) {
      const miningFallback = this.getFallbackPlan(goal, [...toolSet], worldStateHints, feedback)
      if (miningFallback.some(step =>
        step.tool === 'collectBlocks'
        && typeof step.params.type === 'string'
        && ['stone', 'coal_ore', 'iron_ore', 'diamond_ore'].includes(step.params.type),
      )) {
        return miningFallback
      }
    }

    if (isShelterGoal(goal)) {
      return buildShelterFallbackPlan(goal, toolSet, this.bot)
    }

    return []
  }

  /**
   * Parse the LLM response — try JSON first, fall back to text parsing.
   */
  private parsePlanResponse(content: string, validToolNames: string[]): PlanStep[] {
    // Try JSON parse first (expected when format/response_format is set)
    const parsed = extractJsonLiteral(content)
    const stepsArray = Array.isArray((parsed as any)?.steps)
      ? (parsed as any).steps
      : Array.isArray(parsed)
        ? parsed
        : null
    if (stepsArray) {
      return this.parseJsonSteps(stepsArray, validToolNames)
    }

    // Fallback: text-based parsing for providers that don't support structured output
    return this.parseTextPlanContent(content, validToolNames)
  }

  private parseJsonSteps(steps: any[], validToolNames: string[]): PlanStep[] {
    const toolSet = new Set(validToolNames)

    return steps
      .filter((step: any) => {
        if (!step || typeof step !== 'object')
          return false
        if (typeof step.tool !== 'string' || !toolSet.has(step.tool))
          return false
        return true
      })
      .slice(0, 3)
      .map((step: any) => ({
        description: typeof step.description === 'string' ? step.description : '',
        tool: step.tool as string,
        params: (step.params && typeof step.params === 'object' && !Array.isArray(step.params))
          ? step.params as Record<string, unknown>
          : {},
      }))
  }

  /**
   * Legacy text-based plan parser — fallback for providers without JSON schema support.
   */
  private parseTextPlanContent(content: string, validToolNames: string[]): PlanStep[] {
    const toolSet = new Set(validToolNames)
    const normalizeString = (value: string): string => {
      return value
        .trim()
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim()
    }

    const parseParamValue = (rawValue: string): unknown => {
      const normalized = normalizeString(rawValue)
      if (normalized.length === 0)
        return ''
      if (normalized === 'true')
        return true
      if (normalized === 'false')
        return false
      if (/^-?\d+$/.test(normalized))
        return Number.parseInt(normalized, 10)
      if (/^-?\d*\.\d+$/.test(normalized))
        return Number.parseFloat(normalized)
      return normalized
    }

    const steps = content.split(/\d+\./).filter(step => step.trim().length > 0)

    return steps.map((step) => {
      const lines = step.trim().split('\n')
      const description = lines[0]?.trim() ?? ''
      let tool = ''
      const params: Record<string, unknown> = {}

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const trimmed = lines[lineIndex].trim()

        if (trimmed.startsWith('Tool:')) {
          tool = normalizeString(trimmed.slice('Tool:'.length))
          continue
        }

        if (trimmed === 'Params:') {
          for (let i = lineIndex + 1; i < lines.length; i++) {
            const paramLine = lines[i].trim()
            if (paramLine.length === 0)
              break
            const paramMatch = paramLine.match(/(\w+):\s*(.+)/)
            if (!paramMatch)
              continue
            const [, key, value] = paramMatch
            params[key] = parseParamValue(value)
          }
        }
      }

      return { description, tool, params }
    }).filter((step) => {
      if (!step.tool || step.tool.length === 0)
        return false
      if (/[^\w-]/.test(step.tool))
        return false
      if (!toolSet.has(step.tool))
        return false
      // Filter out placeholder param values like [x座標]
      for (const value of Object.values(step.params)) {
        if (typeof value === 'string' && /^\[.*\]$/.test(value)) {
          delete step.params[Object.keys(step.params).find(k => step.params[k] === value)!]
        }
      }
      return true
    }).slice(0, 3)
  }

  private buildSystemPrompt(availableActions: Action[]): string {
    const actionsList = availableActions
      .map((action) => {
        const params = Object.keys(action.schema.shape)
          .map(name => `    - ${name}`)
          .join('\n')
        return `- ${action.name}: ${action.description}\n  Parameters:\n${params}`
      })
      .join('\n\n')

    return `You are a Minecraft bot planner. Break goals into 1-3 short executable steps.
Return a JSON object with a "steps" array. Each step has: description, tool, params.

IMPORTANT: Use ONLY the tools listed below. Do NOT invent tools.

Tools:
${actionsList}

Example output:
{"steps":[{"description":"Search for logs nearby","tool":"searchForBlock","params":{"type":"log","search_range":64}},{"description":"Collect 4 logs","tool":"collectBlocks","params":{"type":"log","num":4}}]}

Rules:
- Maximum 3 steps
- tool must be exactly one of the tool names listed above
- params values must be strings, numbers, or booleans only
- Ground every step in the provided current world state instead of assuming missing items, blocks, or structures.
- Use English for param values (e.g. "log" not "原木")
- Never output a goal recap, "Goal:", "Current State:", analysis, or bullet summaries. Output executable steps only.

Tool requirements (MUST follow this order):
- Mining stone/ore/brick blocks with collectBlocks requires a pickaxe. If inventory has no pickaxe, craft one FIRST with craftRecipe.
- Mining dirt/sand/gravel with collectBlocks requires a shovel. Craft one first if missing.
- Chopping wood planks with collectBlocks requires an axe. Logs can be broken by hand.
- branchMine always requires a pickaxe. Craft one first if missing.
- craftRecipe for tools requires wood. Collect logs first if inventory is empty.
- smeltItem requires a nearby furnace.
- ALWAYS check the inventory in the world state before choosing actions. Do NOT skip tool crafting.`
  }

  private async buildWorldStatePrompt(goal?: string): Promise<string> {
    try {
      if (!this.bot) {
        return 'world_state_unavailable'
      }
      return await generateWorldStatePrompt(this.bot as any, goal)
    }
    catch (error) {
      this.logger.withError(error).warn('Failed to build planner world state prompt')
      return 'world_state_unavailable'
    }
  }

  private buildUserPrompt(goal: string, sender: string, worldState: string, feedback?: string): string {
    const worldStateHints = extractWorldStateHints(worldState)
    const compactWorldState = compactPlanningWorldState(worldState)

    let prompt = `Goal from ${sender}: ${goal}\nCreate steps to achieve this goal.\n\nCurrent world state:\n${compactWorldState}`
    if (worldStateHints.terrainContext === 'underground_cave' && worldStateHints.woodAccess === 'poor') {
      prompt += '\n\nEnvironment rule: You are underground with poor wood access. Do not search for logs in place. Move toward open terrain or a cave exit first.'
    }
    if (worldStateHints.terrainContext === 'underground_cave' && worldStateHints.pickaxeAccess === 'missing') {
      prompt += '\nEnvironment rule: You are underground without pickaxe access. Do not continue cave exploration or ore mining until you recover toward surface or open terrain.'
    }
    if (worldStateHints.surfaceEscapeNeeded) {
      prompt += '\nEnvironment rule: Surface escape is needed. Prefer escape or reposition steps before deeper exploration, mining, or base-building.'
    }
    if (worldStateHints.mobilityState === 'shaft_trap') {
      prompt += '\nEnvironment rule: The immediate terrain looks like an enclosed vertical shaft. Prefer the direct surface-recovery tool over random relocation or more local mining.'
    }
    if (worldStateHints.surfaceEscapeScaffold.startsWith('ready:')) {
      prompt += `\nEnvironment fact: Disposable scaffold is available for surface escape (${worldStateHints.surfaceEscapeScaffold}).`
    }
    if (feedback) {
      prompt += `\nPrevious attempt failed: ${feedback}`
    }
    return prompt
  }
}
