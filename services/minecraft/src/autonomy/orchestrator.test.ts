import type { AutonomySignal } from './types'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { config } from '../composables/config'
import { publishAssistantMessageToAiri } from '../libs/llm-agent/output'
import { resetInferenceLaneForTests } from './inference-lane'
import { AutonomousStreamOrchestrator } from './orchestrator'

vi.mock('../libs/llm-agent/output', () => ({
  publishAssistantMessageToAiri: vi.fn(),
}))

vi.mock('../libs/llm-agent/plan-lock', () => ({
  withSharedPlanLock: vi.fn(async (_botName: string, _source: string, _logger: unknown, fn: () => Promise<unknown>) => await fn()),
  forceReleaseSharedPlanLock: vi.fn(),
}))

function createOrchestrator() {
  const bot = {
    username: 'AIra',
    ready: true,
    emit: vi.fn(),
    abortCurrentAction: vi.fn(),
    bot: {
      on: vi.fn(),
      off: vi.fn(),
      chat: vi.fn(),
      players: {},
      inventory: {
        items: () => [],
      },
      health: 20,
      food: 20,
    },
    memory: {
      actions: [],
      chatHistory: [],
    },
    planning: {
      createPlan: vi.fn(),
      executePlan: vi.fn(async () => {}),
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

beforeEach(() => {
  vi.clearAllMocks()
  resetInferenceLaneForTests()
})

describe('autonomous stream orchestrator social directive handling', () => {
  it('extracts requested reply text from viewer directive', () => {
    const orchestrator = createOrchestrator() as any
    const extracted = orchestrator.extractRequestedReplyFromText('testです。受信したら"受信完了"と回答してください。')
    expect(extracted).toBe('受信完了')
  })

  it('extracts requested reply text with curly quote variants', () => {
    const orchestrator = createOrchestrator() as any
    const extracted = orchestrator.extractRequestedReplyFromText('testです。受信したら“受信完了”と回答してください。')
    expect(extracted).toBe('受信完了')
  })

  it('embeds requested reply metadata into social llm prompts instead of bypassing generation', () => {
    const orchestrator = createOrchestrator() as any
    const signal: AutonomySignal = {
      id: 'yt-1',
      source: 'youtube',
      author: 'onigirikiller',
      text: '受信したら「受信完了」と返事してください。',
      importance: 0.9,
      timestamp: Date.now(),
    }

    const seed = orchestrator.buildOutwardSpeakSeed('viewer message received; reply naturally.', signal)
    expect(seed).toContain('requested-reply=受信完了')
    expect(seed).toContain('instead of copying it verbatim')
  })

  it('keeps periodic commentary timer active when AUTONOMY_FILLER_CHAT_ENABLED is false', () => {
    const previousFillerEnabled = config.autonomy.fillerChatEnabled
    config.autonomy.fillerChatEnabled = false

    try {
      const orchestrator = createOrchestrator() as any
      orchestrator.startGoalCommentary('テスト目標')
      expect(orchestrator.goalCommentaryTimer).not.toBeNull()
      if (orchestrator.goalCommentaryTimer) {
        clearInterval(orchestrator.goalCommentaryTimer)
        orchestrator.goalCommentaryTimer = null
      }
    }
    finally {
      config.autonomy.fillerChatEnabled = previousFillerEnabled
    }
  })

  it('uses GPT-based ambient chat generation when filler commentary is disabled', async () => {
    const previousFillerEnabled = config.autonomy.fillerChatEnabled
    config.autonomy.fillerChatEnabled = false

    try {
      const orchestrator = createOrchestrator() as any
      orchestrator.started = true
      orchestrator.executing = false
      orchestrator.lastAmbientStreamChatAt = 0
      orchestrator.generatePublicSpeakFromIntent = vi.fn(async () => 'GPT実況テスト')
      orchestrator.publishAmbientChat = vi.fn()

      const now = Date.now() + 999_999
      await orchestrator.emitAmbientChatIfNeeded(now)

      expect(orchestrator.generatePublicSpeakFromIntent).toHaveBeenCalled()
      expect(orchestrator.publishAmbientChat).toHaveBeenCalledWith('GPT実況テスト', false)
      expect(orchestrator.lastAmbientStreamChatAt).toBe(now)
    }
    finally {
      config.autonomy.fillerChatEnabled = previousFillerEnabled
    }
  })

  it('prefers social replies when social ratio is below target', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.signalBuffer = [{
      id: 'yt-social-ratio',
      source: 'youtube',
      author: 'viewer',
      text: 'test',
      importance: 0.9,
      timestamp: now,
    }]
    orchestrator.replyMixHistory = [{ kind: 'game', at: now - 1000 }]

    const picked = orchestrator.pickSocialSignalForReply(now)
    expect(picked?.id).toBe('yt-social-ratio')
  })

  it('forces a short gameplay break after too many social replies in a row', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.signalBuffer = [{
      id: 'yt-streak',
      source: 'youtube',
      author: 'viewer',
      text: 'test',
      importance: 0.9,
      timestamp: now,
    }]
    orchestrator.socialReplyStreak = 4

    const picked = orchestrator.pickSocialSignalForReply(now)
    expect(picked).toBeUndefined()
    expect(orchestrator.socialReplyGameBreakUntil).toBeGreaterThan(now)
  })

  it('prioritizes requested reply signals even during gameplay break windows', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.socialReplyGameBreakUntil = now + 60_000
    orchestrator.signalBuffer = [{
      id: 'yt-force',
      source: 'youtube',
      author: 'viewer',
      text: '受信したら「受信完了」と回答してください',
      importance: 0.9,
      timestamp: now,
    }]

    const picked = orchestrator.pickSocialSignalForReply(now)
    expect(picked?.id).toBe('yt-force')
  })

  it('replies when a social signal has waited too long even if ratio is already high', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.replyMixHistory = Array.from({ length: 10 }, (_, index) => ({
      kind: 'social',
      at: now - (index + 1) * 1000,
    }))
    orchestrator.signalBuffer = [{
      id: 'yt-old-wait',
      source: 'youtube',
      author: 'viewer',
      text: '古いコメント',
      importance: 0.9,
      timestamp: now - 40_000,
    }]

    const picked = orchestrator.pickSocialSignalForReply(now)
    expect(picked?.id).toBe('yt-old-wait')
  })

  it('maps goToCoordinates to a natural action label', () => {
    const orchestrator = createOrchestrator() as any
    expect(orchestrator.toActionLabel('goToCoordinates')).toBe('移動')
    expect(orchestrator.toActionLabel('some_unknown_action')).toBe('行動')
  })

  it('skips social signals that are already being replied to', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    orchestrator.replyMixHistory = [{ kind: 'game', at: now - 1000 }]
    orchestrator.replyingSocialSignalIds.add('yt-inflight')
    orchestrator.signalBuffer = [{
      id: 'yt-inflight',
      source: 'youtube',
      author: 'viewer',
      text: 'テスト',
      importance: 0.9,
      timestamp: now,
    }]

    const picked = orchestrator.pickSocialSignalForReply(now)
    expect(picked).toBeUndefined()
  })
})

