// ============================================================
// Precondition Mask — Action/Goal safety guard (Lv0 A-1, Lv1 B-1)
// ============================================================

import toolRequirements from './knowledge/tool_requirements.json'

import { isFoodItemName } from '../skills/food'
import { getInventoryCounts, getNearestBlock } from '../skills/world'
import { incrementMetric } from './metrics'

const REACHABLE_WORKSTATION_SCAN_DISTANCE = 64
const REACHABLE_WORKSTATION_VERTICAL_DISTANCE = 3

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorldFacts {
  health: number
  food: number
  hasCraftingTable: boolean
  hasFurnace: boolean
  woodCount: number
  stoneCount: number
  cobblestoneCount: number
  ironIngotCount: number
  ironOreCount: number
  diamondCount: number
  coalCount: number
  foodItemCount: number
  torchCount: number
  equipmentTier: 'none' | 'wood' | 'stone' | 'iron' | 'diamond'
  pickaxeTier: 'none' | 'wood' | 'stone' | 'iron' | 'diamond'
  hasPickaxe: boolean
  hasIronPickaxe: boolean
  hasDiamondPickaxe: boolean
  hasAxe: boolean
  hasSword: boolean
  hasShield: boolean
  hasDiamondHelmet: boolean
  hasDiamondChestplate: boolean
  hasDiamondLeggings: boolean
  hasDiamondBoots: boolean
  diamondArmorPieceCount: number
  obsidianCount: number
  blazeRodCount: number
  blazePowderCount: number
  enderPearlCount: number
  enderEyeCount: number
  hasFlintAndSteel: boolean
  hasBow: boolean
  arrowCount: number
  timeOfDay: 'day' | 'night'
  nearbyHostileCount: number
  dimension: string
  position: { x: number, y: number, z: number }
  runnerPhase: string
  runnerPhaseStep: number
}

export interface AllowedSet {
  allowedGoalTypes: Set<string>
  blocked: Array<{ goalType: string, reason: string }>
}

export interface GoalConstraint {
  blocked: boolean
  goalType: string
  reason?: string
  redirect?: string
  source?: 'ban' | 'precondition'
  banUntil?: number
}

// ---------------------------------------------------------------------------
// Goal type classification
// ---------------------------------------------------------------------------

const GOAL_TYPE_PATTERNS: Array<{ type: string, pattern: RegExp }> = [
  { type: 'mine_diamond', pattern: /diamond|ダイヤ/i },
  { type: 'mine_iron', pattern: /iron ore|鉄鉱石|mine iron/i },
  { type: 'mine_gold', pattern: /gold ore|金鉱石/i },
  { type: 'mine_stone', pattern: /mine stone|cobblestone|石を掘|丸石/i },
  { type: 'surface_escape', pattern: /reach the surface|escape to the surface|surface escape|escape the underground|cave exit|dig up(?:wards)?|ascend|climb upward|地上|出口|上へ|掘り進め/i },
  { type: 'mine_generic', pattern: /\bmine\b|mining|採掘/i },
  { type: 'explore_cave', pattern: /cave|洞窟|underground|地下/i },
  { type: 'fight', pattern: /fight|attack|combat|kill|battle|戦|攻撃|倒/i },
  { type: 'craft_tool', pattern: /craft.*(?:pick|axe|sword|tool)|作.*(?:ツルハシ|斧|剣)/i },
  { type: 'craft_pickaxe', pattern: /craft.*pickaxe|ツルハシ.*作/i },
  { type: 'craft_crafting_table', pattern: /craft.*(?:crafting.?table|作業台)/i },
  { type: 'craft_furnace', pattern: /craft.*furnace|かまど.*作/i },
  { type: 'craft_armor', pattern: /craft.*(?:armor|helmet|chestplate|leggings|boots|防具)/i },
  { type: 'smelt', pattern: /smelt|精錬|かまど/i },
  { type: 'gather_wood', pattern: /wood|log|tree|原木|木を/i },
  { type: 'find_food', pattern: /food|eat|hunger|cook|bread|meat|食料|パン|肉/i },
  { type: 'explore', pattern: /explore|survey|scout|探索|偵察/i },
  { type: 'nether', pattern: /nether|ネザー|portal|ポータル|obsidian|黒曜石/i },
  { type: 'blaze', pattern: /blaze|ブレイズ/i },
  { type: 'enderman', pattern: /enderman|ender.*pearl|エンダーマン|エンダーパール/i },
  { type: 'dragon', pattern: /dragon|ドラゴン/i },
  { type: 'retreat', pattern: /retreat|flee|escape|run away|逃|退避|回復/i },
  { type: 'heal', pattern: /heal|recover|回復|HP/i },
  { type: 'shelter', pattern: /shelter|house|base|bed|拠点|家|ベッド/i },
]

