import { describe, expect, it } from 'vitest'

import { getFallbackCraftRecipeRequirements } from './crafting-recipe-hints'

describe('getFallbackCraftRecipeRequirements', () => {
  it('maps wooden tool outputs to plank and stick requirements', () => {
    expect(getFallbackCraftRecipeRequirements('wooden_pickaxe', 1)).toEqual([
      { itemName: 'planks', count: 3 },
      { itemName: 'stick', count: 2 },
    ])
  })

  it('maps crafting_table to generic plank requirements', () => {
    expect(getFallbackCraftRecipeRequirements('crafting_table', 1)).toEqual([
      { itemName: 'planks', count: 4 },
    ])
  })

  it('scales recipe hints by the requested craft iterations', () => {
    expect(getFallbackCraftRecipeRequirements('torch', 2)).toEqual([
      { itemName: 'coal', count: 2 },
      { itemName: 'stick', count: 2 },
    ])
  })
})
