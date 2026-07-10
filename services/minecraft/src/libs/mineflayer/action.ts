import type { z } from 'zod'

import type { Mineflayer } from './core'

type ActionResult = string | Promise<string>

/**
 * Declares what a tool/action requires before it can succeed.
 *
 * - `requiresTool`  — tool category needed (e.g. 'pickaxe', 'axe', 'shovel').
 *   If set to `'for-block'`, the required tool depends on the block `type` param.
 * - `requiresItem`  — item(s) that must be in inventory (e.g. `['flint_and_steel']`).
 * - `requiresNearbyBlock` — block that must be within reach (e.g. `'crafting_table'`).
 */
export interface ActionPreconditions {
  readonly requiresTool?: 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword' | 'for-block'
  readonly requiresItem?: readonly string[]
  readonly requiresNearbyBlock?: string
}

export interface Action {
  readonly name: string
  readonly description: string
  readonly schema: z.ZodObject<any>
  readonly preconditions?: ActionPreconditions
  readonly perform: (mineflayer: Mineflayer) => (...args: any[]) => ActionResult
}
