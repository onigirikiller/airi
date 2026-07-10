import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { config } from '../../composables/config'
import { withSerializedGpuTask } from '../gpu-coordinator'
import { __resetOutputVoiceStateForTest, publishAssistantMessageToAiri } from './output'

function flushMicrotasks() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('publishAssistantMessageToAiri', () => {
  beforeEach(() => {
    __resetOutputVoiceStateForTest()
  })

  it('sends assistant text event when gemini live speech is disabled', async () => {
    config.gemini.liveSpeechEnabled = false
    config.gemini.apiKey = ''

    const send = vi.fn()
    publishAssistantMessageToAiri({ send } as any, '  hello world  ')

    await flushMicrotasks()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: 'output:gen-ai:chat:message',
      data: {
        message: {
          role: 'assistant',
          content: 'hello world',
        },
      },
    })
  })

  it('writes latest subtitle text file for OBS when enabled', async () => {
    const previousSubtitleEnabled = config.subtitle.enabled
    const previousSubtitleFilePath = config.subtitle.filePath

    const tempDir = await mkdtemp(join(tmpdir(), 'airi-subtitle-test-'))
    const subtitleFile = join(tempDir, 'subtitle.txt')

    config.subtitle.enabled = true
    config.subtitle.filePath = subtitleFile

    try {
      const send = vi.fn()
      publishAssistantMessageToAiri({ send } as any, '字幕テストです')
      await flushMicrotasks()
      await sleep(20)

      const text = await readFile(subtitleFile, 'utf8')
      expect(text.trim()).toBe('字幕テストです')
    }
    finally {
      config.subtitle.enabled = previousSubtitleEnabled
      config.subtitle.filePath = previousSubtitleFilePath
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('writes subtitle file even when AIRI client is unavailable', async () => {
    const previousSubtitleEnabled = config.subtitle.enabled
    const previousSubtitleFilePath = config.subtitle.filePath

    const tempDir = await mkdtemp(join(tmpdir(), 'airi-subtitle-test-no-client-'))
    const subtitleFile = join(tempDir, 'subtitle.txt')

    config.subtitle.enabled = true
    config.subtitle.filePath = subtitleFile

    try {
      publishAssistantMessageToAiri(undefined, 'クライアントなし字幕テスト')
      await flushMicrotasks()
      await sleep(20)

      const text = await readFile(subtitleFile, 'utf8')
      expect(text.trim()).toBe('クライアントなし字幕テスト')
    }
    finally {
      config.subtitle.enabled = previousSubtitleEnabled
      config.subtitle.filePath = previousSubtitleFilePath
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('wraps subtitle text into multiple lines based on OBS subtitle settings', async () => {
    const previousSubtitleEnabled = config.subtitle.enabled
    const previousSubtitleFilePath = config.subtitle.filePath
    const previousMaxChars = config.subtitle.maxCharsPerLine
    const previousMaxLines = config.subtitle.maxLines

    const tempDir = await mkdtemp(join(tmpdir(), 'airi-subtitle-wrap-test-'))
    const subtitleFile = join(tempDir, 'subtitle.txt')

    config.subtitle.enabled = true
    config.subtitle.filePath = subtitleFile
    config.subtitle.maxCharsPerLine = 10
    config.subtitle.maxLines = 3

    try {
      const send = vi.fn()
      publishAssistantMessageToAiri({ send } as any, 'これは字幕の自動改行テストです。なるべく自然に折り返して表示します。')
      await flushMicrotasks()
      await sleep(20)

      const text = await readFile(subtitleFile, 'utf8')
      const lines = text.trim().split('\n')
      expect(lines.length).toBeGreaterThan(1)
      expect(lines.length).toBeLessThanOrEqual(3)
    }
    finally {
      config.subtitle.enabled = previousSubtitleEnabled
      config.subtitle.filePath = previousSubtitleFilePath
      config.subtitle.maxCharsPerLine = previousMaxChars
      config.subtitle.maxLines = previousMaxLines
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('skips empty message payload', async () => {
    const send = vi.fn()
    publishAssistantMessageToAiri({ send } as any, '   ')
    await flushMicrotasks()
    expect(send).not.toHaveBeenCalled()
  })

  it('suppresses low-priority voice while previous speech is still in busy window', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/audio_query')) {
        return new Response(JSON.stringify({ accent_phrases: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/synthesis')) {
        const wav = new Uint8Array([
          82,
          73,
          70,
          70,
          36,
          0,
          0,
          0,
          87,
          65,
          86,
          69,
          102,
          109,
          116,
          32,
          16,
          0,
          0,
          0,
          1,
          0,
          1,
          0,
          64,
          31,
          0,
          0,
          128,
          62,
          0,
          0,
          2,
          0,
          16,
          0,
          100,
          97,
          116,
          97,
          0,
          0,
          0,
          0,
        ])
        return new Response(wav, {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const previousLiveSpeechEnabled = config.gemini.liveSpeechEnabled
    const previousGeminiApiKey = config.gemini.apiKey
    const previousLocalTtsEnabled = config.localTts.enabled
    const previousLocalTtsProvider = config.localTts.provider
    const previousLocalTtsBaseUrl = config.localTts.baseUrl

    config.gemini.liveSpeechEnabled = false
    config.gemini.apiKey = ''
    config.localTts.enabled = true
    config.localTts.provider = 'voicevox'
    config.localTts.baseUrl = 'http://127.0.0.1:50021'
    globalThis.fetch = fetchMock as any

    try {
      const send = vi.fn()
      publishAssistantMessageToAiri({ send } as any, '最初の発話です', undefined, { voiceMode: 'on', voicePriority: 'low' })
      publishAssistantMessageToAiri({ send } as any, '二つ目の発話です', undefined, { voiceMode: 'on', voicePriority: 'low' })

      await sleep(80)

      expect(send).toHaveBeenCalledTimes(2)
      const firstPayload = send.mock.calls[0]?.[0]
      const secondPayload = send.mock.calls[1]?.[0]

      expect(firstPayload?.data?.voice).toBeDefined()
      expect(secondPayload?.data?.voice).toBeUndefined()
    }
    finally {
      config.gemini.liveSpeechEnabled = previousLiveSpeechEnabled
      config.gemini.apiKey = previousGeminiApiKey
      config.localTts.enabled = previousLocalTtsEnabled
      config.localTts.provider = previousLocalTtsProvider
      config.localTts.baseUrl = previousLocalTtsBaseUrl
      globalThis.fetch = originalFetch
    }
  })

  it('attaches local style-bert-vits2 voice payload when provider is style-bert-vits2', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/voice?')) {
        const wav = new Uint8Array([
          82,
          73,
          70,
          70,
          36,
          0,
          0,
          0,
          87,
          65,
          86,
          69,
          102,
          109,
          116,
          32,
          16,
          0,
          0,
          0,
          1,
          0,
          1,
          0,
          64,
          31,
          0,
          0,
          128,
          62,
          0,
          0,
          2,
          0,
          16,
          0,
          100,
          97,
          116,
          97,
          0,
          0,
          0,
          0,
        ])
        return new Response(wav, {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const previousLiveSpeechEnabled = config.gemini.liveSpeechEnabled
    const previousGeminiApiKey = config.gemini.apiKey
    const previousLocalTtsEnabled = config.localTts.enabled
    const previousLocalTtsProvider = config.localTts.provider
    const previousLocalTtsBaseUrl = config.localTts.baseUrl

    config.gemini.liveSpeechEnabled = false
    config.gemini.apiKey = ''
    config.localTts.enabled = true
    config.localTts.provider = 'style-bert-vits2'
    config.localTts.baseUrl = 'http://127.0.0.1:5000'
    globalThis.fetch = fetchMock as any

    try {
      const send = vi.fn()
      publishAssistantMessageToAiri({ send } as any, 'style bert test', undefined, { voiceMode: 'on', voicePriority: 'high' })
      await sleep(80)

      expect(send).toHaveBeenCalledTimes(1)
      const payload = send.mock.calls[0]?.[0]
      expect(payload?.data?.voice).toBeDefined()
      expect(payload?.data?.voice?.provider).toBe('local-tts')
      expect(payload?.data?.voice?.model).toContain('style-bert-vits2')
      expect(payload?.data?.voice?.mimeType).toContain('audio')
    }
    finally {
      config.gemini.liveSpeechEnabled = previousLiveSpeechEnabled
      config.gemini.apiKey = previousGeminiApiKey
      config.localTts.enabled = previousLocalTtsEnabled
      config.localTts.provider = previousLocalTtsProvider
      config.localTts.baseUrl = previousLocalTtsBaseUrl
      globalThis.fetch = originalFetch
    }
  })

  it('attaches local irodori-tts voice payload and forwards caption/checkpoint', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/voice?')) {
        const wav = new Uint8Array([
          82,
          73,
          70,
          70,
          36,
          0,
          0,
          0,
          87,
          65,
          86,
          69,
          102,
          109,
          116,
          32,
          16,
          0,
          0,
          0,
          1,
          0,
          1,
          0,
          64,
          31,
          0,
          0,
          128,
          62,
          0,
          0,
          2,
          0,
          16,
          0,
          100,
          97,
          116,
          97,
          0,
          0,
          0,
          0,
        ])
        return new Response(wav, {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const previousLiveSpeechEnabled = config.gemini.liveSpeechEnabled
    const previousGeminiApiKey = config.gemini.apiKey
    const previousLocalTtsEnabled = config.localTts.enabled
    const previousLocalTtsProvider = config.localTts.provider
    const previousLocalTtsBaseUrl = config.localTts.baseUrl
    const previousIrodoriEndpointPath = config.localTts.irodoriEndpointPath
    const previousIrodoriHfCheckpoint = config.localTts.irodoriHfCheckpoint
    const previousIrodoriCaption = config.localTts.irodoriCaption

    config.gemini.liveSpeechEnabled = false
    config.gemini.apiKey = ''
    config.localTts.enabled = true
    config.localTts.provider = 'irodori-tts'
    config.localTts.baseUrl = 'http://127.0.0.1:5000'
    config.localTts.irodoriEndpointPath = '/voice'
    config.localTts.irodoriHfCheckpoint = 'Aratako/Irodori-TTS-500M-v2-VoiceDesign'
    config.localTts.irodoriCaption = '高校生くらいの若い声で、テンションは非常に高い'
    globalThis.fetch = fetchMock as any

    try {
      const send = vi.fn()
      publishAssistantMessageToAiri({ send } as any, 'くくく……封印が解けたぞ😏⚡', undefined, { voiceMode: 'on', voicePriority: 'high' })
      await sleep(80)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const requestedUrl = String(fetchMock.mock.calls[0]?.[0] || '')
      expect(requestedUrl).toContain('/voice?')
      expect(requestedUrl).toContain(encodeURIComponent('Aratako/Irodori-TTS-500M-v2-VoiceDesign'))
      expect(requestedUrl).toContain(encodeURIComponent('高校生くらいの若い声で、テンションは非常に高い'))

      expect(send).toHaveBeenCalledTimes(1)
      const payload = send.mock.calls[0]?.[0]
      expect(payload?.data?.voice).toBeDefined()
      expect(payload?.data?.voice?.provider).toBe('local-tts')
      expect(payload?.data?.voice?.model).toContain('irodori-tts')
      expect(payload?.data?.voice?.mimeType).toContain('audio')
    }
    finally {
      config.gemini.liveSpeechEnabled = previousLiveSpeechEnabled
      config.gemini.apiKey = previousGeminiApiKey
      config.localTts.enabled = previousLocalTtsEnabled
      config.localTts.provider = previousLocalTtsProvider
      config.localTts.baseUrl = previousLocalTtsBaseUrl
      config.localTts.irodoriEndpointPath = previousIrodoriEndpointPath
      config.localTts.irodoriHfCheckpoint = previousIrodoriHfCheckpoint
      config.localTts.irodoriCaption = previousIrodoriCaption
      globalThis.fetch = originalFetch
    }
  })

  it('bypasses the shared gpu queue when local irodori tts is configured for cpu execution', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/voice?')) {
        const wav = new Uint8Array([
          82,
          73,
          70,
          70,
          36,
          0,
          0,
          0,
          87,
          65,
          86,
          69,
          102,
          109,
          116,
          32,
          16,
          0,
          0,
          0,
          1,
          0,
          1,
          0,
          64,
          31,
          0,
          0,
          128,
          62,
          0,
          0,
          2,
          0,
          16,
          0,
          100,
          97,
          116,
          97,
          0,
          0,
          0,
          0,
        ])
        return new Response(wav, {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const previousLiveSpeechEnabled = config.gemini.liveSpeechEnabled
    const previousGeminiApiKey = config.gemini.apiKey
    const previousLocalTtsEnabled = config.localTts.enabled
    const previousLocalTtsProvider = config.localTts.provider
    const previousLocalTtsBaseUrl = config.localTts.baseUrl
    const previousLocalTtsSerializeWithGpu = config.localTts.serializeWithGpu

    config.gemini.liveSpeechEnabled = false
    config.gemini.apiKey = ''
    config.localTts.enabled = true
    config.localTts.provider = 'irodori-tts'
    config.localTts.baseUrl = 'http://127.0.0.1:5000'
    config.localTts.serializeWithGpu = false
    globalThis.fetch = fetchMock as any

    let releaseBlocker: (() => void) | undefined
    const blocker = withSerializedGpuTask('test:gpu-blocker', undefined, async () => {
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve
      })
    })

    try {
      const send = vi.fn()
      publishAssistantMessageToAiri({ send } as any, 'CPU TTS should not wait for the GPU queue', undefined, {
        voiceMode: 'on',
        voicePriority: 'high',
      })
      await sleep(80)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[0]?.data?.voice?.provider).toBe('local-tts')
    }
    finally {
      releaseBlocker?.()
      await blocker
      config.gemini.liveSpeechEnabled = previousLiveSpeechEnabled
      config.gemini.apiKey = previousGeminiApiKey
      config.localTts.enabled = previousLocalTtsEnabled
      config.localTts.provider = previousLocalTtsProvider
      config.localTts.baseUrl = previousLocalTtsBaseUrl
      config.localTts.serializeWithGpu = previousLocalTtsSerializeWithGpu
      globalThis.fetch = originalFetch
    }
  })

  it('reports the estimated voice end when local tts attaches audio', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/voice?')) {
        const wav = new Uint8Array([
          82,
          73,
          70,
          70,
          36,
          0,
          0,
          0,
          87,
          65,
          86,
          69,
          102,
          109,
          116,
          32,
          16,
          0,
          0,
          0,
          1,
          0,
          1,
          0,
          64,
          31,
          0,
          0,
          128,
          62,
          0,
          0,
          2,
          0,
          16,
          0,
          100,
          97,
          116,
          97,
          0,
          0,
          0,
          0,
        ])
        return new Response(wav, {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const previousLiveSpeechEnabled = config.gemini.liveSpeechEnabled
    const previousGeminiApiKey = config.gemini.apiKey
    const previousLocalTtsEnabled = config.localTts.enabled
    const previousLocalTtsProvider = config.localTts.provider
    const previousLocalTtsBaseUrl = config.localTts.baseUrl

    config.gemini.liveSpeechEnabled = false
    config.gemini.apiKey = ''
    config.localTts.enabled = true
    config.localTts.provider = 'irodori-tts'
    config.localTts.baseUrl = 'http://127.0.0.1:5000'
    globalThis.fetch = fetchMock as any

    try {
      const send = vi.fn()
      const onVoiceAttached = vi.fn()
      const startedAt = Date.now()

      publishAssistantMessageToAiri({ send } as any, '封印解除の刻だ😏✨🔥', undefined, {
        voiceMode: 'on',
        voicePriority: 'high',
        onVoiceAttached,
      })
      await sleep(80)

      expect(onVoiceAttached).toHaveBeenCalledTimes(1)
      expect(onVoiceAttached).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'local-tts',
        model: expect.stringContaining('irodori-tts'),
        mimeType: expect.stringContaining('audio'),
        estimatedEndAt: expect.any(Number),
      }))
      expect(onVoiceAttached.mock.calls[0]?.[0]?.estimatedEndAt).toBeGreaterThan(startedAt + 3_000)
    }
    finally {
      config.gemini.liveSpeechEnabled = previousLiveSpeechEnabled
      config.gemini.apiKey = previousGeminiApiKey
      config.localTts.enabled = previousLocalTtsEnabled
      config.localTts.provider = previousLocalTtsProvider
      config.localTts.baseUrl = previousLocalTtsBaseUrl
      globalThis.fetch = originalFetch
    }
  })
})

describe('measureVoicePlaybackMs', () => {
  it('reads exact duration from a WAV header', async () => {
    const { measureVoicePlaybackMs } = await import('./output')
    // 1 second of 24kHz 16-bit mono PCM: byteRate 48000, data 48000 bytes.
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + 48_000, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(24_000, 24)
    header.writeUInt32LE(48_000, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(48_000, 40)
    const wav = Buffer.concat([header, Buffer.alloc(48_000)])

    const ms = measureVoicePlaybackMs({
      provider: 'local-tts',
      model: 'test',
      mimeType: 'audio/wav',
      audio: wav.toString('base64'),
    }, 'こんにちは')

    expect(ms).toBe(1000)
  })

  it('falls back to the character estimate for non-WAV payloads', async () => {
    const { measureVoicePlaybackMs } = await import('./output')
    const ms = measureVoicePlaybackMs({
      provider: 'local-tts',
      model: 'test',
      mimeType: 'audio/mpeg',
      audio: Buffer.from('not-a-wav').toString('base64'),
    }, 'あ'.repeat(50))

    expect(ms).toBe(5000)
  })
})
