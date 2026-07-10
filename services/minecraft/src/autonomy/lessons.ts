import type { WorldFacts } from './preconditions'
import type { ProgressMilestone } from './progress'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { useLogger } from '../utils/logger'

export type LessonTrigger = 'death' | 'goal-failure' | 'stall'

export interface Lesson {
  id: string
  trigger: LessonTrigger
  /** Factual description of what happened, e.g. "Died to zombie at y=12 while mining at night". */
  fact: string
  /** Milestone active when the lesson was learned; used for relevance ranking. */
  milestone: string
  dimension: string
  occurrences: number
  firstAt: number
  lastAt: number
}

interface PersistedLessons {
  version: 1
  lessons: Lesson[]
}

const MAX_LESSONS = 50
const PERSIST_DEBOUNCE_MS = 3_000

function normalizeFactKey(fact: string): string {
  return fact.toLowerCase().replace(/-?\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim()
}

/**
 * Persistent episodic memory of deaths and repeated failures. Lessons are
 * factual records — the LLM strategist reads them in its context and decides
 * how to act on them; nothing here drives behavior directly.
 */
export class LessonStore {
  private readonly logger = useLogger()
  private readonly persistencePath: string
  private lessons: Lesson[] = []
  private persistTimer: ReturnType<typeof setTimeout> | undefined

  constructor(botUsername: string, persistencePath?: string) {
    this.persistencePath = persistencePath
      ?? join(tmpdir(), 'airi-minecraft-state', `${botUsername}-lessons.json`)
    this.load()
  }

  public record(entry: {
    trigger: LessonTrigger
    fact: string
    milestone: ProgressMilestone | string
    dimension: string
  }): Lesson {
    const now = Date.now()
    const key = normalizeFactKey(entry.fact)
    const existing = this.lessons.find(lesson =>
      lesson.trigger === entry.trigger && normalizeFactKey(lesson.fact) === key,
    )

    if (existing) {
      existing.occurrences += 1
      existing.lastAt = now
      existing.fact = entry.fact
      this.schedulePersist()
      return existing
    }

    const lesson: Lesson = {
      id: `${entry.trigger}-${now.toString(36)}`,
      trigger: entry.trigger,
      fact: entry.fact,
      milestone: String(entry.milestone),
      dimension: entry.dimension,
      occurrences: 1,
      firstAt: now,
      lastAt: now,
    }
    this.lessons.push(lesson)
    if (this.lessons.length > MAX_LESSONS) {
      this.lessons = this.lessons
        .sort((left, right) => this.weight(right) - this.weight(left))
        .slice(0, MAX_LESSONS)
    }
    this.schedulePersist()
    return lesson
  }

  /**
   * Lessons ranked for the current situation: same milestone and dimension
   * first, then repeated and recent ones.
   */
  public getRelevant(facts: Pick<WorldFacts, 'dimension'> & { milestone?: string }, limit = 5): Lesson[] {
    const now = Date.now()
    return [...this.lessons]
      .sort((left, right) => this.relevance(right, facts, now) - this.relevance(left, facts, now))
      .slice(0, Math.max(0, limit))
  }

  public formatForPrompt(facts: Pick<WorldFacts, 'dimension'> & { milestone?: string }, limit = 5): string[] {
    return this.getRelevant(facts, limit).map((lesson) => {
      const repeat = lesson.occurrences > 1 ? ` (x${lesson.occurrences})` : ''
      return `- [${lesson.trigger}] ${lesson.fact}${repeat}`
    })
  }

  public get size(): number {
    return this.lessons.length
  }

  public flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      const payload: PersistedLessons = { version: 1, lessons: this.lessons }
      writeFileSync(this.persistencePath, JSON.stringify(payload), 'utf8')
    }
    catch (error) {
      this.logger.withError(error).warn('Failed to persist lessons')
    }
  }

  private weight(lesson: Lesson): number {
    return lesson.occurrences * 2 + lesson.lastAt / 1e12
  }

  private relevance(lesson: Lesson, facts: Pick<WorldFacts, 'dimension'> & { milestone?: string }, now: number): number {
    let score = 0
    if (facts.milestone && lesson.milestone === facts.milestone) {
      score += 4
    }
    if (lesson.dimension === facts.dimension) {
      score += 2
    }
    score += Math.min(3, lesson.occurrences)
    const ageHours = (now - lesson.lastAt) / 3_600_000
    score += Math.max(0, 2 - ageHours / 12)
    return score
  }

  private load(): void {
    try {
      if (!existsSync(this.persistencePath)) {
        return
      }
      const parsed = JSON.parse(readFileSync(this.persistencePath, 'utf8')) as PersistedLessons
      if (parsed?.version === 1 && Array.isArray(parsed.lessons)) {
        this.lessons = parsed.lessons.filter(lesson =>
          typeof lesson?.fact === 'string' && typeof lesson?.trigger === 'string',
        )
      }
    }
    catch (error) {
      this.logger.withError(error).warn('Failed to load persisted lessons; starting fresh')
      this.lessons = []
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.flush()
    }, PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }
}

/** Builds the factual death lesson line from the world state at death time. */
export function describeDeathLesson(facts: WorldFacts, nearestHostileName?: string): string {
  const position = `(${Math.round(facts.position.x)}, ${Math.round(facts.position.y)}, ${Math.round(facts.position.z)})`
  const cause = nearestHostileName ? `near ${nearestHostileName}` : 'from an unknown cause'
  const conditions: string[] = []
  if (facts.timeOfDay === 'night') {
    conditions.push('at night')
  }
  if (facts.position.y < 32) {
    conditions.push('underground')
  }
  if (facts.food <= 6) {
    conditions.push('while starving')
  }
  const suffix = conditions.length > 0 ? ` ${conditions.join(' ')}` : ''
  return `Died ${cause} at ${position} in ${facts.dimension}${suffix}; milestone was ${facts.runnerPhase !== 'UNKNOWN' ? facts.runnerPhase : 'unknown'}`
}
