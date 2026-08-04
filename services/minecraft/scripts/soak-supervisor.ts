import type { ChildProcess } from 'node:child_process'
import type { WriteStream } from 'node:fs'

import type { MonitorState, SupervisorSummary } from '../src/supervisor/soak'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  buildStateFingerprint,
  calculateRestartDelay,
  createEmptySupervisorSummary,
  getHealthRestartReason,
  isAwaitingWorldReady,
  isBridgeBuildRestartRequired,
  isRestartRequiredBlockedReason,
  pruneRestartHistory,
  readNonNegativeInt,
  readPositiveInt,
  selectRunLogsToDelete,
  summarizeSupervisorEvent,
} from '../src/supervisor/soak'

interface SupervisorEvent {
  at: string
  type: string
  details: Record<string, unknown>
}

interface SupervisorStatus {
  activeRunId: string | null
  childPid: number | null
  childStartedAt: string | null
  childCommand: string
  logDirectory: string
  monitorUrl: string
  lastStdoutAt: string | null
  lastMonitorSuccessAt: string | null
  lastStateChangeAt: string | null
  lastStateFingerprint: string | null
  consecutiveRestarts: number
  recentRestartCount: number
  pendingRestartReason: string | null
  lastRestartReason: string | null
  summaryFilePath: string
}

const workspaceRoot = resolve(import.meta.dirname, '..')
const logDirectory = resolve(workspaceRoot, process.env.SOAK_SUPERVISOR_LOG_DIR ?? 'runtime/soak-supervisor')
const childCommand = process.env.SOAK_SUPERVISOR_COMMAND ?? 'pnpm start'
const monitorPort = process.env.MONITOR_PORT ?? process.env.MINECRAFT_MONITOR_PORT ?? '3002'
const monitorUrl = process.env.SOAK_SUPERVISOR_MONITOR_URL ?? `http://127.0.0.1:${monitorPort}/api/state`
const pollIntervalMs = readPositiveInt(process.env.SOAK_SUPERVISOR_POLL_INTERVAL_MS, 5000)
const stdoutIdleTimeoutMs = readPositiveInt(process.env.SOAK_SUPERVISOR_STDOUT_IDLE_TIMEOUT_MS, 180000)
const stateStallTimeoutMs = readPositiveInt(process.env.SOAK_SUPERVISOR_STATE_STALL_TIMEOUT_MS, 240000)
const monitorFailureTimeoutMs = readPositiveInt(process.env.SOAK_SUPERVISOR_MONITOR_FAILURE_TIMEOUT_MS, 90000)
const startupGraceMs = readPositiveInt(process.env.SOAK_SUPERVISOR_STARTUP_GRACE_MS, 60000)
const restartBaseDelayMs = readPositiveInt(process.env.SOAK_SUPERVISOR_RESTART_BASE_DELAY_MS, 5000)
const restartMaxDelayMs = readPositiveInt(process.env.SOAK_SUPERVISOR_RESTART_MAX_DELAY_MS, 60000)
const maxRestartsPerHour = readNonNegativeInt(process.env.SOAK_SUPERVISOR_MAX_RESTARTS_PER_HOUR, 20)
const gracefulShutdownMs = readPositiveInt(process.env.SOAK_SUPERVISOR_GRACEFUL_SHUTDOWN_MS, 10000)
const maxRunLogs = readPositiveInt(process.env.SOAK_SUPERVISOR_MAX_RUN_LOGS, 40)
const maxRunLogAgeMs = readPositiveInt(process.env.SOAK_SUPERVISOR_MAX_RUN_LOG_AGE_MS, 7 * 24 * 60 * 60 * 1000)
const maxRunLogBytes = readPositiveInt(process.env.SOAK_SUPERVISOR_MAX_RUN_LOG_BYTES, 512 * 1024 * 1024)
const requestTimeoutMs = readPositiveInt(process.env.SOAK_SUPERVISOR_REQUEST_TIMEOUT_MS, 5000)
const restartRequiredDelayMs = readPositiveInt(process.env.SOAK_SUPERVISOR_RESTART_REQUIRED_DELAY_MS, 5 * 60 * 1000)
const instanceLockStaleAfterMs = readPositiveInt(process.env.SOAK_SUPERVISOR_INSTANCE_LOCK_STALE_AFTER_MS, 30_000)
const awaitingWorldRestartMs = readPositiveInt(process.env.SOAK_SUPERVISOR_AWAITING_WORLD_RESTART_MS, 90_000)
const stopOnVictory = /^(?:1|true|yes)$/iu.test(process.env.SOAK_SUPERVISOR_STOP_ON_VICTORY ?? '')
const restartWindowMs = 60 * 60 * 1000
const summaryFilePath = resolve(logDirectory, 'summary.json')
const botPort = readPositiveInt(process.env.BOT_PORT, 25565)
const instanceLockPath = join(tmpdir(), 'airi-minecraft-locks', `port-${botPort}.lock`)
let lastBlockedReason: string | null = null
let awaitingWorldSinceAt = 0

