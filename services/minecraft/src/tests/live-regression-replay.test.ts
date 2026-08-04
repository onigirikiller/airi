import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { normalizeIntentGoalText } from '../autonomy/decision-provider'

const replayFixturePath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/live-regression-20260410.log')

describe('live replay regression fixture', () => {
  it('captures the exact April 10 early-survival failure signatures', () => {
    const replayLog = readFileSync(replayFixturePath, 'utf8')

    expect(replayLog).toContain('Coordinate stall detected; signaling the LLM instead of forcing a recovery goal switch')
    expect(replayLog).toContain('searchForEntity(cow) failed')
    expect(replayLog).toContain('searchForEntity(animal) failed')
    expect(replayLog).toContain('Autonomy blocked goal without mechanical replacement')
    expect(replayLog).toContain('Autonomy decision goal was discarded during normalization')
  })

  it('documents the shorthand surface-recovery goal that now has a production mapping', () => {
    const replayLog = readFileSync(replayFixturePath, 'utf8')

    expect(replayLog).toContain('originalGoal=surface_escape')
    expect(normalizeIntentGoalText('surface_escape')).toBe('Escape to the surface to gather wood')
  })
})
