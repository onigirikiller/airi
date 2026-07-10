import type { BotOptions } from 'mineflayer'

import { env } from 'node:process'

import { useLogger } from '../utils/logger'

const logger = useLogger()

// Configuration interfaces
interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
  reasoningModel: string
  publicSpeakModel: string
}

interface AiriConfig {
  wsBaseUrl: string
  clientName: string
}

interface AutonomyLlmConfig {
  enabled: boolean
  apiKey: string
  baseUrl: string
  model: string
  liveModel: string
  useLiveApi: boolean
  temperature: number
  maxOutputTokens: number
}

interface GeminiSpeechConfig {
  apiKey: string
  baseUrl: string
  model: string
  liveModel: string
  liveSpeechEnabled: boolean
  liveSpeechModel: string
  liveSpeechLanguageCode: string
  liveSpeechVoiceName: string
}

type LegacyGeminiConfig = AutonomyLlmConfig & GeminiSpeechConfig

interface LocalTtsConfig {
  enabled: boolean
  provider: 'voicevox' | 'style-bert-vits2' | 'irodori-tts'
  baseUrl: string
  serializeWithGpu: boolean
  speaker: number
  speedScale: number
  pitchScale: number
  intonationScale: number
  volumeScale: number
  styleBertVits2EndpointPath: string
  styleBertVits2ModelId: number
  styleBertVits2SpeakerId: number
  styleBertVits2Style: string
  styleBertVits2StyleWeight: number
  styleBertVits2SdpRatio: number
  styleBertVits2Noise: number
  styleBertVits2NoiseW: number
  styleBertVits2Length: number
  styleBertVits2Language: string
  irodoriEndpointPath: string
  irodoriHfCheckpoint: string
  irodoriCaption: string
}

interface PublicSpeakConfig {
  provider: 'llm' | 'gemini'
}

interface AutonomyConfig {
  enabled: boolean
  mode: 'stream'
  fillerChatEnabled: boolean
  lowVramMode: boolean
  singleInferenceLane: boolean
  loopIntervalMs: number
  minGoalIntervalMs: number
  goalLockMs: number
  maxContextMessages: number
  maxPlannerContextItems: number
  maxSpeechContextItems: number
  narrationMinIntervalMs: number
  maxConsecutiveKeepalives: number
  selfGoals: string[]
  selfGoalWeight: number
  socialWeight: number
  commentWeight: number
}

interface SubtitleConfig {
  enabled: boolean
  filePath: string
  maxCharsPerLine: number
  maxLines: number
}

interface YouTubeConfig {
  enabled: boolean
  apiKey: string
  liveChatId: string
  liveVideoId: string
  liveUrl: string
  oauthAccessToken: string
  pollIntervalMs: number
  quotaBackoffMs: number
  maxResults: number
  maxPendingMessages: number
  replyEnabled: boolean
  maxDailyReplies: number
  commentOverlayEnabled: boolean
  commentOverlayFilePath: string
  commentOverlayMaxCharsPerLine: number
  commentOverlayMaxLines: number
  commentOverlayIncludeAuthor: boolean
  commentOverlayRecentEnabled: boolean
  commentOverlayRecentFilePath: string
  commentOverlayRecentMaxItems: number
}

interface FabricBridgeConfig {
  enabled: boolean
  host: string
  port: number
  reconnectInterval: number
  maxReconnectAttempts: number
}

interface MonitorConfig {
  enabled: boolean
  port: number
}

interface ViewerConfig {
  enabled: boolean
  port: number
  hudEnabled: boolean
  hudPort: number
  firstPerson: boolean
  viewDistance: number
  prefix: string
}

interface Config {
  llm: LlmConfig
  speechLlm: LlmConfig
  openai: LlmConfig
  bot: BotOptions
  airi: AiriConfig
  autonomyLlm: AutonomyLlmConfig
  geminiSpeech: GeminiSpeechConfig
  gemini: LegacyGeminiConfig
  localTts: LocalTtsConfig
  publicSpeak: PublicSpeakConfig
  autonomy: AutonomyConfig
  subtitle: SubtitleConfig
  youtube: YouTubeConfig
  monitor: MonitorConfig
  viewer: ViewerConfig
  fabricBridge: FabricBridgeConfig
}

const LLM_API_KEY_KEYS = ['LLM_API_KEY', 'OPENAI_API_KEY']
const LLM_BASE_URL_KEYS = ['LLM_BASE_URL', 'LLM_API_BASE_URL', 'OPENAI_API_BASEURL', 'OPENAI_API_BASE_URL']
const LLM_MODEL_KEYS = ['LLM_MODEL', 'OPENAI_MODEL']
const LLM_REASONING_MODEL_KEYS = ['LLM_REASONING_MODEL', 'OPENAI_REASONING_MODEL']
const LLM_PUBLIC_SPEAK_MODEL_KEYS = ['LLM_PUBLIC_SPEAK_MODEL', 'OPENAI_PUBLIC_SPEAK_MODEL']
const SPEECH_LLM_API_KEY_KEYS = ['SPEECH_LLM_API_KEY', ...LLM_API_KEY_KEYS]
const SPEECH_LLM_BASE_URL_KEYS = ['SPEECH_LLM_BASE_URL', 'SPEECH_LLM_API_BASE_URL', ...LLM_BASE_URL_KEYS]
const SPEECH_LLM_MODEL_KEYS = ['SPEECH_LLM_MODEL', ...LLM_MODEL_KEYS]
const SPEECH_LLM_REASONING_MODEL_KEYS = ['SPEECH_LLM_REASONING_MODEL', ...LLM_REASONING_MODEL_KEYS]
const SPEECH_LLM_PUBLIC_SPEAK_MODEL_KEYS = ['SPEECH_LLM_PUBLIC_SPEAK_MODEL', ...LLM_PUBLIC_SPEAK_MODEL_KEYS]