let child: ChildProcess | null = null
let childLogStream: WriteStream | null = null
let childStartAt = 0
let lastStdoutAt = 0
let lastMonitorSuccessAt = 0
let lastStateChangeAt = 0
let lastStateFingerprint = ''
let activeRunId: string | null = null
let expectedExitPid: number | null = null
let shuttingDown = false
let pendingRestartReason: string | null = null
let lastRestartReason: string | null = null
let consecutiveRestarts = 0
let restartHistory: number[] = []
let pollTimer: ReturnType<typeof setInterval> | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null
let healthCheckInFlight = false
let summary: SupervisorSummary = await loadSupervisorSummary()

interface SpawnCommand {
  command: string
  args: string[]
}

await mkdir(logDirectory, { recursive: true })
await recordEvent('supervisor_started', {
  childCommand,
  logDirectory,
  monitorUrl,
})
await startChild()
pollTimer = setInterval(() => {
  void checkHealth()
}, pollIntervalMs)

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})

async function startChild(): Promise<void> {
  await pruneRunLogs()
  await cleanupOrphanedBotInstanceLock()
  activeRunId = createRunId()
  childStartAt = Date.now()
  lastStdoutAt = childStartAt
  lastMonitorSuccessAt = childStartAt
  lastStateChangeAt = childStartAt
  lastStateFingerprint = ''

  const logFilePath = resolve(logDirectory, `${activeRunId}.log`)
  childLogStream = createWriteStream(logFilePath, { flags: 'a' })
  const spawnCommand = resolveSpawnCommand(childCommand)
  child = spawn(spawnCommand.command, spawnCommand.args, {
    cwd: workspaceRoot,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (chunk: Uint8Array | string) => {
    lastStdoutAt = Date.now()
    childLogStream?.write(chunk)
  })

  child.stderr?.on('data', (chunk: Uint8Array | string) => {
    lastStdoutAt = Date.now()
    childLogStream?.write(chunk)
  })

  child.on('error', (error) => {
    void recordEvent('child_error', {
      pid: child?.pid ?? null,
      message: error.message,
    })
  })

  child.on('exit', (code, signal) => {
    const exitedPid = child?.pid ?? null
    void recordEvent('child_exit', {
      code,
      signal,
      pid: exitedPid,
      expected: expectedExitPid != null && expectedExitPid === exitedPid,
    })

    childLogStream?.end()
    childLogStream = null
    child = null

    if (expectedExitPid != null && expectedExitPid === exitedPid) {
      expectedExitPid = null
      return
    }

    if (!shuttingDown) {
      void scheduleRestart(`process_exit:${code ?? signal ?? 'unknown'}`)
    }
  })

  await recordEvent('child_started', {
    pid: child.pid ?? null,
    runId: activeRunId,
    logFilePath,
    command: spawnCommand.command,
    args: spawnCommand.args,
  })
}

function resolveSpawnCommand(commandText: string): SpawnCommand {
  const normalized = commandText.trim()
  if (normalized.length === 0) {
    return resolveDefaultBotStartCommand()
  }

  if (/^pnpm(?:\.cmd)?\s+start$/iu.test(normalized)) {
    return resolveDefaultBotStartCommand()
  }

  const segments = normalized.match(/"[^"]*"|\S+/gu)?.map(segment => segment.replace(/^"(.*)"$/u, '$1')) ?? []
  if (segments.length === 0) {
    return {
      command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      args: ['start'],
    }
  }

  const [command, ...args] = segments
  return { command, args }
}

function resolveDefaultBotStartCommand(): SpawnCommand {
  const tsxCliPath = resolve(workspaceRoot, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
  return {
    command: process.execPath,
    args: [
      tsxCliPath,
      '--env-file=.env',
      '--env-file-if-exists=.env.local',
      'src/main.ts',
    ],
  }
}

async function cleanupOrphanedBotInstanceLock(): Promise<void> {
  try {
    const lockRaw = await readFile(instanceLockPath, 'utf8')
    const parsed = JSON.parse(lockRaw) as {
      pid?: number
      parentPid?: number
      createdAt?: string
      heartbeatAt?: string
    }
    const lockedPid = typeof parsed.pid === 'number' ? parsed.pid : null
    const ownedByCurrentChild = child?.pid != null
      && (
        child.pid === lockedPid
        || (typeof parsed.parentPid === 'number' && parsed.parentPid === child.pid)
      )
    if (lockedPid == null || ownedByCurrentChild) {
      return
    }

    const lockHeartbeatText = parsed.heartbeatAt ?? parsed.createdAt ?? null
    const lockHeartbeatAt = lockHeartbeatText == null ? Number.NaN : Date.parse(lockHeartbeatText)
    const hasFreshHeartbeat = Number.isFinite(lockHeartbeatAt)
      && Date.now() - lockHeartbeatAt <= instanceLockStaleAfterMs

    try {
      process.kill(lockedPid, 0)
      if (hasFreshHeartbeat) {
        return
      }
    }
    catch {
      await rm(instanceLockPath, { force: true })
      return
    }

    await recordEvent('orphan_lock_process_detected', {
      pid: lockedPid,
      lockPath: instanceLockPath,
    })
    await terminatePid(lockedPid)
    await wait(1_000)
    await rm(instanceLockPath, { force: true })
  }
  catch {
    // noop
  }
}

async function checkHealth(): Promise<void> {
  if (shuttingDown || healthCheckInFlight || child == null) {
    return
  }

  healthCheckInFlight = true
  try {
    const now = Date.now()
    const preFetchRestartReason = getHealthRestartReason({
      childStartAt,
      lastMonitorSuccessAt,
      lastStateChangeAt,
      lastStdoutAt,
      monitorFailureTimeoutMs,
      monitorFetchFailed: false,
      now,
      startupGraceMs,
      stateStallTimeoutMs,
      stdoutIdleTimeoutMs,
    })
    if (preFetchRestartReason != null) {
      await scheduleRestart(preFetchRestartReason)
      return
    }

    const state = await fetchMonitorState()
    lastMonitorSuccessAt = now
    const phase = typeof state.runnerState?.phase === 'string'
      ? state.runnerState.phase
      : null
    if (stopOnVictory && phase === 'VICTORY') {
      await recordEvent('victory_detected', {
        phase,
        position: state.botState?.position ?? null,
        dimension: state.botState?.dimension ?? null,
      })
      await shutdown('VICTORY')
      return
    }
    const blockedReason = typeof state.runnerState?.blockedReason === 'string'
      ? state.runnerState.blockedReason
      : null
    if (blockedReason != null) {
      lastStateChangeAt = now
    }
    if (blockedReason !== lastBlockedReason) {
      lastBlockedReason = blockedReason
      if (blockedReason != null) {
        await recordEvent('runner_blocked', {
          blockedReason,
          blockedMsRemaining: state.runnerState?.blockedMsRemaining ?? null,
          bridgeVersion: state.bridgeState?.bridgeVersion ?? null,
          bridgeBuildTimestamp: state.bridgeState?.bridgeBuildTimestamp ?? null,
        })
      }
    }
    if (isBridgeBuildRestartRequired(state)) {
      await requestLauncherRestart(
        'Installed bridge jar is newer than the running Fabric mod build; Minecraft restart required',
        state,
      )
      return
    }
    if (isAwaitingWorldReady(state)) {
      if (awaitingWorldSinceAt === 0) {
        awaitingWorldSinceAt = now
      }
      else if (now - awaitingWorldSinceAt >= awaitingWorldRestartMs) {
        await requestLauncherRestart(
          `Fabric bridge connected but never reached in-world readiness after ${awaitingWorldRestartMs}ms`,
          state,
        )
        return
      }
    }
    else {
      awaitingWorldSinceAt = 0
    }
    if (blockedReason != null && isRestartRequiredBlockedReason(blockedReason)) {
      await requestLauncherRestart(blockedReason, state)
      return
    }
    const fingerprint = buildStateFingerprint(state)
    if (fingerprint !== lastStateFingerprint) {
      lastStateFingerprint = fingerprint
      lastStateChangeAt = now
    }

    const postFetchRestartReason = getHealthRestartReason({
      childStartAt,
      lastMonitorSuccessAt,
      lastStateChangeAt,
      lastStdoutAt,
      monitorFailureTimeoutMs,
      monitorFetchFailed: false,
      now,
      startupGraceMs,
      stateStallTimeoutMs,
      stdoutIdleTimeoutMs,
    })
    if (postFetchRestartReason != null) {
      await scheduleRestart(postFetchRestartReason)
      return
    }

    await writeStatus()
  }
  catch (error) {
    const now = Date.now()
    await recordEvent('monitor_fetch_failed', {
      message: error instanceof Error ? error.message : String(error),
    })

    const restartReason = getHealthRestartReason({
      childStartAt,
      lastMonitorSuccessAt,
      lastStateChangeAt,
      lastStdoutAt,
      monitorFailureTimeoutMs,
      monitorFetchFailed: true,
      now,
      startupGraceMs,
      stateStallTimeoutMs,
      stdoutIdleTimeoutMs,
    })
    if (restartReason != null) {
      await scheduleRestart(restartReason)
      return
    }

    await writeStatus()
  }
  finally {
    healthCheckInFlight = false
  }
}

async function requestLauncherRestart(reason: string, state: MonitorState): Promise<void> {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  pendingRestartReason = 'launcher_restart_required'

  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (restartTimer != null) {
    clearTimeout(restartTimer)
    restartTimer = null
  }

  await recordEvent('launcher_restart_requested', {
    blockedReason: reason,
    blockedMsRemaining: state.runnerState?.blockedMsRemaining ?? null,
    bridgeVersion: state.bridgeState?.bridgeVersion ?? null,
    bridgeBuildTimestamp: state.bridgeState?.bridgeBuildTimestamp ?? null,
  })
  await stopChild(`launcher_restart_required:${reason}`)
  await writeStatus()
  process.exit(75)
}

async function fetchMonitorState(): Promise<MonitorState> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)

  try {
    // NOTICE: Reuse the existing monitor dashboard JSON instead of inventing a parallel
    // health endpoint, so soak supervision stays aligned with the same state operators inspect.
    const response = await fetch(monitorUrl, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error(`Monitor responded with ${response.status}`)
    }
    return await response.json() as MonitorState
  }
  finally {
    clearTimeout(timeout)
  }
}

