import { describe, expect, it } from 'vitest'

import { loadSetup, readAiriConnection } from './settings'

function createStorage(initial: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(initial))

  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: key => entries.get(key) ?? null,
    key: index => [...entries.keys()][index] ?? null,
    removeItem: key => entries.delete(key),
    setItem: (key, value) => entries.set(key, value),
  }
}

describe('arena settings persistence', () => {
  it('imports AIRI consciousness settings from the canonical storage keys', () => {
    const storage = createStorage({
      'settings/consciousness/active-model': 'qwen3:14b',
      'settings/consciousness/active-provider': 'ollama',
      'settings/credentials/providers': JSON.stringify({
        ollama: {
          apiKey: 'local-key',
          baseUrl: 'http://127.0.0.1:11434/v1/',
        },
      }),
    })

    expect(readAiriConnection(storage)).toEqual({
      apiKey: 'local-key',
      baseUrl: 'http://127.0.0.1:11434/v1/',
      model: 'qwen3:14b',
    })
    expect(loadSetup(storage).source).toBe('airi')
  })

  it('does not import an incomplete AIRI provider', () => {
    const storage = createStorage({
      'settings/consciousness/active-model': 'qwen3:14b',
      'settings/consciousness/active-provider': 'ollama',
      'settings/credentials/providers': '{broken json',
    })

    expect(readAiriConnection(storage)).toBeNull()
    expect(loadSetup(storage).source).toBe('default')
  })

  it('migrates the previous Ollama defaults to the LM Studio model', () => {
    const storage = createStorage({
      'connect-four-arena/settings': JSON.stringify({
        baseUrl: 'http://localhost:11434/v1/',
        model: 'qwen3:8b',
      }),
    })

    expect(loadSetup(storage).settings).toMatchObject({
      baseUrl: 'http://localhost:1234/v1/',
      model: 'agents-a1-4b',
    })
  })

  it('migrates a stale model even when the Base URL was already changed', () => {
    const storage = createStorage({
      'connect-four-arena/settings': JSON.stringify({
        baseUrl: 'http://localhost:1234/v1/',
        model: 'qwen3:8b',
      }),
    })

    expect(loadSetup(storage).settings).toMatchObject({
      baseUrl: 'http://localhost:1234/v1/',
      model: 'agents-a1-4b',
    })
  })

  it('migrates stale AIRI defaults before the first request', () => {
    const storage = createStorage({
      'settings/consciousness/active-model': 'qwen3:8b',
      'settings/consciousness/active-provider': 'ollama',
      'settings/credentials/providers': JSON.stringify({
        ollama: {
          baseUrl: 'http://127.0.0.1:11434/v1/',
        },
      }),
    })

    expect(loadSetup(storage).settings).toMatchObject({
      baseUrl: 'http://localhost:1234/v1/',
      model: 'agents-a1-4b',
    })
  })
})
