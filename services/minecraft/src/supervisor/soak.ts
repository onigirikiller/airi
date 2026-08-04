export interface Position {
  x: number
  y: number
  z: number
}

export interface BotState {
  health?: number
  food?: number
  position?: Position | null
  dimension?: string
}

export interface MonitorEvent {
  type?: string
  timestamp?: number | string
}

export interface MonitorState {
  eventHistory?: MonitorEvent[]
  botState?: BotState
  runnerState?: {
    phase?: string
    phaseStep?: number
    attempts?: number
    noProgressStreak?: number
    blockedReason?: string | null
    blockedMsRemaining?: number
  } | null
  bridgeState?: {
    connected?: boolean | null
    ready?: boolean | null
    bridgeVersion?: string | null
    bridgeBuildTimestamp?: string | null
    staleInstalledBridgeBuild?: boolean | null
  } | null
  worldState?: {
    biome?: string
    terrainContext?: string
    skyAccess?: string
    woodAccess?: string
    surfaceEscapeNeeded?: boolean
    pickaxeAccess?: string
  } | null
}

export interface SupervisorEvent {
  at: string
  type: string
  details: Record<string, unknown>
}

export interface SupervisorSummary {
  eventTypeCounts: Record<string, number>
  firstEventAt: string | null
  lastEventAt: string | null
  lastRestartAt: string | null
  lastRestartReason: string | null
  restartReasonCounts: Record<string, number>
  totalRestarts: number
}

export interface SupervisorHealthSnapshot {
  childStartAt: number
  lastMonitorSuccessAt: number
  lastStateChangeAt: number
  lastStdoutAt: number
  monitorFailureTimeoutMs: number
  monitorFetchFailed: boolean
  now: number
  startupGraceMs: number
  stateStallTimeoutMs: number
  stdoutIdleTimeoutMs: number
}

export interface RunLogFile {
  modifiedAtMs: number
  name: string
  path: string
  size: number
}

export interface RunLogRetentionPolicy {
  maxLogAgeMs: number
  maxLogFiles: number
  maxTotalBytes: number
  now: number
}

/**
 * Build a stable state fingerprint so the supervisor can detect whether the bot
 * is still progressing even when stdout is quiet.
 */
export function buildStateFingerprint(state: MonitorState): string {
  const latestEvent = Array.isArray(state.eventHistory) && state.eventHistory.length > 0
    ? state.eventHistory.at(-1) ?? null
    : null
  const position = normalizePosition(state.botState?.position ?? null)

  return JSON.stringify({
    position,
    dimension: state.botState?.dimension ?? 'unknown',
    health: state.botState?.health ?? null,
    food: state.botState?.food ?? null,
    phase: state.runnerState?.phase ?? null,
    phaseStep: state.runnerState?.phaseStep ?? null,
    attempts: state.runnerState?.attempts ?? null,
    noProgressStreak: state.runnerState?.noProgressStreak ?? null,
    blockedReason: state.runnerState?.blockedReason ?? null,
    blockedMsRemaining: state.runnerState?.blockedMsRemaining ?? null,
    bridgeVersion: state.bridgeState?.bridgeVersion ?? null,
    bridgeBuildTimestamp: state.bridgeState?.bridgeBuildTimestamp ?? null,
    biome: state.worldState?.biome ?? null,
    terrainContext: state.worldState?.terrainContext ?? null,
    skyAccess: state.worldState?.skyAccess ?? null,
    woodAccess: state.worldState?.woodAccess ?? null,
    surfaceEscapeNeeded: state.worldState?.surfaceEscapeNeeded ?? null,
    pickaxeAccess: state.worldState?.pickaxeAccess ?? null,
    latestEventType: latestEvent?.type ?? null,
    latestEventTimestamp: latestEvent?.timestamp ?? null,
  })
}

export function calculateRestartDelay(
  consecutiveRestarts: number,
  restartBaseDelayMs: number,
  restartMaxDelayMs: number,
): number {
  return Math.min(
    restartBaseDelayMs * (2 ** consecutiveRestarts),
    restartMaxDelayMs,
  )
}

export function isRestartRequiredBlockedReason(blockedReason: string | null | undefined): boolean {
  if (blockedReason == null) {
    return false
  }

  const normalized = blockedReason.toLowerCase()
  return normalized.includes('restart required')
    || normalized.includes('minecraft restart required')
}

export function isBridgeBuildRestartRequired(state: MonitorState | null | undefined): boolean {
  return state?.bridgeState?.staleInstalledBridgeBuild === true
}

export function isAwaitingWorldReady(state: MonitorState | null | undefined): boolean {
  return state?.bridgeState?.connected === true
    && state?.bridgeState?.ready === false
    && state?.worldState?.terrainContext === 'awaiting_world'
}

