/**
 * FabricBridge: Mineflayer-compatible wrapper for the Fabric mod WebSocket bridge.
 *
 * Drop-in replacement for the Mineflayer class - same public interface,
 * backed by a real Minecraft client running the airi-mcbridge Fabric mod.
 */

import type { MineflayerPlugin } from '../mineflayer/plugin'
import type { TickEvents, TickEventsHandler } from '../mineflayer/ticker'
import type { EventHandlers, EventsHandler } from '../mineflayer/types'
import type { FabricBridgeConfig } from './types'

import process from 'node:process'

import { statSync } from 'node:fs'
import { join } from 'node:path'

import EventEmitter from 'eventemitter3'

import { useLogg } from '@guiiai/logg'

import { ActionAbortedError, stopActiveBotAction } from '../mineflayer/action-abort'
import { Components } from '../mineflayer/components'
import { Health } from '../mineflayer/health'
import { Memory } from '../mineflayer/memory'
import { Status } from '../mineflayer/status'
import { Ticker } from '../mineflayer/ticker'
import { BotProxy } from './bot-proxy'
import { BaritonePathfinder } from './pathfinder'
import { WsClient } from './ws-client'

export interface FabricBridgeOptions {
  username: string
  wsConfig: FabricBridgeConfig
  plugins?: MineflayerPlugin[]
}

export function getInstalledBridgeJarPath(version: string | null): string | null {
  if (!version) {
    return null
  }

  const appData = process.env.APPDATA
  if (!appData) {
    return null
  }

  return join(appData, '.minecraft', 'mods', `airi-mcbridge-${version}.jar`)
}

export function hasLikelyNewerInstalledBridgeBuild(
  bridgeVersion: string | null,
  bridgeBuildTimestamp: string | null,
): boolean {
  const jarPath = getInstalledBridgeJarPath(bridgeVersion)
  if (!jarPath || !bridgeBuildTimestamp) {
    return false
  }

  const runningBuildAt = Date.parse(bridgeBuildTimestamp)
  if (Number.isNaN(runningBuildAt)) {
    return false
  }

  try {
    const stats = statSync(jarPath)
    // NOTICE: The running bridge reports its internal build timestamp, but the installed
    // jar on disk is easier to probe from Node than reading zip metadata at runtime.
    // If the local jar file modification time is materially newer than the running build,
    // the Minecraft client is almost certainly still using an older mod load and needs a restart.
    return stats.mtimeMs > runningBuildAt + 60_000
  }
  catch {
    return false
  }
}

/**
 * FabricBridge implements the same public API as Mineflayer class.
 */
export class FabricBridge extends EventEmitter<EventHandlers> {
  private static readonly CONNECT_TIMEOUT_MS = 90_000
  private static readonly READY_STATUS_POLL_INTERVAL_MS = 2_000
  public bot: BotProxy
  public username: string
  public health: Health = new Health()
  public ready: boolean = false
  public components: Components = new Components()
  public status: Status = new Status()
  public memory: Memory = new Memory()

  public isCreative: boolean = false
  public allowCheats: boolean = false
  public bridgeVersion: string | null = null
  public bridgeBuildTimestamp: string | null = null

  private wsClient: WsClient
  private pathfinder: BaritonePathfinder
  private options: FabricBridgeOptions
  private logger = useLogg('FabricBridge').useGlobalConfig()
  private commands: Map<string, EventsHandler<'command'>> = new Map()
  private ticker: Ticker = new Ticker()
  private pluginSpawnHooksRan = false
  private pluginsInitialized = false
  private hasConnectedOnce = false
  private pendingConnectionRefresh: Promise<void> | null = null
  private readyStatusPollTimer: ReturnType<typeof setInterval> | null = null
  private readyStatusRefreshInFlight = false
  private blockScanTimer: ReturnType<typeof setInterval> | null = null
  private currentActionController: AbortController | undefined
  private currentActionLabel: string | undefined

  public get currentActionSignal(): AbortSignal | undefined {
    return this.currentActionController?.signal
  }

  /** Starts an exclusive action, interrupting any older action before publishing its signal. */
  public beginAction(label: string): AbortSignal {
    if (this.currentActionController) {
      this.abortCurrentAction(`Superseded by action: ${label}`)
    }

    const controller = new AbortController()
    controller.signal.addEventListener('abort', () => stopActiveBotAction(this.bot as any), { once: true })
    this.currentActionController = controller
    this.currentActionLabel = label
    return controller.signal
  }

