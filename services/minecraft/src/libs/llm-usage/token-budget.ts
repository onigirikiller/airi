import process from 'node:process'

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { useLogger } from '../../utils/logger'
import { monitorBus } from '../monitor-event-bus'

export const TOKEN_BUDGET_EXIT_CODE = 78
export const TOKEN_BUDGET_SHUTDOWN_EVENT = 'airi:token-budget-exhausted'

const DEFAULT_DAILY_LIMIT = 2_500_000
const DEFAULT_SOFT_STOP_RATIO = 0.9
const DEFAULT_ALLOWED_MODELS = ['gpt-5.6-terra', 'gpt-5.6-luna']
const DEFAULT_PERSIST_DEBOUNCE_MS = 5_000
const NOTIFICATION_RATIOS = [0.25, 0.5, 0.75, 0.9] as const

interface PersistedTokenUsage {
  utcDate: string
  usedToday: number
}

export interface TokenBudgetState {
  usedToday: number
  limit: number
  softStopAt: number
  blocked: boolean
  utcDate: string
}

export interface RecordTokenUsageInput {
  promptTokens: number
  completionTokens: number
  model: string
  scope: string
}

interface TokenBudgetGuardOptions {
  allowedModels?: string[]
  dailyLimit?: number
  now?: () => Date
  persistencePath?: string
  persistDebounceMs?: number
  softStopRatio?: number
}

interface OpenAIUsageLike {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  input_tokens?: unknown
  output_tokens?: unknown
}

interface BlockedSubscriber {
  callback: (state: TokenBudgetState) => void
  lastNotifiedUtcDate?: string
}

export class TokenBudgetExceededError extends Error {
  constructor(
    public readonly scope: string,
    public readonly model: string,
    public readonly state: TokenBudgetState,
  ) {
    super(`OpenAI token budget exhausted for ${state.utcDate}: ${state.usedToday}/${state.softStopAt} soft-stop tokens used`)
    this.name = 'TokenBudgetExceededError'
  }
}

export class DisallowedModelError extends Error {
  constructor(
    public readonly scope: string,
    public readonly model: string,
    public readonly allowedModels: readonly string[],
  ) {
    super(`OpenAI model is not allowed for ${scope}: ${model || '<empty>'}`)
    this.name = 'DisallowedModelError'
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseSoftStopRatio(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DEFAULT_SOFT_STOP_RATIO
}

function parseAllowedModels(value: string | undefined): string[] {
  const parsed = (value ?? DEFAULT_ALLOWED_MODELS.join(','))
    .split(',')
    .map(model => model.trim())
    .filter(Boolean)
  return parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_ALLOWED_MODELS
}

function utcDateOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0
}

function readUsageToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.ceil(value)
    : undefined
}

/** Conservatively estimates tokens from text when the provider omits usage. */
export function estimateTokensFromCharacters(value: string): number {
  return value.length > 0 ? Math.ceil(value.length / 3) : 0
}

/** Only the official OpenAI host consumes the configured free-tier budget. */
export function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase().includes('api.openai.com')
}

export function isTokenBudgetError(error: unknown): error is TokenBudgetExceededError | DisallowedModelError {
  return error instanceof TokenBudgetExceededError || error instanceof DisallowedModelError
}

export class TokenBudgetGuard {
  private readonly logger = useLogger()
  private readonly allowedModels: Set<string>
  private readonly limit: number
  private readonly now: () => Date
  private readonly persistencePath: string
  private readonly persistDebounceMs: number
  private readonly softStopRatio: number
  private readonly subscribers = new Set<BlockedSubscriber>()
  private notifiedRatios = new Set<number>()
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private usedToday = 0
  private utcDate: string

