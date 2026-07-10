import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ActionAgentImpl } from '../../agents/action'
import { abortableSleep, ActionAbortedError, raceWithAbort } from './action-abort'
import { Mineflayer } from './core'

function createMineflayerWithFakeBot(): Mineflayer {
  const mineflayer = Object.create(Mineflayer.prototype) as Mineflayer
  ;(mineflayer as any).logger = {
    withFields: vi.fn(() => ({ log: vi.fn() })),
  }
  mineflayer.bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {},
    inventory: { selectedSlot: 0, slots: [] },
    pathfinder: {
      setGoal: vi.fn(),
      stop: vi.fn(),
    },
    stopDigging: vi.fn(),
    clearControlStates: vi.fn(),
    collectBlock: {
      cancelTask: vi.fn(async () => {}),
    },
  } as any
  return mineflayer
}

describe('action abort context', () => {
  it('aborts the older signal before beginning a second action', () => {
    const mineflayer = createMineflayerWithFakeBot()
    const firstSignal = mineflayer.beginAction('first')
    const secondSignal = mineflayer.beginAction('second')

    expect(firstSignal.aborted).toBe(true)
    expect(firstSignal.reason).toBeInstanceOf(ActionAbortedError)
    expect((firstSignal.reason as ActionAbortedError).reason).toBe('Superseded by action: second')
    expect(secondSignal.aborted).toBe(false)
    expect(mineflayer.currentActionSignal).toBe(secondSignal)
    expect((mineflayer.bot as any).pathfinder.setGoal).toHaveBeenCalledWith(null)
    expect((mineflayer.bot as any).pathfinder.stop).toHaveBeenCalledOnce()
  })

  it('releases abortableSleep immediately and clears its timer', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const sleepPromise = abortableSleep(60_000, controller.signal)

      controller.abort(new ActionAbortedError('wake now'))

      await expect(sleepPromise).rejects.toMatchObject({
        name: 'ActionAbortedError',
        reason: 'wake now',
      })
      expect(vi.getTimerCount()).toBe(0)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('races a pending operation against abort', async () => {
    const controller = new AbortController()
    const operation = new Promise<string>(() => {})
    const result = raceWithAbort(operation, controller.signal)

    controller.abort(new ActionAbortedError('interrupted'))

    await expect(result).rejects.toMatchObject({
      name: 'ActionAbortedError',
      reason: 'interrupted',
    })
  })

  it('aborts a timed-out skill loop so it cannot continue as a zombie', async () => {
    vi.useFakeTimers()
    try {
      const mineflayer = createMineflayerWithFakeBot()
      const agent = new ActionAgentImpl({
        id: 'abort-integration-test',
        type: 'action',
        bot: mineflayer,
      }) as any
      let iterations = 0
      let loopExited = false

      agent.initialized = true
      agent.actions = new Map([['fakeLoop', {
        name: 'fakeLoop',
        description: '',
        schema: z.object({}),
        perform: () => async () => {
          try {
            while (true) {
              await abortableSleep(1_000, mineflayer.currentActionSignal)
              iterations++
            }
          }
          finally {
            loopExited = true
          }
        },
      }]])

      const resultPromise = agent.performAction({
        tool: 'fakeLoop',
        description: 'run fake loop',
        params: {},
      }).catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(90_000)
      const result = await resultPromise
      const iterationsAtAbort = iterations

      expect(result).toBeInstanceOf(ActionAbortedError)
      expect(result).toMatchObject({ reason: 'Action "fakeLoop" timed out after 90s' })
      expect(loopExited).toBe(true)
      expect(mineflayer.currentActionSignal).toBeUndefined()

      await vi.advanceTimersByTimeAsync(30_000)
      expect(iterations).toBe(iterationsAtAbort)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