  /** Physically stops and aborts the currently executing action. */
  public abortCurrentAction(reason: string): void {
    const controller = this.currentActionController
    if (!controller || controller.signal.aborted) {
      return
    }

    this.logger.withFields({ action: this.currentActionLabel ?? '', reason }).log('Aborting current action')
    controller.abort(new ActionAbortedError(reason))
  }

  /** Clears an action only when the completing caller still owns the active signal. */
  public completeAction(signal: AbortSignal): void {
    if (this.currentActionController?.signal !== signal) {
      return
    }
    this.currentActionController = undefined
    this.currentActionLabel = undefined
  }

  constructor(options: FabricBridgeOptions) {
    super()
    this.options = options
    this.username = options.username

    this.wsClient = new WsClient(options.wsConfig)
    this.bot = new BotProxy(this.wsClient, options.username)
    this.pathfinder = new BaritonePathfinder(this.wsClient, () => this.bot.entity.position)

    // Wire pathfinder into bot proxy
    this.bot.pathfinder = this.pathfinder as any

    // Wire up interrupt
    this.on('interrupt', () => {
      this.logger.log('Interrupted')
      this.abortCurrentAction('Interrupt requested')
      this.bot.chat('Interrupted')
    })
  }

  static async asyncBuild(options: FabricBridgeOptions): Promise<FabricBridge> {
    const bridge = new FabricBridge(options)

    bridge.registerConnectionLifecycleHandlers()

    // Connect to Fabric mod
    bridge.wsClient.connect()

    const connectedInitially = await bridge.waitForInitialConnection()
    if (!connectedInitially) {
      bridge.logger.warn(`Initial Fabric mod connection did not arrive within ${FabricBridge.CONNECT_TIMEOUT_MS}ms; continuing in deferred-connect mode and waiting for websocket reconnect`)
    }
    else {
      await bridge.awaitPendingConnectionRefresh()
    }

    // Wire up bot events to bridge events
    bridge.bot.on('health', () => {
      if (bridge.bot.health < bridge.health.value) {
        bridge.health.lastDamageTime = Date.now()
        bridge.health.lastDamageTaken = bridge.health.value - bridge.bot.health
      }
      bridge.health.value = bridge.bot.health
    })

    bridge.bot.on('time', () => {
      const time = bridge.bot.time.timeOfDay
      if (time === 0)
        bridge.emit('time:sunrise', { time })
      else if (time === 6000)
        bridge.emit('time:noon', { time })
      else if (time === 12000)
        bridge.emit('time:sunset', { time })
      else if (time === 18000)
        bridge.emit('time:midnight', { time })
    })

    bridge.bot.on('death', () => {
      bridge.logger.error('Player died')
    })

    bridge.bot.on('spawn', () => {
      bridge.ready = true
      bridge.stopReadyStatusPolling()
      bridge.logger.log('Player spawned, bridge ready')
      void bridge.runSpawnHooks()
    })

    bridge.bot.on('chat', (username: string, message: string) => {
      bridge.handleChatCommand(username, message)
    })
    // Initial block scan to populate cache for sync lookups
    if (bridge.ready) {
      bridge.logger.log('Starting initial block scan...')
      bridge.bot.scanNearbyBlocks(32).then(() => {
        bridge.logger.log('Initial block scan complete')
      }).catch(() => {})
    }

    // Periodic block scan to keep cache fresh
    bridge.ticker.on('tick', () => {
      bridge.updateStatus()
    })

    // Re-scan blocks periodically (every 30 seconds)
    bridge.blockScanTimer = setInterval(() => {
      if (bridge.ready) {
        bridge.bot.scanNearbyBlocks(32).catch(() => {})
      }
    }, 30000)

    // Load plugins
    for (const plugin of options.plugins || []) {
      if (plugin.created) {
        await plugin.created(bridge as any)
      }
    }

    bridge.pluginsInitialized = true

    if (bridge.ready) {
      await bridge.runSpawnHooks()
    }
    else {
      bridge.startReadyStatusPolling()
    }

    return bridge
  }

  private registerConnectionLifecycleHandlers(): void {
    this.wsClient.on('connected', () => {
      const context: 'initial' | 'reconnected' = this.hasConnectedOnce ? 'reconnected' : 'initial'
      this.hasConnectedOnce = true
      if (context === 'initial') {
        this.logger.log('Connected to Fabric mod WebSocket')
      }

      const refreshPromise = this.refreshConnectionState(context)
      this.pendingConnectionRefresh = refreshPromise.finally(() => {
        if (this.pendingConnectionRefresh === refreshPromise) {
          this.pendingConnectionRefresh = null
        }
      })
    })

    this.wsClient.on('disconnected', () => {
      this.ready = false
      this.pluginSpawnHooksRan = false
      this.stopReadyStatusPolling()
      this.logger.warn('Lost Fabric bridge connection, waiting for websocket reconnect')
    })
  }