export function classifyGoalType(goal: string): string {
  if (!goal)
    return 'unknown'
  const lower = goal.toLowerCase()
  for (const { type, pattern } of GOAL_TYPE_PATTERNS) {
    if (pattern.test(lower))
      return type
  }
  return 'generic'
}

// ---------------------------------------------------------------------------
// Equipment tier helpers
// ---------------------------------------------------------------------------

const TIER_ORDER = ['none', 'wood', 'stone', 'iron', 'diamond'] as const
type Tier = typeof TIER_ORDER[number]

function tierIndex(tier: Tier): number {
  return TIER_ORDER.indexOf(tier)
}

function detectEquipmentTier(bot: any): Tier {
  try {
    const inventory = getInventoryCounts(bot)
    let best: Tier = 'none'
    for (const [name, count] of Object.entries(inventory)) {
      if (count <= 0) {
        continue
      }

      if (name.includes('diamond') && (name.includes('pickaxe') || name.includes('sword') || name.includes('axe') || name.includes('helmet') || name.includes('chestplate') || name.includes('leggings') || name.includes('boots'))) {
        return 'diamond'
      }
      if (name.includes('iron') && (name.includes('pickaxe') || name.includes('sword') || name.includes('axe') || name.includes('helmet') || name.includes('chestplate') || name.includes('leggings') || name.includes('boots'))) {
        if (tierIndex('iron') > tierIndex(best))
          best = 'iron'
      }
      if (name.includes('stone') && (name.includes('pickaxe') || name.includes('sword') || name.includes('axe'))) {
        if (tierIndex('stone') > tierIndex(best))
          best = 'stone'
      }
      if (name.includes('wooden') && (name.includes('pickaxe') || name.includes('sword') || name.includes('axe'))) {
        if (tierIndex('wood') > tierIndex(best))
          best = 'wood'
      }
    }
    return best
  }
  catch {
    return 'none'
  }
}

function detectPickaxeTier(bot: any): Tier {
  try {
    const inventory = getInventoryCounts(bot)
    let best: Tier = 'none'
    for (const [name, count] of Object.entries(inventory)) {
      if (count <= 0 || !name.includes('pickaxe')) {
        continue
      }

      if (name.includes('diamond')) {
        return 'diamond'
      }
      if (name.includes('iron')) {
        best = tierIndex('iron') > tierIndex(best) ? 'iron' : best
      }
      else if (name.includes('stone')) {
        best = tierIndex('stone') > tierIndex(best) ? 'stone' : best
      }
      else if (name.includes('wooden') || name.includes('golden')) {
        best = tierIndex('wood') > tierIndex(best) ? 'wood' : best
      }
    }

    return best
  }
  catch {
    return 'none'
  }
}

function hasItemMatching(bot: any, pattern: RegExp): boolean {
  try {
    const inventory = getInventoryCounts(bot)
    return Object.entries(inventory).some(([itemName, count]) => count > 0 && pattern.test(itemName))
  }
  catch {
    return false
  }
}