const AUTONOMY_LLM_ENABLED_KEYS = ['AUTONOMY_LLM_ENABLED', 'GEMINI_ENABLED']
const AUTONOMY_LLM_API_KEY_KEYS = ['AUTONOMY_LLM_API_KEY', 'GEMINI_API_KEY']
const AUTONOMY_LLM_BASE_URL_KEYS = ['AUTONOMY_LLM_BASE_URL', 'AUTONOMY_LLM_API_BASE_URL', 'GEMINI_API_BASEURL', 'GEMINI_API_BASE_URL']
const AUTONOMY_LLM_MODEL_KEYS = ['AUTONOMY_LLM_MODEL', 'GEMINI_MODEL']
const AUTONOMY_LLM_LIVE_MODEL_KEYS = ['AUTONOMY_LLM_LIVE_MODEL', 'GEMINI_LIVE_MODEL']
const AUTONOMY_LLM_USE_LIVE_API_KEYS = ['AUTONOMY_LLM_USE_LIVE_API', 'GEMINI_USE_LIVE_API']
const AUTONOMY_LLM_TEMPERATURE_KEYS = ['AUTONOMY_LLM_TEMPERATURE', 'GEMINI_TEMPERATURE']
const AUTONOMY_LLM_MAX_OUTPUT_TOKENS_KEYS = ['AUTONOMY_LLM_MAX_OUTPUT_TOKENS', 'GEMINI_MAX_OUTPUT_TOKENS']

const GEMINI_SPEECH_API_KEY_KEYS = ['GEMINI_API_KEY']
const GEMINI_SPEECH_BASE_URL_KEYS = ['GEMINI_BASE_URL', 'GEMINI_API_BASE_URL', 'GEMINI_API_BASEURL']
const GEMINI_SPEECH_MODEL_KEYS = ['GEMINI_HTTP_MODEL', 'GEMINI_MODEL']
const GEMINI_SPEECH_LIVE_MODEL_KEYS = ['GEMINI_LIVE_MODEL']
const GEMINI_SPEECH_ENABLED_KEYS = ['GEMINI_LIVE_SPEECH_ENABLED']
const GEMINI_SPEECH_MODEL_OVERRIDE_KEYS = ['GEMINI_LIVE_SPEECH_MODEL']
const GEMINI_SPEECH_LANGUAGE_CODE_KEYS = ['GEMINI_LIVE_SPEECH_LANGUAGE_CODE']
const GEMINI_SPEECH_VOICE_NAME_KEYS = ['GEMINI_LIVE_SPEECH_VOICE_NAME']
const PUBLIC_SPEAK_PROVIDER_KEYS = ['PUBLIC_SPEAK_PROVIDER', 'LLM_PUBLIC_SPEAK_PROVIDER']

function hasEnvKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key)
}

// Helper functions for type-safe environment variable parsing
function getEnvVar<V extends string>(key: string, defaultValue?: V): V | undefined {
  return getEnvVarFromKeys([key], defaultValue)
}

function getEnvVarFromKeys<V extends string>(keys: string[], defaultValue?: V): V | undefined {
  for (const key of keys) {
    if (hasEnvKey(key)) {
      return env[key] as V | undefined
    }
  }

  return defaultValue
}

function getEnvNumber(key: string, defaultValue: number): number {
  return getEnvNumberFromKeys([key], defaultValue)
}

function getEnvNumberFromKeys(keys: string[], defaultValue: number): number {
  for (const key of keys) {
    if (!hasEnvKey(key)) {
      continue
    }

    const parsed = Number.parseInt(env[key] || String(defaultValue), 10)
    return Number.isNaN(parsed) ? defaultValue : parsed
  }

  return defaultValue
}

function getEnvFloat(key: string, defaultValue: number): number {
  return getEnvFloatFromKeys([key], defaultValue)
}

function getEnvFloatFromKeys(keys: string[], defaultValue: number): number {
  for (const key of keys) {
    if (!hasEnvKey(key)) {
      continue
    }

    const parsed = Number.parseFloat(env[key] || String(defaultValue))
    return Number.isNaN(parsed) ? defaultValue : parsed
  }

  return defaultValue
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  return getEnvBooleanFromKeys([key], defaultValue)
}

function getEnvBooleanFromKeys(keys: string[], defaultValue: boolean): boolean {
  for (const key of keys) {
    if (!hasEnvKey(key)) {
      continue
    }

    const raw = env[key]
    if (raw == null) {
      return defaultValue
    }

    switch (raw.trim().toLowerCase()) {
      case '1':
      case 'true':
      case 'yes':
      case 'on':
        return true
      case '0':
      case 'false':
      case 'no':
      case 'off':
        return false
      default:
        return defaultValue
    }
  }

  return defaultValue
}

