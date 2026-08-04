/**
 * Baritone-backed pathfinder adapter with simple walk-toward fallback.
 * Provides mineflayer-pathfinder compatible API, routes through Fabric mod WebSocket.
 */

import type { WsClient } from './ws-client'

import { useLogg } from '@guiiai/logg'

import { Vec3Simple } from './bot-proxy'

/**
 * Goal-compatible interfaces matching mineflayer-pathfinder goals.
 */
export interface GoalLike {
  x?: number
  y?: number
  z?: number
  range?: number
  rangeSq?: number
  timeoutMs?: number
  movementMode?: 'walk' | 'swim'
}

export class GoalBlock implements GoalLike {
  constructor(public x: number, public y: number, public z: number) {}
}

export class GoalNear implements GoalLike {
  constructor(public x: number, public y: number, public z: number, public range: number) {}
}

export class GoalXZ implements GoalLike {
  constructor(public x: number, public z: number) {}
}

export class GoalFollow implements GoalLike {
  public x: number
  public y: number
  public z: number

  constructor(entity: { position: Vec3Simple }, public range: number) {
    this.x = entity.position.x
    this.y = entity.position.y
    this.z = entity.position.z
  }
}

export class GoalGetToBlock implements GoalLike {
  constructor(public x: number, public y: number, public z: number) {}
}

export class GoalInvert implements GoalLike {
  constructor(public goal: GoalLike) {}
  get x() { return this.goal.x }
  get y() { return this.goal.y }
  get z() { return this.goal.z }
  get range() { return this.goal.range }
}

/**
 * Movements stub - Baritone handles this internally.
 */
export class Movements {
  canDig: boolean = true
  allow1by1towers: boolean = true
  allowSprinting: boolean = true
  allowParkour: boolean = true
  scafoldingBlocks: number[] = []
  blocksToAvoid: Set<number> = new Set()
  maxDropDown: number = 4

  constructor(_mcDataOrBot?: unknown, _bot?: unknown) {}
}

/** Position getter function type */
type PositionGetter = () => Vec3Simple

interface GotoResponse {
  status: string
  method?: string
  message?: string
}

interface BaritoneStatusResponse {
  available: boolean
  isPathing: boolean
  isActive: boolean
}

/**
 * Pathfinder adapter that wraps Baritone via the Fabric mod WebSocket.
 * Falls back to simple walk-toward movement when Baritone is not installed.
 */
export class BaritonePathfinder {
  private static readonly LOOK_ASSIST_INTERVAL_MS = 150
  private static readonly LOOK_ASSIST_MIN_DELTA = 0.02
  private static readonly LOOK_ASSIST_MIN_GOAL_DISTANCE = 0.35
  private static readonly LOOK_ASSIST_MIN_ANGLE_DELTA_DEGREES = 2
  private static readonly LOOK_ASSIST_MAX_YAW_STEP_DEGREES = 24
  private static readonly LOOK_ASSIST_MAX_PITCH_STEP_DEGREES = 16
  private static readonly MIN_PATH_TIMEOUT_MS = 30_000
  private static readonly MAX_PATH_TIMEOUT_MS = 75_000
  private static readonly BASE_PATH_TIMEOUT_MS = 20_000
  private static readonly DISTANCE_TIMEOUT_FACTOR_MS = 500
  private static readonly DEFAULT_NON_GOAL_TIMEOUT_MS = 60_000
  private static readonly MINING_TIMEOUT_MS = 120_000
  private static readonly SWIM_SURFACE_BIAS_BLOCKS = 4
  private static readonly VERTICAL_ASCENT_RECOVERY_ATTEMPTS = 3
  private static readonly VERTICAL_ASCENT_RECOVERY_TIMEOUT_MS = 8_000
  private static readonly VERTICAL_ASCENT_REMOTE_TIMEOUT_MS = 20_000
  private static readonly MIN_CLOSE_RANGE_VERTICAL_ASCENT_TIMEOUT_MS = 30_000
  private static readonly MAX_CLOSE_RANGE_VERTICAL_ASCENT_TIMEOUT_MS = 45_000

  private ws: WsClient
  private moving = false
  private _mining = false
  private interrupted = false
  private logger = useLogg('FabricBridge:Pathfinder').useGlobalConfig()
  private getPosition: PositionGetter
  private lookAssistInterval: ReturnType<typeof setInterval> | undefined
  private lastLookAssistPosition: Vec3Simple | undefined
  private lookAssistGoal: GoalLike | undefined
  private lastSentLook: { yaw: number, pitch: number } | undefined
  private baritoneActive = false
  private remoteMovementSupport: 'unknown' | 'supported' | 'unsupported' = 'unknown'
  private baritoneAvailability: 'unknown' | 'available' | 'unavailable' = 'unknown'
  private lastSwimFallbackReason: string | null = null

  constructor(ws: WsClient, positionGetter: PositionGetter) {
    this.ws = ws
    this.getPosition = positionGetter

    // Listen for path completion events
    ws.on('event', (event) => {
      if (event.type === 'event:pathComplete') {
        this.moving = false
        this._mining = false
      }
    })
  }

