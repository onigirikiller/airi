import type { ConnectionSettings, PersonaConfig } from '../types'

const ARENA_SETTINGS_KEY = 'connect-four-arena/settings'
const ARENA_PERSONAS_KEY = 'connect-four-arena/personas'
const LEGACY_DEFAULT_BASE_URLS = new Set([
  'http://127.0.0.1:11434/v1/',
  'http://localhost:11434/v1/',
])
const LEGACY_DEFAULT_MODEL = 'qwen3:8b'

export const defaultSettings: ConnectionSettings = {
  apiKey: '',
  autoPlay: true,
  baseUrl: 'http://localhost:1234/v1/',
  model: 'agents-a1-4b',
  moveDelayMs: 900,
  temperature: 0.65,
}

export const defaultPersonas: PersonaConfig[] = [
  {
    id: 'red',
    name: 'AIra',
    personality: '好奇心旺盛で直感を信じるAI VTuber。大胆な勝負を好み、明るく自信のある口調で話す。負け筋にも臆せず、盤面に物語を見つける。',
  },
  {
    id: 'yellow',
    name: 'Noir',
    personality: '冷静で観察力の高い戦略家。相手の狙いを先に潰し、静かなユーモアを交えて簡潔に話す。派手さより確実な優位を積み上げる。',
  },
]

interface StoredSetup {
  personas: PersonaConfig[]
  settings: ConnectionSettings
  source: 'airi' | 'arena' | 'default'
}

function parseJson<T>(value: string | null): T | null {
  if (!value)
    return null

  try {
    return JSON.parse(value) as T
  }
  catch {
    return null
  }
}

export function migrateLegacyDefaults(settings: ConnectionSettings): ConnectionSettings {
  return {
    ...settings,
    baseUrl: LEGACY_DEFAULT_BASE_URLS.has(settings.baseUrl)
      ? defaultSettings.baseUrl
      : settings.baseUrl,
    model: settings.model === LEGACY_DEFAULT_MODEL
      ? defaultSettings.model
      : settings.model,
  }
}

/** Reads AIRI's canonical consciousness keys when this app is hosted on the same origin. */
export function readAiriConnection(storage: Storage): Partial<ConnectionSettings> | null {
  const providerId = storage.getItem('settings/consciousness/active-provider')
  const model = storage.getItem('settings/consciousness/active-model')
  const providers = parseJson<Record<string, Record<string, unknown>>>(storage.getItem('settings/credentials/providers'))
  const provider = providerId && providers ? providers[providerId] : null

  if (!model || !provider)
    return null

  const baseUrl = typeof provider.baseUrl === 'string'
    ? provider.baseUrl
    : typeof provider.baseURL === 'string' ? provider.baseURL : ''
  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey : ''

  if (!baseUrl)
    return null

  return { apiKey, baseUrl, model }
}

export function loadSetup(storage: Storage): StoredSetup {
  const storedSettings = parseJson<Partial<ConnectionSettings>>(storage.getItem(ARENA_SETTINGS_KEY))
  const storedPersonas = parseJson<PersonaConfig[]>(storage.getItem(ARENA_PERSONAS_KEY))

  if (storedSettings) {
    return {
      personas: storedPersonas?.length === 2 ? storedPersonas : structuredClone(defaultPersonas),
      settings: migrateLegacyDefaults({ ...defaultSettings, ...storedSettings }),
      source: 'arena',
    }
  }

  const airiConnection = readAiriConnection(storage)
  return {
    personas: storedPersonas?.length === 2 ? storedPersonas : structuredClone(defaultPersonas),
    settings: migrateLegacyDefaults({ ...defaultSettings, ...airiConnection }),
    source: airiConnection ? 'airi' : 'default',
  }
}

export function saveSetup(storage: Storage, settings: ConnectionSettings, personas: PersonaConfig[]) {
  storage.setItem(ARENA_SETTINGS_KEY, JSON.stringify(settings))
  storage.setItem(ARENA_PERSONAS_KEY, JSON.stringify(personas))
}