function getEnvList(key: string, defaultValue: string[]): string[] {
  return getEnvListFromKeys([key], defaultValue)
}

function getEnvListFromKeys(keys: string[], defaultValue: string[]): string[] {
  for (const key of keys) {
    if (!hasEnvKey(key)) {
      continue
    }

    const raw = env[key]
    if (!raw) {
      return defaultValue
    }

    const values = raw
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)

    return values.length > 0 ? values : defaultValue
  }

  return defaultValue
}

function parseLocalTtsProvider(value: string | undefined, fallback: LocalTtsConfig['provider']): LocalTtsConfig['provider'] {
  if (!value) {
    return fallback
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'voicevox') {
    return 'voicevox'
  }
  if (normalized === 'style-bert-vits2' || normalized === 'style_bert_vits2' || normalized === 'sbv2') {
    return 'style-bert-vits2'
  }
  if (normalized === 'irodori-tts' || normalized === 'irodori_tts' || normalized === 'irodori') {
    return 'irodori-tts'
  }

  return fallback
}

function parseAutonomyMode(value: string | undefined, fallback: AutonomyConfig['mode']): AutonomyConfig['mode'] {
  if (!value) {
    return fallback
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'runner' || normalized === 'phase-runner' || normalized === 'phase_runner') {
    logger.warn('AUTONOMY_MODE=runner is deprecated; forcing stream mode so action selection stays LLM-directed.')
  }

  return 'stream'
}

function parsePublicSpeakProvider(
  value: string | undefined,
  fallback: PublicSpeakConfig['provider'],
): PublicSpeakConfig['provider'] {
  if (!value) {
    return fallback
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'gemini') {
    return 'gemini'
  }
  if (normalized === 'llm' || normalized === 'openai') {
    return 'llm'
  }

  return fallback
}

function createLegacyLlmConfigAlias(current: Pick<Config, 'llm'>): LlmConfig {
  const alias = {} as LlmConfig

  Object.defineProperties(alias, {
    apiKey: {
      enumerable: true,
      get: () => current.llm.apiKey,
      set: value => current.llm.apiKey = value,
    },
    baseUrl: {
      enumerable: true,
      get: () => current.llm.baseUrl,
      set: value => current.llm.baseUrl = value,
    },
    model: {
      enumerable: true,
      get: () => current.llm.model,
      set: value => current.llm.model = value,
    },
    reasoningModel: {
      enumerable: true,
      get: () => current.llm.reasoningModel,
      set: value => current.llm.reasoningModel = value,
    },
    publicSpeakModel: {
      enumerable: true,
      get: () => current.llm.publicSpeakModel,
      set: value => current.llm.publicSpeakModel = value,
    },
  })

  return alias
}

function createLegacyGeminiConfigAlias(current: Pick<Config, 'autonomyLlm' | 'geminiSpeech'>): LegacyGeminiConfig {
  const alias = {} as LegacyGeminiConfig

  Object.defineProperties(alias, {
    enabled: {
      enumerable: true,
      get: () => current.autonomyLlm.enabled,
      set: value => current.autonomyLlm.enabled = value,
    },
    apiKey: {
      enumerable: true,
      get: () => current.autonomyLlm.apiKey || current.geminiSpeech.apiKey,
      set: (value: string) => {
        current.autonomyLlm.apiKey = value
        current.geminiSpeech.apiKey = value
      },
    },
    baseUrl: {
      enumerable: true,
      get: () => current.autonomyLlm.baseUrl || current.geminiSpeech.baseUrl,
      set: (value: string) => {
        current.autonomyLlm.baseUrl = value
        current.geminiSpeech.baseUrl = value
      },
    },
    model: {
      enumerable: true,
      get: () => current.autonomyLlm.model || current.geminiSpeech.model,
      set: (value: string) => {
        current.autonomyLlm.model = value
        current.geminiSpeech.model = value
      },
    },
    liveModel: {
      enumerable: true,
      get: () => current.autonomyLlm.liveModel || current.geminiSpeech.liveModel,
      set: (value: string) => {
        current.autonomyLlm.liveModel = value
        current.geminiSpeech.liveModel = value
      },
    },
    useLiveApi: {
      enumerable: true,
      get: () => current.autonomyLlm.useLiveApi,
      set: value => current.autonomyLlm.useLiveApi = value,
    },
    temperature: {
      enumerable: true,
      get: () => current.autonomyLlm.temperature,
      set: value => current.autonomyLlm.temperature = value,
    },
    maxOutputTokens: {
      enumerable: true,
      get: () => current.autonomyLlm.maxOutputTokens,
      set: value => current.autonomyLlm.maxOutputTokens = value,
    },
    liveSpeechEnabled: {
      enumerable: true,
      get: () => current.geminiSpeech.liveSpeechEnabled,
      set: value => current.geminiSpeech.liveSpeechEnabled = value,
    },
    liveSpeechModel: {
      enumerable: true,
      get: () => current.geminiSpeech.liveSpeechModel,
      set: value => current.geminiSpeech.liveSpeechModel = value,
    },
    liveSpeechLanguageCode: {
      enumerable: true,
      get: () => current.geminiSpeech.liveSpeechLanguageCode,
      set: value => current.geminiSpeech.liveSpeechLanguageCode = value,
    },
    liveSpeechVoiceName: {
      enumerable: true,
      get: () => current.geminiSpeech.liveSpeechVoiceName,
      set: value => current.geminiSpeech.liveSpeechVoiceName = value,
    },
  })

  return alias
}