  /**
   * Navigate to a goal (blocking until arrival or error).
   */
  async goto(goal: GoalLike): Promise<void> {
    goal = this.normalizeGoal(goal)
    this.moving = true
    this.interrupted = false

    // Handle inverted goals (move AWAY from target)
    // Check by duck-typing since the goal may come from mineflayer-pathfinder's GoalInvert
    if ('goal' in goal && (goal as any).goal) {
      const escaped = await this.simpleWalkAway((goal as any).goal)
      if (!escaped) {
        throw new Error('Failed to move away from goal')
      }
      return
    }

    const x = goal.x ?? 0
    const z = goal.z ?? 0
    const y = goal.y ?? 64
    const range = goal.range
    const position = this.getPosition()
    const horizontalDistance = Math.sqrt((x - position.x) ** 2 + (z - position.z) ** 2)
    const verticalOnlyAscent = horizontalDistance <= 3 && y > position.y + 2
    const swimMode = goal.movementMode === 'swim'
    const effectiveGoal = verticalOnlyAscent && goal.y == null
      ? { ...goal, y }
      : goal

    this.logger.log(`Pathfinding to (${x}, ${y}, ${z})${range != null ? `, range=${range}` : ''}`)

    if (swimMode) {
      this.logger.log('Skipping baritone request for swim relocation and using remote swim controller immediately')
      const capabilityState = await this.probeMovementCapabilities()
      if (capabilityState.remoteMovementSupport === 'unsupported'
        && capabilityState.baritoneAvailability === 'unavailable') {
        throw new Error('Swim relocation unsupported: moveToward unavailable and baritone unavailable')
      }
      const reached = await this.remoteMoveToward(goal)
      if (!reached) {
        throw new Error(`Failed to reach (${x}, ${y}, ${z})`)
      }
      return
    }

    this.startMovementLookAssist(effectiveGoal)

    if (verticalOnlyAscent) {
      const baritoneAvailability = await this.ensureBaritoneAvailability()
      if (baritoneAvailability !== 'available') {
        this.logger.log('Skipping baritone request for local vertical ascent and trying remote walk control before simple walk')
        const reached = await this.tryRemoteWalkVerticalAscent(effectiveGoal)
        if (reached) {
          return
        }
      }
      else {
        this.logger.log('Using baritone for local vertical ascent because baritone is available')
      }
    }

    try {
      // Use gotoNear when range is specified (GoalNear), otherwise goto (GoalBlock)
      const command = range != null ? 'gotoNear' : 'goto'
      const params = range != null ? { x, y, z, range } : { x, y, z }
      const commandTimeoutMs = Math.max(10_000, Math.min(effectiveGoal.timeoutMs ?? 120_000, 120_000))

      const result = await this.ws.request<GotoResponse>(command, params, commandTimeoutMs)

      if (result.status === 'pathfinding' && result.method === 'baritone') {
        // Baritone is handling it, wait for completion
        this.baritoneActive = true
        try {
          await this.waitForPathComplete(effectiveGoal)
        }
        finally {
          this.baritoneActive = false
        }
        const reached = await this.confirmGoalReached(effectiveGoal)
        if (reached) {
          return
        }

        this.logger.log('Baritone reported path completion before the bot actually reached the goal; falling back to simple walk')
      }
      else if (result.status === 'ok') {
        const reached = await this.confirmGoalReached(effectiveGoal)
        if (reached) {
          this.moving = false
          this.stopMovementLookAssist()
          return
        }

        this.logger.log('Pathfinding reported immediate success before the bot reached the goal; falling back to simple walk')
      }
      else {
        // Baritone not installed or other error - use simple walk
        this.logger.log(`Baritone unavailable, using simple walk-toward: ${result.message || result.status}`)
      }
    }
    catch (err) {
      this.logger.log(`goto WebSocket error, falling back to simple walk: ${(err as Error).message}`)
    }

    const reached = verticalOnlyAscent
      ? await this.tryRemoteWalkVerticalAscent(effectiveGoal)
      : await this.remoteMoveToward({
          ...effectiveGoal,
          movementMode: 'walk',
        })
    if (reached) {
      return
    }

    // NOTICE: `moveToward` already falls back to the low-level control loop when the
    // bridge does not support remote walk movement. Only add the extra close-range
    // ascent recovery when the goal genuinely needs a local climb.
    const recovered = verticalOnlyAscent
      ? await this.tryRecoveringVerticalAscent(effectiveGoal)
      : false
    if (recovered) {
      return
    }

    throw new Error(`Failed to reach (${x}, ${y}, ${z})`)
  }

  /**
   * Mine specified block types using Baritone.
   * Falls back silently if Baritone is not installed.
   * @param blockNames registry names like ["diamond_ore", "oak_log"]
   */
  async mine(blockNames: string[]): Promise<boolean> {
    this.logger.log(`Baritone mine request: ${blockNames.join(', ')}`)

    try {
      const result = await this.ws.request<GotoResponse>('baritone_mine', { blockNames }, 10000)

      if (result.status === 'mining' && result.method === 'baritone') {
        this._mining = true
        this.moving = true
        this.baritoneActive = true
        try {
          // Use a longer timeout for mining — baritone mines indefinitely (quantity=0)
          // and needs time to find, path to, and break multiple blocks.
          await this.waitForPathComplete({ timeoutMs: BaritonePathfinder.MINING_TIMEOUT_MS })
        }
        finally {
          this.baritoneActive = false
        }
        return true
      }

      this.logger.log(`Baritone mine unavailable: ${result.message || result.status}`)
      return false
    }
    catch (err) {
      this.logger.log(`Baritone mine error: ${(err as Error).message}`)
      return false
    }
  }