  constructor(options: TokenBudgetGuardOptions = {}) {
    this.limit = options.dailyLimit ?? parsePositiveInteger(process.env.OPENAI_DAILY_TOKEN_LIMIT, DEFAULT_DAILY_LIMIT)
    this.softStopRatio = options.softStopRatio ?? parseSoftStopRatio(process.env.OPENAI_DAILY_TOKEN_SOFT_STOP_RATIO)
    this.allowedModels = new Set(options.allowedModels ?? parseAllowedModels(process.env.OPENAI_ALLOWED_MODELS))
    this.now = options.now ?? (() => new Date())
    this.persistencePath = options.persistencePath
      // NOTICE: Test workers must not consume or overwrite the real persisted daily budget.
      ?? (process.env.VITEST
        ? join(tmpdir(), 'airi-minecraft-state', `token-usage-vitest-${process.pid}.json`)
        : join(tmpdir(), 'airi-minecraft-state', 'token-usage.json'))
    this.persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS
    this.utcDate = utcDateOf(this.now())
    this.loadPersistedState()
  }

  public recordUsage(input: RecordTokenUsageInput): void {
    this.rotateUtcDayIfNeeded()
    const previousUsed = this.usedToday
    const promptTokens = normalizeTokenCount(input.promptTokens)
    const completionTokens = normalizeTokenCount(input.completionTokens)
    this.usedToday += promptTokens + completionTokens
    this.logger.withFields({
      scope: input.scope,
      promptTokens,
      completionTokens,
      usedToday: this.usedToday,
    }).log('OpenAI tokens recorded')
    this.schedulePersistence()

    for (const ratio of NOTIFICATION_RATIOS) {
      const threshold = Math.ceil(this.limit * ratio)
      if (previousUsed < threshold && this.usedToday >= threshold && !this.notifiedRatios.has(ratio)) {
        this.notifiedRatios.add(ratio)
        this.emitState(input.scope, input.model, `${Math.round(ratio * 100)}%-threshold`)
      }
    }

    if (previousUsed < this.softStopAt && this.usedToday >= this.softStopAt) {
      this.emitState(input.scope, input.model, 'blocked')
      const state = this.getState()
      for (const subscriber of this.subscribers) {
        this.notifyBlockedSubscriber(subscriber, state)
      }
    }
  }

  public assertBudget(scope: string, model: string): void {
    this.rotateUtcDayIfNeeded()
    if (!this.allowedModels.has(model)) {
      throw new DisallowedModelError(scope, model, [...this.allowedModels])
    }
    const state = this.getState()
    if (state.blocked) {
      throw new TokenBudgetExceededError(scope, model, state)
    }
  }

  public getState(): TokenBudgetState {
    this.rotateUtcDayIfNeeded()
    return {
      usedToday: this.usedToday,
      limit: this.limit,
      softStopAt: this.softStopAt,
      blocked: this.usedToday >= this.softStopAt,
      utcDate: this.utcDate,
    }
  }

  public onBlocked(callback: (state: TokenBudgetState) => void): () => void {
    const subscriber: BlockedSubscriber = { callback }
    this.subscribers.add(subscriber)
    const state = this.getState()
    if (state.blocked) {
      this.notifyBlockedSubscriber(subscriber, state)
    }
    return () => this.subscribers.delete(subscriber)
  }

  /** Flushes a pending debounced write, primarily for graceful shutdown and tests. */
  public flushPersistence(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    mkdirSync(dirname(this.persistencePath), { recursive: true })
    const temporaryPath = `${this.persistencePath}.tmp`
    writeFileSync(temporaryPath, JSON.stringify({
      utcDate: this.utcDate,
      usedToday: this.usedToday,
    } satisfies PersistedTokenUsage), 'utf8')
    renameSync(temporaryPath, this.persistencePath)
  }

  private get softStopAt(): number {
    return Math.ceil(this.limit * this.softStopRatio)
  }

  private emitState(scope: string, model: string, reason: string): void {
    const state = this.getState()
    const payload = { ...state, scope, model, reason }
    monitorBus.emitMonitor('tokenBudget:state', payload)
    this.logger.withFields(payload).warn(reason === 'blocked'
      ? 'OpenAI token budget soft stop reached; blocking further requests'
      : 'OpenAI token budget usage threshold reached')
  }

