import type { Client } from '@proj-airi/server-sdk'
import type { Neuri, NeuriContext } from 'neuri'

import type { Logger } from '../../utils/logger'
import type { MineflayerWithAgents } from './types'

import { withRetry } from '@moeru/std'
import { system, user } from 'neuri/openai'

import { handleLLMCompletion } from './completion'
import { requestInteractivePlanFromText } from './interactive-plan'
import { publishAssistantMessageToAiri } from './output'
import { generateStatusPrompt } from './prompt'

const ERROR_CHAT_COOLDOWN_MS = 15_000
let lastErrorChatAt = 0

function toUserFacingErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const normalized = raw.toLowerCase()

  if (
    normalized.includes('cert_has_expired')
    || normalized.includes('unable_to_verify_leaf_signature')
    || normalized.includes('fetch failed')
  ) {
    return 'ネットワークまたはAPIエラーが発生しました。少し待ってから再試行してください。'
  }

  if (
    normalized.includes('edge ip restricted')
    || normalized.includes('cloudflare')
    || normalized.includes('quota')
    || normalized.includes('rate limit')
    || normalized.includes('429')
    || normalized.includes('403')
  ) {
    return 'APIの制限またはブロックが発生しています。しばらくしてから再試行してください。'
  }

  return '処理中にエラーが発生しました。'
}

function announceErrorToMinecraft(bot: MineflayerWithAgents, message: string): void {
  const now = Date.now()
  if (now - lastErrorChatAt < ERROR_CHAT_COOLDOWN_MS) {
    return
  }

  bot.bot.chat(message.slice(0, 120))
  lastErrorChatAt = now
}

interface DiscordGuildMemberLike {
  displayName?: string
  nickname?: string
  id?: string
}

interface InputEventLike {
  data?: {
    transcription?: string
    text?: string
    discord?: {
      guildMember?: DiscordGuildMemberLike
    }
  }
}

function resolveInputText(event: InputEventLike): string {
  return event.data?.transcription?.trim()
    || event.data?.text?.trim()
    || ''
}

function resolveSenderName(event: InputEventLike): string {
  const member = event.data?.discord?.guildMember
  return member?.displayName || member?.nickname || member?.id || 'User'
}

export async function handleInputTextEvent(
  event: InputEventLike,
  bot: MineflayerWithAgents,
  agent: Neuri,
  logger: Logger,
  airiClient?: Client,
): Promise<void> {
  const inputText = resolveInputText(event)
  if (!inputText) {
    logger.log('Skip empty input event')
    return
  }

  const senderName = resolveSenderName(event)

  logger
    .withFields({
      user: event.data?.discord?.guildMember,
      message: inputText,
    })
    .log('Chat message received')

  const statusPrompt = await generateStatusPrompt(bot)
  bot.memory.pushChatMessage(system(statusPrompt))
  bot.memory.pushChatMessage(user(`${senderName}: ${inputText}`))

  try {
    // Generate response first to avoid blocking on heavy planning.
    const retryHandler = withRetry<NeuriContext, string>(
      ctx => handleLLMCompletion(ctx, bot, logger),
      {
        retry: 3,
        retryDelay: 1000,
      },
    )

    const content = await agent.handleStateless(
      [...bot.memory.chatHistory, system(statusPrompt)],
      async (c: NeuriContext) => {
        logger.log('thinking...')
        return retryHandler(c)
      },
    )

    if (content) {
      logger.withFields({ content }).log('responded')
      bot.bot.chat(content)
      publishAssistantMessageToAiri(airiClient, content, logger, { voiceMode: 'on', voicePriority: 'high' })
    }

    // Apply intent change in background so chat reply stays responsive.
    requestInteractivePlanFromText(inputText, bot, logger)
  }
  catch (error) {
    logger.withError(error).error('Failed to process message')
    announceErrorToMinecraft(bot, toUserFacingErrorMessage(error))
  }
}

export async function handleVoiceInput(
  event: InputEventLike,
  bot: MineflayerWithAgents,
  agent: Neuri,
  logger: Logger,
  airiClient?: Client,
): Promise<void> {
  return handleInputTextEvent(event, bot, agent, logger, airiClient)
}
