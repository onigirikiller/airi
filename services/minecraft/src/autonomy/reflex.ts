import type { Entity } from 'prismarine-entity'

import type { Mineflayer } from '../libs/mineflayer'

import { EventEmitter } from 'eventemitter3'

import { monitorBus } from '../libs/monitor-event-bus'
import { autoEat, defendSelf } from '../skills/combat'
import { moveAway, moveAwayFromEntity } from '../skills/movement'
import { getNearbyEntities } from '../skills/world'
import { useLogger } from '../utils/logger'
import { isHostile } from '../utils/mcdata'

export type ReflexKind
  = | 'creeper-flee'
    | 'combat-defense'
    | 'emergency-retreat'
    | 'lava-escape'

export interface ReflexEvent {
  kind: ReflexKind
  at: number
  detail: string
}

interface ReflexSkills {
  flee: (mineflayer: Mineflayer, entity: Entity, distance: number) => Promise<boolean>
  defend: (mineflayer: Mineflayer, range: number) => Promise<boolean>
  eat: (mineflayer: Mineflayer, threshold?: number) => Promise<boolean>
  escape: (mineflayer: Mineflayer, distance: number) => Promise<boolean>
}

export interface ReflexControllerOptions {
  scanIntervalMs?: number
  creeperDangerDistance?: number
  hostileContactDistance?: number
  damageReactionDistance?: number
  damageReactionWindowMs?: number
  emergencyHealth?: number
  cooldownMs?: number
  skills?: Partial<ReflexSkills>
}

const DEFAULT_SCAN_INTERVAL_MS = 500
const DEFAULT_CREEPER_DANGER_DISTANCE = 6
const DEFAULT_HOSTILE_CONTACT_DISTANCE = 3.5
const DEFAULT_DAMAGE_REACTION_DISTANCE = 9
const DEFAULT_DAMAGE_REACTION_WINDOW_MS = 4_000
const DEFAULT_EMERGENCY_HEALTH = 8
const DEFAULT_COOLDOWN_MS = 2_500
const HOSTILE_SCAN_DISTANCE = 12
const CREEPER_FLEE_DISTANCE = 12
const EMERGENCY_RETREAT_DISTANCE = 16
const LAVA_ESCAPE_DISTANCE = 8

/**
 * Always-on survival reflexes that react to danger on game-event timescales
 * without any LLM involvement. A reflex response preempts whatever action is
 * currently executing via the shared action-abort mechanism, runs a
 * deterministic survival skill, and then releases control back to the
 * planning stack.
 */
export class ReflexController extends EventEmitter<{ reflex: (event: ReflexEvent) => void }> {
  private readonly logger = useLogger()
  private readonly scanIntervalMs: number
  private readonly creeperDangerDistance: number
  private readonly hostileContactDistance: number
  private readonly damageReactionDistance: number
  private readonly damageReactionWindowMs: number
  private readonly emergencyHealth: number
  private readonly cooldownMs: number
  private readonly skills: ReflexSkills