  private waitForInitialConnection(): Promise<boolean> {
    if (this.wsClient.connected) {
      return Promise.resolve(true)
    }

    return new Promise<boolean>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      let handleConnected: (() => void) | undefined
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout)
          timeout = undefined
        }
        if (handleConnected) {
          this.wsClient.off('connected', handleConnected)
        }
      }

      handleConnected = () => {
        cleanup()
        resolve(true)
      }

      timeout = setTimeout(() => {
        cleanup()
        resolve(false)
      }, FabricBridge.CONNECT_TIMEOUT_MS)

      this.wsClient.once('connected', handleConnected)
    })
  }

  private async awaitPendingConnectionRefresh(): Promise<void> {
    if (!this.pendingConnectionRefresh) {
      return
    }

    await this.pendingConnectionRefresh
  }

  public onCommand(commandName: string, cb: EventsHandler<'command'>) {
    this.commands.set(commandName, cb)
  }

  public onTick(event: TickEvents, cb: TickEventsHandler<TickEvents>) {
    this.ticker.on(event, cb)
  }

  public async loadPlugin(plugin: MineflayerPlugin) {
    if (plugin.created)
      await plugin.created(this as any)

    if (plugin.spawned && this.ready)
      await plugin.spawned(this as any)
  }

  public async stop() {
    this.abortCurrentAction('FabricBridge stopping')
    this.stopReadyStatusPolling()
    if (this.blockScanTimer) {
      clearInterval(this.blockScanTimer)
      this.blockScanTimer = null
    }
    this.ticker.stop()
    this.pathfinder.stop()
    for (const plugin of this.options?.plugins || []) {
      if (plugin.beforeCleanup) {
        await plugin.beforeCleanup(this as any)
      }
    }
    this.components.cleanup()
    this.wsClient.disconnect()
    this.removeAllListeners()
  }

  public getBridgeDebugState(): Record<string, unknown> {
    const staleInstalledBridgeBuild = hasLikelyNewerInstalledBridgeBuild(
      this.bridgeVersion,
      this.bridgeBuildTimestamp,
    )

    return {
      connected: this.wsClient.connected,
      ready: this.ready,
      bridgeVersion: this.bridgeVersion,
      bridgeBuildTimestamp: this.bridgeBuildTimestamp,
      staleInstalledBridgeBuild,
      capabilitySnapshot: this.bot.getBridgeCapabilitySnapshot(),
      pathfinder: this.pathfinder.getDebugState(),
    }
  }

  public async probeBridgeCapabilities(): Promise<Record<string, unknown>> {
    try {
      const status = await this.wsClient.request<{
        supportedCommands?: string[]
        capabilitiesHash?: string
      }>('getStatus', {})
      this.bot.applyBridgeCapabilitySnapshot({
        supportedCommands: status.supportedCommands,
        capabilityHash: status.capabilitiesHash,
        sourceKind: 'fabric-bridge:probe:getStatus',
      })
    }
    catch {
      // Ignore capability probe failures and fall back to current session state.
    }
    await this.pathfinder.probeMovementCapabilities()
    return this.getBridgeDebugState()
  }

  private async runSpawnHooks(): Promise<void> {
    if (!this.ready || this.pluginSpawnHooksRan) {
      return
    }

    this.pluginSpawnHooksRan = true

    try {
      for (const plugin of this.options.plugins || []) {
        if (plugin.spawned) {
          await plugin.spawned(this as any)
        }
      }
    }
    catch (error) {
      this.pluginSpawnHooksRan = false
      this.logger.error(`Failed to run FabricBridge spawn hooks: ${error}`)
      throw error
    }
  }

  private async refreshConnectionState(context: 'initial' | 'reconnected'): Promise<void> {
    if (this.readyStatusRefreshInFlight) {
      return
    }

    this.readyStatusRefreshInFlight = true

    try {
      const status = await this.wsClient.request<{
        connected: boolean
        username?: string
        bridgeVersion?: string
        bridgeBuildTimestamp?: string
        supportedCommands?: string[]
        capabilitiesHash?: string
      }>('getStatus', {})

      this.bridgeVersion = status.bridgeVersion ?? null
      this.bridgeBuildTimestamp = status.bridgeBuildTimestamp ?? null
      this.bot.applyBridgeCapabilitySnapshot({
        supportedCommands: status.supportedCommands,
        capabilityHash: status.capabilitiesHash,
        sourceKind: `fabric-bridge:${context}:getStatus`,
      })

      if (status.username) {
        this.username = status.username
        this.bot.entity.username = status.username
      }

      if (!status.connected) {
        this.ready = false
        this.startReadyStatusPolling()
        this.logger.log('Mod connected but player not in world yet, waiting for spawn...')
        return
      }

      this.ready = true
      this.stopReadyStatusPolling()
      const buildSuffix = [
        status.bridgeVersion ? `version=${status.bridgeVersion}` : null,
        status.bridgeBuildTimestamp ? `build=${status.bridgeBuildTimestamp}` : null,
      ].filter(Boolean).join(' ')
      const logPrefix = context === 'reconnected' ? 'Bridge reconnected' : 'Bridge ready'
      this.logger.log(`${logPrefix}, player: ${status.username}${buildSuffix ? ` (${buildSuffix})` : ''}`)

      if (!status.bridgeVersion || !status.bridgeBuildTimestamp) {
        this.logger.warn('Bridge did not report build metadata. The Minecraft client may still be running an older Fabric mod build and could require a restart.')
      }
      else if (hasLikelyNewerInstalledBridgeBuild(status.bridgeVersion, status.bridgeBuildTimestamp)) {
        this.logger.warn('Installed airi-mcbridge jar appears newer than the running Fabric mod build. Minecraft likely needs a full restart to load the updated bridge.')
      }

      this.bot.scanNearbyBlocks(32).catch(() => {})

      if (this.pluginsInitialized) {
        void this.runSpawnHooks()
      }
    }
    catch (err) {
      this.ready = false
      if (this.wsClient.connected) {
        this.startReadyStatusPolling()
      }
      const logPrefix = context === 'reconnected'
        ? 'Failed to refresh bridge status after reconnect'
        : 'Failed to get initial status'
      this.logger.error(`${logPrefix}: ${err}`)
    }
    finally {
      this.readyStatusRefreshInFlight = false
    }
  }

  private startReadyStatusPolling(): void {
    if (this.ready || this.readyStatusPollTimer || !this.wsClient.connected) {
      return
    }

    this.readyStatusPollTimer = setInterval(() => {
      if (this.ready || !this.wsClient.connected) {
        this.stopReadyStatusPolling()
        return
      }

      void this.refreshConnectionState('reconnected')
    }, FabricBridge.READY_STATUS_POLL_INTERVAL_MS)
  }

  private stopReadyStatusPolling(): void {
    if (!this.readyStatusPollTimer) {
      return
    }

    clearInterval(this.readyStatusPollTimer)
    this.readyStatusPollTimer = null
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private updateStatus() {
    if (!this.ready)
      return

    const pos = this.bot.entity.position
    const time = this.bot.time.timeOfDay
    const timeLabel = time < 6000 ? 'Morning' : time < 12000 ? 'Afternoon' : 'Night'

    this.status.position = `x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`
    this.status.health = `${Math.round(this.bot.health)} / 20`
    this.status.weather = 'Clear' // Updated via events
    this.status.timeOfDay = timeLabel

    this.isCreative = this.bot.game.gameMode === 'creative'
  }

  private handleChatCommand(sender: string, message: string) {
    if (sender === this.username)
      return
    if (!message.startsWith('#'))
      return

    const parts = message.slice(1).split(' ')
    const command = parts[0]
    const args = parts.slice(1)

    this.logger.log(`Command from ${sender}: ${command} ${args.join(' ')}`)

    const handler = this.commands.get(command)
    if (handler) {
      handler({ time: this.bot.time.timeOfDay, command: { sender, isCommand: true, command, args } })
      return
    }

    if (command === 'help') {
      const commandList = Array.from(this.commands.keys()).concat(['help'])
      this.bot.chat(`Available commands: ${commandList.map(cmd => `#${cmd}`).join(', ')}`)
    }
    else {
      this.bot.chat(`Unknown command: ${command}`)
    }
  }
}

// Re-export utilities
export { BotProxy, Vec3Simple } from './bot-proxy'
export { BaritonePathfinder, GoalBlock, GoalFollow, GoalGetToBlock, GoalInvert, GoalNear, GoalXZ, Movements } from './pathfinder'
export type * from './types'
export { WsClient } from './ws-client'