async function scheduleRestart(reason: string): Promise<void> {
  if (shuttingDown || restartTimer != null) {
    return
  }

  restartHistory = pruneRestartHistory(restartHistory, Date.now(), restartWindowMs)
  if (maxRestartsPerHour > 0 && restartHistory.length >= maxRestartsPerHour) {
    await recordEvent('restart_limit_reached', {
      reason,
      maxRestartsPerHour,
      restartHistory,
    })
    return
  }

  const restartRequiredBlocked = reason.startsWith('process_exit:')
    && isRestartRequiredBlockedReason(lastBlockedReason)
  const effectiveReason = restartRequiredBlocked
    ? 'runner_blocked_restart_required'
    : reason

  pendingRestartReason = effectiveReason
  const delayMs = restartRequiredBlocked
    ? Math.max(restartRequiredDelayMs, calculateRestartDelay(consecutiveRestarts, restartBaseDelayMs, restartMaxDelayMs))
    : calculateRestartDelay(consecutiveRestarts, restartBaseDelayMs, restartMaxDelayMs)

  await recordEvent('restart_scheduled', {
    reason: effectiveReason,
    delayMs,
    consecutiveRestarts,
    blockedReason: restartRequiredBlocked ? lastBlockedReason : null,
  })

  restartTimer = setTimeout(() => {
    restartTimer = null
    void restartChild(effectiveReason)
  }, delayMs)
  await writeStatus()
}

