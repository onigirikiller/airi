import type { Client } from '@proj-airi/server-sdk'
import type { Neuri, NeuriContext } from 'neuri'

import type { Logger } from '../../utils/logger'
import type { MineflayerWithAgents } from './types'

import { withRetry } from '@moeru/std'
import { system, user } from 'neuri/openai'

import { handleLLMCompletion } from './completion'
import { requestInteractivePlanFromText } from './interactive-plan'
import { publishAssistantMessageToAiri } from './output'
import { generateStatusPrompt, generateSystemBasicPrompt } from './prompt'

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
    return 'ネットワークまたはAPI接続でエラーが出たよ。少し待ってから再試行するね。'
  }

  if (
    normalized.includes('edge ip restricted')
    || normalized.includes('cloudflare')
    || normalized.includes('quota')
    || normalized.includes('rate limit')
    || normalized.includes('429')
    || normalized.includes('403')
  ) {
    return 'APIの制限に当たったみたい。少し時間を置いて再開するよ。'
  }

  return '会話処理でエラーが出たよ。立て直して再開するね。'
}

function announceErrorToMinecraft(bot: MineflayerWithAgents, message: string): void {
  const now = Date.now()
  if (now - lastErrorChatAt < ERROR_CHAT_COOLDOWN_MS) {
    return
  }

  bot.bot.chat(message.slice(0, 120))
  lastErrorChatAt = now
}

export async function handleChatMessage(
  username: string,
  message: string,
  bot: MineflayerWithAgents,
  agent: Neuri,
  logger: Logger,
  airiClient?: Client,
): Promise<void> {
  logger.withFields({ username, message }).log('Chat message received')
  bot.memory.pushChatMessage(user(`${username}: ${message}`))

  logger.log('thinking...')

  try {
    // Generate response first to avoid blocking on heavy planning.
    // TODO: use chat agent and conversion manager
    const statusPrompt = await generateStatusPrompt(bot)
    const personaSystemPrompt = `${generateSystemBasicPrompt(bot.username)}

追加ルール:
- 返答は短く自然な日本語で、1〜2文を基本にする
- 可能なら先頭で相手コメントに触れる
- 質問にはまず結論で答え、その後に必要な補足を短く付ける
- 二択やトロッコ問題など強制選択の質問では、前提否定せずどちらか一方を即答する
- 「コメントありがとう。反映する」系の汎用文を避け、コメント固有の語を入れて返す
- 同じ言い回しを連続で繰り返さない
- 礼儀は保ちつつ、生意気さと自信の強さは崩さない`
    const content = await agent.handleStateless(
      [
        system(personaSystemPrompt),
        system(`現在のゲーム状態:\n${statusPrompt}`),
        ...bot.memory.chatHistory,
      ],
      async (c: NeuriContext) => {
        logger.log('handling response...')
        return withRetry<NeuriContext, string>(
          ctx => handleLLMCompletion(ctx, bot, logger),
          {
            retry: 3,
            retryDelay: 1000,
            onError: err => logger.withError(err).log('error occurred'),
          },
        )(c)
      },
    )

    if (content) {
      logger.withFields({ content }).log('responded')
      bot.bot.chat(content)
      publishAssistantMessageToAiri(airiClient, content, logger, { voiceMode: 'on', voicePriority: 'high' })
    }

    // Apply intent change in background so chat reply stays responsive.
    requestInteractivePlanFromText(message, bot, logger)
  }
  catch (error) {
    logger.withError(error).error('Failed to process message')
    announceErrorToMinecraft(bot, toUserFacingErrorMessage(error))
  }
}
