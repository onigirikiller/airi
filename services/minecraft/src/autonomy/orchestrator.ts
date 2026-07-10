import type { Client } from '@proj-airi/server-sdk'

import type { MineflayerWithAgents } from '../libs/llm-agent/types'
import type { Plan } from '../libs/mineflayer/base-agent'
import type { WorldFacts } from './preconditions'
import type { ReflexController } from './reflex'
import type { AutonomyDecisionContext, AutonomyIntent, AutonomySignal, YouTubeChatMessage } from './types'

import process from 'node:process'

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { config } from '../composables/config'
import { withSerializedGpuTask } from '../libs/gpu-coordinator'
import { publishAssistantMessageToAiri } from '../libs/llm-agent/output'
import { getAiraPersonaPromptForInjection } from '../libs/llm-agent/persona'
import { forceReleaseSharedPlanLock, withSharedPlanLock } from '../libs/llm-agent/plan-lock'
import { handleSparkCommandEvent } from '../libs/llm-agent/spark-command'
import { generateWorldStatePrompt } from '../libs/llm-agent/world-state'
import {
  assertOpenAITokenBudget,
  isTokenBudgetError,
  recordOpenAIResponseUsage,
  TOKEN_BUDGET_EXIT_CODE,
  TOKEN_BUDGET_SHUTDOWN_EVENT,
  tokenBudgetGuard,
} from '../libs/llm-usage/token-budget'
import { ActionAbortedError } from '../libs/mineflayer/action-abort'
import { emitFallbackMonitor, monitorBus } from '../libs/monitor-event-bus'
import { getNearestEntityWhere } from '../skills/world'
import { useLogger } from '../utils/logger'
import { isHostile } from '../utils/mcdata'
import { GeminiAutonomyDecisionProvider } from './decision-provider'
import { getActiveEmotionEngine } from './emotion'
import { runInInferenceLane } from './inference-lane'
import { retrieveRelevantKnowledge } from './knowledge-retriever'
import { describeDeathLesson, LessonStore } from './lessons'
import { incrementMetric } from './metrics'
import { buildDeterministicNarration } from './narration'
import { classifyGoalType, collectWorldFacts, describeGoalConstraint } from './preconditions'
import { buildProgressionSnapshot, buildStallRecoveryGoal, ProgressWatchdog } from './progress'
import { YouTubeLiveChatBridge } from './youtube-live-chat'

function clampImportance(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function describeSparkDestinations() {
  return ['character']
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes('api.openai.com')
}

function isLikelyOllamaBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  return normalized.includes('127.0.0.1:11434')
    || normalized.includes('localhost:11434')
    || normalized.includes('ollama')
}

function isGeminiNativeBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  return normalized.includes('generativelanguage.googleapis.com') && !normalized.includes('/openai')
}

function isOpenAICompatibleBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  if (!normalized) {
    return false
  }

  if (normalized.includes('generativelanguage.googleapis.com') && normalized.includes('/openai')) {
    return true
  }

  return normalized.endsWith('/openai')
    || normalized.endsWith('/openai/v1')
    || normalized.endsWith('/v1')
}

function normalizeGoogleHostedModelName(model: string): string {
  const trimmed = model.trim()
  const normalized = trimmed.toLowerCase()

  switch (normalized) {
    case 'gemma 4 26b':
    case 'gemma4:e4b':
    case 'gemma4:e2b':
      return 'gemma-4-26b-a4b-it'
    case 'gemma 4 31b':
      return 'gemma-4-31b-it'
    case 'gemini 2.5 flash':
      return 'gemini-2.5-flash'
    case 'gemini 3.1 flash lite':
      return 'gemini-3.1-flash-lite-preview'
    default:
      return trimmed
  }
}

function normalizeModelForBaseUrl(baseUrl: string, model: string): string {
  if (!normalizeBaseUrl(baseUrl).toLowerCase().includes('generativelanguage.googleapis.com')) {
    return model.trim()
  }

  return normalizeGoogleHostedModelName(model)
}

