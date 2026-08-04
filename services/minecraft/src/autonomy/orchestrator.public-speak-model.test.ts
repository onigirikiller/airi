import { afterEach, describe, expect, it, vi } from 'vitest'

import { config } from '../composables/config'
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
const originalGeminiSpeechConfig = { ...config.geminiSpeech }

afterEach(() => {
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
  config.geminiSpeech.apiKey = originalGeminiSpeechConfig.apiKey
  config.geminiSpeech.baseUrl = originalGeminiSpeechConfig.baseUrl
  config.geminiSpeech.model = originalGeminiSpeechConfig.model
  config.geminiSpeech.liveModel = originalGeminiSpeechConfig.liveModel
  config.geminiSpeech.liveSpeechEnabled = originalGeminiSpeechConfig.liveSpeechEnabled
  config.geminiSpeech.liveSpeechModel = originalGeminiSpeechConfig.liveSpeechModel
  config.geminiSpeech.liveSpeechLanguageCode = originalGeminiSpeechConfig.liveSpeechLanguageCode
  config.geminiSpeech.liveSpeechVoiceName = originalGeminiSpeechConfig.liveSpeechVoiceName
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('autonomous stream orchestrator public speak model routing', () => {
  it('uses the lighter public speak model for gameplay commentary', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'
    config.speechLlm.publicSpeakModel = 'gemma4:e2b'

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      expect(payload.model).toBe('gemma4:e2b')
      return new Response(JSON.stringify({
        message: {
          content: 'くくく……創世の儀は加速するッ🔥',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Craft a crafting table',
      undefined,
      'goal=crafting_table | action=move',
      { mode: 'default' },
    )

    expect(message).toContain('創世')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps social replies on the primary model', async () => {
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'
    config.speechLlm.publicSpeakModel = 'gemma4:e2b'

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      expect(payload.model).toBe('gemma4:e4b')
      return new Response(JSON.stringify({
        message: {
          content: 'くくく……その呼び声、我が深淵に届いたぞッ😏',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Reply to viewer',
      undefined,
      [
        'viewer message received',
        'social-source=youtube-chat',
        'social-author=@alice',
        'social-snippet=hello',
      ].join(' | '),
      { mode: 'default' },
    )

    expect(message).toContain('深淵')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('routes gameplay commentary through Gemini native API when requested', async () => {
    config.publicSpeak.provider = 'gemini'
    config.geminiSpeech.apiKey = 'gemini-key'
    config.geminiSpeech.baseUrl = 'https://generativelanguage.googleapis.com'
    config.geminiSpeech.model = 'gemini-2.5-flash'

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/models/gemini-2.5-flash:generateContent?key=gemini-key')
      const payload = JSON.parse(String(init?.body))
      expect(payload.generationConfig.maxOutputTokens).toBe(64)
      expect(JSON.stringify(payload.contents)).toContain('scene_memo: goal=crafting_table')

      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{ text: '封印解除、創世炉は回り出したッ🔥' }],
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Craft a crafting table',
      undefined,
      'goal=crafting_table | action=move',
      { mode: 'default' },
    )

    expect(message).toContain('創世炉')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats Google OpenAI-compatible speech endpoints as chat completions and normalizes hosted Gemma aliases', async () => {
    config.publicSpeak.provider = 'llm'
    config.speechLlm.apiKey = 'google-key'
    config.speechLlm.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/'
    config.speechLlm.model = 'Gemma 4 26B'
    config.speechLlm.publicSpeakModel = 'Gemma 4 26B'

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer google-key' })
      const payload = JSON.parse(String(init?.body))
      expect(payload.model).toBe('gemma-4-26b-a4b-it')

      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '<thought>hidden</thought>封印解除、刻印炉は回るッ🔥',
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const orchestrator = createOrchestrator() as any
    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Craft a crafting table',
      undefined,
      'goal=crafting_table | action=move',
      { mode: 'default' },
    )

    expect(message).toContain('刻印炉')
    expect(message).not.toContain('hidden')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('adds continuity-focused gameplay context so commentary can follow the ongoing stream', async () => {
    config.publicSpeak.provider = 'llm'
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'
    config.speechLlm.publicSpeakModel = 'gemma4:e2b'

    const orchestrator = createOrchestrator() as any
    orchestrator.bot.memory.actions = [
      { name: 'searchForBlock' },
      { name: 'collectBlocks' },
    ]
    orchestrator.bot.memory.chatHistory = [
      { role: 'user', content: '鉄出ねーよってみんな言ってるぞ' },
      { role: 'assistant', content: 'まだ終わらん……この深淵は我が穿つ' },
      { role: 'user', content: 'ダイヤ早く' },
    ]
    orchestrator.currentReplyContext = {
      speechText: '鉄が出たらすぐ剣まで持っていくぞ',
      replyToCommentId: '',
      updatedAt: Date.now(),
    }
    orchestrator.recentPublicSpeeches = [
      { text: '因果の乱れを断ち切るぞ', at: Date.now(), kind: 'game' },
      { text: '因果の壁など砕くのみだ', at: Date.now(), kind: 'game' },
      { text: '鉄が出たら剣まで一気に行く', at: Date.now(), kind: 'game' },
    ]

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      const prompt = JSON.stringify(payload.messages)
      expect(prompt).toContain('recent_viewer_messages: 鉄出ねーよってみんな言ってるぞ || ダイヤ早く')
      expect(prompt).toContain('recent_streamer_lines:')
      expect(prompt).toContain('stream_memory:')
      expect(prompt).toContain('continuity_rule:')
      expect(prompt).toContain('avoid_reusing_motifs: 因果')
      expect(prompt).toContain('gameplay_priority: state at least one concrete gameplay beat')
      return new Response(JSON.stringify({
        message: {
          content: '鉄が見えたらすぐ剣だ。さっきの煽りはまとめて返してやる😏',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Mine iron ore',
      'goal-progress',
      'goal=iron | action=mine | obstacle=stone',
      { mode: 'periodic-progress' },
    )

    expect(message).toContain('鉄')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('allows idle callbacks while avoiding repeated openings during stalled commentary', async () => {
    config.publicSpeak.provider = 'llm'
    config.speechLlm.apiKey = ''
    config.speechLlm.baseUrl = 'http://localhost:11434/v1'
    config.speechLlm.model = 'gemma4:e4b'
    config.speechLlm.publicSpeakModel = 'gemma4:e2b'

    const orchestrator = createOrchestrator() as any
    orchestrator.bot.memory.actions = [
      { name: 'move' },
      { name: 'move' },
      { name: 'move' },
    ]
    orchestrator.bot.memory.chatHistory = [
      { role: 'user', content: 'また鉄出ねーのかよ' },
      { role: 'assistant', content: 'まだ掘る。ここで折れるほど安くない' },
    ]
    orchestrator.currentReplyContext = {
      speechText: 'さっきの煽りは覚えてるぞ',
      replyToCommentId: '',
      updatedAt: Date.now(),
    }
    orchestrator.recentPublicSpeeches = [
      { text: 'くくく……まだ終わらん', at: Date.now(), kind: 'game' },
      { text: 'くくく……石ごと穿つ', at: Date.now(), kind: 'game' },
      { text: 'くくく……鉄まで通す', at: Date.now(), kind: 'game' },
    ]

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      const prompt = JSON.stringify(payload.messages)
      expect(prompt).toContain('tempo_state: stalled')
      expect(prompt).toContain('idle_banter_rule:')
      expect(prompt).toContain('callback_candidates:')
      expect(prompt).toContain('recent_openings_to_avoid: くくく')
      expect(prompt).toContain('style_rotation_rule:')
      return new Response(JSON.stringify({
        message: {
          content: 'さっきの煽りは預けとけ。鉄が見えた瞬間まとめて返す😏',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as any

    const message = await orchestrator.generatePublicSpeakFromIntent(
      'Mine iron ore',
      'periodic-idle-stream',
      'goal=iron | action=move | obstacle=stone | changed_since_last: none',
      { mode: 'periodic-idle' },
    )

    expect(message).toContain('鉄')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
