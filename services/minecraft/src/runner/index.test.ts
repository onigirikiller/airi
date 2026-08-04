import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Vec3 } from 'vec3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildRunnerProgressFingerprint, GameRunner, getActiveGameRunner, isBridgeCapabilityBlockedFailure, shouldAdvanceOnAttemptLimit } from './index'
import { GamePhase, GameStateManager } from './state'

const mocks = vi.hoisted(() => ({
  getItemCount: vi.fn(() => 0),
  getPosition: vi.fn(() => new Vec3(0, 64, 0)),
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

vi.mock('../skills/actions/inventory', () => ({
  getItemCount: mocks.getItemCount,
}))

vi.mock('../skills/world', () => ({
  getPosition: mocks.getPosition,
}))

vi.mock('../utils/logger', () => ({
  useLogger: () => mocks.logger,
}))

describe('buildRunnerProgressFingerprint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getItemCount.mockReturnValue(0)
    mocks.getPosition.mockReturnValue(new Vec3(0, 64, 0))
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

  it('changes when relevant inventory changes even if the phase message would be the same', () => {
    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
      },
    } as any

    mocks.getItemCount.mockImplementation((...args: unknown[]) => {
      const itemName = String(args[1] ?? '')
      return itemName === 'crafting_table' ? 0 : 0
    })
    const before = buildRunnerProgressFingerprint(bot, state)

    mocks.getItemCount.mockImplementation((...args: unknown[]) => {
      const itemName = String(args[1] ?? '')
      return itemName === 'crafting_table' ? 1 : 0
    })
    const after = buildRunnerProgressFingerprint(bot, state)

    expect(after).not.toBe(before)
  })

  it('changes when the bot has materially relocated', () => {
    const state = new GameStateManager(`test-${Date.now()}`)
    const bot = {
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
      },
    } as any

    mocks.getPosition.mockReturnValue(new Vec3(0, 64, 0))
    const before = buildRunnerProgressFingerprint(bot, state)

    mocks.getPosition.mockReturnValue(new Vec3(24, 64, 0))
    const after = buildRunnerProgressFingerprint(bot, state)

    expect(after).not.toBe(before)
  })

  it('only allows attempt-limit advancement when the detected phase is actually ahead', () => {
    expect(shouldAdvanceOnAttemptLimit(GamePhase.EARLY_GAME, GamePhase.IRON_AGE)).toBe(true)
    expect(shouldAdvanceOnAttemptLimit(GamePhase.EARLY_GAME, GamePhase.EARLY_GAME)).toBe(false)
    expect(shouldAdvanceOnAttemptLimit(GamePhase.IRON_AGE, GamePhase.EARLY_GAME)).toBe(false)
  })

  it('can reset per-phase attempts without changing the current phase', () => {
    const state = new GameStateManager(`test-${Date.now()}`)
    state.incrementAttempts()
    state.incrementAttempts()

    expect(state.getAttempts()).toBe(2)

    state.resetAttempts()

    expect(state.getAttempts()).toBe(0)
    expect(state.phase).toBe(GamePhase.EARLY_GAME)
  })

  it('can prime the saved position baseline without triggering stuck detection', () => {
    const state = new GameStateManager(`test-${Date.now()}`)

    state.primePosition(10, 64, 10)

    expect(state.updatePosition(10, 64, 10)).toBe(false)
  })

  it('returns null for usernames without an active runner handle', () => {
    expect(getActiveGameRunner('missing-user')).toBeNull()
  })

  it('classifies submerged bridge capability failures for runner backoff', () => {
    expect(isBridgeCapabilityBlockedFailure('Bridge capability blocked submerged escape: moveToward unsupported and baritone unavailable')).toBe(true)
    expect(isBridgeCapabilityBlockedFailure('Bridge capability blocked craft sync: inventory recipe craft did not sync to bot state')).toBe(true)
    expect(isBridgeCapabilityBlockedFailure('Could not mine cobblestone')).toBe(false)
  })

  it('surfaces external block state in runner debug output', () => {
    const bot = {
      username: 'debug-runner',
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
        chat: vi.fn(),
        on: vi.fn(),
      },
    } as any

    const runner = new GameRunner(bot)
    ;(runner as any).externalBlockReason = 'Bridge capability blocked submerged escape: moveToward unsupported and baritone unavailable'
    ;(runner as any).externalBlockUntil = Date.now() + 25_000

    const debugState = runner.getDebugState()

    expect(debugState.blockedReason).toContain('Bridge capability blocked submerged escape')
    expect(debugState.blockedMsRemaining).toBeGreaterThan(0)
  })

  it('keeps long restart-required block windows visible in debug output', () => {
    const bot = {
      username: 'debug-runner',
      bot: {
        game: {
          dimension: 'minecraft:overworld',
        },
        chat: vi.fn(),
        on: vi.fn(),
      },
    } as any

    const runner = new GameRunner(bot)
    ;(runner as any).externalBlockReason = 'Bridge capability blocked submerged escape: bridge underwater relocation support unavailable'
    ;(runner as any).externalBlockUntil = Date.now() + (4 * 60_000)

    expect(runner.getDebugState().blockedMsRemaining).toBeGreaterThan(200_000)
  })
})
