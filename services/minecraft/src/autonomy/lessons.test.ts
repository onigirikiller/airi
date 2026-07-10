import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { describeDeathLesson, LessonStore } from './lessons'

describe('lessonStore', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airi-lessons-test-'))
    path = join(dir, 'lessons.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('deduplicates numerically-similar facts and counts occurrences', () => {
    const store = new LessonStore('AIra', path)
    store.record({ trigger: 'death', fact: 'Died near zombie at (10, 12, -4) in overworld at night', milestone: 'iron-acquisition', dimension: 'overworld' })
    store.record({ trigger: 'death', fact: 'Died near zombie at (44, 13, -9) in overworld at night', milestone: 'iron-acquisition', dimension: 'overworld' })

    expect(store.size).toBe(1)
    const [lesson] = store.getRelevant({ dimension: 'overworld', milestone: 'iron-acquisition' }, 1)
    expect(lesson.occurrences).toBe(2)
  })

  it('persists lessons across instances', () => {
    const store = new LessonStore('AIra', path)
    store.record({ trigger: 'goal-failure', fact: 'Goal "Mine iron ore" keeps failing: pathfinding timed out', milestone: 'iron-acquisition', dimension: 'overworld' })
    store.flush()

    const reloaded = new LessonStore('AIra', path)
    expect(reloaded.size).toBe(1)
    expect(reloaded.getRelevant({ dimension: 'overworld' }, 1)[0].fact).toContain('Mine iron ore')
  })

  it('ranks lessons matching the current milestone and dimension first', () => {
    const store = new LessonStore('AIra', path)
    store.record({ trigger: 'death', fact: 'Died near blaze in nether fortress', milestone: 'blaze-rods', dimension: 'the_nether' })
    store.record({ trigger: 'death', fact: 'Died near creeper while chopping wood', milestone: 'wood', dimension: 'overworld' })

    const relevant = store.getRelevant({ dimension: 'the_nether', milestone: 'blaze-rods' }, 2)
    expect(relevant[0].fact).toContain('blaze')
  })

  it('formats prompt lines with repetition counts', () => {
    const store = new LessonStore('AIra', path)
    store.record({ trigger: 'stall', fact: 'Progress stalled: repeating "mine iron"', milestone: 'iron-acquisition', dimension: 'overworld' })
    store.record({ trigger: 'stall', fact: 'Progress stalled: repeating "mine iron"', milestone: 'iron-acquisition', dimension: 'overworld' })

    const lines = store.formatForPrompt({ dimension: 'overworld', milestone: 'iron-acquisition' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[stall]')
    expect(lines[0]).toContain('(x2)')
  })
})

describe('describeDeathLesson', () => {
  it('includes cause, position, and conditions', () => {
    const fact = describeDeathLesson({
      position: { x: 10.6, y: 11.2, z: -3.9 },
      dimension: 'overworld',
      timeOfDay: 'night',
      food: 4,
      runnerPhase: 'IRON_AGE',
    } as any, 'zombie')

    expect(fact).toContain('zombie')
    expect(fact).toContain('(11, 11, -4)')
    expect(fact).toContain('at night')
    expect(fact).toContain('underground')
    expect(fact).toContain('while starving')
  })
})
