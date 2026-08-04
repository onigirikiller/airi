import type { Client } from '@proj-airi/server-sdk'

import type { Logger } from '../../utils/logger'
import type { MineflayerWithAgents } from './types'

import { randomUUID } from 'node:crypto'

import { config } from '../../composables/config'
import { withSharedPlanLock } from './plan-lock'

interface SparkCommandGuidanceOptionLike {
  label?: string
  steps?: string[]
  fallback?: string[]
  rationale?: string
}

interface SparkCommandLike {
  id?: string
  commandId?: string
  eventId?: string
  interrupt?: 'force' | 'soft' | false
  intent?: 'plan' | 'proposal' | 'action' | 'pause' | 'resume' | 'reroute' | 'context'
  ack?: string
  destinations?: string[]
  guidance?: {
    type?: 'proposal' | 'instruction' | 'memory-recall'
    options?: SparkCommandGuidanceOptionLike[]
  }
  contexts?: Array<{
    lane?: string
    headline?: string
    note?: string
  }>
}

interface SparkCommandEventLike {
  data?: SparkCommandLike
}

interface RunnerControlsLike {
  pause?: () => void
  resume?: () => void
  getDebugState?: () => { paused?: boolean }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeDestination(value: unknown): string {
  return normalizeText(value).toLowerCase()
}

function getRunner(bot: MineflayerWithAgents): RunnerControlsLike | null {
  return ((bot as MineflayerWithAgents & { __gameRunner?: RunnerControlsLike }).__gameRunner
    ?? (bot.bot as typeof bot.bot & { __gameRunner?: RunnerControlsLike }).__gameRunner
    ?? null)
}

function describeSparkDestinations(): string[] {
  return ['character']
}

function emitSpark(
  airiClient: Client | undefined,
  state: 'queued' | 'working' | 'done' | 'dropped' | 'blocked' | 'expired',
  note: string,
  command?: SparkCommandLike,
): void {
  if (!airiClient) {
    return
  }

  airiClient.send({
    type: 'spark:emit',
    data: {
      id: randomUUID(),
      eventId: command?.eventId,
      state,
      note,
      destinations: describeSparkDestinations(),
      metadata: {
        from: config.airi.clientName,
        commandId: command?.commandId,
        sparkCommandId: command?.id,
      },
    },
  })
}

export function isSparkCommandForMinecraft(command: SparkCommandLike | undefined, bot: MineflayerWithAgents): boolean {
  const destinations = Array.isArray(command?.destinations) ? command.destinations : []
  if (destinations.length === 0) {
    return false
  }

  const accepted = new Set([
    'minecraft',
    'minecraft-agent',
    'minecraft-bot',
    normalizeDestination(config.airi.clientName),
    normalizeDestination(bot.username),
  ])

  return destinations.some(destination => accepted.has(normalizeDestination(destination)))
}

export function buildGoalFromSparkCommand(command: SparkCommandLike | undefined): string {
  if (!command) {
    return ''
  }

  const options = Array.isArray(command.guidance?.options) ? command.guidance.options : []
  const primaryOption = options[0]
  const steps = Array.isArray(primaryOption?.steps) ? primaryOption.steps.map(normalizeText).filter(Boolean) : []
  const fallbackSteps = Array.isArray(primaryOption?.fallback) ? primaryOption.fallback.map(normalizeText).filter(Boolean) : []
  const contexts = Array.isArray(command.contexts)
    ? command.contexts
        .map((context) => {
          const headline = normalizeText(context?.headline)
          const note = normalizeText(context?.note)
          return [headline, note].filter(Boolean).join(': ')
        })
        .filter(Boolean)
    : []

  const segments = [
    normalizeText(command.ack),
    normalizeText(primaryOption?.label),
    steps.length > 0 ? `Steps: ${steps.join('. ')}` : '',
    fallbackSteps.length > 0 ? `Fallback: ${fallbackSteps.join('. ')}` : '',
    contexts.length > 0 ? `Context: ${contexts.join(' | ')}` : '',
  ].filter(Boolean)

  return segments.join('. ').trim()
}

export async function handleSparkCommandEvent(
  event: SparkCommandEventLike,
  bot: MineflayerWithAgents,
  logger: Logger,
  airiClient?: Client,
): Promise<boolean> {
  const command = event.data
  if (!isSparkCommandForMinecraft(command, bot)) {
    return false
  }

  const intent = command?.intent ?? 'action'
  const runner = getRunner(bot)

  if (intent === 'pause') {
    runner?.pause?.()
    emitSpark(airiClient, 'done', command?.ack || 'Paused Minecraft execution.', command)
    return true
  }

  if (intent === 'resume') {
    runner?.resume?.()
    emitSpark(airiClient, 'done', command?.ack || 'Resumed Minecraft execution.', command)
    return true
  }

  if (intent === 'context') {
    emitSpark(airiClient, 'done', command?.ack || 'Minecraft context received.', command)
    return true
  }

  const goal = buildGoalFromSparkCommand(command)
  if (!goal) {
    emitSpark(airiClient, 'blocked', 'Ignored spark command because no executable goal was provided.', command)
    return true
  }

  emitSpark(airiClient, 'queued', `Queued Minecraft goal: ${goal}`, command)

  const runnerWasPaused = Boolean(runner?.getDebugState?.().paused)
  if (runner && !runnerWasPaused) {
    runner.pause?.()
  }

  try {
    await withSharedPlanLock(bot.username, 'interactive', logger, async () => {
      emitSpark(airiClient, 'working', `Executing Minecraft goal: ${goal}`, command)
      const plan = await bot.planning.createPlan(goal)
      await bot.planning.executePlan(plan)
    })
    emitSpark(airiClient, 'done', command?.ack || `Completed Minecraft goal: ${goal}`, command)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.withError?.(error).warn?.('Spark command execution failed')
    emitSpark(airiClient, 'blocked', `Minecraft goal failed: ${message}`, command)
  }
  finally {
    if (runner && !runnerWasPaused) {
      runner.resume?.()
    }
  }

  return true
}