async function restartChild(reason: string): Promise<void> {
  if (shuttingDown) {
    return
  }

  lastRestartReason = reason
  consecutiveRestarts += 1
  restartHistory.push(Date.now())
  pendingRestartReason = null
  await recordEvent('restart_started', {
    reason,
    consecutiveRestarts,
  })

  await stopChild(`restart:${reason}`)
  await startChild()
  await writeStatus()
}

async function stopChild(reason: string): Promise<void> {
  if (child == null) {
    return
  }

  const runningChild = child
  const pid = runningChild.pid ?? null
  expectedExitPid = pid
  await recordEvent('child_stop_requested', {
    reason,
    pid,
  })

  if (pid == null) {
    child = null
    expectedExitPid = null
    return
  }

  runningChild.kill('SIGTERM')
  await wait(gracefulShutdownMs)

  if (child != null && child.pid === pid) {
    await terminatePid(pid)
  }
}

async function terminatePid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: true,
      })
      killer.on('exit', () => resolvePromise())
      killer.on('error', () => resolvePromise())
    })
    return
  }

  try {
    process.kill(pid, 'SIGKILL')
  }
  catch {
    /* noop */
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  pendingRestartReason = null

  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (restartTimer != null) {
    clearTimeout(restartTimer)
    restartTimer = null
  }

  await recordEvent('supervisor_stopping', { signal })
  await stopChild(`shutdown:${signal}`)
  await writeStatus()
  process.exit(0)
}

