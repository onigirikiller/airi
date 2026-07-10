import process, { exit } from 'node:process'

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import MineflayerArmorManager from 'mineflayer-armor-manager'

import { Client } from '@proj-airi/server-sdk'
import { loader as MineflayerAutoEat } from 'mineflayer-auto-eat'
import { plugin as MineflayerCollectBlock } from 'mineflayer-collectblock'
import { pathfinder as MineflayerPathfinder } from 'mineflayer-pathfinder'
import { plugin as MineflayerPVP } from 'mineflayer-pvp'
import { plugin as MineflayerTool } from 'mineflayer-tool'

import { initBot, initFabricBridge, resetBot } from './composables/bot'
import { config, initEnv } from './composables/config'
import { LLMAgent } from './libs/llm-agent'
import { wrapPlugin } from './libs/mineflayer'
import { AutonomyPlugin } from './plugins/autonomy'
import { MonitorDashboardPlugin } from './plugins/monitor-dashboard'
import { ViewerPlugin } from './plugins/viewer'
import { ViewerHudPlugin } from './plugins/viewer-hud'
import { initLogger, useLogger } from './utils/logger'

const LOCK_HEARTBEAT_INTERVAL_MS = 5_000
const LOCK_STALE_AFTER_MS = 30_000
const LOCK_CONFIRMATION_GRACE_MS = 750
const AIRI_CLIENT_WARN_THROTTLE_MS = 30_000

interface InstanceLockPayload {
  pid: number
  parentPid: number
  username: string
  port: number
  createdAt: string
  heartbeatAt: string
}

function isInstanceLockError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('Another minecraft-bot instance is already running')
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

function buildLockPath(port: number, _username: string): string {
  const lockDir = join(tmpdir(), 'airi-minecraft-locks')
  mkdirSync(lockDir, { recursive: true })
  return join(lockDir, `port-${port}.lock`)
}

function readInstanceLockPayload(lockPath: string): InstanceLockPayload | undefined {
  try {
    const raw = readFileSync(lockPath, 'utf8')
    return JSON.parse(raw) as InstanceLockPayload
  }
  catch {
    return undefined
  }
}

function writeInstanceLockPayload(lockPath: string, username: string, port: number): void {
  const nowIso = new Date().toISOString()
  const previous = readInstanceLockPayload(lockPath)
  const payload: InstanceLockPayload = {
    pid: process.pid,
    parentPid: process.ppid,
    username,
    port,
    createdAt: previous?.createdAt || nowIso,
    heartbeatAt: nowIso,
  }
  writeFileSync(lockPath, JSON.stringify(payload), 'utf8')
}

function hasFreshHeartbeat(payload: InstanceLockPayload | undefined): boolean {
  if (!payload) {
    return false
  }

  const heartbeatText = payload.heartbeatAt || payload.createdAt
  const heartbeatAt = Date.parse(heartbeatText)
  if (Number.isNaN(heartbeatAt)) {
    return false
  }

  return Date.now() - heartbeatAt <= LOCK_STALE_AFTER_MS
}

async function confirmActiveInstanceLock(lockPath: string, payload: InstanceLockPayload | undefined): Promise<boolean> {
  const existingPid = Number(payload?.pid)
  if (!isProcessAlive(existingPid) || !hasFreshHeartbeat(payload)) {
    return false
  }

  const initialHeartbeat = payload?.heartbeatAt || payload?.createdAt || ''
  const waitMs = Math.min(LOCK_STALE_AFTER_MS, LOCK_HEARTBEAT_INTERVAL_MS + LOCK_CONFIRMATION_GRACE_MS)
  await new Promise(resolve => setTimeout(resolve, waitMs))

  const refreshed = readInstanceLockPayload(lockPath)
  if (!refreshed) {
    return false
  }

  const refreshedPid = Number(refreshed?.pid)
  if (!isProcessAlive(refreshedPid) || !hasFreshHeartbeat(refreshed) || refreshedPid !== existingPid) {
    return false
  }

  const refreshedHeartbeat = refreshed.heartbeatAt || refreshed.createdAt
  return refreshedHeartbeat !== initialHeartbeat
}

