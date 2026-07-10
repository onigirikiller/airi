import type { NeuriContext } from 'neuri'
import type { ChatCompletion } from 'neuri/openai'

import type { Logger } from '../../utils/logger'
import type { MineflayerWithAgents } from './types'

import { assistant, system, user } from 'neuri/openai'

import { config } from '../../composables/config'
import { isLikelyOllamaBaseUrl, unloadOllamaModel, withSerializedGpuTask } from '../gpu-coordinator'
import { emitFallbackMonitor } from '../monitor-event-bus'

function hasJapanese(text: string): boolean {
  return /[\u3040-\u30FF\u3400-\u9FFF]/.test(text)
}

function hasLatinLetters(text: string): boolean {
  return /[A-Z]/i.test(text)
}

function shouldForceJapaneseRewrite(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) {
    return false
  }
  return !hasJapanese(normalized) && hasLatinLetters(normalized)
}

async function rewriteToJapanese(
  context: NeuriContext,
  content: string,
  logger: Logger,
): Promise<string> {
  try {
    const rewriteMessages = [
      system('あなたは翻訳者です。入力文を自然な日本語に変換し、変換結果だけを返してください。'),
      user(content),
    ]
    const reroute = async () => await context.reroute('action', rewriteMessages, {
      model: config.speechLlm.model,
    }) as ChatCompletion | { error: { message: string } } & ChatCompletion
    const completion = isLikelyOllamaBaseUrl(config.speechLlm.baseUrl)
      ? await withSerializedGpuTask('ollama:completion.rewrite-japanese', logger, async () => {
          try {
            return await reroute()
          }
          finally {
            await unloadOllamaModel(config.speechLlm.baseUrl, config.speechLlm.model, logger)
          }
        })
      : await reroute()

    if (!completion || 'error' in completion) {
      logger.withFields({ completion }).warn('Japanese rewrite failed; fallback message will be used')
      emitFallbackMonitor({
        scope: 'llm.completion',
        reason: 'japanese-rewrite-fallback',
        detail: 'Japanese rewrite failed; fallback message will be used.',
        from: 'rewrite-to-japanese',
        to: 'fallback-message',
        recoverable: true,
      }, { throttleMs: 30_000 })
      return ''
    }

    const rewritten = (await completion.firstContent())?.trim() || ''
    if (hasJapanese(rewritten)) {
      return rewritten
    }
  }
  catch (error) {
    logger.withError(error).warn('Japanese rewrite failed by exception')
  }

  return ''
}

export async function handleLLMCompletion(context: NeuriContext, bot: MineflayerWithAgents, logger: Logger): Promise<string> {
  logger.log('rerouting...')

  let completion: ChatCompletion | ({ error: { message: string } } & ChatCompletion)
  try {
    const reroute = async () => await context.reroute('action', context.messages, {
      model: config.speechLlm.model,
    }) as ChatCompletion | ({ error: { message: string } } & ChatCompletion)
    completion = isLikelyOllamaBaseUrl(config.speechLlm.baseUrl)
      ? await withSerializedGpuTask('ollama:completion.action', logger, async () => {
          try {
            return await reroute()
          }
          finally {
            await unloadOllamaModel(config.speechLlm.baseUrl, config.speechLlm.model, logger)
          }
        })
      : await reroute()
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const lowered = message.toLowerCase()
    if (
      lowered.includes('assistant message with \'tool_calls\' must be followed by tool messages')
      || lowered.includes('tool_call_id')
      || lowered.includes('invalid_request_error')
    ) {
      logger.withError(error).warn('Chat reroute state mismatch detected; returning safe fallback response')
      emitFallbackMonitor({
        scope: 'llm.completion',
        reason: 'chat-reroute-safe-response',
        detail: message,
        from: 'chat-reroute',
        to: 'safe-fallback-response',
        recoverable: true,
      }, { throttleMs: 15_000 })
      const fallback = 'いま会話ルートの整合で一時的に詰まった。すぐ復帰するから、もう一度聞いて。'
      bot.memory.pushChatMessage(assistant(fallback))
      return fallback
    }
    throw error
  }

  if (!completion || 'error' in completion) {
    logger.withFields({ completion }).error('Completion')
    logger.withFields({ messages: context.messages }).log('messages')
    return (completion as any)?.error?.message ?? 'Unknown error'
  }

  let content = await completion.firstContent()
  if (shouldForceJapaneseRewrite(content)) {
    const rewritten = await rewriteToJapanese(context, content, logger)
    if (rewritten) {
      content = rewritten
      logger.withFields({ rewritten }).log('rewritten to Japanese')
    }
    else {
      content = '日本語で言い直すね。いまは状況を確認しながら進めているところ。'
      emitFallbackMonitor({
        scope: 'llm.completion',
        reason: 'forced-japanese-fallback',
        detail: 'Applied fallback Japanese response because rewrite produced no Japanese output.',
        from: 'rewrite-to-japanese',
        to: 'hardcoded-japanese-response',
        recoverable: true,
      }, { throttleMs: 30_000 })
      logger.log('Applied Japanese fallback response')
    }
  }

  logger.withFields({ usage: completion.usage, content }).log('output')

  bot.memory.pushChatMessage(assistant(content))
  return content
}
