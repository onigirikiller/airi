import { Vec3 } from 'vec3'
import { describe, expect, it, vi } from 'vitest'

import { breakBlockAt } from './blocks'

vi.mock('./block-access', () => ({
  getBlockAtAccurate: vi.fn(async (_mineflayer: unknown, pos: Vec3) => ({
    name: 'spruce_log',
    position: pos,
  })),
  getNearestBlockAccurate: vi.fn(),
}))

vi.mock('./movement', () => ({
  goToPosition: vi.fn(async () => true),
}))

vi.mock('./world', () => ({
  getNearestBlocks: vi.fn(() => []),
  getPosition: vi.fn(() => new Vec3(0, 64, 0)),
  shouldPlaceTorch: vi.fn(() => false),
}))

vi.mock('../utils/mcdata', () => ({
  getBlockId: vi.fn(() => 1),
  makeItem: vi.fn(),
}))

describe('blocks FabricBridge fallback', () => {
  it('breakBlockAt does not require Movements when registry metadata is unavailable', async () => {
    const dig = vi.fn(async () => {})
    const equipForBlock = vi.fn(async () => {})
    const goto = vi.fn(async () => {})
    const setMovements = vi.fn()

    const mineflayer = {
      allowCheats: false,
      isCreative: false,
      bot: {
        chat: vi.fn(),
        registry: undefined,
        entity: {
          position: new Vec3(0, 64, 0),
        },
        tool: {
          equipForBlock,
        },
        pathfinder: {
          goto,
          setMovements,
        },
        dig,
        heldItem: null,
      },
    } as any

    const success = await breakBlockAt(mineflayer, 10, 64, 10)

    expect(success).toBe(true)
    expect(goto).toHaveBeenCalled()
    expect(setMovements).not.toHaveBeenCalled()
    expect(dig).toHaveBeenCalled()
  })

  it('stops pathfinder when block-break positioning does not resolve', async () => {
    vi.useFakeTimers()
    try {
      const dig = vi.fn(async () => {})
      const equipForBlock = vi.fn(async () => {})
      const goto = vi.fn(() => new Promise<void>(() => {}))
      const stop = vi.fn()

      const mineflayer = {
        allowCheats: false,
        isCreative: false,
        bot: {
          chat: vi.fn(),
          registry: undefined,
          entity: {
            position: new Vec3(0, 64, 0),
          },
          tool: {
            equipForBlock,
          },
          pathfinder: {
            goto,
            stop,
            setMovements: vi.fn(),
          },
          dig,
          heldItem: null,
        },
      } as any

      const successPromise = breakBlockAt(mineflayer, 10, 64, 10)
      const rejected = expect(successPromise).rejects.toThrow('Pathing to spruce_log at 10, 64, 10 timed out after 20000ms')
      await vi.advanceTimersByTimeAsync(20_000)

      await rejected
      expect(stop).toHaveBeenCalledOnce()
      expect(dig).not.toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('stops digging when the server never completes a block break', async () => {
    vi.useFakeTimers()
    try {
      const dig = vi.fn(() => new Promise<void>(() => {}))
      const stopDigging = vi.fn()
      const equipForBlock = vi.fn(async () => {})
      const goto = vi.fn(async () => {})

      const mineflayer = {
        allowCheats: false,
        isCreative: false,
        bot: {
          chat: vi.fn(),
          registry: undefined,
          entity: {
            position: new Vec3(10, 64, 10),
          },
          tool: {
            equipForBlock,
          },
          pathfinder: {
            goto,
            setMovements: vi.fn(),
          },
          dig,
          stopDigging,
          heldItem: null,
        },
      } as any

      const successPromise = breakBlockAt(mineflayer, 10, 64, 10)
      const rejected = expect(successPromise).rejects.toThrow('Digging spruce_log at 10, 64, 10 timed out after 15000ms')
      await vi.advanceTimersByTimeAsync(15_000)

      await rejected
      expect(stopDigging).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })
})