async function writeStatus(): Promise<void> {
  const status: SupervisorStatus = {
    activeRunId,
    childPid: child?.pid ?? null,
    childStartedAt: childStartAt > 0 ? new Date(childStartAt).toISOString() : null,
    childCommand,
    logDirectory,
    monitorUrl,
    lastStdoutAt: lastStdoutAt > 0 ? new Date(lastStdoutAt).toISOString() : null,
    lastMonitorSuccessAt: lastMonitorSuccessAt > 0 ? new Date(lastMonitorSuccessAt).toISOString() : null,
    lastStateChangeAt: lastStateChangeAt > 0 ? new Date(lastStateChangeAt).toISOString() : null,
    lastStateFingerprint: lastStateFingerprint || null,
    consecutiveRestarts,
    recentRestartCount: pruneRestartHistory(restartHistory, Date.now(), restartWindowMs).length,
    pendingRestartReason,
    lastRestartReason,
    summaryFilePath,
  }

  await writeFile(
    resolve(logDirectory, 'status.json'),
    `${JSON.stringify(status, null, 2)}\n`,
    'utf8',
  )
}

async function recordEvent(type: string, details: Record<string, unknown>): Promise<void> {
  const event: SupervisorEvent = {
    at: new Date().toISOString(),
    type,
    details,
  }
  summary = summarizeSupervisorEvent(summary, event)
  await appendFile(
    resolve(logDirectory, 'events.ndjson'),
    `${JSON.stringify(event)}\n`,
    'utf8',
  )
  await writeFile(summaryFilePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
}

function createRunId(): string {
  const now = new Date()
  const iso = now.toISOString().replace(/[:.]/g, '-')
  return `run-${iso}`
}

function wait(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function loadSupervisorSummary(): Promise<SupervisorSummary> {
  try {
    const text = await readFile(summaryFilePath, 'utf8')
    const parsed = JSON.parse(text) as Partial<SupervisorSummary>
    return {
      ...createEmptySupervisorSummary(),
      ...parsed,
      eventTypeCounts: parsed.eventTypeCounts ?? {},
      restartReasonCounts: parsed.restartReasonCounts ?? {},
    }
  }
  catch {
    return createEmptySupervisorSummary()
  }
}

async function pruneRunLogs(): Promise<void> {
  const entries = await readdir(logDirectory, { withFileTypes: true })
  const runLogs = await Promise.all(entries
    .filter(entry => entry.isFile() && /^run-.*\.log$/u.test(entry.name))
    .map(async (entry) => {
      const fullPath = resolve(logDirectory, entry.name)
      const stats = await stat(fullPath)
      return {
        modifiedAtMs: stats.mtimeMs,
        name: entry.name,
        path: fullPath,
        size: stats.size,
      }
    }))

  const logsToDelete = selectRunLogsToDelete(runLogs, {
    maxLogAgeMs: maxRunLogAgeMs,
    maxLogFiles: maxRunLogs,
    maxTotalBytes: maxRunLogBytes,
    now: Date.now(),
  })

  if (logsToDelete.length === 0) {
    return
  }

  for (const runLog of logsToDelete) {
    await rm(runLog.path, { force: true })
  }

  await recordEvent('run_log_pruned', {
    deletedCount: logsToDelete.length,
    deletedFiles: logsToDelete.map(runLog => runLog.name),
    maxLogAgeMs: maxRunLogAgeMs,
    maxLogFiles: maxRunLogs,
    maxRunLogBytes,
  })
}