async function acquireInstanceLock(port: number, username: string): Promise<string> {
  const lockPath = buildLockPath(port, username)
  if (existsSync(lockPath)) {
    const payload = readInstanceLockPayload(lockPath)
    const existingPid = Number(payload?.pid)
    if (await confirmActiveInstanceLock(lockPath, payload)) {
      throw new Error(`Another minecraft-bot instance is already running for ${username}:${port} (pid=${existingPid}).`)
    }

    try {
      unlinkSync(lockPath)
    }
    catch {
      // noop
    }
  }

  writeInstanceLockPayload(lockPath, username, port)

  return lockPath
}

function refreshInstanceLock(lockPath: string, username: string, port: number): void {
  try {
    writeInstanceLockPayload(lockPath, username, port)
  }
  catch (error) {
    useLogger().withError(error).warn('Failed to refresh instance lock heartbeat')
  }
}

function releaseInstanceLock(lockPath?: string): void {
  if (!lockPath) {
    return
  }

  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath)
    }
  }
  catch {
    // noop
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }

  return parsed
}

let instanceLockPath: string | undefined
let instanceLockHeartbeatTimer: ReturnType<typeof setInterval> | undefined
let airiClient: Client | undefined
let airiClientConnectedOnce = false
let lastAiriClientWarningAt = 0
let shuttingDown = false

// --- Auto-restart state ---
const MAX_RESTARTS_IN_WINDOW = readNonNegativeIntEnv('MINECRAFT_BOT_MAX_RESTARTS_IN_WINDOW', 5)
const RESTART_WINDOW_MS = readPositiveIntEnv('MINECRAFT_BOT_RESTART_WINDOW_MS', 10 * 60_000)
const BASE_RESTART_DELAY_MS = readPositiveIntEnv('MINECRAFT_BOT_RESTART_BASE_DELAY_MS', 3_000)
const MAX_RESTART_DELAY_MS = readPositiveIntEnv('MINECRAFT_BOT_RESTART_MAX_DELAY_MS', 5 * 60_000)

let restartCount = 0
let restartWindowStart = Date.now()
let isRestarting = false

async function cleanupCurrentSession(): Promise<void> {
  try {
    await resetBot()
  }
  catch (error) {
    useLogger().withError(error).warn('Failed to cleanup current bot session')
  }
}

function formatAiriClientError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (error && typeof error === 'object') {
    const message = Reflect.get(error, 'message')
    if (typeof message === 'string' && message.length > 0) {
      return message
    }

    const type = Reflect.get(error, 'type')
    if (typeof type === 'string' && type.length > 0) {
      return type
    }
  }

  return String(error)
}

function shouldEmitAiriClientWarning(): boolean {
  const now = Date.now()
  if (now - lastAiriClientWarningAt < AIRI_CLIENT_WARN_THROTTLE_MS) {
    return false
  }

  lastAiriClientWarningAt = now
  return true
}

function isTransientFabricDisconnectReason(reason: string): boolean {
  const normalized = reason.toLowerCase()
  return normalized === 'websocket disconnected'
    || normalized === 'not connected to fabric mod'
    || normalized === 'connection closed'
    || normalized.startsWith('bridge connection temporarily unavailable:')
}