function countItems(bot: any, pattern: RegExp): number {
  try {
    let total = 0
    const inventory = getInventoryCounts(bot)
    for (const [itemName, count] of Object.entries(inventory)) {
      if (count > 0 && pattern.test(itemName)) {
        total += count
      }
    }
    return total
  }
  catch {
    return 0
  }
}

function countItemsWhere(bot: any, predicate: (itemName: string) => boolean): number {
  try {
    let total = 0
    const inventory = getInventoryCounts(bot)
    for (const [itemName, count] of Object.entries(inventory)) {
      if (count > 0 && predicate(itemName)) {
        total += count
      }
    }
    return total
  }
  catch {
    return 0
  }
}

function countArmorPieces(bot: any, material: 'iron' | 'diamond'): number {
  const armorPieces = ['helmet', 'chestplate', 'leggings', 'boots']
  try {
    const inventory = getInventoryCounts(bot)
    return armorPieces.reduce((sum, piece) => sum + ((inventory[`${material}_${piece}`] ?? 0) > 0 ? 1 : 0), 0)
  }
  catch {
    return 0
  }
}

function hasNearbyBlock(bot: any, blockName: string, distance = 6): boolean {
  try {
    return Boolean(getNearestBlock(bot, blockName, distance))
  }
  catch {
    return false
  }
}