  /**
   * Follow an entity using Baritone.
   * @param entityId the Minecraft entity ID to follow
   */
  async followEntity(entityId: number): Promise<boolean> {
    this.logger.log(`Baritone follow entity: ${entityId}`)

    try {
      const result = await this.ws.request<GotoResponse & { entityName?: string }>(
        'baritone_follow',
        { entityId },
        10000,
      )

      if (result.status === 'following' && result.method === 'baritone') {
        this.moving = true
        this.interrupted = false
        this.startMovementLookAssist()
        return true
      }

      this.logger.log(`Baritone follow unavailable: ${result.message || result.status}`)
      return false
    }
    catch (err) {
      this.logger.log(`Baritone follow error: ${(err as Error).message}`)
      return false
    }
  }

  /**
   * Set goal without blocking.
   */
  setGoal(goal: GoalLike | null, _dynamic?: boolean): void {
    if (!goal) {
      this.ws.send('stopMovement', {})
      this.moving = false
      this.stopMovementLookAssist()
      return
    }

    goal = this.normalizeGoal(goal)
    // For non-blocking goal setting, start walking
    this.moving = true
    this.interrupted = false
    this.startMovementLookAssist(goal)
    this.simpleWalkToward(goal).catch(() => {
      this.moving = false
      this.stopMovementLookAssist()
    })
  }

  setMovements(_movements: Movements): void {
    // Baritone/simple movement manages its own settings
  }

  isMoving(): boolean {
    return this.moving
  }

  isMining(): boolean {
    return this._mining
  }

  isBuilding(): boolean {
    return false
  }

  getDebugState(): {
    remoteMovementSupport: 'unknown' | 'supported' | 'unsupported'
    baritoneAvailability: 'unknown' | 'available' | 'unavailable'
    lastSwimFallbackReason: string | null
  } {
    return {
      remoteMovementSupport: this.remoteMovementSupport,
      baritoneAvailability: this.baritoneAvailability,
      lastSwimFallbackReason: this.lastSwimFallbackReason,
    }
  }

  async probeMovementCapabilities(): Promise<{
    remoteMovementSupport: 'unknown' | 'supported' | 'unsupported'
    baritoneAvailability: 'unknown' | 'available' | 'unavailable'
    lastSwimFallbackReason: string | null
  }> {
    if (this.remoteMovementSupport === 'unknown') {
      const position = this.getPosition()
      try {
        await this.ws.request('moveToward', {
          x: position.x,
          y: position.y,
          z: position.z,
          range: 0,
          movementMode: 'swim',
          timeoutMs: 1000,
        }, 1500)
        this.remoteMovementSupport = 'supported'
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('Unknown command: moveToward')) {
          this.remoteMovementSupport = 'unsupported'
          this.lastSwimFallbackReason = message
        }
      }
      finally {
        this.ws.send('stopMovement', {})
      }
    }

    await this.ensureBaritoneAvailability()