describe('autonomous stream orchestrator dedupe guards', () => {
  it('detects parroted social replies', () => {
    const orchestrator = createOrchestrator() as any
    expect(orchestrator.isSocialReplyParrot('南西案、いいね！', '南西案、いいね！')).toBe(true)
    expect(orchestrator.isSocialReplyParrot('@alice こんにちは', 'こんにちは')).toBe(true)
    expect(orchestrator.isSocialReplyParrot('南西で行くね、石を優先する。', '南西案、いいね！')).toBe(false)
  })
})

describe('autonomous stream orchestrator coordinate stall recovery', () => {
  it('queues deterministic recovery when coordinates stay unchanged for too long during a goal', () => {
    const orchestrator = createOrchestrator() as any
    orchestrator.activeGoal = 'Mine 16 cobblestone'
    orchestrator.executing = true
    orchestrator.bot.bot.entity = { position: { x: 10, y: 64, z: 10 } }

    const t0 = Date.now()
    orchestrator.updateCoordinateStuckState(t0)
    orchestrator.updateCoordinateStuckState(t0 + 121000)

    expect(orchestrator.signalBuffer).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'system',
        author: 'stuck-detector',
        text: expect.stringContaining('stuck-recovery'),
      }),
    ]))
    expect(orchestrator.pendingRecoveryPlan).toEqual(expect.objectContaining({
      reason: expect.stringContaining('stuck-recovery'),
    }))
    expect(orchestrator.pendingRecoveryPlan.plan.steps.map((step: any) => step.tool)).not.toContain('nearbyBlocks')
    expect(orchestrator.pendingRecoveryPlan.plan.steps.at(-1)?.tool).toBe('moveAway')
    expect(orchestrator.criticalRecoveryUntil).toBeGreaterThan(t0)
  })

  it('does not schedule recovery if coordinates moved enough', () => {
    const orchestrator = createOrchestrator() as any
    orchestrator.activeGoal = 'Mine 16 cobblestone'
    orchestrator.executing = true

    const t0 = Date.now()
    orchestrator.bot.bot.entity = { position: { x: 0, y: 64, z: 0 } }
    orchestrator.updateCoordinateStuckState(t0)

    orchestrator.bot.bot.entity = { position: { x: 4, y: 64, z: 0 } }
    orchestrator.updateCoordinateStuckState(t0 + 121000)

    expect(orchestrator.signalBuffer).toEqual([])
  })

  it('suppresses coordinate-stall recovery for wood bootstrap goals', () => {
    const orchestrator = createOrchestrator() as any
    orchestrator.activeGoal = 'Collect logs'
    orchestrator.executing = true
    orchestrator.bot.bot.entity = { position: { x: 10, y: 64, z: 10 } }

    const t0 = Date.now()
    orchestrator.updateCoordinateStuckState(t0)
    orchestrator.updateCoordinateStuckState(t0 + 121000)

    expect(orchestrator.signalBuffer).toEqual([])
    expect(orchestrator.pendingRecoveryPlan).toBeNull()
  })

  it('suppresses coordinate-stall recovery for Japanese wood and crafting-table bootstrap goals', () => {
    const orchestrator = createOrchestrator() as any
    orchestrator.activeGoal = 'スポーン付近で木材を回収し、作業台を設置する'
    orchestrator.executing = true
    orchestrator.bot.bot.entity = { position: { x: 10, y: 64, z: 10 } }

    const t0 = Date.now()
    orchestrator.updateCoordinateStuckState(t0)
    orchestrator.updateCoordinateStuckState(t0 + 121000)

    expect(orchestrator.signalBuffer).toEqual([])
    expect(orchestrator.pendingRecoveryPlan).toBeNull()
  })

  it('suppresses coordinate-stall recovery for stationary smelting goals', () => {
    const orchestrator = createOrchestrator() as any
    orchestrator.activeGoal = 'Smelt raw iron into iron ingots using the furnace'
    orchestrator.executing = true
    orchestrator.bot.bot.entity = { position: { x: -390, y: 70, z: 245 } }

    const t0 = Date.now()
    orchestrator.updateCoordinateStuckState(t0)
    orchestrator.updateCoordinateStuckState(t0 + 121000)

    expect(orchestrator.signalBuffer).toEqual([])
  })

  it('suppresses coordinate-stall recovery while a surface recovery goal is still running', () => {
    const orchestrator = createOrchestrator() as any
    orchestrator.activeGoal = 'Climb out of the enclosed shaft toward the surface'
    orchestrator.executing = true
    orchestrator.bot.bot.entity = { position: { x: -262.5, y: 42, z: 261.5 } }

    const t0 = Date.now()
    orchestrator.updateCoordinateStuckState(t0)
    orchestrator.updateCoordinateStuckState(t0 + 121000)

    expect(orchestrator.signalBuffer).toEqual([])
    expect(orchestrator.pendingRecoveryPlan).toBeNull()
  })

  it('executes deterministic recovery before another LLM decision on the next idle loop', async () => {
    const orchestrator = createOrchestrator() as any
    orchestrator.started = true
    orchestrator.executing = false
    orchestrator.pendingRecoveryPlan = {
      goal: 'Explore nearby terrain for useful resources',
      reason: 'progress-stall: progress stalled for 3 observations',
      queuedAt: Date.now(),
      plan: {
        goal: 'Explore nearby terrain for useful resources',
        status: 'pending',
        requiresAction: true,
        steps: [
          {
            description: 'Move away from the stalled coordinates to force a new path and viewpoint',
            tool: 'moveAway',
            params: { distance: 16 },
            meta: { plannerSource: 'recovery' },
          },
        ],
      },
    }
    orchestrator.executePendingRecoveryPlan = vi.fn(async () => {})
    orchestrator.decideIntent = vi.fn(async () => ({
      confidence: 0.9,
      focus: 'self',
      reason: 'should-not-run',
    }))

    await orchestrator.tickImpl()

    expect(orchestrator.executePendingRecoveryPlan).toHaveBeenCalledOnce()
    expect(orchestrator.decideIntent).not.toHaveBeenCalled()
  })

  it('aborts the active action before deterministic recovery takes control', async () => {
    const orchestrator = createOrchestrator() as any
    orchestrator.executing = true
    orchestrator.activeGoal = 'Mine stone'
    orchestrator.bot.bot.entity = { position: { x: 0, y: 64, z: 0 } }
    orchestrator.pendingRecoveryPlan = {
      goal: 'Recover movement',
      reason: 'coordinate stall',
      queuedAt: Date.now(),
      plan: {
        goal: 'Recover movement',
        status: 'pending',
        requiresAction: true,
        steps: [],
      },
    }
    orchestrator.executePendingRecoveryPlan = vi.fn(async () => {})

    await orchestrator.tickImpl()

    expect(orchestrator.bot.abortCurrentAction).toHaveBeenCalledWith(
      'Deterministic recovery requested: coordinate stall',
    )
    expect(orchestrator.bot.emit).toHaveBeenCalledWith('interrupt')
  })

  it('skips noncritical ambient and keepalive speech when a planning tick is due', async () => {
    const orchestrator = createOrchestrator() as any
    orchestrator.started = true
    orchestrator.executing = false
    orchestrator.lastGoalAt = 0
    orchestrator.emitAmbientChatIfNeeded = vi.fn(async () => undefined)
    orchestrator.emitVoicedKeepAliveIfNeeded = vi.fn(async () => undefined)
    orchestrator.buildContext = vi.fn(async () => ({
      nowIso: new Date().toISOString(),
      botName: 'AIra',
      activeGoal: null,
      activeGoalElapsedMs: 0,
      status: 'ok',
      worldState: 'ok',
      nearbyPlayers: [],
      recentActions: [],
      candidateSelfGoals: [],
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
    }))
    orchestrator.decideIntent = vi.fn(async () => ({
      focus: 'self',
      confidence: 0.8,
      goal: 'Gather wood and basic resources near spawn',
      reason: 'test',
    }))
    orchestrator.resolveExecutableGoal = vi.fn(() => ({
      goal: 'Gather wood and basic resources near spawn',
      reason: 'test',
    }))
    orchestrator.executeGoal = vi.fn(async () => {})

    await orchestrator.tickImpl()

    expect(orchestrator.buildContext).toHaveBeenCalledOnce()
    expect(orchestrator.emitAmbientChatIfNeeded).not.toHaveBeenCalled()
    expect(orchestrator.emitVoicedKeepAliveIfNeeded).not.toHaveBeenCalled()
  })
})