function createConfig(): Config {
  const current = {
    llm: {
      apiKey: '',
      baseUrl: '',
      model: '',
      reasoningModel: '',
      publicSpeakModel: '',
    },
    speechLlm: {
      apiKey: '',
      baseUrl: '',
      model: '',
      reasoningModel: '',
      publicSpeakModel: '',
    },
    bot: {
      username: 'airi-bot',
      host: 'localhost',
      port: 25565,
      password: '',
      version: '1.20',
    },
    airi: {
      wsBaseUrl: 'ws://localhost:6121/ws',
      clientName: 'minecraft-bot',
    },
    autonomyLlm: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash',
      liveModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
      useLiveApi: true,
      temperature: 0.6,
      maxOutputTokens: 512,
    },
    geminiSpeech: {
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash',
      liveModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
      liveSpeechEnabled: false,
      liveSpeechModel: 'gemini-2.5-flash-preview-tts',
      liveSpeechLanguageCode: '',
      liveSpeechVoiceName: '',
    },
    localTts: {
      enabled: false,
      provider: 'voicevox',
      baseUrl: 'http://127.0.0.1:50021',
      serializeWithGpu: true,
      speaker: 3,
      speedScale: 1,
      pitchScale: 0,
      intonationScale: 1,
      volumeScale: 1,
      styleBertVits2EndpointPath: '/voice',
      styleBertVits2ModelId: 0,
      styleBertVits2SpeakerId: 0,
      styleBertVits2Style: 'Neutral',
      styleBertVits2StyleWeight: 1,
      styleBertVits2SdpRatio: 0.2,
      styleBertVits2Noise: 0.6,
      styleBertVits2NoiseW: 0.8,
      styleBertVits2Length: 1.0,
      styleBertVits2Language: 'JP',
      irodoriEndpointPath: '/voice',
      irodoriHfCheckpoint: 'Aratako/Irodori-TTS-500M-v2-VoiceDesign',
      irodoriCaption: '',
    },
    publicSpeak: {
      provider: 'llm',
    },
    autonomy: {
      enabled: false,
      mode: 'stream',
      fillerChatEnabled: true,
      lowVramMode: true,
      singleInferenceLane: true,
      loopIntervalMs: 30_000,
      minGoalIntervalMs: 20_000,
      goalLockMs: 120_000,
      maxContextMessages: 12,
      maxPlannerContextItems: 10,
      maxSpeechContextItems: 8,
      narrationMinIntervalMs: 12_000,
      maxConsecutiveKeepalives: 2,
      selfGoals: [
        'スポーン付近で木材と基礎資源を集める',
        '現在の拠点まわりの安全を整える',
        '近くの地形を探り有用な資源を見つける',
        '食料を確保して生存を安定させる',
      ],
      selfGoalWeight: 1.0,
      socialWeight: 0.7,
      commentWeight: 0.25,
    },
    subtitle: {
      enabled: false,
      filePath: '',
      maxCharsPerLine: 22,
      maxLines: 3,
    },
    youtube: {
      enabled: false,
      apiKey: '',
      liveChatId: '',
      liveVideoId: '',
      liveUrl: '',
      oauthAccessToken: '',
      pollIntervalMs: 30_000,
      quotaBackoffMs: 60 * 60_000,
      maxResults: 20,
      maxPendingMessages: 50,
      replyEnabled: false,
      maxDailyReplies: 20,
      commentOverlayEnabled: false,
      commentOverlayFilePath: '',
      commentOverlayMaxCharsPerLine: 28,
      commentOverlayMaxLines: 2,
      commentOverlayIncludeAuthor: true,
      commentOverlayRecentEnabled: false,
      commentOverlayRecentFilePath: '',
      commentOverlayRecentMaxItems: 8,
    },
    monitor: {
      enabled: false,
      port: 3002,
    },
    viewer: {
      enabled: false,
      port: 3000,
      hudEnabled: true,
      hudPort: 3001,
      firstPerson: true,
      viewDistance: 8,
      prefix: '',
    },
    fabricBridge: {
      enabled: false,
      host: 'localhost',
      port: 8089,
      reconnectInterval: 3000,
      maxReconnectAttempts: 50,
    },
  } satisfies Omit<Config, 'openai' | 'gemini'>

  const configWithAliases = current as Config
  configWithAliases.openai = createLegacyLlmConfigAlias(configWithAliases)
  configWithAliases.gemini = createLegacyGeminiConfigAlias(configWithAliases)

  return configWithAliases
}

// Default configurations
const defaultConfig: Config = createConfig()

// Create a singleton config instance
export const config: Config = createConfig()

function maskSecret(value: string): string {
  if (!value)
    return ''
  if (value.length <= 8)
    return '***'

  return `${value.slice(0, 4)}...${value.slice(-2)}`
}

