// ============================================================
// Stability Metrics — centralized counters for Lv0–Lv2 mechanisms
// ============================================================

export interface StabilityMetrics {
  stallDetectedCount: number
  precondViolationCount: number
  goalBanAppliedCount: number
  decisionDiscardedVersionMismatchCount: number
  sameGoalRepeatSuppressedCount: number
  progressScore: number
  worldStateVersion: number
}

const metrics: StabilityMetrics = {
  stallDetectedCount: 0,
  precondViolationCount: 0,
  goalBanAppliedCount: 0,
  decisionDiscardedVersionMismatchCount: 0,
  sameGoalRepeatSuppressedCount: 0,
  progressScore: 0,
  worldStateVersion: 0,
}

export function incrementMetric(key: keyof StabilityMetrics): void {
  metrics[key]++
}

export function setMetric(key: keyof StabilityMetrics, value: number): void {
  metrics[key] = value
}

export function getStabilityMetrics(): StabilityMetrics {
  return { ...metrics }
}

export function resetStabilityMetrics(): void {
  metrics.stallDetectedCount = 0
  metrics.precondViolationCount = 0
  metrics.goalBanAppliedCount = 0
  metrics.decisionDiscardedVersionMismatchCount = 0
  metrics.sameGoalRepeatSuppressedCount = 0
  metrics.progressScore = 0
  metrics.worldStateVersion = 0
}
