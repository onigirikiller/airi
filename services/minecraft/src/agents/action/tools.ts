import type { Block } from 'prismarine-block'

import type { Action, Mineflayer } from '../../libs/mineflayer'

import { z } from 'zod'

import { getNotableBlockObservations } from '../../libs/llm-agent/world-state'
import { recoverTowardSurface } from '../../runner/phases'
import { collectBlock } from '../../skills/actions/collect-block'
import {
  ensureAxe,
  ensureCraftingTable,
  ensureHoe,
  ensurePickaxe,
  ensureShovel,
  ensureStoneTierPickaxe,
  ensureSword,
  ensureTorches,
} from '../../skills/actions/ensure'
import { approachNearestWoodTarget, gatherWood, isWoodLikeBlockQuery } from '../../skills/actions/gather-wood'
import { discard, equip, putInChest, takeFromChest, viewChest } from '../../skills/actions/inventory'
import { activateNearestBlock, placeBlock } from '../../skills/actions/world-interactions'
import { getMiningExposureKindAccurate, getNearestBlocksAccurate, getNearestFreeSpaceAccurate } from '../../skills/block-access'
import { brewPotion } from '../../skills/brewing'
import { rangedAttack, shieldBlock } from '../../skills/combat'
import { shootBow, throwItem, useBucket, useFlintAndSteel } from '../../skills/items'
import { branchMine } from '../../skills/mining'
import { exploreLongDistance, throwAndTrackEyeOfEnder, triangulateStronghold } from '../../skills/navigation'
import { bridgeBuild, buildNetherPortal, enterPortal, lightPortal, pillarUp } from '../../skills/structures'
import { useLogger } from '../../utils/logger'
import { normalizeQueryToken, resolveBlockQueryTypes } from '../../utils/query-normalizer'

import * as skills from '../../skills'
import * as world from '../../skills/world'

interface SearchableExposureCandidate { block: Block, exposureKind: 'air' | 'fluid' }
const WOOD_SEARCH_DEFERRED_RESULT = 'Wood search deferred to trunk-aware collection.'

// Utils
const pad = (str: string): string => `\n${str}\n`

function formatInventoryItem(item: string, count: number): string {
  return count > 0 ? `\n- ${item}: ${count}` : ''
}

function formatWearingItem(slot: string, item: string | undefined): string {
  return item ? `\n${slot}: ${item}` : ''
}

async function assertActionSucceeded(actionName: string, run: () => Promise<boolean>): Promise<void> {
  try {
    const ok = await run()
    if (!ok) {
      throw new Error(`${actionName} failed`)
    }
  }
  catch (error) {
    if (error instanceof Error) {
      throw new Error(`${actionName} failed: ${error.message}`)
    }
    throw new Error(`${actionName} failed`)
  }
}

function clampSearchRange(value: number): number {
  return Math.max(32, Math.min(256, Math.trunc(value)))
}

function requiresExposedMiningSearch(blockName: string): boolean {
  const normalized = blockName.replace(/^minecraft:/, '')
  return normalized.includes('ore') || normalized.includes('stone')
}

function blockMatchesSearchTarget(blockName: string, candidateTypes: string[]): boolean {
  const normalized = normalizeQueryToken(blockName)
  return candidateTypes.some(type =>
    normalized === type
    || normalized.includes(type)
    || type.includes(normalized))
}

function getNotableSearchFallbackTarget(
  mineflayer: Mineflayer,
  rawBlockType: string,
  range: number,
): { x: number, y: number, z: number } | null {
  const candidateTypes = resolveBlockQueryTypes(normalizeQueryToken(rawBlockType))
  if (candidateTypes.length === 0) {
    return null
  }

  const observations = getNotableBlockObservations(mineflayer, Math.max(32, Math.min(96, range)))
  const match = observations.find(observation => blockMatchesSearchTarget(observation.name, candidateTypes))
  return match?.position ?? null
}

async function goToNearestSearchableBlock(
  mineflayer: Mineflayer,
  rawBlockType: string,
  minDistance: number,
  range: number,
): Promise<boolean> {
  if (isWoodLikeBlockQuery(rawBlockType)) {
    return approachNearestWoodTarget(mineflayer, rawBlockType, range)
  }

  const candidateTypes = resolveBlockQueryTypes(normalizeQueryToken(rawBlockType))
  if (candidateTypes.length === 0) {
    return false
  }

  const needsExposureFiltering = candidateTypes.some(requiresExposedMiningSearch)
  if (!needsExposureFiltering) {
    return skills.goToNearestBlock(mineflayer, rawBlockType, minDistance, range)
  }

  const blocks = await getNearestBlocksAccurate(mineflayer, candidateTypes, range, 48)
  const rankedBlocks = await Promise.all(blocks.map(async (block): Promise<SearchableExposureCandidate | null> => {
    if (!requiresExposedMiningSearch(block.name)) {
      return { block, exposureKind: 'air' }
    }

    const exposureKind = await getMiningExposureKindAccurate(mineflayer, block.position)
    return exposureKind === 'sealed' ? null : { block, exposureKind }
  }))

  const searchableBlocks = rankedBlocks
    .filter((entry): entry is SearchableExposureCandidate => entry !== null)
  const orderedBlocks = [
    ...searchableBlocks.filter(entry => entry.exposureKind === 'air'),
    ...searchableBlocks.filter(entry => entry.exposureKind === 'fluid'),
  ]
  const selectedBlock = orderedBlocks[0]?.block
  if (selectedBlock) {
    useLogger().log(`Found exposed ${selectedBlock.name} at ${selectedBlock.position}.`)
    return skills.goToPosition(
      mineflayer,
      selectedBlock.position.x,
      selectedBlock.position.y,
      selectedBlock.position.z,
      minDistance,
    )
  }

  return false
}

