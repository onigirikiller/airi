import type { Mineflayer } from '../libs/mineflayer'
import type { MineflayerPlugin } from '../libs/mineflayer/plugin'

import { sleep } from '@moeru/std'

import { getItemCount } from '../skills/actions/inventory'
import { recordDeathPosition, recoverAfterDeath } from '../skills/recovery'
import { getPosition } from '../skills/world'
import { useLogger } from '../utils/logger'
import { determinePhase, executePhase, recoverTowardSurface, survivalCheck } from './phases'
import { GamePhase, GameStateManager } from './state'

const logger = useLogger()

const PHASE_STEP_DELAY_MS = 2_000
const SURVIVAL_CHECK_INTERVAL_MS = 10_000
const STUCK_RECOVERY_THRESHOLD = 3
const NO_PROGRESS_RECOVERY_THRESHOLD = 3
const MAX_PHASE_ATTEMPTS = 50
const MAX_DEATH_RECOVERY_ATTEMPTS = 3
const EXTERNAL_BLOCK_BACKOFF_MS = 30_000
const EXTERNAL_RESTART_REQUIRED_BACKOFF_MS = 5 * 60_000
const TRANSIENT_BRIDGE_BACKOFF_MS = 15_000
const activeRunnerRegistry = ((globalThis as any).__airiMinecraftRunnerRegistry
  ?? ((globalThis as any).__airiMinecraftRunnerRegistry = new Map<string, GameRunner>())) as Map<string, GameRunner>

export function isBridgeCapabilityBlockedFailure(message: string): boolean {
  return message.startsWith('Bridge capability blocked submerged escape:')
    || message.startsWith('Bridge capability blocked craft sync:')
}

function isCraftSyncBlockedFailure(message: string | null | undefined): boolean {
  return (message ?? '').startsWith('Bridge capability blocked craft sync:')
}

export function isTransientFabricDisconnectFailure(message: string | null | undefined): boolean {
  const normalized = (message ?? '').toLowerCase()
  return normalized === 'not connected to fabric mod'
    || normalized === 'connection closed'
    || normalized.startsWith('bridge connection temporarily unavailable:')
}

function getExternalBlockBackoffMs(message: string): number {
  if (isTransientFabricDisconnectFailure(message)) {
    return TRANSIENT_BRIDGE_BACKOFF_MS
  }
  if (message.includes('bridge underwater relocation support unavailable')) {
    return EXTERNAL_RESTART_REQUIRED_BACKOFF_MS
  }
  if (message.includes('craft sync')) {
    return EXTERNAL_RESTART_REQUIRED_BACKOFF_MS
  }

  return EXTERNAL_BLOCK_BACKOFF_MS
}

function getRunnerBridgeDebugState(bot: Mineflayer): Record<string, unknown> | null {
  const bridgeStateGetter = (bot as any).getBridgeDebugState
    ?? (bot.bot as any)?.getBridgeDebugState
  if (typeof bridgeStateGetter !== 'function') {
    return null
  }

  try {
    const receiver = typeof (bot as any).getBridgeDebugState === 'function'
      ? bot
      : bot.bot
    return bridgeStateGetter.call(receiver) as Record<string, unknown>
  }
  catch {
    return null
  }
}

export function getActiveGameRunner(username: string): GameRunner | null {
  return activeRunnerRegistry.get(username) ?? null
}

export function registerActiveGameRunner(username: string, runner: GameRunner): void {
  activeRunnerRegistry.set(username, runner)
}

export function unregisterActiveGameRunner(username: string): void {
  activeRunnerRegistry.delete(username)
}