function redactConfigForLog(current: Config) {
  const redactedBot: BotOptions = {
    ...current.bot,
  }

  if (typeof redactedBot.password === 'string' && redactedBot.password.length > 0) {
    redactedBot.password = maskSecret(redactedBot.password)
  }

  return {
    ...current,
    llm: {
      ...current.llm,
      apiKey: maskSecret(current.llm.apiKey),
    },
    speechLlm: {
      ...current.speechLlm,
      apiKey: maskSecret(current.speechLlm.apiKey),
    },
    openai: {
      ...current.openai,
      apiKey: maskSecret(current.openai.apiKey),
    },
    autonomyLlm: {
      ...current.autonomyLlm,
      apiKey: maskSecret(current.autonomyLlm.apiKey),
    },
    geminiSpeech: {
      ...current.geminiSpeech,
      apiKey: maskSecret(current.geminiSpeech.apiKey),
    },
    gemini: {
      ...current.gemini,
      apiKey: maskSecret(current.gemini.apiKey),
    },
    youtube: {
      ...current.youtube,
      apiKey: maskSecret(current.youtube.apiKey),
      oauthAccessToken: maskSecret(current.youtube.oauthAccessToken),
    },
    bot: redactedBot,
  }
}

// Initialize environment configuration
export function initEnv(): void {
  logger.log('Initializing environment variables')

  // Primary LLM used by chat replies and public speech.
  config.llm = {
    apiKey: getEnvVarFromKeys(LLM_API_KEY_KEYS, defaultConfig.llm.apiKey)!,
    baseUrl: getEnvVarFromKeys(LLM_BASE_URL_KEYS, defaultConfig.llm.baseUrl)!,
    model: getEnvVarFromKeys(LLM_MODEL_KEYS, defaultConfig.llm.model)!,
    reasoningModel: getEnvVarFromKeys(LLM_REASONING_MODEL_KEYS, defaultConfig.llm.reasoningModel)!,
    publicSpeakModel: getEnvVarFromKeys(LLM_PUBLIC_SPEAK_MODEL_KEYS, defaultConfig.llm.publicSpeakModel)!,
  }

  // Speech-side text generation can now be configured independently from gameplay/autonomy.
  config.speechLlm = {
    apiKey: getEnvVarFromKeys(SPEECH_LLM_API_KEY_KEYS, defaultConfig.speechLlm.apiKey)!,
    baseUrl: getEnvVarFromKeys(SPEECH_LLM_BASE_URL_KEYS, defaultConfig.speechLlm.baseUrl)!,
    model: getEnvVarFromKeys(SPEECH_LLM_MODEL_KEYS, defaultConfig.speechLlm.model)!,
    reasoningModel: getEnvVarFromKeys(SPEECH_LLM_REASONING_MODEL_KEYS, defaultConfig.speechLlm.reasoningModel)!,
    publicSpeakModel: getEnvVarFromKeys(SPEECH_LLM_PUBLIC_SPEAK_MODEL_KEYS, defaultConfig.speechLlm.publicSpeakModel)!,
  }

  if (!config.speechLlm.apiKey.trim()) {
    config.speechLlm.apiKey = config.llm.apiKey
  }
  if (!config.speechLlm.baseUrl.trim()) {
    config.speechLlm.baseUrl = config.llm.baseUrl
  }
  if (!config.speechLlm.model.trim()) {
    config.speechLlm.model = config.llm.model
  }
  if (!config.speechLlm.reasoningModel.trim()) {
    config.speechLlm.reasoningModel = config.speechLlm.model || config.llm.reasoningModel || config.llm.model
  }
  if (!config.speechLlm.publicSpeakModel.trim()) {
    config.speechLlm.publicSpeakModel = config.speechLlm.model || config.llm.publicSpeakModel || config.llm.model
  }

  config.bot = {
    username: getEnvVar('BOT_USERNAME', defaultConfig.bot.username as string)!,
    host: getEnvVar('BOT_HOSTNAME', defaultConfig.bot.host as string)!,
    port: getEnvNumber('BOT_PORT', defaultConfig.bot.port as number),
    auth: getEnvVar('BOT_AUTH', defaultConfig.bot.auth as string | undefined) as BotOptions['auth'],
    version: getEnvVar('BOT_VERSION', defaultConfig.bot.version as string),
  }

  config.airi = {
    wsBaseUrl: getEnvVar('AIRI_WS_BASEURL', defaultConfig.airi.wsBaseUrl)!,
    clientName: getEnvVar('AIRI_CLIENT_NAME', defaultConfig.airi.clientName)!,
  }

  // Structured decision provider for autonomous goal selection and gameplay-side planning.
  config.autonomyLlm = {
    enabled: getEnvBooleanFromKeys(AUTONOMY_LLM_ENABLED_KEYS, defaultConfig.autonomyLlm.enabled),
    apiKey: getEnvVarFromKeys(AUTONOMY_LLM_API_KEY_KEYS, defaultConfig.autonomyLlm.apiKey)!,
    baseUrl: getEnvVarFromKeys(AUTONOMY_LLM_BASE_URL_KEYS, defaultConfig.autonomyLlm.baseUrl)!,
    model: getEnvVarFromKeys(AUTONOMY_LLM_MODEL_KEYS, defaultConfig.autonomyLlm.model)!,
    liveModel: getEnvVarFromKeys(AUTONOMY_LLM_LIVE_MODEL_KEYS, defaultConfig.autonomyLlm.liveModel)!,
    useLiveApi: getEnvBooleanFromKeys(AUTONOMY_LLM_USE_LIVE_API_KEYS, defaultConfig.autonomyLlm.useLiveApi),
    temperature: getEnvFloatFromKeys(AUTONOMY_LLM_TEMPERATURE_KEYS, defaultConfig.autonomyLlm.temperature),
    maxOutputTokens: getEnvNumberFromKeys(AUTONOMY_LLM_MAX_OUTPUT_TOKENS_KEYS, defaultConfig.autonomyLlm.maxOutputTokens),
  }

  if (!config.autonomyLlm.apiKey.trim()) {
    config.autonomyLlm.apiKey = config.llm.apiKey
  }
  if (!config.autonomyLlm.baseUrl.trim()) {
    config.autonomyLlm.baseUrl = config.llm.baseUrl
  }
  if (!config.autonomyLlm.model.trim()) {
    config.autonomyLlm.model = config.llm.model
  }

  // Optional Gemini-backed speech generation. This stays separate from autonomy decision models.
  config.geminiSpeech = {
    apiKey: getEnvVarFromKeys(GEMINI_SPEECH_API_KEY_KEYS, defaultConfig.geminiSpeech.apiKey)!,
    baseUrl: getEnvVarFromKeys(GEMINI_SPEECH_BASE_URL_KEYS, defaultConfig.geminiSpeech.baseUrl)!,
    model: getEnvVarFromKeys(GEMINI_SPEECH_MODEL_KEYS, defaultConfig.geminiSpeech.model)!,
    liveModel: getEnvVarFromKeys(GEMINI_SPEECH_LIVE_MODEL_KEYS, defaultConfig.geminiSpeech.liveModel)!,
    liveSpeechEnabled: getEnvBooleanFromKeys(GEMINI_SPEECH_ENABLED_KEYS, defaultConfig.geminiSpeech.liveSpeechEnabled),
    liveSpeechModel: getEnvVarFromKeys(GEMINI_SPEECH_MODEL_OVERRIDE_KEYS, defaultConfig.geminiSpeech.liveSpeechModel)!,
    liveSpeechLanguageCode: getEnvVarFromKeys(GEMINI_SPEECH_LANGUAGE_CODE_KEYS, defaultConfig.geminiSpeech.liveSpeechLanguageCode)!,
    liveSpeechVoiceName: getEnvVarFromKeys(GEMINI_SPEECH_VOICE_NAME_KEYS, defaultConfig.geminiSpeech.liveSpeechVoiceName)!,
  }

  const localTtsProvider = parseLocalTtsProvider(
    getEnvVar('LOCAL_TTS_PROVIDER', defaultConfig.localTts.provider),
    defaultConfig.localTts.provider,
  )

  config.localTts = {
    enabled: getEnvBoolean('LOCAL_TTS_ENABLED', defaultConfig.localTts.enabled),
    provider: localTtsProvider,
    baseUrl: getEnvVar('LOCAL_TTS_BASEURL', defaultConfig.localTts.baseUrl)!,
    serializeWithGpu: getEnvBoolean('LOCAL_TTS_SERIALIZE_WITH_GPU', defaultConfig.localTts.serializeWithGpu),
    speaker: getEnvNumber('LOCAL_TTS_SPEAKER', defaultConfig.localTts.speaker),
    speedScale: getEnvFloat('LOCAL_TTS_SPEED_SCALE', defaultConfig.localTts.speedScale),
    pitchScale: getEnvFloat('LOCAL_TTS_PITCH_SCALE', defaultConfig.localTts.pitchScale),
    intonationScale: getEnvFloat('LOCAL_TTS_INTONATION_SCALE', defaultConfig.localTts.intonationScale),
    volumeScale: getEnvFloat('LOCAL_TTS_VOLUME_SCALE', defaultConfig.localTts.volumeScale),
    styleBertVits2EndpointPath: getEnvVar('LOCAL_TTS_STYLE_BERT_VITS2_ENDPOINT_PATH', defaultConfig.localTts.styleBertVits2EndpointPath)!,
    styleBertVits2ModelId: getEnvNumber('LOCAL_TTS_STYLE_BERT_VITS2_MODEL_ID', defaultConfig.localTts.styleBertVits2ModelId),
    styleBertVits2SpeakerId: getEnvNumber('LOCAL_TTS_STYLE_BERT_VITS2_SPEAKER_ID', defaultConfig.localTts.styleBertVits2SpeakerId),
    styleBertVits2Style: getEnvVar('LOCAL_TTS_STYLE_BERT_VITS2_STYLE', defaultConfig.localTts.styleBertVits2Style)!,
    styleBertVits2StyleWeight: getEnvFloat('LOCAL_TTS_STYLE_BERT_VITS2_STYLE_WEIGHT', defaultConfig.localTts.styleBertVits2StyleWeight),
    styleBertVits2SdpRatio: getEnvFloat('LOCAL_TTS_STYLE_BERT_VITS2_SDP_RATIO', defaultConfig.localTts.styleBertVits2SdpRatio),
    styleBertVits2Noise: getEnvFloat('LOCAL_TTS_STYLE_BERT_VITS2_NOISE', defaultConfig.localTts.styleBertVits2Noise),
    styleBertVits2NoiseW: getEnvFloat('LOCAL_TTS_STYLE_BERT_VITS2_NOISE_W', defaultConfig.localTts.styleBertVits2NoiseW),
    styleBertVits2Length: getEnvFloat('LOCAL_TTS_STYLE_BERT_VITS2_LENGTH', defaultConfig.localTts.styleBertVits2Length),
    styleBertVits2Language: getEnvVar('LOCAL_TTS_STYLE_BERT_VITS2_LANGUAGE', defaultConfig.localTts.styleBertVits2Language)!,
    irodoriEndpointPath: getEnvVar('LOCAL_TTS_IRODORI_ENDPOINT_PATH', defaultConfig.localTts.irodoriEndpointPath)!,
    irodoriHfCheckpoint: getEnvVar('LOCAL_TTS_IRODORI_HF_CHECKPOINT', defaultConfig.localTts.irodoriHfCheckpoint)!,
    irodoriCaption: getEnvVar('LOCAL_TTS_IRODORI_CAPTION', defaultConfig.localTts.irodoriCaption)!,
  }

  config.publicSpeak = {
    provider: parsePublicSpeakProvider(
      getEnvVarFromKeys(PUBLIC_SPEAK_PROVIDER_KEYS, defaultConfig.publicSpeak.provider),
      defaultConfig.publicSpeak.provider,
    ),
  }

  config.autonomy = {
    enabled: getEnvBoolean('AUTONOMY_ENABLED', defaultConfig.autonomy.enabled),
    mode: parseAutonomyMode(getEnvVar('AUTONOMY_MODE', defaultConfig.autonomy.mode), defaultConfig.autonomy.mode),
    fillerChatEnabled: getEnvBoolean('AUTONOMY_FILLER_CHAT_ENABLED', defaultConfig.autonomy.fillerChatEnabled),
    lowVramMode: getEnvBoolean('AUTONOMY_LOW_VRAM_MODE', defaultConfig.autonomy.lowVramMode),
    singleInferenceLane: getEnvBoolean('AUTONOMY_SINGLE_INFERENCE_LANE', defaultConfig.autonomy.singleInferenceLane),
    loopIntervalMs: getEnvNumber('AUTONOMY_LOOP_INTERVAL_MS', defaultConfig.autonomy.loopIntervalMs),
    minGoalIntervalMs: getEnvNumber('AUTONOMY_MIN_GOAL_INTERVAL_MS', defaultConfig.autonomy.minGoalIntervalMs),
    goalLockMs: getEnvNumber('AUTONOMY_GOAL_LOCK_MS', defaultConfig.autonomy.goalLockMs),
    maxContextMessages: getEnvNumber('AUTONOMY_MAX_CONTEXT_MESSAGES', defaultConfig.autonomy.maxContextMessages),
    maxPlannerContextItems: getEnvNumber('AUTONOMY_MAX_PLANNER_CONTEXT_ITEMS', defaultConfig.autonomy.maxPlannerContextItems),
    maxSpeechContextItems: getEnvNumber('AUTONOMY_MAX_SPEECH_CONTEXT_ITEMS', defaultConfig.autonomy.maxSpeechContextItems),
    narrationMinIntervalMs: getEnvNumber('AUTONOMY_NARRATION_MIN_INTERVAL_MS', defaultConfig.autonomy.narrationMinIntervalMs),
    maxConsecutiveKeepalives: getEnvNumber('AUTONOMY_MAX_CONSECUTIVE_KEEPALIVES', defaultConfig.autonomy.maxConsecutiveKeepalives),
    selfGoals: getEnvList('AUTONOMY_SELF_GOALS', defaultConfig.autonomy.selfGoals),
    selfGoalWeight: getEnvFloat('AUTONOMY_SELF_GOAL_WEIGHT', defaultConfig.autonomy.selfGoalWeight),
    socialWeight: getEnvFloat('AUTONOMY_SOCIAL_WEIGHT', defaultConfig.autonomy.socialWeight),
    commentWeight: getEnvFloat('AUTONOMY_COMMENT_WEIGHT', defaultConfig.autonomy.commentWeight),
  }

  const subtitleFilePath = getEnvVar('OBS_SUBTITLE_FILE_PATH', defaultConfig.subtitle.filePath)!
  config.subtitle = {
    enabled: getEnvBoolean('OBS_SUBTITLE_ENABLED', subtitleFilePath.trim().length > 0 ? true : defaultConfig.subtitle.enabled),
    filePath: subtitleFilePath,
    maxCharsPerLine: getEnvNumber('OBS_SUBTITLE_MAX_CHARS_PER_LINE', defaultConfig.subtitle.maxCharsPerLine),
    maxLines: getEnvNumber('OBS_SUBTITLE_MAX_LINES', defaultConfig.subtitle.maxLines),
  }

  config.youtube = {
    enabled: getEnvBoolean('YOUTUBE_ENABLED', defaultConfig.youtube.enabled),
    apiKey: getEnvVar('YOUTUBE_API_KEY', defaultConfig.youtube.apiKey)!,
    liveChatId: getEnvVar('YOUTUBE_LIVE_CHAT_ID', defaultConfig.youtube.liveChatId)!,
    liveVideoId: getEnvVar('YOUTUBE_LIVE_VIDEO_ID', defaultConfig.youtube.liveVideoId)!,
    liveUrl: getEnvVar('YOUTUBE_LIVE_URL', defaultConfig.youtube.liveUrl)!,
    oauthAccessToken: getEnvVar('YOUTUBE_OAUTH_ACCESS_TOKEN', defaultConfig.youtube.oauthAccessToken)!,
    pollIntervalMs: getEnvNumber('YOUTUBE_POLL_INTERVAL_MS', defaultConfig.youtube.pollIntervalMs),
    quotaBackoffMs: getEnvNumber('YOUTUBE_QUOTA_BACKOFF_MS', defaultConfig.youtube.quotaBackoffMs),
    maxResults: getEnvNumber('YOUTUBE_MAX_RESULTS', defaultConfig.youtube.maxResults),
    maxPendingMessages: getEnvNumber('YOUTUBE_MAX_PENDING_MESSAGES', defaultConfig.youtube.maxPendingMessages),
    replyEnabled: getEnvBoolean('YOUTUBE_REPLY_ENABLED', defaultConfig.youtube.replyEnabled),
    maxDailyReplies: getEnvNumber('YOUTUBE_MAX_DAILY_REPLIES', defaultConfig.youtube.maxDailyReplies),
    commentOverlayEnabled: getEnvBoolean('YOUTUBE_COMMENT_OVERLAY_ENABLED', defaultConfig.youtube.commentOverlayEnabled),
    commentOverlayFilePath: getEnvVar('YOUTUBE_COMMENT_OVERLAY_FILE_PATH', defaultConfig.youtube.commentOverlayFilePath)!,
    commentOverlayMaxCharsPerLine: getEnvNumber('YOUTUBE_COMMENT_OVERLAY_MAX_CHARS_PER_LINE', defaultConfig.youtube.commentOverlayMaxCharsPerLine),
    commentOverlayMaxLines: getEnvNumber('YOUTUBE_COMMENT_OVERLAY_MAX_LINES', defaultConfig.youtube.commentOverlayMaxLines),
    commentOverlayIncludeAuthor: getEnvBoolean('YOUTUBE_COMMENT_OVERLAY_INCLUDE_AUTHOR', defaultConfig.youtube.commentOverlayIncludeAuthor),
    commentOverlayRecentEnabled: getEnvBoolean('YOUTUBE_COMMENT_OVERLAY_RECENT_ENABLED', defaultConfig.youtube.commentOverlayRecentEnabled),
    commentOverlayRecentFilePath: getEnvVar('YOUTUBE_COMMENT_OVERLAY_RECENT_FILE_PATH', defaultConfig.youtube.commentOverlayRecentFilePath)!,
    commentOverlayRecentMaxItems: getEnvNumber('YOUTUBE_COMMENT_OVERLAY_RECENT_MAX_ITEMS', defaultConfig.youtube.commentOverlayRecentMaxItems),
  }

  config.fabricBridge = {
    enabled: getEnvBoolean('FABRIC_BRIDGE_ENABLED', defaultConfig.fabricBridge.enabled),
    host: getEnvVar('FABRIC_BRIDGE_HOST', defaultConfig.fabricBridge.host)!,
    port: getEnvNumber('FABRIC_BRIDGE_PORT', defaultConfig.fabricBridge.port),
    reconnectInterval: getEnvNumber('FABRIC_BRIDGE_RECONNECT_INTERVAL', defaultConfig.fabricBridge.reconnectInterval),
    maxReconnectAttempts: getEnvNumber('FABRIC_BRIDGE_MAX_RECONNECT_ATTEMPTS', defaultConfig.fabricBridge.maxReconnectAttempts),
  }

  config.monitor = {
    enabled: getEnvBoolean('MONITOR_ENABLED', defaultConfig.monitor.enabled),
    port: getEnvNumber('MONITOR_PORT', defaultConfig.monitor.port),
  }

  const viewerPort = getEnvNumber('VIEWER_PORT', defaultConfig.viewer.port)
  config.viewer = {
    enabled: getEnvBoolean('VIEWER_ENABLED', defaultConfig.viewer.enabled),
    port: viewerPort,
    hudEnabled: getEnvBoolean('VIEWER_HUD_ENABLED', defaultConfig.viewer.hudEnabled),
    hudPort: getEnvNumber('VIEWER_HUD_PORT', viewerPort + 1),
    firstPerson: getEnvBoolean('VIEWER_FIRST_PERSON', defaultConfig.viewer.firstPerson),
    viewDistance: getEnvNumber('VIEWER_VIEW_DISTANCE', defaultConfig.viewer.viewDistance),
    prefix: getEnvVar('VIEWER_PREFIX', defaultConfig.viewer.prefix)!,
  }

  logger.withFields({ config: redactConfigForLog(config) }).log('Environment variables initialized')
}