function normalizeRecipeName(recipeName: string): string {
  return recipeName.trim().toLowerCase().replace(/\s+/g, '_')
}

function resolveGenericToolRecipeCategory(recipeName: string): 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'hoe' | undefined {
  const normalized = normalizeRecipeName(recipeName)

  if (normalized === 'pickaxe' || normalized === 'pick_axe') {
    return 'pickaxe'
  }
  if (normalized === 'axe') {
    return 'axe'
  }
  if (normalized === 'shovel') {
    return 'shovel'
  }
  if (normalized === 'sword') {
    return 'sword'
  }
  if (normalized === 'hoe') {
    return 'hoe'
  }

  return undefined
}

function shouldUseSafeFreeSpacePlacement(blockType: string): boolean {
  return blockType === 'furnace' || blockType === 'crafting_table'
}

export const actionsList: Action[] = [
  {
    name: 'stats',
    description: 'Get your bot\'s location, health, hunger, and time of day.',
    schema: z.object({}),
    perform: mineflayer => (): string => {
      const status = mineflayer.status.toOneLiner()
      return status
    },
  },
  {
    name: 'inventory',
    description: 'Get your bot\'s inventory.',
    schema: z.object({}),
    perform: mineflayer => (): string => {
      const inventory = world.getInventoryCounts(mineflayer)
      const items = Object.entries(inventory)
        .map(([item, count]) => formatInventoryItem(item, count))
        .join('')

      const wearing = [
        formatWearingItem('Head', mineflayer.bot.inventory.slots[5]?.name),
        formatWearingItem('Torso', mineflayer.bot.inventory.slots[6]?.name),
        formatWearingItem('Legs', mineflayer.bot.inventory.slots[7]?.name),
        formatWearingItem('Feet', mineflayer.bot.inventory.slots[8]?.name),
      ].filter(Boolean).join('')

      return pad(`INVENTORY${items || ': Nothing'}
  ${mineflayer.bot.game.gameMode === 'creative' ? '\n(You have infinite items in creative mode. You do not need to gather resources!!)' : ''}
  WEARING: ${wearing || 'Nothing'}`)
    },
  },
  {
    name: 'nearbyBlocks',
    description: 'Get the blocks near the bot.',
    schema: z.object({}),
    perform: mineflayer => (): string => {
      const blocks = world.getNearbyBlockTypes(mineflayer)
      useLogger().withFields({ blocks }).log('nearbyBlocks')
      return pad(`NEARBY_BLOCKS${blocks.map((b: string) => `\n- ${b}`).join('') || ': none'}`)
    },
  },
  {
    name: 'craftable',
    description: 'Get the craftable items with the bot\'s inventory.',
    schema: z.object({}),
    perform: mineflayer => async (): Promise<string> => {
      const craftable = await world.getCraftableItems(mineflayer)
      return pad(`CRAFTABLE_ITEMS${craftable.map((i: string) => `\n- ${i}`).join('') || ': none'}`)
    },
  },
  {
    name: 'entities',
    description: 'Get the nearby players and entities.',
    schema: z.object({}),
    perform: mineflayer => (): string => {
      const players = world.getNearbyPlayerNames(mineflayer)
      const entities = world.getNearbyEntityTypes(mineflayer)
        .filter((e: string) => e !== 'player' && e !== 'item')

      const result = [
        ...players.map((p: string) => `- Human player: ${p}`),
        ...entities.map((e: string) => `- entities: ${e}`),
      ]

      return pad(`NEARBY_ENTITIES${result.length ? `\n${result.join('\n')}` : ': none'}`)
    },
  },
  // getNewAction(): Action {
  //   return {
  //     name: 'newAction',
  //     description: 'Perform new and unknown custom behaviors that are not available as a command.',
  //     schema: z.object({
  //       prompt: z.string().describe('A natural language prompt to guide code generation. Make a detailed step-by-step plan.'),
  //     }),
  //     perform: (mineflayer: BotContext) => async (prompt: string) => {
  //       if (!settings.allow_insecure_coding)
  //         return 'newAction not allowed! Code writing is disabled in settings. Notify the user.'
  //       return await ctx.coder.generateCode(mineflayer.history)
  //     },
  //   }
  // },

  // todo: must 'stop now' can be used to stop the agent
  {
    name: 'stop',
    description: 'Force stop all actions and commands that are currently executing.',
    schema: z.object({}),
    perform: mineflayer => async () => {
      // await ctx.actions.stop()
      // ctx.clearBotLogs()
      // ctx.actions.cancelResume()
      // ctx.bot.emit('idle')

      mineflayer.emit('interrupt')

      const msg = 'Agent stopped.'
      // if (mineflayer.self_prompter.on)
      //   msg += ' Self-prompting still active.'
      return msg
    },
  },

  // getStfuAction(): Action {
  //   return {
  //     name: 'stfu',
  //     description: 'Stop all chatting and self prompting, but continue current action.',
  //     schema: z.object({}),
  //     perform: (mineflayer: BotContext) => async () => {
  //       ctx.openChat('Shutting up.')
  //       ctx.shutUp()
  //       return 'Shutting up.'
  //     },
  //   }
  // },

  // getRestartAction(): Action {
  //   return {
  //     name: 'restart',
  //     description: 'Restart the agent process.',
  //     schema: z.object({}),
  //     perform: (mineflayer: BotContext) => async () => {
  //       ctx.cleanKill()
  //       return 'Restarting agent...'
  //     },
  //   }
  // },

  // getClearChatAction(): Action {
  //   return {
  //     name: 'clearChat',
  //     description: 'Clear the chat history.',
  //     schema: z.object({}),
  //     perform: (mineflayer: BotContext) => async () => {
  //       ctx.history.clear()
  //       return `${ctx.name}'s chat history was cleared, starting new conversation from scratch.`
  //     },
  //   }
  // },
  {
    name: 'goToPlayer',
    description: 'Go to the given player.',
    schema: z.object({
      player_name: z.string().describe('The name of the player to go to.'),
      closeness: z.number().describe('How close to get to the player.').min(0),
    }),
    perform: mineflayer => async (player_name: string, closeness: number) => {
      await assertActionSucceeded(
        `goToPlayer(${player_name})`,
        () => skills.goToPlayer(mineflayer, player_name, closeness),
      )
      return 'Moving to player...'
    },
  },

  {
    name: 'followPlayer',
    description: 'Endlessly follow the given player.',
    schema: z.object({
      player_name: z.string().describe('name of the player to follow.'),
      follow_dist: z.number().describe('The distance to follow from.').min(0),
    }),
    perform: mineflayer => async (player_name: string, follow_dist: number) => {
      await assertActionSucceeded(
        `followPlayer(${player_name})`,
        () => skills.followPlayer(mineflayer, player_name, follow_dist),
      )
      return 'Following player...'
    },
  },

  {
    name: 'goToCoordinates',
    description: 'Go to the given x, y, z location.',
    schema: z.object({
      x: z.number().describe('The x coordinate.'),
      y: z.number().describe('The y coordinate.').min(-64).max(320),
      z: z.number().describe('The z coordinate.'),
      closeness: z.number().describe('How close to get to the location.').min(0),
    }),
    perform: mineflayer => async (x: number, y: number, z: number, closeness: number) => {
      await assertActionSucceeded(
        `goToCoordinates(${x},${y},${z})`,
        () => skills.goToPosition(mineflayer, x, y, z, closeness),
      )
      return 'Moving to coordinates...'
    },
  },

  {
    name: 'recoverTowardSurface',
    description: 'Recover toward the surface using the stronger underground escape routine.',
    schema: z.object({
      reason: z.string().describe('Optional short reason for the recovery attempt.').optional(),
    }),
    perform: mineflayer => async (reason?: string) => {
      const normalizedReason = reason?.trim() || 'llm-surface-recovery'
      await assertActionSucceeded(
        `recoverTowardSurface(${normalizedReason})`,
        () => recoverTowardSurface(mineflayer, normalizedReason),
      )
      return 'Recovering toward the surface...'
    },
  },

  {
    name: 'searchForBlock',
    description: 'Find and go to the nearest block of a given type in a given range.',
    schema: z.object({
      type: z.string().describe('The block type to go to.'),
      search_range: z.number().describe('The range to search for the block.').min(32).max(512),
    }),
    perform: mineflayer => async (block_type: string, range: number) => {
      const primaryRange = clampSearchRange(range)
      const expandedRange = clampSearchRange(Math.max(primaryRange * 2, 96))
      const isWoodSearch = isWoodLikeBlockQuery(block_type)
      let found = false
      const notableFallbackTarget = getNotableSearchFallbackTarget(mineflayer, block_type, expandedRange)

      try {
        found = await goToNearestSearchableBlock(mineflayer, block_type, 4, primaryRange)
      }
      catch {
        found = false
      }

      if (!found && isWoodSearch) {
        try {
          found = await goToNearestSearchableBlock(mineflayer, block_type, 4, expandedRange)
        }
        catch {
          found = false
        }

        if (!found && notableFallbackTarget) {
          useLogger().withFields({
            blockType: block_type,
            position: notableFallbackTarget,
          }).log('searchForBlock saw wood but skipped generic notable-block pathing; collectBlocks will use trunk-aware recovery.')
          return WOOD_SEARCH_DEFERRED_RESULT
        }
      }

      if (!found && !isWoodSearch && notableFallbackTarget) {
        useLogger().withFields({
          blockType: block_type,
          position: notableFallbackTarget,
        }).log('searchForBlock falling back to the latest notable-block coordinates')
        try {
          found = await skills.goToPosition(
            mineflayer,
            notableFallbackTarget.x,
            notableFallbackTarget.y,
            notableFallbackTarget.z,
            4,
          )
        }
        catch {
          found = false
        }
      }

      if (!found && !isWoodSearch) {
        await skills.moveAway(mineflayer, 12)
        found = await goToNearestSearchableBlock(mineflayer, block_type, 4, expandedRange)
      }

      if (!found) {
        if (isWoodSearch) {
          useLogger().withFields({ blockType: block_type, primaryRange, expandedRange }).log('searchForBlock deferred unresolved wood search to collectBlocks.')
          return WOOD_SEARCH_DEFERRED_RESULT
        }
        throw new Error(`searchForBlock(${block_type}) failed`)
      }
      return 'Searching for block...'
    },
  },

  {
    name: 'searchForEntity',
    description: 'Find and go to the nearest entity of a given type in a given range.',
    schema: z.object({
      type: z.string().describe('The type of entity to go to.'),
      search_range: z.number().describe('The range to search for the entity.').min(32).max(512),
    }),
    perform: mineflayer => async (entity_type: string, range: number) => {
      const normalizedType = entity_type.trim().toLowerCase()
      const primaryRange = clampSearchRange(range)
      const expandedRange = clampSearchRange(Math.max(primaryRange * 2, 96))

      const candidateTypes = [normalizedType]
      if (['cow', 'sheep', 'pig', 'chicken', 'rabbit'].includes(normalizedType)) {
        candidateTypes.push('animal')
      }

      let found = false
      for (const candidate of candidateTypes) {
        if (found) {
          break
        }

        try {
          found = await skills.goToNearestEntity(mineflayer, candidate, 4, primaryRange)
        }
        catch {
          found = false
        }

        if (!found) {
          found = await skills.goToNearestEntity(mineflayer, candidate, 4, expandedRange)
        }
      }

      if (!found) {
        throw new Error(`searchForEntity(${entity_type}) failed`)
      }
      return 'Searching for entity...'
    },
  },

  {
    name: 'moveAway',
    description: 'Move away from the current location in any direction by a given distance.',
    schema: z.object({
      distance: z.number().describe('The distance to move away.').min(0),
    }),
    perform: mineflayer => async (distance: number) => {
      await assertActionSucceeded(
        `moveAway(${distance})`,
        () => skills.moveAway(mineflayer, distance),
      )
      return 'Moving away...'
    },
  },

  {
    name: 'givePlayer',
    description: 'Give the specified item to the given player.',
    schema: z.object({
      player_name: z.string().describe('The name of the player to give the item to.'),
      item_name: z.string().describe('The name of the item to give.'),
      num: z.number().int().describe('The number of items to give.').min(1),
    }),
    perform: mineflayer => async (player_name: string, item_name: string, num: number) => {
      await assertActionSucceeded(
        `givePlayer(${item_name}x${num}=>${player_name})`,
        () => skills.giveToPlayer(mineflayer, item_name, player_name, num),
      )
      return 'Giving items to player...'
    },
  },

  {
    name: 'consume',
    description: 'Eat/drink the given item.',
    schema: z.object({
      item_name: z.string().describe('The name of the item to consume.'),
    }),
    perform: mineflayer => async (item_name: string) => {
      await assertActionSucceeded(
        `consume(${item_name})`,
        () => skills.consume(mineflayer, item_name),
      )
      return 'Consuming item...'
    },
  },

  {
    name: 'equip',
    description: 'Equip the given item.',
    schema: z.object({
      item_name: z.string().describe('The name of the item to equip.'),
    }),
    perform: mineflayer => async (item_name: string) => {
      await assertActionSucceeded(
        `equip(${item_name})`,
        () => equip(mineflayer, item_name),
      )
      return 'Equipping item...'
    },
  },

  {
    name: 'putInChest',
    description: 'Put the given item in the nearest chest.',
    schema: z.object({
      item_name: z.string().describe('The name of the item to put in the chest.'),
      num: z.number().int().describe('The number of items to put in the chest.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await assertActionSucceeded(
        `putInChest(${item_name}x${num})`,
        () => putInChest(mineflayer, item_name, num),
      )
      return 'Putting items in chest...'
    },
  },

  {
    name: 'takeFromChest',
    description: 'Take the given items from the nearest chest.',
    schema: z.object({
      item_name: z.string().describe('The name of the item to take.'),
      num: z.number().int().describe('The number of items to take.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await assertActionSucceeded(
        `takeFromChest(${item_name}x${num})`,
        () => takeFromChest(mineflayer, item_name, num),
      )
      return 'Taking items from chest...'
    },
  },

  {
    name: 'viewChest',
    description: 'View the items/counts of the nearest chest.',
    schema: z.object({}),
    perform: mineflayer => async () => {
      await assertActionSucceeded(
        'viewChest',
        () => viewChest(mineflayer),
      )
      return 'Viewing chest contents...'
    },
  },

  {
    name: 'discard',
    description: 'Discard the given item from the inventory.',
    schema: z.object({
      item_name: z.string().describe('The name of the item to discard.'),
      num: z.number().int().describe('The number of items to discard.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await assertActionSucceeded(
        `discard(${item_name}x${num})`,
        () => discard(mineflayer, item_name, num),
      )
      return 'Discarding items...'
    },
  },

  {
    name: 'collectBlocks',
    description: 'Collect the nearest blocks of a given type.',
    schema: z.object({
      type: z.string().describe('The block type to collect.'),
      num: z.number().int().describe('The number of blocks to collect.').min(1),
    }),
    preconditions: { requiresTool: 'for-block' },
    perform: mineflayer => async (type: string, num: number) => {
      const normalizedType = type.trim().toLowerCase()
      if (isWoodLikeBlockQuery(normalizedType)) {
        let success = await gatherWood(mineflayer, num, 24, normalizedType)
        if (!success) {
          success = await gatherWood(mineflayer, num, 64, normalizedType)
        }
        if (!success) {
          throw new Error(`collectBlocks failed: ${type} x${num} not found or unreachable`)
        }
        return 'Collecting wood...'
      }

      let success = await collectBlock(mineflayer, type, num, 24)
      if (!success) {
        success = await collectBlock(mineflayer, type, num, 64)
      }
      if (!success) {
        throw new Error(`collectBlocks failed: ${type} x${num} not found or unreachable`)
      }
      return 'Collecting blocks...'
    },
  },

  {
    name: 'craftRecipe',
    description: 'Craft the given recipe a given number of times.',
    schema: z.object({
      recipe_name: z.string().describe('The name of the output item to craft.'),
      num: z.number().int().describe('The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.').min(1),
    }),
    perform: mineflayer => async (recipe_name: string, num: number) => {
      const normalized = normalizeRecipeName(recipe_name)
      const genericToolCategory = resolveGenericToolRecipeCategory(normalized)

      if (normalized === 'crafting_table') {
        await assertActionSucceeded('ensureCraftingTable', () => ensureCraftingTable(mineflayer))
        return 'Crafting table is ready.'
      }

      if (genericToolCategory === 'pickaxe') {
        await assertActionSucceeded(`ensurePickaxe(x${num})`, () => ensurePickaxe(mineflayer, num))
        return 'Pickaxe crafted/prepared.'
      }
      if (genericToolCategory === 'axe') {
        await assertActionSucceeded(`ensureAxe(x${num})`, () => ensureAxe(mineflayer, num))
        return 'Axe crafted/prepared.'
      }
      if (genericToolCategory === 'shovel') {
        await assertActionSucceeded(`ensureShovel(x${num})`, () => ensureShovel(mineflayer, num))
        return 'Shovel crafted/prepared.'
      }
      if (genericToolCategory === 'sword') {
        await assertActionSucceeded(`ensureSword(x${num})`, () => ensureSword(mineflayer, num))
        return 'Sword crafted/prepared.'
      }
      if (genericToolCategory === 'hoe') {
        await assertActionSucceeded(`ensureHoe(x${num})`, () => ensureHoe(mineflayer, num))
        return 'Hoe crafted/prepared.'
      }

      if (normalized === 'wooden_pickaxe') {
        await assertActionSucceeded(`ensurePickaxe(x${num})`, () => ensurePickaxe(mineflayer, num))
        return 'Pickaxe crafted/prepared.'
      }
      if (normalized === 'stone_pickaxe' && num === 1) {
        await assertActionSucceeded('ensureStoneTierPickaxe', () => ensureStoneTierPickaxe(mineflayer))
        return 'Stone-tier pickaxe crafted/prepared.'
      }

      if (normalized.endsWith('_pickaxe')) {
        await assertActionSucceeded(
          `craftRecipe(${normalized},${num})`,
          () => skills.craftRecipe(mineflayer, normalized, num),
        )
        return 'Pickaxe crafted/prepared.'
      }
      if (normalized.endsWith('_axe') && !normalized.endsWith('_pickaxe')) {
        const craftedExact = await skills.craftRecipe(mineflayer, normalized, num)
        if (!craftedExact) {
          await assertActionSucceeded(`ensureAxe(x${num})`, () => ensureAxe(mineflayer, num))
        }
        return 'Axe crafted/prepared.'
      }
      if (normalized.endsWith('_shovel')) {
        const craftedExact = await skills.craftRecipe(mineflayer, normalized, num)
        if (!craftedExact) {
          await assertActionSucceeded(`ensureShovel(x${num})`, () => ensureShovel(mineflayer, num))
        }
        return 'Shovel crafted/prepared.'
      }
      if (normalized.endsWith('_sword')) {
        const craftedExact = await skills.craftRecipe(mineflayer, normalized, num)
        if (!craftedExact) {
          await assertActionSucceeded(`ensureSword(x${num})`, () => ensureSword(mineflayer, num))
        }
        return 'Sword crafted/prepared.'
      }
      if (normalized.endsWith('_hoe')) {
        const craftedExact = await skills.craftRecipe(mineflayer, normalized, num)
        if (!craftedExact) {
          await assertActionSucceeded(`ensureHoe(x${num})`, () => ensureHoe(mineflayer, num))
        }
        return 'Hoe crafted/prepared.'
      }

      await assertActionSucceeded(
        `craftRecipe(${normalized},${num})`,
        () => skills.craftRecipe(mineflayer, normalized, num),
      )
      return 'Crafting items...'
    },
  },

  {
    name: 'smeltItem',
    description: 'Smelt the given item the given number of times.',
    schema: z.object({
      item_name: z.string().describe('The name of the input item to smelt.'),
      num: z.number().int().describe('The number of times to smelt the item.').min(1),
    }),
    preconditions: { requiresNearbyBlock: 'furnace' },
    perform: mineflayer => async (item_name: string, num: number) => {
      await assertActionSucceeded(
        `smeltItem(${item_name}x${num})`,
        () => skills.smeltItem(mineflayer, item_name, num),
      )
      return 'Smelting items...'
    },
  },

  {
    name: 'clearFurnace',
    description: 'Take all items out of the nearest furnace.',
    schema: z.object({}),
    perform: mineflayer => async () => {
      await assertActionSucceeded(
        'clearFurnace',
        () => skills.clearNearestFurnace(mineflayer),
      )
      return 'Clearing furnace...'
    },
  },

  {
    name: 'placeHere',
    description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
    schema: z.object({
      type: z.string().describe('The block type to place.'),
    }),
    perform: mineflayer => async (type: string) => {
      const normalizedType = type.trim().toLowerCase().replace(/\s+/g, '_')
      if (normalizedType === 'torch') {
        await assertActionSucceeded('ensureTorches', () => ensureTorches(mineflayer, 4))
      }
      const pos = shouldUseSafeFreeSpacePlacement(normalizedType)
        ? await getNearestFreeSpaceAccurate(mineflayer, 1, 8)
        : mineflayer.bot.entity.position
      if (!pos) {
        throw new Error(`placeHere(${normalizedType}) failed: no safe nearby free space`)
      }
      await assertActionSucceeded(
        `placeHere(${normalizedType})`,
        () => placeBlock(mineflayer, normalizedType, pos.x, pos.y, pos.z),
      )
      return 'Placing block...'
    },
  },

  {
    name: 'attack',
    description: 'Attack and kill the nearest entity of a given type.',
    schema: z.object({
      type: z.string().describe('The type of entity to attack.'),
    }),
    perform: mineflayer => async (type: string) => {
      const normalizedType = type.trim().toLowerCase()
      const candidateTypes = [normalizedType]
      if (['cow', 'sheep', 'pig', 'chicken', 'rabbit'].includes(normalizedType)) {
        candidateTypes.push('animal')
      }

      let attacked = false
      for (const candidate of candidateTypes) {
        attacked = await skills.attackNearest(mineflayer, candidate, true)
        if (attacked) {
          break
        }
      }

      if (!attacked) {
        throw new Error(`attack(${type}) failed`)
      }
      return 'Attacking entity...'
    },
  },

  {
    name: 'attackPlayer',
    description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
    schema: z.object({
      player_name: z.string().describe('The name of the player to attack.'),
    }),
    perform: mineflayer => async (player_name: string) => {
      const player = mineflayer.bot.players[player_name]?.entity
      if (!player) {
        throw new Error(`attackPlayer failed: player not found (${player_name})`)
      }
      await assertActionSucceeded(
        `attackPlayer(${player_name})`,
        () => skills.attackEntity(mineflayer, player, true),
      )
      return 'Attacking player...'
    },
  },

  {
    name: 'goToBed',
    description: 'Go to the nearest bed and sleep.',
    schema: z.object({}),
    perform: mineflayer => async () => {
      await assertActionSucceeded(
        'goToBed',
        () => skills.goToBed(mineflayer),
      )
      return 'Going to bed...'
    },
  },

  {
    name: 'activate',
    description: 'Activate the nearest object of a given type.',
    schema: z.object({
      type: z.string().describe('The type of object to activate.'),
    }),
    perform: mineflayer => async (type: string) => {
      await assertActionSucceeded(
        `activate(${type})`,
        () => activateNearestBlock(mineflayer, type),
      )
      return 'Activating block...'
    },
  },

  {
    name: 'stay',
    description: 'Stay in the current location no matter what. Pauses all modes.',
    schema: z.object({
      type: z.number().int().describe('The number of seconds to stay. -1 for forever.').min(-1),
    }),
    perform: mineflayer => async (seconds: number) => {
      await assertActionSucceeded(
        `stay(${seconds})`,
        () => skills.stay(mineflayer, seconds),
      )
      return 'Staying in place...'
    },
  },
  // getSetModeAction(): Action {
  //   return {
  //     name: 'setMode',
  //     description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
  //     schema: z.object({
  //       mode_name: z.string().describe('The name of the mode to enable.'),
  //       on: z.boolean().describe('Whether to enable or disable the mode.'),
  //     }),
  //     perform: (mineflayer: BotContext) => async (mode_name: string, on: boolean) => {
  //       const modes = ctx.bot.modes
  //       if (!modes.exists(mode_name))
  //         return `Mode ${mode_name} does not exist.${modes.getDocs()}`
  //       if (modes.isOn(mode_name) === on)
  //         return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`
  //       modes.setOn(mode_name, on)
  //       return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`
  //     },
  //   }
  // },

  // ─── Phase 1: Item Use Primitives ─────────────────────────────────────

  {
    name: 'useBucket',
    description: 'Use a bucket to pick up or place water/lava at a position.',
    schema: z.object({
      bucket_type: z.enum(['bucket', 'water_bucket', 'lava_bucket']).describe('The type of bucket to use.'),
      x: z.number().describe('The x coordinate.'),
      y: z.number().describe('The y coordinate.'),
      z: z.number().describe('The z coordinate.'),
    }),
    perform: mineflayer => async (bucket_type: string, x: number, y: number, z: number) => {
      await assertActionSucceeded(
        `useBucket(${bucket_type})`,
        () => useBucket(mineflayer, bucket_type, x, y, z),
      )
      return 'Bucket used.'
    },
  },

  {
    name: 'useFlintAndSteel',
    description: 'Use flint and steel to start a fire at a position (e.g. light nether portal).',
    preconditions: { requiresItem: ['flint_and_steel'] },
    schema: z.object({
      x: z.number().describe('The x coordinate.'),
      y: z.number().describe('The y coordinate.'),
      z: z.number().describe('The z coordinate.'),
    }),
    perform: mineflayer => async (x: number, y: number, z: number) => {
      await assertActionSucceeded(
        'useFlintAndSteel',
        () => useFlintAndSteel(mineflayer, x, y, z),
      )
      return 'Lit fire with flint and steel.'
    },
  },

  {
    name: 'shootBow',
    description: 'Shoot a bow at target coordinates.',
    preconditions: { requiresItem: ['bow', 'arrow'] },
    schema: z.object({
      x: z.number().describe('The target x coordinate.'),
      y: z.number().describe('The target y coordinate.'),
      z: z.number().describe('The target z coordinate.'),
      charge_ms: z.number().optional().describe('How long to charge the bow in ms (default 1200).'),
    }),
    perform: mineflayer => async (x: number, y: number, z: number, charge_ms?: number) => {
      await assertActionSucceeded(
        'shootBow',
        () => shootBow(mineflayer, x, y, z, charge_ms ?? 1200),
      )
      return 'Shot bow.'
    },
  },

  {
    name: 'throwEnderPearl',
    description: 'Throw an ender pearl to teleport.',
    preconditions: { requiresItem: ['ender_pearl'] },
    schema: z.object({}),
    perform: mineflayer => async () => {
      await assertActionSucceeded(
        'throwEnderPearl',
        () => throwItem(mineflayer, 'ender_pearl'),
      )
      return 'Threw ender pearl.'
    },
  },

  // ─── Phase 2: Dimensions & Structures ──────────────────────────────────

  {
    name: 'buildNetherPortal',
    description: 'Build a nether portal frame using obsidian (requires 10 obsidian).',
    preconditions: { requiresItem: ['obsidian'] },
    schema: z.object({
      x: z.number().describe('Base x coordinate.'),
      y: z.number().describe('Base y coordinate.'),
      z: z.number().describe('Base z coordinate.'),
      facing: z.enum(['north', 'south', 'east', 'west']).describe('Direction the portal faces.'),
    }),
    perform: mineflayer => async (x: number, y: number, z: number, facing: 'north' | 'south' | 'east' | 'west') => {
      await assertActionSucceeded(
        'buildNetherPortal',
        () => buildNetherPortal(mineflayer, x, y, z, facing),
      )
      return 'Nether portal built.'
    },
  },

  {
    name: 'lightPortal',
    description: 'Light a nether portal with flint and steel.',
    preconditions: { requiresItem: ['flint_and_steel'] },
    schema: z.object({
      x: z.number().describe('Portal interior x.'),
      y: z.number().describe('Portal interior y.'),
      z: z.number().describe('Portal interior z.'),
    }),
    perform: mineflayer => async (x: number, y: number, z: number) => {
      await assertActionSucceeded(
        'lightPortal',
        () => lightPortal(mineflayer, x, y, z),
      )
      return 'Portal lit.'
    },
  },

  {
    name: 'enterPortal',
    description: 'Walk into a portal to travel to another dimension.',
    schema: z.object({
      x: z.number().describe('Portal x coordinate.'),
      y: z.number().describe('Portal y coordinate.'),
      z: z.number().describe('Portal z coordinate.'),
    }),
    perform: mineflayer => async (x: number, y: number, z: number) => {
      await assertActionSucceeded(
        'enterPortal',
        () => enterPortal(mineflayer, x, y, z),
      )
      return 'Traveled through portal.'
    },
  },

  {
    name: 'pillarUp',
    description: 'Pillar up by placing blocks beneath while jumping.',
    schema: z.object({
      block_type: z.string().describe('Block type to use for pillaring.'),
      height: z.number().int().min(1).max(64).describe('How many blocks to pillar up.'),
    }),
    perform: mineflayer => async (block_type: string, height: number) => {
      await assertActionSucceeded(
        `pillarUp(${height})`,
        () => pillarUp(mineflayer, block_type, height),
      )
      return `Pillared up ${height} blocks.`
    },
  },

  {
    name: 'bridgeBuild',
    description: 'Build a horizontal bridge in a direction.',
    schema: z.object({
      block_type: z.string().describe('Block type to use for bridging.'),
      direction: z.enum(['north', 'south', 'east', 'west']).describe('Direction to build.'),
      length: z.number().int().min(1).max(64).describe('Length of the bridge.'),
    }),
    perform: mineflayer => async (block_type: string, direction: 'north' | 'south' | 'east' | 'west', length: number) => {
      await assertActionSucceeded(
        `bridgeBuild(${length})`,
        () => bridgeBuild(mineflayer, block_type, direction, length),
      )
      return `Built bridge ${length} blocks ${direction}.`
    },
  },

  {
    name: 'getDimension',
    description: 'Get the current dimension (overworld, nether, end).',
    schema: z.object({}),
    perform: mineflayer => () => {
      const dim = mineflayer.bot.game.dimension
      return `Current dimension: ${dim}`
    },
  },

  {
    name: 'respawn',
    description: 'Respawn after death.',
    schema: z.object({}),
    perform: mineflayer => async () => {
      const bot = mineflayer.bot as any
      if ('respawn' in bot) {
        await bot.respawn()
        return 'Respawned.'
      }
      return 'Respawn not available.'
    },
  },

  // ─── Phase 3: Eye of Ender & Exploration ────────────────────────────

  {
    name: 'throwEyeOfEnder',
    description: 'Throw an eye of ender to detect stronghold direction.',
    preconditions: { requiresItem: ['ender_eye'] },
    schema: z.object({}),
    perform: mineflayer => async () => {
      const result = await throwAndTrackEyeOfEnder(mineflayer)
      if (!result) {
        throw new Error('throwEyeOfEnder failed')
      }
      return `Eye of ender direction: (${result.direction.x.toFixed(2)}, ${result.direction.z.toFixed(2)}), end position: (${result.endPos.x.toFixed(0)}, ${result.endPos.y.toFixed(0)}, ${result.endPos.z.toFixed(0)})`
    },
  },

  {
    name: 'triangulateStronghold',
    description: 'Use two eye of ender throws to triangulate the stronghold position. Requires 2 ender eyes and will move ~400 blocks.',
    schema: z.object({}),
    perform: mineflayer => async () => {
      const result = await triangulateStronghold(mineflayer)
      if (!result) {
        throw new Error('triangulateStronghold failed')
      }
      return `Stronghold estimated at (${result.x}, ${result.z})`
    },
  },

  {
    name: 'exploreLongDistance',
    description: 'Travel a long distance in a direction (useful for finding nether fortresses).',
    schema: z.object({
      direction: z.enum(['north', 'south', 'east', 'west']).describe('Direction to travel.'),
      distance: z.number().int().min(10).max(2000).describe('Distance to travel in blocks.'),
    }),
    perform: mineflayer => async (direction: 'north' | 'south' | 'east' | 'west', distance: number) => {
      await assertActionSucceeded(
        `exploreLongDistance(${direction},${distance})`,
        () => exploreLongDistance(mineflayer, direction, distance),
      )
      return `Traveled ${distance} blocks ${direction}.`
    },
  },

  // ─── Phase 4: Brewing ──────────────────────────────────────────────

  {
    name: 'brewPotion',
    description: 'Brew a potion at a brewing stand.',
    preconditions: { requiresNearbyBlock: 'brewing_stand' },
    schema: z.object({
      ingredient: z.string().describe('The ingredient to brew with (e.g. nether_wart, blaze_powder, ghast_tear).'),
      base: z.string().describe('The base bottle type (e.g. glass_bottle, potion).').default('glass_bottle'),
      count: z.number().int().min(1).max(3).describe('Number of potions to brew (max 3).').default(3),
    }),
    perform: mineflayer => async (ingredient: string, base: string, count: number) => {
      await assertActionSucceeded(
        `brewPotion(${ingredient})`,
        () => brewPotion(mineflayer, ingredient, base, count),
      )
      return `Brewed potion with ${ingredient}.`
    },
  },

  // ─── Phase 5: Enchanting ───────────────────────────────────────────

  {
    name: 'enchant',
    description: 'Enchant an item at an enchanting table. Requires lapis lazuli and XP levels.',
    preconditions: { requiresItem: ['lapis_lazuli'], requiresNearbyBlock: 'enchanting_table' },
    schema: z.object({
      item_name: z.string().describe('Name of the item to enchant.'),
      level: z.number().int().min(1).max(3).describe('Enchantment level (1-3). Higher levels require more XP and bookshelves.'),
    }),
    perform: mineflayer => async (item_name: string, level: number) => {
      await assertActionSucceeded(
        `enchant(${item_name},${level})`,
        () => skills.enchantItem(mineflayer, item_name, level as 1 | 2 | 3),
      )
      return `Enchanted ${item_name} at level ${level}.`
    },
  },

  // ─── Phase 6: Advanced Combat ─────────────────────────────────────

  {
    name: 'rangedAttack',
    description: 'Shoot arrows at the nearest entity of a given type.',
    preconditions: { requiresItem: ['bow', 'arrow'] },
    schema: z.object({
      entity_type: z.string().describe('The type of entity to attack.'),
      max_shots: z.number().int().min(1).max(64).describe('Maximum number of arrows to shoot.').default(5),
    }),
    perform: mineflayer => async (entity_type: string, max_shots: number) => {
      await assertActionSucceeded(
        `rangedAttack(${entity_type})`,
        () => rangedAttack(mineflayer, entity_type, max_shots),
      )
      return `Ranged attack on ${entity_type}.`
    },
  },

  {
    name: 'shieldBlock',
    description: 'Block with a shield for a duration.',
    preconditions: { requiresItem: ['shield'] },
    schema: z.object({
      duration_ms: z.number().int().min(500).max(10000).describe('Duration to block in milliseconds.').default(2000),
    }),
    perform: mineflayer => async (duration_ms: number) => {
      await assertActionSucceeded(
        'shieldBlock',
        () => shieldBlock(mineflayer, duration_ms),
      )
      return 'Blocked with shield.'
    },
  },

  // ─── Phase 7: Mining ───────────────────────────────────────────────

  {
    name: 'branchMine',
    description: 'Perform branch mining at a target Y level. Digs a main tunnel with side branches for efficient ore discovery.',
    schema: z.object({
      target_y: z.number().int().min(-64).max(320).describe('Y level to mine at (e.g. -59 for diamonds, 15 for iron).'),
      main_length: z.number().int().min(5).max(100).describe('Length of the main tunnel.'),
      branch_length: z.number().int().min(3).max(32).describe('Length of each side branch.'),
    }),
    preconditions: { requiresTool: 'pickaxe' },
    perform: mineflayer => async (target_y: number, main_length: number, branch_length: number) => {
      await assertActionSucceeded(
        `branchMine(y=${target_y})`,
        () => branchMine(mineflayer, target_y, main_length, branch_length),
      )
      return `Branch mining complete at Y=${target_y}.`
    },
  },

  // getGoalAction(): Action {
  //   return {
  //     name: 'goal',
  //     description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
  //     schema: z.object({
  //       selfPrompt: z.string().describe('The goal prompt.'),
  //     }),
  //     perform: (mineflayer: BotContext) => async (prompt: string) => {
  //       if (convoManager.inConversation()) {
  //         ctx.self_prompter.setPrompt(prompt)
  //         convoManager.scheduleSelfPrompter()
  //       }
  //       else {
  //         ctx.self_prompter.start(prompt)
  //       }
  //       return 'Goal set...'
  //     },
  //   }
  // },

  // getEndGoalAction(): Action {
  //   return {
  //     name: 'endGoal',
  //     description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action.',
  //     schema: z.object({}),
  //     perform: (mineflayer: BotContext) => async () => {
  //       ctx.self_prompter.stop()
  //       convoManager.cancelSelfPrompter()
  //       return 'Self-prompting stopped.'
  //     },
  //   }
  // },

  // getStartConversationAction(): Action {
  //   return {
  //     name: 'startConversation',
  //     description: 'Start a conversation with a player. Use for bots only.',
  //     schema: z.object({
  //       player_name: z.string().describe('The name of the player to send the message to.'),
  //       message: z.string().describe('The message to send.'),
  //     }),
  //     perform: (mineflayer: BotContext) => async (player_name: string, message: string) => {
  //       if (!convoManager.isOtherAgent(player_name))
  //         return `${player_name} is not a bot, cannot start conversation.`
  //       if (convoManager.inConversation() && !convoManager.inConversation(player_name))
  //         convoManager.forceEndCurrentConversation()
  //       else if (convoManager.inConversation(player_name))
  //         ctx.history.add('system', `You are already in conversation with ${player_name}. Don't use this command to talk to them.`)
  //       convoManager.startConversation(player_name, message)
  //     },
  //   }
  // },

  // getEndConversationAction(): Action {
  //   return {
  //     name: 'endConversation',
  //     description: 'End the conversation with the given player.',
  //     schema: z.object({
  //       player_name: z.string().describe('The name of the player to end the conversation with.'),
  //     }),
  //     perform: (mineflayer: BotContext) => async (player_name: string) => {
  //       if (!convoManager.inConversation(player_name))
  //         return `Not in conversation with ${player_name}.`
  //       convoManager.endConversation(player_name)
  //       return `Converstaion with ${player_name} ended.`
  //     },
  //   }
  // },
]
