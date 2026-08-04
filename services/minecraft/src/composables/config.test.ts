import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key]
  }

  Object.assign(process.env, ORIGINAL_ENV)
}

async function loadConfigModule() {
  vi.resetModules()
  return await import('./config')
}

afterEach(() => {
  resetEnv()
})

describe('minecraft config env aliases', () => {
  it('prefers LLM_* over legacy OPENAI_* for the primary LLM', async () => {
    process.env.OPENAI_API_KEY = 'legacy-openai'
    process.env.OPENAI_API_BASEURL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'legacy-model'
    process.env.OPENAI_REASONING_MODEL = 'legacy-reasoning'

    process.env.LLM_API_KEY = 'new-openai'
    process.env.LLM_BASE_URL = 'https://api.openai.com/v1'
    process.env.LLM_MODEL = 'gpt-4o-mini'
    process.env.LLM_REASONING_MODEL = 'gpt-4.1-mini'
    process.env.LLM_PUBLIC_SPEAK_MODEL = 'gpt-4o-nano'

    const { config, initEnv } = await loadConfigModule()
    initEnv()

    expect(config.llm.apiKey).toBe('new-openai')
    expect(config.llm.baseUrl).toBe('https://api.openai.com/v1')
    expect(config.llm.model).toBe('gpt-4o-mini')
    expect(config.llm.reasoningModel).toBe('gpt-4.1-mini')
    expect(config.llm.publicSpeakModel).toBe('gpt-4o-nano')

    expect(config.openai.apiKey).toBe('new-openai')
    expect(config.openai.baseUrl).toBe('https://api.openai.com/v1')
    expect(config.openai.model).toBe('gpt-4o-mini')
    expect(config.openai.reasoningModel).toBe('gpt-4.1-mini')
    expect(config.openai.publicSpeakModel).toBe('gpt-4o-nano')
  })

  it('lets speech generation override the primary llm while keeping legacy fallbacks', async () => {
    process.env.LLM_API_KEY = 'shared-openai-key'
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1'
    process.env.LLM_MODEL = 'gemma4:e4b'
    process.env.LLM_REASONING_MODEL = 'gemma4:e4b'
    process.env.LLM_PUBLIC_SPEAK_MODEL = 'gemma4:e2b'

    process.env.SPEECH_LLM_API_KEY = 'speech-key'
    process.env.SPEECH_LLM_BASE_URL = 'https://api.example.com/v1'
    process.env.SPEECH_LLM_MODEL = 'gemma-remote'
    process.env.SPEECH_LLM_REASONING_MODEL = 'gemma-remote-reasoning'
    process.env.SPEECH_LLM_PUBLIC_SPEAK_MODEL = 'gemma-remote-speak'

    const { config, initEnv } = await loadConfigModule()
    initEnv()

    expect(config.llm.apiKey).toBe('shared-openai-key')
    expect(config.llm.model).toBe('gemma4:e4b')

    expect(config.speechLlm.apiKey).toBe('speech-key')
    expect(config.speechLlm.baseUrl).toBe('https://api.example.com/v1')
    expect(config.speechLlm.model).toBe('gemma-remote')
    expect(config.speechLlm.reasoningModel).toBe('gemma-remote-reasoning')
    expect(config.speechLlm.publicSpeakModel).toBe('gemma-remote-speak')
  })

  it('falls back to the primary llm when SPEECH_LLM_* is not provided', async () => {
    process.env.LLM_API_KEY = 'shared-openai-key'
    process.env.LLM_BASE_URL = 'https://api.openai.com/v1'
    process.env.LLM_MODEL = 'gpt-5.4-mini'
    process.env.LLM_REASONING_MODEL = 'gpt-5.4-mini'
    process.env.LLM_PUBLIC_SPEAK_MODEL = 'gpt-5.4-nano'

    const { config, initEnv } = await loadConfigModule()
    initEnv()

    expect(config.speechLlm.apiKey).toBe('shared-openai-key')
    expect(config.speechLlm.baseUrl).toBe('https://api.openai.com/v1')
    expect(config.speechLlm.model).toBe('gpt-5.4-mini')
    expect(config.speechLlm.reasoningModel).toBe('gpt-5.4-mini')
    expect(config.speechLlm.publicSpeakModel).toBe('gpt-5.4-nano')
  })

  it('maps AUTONOMY_LLM_* separately from Gemini speech settings while keeping legacy alias access', async () => {
    process.env.AUTONOMY_LLM_ENABLED = 'true'
    process.env.AUTONOMY_LLM_API_KEY = 'autonomy-key'
    process.env.AUTONOMY_LLM_BASE_URL = 'http://localhost:11434/v1'
    process.env.AUTONOMY_LLM_MODEL = 'airi-gemma3-4b'
    process.env.AUTONOMY_LLM_LIVE_MODEL = 'airi-gemma3-4b-live'
    process.env.AUTONOMY_LLM_USE_LIVE_API = 'false'
    process.env.AUTONOMY_LLM_TEMPERATURE = '0.3'
    process.env.AUTONOMY_LLM_MAX_OUTPUT_TOKENS = '256'

    process.env.GEMINI_API_KEY = 'gemini-key'
    process.env.GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'
    process.env.GEMINI_HTTP_MODEL = 'gemini-2.5-flash'
    process.env.GEMINI_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025'
    process.env.GEMINI_LIVE_SPEECH_ENABLED = 'true'
    process.env.GEMINI_LIVE_SPEECH_MODEL = 'gemini-2.5-flash-preview-tts'
    process.env.GEMINI_LIVE_SPEECH_LANGUAGE_CODE = 'ja-JP'
    process.env.GEMINI_LIVE_SPEECH_VOICE_NAME = 'Kore'

    const { config, initEnv } = await loadConfigModule()
    initEnv()

    expect(config.autonomyLlm.enabled).toBe(true)
    expect(config.autonomyLlm.apiKey).toBe('autonomy-key')
    expect(config.autonomyLlm.baseUrl).toBe('http://localhost:11434/v1')
    expect(config.autonomyLlm.model).toBe('airi-gemma3-4b')
    expect(config.autonomyLlm.liveModel).toBe('airi-gemma3-4b-live')
    expect(config.autonomyLlm.useLiveApi).toBe(false)
    expect(config.autonomyLlm.temperature).toBe(0.3)
    expect(config.autonomyLlm.maxOutputTokens).toBe(256)

    expect(config.geminiSpeech.apiKey).toBe('gemini-key')
    expect(config.geminiSpeech.baseUrl).toBe('https://generativelanguage.googleapis.com')
    expect(config.geminiSpeech.model).toBe('gemini-2.5-flash')
    expect(config.geminiSpeech.liveModel).toBe('gemini-2.5-flash-native-audio-preview-12-2025')
    expect(config.geminiSpeech.liveSpeechEnabled).toBe(true)
    expect(config.geminiSpeech.liveSpeechModel).toBe('gemini-2.5-flash-preview-tts')
    expect(config.geminiSpeech.liveSpeechLanguageCode).toBe('ja-JP')
    expect(config.geminiSpeech.liveSpeechVoiceName).toBe('Kore')

    expect(config.gemini.enabled).toBe(true)
    expect(config.gemini.model).toBe('airi-gemma3-4b')
    expect(config.gemini.liveSpeechModel).toBe('gemini-2.5-flash-preview-tts')
  })

  it('falls back to legacy GEMINI_* keys for autonomy when new keys are not present', async () => {
    process.env.GEMINI_ENABLED = 'true'
    process.env.GEMINI_API_KEY = 'legacy-gemini-key'
    process.env.GEMINI_API_BASEURL = 'http://localhost:11434/v1'
    process.env.GEMINI_MODEL = 'legacy-gemma'
    process.env.GEMINI_LIVE_MODEL = 'legacy-gemma-live'
    process.env.GEMINI_USE_LIVE_API = 'false'
    process.env.GEMINI_TEMPERATURE = '0.4'
    process.env.GEMINI_MAX_OUTPUT_TOKENS = '384'

    const { config, initEnv } = await loadConfigModule()
    initEnv()

    expect(config.autonomyLlm.enabled).toBe(true)
    expect(config.autonomyLlm.apiKey).toBe('legacy-gemini-key')
    expect(config.autonomyLlm.baseUrl).toBe('http://localhost:11434/v1')
    expect(config.autonomyLlm.model).toBe('legacy-gemma')
    expect(config.autonomyLlm.liveModel).toBe('legacy-gemma-live')
    expect(config.autonomyLlm.useLiveApi).toBe(false)
    expect(config.autonomyLlm.temperature).toBe(0.4)
    expect(config.autonomyLlm.maxOutputTokens).toBe(384)
  })

  it('reuses the primary LLM credentials for autonomy when autonomy-specific credentials are omitted', async () => {
    process.env.LLM_API_KEY = 'shared-openai-key'
    process.env.LLM_BASE_URL = 'https://api.openai.com/v1'
    process.env.LLM_MODEL = 'gpt-5.4-mini'

    process.env.AUTONOMY_LLM_ENABLED = 'true'
    process.env.AUTONOMY_LLM_API_KEY = ''
    process.env.AUTONOMY_LLM_BASE_URL = ''
    process.env.AUTONOMY_LLM_MODEL = ''

    const { config, initEnv } = await loadConfigModule()
    initEnv()

    expect(config.autonomyLlm.apiKey).toBe('shared-openai-key')
    expect(config.autonomyLlm.baseUrl).toBe('https://api.openai.com/v1')
    expect(config.autonomyLlm.model).toBe('gpt-5.4-mini')
    expect(config.gemini.apiKey).toBe('shared-openai-key')
    expect(config.gemini.baseUrl).toBe('https://api.openai.com/v1')
    expect(config.gemini.model).toBe('gpt-5.4-mini')
  })

  it('parses irodori local tts settings', async () => {
    process.env.LOCAL_TTS_ENABLED = 'true'
    process.env.LOCAL_TTS_PROVIDER = 'irodori'
    process.env.LOCAL_TTS_BASEURL = 'http://127.0.0.1:5000'
    process.env.LOCAL_TTS_IRODORI_ENDPOINT_PATH = '/voice'
    process.env.LOCAL_TTS_IRODORI_HF_CHECKPOINT = 'Aratako/Irodori-TTS-500M-v2-VoiceDesign'
    process.env.LOCAL_TTS_IRODORI_CAPTION = '高校生くらいの若い声'

    const { config, initEnv } = await loadConfigModule()
    initEnv()

    expect(config.localTts.enabled).toBe(true)
    expect(config.localTts.provider).toBe('irodori-tts')
    expect(config.localTts.baseUrl).toBe('http://127.0.0.1:5000')
    expect(config.localTts.irodoriEndpointPath).toBe('/voice')
    expect(config.localTts.irodoriHfCheckpoint).toBe('Aratako/Irodori-TTS-500M-v2-VoiceDesign')
    expect(config.localTts.irodoriCaption).toBe('高校生くらいの若い声')
  })

  it('parses public speak provider selection', async () => {
    process.env.PUBLIC_SPEAK_PROVIDER = 'gemini'

    const { config, initEnv } = await loadConfigModule()
    initEnv()

    expect(config.publicSpeak.provider).toBe('gemini')
  })

  it('parses low-vram autonomy scheduling controls', async () => {
    process.env.AUTONOMY_LOW_VRAM_MODE = 'true'
    process.env.AUTONOMY_SINGLE_INFERENCE_LANE = 'true'
    process.env.AUTONOMY_MAX_PLANNER_CONTEXT_ITEMS = '6'
    process.env.AUTONOMY_MAX_SPEECH_CONTEXT_ITEMS = '5'
    process.env.AUTONOMY_NARRATION_MIN_INTERVAL_MS = '15000'
    process.env.AUTONOMY_MAX_CONSECUTIVE_KEEPALIVES = '1'

    const { config, initEnv } = await loadConfigModule()
    initEnv()

    expect(config.autonomy.lowVramMode).toBe(true)
    expect(config.autonomy.singleInferenceLane).toBe(true)
    expect(config.autonomy.maxPlannerContextItems).toBe(6)
    expect(config.autonomy.maxSpeechContextItems).toBe(5)
    expect(config.autonomy.narrationMinIntervalMs).toBe(15000)
    expect(config.autonomy.maxConsecutiveKeepalives).toBe(1)
  })
})
