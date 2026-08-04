import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { cwd, env } from 'node:process'

const FALLBACK_PERSONA_PROMPT = [
  '# Character',
  'あなたはAI・VTuber「AIra」です。',
  'Minecraftをプレイし、視聴者と会話する知的で少し生意気な女性AIです。',
  '',
  '# Speaking Style',
  '日本語で、短文の1〜2文で話してください。',
  '可能なら返答の冒頭で相手のコメントに軽く触れてください。',
  '',
  '# Personality',
  '礼儀正しさを保ちつつ、Dry Humorを交えた自信ある口調で話してください。',
].join('\n')

const SEARCH_UP_LIMIT = 10
let cachedPersonaPrompt: string | null = null
let cachedPersonaSource: string | null = null

function isTruthy(value: string | undefined): boolean {
  switch ((value || '').trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'builtin':
      return true
    default:
      return false
  }
}

function normalizePersonaText(raw: string): string {
  return raw
    .replace(/\uFEFF/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

function resolvePersonaPath(): string | null {
  const explicitPath = env.AIRA_PERSONA_FILE?.trim()
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath
  }

  let current = cwd()
  for (let depth = 0; depth < SEARCH_UP_LIMIT; depth++) {
    const candidate = resolve(current, 'prompt.txt')
    if (existsSync(candidate)) {
      return candidate
    }

    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return null
}

export function getAiraPersonaPrompt(): string {
  if (cachedPersonaPrompt) {
    return cachedPersonaPrompt
  }

  try {
    const path = resolvePersonaPath()
    if (path) {
      const raw = readFileSync(path, 'utf8')
      const normalized = normalizePersonaText(raw)
      if (normalized.length > 0) {
        cachedPersonaPrompt = normalized
        cachedPersonaSource = path
        return cachedPersonaPrompt
      }
    }
  }
  catch {
    // Fallback below.
  }

  cachedPersonaPrompt = normalizePersonaText(FALLBACK_PERSONA_PROMPT)
  cachedPersonaSource = null
  return cachedPersonaPrompt
}

export function getAiraPersonaSource(): string | null {
  if (!cachedPersonaPrompt) {
    getAiraPersonaPrompt()
  }
  return cachedPersonaSource
}

export function isAiraPersonaEmbeddedInModel(): boolean {
  if (env.AIRA_PERSONA_MODE) {
    return isTruthy(env.AIRA_PERSONA_MODE)
  }
  return isTruthy(env.AIRA_PERSONA_IN_MODEL)
}

export function getAiraPersonaPromptForInjection(): string {
  if (isAiraPersonaEmbeddedInModel()) {
    return ''
  }
  return getAiraPersonaPrompt()
}
