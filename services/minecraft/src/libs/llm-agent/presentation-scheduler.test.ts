import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetPresentationSchedulerForTests, getPresentationScheduler, PresentationScheduler } from './presentation-scheduler'

describe('presentationScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetPresentationSchedulerForTests()
  })

  it('runs immediately when no video delay is configured', () => {
    const scheduler = new PresentationScheduler(0)
    const task = vi.fn()

    expect(scheduler.schedule(Date.now(), task)).toBe(true)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('waits until the event appears on the delayed video', () => {
    const scheduler = new PresentationScheduler(5_000)
    const task = vi.fn()

    scheduler.schedule(Date.now(), task)
    expect(task).not.toHaveBeenCalled()

    vi.advanceTimersByTime(4_999)
    expect(task).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('plays late speech immediately instead of waiting', () => {
    const scheduler = new PresentationScheduler(5_000)
    const task = vi.fn()

    // Generation took 8s for a 5s delay: release right away.
    scheduler.schedule(Date.now() - 8_000, task, { maxLatenessMs: 10_000 })
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('drops hopelessly stale low-priority speech', () => {
    const scheduler = new PresentationScheduler(5_000)
    const task = vi.fn()

    const accepted = scheduler.schedule(Date.now() - 30_000, task, { maxLatenessMs: 10_000 })
    expect(accepted).toBe(false)
    expect(task).not.toHaveBeenCalled()
  })

  it('never drops tasks without a lateness bound', () => {
    const scheduler = new PresentationScheduler(5_000)
    const task = vi.fn()

    expect(scheduler.schedule(Date.now() - 60_000, task)).toBe(true)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('clear cancels pending releases', () => {
    const scheduler = new PresentationScheduler(5_000)
    const task = vi.fn()

    scheduler.schedule(Date.now(), task)
    scheduler.clear()
    vi.advanceTimersByTime(10_000)
    expect(task).not.toHaveBeenCalled()
  })

  it('shared scheduler defaults to zero delay when env is unset', () => {
    const scheduler = getPresentationScheduler()
    expect(scheduler.videoDelayMs).toBe(0)
  })
})
