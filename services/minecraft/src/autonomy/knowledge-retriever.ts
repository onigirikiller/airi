// ============================================================
// Knowledge Retriever — RAG for relevant-only knowledge injection (Lv2 C-1)
// ============================================================

import type { WorldFacts } from './preconditions'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { classifyGoalType } from './preconditions'

// ---------------------------------------------------------------------------
// Knowledge data (loaded once, cached)
// ---------------------------------------------------------------------------

let recipesCache: Record<string, any> | null = null
let toolReqCache: any | null = null
let safetyRulesCache: string | null = null

const KNOWLEDGE_DIR = resolve(import.meta.dirname, 'knowledge')
const MAX_OUTPUT_LENGTH = 1200

function loadRecipes(): Record<string, any> {
  if (!recipesCache) {
    try {
      recipesCache = JSON.parse(readFileSync(resolve(KNOWLEDGE_DIR, 'recipes.json'), 'utf8'))
    }
    catch {
      recipesCache = {}
    }
  }
  return recipesCache!
}

function loadToolRequirements(): any {
  if (!toolReqCache) {
    try {
      toolReqCache = JSON.parse(readFileSync(resolve(KNOWLEDGE_DIR, 'tool_requirements.json'), 'utf8'))
    }
    catch {
      toolReqCache = {}
    }
  }
  return toolReqCache
}

function loadSafetyRules(): string {
  if (safetyRulesCache === null) {
    try {
      safetyRulesCache = readFileSync(resolve(KNOWLEDGE_DIR, 'safety_rules.md'), 'utf8')
    }
    catch {
      safetyRulesCache = ''
    }
  }
  return safetyRulesCache
}

// ---------------------------------------------------------------------------
// Deficit detection
// ---------------------------------------------------------------------------

function detectDeficits(facts: WorldFacts): string[] {
  const deficits: string[] = []

  if (!facts.hasPickaxe)
    deficits.push('no_pickaxe')
  if (!facts.hasAxe)
    deficits.push('no_axe')
  if (!facts.hasSword)
    deficits.push('no_sword')
  if (!facts.hasCraftingTable)
    deficits.push('no_crafting_table')
  if (!facts.hasFurnace)
    deficits.push('no_furnace')
  if (facts.foodItemCount === 0)
    deficits.push('no_food')
  if (facts.torchCount < 4)
    deficits.push('low_torches')
  if (facts.woodCount === 0)
    deficits.push('no_wood')
  if (facts.health <= 6)
    deficits.push('low_health')

  return deficits
}

// ---------------------------------------------------------------------------
// Relevant recipe lookup
// ---------------------------------------------------------------------------

const DEFICIT_TO_RECIPES: Record<string, string[]> = {
  no_pickaxe: ['wooden_pickaxe', 'stone_pickaxe', 'stick', 'oak_planks', 'crafting_table'],
  no_axe: ['wooden_axe', 'stone_axe', 'stick', 'oak_planks'],
  no_sword: ['wooden_sword', 'stone_sword', 'stick', 'oak_planks'],
  no_crafting_table: ['crafting_table', 'oak_planks'],
  no_furnace: ['furnace'],
  no_food: ['bread'],
  low_torches: ['torch', 'stick'],
}

const GOAL_TO_RECIPES: Record<string, string[]> = {
  mine_stone: ['wooden_pickaxe', 'stone_pickaxe'],
  mine_iron: ['stone_pickaxe', 'iron_pickaxe', 'furnace'],
  mine_diamond: ['iron_pickaxe'],
  craft_tool: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'wooden_sword', 'stone_sword'],
  craft_pickaxe: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'],
  craft_furnace: ['furnace'],
  craft_armor: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'shield'],
  smelt: ['furnace'],
  explore_cave: ['torch', 'wooden_sword', 'stone_sword'],
  nether: ['bucket', 'iron_pickaxe', 'diamond_pickaxe'],
}

// ---------------------------------------------------------------------------
// Mining requirement lookup
// ---------------------------------------------------------------------------

