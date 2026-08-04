import type { Logger } from '../../utils/logger'
import type { MineflayerWithAgents } from './types'

import { withSharedPlanLock } from './plan-lock'

const INTERACTIVE_PLAN_TRIGGER_COOLDOWN_MS = 4_000
const INTERACTIVE_PLAN_MAX_BATCH_SIZE = 2
const INTERACTIVE_PLAN_QUEUE_TTL_MS = 30_000
const INTERACTIVE_PLAN_RESTART_DELAY_MS = 2_000

let interactivePlanRunning = false
let queuedGoal: { text: string, at: number } | null = null
let queuedRestartTimer: ReturnType<typeof setTimeout> | null = null
let lastInteractiveTriggerAt = 0

function isSmallTalkText(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) {
    return true
  }

  const smallTalkEn = [
    'hi',
    'hello',
    'hey',
    'thanks',
    'thank you',
    'how are you',
    'what are you doing',
    'who are you',
  ]
  if (smallTalkEn.some(keyword => normalized.includes(keyword))) {
    return true
  }

  const smallTalkJa = [
    'こんにちは',
    'こんばんは',
    'おはよう',
    'ありがとう',
    '元気',
    '調子',
    '雑談',
    '何してる',
    'なにしてる',
    '今どこ',
  ]
  return smallTalkJa.some(keyword => text.includes(keyword))
}

function looksActionSuggestion(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3) {
    return false
  }
  if (isSmallTalkText(trimmed)) {
    return false
  }

  const lower = trimmed.toLowerCase()
  const actionEn = [
    'gather',
    'collect',
    'mine',
    'craft',
    'build',
    'explore',
    'follow',
    'attack',
    'move',
    'start',
    'continue',
    'do this',
    'let\'s',
  ]
  if (actionEn.some(keyword => lower.includes(keyword))) {
    return true
  }

  const actionJa = [
    '集め',
    '掘',
    '採掘',
    'クラフト',
    '作っ',
    '作る',
    '建',
    '探索',
    '探し',
    '倒',
    '戦っ',
    '進ん',
    '移動',
    '行っ',
    'して',
    'してほしい',
    'やって',
    'お願い',
    '手伝',
    'したらどう',
  ]
  return actionJa.some(keyword => trimmed.includes(keyword))
}

async function runInteractivePlanLoop(
  initialGoal: string,
  bot: MineflayerWithAgents,
  logger: Logger,
): Promise<void> {
  interactivePlanRunning = true

  try {
    let currentGoal: string | null = initialGoal
    let executedGoals = 0
    while (currentGoal) {
      try {
        await withSharedPlanLock(bot.username, 'interactive', logger, async () => {
          logger.withField?.('goal', currentGoal).log?.('Interactive plan requested from chat')
          const plan = await bot.planning.createPlan(currentGoal!)
          logger.withFields?.({ plan }).log?.('Interactive plan created')
          await bot.planning.executePlan(plan)
          logger.log?.('Interactive plan executed')
        })
      }
      catch (error) {
        logger.withError?.(error).warn?.('Interactive plan execution failed')
      }

      executedGoals++
      if (executedGoals >= INTERACTIVE_PLAN_MAX_BATCH_SIZE && queuedGoal) {
        logger.log?.('Interactive plan batch limit reached, deferring queued goal to avoid starving autonomy')
        scheduleQueuedInteractivePlan(bot, logger)
        break
      }

      currentGoal = consumeQueuedGoal()
    }
  }
  finally {
    interactivePlanRunning = false
  }
}

function consumeQueuedGoal(now = Date.now()): string | null {
  if (!queuedGoal) {
    return null
  }
  if (now - queuedGoal.at > INTERACTIVE_PLAN_QUEUE_TTL_MS) {
    queuedGoal = null
    return null
  }

  const nextGoal = queuedGoal.text
  queuedGoal = null
  return nextGoal
}

function scheduleQueuedInteractivePlan(bot: MineflayerWithAgents, logger: Logger): void {
  if (queuedRestartTimer) {
    return
  }

  queuedRestartTimer = setTimeout(() => {
    queuedRestartTimer = null
    if (interactivePlanRunning) {
      return
    }

    const nextGoal = consumeQueuedGoal()
    if (!nextGoal) {
      return
    }

    lastInteractiveTriggerAt = Date.now()
    void runInteractivePlanLoop(nextGoal, bot, logger)
  }, INTERACTIVE_PLAN_RESTART_DELAY_MS)
}

export function requestInteractivePlanFromText(
  text: string,
  bot: MineflayerWithAgents,
  logger: Logger,
): void {
  if (!looksActionSuggestion(text)) {
    return
  }

  const now = Date.now()
  if (queuedRestartTimer) {
    queuedGoal = { text, at: now }
    logger.withField?.('goal', text).log?.('Interactive plan request updated while restart is deferred')
    return
  }
  if (interactivePlanRunning) {
    queuedGoal = { text, at: now }
    logger.withField?.('goal', text).log?.('Interactive plan queued while previous run is active')
    return
  }
  if (now - lastInteractiveTriggerAt < INTERACTIVE_PLAN_TRIGGER_COOLDOWN_MS) {
    logger.log?.('Interactive plan request skipped by cooldown')
    return
  }
  lastInteractiveTriggerAt = now

  void runInteractivePlanLoop(text, bot, logger)
}

export function __resetInteractivePlanStateForTests(): void {
  interactivePlanRunning = false
  queuedGoal = null
  if (queuedRestartTimer) {
    clearTimeout(queuedRestartTimer)
    queuedRestartTimer = null
  }
  lastInteractiveTriggerAt = 0
}
