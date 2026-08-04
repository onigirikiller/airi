import { afterEach, describe, expect, it, vi } from 'vitest'

import { config } from '../composables/config'
import { resetInferenceLaneForTests } from './inference-lane'
import { AutonomousStreamOrchestrator } from './orchestrator'

vi.mock('../libs/llm-agent/output', () => ({
  publishAssistantMessageToAiri: vi.fn(),
}))

function createOrchestrator() {
  const bot = {
    username: 'AIra',
    ready: true,
    bot: {
      on: vi.fn(),
      off: vi.fn(),
      chat: vi.fn(),
      players: {},
    },
    memory: {
      actions: [],
      chatHistory: [],
    },
    status: {
      toOneLiner: () => 'ok',
    },
  } as any

  const airiClient = {
    onEvent: vi.fn(),
    offEvent: vi.fn(),
    send: vi.fn(),
  } as any

  return new AutonomousStreamOrchestrator(bot, airiClient)
}

const originalFetch = globalThis.fetch
const originalLlmConfig = { ...config.llm }
const originalSpeechLlmConfig = { ...config.speechLlm }
const originalPublicSpeakConfig = { ...config.publicSpeak }

afterEach(() => {
  resetInferenceLaneForTests()
  config.llm.apiKey = originalLlmConfig.apiKey
  config.llm.baseUrl = originalLlmConfig.baseUrl
  config.llm.model = originalLlmConfig.model
  config.llm.reasoningModel = originalLlmConfig.reasoningModel
  config.llm.publicSpeakModel = originalLlmConfig.publicSpeakModel
  config.speechLlm.apiKey = originalSpeechLlmConfig.apiKey
  config.speechLlm.baseUrl = originalSpeechLlmConfig.baseUrl
  config.speechLlm.model = originalSpeechLlmConfig.model
  config.speechLlm.reasoningModel = originalSpeechLlmConfig.reasoningModel
  config.speechLlm.publicSpeakModel = originalSpeechLlmConfig.publicSpeakModel
  config.publicSpeak.provider = originalPublicSpeakConfig.provider
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('autonomous stream orchestrator llm-only public speak', () => {
  it('defers low-priority speech while recent voice playback is still settling', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()

    orchestrator.pendingSpeechItems = [{ estimatedDoneAt: now + 2_000, isSocialReply: false }]
    orchestrator.lastVoiceRequestAt = now - 1_000
    orchestrator.lastEstimatedVoiceEndAt = now + 1_000

    expect(orchestrator.shouldDeferLowPrioritySpeech(now)).toBe(true)
  })

  it('clears the voice playback cooldown 5 seconds after speech end', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()

    orchestrator.pendingSpeechItems = []
    orchestrator.lastVoiceRequestAt = now - 6_000
    orchestrator.lastEstimatedVoiceEndAt = now - 4_999
    expect(orchestrator.getLowPrioritySpeechDeferralReason(now)).toBe('voice_playback_cooldown')

    orchestrator.lastEstimatedVoiceEndAt = now - 5_000
    expect(orchestrator.getLowPrioritySpeechDeferralReason(now)).toBeNull()
  })

  it('returns empty instead of emitting a template when llm config is missing', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = ''
    config.speechLlm.model = ''

    const orchestrator = createOrchestrator() as any
    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Craft a crafting table',
      undefined,
      'goal=crafting_table | action=move',
      { mode: 'default' },
    )

    expect(message).toBe('')
  })

  it('retries gameplay commentary until llm returns a usable line', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'

    const replies = [
      '',
      'まずは木材を集めましょう。',
      '\u5275\u4E16\u306E\u796D\u58C7\u306F\u307E\u3060\u6C88\u9ED9\u3057\u306A\u3044\u{1F60F}\u2728\u{1F525}',
    ]
    const fetchMock = vi.fn(async () => {
      const content = replies.shift() ?? ''
      return new Response(JSON.stringify({
        message: { content },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    orchestrator.delayPublicSpeakRetry = vi.fn(async () => {})

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Craft a crafting table',
      undefined,
      'goal=crafting_table | action=move',
      { mode: 'default' },
    )

    expect(message).toBe('\u5275\u4E16\u306E\u796D\u58C7\u306F\u307E\u3060\u6C88\u9ED9\u3057\u306A\u3044\u{1F60F}\u2728\u{1F525}')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('adds a soft character budget to gameplay speech prompts without adding new retry rules', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      const prompt = JSON.stringify(payload.messages)
      expect(prompt).toContain('Aim for about 14 to 32 Japanese characters including emojis')
      expect(prompt).toContain('length_hint: Aim for about 14 to 32 Japanese characters including emojis')
      expect(prompt).toContain('scene_memo: goal=wood')
      expect(prompt).toContain('action=move')

      return new Response(JSON.stringify({
        message: {
          content: '\u95C7\u306E\u5C01\u5370\u304C\u7583\u304F\u{1F60F}\u2728\u{1F525}',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    orchestrator.delayPublicSpeakRetry = vi.fn(async () => {})

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Gather wood and craft a crafting table',
      undefined,
      'goal=wood | action=move',
      { mode: 'default' },
    )

    expect(message).toBe('\u95C7\u306E\u5C01\u5370\u304C\u7583\u304F\u{1F60F}\u2728\u{1F525}')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries social replies until they stop parroting the viewer', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'

    const replies = [
      'こんにちは',
      'thanks',
      '深淵はもう観測済みだ',
    ]
    const fetchMock = vi.fn(async () => {
      const content = replies.shift() ?? ''
      return new Response(JSON.stringify({
        message: { content },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    orchestrator.delayPublicSpeakRetry = vi.fn(async () => {})

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Reply to viewer',
      undefined,
      [
        'viewer message received',
        'social-source=youtube-chat',
        'social-author=@alice',
        'social-snippet=こんにちは',
      ].join(' | '),
      { mode: 'default' },
    )

    expect(message).toBe('深淵はもう観測済みだ')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries ollama public speech with a larger token budget after thinking-only responses', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'

    const seenBudgets: number[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      expect(payload.think).toBe(false)
      seenBudgets.push(payload.options.num_predict)
      const firstAttempt = seenBudgets.length === 1
      return new Response(JSON.stringify({
        message: {
          content: firstAttempt ? '' : '\u6DF1\u6DF5\u306F\u307E\u3060\u71C3\u3048\u3066\u3044\u308B\u{1F60F}\u{1F525}\u{1F525}',
          thinking: firstAttempt ? 'long internal reasoning without final line yet' : '',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    orchestrator.delayPublicSpeakRetry = vi.fn(async () => {})

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Craft a crafting table',
      undefined,
      'goal=crafting_table | action=move',
      { mode: 'periodic-progress' },
    )

    expect(message).toBe('\u6DF1\u6DF5\u306F\u307E\u3060\u71C3\u3048\u3066\u3044\u308B\u{1F60F}\u{1F525}\u{1F525}')
    expect(seenBudgets).toEqual([64, 128])
  })

  it('returns the last llm commentary line when style filters reject every attempt', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: {
        content: '木を集めるために移動しています',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    orchestrator.delayPublicSpeakRetry = vi.fn(async () => {})

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Gather wood and craft a crafting table',
      undefined,
      'goal=wood | action=move',
      { mode: 'periodic-progress' },
    )

    expect(message).toBe('木を集めるために移動しています')
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('runs a final rescue llm pass after repeated thinking-only commentary responses', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'

    let callCount = 0
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      callCount += 1
      const payload = JSON.parse(String(init?.body))
      expect(payload.think).toBe(false)
      const isRescue = JSON.stringify(payload.messages).includes('Rewrite it into one short final line only.')
      return new Response(JSON.stringify({
        message: {
          content: isRescue ? '封印解除、木材確保の刻だ' : '',
          thinking: isRescue ? '' : 'draft: gathering wood and turning it into a dramatic spoken line',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    orchestrator.delayPublicSpeakRetry = vi.fn(async () => {})

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Gather wood and craft a crafting table',
      undefined,
      'goal=wood | action=move',
      { mode: 'periodic-progress' },
    )

    expect(message).toBe('\u5C01\u5370\u89E3\u9664\u3001\u6728\u6750\u78BA\u4FDD\u306E\u523B\u3060')
    expect(callCount).toBe(7)
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes('Rewrite it into one short final line only.'))).toBe(true)
  })

  it('rescues blank keepalive-style commentary with one final llm pass before giving up', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'
    config.speechLlm.publicSpeakModel = 'gemma4:e2b'

    let callCount = 0
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      callCount += 1
      const payload = JSON.parse(String(init?.body))
      expect(payload.think).toBe(false)
      const prompt = JSON.stringify(payload.messages)
      const isRescue = prompt.includes('Compose one short final spoken line directly from the goal and internal memo.')
      return new Response(JSON.stringify({
        message: {
          content: isRescue ? '木霊奔流、封印採取の刻だ😏✨🔥' : '',
          thinking: '',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    orchestrator.delayPublicSpeakRetry = vi.fn(async () => {})

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Gather wood and craft a crafting table',
      'voiced-keepalive',
      'goal=wood | action=move | phase=voiced-keepalive',
      { mode: 'periodic-progress', maxAttempts: 1, skipRescue: false },
    )

    expect(message).toBe('木霊奔流、封印採取の刻だ😏✨🔥')
    expect(callCount).toBe(2)
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes('Compose one short final spoken line directly from the goal and internal memo.'))).toBe(true)
  })

  it('preserves emoji-heavy chuuni commentary after sanitization', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'

    const content = '\u304F\u304F\u304F\u2026\u2026\u53F3\u624B\u304C\u75BC\u304F\u{1F60F}\u2728\u{1F525}\u{1F525}'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: {
        content,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    orchestrator.delayPublicSpeakRetry = vi.fn(async () => {})

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Gather wood and craft a crafting table',
      undefined,
      'goal=wood | action=move',
      { mode: 'periodic-progress' },
    )

    expect(message).toBe(content)
  })

  it('requests a named technique every few gameplay commentary lines', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      const prompt = JSON.stringify(payload.messages)
      expect(prompt).toContain('named_technique_required: yes')
      expect(prompt).toContain('A named special move is mandatory in this line.')

      return new Response(JSON.stringify({
        message: {
          content: '\u5C01\u5370\u89E3\u653E\u300C\u30B8\u30E3\u30C3\u30B8\u30E1\u30F3\u30C8\u30CA\u30A4\u30C8\u30AA\u30D6\u30B5\u30F3\u30C0\u30FC\u300D\u3060\u30C3\u{1F525}\u{1F525}',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    orchestrator.nonSocialPublicSpeechCount = 4
    orchestrator.delayPublicSpeakRetry = vi.fn(async () => {})

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Gather wood and craft a crafting table',
      undefined,
      'goal=wood | action=move',
      { mode: 'periodic-progress' },
    )

    expect(message).toContain('\u30B8\u30E3\u30C3\u30B8\u30E1\u30F3\u30C8')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats plain explanatory progress narration as mechanical', () => {
    const orchestrator = createOrchestrator() as any

    expect(orchestrator.isMechanicalProgressNarration('まずは木材を集めて、作業台を作りましょう。')).toBe(true)
  })

  it('detects parroted social replies', () => {
    const orchestrator = createOrchestrator() as any

    expect(orchestrator.isSocialReplyParrot('南西案、いいね！', '南西案、いいね！')).toBe(true)
    expect(orchestrator.isSocialReplyParrot('@alice こんにちは', 'こんにちは')).toBe(true)
    expect(orchestrator.isSocialReplyParrot('南西で行くね、石を優先する。', '南西案、いいね！')).toBe(false)
  })
})