function ensureAiriClient(): Client {
  if (airiClient) {
    return airiClient
  }

  airiClient = new Client({
    name: config.airi.clientName,
    url: config.airi.wsBaseUrl,
    onAnyMessage: () => {
      if (!airiClientConnectedOnce) {
        airiClientConnectedOnce = true
        useLogger().log('AIRI client websocket connected')
      }
    },
    onError: (error) => {
      const message = formatAiriClientError(error)
      const transientTransportError = message.includes('non-101')
        || message === '[object ErrorEvent]'
        || message.includes('WebSocket closed before open')

      if (!airiClientConnectedOnce && transientTransportError) {
        if (shouldEmitAiriClientWarning()) {
          useLogger().withFields({ message, wsBaseUrl: config.airi.wsBaseUrl }).log('AIRI client websocket not ready yet, retrying in background')
        }
        return
      }

      if (shouldEmitAiriClientWarning()) {
        useLogger().withFields({ message, wsBaseUrl: config.airi.wsBaseUrl }).warn('AIRI client websocket error')
      }
    },
    onClose: () => {
      if (airiClientConnectedOnce && shouldEmitAiriClientWarning()) {
        useLogger().warn('AIRI client websocket closed')
      }
    },
  })

  useLogger().withFields({
    clientName: config.airi.clientName,
    wsBaseUrl: config.airi.wsBaseUrl,
  }).log('AIRI client initialized')

  return airiClient
}

function closeAiriClient(): void {
  if (!airiClient) {
    return
  }

  try {
    airiClient.close()
  }
  catch (error) {
    useLogger().withError(error).warn('Failed to close AIRI client')
  }
  finally {
    airiClient = undefined
    airiClientConnectedOnce = false
  }
}

async function scheduleRestart(reason: string): Promise<void> {
  if (isRestarting || shuttingDown) {
    return
  }

  const now = Date.now()
  if (now - restartWindowStart > RESTART_WINDOW_MS) {
    restartCount = 0
    restartWindowStart = now
  }

  restartCount++
  if (MAX_RESTARTS_IN_WINDOW > 0 && restartCount > MAX_RESTARTS_IN_WINDOW) {
    useLogger().withFields({ restartCount, reason }).error('Too many restarts in window, giving up')
    await cleanupCurrentSession()
    if (instanceLockHeartbeatTimer) {
      clearInterval(instanceLockHeartbeatTimer)
      instanceLockHeartbeatTimer = undefined
    }
    releaseInstanceLock(instanceLockPath)
    exit(1)
    return
  }

  const delay = Math.min(
    BASE_RESTART_DELAY_MS * (2 ** (restartCount - 1)),
    MAX_RESTART_DELAY_MS,
  )
  useLogger().withFields({ reason, restartCount, delayMs: delay }).warn('Scheduling restart')

  isRestarting = true
  await cleanupCurrentSession()

  await new Promise<void>(resolve => setTimeout(resolve, delay))

  if (shuttingDown) {
    return
  }

  isRestarting = false
  try {
    await main()
  }
  catch (err) {
    useLogger().withError(err).error('Restart failed')
    void scheduleRestart(`restart-failed: ${(err as Error).message}`)
  }
}

