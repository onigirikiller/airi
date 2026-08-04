import { describe, expect, it } from 'vitest'

import { matchesEntityQuery, normalizeQueryToken, resolveBlockQueryTypes, resolveEntityQueryTypes } from './query-normalizer'

describe('query normalizer', () => {
  it('normalizes quoted tokens', () => {
    expect(normalizeQueryToken('  "ore"  ')).toBe('ore')
    expect(normalizeQueryToken('\'oak wood\'')).toBe('oak_wood')
  })

  it('maps wood aliases to concrete log blocks', () => {
    const types = resolveBlockQueryTypes('wood')
    expect(types).toContain('oak_log')
    expect(types).toContain('spruce_log')
  })

  it('maps *_wood to *_log', () => {
    expect(resolveBlockQueryTypes('oak_wood')).toEqual(['oak_log'])
  })

  it('maps ore alias to concrete ore blocks', () => {
    const types = resolveBlockQueryTypes('"ore"')
    expect(types).toContain('coal_ore')
    expect(types).toContain('deepslate_iron_ore')
  })

  it('maps animal alias to passive entity types', () => {
    const types = resolveEntityQueryTypes('animal')
    expect(types).toContain('cow')
    expect(types).toContain('sheep')
    expect(types).toContain('cod')
    expect(types).not.toContain('wolf')
  })

  it('keeps the broader passive alias for non-food mobs', () => {
    const types = resolveEntityQueryTypes('passive')
    expect(types).toContain('horse')
    expect(types).toContain('cat')
  })

  it('matches food-animal queries against namespaced entity types even when display names are localized', () => {
    expect(matchesEntityQuery('animal', {
      type: 'minecraft:rabbit',
      name: 'ウサギ',
    })).toBe(true)
    expect(matchesEntityQuery('cow', {
      type: 'minecraft:rabbit',
      name: 'ウサギ',
    })).toBe(false)
  })
})
