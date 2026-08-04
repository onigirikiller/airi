import { describe, expect, it } from 'vitest'

import {
  buildStateFingerprint,
  createEmptySupervisorSummary,
  getHealthRestartReason,
  isAwaitingWorldReady,
  isBridgeBuildRestartRequired,
  isRestartRequiredBlockedReason,
  readNonNegativeInt,
  readPositiveInt,
  selectRunLogsToDelete,
  summarizeSupervisorEvent,
} from './soak'

describe('soak supervisor helpers', () => {
  it('builds a stable fingerprint from bot state and latest event', () => {
    const fingerprint = buildStateFingerprint({
      botState: {
        dimension: 'minecraft:overworld',
        food: 18,
        health: 20,
        position: { x: 10.9, y: 64.2, z: -4.1 },
      },
      eventHistory: [
        { timestamp: '2026-03-01T12:00:00.000Z', type: 'action:started' },
      ],
      runnerState: {
        phase: 'EARLY_GAME',
        phaseStep: 0,
        attempts: 1,
        noProgressStreak: 0,
        blockedReason: 'Bridge capability blocked submerged escape: bridge underwater relocation support unavailable',
        blockedMsRemaining: 30000,
      },
      bridgeState: {
        bridgeVersion: null,
        bridgeBuildTimestamp: null,
      },
      worldState: {
        biome: 'ocean',
        terrainContext: 'underground_cave',
        skyAccess: 'enclosed',
        woodAccess: 'poor',
        surfaceEscapeNeeded: true,
        pickaxeAccess: 'missing',
      },
    })

    expect(fingerprint).toContain('"position":"10,64,-5"')
    expect(fingerprint).toContain('"latestEventType":"action:started"')
    expect(fingerprint).toContain('"phase":"EARLY_GAME"')
    expect(fingerprint).toContain('"terrainContext":"underground_cave"')
    expect(fingerprint).toContain('"blockedReason":"Bridge capability blocked submerged escape: bridge underwater relocation support unavailable"')
  })

  it('detects stdout idle, monitor failure, and state stall restart reasons', () => {
    const base = {
      childStartAt: 0,
      lastMonitorSuccessAt: 90_000,
      lastStateChangeAt: 90_000,
      lastStdoutAt: 90_000,
      now: 300_000,
      startupGraceMs: 60_000,
      stateStallTimeoutMs: 120_000,
      stdoutIdleTimeoutMs: 100_000,
    }

    expect(getHealthRestartReason({
      ...base,
      monitorFailureTimeoutMs: 60_000,
      monitorFetchFailed: false,
    })).toBe('stdout_idle_timeout')

    expect(getHealthRestartReason({
      ...base,
      lastStateChangeAt: 250_000,
      monitorFailureTimeoutMs: 60_000,
      monitorFetchFailed: false,
    })).toBe(null)

    expect(getHealthRestartReason({
      ...base,
      lastStdoutAt: 250_000,
      monitorFailureTimeoutMs: 60_000,
      monitorFetchFailed: true,
    })).toBe('monitor_unavailable_timeout')

    expect(getHealthRestartReason({
      ...base,
      lastStdoutAt: 250_000,
      lastMonitorSuccessAt: 250_000,
      monitorFailureTimeoutMs: 60_000,
      monitorFetchFailed: false,
    })).toBe('state_stall_timeout')
  })

  it('aggregates restart reasons into a compact summary', () => {
    let summary = createEmptySupervisorSummary()

    summary = summarizeSupervisorEvent(summary, {
      at: '2026-03-01T12:00:00.000Z',
      details: {},
      type: 'supervisor_started',
    })
    summary = summarizeSupervisorEvent(summary, {
      at: '2026-03-01T12:05:00.000Z',
      details: { reason: 'stdout_idle_timeout' },
      type: 'restart_started',
    })
    summary = summarizeSupervisorEvent(summary, {
      at: '2026-03-01T12:10:00.000Z',
      details: { reason: 'stdout_idle_timeout' },
      type: 'restart_started',
    })

    expect(summary.totalRestarts).toBe(2)
    expect(summary.restartReasonCounts.stdout_idle_timeout).toBe(2)
    expect(summary.eventTypeCounts.restart_started).toBe(2)
    expect(summary.firstEventAt).toBe('2026-03-01T12:00:00.000Z')
    expect(summary.lastRestartReason).toBe('stdout_idle_timeout')
  })

  it('selects old logs for deletion by age, count, and total bytes', () => {
    const deletions = selectRunLogsToDelete([
      { modifiedAtMs: 1_000, name: 'run-1.log', path: '/tmp/run-1.log', size: 100 },
      { modifiedAtMs: 2_000, name: 'run-2.log', path: '/tmp/run-2.log', size: 150 },
      { modifiedAtMs: 3_000, name: 'run-3.log', path: '/tmp/run-3.log', size: 200 },
      { modifiedAtMs: 4_000, name: 'run-4.log', path: '/tmp/run-4.log', size: 300 },
    ], {
      maxLogAgeMs: 2_500,
      maxLogFiles: 2,
      maxTotalBytes: 450,
      now: 5_000,
    })

    expect(deletions.map(runLog => runLog.name)).toEqual([
      'run-1.log',
      'run-2.log',
      'run-3.log',
    ])
  })

  it('parses positive integer overrides safely', () => {
    expect(readPositiveInt('120', 10)).toBe(120)
    expect(readPositiveInt('0', 10)).toBe(10)
    expect(readPositiveInt('abc', 10)).toBe(10)
    expect(readPositiveInt(undefined, 10)).toBe(10)
  })

  it('parses non-negative integer overrides safely', () => {
    expect(readNonNegativeInt('120', 10)).toBe(120)
    expect(readNonNegativeInt('0', 10)).toBe(0)
    expect(readNonNegativeInt('-1', 10)).toBe(10)
    expect(readNonNegativeInt('abc', 10)).toBe(10)
    expect(readNonNegativeInt(undefined, 10)).toBe(10)
  })

  it('detects restart-required blocked reasons', () => {
    expect(isRestartRequiredBlockedReason('Bridge capability blocked craft sync: installed bridge jar is newer than the running Fabric mod build; Minecraft restart required')).toBe(true)
    expect(isRestartRequiredBlockedReason('Bridge capability blocked submerged escape: moveToward unsupported and baritone unavailable')).toBe(false)
    expect(isRestartRequiredBlockedReason(null)).toBe(false)
  })

  it('detects when the running bridge build is stale before the runner blocks on it', () => {
    expect(isBridgeBuildRestartRequired({
      bridgeState: {
        bridgeVersion: '0.1.0',
        bridgeBuildTimestamp: '2026-03-03T11:18:27.393174700Z',
        staleInstalledBridgeBuild: true,
      },
    })).toBe(true)

    expect(isBridgeBuildRestartRequired({
      bridgeState: {
        bridgeVersion: '0.1.0',
        bridgeBuildTimestamp: '2026-03-03T11:32:09.911576400Z',
        staleInstalledBridgeBuild: false,
      },
    })).toBe(false)
  })

  it('detects when the bridge is stuck awaiting world readiness after websocket connect', () => {
    expect(isAwaitingWorldReady({
      bridgeState: {
        connected: true,
        ready: false,
      },
      worldState: {
        terrainContext: 'awaiting_world',
      },
    })).toBe(true)

    expect(isAwaitingWorldReady({
      bridgeState: {
        connected: true,
        ready: true,
      },
      worldState: {
        terrainContext: 'surface_forest',
      },
    })).toBe(false)
  })
})
