import type { Logger } from '../utils/logger'
import type {
  AutonomyDecisionContext,
  AutonomyDecisionProvider,
  AutonomyIntent,
} from './types'

import { withSerializedGpuTask } from '../libs/gpu-coordinator'
import { assertOpenAITokenBudget, isTokenBudgetError, recordOpenAIResponseUsage } from '../libs/llm-usage/token-budget'
import { emitFallbackMonitor } from '../libs/monitor-event-bus'
import { buildObjectiveFramework, chooseFallbackObjective, chooseObjectiveForDomains, formatObjectiveFrameworkFacts, getRecommendedObjective, inferSuggestionDomains } from './objectives'
import { buildProgressionPrompt, buildProgressionSnapshot } from './progress'

interface GeminiDecisionProviderOptions {
  enabled: boolean
  apiKey: string
  baseUrl: string
  model: string
  liveModel: string
  useLiveApi: boolean
  temperature: number
  maxOutputTokens: number
  logger: Logger
}

interface GeminiLiveSessionLike {
  sendClientContent: (payload: Record<string, unknown>) => void
  close?: () => void
}

interface GeminiCloseEventLike {
  code?: number
  reason?: string
}

interface PendingLiveDecisionRequest {
  buffer: string
  timer: ReturnType<typeof setTimeout>
  settle: (value?: string, error?: unknown) => void
}

const LIVE_DECISION_REQUEST_TIMEOUT_MS = 20_000
const LIVE_DECISION_MAX_TURNS_PER_SESSION = 24
const DEFAULT_OLLAMA_NUM_CTX = 4096
const FALLBACK_OLLAMA_NUM_CTX = 2048
const OLLAMA_KEEP_ALIVE = '0'
const GEMINI_DECISION_HTTP_TIMEOUT_MS = 45_000
const OPENAI_COMPAT_DECISION_HTTP_TIMEOUT_MS = 45_000
const DECISION_HTTP_MAX_ATTEMPTS = 2

const DEFAULT_INTENT: AutonomyIntent = {
  focus: 'self',
  confidence: 0.4,
}

function normalizeGoalSignature(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[縲後・'`]/g, '')
    .trim()
}

function isLikelyOllamaBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  return normalized.includes('127.0.0.1:11434')
    || normalized.includes('localhost:11434')
    || normalized.includes('ollama')
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  return normalized.includes('api.openai.com')
}

function shouldSendAuthorizationHeader(baseUrl: string): boolean {
  return !isLikelyOllamaBaseUrl(baseUrl)
}

function isOllamaModelLoadFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('model failed to load')
    || normalized.includes('resource limitations')
}

function compactHttpErrorBody(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500)
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'AbortError'
  }

  if (!(error instanceof Error)) {
    return false
  }

  return error.name === 'AbortError'
    || error.message.toLowerCase().includes('aborted')
    || error.message.toLowerCase().includes('timeout')
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

  const thinking = extractOllamaThinkingText(data)
  if (thinking.length > 0) {
    const parsed = extractJsonObject(thinking)
    if (parsed) {
      return JSON.stringify(parsed)
    }
  }

  return ''
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function isGeminiNativeBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  return normalized.includes('generativelanguage.googleapis.com')
}

function isOpenAICompatibleBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  if (!normalized) {
    return false
  }
  if (isGeminiNativeBaseUrl(normalized)) {
    return false
  }

  return normalized.endsWith('/openai')
    || normalized.endsWith('/openai/v1')
    || normalized.endsWith('/v1')
}

function removeCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```'))
    return trimmed

  const firstNewLine = trimmed.indexOf('\n')
  if (firstNewLine < 0)
    return trimmed

  const closingFence = trimmed.lastIndexOf('```')
  if (closingFence <= firstNewLine)
    return trimmed

  return trimmed.slice(firstNewLine + 1, closingFence).trim()
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const normalized = removeCodeFence(text)
  try {
    return JSON.parse(normalized) as Record<string, unknown>
  }
  catch {
    // fall through
  }

  const first = normalized.indexOf('{')
  const last = normalized.lastIndexOf('}')
  if (first >= 0 && last > first) {
    const objectLiteral = normalized.slice(first, last + 1)
    try {
      return JSON.parse(objectLiteral) as Record<string, unknown>
    }
    catch {
      return null
    }
  }
  return null
}

