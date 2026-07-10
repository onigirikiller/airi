import type { Client } from '@proj-airi/server-sdk'

import type { Logger } from '../../utils/logger'

import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { getActiveTtsStyleHint } from '../../autonomy/emotion'
import { config } from '../../composables/config'
import { withSerializedGpuTask } from '../gpu-coordinator'
import { emitFallbackMonitor } from '../monitor-event-bus'
import { getPresentationScheduler } from './presentation-scheduler'

export interface OutputVoicePayload {
  provider: 'gemini-live' | 'gemini-http' | 'local-tts'
  model: string
  mimeType: string
  audio: string
}

type VoiceMode = 'auto' | 'on' | 'off'
type VoicePriority = 'high' | 'normal' | 'low'

export interface PublishAssistantMessageOptions {
  voiceMode?: VoiceMode
  voicePriority?: VoicePriority
  /**
   * Game-time timestamp of the moment this speech reacts to. The output is
   * released when the delayed stream video shows that moment
   * (STREAM_VIDEO_DELAY_MS). Defaults to "now".
   */
  eventAt?: number
  /** Drop the output when it would release later than this past its slot. */
  maxLatenessMs?: number
  onVoiceAttached?: (payload: {
    estimatedEndAt: number
    provider: OutputVoicePayload['provider']
    model: string
    mimeType: string
  }) => void
  onPlaybackStart?: () => void
}

interface GeminiLiveSessionLike {
  sendClientContent: (payload: Record<string, unknown>) => void
  close?: () => void
}

interface GeminiCloseEventLike {
  code?: number
  reason?: string
}

interface LiveSpeechRequest {
  chunks: Uint8Array[]
  state: { mimeType?: string }
  timer: ReturnType<typeof setTimeout>
  settle: (payload?: OutputVoicePayload, error?: unknown) => void
}

interface GeminiModuleLike {
  GoogleGenAI?: new (options: Record<string, unknown>) => {
    live?: {
      connect: (params: Record<string, unknown>) => Promise<GeminiLiveSessionLike>
    }
    models?: {
      generateContent?: (params: Record<string, unknown>) => Promise<any>
    }
  }
  Modality?: {
    AUDIO?: string
  }
}

let highPriorityQueue: Promise<void> = Promise.resolve()
let normalQueue: Promise<void> = Promise.resolve()
const unavailableGeminiLiveModels = new Set<string>()
const unavailableGeminiHttpSpeechModels = new Set<string>()
const geminiHttpSpeechFallbackModels = [
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
]
const VOICE_FAILURE_BASE_BACKOFF_MS = 5_000
const VOICE_FAILURE_MAX_BACKOFF_MS = 120_000
const VOICE_BACKOFF_LOG_INTERVAL_MS = 30_000
const VOICE_FAILURE_STREAK_FOR_MUTE = 3
const LOCAL_TTS_FAILURE_BASE_BACKOFF_MS = 10_000
const LOCAL_TTS_FAILURE_MAX_BACKOFF_MS = 180_000
const LOCAL_TTS_BACKOFF_LOG_INTERVAL_MS = 30_000
const LOCAL_TTS_FAILURE_STREAK_FOR_MUTE = 2
const LIVE_SPEECH_REQUEST_TIMEOUT_MS = 18_000
const LIVE_SPEECH_MAX_TURNS_PER_SESSION = 24
const VOICE_PLAYBACK_MIN_GAP_MS = 600
const VOICE_PLAYBACK_CHAR_MS = 100
const VOICE_PLAYBACK_MIN_ESTIMATE_MS = 3_000
const VOICE_PLAYBACK_MAX_ESTIMATE_MS = 10_000
const VOICE_BUSY_LOG_INTERVAL_MS = 10_000

let voiceFailureStreak = 0
let voiceMutedUntil = 0
let lastVoiceBackoffLogAt = 0
let localTtsFailureStreak = 0
let localTtsMutedUntil = 0
let lastLocalTtsBackoffLogAt = 0
let liveSpeechSession: GeminiLiveSessionLike | null = null
let liveSpeechConnectPromise: Promise<GeminiLiveSessionLike> | null = null
let liveSpeechRequest: LiveSpeechRequest | null = null
let liveSpeechSessionKey = ''
let liveSpeechTurnCount = 0
let voicePlaybackBusyUntil = 0
let lastVoiceBusyLogAt = 0
let lastSubtitleWriteErrorAt = 0

const SUBTITLE_WRITE_ERROR_LOG_INTERVAL_MS = 30_000

function parseSampleRate(mimeType: string | undefined): number {
  if (!mimeType)
    return 24_000

  const match = mimeType.match(/(?:rate|sample(?:_|-)?rate)\s*=\s*(\d+)/i)
  if (!match)
    return 24_000

  const sampleRate = Number.parseInt(match[1], 10)
  return Number.isNaN(sampleRate) ? 24_000 : sampleRate
}

function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Buffer<ArrayBuffer> {
  const pcmBuffer = Buffer.from(pcm)
  const channelCount = 1
  const bitsPerSample = 16
  const blockAlign = channelCount * (bitsPerSample / 8)
  const byteRate = sampleRate * blockAlign
  const dataSize = pcmBuffer.length
  const header = Buffer.alloc(44)

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channelCount, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.from(Buffer.concat([header, pcmBuffer]))
}

function normalizeAudioPayload(buffers: Uint8Array[], inputMimeType: string | undefined, model: string): OutputVoicePayload | undefined {
  if (buffers.length === 0)
    return undefined

  let payload: Buffer<ArrayBuffer> = Buffer.concat(buffers)
  let mimeType = inputMimeType?.trim() || 'audio/pcm;rate=24000'
  const lowerMimeType = mimeType.toLowerCase()

  if (lowerMimeType.includes('audio/pcm') || lowerMimeType.includes('audio/l16')) {
    payload = pcm16ToWav(payload, parseSampleRate(mimeType))
    mimeType = 'audio/wav'
  }

  return {
    provider: 'gemini-live',
    model,
    mimeType,
    audio: payload.toString('base64'),
  }
}

function isGeminiOpenAICompatibleBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  if (!normalized) {
    return false
  }
  if (normalized.includes('generativelanguage.googleapis.com')) {
    return false
  }

  return normalized.endsWith('/openai')
    || normalized.endsWith('/openai/v1')
    || normalized.endsWith('/v1')
}

function isLikelyGeminiLiveModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return normalized.includes('gemini-live')
    || normalized.includes('-live-')
    || normalized.includes('native-audio')
}

function isLikelySpeechCapableModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return normalized.includes('tts')
    || normalized.includes('audio')
}

function buildGeminiSpeechConfig(): Record<string, unknown> {
  const speechConfig: Record<string, unknown> = {}
  const languageCode = config.gemini.liveSpeechLanguageCode.trim()
  const voiceName = config.gemini.liveSpeechVoiceName.trim()

  if (languageCode) {
    speechConfig.languageCode = languageCode
  }
  if (voiceName) {
    speechConfig.voiceConfig = {
      prebuiltVoiceConfig: {
        voiceName,
      },
    }
  }

  return speechConfig
}

function maybeCollectAudioChunk(
  data: unknown,
  mimeType: unknown,
  chunks: Uint8Array[],
  state: { mimeType?: string },
): void {
  if (typeof data !== 'string' || data.length === 0) {
    return
  }

  chunks.push(Buffer.from(data, 'base64'))
  if (!state.mimeType && typeof mimeType === 'string' && mimeType.trim()) {
    state.mimeType = mimeType.trim()
  }
}

function collectAudioChunksFromLiveMessage(
  message: any,
  chunks: Uint8Array[],
  state: { mimeType?: string },
): void {
  const parts = message?.serverContent?.modelTurn?.parts
  if (Array.isArray(parts)) {
    for (const part of parts) {
      maybeCollectAudioChunk(part?.inlineData?.data, part?.inlineData?.mimeType, chunks, state)
    }
  }

  const audioChunks = message?.serverContent?.audioChunks
  if (Array.isArray(audioChunks)) {
    for (const chunk of audioChunks) {
      maybeCollectAudioChunk(chunk?.data, chunk?.mimeType, chunks, state)
    }
  }

  maybeCollectAudioChunk(message?.data, undefined, chunks, state)
}

function buildGeminiHttpSpeechModelCandidates(): string[] {
  const candidates = new Set<string>()
  const add = (model: string | undefined) => {
    const normalized = model?.trim()
    if (!normalized) {
      return
    }
    candidates.add(normalized)
  }

  const configuredSpeechModel = config.gemini.liveSpeechModel.trim()
  if (configuredSpeechModel && !isLikelyGeminiLiveModel(configuredSpeechModel)) {
    add(configuredSpeechModel)
  }

  const configuredChatModel = config.gemini.model.trim()
  if (
    configuredChatModel
    && !isLikelyGeminiLiveModel(configuredChatModel)
    && isLikelySpeechCapableModel(configuredChatModel)
  ) {
    add(configuredChatModel)
  }

  for (const fallbackModel of geminiHttpSpeechFallbackModels) {
    add(fallbackModel)
  }

  return [...candidates]
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  return String(error)
}

function isUnsupportedModelError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()
  return message.includes('is not found for api version')
    || message.includes('not supported for bidigeneratecontent')
    || message.includes('not supported for generatecontent')
}

function normalizeVoicePayloadWithProvider(
  payload: OutputVoicePayload | undefined,
  provider: OutputVoicePayload['provider'],
): OutputVoicePayload | undefined {
  if (!payload) {
    return undefined
  }

  return {
    ...payload,
    provider,
  }
}

function shouldSuppressVoiceByContent(content: string): boolean {
  const normalized = content.trim().toLowerCase()
  if (!normalized) {
    return true
  }

  // Internal/system markers should not be spoken on stream.
  if (normalized.startsWith('auto goal:')) {
    return true
  }
  if (normalized.startsWith('自動目標:')) {
    return true
  }
  if (normalized.startsWith('spark command')) {
    return true
  }
  if (normalized.startsWith('system:') || normalized.startsWith('internal:')) {
    return true
  }

  return false
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function estimateVoicePlaybackMs(text: string): number {
  const chars = text.trim().length
  const estimated = chars * VOICE_PLAYBACK_CHAR_MS
  return clampNumber(estimated, VOICE_PLAYBACK_MIN_ESTIMATE_MS, VOICE_PLAYBACK_MAX_ESTIMATE_MS)
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  const normalized = Math.trunc(value)
  return normalized > 0 ? normalized : fallback
}

function wrapSubtitleText(content: string): string {
  const maxCharsPerLine = clampPositiveInt(config.subtitle.maxCharsPerLine, 22)
  const maxLines = clampPositiveInt(config.subtitle.maxLines, 3)
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  const punctuation = new Set(['、', '。', '，', '．', ',', '.', '！', '!', '？', '?', '…', '〜', '：', ':', '；', ';'])
  const chars = Array.from(normalized)
  const lines: string[] = []
  let index = 0

  while (index < chars.length && lines.length < maxLines) {
    const remaining = chars.length - index
    if (remaining <= maxCharsPerLine || lines.length === maxLines - 1) {
      lines.push(chars.slice(index).join('').trim())
      index = chars.length
      break
    }

    const hardCut = index + maxCharsPerLine
    const softStart = Math.max(index + Math.floor(maxCharsPerLine * 0.6), index + 1)
    let cut = -1
    for (let cursor = hardCut; cursor >= softStart; cursor--) {
      const ch = chars[cursor - 1]
      if (ch === ' ' || punctuation.has(ch)) {
        cut = cursor
        break
      }
    }
    if (cut < 0) {
      cut = hardCut
    }

    const line = chars.slice(index, cut).join('').trim()
    lines.push(line || chars.slice(index, hardCut).join(''))
    index = cut
    while (chars[index] === ' ') {
      index++
    }
  }

  if (index < chars.length && lines.length > 0) {
    const ellipsis = '…'
    const last = Array.from(lines[lines.length - 1] || '')
    if (last.length >= maxCharsPerLine) {
      lines[lines.length - 1] = `${last.slice(0, Math.max(1, maxCharsPerLine - 1)).join('')}${ellipsis}`
    }
    else {
      lines[lines.length - 1] = `${lines[lines.length - 1]}${ellipsis}`
    }
  }

  return lines.filter(Boolean).join('\n')
}

async function writeObsSubtitle(content: string, logger?: Logger): Promise<void> {
  if (!config.subtitle.enabled) {
    return
  }

  const filePath = config.subtitle.filePath.trim()
  if (!filePath) {
    return
  }

  try {
    const wrapped = wrapSubtitleText(content)
    if (!wrapped) {
      return
    }
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, `${wrapped}\n`, 'utf8')
  }
  catch (error) {
    const now = Date.now()
    if (logger && now - lastSubtitleWriteErrorAt >= SUBTITLE_WRITE_ERROR_LOG_INTERVAL_MS) {
      logger.withFields({ filePath }).withError(error).warn('Failed to write OBS subtitle file')
      lastSubtitleWriteErrorAt = now
    }
  }
}

