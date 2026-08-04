import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Vec3 } from 'vec3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GameRunner } from './index'
import { GamePhase } from './state'

const mocks = vi.hoisted(() => ({
  determinePhase: vi.fn(),
  executePhase: vi.fn(),
  recoverTowardSurface: vi.fn(async () => false),
  survivalCheck: vi.fn(async () => {}),
  getPosition: vi.fn(() => new Vec3(0, 64, 0)),
  getItemCount: vi.fn(() => 0),
  moveAway: vi.fn(async () => true),
  recordDeathPosition: vi.fn(() => ({ x: 0, y: 64, z: 0 })),
  recoverAfterDeath: vi.fn(async () => true),
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withError: vi.fn(),
    withFields: vi.fn(),
  },
}))

mocks.logger.withError.mockReturnValue(mocks.logger)
mocks.logger.withFields.mockReturnValue(mocks.logger)

vi.mock('./phases', () => ({
  determinePhase: mocks.determinePhase,
  executePhase: mocks.executePhase,
  recoverTowardSurface: mocks.recoverTowardSurface,
  survivalCheck: mocks.survivalCheck,
}))

vi.mock('../skills/world', () => ({
  getPosition: mocks.getPosition,
}))

vi.mock('../skills/movement', () => ({
  moveAway: mocks.moveAway,
}))

vi.mock('../skills/actions/inventory', () => ({
  getItemCount: mocks.getItemCount,
}))

vi.mock('../skills/recovery', () => ({
  recordDeathPosition: mocks.recordDeathPosition,
  recoverAfterDeath: mocks.recoverAfterDeath,
}))

vi.mock('../utils/logger', () => ({
  useLogger: () => mocks.logger,
}))

