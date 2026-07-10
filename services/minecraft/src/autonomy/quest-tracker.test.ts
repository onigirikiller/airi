import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Vec3 } from 'vec3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QuestTracker } from './quest-tracker'

function createFakeMineflayer(inventoryItems: Array<{ name: string, count: number }> = []) {
  const listeners = new Map<string, Array<() => void>>()
  return {
    bot: {
      health: 20,
      food: 20,
      time: { timeOfDay: 1000, age: 48_000 },
      game: { dimension: 'minecraft:overworld' },
      entity: { position: new Vec3(0, 64, 0) },
      entities: {},
      inventory: {
        items: () => inventoryItems,
        slots: [],
      },
      findBlocks: () => [],
      blockAt: () => null,
      nearestEntity: () => null,
      on: (event: string, handler: () => void) => {
        const existing = listeners.get(event) ?? []
        existing.push(handler)
        listeners.set(event, existing)
      },
      off: vi.fn(),
    },
    username: 'AIra',
    emitDeath: () => {
      for (const handler of listeners.get('death') ?? []) {
        handler()
      }
    },
  } as any
}

describe('questTracker', () => {
  let dir: string
  let overlayPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airi-quest-test-'))
    overlayPath = join(dir, 'quest.txt')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a viewer-legible overlay with goal, progression, deaths, and day', async () => {
    const mineflayer = createFakeMineflayer()
    const tracker = new QuestTracker(mineflayer, null, { overlayPath })

    tracker.start()
    try {
      mineflayer.emitDeath()
      mineflayer.emitDeath()
      const state = await tracker.refresh()

      expect(state).not.toBeNull()
      expect(state!.deathCount).toBe(2)
      expect(state!.gameDay).toBe(2)

      const overlay = readFileSync(overlayPath, 'utf8')
      expect(overlay).toContain('いまの目標')
      expect(overlay).toContain('エンドラへの道')
      expect(overlay).toContain('死亡 2回')
    }
    finally {
      tracker.stop()
    }
  })

  it('celebrates forward milestone transitions on the voice bank', async () => {
    const mineflayer = createFakeMineflayer()
    const voiceBank = { play: vi.fn() }
    const tracker = new QuestTracker(mineflayer, voiceBank as any, { overlayPath })

    // First refresh establishes the baseline (furnace milestone pending).
    await tracker.refresh()
    expect(voiceBank.play).not.toHaveBeenCalled()

    // A furnace appears in the inventory: milestone advances to light-source.
    mineflayer.bot.inventory.items = () => [
      { name: 'furnace', count: 1 },
    ]
    await tracker.refresh()

    expect(voiceBank.play).toHaveBeenCalledWith('milestone')
  })

  it('does not celebrate regressions', async () => {
    const mineflayer = createFakeMineflayer([
      { name: 'oak_log', count: 8 },
      { name: 'crafting_table', count: 1 },
    ])
    const voiceBank = { play: vi.fn() }
    const tracker = new QuestTracker(mineflayer, voiceBank as any, { overlayPath })

    await tracker.refresh()
    mineflayer.bot.inventory.items = () => []
    await tracker.refresh()

    expect(voiceBank.play).not.toHaveBeenCalled()
  })
})