export function buildRunnerProgressFingerprint(bot: Mineflayer, state: GameStateManager): string {
  const position = getPosition(bot)

  return JSON.stringify({
    phase: state.phase,
    dimension: bot.bot.game.dimension,
    x: Math.floor(position.x / 8),
    y: Math.floor(position.y / 4),
    z: Math.floor(position.z / 8),
    milestones: {
      logs: getItemCount(bot, 'log'),
      planks: getItemCount(bot, 'planks'),
      craftingTable: getItemCount(bot, 'crafting_table'),
      pickaxes: getItemCount(bot, 'pickaxe'),
      cobblestone: getItemCount(bot, 'cobblestone'),
      furnace: getItemCount(bot, 'furnace'),
      torches: getItemCount(bot, 'torch'),
      coal: getItemCount(bot, 'coal'),
      ironOre: getItemCount(bot, 'iron_ore'),
      ironIngots: getItemCount(bot, 'iron_ingot'),
      bow: getItemCount(bot, 'bow'),
      arrows: getItemCount(bot, 'arrow'),
      blazeRods: getItemCount(bot, 'blaze_rod'),
      enderPearls: getItemCount(bot, 'ender_pearl'),
      enderEyes: getItemCount(bot, 'ender_eye'),
      diamonds: getItemCount(bot, 'diamond'),
      obsidian: getItemCount(bot, 'obsidian'),
      food: getItemCount(bot, 'cooked_')
        + getItemCount(bot, 'bread')
        + getItemCount(bot, 'beef')
        + getItemCount(bot, 'porkchop')
        + getItemCount(bot, 'chicken'),
    },
  })
}

export function shouldAdvanceOnAttemptLimit(currentPhase: GamePhase, detectedPhase: GamePhase): boolean {
  const phaseOrder = Object.values(GamePhase)
  return phaseOrder.indexOf(detectedPhase) > phaseOrder.indexOf(currentPhase)
}

export interface RunnerStepResult {
  phase: GamePhase
  phaseStep: number
  success: boolean
  advance: boolean
  completed: boolean
  message: string
  blockedReason: string | null
}

export class GameRunner {
  private bot: Mineflayer
  private state: GameStateManager
  private running = false
  private paused = false
  private initialized = false
  private deathListenerAttached = false
  private lastSurvivalCheck = 0
  private lastAnnouncedPhase = ''
  private lastProgressFingerprint = ''
  private noProgressStreak = 0
  private pendingDeathRecovery: ReturnType<typeof recordDeathPosition> | null = null
  private deathRecoveryAttempts = 0
  private deathEventCount = 0
  private externalBlockReason: string | null = null
  private externalBlockUntil = 0

  private readonly handleDeath = () => {
    logger.warn('Bot died!')
    this.queueDeathRecovery()
  }

  constructor(bot: Mineflayer) {
    this.bot = bot
    this.state = new GameStateManager(bot.username)
  }

  async start(): Promise<void> {
    if (this.running)
      return
    this.running = true

    await this.ensureInitialized({ announceStart: true })

    while (this.running) {
      const step = await this.stepCore()
      if (step.completed) {
        break
      }
    }
  }

  public async stepOnce(options: { announceStart?: boolean } = {}): Promise<RunnerStepResult> {
    await this.ensureInitialized({ announceStart: options.announceStart ?? false })
    return await this.stepCore()
  }

  private async ensureInitialized(options: { announceStart: boolean }): Promise<void> {
    if (this.initialized) {
      return
    }
    this.initialized = true

    logger.withFields({
      phase: this.state.phase,
      elapsed: `${this.state.getElapsedMinutes()} min`,
    }).log('Game runner started')

    const startPos = getPosition(this.bot)
    this.state.primePosition(startPos.x, startPos.y, startPos.z)

    if (options.announceStart) {
      this.bot.bot.chat(`[AI] Starting autonomous play! Current phase: ${this.state.phase}`)
    }

    if (!this.deathListenerAttached) {
      this.bot.bot.on('death', this.handleDeath)
      this.deathListenerAttached = true
    }

    this.syncMissedDeathRecovery()
  }

