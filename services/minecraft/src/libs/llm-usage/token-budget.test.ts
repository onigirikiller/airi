import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { monitorBus } from '../monitor-event-bus'
import {
  createTokenBudgetedFetch,
  DisallowedModelError,
  estimateTokensFromCharacters,
  recordOpenAIResponseUsage,
  TokenBudgetExceededError,
  TokenBudgetGuard,
} from './token-budget'

const temporaryDirectories: string[] = []

function createPersistencePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'airi-token-budget-test-'))
  temporaryDirectories.push(directory)
  return join(directory, 'token-usage.json')
}

function createGuard(options: {
  dailyLimit?: number
  now?: () => Date
  persistencePath?: string
  softStopRatio?: number
} = {}): TokenBudgetGuard {
  return new TokenBudgetGuard({
    allowedModels: ['gpt-5.6-terra', 'gpt-5.6-luna'],
    dailyLimit: options.dailyLimit ?? 100,
    now: options.now,
    persistencePath: options.persistencePath ?? createPersistencePath(),
    persistDebounceMs: 60_000,
    softStopRatio: options.softStopRatio ?? 0.9,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('tokenBudgetGuard', () => {
  it('rotates usage at the UTC date boundary', () => {
    let now = new Date('2026-07-10T23:59:59.000Z')
    const guard = createGuard({ now: () => now })
    guard.recordUsage({ promptTokens: 20, completionTokens: 10, model: 'gpt-5.6-terra', scope: 'test' })

    expect(guard.getState()).toMatchObject({ usedToday: 30, utcDate: '2026-07-10' })

    now = new Date('2026-07-11T00:00:00.000Z')
    expect(guard.getState()).toMatchObject({ usedToday: 0, blocked: false, utcDate: '2026-07-11' })
  })

  it('blocks at the soft stop and rejects later requests', () => {
    const guard = createGuard()
    guard.recordUsage({ promptTokens: 60, completionTokens: 30, model: 'gpt-5.6-terra', scope: 'test' })

    expect(guard.getState()).toMatchObject({ usedToday: 90, softStopAt: 90, blocked: true })
    expect(() => guard.assertBudget('test', 'gpt-5.6-terra')).toThrow(TokenBudgetExceededError)
  })

  it('records an arrived response even when the budget is already blocked', () => {
    const guard = createGuard()
    guard.recordUsage({ promptTokens: 60, completionTokens: 30, model: 'gpt-5.6-terra', scope: 'test' })

    expect(() => recordOpenAIResponseUsage({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-terra',
      scope: 'test.late-response',
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
      },
      promptText: '',
      completionText: '',
      guard,
    })).toThrow(TokenBudgetExceededError)

    expect(guard.getState().usedToday).toBe(95)
  })

  it('rejects models outside the configured allowlist', () => {
    const guard = createGuard()

    expect(() => guard.assertBudget('test', 'gpt-4o')).toThrow(DisallowedModelError)
  })

  it('loads limit, soft stop, and allowed models from the environment', () => {
    vi.stubEnv('OPENAI_DAILY_TOKEN_LIMIT', '200')
    vi.stubEnv('OPENAI_DAILY_TOKEN_SOFT_STOP_RATIO', '0.75')
    vi.stubEnv('OPENAI_ALLOWED_MODELS', 'gpt-custom')
    const guard = new TokenBudgetGuard({
      persistencePath: createPersistencePath(),
      persistDebounceMs: 60_000,
    })

    expect(guard.getState()).toMatchObject({ limit: 200, softStopAt: 150 })
    expect(() => guard.assertBudget('test', 'gpt-custom')).not.toThrow()
    expect(() => guard.assertBudget('test', 'gpt-5.6-terra')).toThrow(DisallowedModelError)
  })

  it('persists and reloads the current UTC usage', () => {
    const persistencePath = createPersistencePath()
    const now = () => new Date('2026-07-10T12:00:00.000Z')
    const first = createGuard({ now, persistencePath })
    first.recordUsage({ promptTokens: 12, completionTokens: 9, model: 'gpt-5.6-terra', scope: 'test' })
    first.flushPersistence()

    expect(JSON.parse(readFileSync(persistencePath, 'utf8'))).toEqual({
      utcDate: '2026-07-10',
      usedToday: 21,
    })

    const restored = createGuard({ now, persistencePath })
    expect(restored.getState().usedToday).toBe(21)
  })

  it('does not measure non-OpenAI base URLs', () => {
    const guard = createGuard()

    recordOpenAIResponseUsage({
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-model',
      scope: 'test',
      promptText: 'x'.repeat(300),
      completionText: 'y'.repeat(300),
      guard,
    })

    expect(guard.getState().usedToday).toBe(0)
  })

  it('guards and records an official OpenAI fetch without response usage', async () => {
    const guard = createGuard({ dailyLimit: 10_000 })
    const responseText = '{"error":"temporary"}'
    const requestBody = JSON.stringify({ model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hello' }] })
    const fetchMock = vi.fn(async () => new Response(responseText, { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    const guardedFetch = createTokenBudgetedFetch('https://api.openai.com/v1', 'test.fetch', guard)
    const response = await guardedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: requestBody,
    })

    expect(response.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(guard.getState().usedToday).toBe(
      estimateTokensFromCharacters(requestBody) + estimateTokensFromCharacters(responseText),
    )
  })

  it('rejects a disallowed official OpenAI model before fetch', async () => {
    const guard = createGuard()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const guardedFetch = createTokenBudgetedFetch('https://api.openai.com/v1', 'test.fetch', guard)
    await expect(guardedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o' }),
    })).rejects.toBeInstanceOf(DisallowedModelError)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fires each blocked subscriber only once per UTC day', () => {
    const guard = createGuard()
    const callback = vi.fn()
    guard.onBlocked(callback)

    guard.recordUsage({ promptTokens: 90, completionTokens: 0, model: 'gpt-5.6-terra', scope: 'test' })
    guard.recordUsage({ promptTokens: 5, completionTokens: 5, model: 'gpt-5.6-terra', scope: 'test' })

    expect(callback).toHaveBeenCalledOnce()
  })

  it('emits monitor state at each usage threshold and when blocked', () => {
    const guard = createGuard()
    const emitSpy = vi.spyOn(monitorBus, 'emitMonitor')

    guard.recordUsage({ promptTokens: 90, completionTokens: 0, model: 'gpt-5.6-terra', scope: 'test' })

    expect(emitSpy.mock.calls
      .filter(([type]) => type === 'tokenBudget:state')
      .map(([, payload]) => payload?.reason))
      .toEqual(['25%-threshold', '50%-threshold', '75%-threshold', '90%-threshold', 'blocked'])
  })

  it('estimates missing response usage using character counts rounded up', () => {
    const guard = createGuard({ dailyLimit: 1_000 })

    recordOpenAIResponseUsage({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-terra',
      scope: 'test',
      promptText: '1234',
      completionText: '1234567',
      guard,
    })

    expect(guard.getState().usedToday).toBe(5)
  })
})