async function main() {
  initLogger() // todo: save logs to file
  initEnv()
  const username = String(config.bot.username || 'minecraft-bot')
  const port = typeof config.bot.port === 'number' ? config.bot.port : 0

  if (!instanceLockPath) {
    instanceLockPath = await acquireInstanceLock(port, username)
    useLogger().withFields({ username, port }).log('Instance lock acquired')
  }

  if (!instanceLockHeartbeatTimer) {
    instanceLockHeartbeatTimer = setInterval(() => {
      if (!instanceLockPath) {
        return
      }
      refreshInstanceLock(instanceLockPath, username, port)
    }, LOCK_HEARTBEAT_INTERVAL_MS)
  }

  let bot: Awaited<ReturnType<typeof initBot>>['bot'] | Awaited<ReturnType<typeof initFabricBridge>>['bot']
  const client = ensureAiriClient()
  const llmPlugins = [
    LLMAgent({ airiClient: client }),
    AutonomyPlugin(client),
    MonitorDashboardPlugin(),
  ]

  if (config.fabricBridge.enabled) {
    // FabricBridge mode: connect to real Minecraft client via Fabric mod
    useLogger().log('Starting in FabricBridge mode (connecting to Fabric mod)')
    const result = await initFabricBridge({
      username,
      wsConfig: {
        host: config.fabricBridge.host,
        port: config.fabricBridge.port,
        reconnectInterval: config.fabricBridge.reconnectInterval,
        maxReconnectAttempts: config.fabricBridge.maxReconnectAttempts,
      },
      plugins: [
        // Mineflayer-specific plugins are not needed in FabricBridge mode
        // The Fabric mod handles pathfinding (Baritone), PVP, etc.
        ...llmPlugins,
      ],
    })
    bot = result.bot
  }
  else {
    // Classic mineflayer mode: headless bot connects to server
    const result = await initBot({
      botConfig: config.bot,
      plugins: [
        wrapPlugin(MineflayerArmorManager),
        wrapPlugin(MineflayerAutoEat),
        wrapPlugin(MineflayerCollectBlock),
        wrapPlugin(MineflayerPathfinder),
        wrapPlugin(MineflayerPVP),
        wrapPlugin(MineflayerTool),
        ViewerPlugin({ enabled: true, firstPerson: true, viewDistance: 6 }),
        ViewerHudPlugin(),
        ...llmPlugins,
      ],
    })
    bot = result.bot
  }

  // Auto-restart on fatal bot disconnect (Layer 3)
  bot.on('fatal-disconnect', (ctx) => {
    if (config.fabricBridge.enabled && isTransientFabricDisconnectReason(ctx.reason)) {
      useLogger().withFields({ reason: ctx.reason }).warn('Transient Fabric bridge disconnect detected, keeping process alive for websocket reconnect')
      return
    }
    useLogger().withFields({ reason: ctx.reason }).warn('Bot fatal disconnect detected, scheduling restart')
    void scheduleRestart(ctx.reason)
  })
}

async function gracefulShutdown(): Promise<void> {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  await cleanupCurrentSession()
  if (instanceLockHeartbeatTimer) {
    clearInterval(instanceLockHeartbeatTimer)
    instanceLockHeartbeatTimer = undefined
  }
  closeAiriClient()
  releaseInstanceLock(instanceLockPath)
  exit(0)
}

process.on('SIGINT', () => void gracefulShutdown())
process.on('SIGTERM', () => void gracefulShutdown())
process.on('exit', () => {
  if (instanceLockHeartbeatTimer) {
    clearInterval(instanceLockHeartbeatTimer)
    instanceLockHeartbeatTimer = undefined
  }
  closeAiriClient()
  releaseInstanceLock(instanceLockPath)
})

process.on('uncaughtException', (err) => {
  if (config.fabricBridge.enabled && isTransientFabricDisconnectReason(err.message)) {
    useLogger().withFields({ reason: err.message }).warn('Transient Fabric bridge exception observed, keeping process alive for reconnect')
    return
  }
  useLogger().withError(err).error('Uncaught exception, scheduling restart')
  void scheduleRestart(`uncaughtException: ${err.message}`)
})

process.on('unhandledRejection', (reason) => {
  const message = String(reason)
  if (config.fabricBridge.enabled && isTransientFabricDisconnectReason(message)) {
    useLogger().withFields({ reason: message }).warn('Transient Fabric bridge rejection observed, keeping process alive for reconnect')
    return
  }
  useLogger().withFields({ reason: message }).error('Unhandled rejection, scheduling restart')
  void scheduleRestart(`unhandledRejection: ${message.slice(0, 200)}`)
})

main().catch((err: Error) => {
  if (isInstanceLockError(err)) {
    useLogger().withError(err).error('Initial startup failed due to active instance lock, exiting for supervisor recovery')
    closeAiriClient()
    releaseInstanceLock(instanceLockPath)
    exit(1)
  }

  useLogger().withError(err).error('Initial startup failed, scheduling restart')
  void scheduleRestart(`startup-failed: ${err.message}`)
})