describe('autonomous stream orchestrator safety goal guard', () => {
  it('routes injured underground cobblestone mining through surface food recovery', () => {
    const orchestrator = createOrchestrator() as any

    orchestrator.lastWorldState = [
      'terrain_context: underground_cave',
      'wood_access: good',
      'pickaxe_access: ready',
      'surface_escape_needed: true',
    ].join('\n')
    orchestrator.bot.bot.health = 8
    orchestrator.bot.bot.food = 14
    orchestrator.bot.bot.entity = { position: { x: 0, y: 57, z: 0 } }
    orchestrator.bot.bot.entities = {}
    orchestrator.bot.bot.time = { timeOfDay: 0 }
    orchestrator.bot.bot.game = { dimension: 'minecraft:overworld' }
    orchestrator.bot.bot.inventory.items = () => [
      { name: 'crafting_table', count: 1 },
      { name: 'wooden_pickaxe', count: 1 },
    ]

    const result = orchestrator.resolveExecutableGoal('Mine 16 cobblestone', 'test', Date.now())

    expect(result?.goal).toBe('Escape to the surface to resupply food and torches for deeper mining')
    expect(result?.reason).toContain('goal-replaced')
  })

  it('routes depleted-hunger underground iron mining through surface food recovery', () => {
    const orchestrator = createOrchestrator() as any

    orchestrator.lastWorldState = [
      'terrain_context: underground_cave',
      'wood_access: good',
      'pickaxe_access: available',
      'surface_escape_needed: true',
    ].join('\n')
    orchestrator.bot.bot.health = 12
    orchestrator.bot.bot.food = 6
    orchestrator.bot.bot.entity = { position: { x: -373, y: 50, z: 189 } }
    orchestrator.bot.bot.entities = {}
    orchestrator.bot.bot.time = { timeOfDay: 0 }
    orchestrator.bot.bot.game = { dimension: 'minecraft:overworld' }
    orchestrator.bot.bot.inventory.items = () => [
      { name: 'crafting_table', count: 1 },
      { name: 'furnace', count: 1 },
      { name: 'stone_pickaxe', count: 1 },
      { name: 'torch', count: 4 },
    ]

    const result = orchestrator.resolveExecutableGoal('mine iron_ore at (-382, 44, 191)', 'test', Date.now())

    expect(result?.goal).toBe('Escape to the surface to resupply food and torches for deeper mining')
    expect(result?.reason).toContain('Food 6 with no recovery food')
  })
})