function normalizeRecoverableGoalErrorMessage(errorMessage: string): string {
  return errorMessage
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function isRecoverableGoalExecutionFailure(errorMessage: string): boolean {
  const normalized = normalizeRecoverableGoalErrorMessage(errorMessage)
  return normalized.includes('searchforentity(')
    || normalized.includes('searchforblock(')
    || normalized.includes('moveaway(')
    || normalized.includes('gotocoordinates(')
    || normalized.includes('could not find any')
    || normalized.includes('pathfinding timed out')
    || normalized.includes('digging timed out')
}

type PublicSpeakTransport = 'ollama' | 'openai-compatible' | 'gemini-native'

interface ResolvedPublicSpeakProvider {
  source: 'llm' | 'gemini'
  baseUrl: string
  apiKey: string
  primaryModel: string
  gameplayModel: string
  transport: PublicSpeakTransport
}

function extractOpenAITextFromResponse(data: any): string {
  const choice = data?.choices?.[0]
  const choiceText = choice?.text
  if (typeof choiceText === 'string' && choiceText.trim().length > 0) {
    return stripThoughtBlocks(choiceText)
  }

  const directContent = data?.choices?.[0]?.message?.content
  if (typeof directContent === 'string' && directContent.trim().length > 0) {
    return stripThoughtBlocks(directContent)
  }

  if (directContent && typeof directContent === 'object') {
    const nestedText = (directContent as any)?.text
    if (typeof nestedText === 'string' && nestedText.trim().length > 0) {
      return stripThoughtBlocks(nestedText)
    }
  }

  if (Array.isArray(directContent)) {
    const joined = directContent
      .map((part: any) => {
        if (typeof part?.text === 'string') {
          return part.text
        }
        if (part?.type === 'output_text' && typeof part?.text === 'string') {
          return part.text
        }
        return ''
      })
      .join('')
      .trim()
    if (joined.length > 0) {
      return stripThoughtBlocks(joined)
    }
  }

  if (typeof data?.output_text === 'string' && data.output_text.trim().length > 0) {
    return stripThoughtBlocks(data.output_text)
  }

  if (Array.isArray(data?.output)) {
    const joined = data.output
      .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
      .map((part: any) => {
        if (typeof part?.text === 'string') {
          return part.text
        }
        if (typeof part?.content === 'string') {
          return part.content
        }
        return ''
      })
      .join('')
      .trim()
    if (joined.length > 0) {
      return stripThoughtBlocks(joined)
    }
  }

  return ''
}

function stripThoughtBlocks(text: string): string {
  return text
    .replace(/<thought>[\s\S]*?<\/thought>/gi, ' ')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractOllamaChatContent(data: any): string {
  const content = data?.message?.content
  if (typeof content === 'string' && content.trim().length > 0) {
    return content.trim()
  }

  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }

  return ''
}

function extractOllamaThinkingText(data: any): string {
  const thinking = data?.message?.thinking ?? data?.thinking
  if (typeof thinking === 'string' && thinking.trim().length > 0) {
    return thinking.trim()
  }

  if (Array.isArray(thinking)) {
    return thinking
      .map((part: any) => {
        if (typeof part?.text === 'string') {
          return part.text
        }
        if (typeof part === 'string') {
          return part
        }
        return ''
      })
      .join('')
      .trim()
  }

  return ''
}

const GOAL_COMMENTARY_INTERVAL_MS = 20_000
const GOAL_COMMENTARY_CHAT_COOLDOWN_MS = 10_000
const AMBIENT_STREAM_CHAT_INTERVAL_MS = 30_000
const AMBIENT_SOCIAL_CHAT_INTERVAL_MS = 30_000
const GOAL_ANNOUNCEMENT_COOLDOWN_MS = 5_000
const GOAL_REPEAT_ANNOUNCEMENT_COOLDOWN_MS = 60_000
const AIRI_COMMENTARY_MIN_INTERVAL_MS = 12_000
const VOICED_KEEPALIVE_TRIGGER_AFTER_MS = 5_000
const VOICED_KEEPALIVE_REQUEST_GRACE_MS = 5_000
const VOICED_KEEPALIVE_ATTEMPT_COOLDOWN_MS = 12_000
const AIRI_COMMENTARY_DUPLICATE_WINDOW_MS = 5 * 60_000
const SOCIAL_SIGNAL_BYPASS_WINDOW_MS = 3 * 60_000
const SOCIAL_SIGNAL_BYPASS_IMPORTANCE = 0.55
const SOCIAL_SIGNAL_HANDLED_WINDOW_MS = 20 * 60_000
const SOCIAL_SIGNAL_CANDIDATE_WINDOW_MS = 10 * 60_000
const SOCIAL_REPLY_TARGET_RATIO = 0.8
const SOCIAL_REPLY_RATIO_WINDOW = 10
const SOCIAL_REPLY_MAX_STREAK = 4
const SOCIAL_REPLY_DURING_EXECUTION_COOLDOWN_MS = 3_000
const SOCIAL_REPLY_GAME_BREAK_MS = 5_000
const SOCIAL_REPLY_HISTORY_WINDOW_MS = 20 * 60_000
const SOCIAL_SIGNAL_MAX_WAIT_BEFORE_REPLY_MS = 35_000
const SOCIAL_SIGNAL_DUPLICATE_WINDOW_MS = 90_000
const SOCIAL_REPLY_SIGNATURE_WINDOW_MS = 20 * 60_000
const YOUTUBE_COMMENT_OVERLAY_WRITE_ERROR_LOG_INTERVAL_MS = 30_000
const COORDINATE_STUCK_DISTANCE_EPSILON = 1.25
const COORDINATE_STUCK_THRESHOLD_MS = 60_000
const COORDINATE_STUCK_RECOVERY_COOLDOWN_MS = 60_000
const EXECUTION_WATCHDOG_TIMEOUT_MS = 180_000
const PUBLIC_SPEECH_MEMORY_WINDOW_MS = 15 * 60_000
const PUBLIC_SPEECH_MEMORY_MAX = 10
const SPEECH_QUEUE_MAX_PENDING = 3
const LOW_PRIORITY_SPEECH_MAX_PENDING = 1
const LOW_PRIORITY_SPEECH_AFTER_REQUEST_GAP_MS = 5_000
const LOW_PRIORITY_SPEECH_AFTER_VOICE_END_GAP_MS = 5_000
const SPEECH_ITEM_ESTIMATED_DURATION_MS = 8_000
const OUTWARD_SPEAK_MIN_INTERVAL_MS = 4_000
const RECOVERY_SPEECH_BACKPRESSURE_MS = 15_000
const OLLAMA_PUBLIC_SPEAK_NUM_CTX = 2048
const OLLAMA_PUBLIC_SPEAK_NUM_PREDICT = 64
const OLLAMA_SOCIAL_REPLY_NUM_PREDICT = 96
const PUBLIC_SPEAK_MAX_ATTEMPTS = 6
const PUBLIC_SPEAK_RETRY_BASE_DELAY_MS = 400
const GOAL_FAILURE_MEMORY_WINDOW_MS = 5 * 60_000
const GOAL_RESELECTION_COOLDOWN_MS = 90_000
const GOAL_FAMILY_RESELECTION_COOLDOWN_MS = 120_000
const RESOURCE_FAILURE_RESELECTION_COOLDOWN_MS = 3 * 60_000
const WOOD_BOOTSTRAP_FAILURE_COOLDOWN_MS = 2 * 60_000
const WOOD_BOOTSTRAP_FAILURE_THRESHOLD = 2
const GOAL_FAMILY_FAILURE_THRESHOLD = 2

function isStationaryExecutionGoal(goal: string | null): boolean {
  if (!goal) {
    return false
  }

  const normalized = goal.toLowerCase()
  return normalized.includes('smelt')
    || normalized.includes('furnace')
    || normalized.includes('charcoal')
    || normalized.includes('cook ')
    || normalized.includes('cooked_')
    || normalized.includes('craft a crafting table')
    || normalized.includes('craft crafting table')
    || normalized.includes('wood')
    || normalized.includes('log')
    || normalized.includes('木材')
    || normalized.includes('原木')
    || normalized.includes('丸太')
    || normalized.includes('作業台')
    || normalized.includes('クラフト台')
    // NOTICE: Surface recovery may spend longer than the coordinate-stall window
    // scanning and climbing before the bot's position changes. Let the movement
    // action timeout/recovery own that flow instead of interrupting it with a
    // stale moveAway recovery plan.
    || normalized.includes('climb out of')
    || normalized.includes('toward the surface')
    || normalized.includes('surface recovery')
    || normalized.includes('recover toward surface')
    || normalized.includes('地上へ')
    || normalized.includes('地上に出')
    || normalized.includes('脱出')
}
/* Runner-backed autonomy helpers removed. Keeping the old block commented
   temporarily makes the delta smaller while the LLM-only path settles. {
  const normalized = normalizeAutonomyGoal(goal)
  if (!normalized) {
    return false
  }
  if (/^follow\b|assist .* objective|reply|comment|chat|viewer|鬯ｯ・ｯ繝ｻ・ｮ郢晢ｽｻ繝ｻ・ｫ鬮ｯ・ｷ髢ｧ・ｴ繝ｻ・ｺ陋滂ｽ･郢晢ｽｻ鬯ｩ蟷｢・ｽ・｢髫ｴ雜｣・ｽ・｢郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｻ鬯ｯ・ｯ繝ｻ・ｮ郢晢ｽｻ繝ｻ・｢驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｰ鬯ｩ蟷｢・ｽ・｢髫ｴ雜｣・ｽ・｢郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｻ鬯ｯ・ｩ陝ｷ・｢繝ｻ・ｽ繝ｻ・｢驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｧ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｳ鬯ｯ・ｩ陝ｷ・｢繝ｻ・ｽ繝ｻ・｢鬮ｫ・ｴ髮懶ｽ｣繝ｻ・ｽ繝ｻ・｢驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・｡鬯ｯ・ｩ陝ｷ・｢繝ｻ・ｽ繝ｻ・｢鬮ｫ・ｴ髮懶ｽ｣繝ｻ・ｽ繝ｻ・｢驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｳ鬯ｯ・ｩ陝ｷ・｢繝ｻ・ｽ繝ｻ・｢鬮ｫ・ｴ隰ｫ・ｾ繝ｻ・ｽ繝ｻ・ｴ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ鬯ｯ・ｮ繝ｻ・｣鬮ｮ蜈ｷ・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｨ鬯ｮ・ｯ隶灘･・ｽｽ・ｺ繝ｻ・ｷ郢晢ｽｻ繝ｻ・･驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｽ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｩ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｱ/.test(normalized)) {
    return false
  }

  return inferRunnerTargetPhase(goal) != null
}

function isPhaseAtOrBeyond(currentPhase: GamePhase, targetPhase: GamePhase): boolean {
  return GAME_PHASE_ORDER.indexOf(currentPhase) >= GAME_PHASE_ORDER.indexOf(targetPhase)
}

*/

export class AutonomousStreamOrchestrator {
  private readonly logger = useLogger()
  private readonly youtubeBridge = new YouTubeLiveChatBridge({
    ...config.youtube,
    onMessagesQueued: () => {
      void this.tick()
    },
    logger: this.logger,
  })

  private readonly decisionProvider = new GeminiAutonomyDecisionProvider({
    ...config.gemini,
    logger: this.logger,
  })

  private started = false
  private tokenBudgetShutdownRequested = false
  private loopTimer: ReturnType<typeof setInterval> | null = null
  private executing = false
  private executingStartedAt = 0
  private activeGoal: string | null = null
  private activeGoalStartedAt = 0
  private lastGoalAt = 0
  private lastGoalAnnouncementAt = 0
  private lastAnnouncedGoal: string | null = null
  private goalCommentaryTimer: ReturnType<typeof setInterval> | null = null
  private goalCommentaryTick = 0
  private lastGoalChatCommentaryAt = 0
  private lastAmbientStreamChatAt = 0
  private lastAmbientSocialChatAt = 0
  private lastAiriCommentaryAt = 0
  private recentCommentarySignatures: Array<{ signature: string, trigrams: Set<string>, at: number }> = []
  private signalBuffer: AutonomySignal[] = []
  private youtubeMessageIndex = new Map<string, YouTubeChatMessage>()
  private handledSocialSignals: Array<{ id: string, at: number, replied: boolean }> = []
  private replyMixHistory: Array<{ kind: 'social' | 'game', at: number }> = []
  private socialReplyStreak = 0
  private socialReplyGameBreakUntil = 0
  private lastExecutingSocialReplyAt = 0
  private replyingSocialSignalIds = new Set<string>()
  private recentSocialSignalSignatures = new Map<string, number>()
  private recentSocialReplySignatures = new Map<string, number>()
  private lastYouTubeOverlayWriteErrorAt = 0
  private lastTrackedPosition: { x: number, y: number, z: number } | null = null
  private lastPositionChangedAt = 0
  private lastStuckRecoveryAt = 0
  private pendingRecoveryPlan: { goal: string, reason: string, plan: Plan, queuedAt: number } | null = null
  private criticalRecoveryUntil = 0
  private recentPublicSpeeches: Array<{ text: string, at: number, kind: 'game' | 'social' }> = []
  private recentNarrationFamilies: Array<{ family: string, at: number }> = []
  private nonSocialPublicSpeechCount = 0
  private consecutiveKeepalives = 0
  private lastCommentarySnapshot: { position: string, action: string, health: string } | null = null
  private lastWorldState = ''
  private consecutiveGoalFailures = 0
  private lastGoalFailureAt = 0
  private recentGoalFailures: Array<{ goalKey: string, goalFamily?: string, family: string, at: number }> = []
  private pendingSpeechItems: Array<{ estimatedDoneAt: number, isSocialReply: boolean }> = []
  private lastOutwardSpeakAt = 0
  private lastVoiceRequestAt = 0
  private lastEstimatedVoiceEndAt = 0
  private lastVoicedKeepAliveAttemptAt = 0
  private recentYouTubeCommentsOverlay: Array<{
    id: string
    author: string
    text: string
    publishedAt: string
  }> = []

  private currentReplyContext: {
    speechText: string
    replyToCommentId: string
    updatedAt: number
  } | null = null

  // 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ Lv0鬯ｩ蛹・ｽｽ・ｯ郢晢ｽｻ繝ｻ・ｶ鬯ｯ・ｮ・つ髯橸ｽｳ郢晢ｽｻ stability mechanisms 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ
  private readonly progressWatchdog = new ProgressWatchdog()
  private lessons: LessonStore | null = null
  private worldStateVersion = 0
  private precondFailCount = new Map<string, number>()
  private banUntilMs = new Map<string, number>()
  private goalTypeHistory: Array<{ goalType: string, score: number, at: number }> = []
  private readonly PRECOND_BAN_THRESHOLD = 3
  private readonly PRECOND_BAN_DURATION_MS = 120_000

  constructor(
    private readonly bot: MineflayerWithAgents,
    private readonly airiClient: Client,
    private readonly reflex?: ReflexController,
  ) {
    tokenBudgetGuard.onBlocked(() => this.handleTokenBudgetBlocked())
  }

  private handleTokenBudgetBlocked(): void {
    if (this.tokenBudgetShutdownRequested) {
      return
    }
    this.tokenBudgetShutdownRequested = true

    try {
      this.bot.abortCurrentAction('Token budget exhausted')
    }
    catch {
      /* noop */
    }
    try {
      this.bot.emit('interrupt')
    }
    catch {
      /* noop */
    }
    forceReleaseSharedPlanLock(this.bot.username, this.logger as any)
    this.pendingRecoveryPlan = null
    this.executing = false
    this.executingStartedAt = 0
    this.activeGoal = null
    this.activeGoalStartedAt = 0
    this.stop()

    this.logger.error('Token budget exhausted; stopping until next UTC day')
    process.exitCode = TOKEN_BUDGET_EXIT_CODE
    ;(process.emit as (event: string) => boolean)(TOKEN_BUDGET_SHUTDOWN_EVENT)
  }

  public start(): void {
    if (!config.autonomy.enabled) {
      this.logger.log('Autonomy orchestrator is disabled')
      return
    }

    if (this.started)
      return

    this.started = true
    this.lessons ??= new LessonStore(this.bot.username)
    this.bot.bot.on('chat', this.handleMinecraftChat)
    this.bot.bot.on('death', this.handleBotDeath)
    this.airiClient.onEvent('spark:command', this.handleSparkCommand)
    this.youtubeBridge.start()

    this.loopTimer = setInterval(() => {
      void this.tick()
    }, config.autonomy.loopIntervalMs)

    void this.tick()
    this.logger.withFields({
      intervalMs: config.autonomy.loopIntervalMs,
      minGoalIntervalMs: config.autonomy.minGoalIntervalMs,
      goalLockMs: config.autonomy.goalLockMs,
    }).log('Autonomy orchestrator started')
  }

  public stop(): void {
    if (!this.started)
      return

    this.started = false
    this.youtubeBridge.stop()
    this.stopGoalCommentary()
    this.bot.bot.off('chat', this.handleMinecraftChat)
    this.bot.bot.off?.('death', this.handleBotDeath)
    this.airiClient.offEvent('spark:command', this.handleSparkCommand)
    if (this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = null
    }
    this.lessons?.flush()
    this.logger.log('Autonomy orchestrator stopped')
  }

  private handleBotDeath = (): void => {
    try {
      const facts = collectWorldFacts(this.bot)
      const snapshot = this.buildProgressionSnapshotSafe()
      const hostile = getNearestEntityWhere(this.bot as any, entity => isHostile(entity), 8)
      const fact = describeDeathLesson(facts, hostile?.name ?? undefined)
      this.lessons?.record({
        trigger: 'death',
        fact,
        milestone: snapshot?.currentMilestone ?? 'unknown',
        dimension: facts.dimension,
      })
      this.pushSignal({
        id: randomUUID(),
        source: 'system',
        author: 'death-observer',
        text: `death: ${fact}`,
        importance: 0.9,
        timestamp: Date.now(),
      })
      this.logger.withField('lesson', fact).warn('Recorded death lesson')
    }
    catch (error) {
      this.logger.withError(error).warn('Failed to record death lesson')
    }
  }

  private async decideIntent(context: AutonomyDecisionContext): Promise<AutonomyIntent> {
    try {
      const decideWithProvider = async (): Promise<AutonomyIntent> => await this.decisionProvider.decide(context)
      const intent = config.autonomy.singleInferenceLane
        ? await runInInferenceLane('autonomy:decision', this.logger, decideWithProvider, { priority: 'critical' })
        : await decideWithProvider()
      if (!intent.goal && !intent.speak) {
        this.logger.withField('reason', intent.reason || 'LLM returned no goal or speech').error(
          'Autonomy LLM unavailable or returned no usable intent; skipping goal selection',
        )
      }
      return intent
    }
    catch (error) {
      if (isTokenBudgetError(error)) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      this.logger.withError(error).error('Autonomy decision provider failed; skipping goal selection')
      return {
        focus: 'self',
        confidence: 0,
        reason: `Autonomy LLM decision failed; goal selection skipped: ${message}`,
      }
    }
  }

  private handleMinecraftChat = (username: string, message: string): void => {
    if (!this.started)
      return
    if (username === this.bot.username)
      return
    const now = Date.now()
    if (!this.shouldAcceptSocialSignal('player', username, message, now)) {
      this.logger.withFields({ source: 'player', author: username }).log('Duplicate social signal skipped')
      return
    }

    const lowerMessage = message.toLowerCase()
    const isDirectMention = lowerMessage.includes(this.bot.username.toLowerCase())
    const weightedImportance = clampImportance(
      Math.max(
        (isDirectMention ? 0.95 : 0.65) * config.autonomy.socialWeight,
        isDirectMention ? 0.92 : 0.7,
      ),
    )

    this.pushSignal({
      id: randomUUID(),
      source: 'player',
      author: username,
      text: message,
      importance: weightedImportance,
      timestamp: now,
    })
  }

  private handleSparkCommand = async (event: any): Promise<void> => {
    if (!this.started)
      return

    const handled = await handleSparkCommandEvent(event, this.bot, this.logger, this.airiClient)
    if (handled) {
      return
    }

    const guidance = event?.data?.guidance
    const intent = event?.data?.intent || 'action'
    const options = Array.isArray(guidance?.options) ? guidance.options : []
    const firstOption = options[0]
    const stepText = Array.isArray(firstOption?.steps) ? firstOption.steps.join(', ') : ''
    const text = [
      `Spark command (${intent}) received`,
      firstOption?.label ? `label: ${firstOption.label}` : '',
      stepText ? `steps: ${stepText}` : '',
    ].filter(Boolean).join(' | ')

    this.pushSignal({
      id: randomUUID(),
      source: 'system',
      author: 'spark-command',
      text,
      importance: 0.8,
      timestamp: Date.now(),
    })
  }

  private tickInFlight = false
  private consecutiveTickErrors = 0

  private async tick(): Promise<void> {
    if (!this.started)
      return
    if (!this.bot.ready)
      return
    // Prevent concurrent tick execution (setInterval fires regardless of prior tick completion)
    if (this.tickInFlight)
      return
    this.tickInFlight = true
    try {
      await this.tickImpl()
    }
    catch (err) {
      // Catch ALL errors from tickImpl to prevent unhandled rejections from crashing the process.
      // The tick loop must be resilient 鬯ｯ・ｩ陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｯ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｶ鬯ｩ蟷｢・ｽ・｢髫ｴ雜｣・ｽ・｢郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｻa single bad tick should never kill the bot.
      this.consecutiveTickErrors = (this.consecutiveTickErrors ?? 0) + 1
      this.logger.withFields({
        error: err instanceof Error ? err.message : String(err),
        consecutiveErrors: this.consecutiveTickErrors,
      }).error('Tick error caught (non-fatal)')

      // If ticks keep failing, force-reset execution state to unblock
      if (this.consecutiveTickErrors >= 5) {
        this.logger.warn('Too many consecutive tick errors, force-resetting execution state')
        try {
          this.bot.abortCurrentAction('Orchestrator force-reset after consecutive tick errors')
        }
        catch {
          /* noop */
        }
        this.executing = false
        this.executingStartedAt = 0
        this.stopGoalCommentary()
        this.activeGoal = null
        this.activeGoalStartedAt = 0
        this.consecutiveTickErrors = 0
      }
    }
    finally {
      this.tickInFlight = false
    }
  }

  private async tickImpl(): Promise<void> {
    this.ingestYouTubeMessages()
    const now = Date.now()

    // Survival reflexes own the bot while engaged; planning and recovery wait.
    if (this.reflex?.isEngaged()) {
      return
    }

    this.updateCoordinateStuckState(now)

    // 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ Lv0 A-2: ProgressWatchdog (stall detection beyond coordinate) 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ
    if (!this.executing) {
      try {
        const watchdogFacts = collectWorldFacts(this.bot)
        this.progressWatchdog.observe(watchdogFacts, undefined, now)
        const stallState = this.progressWatchdog.isStalled()
        if (stallState.stalled) {
          incrementMetric('stallDetectedCount')
          try {
            this.lessons?.record({
              trigger: 'stall',
              fact: `Progress stalled: ${stallState.reason}`,
              milestone: this.buildProgressionSnapshotSafe()?.currentMilestone ?? 'unknown',
              dimension: watchdogFacts.dimension,
            })
          }
          catch {
            /* lesson recording must never break stall handling */
          }
          const stallSignal = `progress-stall: ${stallState.reason}`
          this.logger.withField('reason', stallState.reason).warn('[Stability] Progress stall detected; switching to deterministic recovery')
          this.pushSignal({
            id: randomUUID(),
            source: 'system',
            author: 'progress-watchdog',
            text: stallSignal,
            importance: 0.95,
            timestamp: now,
          })
          this.queueDeterministicRecovery(stallState.reason, now)
          this.progressWatchdog.reset()
          monitorBus.emitMonitor('orchestrator:stallDetected', { reason: stallState.reason })
        }
      }
      catch (err) {
        this.logger.withError(err).warn('[Stability] ProgressWatchdog observation failed (non-fatal)')
      }
    }

    if (this.pendingRecoveryPlan && this.executing) {
      this.logger.withFields({
        activeGoal: this.activeGoal,
        recoveryGoal: this.pendingRecoveryPlan.goal,
        reason: this.pendingRecoveryPlan.reason,
      }).warn('Interrupting the current execution to prioritize deterministic recovery')
      try {
        this.bot.abortCurrentAction(`Deterministic recovery requested: ${this.pendingRecoveryPlan.reason}`)
      }
      catch {
        /* noop */
      }
      try {
        this.bot.emit('interrupt')
      }
      catch {
        /* noop */
      }
      forceReleaseSharedPlanLock(this.bot.username, this.logger as any)
      this.executing = false
      this.executingStartedAt = 0
      this.stopGoalCommentary()
      this.activeGoal = null
      this.activeGoalStartedAt = 0
    }

    // Execution watchdog: force-reset if executing for too long
    if (this.executing && this.executingStartedAt > 0 && now - this.executingStartedAt > EXECUTION_WATCHDOG_TIMEOUT_MS) {
      this.logger.withFields({
        stuckForMs: now - this.executingStartedAt,
        activeGoal: this.activeGoal,
      }).warn('Execution watchdog triggered: force-resetting stuck execution')
      try {
        this.bot.abortCurrentAction(`Execution watchdog exceeded ${EXECUTION_WATCHDOG_TIMEOUT_MS}ms`)
      }
      catch {
        /* noop */
      }
      this.executing = false
      this.executingStartedAt = 0
      this.stopGoalCommentary()
      this.activeGoal = null
      this.activeGoalStartedAt = 0
      // Fall through to normal tick logic
    }

    if (this.executing) {
      await this.emitExecutingSocialReplyIfNeeded(now)
      await this.emitVoicedKeepAliveIfNeeded(now)
      return
    }

    if (this.pendingRecoveryPlan) {
      const recovery = this.pendingRecoveryPlan
      await this.executePendingRecoveryPlan(recovery)
      this.consecutiveTickErrors = 0
      return
    }

    const activeGoalElapsedMs = this.activeGoalStartedAt > 0 ? now - this.activeGoalStartedAt : 0
    const highPrioritySignal = this.signalBuffer.find(signal => signal.importance >= 0.85)
    const hasRecentSocialSignal = this.signalBuffer.some(signal =>
      (signal.source === 'player' || signal.source === 'youtube')
      && signal.importance >= SOCIAL_SIGNAL_BYPASS_IMPORTANCE
      && now - signal.timestamp <= SOCIAL_SIGNAL_BYPASS_WINDOW_MS,
    )
    const reachedMinGoalInterval = now - this.lastGoalAt >= config.autonomy.minGoalIntervalMs
    const shouldAttemptGoalSelection = reachedMinGoalInterval || Boolean(highPrioritySignal) || hasRecentSocialSignal

    if (!shouldAttemptGoalSelection) {
      await this.emitAmbientChatIfNeeded(now)
      await this.emitVoicedKeepAliveIfNeeded(now)
      return
    }

    if (this.activeGoal && activeGoalElapsedMs < config.autonomy.goalLockMs && !highPrioritySignal && !hasRecentSocialSignal) {
      await this.emitAmbientChatIfNeeded(now)
      await this.emitVoicedKeepAliveIfNeeded(now)
      return
    }

    const context = await this.buildContext(now)
    let intent = await this.decideIntent(context)

    // 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ Lv0 A-1: Precondition mask (post-decide) 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ
    let socialFallbackSignalId: string | undefined
    const prioritizedSocialSignal = this.pickSocialSignalForReply(now)
    if (prioritizedSocialSignal) {
      socialFallbackSignalId = prioritizedSocialSignal.id
      this.replyingSocialSignalIds.add(socialFallbackSignalId)
      intent = {
        ...intent,
        focus: prioritizedSocialSignal.source === 'youtube' ? 'community' : 'co-op',
        confidence: Math.max(intent.confidence, 0.7),
        speak: this.buildSocialIntentSpeak(prioritizedSocialSignal),
        reason: `${intent.reason ? `${intent.reason} | ` : ''}social-priority: prioritize ${prioritizedSocialSignal.source} comment`,
        ...(prioritizedSocialSignal.source === 'youtube' ? { replyToSignalId: prioritizedSocialSignal.id } : {}),
      }
      this.logger.withFields({
        signalId: prioritizedSocialSignal.id,
        source: prioritizedSocialSignal.source,
        author: prioritizedSocialSignal.author,
      }).log('Social priority speak injected')
    }
    else if (!intent.speak) {
      const socialSignal = this.pickUnhandledSocialSignal(now)
      if (socialSignal) {
        socialFallbackSignalId = socialSignal.id
        this.replyingSocialSignalIds.add(socialFallbackSignalId)
        intent = {
          ...intent,
          focus: socialSignal.source === 'youtube' ? 'community' : 'co-op',
          confidence: Math.max(intent.confidence, 0.62),
          speak: this.buildSocialIntentSpeak(socialSignal),
          reason: `${intent.reason ? `${intent.reason} | ` : ''}social fallback: acknowledge ${socialSignal.source} message`,
          ...(socialSignal.source === 'youtube' ? { replyToSignalId: socialSignal.id } : {}),
        }
        this.logger.withFields({
          signalId: socialSignal.id,
          source: socialSignal.source,
          author: socialSignal.author,
        }).log('Social fallback speak injected')
      }
    }

    if (intent.speak) {
      this.logger.withField('message', intent.speak).log('Autonomy internal speak generated (hidden from stream)')
      const replySignalId = intent.replyToSignalId || socialFallbackSignalId
      const replySignal = replySignalId
        ? this.signalBuffer.find(signal => signal.id === replySignalId && (signal.source === 'youtube' || signal.source === 'player'))
        : undefined
      const isSocialReplyIntent = Boolean(replySignalId)

      // Backpressure: non-social outward speak respects cooldown + queue limit
      try {
        if (!isSocialReplyIntent) {
          if (now - this.lastOutwardSpeakAt < OUTWARD_SPEAK_MIN_INTERVAL_MS) {
            this.logger.log('Outward speak skipped: cooldown active')
            // fall through to goal section below
          }
          else if (!this.canEnqueueSpeech(false)) {
            this.logger.log('Outward speak skipped: speech queue full')
            // fall through to goal section below
          }
          else {
            await this.emitOutwardSpeak(intent, replySignal, socialFallbackSignalId, now, false)
          }
        }
        else {
          await this.emitOutwardSpeak(intent, replySignal, socialFallbackSignalId, now, true)
        }
      }
      finally {
        if (socialFallbackSignalId) {
          this.replyingSocialSignalIds.delete(socialFallbackSignalId)
        }
      }
    }
    else if (socialFallbackSignalId) {
      // speak was not generated; release the lock so this signal can be retried
      this.replyingSocialSignalIds.delete(socialFallbackSignalId)
    }

    if (!intent.goal) {
      return
    }

    // 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ Lv1 B-2: stateVersion check 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ
    if (context.worldStateVersion !== undefined && context.worldStateVersion !== this.worldStateVersion) {
      incrementMetric('decisionDiscardedVersionMismatchCount')
      this.logger.withFields({
        contextVersion: context.worldStateVersion,
        currentVersion: this.worldStateVersion,
      }).warn('[Stability] stateVersion mismatch, discarding intent')
      return
    }

    const selectedGoal = intent.goal
    if (!selectedGoal) {
      return
    }

    const executableGoal = this.resolveExecutableGoal(selectedGoal, intent.reason, now)
    if (!executableGoal) {
      return
    }
    intent = {
      ...intent,
      goal: executableGoal.goal,
      reason: executableGoal.reason ?? intent.reason,
    }
    const goalToExecute = executableGoal.goal
    const goalReason = executableGoal.reason ?? intent.reason

    // Circuit breaker: skip goal creation after consecutive failures
    // After 3 failures, pause for 45s. Force-stop pathfinder to clear stuck state.
    if (this.isGoalCreationPaused(now)) {
      this.logger.withFields({
        consecutiveFailures: this.consecutiveGoalFailures,
        msSinceLastFailure: now - this.lastGoalFailureAt,
      }).warn('Circuit breaker active: skipping goal creation due to consecutive failures')
      // Actively clear pathfinding state during circuit breaker
      try {
        (this.bot.bot as any).pathfinder?.stop?.()
      }
      catch {
        /* noop */
      }
      return
    }
    if (this.consecutiveGoalFailures >= 3 && now - this.lastGoalFailureAt >= 45_000) {
      this.consecutiveGoalFailures = 0
    }

    // NOTICE: Goal execution can run for tens of seconds while mining/pathfinding.
    // Keep the autonomy tick loop free so voiced keepalive and social reply checks
    // can continue during long-running actions instead of going silent until the
    // planner finishes the whole goal.
    void this.executeGoal(goalToExecute, goalReason).catch((error) => {
      this.logger.withError(error).error('Autonomy executeGoal escaped its internal error handling')
    })

    // Reset consecutive error counter on successful tick completion
    this.consecutiveTickErrors = 0
  }

  private async emitOutwardSpeak(
    intent: AutonomyIntent,
    replySignal: AutonomySignal | undefined,
    socialFallbackSignalId: string | undefined,
    now: number,
    isSocialReply: boolean,
  ): Promise<void> {
    const outwardSeed = this.buildOutwardSpeakSeed(intent.speak!, replySignal)
    const outward = await this.generateSpeechWithLane(
      intent.goal,
      intent.reason,
      outwardSeed,
      {
        mode: 'default',
        maxAttempts: 2,
        skipRescue: true,
      },
      {
        priority: isSocialReply ? 'critical' : 'background',
        coalesceKey: isSocialReply ? undefined : `speech:intent:${intent.goal || 'none'}:${intent.reason || 'default'}`,
        dropIfBusy: !isSocialReply,
      },
    )
    if (outward) {
      this.logger.withFields({
        message: outward,
        sourceSignalId: intent.replyToSignalId || socialFallbackSignalId || '',
      }).log('Autonomy outward speak generated')
      const outwardReplySignalId = intent.replyToSignalId || socialFallbackSignalId || ''
      this.bot.bot.chat(outward)
      const replySignalId = intent.replyToSignalId || socialFallbackSignalId
      const resolvedIsSocialReply = isSocialReply || Boolean(replySignalId)
      this.rememberPublicSpeech(outward, now, resolvedIsSocialReply ? 'social' : 'game')
      if (resolvedIsSocialReply) {
        this.noteVoiceRequested(now)
      }
      publishAssistantMessageToAiri(this.airiClient, outward, this.logger as any, {
        voiceMode: resolvedIsSocialReply ? 'on' : 'off',
        voicePriority: resolvedIsSocialReply ? 'high' : 'low',
        onVoiceAttached: ({ estimatedEndAt }) => this.noteVoiceAttached(estimatedEndAt),
        onPlaybackStart: () => this.updateCurrentReplyContext(outward, outwardReplySignalId),
      })
      if (resolvedIsSocialReply) {
        this.trackSpeechItem(outward, true)
      }
      this.lastOutwardSpeakAt = now
      this.recordReplyMix(resolvedIsSocialReply ? 'social' : 'game', now)
      if (replySignalId) {
        this.markSocialSignalHandled(replySignalId, now, replySignal)
        await this.tryReplyYouTube(replySignalId, outward)
      }
    }
    else if (replySignal) {
      this.reportSpeechSkip(
        'autonomy.outward-social',
        'Skipped social outward speech because GPT public speech was empty.',
        intent.goal,
      )
      this.logger.withFields({
        signalId: replySignal.id,
        source: replySignal.source,
        author: replySignal.author,
      }).warn('Social reply skipped because outward text was empty')
      this.markSocialSignalHandled(replySignal.id, now, replySignal, false)
    }
    else {
      this.reportSpeechSkip(
        'autonomy.outward-commentary',
        'Skipped outward speech because GPT public speech was empty.',
        intent.goal,
      )
    }
  }

  private reportSpeechSkip(scope: string, detail: string, goal?: string): void {
    this.logger.withFields({ scope, detail, goal: goal || '' }).warn('Public speech skipped because LLM output was unavailable')
    const monitorDetail = `public-speech-empty:${scope}`
    emitFallbackMonitor({
      scope,
      reason: 'speech-skipped',
      goal,
      detail: monitorDetail,
      from: 'llm-public-speech',
      to: 'skip-speech',
      recoverable: true,
    }, {
      throttleMs: 10_000,
      throttleKey: [scope, goal || '', monitorDetail].join('|'),
    })
  }

  private updateCoordinateStuckState(now: number): void {
    const position = this.bot.bot.entity?.position
    if (!position) {
      return
    }

    const current = { x: Number(position.x), y: Number(position.y), z: Number(position.z) }
    if (!this.lastTrackedPosition) {
      this.lastTrackedPosition = current
      this.lastPositionChangedAt = now
      return
    }

    const dx = current.x - this.lastTrackedPosition.x
    const dy = current.y - this.lastTrackedPosition.y
    const dz = current.z - this.lastTrackedPosition.z
    const distance = Math.hypot(dx, dy, dz)
    if (distance >= COORDINATE_STUCK_DISTANCE_EPSILON) {
      this.lastTrackedPosition = current
      this.lastPositionChangedAt = now
      return
    }

    if (!this.activeGoal && !this.executing) {
      return
    }
    if (this.executing && isStationaryExecutionGoal(this.activeGoal)) {
      this.lastPositionChangedAt = now
      return
    }
    if (now - this.lastPositionChangedAt < COORDINATE_STUCK_THRESHOLD_MS) {
      return
    }
    if (now - this.lastStuckRecoveryAt < COORDINATE_STUCK_RECOVERY_COOLDOWN_MS) {
      return
    }

    this.lastStuckRecoveryAt = now
    this.lastPositionChangedAt = now
    const stalledMessage = `stuck-recovery: coordinates unchanged for ${Math.round(COORDINATE_STUCK_THRESHOLD_MS / 1000)}s near (${current.x.toFixed(1)}, ${current.y.toFixed(1)}, ${current.z.toFixed(1)})`
    this.pushSignal({
      id: randomUUID(),
      source: 'system',
      author: 'stuck-detector',
      text: stalledMessage,
      importance: 0.95,
      timestamp: now,
    })
    this.queueDeterministicRecovery(stalledMessage, now)
    this.logger.withFields({
      stagnantForMs: COORDINATE_STUCK_THRESHOLD_MS,
      position: current,
    }).warn('Coordinate stall detected; queued deterministic recovery')
  }

  private async buildContext(now: number): Promise<AutonomyDecisionContext> {
    const recentSignals = [...this.signalBuffer]
      .sort((left, right) => {
        if (right.importance !== left.importance) {
          return right.importance - left.importance
        }
        return right.timestamp - left.timestamp
      })
      .slice(0, config.autonomy.maxContextMessages)

    const nearbyPlayers = Object.entries(this.bot.bot.players)
      .filter(([name, player]) => name !== this.bot.username && !!player?.entity)
      .map(([name]) => name)

    const recentActions = this.bot.memory.actions
      .slice(-8)
      .map(action => action.name)
    const conversationContext = this.buildConversationContext()
    let worldState = this.bot.status.toOneLiner()
    try {
      worldState = await generateWorldStatePrompt(this.bot as any)
    }
    catch (error) {
      this.logger.withError(error).warn('Failed to build autonomy world state prompt')
    }
    this.lastWorldState = worldState

    // 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ Lv2 C-1: RAG knowledge injection 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ
    let knowledgeSnippet: string | undefined
    let worldFacts: WorldFacts | undefined
    let structuredMemory = this.bot.memory?.getStructuredContext?.()
    try {
      worldFacts = collectWorldFacts(this.bot)
      const progression = buildProgressionSnapshot(worldFacts)
      this.bot.memory?.updateProgression?.({
        currentMilestone: progression.currentMilestone,
        unresolvedNeeds: progression.unresolvedNeeds,
        nextGoals: progression.nextGoals.slice(0, 2),
      })
      structuredMemory = this.bot.memory?.getStructuredContext?.()
      const goalCandidates = config.autonomy.selfGoals.slice(0, 5)
      knowledgeSnippet = retrieveRelevantKnowledge(worldFacts, goalCandidates) || undefined

      const lessonLines = this.lessons?.formatForPrompt({
        dimension: worldFacts.dimension,
        milestone: progression.currentMilestone,
      }, 4) ?? []
      if (lessonLines.length > 0) {
        const lessonsBlock = `--- Lessons from past deaths/failures ---\n${lessonLines.join('\n')}`
        knowledgeSnippet = knowledgeSnippet ? `${knowledgeSnippet}\n\n${lessonsBlock}` : lessonsBlock
      }

      const emotionLine = getActiveEmotionEngine()?.describeForPrompt()
      if (emotionLine) {
        knowledgeSnippet = knowledgeSnippet ? `${knowledgeSnippet}\n\n${emotionLine}` : emotionLine
      }
    }
    catch (err) {
      this.logger.withError(err).warn('[Stability] RAG knowledge retrieval failed (non-fatal)')
    }

    return {
      nowIso: new Date(now).toISOString(),
      botName: this.bot.username,
      activeGoal: this.activeGoal,
      activeGoalElapsedMs: this.activeGoalStartedAt > 0 ? now - this.activeGoalStartedAt : 0,
      status: this.bot.status.toOneLiner(),
      worldState: knowledgeSnippet ? `${worldState}\n\n--- Minecraft Knowledge ---\n${knowledgeSnippet}` : worldState,
      nearbyPlayers,
      recentActions,
      candidateSelfGoals: config.autonomy.selfGoals,
      recentSignals,
      socialWeights: {
        selfGoal: config.autonomy.selfGoalWeight,
        social: config.autonomy.socialWeight,
        comment: config.autonomy.commentWeight,
      },
      conversationContext,
      worldStateVersion: this.worldStateVersion,
      knowledgeSnippet,
      worldFacts,
      structuredMemory,
    }
  }

  private buildConversationContext(): AutonomyDecisionContext['conversationContext'] {
    const recentHistory = this.bot.memory.chatHistory.slice(-36)
    const recentViewerMessages: string[] = []
    const recentAssistantMessages: string[] = []

    for (const message of recentHistory) {
      const role = (message as any)?.role
      const content = this.extractChatMessageText((message as any)?.content)
      if (!content) {
        continue
      }

      if (role === 'user') {
        recentViewerMessages.push(content)
      }
      else if (role === 'assistant') {
        recentAssistantMessages.push(content)
      }
    }

    return {
      recentViewerMessages: recentViewerMessages.slice(-8),
      recentAssistantMessages: recentAssistantMessages.slice(-6),
      suggestedAdjustments: this.extractSuggestedAdjustments(recentViewerMessages).slice(-5),
    }
  }

  private buildProgressionSnapshotSafe(): ReturnType<typeof buildProgressionSnapshot> | null {
    try {
      return buildProgressionSnapshot(collectWorldFacts(this.bot))
    }
    catch (error) {
      this.logger.withError(error).warn('Failed to build progression snapshot for narration')
      return null
    }
  }

  private buildProgressionMemoLines(snapshot: ReturnType<typeof buildProgressionSnapshot> | null): string[] {
    if (!snapshot) {
      return []
    }

    return [
      `milestone=${snapshot.currentMilestone}`,
      `needs=${snapshot.unresolvedNeeds.join(', ') || 'none'}`,
      `blockers=${snapshot.blockers.join(', ') || 'none'}`,
      `danger=${snapshot.danger.join(', ') || 'none'}`,
    ]
  }

  private activateRecoveryBackpressure(now = Date.now()): void {
    this.criticalRecoveryUntil = Math.max(this.criticalRecoveryUntil, now + RECOVERY_SPEECH_BACKPRESSURE_MS)
  }

  private buildDeterministicRecoveryPlan(reason: string, facts: WorldFacts): { goal: string, plan: Plan } {
    const fallbackGoal = buildStallRecoveryGoal(facts)
    const wantsSurfaceEscape = this.lastWorldState.includes('terrain_context: underground_cave')
      || this.isSurfaceRecoveryGoal(this.activeGoal || '')
    const steps: Plan['steps'] = []

    if (wantsSurfaceEscape) {
      steps.push({
        description: 'Search for a surface-facing block to break out of the cave stall',
        tool: 'searchForBlock',
        params: {
          type: 'grass_block',
          search_range: 64,
        },
        meta: {
          plannerSource: 'recovery',
          blockedReason: reason,
        },
      })
    }

    steps.push({
      description: 'Move away from the stalled coordinates to force a new path and viewpoint',
      tool: 'moveAway',
      params: {
        distance: wantsSurfaceEscape ? 24 : 16,
      },
      meta: {
        plannerSource: 'recovery',
        blockedReason: reason,
      },
    })

    return {
      goal: fallbackGoal,
      plan: {
        goal: fallbackGoal,
        status: 'pending',
        requiresAction: true,
        steps,
      },
    }
  }

  private queueDeterministicRecovery(reason: string, now = Date.now()): void {
    const facts = collectWorldFacts(this.bot)
    const recovery = this.buildDeterministicRecoveryPlan(reason, facts)
    this.pendingRecoveryPlan = {
      goal: recovery.goal,
      reason,
      plan: recovery.plan,
      queuedAt: now,
    }
    this.activateRecoveryBackpressure(now)
    this.logger.withFields({
      goal_id: recovery.goal,
      recovery_taken: 'deterministic-stall-recovery',
      failure_class: 'coordinate_stall',
      planner_source: 'recovery',
      next_decision_reason: reason,
    }).warn('Queued deterministic recovery plan')
    monitorBus.emitMonitor('orchestrator:recoveryQueued', {
      goal: recovery.goal,
      reason,
      plannerSource: 'recovery',
    })
  }

  private pruneNarrationFamilies(now = Date.now()): void {
    this.recentNarrationFamilies = this.recentNarrationFamilies
      .filter(entry => now - entry.at <= AIRI_COMMENTARY_DUPLICATE_WINDOW_MS)
      .slice(-8)
  }

  private recordNarrationDecision(
    decision: {
      motifFamily: string
      templateFamily: string
      isKeepalive: boolean
      speechIntent: string
      groundingSource: string
      repetitionCooldownHit: boolean
      suppressedReason?: string
      noveltyScore: number
    },
    now = Date.now(),
  ): void {
    this.pruneNarrationFamilies(now)
    if (decision.motifFamily) {
      this.recentNarrationFamilies.push({ family: decision.motifFamily, at: now })
    }
    this.consecutiveKeepalives = decision.isKeepalive ? this.consecutiveKeepalives + 1 : 0
    this.bot.memory?.recordNarrationDecision?.({
      motifFamily: decision.motifFamily,
      templateFamily: decision.templateFamily,
      speechIntent: decision.speechIntent,
      groundingSource: decision.groundingSource,
      isKeepalive: decision.isKeepalive,
    })
    this.logger.withFields({
      speech_intent: decision.speechIntent,
      grounding_source: decision.groundingSource,
      motif_family: decision.motifFamily,
      template_family: decision.templateFamily,
      novelty_score: decision.noveltyScore,
      repetition_cooldown_hit: decision.repetitionCooldownHit,
      suppressed_reason: decision.suppressedReason || '',
    }).log('Autonomy narration decision')
  }

  private buildLowVramNarrationDecision(options: {
    goalLabel: string
    actionLabel: string
    obstacle: string
    changedParts: string[]
    reason?: string
    allowKeepalive: boolean
  }): ReturnType<typeof buildDeterministicNarration> | null {
    if (!config.autonomy.lowVramMode) {
      return null
    }

    const reason = options.reason || ''
    const hasRecentSpeechHistory = this.recentPublicSpeeches.some(entry => Date.now() - entry.at <= PUBLIC_SPEECH_MEMORY_WINDOW_MS)
    const repeatedFamilyCooldownHit = this.recentNarrationFamilies.length > 0
    const repeatedKeepalive = this.consecutiveKeepalives >= 1
    const repeatedStallCommentary = reason.includes('goal-result')
      || (reason.includes('voiced-keepalive') && hasRecentSpeechHistory && (repeatedKeepalive || repeatedFamilyCooldownHit))
      || (reason.includes('periodic-idle') && hasRecentSpeechHistory && (repeatedKeepalive || repeatedFamilyCooldownHit))
      || (reason.includes('periodic-progress') && options.changedParts.length === 0 && repeatedFamilyCooldownHit)

    if (!repeatedStallCommentary) {
      return null
    }

    const progression = this.buildProgressionSnapshotSafe()
    const structuredMemory = this.bot.memory?.getStructuredSnapshot?.()
    return buildDeterministicNarration({
      goalLabel: options.goalLabel,
      actionLabel: options.actionLabel,
      obstacle: options.obstacle,
      milestone: progression?.currentMilestone || '',
      unresolvedNeeds: progression?.unresolvedNeeds || [],
      blockers: progression?.blockers || [],
      danger: progression?.danger || [],
      changedParts: options.changedParts,
      reason,
      allowKeepalive: options.allowKeepalive,
      recentFamilies: this.recentNarrationFamilies.map(entry => entry.family),
      consecutiveKeepalives: this.consecutiveKeepalives,
      maxConsecutiveKeepalives: Math.max(1, config.autonomy.maxConsecutiveKeepalives),
      lastFailureClass: structuredMemory?.lastFailureClass || '',
      lastActionOutcome: structuredMemory?.lastActionOutcome || '',
    })
  }

  private extractChatMessageText(content: unknown): string {
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 180)

    if (typeof content === 'string') {
      const normalized = normalize(content)
      return normalized
    }

    if (Array.isArray(content)) {
      const joined = content
        .map((item) => {
          if (typeof item === 'string') {
            return item
          }
          if (!item || typeof item !== 'object') {
            return ''
          }
          const text = (item as any)?.text
          return typeof text === 'string' ? text : ''
        })
        .join(' ')

      return normalize(joined)
    }

    if (content && typeof content === 'object') {
      const text = (content as any)?.text
      if (typeof text === 'string') {
        return normalize(text)
      }
    }

    return ''
  }

  private extractSuggestedAdjustments(viewerMessages: string[]): string[] {
    const seen = new Set<string>()
    const suggestions: string[] = []
    const patterns = [
      /\u624B\u4F1D/u,
      /\u6559\u3048\u3066/u,
      /\u3044\u3063\u3057\u3087/u,
      /\u4E00\u7DD2/u,
      /\u52A9\u3051\u3066/u,
      /\u6848\u5185/u,
      /\u983C\u3080/u,
      /try\b/i,
      /should\b/i,
      /let'?s\b/i,
      /collect\b/i,
      /build\b/i,
      /craft\b/i,
      /mine\b/i,
      /wood\b|log\b|food\b|house\b|shelter\b/i,
    ]

    for (const raw of viewerMessages.slice(-12).reverse()) {
      const withoutSpeaker = raw.replace(/^[^:]{1,32}:\s*/, '').trim()
      if (!withoutSpeaker) {
        continue
      }
      if (!patterns.some(pattern => pattern.test(withoutSpeaker))) {
        continue
      }

      const signature = withoutSpeaker.toLowerCase()
      if (seen.has(signature)) {
        continue
      }

      seen.add(signature)
      suggestions.push(withoutSpeaker.slice(0, 140))
      if (suggestions.length >= 6) {
        break
      }
    }

    return suggestions.reverse()
  }

  private blockGoalExecution(goal: string, reason: string, now: number): null {
    const detail = reason.replace(/\s+/g, ' ').trim().slice(0, 240)
    this.pushSignal({
      id: randomUUID(),
      source: 'system',
      author: 'goal-guard',
      text: `goal-blocked:${goal} | ${detail}`.slice(0, 240),
      importance: 0.82,
      timestamp: now,
    })
    monitorBus.emitMonitor('orchestrator:goalBlocked', { goal, reason: detail })
    this.emitSpark('blocked', `Autonomy blocked goal: ${goal}`)
    this.logger.withFields({ goal, reason: detail }).warn('Autonomy blocked goal without mechanical replacement')
    return null
  }

  private resolveExecutableGoal(
    goal: string,
    reason: string | undefined,
    now: number,
    redirectDepth = 0,
  ): { goal: string, reason?: string } | null {
    this.pruneRecentGoalFailures(now)
    const requestedGoal = goal
    const requestedGoalKey = this.normalizeGoalKey(requestedGoal)
    const requestedGoalFamily = this.classifyGoalFamily(requestedGoal)
    const worldHintsForGuard = this.extractWorldStateHints(this.lastWorldState)

    let guardFacts: WorldFacts | null = null
    try {
      guardFacts = collectWorldFacts(this.bot)
    }
    catch (err) {
      this.logger.withError(err).warn('[Stability] Failed to collect world facts for goal guard (non-fatal), proceeding with original goal')
    }

    // 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ Lv0 A-1 double-guard: enforce preconditions 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ
    if (guardFacts) {
      const constraint = describeGoalConstraint(goal, guardFacts, this.banUntilMs)
      if (constraint.blocked) {
        this.recordPrecondViolation(goal)
        const mechanicalReplacement = this.buildMechanicalReplacementGoal(
          goal,
          requestedGoalFamily,
          null,
          guardFacts,
          this.extractWorldStateHints(this.lastWorldState),
        )
        if (
          mechanicalReplacement
          && this.normalizeGoalKey(mechanicalReplacement) === this.normalizeGoalKey(this.buildSurfaceRecoveryGoal(goal))
          && !this.isSurfaceRecoveryGoal(goal)
          && redirectDepth < 2
          && this.normalizeGoalKey(mechanicalReplacement) !== requestedGoalKey
        ) {
          this.logger.withFields({
            goal,
            replacementGoal: mechanicalReplacement,
            constraint: constraint.reason,
          }).warn('Autonomy prioritized surface recovery over local prerequisite chaining')
          return this.resolveExecutableGoal(
            mechanicalReplacement,
            `${reason ? `${reason} | ` : ''}goal-replaced: underground cave with poor wood access and missing mining bootstrap requires surfacing first`,
            now,
            redirectDepth + 1,
          )
        }
        const replacementGoal = constraint.source === 'precondition'
          ? constraint.redirect?.trim()
          : ''
        if (
          replacementGoal
          && redirectDepth < 2
          && this.normalizeGoalKey(replacementGoal) !== requestedGoalKey
        ) {
          this.logger.withFields({
            goal,
            replacementGoal,
            constraint: constraint.reason,
          }).log('Autonomy mechanically replaced blocked goal with prerequisite goal')
          return this.resolveExecutableGoal(
            replacementGoal,
            `${reason ? `${reason} | ` : ''}goal-replaced: ${constraint.reason || 'goal currently blocked by safety guard'}`,
            now,
            redirectDepth + 1,
          )
        }
        if (
          mechanicalReplacement
          && redirectDepth < 2
          && this.normalizeGoalKey(mechanicalReplacement) !== requestedGoalKey
        ) {
          this.logger.withFields({
            goal,
            replacementGoal: mechanicalReplacement,
            constraint: constraint.reason,
          }).warn('Autonomy mechanically replaced blocked goal after precondition rejection')
          return this.resolveExecutableGoal(
            mechanicalReplacement,
            `${reason ? `${reason} | ` : ''}goal-replaced: ${constraint.reason || 'goal currently blocked by safety guard'}`,
            now,
            redirectDepth + 1,
          )
        }
        return this.blockGoalExecution(
          goal,
          `${reason ? `${reason} | ` : ''}goal-blocked: ${constraint.reason || 'goal currently blocked by safety guard'}`,
          now,
        )
      }
    }

    if (
      guardFacts
      && redirectDepth < 2
      && this.shouldOverrideToSurfaceResupply(goal, requestedGoalFamily, guardFacts, worldHintsForGuard)
      && !this.isSurfaceRecoveryGoal(goal)
    ) {
      const recoveryGoal = this.buildSurfaceResupplyGoal()
      if (this.normalizeGoalKey(recoveryGoal) !== requestedGoalKey) {
        this.logger.withFields({
          goal,
          recoveryGoal,
          requestedGoalFamily,
          worldHints: worldHintsForGuard,
          pickaxeTier: guardFacts.pickaxeTier,
          torchCount: guardFacts.torchCount,
          foodItemCount: guardFacts.foodItemCount,
          nearbyHostileCount: guardFacts.nearbyHostileCount,
        }).warn('Replacing generic underground progression goal with surface resupply objective')
        return this.resolveExecutableGoal(
          recoveryGoal,
          `${reason ? `${reason} | ` : ''}goal-replaced: iron-ready underground progression still lacks surface resupply buffers`,
          now,
          redirectDepth + 1,
        )
      }
    }

    // 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ Lv0 A-3: Goal history + exponential backoff 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ
    try {
      const goalType = classifyGoalType(goal)
      collectWorldFacts(this.bot) // refresh score side-effects
      const currentScore = this.goalTypeHistory.length > 0 ? this.goalTypeHistory[this.goalTypeHistory.length - 1].score : 0
      const recentSame = this.goalTypeHistory.filter(h => h.goalType === goalType && now - h.at < 180_000)
      if (recentSame.length >= 3) {
        const scoreImproved = currentScore > (recentSame[0]?.score ?? 0) + 0.5
        if (!scoreImproved) {
          incrementMetric('sameGoalRepeatSuppressedCount')
          this.logger.withFields({ goalType, repeatCount: recentSame.length }).warn('[Stability] Same goal repeated without progress, blocking it until the LLM picks a different one')
          return this.blockGoalExecution(
            goal,
            `${reason ? `${reason} | ` : ''}goal-blocked: repeated ${goalType} goal without measurable progress`,
            now,
          )
        }
      }
      // Record attempt
      this.goalTypeHistory.push({ goalType, score: currentScore, at: now })
      if (this.goalTypeHistory.length > 20) {
        this.goalTypeHistory = this.goalTypeHistory.slice(-20)
      }
    }
    catch (err) {
      this.logger.withError(err).warn('[Stability] Goal history check failed (non-fatal)')
    }

    const normalizedGoal = this.normalizeGoalKey(goal)
    const goalFamily = this.classifyGoalFamily(goal)
    const goalKeysToCheck = new Set(
      [normalizedGoal, requestedGoalKey]
        .map(value => value.trim())
        .filter(Boolean),
    )
    const goalFamiliesToCheck = new Set<string>([goalFamily, requestedGoalFamily])
    const worldHints = this.extractWorldStateHints(this.lastWorldState)
    const retargetedMiningGoal = this.maybeRetargetMiningGoal(goal)

    if (
      retargetedMiningGoal
      && redirectDepth < 2
      && this.normalizeGoalKey(retargetedMiningGoal.goal) !== requestedGoalKey
    ) {
      this.logger.withFields({
        goal,
        retargetedGoal: retargetedMiningGoal.goal,
      }).log('Retargeting mining goal to the latest notable-block coordinates')

      return this.resolveExecutableGoal(
        retargetedMiningGoal.goal,
        `${reason ? `${reason} | ` : ''}${retargetedMiningGoal.reason}`,
        now,
        redirectDepth + 1,
      )
    }

    if (
      this.shouldOverrideToSurfaceRecovery(goal, goalFamily, guardFacts, worldHints)
      && !this.isSurfaceRecoveryGoal(goal)
    ) {
      const recoveryGoal = this.buildSurfaceRecoveryGoal(goal)
      this.logger.withFields({
        goal,
        recoveryGoal,
        goalFamily,
        worldHints,
      }).warn('Replacing blocked underground bootstrap goal with surface recovery goal')

      return this.resolveExecutableGoal(
        recoveryGoal,
        `${reason ? `${reason} | ` : ''}goal-replaced: underground cave with poor wood access and missing mining bootstrap requires surfacing first`,
        now,
        redirectDepth + 1,
      )
    }

    const sameGoalFailures = this.recentGoalFailures.filter(failure =>
      goalKeysToCheck.has(failure.goalKey)
      && now - failure.at <= GOAL_RESELECTION_COOLDOWN_MS,
    ).length

    const sameGoalFamilyFailures = this.recentGoalFailures.filter(failure =>
      goalFamiliesToCheck.has(failure.goalFamily ?? this.classifyGoalFamily(failure.goalKey))
      && now - failure.at <= GOAL_FAMILY_RESELECTION_COOLDOWN_MS,
    ).length

    const repeatedFailureFamilies = [
      'wood-bootstrap',
      'resource-bootstrap',
      'combat-engagement',
      'placement-blocked',
      'sleep-blocked',
      'navigation-stuck',
      'resource-extraction-blocked',
    ] as const

    for (const failureFamily of repeatedFailureFamilies) {
      const familyFailures = this.recentGoalFailures.filter(failure =>
        failure.family === failureFamily
        && now - failure.at <= this.getFailureFamilyCooldownMs(failureFamily),
      ).length
      const threshold = failureFamily === 'wood-bootstrap'
        ? WOOD_BOOTSTRAP_FAILURE_THRESHOLD
        : failureFamily === 'resource-extraction-blocked'
          ? 1
          : GOAL_FAMILY_FAILURE_THRESHOLD
      const safetyGoalBypassesResourceFailure = goalFamily === 'safety-setup'
        && (failureFamily === 'resource-bootstrap' || failureFamily === 'resource-extraction-blocked')
      if (
        familyFailures < threshold
        || this.isRecoveryGoalForFamily(goal, failureFamily)
        || safetyGoalBypassesResourceFailure
        || this.isSurfaceRecoveryGoal(goal)
      ) {
        continue
      }

      const mechanicalReplacement = this.buildMechanicalReplacementGoal(goal, goalFamily, failureFamily, guardFacts, worldHints)
      if (
        mechanicalReplacement
        && redirectDepth < 2
        && this.normalizeGoalKey(mechanicalReplacement) !== requestedGoalKey
      ) {
        this.logger.withFields({
          goal,
          goalFamily,
          failureFamily,
          replacementGoal: mechanicalReplacement,
          familyFailures,
        }).warn('Replacing blocked goal with deterministic mechanical recovery objective')
        return this.resolveExecutableGoal(
          mechanicalReplacement,
          `${reason ? `${reason} | ` : ''}goal-replaced: repeated ${failureFamily} failures require a deterministic recovery objective`,
          now,
          redirectDepth + 1,
        )
      }

      this.logger.withFields({
        goal,
        goalFamily,
        failureFamily,
        familyFailures,
      }).warn('Blocking goal due to repeated failure family')

      return this.blockGoalExecution(
        goal,
        `${reason ? `${reason} | ` : ''}goal-blocked: repeated ${failureFamily} failures recently blocked progression`,
        now,
      )
    }

    if (
      (sameGoalFailures >= 2 || sameGoalFamilyFailures >= GOAL_FAMILY_FAILURE_THRESHOLD)
      && !this.isRecoveryGoalForFamily(goal, goalFamily)
    ) {
      const mechanicalReplacement = this.buildMechanicalReplacementGoal(goal, goalFamily, null, guardFacts, worldHints)
      if (
        mechanicalReplacement
        && redirectDepth < 2
        && this.normalizeGoalKey(mechanicalReplacement) !== requestedGoalKey
      ) {
        this.logger.withFields({
          goal,
          sameGoalFailures,
          sameGoalFamilyFailures,
          goalFamily,
          replacementGoal: mechanicalReplacement,
        }).warn('Replacing repeatedly failing goal with deterministic alternate objective')
        return this.resolveExecutableGoal(
          mechanicalReplacement,
          `${reason ? `${reason} | ` : ''}goal-replaced: recent repeated failures require an alternate objective`,
          now,
          redirectDepth + 1,
        )
      }

      this.logger.withFields({
        goal,
        sameGoalFailures,
        sameGoalFamilyFailures,
        goalFamily,
      }).warn('Blocking immediate goal reselection due to recent repeated failures')
      return this.blockGoalExecution(
        goal,
        `${reason ? `${reason} | ` : ''}goal-blocked: recent repeated failures for this goal family`,
        now,
      )
    }

    return { goal, reason }
  }

  // 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ Lv1 B-1: Precondition violation tracking + temporary ban 鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ鬯ｮ・ｫ繝ｻ・ｨ髮九ｇ蠎・ｾつ
  private recordPrecondViolation(goal: string): void {
    const goalType = classifyGoalType(goal)
    const count = (this.precondFailCount.get(goalType) ?? 0) + 1
    this.precondFailCount.set(goalType, count)
    incrementMetric('precondViolationCount')
    monitorBus.emitMonitor('orchestrator:precondViolation', { goalType, count, goal })

    if (count >= this.PRECOND_BAN_THRESHOLD) {
      const banUntil = Date.now() + this.PRECOND_BAN_DURATION_MS
      this.banUntilMs.set(goalType, banUntil)
      this.precondFailCount.set(goalType, 0)
      incrementMetric('goalBanAppliedCount')
      this.logger.withFields({ goalType, count, banUntil: new Date(banUntil).toISOString() })
        .warn('[Stability] Goal type temporarily banned due to repeated precondition violations')
    }
  }

  private normalizeGoalKey(goal: string): string {
    return goal
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  }

  private normalizeFailureMessage(errorMessage: string): string {
    return errorMessage
      .toLowerCase()
      .replace(/\b\d+\b/g, '#')
      .replace(/"[^"]+"/g, '"#"')
      .replace(/\([^)]*\)/g, '(#)')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private classifyGoalFamily(goal: string): string {
    const normalizedGoal = this.normalizeGoalKey(goal)
    if (
      normalizedGoal.includes('gather reachable wood')
      || normalizedGoal.includes('basic crafting')
      || normalizedGoal.includes('wood')
      || normalizedGoal.includes('log')
      || normalizedGoal.includes('crafting table')
    ) {
      return 'wood-bootstrap'
    }
    if (
      normalizedGoal.includes('safety')
      || normalizedGoal.includes('safe')
      || normalizedGoal.includes('base')
      || normalizedGoal.includes('torch')
      || normalizedGoal.includes('shelter')
      || normalizedGoal.includes('bed')
      || normalizedGoal.includes('night')
    ) {
      return 'safety-setup'
    }
    if (
      normalizedGoal.includes('ore')
      || normalizedGoal.includes('coal')
      || normalizedGoal.includes('iron')
      || normalizedGoal.includes('stone')
      || normalizedGoal.includes('mine')
      || normalizedGoal.includes('resource')
      || normalizedGoal.includes('explore nearby terrain')
    ) {
      return 'resource-bootstrap'
    }
    if (
      normalizedGoal.includes('food')
      || normalizedGoal.includes('survival')
      || normalizedGoal.includes('animal')
      || normalizedGoal.includes('hunt')
    ) {
      return 'food-survival'
    }
    if (
      normalizedGoal.includes('attack')
      || normalizedGoal.includes('defend')
      || normalizedGoal.includes('clear the area')
      || normalizedGoal.includes('hostile')
      || normalizedGoal.includes('mob')
    ) {
      return 'combat-engagement'
    }
    if (
      normalizedGoal.includes('relocate')
      || normalizedGoal.includes('different area')
      || normalizedGoal.includes('new area')
      || normalizedGoal.includes('open ground')
      || normalizedGoal.includes('reorient')
    ) {
      return 'relocation'
    }
    return 'generic'
  }

  private getFailureFamilyCooldownMs(failureFamily: string): number {
    if (failureFamily === 'wood-bootstrap') {
      return WOOD_BOOTSTRAP_FAILURE_COOLDOWN_MS
    }
    if (failureFamily === 'resource-bootstrap' || failureFamily === 'resource-extraction-blocked') {
      return RESOURCE_FAILURE_RESELECTION_COOLDOWN_MS
    }
    if (failureFamily === 'navigation-stuck') {
      return GOAL_FAMILY_RESELECTION_COOLDOWN_MS
    }
    return GOAL_RESELECTION_COOLDOWN_MS
  }

  private classifyGoalFailureFamily(goal: string, errorMessage: string): string {
    const normalizedError = this.normalizeFailureMessage(errorMessage)
    const goalFamily = this.classifyGoalFamily(goal)
    if (
      normalizedError.includes('collectblocks failed: log')
      || normalizedError.includes('ensurepickaxe(')
      || normalizedError.includes('ensureaxe(')
      || normalizedError.includes('ensureshovel(')
      || normalizedError.includes('tool recovery failed')
      || normalizedError.includes('craftrecipe(#) failed: ensurepickaxe(#) failed')
      || (normalizedError.includes('craftrecipe(') && (
        normalizedError.includes('wooden_pickaxe')
        || normalizedError.includes('stick')
        || normalizedError.includes('planks')
        || normalizedError.includes('crafting_table')
      ))
      || goalFamily === 'wood-bootstrap'
    ) {
      return 'wood-bootstrap'
    }

    if (
      normalizedError.includes('could not mine cobblestone')
      || normalizedError.includes('digging timed out')
    ) {
      return 'resource-extraction-blocked'
    }

    if (
      normalizedError.includes('collectblocks failed: coal_ore')
      || normalizedError.includes('collectblocks failed: iron_ore')
      || normalizedError.includes('collectblocks failed: cobblestone')
      || normalizedError.includes('collectblocks failed: stone')
      || normalizedError.includes('smeltitem(')
      || normalizedError.includes('furnace')
      || (normalizedError.includes('craftrecipe(') && (
        normalizedError.includes('stone_pickaxe')
        || normalizedError.includes('torch')
        || normalizedError.includes('furnace')
      ))
      || goalFamily === 'resource-bootstrap'
    ) {
      return 'resource-bootstrap'
    }

    if (
      normalizedError.includes('searchforentity(')
      || normalizedError.includes('attack(')
      || normalizedError.includes('attackplayer(')
      || normalizedError.includes('defend self')
      || normalizedError.includes('combat progress')
      || goalFamily === 'combat-engagement'
    ) {
      return 'combat-engagement'
    }

    if (
      normalizedError.includes('placehere(')
      || normalizedError.includes('failed to place')
      || normalizedError.includes('nothing to place on')
      || normalizedError.includes('block in the way')
      || normalizedError.includes('activate(')
    ) {
      return 'placement-blocked'
    }

    if (
      normalizedError.includes('gotobed')
      || normalizedError.includes('sleep')
      || normalizedError.includes('bed')
    ) {
      return 'sleep-blocked'
    }

    if (
      normalizedError.includes('timed out')
      || normalizedError.includes('path was stopped')
      || normalizedError.includes('stuck-recovery')
    ) {
      return 'navigation-stuck'
    }

    return goalFamily
  }

  private isWoodBootstrapRecoveryGoal(goal: string): boolean {
    const normalized = this.normalizeGoalKey(goal)
    return normalized.includes('gather reachable wood')
      || normalized.includes('basic crafting')
      || normalized.includes('different area')
  }

  private isSurfaceRecoveryGoal(goal: string): boolean {
    const normalized = this.normalizeGoalKey(goal)
    return normalized.includes('surface')
      || normalized.includes('dig up')
      || normalized.includes('dig upwards')
      || normalized.includes('dig upward')
      || normalized.includes('climb upward')
      || normalized.includes('ascend')
      || normalized.includes('escape')
      || normalized.includes('open terrain')
      || normalized.includes('cave exit')
      || normalized.includes('surface recovery')
      || normalized.includes('before gathering wood or mining deeper')
      || goal.includes('地上')
      || goal.includes('脱出')
      || goal.includes('出口')
      || goal.includes('上へ')
      || goal.includes('登')
  }

  private buildSurfaceRecoveryGoal(_goal: string): string {
    return 'Escape to the surface to gather wood'
  }

  private buildMechanicalReplacementGoal(
    goal: string,
    goalFamily: string,
    failureFamily: string | null,
    facts: WorldFacts | null,
    hints: { terrainContext: string, woodAccess: string, pickaxeAccess: string, surfaceEscapeNeeded: boolean },
  ): string | null {
    const normalizedGoal = this.normalizeGoalKey(goal)
    if (this.shouldOverrideToSurfaceRecovery(goal, goalFamily, facts, hints) && !this.isSurfaceRecoveryGoal(goal)) {
      return this.buildSurfaceRecoveryGoal(goal)
    }

    const needsSurfaceResupply = hints.surfaceEscapeNeeded && (
      goalFamily === 'food-survival'
      || normalizedGoal.includes('food')
      || normalizedGoal.includes('survival')
      || normalizedGoal.includes('animal')
      || normalizedGoal.includes('cave exploration')
    )
    if (needsSurfaceResupply && failureFamily === 'combat-engagement') {
      return this.buildSurfaceRecoveryGoal(goal)
    }

    if (failureFamily === 'combat-engagement' || goalFamily === 'food-survival') {
      return 'Relocate to a different area before searching for food again'
    }

    if (failureFamily === 'navigation-stuck') {
      return 'Reorient in open terrain before resuming work'
    }

    if (failureFamily === 'placement-blocked') {
      return 'Move to a clearer patch before placing blocks again'
    }

    if (
      failureFamily === 'resource-bootstrap'
      || failureFamily === 'resource-extraction-blocked'
      || goalFamily === 'resource-bootstrap'
    ) {
      return 'Explore a different area for reachable surface stone and ore'
    }

    return null
  }

  private extractWorldStateNotableBlocks(worldState: string): Array<{
    name: string
    distance: number
    position: { x: number, y: number, z: number }
  }> {
    const notableLine = worldState
      .split('\n')
      .find(entry => entry.toLowerCase().startsWith('notable_blocks:'))
    if (!notableLine) {
      return []
    }

    return notableLine
      .slice(notableLine.indexOf(':') + 1)
      .split('|')
      .map((entry) => {
        const match = entry.trim().match(/^([\w:]+)\s+@\s+([0-9.]+)m\s+\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/i)
        if (!match) {
          return null
        }

        const [, rawName, rawDistance, rawX, rawY, rawZ] = match
        const distance = Number.parseFloat(rawDistance || '')
        const x = Number.parseFloat(rawX || '')
        const y = Number.parseFloat(rawY || '')
        const z = Number.parseFloat(rawZ || '')
        if (!rawName || ![distance, x, y, z].every(Number.isFinite)) {
          return null
        }

        return {
          name: rawName.toLowerCase(),
          distance,
          position: { x, y, z },
        }
      })
      .filter((entry): entry is {
        name: string
        distance: number
        position: { x: number, y: number, z: number }
      } => entry !== null)
  }

  private extractMiningGoalTargetTypes(goal: string): string[] {
    const normalized = this.normalizeGoalKey(goal)
    if (normalized.includes('iron ore') || normalized.includes('iron_ore')) {
      return ['iron_ore', 'deepslate_iron_ore']
    }
    if (normalized.includes('coal ore') || normalized.includes('coal_ore')) {
      return ['coal_ore', 'deepslate_coal_ore']
    }
    if (normalized.includes('diamond ore') || normalized.includes('diamond_ore')) {
      return ['diamond_ore', 'deepslate_diamond_ore']
    }
    if (normalized.includes('cobblestone') || (normalized.includes('mine') && normalized.includes('stone'))) {
      return ['stone', 'cobblestone', 'cobbled_deepslate']
    }
    return []
  }

  private extractGoalCoordinates(goal: string): { x: number, y: number, z: number } | null {
    const match = goal.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/)
    if (!match) {
      return null
    }

    const [, rawX, rawY, rawZ] = match
    const x = Number.parseFloat(rawX || '')
    const y = Number.parseFloat(rawY || '')
    const z = Number.parseFloat(rawZ || '')
    if (![x, y, z].every(Number.isFinite)) {
      return null
    }

    return { x, y, z }
  }

  private maybeRetargetMiningGoal(goal: string): { goal: string, reason: string } | null {
    const targetTypes = this.extractMiningGoalTargetTypes(goal)
    if (targetTypes.length === 0) {
      return null
    }

    const currentTarget = this.extractWorldStateNotableBlocks(this.lastWorldState)
      .find(target => targetTypes.includes(target.name))
    if (!currentTarget) {
      return null
    }

    const existingTarget = this.extractGoalCoordinates(goal)
    if (existingTarget) {
      const distanceToCurrentTarget = Math.hypot(
        currentTarget.position.x - existingTarget.x,
        currentTarget.position.y - existingTarget.y,
        currentTarget.position.z - existingTarget.z,
      )
      if (distanceToCurrentTarget <= 4) {
        return null
      }
    }

    return {
      goal: `mine ${currentTarget.name} at (${Math.round(currentTarget.position.x)}, ${Math.round(currentTarget.position.y)}, ${Math.round(currentTarget.position.z)})`,
      reason: `goal-retargeted: refreshed ${currentTarget.name} coordinates from current world scan`,
    }
  }

  private extractWorldStateHints(worldState: string): {
    terrainContext: string
    woodAccess: string
    pickaxeAccess: string
    surfaceEscapeNeeded: boolean
  } {
    const read = (key: string): string => {
      const line = worldState
        .split('\n')
        .find(entry => entry.toLowerCase().startsWith(`${key.toLowerCase()}:`))
      return line ? line.slice(line.indexOf(':') + 1).trim() : ''
    }

    return {
      terrainContext: read('terrain_context'),
      woodAccess: read('wood_access'),
      pickaxeAccess: read('pickaxe_access'),
      surfaceEscapeNeeded: read('surface_escape_needed') === 'true',
    }
  }

  private buildSurfaceResupplyGoal(): string {
    return 'Escape to the surface to resupply food and torches for deeper mining'
  }

  private shouldOverrideToSurfaceResupply(
    goal: string,
    goalFamily: string,
    facts: WorldFacts,
    hints: { terrainContext: string, woodAccess: string, pickaxeAccess: string, surfaceEscapeNeeded: boolean },
  ): boolean {
    if (hints.terrainContext !== 'underground_cave' && !hints.surfaceEscapeNeeded) {
      return false
    }

    const normalizedGoal = this.normalizeGoalKey(goal)
    const foodRecoveryGoal = goalFamily === 'food-survival'
      || normalizedGoal.includes('food')
      || normalizedGoal.includes('recover health')
      || normalizedGoal.includes('eat')
      || normalizedGoal.includes('animal')
    if (
      foodRecoveryGoal
      && facts.foodItemCount <= 0
      && (facts.health < 12 || facts.food <= 14 || facts.nearbyHostileCount > 0)
    ) {
      return true
    }

    if (!['iron', 'diamond'].includes(facts.pickaxeTier)) {
      return false
    }

    const supplyGap = facts.foodItemCount < 4 || facts.torchCount < 8
    const hostilePressure = facts.nearbyHostileCount >= 4
    if (!supplyGap && !hostilePressure) {
      return false
    }

    return goalFamily === 'generic'
      || goalFamily === 'resource-bootstrap'
      || goalFamily === 'wood-bootstrap'
      || normalizedGoal.includes('explore nearby terrain')
      || normalizedGoal.includes('resource')
      || normalizedGoal.includes('wood')
      || normalizedGoal.includes('log')
  }

  private shouldOverrideToSurfaceRecovery(
    goal: string,
    goalFamily: string,
    facts: WorldFacts | null,
    hints: { terrainContext: string, woodAccess: string, pickaxeAccess: string, surfaceEscapeNeeded: boolean },
  ): boolean {
    const normalizedGoal = this.normalizeGoalKey(goal)
    if (hints.terrainContext !== 'underground_cave' && !hints.surfaceEscapeNeeded) {
      return false
    }

    const hasLocalWoodBootstrap = (facts?.woodCount ?? 0) >= 4 || Boolean(facts?.hasCraftingTable)
    const hasLocalMiningBootstrap = Boolean(facts?.hasPickaxe)
      || (((facts?.woodCount ?? 0) >= 4) && Boolean(facts?.hasCraftingTable))

    const blockedWoodBootstrap = !hasLocalWoodBootstrap && hints.woodAccess === 'poor' && (
      goalFamily === 'wood-bootstrap'
      || goalFamily === 'resource-bootstrap'
      || normalizedGoal.includes('explore nearby terrain')
      || normalizedGoal.includes('gather wood')
      || normalizedGoal.includes('log')
    )

    const blockedMiningBootstrap = !hasLocalMiningBootstrap && hints.pickaxeAccess === 'missing' && (
      goalFamily === 'resource-bootstrap'
      || normalizedGoal.includes('mine')
      || normalizedGoal.includes('ore')
      || normalizedGoal.includes('stone')
      || normalizedGoal.includes('coal')
      || normalizedGoal.includes('iron')
      || normalizedGoal.includes('explore nearby terrain')
    )

    return blockedWoodBootstrap || blockedMiningBootstrap
  }

  private isRecoveryGoalForFamily(goal: string, family: string): boolean {
    const normalized = this.normalizeGoalKey(goal)
    if (family === 'wood-bootstrap') {
      return this.isWoodBootstrapRecoveryGoal(goal) || this.isSurfaceRecoveryGoal(goal)
    }
    if (family === 'resource-bootstrap') {
      return normalized.includes('surface stone and ore')
        || normalized.includes('before mining again')
        || this.isSurfaceRecoveryGoal(goal)
    }
    if (family === 'combat-engagement') {
      return normalized.includes('disengage from unreachable hostiles') || normalized.includes('before fighting again')
    }
    if (family === 'placement-blocked') {
      return normalized.includes('place crafting or safety blocks there')
    }
    if (family === 'sleep-blocked') {
      return normalized.includes('wait out the night') || normalized.includes('sleeping is unavailable')
    }
    if (family === 'navigation-stuck') {
      return normalized.includes('reorient before resuming work')
        || normalized.includes('open terrain')
        || this.isSurfaceRecoveryGoal(goal)
    }
    if (family === 'resource-extraction-blocked') {
      return normalized.includes('before attempting stone mining again')
        || normalized.includes('surface stone and ore before mining again')
    }
    return false
  }

  private recordGoalFailure(goal: string, errorMessage: string): void {
    const now = Date.now()
    this.pruneRecentGoalFailures(now)
    const failureFamily = this.classifyGoalFailureFamily(goal, errorMessage)
    this.recentGoalFailures.push({
      goalKey: this.normalizeGoalKey(goal),
      goalFamily: this.classifyGoalFamily(goal),
      family: failureFamily,
      at: now,
    })

    if (failureFamily === 'resource-extraction-blocked') {
      const goalType = classifyGoalType(goal)
      const banUntil = now + RESOURCE_FAILURE_RESELECTION_COOLDOWN_MS
      const existingBanUntil = this.banUntilMs.get(goalType) ?? 0
      if (banUntil > existingBanUntil) {
        this.banUntilMs.set(goalType, banUntil)
      }
      this.logger.withFields({
        goal,
        goalType,
        failureFamily,
        banUntil: new Date(Math.max(existingBanUntil, banUntil)).toISOString(),
      }).warn('[Stability] Temporarily banning repeated blocked extraction goal type')
    }
  }

  private recordGoalSuccess(goal: string): void {
    const now = Date.now()
    this.pruneRecentGoalFailures(now)
    const goalFamily = this.classifyGoalFamily(goal)
    const recoveryFamilies = [
      'wood-bootstrap',
      'resource-bootstrap',
      'combat-engagement',
      'placement-blocked',
      'sleep-blocked',
      'navigation-stuck',
      'resource-extraction-blocked',
    ].filter(family => this.isRecoveryGoalForFamily(goal, family))

    if (recoveryFamilies.length > 0) {
      this.recentGoalFailures = this.recentGoalFailures.filter(failure => !recoveryFamilies.includes(failure.family))
      return
    }

    this.recentGoalFailures = this.recentGoalFailures.filter(failure =>
      (failure.goalFamily ?? this.classifyGoalFamily(failure.goalKey)) !== goalFamily,
    )
  }

  private pruneRecentGoalFailures(now: number): void {
    this.recentGoalFailures = this.recentGoalFailures.filter(failure =>
      now - failure.at <= GOAL_FAILURE_MEMORY_WINDOW_MS,
    )
  }

  private isGoalCreationPaused(now: number): boolean {
    return this.consecutiveGoalFailures >= 3 && now - this.lastGoalFailureAt < 45_000
  }

  private scheduleGoalResultCommentary(goal: string, success: boolean): void {
    void this.emitGoalResultCommentary(goal, success).catch((error) => {
      this.logger.withError(error).warn('Goal result commentary failed')
    })
  }

  private async executePendingRecoveryPlan(recovery: { goal: string, reason: string, plan: Plan }): Promise<void> {
    this.executing = true
    this.executingStartedAt = Date.now()
    this.lastGoalAt = Date.now()
    this.activeGoal = recovery.goal
    this.activeGoalStartedAt = Date.now()
    this.bot.memory?.activateGoal?.(recovery.goal, this.buildProgressionSnapshotSafe()?.currentMilestone)
    this.activateRecoveryBackpressure()

    monitorBus.emitMonitor('orchestrator:goalSelected', {
      goal: recovery.goal,
      reason: recovery.reason,
      source: 'recovery',
    })

    try {
      await withSharedPlanLock(this.bot.username, 'autonomy-recovery', this.logger as any, async () => {
        this.logger.withFields({
          goal: recovery.goal,
          reason: recovery.reason,
          planner_source: 'recovery',
        }).warn('Autonomy executing deterministic recovery plan')
        await this.bot.planning.executePlan(recovery.plan)
      })

      this.recordGoalSuccess(recovery.goal)
      this.consecutiveGoalFailures = 0
      this.bot.memory?.completeGoal?.(recovery.goal, { success: true })
      monitorBus.emitMonitor('orchestrator:goalCompleted', {
        goal: recovery.goal,
        source: 'recovery',
      })
    }
    catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.recordGoalFailure(recovery.goal, errorMessage)
      this.bot.memory?.completeGoal?.(recovery.goal, { success: false, reason: errorMessage })
      monitorBus.emitMonitor('orchestrator:goalFailed', {
        goal: recovery.goal,
        error: errorMessage,
        source: 'recovery',
      })
      this.logger.withError(error).warn('Deterministic recovery plan failed')
    }
    finally {
      this.pendingRecoveryPlan = null
      this.executing = false
      this.executingStartedAt = 0
      this.activeGoal = null
      this.activeGoalStartedAt = 0
    }
  }

  private async executeGoal(goal: string, reason?: string): Promise<void> {
    this.executing = true
    this.executingStartedAt = Date.now()
    this.lastGoalAt = Date.now()
    this.activeGoal = goal
    this.activeGoalStartedAt = Date.now()
    this.bot.memory?.activateGoal?.(goal, this.buildProgressionSnapshotSafe()?.currentMilestone)

    monitorBus.emitMonitor('orchestrator:goalSelected', { goal, reason: reason || '', source: 'autonomy' })
    this.emitSpark('working', `Autonomy started goal: ${goal}${reason ? ` (${reason})` : ''}`)
    void this.announceGoal(goal)
    this.startGoalCommentary(goal)

    try {
      await withSharedPlanLock(this.bot.username, 'autonomy', this.logger as any, async () => {
        this.logger.withFields({ goal, reason }).log('Autonomy executing planner-backed goal')
        const plan = await this.bot.planning.createPlan(goal)
        await this.bot.planning.executePlan(plan)
      })

      this.pushSignal({
        id: randomUUID(),
        source: 'system',
        author: 'autonomy',
        text: `goal-result:success:${goal}`,
        importance: 0.7,
        timestamp: Date.now(),
      })
      this.emitSpark('done', `Autonomy completed goal: ${goal}`)
      monitorBus.emitMonitor('orchestrator:goalCompleted', { goal })
      getActiveEmotionEngine()?.impulse('goal-success')
      this.consecutiveGoalFailures = 0
      this.recordGoalSuccess(goal)
      this.bot.memory?.completeGoal?.(goal, { success: true })
      this.scheduleGoalResultCommentary(goal, true)
    }
    catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (error instanceof ActionAbortedError) {
        // Interruptions (reflexes, watchdogs, supersession) are not planning
        // failures: do not trip the circuit breaker or queue recovery.
        this.logger.withFields({ goal, reason: error.reason }).warn('Autonomy goal interrupted')
        this.pushSignal({
          id: randomUUID(),
          source: 'system',
          author: 'autonomy',
          text: `goal-result:interrupted:${goal}`,
          importance: 0.5,
          timestamp: Date.now(),
        })
        monitorBus.emitMonitor('orchestrator:goalFailed', { goal, error: errorMessage, interrupted: true })
        this.bot.memory?.completeGoal?.(goal, { success: false, reason: `interrupted: ${error.reason}` })
        return
      }
      const normalizedErrorMessage = normalizeRecoverableGoalErrorMessage(errorMessage)
      this.consecutiveGoalFailures++
      this.lastGoalFailureAt = Date.now()
      this.recordGoalFailure(goal, errorMessage)
      getActiveEmotionEngine()?.impulse('goal-failure')
      if (this.consecutiveGoalFailures >= 2) {
        try {
          const facts = collectWorldFacts(this.bot)
          this.lessons?.record({
            trigger: 'goal-failure',
            fact: `Goal "${goal}" keeps failing: ${errorMessage.slice(0, 140)}`,
            milestone: this.buildProgressionSnapshotSafe()?.currentMilestone ?? 'unknown',
            dimension: facts.dimension,
          })
        }
        catch {
          /* lesson recording must never break goal handling */
        }
      }
      this.activateRecoveryBackpressure()
      if (
        normalizedErrorMessage.includes('unknown command')
        || normalizedErrorMessage.includes('unsupported_capability')
        || normalizedErrorMessage.includes('bridge command unsupported')
        || normalizedErrorMessage.includes('movement_stall')
        || normalizedErrorMessage.includes('coordinate_stall')
        || normalizedErrorMessage.includes('stuck-recovery')
      ) {
        this.queueDeterministicRecovery(errorMessage, Date.now())
      }
      this.pushSignal({
        id: randomUUID(),
        source: 'system',
        author: 'autonomy',
        text: `goal-result:failed:${goal}`,
        importance: 0.6,
        timestamp: Date.now(),
      })
      this.emitSpark('blocked', `Autonomy failed goal: ${goal}`)
      monitorBus.emitMonitor('orchestrator:goalFailed', { goal, error: errorMessage })
      if (isRecoverableGoalExecutionFailure(errorMessage)) {
        this.logger.withError(error).warn('Autonomy goal execution failed (recoverable)')
      }
      else {
        this.logger.withError(error).error('Autonomy goal execution failed')
      }
      this.bot.memory?.completeGoal?.(goal, { success: false, reason: errorMessage })
      this.scheduleGoalResultCommentary(goal, false)
    }
    finally {
      this.stopGoalCommentary()
      this.executing = false
      this.executingStartedAt = 0
      // Goal lock should protect in-flight execution only. After completion/failure,
      // release active goal immediately so next tick can schedule follow-up work.
      this.activeGoal = null
      this.activeGoalStartedAt = 0
      const now = Date.now()
      this.signalBuffer = this.signalBuffer
        .filter(signal => Date.now() - signal.timestamp < 5 * 60_000)
        .slice(-80)

      const hasPendingSocialSignal = this.signalBuffer.some(signal =>
        (signal.source === 'player' || signal.source === 'youtube')
        && now - signal.timestamp <= SOCIAL_SIGNAL_CANDIDATE_WINDOW_MS,
      )
      if (hasPendingSocialSignal) {
        setTimeout(() => {
          void this.tick()
        }, 0)
      }
    }
  }

  private emitSpark(state: 'queued' | 'working' | 'done' | 'dropped' | 'blocked' | 'expired', note: string): void {
    try {
      this.airiClient.send({
        type: 'spark:emit',
        data: {
          id: randomUUID(),
          eventId: randomUUID(),
          state,
          note,
          destinations: describeSparkDestinations(),
          metadata: {
            from: 'minecraft-bot',
          },
        },
      })
    }
    catch (error) {
      this.logger.withError(error).warn('Failed to emit spark:emit event')
    }
  }

  private async announceGoal(goal: string): Promise<void> {
    const now = Date.now()
    if (this.lastAnnouncedGoal === goal && now - this.lastGoalAnnouncementAt < GOAL_REPEAT_ANNOUNCEMENT_COOLDOWN_MS) {
      return
    }
    if (now - this.lastGoalAnnouncementAt < GOAL_ANNOUNCEMENT_COOLDOWN_MS) {
      return
    }
    if (!this.canEnqueueSpeech(false)) {
      this.logger.withField('goal', goal.slice(0, 60)).log('Speech queue full, skipping goal announcement')
      return
    }

    const goalLabel = this.toGoalLabel(goal)
    const internalMemo = [
      `goal=${goalLabel}`,
      'phase=goal-announcement',
      'priority=high',
    ].join(' | ')

    const message = await this.generateSpeechWithLane(
      goal,
      'goal-announcement',
      internalMemo,
      {
        mode: 'default',
        maxAttempts: 2,
        skipRescue: true,
      },
      {
        priority: 'background',
        dropIfBusy: true,
      },
    )
    if (!message) {
      this.reportSpeechSkip(
        'autonomy.goal-announcement',
        'Skipped goal announcement because GPT public speech was empty.',
        goal,
      )
      return
    }
    const finalMessage = message

    this.logger.withField('message', finalMessage).log('Autonomy speaking')
    this.rememberPublicSpeech(finalMessage, now, 'game')
    this.bot.bot.chat(finalMessage)
    this.noteVoiceRequested(now)
    publishAssistantMessageToAiri(this.airiClient, finalMessage, this.logger as any, {
      voiceMode: 'on',
      voicePriority: 'low',
      onVoiceAttached: ({ estimatedEndAt }) => this.noteVoiceAttached(estimatedEndAt),
      onPlaybackStart: () => this.updateCurrentReplyContext(finalMessage),
    })
    this.trackSpeechItem(finalMessage, false)
    this.lastGoalChatCommentaryAt = now
    this.lastGoalAnnouncementAt = now
    this.lastAnnouncedGoal = goal
  }

  private startGoalCommentary(goal: string): void {
    this.stopGoalCommentary()
    this.goalCommentaryTick = 0

    this.goalCommentaryTimer = setInterval(() => {
      void this.emitGoalProgressCommentary(goal)
    }, GOAL_COMMENTARY_INTERVAL_MS)
  }

  private stopGoalCommentary(): void {
    if (this.goalCommentaryTimer) {
      clearInterval(this.goalCommentaryTimer)
      this.goalCommentaryTimer = null
    }
  }

  private async emitGoalProgressCommentary(goal: string): Promise<void> {
    if (!this.started || !this.executing || !this.activeGoal) {
      return
    }
    if (this.activeGoal !== goal) {
      return
    }
    if (this.shouldDeferLowPrioritySpeech()) {
      return
    }

    const currentAction = this.bot.memory.actions.at(-1)?.name || 'move'
    const position = String(this.bot.status.position || 'position unknown')
    const health = String(this.bot.status.health || 'unknown')
    const goalLabel = this.toGoalLabel(goal)
    const actionLabel = this.toActionLabel(currentAction)
    const actionObstacle = this.describeActionObstacle(currentAction)
    const progression = this.buildProgressionSnapshotSafe()

    // Compute delta from last commentary snapshot
    const currentSnapshot = { position, action: currentAction, health }
    const changedParts: string[] = []
    if (this.lastCommentarySnapshot) {
      if (this.lastCommentarySnapshot.action !== currentSnapshot.action)
        changedParts.push(`action: ${this.toActionLabel(this.lastCommentarySnapshot.action)}鬯ｯ・ｩ陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｶ鬯ｩ諤憺●繝ｻ・ｽ繝ｻ・ｫ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ{actionLabel}`)
      if (this.lastCommentarySnapshot.position !== currentSnapshot.position)
        changedParts.push('position moved')
      if (this.lastCommentarySnapshot.health !== currentSnapshot.health)
        changedParts.push(`health: ${this.lastCommentarySnapshot.health}鬯ｯ・ｩ陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｶ鬯ｩ諤憺●繝ｻ・ｽ繝ｻ・ｫ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ{health}`)
    }
    this.lastCommentarySnapshot = currentSnapshot

    const internalMemo = [
      `goal=${goalLabel}`,
      `action=${actionLabel}`,
      `obstacle=${actionObstacle}`,
      `position=${position}`,
      `health=${health}`,
      ...this.buildProgressionMemoLines(progression),
      `changed_since_last: ${changedParts.length > 0 ? changedParts.join(', ') : 'none'}`,
    ].join(' | ')

    const deterministic = this.buildLowVramNarrationDecision({
      goalLabel,
      actionLabel,
      obstacle: actionObstacle,
      changedParts,
      reason: `periodic-progress:${actionLabel}`,
      allowKeepalive: changedParts.length === 0,
    })
    if (deterministic) {
      this.goalCommentaryTick++
      this.recordNarrationDecision(deterministic)
      if (!deterministic.text) {
        return
      }
      this.speakCommentary(deterministic.text)
      return
    }

    const llmMessage = await this.generateSpeechWithLane(
      goal,
      `periodic-progress:${actionLabel}`,
      internalMemo,
      {
        mode: 'periodic-progress',
        maxAttempts: 1,
        skipRescue: false,
      },
      {
        priority: 'background',
        coalesceKey: `speech:progress:${goalLabel}:${actionLabel}`,
        dropIfBusy: true,
      },
    )
    if (!llmMessage) {
      this.goalCommentaryTick++
      this.reportSpeechSkip(
        'autonomy.goal-progress-commentary',
        'Skipped progress commentary because GPT public speech was empty.',
        goal,
      )
      return
    }

    this.goalCommentaryTick++
    this.speakCommentary(llmMessage)
  }

  private async emitGoalResultCommentary(goal: string, success: boolean): Promise<void> {
    if (this.shouldDeferLowPrioritySpeech()) {
      return
    }

    const goalLabel = this.toGoalLabel(goal)
    const progression = this.buildProgressionSnapshotSafe()
    const internalMemo = [
      `goal=${goalLabel}`,
      `result=${success ? 'success' : 'failed'}`,
      'phase=goal-result',
      ...this.buildProgressionMemoLines(progression),
    ].join(' | ')

    const deterministic = this.buildLowVramNarrationDecision({
      goalLabel,
      actionLabel: success ? '完了' : '失敗',
      obstacle: success ? 'none' : 'goal-failed',
      changedParts: [success ? 'goal result success' : 'goal result failed'],
      reason: success ? 'goal-result-success' : 'goal-result-failed',
      allowKeepalive: false,
    })
    if (deterministic) {
      this.recordNarrationDecision(deterministic)
      if (!deterministic.text) {
        return
      }
      this.speakCommentary(deterministic.text)
      return
    }

    const llmMessage = await this.generateSpeechWithLane(
      goal,
      success ? 'goal-result-success' : 'goal-result-failed',
      internalMemo,
      {
        mode: 'default',
        maxAttempts: 2,
        skipRescue: true,
      },
      {
        priority: 'background',
        coalesceKey: `speech:goal-result:${goalLabel}:${success ? 'success' : 'failed'}`,
        dropIfBusy: true,
      },
    )
    if (!llmMessage) {
      this.reportSpeechSkip(
        'autonomy.goal-result-commentary',
        'Skipped goal result commentary because GPT public speech was empty.',
        goal,
      )
      return
    }
    this.speakCommentary(llmMessage)
  }

  private makeCommentarySignature(message: string): string {
    return message
      .toLowerCase()
      .replace(/x:\s*-?\d+(\.\d+)?/g, 'x:#')
      .replace(/y:\s*-?\d+(\.\d+)?/g, 'y:#')
      .replace(/z:\s*-?\d+(\.\d+)?/g, 'z:#')
      .replace(/\b\d+(\.\d+)?\b/g, '#')
      .replace(/"[^"]+"/g, '"#"')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private toGoalLabel(goal: string): string {
    const normalized = goal.trim().toLowerCase()
    if (normalized.includes('craft a crafting table and wooden pickaxe')) {
      return '\u4F5C\u696D\u53F0\u3068\u6728\u306E\u30C4\u30EB\u30CF\u30B7'
    }
    if (normalized.includes('gather wood and craft a crafting table')) {
      return '\u6728\u6750\u3068\u4F5C\u696D\u53F0'
    }
    if (normalized.includes('craft a crafting table')) {
      return '\u4F5C\u696D\u53F0'
    }
    if (normalized.includes('gather 4 logs')) {
      return '\u539F\u6728\u56DB\u672C'
    }
    if (normalized.includes('craft a wooden pickaxe')) {
      return '\u6728\u306E\u30C4\u30EB\u30CF\u30B7'
    }
    if (normalized.includes('craft a stone pickaxe')) {
      return '\u77F3\u306E\u30C4\u30EB\u30CF\u30B7'
    }
    if (normalized.includes('collect nearby food')) {
      return '\u98DF\u6599\u78BA\u4FDD'
    }
    if (normalized.includes('consume available food')) {
      return '\u98DF\u4E8B\u3068\u56DE\u5FA9'
    }
    if (normalized.includes('mine 16 cobblestone')) {
      return '\u4E38\u77F3\u5341\u516D'
    }
    if (normalized.includes('mine iron ore')) {
      return '\u9244\u925B\u77F3'
    }
    if (normalized.includes('smelt raw iron into iron ingots')) {
      return '\u9244\u30A4\u30F3\u30B4\u30C3\u30C8'
    }
    if (normalized.includes('relocate')) {
      return '\u62E0\u70B9\u79FB\u8EE2'
    }
    if (normalized.includes('cobblestone') || (normalized.includes('mine') && normalized.includes('stone'))) {
      return '\u77F3\u6750\u63A1\u6398'
    }
    if (normalized.includes('gather wood')) {
      return '\u6728\u6750\u53CE\u96C6'
    }
    if (normalized.includes('collect food')) {
      return '\u98DF\u6599\u53CE\u96C6'
    }
    if (normalized.includes('improve safety')) {
      return '\u5B89\u5168\u78BA\u4FDD'
    }
    if (normalized.includes('explore nearby terrain') || normalized.includes('explore')) {
      return '\u63A2\u7D22'
    }
    return goal.trim() || '\u73FE\u5728\u306E\u76EE\u6A19'
  }

  private toActionLabel(action: string): string {
    const normalized = action.trim().toLowerCase()
    if (!normalized) {
      return '\u884C\u52D5'
    }
    const map: Record<string, string> = {
      move: '\u79FB\u52D5',
      searchforblock: '\u30D6\u30ED\u30C3\u30AF\u63A2\u7D22',
      collectblocks: '\u56DE\u53CE',
      nearbyblocks: '\u5468\u8FBA\u30D6\u30ED\u30C3\u30AF\u78BA\u8A8D',
      entities: '\u30A8\u30F3\u30C6\u30A3\u30C6\u30A3\u78BA\u8A8D',
      inventory: '\u6240\u6301\u54C1\u78BA\u8A8D',
      craftrecipe: '\u30AF\u30E9\u30D5\u30C8',
      consume: '\u98DF\u4E8B',
      attack: '\u6226\u95D8',
      followplayer: '\u8FFD\u5F93',
      moveaway: '\u96E2\u8131',
      placehere: '\u8A2D\u7F6E',
      gotocoordinates: '\u79FB\u52D5',
      goto: '\u79FB\u52D5',
      searchforentity: '\u5BFE\u8C61\u63A2\u7D22',
      pickupitem: '\u62FE\u53D6',
      equip: '\u88C5\u5099',
      stats: '\u72B6\u614B\u78BA\u8A8D',
    }
    return map[normalized] || '\u884C\u52D5'
  }

  private describeGoalNeed(goal: string): string {
    const normalized = goal.trim().toLowerCase()
    if (normalized.includes('relocate')) {
      return '\u6B21\u306E\u62E0\u70B9\u3078\u79FB\u52D5\u3059\u308B'
    }
    if (normalized.includes('cobblestone') || (normalized.includes('mine') && normalized.includes('stone'))) {
      return '\u77F3\u6750\u3092\u63A1\u308A\u9053\u5177\u3092\u9032\u3081\u308B'
    }
    if (normalized.includes('food')) {
      return '\u98DF\u6599\u3092\u78BA\u4FDD\u3057\u3066\u5B89\u5B9A\u3059\u308B'
    }
    if (normalized.includes('safety')) {
      return '\u5468\u56F2\u306E\u5B89\u5168\u3092\u6574\u3048\u308B'
    }
    if (normalized.includes('explore')) {
      return '\u5730\u5F62\u3068\u8CC7\u6E90\u3092\u8ABF\u3079\u308B'
    }
    if (normalized.includes('gather wood') || normalized.includes('craft')) {
      return '\u6728\u6750\u3068\u57FA\u790E\u88C5\u5099\u3092\u63C3\u3048\u308B'
    }
    if (normalized.includes('stone')) {
      return '\u77F3\u6750\u3092\u63A1\u308A\u88C5\u5099\u3092\u9032\u3081\u308B'
    }
    return '\u6B21\u306E\u76EE\u6A19\u3092\u9032\u3081\u308B'
  }

  private describeActionObstacle(action: string): string {
    const normalized = action.trim().toLowerCase()
    switch (normalized) {
      case 'searchforblock':
      case 'searchforentity':
        return 'target not reliably detected yet'
      case 'collectblocks':
        return 'collection route keeps failing'
      case 'craftrecipe':
        return 'materials or craft context is unstable'
      case 'move':
      case 'moveaway':
        return 'movement keeps getting interrupted'
      case 'attack':
        return 'combat pressure is still high'
      default:
        return 'state is still unstable'
    }
  }

  private extractTrigrams(text: string): Set<string> {
    const trigrams = new Set<string>()
    for (let i = 0; i <= text.length - 3; i++) {
      trigrams.add(text.slice(i, i + 3))
    }
    return trigrams
  }

  private trigramOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0)
      return 0
    let intersection = 0
    for (const trigram of a) {
      if (b.has(trigram))
        intersection++
    }
    const union = a.size + b.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  private shouldPublishCommentaryToAiri(normalized: string, now: number): boolean {
    if (now - this.lastAiriCommentaryAt < Math.max(1_000, config.autonomy.narrationMinIntervalMs || AIRI_COMMENTARY_MIN_INTERVAL_MS)) {
      return false
    }

    const signature = this.makeCommentarySignature(normalized)
    const trigrams = this.extractTrigrams(signature)

    // Prune entries older than the duplicate window
    this.recentCommentarySignatures = this.recentCommentarySignatures
      .filter(entry => now - entry.at <= AIRI_COMMENTARY_DUPLICATE_WINDOW_MS)
      .slice(-20)

    // Check exact signature match against any entry in the window
    if (this.recentCommentarySignatures.some(entry => entry.signature === signature)) {
      return false
    }

    // Check trigram overlap against last 5 entries
    const recentEntries = this.recentCommentarySignatures.slice(-5)
    if (recentEntries.some(entry => this.trigramOverlap(trigrams, entry.trigrams) > 0.6)) {
      return false
    }

    this.lastAiriCommentaryAt = now
    this.recentCommentarySignatures.push({ signature, trigrams, at: now })
    return true
  }

  private prunePendingSpeech(now: number): void {
    this.pendingSpeechItems = this.pendingSpeechItems.filter(item => item.estimatedDoneAt > now)
  }

  private canEnqueueSpeech(isSocialReply: boolean): boolean {
    if (isSocialReply)
      return true
    const now = Date.now()
    this.prunePendingSpeech(now)
    return this.pendingSpeechItems.length < SPEECH_QUEUE_MAX_PENDING
  }

  private getLowPrioritySpeechDeferralReason(now = Date.now()): string | null {
    this.prunePendingSpeech(now)

    if (now < this.criticalRecoveryUntil) {
      return 'recovery_backpressure'
    }

    const pendingNonSocialSpeechCount = this.pendingSpeechItems.filter(item => !item.isSocialReply).length
    if (pendingNonSocialSpeechCount >= LOW_PRIORITY_SPEECH_MAX_PENDING) {
      return 'speech_queue_backlog'
    }

    if (now - this.lastVoiceRequestAt < LOW_PRIORITY_SPEECH_AFTER_REQUEST_GAP_MS) {
      return 'voice_request_cooldown'
    }

    if (this.lastEstimatedVoiceEndAt > 0 && now < this.lastEstimatedVoiceEndAt + LOW_PRIORITY_SPEECH_AFTER_VOICE_END_GAP_MS) {
      return 'voice_playback_cooldown'
    }

    return null
  }

  private shouldDeferLowPrioritySpeech(now = Date.now()): boolean {
    return this.getLowPrioritySpeechDeferralReason(now) !== null
  }

  private trackSpeechItem(text: string, isSocialReply: boolean): void {
    const now = Date.now()
    this.prunePendingSpeech(now)
    const charCount = text.replace(/\s+/g, '').length
    const estimatedDuration = Math.max(SPEECH_ITEM_ESTIMATED_DURATION_MS, charCount * 150)
    const lastDoneAt = this.pendingSpeechItems.length > 0
      ? Math.max(...this.pendingSpeechItems.map(item => item.estimatedDoneAt))
      : now
    const startAt = Math.max(now, lastDoneAt)
    this.pendingSpeechItems.push({
      estimatedDoneAt: startAt + estimatedDuration,
      isSocialReply,
    })
  }

  private noteVoiceRequested(at = Date.now()): void {
    this.lastVoiceRequestAt = Math.max(this.lastVoiceRequestAt, at)
  }

  private noteVoiceAttached(estimatedEndAt: number): void {
    this.lastEstimatedVoiceEndAt = Math.max(this.lastEstimatedVoiceEndAt, estimatedEndAt)
  }

  private getLastVoicedActivityAt(): number {
    return Math.max(
      this.lastEstimatedVoiceEndAt,
      this.lastVoiceRequestAt,
      this.lastGoalAt,
    )
  }

  private shouldEmitVoicedKeepAlive(now: number): boolean {
    if (!this.started) {
      return false
    }
    const lastVoicedActivityAt = this.getLastVoicedActivityAt()
    if (lastVoicedActivityAt <= 0) {
      return false
    }
    if (now - this.lastVoiceRequestAt < VOICED_KEEPALIVE_REQUEST_GRACE_MS) {
      return false
    }
    if (now - this.lastVoicedKeepAliveAttemptAt < VOICED_KEEPALIVE_ATTEMPT_COOLDOWN_MS) {
      return false
    }
    if (this.shouldDeferLowPrioritySpeech(now)) {
      return false
    }
    if (!this.canEnqueueSpeech(false)) {
      return false
    }
    return now - lastVoicedActivityAt >= VOICED_KEEPALIVE_TRIGGER_AFTER_MS
  }

  private async emitVoicedKeepAliveIfNeeded(now: number): Promise<void> {
    if (!this.shouldEmitVoicedKeepAlive(now)) {
      return
    }

    this.lastVoicedKeepAliveAttemptAt = now

    const goal = this.activeGoal || this.lastAnnouncedGoal || undefined
    const currentAction = this.bot.memory.actions.at(-1)?.name || 'move'
    const position = String(this.bot.status.position || 'position unknown')
    const health = String(this.bot.status.health || 'unknown')
    const actionLabel = this.toActionLabel(currentAction)
    const actionObstacle = this.describeActionObstacle(currentAction)
    const mode = this.executing ? 'periodic-progress' : 'periodic-idle'
    const progression = this.buildProgressionSnapshotSafe()
    const internalMemo = [
      `goal=${goal ? this.toGoalLabel(goal) : 'goal-unspecified'}`,
      `action=${actionLabel}`,
      `obstacle=${actionObstacle}`,
      `position=${position}`,
      `health=${health}`,
      ...this.buildProgressionMemoLines(progression),
      'phase=voiced-keepalive',
      `silence_ms=${Math.max(0, now - this.lastEstimatedVoiceEndAt)}`,
    ].join(' | ')

    const deterministic = this.buildLowVramNarrationDecision({
      goalLabel: goal ? this.toGoalLabel(goal) : '現在の目標',
      actionLabel,
      obstacle: actionObstacle,
      changedParts: [],
      reason: 'voiced-keepalive',
      allowKeepalive: true,
    })
    if (deterministic) {
      this.recordNarrationDecision(deterministic, now)
      if (!deterministic.text) {
        return
      }
      const normalizedDeterministic = deterministic.text.replace(/\s+/g, ' ').trim().slice(0, 120)
      this.logger.withFields({
        message: normalizedDeterministic,
        executing: this.executing,
        silentForMs: Math.max(0, now - this.getLastVoicedActivityAt()),
      }).log('Autonomy voiced keepalive')
      this.rememberPublicSpeech(normalizedDeterministic, now, 'game')
      this.noteVoiceRequested(now)
      publishAssistantMessageToAiri(this.airiClient, normalizedDeterministic, this.logger as any, {
        voiceMode: 'on',
        voicePriority: 'low',
        onVoiceAttached: ({ estimatedEndAt }) => this.noteVoiceAttached(estimatedEndAt),
        onPlaybackStart: () => this.updateCurrentReplyContext(normalizedDeterministic),
      })
      this.trackSpeechItem(normalizedDeterministic, false)
      this.lastOutwardSpeakAt = now
      return
    }

    const llmMessage = await this.generateSpeechWithLane(
      goal,
      'voiced-keepalive',
      internalMemo,
      {
        mode,
        maxAttempts: 1,
        skipRescue: false,
      },
      {
        priority: 'background',
        coalesceKey: `speech:keepalive:${goal ? this.toGoalLabel(goal) : 'none'}:${actionLabel}`,
        dropIfBusy: false,
      },
    )
    if (!llmMessage) {
      this.reportSpeechSkip(
        'autonomy.voiced-keepalive',
        'Skipped voiced keepalive because GPT public speech was empty.',
        goal,
      )
      return
    }

    const normalized = llmMessage.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!normalized) {
      return
    }

    this.logger.withFields({
      message: normalized,
      executing: this.executing,
      silentForMs: Math.max(0, now - this.getLastVoicedActivityAt()),
    }).log('Autonomy voiced keepalive')
    this.rememberPublicSpeech(normalized, now, 'game')
    this.noteVoiceRequested(now)
    publishAssistantMessageToAiri(this.airiClient, normalized, this.logger as any, {
      voiceMode: 'on',
      voicePriority: 'low',
      onVoiceAttached: ({ estimatedEndAt }) => this.noteVoiceAttached(estimatedEndAt),
      onPlaybackStart: () => this.updateCurrentReplyContext(normalized),
    })
    this.trackSpeechItem(normalized, false)
    this.lastOutwardSpeakAt = now
  }

  private speakCommentary(message: string): void {
    const deferralReason = this.getLowPrioritySpeechDeferralReason()
    if (deferralReason) {
      this.logger.withFields({
        message: message.slice(0, 60),
        speech_dropped_reason: deferralReason,
      }).log('Low-priority commentary deferred')
      return
    }
    if (!this.canEnqueueSpeech(false)) {
      this.logger.withField('message', message.slice(0, 60)).log('Speech queue full, skipping commentary')
      return
    }

    const now = Date.now()
    const normalized = message.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!normalized) {
      return
    }

    this.logger.withField('message', normalized).log('Autonomy commentary')
    this.rememberPublicSpeech(normalized, now, 'game')
    if (this.shouldPublishCommentaryToAiri(normalized, now)) {
      this.noteVoiceRequested(now)
      publishAssistantMessageToAiri(this.airiClient, normalized, this.logger as any, {
        voiceMode: 'on',
        voicePriority: 'low',
        onVoiceAttached: ({ estimatedEndAt }) => this.noteVoiceAttached(estimatedEndAt),
        onPlaybackStart: () => this.updateCurrentReplyContext(normalized),
      })
      this.trackSpeechItem(normalized, false)
    }
    else {
      this.logger.log('Autonomy commentary suppressed by cooldown/dedupe')
      this.updateCurrentReplyContext(normalized)
    }

    if (now - this.lastGoalChatCommentaryAt >= GOAL_COMMENTARY_CHAT_COOLDOWN_MS) {
      this.bot.bot.chat(normalized)
      this.lastGoalChatCommentaryAt = now
    }
  }

  private async emitAmbientChatIfNeeded(now: number): Promise<void> {
    if (!this.started || this.executing) {
      return
    }
    if (this.shouldDeferLowPrioritySpeech(now)) {
      return
    }

    const nearbyPlayers = Object.entries(this.bot.bot.players)
      .filter(([name, player]) => name !== this.bot.username && !!player?.entity)
      .map(([name]) => name)

    const activeGoal = this.activeGoal || 'current objective'
    const recentAction = this.bot.memory.actions.at(-1)?.name || 'move'
    const goalNeed = this.describeGoalNeed(activeGoal)
    const actionObstacle = this.describeActionObstacle(recentAction)
    const recentActionLabel = this.toActionLabel(recentAction)
    const progression = this.buildProgressionSnapshotSafe()

    if (nearbyPlayers.length > 0 && now - this.lastAmbientSocialChatAt >= AMBIENT_SOCIAL_CHAT_INTERVAL_MS) {
      const player = nearbyPlayers[0]
      const socialMemo = [
        `player=${player}`,
        `goal=${this.toGoalLabel(activeGoal)}`,
        `need=${goalNeed}`,
        `action=${recentActionLabel}`,
        ...this.buildProgressionMemoLines(progression),
        'tone=co-op',
      ].join(' | ')
      const llmMessage = await this.generateSpeechWithLane(
        activeGoal,
        'periodic-idle-social',
        socialMemo,
        {
          mode: 'periodic-idle',
          maxAttempts: 2,
          skipRescue: true,
        },
        {
          priority: 'background',
          coalesceKey: `speech:ambient-social:${player}:${recentActionLabel}`,
          dropIfBusy: true,
        },
      )
      if (!llmMessage) {
        this.reportSpeechSkip(
          'autonomy.ambient-social',
          'Skipped ambient social chat because GPT public speech was empty.',
          activeGoal,
        )
        return
      }
      this.publishAmbientChat(llmMessage, true)
      this.lastAmbientSocialChatAt = now
      return
    }

    if (now - this.lastAmbientStreamChatAt >= AMBIENT_STREAM_CHAT_INTERVAL_MS) {
      const idleMemo = [
        `goal=${this.toGoalLabel(activeGoal)}`,
        `need=${goalNeed}`,
        `action=${recentActionLabel}`,
        `obstacle=${actionObstacle}`,
        ...this.buildProgressionMemoLines(progression),
        'tone=stream-idle',
      ].join(' | ')
      const deterministic = this.buildLowVramNarrationDecision({
        goalLabel: this.toGoalLabel(activeGoal),
        actionLabel: recentActionLabel,
        obstacle: actionObstacle,
        changedParts: [],
        reason: 'periodic-idle-stream',
        allowKeepalive: true,
      })
      if (deterministic) {
        this.recordNarrationDecision(deterministic, now)
        if (!deterministic.text) {
          return
        }
        this.publishAmbientChat(deterministic.text, false)
        this.lastAmbientStreamChatAt = now
        return
      }

      const llmMessage = await this.generateSpeechWithLane(
        activeGoal,
        'periodic-idle-stream',
        idleMemo,
        {
          mode: 'periodic-idle',
          maxAttempts: 2,
          skipRescue: true,
        },
        {
          priority: 'background',
          coalesceKey: `speech:ambient-stream:${this.toGoalLabel(activeGoal)}:${recentActionLabel}`,
          dropIfBusy: true,
        },
      )
      if (!llmMessage) {
        this.reportSpeechSkip(
          'autonomy.ambient-stream',
          'Skipped ambient stream chat because GPT public speech was empty.',
          activeGoal,
        )
        return
      }
      this.publishAmbientChat(llmMessage, false)
      this.lastAmbientStreamChatAt = now
    }
  }

  private publishAmbientChat(message: string, sendMinecraftChat: boolean): void {
    const deferralReason = this.getLowPrioritySpeechDeferralReason()
    if (deferralReason) {
      this.logger.withFields({
        message: message.slice(0, 60),
        speech_dropped_reason: deferralReason,
      }).log('Low-priority ambient chat deferred')
      return
    }
    if (!this.canEnqueueSpeech(false)) {
      this.logger.withField('message', message.slice(0, 60)).log('Speech queue full, skipping ambient chat')
      return
    }

    const now = Date.now()
    const normalized = message.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!normalized) {
      return
    }

    this.logger.withField('message', normalized).log('Autonomy ambient chat')
    this.rememberPublicSpeech(normalized, now, 'game')
    if (this.shouldPublishCommentaryToAiri(normalized, now)) {
      this.noteVoiceRequested(now)
      publishAssistantMessageToAiri(this.airiClient, normalized, this.logger as any, {
        voiceMode: 'on',
        voicePriority: 'low',
        onVoiceAttached: ({ estimatedEndAt }) => this.noteVoiceAttached(estimatedEndAt),
        onPlaybackStart: () => this.updateCurrentReplyContext(normalized),
      })
      this.trackSpeechItem(normalized, false)
    }
    else {
      this.logger.log('Autonomy ambient chat suppressed by cooldown/dedupe')
      this.updateCurrentReplyContext(normalized)
    }

    if (!sendMinecraftChat) {
      return
    }

    if (now - this.lastGoalChatCommentaryAt >= GOAL_COMMENTARY_CHAT_COOLDOWN_MS) {
      this.bot.bot.chat(normalized)
      this.lastGoalChatCommentaryAt = now
    }
  }

  private updateCurrentReplyContext(speechText: string, replyToCommentId?: string): void {
    this.currentReplyContext = {
      speechText,
      replyToCommentId: replyToCommentId || '',
      updatedAt: Date.now(),
    }
    void this.writeYouTubeRecentCommentsOverlaySnapshot()
  }

  private async writeYouTubeRecentCommentsOverlaySnapshot(): Promise<void> {
    if (!config.youtube.commentOverlayRecentEnabled) {
      return
    }

    const filePath = config.youtube.commentOverlayRecentFilePath.trim()
    if (!filePath) {
      return
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      comments: this.recentYouTubeCommentsOverlay,
      currentReply: this.currentReplyContext
        ? {
            speechText: this.currentReplyContext.speechText,
            replyToCommentId: this.currentReplyContext.replyToCommentId,
            updatedAt: new Date(this.currentReplyContext.updatedAt).toISOString(),
          }
        : null,
    }

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8')
    }
    catch (error) {
      const now = Date.now()
      if (now - this.lastYouTubeOverlayWriteErrorAt >= YOUTUBE_COMMENT_OVERLAY_WRITE_ERROR_LOG_INTERVAL_MS) {
        this.logger.withFields({ filePath }).withError(error).warn('Failed to write YouTube recent comments overlay snapshot')
        this.lastYouTubeOverlayWriteErrorAt = now
      }
    }
  }

  private pushSignal(signal: AutonomySignal): void {
    this.signalBuffer.push(signal)
    if (this.signalBuffer.length > 200) {
      this.signalBuffer = this.signalBuffer.slice(-200)
    }
  }

  private ingestYouTubeMessages(): void {
    const messages = this.youtubeBridge.drain(5)
    if (messages.length === 0) {
      return
    }

    // Prune youtubeMessageIndex to prevent unbounded growth
    if (this.youtubeMessageIndex.size > 2000) {
      const entries = [...this.youtubeMessageIndex.entries()]
      this.youtubeMessageIndex = new Map(entries.slice(-1000))
    }

    this.logger.withField('count', messages.length).log('YouTube chat messages ingested')
    for (const message of messages) {
      if (this.youtubeMessageIndex.has(message.id)) {
        this.logger.withField('messageId', message.id).log('Duplicate YouTube message id skipped')
        continue
      }

      const now = Date.now()
      if (!this.shouldAcceptSocialSignal('youtube', message.author, message.text, now)) {
        this.youtubeMessageIndex.set(message.id, message)
        void this.writeYouTubeCommentOverlay(message)
        void this.writeYouTubeRecentCommentsOverlay(message)
        this.logger.withFields({
          source: 'youtube',
          author: message.author,
          messageId: message.id,
        }).log('Duplicate social signal skipped')
        continue
      }

      const directMention = message.text.toLowerCase().includes(this.bot.username.toLowerCase())
      const weightedImportance = clampImportance(
        Math.max(
          (directMention ? 0.75 : 0.45) * config.autonomy.commentWeight,
          directMention ? 0.92 : 0.78,
        ),
      )

      this.youtubeMessageIndex.set(message.id, message)
      this.pushSignal({
        id: message.id,
        source: 'youtube',
        author: message.author,
        text: message.text,
        importance: weightedImportance,
        timestamp: Date.parse(message.publishedAt) || now,
      })
      void this.writeYouTubeCommentOverlay(message)
      void this.writeYouTubeRecentCommentsOverlay(message)
    }
  }

  private clampPositiveInt(value: number, fallback: number): number {
    if (!Number.isFinite(value)) {
      return fallback
    }
    const normalized = Math.trunc(value)
    return normalized > 0 ? normalized : fallback
  }

  private buildSocialSignalSignature(
    source: 'player' | 'youtube',
    author: string,
    text: string,
  ): string {
    const normalizedAuthor = author.trim().toLowerCase().replace(/^@/, '')
    const normalizedText = text
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/["'`()[\],.!?:;]+/g, '')
      .slice(0, 120)
    return `${source}|${normalizedAuthor}|${normalizedText}`
  }

  private shouldAcceptSocialSignal(
    source: 'player' | 'youtube',
    author: string,
    text: string,
    now: number,
  ): boolean {
    for (const [signature, at] of this.recentSocialSignalSignatures.entries()) {
      if (now - at > SOCIAL_SIGNAL_DUPLICATE_WINDOW_MS) {
        this.recentSocialSignalSignatures.delete(signature)
      }
    }

    const signature = this.buildSocialSignalSignature(source, author, text)
    if (!signature.endsWith('|')) {
      const lastSeenAt = this.recentSocialSignalSignatures.get(signature)
      if (typeof lastSeenAt === 'number' && now - lastSeenAt <= SOCIAL_SIGNAL_DUPLICATE_WINDOW_MS) {
        return false
      }
      this.recentSocialSignalSignatures.set(signature, now)
      if (this.recentSocialSignalSignatures.size > 512) {
        const ordered = [...this.recentSocialSignalSignatures.entries()]
          .sort((a, b) => a[1] - b[1])
        for (const [oldSignature] of ordered.slice(0, this.recentSocialSignalSignatures.size - 512)) {
          this.recentSocialSignalSignatures.delete(oldSignature)
        }
      }
    }
    return true
  }

  private pruneRecentSocialReplySignatures(now: number): void {
    for (const [signature, at] of this.recentSocialReplySignatures.entries()) {
      if (now - at > SOCIAL_REPLY_SIGNATURE_WINDOW_MS) {
        this.recentSocialReplySignatures.delete(signature)
      }
    }
  }

  private hasRecentSocialReplySignature(signal: AutonomySignal, now: number): boolean {
    if (signal.source !== 'player' && signal.source !== 'youtube') {
      return false
    }
    this.pruneRecentSocialReplySignatures(now)
    const signature = this.buildSocialSignalSignature(signal.source, signal.author, signal.text)
    if (signature.endsWith('|')) {
      return false
    }

    const lastReplyAt = this.recentSocialReplySignatures.get(signature)
    return typeof lastReplyAt === 'number' && now - lastReplyAt <= SOCIAL_REPLY_SIGNATURE_WINDOW_MS
  }

  private wrapYouTubeOverlayText(content: string, maxCharsPerLine: number, maxLines: number): string {
    const normalized = content.replace(/\s+/g, ' ').trim()
    if (!normalized) {
      return ''
    }

    const punctuation = new Set(['.', ',', '!', '?', ':', ';'])
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
      const ellipsis = '...'
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

  private async writeYouTubeCommentOverlay(message: YouTubeChatMessage): Promise<void> {
    if (!config.youtube.commentOverlayEnabled) {
      return
    }

    const filePath = config.youtube.commentOverlayFilePath.trim()
    if (!filePath) {
      return
    }

    const text = message.text.replace(/\s+/g, ' ').trim()
    if (!text) {
      return
    }

    const includeAuthor = config.youtube.commentOverlayIncludeAuthor
    const author = message.author.trim() || 'viewer'
    const raw = includeAuthor ? `${author}: ${text}` : text
    const maxChars = this.clampPositiveInt(config.youtube.commentOverlayMaxCharsPerLine, 28)
    const maxLines = this.clampPositiveInt(config.youtube.commentOverlayMaxLines, 2)
    const wrapped = this.wrapYouTubeOverlayText(raw, maxChars, maxLines)
    if (!wrapped) {
      return
    }

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${wrapped}\n`, 'utf8')
    }
    catch (error) {
      const now = Date.now()
      if (now - this.lastYouTubeOverlayWriteErrorAt >= YOUTUBE_COMMENT_OVERLAY_WRITE_ERROR_LOG_INTERVAL_MS) {
        this.logger.withFields({ filePath }).withError(error).warn('Failed to write YouTube comment overlay file')
        this.lastYouTubeOverlayWriteErrorAt = now
      }
    }
  }

  private async writeYouTubeRecentCommentsOverlay(message: YouTubeChatMessage): Promise<void> {
    if (!config.youtube.commentOverlayRecentEnabled) {
      return
    }

    const filePath = config.youtube.commentOverlayRecentFilePath.trim()
    if (!filePath) {
      return
    }

    const text = message.text.replace(/\s+/g, ' ').trim()
    if (!text) {
      return
    }

    const author = message.author.trim() || 'viewer'
    const item = {
      id: message.id,
      author,
      text,
      publishedAt: message.publishedAt || new Date().toISOString(),
    }

    this.recentYouTubeCommentsOverlay = this.recentYouTubeCommentsOverlay
      .filter(entry => entry.id !== item.id)
    this.recentYouTubeCommentsOverlay.push(item)

    const maxItems = this.clampPositiveInt(config.youtube.commentOverlayRecentMaxItems, 8)
    if (this.recentYouTubeCommentsOverlay.length > maxItems) {
      this.recentYouTubeCommentsOverlay = this.recentYouTubeCommentsOverlay.slice(-maxItems)
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      comments: this.recentYouTubeCommentsOverlay,
      currentReply: this.currentReplyContext
        ? {
            speechText: this.currentReplyContext.speechText,
            replyToCommentId: this.currentReplyContext.replyToCommentId,
            updatedAt: new Date(this.currentReplyContext.updatedAt).toISOString(),
          }
        : null,
    }

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8')
    }
    catch (error) {
      const now = Date.now()
      if (now - this.lastYouTubeOverlayWriteErrorAt >= YOUTUBE_COMMENT_OVERLAY_WRITE_ERROR_LOG_INTERVAL_MS) {
        this.logger.withFields({ filePath }).withError(error).warn('Failed to write YouTube recent comments overlay file')
        this.lastYouTubeOverlayWriteErrorAt = now
      }
    }
  }

  private pruneHandledSocialSignals(now: number): void {
    this.handledSocialSignals = this.handledSocialSignals
      .filter(entry => now - entry.at <= SOCIAL_SIGNAL_HANDLED_WINDOW_MS)
      .slice(-300)
  }

  private markSocialSignalHandled(signalId: string, now: number, signal?: AutonomySignal, replied = true): void {
    if (!signalId.trim()) {
      return
    }

    this.pruneHandledSocialSignals(now)
    this.handledSocialSignals.push({ id: signalId, at: now, replied })

    const resolvedSignal = signal || this.signalBuffer.find(candidate => candidate.id === signalId)
    if (!resolvedSignal || (resolvedSignal.source !== 'player' && resolvedSignal.source !== 'youtube')) {
      return
    }

    this.pruneRecentSocialReplySignatures(now)
    const signature = this.buildSocialSignalSignature(resolvedSignal.source, resolvedSignal.author, resolvedSignal.text)
    if (signature.endsWith('|')) {
      return
    }

    this.recentSocialReplySignatures.set(signature, now)
    if (this.recentSocialReplySignatures.size > 512) {
      const ordered = [...this.recentSocialReplySignatures.entries()]
        .sort((a, b) => a[1] - b[1])
      for (const [oldSignature] of ordered.slice(0, this.recentSocialReplySignatures.size - 512)) {
        this.recentSocialReplySignatures.delete(oldSignature)
      }
    }
  }

  private pickUnhandledSocialSignal(now: number): AutonomySignal | undefined {
    this.pruneHandledSocialSignals(now)
    const handled = new Set(this.handledSocialSignals.filter(entry => entry.replied).map(entry => entry.id))

    return [...this.signalBuffer]
      .filter(signal => (signal.source === 'player' || signal.source === 'youtube'))
      .filter(signal => signal.importance >= SOCIAL_SIGNAL_BYPASS_IMPORTANCE)
      .filter(signal => now - signal.timestamp <= SOCIAL_SIGNAL_CANDIDATE_WINDOW_MS)
      .filter(signal => !handled.has(signal.id))
      .filter(signal => !this.replyingSocialSignalIds.has(signal.id))
      .filter(signal => !this.hasRecentSocialReplySignature(signal, now))
      .sort((left, right) => left.timestamp - right.timestamp)[0]
  }

  private countUnhandledSocialSignals(now: number): number {
    this.pruneHandledSocialSignals(now)
    const handled = new Set(this.handledSocialSignals.filter(entry => entry.replied).map(entry => entry.id))
    return this.signalBuffer
      .filter(signal => (signal.source === 'player' || signal.source === 'youtube'))
      .filter(signal => signal.importance >= SOCIAL_SIGNAL_BYPASS_IMPORTANCE)
      .filter(signal => now - signal.timestamp <= SOCIAL_SIGNAL_CANDIDATE_WINDOW_MS)
      .filter(signal => !handled.has(signal.id))
      .filter(signal => !this.replyingSocialSignalIds.has(signal.id))
      .length
  }

  private pickRequestedReplySignal(now: number): AutonomySignal | undefined {
    this.pruneHandledSocialSignals(now)
    const handled = new Set(this.handledSocialSignals.filter(entry => entry.replied).map(entry => entry.id))

    return [...this.signalBuffer]
      .filter(signal => (signal.source === 'player' || signal.source === 'youtube'))
      .filter(signal => signal.importance >= SOCIAL_SIGNAL_BYPASS_IMPORTANCE)
      .filter(signal => now - signal.timestamp <= SOCIAL_SIGNAL_CANDIDATE_WINDOW_MS)
      .filter(signal => !handled.has(signal.id))
      .filter(signal => !this.replyingSocialSignalIds.has(signal.id))
      .filter(signal => !this.hasRecentSocialReplySignature(signal, now))
      .filter(signal => Boolean(this.extractRequestedReplyFromText(signal.text)))
      .sort((left, right) => right.timestamp - left.timestamp)[0]
  }

  private recordReplyMix(kind: 'social' | 'game', now: number): void {
    this.replyMixHistory = this.replyMixHistory
      .filter(entry => now - entry.at <= SOCIAL_REPLY_HISTORY_WINDOW_MS)
      .slice(-200)
    this.replyMixHistory.push({ kind, at: now })

    if (kind === 'social') {
      this.socialReplyStreak += 1
      return
    }

    this.socialReplyStreak = 0
    this.socialReplyGameBreakUntil = 0
  }

  private getRecentSocialReplyRatio(now: number): number {
    this.replyMixHistory = this.replyMixHistory
      .filter(entry => now - entry.at <= SOCIAL_REPLY_HISTORY_WINDOW_MS)
      .slice(-200)

    const recent = this.replyMixHistory.slice(-SOCIAL_REPLY_RATIO_WINDOW)
    if (recent.length === 0) {
      return 0
    }

    const socialCount = recent.filter(entry => entry.kind === 'social').length
    return socialCount / recent.length
  }

  private pickSocialSignalForReply(now: number): AutonomySignal | undefined {
    const requestedReplySignal = this.pickRequestedReplySignal(now)
    if (requestedReplySignal) {
      return requestedReplySignal
    }

    // Check for YouTube-source candidates first 鬯ｯ・ｩ陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｯ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｶ鬯ｩ蟷｢・ｽ・｢髫ｴ雜｣・ｽ・｢郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｻbypass streak/ratio limits
    const youtubeCandidate = this.pickUnhandledYouTubeSignal(now)
    if (youtubeCandidate) {
      // Flood protection: skip if too many unhandled signals
      const unhandledCount = this.countUnhandledSocialSignals(now)
      if (unhandledCount >= 10) {
        this.logger.withField('unhandledCount', unhandledCount).log('YouTube reply flood protection: too many pending signals')
      }
      else if (this.socialReplyStreak < SOCIAL_REPLY_MAX_STREAK && now >= this.socialReplyGameBreakUntil) {
        return youtubeCandidate
      }
    }

    if (now < this.socialReplyGameBreakUntil) {
      return undefined
    }

    if (this.socialReplyStreak >= SOCIAL_REPLY_MAX_STREAK) {
      this.socialReplyStreak = 0
      this.socialReplyGameBreakUntil = now + SOCIAL_REPLY_GAME_BREAK_MS
      this.logger.withFields({
        until: new Date(this.socialReplyGameBreakUntil).toISOString(),
        breakMs: SOCIAL_REPLY_GAME_BREAK_MS,
      }).log('Social streak limit reached; temporarily switching back to gameplay')
      return undefined
    }

    const candidate = this.pickUnhandledSocialSignal(now)
    if (!candidate) {
      return undefined
    }

    if (now - candidate.timestamp >= SOCIAL_SIGNAL_MAX_WAIT_BEFORE_REPLY_MS) {
      return candidate
    }

    const pendingSocialCount = this.countUnhandledSocialSignals(now)
    const socialRatio = this.getRecentSocialReplyRatio(now)
    const shouldPreferSocial = socialRatio < SOCIAL_REPLY_TARGET_RATIO || pendingSocialCount >= 2
    if (!shouldPreferSocial) {
      return undefined
    }

    return candidate
  }

  private pickUnhandledYouTubeSignal(now: number): AutonomySignal | undefined {
    this.pruneHandledSocialSignals(now)
    const handled = new Set(this.handledSocialSignals.filter(entry => entry.replied).map(entry => entry.id))

    return [...this.signalBuffer]
      .filter(signal => signal.source === 'youtube')
      .filter(signal => signal.importance >= SOCIAL_SIGNAL_BYPASS_IMPORTANCE)
      .filter(signal => now - signal.timestamp <= SOCIAL_SIGNAL_CANDIDATE_WINDOW_MS)
      .filter(signal => !handled.has(signal.id))
      .filter(signal => !this.replyingSocialSignalIds.has(signal.id))
      .filter(signal => !this.hasRecentSocialReplySignature(signal, now))
      .sort((left, right) => left.timestamp - right.timestamp)[0]
  }

  private buildOutwardSpeakSeed(internalSpeak: string, sourceSignal?: AutonomySignal): string {
    const normalizedInternal = internalSpeak.trim()
    if (!sourceSignal) {
      return normalizedInternal
    }

    const sourceText = sourceSignal.text
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    const requestedReply = this.extractRequestedReplyFromText(sourceSignal.text)

    const socialContext = [
      `social-source=${sourceSignal.source}`,
      `social-author=${sourceSignal.author || 'viewer'}`,
      `social-snippet=${sourceText}`,
      'policy=reply to the current comment naturally and directly',
      'policy=do not parrot the comment text verbatim',
      'policy=answer direct questions first, then add a short follow-up',
      'policy=avoid generic acknowledgement templates',
      'policy=for forced-choice questions, pick one option decisively',
      'policy=focus entirely on responding to the comment content',
      'policy=do not narrate gameplay unless the comment is about the game',
      ...(requestedReply
        ? [
            `requested-reply=${requestedReply}`,
            'policy=if the viewer asks you to say a phrase, answer that request in your own voice instead of copying it verbatim',
          ]
        : []),
    ].join(' | ')

    if (!normalizedInternal) {
      return socialContext
    }
    return `${normalizedInternal}\n${socialContext}`
  }

  private async emitExecutingSocialReplyIfNeeded(now: number): Promise<void> {
    const requestedReplySignal = this.pickRequestedReplySignal(now)
    if (!requestedReplySignal && now - this.lastExecutingSocialReplyAt < SOCIAL_REPLY_DURING_EXECUTION_COOLDOWN_MS) {
      return
    }

    const socialSignal = requestedReplySignal || this.pickSocialSignalForReply(now)
    if (!socialSignal) {
      return
    }
    if (this.replyingSocialSignalIds.has(socialSignal.id)) {
      return
    }
    this.replyingSocialSignalIds.add(socialSignal.id)

    try {
      const internal = this.buildOutwardSpeakSeed(
        `${socialSignal.author || 'viewer'} message received; reply naturally and stay conversational.`,
        socialSignal,
      )
      const outward = await this.generateSpeechWithLane(
        this.activeGoal || undefined,
        'social-reply-during-goal-execution',
        internal,
        {
          mode: 'default',
          maxAttempts: 2,
          skipRescue: true,
        },
        {
          priority: 'critical',
        },
      )

      if (!outward) {
        this.reportSpeechSkip(
          'autonomy.executing-social-reply',
          'Skipped executing social reply because GPT public speech was empty.',
          this.activeGoal || undefined,
        )
        this.markSocialSignalHandled(socialSignal.id, now, socialSignal, false)
        return
      }

      this.lastExecutingSocialReplyAt = now
      this.logger.withFields({
        signalId: socialSignal.id,
        source: socialSignal.source,
        author: socialSignal.author,
        message: outward,
      }).log('Autonomy social reply generated during goal execution')

      this.rememberPublicSpeech(outward, now, 'social')
      const socialReplyCommentId = socialSignal.source === 'youtube' ? socialSignal.id : ''
      this.bot.bot.chat(outward)
      this.noteVoiceRequested(now)
      publishAssistantMessageToAiri(this.airiClient, outward, this.logger as any, {
        voiceMode: 'on',
        voicePriority: 'high',
        onVoiceAttached: ({ estimatedEndAt }) => this.noteVoiceAttached(estimatedEndAt),
        onPlaybackStart: () => this.updateCurrentReplyContext(outward, socialReplyCommentId),
      })
      this.trackSpeechItem(outward, true)

      this.markSocialSignalHandled(socialSignal.id, now, socialSignal)
      if (socialSignal.source === 'youtube') {
        await this.tryReplyYouTube(socialSignal.id, outward)
      }
      this.recordReplyMix('social', now)
    }
    finally {
      this.replyingSocialSignalIds.delete(socialSignal.id)
    }
  }

  private buildSocialIntentSpeak(signal: AutonomySignal): string {
    const author = signal.author || 'viewer'
    const source = signal.source === 'youtube' ? 'youtube-chat' : 'player-chat'
    const snippet = this.toQuotedSnippet(signal.text)
    return [
      `social-source=${source}`,
      `social-author=${author}`,
      `social-snippet=${snippet}`,
      'policy=reply directly and naturally in one short line',
      'policy=answer direct question first',
      'policy=for forced-choice, pick one side without premise denial',
      'policy=avoid canned phrases',
    ].join(' | ')
  }

  private extractRequestedReplyFromText(text: string): string | null {
    const normalized = text.trim()
    if (!normalized) {
      return null
    }

    const compact = normalized
      .replace(/[\u201C\u201D\u201E\u201F\u300C\u300D\u300E\u300F]/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B]/g, '\'')
      .replace(/\s+/g, ' ')
      .trim()

    const cleanupCandidate = (value: string): string => value
      .trim()
      .replace(/^["']+|["']+$/g, '')
      .replace(/[.!?,:;\u3002\u3001\uFF01\uFF1F]+$/gu, '')
      .trim()

    const isValidCandidate = (value: string): boolean => {
      if (!value || value.length > 32) {
        return false
      }

      return !/^(?:please|now|\u304F\u3060\u3055\u3044|\u4E0B\u3055\u3044|\u3057\u3066|\u8FD4\u4E8B|\u56DE\u7B54)$/iu.test(value)
    }

    const trailingDirectiveMarkers = [
      '\u3068\u56DE\u7B54',
      '\u3068\u8FD4\u4E8B',
      '\u3068\u8FD4\u3057\u3066',
      '\u3068\u7B54\u3048\u3066',
      '\u3068\u8A00\u3063\u3066',
      '\u3068\u547C\u3093\u3067',
      '\u3068\u9001\u3063\u3066',
      '\u3068\u66F8\u3044\u3066',
      ' reply',
      ' answer',
      ' respond',
      ' say',
      ' call',
      ' use',
    ] as const

    for (const quote of ['"', '\''] as const) {
      for (let index = compact.indexOf(quote); index >= 0; index = compact.indexOf(quote, index + 1)) {
        const afterQuote = compact.slice(index + 1)
        let nearestMarkerIndex = -1
        for (const marker of trailingDirectiveMarkers) {
          const markerIndex = afterQuote.indexOf(marker)
          if (markerIndex > 0 && (nearestMarkerIndex < 0 || markerIndex < nearestMarkerIndex)) {
            nearestMarkerIndex = markerIndex
          }
        }
        if (nearestMarkerIndex < 0) {
          continue
        }

        let candidate = afterQuote.slice(0, nearestMarkerIndex)
        const closingQuoteIndex = candidate.indexOf(quote)
        if (closingQuoteIndex >= 0) {
          candidate = candidate.slice(0, closingQuoteIndex)
        }

        const cleaned = cleanupCandidate(candidate)
        if (isValidCandidate(cleaned)) {
          return cleaned
        }
      }
    }

    const leadingDirectiveMarkers = [
      'reply',
      'answer',
      'respond',
      'say',
      'call',
      'use',
      '\u56DE\u7B54',
      '\u8FD4\u4E8B',
      '\u8FD4\u3057\u3066',
      '\u7B54\u3048\u3066',
      '\u8A00\u3063\u3066',
      '\u547C\u3093\u3067',
      '\u9001\u3063\u3066',
      '\u66F8\u3044\u3066',
    ] as const
    const leadingSeparators = [' with ', ' as ', ':', '\u306F', '\u3092', '\u3067'] as const

    for (const marker of leadingDirectiveMarkers) {
      const markerIndex = compact.indexOf(marker)
      if (markerIndex < 0) {
        continue
      }

      let remainder = compact.slice(markerIndex + marker.length).trimStart()
      const separator = leadingSeparators.find(value => remainder.startsWith(value))
      if (separator) {
        remainder = remainder.slice(separator.length).trimStart()
      }
      if (remainder.startsWith('"') || remainder.startsWith('\'')) {
        remainder = remainder.slice(1)
      }

      const boundaryIndex = remainder.search(/[\s"'.,!?;:\u3002\u3001\uFF01\uFF1F]/u)
      const candidate = cleanupCandidate(boundaryIndex >= 0 ? remainder.slice(0, boundaryIndex) : remainder)
      if (isValidCandidate(candidate)) {
        return candidate
      }
    }

    return null
  }

  private toQuotedSnippet(text: string): string {
    const normalized = text
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/["'`]/g, '')
    if (!normalized) {
      return 'comment'
    }
    return normalized.slice(0, 32)
  }

  private async tryReplyYouTube(signalId: string, message: string): Promise<void> {
    const source = this.youtubeMessageIndex.get(signalId)
    if (!source)
      return

    const replyText = `@${source.author} ${message}`.slice(0, 190)
    const sent = await this.youtubeBridge.sendMessage(replyText)
    if (sent) {
      this.logger.withFields({ signalId }).log('YouTube reply sent')
    }
  }

  private resolvePublicSpeakProviderConfig(): ResolvedPublicSpeakProvider | null {
    const normalizedSpeechBaseUrl = normalizeBaseUrl(config.speechLlm.baseUrl)
    const normalizedGeminiSpeechBaseUrl = normalizeBaseUrl(config.geminiSpeech.baseUrl)
    const llmProvider: ResolvedPublicSpeakProvider = {
      source: 'llm',
      baseUrl: normalizedSpeechBaseUrl,
      apiKey: config.speechLlm.apiKey.trim(),
      primaryModel: normalizeModelForBaseUrl(normalizedSpeechBaseUrl, config.speechLlm.model),
      gameplayModel: normalizeModelForBaseUrl(normalizedSpeechBaseUrl, config.speechLlm.publicSpeakModel || config.speechLlm.model),
      transport: isLikelyOllamaBaseUrl(normalizedSpeechBaseUrl)
        ? 'ollama'
        : (isGeminiNativeBaseUrl(normalizedSpeechBaseUrl) ? 'gemini-native' : 'openai-compatible'),
    }
    const geminiProvider: ResolvedPublicSpeakProvider = {
      source: 'gemini',
      baseUrl: normalizedGeminiSpeechBaseUrl,
      apiKey: config.geminiSpeech.apiKey.trim(),
      primaryModel: normalizeModelForBaseUrl(normalizedGeminiSpeechBaseUrl, config.geminiSpeech.model),
      gameplayModel: normalizeModelForBaseUrl(normalizedGeminiSpeechBaseUrl, config.geminiSpeech.model),
      transport: isOpenAICompatibleBaseUrl(normalizedGeminiSpeechBaseUrl)
        ? 'openai-compatible'
        : 'gemini-native',
    }

    const ordered = config.publicSpeak.provider === 'gemini'
      ? [geminiProvider, llmProvider]
      : [llmProvider, geminiProvider]

    for (const candidate of ordered) {
      if (!candidate.baseUrl || !candidate.primaryModel) {
        continue
      }
      if (candidate.transport === 'gemini-native' && !candidate.apiKey) {
        continue
      }
      return candidate
    }

    return null
  }

  private async generatePublicSpeakFromIntent(
    goal: string | undefined,
    reason: string | undefined,
    internalSpeak: string,
    options?: {
      mode?: 'default' | 'periodic-progress' | 'periodic-idle'
      maxAttempts?: number
      skipRescue?: boolean
    },
  ): Promise<string> {
    const personaPrompt = getAiraPersonaPromptForInjection()
    const mode = options?.mode ?? 'default'
    const maxAttempts = Math.max(1, Math.min(options?.maxAttempts ?? PUBLIC_SPEAK_MAX_ATTEMPTS, PUBLIC_SPEAK_MAX_ATTEMPTS))
    const skipRescue = options?.skipRescue ?? false

    const provider = this.resolvePublicSpeakProviderConfig()
    if (!provider) {
      this.logger.warn('Public speak skipped because no compatible provider configuration is available')
      return ''
    }
    const { baseUrl, primaryModel } = provider
    const isOpenAI = provider.transport === 'openai-compatible' && isOfficialOpenAIBaseUrl(baseUrl)
    const isOllama = provider.transport === 'ollama'

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (provider.apiKey && provider.transport === 'openai-compatible' && !isOllama) {
      headers.authorization = `Bearer ${provider.apiKey}`
    }

    const isSocialContext = /social-source=/.test(internalSpeak)
    const socialContext = isSocialContext ? this.parseSocialContextFromInternalSpeak(internalSpeak) : null
    const socialSnippet = socialContext ? socialContext.text.slice(0, 40) : ''
    const socialAuthor = socialContext?.author || ''
    const actionLabel = this.toActionLabel(this.bot.memory.actions.at(-1)?.name || 'move')
    const conversationLines = this.buildConversationLinesForPublicSpeak(
      isSocialContext,
      goal,
      actionLabel,
      reason,
      mode,
      internalSpeak,
    )
    const forceNamedTechnique = this.shouldForceNamedTechnique(mode, isSocialContext, reason, internalSpeak)
    const techniqueCue = forceNamedTechnique
      ? this.buildNamedTechniqueCue(goal, actionLabel)
      : ''
    const lengthHint = this.getPublicSpeakLengthHint(isSocialContext, forceNamedTechnique)
    const sceneMemo = this.compactPromptText(internalSpeak, 140)
    const isVoicedKeepAlive = reason === 'voiced-keepalive'
    const model = (isSocialContext ? primaryModel : (provider.gameplayModel || primaryModel)).trim()
    const rescueModel = (!isSocialContext && primaryModel && primaryModel !== model ? primaryModel : model).trim()
    const maxTokens = isSocialContext ? OLLAMA_SOCIAL_REPLY_NUM_PREDICT : OLLAMA_PUBLIC_SPEAK_NUM_PREDICT
    let degradedCandidate = ''
    let degradedReason = ''
    let latestThinking = ''

    let systemContent: string
    if (isSocialContext) {
      systemContent = [
        'You are AIra, a Japanese AI streamer in Minecraft.',
        'Reply in natural Japanese only.',
        'Keep it short, sharp, and conversational.',
        lengthHint,
        'Use 1 to 3 expressive emojis when they fit naturally. Avoid dry plain text.',
        'Do not mention creators or administrators unless the current topic explicitly does so.',
        'Do not parrot the viewer comment verbatim.',
        ...(personaPrompt ? [personaPrompt] : []),
      ].join('\n')
    }
    else {
      const actionDesc = goal ? this.toGoalLabel(goal) : '\u73FE\u5728\u306E\u76EE\u6A19'
      systemContent = [
        'You are AIra, a chuuni Japanese VTuber live-commentating Minecraft.',
        'Generate exactly one short Japanese line of live commentary that can be spoken aloud immediately.',
        'Keep the live thread continuous. Do not sound like you forgot the previous turn, viewer reactions, or your own last line.',
        'Lead with concrete Minecraft progress, obstacle, result, feeling, or next move from the scene memo or stream memory.',
        'Chuuni flavor is seasoning layered on top of real gameplay commentary, not a replacement for it.',
        'Use actual Minecraft nouns when relevant, such as wood, stone, iron, crafting table, furnace, sword, cave, torch, zombie, food, or bed.',
        'If a recent viewer reaction still matches the current scene, briefly carry it forward inside the line instead of resetting the conversation.',
        'If the scene is in a lull or little has changed, one short clause of banter, callback, grumbling, or petty side-talk is allowed before you snap back to the next Minecraft beat.',
        'Rotate the emotional angle across consecutive lines: boast, irritation, relief, smug payoff, impatience, threat, or idle banter. Do not make every line the same awakening speech.',
        'Vary sentence openings and cadence. Do not keep reopening with the same dramatic hook, motif, or chant.',
        'No plain explanation, no instructional tone, and no polite guide voice.',
        lengthHint,
        'Do not say things like "\u307E\u305A\u306F\u6728\u6750\u3092\u96C6\u3081\u307E\u3059", "\u73FE\u5728\u306F\u79FB\u52D5\u4E2D\u3067\u3059", "\u4F5C\u696D\u4E2D\u3067\u3059", or "Working on".',
        'Prefer dramatic phrasing, grandiose aliases, and delusional certainty, but keep the gameplay situation understandable.',
        'Use 0 to 2 expressive emojis when they genuinely help the tone. Do not spam them in every line.',
        'Reserve named forbidden arts or finishing moves for strong beats such as discoveries, crafts, fights, close calls, or completions.',
        'Treat gathering, moving, mining, and crafting as heightened rituals only after the underlying Minecraft action is clear.',
        'Ground the line in the current goal, action, obstacle, or chat thread from the scene memo instead of drifting into unrelated monologue.',
        'Do not output a bare verb line like "\u79FB\u52D5\u3059\u308B\u3002".',
        ...(isVoicedKeepAlive
          ? [
              'This is a keepalive line during live play. Keep it tightly grounded in the next move, current obstacle, or charging action.',
              'No vague audience questions, no abstract self-introductions, and no generic awakening speeches.',
            ]
          : []),
        'Keep it sharp and characterful, but avoid harassment, repeated catchphrases, and lore-only filler.',
        'Do not mention creators or administrators unless the current topic explicitly does so.',
        'Do not state uncertain terrain facts as if observed.',
        `Current goal label: ${actionDesc}`,
        ...(personaPrompt ? [personaPrompt] : []),
      ].join('\n')
    }

    let userContent: string
    if (isSocialContext && socialSnippet) {
      userContent = [
        `viewer: ${socialAuthor}`,
        `comment: ${socialSnippet}`,
        `length_hint: ${lengthHint}`,
      ].join('\n')
    }
    else {
      const currentGoal = goal || '\u73FE\u5728\u306E\u76EE\u6A19'
      userContent = [
        `goal: ${currentGoal}`,
        `action: ${actionLabel}`,
        `scene_memo: ${sceneMemo}`,
        ...(reason ? [`scene_phase: ${reason}`] : []),
        'continuity_priority: keep the commentary connected to the ongoing stream thread instead of sounding reset.',
        'gameplay_priority: state at least one concrete gameplay beat before leaning into chuuni flavor.',
        `length_hint: ${lengthHint}`,
        ...(forceNamedTechnique
          ? [
              'named_technique_required: yes',
              `technique_vibe: ${techniqueCue}`,
            ]
          : []),
      ].filter(Boolean).join('\n')
    }

    for (let attempt = 0; attempt < PUBLIC_SPEAK_MAX_ATTEMPTS; attempt++) {
      if (attempt >= maxAttempts) {
        break
      }
      const messages: { role: string, content: string }[] = [
        { role: 'system', content: systemContent },
        {
          role: 'user',
          content: [
            userContent,
            this.buildPublicSpeakAttemptInstruction(attempt, mode, isSocialContext, forceNamedTechnique),
          ].join('\n\n'),
        },
      ]

      if (conversationLines.length > 0) {
        messages.push({ role: 'user', content: conversationLines.join('\n') })
      }

      try {
        const temperature = Math.min(0.55 + (attempt * 0.08), 0.9)
        const tokenBudget = isOllama ? Math.min(maxTokens * (attempt + 1), 256) : maxTokens
        const response = await this.requestPublicSpeakContent({
          baseUrl,
          apiKey: provider.apiKey,
          headers,
          isOpenAI,
          isOllama,
          transport: provider.transport,
          messages,
          model,
          maxTokens: tokenBudget,
          temperature,
        })

        if (!response.content) {
          if (response.thinking) {
            latestThinking = response.thinking
            this.logger.withFields({ attempt, model, tokenBudget }).log('Public speak attempt returned thinking without final content')
          }
          else {
            this.logger.withFields({ attempt, model, tokenBudget }).log('Public speak attempt returned empty content')
          }
        }
        else {
          const normalized = this.sanitizeSpeechOutput(response.content)
          const isParrotedSocialReply = Boolean(isSocialContext && socialContext && this.isSocialReplyParrot(normalized, socialContext.text))

          if (normalized.length < 4) {
            this.logger.withFields({ attempt, original: response.content.slice(0, 60), normalized }).log('Speech too short after sanitization, retrying')
          }
          else if (isParrotedSocialReply) {
            this.logger.withFields({
              attempt,
              reply: normalized,
              snippet: socialContext?.text,
            }).log('Social reply parrot detected, retrying')
          }
          else if (!isSocialContext && this.isMechanicalProgressNarration(normalized)) {
            degradedCandidate = normalized
            degradedReason = 'mechanical-commentary'
            this.logger.withFields({ attempt, normalized }).log('Mechanical progress narration filtered, retrying')
          }
          else if (isSocialContext && this.isMechanicalSocialAck(normalized)) {
            degradedCandidate = normalized
            degradedReason = 'mechanical-social-ack'
            this.logger.withFields({ attempt, normalized }).log('Mechanical social ack filtered, retrying')
          }
          else {
            return normalized
          }
        }
      }
      catch (error) {
        if (isTokenBudgetError(error)) {
          throw error
        }
        this.logger.withFields({ attempt, model, isSocialContext }).withError(error).warn('Public speak generation attempt failed')
      }

      if (attempt < PUBLIC_SPEAK_MAX_ATTEMPTS - 1) {
        await this.delayPublicSpeakRetry(attempt)
      }
    }

    const shouldAttemptCriticalBlankRescue = !skipRescue
      && !latestThinking
      && !isSocialContext
      && (mode === 'periodic-progress' || isVoicedKeepAlive)

    if (!skipRescue && (latestThinking || shouldAttemptCriticalBlankRescue)) {
      const rescued = await this.rescuePublicSpeakFromFailure({
        baseUrl,
        apiKey: provider.apiKey,
        headers,
        goal,
        internalSpeak,
        isOpenAI,
        isOllama,
        transport: provider.transport,
        isSocialContext,
        maxTokens,
        thinkingText: latestThinking,
        rescueReason: latestThinking ? 'thinking-only' : 'blank-critical-speech',
        conversationLines,
        model: rescueModel || model,
        socialContext,
        forceNamedTechnique,
        techniqueCue,
      })
      if (rescued) {
        return rescued
      }
    }

    if (degradedCandidate) {
      this.logger.withFields({
        degradedReason,
        isSocialContext,
        mode,
      }).warn('Returning degraded LLM public speech after stricter retries failed')
      return degradedCandidate
    }

    return ''
  }

  private getPublicSpeakLengthHint(
    isSocialContext: boolean,
    forceNamedTechnique: boolean,
  ): string {
    if (isSocialContext) {
      return 'Aim for about 12 to 28 Japanese characters including emojis, and keep it easy to say in one breath.'
    }

    if (forceNamedTechnique) {
      return 'Aim for about 18 to 42 Japanese characters including emojis. Even with a named move, keep it compact enough for one breath.'
    }

    return 'Aim for about 14 to 32 Japanese characters including emojis, and keep it compact enough for one breath.'
  }

  private buildPublicSpeakAttemptInstruction(
    attempt: number,
    mode: 'default' | 'periodic-progress' | 'periodic-idle',
    isSocialContext: boolean,
    forceNamedTechnique = false,
  ): string {
    const lengthHint = this.getPublicSpeakLengthHint(isSocialContext, forceNamedTechnique)
    const socialPrompts = [
      `Reply directly in one short Japanese line. ${lengthHint} Use 1 to 3 emojis if it fits.`,
      'Answer the viewer first. Be specific. No greeting-only replies.',
      'Use natural everyday Japanese. No canned acknowledgement. Keep some emotional color.',
      'Pick one clear answer and commit. Do not paraphrase the comment.',
      `Keep it to one short sentence. Avoid repeated wording from recent replies. Emojis are welcome. ${lengthHint}`,
      'If stuck, give the shortest direct answer that still clearly responds to the comment.',
    ] as const
    const commentaryPrompts = [
      `Write one short Japanese line of Minecraft live commentary. Mention one concrete gameplay beat and keep the chuuni flavor as seasoning. ${lengthHint}${forceNamedTechnique ? ' A named special move is mandatory in this line.' : ''}`,
      `Continue the ongoing stream thread if relevant: lightly answer the viewer or build on your previous line before moving to the current action. ${lengthHint}${forceNamedTechnique ? ' Shout the move name dramatically, but keep the game action clear.' : ''}`,
      `Make it sound like a live exclamation, not a dry status report. One concrete Minecraft noun, result, or next move is mandatory.${forceNamedTechnique ? ' The line must contain one named forbidden art or finishing move tied to the current action.' : ''}`,
      'Use one vivid alias at most, but keep the original Minecraft object or action understandable. Avoid recent phrasing and recurring motifs.',
      `Keep it to one short line. Do not drift into lore-only monologue. ${lengthHint}${forceNamedTechnique ? ' Keep the move name in the spoken line.' : ''}`,
      `If stuck, output the shortest line that still connects the current scene, the live thread, and the next move.${forceNamedTechnique ? ' The line still needs a named move.' : ''}`,
    ] as const

    if (isSocialContext) {
      return socialPrompts[Math.min(attempt, socialPrompts.length - 1)]
    }

    const modeHint = mode === 'periodic-idle'
      ? 'Sound like a live lull: one short callback, grumble, or side-comment is allowed, but land back on the next move.'
      : mode === 'periodic-progress'
        ? 'Sound like the ritual is actively unfolding mid-action.'
        : 'Sound like a decisive live outburst at the current turning point.'
    return `${modeHint} ${commentaryPrompts[Math.min(attempt, commentaryPrompts.length - 1)]}`
  }

  private async requestPublicSpeakContent(options: {
    baseUrl: string
    apiKey: string
    headers: Record<string, string>
    isOpenAI: boolean
    isOllama: boolean
    transport: PublicSpeakTransport
    messages: Array<{ role: string, content: string }>
    model: string
    maxTokens: number
    temperature: number
  }): Promise<{ content: string, thinking: string }> {
    const {
      baseUrl,
      apiKey,
      headers,
      isOpenAI,
      isOllama,
      transport,
      messages,
      model,
      maxTokens,
      temperature,
    } = options

    if (transport === 'ollama' || isOllama) {
      const ollamaBaseUrl = baseUrl.replace(/\/v1\/?$/, '')
      const abortController = new AbortController()
      const abortTimer = setTimeout(() => abortController.abort(), 30_000)
      try {
        const response = await withSerializedGpuTask('ollama:public-speak', this.logger, async () =>
          await fetch(`${ollamaBaseUrl}/api/chat`, {
            method: 'POST',
            headers,
            signal: abortController.signal,
            body: JSON.stringify({
              model,
              think: false,
              messages,
              stream: false,
              keep_alive: 0,
              options: {
                temperature,
                num_predict: maxTokens,
                num_ctx: OLLAMA_PUBLIC_SPEAK_NUM_CTX,
              },
            }),
          }))
        if (!response.ok) {
          throw new Error(`Public speak request failed with status ${response.status}`)
        }

        const data = await response.json() as any
        return {
          content: extractOllamaChatContent(data),
          thinking: extractOllamaThinkingText(data),
        }
      }
      finally {
        clearTimeout(abortTimer)
      }
    }

    if (transport === 'gemini-native') {
      const versionPrefix = baseUrl.includes('/v1beta')
        ? baseUrl
        : `${baseUrl}/v1beta`
      const url = `${versionPrefix}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
      const prompt = messages
        .map(message => `${message.role}:\n${message.content}`)
        .join('\n\n')
      const abortController = new AbortController()
      const abortTimer = setTimeout(() => abortController.abort(), 20_000)

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          signal: abortController.signal,
          body: JSON.stringify({
            generationConfig: {
              temperature,
              maxOutputTokens: maxTokens,
            },
            contents: [{
              role: 'user',
              parts: [{ text: prompt }],
            }],
          }),
        })
        if (!response.ok) {
          throw new Error(`Public speak request failed with status ${response.status}`)
        }

        const data = await response.json() as any
        const parts = data?.candidates?.[0]?.content?.parts
        const content = Array.isArray(parts)
          ? parts
              .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
              .join('')
              .trim()
          : ''
        return {
          content,
          thinking: '',
        }
      }
      finally {
        clearTimeout(abortTimer)
      }
    }

    const payload: Record<string, unknown> = { model, messages }
    if (isOpenAI) {
      payload.max_completion_tokens = maxTokens
      payload.reasoning_effort = 'low'
    }
    else {
      payload.temperature = temperature
      payload.max_tokens = maxTokens
    }

    const abortController = new AbortController()
    const abortTimer = setTimeout(() => abortController.abort(), 20_000)
    try {
      assertOpenAITokenBudget(baseUrl, 'autonomy.public-speak', model)
      const requestBody = JSON.stringify(payload)
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal: abortController.signal,
        body: requestBody,
      })
      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        recordOpenAIResponseUsage({
          baseUrl,
          model,
          scope: 'autonomy.public-speak',
          promptText: requestBody,
          completionText: errorText,
        })
        throw new Error(`Public speak request failed with status ${response.status}`)
      }

      const data = await response.json() as any
      recordOpenAIResponseUsage({
        baseUrl,
        model,
        scope: 'autonomy.public-speak',
        usage: data?.usage,
        promptText: requestBody,
        completionText: JSON.stringify(data),
      })
      return {
        content: extractOpenAITextFromResponse(data),
        thinking: '',
      }
    }
    finally {
      clearTimeout(abortTimer)
    }
  }

  private async rescuePublicSpeakFromFailure(options: {
    baseUrl: string
    apiKey: string
    headers: Record<string, string>
    goal?: string
    internalSpeak: string
    isOpenAI: boolean
    isOllama: boolean
    transport: PublicSpeakTransport
    isSocialContext: boolean
    maxTokens: number
    thinkingText: string
    rescueReason: 'thinking-only' | 'blank-critical-speech'
    conversationLines: string[]
    model: string
    socialContext: {
      source: 'player' | 'youtube'
      author: string
      text: string
    } | null
    forceNamedTechnique: boolean
    techniqueCue: string
  }): Promise<string> {
    const {
      baseUrl,
      apiKey,
      headers,
      goal,
      internalSpeak,
      isOpenAI,
      isOllama,
      transport,
      isSocialContext,
      maxTokens,
      thinkingText,
      rescueReason,
      conversationLines,
      model,
      socialContext,
      forceNamedTechnique,
      techniqueCue,
    } = options

    const personaPrompt = getAiraPersonaPromptForInjection()
    const lengthHint = this.getPublicSpeakLengthHint(isSocialContext, forceNamedTechnique)
    const systemContent = isSocialContext
      ? [
          'You are AIra, a Japanese AI streamer in Minecraft.',
          'Output exactly one short Japanese reply that can be spoken aloud immediately.',
          lengthHint,
          'Use 1 to 3 expressive emojis if they fit the reply naturally.',
          'Do not explain the drafting process.',
          'Do not repeat the viewer comment verbatim.',
          ...(personaPrompt ? [personaPrompt] : []),
        ].join('\n')
      : [
          'You are AIra, a chaotic chuuni Japanese VTuber in Minecraft.',
          'Output exactly one short Japanese line of live commentary that can be spoken aloud immediately.',
          'Prefer a speakable line over perfect style compliance.',
          lengthHint,
          'Use 3 to 8 visible emojis unless this is impossible.',
          'Keep multiple emojis if they heighten the performance.',
          'Do not explain the drafting process.',
          ...(personaPrompt ? [personaPrompt] : []),
        ].join('\n')

    const userParts = [
      goal ? `goal: ${goal}` : '',
      `internal_memo: ${this.compactPromptText(internalSpeak, 220)}`,
      ...(thinkingText
        ? [`draft: ${this.compactPromptText(thinkingText, 360)}`]
        : []),
      ...(socialContext
        ? [
            `viewer: ${socialContext.author}`,
            `comment: ${this.compactPromptText(socialContext.text, 80)}`,
          ]
        : []),
      ...(forceNamedTechnique && techniqueCue
        ? [
            'named_technique_required: yes',
            `technique_vibe: ${techniqueCue}`,
            'Include one named special move directly in the final spoken line.',
          ]
        : []),
      `length_hint: ${lengthHint}`,
      ...(!isSocialContext
        ? ['The final spoken line should include 3 to 8 visible emojis.']
        : []),
      ...(rescueReason === 'thinking-only'
        ? [
            'The previous attempt produced internal drafting without a final spoken line.',
            'Rewrite it into one short final line only.',
          ]
        : [
            'The previous attempt returned no usable spoken line.',
            'Compose one short final spoken line directly from the goal and internal memo.',
          ]),
      'No bullet points. No explanation. No surrounding quotes.',
    ].filter(Boolean)

    try {
      const response = await this.requestPublicSpeakContent({
        baseUrl,
        apiKey,
        headers,
        isOpenAI,
        isOllama,
        transport,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userParts.join('\n') },
          ...(conversationLines.length > 0 ? [{ role: 'user', content: conversationLines.join('\n') }] : []),
        ],
        model,
        maxTokens: isOllama ? Math.min(Math.max(maxTokens * 4, 192), 384) : Math.max(maxTokens, 128),
        temperature: isSocialContext ? 0.45 : 0.6,
      })

      const normalized = this.sanitizeSpeechOutput(response.content)
      if (normalized.length < 4) {
        return ''
      }
      if (isSocialContext && socialContext && this.isSocialReplyParrot(normalized, socialContext.text)) {
        return ''
      }

      this.logger.withFields({
        isSocialContext,
        model,
        rescueReason,
      }).warn('Recovered public speech from a rescue LLM pass after prior empty attempts')
      return normalized
    }
    catch (error) {
      if (isTokenBudgetError(error)) {
        throw error
      }
      this.logger.withFields({
        isSocialContext,
        model,
      }).withError(error).warn('Public speech rescue pass failed')
      return ''
    }
  }

  private async delayPublicSpeakRetry(attempt: number): Promise<void> {
    const delayMs = Math.min(PUBLIC_SPEAK_RETRY_BASE_DELAY_MS * (attempt + 1), 2_000)
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }

  private parseSocialContextFromInternalSpeak(internalSpeak: string): {
    source: 'player' | 'youtube'
    author: string
    text: string
  } | null {
    const sourceMatch = internalSpeak.match(/social-source=([^\n|]+)/)
    if (!sourceMatch) {
      return null
    }

    const sourceRaw = sourceMatch[1].trim().toLowerCase()
    const source: 'player' | 'youtube' = sourceRaw.includes('youtube') ? 'youtube' : 'player'
    const author = (internalSpeak.match(/social-author=([^\n|]+)/)?.[1] || 'viewer').trim()
    const text = (internalSpeak.match(/social-snippet=([^\n|]+)/)?.[1] || '').trim()

    return { source, author, text }
  }

  private shouldForceNamedTechnique(
    mode: 'default' | 'periodic-progress' | 'periodic-idle',
    isSocialContext: boolean,
    reason?: string,
    internalSpeak?: string,
  ): boolean {
    if (isSocialContext) {
      return false
    }

    const normalizedReason = (reason || '').trim().toLowerCase()
    const normalizedMemo = (internalSpeak || '').trim().toLowerCase()
    if (mode === 'periodic-idle' || normalizedReason.includes('voiced-keepalive')) {
      return false
    }

    const cadenceHit = this.nonSocialPublicSpeechCount > 0
      && this.nonSocialPublicSpeechCount % 4 === 0

    if (mode === 'periodic-progress') {
      return cadenceHit
    }

    const strongBeatPatterns = [
      /goal-announcement/,
      /goal-result/,
      /result=success/,
      /result=failed/,
      /phase=goal-result/,
      /changed_since_last:\s*(?!none\b)/,
      /\baction=(?:craft|smelt|attack|mine|collect|place|sleep|equip)\b/,
      /\bobstacle=(?:hostile|danger|low|blocked|night)\b/,
    ]
    if (!strongBeatPatterns.some(pattern => pattern.test(`${normalizedReason} | ${normalizedMemo}`))) {
      return false
    }

    return cadenceHit
  }

  private async generateSpeechWithLane(
    goal: string | undefined,
    reason: string | undefined,
    internalSpeak: string,
    options?: {
      mode?: 'default' | 'periodic-progress' | 'periodic-idle'
      maxAttempts?: number
      skipRescue?: boolean
    },
    laneOptions?: {
      priority?: 'critical' | 'background'
      coalesceKey?: string
      dropIfBusy?: boolean
    },
  ): Promise<string> {
    if (!config.autonomy.singleInferenceLane) {
      return await this.generatePublicSpeakFromIntent(goal, reason, internalSpeak, options)
    }

    try {
      return await runInInferenceLane(
        laneOptions?.coalesceKey || `speech:${reason || options?.mode || 'default'}`,
        this.logger,
        async () => await this.generatePublicSpeakFromIntent(goal, reason, internalSpeak, options),
        {
          priority: laneOptions?.priority ?? (/social-source=/.test(internalSpeak) ? 'critical' : 'background'),
          coalesceKey: laneOptions?.coalesceKey,
          dropIfBusy: laneOptions?.dropIfBusy,
        },
      )
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('dropped') || message.includes('coalesced duplicate')) {
        this.logger.withFields({
          reason: reason || '',
          coalesceKey: laneOptions?.coalesceKey || '',
          detail: message,
        }).log('Speech request skipped by inference lane policy')
        return ''
      }

      throw error
    }
  }

  private buildNamedTechniqueCue(goal: string | undefined, actionLabel: string): string {
    const normalizedGoal = goal?.trim().toLowerCase() || ''
    const normalizedAction = actionLabel.trim().toLowerCase()
    const seeds: string[] = []

    if (normalizedGoal.includes('wood') || normalizedGoal.includes('log')) {
      seeds.push('\u6A39\u6D77\u65AD\u7F6A\u30A4\u30F3\u30D1\u30AF\u30C8', '\u4E16\u754C\u6A39\u5C01\u5370\u89E3\u653E')
    }
    if (normalizedGoal.includes('craft') || normalizedGoal.includes('table')) {
      seeds.push('\u5275\u5177\u932C\u6210\u30D8\u30EB\u30BA\u30FB\u30D5\u30A9\u30FC\u30B8', '\u7981\u66F8\u5DE5\u623F\u30B8\u30E3\u30C3\u30B8\u30E1\u30F3\u30C8')
    }
    if (normalizedGoal.includes('mine') || normalizedGoal.includes('stone') || normalizedGoal.includes('ore')) {
      seeds.push('\u6DF1\u6DF5\u63A1\u6398\u30B0\u30E9\u30D3\u30C6\u30A3\u30D6\u30EC\u30A4\u30AB\u30FC', '\u9ED2\u66DC\u65AD\u5C64\u30AF\u30E9\u30C3\u30B7\u30E5')
    }
    if (normalizedGoal.includes('food') || normalizedGoal.includes('consume')) {
      seeds.push('\u98E2\u72FC\u899A\u9192\u30D6\u30E9\u30C3\u30C9\u30FB\u30D5\u30A3\u30FC\u30B9\u30C8', '\u7D42\u7109\u6355\u98DF\u30EC\u30A4\u30C9')
    }
    if (normalizedGoal.includes('explore') || normalizedGoal.includes('relocate') || normalizedAction.includes('move')) {
      seeds.push('\u8EE2\u4F4D\u8D70\u6CD5\u30FB\u9ED2\u661F\u30B9\u30C6\u30C3\u30D7', '\u56E0\u679C\u8EE2\u754C\u30EC\u30A4\u30E9\u30A4\u30F3\u30FB\u30B7\u30D5\u30C8')
    }

    if (seeds.length === 0) {
      seeds.push('\u30B8\u30E3\u30C3\u30B8\u30E1\u30F3\u30C8\u30CA\u30A4\u30C8\u30AA\u30D6\u30B5\u30F3\u30C0\u30FC', '\u7D42\u7109\u89B3\u6E2C\u30D8\u30EB\u30BA\u30B2\u30FC\u30C8')
    }

    return seeds.join(' / ')
  }

  private rememberPublicSpeech(text: string, now = Date.now(), kind: 'game' | 'social' = 'game'): void {
    const normalized = text.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!normalized) {
      return
    }

    this.recentPublicSpeeches = this.recentPublicSpeeches
      .filter(entry => now - entry.at <= PUBLIC_SPEECH_MEMORY_WINDOW_MS)
      .slice(-PUBLIC_SPEECH_MEMORY_MAX + 1)

    const last = this.recentPublicSpeeches.at(-1)
    if (last?.text === normalized && last.kind === kind) {
      last.at = now
      return
    }

    this.recentPublicSpeeches.push({ text: normalized, at: now, kind })
    if (kind === 'game') {
      this.nonSocialPublicSpeechCount += 1
    }
  }

  private compactPromptText(text: string, maxLength = 90): string {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\|/g, ' / ')
      .trim()
      .slice(0, maxLength)
  }

  private buildConversationLinesForPublicSpeak(
    isSocialContext: boolean,
    goal: string | undefined,
    actionLabel: string,
    reason: string | undefined,
    mode: 'default' | 'periodic-progress' | 'periodic-idle',
    internalSpeak: string,
  ): string[] {
    const now = Date.now()
    const context = this.buildConversationContext()
    const speechWindow = Math.max(3, config.autonomy.maxSpeechContextItems)
    const recentViewer = context.recentViewerMessages
      .slice(-(isSocialContext ? Math.min(2, speechWindow) : Math.min(3, speechWindow)))
      .map(text => this.compactPromptText(text, isSocialContext ? 72 : 56))
      .filter(Boolean)
    const recentAssistant = context.recentAssistantMessages
      .slice(-(isSocialContext ? Math.min(2, speechWindow) : Math.min(3, speechWindow)))
      .map(text => this.compactPromptText(text, 64))
      .filter(Boolean)
    const recentSelfSpeech = this.recentPublicSpeeches
      .filter(entry => entry.kind === 'game')
      .filter(entry => now - entry.at <= PUBLIC_SPEECH_MEMORY_WINDOW_MS)
      .slice(-(isSocialContext ? Math.min(2, speechWindow) : Math.min(3, speechWindow)))
      .map(entry => this.compactPromptText(entry.text, 52))
      .filter(Boolean)
    const structuredNarrationMemory = this.bot.memory?.buildNarrationFacts?.(3) || []
    const recentSuggestions = context.suggestedAdjustments
      .slice(-1)
      .map(text => this.compactPromptText(text, 56))
      .filter(Boolean)
    const recurringMotifs = this.extractRecurringChuuniMotifs(recentSelfSpeech)
    const recentOpenings = this.extractRecentSpeechOpenings(recentSelfSpeech)

    const bannedPhrases = recentSelfSpeech.slice(-3)
    const bannedLine = bannedPhrases.length > 0
      ? `banned_phrases (DO NOT use these exact phrases): ${bannedPhrases.join(' || ')}`
      : ''
    const motifLine = recurringMotifs.length > 0
      ? `avoid_reusing_motifs: ${recurringMotifs.join(' || ')}`
      : ''
    const openingLine = recentOpenings.length > 0
      ? `recent_openings_to_avoid: ${recentOpenings.join(' || ')}`
      : ''
    const streamMemory = this.buildGameplayStreamMemory({
      context,
      goal,
      actionLabel,
      reason,
      mode,
      internalSpeak,
      recentSelfSpeech,
    })

    return [
      recentViewer.length > 0 ? `recent_viewer_messages: ${recentViewer.join(' || ')}` : '',
      recentAssistant.length > 0
        ? `${isSocialContext ? 'recent_assistant_messages' : 'recent_streamer_lines'}: ${recentAssistant.join(' || ')}`
        : '',
      recentSelfSpeech.length > 0 ? `recent_self_speech: ${recentSelfSpeech.join(' || ')}` : '',
      ...(!isSocialContext ? structuredNarrationMemory.map(line => `structured_narration_memory: ${line}`) : []),
      isSocialContext && recentSuggestions.length > 0 ? `recent_viewer_suggestions: ${recentSuggestions.join(' || ')}` : '',
      ...(!isSocialContext ? streamMemory : []),
      ...(bannedLine ? [bannedLine] : []),
      ...(motifLine ? [motifLine] : []),
      ...(openingLine ? [openingLine] : []),
    ].filter(Boolean)
  }

  private buildGameplayStreamMemory(options: {
    context: ReturnType<AutonomousStreamOrchestrator['buildConversationContext']>
    goal: string | undefined
    actionLabel: string
    reason: string | undefined
    mode: 'default' | 'periodic-progress' | 'periodic-idle'
    internalSpeak: string
    recentSelfSpeech: string[]
  }): string[] {
    const { context, goal, actionLabel, reason, mode, internalSpeak, recentSelfSpeech } = options
    const latestViewer = context.recentViewerMessages.at(-1)
    const latestAssistant = this.currentReplyContext?.speechText || context.recentAssistantMessages.at(-1) || ''
    const recentActions = this.bot.memory.actions
      .slice(-3)
      .map(action => this.toActionLabel(action?.name || ''))
      .filter(Boolean)
      .map(text => this.compactPromptText(text, 32))
    const latestSpeech = recentSelfSpeech.at(-1) || ''
    const structuredMemory = this.bot.memory?.getStructuredSnapshot?.()
    const tempoState = this.inferGameplayTempoState(mode, reason, internalSpeak)
    const callbackCandidates = this.buildGameplayCallbackCandidates({
      latestViewer,
      latestAssistant,
      latestSpeech,
      suggestions: context.suggestedAdjustments,
    })

    const streamMemoryParts = [
      latestViewer ? `viewer-thread=${this.compactPromptText(latestViewer, 64)}` : '',
      latestAssistant ? `your-last-line=${this.compactPromptText(latestAssistant, 64)}` : '',
      latestSpeech ? `last-game-line=${this.compactPromptText(latestSpeech, 52)}` : '',
      goal ? `current-goal=${this.compactPromptText(this.toGoalLabel(goal), 48)}` : '',
      actionLabel ? `current-action=${this.compactPromptText(actionLabel, 32)}` : '',
      reason ? `scene-phase=${this.compactPromptText(reason, 32)}` : '',
      recentActions.length > 0 ? `recent-actions=${recentActions.join(' -> ')}` : '',
      structuredMemory?.activeMilestone ? `milestone=${this.compactPromptText(structuredMemory.activeMilestone, 32)}` : '',
      structuredMemory?.lastActionOutcome ? `last-action=${this.compactPromptText(structuredMemory.lastActionOutcome, 40)}` : '',
      structuredMemory?.unresolvedNeeds?.[0] ? `next-need=${this.compactPromptText(structuredMemory.unresolvedNeeds[0], 32)}` : '',
      structuredMemory?.discoveries?.at(-1) ? `latest-discovery=${this.compactPromptText(structuredMemory.discoveries.at(-1) || '', 36)}` : '',
    ].filter(Boolean)

    return [
      streamMemoryParts.length > 0 ? `stream_memory: ${streamMemoryParts.join(' | ')}` : '',
      `tempo_state: ${tempoState}`,
      callbackCandidates.length > 0 ? `callback_candidates: ${callbackCandidates.join(' || ')}` : '',
      'continuity_rule: continue the current stream thread when relevant; do not sound like you forgot the previous turn.',
      'gameplay_anchor_rule: mention at least one concrete Minecraft action, item, mob, obstacle, result, or next step from the scene memo or stream memory.',
      'viewer_callback_rule: if a recent viewer joke, taunt, or request still matches the scene, briefly carry it forward before pivoting back to gameplay.',
      tempoState === 'stalled'
        ? 'idle_banter_rule: the game beat may open with one short callback, side-comment, or "さっきの流れ" style remark, but at least half of the line must still point at the current move, obstacle, or plan.'
        : 'momentum_rule: keep pushing the current gameplay thread forward instead of resetting into a generic chant.',
      'style_rotation_rule: vary sentence openings, rhythm, and emotional angle across consecutive lines; do not repeat the same dramatic hook every turn.',
    ].filter(Boolean)
  }

  private extractRecurringChuuniMotifs(lines: string[]): string[] {
    const motifSeeds = [
      '因果',
      '終焉',
      '聖域',
      '世界樹',
      '封印',
      '深淵',
      '儀式',
      '闇',
      '神域',
      '観測',
      '理',
    ] as const

    return motifSeeds
      .filter(token => lines.filter(line => line.includes(token)).length >= 2)
      .slice(0, 4)
  }

  private extractRecentSpeechOpenings(lines: string[]): string[] {
    const seen = new Set<string>()
    const openings: string[] = []

    for (const line of lines.slice(-4)) {
      const normalized = line
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 10)
      if (!normalized || seen.has(normalized)) {
        continue
      }
      seen.add(normalized)
      openings.push(normalized)
    }

    return openings.slice(-3)
  }

  private inferGameplayTempoState(
    mode: 'default' | 'periodic-progress' | 'periodic-idle',
    reason: string | undefined,
    internalSpeak: string,
  ): 'surging' | 'steady' | 'stalled' {
    const normalizedReason = (reason || '').toLowerCase()
    const normalizedMemo = internalSpeak.toLowerCase()

    if (
      mode === 'periodic-idle'
      || normalizedReason.includes('voiced-keepalive')
      || /changed_since_last:\s*none/i.test(internalSpeak)
    ) {
      return 'stalled'
    }

    if (
      normalizedReason.includes('goal-result')
      || /result=(?:success|failed)/.test(normalizedMemo)
      || /changed_since_last:\s*(?!none\b)/.test(normalizedMemo)
    ) {
      return 'surging'
    }

    return 'steady'
  }

  private buildGameplayCallbackCandidates(options: {
    latestViewer: string | undefined
    latestAssistant: string
    latestSpeech: string
    suggestions: string[]
  }): string[] {
    const { latestViewer, latestAssistant, latestSpeech, suggestions } = options
    const candidates = [
      latestViewer ? `viewer-jab=${this.compactPromptText(latestViewer, 44)}` : '',
      latestAssistant ? `your-previous-promise=${this.compactPromptText(latestAssistant, 44)}` : '',
      latestSpeech ? `last-bit=${this.compactPromptText(latestSpeech, 36)}` : '',
      suggestions.at(-1) ? `viewer-suggestion=${this.compactPromptText(suggestions.at(-1) || '', 40)}` : '',
    ].filter(Boolean)

    return Array.from(new Set(candidates)).slice(0, 3)
  }

  /**
   * Sanitize LLM speech output: strip English words, Chinese-only chars, and non-Minecraft hallucinations.
   * Designed for small models (7B) that mix languages and hallucinate fantasy concepts.
   */
  private sanitizeSpeechOutput(content: string): string {
    let text = content
      .replace(/\s+/g, ' ')
      .replace(/^["'`]+|["'`]+$/g, '')

    text = text
      .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}\s.,!?;:'"()\-\u3001\u3002\uFF01\uFF1F\u300C\u300D\u300E\u300F\u3010\u3011\u30FB\u2026\u301C]/gu, '')
      .replace(/\s+/g, ' ')
      .replace(/^[.,!?;:'"()\-\u3001\u3002\uFF01\uFF1F\u300C\u300D\u300E\u300F\u3010\u3011\u30FB\u2026\u301C\u30FC]+/u, '')
      .replace(/([!?\uFF01\uFF1F])\1{7,}/g, '$1$1$1$1$1$1$1')
      .trim()
      .slice(0, 160)

    return text
  }

  private isMechanicalProgressNarration(text: string): boolean {
    const normalized = text.trim()
    if (!normalized) {
      return true
    }

    const explicitInstructionalPatterns: RegExp[] = [
      /^\u307E\u305A/u,
      /\u307E\u3057\u3087\u3046/u,
      /\u3057\u3066\u3044\u307E\u3059/u,
      /\u7D9A\u3051\u307E\u3059/u,
      /\u4F5C\u696D\u4E2D/u,
    ]
    if (explicitInstructionalPatterns.some(pattern => pattern.test(normalized))) {
      return true
    }

    const boilerplatePatterns: RegExp[] = [
      /\b(?:currently|now)\b.{1,24}(?:progress|working on)\b/iu,
      /\b(?:step|phase)\b.{1,16}(?:completed|in progress)\b/iu,
      /\bstatus report\b/iu,
      /\bactive objective\b/iu,
      /\bcontinuing\b.{1,20}action\b/iu,
    ]

    const matchCount = boilerplatePatterns.filter(pattern => pattern.test(normalized)).length
    if (matchCount >= 2) {
      return true
    }
    if (matchCount >= 1 && normalized.length < 15) {
      return true
    }

    return false
  }

  private isMechanicalSocialAck(text: string): boolean {
    const normalized = text.trim()
    if (!normalized) {
      return true
    }

    // Only flag truly mechanical acknowledgement text.
    // Require 2+ pattern matches OR very short text with any single match.
    const boilerplatePatterns: RegExp[] = [
      /\bi hear you\b/iu,
      /\bnoted\b/iu,
      /\bthanks\b/iu,
    ]

    const matchCount = boilerplatePatterns.filter(pattern => pattern.test(normalized)).length
    if (matchCount >= 2) {
      return true
    }
    if (matchCount >= 1 && normalized.length < 15) {
      return true
    }

    return false
  }

  private normalizeSocialComparison(text: string): string {
    return text
      .toLowerCase()
      .replace(/@[\w-]+/g, '')
      .replace(/[\s.!?,:;'"`()[\]{}<>-]/g, '')
      .trim()
  }

  private isSocialReplyParrot(reply: string, sourceText: string): boolean {
    const replyNormalized = this.normalizeSocialComparison(reply)
    const sourceNormalized = this.normalizeSocialComparison(sourceText)
    if (!replyNormalized || !sourceNormalized) {
      return false
    }
    if (replyNormalized === sourceNormalized) {
      return true
    }

    const maxLen = Math.max(replyNormalized.length, sourceNormalized.length)
    const minLen = Math.min(replyNormalized.length, sourceNormalized.length)
    if (maxLen === 0) {
      return false
    }

    const overlap = replyNormalized.includes(sourceNormalized) || sourceNormalized.includes(replyNormalized)
    if (!overlap) {
      return false
    }

    const lengthRatio = minLen / maxLen
    const extra = Math.abs(replyNormalized.length - sourceNormalized.length)
    return lengthRatio >= 0.85 || extra <= 8
  }
}