function extractLooseStringField(text: string, field: string): string | undefined {
  const key = `"${field}"`
  const keyIndex = text.indexOf(key)
  if (keyIndex < 0)
    return undefined

  const colonIndex = text.indexOf(':', keyIndex + key.length)
  if (colonIndex < 0)
    return undefined

  const firstQuote = text.indexOf('"', colonIndex + 1)
  if (firstQuote < 0)
    return undefined

  let value = ''
  for (let index = firstQuote + 1; index < text.length; index++) {
    const char = text[index]
    if (char === '"' || char === '\n' || char === '\r' || char === '}')
      break
    value += char
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function extractOpenAITextFromResponse(data: any): string {
  const choice = data?.choices?.[0]
  const choiceText = choice?.text
  if (typeof choiceText === 'string' && choiceText.trim().length > 0) {
    return choiceText.trim()
  }

  const directContent = data?.choices?.[0]?.message?.content
  if (typeof directContent === 'string' && directContent.trim().length > 0) {
    return directContent.trim()
  }

  if (directContent && typeof directContent === 'object') {
    const nestedText = (directContent as any)?.text
    if (typeof nestedText === 'string' && nestedText.trim().length > 0) {
      return nestedText.trim()
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
      return joined
    }
  }

  if (typeof data?.output_text === 'string' && data.output_text.trim().length > 0) {
    return data.output_text.trim()
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
      return joined
    }
  }

  return ''
}

function extractLooseNumberField(text: string, field: string): number | undefined {
  const key = `"${field}"`
  const keyIndex = text.indexOf(key)
  if (keyIndex < 0)
    return undefined

  const colonIndex = text.indexOf(':', keyIndex + key.length)
  if (colonIndex < 0)
    return undefined

  const start = colonIndex + 1
  let end = start
  while (end < text.length) {
    const char = text[end]
    if (char === ',' || char === '\n' || char === '\r' || char === '}')
      break
    end++
  }

  const raw = text.slice(start, end).trim()
  if (!raw)
    return undefined

  const value = Number.parseFloat(raw)
  return Number.isNaN(value) ? undefined : value
}

function extractIntentLoosely(text: string): AutonomyIntent | null {
  const normalized = removeCodeFence(text)
  if (!normalized)
    return null

  const goal = extractLooseStringField(normalized, 'goal')
  const speak = extractLooseStringField(normalized, 'speak')
  if (!goal && !speak)
    return null

  const focusRaw = extractLooseStringField(normalized, 'focus')
  const focus = focusRaw === 'co-op' || focusRaw === 'community' || focusRaw === 'self'
    ? focusRaw
    : 'self'

  const reason = extractLooseStringField(normalized, 'reason')
  const replyToSignalId = extractLooseStringField(normalized, 'replyToSignalId')
  const confidenceRaw = extractLooseNumberField(normalized, 'confidence') ?? 0.55

  return {
    focus,
    confidence: clampConfidence(confidenceRaw),
    goal,
    speak,
    reason,
    replyToSignalId,
  }
}

function toIntent(parsed: Record<string, unknown> | null): AutonomyIntent | null {
  if (!parsed)
    return null

  const focusValue = parsed.focus
  const focus = focusValue === 'co-op' || focusValue === 'community' || focusValue === 'self'
    ? focusValue
    : 'self'

  const goal = typeof parsed.goal === 'string' ? parsed.goal.trim() : undefined
  const speak = typeof parsed.speak === 'string' ? parsed.speak.trim() : undefined
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined
  const replyToSignalId = typeof parsed.replyToSignalId === 'string' ? parsed.replyToSignalId.trim() : undefined
  const confidenceRaw = typeof parsed.confidence === 'number' ? parsed.confidence : 0.55

  const intent: AutonomyIntent = {
    focus,
    confidence: clampConfidence(confidenceRaw),
    goal: goal || undefined,
    speak: speak || undefined,
    reason: reason || undefined,
    replyToSignalId: replyToSignalId || undefined,
  }

  if (!intent.goal && !intent.speak)
    return null

  return intent
}

function truncateContext(context: AutonomyDecisionContext): string {
  const essential: Record<string, unknown> = {
    bot: context.botName,
    goal: context.activeGoal,
    elapsed: context.activeGoalElapsedMs,
    status: context.status,
    world: context.worldState,
    players: context.nearbyPlayers,
    actions: context.recentActions.slice(0, 3),
    signals: context.recentSignals.slice(0, 2).map(s => ({ author: s.author, text: s.text })),
    memory: {
      milestone: context.structuredMemory?.snapshot.activeMilestone || '',
      lastAction: context.structuredMemory?.snapshot.lastActionOutcome || '',
      lastFailure: context.structuredMemory?.snapshot.lastFailureClass || '',
    },
  }

  const serialized = JSON.stringify(essential)
  // Truncate to keep within small model context budget
  return serialized.length > 4000 ? serialized.slice(0, 4000) : serialized
}

function buildDecisionPrompt(
  context: AutonomyDecisionContext,
  recentGoals: string[],
): string {
  const serializedContext = truncateContext(context)
  const recentGoalText = recentGoals.length > 0 ? recentGoals.join(' | ') : '(none)'
  const progressionLines = context.worldFacts
    ? buildProgressionPrompt(buildProgressionSnapshot(context.worldFacts))
    : []
  const plannerMemoryLines = context.structuredMemory?.plannerFacts.slice(0, 6) || []
  const framework = buildObjectiveFramework(context)
  const objectiveLines = formatObjectiveFrameworkFacts(framework, 6)
  const recommendedObjective = getRecommendedObjective(framework)

  const selfGoals = (context.candidateSelfGoals || []).slice(0, 4)
  const selfGoalText = selfGoals.length > 0 ? selfGoals.join(' | ') : ''

  return [
    'Minecraft AI VTuber decision engine. Return one JSON object only.',
    selfGoalText ? `Preferred safe goals: ${selfGoalText}` : '',
    '',
    'JSON schema:',
    '{"goal":"actionable goal","speak":"short Japanese","focus":"self|co-op|community","confidence":0.5,"reason":"brief"}',
    '',
    'Rules:',
    '- goal must be practical and achievable RIGHT NOW with current resources',
    '- Use the world observation to decide. Consider inventory, health, hunger, nearby terrain, notable blocks, nearby entities, and immediate terrain.',
    '- Do NOT set goals requiring items or nearby structures you do not currently have or cannot reasonably reach now.',
    '- speak in Japanese (1 sentence). No repeated goals.',
    '- Prioritize urgent survival/recovery gaps first, then durable progression, then base/interior improvements.',
    '- Use the objective framework facts as gap reports, not as a fixed script.',
    '- If a recommended objective is present, prefer staying close to it unless you can justify a more urgent immediate action from the observation.',
    '',
    `Recent goals: ${recentGoalText}`,
    recommendedObjective ? `Recommended objective: [${recommendedObjective.domain}] ${recommendedObjective.target}` : '',
    ...progressionLines,
    ...objectiveLines,
    ...plannerMemoryLines,
    `Context: ${serializedContext}`,
  ].filter(Boolean).join('\n')
}

function buildIntentRepairPrompt(originalPrompt: string, brokenOutput: string): string {
  const clippedOutput = brokenOutput.replace(/\s+/g, ' ').trim().slice(0, 1200)
  const clippedPrompt = originalPrompt.slice(-2000)

  return [
    'Fix the previous invalid output into one valid JSON object.',
    'Return JSON only. No markdown and no explanation.',
    'Allowed keys: goal, speak, focus, confidence, reason, replyToSignalId.',
    'At least one of goal or speak is required.',
    'focus must be self / co-op / community.',
    'confidence must be between 0.0 and 1.0.',
    '',
    `broken_output: ${clippedOutput || '(empty)'}`,
    '',
    `original_context:\n${clippedPrompt}`,
  ].join('\n')
}

function chooseFallbackGoal(context: AutonomyDecisionContext): string {
  const fallbackObjective = chooseFallbackObjective(buildObjectiveFramework(context))
  return fallbackObjective?.target || context.candidateSelfGoals[0] || 'Survey the nearby terrain for actionable progress'
}

function matchesCandidateSelfGoal(goal: string, context: AutonomyDecisionContext): boolean {
  const signature = normalizeGoalSignature(goal)
  return context.candidateSelfGoals.some(candidate => normalizeGoalSignature(candidate) === signature)
}

function shouldRealignGoalToRecommendedObjective(
  goal: string,
  recommendedGoal: string,
  recommendedUrgency: number,
  recommendedDomain: string,
  context: AutonomyDecisionContext,
): boolean {
  if (recommendedUrgency < 0.8) {
    return false
  }

  const goalSignature = normalizeGoalSignature(goal)
  const recommendedSignature = normalizeGoalSignature(recommendedGoal)
  if (goalSignature === recommendedSignature) {
    return false
  }

  if (matchesCandidateSelfGoal(goal, context)) {
    return true
  }

  const inferredDomains = inferSuggestionDomains(goal)
  const genericExplorationGoal = inferredDomains.length === 1 && inferredDomains[0] === 'explore'
  if (!genericExplorationGoal) {
    return false
  }

  return recommendedUrgency >= 0.9 || recommendedDomain === 'recovery' || recommendedDomain === 'survival'
}

function alignIntentWithObjectiveFramework(intent: AutonomyIntent, context: AutonomyDecisionContext): AutonomyIntent {
  const goal = intent.goal?.trim()
  if (!goal) {
    return intent
  }

  const framework = buildObjectiveFramework(context)
  const recommendedObjective = getRecommendedObjective(framework)
  if (!recommendedObjective) {
    return intent
  }

  if (!shouldRealignGoalToRecommendedObjective(
    goal,
    recommendedObjective.target,
    recommendedObjective.urgency,
    recommendedObjective.domain,
    context,
  )) {
    return intent
  }

  const alignmentReason = `Re-aligned to the top ${recommendedObjective.domain} objective because the returned goal stayed generic under a higher-urgency gap.`
  return {
    ...intent,
    goal: recommendedObjective.target,
    reason: intent.reason ? `${intent.reason} ${alignmentReason}` : alignmentReason,
  }
}

function classifySuggestionGoal(
  context: AutonomyDecisionContext,
  suggestion: string,
): { goal: string, adopted: boolean, reason: string } {
  const normalized = suggestion.toLowerCase()
  const currentGoal = context.activeGoal?.trim() || ''
  const framework = buildObjectiveFramework(context)

  const currentGoalLocked = Boolean(currentGoal)
    && context.activeGoalElapsedMs > 0
    && context.activeGoalElapsedMs < 75_000

  if (currentGoalLocked) {
    return {
      goal: currentGoal,
      adopted: false,
      reason: 'Current goal is still in progress; keep momentum before applying new advice.',
    }
  }

  const selectedObjective = chooseObjectiveForDomains(framework, inferSuggestionDomains(normalized))
  if (selectedObjective) {
    return {
      goal: selectedObjective.target,
      adopted: true,
      reason: `Viewer advice matched objective domain ${selectedObjective.domain}.`,
    }
  }

  return {
    goal: chooseFallbackGoal(context),
    adopted: false,
    reason: 'Viewer advice was not actionable or not aligned with current priorities.',
  }
}

function isGoalClearlyIncomplete(goal: string): boolean {
  const trimmed = goal.trim()
  if (trimmed.length < 7)
    return true

  const hasJapaneseScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(trimmed)
  if (hasJapaneseScript) {
    const incompleteJapaneseTail = ['を', 'に', 'で', 'へ', 'と', 'が', 'の', 'や', 'から', 'まで']
    return incompleteJapaneseTail.some(word => trimmed.endsWith(word))
  }

  if (trimmed.split(/\s+/).length < 2)
    return true

  const badTail = ['around', 'and', 'with', 'for', 'to', 'the', 'a', 'an']
  const lowered = trimmed.toLowerCase()
  return badTail.some(word => lowered.endsWith(` ${word}`))
}

const GOAL_TEXT_ALIASES = new Map<string, string>([
  ['surface_escape', 'Escape to the surface to gather wood'],
  ['surface_recovery', 'Escape to the surface to gather wood'],
  ['dig_upwards_to_reach_surface', 'Dig upwards to reach the surface'],
  ['dig_upward_to_reach_surface', 'Dig upwards to reach the surface'],
  ['escape_to_surface', 'Escape to the surface to gather wood'],
])

export function normalizeIntentGoalText(goal: string | undefined): string | undefined {
  const trimmed = goal?.trim()
  if (!trimmed) {
    return undefined
  }

  const alias = GOAL_TEXT_ALIASES.get(trimmed.toLowerCase())
  if (alias) {
    return alias
  }

  return trimmed
}

function normalizeIntent(intent: AutonomyIntent): AutonomyIntent {
  const normalizedGoal = normalizeIntentGoalText(intent.goal)
  if (!normalizedGoal)
    return intent

  if (!isGoalClearlyIncomplete(normalizedGoal)) {
    return {
      ...intent,
      goal: normalizedGoal,
    }
  }

  return {
    ...intent,
    goal: undefined,
    reason: intent.reason || 'Goal text was incomplete; ignored instead of replacing it with a mechanical fallback goal.',
  }
}

export class RuleBasedAutonomyDecisionProvider implements AutonomyDecisionProvider {
  public async decide(context: AutonomyDecisionContext): Promise<AutonomyIntent> {
    const topSignal = context.recentSignals[0]
    if (topSignal?.source === 'player') {
      return {
        focus: 'co-op',
        confidence: 0.72,
        goal: `Follow ${topSignal.author} and assist their nearby objective`,
        speak: `${topSignal.author}さん、一緒に行こう。近くでサポートするよ。`,
        reason: 'Prioritize nearby player coordination.',
      }
    }

    if (topSignal?.source === 'youtube') {
      const snippet = topSignal.text.replace(/\s+/g, ' ').trim().slice(0, 20) || 'コメント'
      return {
        focus: 'community',
        confidence: 0.58,
        goal: chooseFallbackGoal(context),
        speak: `${topSignal.author}さん、「${snippet}」見えてる。私の手順で最短寄りに進めるよ。`,
        reason: 'Acknowledge recent YouTube comment while maintaining progression.',
        replyToSignalId: topSignal.id,
      }
    }

    const latestSuggestion = context.conversationContext.suggestedAdjustments.at(-1)
    if (latestSuggestion) {
      const selected = classifySuggestionGoal(context, latestSuggestion)
      return {
        focus: 'self',
        confidence: selected.adopted ? 0.56 : 0.46,
        goal: selected.goal,
        speak: selected.adopted
          ? '提案いいね。状況に合わせて次の一手に混ぜる。'
          : '提案は見えてる。今は現行タスクを崩さず進めるよ。',
        reason: `${selected.reason} suggestion="${latestSuggestion}"`,
      }
    }

    return {
      ...DEFAULT_INTENT,
      goal: chooseFallbackGoal(context),
      reason: 'Continue autonomous progression.',
    }
  }
}

export class GeminiAutonomyDecisionProvider implements AutonomyDecisionProvider {
  private liveSession: GeminiLiveSessionLike | null = null
  private liveConnectPromise: Promise<GeminiLiveSessionLike> | null = null
  private liveRequest: PendingLiveDecisionRequest | null = null
  private liveQueue: Promise<string | undefined> = Promise.resolve(undefined)
  private liveSessionKey = ''
  private liveTurnCount = 0
  private recentChosenGoals: string[] = []

  constructor(
    private readonly options: GeminiDecisionProviderOptions,
  ) {}

  private reportFallback(
    reason: string,
    detail: string,
    extra?: Partial<{
      from: string
      to: string
      goal: string
      recoverable: boolean
    }>,
  ): void {
    emitFallbackMonitor({
      scope: 'autonomy.decision',
      reason,
      detail,
      from: extra?.from,
      to: extra?.to,
      goal: extra?.goal,
      recoverable: extra?.recoverable ?? true,
    }, {
      throttleMs: 30_000,
      throttleKey: ['autonomy.decision', reason, extra?.from || '', extra?.to || '', extra?.goal || ''].join('|'),
    })
  }

  public async decide(context: AutonomyDecisionContext): Promise<AutonomyIntent> {
    const hasProviderCredential = this.options.apiKey.trim().length > 0 || isOpenAICompatibleBaseUrl(this.options.baseUrl)
    if (!this.options.enabled || !hasProviderCredential) {
      this.reportFallback(
        'llm-provider-unavailable',
        !this.options.enabled
          ? 'Autonomy LLM is disabled; returning no-op intent instead of a mechanical fallback.'
          : 'Autonomy LLM credentials/base URL unavailable; returning no-op intent instead of a mechanical fallback.',
        {
          from: 'gemini-decision',
          to: 'no-op-intent',
          goal: context.activeGoal || undefined,
        },
      )
      return {
        ...DEFAULT_INTENT,
        reason: !this.options.enabled
          ? 'Autonomy LLM is disabled.'
          : 'Autonomy LLM credentials/base URL unavailable.',
      }
    }

    const prompt = buildDecisionPrompt(context, this.recentChosenGoals.slice(-4))

    try {
      const rawText = this.options.useLiveApi
        ? await this.generateWithLiveApi(prompt)
        : await this.generateWithHttpApi(prompt)
      let parseSourceText = rawText
      let intent = toIntent(extractJsonObject(parseSourceText)) ?? extractIntentLoosely(parseSourceText)

      if (!intent && this.options.useLiveApi) {
        this.options.logger.withFields({ rawText: parseSourceText }).warn('Live decision API returned non-parseable intent, retrying with HTTP API')
        this.reportFallback('live-api-http-retry', 'Live decision API returned non-parseable intent; retrying with HTTP API.', {
          from: 'gemini-live',
          to: 'gemini-http',
          goal: context.activeGoal || undefined,
        })
        const httpRawText = await this.generateWithHttpApi(prompt)
        parseSourceText = httpRawText
        intent = toIntent(extractJsonObject(parseSourceText)) ?? extractIntentLoosely(parseSourceText)
        if (!intent) {
          this.options.logger.withFields({ rawText: parseSourceText }).warn('HTTP decision API retry returned non-parseable intent')
        }
      }

      if (!intent && this.shouldAttemptJsonRepair(context)) {
        this.reportFallback('json-repair-retry', 'Decision output was invalid; retrying with strict JSON repair.', {
          from: 'provider-output',
          to: 'json-repair',
          goal: context.activeGoal || undefined,
        })
        const repairPrompt = buildIntentRepairPrompt(prompt, parseSourceText)
        const repairedRawText = await this.generateWithHttpApi(repairPrompt, { strictJson: true })
        parseSourceText = repairedRawText
        intent = toIntent(extractJsonObject(parseSourceText)) ?? extractIntentLoosely(parseSourceText)
        if (!intent) {
          this.options.logger.withFields({ rawText: parseSourceText }).warn('Decision JSON repair returned non-parseable intent')
        }
      }
      else if (!intent) {
        this.reportFallback(
          'json-repair-skipped',
          'Decision output was invalid; skipping slow JSON repair and letting the rule-based fallback handle gameplay intent selection.',
          {
            from: 'provider-output',
            to: 'no-op-intent',
            goal: context.activeGoal || undefined,
          },
        )
      }

      if (intent) {
        const normalized = alignIntentWithObjectiveFramework(normalizeIntent(intent), context)
        if (intent.goal && !normalized.goal) {
          this.options.logger.withFields({
            originalGoal: intent.goal,
            reason: normalized.reason || '',
          }).warn('Autonomy decision goal was discarded during normalization')
        }
        return this.rememberAndNormalizeIntent(normalized)
      }

      this.options.logger.withFields({ rawText: parseSourceText }).warn('Decision provider returned non-parseable intent, returning no-op intent')
      this.reportFallback('llm-intent-empty', 'Decision provider returned non-parseable intent; returning no-op intent.', {
        from: 'gemini-decision',
        to: 'no-op-intent',
        goal: context.activeGoal || undefined,
      })
      return {
        ...DEFAULT_INTENT,
        reason: 'Autonomy LLM returned non-parseable intent.',
      }
    }
    catch (error) {
      if (isTokenBudgetError(error)) {
        throw error
      }
      this.options.logger.withError(error).warn('Autonomy LLM decision failed, returning no-op intent')
      this.reportFallback('llm-decision-failed', error instanceof Error
        ? `Autonomy LLM decision failed: ${error.message}`
        : `Autonomy LLM decision failed: ${String(error)}`, {
        from: 'gemini-decision',
        to: 'no-op-intent',
        goal: context.activeGoal || undefined,
      })
      return {
        ...DEFAULT_INTENT,
        reason: error instanceof Error
          ? `Autonomy LLM decision failed: ${error.message}`
          : `Autonomy LLM decision failed: ${String(error)}`,
      }
    }
  }

  private shouldAttemptJsonRepair(context: AutonomyDecisionContext): boolean {
    const baseUrl = normalizeBaseUrl(this.options.baseUrl)
    if (!isLikelyOllamaBaseUrl(baseUrl)) {
      return true
    }

    return context.recentSignals.some(signal =>
      (signal.source === 'player' || signal.source === 'youtube')
      && signal.importance >= 0.85,
    )
  }

  private rememberAndNormalizeIntent(intent: AutonomyIntent): AutonomyIntent {
    const goal = (intent.goal || '').trim()
    if (goal.length > 0) {
      const goalSignature = normalizeGoalSignature(goal)
      const lastGoalSignature = this.recentChosenGoals.length > 0
        ? normalizeGoalSignature(this.recentChosenGoals[this.recentChosenGoals.length - 1]!)
        : ''
      if (goalSignature !== lastGoalSignature) {
        this.recentChosenGoals.push(goal)
        if (this.recentChosenGoals.length > 8) {
          this.recentChosenGoals = this.recentChosenGoals.slice(-8)
        }
      }
    }

    return {
      ...intent,
      ...(goal.length > 0 ? { goal } : {}),
      focus: intent.focus || 'self',
      confidence: clampConfidence(intent.confidence ?? 0.55),
    }
  }

  private resolveLiveDecisionModel(): string {
    const liveModel = this.options.liveModel.trim()
    if (liveModel.length > 0) {
      return liveModel
    }

    return this.options.model.trim()
  }

  private resolveLiveSessionKey(model: string): string {
    const baseUrl = this.options.baseUrl.trim().replace(/\/+$/, '')
    return [this.options.apiKey, baseUrl, model].join('::')
  }

  private closeLiveSession(closeSocket = true): void {
    const activeSession = this.liveSession
    this.liveSession = null
    this.liveConnectPromise = null
    this.liveSessionKey = ''
    this.liveTurnCount = 0
    if (!activeSession || !closeSocket) {
      return
    }

    try {
      activeSession.close?.()
    }
    catch {
      // noop
    }
  }

  private settleLiveRequest(value?: string, error?: unknown): void {
    const request = this.liveRequest
    if (!request) {
      return
    }

    this.liveRequest = null
    clearTimeout(request.timer)
    request.settle(value, error)
  }

  private async ensureLiveSession(model: string): Promise<GeminiLiveSessionLike> {
    const sessionKey = this.resolveLiveSessionKey(model)
    if (
      this.liveSession
      && (this.liveSessionKey !== sessionKey || this.liveTurnCount >= LIVE_DECISION_MAX_TURNS_PER_SESSION)
    ) {
      this.closeLiveSession()
    }

    if (this.liveSession) {
      return this.liveSession
    }

    if (this.liveConnectPromise) {
      return this.liveConnectPromise
    }

    this.liveConnectPromise = (async () => {
      const moduleValue = await import('@google/genai')
      const GoogleGenAI = (moduleValue as any)?.GoogleGenAI || (moduleValue as any)?.default?.GoogleGenAI

      if (typeof GoogleGenAI !== 'function') {
        throw new TypeError('GoogleGenAI export not found')
      }

      const baseUrl = this.options.baseUrl.trim().replace(/\/+$/, '')
      const useCustomBaseUrl = baseUrl.length > 0 && !baseUrl.includes('generativelanguage.googleapis.com')
      const client = new GoogleGenAI({
        apiKey: this.options.apiKey,
        ...(useCustomBaseUrl
          ? {
              httpOptions: {
                baseUrl,
              },
            }
          : {}),
      })

      const connected = await client.live.connect({
        model,
        config: {
          responseModalities: ['TEXT'],
        },
        callbacks: {
          onmessage: (message: any) => {
            const request = this.liveRequest
            if (!request) {
              return
            }

            const delta = this.extractLiveText(message)
            if (delta) {
              request.buffer += delta
            }

            const turnComplete = Boolean(message?.serverContent?.turnComplete)
            const generationComplete = Boolean(message?.serverContent?.generationComplete)
            if (turnComplete || generationComplete) {
              this.settleLiveRequest(request.buffer.trim())
              this.liveTurnCount++
              if (this.liveTurnCount >= LIVE_DECISION_MAX_TURNS_PER_SESSION) {
                this.closeLiveSession()
              }
            }
          },
          onerror: (error: unknown) => {
            this.options.logger.withError(error).warn('Live decision session error')
            this.settleLiveRequest(undefined, error)
            this.closeLiveSession()
          },
          onclose: (event: GeminiCloseEventLike) => {
            const request = this.liveRequest
            if (request) {
              const buffered = request.buffer.trim()
              if (buffered.length > 0) {
                this.settleLiveRequest(buffered)
              }
              else {
                this.settleLiveRequest(undefined, new Error(`Live decision session closed without text output. code=${event?.code ?? 'unknown'} reason=${event?.reason ?? ''}`))
              }
            }
            this.closeLiveSession(false)
          },
        },
      })

      this.liveSession = connected
      this.liveSessionKey = sessionKey
      this.options.logger.withFields({ model }).log('Live decision session connected')
      return connected
    })()

    try {
      return await this.liveConnectPromise
    }
    finally {
      this.liveConnectPromise = null
    }
  }

  private async requestLiveDecision(prompt: string): Promise<string> {
    const model = this.resolveLiveDecisionModel()
    const task = this.liveQueue.then(async () => {
      const session = await this.ensureLiveSession(model)
      return await new Promise<string>((resolve, reject) => {
        if (this.liveRequest) {
          reject(new Error('Live decision request already in flight'))
          return
        }

        const request: PendingLiveDecisionRequest = {
          buffer: '',
          timer: setTimeout(() => {
            const buffered = request.buffer.trim()
            if (buffered.length > 0) {
              this.settleLiveRequest(buffered)
              return
            }
            this.settleLiveRequest(undefined, new Error('Live decision request timed out without text output'))
          }, LIVE_DECISION_REQUEST_TIMEOUT_MS),
          settle: (value, error) => {
            if (error) {
              reject(error)
              return
            }
            const normalized = (value || '').trim()
            if (!normalized) {
              reject(new Error('Live decision request produced empty output'))
              return
            }
            resolve(normalized)
          },
        }

        this.liveRequest = request

        try {
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: prompt }] }],
            turnComplete: true,
          })
        }
        catch (error) {
          this.settleLiveRequest(undefined, error)
        }
      })
    })

    this.liveQueue = task
      .then(() => undefined)
      .catch(() => undefined)

    return await task
  }

  private async generateWithLiveApi(prompt: string): Promise<string> {
    try {
      return await this.requestLiveDecision(prompt)
    }
    catch (error) {
      this.options.logger.withError(error).warn('Live decision API unavailable, falling back to HTTP API')
      return this.generateWithHttpApi(prompt)
    }
  }

  private extractLiveText(message: any): string {
    if (typeof message === 'string')
      return message

    const directText = message?.text
    if (typeof directText === 'string')
      return directText

    const outputText = message?.serverContent?.outputTranscription?.text
    if (typeof outputText === 'string')
      return outputText

    const modelTurnParts = message?.serverContent?.modelTurn?.parts
    if (Array.isArray(modelTurnParts)) {
      return modelTurnParts
        .map(part => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
    }

    return ''
  }

  private async generateWithHttpApi(
    prompt: string,
    options?: { strictJson?: boolean },
  ): Promise<string> {
    const baseUrl = normalizeBaseUrl(this.options.baseUrl)
    const isOllama = isLikelyOllamaBaseUrl(baseUrl)
    const maxDecisionTokens = Math.min(this.options.maxOutputTokens, isOllama ? 128 : 192)
    const strictJson = options?.strictJson ?? false
    if (isOpenAICompatibleBaseUrl(baseUrl)) {
      return this.generateWithOpenAICompatible(baseUrl, prompt, { strictJson })
    }

    const versionPrefix = baseUrl.includes('/v1beta')
      ? baseUrl
      : `${baseUrl}/v1beta`
    const url = `${versionPrefix}/models/${encodeURIComponent(this.options.model)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`

    let lastError: unknown
    for (let attempt = 0; attempt < DECISION_HTTP_MAX_ATTEMPTS; attempt++) {
      const abortController = new AbortController()
      const abortTimer = setTimeout(() => abortController.abort(), GEMINI_DECISION_HTTP_TIMEOUT_MS)
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          signal: abortController.signal,
          body: JSON.stringify({
            generationConfig: {
              temperature: strictJson ? 0 : this.options.temperature,
              maxOutputTokens: maxDecisionTokens,
              responseMimeType: 'application/json',
            },
            contents: [{
              role: 'user',
              parts: [{ text: prompt }],
            }],
          }),
        })

        if (!response.ok) {
          throw new Error(`Decision HTTP API error: ${response.status} ${response.statusText}`)
        }

        const data = await response.json() as any
        const parts = data?.candidates?.[0]?.content?.parts
        if (!Array.isArray(parts)) {
          throw new TypeError('Decision HTTP API returned unexpected payload')
        }

        return parts
          .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
          .join('')
          .trim()
      }
      catch (error) {
        lastError = error
        if (isAbortLikeError(error) && attempt < DECISION_HTTP_MAX_ATTEMPTS - 1) {
          this.options.logger.withFields({
            attempt,
            nextAttempt: attempt + 1,
            timeoutMs: GEMINI_DECISION_HTTP_TIMEOUT_MS,
          }).warn('Gemini native decision request aborted or timed out, retrying once')
          continue
        }
        throw error
      }
      finally {
        clearTimeout(abortTimer)
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Decision HTTP API failed')
  }

  private async generateWithOpenAICompatible(
    baseUrl: string,
    prompt: string,
    options?: { strictJson?: boolean },
  ): Promise<string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (this.options.apiKey.trim() && shouldSendAuthorizationHeader(baseUrl)) {
      headers.authorization = `Bearer ${this.options.apiKey}`
    }

    const strictJson = options?.strictJson ?? false
    const isOpenAI = isOfficialOpenAIBaseUrl(baseUrl)
    const temperature = strictJson
      ? 0
      : Math.min(0.3, Math.max(0, this.options.temperature))
    const isOllamaEndpoint = isLikelyOllamaBaseUrl(baseUrl)
    const maxDecisionTokens = Math.min(this.options.maxOutputTokens, isOllamaEndpoint ? 128 : 192)

    const messages = [
      { role: 'system', content: 'Return exactly one JSON object. No markdown, no explanation. Allowed keys: goal, speak, focus, confidence, reason, replyToSignalId. focus must be one of: self, co-op, community. At least one of goal or speak must be present.' },
      { role: 'user', content: prompt },
    ]

    if (isOllamaEndpoint) {
      const ollamaBase = baseUrl.replace(/\/v1\/?$/, '')
      const responseFormat = {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          speak: { type: 'string' },
          focus: { type: 'string', enum: ['self', 'co-op', 'community'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          replyToSignalId: { type: 'string' },
        },
      }

      const executeOllamaChat = async (
        tokenBudget: number,
        ollamaNumCtx = DEFAULT_OLLAMA_NUM_CTX,
      ): Promise<{ content: string, data: any }> => {
        const abortController = new AbortController()
        const abortTimer = setTimeout(() => abortController.abort(), 45_000)
        const response = await fetch(`${ollamaBase}/api/chat`, {
          method: 'POST',
          headers,
          signal: abortController.signal,
          body: JSON.stringify({
            model: this.options.model,
            think: false,
            messages,
            format: responseFormat,
            stream: false,
            keep_alive: OLLAMA_KEEP_ALIVE,
            options: {
              repeat_penalty: 1.15,
              temperature,
              top_p: strictJson ? 0.2 : 0.4,
              num_predict: tokenBudget,
              num_ctx: ollamaNumCtx,
            },
          }),
        })
        clearTimeout(abortTimer)

        if (!response.ok) {
          const errorText = await response.text().catch(() => '')
          const detail = compactHttpErrorBody(errorText)
          throw new Error(`Decision Ollama API error: ${response.status} ${response.statusText}${detail ? ` body=${detail}` : ''}`)
        }

        const data = await response.json() as any
        return {
          content: extractOllamaChatContent(data),
          data,
        }
      }

      return await withSerializedGpuTask('ollama:autonomy.decision', this.options.logger, async () => {
        let first: { content: string, data: any }
        try {
          first = await executeOllamaChat(maxDecisionTokens)
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (isOllamaModelLoadFailure(message)) {
            this.options.logger.withFields({
              model: this.options.model,
              numCtx: FALLBACK_OLLAMA_NUM_CTX,
            }).warn('Autonomy decision retrying Ollama load with reduced context window')
            first = await executeOllamaChat(maxDecisionTokens, FALLBACK_OLLAMA_NUM_CTX)
          }
          else {
            throw error
          }
        }

        if (first.content.length > 0) {
          return first.content
        }

        const firstThinking = extractOllamaThinkingText(first.data)
        if (firstThinking.length > 0) {
          const retryTokenBudget = Math.max(maxDecisionTokens, Math.min(this.options.maxOutputTokens, 512))
          if (retryTokenBudget > maxDecisionTokens) {
            this.options.logger.withFields({
              model: this.options.model,
              initialTokenBudget: maxDecisionTokens,
              retryTokenBudget,
            }).warn('Autonomy decision retrying Ollama after thinking-only response consumed the initial token budget')
            const retried = await executeOllamaChat(retryTokenBudget)
            if (retried.content.length > 0) {
              return retried.content
            }
            first = retried
          }
        }

        const detail = compactHttpErrorBody(JSON.stringify(first.data))
        throw new Error(`Decision Ollama API returned empty content${detail ? ` body=${detail}` : ''}`)
      })
    }

    const payload: Record<string, unknown> = {
      model: this.options.model,
      messages,
    }

    if (!isOpenAI) {
      payload.temperature = temperature
      payload.top_p = strictJson ? 0.2 : 0.4
      payload.frequency_penalty = 0
      payload.presence_penalty = 0
      payload.max_tokens = maxDecisionTokens
      payload.response_format = { type: 'json_object' }
    }
    else {
      payload.reasoning_effort = 'low'
      // Strict structured output: guarantees a parseable intent and removes
      // the repair-prompt retry round trips from the token budget.
      payload.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'autonomy_intent',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              goal: { type: ['string', 'null'], description: 'Actionable goal achievable right now, or null to stay idle' },
              speak: { type: ['string', 'null'], description: 'Short Japanese line for the stream, or null' },
              focus: { type: 'string', enum: ['self', 'co-op', 'community'] },
              confidence: { type: 'number' },
              reason: { type: 'string' },
              replyToSignalId: { type: ['string', 'null'] },
            },
            required: ['goal', 'speak', 'focus', 'confidence', 'reason', 'replyToSignalId'],
          },
        },
      }
      payload.max_completion_tokens = maxDecisionTokens
    }

    const executeCompletion = async (
      tokenBudget: number,
    ): Promise<{ content: string, data: any }> => {
      const requestPayload: Record<string, unknown> = { ...payload }
      if (isOpenAI) {
        requestPayload.max_completion_tokens = tokenBudget
      }
      else {
        requestPayload.max_tokens = tokenBudget
      }

      let lastError: unknown
      for (let attempt = 0; attempt < DECISION_HTTP_MAX_ATTEMPTS; attempt++) {
        const abortController = new AbortController()
        const abortTimer = setTimeout(() => abortController.abort(), OPENAI_COMPAT_DECISION_HTTP_TIMEOUT_MS)
        try {
          assertOpenAITokenBudget(baseUrl, 'autonomy.decision', this.options.model)
          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            signal: abortController.signal,
            body: JSON.stringify(requestPayload),
          })

          if (!response.ok) {
            const errorText = await response.text().catch(() => '')
            recordOpenAIResponseUsage({
              baseUrl,
              model: this.options.model,
              scope: 'autonomy.decision',
              promptText: JSON.stringify(requestPayload),
              completionText: errorText,
            })
            const compact = compactHttpErrorBody(errorText)
            const detail = compact ? ` body=${compact}` : ''
            throw new Error(`Decision OpenAI-compatible API error: ${response.status} ${response.statusText}${detail}`)
          }

          const data = await response.json() as any
          recordOpenAIResponseUsage({
            baseUrl,
            model: this.options.model,
            scope: 'autonomy.decision',
            usage: data?.usage,
            promptText: JSON.stringify(requestPayload),
            completionText: JSON.stringify(data),
          })
          return {
            content: extractOpenAITextFromResponse(data),
            data,
          }
        }
        catch (error) {
          if (isTokenBudgetError(error)) {
            throw error
          }
          lastError = error
          if (isAbortLikeError(error) && attempt < DECISION_HTTP_MAX_ATTEMPTS - 1) {
            this.options.logger.withFields({
              attempt,
              nextAttempt: attempt + 1,
              timeoutMs: OPENAI_COMPAT_DECISION_HTTP_TIMEOUT_MS,
              baseUrl,
            }).warn('OpenAI-compatible decision request aborted or timed out, retrying once')
            continue
          }
          throw error
        }
        finally {
          clearTimeout(abortTimer)
        }
      }

      throw lastError instanceof Error ? lastError : new Error('Decision OpenAI-compatible API failed')
    }

    const first = await executeCompletion(maxDecisionTokens)

    if (first.content.length > 0) {
      return first.content
    }

    if (isOpenAI && first.data?.choices?.[0]?.finish_reason === 'length') {
      const retryTokenBudget = Math.min(2048, Math.max(1024, maxDecisionTokens * 6))
      const retried = await executeCompletion(retryTokenBudget)
      if (retried.content.length > 0) {
        return retried.content
      }
      const compact = JSON.stringify(retried.data).slice(0, 500)
      const detail = compact ? ` body=${compact}` : ''
      throw new Error(`Decision OpenAI-compatible API returned empty content after retry${detail}`)
    }

    const compact = JSON.stringify(first.data).slice(0, 500)
    const detail = compact ? ` body=${compact}` : ''
    throw new Error(`Decision OpenAI-compatible API returned empty content${detail}`)
  }
}