    return this.getDebugState()
  }

  private async ensureBaritoneAvailability(): Promise<'unknown' | 'available' | 'unavailable'> {
    if (this.baritoneAvailability !== 'unknown') {
      return this.baritoneAvailability
    }

    try {
      const status = await this.ws.request<BaritoneStatusResponse>('baritone_status', {}, 3000)
      this.baritoneAvailability = status.available === true ? 'available' : 'unavailable'
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.length > 0) {
        this.baritoneAvailability = 'unavailable'
      }
    }

    return this.baritoneAvailability
  }

  stop(): void {
    this.interrupted = true
    this.ws.send('stopMovement', {})
    this.moving = false
    this._mining = false
    this.stopMovementLookAssist()
  }

  /**
   * getPathTo stub - used by world.ts isClearPath
   */
  async getPathTo(_movements: Movements, _goal: GoalLike, _timeout?: number): Promise<{ status: string }> {
    return { status: 'success' }
  }

  // ─── Simple Walk-Toward (Fallback) ──────────────────────────────────────

  /**
   * Walk toward a target position using look + forward controls.
   * Handles jumping when stuck, and stops when within range.
   */
  private async simpleWalkToward(goal: GoalLike): Promise<boolean> {
    goal = this.normalizeGoal(goal)
    const targetX = goal.x ?? 0
    const targetY = goal.y
    const targetZ = goal.z ?? 0
    const range = goal.range ?? 2
    const verticalRange = targetY == null ? Infinity : Math.max(1.5, range)
    const swimMode = goal.movementMode === 'swim'

    if (swimMode) {
      return this.remoteMoveToward(goal)
    }

    return this.simpleControlWalkToward(goal, {
      targetX,
      targetY,
      targetZ,
      range,
      verticalRange,
      swimMode: false,
    })
  }

  private async simpleControlWalkToward(
    goal: GoalLike,
    config?: {
      targetX?: number
      targetY?: number
      targetZ?: number
      range?: number
      verticalRange?: number
      swimMode?: boolean
    },
  ): Promise<boolean> {
    const targetX = config?.targetX ?? goal.x ?? 0
    const targetY = config?.targetY ?? goal.y
    const targetZ = config?.targetZ ?? goal.z ?? 0
    const range = config?.range ?? goal.range ?? 2
    const swimMode = config?.swimMode ?? goal.movementMode === 'swim'
    const verticalRange = config?.verticalRange ?? (targetY == null ? Infinity : Math.max(swimMode ? 2.5 : 1.5, range))

    let lastPos = this.clonePosition(this.getPosition())
    let stuckTicks = 0
    let reached = false
    const MAX_TICKS = this.getMovementTickBudget(goal.timeoutMs)
    const STUCK_THRESHOLD = 0.1 // blocks moved per tick to not be "stuck"
    const STUCK_JUMP_AFTER = 5 // ticks of being stuck before jumping
    const STUCK_GIVE_UP_AFTER = swimMode ? STUCK_JUMP_AFTER * 8 : STUCK_JUMP_AFTER * 4

    this.logger.log(`Simple walk to (${targetX.toFixed(1)}, ${targetZ.toFixed(1)}), range=${range}, mode=${swimMode ? 'swim' : 'walk'}`)
    this.sendImmediateLookToward(targetX, targetZ)

    try {
      for (let tick = 0; tick < MAX_TICKS; tick++) {
        if (this.interrupted) {
          this.logger.log('Walk interrupted')
          return false
        }

        const pos = this.getPosition()
        const dx = targetX - pos.x
        const dy = targetY == null ? 0 : targetY - pos.y
        const dz = targetZ - pos.z
        const dist = Math.sqrt(dx * dx + dz * dz)
        const verticalDist = Math.abs(dy)
        const yaw = Math.atan2(-dx, dz) * 180 / Math.PI
        const swimPitch = this.getSwimPitch(targetY, pos.y, dy, dist)

        // Check if arrived
        if (dist <= range && verticalDist <= verticalRange) {
          this.logger.log(`Arrived at target (dist=${dist.toFixed(1)}, vertical=${verticalDist.toFixed(1)})`)
          reached = true
          break
        }

        if (swimMode) {
          this.sendSmoothedLook(yaw, swimPitch)
        }

        // Set movement controls
        this.ws.send('setControlState', { control: 'forward', state: true })
        this.ws.send('setControlState', { control: 'sprint', state: swimMode || dist > 10 })
        this.ws.send('setControlState', {
          control: 'jump',
          state: swimMode || (targetY != null && (targetY - pos.y) > 1),
        })

        // Check if stuck
        const moved = Math.sqrt(
          (pos.x - lastPos.x) ** 2 + (pos.y - lastPos.y) ** 2 + (pos.z - lastPos.z) ** 2,
        )

        if (moved < STUCK_THRESHOLD) {
          stuckTicks++
          if (stuckTicks >= STUCK_JUMP_AFTER) {
            if (swimMode) {
              this.sendSmoothedLook(yaw, stuckTicks >= (STUCK_JUMP_AFTER * 3) ? -50 : -35)
              const strafeControl = Math.floor(stuckTicks / STUCK_JUMP_AFTER) % 2 === 0 ? 'left' : 'right'
              this.ws.send('setControlState', { control: strafeControl, state: true })
              this.ws.send('setControlState', { control: 'sprint', state: true })
              await this.sleep(250)
              this.ws.send('setControlState', { control: strafeControl, state: false })
            }
            // Try jumping to get unstuck
            this.ws.send('setControlState', { control: 'jump', state: true })
            await this.sleep(150)
            this.ws.send('setControlState', {
              control: 'jump',
              state: swimMode || (targetY != null && (targetY - pos.y) > 1),
            })

            if (stuckTicks >= STUCK_GIVE_UP_AFTER) {
              // Really stuck, give up
              this.logger.log(`Stuck for too long, giving up (dist=${dist.toFixed(1)})`)
              return false
            }
          }
        }
        else {
          stuckTicks = 0
        }

        lastPos = this.clonePosition(pos)
        await this.sleep(100)
      }
    }
    finally {
      // Stop all movement
      this.ws.send('setControlState', { control: 'forward', state: false })
      this.ws.send('setControlState', { control: 'left', state: false })
      this.ws.send('setControlState', { control: 'right', state: false })
      this.ws.send('setControlState', { control: 'sprint', state: false })
      this.ws.send('setControlState', { control: 'jump', state: false })
      this.moving = false
      this.stopMovementLookAssist()
    }

    return reached
  }

  private async remoteMoveToward(goal: GoalLike): Promise<boolean> {
    goal = this.normalizeGoal(goal)
    const targetX = goal.x ?? 0
    const targetY = this.getPreferredRemoteTargetY(goal)
    const targetZ = goal.z ?? 0
    const range = goal.range ?? 2
    const verticalRange = Math.max(1.5, range)
    const timeoutMs = goal.timeoutMs ?? BaritonePathfinder.DEFAULT_NON_GOAL_TIMEOUT_MS

    let lastPos = this.clonePosition(this.getPosition())
    let stuckTicks = 0
    let bestHorizontalDist = Math.sqrt(((targetX - lastPos.x) ** 2) + ((targetZ - lastPos.z) ** 2))
    let bestVerticalDist = Math.abs(targetY - lastPos.y)
    let noProgressTicks = 0
    const MAX_TICKS = this.getMovementTickBudget(timeoutMs)
    const STUCK_THRESHOLD = 0.04
    const STUCK_GIVE_UP_AFTER = 120
    const MEANINGFUL_HORIZONTAL_PROGRESS = 0.25
    const MEANINGFUL_VERTICAL_PROGRESS = 0.5
    const NO_PROGRESS_GIVE_UP_AFTER = 120

    this.logger.log(`Remote move to (${targetX.toFixed(1)}, ${targetY.toFixed(1)}, ${targetZ.toFixed(1)}), range=${range}, mode=${goal.movementMode ?? 'walk'}`)

    try {
      await this.ws.request('moveToward', {
        x: targetX,
        y: targetY,
        z: targetZ,
        range,
        movementMode: goal.movementMode ?? 'walk',
        timeoutMs,
      }, 5000)
      this.remoteMovementSupport = 'supported'
      this.lastSwimFallbackReason = null
    }
    catch (error) {
      this.remoteMovementSupport = 'unsupported'
      this.lastSwimFallbackReason = (error as Error).message
      const swimMode = goal.movementMode === 'swim'
      this.logger.log(`Remote movement unavailable, falling back to ${swimMode ? 'swim' : 'walk'} control loop: ${(error as Error).message}`)
      if (swimMode) {
        const baritoneFallbackReached = await this.tryBaritoneSwimFallback(targetX, targetY, targetZ, range)
        if (baritoneFallbackReached) {
          return true
        }
      }
      return this.simpleControlWalkToward(goal, {
        targetX,
        targetY,
        targetZ,
        range,
        verticalRange,
        swimMode,
      })
    }

    try {
      for (let tick = 0; tick < MAX_TICKS; tick++) {
        if (this.interrupted) {
          this.logger.log('Remote movement interrupted')
          return false
        }

        const pos = this.getPosition()
        const dx = targetX - pos.x
        const dy = targetY - pos.y
        const dz = targetZ - pos.z
        const dist = Math.sqrt(dx * dx + dz * dz)
        const verticalDist = Math.abs(dy)

        if (dist <= range && verticalDist <= verticalRange) {
          this.logger.log(`Arrived at remote movement target (dist=${dist.toFixed(1)}, vertical=${verticalDist.toFixed(1)})`)
          return true
        }

        const moved = Math.sqrt(
          (pos.x - lastPos.x) ** 2 + (pos.y - lastPos.y) ** 2 + (pos.z - lastPos.z) ** 2,
        )
        const madeMeaningfulProgress = dist <= (bestHorizontalDist - MEANINGFUL_HORIZONTAL_PROGRESS)
          || verticalDist <= (bestVerticalDist - MEANINGFUL_VERTICAL_PROGRESS)

        if (madeMeaningfulProgress) {
          bestHorizontalDist = Math.min(bestHorizontalDist, dist)
          bestVerticalDist = Math.min(bestVerticalDist, verticalDist)
          noProgressTicks = 0
        }
        else {
          noProgressTicks++
          if (noProgressTicks >= NO_PROGRESS_GIVE_UP_AFTER) {
            this.logger.log(`Remote movement made no meaningful progress, giving up (dist=${dist.toFixed(1)}, vertical=${verticalDist.toFixed(1)})`)
            return false
          }
        }

        if (moved < STUCK_THRESHOLD) {
          stuckTicks++
          if (stuckTicks === 40 || stuckTicks === 80 || noProgressTicks === 40 || noProgressTicks === 80) {
            await this.ws.request('moveToward', {
              x: targetX,
              y: targetY,
              z: targetZ,
              range,
              movementMode: goal.movementMode ?? 'walk',
              timeoutMs,
            }, 5000)
          }
          if (stuckTicks >= STUCK_GIVE_UP_AFTER) {
            this.logger.log(`Remote movement stuck for too long, giving up (dist=${dist.toFixed(1)})`)
            return false
          }
        }
        else {
          stuckTicks = 0
        }

        lastPos = this.clonePosition(pos)
        await this.sleep(100)
      }
    }
    finally {
      this.ws.send('stopMovement', {})
      this.moving = false
      this.stopMovementLookAssist()
    }

    return false
  }

  private async tryRemoteWalkVerticalAscent(goal: GoalLike): Promise<boolean> {
    goal = this.normalizeGoal(goal)
    this.logger.log('Trying remote walk controller for local vertical ascent before simple walk')
    const reached = await this.remoteMoveToward({
      x: goal.x,
      y: goal.y,
      z: goal.z,
      range: goal.range,
      timeoutMs: Math.min(
        goal.timeoutMs ?? BaritonePathfinder.VERTICAL_ASCENT_REMOTE_TIMEOUT_MS,
        BaritonePathfinder.VERTICAL_ASCENT_REMOTE_TIMEOUT_MS,
      ),
      movementMode: 'walk',
    })

    if (!reached) {
      this.logger.log('Remote walk controller could not complete local vertical ascent; falling back to simple walk')
    }

    return reached
  }

  private async tryRecoveringVerticalAscent(goal: GoalLike): Promise<boolean> {
    goal = this.normalizeGoal(goal)
    const maxAttempts = BaritonePathfinder.VERTICAL_ASCENT_RECOVERY_ATTEMPTS

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const startPosition = this.clonePosition(this.getPosition())
      const reached = await this.simpleWalkToward({
        ...goal,
        timeoutMs: goal.timeoutMs ?? BaritonePathfinder.VERTICAL_ASCENT_RECOVERY_TIMEOUT_MS,
      })

      if (reached) {
        return true
      }

      const endPosition = this.clonePosition(this.getPosition())
      const madeVerticalProgress = endPosition.y >= startPosition.y + 0.75
      const horizontalImprovement = this.getHorizontalDistance(goal, startPosition) - this.getHorizontalDistance(goal, endPosition)
      const madeHorizontalProgress = horizontalImprovement >= 0.5

      this.logger.log(
        `Close-range vertical ascent recovery ${attempt + 1}/${maxAttempts} ended at `
        + `(${endPosition.x.toFixed(2)}, ${endPosition.y.toFixed(2)}, ${endPosition.z.toFixed(2)}) `
        + `(verticalProgress=${madeVerticalProgress}, horizontalImprovement=${horizontalImprovement.toFixed(2)})`,
      )

      if (this.isGoalReached(goal, endPosition)) {
        return true
      }

      if (!madeVerticalProgress && !madeHorizontalProgress) {
        break
      }
    }

    return false
  }

  private async tryBaritoneSwimFallback(targetX: number, targetY: number, targetZ: number, range: number): Promise<boolean> {
    try {
      const result = await this.ws.request<GotoResponse>('gotoNear', {
        x: targetX,
        y: targetY,
        z: targetZ,
        range,
      }, 10_000)

      if (result.status === 'pathfinding' && result.method === 'baritone') {
        this.baritoneAvailability = 'available'
        this.logger.log('Remote swim fallback unavailable, retrying movement with baritone gotoNear')
        this.startMovementLookAssist({ x: targetX, y: targetY, z: targetZ, range })
        this.baritoneActive = true
        try {
          await this.waitForPathComplete({ x: targetX, y: targetY, z: targetZ, range })
        }
        finally {
          this.baritoneActive = false
        }
        const reached = await this.confirmGoalReached({ x: targetX, y: targetY, z: targetZ, range })
        if (reached) {
          return true
        }
        this.logger.log('Baritone swim fallback reported path completion before the bot reached the goal')
        return false
      }

      if (result.status === 'ok') {
        this.baritoneAvailability = 'available'
        const reached = await this.confirmGoalReached({ x: targetX, y: targetY, z: targetZ, range })
        if (reached) {
          this.logger.log('Remote swim fallback unavailable, but baritone gotoNear completed immediately')
          return true
        }
        this.logger.log('Remote swim fallback unavailable, and baritone gotoNear returned immediate success without reaching the goal')
        return false
      }

      if ((result.message || '').toLowerCase().includes('not installed')) {
        this.baritoneAvailability = 'unavailable'
      }
      this.logger.log(`Baritone swim fallback unavailable: ${result.message || result.status}`)
    }
    catch (error) {
      if ((error as Error).message.toLowerCase().includes('not installed')) {
        this.baritoneAvailability = 'unavailable'
      }
      this.logger.log(`Baritone swim fallback failed: ${(error as Error).message}`)
    }

    return false
  }

  private getPreferredRemoteTargetY(goal: GoalLike): number {
    const currentY = this.getPosition().y
    if (goal.movementMode !== 'swim') {
      return goal.y ?? currentY
    }

    const requestedY = goal.y ?? currentY
    return Math.max(requestedY, currentY + BaritonePathfinder.SWIM_SURFACE_BIAS_BLOCKS)
  }

  private getSwimPitch(targetY: number | undefined, currentY: number, dy: number, horizontalDistance: number): number {
    if (targetY == null) {
      return -30
    }

    const requestedPitch = -(Math.atan2(dy, Math.max(horizontalDistance, 0.1)) * 180 / Math.PI)
    const needsLift = targetY > currentY + 1
    if (needsLift) {
      return Math.min(requestedPitch, -20)
    }

    return Math.min(requestedPitch, -12)
  }

  private getHorizontalDistance(goal: GoalLike, position = this.getPosition()): number {
    goal = this.normalizeGoal(goal)
    const targetX = goal.x ?? position.x
    const targetZ = goal.z ?? position.z
    return Math.sqrt(((targetX - position.x) ** 2) + ((targetZ - position.z) ** 2))
  }

  private isGoalReached(goal: GoalLike, position = this.getPosition()): boolean {
    goal = this.normalizeGoal(goal)
    const targetY = goal.y
    const range = goal.range ?? 2
    const horizontalDistance = this.getHorizontalDistance(goal, position)
    const verticalDistance = targetY == null ? 0 : Math.abs(targetY - position.y)
    const verticalRange = targetY == null
      ? Infinity
      : Math.max(goal.movementMode === 'swim' ? 2.5 : 1.5, range)

    return horizontalDistance <= range && verticalDistance <= verticalRange
  }

  private async confirmGoalReached(
    goal: GoalLike,
    options?: {
      attempts?: number
      intervalMs?: number
    },
  ): Promise<boolean> {
    const attempts = options?.attempts ?? 6
    const intervalMs = options?.intervalMs ?? 150

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.isGoalReached(goal)) {
        return true
      }

      if (attempt < attempts - 1) {
        await this.sleep(intervalMs)
      }
    }

    return false
  }

  /**
   * Walk AWAY from a target position.
   */
  private async simpleWalkAway(goal: GoalLike): Promise<boolean> {
    goal = this.normalizeGoal(goal)
    const targetX = goal.x ?? 0
    const targetZ = goal.z ?? 0
    const awayDistance = goal.range ?? 16

    const pos = this.getPosition()
    const dx = pos.x - targetX
    const dz = pos.z - targetZ
    const dist = Math.sqrt(dx * dx + dz * dz)

    if (dist >= awayDistance) {
      this.moving = false
      this.stopMovementLookAssist()
      return true
    }

    // Calculate a point away from the target
    const scale = awayDistance / (dist || 1)
    const awayX = targetX + dx * scale
    const awayZ = targetZ + dz * scale

    return await this.simpleWalkToward({
      x: awayX,
      z: awayZ,
      range: 2,
    })
  }

  /**
   * Wait for Baritone path completion with periodic status polling.
   * - Listens for event:pathComplete from the mod
   * - Polls baritone_status every 5s as a deadlock guard
   * - Uses a distance-scaled timeout for movement so long stuck paths fall back sooner
   */
  private waitForPathComplete(goal?: GoalLike): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.getPathTimeoutMs(goal)
      const POLL_INTERVAL_MS = 5_000

      let resolved = false
      let timeout: ReturnType<typeof setTimeout>
      let pollInterval: ReturnType<typeof setInterval>
      let cleanup: () => void

      const onEvent = (event: { type: string }) => {
        if (event.type === 'event:pathComplete') {
          cleanup()
          resolve()
        }
      }

      cleanup = () => {
        if (resolved)
          return
        resolved = true
        clearTimeout(timeout)
        clearInterval(pollInterval)
        this.ws.off('event', onEvent as any)
        this.moving = false
        this._mining = false
        this.stopMovementLookAssist()
      }

      timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Pathfinding timed out (${timeoutMs}ms)`))
      }, timeoutMs)

      this.ws.on('event', onEvent as any)

      // Periodic status poll as deadlock guard
      pollInterval = setInterval(async () => {
        if (resolved)
          return
        try {
          const status = await this.ws.request<BaritoneStatusResponse>('baritone_status', {}, 3000)
          if (!status.isPathing && !status.isActive) {
            // Baritone finished but we missed the event
            cleanup()
            resolve()
          }
        }
        catch {
          // Poll failed, not critical — keep waiting for the event
        }
      }, POLL_INTERVAL_MS)
    })
  }

  // Keep the real client facing its horizontal movement vector without coupling
  // to pathfinding internals. If motion data is too small, fall back to the active goal.
  private startMovementLookAssist(goal?: GoalLike): void {
    this.lookAssistGoal = goal ? this.normalizeGoal(goal) : undefined
    this.lastLookAssistPosition = this.clonePosition(this.getPosition())

    if (this.lookAssistInterval) {
      return
    }

    this.lookAssistInterval = setInterval(() => {
      this.updateMovementLook()
    }, BaritonePathfinder.LOOK_ASSIST_INTERVAL_MS)
  }

  private stopMovementLookAssist(): void {
    if (this.lookAssistInterval) {
      clearInterval(this.lookAssistInterval)
      this.lookAssistInterval = undefined
    }

    this.lookAssistGoal = undefined
    this.lastLookAssistPosition = undefined
    this.lastSentLook = undefined
  }

  private updateMovementLook(): void {
    if (!this.moving || this.interrupted || !this.ws.connected || this.baritoneActive) {
      return
    }

    const currentPosition = this.getPosition()
    const previousPosition = this.lastLookAssistPosition ?? currentPosition

    let dx = currentPosition.x - previousPosition.x
    let dz = currentPosition.z - previousPosition.z
    let horizontalDistance = Math.sqrt(dx * dx + dz * dz)

    if (horizontalDistance < BaritonePathfinder.LOOK_ASSIST_MIN_DELTA) {
      const goal = this.lookAssistGoal
      if (goal?.x == null || goal?.z == null) {
        this.lastLookAssistPosition = this.clonePosition(currentPosition)
        return
      }

      dx = goal.x - currentPosition.x
      dz = goal.z - currentPosition.z
      horizontalDistance = Math.sqrt(dx * dx + dz * dz)
      if (horizontalDistance < BaritonePathfinder.LOOK_ASSIST_MIN_GOAL_DISTANCE) {
        this.lastLookAssistPosition = this.clonePosition(currentPosition)
        return
      }
    }

    const yaw = Math.atan2(-dx, dz) * 180 / Math.PI
    this.sendSmoothedLook(yaw, 0)
    this.lastLookAssistPosition = this.clonePosition(currentPosition)
  }

  private clonePosition(position: Vec3Simple): Vec3Simple {
    return new Vec3Simple(position.x, position.y, position.z)
  }

  private sendImmediateLookToward(targetX: number, targetZ: number): void {
    const position = this.getPosition()
    const dx = targetX - position.x
    const dz = targetZ - position.z
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz)

    if (horizontalDistance < BaritonePathfinder.LOOK_ASSIST_MIN_GOAL_DISTANCE) {
      return
    }

    const yaw = Math.atan2(-dx, dz) * 180 / Math.PI
    this.sendSmoothedLook(yaw, 0)
  }

  private getPathTimeoutMs(goal?: GoalLike): number {
    goal = goal ? this.normalizeGoal(goal) : undefined
    if (goal?.timeoutMs != null) {
      return goal.timeoutMs
    }

    if (goal?.x == null || goal?.z == null) {
      return BaritonePathfinder.DEFAULT_NON_GOAL_TIMEOUT_MS
    }

    const position = this.getPosition()
    const dx = goal.x - position.x
    const dy = (goal.y ?? position.y) - position.y
    const dz = goal.z - position.z
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz)
    const verticalDistance = Math.abs(dy)

    if (horizontalDistance <= 3 && verticalDistance > 2) {
      return Math.min(
        Math.max(
          BaritonePathfinder.BASE_PATH_TIMEOUT_MS + (verticalDistance * 4_000),
          BaritonePathfinder.MIN_CLOSE_RANGE_VERTICAL_ASCENT_TIMEOUT_MS,
        ),
        BaritonePathfinder.MAX_CLOSE_RANGE_VERTICAL_ASCENT_TIMEOUT_MS,
      )
    }

    return Math.min(
      Math.max(
        BaritonePathfinder.BASE_PATH_TIMEOUT_MS + (horizontalDistance * BaritonePathfinder.DISTANCE_TIMEOUT_FACTOR_MS),
        BaritonePathfinder.MIN_PATH_TIMEOUT_MS,
      ),
      BaritonePathfinder.MAX_PATH_TIMEOUT_MS,
    )
  }

  private getMovementTickBudget(timeoutMs?: number): number {
    return Math.max(1, Math.ceil((timeoutMs ?? BaritonePathfinder.DEFAULT_NON_GOAL_TIMEOUT_MS) / 100))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private normalizeGoal(goal: GoalLike): GoalLike {
    const range = this.readGoalRange(goal)
    if (range == null || goal.range === range) {
      return goal
    }

    return {
      ...goal,
      range,
    }
  }

  private readGoalRange(goal: GoalLike): number | undefined {
    if (typeof goal.range === 'number' && Number.isFinite(goal.range)) {
      return goal.range
    }

    if (typeof goal.rangeSq === 'number' && Number.isFinite(goal.rangeSq) && goal.rangeSq >= 0) {
      return Math.sqrt(goal.rangeSq)
    }

    return undefined
  }

  private sendSmoothedLook(targetYaw: number, targetPitch: number): void {
    const previousLook = this.lastSentLook
    if (!previousLook) {
      this.lastSentLook = { yaw: targetYaw, pitch: targetPitch }
      this.ws.send('look', { yaw: targetYaw, pitch: targetPitch })
      return
    }

    const yawDelta = this.normalizeAngleDelta(targetYaw - previousLook.yaw)
    const pitchDelta = targetPitch - previousLook.pitch

    if (Math.abs(yawDelta) < BaritonePathfinder.LOOK_ASSIST_MIN_ANGLE_DELTA_DEGREES
      && Math.abs(pitchDelta) < BaritonePathfinder.LOOK_ASSIST_MIN_ANGLE_DELTA_DEGREES) {
      return
    }

    const nextYaw = this.normalizeYaw(
      previousLook.yaw + this.clamp(
        yawDelta,
        -BaritonePathfinder.LOOK_ASSIST_MAX_YAW_STEP_DEGREES,
        BaritonePathfinder.LOOK_ASSIST_MAX_YAW_STEP_DEGREES,
      ),
    )
    const nextPitch = this.clamp(
      previousLook.pitch + this.clamp(
        pitchDelta,
        -BaritonePathfinder.LOOK_ASSIST_MAX_PITCH_STEP_DEGREES,
        BaritonePathfinder.LOOK_ASSIST_MAX_PITCH_STEP_DEGREES,
      ),
      -90,
      90,
    )

    this.lastSentLook = { yaw: nextYaw, pitch: nextPitch }
    this.ws.send('look', { yaw: nextYaw, pitch: nextPitch })
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
  }

  private normalizeYaw(yaw: number): number {
    if (yaw > 180) {
      return yaw - 360
    }
    if (yaw <= -180) {
      return yaw + 360
    }
    return yaw
  }

  private normalizeAngleDelta(delta: number): number {
    let normalized = delta
    while (normalized > 180) {
      normalized -= 360
    }
    while (normalized <= -180) {
      normalized += 360
    }
    return normalized
  }
}