  private loadPersistedState(): void {
    try {
      const persisted = JSON.parse(readFileSync(this.persistencePath, 'utf8')) as Partial<PersistedTokenUsage>
      if (persisted.utcDate !== this.utcDate) {
        return
      }
      if (typeof persisted.usedToday !== 'number' || !Number.isFinite(persisted.usedToday) || persisted.usedToday < 0) {
        throw new TypeError('Persisted OpenAI token usage is invalid')
      }

      this.usedToday = normalizeTokenCount(persisted.usedToday)
      for (const ratio of NOTIFICATION_RATIOS) {
        if (this.usedToday >= Math.ceil(this.limit * ratio)) {
          this.notifiedRatios.add(ratio)
        }
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.usedToday = 0
        return
      }

      // NOTICE: Corrupt usage state blocks OpenAI rather than risking paid overage from an undercount.
      this.usedToday = this.softStopAt
      this.logger.withError(error).error('Invalid OpenAI token usage state; blocking requests for the current UTC day')
    }
  }

  private notifyBlockedSubscriber(subscriber: BlockedSubscriber, state: TokenBudgetState): void {
    if (subscriber.lastNotifiedUtcDate === state.utcDate) {
      return
    }
    subscriber.lastNotifiedUtcDate = state.utcDate
    try {
      subscriber.callback(state)
    }
    catch (error) {
      this.logger.withError(error).error('Token budget blocked callback failed')
    }
  }

  private rotateUtcDayIfNeeded(): void {
    const currentUtcDate = utcDateOf(this.now())
    if (currentUtcDate === this.utcDate) {
      return
    }
    this.utcDate = currentUtcDate
    this.usedToday = 0
    this.notifiedRatios.clear()
    this.schedulePersistence()
  }

  private schedulePersistence(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      try {
        this.flushPersistence()
      }
      catch (error) {
        this.logger.withError(error).error('Failed to persist OpenAI token usage state')
      }
    }, this.persistDebounceMs)
    this.persistTimer.unref?.()
  }
}

export const tokenBudgetGuard = new TokenBudgetGuard()

/** Records official OpenAI usage and estimates any missing fields conservatively. */
export function recordOpenAIResponseUsage(options: {
  baseUrl: string
  model: string
  scope: string
  usage?: OpenAIUsageLike | null
  promptText: string
  completionText: string
  guard?: TokenBudgetGuard
}): void {
  if (!isOfficialOpenAIBaseUrl(options.baseUrl)) {
    return
  }

  const guard = options.guard ?? tokenBudgetGuard
  const promptTokens = readUsageToken(options.usage?.prompt_tokens)
    ?? readUsageToken(options.usage?.input_tokens)
    ?? estimateTokensFromCharacters(options.promptText)
  const completionTokens = readUsageToken(options.usage?.completion_tokens)
    ?? readUsageToken(options.usage?.output_tokens)
    ?? estimateTokensFromCharacters(options.completionText)

  guard.recordUsage({ promptTokens, completionTokens, model: options.model, scope: options.scope })
  // Refuse use of the response that crossed the soft stop, so no action can start after blocking.
  guard.assertBudget(options.scope, options.model)
}

export function assertOpenAITokenBudget(baseUrl: string, scope: string, model: string, guard = tokenBudgetGuard): void {
  if (isOfficialOpenAIBaseUrl(baseUrl)) {
    guard.assertBudget(scope, model)
  }
}

/** Wraps every Neuri/XSAI round trip so tool-call retries cannot escape accounting. */
export function createTokenBudgetedFetch(baseUrl: string, scope: string, guard = tokenBudgetGuard): typeof globalThis.fetch {
  return async (input, init) => {
    if (!isOfficialOpenAIBaseUrl(baseUrl)) {
      return await globalThis.fetch(input, init)
    }

    const promptText = typeof init?.body === 'string' ? init.body : ''
    let model = ''
    try {
      model = String(JSON.parse(promptText)?.model ?? '')
    }
    catch {
      // Invalid request JSON will still be rejected by the allowlist before reaching OpenAI.
    }

    guard.assertBudget(scope, model)
    const response = await globalThis.fetch(input, init)
    const responseText = await response.clone().text()
    let data: { usage?: OpenAIUsageLike } | undefined
    try {
      data = JSON.parse(responseText) as { usage?: OpenAIUsageLike }
    }
    catch {
      // Non-JSON error bodies are still conservatively charged from their character count.
    }
    recordOpenAIResponseUsage({
      baseUrl,
      model,
      scope,
      usage: data?.usage,
      promptText,
      completionText: responseText,
      guard,
    })
    return response
  }
}