async function parseResponseError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      const payload = await response.json() as any
      const message = payload?.error?.message || payload?.message
      if (typeof message === 'string' && message.trim()) {
        return message.trim()
      }
      return JSON.stringify(payload)
    }
    catch {
      return `${response.status} ${response.statusText}`
    }
  }

  try {
    const text = await response.text()
    return text.trim() || `${response.status} ${response.statusText}`
  }
  catch {
    return `${response.status} ${response.statusText}`
  }
}

async function generateVoicevoxVoice(text: string, logger?: Logger): Promise<OutputVoicePayload | undefined> {
  const baseUrl = config.localTts.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) {
    logger?.warn('LOCAL_TTS_BASEURL is empty, skipping local TTS generation')
    return undefined
  }

  const speaker = Math.max(0, Math.trunc(config.localTts.speaker))
  const textValue = text.trim()
  if (!textValue) {
    return undefined
  }

  const queryUrl = `${baseUrl}/audio_query?text=${encodeURIComponent(textValue)}&speaker=${speaker}`
  const queryResponse = await fetch(queryUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
    },
  })
  if (!queryResponse.ok) {
    const reason = await parseResponseError(queryResponse)
    logger?.withFields({ status: queryResponse.status, reason }).warn('VoiceVox audio_query failed')
    return undefined
  }

  const query = await queryResponse.json() as Record<string, unknown>
  query.speedScale = clampNumber(config.localTts.speedScale, 0.5, 2.0)
  query.pitchScale = clampNumber(config.localTts.pitchScale, -0.15, 0.15)
  query.intonationScale = clampNumber(config.localTts.intonationScale, 0.0, 2.0)
  query.volumeScale = clampNumber(config.localTts.volumeScale, 0.0, 2.0)

  const synthUrl = `${baseUrl}/synthesis?speaker=${speaker}`
  const synthResponse = await fetch(synthUrl, {
    method: 'POST',
    headers: {
      'accept': 'audio/wav',
      'content-type': 'application/json',
    },
    body: JSON.stringify(query),
  })
  if (!synthResponse.ok) {
    const reason = await parseResponseError(synthResponse)
    logger?.withFields({ status: synthResponse.status, reason }).warn('VoiceVox synthesis failed')
    return undefined
  }

  const audioBuffer = Buffer.from(await synthResponse.arrayBuffer())
  if (audioBuffer.byteLength === 0) {
    logger?.warn('VoiceVox synthesis returned empty audio payload')
    return undefined
  }

  return {
    provider: 'local-tts',
    model: `voicevox:${speaker}`,
    mimeType: 'audio/wav',
    audio: audioBuffer.toString('base64'),
  }
}

function normalizeLocalTtsEndpointPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) {
    return '/voice'
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  if (trimmed.startsWith('/')) {
    return trimmed
  }
  return `/${trimmed}`
}

function tryExtractAudioFromJsonPayload(payload: unknown): { audioBase64: string, mimeType?: string } | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined
  }

  const maybeAudio = (payload as any).audio
    ?? (payload as any).wav
    ?? (payload as any).data
    ?? (payload as any).audio_base64
    ?? (payload as any).audioBase64

  if (typeof maybeAudio !== 'string' || !maybeAudio.trim()) {
    return undefined
  }

  const trimmed = maybeAudio.trim()
  const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i)
  if (dataUrlMatch) {
    return {
      audioBase64: dataUrlMatch[2].trim(),
      mimeType: dataUrlMatch[1].trim(),
    }
  }

  const mimeType = typeof (payload as any).mimeType === 'string'
    ? (payload as any).mimeType.trim()
    : undefined

  return {
    audioBase64: trimmed,
    mimeType,
  }
}