function hasReachableWorkstation(bot: any, blockName: 'crafting_table' | 'furnace'): boolean {
  try {
    const block = getNearestBlock(bot, blockName, REACHABLE_WORKSTATION_SCAN_DISTANCE)
    const botPosition = bot?.bot?.entity?.position
    const blockPosition = block?.position
    if (!botPosition || !blockPosition) {
      return Boolean(block)
    }

    const verticalDistance = Math.abs(Number(blockPosition.y) - Number(botPosition.y))
    return Number.isFinite(verticalDistance) && verticalDistance <= REACHABLE_WORKSTATION_VERTICAL_DISTANCE
  }
  catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// collectWorldFacts
// ---------------------------------------------------------------------------

export function collectWorldFacts(bot: any, runner?: any): WorldFacts {
  const health = bot.bot?.health ?? 20
  const food = bot.bot?.food ?? 20
  const position = bot.bot?.entity?.position
    ? { x: bot.bot.entity.position.x, y: bot.bot.entity.position.y, z: bot.bot.entity.position.z }
    : { x: 0, y: 64, z: 0 }
  const dimension = (bot.bot as any)?.game?.dimension ?? 'minecraft:overworld'

  const equipmentTier = detectEquipmentTier(bot)
  const pickaxeTier = detectPickaxeTier(bot)

  const timeOfDay = (() => {
    try {
      const time = bot.bot?.time?.timeOfDay ?? 0
      return (time >= 13000 && time < 23000) ? 'night' as const : 'day' as const
    }
    catch {
      return 'day' as const
    }
  })()

  // Count nearby hostile entities
  const nearbyHostileCount = (() => {
    try {
      const entities = bot.bot?.entities ?? {}
      let count = 0
      const hostileTypes = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'drowned', 'phantom']
      for (const entity of Object.values(entities) as any[]) {
        if (entity?.type === 'mob' && hostileTypes.some(h => (entity.name ?? '').includes(h))) {
          const dist = position
            ? Math.hypot(
                entity.position.x - position.x,
                entity.position.y - position.y,
                entity.position.z - position.z,
              )
            : Infinity
          if (dist < 24)
            count++
        }
      }
      return count
    }
    catch {
      return 0
    }
  })()

  const runnerState = runner?.getDebugState?.()

  return {
    health,
    food,
    hasCraftingTable: hasItemMatching(bot, /crafting_table/) || hasReachableWorkstation(bot, 'crafting_table'),
    hasFurnace: hasItemMatching(bot, /furnace/) || hasNearbyBlock(bot, 'furnace', 6),
    woodCount: countItems(bot, /(?:_log|_wood)$/),
    stoneCount: countItems(bot, /^(?:cobblestone|cobbled_deepslate)$/),
    cobblestoneCount: countItems(bot, /^cobblestone$/),
    ironIngotCount: countItems(bot, /^iron_ingot$/),
    ironOreCount: countItems(bot, /^(?:iron_ore|deepslate_iron_ore|raw_iron)$/),
    diamondCount: countItems(bot, /^diamond$/),
    coalCount: countItems(bot, /^(?:coal|charcoal)$/),
    foodItemCount: countItemsWhere(bot, isFoodItemName),
    torchCount: countItems(bot, /^torch$/),
    equipmentTier,
    pickaxeTier,
    hasPickaxe: hasItemMatching(bot, /pickaxe/),
    hasIronPickaxe: hasItemMatching(bot, /^iron_pickaxe$/),
    hasDiamondPickaxe: hasItemMatching(bot, /^diamond_pickaxe$/),
    hasAxe: hasItemMatching(bot, /(?<!pick)axe/),
    hasSword: hasItemMatching(bot, /sword/),
    hasShield: hasItemMatching(bot, /shield/),
    hasDiamondHelmet: hasItemMatching(bot, /^diamond_helmet$/),
    hasDiamondChestplate: hasItemMatching(bot, /^diamond_chestplate$/),
    hasDiamondLeggings: hasItemMatching(bot, /^diamond_leggings$/),
    hasDiamondBoots: hasItemMatching(bot, /^diamond_boots$/),
    diamondArmorPieceCount: countArmorPieces(bot, 'diamond'),
    obsidianCount: countItems(bot, /^obsidian$/),
    blazeRodCount: countItems(bot, /^blaze_rod$/),
    blazePowderCount: countItems(bot, /^blaze_powder$/),
    enderPearlCount: countItems(bot, /^ender_pearl$/),
    enderEyeCount: countItems(bot, /^ender_eye$/),
    hasFlintAndSteel: hasItemMatching(bot, /^flint_and_steel$/),
    hasBow: hasItemMatching(bot, /^bow$/),
    arrowCount: countItems(bot, /^arrow$/),
    timeOfDay,
    nearbyHostileCount,
    dimension,
    position,
    runnerPhase: runnerState?.phase ?? 'UNKNOWN',
    runnerPhaseStep: runnerState?.phaseStep ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Precondition rules
// ---------------------------------------------------------------------------

interface PrecondRule {
  goalTypes: string[]
  check: (facts: WorldFacts) => string | null // null = OK, string = reason
  redirect: (facts: WorldFacts) => string
}

const PRECOND_RULES: PrecondRule[] = [
  // --- Mining without pickaxe ---
  {
    goalTypes: ['mine_stone', 'mine_iron', 'mine_gold', 'mine_diamond', 'mine_generic'],
    check: facts => facts.hasPickaxe ? null : 'No pickaxe in inventory',
    redirect: (facts) => {
      if (facts.cobblestoneCount >= 3 && facts.hasCraftingTable)
        return 'Craft a stone pickaxe'
      if (facts.woodCount >= 3 && facts.hasCraftingTable)
        return 'Craft a wooden pickaxe'
      if (facts.woodCount >= 4)
        return 'Craft a crafting table and wooden pickaxe'
      return 'Gather wood to craft a pickaxe'
    },
  },
  // --- Mining while hunger is too low to absorb cave mistakes ---
  {
    goalTypes: ['mine_stone', 'mine_iron', 'mine_gold', 'mine_diamond', 'mine_generic'],
    check: (facts) => {
      if (facts.food > 8) {
        return null
      }
      return facts.foodItemCount > 0
        ? `Food ${facts.food} should recover before mining`
        : `Food ${facts.food} with no recovery food before mining`
    },
    redirect: facts => facts.foodItemCount > 0 ? 'Eat food and recover health' : 'Collect nearby food',
  },
  // --- Mining while injured without recovery food ---
  {
    goalTypes: ['mine_stone', 'mine_iron', 'mine_gold', 'mine_diamond', 'mine_generic'],
    check: (facts) => {
      if (facts.health >= 12 || facts.food > 16) {
        return null
      }
      return facts.foodItemCount > 0
        ? `HP ${facts.health} should recover before mining`
        : `HP ${facts.health} with no recovery food before mining`
    },
    redirect: facts => facts.foodItemCount > 0 ? 'Eat food and recover health' : 'Find food and recover health',
  },
  // --- Low HP should recover before non-urgent gathering/crafting movement ---
  {
    goalTypes: ['gather_wood', 'craft_tool', 'craft_pickaxe', 'craft_crafting_table', 'craft_furnace', 'craft_armor', 'smelt'],
    check: (facts) => {
      if (facts.health >= 12) {
        return null
      }
      return facts.foodItemCount > 0
        ? `HP ${facts.health} should recover before gathering or crafting`
        : `HP ${facts.health} with no recovery food before gathering or crafting`
    },
    redirect: facts => facts.foodItemCount > 0 ? 'Eat food and recover health' : 'Collect nearby food',
  },
  // --- Diamond mining without iron pickaxe ---
  {
    goalTypes: ['mine_diamond'],
    check: facts => tierIndex(facts.pickaxeTier) >= tierIndex('iron') ? null : 'Need iron pickaxe or better for diamond mining',
    redirect: () => 'Mine iron ore and craft an iron pickaxe',
  },
  // --- Cave exploration unprepared ---
  {
    goalTypes: ['explore_cave'],
    check: (facts) => {
      const cavePrep = toolRequirements.cave_prep
      const issues: string[] = []
      if (facts.torchCount < cavePrep.minTorches)
        issues.push(`torch count ${facts.torchCount} < ${cavePrep.minTorches}`)
      if (facts.foodItemCount < cavePrep.minFoodItems)
        issues.push(`food items ${facts.foodItemCount} < ${cavePrep.minFoodItems}`)
      if (cavePrep.requiresSword && !facts.hasSword)
        issues.push('no sword')
      if (!facts.hasPickaxe)
        issues.push('no pickaxe')
      if (facts.health < cavePrep.minHealthForEntry)
        issues.push(`HP ${facts.health} < ${cavePrep.minHealthForEntry}`)
      return issues.length > 0 ? `Cave prep insufficient: ${issues.join(', ')}` : null
    },
    redirect: (facts) => {
      if (facts.health < 8)
        return 'Eat food and recover health before cave exploration'
      if (!facts.hasSword && !facts.hasPickaxe)
        return 'Craft basic tools (pickaxe and sword) before cave exploration'
      if (facts.torchCount < 4)
        return 'Gather coal and craft torches for cave exploration'
      return 'Prepare supplies (food, torches, sword) for cave exploration'
    },
  },
  // --- Fighting at low HP ---
  {
    goalTypes: ['fight'],
    check: facts => facts.health <= 4 ? `HP critically low (${facts.health})` : null,
    redirect: facts => facts.foodItemCount > 0 ? 'Eat food and recover health' : 'Find food and recover health',
  },
  // --- Fighting without weapon ---
  {
    goalTypes: ['fight'],
    check: facts => facts.hasSword ? null : 'No sword for combat',
    redirect: (facts) => {
      if (facts.cobblestoneCount >= 2 && facts.hasCraftingTable)
        return 'Craft a stone sword'
      if (facts.woodCount >= 2 && facts.hasCraftingTable)
        return 'Craft a wooden sword'
      return 'Gather materials and craft a sword'
    },
  },
  // --- Smelting without furnace ---
  {
    goalTypes: ['smelt'],
    check: facts => facts.hasFurnace ? null : 'No furnace available',
    redirect: facts => facts.cobblestoneCount >= 8 && facts.hasCraftingTable
      ? 'Craft a furnace'
      : 'Gather cobblestone and craft a furnace',
  },
  // --- Crafting 3x3 without crafting table ---
  {
    goalTypes: ['craft_tool', 'craft_armor', 'craft_pickaxe', 'craft_furnace'],
    check: facts => facts.hasCraftingTable ? null : 'No crafting table for 3x3 recipe',
    redirect: facts => facts.woodCount >= 4 ? 'Craft a crafting table' : 'Gather wood and craft a crafting table',
  },
  // --- Starvation guard: food=0 + no food items -> prioritize food ---
  {
    goalTypes: ['mine_stone', 'mine_iron', 'mine_diamond', 'mine_generic', 'mine_gold', 'explore_cave', 'explore', 'fight', 'nether', 'blaze', 'enderman', 'dragon'],
    check: facts => (facts.food <= 2 && facts.foodItemCount === 0) ? 'Starving with no food items' : null,
    redirect: () => 'Find and collect food immediately',
  },
  // --- Nether without proper gear ---
  {
    goalTypes: ['nether'],
    check: (facts) => {
      if (tierIndex(facts.equipmentTier) < tierIndex('iron'))
        return 'Need iron gear for nether'
      if (!facts.hasSword)
        return 'Need sword for nether'
      if (facts.foodItemCount < 4)
        return 'Need more food for nether'
      return null
    },
    redirect: () => 'Prepare iron gear, sword, and food for nether expedition',
  },
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateGoalPreconditions(goal: string, facts: WorldFacts): { ok: boolean, reasons: string[] } {
  const goalType = classifyGoalType(goal)
  const reasons: string[] = []

  for (const rule of PRECOND_RULES) {
    if (!rule.goalTypes.includes(goalType))
      continue
    const reason = rule.check(facts)
    if (reason)
      reasons.push(reason)
  }

  return { ok: reasons.length === 0, reasons }
}

export function computeAllowedGoals(facts: WorldFacts, bannedGoals?: Map<string, number>): AllowedSet {
  const now = Date.now()
  const allGoalTypes = new Set(GOAL_TYPE_PATTERNS.map(p => p.type))
  const blocked: AllowedSet['blocked'] = []

  for (const goalType of allGoalTypes) {
    // Check ban
    if (bannedGoals) {
      const banUntil = bannedGoals.get(goalType)
      if (banUntil && banUntil > now) {
        blocked.push({ goalType, reason: `Temporarily banned until ${new Date(banUntil).toISOString()}` })
        allGoalTypes.delete(goalType)
        incrementMetric('goalBanAppliedCount')
        continue
      }
    }

    // Check preconditions
    for (const rule of PRECOND_RULES) {
      if (!rule.goalTypes.includes(goalType))
        continue
      const reason = rule.check(facts)
      if (reason) {
        blocked.push({ goalType, reason })
        allGoalTypes.delete(goalType)
        break
      }
    }
  }

  return { allowedGoalTypes: allGoalTypes, blocked }
}

export function describeGoalConstraint(
  goal: string,
  facts: WorldFacts,
  bannedGoals?: Map<string, number>,
): GoalConstraint {
  const goalType = classifyGoalType(goal)

  if (bannedGoals) {
    const banUntil = bannedGoals.get(goalType)
    if (banUntil && banUntil > Date.now()) {
      incrementMetric('goalBanAppliedCount')
      return {
        blocked: true,
        goalType,
        source: 'ban',
        reason: `${goalType} temporarily banned`,
        banUntil,
      }
    }
  }

  for (const rule of PRECOND_RULES) {
    if (!rule.goalTypes.includes(goalType))
      continue
    const reason = rule.check(facts)
    if (reason) {
      incrementMetric('precondViolationCount')
      const redirect = rule.redirect(facts)
      return {
        blocked: true,
        goalType,
        source: 'precondition',
        reason: `${reason}; recommended preparation: ${redirect}`,
        redirect,
      }
    }
  }

  return {
    blocked: false,
    goalType,
  }
}