function getMiningRequirements(goalType: string): string {
  const toolReq = loadToolRequirements()
  const miningReqs = toolReq.mining_requirements ?? {}

  const relevantBlocks: string[] = []
  if (goalType === 'mine_stone')
    relevantBlocks.push('stone', 'cobblestone')
  else if (goalType === 'mine_iron')
    relevantBlocks.push('iron_ore')
  else if (goalType === 'mine_diamond')
    relevantBlocks.push('diamond_ore')
  else if (goalType === 'mine_gold')
    relevantBlocks.push('gold_ore')

  if (relevantBlocks.length === 0)
    return ''

  const lines: string[] = []
  for (const block of relevantBlocks) {
    const req = miningReqs[block]
    if (req) {
      lines.push(`${block}: requires ${req.minTool} (tier ${req.tier})`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Safety rules extraction (relevant sections only)
// ---------------------------------------------------------------------------

function getRelevantSafetyRules(goalType: string, deficits: string[]): string {
  const rules = loadSafetyRules()
  if (!rules)
    return ''

  const sections = rules.split(/^## /m).filter(s => s.trim().length > 0)
  const relevant: string[] = []

  const sectionKeywords: Record<string, string[]> = {
    Cave: ['explore_cave', 'mine_stone', 'mine_iron', 'mine_diamond', 'mine_generic', 'no_pickaxe', 'low_torches'],
    Mining: ['mine_stone', 'mine_iron', 'mine_diamond', 'mine_generic', 'mine_gold', 'no_pickaxe'],
    Combat: ['fight', 'no_sword', 'low_health'],
    Crafting: ['craft_tool', 'craft_pickaxe', 'craft_armor', 'craft_furnace', 'no_crafting_table', 'no_furnace'],
    Night: ['explore', 'shelter', 'no_sword'],
    Food: ['find_food', 'no_food', 'low_health'],
  }

  for (const section of sections) {
    const firstLine = section.split('\n')[0].trim()
    for (const [keyword, triggers] of Object.entries(sectionKeywords)) {
      if (firstLine.includes(keyword) && triggers.some(t => t === goalType || deficits.includes(t))) {
        relevant.push(`## ${section.trim()}`)
        break
      }
    }
  }

  return relevant.join('\n\n')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function retrieveRelevantKnowledge(
  facts: WorldFacts,
  goalCandidates: string[],
  explicitDeficits?: string[],
): string {
  const deficits = explicitDeficits ?? detectDeficits(facts)
  const goalTypes = goalCandidates.map(g => classifyGoalType(g)).filter(t => t !== 'unknown' && t !== 'generic')
  const recipes = loadRecipes()

  // Collect relevant recipe names
  const relevantRecipeNames = new Set<string>()

  for (const deficit of deficits) {
    const recipeNames = DEFICIT_TO_RECIPES[deficit]
    if (recipeNames)
      recipeNames.forEach(r => relevantRecipeNames.add(r))
  }

  for (const goalType of goalTypes) {
    const recipeNames = GOAL_TO_RECIPES[goalType]
    if (recipeNames)
      recipeNames.forEach(r => relevantRecipeNames.add(r))
  }

  // Build output
  const parts: string[] = []

  // Recipe snippets
  if (relevantRecipeNames.size > 0) {
    const recipeLines: string[] = ['[Recipes]']
    for (const name of relevantRecipeNames) {
      const recipe = recipes[name]
      if (!recipe)
        continue
      const ingredients = Object.entries(recipe.ingredients ?? {}).map(([k, v]) => `${k}×${v}`).join(', ')
      const table = recipe.requires_table ? ' (crafting table required)' : ''
      const output = recipe.output_count ? ` → ${recipe.output_count}` : ''
      recipeLines.push(`  ${name}: ${ingredients}${table}${output}`)
    }
    if (recipeLines.length > 1)
      parts.push(recipeLines.join('\n'))
  }

  // Mining requirements
  for (const goalType of goalTypes) {
    const miningReq = getMiningRequirements(goalType)
    if (miningReq) {
      parts.push(`[Mining Requirements]\n${miningReq}`)
    }
  }

  // Safety rules
  const safetyRules = getRelevantSafetyRules(goalTypes[0] ?? 'generic', deficits)
  if (safetyRules) {
    parts.push(`[Safety Rules]\n${safetyRules}`)
  }

  const output = parts.join('\n\n')

  // Truncate to max length
  if (output.length > MAX_OUTPUT_LENGTH) {
    return `${output.slice(0, MAX_OUTPUT_LENGTH - 3)}...`
  }

  return output
}