export function createEmptySupervisorSummary(): SupervisorSummary {
  return {
    eventTypeCounts: {},
    firstEventAt: null,
    lastEventAt: null,
    lastRestartAt: null,
    lastRestartReason: null,
    restartReasonCounts: {},
    totalRestarts: 0,
  }
}

/**
 * Reduce the current supervisor signal set into a restart reason when the child
 * has stopped making useful progress.
 */
export function getHealthRestartReason(snapshot: SupervisorHealthSnapshot): string | null {
  const withinStartupGrace = snapshot.now - snapshot.childStartAt < snapshot.startupGraceMs
  if (withinStartupGrace) {
    return null
  }

  const stdoutIdleForTooLong = snapshot.now - snapshot.lastStdoutAt > snapshot.stdoutIdleTimeoutMs
  const stateAlsoIdleForTooLong = snapshot.now - snapshot.lastStateChangeAt > snapshot.stdoutIdleTimeoutMs
  if (stdoutIdleForTooLong && stateAlsoIdleForTooLong) {
    return 'stdout_idle_timeout'
  }

  if (snapshot.monitorFetchFailed) {
    if (snapshot.now - snapshot.lastMonitorSuccessAt > snapshot.monitorFailureTimeoutMs) {
      return 'monitor_unavailable_timeout'
    }
    return null
  }

  if (snapshot.now - snapshot.lastStateChangeAt > snapshot.stateStallTimeoutMs) {
    return 'state_stall_timeout'
  }

  return null
}

export function normalizePosition(position: Position | null): string | null {
  if (position == null) {
    return null
  }

  return [
    Math.floor(position.x),
    Math.floor(position.y),
    Math.floor(position.z),
  ].join(',')
}

export function pruneRestartHistory(
  restartHistory: number[],
  now: number,
  restartWindowMs: number,
): number[] {
  const cutoff = now - restartWindowMs
  return restartHistory.filter(timestamp => timestamp >= cutoff)
}

export function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

export function readNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }

  return parsed
}

/**
 * Apply one supervisor event to the persisted summary so long soak runs can be
 * inspected without replaying the full NDJSON history each time.
 */
export function summarizeSupervisorEvent(
  currentSummary: SupervisorSummary,
  event: SupervisorEvent,
): SupervisorSummary {
  const nextSummary: SupervisorSummary = {
    ...currentSummary,
    eventTypeCounts: {
      ...currentSummary.eventTypeCounts,
      [event.type]: (currentSummary.eventTypeCounts[event.type] ?? 0) + 1,
    },
    firstEventAt: currentSummary.firstEventAt ?? event.at,
    lastEventAt: event.at,
    restartReasonCounts: { ...currentSummary.restartReasonCounts },
  }

  if (event.type === 'restart_started') {
    const reason = typeof event.details.reason === 'string'
      ? event.details.reason
      : 'unknown'
    nextSummary.totalRestarts += 1
    nextSummary.lastRestartAt = event.at
    nextSummary.lastRestartReason = reason
    nextSummary.restartReasonCounts[reason] = (nextSummary.restartReasonCounts[reason] ?? 0) + 1
  }

  return nextSummary
}

/**
 * Select old run logs that should be removed to keep long unattended soak runs
 * bounded in disk usage.
 */
export function selectRunLogsToDelete(
  runLogs: RunLogFile[],
  retentionPolicy: RunLogRetentionPolicy,
): RunLogFile[] {
  const orderedLogs = [...runLogs].sort((left, right) => left.modifiedAtMs - right.modifiedAtMs)
  const deletions = new Set<string>()

  for (const runLog of orderedLogs) {
    if (retentionPolicy.now - runLog.modifiedAtMs > retentionPolicy.maxLogAgeMs) {
      deletions.add(runLog.path)
    }
  }

  const remainingLogs = orderedLogs.filter(runLog => !deletions.has(runLog.path))
  while (remainingLogs.length > retentionPolicy.maxLogFiles) {
    const oldestLog = remainingLogs.shift()
    if (oldestLog == null) {
      break
    }
    deletions.add(oldestLog.path)
  }

  let totalBytes = remainingLogs.reduce((sum, runLog) => sum + runLog.size, 0)
  while (totalBytes > retentionPolicy.maxTotalBytes && remainingLogs.length > 0) {
    const oldestLog = remainingLogs.shift()
    if (oldestLog == null) {
      break
    }
    deletions.add(oldestLog.path)
    totalBytes -= oldestLog.size
  }

  return orderedLogs.filter(runLog => deletions.has(runLog.path))
}
