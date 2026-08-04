import { describe, expect, it, vi } from 'vitest'

const { baseMocks } = vi.hoisted(() => ({
  baseMocks: {
    log: vi.fn(),
  },
}))

vi.mock('./base', () => ({
  log: baseMocks.log,
}))

const { consume } = await import('./inventory')

function createMineflayer(items: Array<{ name: string, count: number }>) {
  return {
    bot: {
      inventory: {
        items: () => items,
      },
      equip: vi.fn(async () => {}),
      consume: vi.fn(async () => {}),
    },
  } as any
}

describe('skills.consume', () => {
  it('auto-selects the best available food when no item name is provided', async () => {
    const mineflayer = createMineflayer([
      { name: 'beef', count: 2 },
      { name: 'bread', count: 1 },
    ])

    await expect(consume(mineflayer)).resolves.toBe(true)
    expect(mineflayer.bot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'bread' }), 'hand')
    expect(mineflayer.bot.consume).toHaveBeenCalledOnce()
  })

  it('accepts generic food placeholders and still eats the best item', async () => {
    const mineflayer = createMineflayer([
      { name: 'cooked_beef', count: 1 },
      { name: 'bread', count: 3 },
    ])

    await expect(consume(mineflayer, 'food')).resolves.toBe(true)
    expect(mineflayer.bot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'cooked_beef' }), 'hand')
  })
})