describe('autonomous stream orchestrator voiced keepalive', () => {
  it('does not block the tick loop while a long-running goal is executing', async () => {
    const orchestrator = createOrchestrator() as any
    const neverSettles = new Promise<void>(() => {})

    orchestrator.started = true
    orchestrator.executing = false
    orchestrator.lastGoalAt = 0
    orchestrator.ingestYouTubeMessages = vi.fn()
    orchestrator.updateCoordinateStuckState = vi.fn()
    orchestrator.emitAmbientChatIfNeeded = vi.fn(async () => undefined)
    orchestrator.emitVoicedKeepAliveIfNeeded = vi.fn(async () => undefined)
    orchestrator.buildContext = vi.fn(async () => ({ world: 'ok' }))
    orchestrator.decideIntent = vi.fn(async () => ({
      focus: 'progression',
      confidence: 0.9,
      goal: 'Mine 16 cobblestone',
      speak: '',
      reason: 'test',
    }))
    orchestrator.resolveExecutableGoal = vi.fn(() => ({
      goal: 'Mine 16 cobblestone',
      reason: 'test',
    }))
    orchestrator.executeGoal = vi.fn(() => neverSettles)

    const result = await Promise.race([
      orchestrator.tickImpl().then(() => 'resolved'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 50)),
    ])

    expect(result).toBe('resolved')
    expect(orchestrator.executeGoal).toHaveBeenCalledWith('Mine 16 cobblestone', 'test')
  })

  it('emits a voiced llm keepalive after prolonged voiced silence without sending minecraft chat', async () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    const publishMock = vi.mocked(publishAssistantMessageToAiri)

    orchestrator.started = true
    orchestrator.executing = true
    orchestrator.activeGoal = 'Gather wood and craft a crafting table'
    orchestrator.lastEstimatedVoiceEndAt = now - 5_000
    orchestrator.lastVoiceRequestAt = now - 6_000
    orchestrator.generatePublicSpeakFromIntent = vi.fn(async () => '封印解除、木材招来の刻だ😏✨🔥')

    await orchestrator.emitVoicedKeepAliveIfNeeded(now)

    expect(orchestrator.generatePublicSpeakFromIntent).toHaveBeenCalledWith(
      'Gather wood and craft a crafting table',
      'voiced-keepalive',
      expect.stringContaining('phase=voiced-keepalive'),
      {
        mode: 'periodic-progress',
        maxAttempts: 1,
        skipRescue: false,
      },
    )
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(publishMock.mock.calls[0]?.[1]).toBe('封印解除、木材招来の刻だ😏✨🔥')
    expect(publishMock.mock.calls[0]?.[3]).toMatchObject({
      voiceMode: 'on',
      voicePriority: 'low',
    })
    expect(typeof publishMock.mock.calls[0]?.[3]?.onVoiceAttached).toBe('function')
    expect(orchestrator.bot.bot.chat).not.toHaveBeenCalled()
  })

  it('waits until 5 seconds after voice playback ends before emitting voiced keepalive', () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()

    orchestrator.started = true
    orchestrator.lastGoalAt = now - 20_000
    orchestrator.lastVoiceRequestAt = now - 6_000
    orchestrator.lastEstimatedVoiceEndAt = now - 4_999

    expect(orchestrator.shouldEmitVoicedKeepAlive(now)).toBe(false)

    orchestrator.lastEstimatedVoiceEndAt = now - 5_000
    expect(orchestrator.shouldEmitVoicedKeepAlive(now)).toBe(true)
  })

  it('queues voiced keepalive on the background inference lane instead of dropping it when busy', async () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    const publishMock = vi.mocked(publishAssistantMessageToAiri)

    orchestrator.started = true
    orchestrator.executing = true
    orchestrator.activeGoal = 'Gather wood and craft a crafting table'
    orchestrator.lastEstimatedVoiceEndAt = now - 5_000
    orchestrator.lastVoiceRequestAt = now - 6_000
    orchestrator.generateSpeechWithLane = vi.fn(async (
      _goal: string,
      _reason: string,
      _memo: string,
      _speechOptions: unknown,
      laneOptions: { priority?: string, coalesceKey?: string, dropIfBusy?: boolean },
    ) => {
      expect(laneOptions).toMatchObject({
        priority: 'background',
        dropIfBusy: false,
      })
      expect(laneOptions.coalesceKey).toContain('speech:keepalive:')
      return '木霊奔流、封印採取の刻だ😏✨🔥'
    })

    await orchestrator.emitVoicedKeepAliveIfNeeded(now)

    expect(orchestrator.generateSpeechWithLane).toHaveBeenCalledTimes(1)
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(publishMock.mock.calls[0]?.[1]).toBe('木霊奔流、封印採取の刻だ😏✨🔥')
  })

  it('can emit a voiced keepalive even before any prior voice attachment has completed', async () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()
    const publishMock = vi.mocked(publishAssistantMessageToAiri)

    orchestrator.started = true
    orchestrator.executing = false
    orchestrator.activeGoal = 'Gather wood and craft a crafting table'
    orchestrator.lastGoalAt = now - 12_000
    orchestrator.lastVoiceRequestAt = 0
    orchestrator.lastEstimatedVoiceEndAt = 0
    orchestrator.generatePublicSpeakFromIntent = vi.fn(async () => '封印継続、木霊招来だ😏✨🔥')

    await orchestrator.emitVoicedKeepAliveIfNeeded(now)

    expect(orchestrator.generatePublicSpeakFromIntent).toHaveBeenCalled()
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(publishMock.mock.calls[0]?.[3]).toMatchObject({
      voiceMode: 'on',
      voicePriority: 'low',
    })
  })

  it('drops noncritical voiced keepalive while deterministic recovery backpressure is active', async () => {
    const orchestrator = createOrchestrator() as any
    const now = Date.now()

    orchestrator.started = true
    orchestrator.executing = true
    orchestrator.activeGoal = 'Gather wood and craft a crafting table'
    orchestrator.lastEstimatedVoiceEndAt = now - 20_000
    orchestrator.lastVoiceRequestAt = now - 20_000
    orchestrator.criticalRecoveryUntil = now + 10_000
    orchestrator.generatePublicSpeakFromIntent = vi.fn(async () => 'should-not-run')

    await orchestrator.emitVoicedKeepAliveIfNeeded(now)

    expect(orchestrator.generatePublicSpeakFromIntent).not.toHaveBeenCalled()
    expect(vi.mocked(publishAssistantMessageToAiri)).not.toHaveBeenCalled()
  })

  it('voices periodic commentary at low priority so regular gameplay talk can fill silence', () => {
    const orchestrator = createOrchestrator() as any
    const publishMock = vi.mocked(publishAssistantMessageToAiri)

    orchestrator.speakCommentary('封印解除の進捗だ😏✨🔥')

    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(publishMock.mock.calls[0]?.[1]).toBe('封印解除の進捗だ😏✨🔥')
    expect(publishMock.mock.calls[0]?.[3]).toMatchObject({
      voiceMode: 'on',
      voicePriority: 'low',
    })
  })

  it('voices ambient chat at low priority without forcing minecraft chat output', () => {
    const orchestrator = createOrchestrator() as any
    const publishMock = vi.mocked(publishAssistantMessageToAiri)

    orchestrator.publishAmbientChat('深淵巡航モードだ😏✨🔥', false)

    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(publishMock.mock.calls[0]?.[1]).toBe('深淵巡航モードだ😏✨🔥')
    expect(publishMock.mock.calls[0]?.[3]).toMatchObject({
      voiceMode: 'on',
      voicePriority: 'low',
    })
    expect(orchestrator.bot.bot.chat).not.toHaveBeenCalled()
  })
})

