import { beforeEach, describe, expect, it } from 'vitest'

import { getStabilityMetrics, incrementMetric, resetStabilityMetrics, setMetric } from './metrics'

describe('metrics', () => {
  beforeEach(() => {
    resetStabilityMetrics()
  })

  it('incrementMetric increases the counter', () => {
    expect(getStabilityMetrics().stallDetectedCount).toBe(0)
    incrementMetric('stallDetectedCount')
    incrementMetric('stallDetectedCount')
    expect(getStabilityMetrics().stallDetectedCount).toBe(2)
  })

  it('setMetric sets an exact value', () => {
    setMetric('progressScore', 42.5)
    expect(getStabilityMetrics().progressScore).toBe(42.5)
  })

  it('getStabilityMetrics returns all fields', () => {
    const metrics = getStabilityMetrics()
    expect(metrics).toHaveProperty('stallDetectedCount')
    expect(metrics).toHaveProperty('precondViolationCount')
    expect(metrics).toHaveProperty('goalBanAppliedCount')
    expect(metrics).toHaveProperty('decisionDiscardedVersionMismatchCount')
    expect(metrics).toHaveProperty('sameGoalRepeatSuppressedCount')
    expect(metrics).toHaveProperty('progressScore')
    expect(metrics).toHaveProperty('worldStateVersion')
  })

  it('resetStabilityMetrics resets all counters to zero', () => {
    incrementMetric('stallDetectedCount')
    incrementMetric('precondViolationCount')
    setMetric('progressScore', 100)

    resetStabilityMetrics()

    const metrics = getStabilityMetrics()
    expect(metrics.stallDetectedCount).toBe(0)
    expect(metrics.precondViolationCount).toBe(0)
    expect(metrics.progressScore).toBe(0)
  })

  it('returns a copy, not a reference', () => {
    const metrics1 = getStabilityMetrics()
    incrementMetric('stallDetectedCount')
    const metrics2 = getStabilityMetrics()
    expect(metrics1.stallDetectedCount).toBe(0)
    expect(metrics2.stallDetectedCount).toBe(1)
  })
})