  private started = false
  private engaged: ReflexKind | null = null
  private lastResponseAt = 0
  private lastKnownHealth: number | null = null
  private lastDamageAt = 0
  private scanTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly mineflayer: Mineflayer,
    options: ReflexControllerOptions = {},
  ) {
    super()
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS
    this.creeperDangerDistance = options.creeperDangerDistance ?? DEFAULT_CREEPER_DANGER_DISTANCE
    this.hostileContactDistance = options.hostileContactDistance ?? DEFAULT_HOSTILE_CONTACT_DISTANCE
    this.damageReactionDistance = options.damageReactionDistance ?? DEFAULT_DAMAGE_REACTION_DISTANCE
    this.damageReactionWindowMs = options.damageReactionWindowMs ?? DEFAULT_DAMAGE_REACTION_WINDOW_MS
    this.emergencyHealth = options.emergencyHealth ?? DEFAULT_EMERGENCY_HEALTH
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.skills = {
      flee: options.skills?.flee ?? ((m, entity, distance) => moveAwayFromEntity(m, entity, distance)),
      defend: options.skills?.defend ?? ((m, range) => defendSelf(m, range)),
      eat: options.skills?.eat ?? ((m, threshold) => autoEat(m, threshold)),
      escape: options.skills?.escape ?? ((m, distance) => moveAway(m, distance)),
    }
  }

  public start(): void {
    if (this.started) {
      return
    }
    this.started = true
    this.lastKnownHealth = null
    this.mineflayer.bot.on('health', this.handleHealth)
    this.scanTimer = setInterval(() => {
      void this.evaluate('scan')
    }, this.scanIntervalMs)
    this.scanTimer.unref?.()
    this.logger.log('Reflex controller started')
  }

  public stop(): void {
    if (!this.started) {
      return
    }
    this.started = false
    this.mineflayer.bot.off?.('health', this.handleHealth)
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
    this.logger.log('Reflex controller stopped')
  }

  public isEngaged(): boolean {
    return this.engaged !== null
  }

  public get activeReflex(): ReflexKind | null {
    return this.engaged
  }

  private handleHealth = (): void => {
    const health = Number(this.mineflayer.bot.health)
    if (!Number.isFinite(health)) {
      return
    }
    const previous = this.lastKnownHealth
    this.lastKnownHealth = health
    if (previous !== null && health < previous) {
      this.lastDamageAt = Date.now()
      void this.evaluate('damage')
    }
  }

  private async evaluate(trigger: 'scan' | 'damage'): Promise<void> {
    if (!this.started || this.engaged) {
      return
    }
    const now = Date.now()
    if (now - this.lastResponseAt < this.cooldownMs) {
      return
    }

    const self = this.mineflayer.bot.entity
    if (!self?.position) {
      return
    }

    let hostiles: Entity[] = []
    try {
      hostiles = getNearbyEntities(this.mineflayer, HOSTILE_SCAN_DISTANCE).filter(entity => isHostile(entity))
    }
    catch {
      return
    }

    const distanceTo = (entity: Entity): number => {
      try {
        return self.position.distanceTo(entity.position)
      }
      catch {
        return Number.POSITIVE_INFINITY
      }
    }

    // 1. Creepers about to detonate outrank everything else.
    const creeper = hostiles
      .filter(entity => entity.name === 'creeper')
      .sort((left, right) => distanceTo(left) - distanceTo(right))[0]
    if (creeper && distanceTo(creeper) <= this.creeperDangerDistance) {
      await this.respond('creeper-flee', `creeper at ${distanceTo(creeper).toFixed(1)} blocks`, async () => {
        await this.skills.flee(this.mineflayer, creeper, CREEPER_FLEE_DISTANCE)
      })
      return
    }

    // 2. Standing in lava or on fire: get out before anything else.
    if (this.isBurning()) {
      await this.respond('lava-escape', 'burning or touching lava', async () => {
        await this.skills.escape(this.mineflayer, LAVA_ESCAPE_DISTANCE)
      })
      return
    }

    // 3. Critical health: break contact, then recover.
    const health = Number(this.mineflayer.bot.health)
    if (Number.isFinite(health) && health <= this.emergencyHealth) {
      const nearestHostile = hostiles.sort((left, right) => distanceTo(left) - distanceTo(right))[0]
      if (nearestHostile && distanceTo(nearestHostile) <= HOSTILE_SCAN_DISTANCE) {
        await this.respond('emergency-retreat', `health ${health} with ${nearestHostile.name} nearby`, async () => {
          await this.skills.flee(this.mineflayer, nearestHostile, EMERGENCY_RETREAT_DISTANCE)
          await this.skills.eat(this.mineflayer, 20)
        })
        return
      }
    }

    // 4. Active combat: melee contact, or recent damage with a hostile close by.
    const nearestHostile = hostiles.sort((left, right) => distanceTo(left) - distanceTo(right))[0]
    if (nearestHostile) {
      const distance = distanceTo(nearestHostile)
      const recentlyDamaged = trigger === 'damage'
        || now - this.lastDamageAt <= this.damageReactionWindowMs
      if (distance <= this.hostileContactDistance || (recentlyDamaged && distance <= this.damageReactionDistance)) {
        await this.respond('combat-defense', `${nearestHostile.name} at ${distance.toFixed(1)} blocks`, async () => {
          await this.skills.defend(this.mineflayer, Math.max(this.damageReactionDistance, 10))
        })
      }
    }
  }

  private isBurning(): boolean {
    const bot = this.mineflayer.bot
    if ((bot.entity as any)?.onFire === true) {
      return true
    }
    try {
      const feet = bot.blockAt?.(bot.entity.position)
      const head = bot.blockAt?.(bot.entity.position.offset(0, 1, 0))
      return [feet?.name, head?.name].some(name => name === 'lava' || name === 'fire')
    }
    catch {
      return false
    }
  }

  private async respond(kind: ReflexKind, detail: string, run: () => Promise<void>): Promise<void> {
    this.engaged = kind
    const event: ReflexEvent = { kind, at: Date.now(), detail }
    this.logger.withFields({ kind, detail }).warn('Reflex triggered; preempting current action')
    monitorBus.emitMonitor('reflex:triggered', { kind, detail })
    this.emit('reflex', event)

    const signal = this.mineflayer.beginAction(`reflex:${kind}`)
    try {
      await run()
    }
    catch (error) {
      this.logger.withError(error).warn('Reflex response failed (non-fatal)')
    }
    finally {
      this.mineflayer.completeAction(signal)
      this.lastResponseAt = Date.now()
      this.engaged = null
      monitorBus.emitMonitor('reflex:resolved', { kind })
    }
  }
}
