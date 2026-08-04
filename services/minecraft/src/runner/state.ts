import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { useLogger } from '../utils/logger'

const logger = useLogger()

export enum GamePhase {
  EARLY_GAME = 'EARLY_GAME',
  IRON_AGE = 'IRON_AGE',
  FOOD_SUPPLY = 'FOOD_SUPPLY',
  DIAMOND_MINING = 'DIAMOND_MINING',
  NETHER_PREP = 'NETHER_PREP',
  NETHER_PORTAL = 'NETHER_PORTAL',
  NETHER_EXPLORE = 'NETHER_EXPLORE',
  BLAZE_HUNTING = 'BLAZE_HUNTING',
  ENDERMAN_HUNTING = 'ENDERMAN_HUNTING',
  EYE_CRAFTING = 'EYE_CRAFTING',
  STRONGHOLD = 'STRONGHOLD',
  END_PORTAL = 'END_PORTAL',
  DRAGON_FIGHT = 'DRAGON_FIGHT',
  VICTORY = 'VICTORY',
}

export interface SavedLocation {
  x: number
  y: number
  z: number
  dimension: string
  label: string
}

export interface GameState {
  phase: GamePhase
  phaseStep: number
  completedPhases: GamePhase[]
  locations: Record<string, SavedLocation>
  deathCount: number
  stuckCount: number
  lastPosition: { x: number, y: number, z: number } | null
  lastPositionTime: number
  startTime: number
  lastSaveTime: number
  phaseAttempts: Record<string, number>
  failedTasks: string[]
}

function defaultState(): GameState {
  return {
    phase: GamePhase.EARLY_GAME,
    phaseStep: 0,
    completedPhases: [],
    locations: {},
    deathCount: 0,
    stuckCount: 0,
    lastPosition: null,
    lastPositionTime: 0,
    startTime: Date.now(),
    lastSaveTime: Date.now(),
    phaseAttempts: {},
    failedTasks: [],
  }
}

export class GameStateManager {
  private state: GameState
  private savePath: string

  constructor(botUsername: string) {
    const stateDir = join(tmpdir(), 'airi-minecraft-state')
    mkdirSync(stateDir, { recursive: true })
    this.savePath = join(stateDir, `${botUsername}-progress.json`)
    this.state = this.load()
  }

  private ensureSaveDirectory(): void {
    mkdirSync(dirname(this.savePath), { recursive: true })
  }

  private load(): GameState {
    try {
      this.ensureSaveDirectory()
      if (existsSync(this.savePath)) {
        const raw = readFileSync(this.savePath, 'utf8')
        const saved = JSON.parse(raw) as Partial<GameState>
        const def = defaultState()
        // Merge with defaults to handle schema evolution
        return { ...def, ...saved, startTime: saved.startTime ?? def.startTime }
      }
    }
    catch (err) {
      logger.withError(err).warn('Failed to load game state, starting fresh')
    }
    return defaultState()
  }

  save(): void {
    try {
      this.ensureSaveDirectory()
      this.state.lastSaveTime = Date.now()
      writeFileSync(this.savePath, JSON.stringify(this.state, null, 2), 'utf8')
    }
    catch (err) {
      logger.withError(err).warn('Failed to save game state')
    }
  }

  get current(): GameState {
    return this.state
  }

  get phase(): GamePhase {
    return this.state.phase
  }

  get phaseStep(): number {
    return this.state.phaseStep
  }

  setPhase(phase: GamePhase): void {
    if (this.state.phase !== phase) {
      logger.withFields({ from: this.state.phase, to: phase }).log('Phase transition')
      if (!this.state.completedPhases.includes(this.state.phase)) {
        this.state.completedPhases.push(this.state.phase)
      }
      this.state.phase = phase
      this.state.phaseStep = 0
      this.state.phaseAttempts[phase] = 0
      this.save()
    }
  }

  advanceStep(): void {
    this.state.phaseStep++
    this.save()
  }

  resetStep(): void {
    this.state.phaseStep = 0
    this.save()
  }

  incrementAttempts(): number {
    const key = this.state.phase
    this.state.phaseAttempts[key] = (this.state.phaseAttempts[key] || 0) + 1
    this.save()
    return this.state.phaseAttempts[key]
  }

  getAttempts(): number {
    return this.state.phaseAttempts[this.state.phase] || 0
  }

  resetAttempts(phase: GamePhase = this.state.phase): void {
    this.state.phaseAttempts[phase] = 0
    this.save()
  }

  saveLocation(key: string, loc: SavedLocation): void {
    this.state.locations[key] = loc
    this.save()
  }

  getLocation(key: string): SavedLocation | undefined {
    return this.state.locations[key]
  }

  recordDeath(): void {
    this.state.deathCount++
    this.save()
  }

  recordStuck(): void {
    this.state.stuckCount++
    this.save()
  }

  updatePosition(x: number, y: number, z: number): boolean {
    const now = Date.now()
    const last = this.state.lastPosition
    const isStuck = last !== null
      && Math.abs(last.x - x) < 2
      && Math.abs(last.y - y) < 2
      && Math.abs(last.z - z) < 2
      && (now - this.state.lastPositionTime) > 60_000

    this.state.lastPosition = { x, y, z }
    this.state.lastPositionTime = now
    return isStuck
  }

  primePosition(x: number, y: number, z: number): void {
    this.state.lastPosition = { x, y, z }
    this.state.lastPositionTime = Date.now()
    this.save()
  }

  recordFailedTask(taskName: string): void {
    if (!this.state.failedTasks.includes(taskName)) {
      this.state.failedTasks.push(taskName)
      if (this.state.failedTasks.length > 50) {
        this.state.failedTasks = this.state.failedTasks.slice(-25)
      }
    }
    this.save()
  }

  reset(): void {
    this.state = defaultState()
    this.save()
  }

  getElapsedMinutes(): number {
    return Math.floor((Date.now() - this.state.startTime) / 60_000)
  }
}