async function generateStyleBertVits2Voice(text: string, logger?: Logger): Promise<OutputVoicePayload | undefined> {
  const baseUrl = config.localTts.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) {
    logger?.warn('LOCAL_TTS_BASEURL is empty, skipping local TTS generation')
    return undefined
  }

  const textValue = text.trim()
  if (!textValue) {
    return undefined
  }

  const endpointPath = normalizeLocalTtsEndpointPath(config.localTts.styleBertVits2EndpointPath)
  const endpoint = endpointPath.startsWith('http://') || endpointPath.startsWith('https://')
    ? endpointPath
    : `${baseUrl}${endpointPath}`

  const modelId = Math.max(0, Math.trunc(config.localTts.styleBertVits2ModelId))
  const speakerId = Math.max(0, Math.trunc(config.localTts.styleBertVits2SpeakerId))
  // Emotion engine hint modulates voice tone per utterance (fear -> faster,
  // surprised style, etc.). Falls back to static config when calm.
  const emotionHint = getActiveTtsStyleHint()
  const style = (emotionHint?.style ?? config.localTts.styleBertVits2Style).trim()
  const styleWeight = clampNumber(emotionHint?.styleWeight ?? config.localTts.styleBertVits2StyleWeight, 0.1, 10.0)
  const sdpRatio = clampNumber(config.localTts.styleBertVits2SdpRatio, 0.0, 1.0)
  const noise = clampNumber(config.localTts.styleBertVits2Noise, 0.0, 2.0)
  const noiseW = clampNumber(config.localTts.styleBertVits2NoiseW, 0.0, 2.0)
  const length = clampNumber(
    config.localTts.styleBertVits2Length * (emotionHint?.lengthScale ?? 1),
    0.1,
    3.0,
  )
  const language = config.localTts.styleBertVits2Language.trim()

  const query = new URLSearchParams()
  query.set('text', textValue)
  query.set('model_id', String(modelId))
  query.set('speaker_id', String(speakerId))
  if (style) {
    query.set('style', style)
  }
  query.set('style_weight', String(styleWeight))
  query.set('sdp_ratio', String(sdpRatio))
  query.set('noise', String(noise))
  query.set('noise_w', String(noiseW))
  query.set('length', String(length))
  if (language) {
    query.set('language', language)
  }

  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${query.toString()}`

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'audio/wav, audio/*;q=0.9, application/json;q=0.5',
    },
  })
  if (!response.ok) {
    const reason = await parseResponseError(response)
    logger?.withFields({ status: response.status, reason }).warn('Style-Bert-VITS2 voice generation failed')
    return undefined
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('application/json')) {
    const payload = await response.json()
    const extracted = tryExtractAudioFromJsonPayload(payload)
    if (!extracted) {
      logger?.warn('Style-Bert-VITS2 returned JSON without audio payload')
      return undefined
    }
    return {
      provider: 'local-tts',
      model: `style-bert-vits2:${modelId}:${speakerId}`,
      mimeType: extracted.mimeType || 'audio/wav',
      audio: extracted.audioBase64,
    }
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer())
  if (audioBuffer.byteLength === 0) {
    logger?.warn('Style-Bert-VITS2 returned empty audio payload')
    return undefined
  }

  return {
    provider: 'local-tts',
    model: `style-bert-vits2:${modelId}:${speakerId}`,
    mimeType: contentType || 'audio/wav',
    audio: audioBuffer.toString('base64'),
  }
}

async function runLocalTtsTask<T>(
  scope: string,
  logger: Logger | undefined,
  task: () => Promise<T>,
  priority: 'high' | 'normal' | 'low' = 'normal',
): Promise<T> {
  if (!config.localTts.serializeWithGpu) {
    return await task()
  }

  return await withSerializedGpuTask(scope, logger, task, { priority })
}

async function generateIrodoriTtsVoice(
  text: string,
  logger?: Logger,
  priority: 'high' | 'normal' | 'low' = 'normal',
): Promise<OutputVoicePayload | undefined> {
  const scope = priority === 'high' ? 'local-tts:reply.irodori' : 'local-tts:commentary.irodori'
  return await runLocalTtsTask(scope, logger, async () => {
    const baseUrl = config.localTts.baseUrl.trim().replace(/\/+$/, '')
    if (!baseUrl) {
      logger?.warn('LOCAL_TTS_BASEURL is empty, skipping local TTS generation')
      return undefined
    }

    const textValue = text.trim()
    if (!textValue) {
      return undefined
    }

    const endpointPath = normalizeLocalTtsEndpointPath(config.localTts.irodoriEndpointPath)
    const endpoint = endpointPath.startsWith('http://') || endpointPath.startsWith('https://')
      ? endpointPath
      : `${baseUrl}${endpointPath}`

    const caption = config.localTts.irodoriCaption.trim()
    const hfCheckpoint = config.localTts.irodoriHfCheckpoint.trim()
    const query = new URLSearchParams()
    query.set('text', textValue)
    if (caption) {
      query.set('caption', caption)
    }
    if (hfCheckpoint) {
      query.set('hf_checkpoint', hfCheckpoint)
    }

    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${query.toString()}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'audio/wav, audio/*;q=0.9, application/json;q=0.5',
      },
    })
    if (!response.ok) {
      const reason = await parseResponseError(response)
      logger?.withFields({ status: response.status, reason }).warn('Irodori-TTS voice generation failed')
      return undefined
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('application/json')) {
      const payload = await response.json()
      const extracted = tryExtractAudioFromJsonPayload(payload)
      if (!extracted) {
        logger?.warn('Irodori-TTS returned JSON without audio payload')
        return undefined
      }
      return {
        provider: 'local-tts',
        model: `irodori-tts:${hfCheckpoint || 'default'}`,
        mimeType: extracted.mimeType || 'audio/wav',
        audio: extracted.audioBase64,
      }
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer())
    if (audioBuffer.byteLength === 0) {
      logger?.warn('Irodori-TTS returned empty audio payload')
      return undefined
    }

    return {
      provider: 'local-tts',
      model: `irodori-tts:${hfCheckpoint || 'default'}`,
      mimeType: contentType || 'audio/wav',
      audio: audioBuffer.toString('base64'),
    }
  }, priority)
}

export async function generateLocalVoice(
  text: string,
  logger?: Logger,
  priority: 'high' | 'normal' | 'low' = 'normal',
): Promise<OutputVoicePayload | undefined> {
  if (!config.localTts.enabled) {
    return undefined
  }

  if (config.localTts.provider === 'voicevox') {
    return await generateVoicevoxVoice(text, logger)
  }

  if (config.localTts.provider === 'style-bert-vits2') {
    return await generateStyleBertVits2Voice(text, logger)
  }

  if (config.localTts.provider === 'irodori-tts') {
    return await generateIrodoriTtsVoice(text, logger, priority)
  }

  return undefined
}

function canAttemptVoiceGeneration(logger?: Logger): boolean {
  const now = Date.now()
  if (now >= voiceMutedUntil) {
    return true
  }

  if (logger && now - lastVoiceBackoffLogAt >= VOICE_BACKOFF_LOG_INTERVAL_MS) {
    logger.withFields({
      mutedUntil: new Date(voiceMutedUntil).toISOString(),
      remainingMs: voiceMutedUntil - now,
      failureStreak: voiceFailureStreak,
    }).warn('Gemini voice generation temporarily muted after repeated failures')
    lastVoiceBackoffLogAt = now
  }

  return false
}

function registerVoiceGenerationFailure(logger?: Logger): void {
  voiceFailureStreak++
  if (voiceFailureStreak < VOICE_FAILURE_STREAK_FOR_MUTE) {
    if (logger) {
      logger.withFields({
        failureStreak: voiceFailureStreak,
        muteThreshold: VOICE_FAILURE_STREAK_FOR_MUTE,
      }).warn('Gemini voice failure detected')
    }
    return
  }

  const effectiveStreak = voiceFailureStreak - VOICE_FAILURE_STREAK_FOR_MUTE + 1
  const backoff = Math.min(
    VOICE_FAILURE_MAX_BACKOFF_MS,
    VOICE_FAILURE_BASE_BACKOFF_MS * 2 ** Math.max(0, effectiveStreak - 1),
  )
  voiceMutedUntil = Date.now() + backoff

  if (logger) {
    logger.withFields({
      failureStreak: voiceFailureStreak,
      backoffMs: backoff,
    }).warn('Gemini voice failure detected, enabling temporary backoff')
  }
}

function registerVoiceGenerationSuccess(): void {
  voiceFailureStreak = 0
  voiceMutedUntil = 0
}

function canAttemptLocalTts(logger?: Logger): boolean {
  const now = Date.now()
  if (now >= localTtsMutedUntil) {
    return true
  }

  if (logger && now - lastLocalTtsBackoffLogAt >= LOCAL_TTS_BACKOFF_LOG_INTERVAL_MS) {
    logger.withFields({
      mutedUntil: new Date(localTtsMutedUntil).toISOString(),
      remainingMs: localTtsMutedUntil - now,
      failureStreak: localTtsFailureStreak,
    }).warn('Local TTS temporarily muted after repeated failures')
    lastLocalTtsBackoffLogAt = now
  }

  return false
}

function registerLocalTtsFailure(logger?: Logger, error?: unknown): void {
  localTtsFailureStreak++
  if (localTtsFailureStreak < LOCAL_TTS_FAILURE_STREAK_FOR_MUTE) {
    if (logger) {
      const errorCode = (error as any)?.cause?.code || (error as any)?.code
      logger.withFields({
        failureStreak: localTtsFailureStreak,
        muteThreshold: LOCAL_TTS_FAILURE_STREAK_FOR_MUTE,
        errorCode: typeof errorCode === 'string' ? errorCode : undefined,
      }).warn('Local TTS failure detected')
    }
    return
  }

  const effectiveStreak = localTtsFailureStreak - LOCAL_TTS_FAILURE_STREAK_FOR_MUTE + 1
  const backoff = Math.min(
    LOCAL_TTS_FAILURE_MAX_BACKOFF_MS,
    LOCAL_TTS_FAILURE_BASE_BACKOFF_MS * 2 ** Math.max(0, effectiveStreak - 1),
  )
  localTtsMutedUntil = Date.now() + backoff

  if (logger) {
    const errorCode = (error as any)?.cause?.code || (error as any)?.code
    logger.withFields({
      failureStreak: localTtsFailureStreak,
      backoffMs: backoff,
      errorCode: typeof errorCode === 'string' ? errorCode : undefined,
    }).warn('Local TTS failure detected, enabling temporary backoff')
  }
}

function registerLocalTtsSuccess(): void {
  localTtsFailureStreak = 0
  localTtsMutedUntil = 0
}

function resolveLiveSpeechSessionKey(model: string): string {
  const baseUrl = config.gemini.baseUrl.trim().replace(/\/+$/, '')
  return [
    config.gemini.apiKey,
    baseUrl,
    model,
    config.gemini.liveSpeechLanguageCode.trim(),
    config.gemini.liveSpeechVoiceName.trim(),
  ].join('::')
}

function closeLiveSpeechSession(closeSocket = true): void {
  const activeSession = liveSpeechSession
  liveSpeechSession = null
  liveSpeechConnectPromise = null
  liveSpeechSessionKey = ''
  liveSpeechTurnCount = 0
  if (!activeSession || !closeSocket) {
    return
  }

  try {
    activeSession.close?.()
  }
  catch {
    // noop
  }
}

function settleLiveSpeechRequest(payload?: OutputVoicePayload, error?: unknown): void {
  const request = liveSpeechRequest
  if (!request) {
    return
  }

  liveSpeechRequest = null
  clearTimeout(request.timer)
  request.settle(payload, error)
}

async function ensureGeminiLiveSpeechSession(
  model: string,
  logger?: Logger,
): Promise<GeminiLiveSessionLike> {
  const sessionKey = resolveLiveSpeechSessionKey(model)
  if (
    liveSpeechSession
    && (liveSpeechSessionKey !== sessionKey || liveSpeechTurnCount >= LIVE_SPEECH_MAX_TURNS_PER_SESSION)
  ) {
    closeLiveSpeechSession()
  }

  if (liveSpeechSession) {
    return liveSpeechSession
  }

  if (liveSpeechConnectPromise) {
    return liveSpeechConnectPromise
  }

  liveSpeechConnectPromise = (async () => {
    const moduleValue = await import('@google/genai') as unknown as GeminiModuleLike
    const GoogleGenAI = moduleValue.GoogleGenAI

    if (typeof GoogleGenAI !== 'function') {
      throw new TypeError('GoogleGenAI export not found for Gemini Live speech')
    }

    const liveResponseModalityAudio = moduleValue.Modality?.AUDIO || 'AUDIO'
    const baseUrl = config.gemini.baseUrl.trim().replace(/\/+$/, '')
    const useCustomBaseUrl = baseUrl.length > 0 && !baseUrl.includes('generativelanguage.googleapis.com')

    const client = new GoogleGenAI({
      apiKey: config.gemini.apiKey,
      ...(useCustomBaseUrl
        ? {
            httpOptions: {
              baseUrl,
            },
          }
        : {}),
    })
    const liveClient = client.live
    if (!liveClient || typeof liveClient.connect !== 'function') {
      throw new TypeError('GoogleGenAI live.connect is unavailable for Gemini Live speech')
    }

    const speechConfig = buildGeminiSpeechConfig()
    const connected = await liveClient.connect({
      model,
      config: {
        responseModalities: [liveResponseModalityAudio],
        ...(Object.keys(speechConfig).length > 0 ? { speechConfig } : {}),
      },
      callbacks: {
        onmessage: (message: any) => {
          const request = liveSpeechRequest
          if (!request) {
            return
          }

          collectAudioChunksFromLiveMessage(message, request.chunks, request.state)

          const turnComplete = Boolean(message?.serverContent?.turnComplete)
          const generationComplete = Boolean(message?.serverContent?.generationComplete)
          if (turnComplete || generationComplete) {
            const payload = normalizeVoicePayloadWithProvider(
              normalizeAudioPayload(request.chunks, request.state.mimeType, model),
              'gemini-live',
            )
            settleLiveSpeechRequest(payload)
            liveSpeechTurnCount++
            if (liveSpeechTurnCount >= LIVE_SPEECH_MAX_TURNS_PER_SESSION) {
              closeLiveSpeechSession()
            }
          }
        },
        onerror: (error: unknown) => {
          if (logger) {
            logger.withFields({ model }).withError(error).warn('Gemini Live speech session error')
          }
          settleLiveSpeechRequest(undefined, error)
          closeLiveSpeechSession()
        },
        onclose: (event: GeminiCloseEventLike) => {
          const request = liveSpeechRequest
          if (request) {
            const payload = normalizeVoicePayloadWithProvider(
              normalizeAudioPayload(request.chunks, request.state.mimeType, model),
              'gemini-live',
            )
            if (!payload && (event?.code || event?.reason)) {
              settleLiveSpeechRequest(undefined, new Error(`Gemini Live speech closed before audio output. code=${event?.code ?? 'unknown'} reason=${event?.reason ?? ''}`))
            }
            else {
              settleLiveSpeechRequest(payload)
            }
          }
          closeLiveSpeechSession(false)
        },
      },
    })

    liveSpeechSession = connected
    liveSpeechSessionKey = sessionKey
    logger?.withFields({ model }).log('Gemini Live speech session connected')
    return connected
  })()

  try {
    return await liveSpeechConnectPromise
  }
  finally {
    liveSpeechConnectPromise = null
  }
}

async function requestGeminiLiveSpeech(
  model: string,
  text: string,
  logger?: Logger,
): Promise<OutputVoicePayload | undefined> {
  const session = await ensureGeminiLiveSpeechSession(model, logger)

  return await new Promise<OutputVoicePayload | undefined>((resolve, reject) => {
    if (liveSpeechRequest) {
      reject(new Error('Gemini Live speech request already in flight'))
      return
    }

    const chunks: Uint8Array[] = []
    const state: { mimeType?: string } = {}
    const timer = setTimeout(() => {
      const payload = normalizeVoicePayloadWithProvider(
        normalizeAudioPayload(chunks, state.mimeType, model),
        'gemini-live',
      )
      settleLiveSpeechRequest(payload, payload ? undefined : new Error('Gemini Live speech timeout without audio output'))
    }, LIVE_SPEECH_REQUEST_TIMEOUT_MS)

    liveSpeechRequest = {
      chunks,
      state,
      timer,
      settle: (payload, error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(payload)
      },
    }

    try {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      })
    }
    catch (error) {
      settleLiveSpeechRequest(undefined, error)
    }
  })
}

async function generateGeminiLiveVoice(text: string, logger?: Logger): Promise<OutputVoicePayload | undefined> {
  if (!config.gemini.liveSpeechEnabled || !config.gemini.apiKey) {
    return undefined
  }

  // Prefer liveModel so decision+speech can share the same Native Audio session model.
  const model = (config.gemini.liveModel || config.gemini.liveSpeechModel).trim()
  if (!model) {
    return undefined
  }
  if (!isLikelyGeminiLiveModel(model)) {
    return undefined
  }
  if (unavailableGeminiLiveModels.has(model)) {
    return undefined
  }

  if (isGeminiOpenAICompatibleBaseUrl(config.gemini.baseUrl)) {
    logger?.warn('Gemini Live speech requires Gemini native API base URL, skipping voice generation.')
    return undefined
  }

  try {
    return await requestGeminiLiveSpeech(model, text, logger)
  }
  catch (error) {
    if (isUnsupportedModelError(error)) {
      unavailableGeminiLiveModels.add(model)
    }
    closeLiveSpeechSession()
    if (logger) {
      logger.withFields({ model }).withError(error).warn('Gemini Live speech generation failed, fallback to HTTP TTS')
    }
    emitFallbackMonitor({
      scope: 'llm.output.voice',
      reason: 'gemini-live-http-tts-fallback',
      detail: error instanceof Error ? error.message : String(error),
      from: model,
      to: 'gemini-http-tts',
      recoverable: true,
    }, { throttleMs: 30_000 })
    return undefined
  }
}

async function generateGeminiHttpVoice(text: string, logger?: Logger): Promise<OutputVoicePayload | undefined> {
  if (!config.gemini.liveSpeechEnabled || !config.gemini.apiKey) {
    return undefined
  }

  if (isGeminiOpenAICompatibleBaseUrl(config.gemini.baseUrl)) {
    logger?.warn('Gemini HTTP speech requires Gemini native API base URL, skipping voice generation.')
    return undefined
  }

  const moduleValue = await import('@google/genai') as unknown as GeminiModuleLike
  const GoogleGenAI = moduleValue.GoogleGenAI
  if (typeof GoogleGenAI !== 'function') {
    throw new TypeError('GoogleGenAI export not found for Gemini HTTP speech')
  }

  const baseUrl = config.gemini.baseUrl.trim().replace(/\/+$/, '')
  const useCustomBaseUrl = baseUrl.length > 0 && !baseUrl.includes('generativelanguage.googleapis.com')
  const client = new GoogleGenAI({
    apiKey: config.gemini.apiKey,
    ...(useCustomBaseUrl
      ? {
          httpOptions: {
            baseUrl,
          },
        }
      : {}),
  })
  const modelsClient = client.models
  if (!modelsClient || typeof modelsClient.generateContent !== 'function') {
    throw new TypeError('GoogleGenAI models.generateContent is unavailable for Gemini HTTP speech')
  }

  const speechConfig = buildGeminiSpeechConfig()
  const responseModalityAudio = moduleValue.Modality?.AUDIO || 'AUDIO'

  for (const model of buildGeminiHttpSpeechModelCandidates()) {
    if (unavailableGeminiHttpSpeechModels.has(model)) {
      continue
    }

    try {
      const response = await modelsClient.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text }] }],
        config: {
          responseModalities: [responseModalityAudio],
          ...(Object.keys(speechConfig).length > 0 ? { speechConfig } : {}),
        },
      })

      const chunks: Uint8Array[] = []
      const state: { mimeType?: string } = {}
      const parts = response?.candidates?.[0]?.content?.parts
      if (Array.isArray(parts)) {
        for (const part of parts) {
          maybeCollectAudioChunk(part?.inlineData?.data, part?.inlineData?.mimeType, chunks, state)
        }
      }

      const payload = normalizeVoicePayloadWithProvider(
        normalizeAudioPayload(chunks, state.mimeType, model),
        'gemini-http',
      )

      if (payload) {
        return payload
      }

      logger?.withFields({ model }).warn('Gemini HTTP speech returned no audio payload')
    }
    catch (error) {
      if (isUnsupportedModelError(error)) {
        unavailableGeminiHttpSpeechModels.add(model)
      }
      logger?.withFields({ model }).withError(error).warn('Gemini HTTP speech model failed')
    }
  }

  return undefined
}

async function publishAssistantMessageInternal(
  airiClient: Client | undefined,
  content: string,
  logger?: Logger,
  options?: PublishAssistantMessageOptions,
): Promise<void> {
  let voice: OutputVoicePayload | undefined
  const localTtsEnabled = config.localTts.enabled
  const geminiSpeechEnabled = config.gemini.liveSpeechEnabled && !!config.gemini.apiKey
  const voiceMode: VoiceMode = options?.voiceMode ?? 'auto'
  const voicePriority: VoicePriority = options?.voicePriority ?? 'normal'
  const voiceSuppressedByPolicy = voiceMode === 'off' || (voiceMode === 'auto' && shouldSuppressVoiceByContent(content))
  const now = Date.now()
  const busyRemainingMs = Math.max(0, voicePlaybackBusyUntil - now)
  const voiceSuppressedByBusyWindow = voicePriority !== 'high' && busyRemainingMs > 0
  // High-priority voice no longer waits for busy window - generate immediately
  // so social replies are not delayed by commentary playback estimates.
  const shouldAttemptVoice = !voiceSuppressedByPolicy && !voiceSuppressedByBusyWindow && voicePriority !== 'high'
  const highPriorityForceVoice = !voiceSuppressedByPolicy && voicePriority === 'high'
  const shouldAttemptVoiceEffective = shouldAttemptVoice || highPriorityForceVoice
  const canAttemptLocal = shouldAttemptVoiceEffective && localTtsEnabled && canAttemptLocalTts(logger)
  const canAttemptLive = shouldAttemptVoiceEffective && geminiSpeechEnabled && canAttemptVoiceGeneration(logger)
  const liveModel = config.gemini.liveModel.trim().toLowerCase()
  const nativeAudioMode = liveModel.includes('native-audio')
  const allowHttpFallback = !nativeAudioMode
  let attemptedLocal = false
  let attemptedLive = false
  let attemptedHttp = false

  if (voiceSuppressedByBusyWindow && logger && now - lastVoiceBusyLogAt >= VOICE_BUSY_LOG_INTERVAL_MS) {
    logger.withFields({
      priority: voicePriority,
      busyUntil: new Date(voicePlaybackBusyUntil).toISOString(),
      remainingMs: busyRemainingMs,
    }).log('Voice skipped because previous speech is still playing')
    lastVoiceBusyLogAt = now
  }

  try {
    if (shouldAttemptVoiceEffective) {
      if (canAttemptLocal) {
        attemptedLocal = true
        try {
          voice = await generateLocalVoice(content, logger, voicePriority)
          if (voice) {
            registerLocalTtsSuccess()
          }
          else {
            registerLocalTtsFailure(logger)
          }
        }
        catch (error) {
          registerLocalTtsFailure(logger, error)
          if (logger) {
            logger.withError(error).warn('Local TTS generation failed')
          }
        }
      }

      if (!voice && geminiSpeechEnabled) {
        if (canAttemptLive) {
          attemptedLive = true
          voice = await generateGeminiLiveVoice(content, logger)
        }
        if (!voice && allowHttpFallback) {
          attemptedHttp = true
          voice = await generateGeminiHttpVoice(content, logger)
        }
      }
    }
    if (voice) {
      if (voice.provider !== 'local-tts') {
        registerVoiceGenerationSuccess()
      }
      const holdMs = estimateVoicePlaybackMs(content) + VOICE_PLAYBACK_MIN_GAP_MS
      voicePlaybackBusyUntil = Math.max(voicePlaybackBusyUntil, Date.now() + holdMs)
      if (options?.onVoiceAttached) {
        try {
          options.onVoiceAttached({
            estimatedEndAt: voicePlaybackBusyUntil,
            provider: voice.provider,
            model: voice.model,
            mimeType: voice.mimeType,
          })
        }
        catch {
          // noop - voice timing observer must never block output delivery
        }
      }
    }
    else if ((attemptedLive || attemptedHttp) && shouldAttemptVoice && geminiSpeechEnabled) {
      registerVoiceGenerationFailure(logger)
    }
    if (voice && logger) {
      logger.withFields({
        provider: voice.provider,
        model: voice.model,
        mimeType: voice.mimeType,
      }).log('Voice attached to assistant output')
    }
    else if (logger && shouldAttemptVoice) {
      if (attemptedLocal) {
        logger.warn('Local TTS did not attach voice payload')
      }
      else if (localTtsEnabled && !canAttemptLocal) {
        logger.log('Local TTS is temporarily muted due to recent failures')
      }
      if (!geminiSpeechEnabled) {
        logger.warn('Gemini speech is disabled and local TTS had no output, forwarding text-only output')
        emitFallbackMonitor({
          scope: 'llm.output.voice',
          reason: 'text-only-output',
          detail: 'Gemini speech is disabled and local TTS had no output, forwarding text-only output.',
          from: localTtsEnabled ? 'local-tts' : 'voice-disabled',
          to: 'text-only',
          recoverable: true,
        }, { throttleMs: 30_000 })
      }
      else {
        if (!canAttemptLive) {
          if (attemptedHttp) {
            logger.log('Gemini Live is temporarily muted, tried HTTP TTS directly')
          }
          else {
            logger.log('Gemini Live is temporarily muted, skipped HTTP TTS fallback in native-audio mode')
          }
        }
        else if (!attemptedHttp && nativeAudioMode) {
          logger.log('Gemini HTTP TTS fallback disabled in native-audio mode')
        }
        logger.warn('Gemini voice not attached, forwarding text-only output')
        emitFallbackMonitor({
          scope: 'llm.output.voice',
          reason: 'text-only-output',
          detail: 'Gemini voice was not attached, forwarding text-only output.',
          from: attemptedHttp ? 'gemini-http-tts' : 'gemini-live-tts',
          to: 'text-only',
          recoverable: true,
        }, { throttleMs: 30_000 })
      }
    }
    else if (logger && (geminiSpeechEnabled || localTtsEnabled) && voiceSuppressedByPolicy) {
      logger.withField('voiceMode', voiceMode).log('Voice suppressed by output policy')
    }
  }
  catch (error) {
    if ((attemptedLive || attemptedHttp) && shouldAttemptVoice && geminiSpeechEnabled) {
      registerVoiceGenerationFailure(logger)
    }
    if (logger) {
      logger.withError(error).warn('Voice generation failed, forwarding text-only output')
    }
    emitFallbackMonitor({
      scope: 'llm.output.voice',
      reason: 'voice-generation-text-only-fallback',
      detail: error instanceof Error ? error.message : String(error),
      from: attemptedHttp ? 'gemini-http-tts' : attemptedLive ? 'gemini-live-tts' : attemptedLocal ? 'local-tts' : 'voice-generation',
      to: 'text-only',
      recoverable: true,
    }, { throttleMs: 30_000 })
  }

  await writeObsSubtitle(content, logger)

  if (options?.onPlaybackStart) {
    try {
      options.onPlaybackStart()
    }
    catch {
      // noop — overlay update failure must not block speech dispatch
    }
  }

  if (airiClient) {
    try {
      airiClient.send({
        type: 'output:gen-ai:chat:message',
        data: {
          message: {
            role: 'assistant',
            content,
          },
          ...(voice ? { voice } : {}),
        } as any,
      })
    }
    catch (error) {
      if (logger) {
        logger.withError(error).warn('Failed to forward assistant output to AIRI server')
      }
    }
  }
}

export function publishAssistantMessageToAiri(
  airiClient: Client | undefined,
  message: string,
  logger?: Logger,
  options?: PublishAssistantMessageOptions,
): void {
  const content = message.trim()
  if (!content) {
    return
  }

  const priority = options?.voicePriority ?? 'normal'
  const enqueue = (): void => {
    if (priority === 'high') {
      // High-priority (social replies) run on a separate queue so they are
      // never blocked behind low-priority commentary/ambient messages.
      highPriorityQueue = highPriorityQueue.then(() =>
        publishAssistantMessageInternal(airiClient, content, logger, options),
      )
    }
    else {
      normalQueue = normalQueue.then(() =>
        publishAssistantMessageInternal(airiClient, content, logger, options),
      )
    }
  }

  // Release on the presentation clock so the voice lands when the delayed
  // stream video shows the moment being reacted to. High-priority speech is
  // never dropped for staleness.
  getPresentationScheduler().schedule(
    options?.eventAt ?? Date.now(),
    enqueue,
    {
      maxLatenessMs: priority === 'high' ? undefined : options?.maxLatenessMs,
      label: `assistant-output:${priority}`,
    },
  )
}

/**
 * Publishes a pre-synthesized voice clip on the presentation clock, skipping
 * LLM and TTS entirely. Used by the instant-reaction voice bank so a scream
 * lands the moment the danger appears on the delayed stream video.
 */
export function publishPrerenderedVoiceToAiri(
  airiClient: Client | undefined,
  text: string,
  voice: OutputVoicePayload,
  logger?: Logger,
  options?: { eventAt?: number, maxLatenessMs?: number },
): void {
  const content = text.trim()
  if (!content) {
    return
  }

  getPresentationScheduler().schedule(
    options?.eventAt ?? Date.now(),
    () => {
      const holdMs = estimateVoicePlaybackMs(content) + VOICE_PLAYBACK_MIN_GAP_MS
      voicePlaybackBusyUntil = Math.max(voicePlaybackBusyUntil, Date.now() + holdMs)
      void writeObsSubtitle(content, logger)
      if (airiClient) {
        try {
          airiClient.send({
            type: 'output:gen-ai:chat:message',
            data: {
              message: {
                role: 'assistant',
                content,
              },
              voice,
            } as any,
          })
        }
        catch (error) {
          logger?.withError(error).warn('Failed to forward prerendered voice to AIRI server')
        }
      }
    },
    {
      maxLatenessMs: options?.maxLatenessMs ?? 6_000,
      label: 'voice-bank',
    },
  )
}

export function __resetOutputVoiceStateForTest(): void {
  highPriorityQueue = Promise.resolve()
  normalQueue = Promise.resolve()
  unavailableGeminiLiveModels.clear()
  unavailableGeminiHttpSpeechModels.clear()
  voiceFailureStreak = 0
  voiceMutedUntil = 0
  lastVoiceBackoffLogAt = 0
  localTtsFailureStreak = 0
  localTtsMutedUntil = 0
  lastLocalTtsBackoffLogAt = 0
  if (liveSpeechRequest?.timer) {
    clearTimeout(liveSpeechRequest.timer)
  }
  liveSpeechRequest = null
  if (liveSpeechSession?.close) {
    try {
      liveSpeechSession.close()
    }
    catch {}
  }
  liveSpeechSession = null
  liveSpeechConnectPromise = null
  liveSpeechSessionKey = ''
  liveSpeechTurnCount = 0
  voicePlaybackBusyUntil = 0
  lastVoiceBusyLogAt = 0
  lastSubtitleWriteErrorAt = 0
}