describe('autonomous stream orchestrator goal completion flow', () => {
  it('treats goal announcements as background speech instead of blocking the critical lane', async () => {
    const orchestrator = createOrchestrator() as any
    const publishMock = vi.mocked(publishAssistantMessageToAiri)

    orchestrator.generateSpeechWithLane = vi.fn(async (
      _goal: string,
      _reason: string,
      _memo: string,
      _speechOptions: unknown,
      laneOptions: { priority?: string, dropIfBusy?: boolean },
    ) => {
      expect(laneOptions).toMatchObject({
        priority: 'background',
        dropIfBusy: true,
      })
      return 'まずは松明を作るよ'
    })

    await orchestrator.announceGoal('Craft torches')

    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(publishMock.mock.calls[0]?.[3]).toMatchObject({
      voiceMode: 'on',
      voicePriority: 'low',
    })
  })

  it('does not block goal completion on goal result commentary generation', async () => {
    const orchestrator = createOrchestrator() as any

    orchestrator.bot.planning = {
      createPlan: vi.fn(async () => ({ steps: [] })),
      executePlan: vi.fn(async () => undefined),
    }
    orchestrator.started = true
    orchestrator.emitSpark = vi.fn()
    orchestrator.announceGoal = vi.fn(async () => undefined)
    orchestrator.startGoalCommentary = vi.fn()
    orchestrator.stopGoalCommentary = vi.fn()
    orchestrator.emitGoalResultCommentary = vi.fn(() => new Promise<void>(() => {}))

    const executePromise = orchestrator.executeGoal('Craft a wooden pickaxe', 'test-reason')
    await vi.waitFor(() => {
      expect(orchestrator.emitGoalResultCommentary).toHaveBeenCalledWith('Craft a wooden pickaxe', true)
    })

    await executePromise

    expect(orchestrator.executing).toBe(false)
    expect(orchestrator.activeGoal).toBeNull()
    expect(orchestrator.bot.planning.createPlan).toHaveBeenCalledWith('Craft a wooden pickaxe')
  })
})
