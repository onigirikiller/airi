import { describe, expect, it } from 'vitest'

import { buildDeterministicNarration } from './narration'

describe('buildDeterministicNarration', () => {
  it('grounds progress speech in the current goal and next need', () => {
    const result = buildDeterministicNarration({
      goalLabel: '鉄確保',
      actionLabel: '採掘',
      obstacle: '岩盤まわりの段差',
      milestone: 'iron-acquisition',
      unresolvedNeeds: ['iron-ore'],
      blockers: [],
      danger: [],
      changedParts: ['action: 移動 -> 採掘'],
      reason: 'periodic-progress:採掘',
      allowKeepalive: true,
      recentFamilies: [],
      consecutiveKeepalives: 0,
      maxConsecutiveKeepalives: 2,
    })

    expect(result.speechIntent).toBe('discovery')
    expect(result.groundingSource).toBe('state-delta')
    expect(result.text).toContain('鉄確保')
    expect(result.text).toContain('鉄鉱石')
  })

  it('suppresses repeated keepalives after the configured limit', () => {
    const result = buildDeterministicNarration({
      goalLabel: 'かまど確保',
      actionLabel: '移動',
      obstacle: '坂',
      milestone: 'furnace',
      unresolvedNeeds: ['furnace'],
      blockers: [],
      danger: [],
      changedParts: [],
      reason: 'voiced-keepalive',
      allowKeepalive: true,
      recentFamilies: ['keepalive:furnace', 'keepalive:furnace'],
      consecutiveKeepalives: 2,
      maxConsecutiveKeepalives: 2,
    })

    expect(result.text).toBe('')
    expect(result.suppressedReason).toBe('keepalive-limit')
    expect(result.repetitionCooldownHit).toBe(true)
  })

  it('avoids echoing the same resolve target as both completed goal and next need', () => {
    const result = buildDeterministicNarration({
      goalLabel: '鉄インゴット',
      actionLabel: '精錬',
      obstacle: 'なし',
      milestone: 'iron-smelting',
      unresolvedNeeds: ['iron-ingots'],
      blockers: [],
      danger: [],
      changedParts: ['inventory: iron_ingot +2'],
      reason: 'goal-result-success',
      allowKeepalive: true,
      recentFamilies: [],
      consecutiveKeepalives: 0,
      maxConsecutiveKeepalives: 2,
    })

    expect(result.speechIntent).toBe('resolve')
    expect(result.text).toContain('次の工程')
    expect(result.text).not.toContain('次は鉄インゴット')
  })

  it('uses viewer-address intent when fresh viewer input is the grounding source', () => {
    const result = buildDeterministicNarration({
      goalLabel: '鉄確保',
      actionLabel: '採掘',
      obstacle: '石壁',
      milestone: 'iron-acquisition',
      unresolvedNeeds: ['iron-ore'],
      blockers: [],
      danger: [],
      changedParts: [],
      reason: 'viewer-suggestion',
      allowKeepalive: true,
      recentFamilies: [],
      consecutiveKeepalives: 0,
      maxConsecutiveKeepalives: 2,
      viewerInput: '鉄まだ？',
      lastActionOutcome: 'collectBlocks:verified',
    })

    expect(result.speechIntent).toBe('viewer-address')
    expect(result.groundingSource).toBe('viewer-input')
    expect(result.templateFamily).toBe('viewer-address:viewer-input')
    expect(result.noveltyScore).toBeGreaterThan(0.7)
    expect(result.text).toContain('鉄まだ？')
  })
})
