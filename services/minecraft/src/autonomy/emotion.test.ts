import { afterEach, describe, expect, it } from 'vitest'

import { EmotionEngine, getActiveTtsStyleHint, setActiveEmotionEngine } from './emotion'

function createClock(start = 0) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('emotionEngine', () => {
  afterEach(() => {
    setActiveEmotionEngine(undefined)
  })

  it('spikes fear on danger and decays back toward calm', () => {
    const clock = createClock()
    const engine = new EmotionEngine({ now: clock.now })

    engine.impulse('danger')
    expect(engine.getState().fear).toBeGreaterThan(0.6)
    expect(engine.dominant().emotion).toBe('fear')

    clock.advance(120_000)
    expect(engine.getState().fear).toBeLessThan(0.1)
  })

  it('produces a faster surprised voice style under fear', () => {
    const clock = createClock()
    const engine = new EmotionEngine({ now: clock.now })

    expect(engine.currentTtsStyle()).toBeNull()

    engine.impulse('danger')
    const hint = engine.currentTtsStyle()
    expect(hint).not.toBeNull()
    expect(hint!.style).toBe('Surprised')
    expect(hint!.lengthScale).toBeLessThan(1)
    expect(hint!.styleWeight).toBeGreaterThan(1)
  })

  it('milestones raise pride which outlasts short-lived fear', () => {
    const clock = createClock()
    const engine = new EmotionEngine({ now: clock.now })

    engine.impulse('milestone')
    engine.impulse('danger', 0.5)
    clock.advance(60_000)
    expect(engine.dominant().emotion).toBe('pride')
  })

  it('grows bored over idle time', () => {
    const clock = createClock()
    const engine = new EmotionEngine({ now: clock.now })

    engine.impulse('goal-success')
    clock.advance(10 * 60_000)
    expect(engine.dominant().emotion).toBe('boredom')
  })

  it('summarizes the mood for prompt conditioning in Japanese', () => {
    const clock = createClock()
    const engine = new EmotionEngine({ now: clock.now })

    engine.impulse('death')
    expect(engine.describeForPrompt()).toContain('悔しさ')
  })

  it('exposes the active engine to the TTS layer via the shared provider', () => {
    const clock = createClock()
    const engine = new EmotionEngine({ now: clock.now })
    setActiveEmotionEngine(engine)

    engine.impulse('danger')
    expect(getActiveTtsStyleHint()?.style).toBe('Surprised')

    setActiveEmotionEngine(undefined)
    expect(getActiveTtsStyleHint()).toBeNull()
  })
})
