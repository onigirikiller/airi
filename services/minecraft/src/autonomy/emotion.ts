import { monitorBus } from '../libs/monitor-event-bus'

/**
 * Lightweight emotional state machine driving voice tone, avatar expression,
 * and word choice. Game events add impulses; everything decays toward calm.
 * This is presentation-layer state only — it never influences gameplay
 * decisions.
 */

export type Emotion = 'fear' | 'excitement' | 'frustration' | 'pride' | 'boredom'

export type EmotionImpulseKind
  = | 'danger'
    | 'combat'
    | 'death'
    | 'goal-success'
    | 'goal-failure'
    | 'milestone'
    | 'discovery'
    | 'stall'
    | 'social'

export interface EmotionState {
  fear: number
  excitement: number
  frustration: number
  pride: number
  boredom: number
}

export interface TtsStyleHint {
  style: string
  styleWeight: number
  /** style-bert-vits2 length scale: <1 is faster speech. */
  lengthScale: number
}

interface ImpulseEffect {
  emotion: Emotion
  amount: number
}

const IMPULSE_EFFECTS: Record<EmotionImpulseKind, ImpulseEffect[]> = {
  'danger': [{ emotion: 'fear', amount: 0.7 }, { emotion: 'boredom', amount: -0.6 }],
  'combat': [{ emotion: 'fear', amount: 0.35 }, { emotion: 'excitement', amount: 0.4 }, { emotion: 'boredom', amount: -0.6 }],
  'death': [{ emotion: 'frustration', amount: 0.65 }, { emotion: 'fear', amount: 0.3 }, { emotion: 'pride', amount: -0.4 }],
  'goal-success': [{ emotion: 'pride', amount: 0.45 }, { emotion: 'frustration', amount: -0.3 }, { emotion: 'boredom', amount: -0.3 }],
  'goal-failure': [{ emotion: 'frustration', amount: 0.35 }],
  'milestone': [{ emotion: 'pride', amount: 0.7 }, { emotion: 'excitement', amount: 0.5 }, { emotion: 'boredom', amount: -0.8 }],
  'discovery': [{ emotion: 'excitement', amount: 0.6 }, { emotion: 'boredom', amount: -0.7 }],
  'stall': [{ emotion: 'frustration', amount: 0.25 }, { emotion: 'boredom', amount: 0.3 }],
  'social': [{ emotion: 'excitement', amount: 0.25 }, { emotion: 'boredom', amount: -0.5 }],
}

/** Half-life per emotion in milliseconds. Fear fades fast, pride lingers. */
const HALF_LIFE_MS: Record<Emotion, number> = {
  fear: 25_000,
  excitement: 45_000,
  frustration: 90_000,
  pride: 120_000,
  boredom: 180_000,
}

/** Passive boredom growth per minute of nothing happening. */
const BOREDOM_GROWTH_PER_MINUTE = 0.06

const DEFAULT_STYLE_BY_EMOTION: Record<Emotion, string> = {
  fear: 'Surprised',
  excitement: 'Happy',
  frustration: 'Sad',
  pride: 'Happy',
  boredom: 'Neutral',
}

const EMOTION_LABELS_JA: Record<Emotion, string> = {
  fear: '恐怖',
  excitement: '興奮',
  frustration: '悔しさ',
  pride: '誇らしさ',
  boredom: '退屈',
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export class EmotionEngine {
  private state: EmotionState = { fear: 0, excitement: 0, frustration: 0, pride: 0, boredom: 0.2 }
  private lastUpdateAt: number
  private readonly styleByEmotion: Record<Emotion, string>

  constructor(options: { now?: () => number, styleOverrides?: Partial<Record<Emotion, string>> } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.lastUpdateAt = this.now()
    this.styleByEmotion = { ...DEFAULT_STYLE_BY_EMOTION, ...options.styleOverrides }
  }

  private readonly now: () => number

  public impulse(kind: EmotionImpulseKind, intensity = 1): void {
    this.decay()
    for (const effect of IMPULSE_EFFECTS[kind]) {
      this.state[effect.emotion] = clamp01(this.state[effect.emotion] + effect.amount * intensity)
    }
    const dominant = this.dominant()
    monitorBus.emitMonitor('emotion:state', {
      ...this.state,
      dominant: dominant.emotion,
      dominantIntensity: dominant.intensity,
      impulse: kind,
    })
  }

  public getState(): EmotionState {
    this.decay()
    return { ...this.state }
  }

  public dominant(): { emotion: Emotion, intensity: number } {
    this.decay()
    let best: Emotion = 'boredom'
    let bestValue = -1
    for (const emotion of Object.keys(this.state) as Emotion[]) {
      if (this.state[emotion] > bestValue) {
        best = emotion
        bestValue = this.state[emotion]
      }
    }
    return { emotion: best, intensity: bestValue }
  }

  /** style-bert-vits2 parameters for the current mood, or null when calm. */
  public currentTtsStyle(): TtsStyleHint | null {
    const { emotion, intensity } = this.dominant()
    if (intensity < 0.35) {
      return null
    }

    // Tense emotions speed speech up; low-energy ones slow it slightly.
    const lengthScale = emotion === 'fear' || emotion === 'excitement'
      ? 1 - 0.18 * intensity
      : emotion === 'boredom'
        ? 1 + 0.06 * intensity
        : 1 - 0.05 * intensity

    return {
      style: this.styleByEmotion[emotion],
      styleWeight: Math.round((1 + intensity * 4) * 10) / 10,
      lengthScale: Math.round(lengthScale * 100) / 100,
    }
  }

  /** One-line Japanese summary for LLM prompt conditioning. */
  public describeForPrompt(): string {
    const state = this.getState()
    const parts = (Object.keys(state) as Emotion[])
      .filter(emotion => state[emotion] >= 0.25)
      .sort((left, right) => state[right] - state[left])
      .slice(0, 2)
      .map(emotion => `${EMOTION_LABELS_JA[emotion]}${state[emotion].toFixed(1)}`)
    return parts.length > 0 ? `現在の感情: ${parts.join('、')}` : '現在の感情: 平常'
  }

  private decay(): void {
    const now = this.now()
    const elapsed = now - this.lastUpdateAt
    if (elapsed <= 0) {
      return
    }
    this.lastUpdateAt = now

    for (const emotion of Object.keys(this.state) as Emotion[]) {
      const factor = 2 ** (-elapsed / HALF_LIFE_MS[emotion])
      this.state[emotion] = clamp01(this.state[emotion] * factor)
    }
    this.state.boredom = clamp01(this.state.boredom + (elapsed / 60_000) * BOREDOM_GROWTH_PER_MINUTE)
  }
}

// ---------------------------------------------------------------------------
// Shared provider so the TTS layer can consult the active emotion without
// threading state through every speech call site.
// ---------------------------------------------------------------------------

let activeEmotionEngine: EmotionEngine | undefined

export function setActiveEmotionEngine(engine: EmotionEngine | undefined): void {
  activeEmotionEngine = engine
}

export function getActiveTtsStyleHint(): TtsStyleHint | null {
  try {
    return activeEmotionEngine?.currentTtsStyle() ?? null
  }
  catch {
    return null
  }
}

export function getActiveEmotionEngine(): EmotionEngine | undefined {
  return activeEmotionEngine
}
