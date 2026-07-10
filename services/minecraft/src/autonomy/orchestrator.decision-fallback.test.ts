import { describe, expect, it, vi } from 'vitest'

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

describe('autonomous stream orchestrator decision failure', () => {
  it('skips goal selection when the LLM returns a no-op failure intent', async () => {
    const orchestrator = createOrchestrator() as any
    const context = {
      nowIso: new Date().toISOString(),
      botName: 'AIra',
      activeGoal: null,
      activeGoalElapsedMs: 0,
      status: 'ok',
      worldState: 'terrain_context: surface',
      nearbyPlayers: [],
      recentActions: [],
      candidateSelfGoals: ['Gather wood and basic resources near spawn'],
      recentSignals: [],
      socialWeights: {
        selfGoal: 1,
        social: 0.7,
        comment: 0.25,
      },
      conversationContext: {
        recentViewerMessages: [],
        recentAssistantMessages: [],
        suggestedAdjustments: [],
      },
    }

    orchestrator.decisionProvider.decide = vi.fn(async () => ({
      focus: 'self',
      confidence: 0.4,
      reason: 'Autonomy LLM decision failed: Decision OpenAI-compatible API error: 429 Too Many Requests body={"error":{"code":"insufficient_quota"}}',
    }))
    const intent = await orchestrator.decideIntent(context)

    expect(intent.goal).toBeUndefined()
    expect(intent.speak).toBeUndefined()
    expect(intent.reason).toContain('Autonomy LLM decision failed')
    expect(orchestrator.fallbackDecisionProvider).toBeUndefined()
  })

  it('returns a no-op intent when the LLM provider throws', async () => {
    const orchestrator = createOrchestrator() as any
    orchestrator.decisionProvider.decide = vi.fn(async () => {
      throw new Error('provider unavailable')
    })

    const intent = await orchestrator.decideIntent({} as any)

    expect(intent).toMatchObject({
      focus: 'self',
      confidence: 0,
    })
    expect(intent.goal).toBeUndefined()
    expect(intent.reason).toContain('goal selection skipped')
  })
})