describe('gameRunner.stepOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.determinePhase.mockReturnValue(GamePhase.EARLY_GAME)
    mocks.recoverTowardSurface.mockResolvedValue(false)
    mocks.executePhase.mockResolvedValue({
      success: true,
      message: 'phase complete',
      advance: true,
    })
  })

  afterEach(() => {
    const stateDir = join(tmpdir(), 'airi-minecraft-state')
    try {
      rmSync(stateDir, { recursive: true, force: true })
    }
    catch {
      // noop
    }
  })

  it('runs one deterministic phase step without start-loop chat noise', async () => {
    const chat = vi.fn()
    const bot = {
      username: `step-test-${Date.now()}`,
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
        chat,
        on: vi.fn(),
        off: vi.fn(),
      },
    } as any

    const runner = new GameRunner(bot)
    const result = await runner.stepOnce({ announceStart: false })

    expect(result.success).toBe(true)
    expect(result.advance).toBe(true)
    expect(result.phase).toBe(GamePhase.IRON_AGE)
    expect(chat).toHaveBeenCalledWith('[AI] Phase: EARLY_GAME')
    expect(chat).not.toHaveBeenCalledWith(expect.stringContaining('Starting autonomous play'))
  })

  it('surfaces runner external block state to stream callers', async () => {
    const bot = {
      username: `step-block-${Date.now()}`,
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
        chat: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      },
    } as any

    mocks.executePhase.mockResolvedValue({
      success: false,
      message: 'Bridge capability blocked craft sync: inventory recipe craft did not sync to bot state',
      advance: false,
    })

    const runner = new GameRunner(bot)
    const result = await runner.stepOnce({ announceStart: false })

    expect(result.success).toBe(false)
    expect(result.blockedReason).toContain('Bridge capability blocked craft sync')
  })

  it('treats transient Fabric disconnects as reconnect backoff instead of generic runner errors', async () => {
    const chat = vi.fn()
    const bot = {
      username: `step-disconnect-${Date.now()}`,
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
        chat,
        on: vi.fn(),
        off: vi.fn(),
      },
      getBridgeDebugState: vi.fn(() => ({ connected: false })),
    } as any

    mocks.executePhase.mockRejectedValue(new Error('Not connected to Fabric mod'))

    const runner = new GameRunner(bot)
    const result = await runner.stepOnce({ announceStart: false })

    expect(result.success).toBe(false)
    expect(result.blockedReason).toBe('Bridge connection temporarily unavailable: Not connected to Fabric mod')
    expect(chat).not.toHaveBeenCalledWith(expect.stringContaining('[AI] Error:'))
  })

  it('defers phase progress when death interrupts the active step', async () => {
    const chat = vi.fn()
    const listeners = new Map<string, Set<(...args: any[]) => void>>()
    const on = vi.fn((event: string, cb: (...args: any[]) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
    })
    const off = vi.fn((event: string, cb: (...args: any[]) => void) => {
      listeners.get(event)?.delete(cb)
    })
    const emit = (event: string, ...args: any[]) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args)
      }
    }
    const bot = {
      username: `step-death-${Date.now()}`,
      bot: {
        health: 20,
        game: {
          dimension: 'minecraft:overworld',
        },
        chat,
        on,
        off,
        pathfinder: {
          stop: vi.fn(),
        },
        clearControlStates: vi.fn(),
        pvp: {
          stop: vi.fn(),
        },
      },
    } as any

    mocks.executePhase.mockImplementation(async () => {
      bot.bot.health = 0
      emit('death')
      return {
        success: false,
        message: 'phase interrupted by death',
        advance: false,
      }
    })

    const runner = new GameRunner(bot)
    const result = await runner.stepOnce({ announceStart: false })

    expect(result.success).toBe(false)
    expect(result.message).toBe('Death interrupted current phase step.')
    expect(bot.bot.pathfinder.stop).toHaveBeenCalled()
    expect(bot.bot.clearControlStates).toHaveBeenCalled()
    expect(mocks.recoverAfterDeath).not.toHaveBeenCalled()
  })

  it('queues death recovery when the runner starts after a death event was missed', async () => {
    const chat = vi.fn()
    const bot = {
      username: `step-missed-death-${Date.now()}`,
      bot: {
        health: 0,
        game: {
          dimension: 'minecraft:overworld',
        },
        chat,
        on: vi.fn(),
        off: vi.fn(),
        pathfinder: {
          stop: vi.fn(),
        },
        clearControlStates: vi.fn(),
        pvp: {
          stop: vi.fn(),
        },
      },
    } as any

    const runner = new GameRunner(bot)
    const result = await runner.stepOnce({ announceStart: false })

    expect(result.success).toBe(true)
    expect(result.message).toBe('Recovered from death.')
    expect(mocks.recordDeathPosition).toHaveBeenCalledWith(bot)
    expect(mocks.recoverAfterDeath).toHaveBeenCalled()
    expect(mocks.executePhase).not.toHaveBeenCalled()
    expect(bot.bot.pathfinder.stop).toHaveBeenCalled()
    expect(bot.bot.clearControlStates).toHaveBeenCalled()
    expect(chat).toHaveBeenCalledWith('[AI] I died! (deaths: 1)')
    expect(chat).toHaveBeenCalledWith('[AI] Recovered after death and returned toward my last location.')
  })

  it('prefers surface recovery over moveAway when repeated underground steps make no progress', async () => {
    const bot = {
      username: `step-no-progress-${Date.now()}`,
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
        chat: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      },
    } as any

    mocks.executePhase.mockResolvedValue({
      success: true,
      message: 'waiting for bridge inventory sync',
      advance: false,
    })
    mocks.recoverTowardSurface.mockResolvedValue(true)

    const runner = new GameRunner(bot)
    await runner.stepOnce({ announceStart: false })
    ;(runner as any).noProgressStreak = 2
    await runner.stepOnce({ announceStart: false })

    expect(mocks.recoverTowardSurface).toHaveBeenCalledWith(bot, 'no-progress')
    expect(mocks.moveAway).not.toHaveBeenCalled()
  })
})
