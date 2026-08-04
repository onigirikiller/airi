import { afterEach, describe, expect, it, vi } from 'vitest'

import { __resetPlanLocksForTests, forceReleaseSharedPlanLock, withSharedPlanLock } from './plan-lock'

function createTestLogger() {
  const logger = {
    withFields: vi.fn(() => logger),
    withField: vi.fn(() => logger),
    log: vi.fn(),
    warn: vi.fn(),
  }
  return logger
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('withSharedPlanLock', () => {
  afterEach(() => {
    vi.useRealTimers()
    __resetPlanLocksForTests()
  })

  it('does not force-release a long-running task before five minutes', async () => {
    vi.useFakeTimers()
    const logger = createTestLogger()
    const firstTask = createDeferred<void>()

    const first = withSharedPlanLock('bot-a', 'autonomy', logger as any, async () => {
      await firstTask.promise
    })
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(240_000)

    expect(logger.warn).not.toHaveBeenCalledWith('Plan lock hold timeout exceeded; force-releasing')

    firstTask.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await first
  })

  it('still force-releases a wedged task after five minutes', async () => {
    vi.useFakeTimers()
    const logger = createTestLogger()

    void withSharedPlanLock('bot-b', 'autonomy', logger as any, async () => {
      await new Promise<void>(() => {})
    })
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(300_000)

    expect(logger.warn).toHaveBeenCalledWith('Plan lock hold timeout exceeded; force-releasing')

    let secondRan = false
    const second = await withSharedPlanLock('bot-b', 'interactive', logger as any, async () => {
      secondRan = true
    })

    expect(secondRan).toBe(true)
    expect(second).toBeUndefined()
  })

  it('lets deterministic recovery take over after a forced release without a stale releaser dropping the new lock', async () => {
    const logger = createTestLogger()
    const firstTask = createDeferred<void>()
    const recoveryTask = createDeferred<void>()
    let recoveryRan = false

    const first = withSharedPlanLock('bot-c', 'autonomy', logger as any, async () => {
      await firstTask.promise
    })

    await Promise.resolve()
    forceReleaseSharedPlanLock('bot-c', logger as any)

    const recovery = withSharedPlanLock('bot-c', 'autonomy-recovery', logger as any, async () => {
      recoveryRan = true
      await recoveryTask.promise
    })

    await Promise.resolve()
    expect(recoveryRan).toBe(true)

    firstTask.resolve()
    await first

    let interactiveRan = false
    const interactive = withSharedPlanLock('bot-c', 'interactive', logger as any, async () => {
      interactiveRan = true
    })

    await Promise.resolve()
    expect(interactiveRan).toBe(false)

    recoveryTask.resolve()
    await recovery
    await interactive
    expect(interactiveRan).toBe(true)
  })
})
