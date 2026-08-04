import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./plan-lock', () => ({
  withSharedPlanLock: vi.fn(async (_username: string, _source: string, _logger: any, run: () => Promise<void>) => {
    await run()
  }),
}))

const {
  __resetInteractivePlanStateForTests,
  requestInteractivePlanFromText,
} = await import('./interactive-plan')

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve())
}

describe('interactive plan starvation safeguards', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetInteractivePlanStateForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetInteractivePlanStateForTests()
  })

  it('defers queued goals after a small batch to avoid starving autonomy', async () => {
    const executeResolvers: Array<() => void> = []
    const bot = {
      username: 'AIra',
      planning: {
        createPlan: vi.fn(async (goal: string) => ({ goal })),
        executePlan: vi.fn(() => new Promise<void>(resolve => executeResolvers.push(resolve))),
      },
    } as any
    const logger = {
      log: vi.fn(),
      withField: vi.fn(() => ({ log: vi.fn() })),
      withFields: vi.fn(() => ({ log: vi.fn() })),
      withError: vi.fn(() => ({ warn: vi.fn() })),
    } as any

    requestInteractivePlanFromText('collect wood', bot, logger)
    await flushMicrotasks()
    requestInteractivePlanFromText('build shelter', bot, logger)
    executeResolvers.shift()?.()
    await flushMicrotasks()
    requestInteractivePlanFromText('mine stone', bot, logger)
    executeResolvers.shift()?.()
    await flushMicrotasks()

    expect(bot.planning.createPlan).toHaveBeenCalledTimes(2)
    expect(bot.planning.createPlan).toHaveBeenNthCalledWith(1, 'collect wood')
    expect(bot.planning.createPlan).toHaveBeenNthCalledWith(2, 'build shelter')

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(bot.planning.createPlan).toHaveBeenCalledTimes(3)
    expect(bot.planning.createPlan).toHaveBeenNthCalledWith(3, 'mine stone')
  })
})