  private async stepCore(): Promise<RunnerStepResult> {
    try {
      this.syncMissedDeathRecovery()

      if (this.state.phase === GamePhase.VICTORY) {
        this.running = false
        return {
          phase: this.state.phase,
          phaseStep: this.state.phaseStep,
          success: true,
          advance: false,
          completed: true,
          message: 'The Ender Dragon has already been defeated.',
          blockedReason: this.externalBlockReason,
        }
      }

      if (this.paused) {
        await sleep(1000)
        return {
          phase: this.state.phase,
          phaseStep: this.state.phaseStep,
          success: true,
          advance: false,
          completed: false,
          message: 'Runner is paused.',
          blockedReason: this.externalBlockReason,
        }
      }

      if (this.pendingDeathRecovery) {
        const recovered = await this.tryRecoverFromDeath()
        if (!recovered) {
          await sleep(3000)
        }
        return {
          phase: this.state.phase,
          phaseStep: this.state.phaseStep,
          success: recovered,
          advance: false,
          completed: false,
          message: recovered ? 'Recovered from death.' : 'Death recovery still in progress.',
          blockedReason: this.externalBlockReason,
        }
      }

      if (this.externalBlockReason) {
        if (this.isExternalBlockResolved()) {
          logger.withFields({ reason: this.externalBlockReason }).log('Runner external block cleared')
          this.externalBlockReason = null
          this.externalBlockUntil = 0
        }
        else if (Date.now() < this.externalBlockUntil) {
          await sleep(1000)
          return {
            phase: this.state.phase,
            phaseStep: this.state.phaseStep,
            success: false,
            advance: false,
            completed: false,
            message: this.externalBlockReason,
            blockedReason: this.externalBlockReason,
          }
        }
      }

      const now = Date.now()
      if (now - this.lastSurvivalCheck > SURVIVAL_CHECK_INTERVAL_MS) {
        await survivalCheck(this.bot)
        this.lastSurvivalCheck = now
      }

      const pos = getPosition(this.bot)
      const isStuck = this.state.updatePosition(pos.x, pos.y, pos.z)
      if (isStuck) {
        this.state.recordStuck()
        const stuckCount = this.state.current.stuckCount
        logger.warn(`Bot appears stuck (count: ${stuckCount})`)
        this.bot.bot.chat(`[AI] Seems stuck (${stuckCount}x), trying to recover...`)

        const surfaced = await recoverTowardSurface(
          this.bot,
          stuckCount >= STUCK_RECOVERY_THRESHOLD ? 'stuck-escalated' : 'stuck',
        )
        if (!surfaced) {
          const { moveAway: moveAwaySkill } = await import('../skills/movement')
          if (stuckCount >= STUCK_RECOVERY_THRESHOLD) {
            await moveAwaySkill(this.bot, 80)
            this.state.resetStep()
          }
          else {
            await moveAwaySkill(this.bot, 20)
          }
        }
        else if (stuckCount >= STUCK_RECOVERY_THRESHOLD) {
          this.state.resetStep()
        }
      }

      const detectedPhase = determinePhase(this.bot, this.state)
      if (detectedPhase !== this.state.phase) {
        const phaseOrder = Object.values(GamePhase)
        const currentIdx = phaseOrder.indexOf(this.state.phase)
        const detectedIdx = phaseOrder.indexOf(detectedPhase)
        if (detectedIdx > currentIdx) {
          logger.withFields({
            from: this.state.phase,
            to: detectedPhase,
          }).log('Phase auto-advance based on inventory')
          this.state.setPhase(detectedPhase)
        }
      }

      if (this.state.getAttempts() > MAX_PHASE_ATTEMPTS) {
        if (shouldAdvanceOnAttemptLimit(this.state.phase, detectedPhase)) {
          logger.withFields({
            phase: this.state.phase,
            detectedPhase,
          }).warn('Max attempts reached, auto-advancing only because inventory/world state proves progress')
          this.bot.bot.chat(`[AI] ${this.state.phase} looks complete from current inventory. Advancing to ${detectedPhase}.`)
          this.state.setPhase(detectedPhase)
        }
        else {
          logger.withFields({
            phase: this.state.phase,
            detectedPhase,
          }).warn('Max attempts reached without satisfying phase prerequisites, forcing recovery instead of advancing')
          this.bot.bot.chat(`[AI] ${this.state.phase} is still incomplete. Forcing a stronger recovery instead of skipping ahead.`)
          const surfaced = await recoverTowardSurface(this.bot, 'attempt-limit')
          if (!surfaced) {
            const { moveAway: moveAwaySkill } = await import('../skills/movement')
            await moveAwaySkill(this.bot, 192)
          }
          this.state.resetStep()
          this.state.resetAttempts()
          this.lastProgressFingerprint = ''
          this.noProgressStreak = 0
        }
        await sleep(PHASE_STEP_DELAY_MS)
        return {
          phase: this.state.phase,
          phaseStep: this.state.phaseStep,
          success: true,
          advance: false,
          completed: false,
          message: 'Runner recovered after attempt limit.',
          blockedReason: this.externalBlockReason,
        }
      }

      if (this.lastAnnouncedPhase !== this.state.phase) {
        this.lastAnnouncedPhase = this.state.phase
        this.bot.bot.chat(`[AI] Phase: ${this.state.phase}`)
      }

      const phaseBeforeExecution = this.state.phase
      const deathEventCountBeforePhase = this.deathEventCount
      const result = await executePhase(this.bot, this.state)
      if (this.pendingDeathRecovery
        || this.deathEventCount !== deathEventCountBeforePhase
        || this.bot.bot.health <= 0) {
        logger.warn('Death interrupted the current phase step; deferring progress handling until recovery completes')
        this.state.save()
        return {
          phase: this.state.phase,
          phaseStep: this.state.phaseStep,
          success: false,
          advance: false,
          completed: false,
          message: 'Death interrupted current phase step.',
          blockedReason: this.externalBlockReason,
        }
      }
      this.state.incrementAttempts()

      logger.withFields({
        phase: this.state.phase,
        success: result.success,
        message: result.message,
        advance: result.advance,
      }).log('Phase step completed')

      if (result.advance) {
        this.lastProgressFingerprint = ''
        this.noProgressStreak = 0
        this.externalBlockReason = null
        this.externalBlockUntil = 0
        advanceToNextPhase(this.state)
      }
      else {
        const progressFingerprint = buildRunnerProgressFingerprint(this.bot, this.state)
        if (progressFingerprint === this.lastProgressFingerprint) {
          this.noProgressStreak++
        }
        else {
          this.lastProgressFingerprint = progressFingerprint
          this.noProgressStreak = 1
        }

        if (this.noProgressStreak >= NO_PROGRESS_RECOVERY_THRESHOLD) {
          logger.withFields({
            noProgressStreak: this.noProgressStreak,
            phase: this.state.phase,
            result: result.message,
          }).warn('No-progress streak exceeded, forcing a stronger relocation recovery')
          const surfaced = await recoverTowardSurface(this.bot, 'no-progress')
          if (!surfaced) {
            const { moveAway: moveAwaySkill } = await import('../skills/movement')
            await moveAwaySkill(this.bot, 160)
          }
          this.state.resetStep()
          this.lastProgressFingerprint = ''
          this.noProgressStreak = 0
        }
      }

      if (!result.success) {
        this.state.recordFailedTask(`${this.state.phase}:${this.state.phaseStep}`)
        if (isBridgeCapabilityBlockedFailure(result.message)) {
          const backoffMs = getExternalBlockBackoffMs(result.message)
          this.externalBlockReason = result.message
          this.externalBlockUntil = Date.now() + backoffMs
          logger.withFields({
            reason: result.message,
            backoffMs,
          }).warn('Runner entered external-block backoff')
        }
      }

      this.state.save()

      if (this.state.current.phase === GamePhase.VICTORY) {
        this.bot.bot.chat('[AI] VICTORY! The Ender Dragon has been defeated!')
        logger.log('=== ENDER DRAGON DEFEATED ===')
        this.running = false
        return {
          phase: this.state.phase,
          phaseStep: this.state.phaseStep,
          success: true,
          advance: false,
          completed: true,
          message: 'The Ender Dragon has been defeated!',
          blockedReason: this.externalBlockReason,
        }
      }

      await sleep(PHASE_STEP_DELAY_MS)

      return {
        phase: this.state.phase,
        phaseStep: this.state.phaseStep,
        success: result.success,
        advance: result.advance || this.state.phase !== phaseBeforeExecution,
        completed: false,
        message: result.message,
        blockedReason: this.externalBlockReason,
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      if (isTransientFabricDisconnectFailure(message)) {
        const backoffMs = getExternalBlockBackoffMs(message)
        this.externalBlockReason = `Bridge connection temporarily unavailable: ${message}`
        this.externalBlockUntil = Date.now() + backoffMs
        logger.withFields({
          reason: this.externalBlockReason,
          backoffMs,
        }).warn('Runner entered transient bridge backoff')
        await sleep(1000)
        return {
          phase: this.state.phase,
          phaseStep: this.state.phaseStep,
          success: false,
          advance: false,
          completed: false,
          message: this.externalBlockReason,
          blockedReason: this.externalBlockReason,
        }
      }

      logger.withError(err).error('Error in game loop')
      this.bot.bot.chat(`[AI] Error: ${message.slice(0, 50)}`)
      await sleep(5000)
      return {
        phase: this.state.phase,
        phaseStep: this.state.phaseStep,
        success: false,
        advance: false,
        completed: false,
        message,
        blockedReason: this.externalBlockReason,
      }
    }
  }

  stop(): void {
    this.running = false
    if (this.deathListenerAttached) {
      this.bot.bot.off('death', this.handleDeath)
      this.deathListenerAttached = false
    }
    this.initialized = false
    logger.log('Game runner stopped')
  }

  pause(): void {
    this.paused = true
    this.bot.bot.chat('[AI] Paused')
  }

  resume(): void {
    this.paused = false
    this.bot.bot.chat('[AI] Resumed')
  }

  getStatus(): { phase: string, elapsed: string, deaths: number } {
    return {
      phase: this.state.phase,
      elapsed: `${this.state.getElapsedMinutes()} min`,
      deaths: this.state.current.deathCount,
    }
  }

  getDebugState(): {
    phase: string
    phaseStep: number
    attempts: number
    deaths: number
    noProgressStreak: number
    paused: boolean
    pendingDeathRecovery: boolean
    blockedReason: string | null
    blockedMsRemaining: number
  } {
    return {
      phase: this.state.phase,
      phaseStep: this.state.phaseStep,
      attempts: this.state.getAttempts(),
      deaths: this.state.current.deathCount,
      noProgressStreak: this.noProgressStreak,
      paused: this.paused,
      pendingDeathRecovery: Boolean(this.pendingDeathRecovery),
      blockedReason: this.externalBlockReason,
      blockedMsRemaining: Math.max(0, this.externalBlockUntil - Date.now()),
    }
  }

  resetProgress(): void {
    this.state.reset()
    this.bot.bot.chat('[AI] Progress reset!')
  }

  private async tryRecoverFromDeath(): Promise<boolean> {
    if (!this.pendingDeathRecovery) {
      return true
    }

    this.deathRecoveryAttempts++
    logger.withFields({
      attempt: this.deathRecoveryAttempts,
      deathPos: this.pendingDeathRecovery,
    }).warn('Attempting death recovery')

    const recovered = await recoverAfterDeath(this.bot, this.pendingDeathRecovery)
    if (recovered) {
      this.bot.bot.chat('[AI] Recovered after death and returned toward my last location.')
      this.pendingDeathRecovery = null
      this.deathRecoveryAttempts = 0
      this.state.resetStep()
      return true
    }

    if (this.deathRecoveryAttempts >= MAX_DEATH_RECOVERY_ATTEMPTS) {
      logger.withFields({
        attempt: this.deathRecoveryAttempts,
        phase: this.state.phase,
      }).warn('Death recovery exhausted, resetting current phase step')
      this.bot.bot.chat('[AI] Could not recover my items after death. Rebuilding from current phase.')
      this.pendingDeathRecovery = null
      this.deathRecoveryAttempts = 0
      this.state.resetStep()
      return false
    }

    return false
  }

  private queueDeathRecovery(): void {
    this.haltActiveControlsForDeathRecovery()
    this.state.recordDeath()
    this.pendingDeathRecovery = recordDeathPosition(this.bot)
    this.deathRecoveryAttempts = 0
    this.deathEventCount++
    this.bot.bot.chat(`[AI] I died! (deaths: ${this.state.current.deathCount})`)
  }

  private syncMissedDeathRecovery(): void {
    const health = this.bot.bot.health
    if (this.pendingDeathRecovery || typeof health !== 'number' || !Number.isFinite(health) || health > 0) {
      return
    }

    logger.warn('Bot is already dead before the runner observed a death event; queuing recovery from current snapshot')
    this.queueDeathRecovery()
  }

  private haltActiveControlsForDeathRecovery(): void {
    const bot = this.bot.bot as any

    try {
      bot.pathfinder?.stop?.()
    }
    catch {}

    try {
      bot.clearControlStates?.()
    }
    catch {}

    try {
      bot.pvp?.stop?.()
    }
    catch {}

    try {
      void bot.stopUseItem?.()
    }
    catch {}
  }

  private isExternalBlockResolved(): boolean {
    if (isTransientFabricDisconnectFailure(this.externalBlockReason)) {
      const bridgeState = getRunnerBridgeDebugState(this.bot)
      return bridgeState?.connected === true
    }

    if (isCraftSyncBlockedFailure(this.externalBlockReason)) {
      return false
    }

    const bridgeState = getRunnerBridgeDebugState(this.bot)
    if (!bridgeState) {
      return false
    }

    const metadataMissing = bridgeState.bridgeVersion == null || bridgeState.bridgeBuildTimestamp == null
    if (metadataMissing) {
      return false
    }

    const pathfinderState = bridgeState?.pathfinder as
      | { remoteMovementSupport?: string, baritoneAvailability?: string }
      | undefined

    return pathfinderState?.remoteMovementSupport !== 'unsupported'
      || pathfinderState?.baritoneAvailability !== 'unavailable'
  }
}

function advanceToNextPhase(state: GameStateManager): void {
  const phases = Object.values(GamePhase)
  const currentIdx = phases.indexOf(state.phase)
  if (currentIdx < phases.length - 1) {
    state.setPhase(phases[currentIdx + 1])
  }
}

// Plugin wrapper for use in main.ts
export function GameRunnerPlugin(): MineflayerPlugin {
  let runner: GameRunner | null = null

  return {
    async spawned(mineflayer) {
      runner = new GameRunner(mineflayer)
      ;(mineflayer as any).__gameRunner = runner
      ;(mineflayer.bot as any).__gameRunner = runner
      registerActiveGameRunner(mineflayer.username, runner)

      // Listen for chat commands
      mineflayer.bot.on('chat', (username, message) => {
        if (username === mineflayer.username)
          return

        const cmd = message.trim().toLowerCase()
        if (cmd === '!status') {
          const status = runner?.getStatus()
          if (status) {
            mineflayer.bot.chat(`Phase: ${status.phase} | Time: ${status.elapsed} | Deaths: ${status.deaths}`)
          }
        }
        else if (cmd === '!pause') {
          runner?.pause()
        }
        else if (cmd === '!resume') {
          runner?.resume()
        }
        else if (cmd === '!reset') {
          runner?.resetProgress()
        }
      })

      // Start the game runner after a brief delay
      setTimeout(() => {
        runner?.start().catch((err) => {
          logger.withError(err).error('Game runner crashed')
        })
      }, 3000)
    },
    beforeCleanup(mineflayer) {
      // NOTICE: Monitor and debug tooling read the attached runner state to correlate
      // in-world behavior with phase logic. Clear it during cleanup so stale state is not exposed.
      delete (mineflayer as any).__gameRunner
      delete (mineflayer.bot as any).__gameRunner
      unregisterActiveGameRunner(mineflayer.username)
      runner?.stop()
      runner = null
    },
  }
}
