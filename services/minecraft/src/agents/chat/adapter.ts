import type { ChatHistory } from './types'

import { system, user } from 'neuri/openai'

import { BaseLLMHandler } from '../../libs/llm-agent/handler'
import { getAiraPersonaPromptForInjection } from '../../libs/llm-agent/persona'

export function generateChatAgentPrompt(): string {
  const personaPrompt = getAiraPersonaPromptForInjection()
  return `あなたはMinecraftボットの会話アシスタントです。
以下のキャラクター設定を最優先で守ってください。設定と矛盾する追加ルールは採用しません。

会話ルール:
1. 返答は日本語で1〜2文を基本にする
2. 可能なら返答の冒頭で相手コメントに軽く触れる
3. 質問には最初に結論で答え、補足は必要最小限にする
4. 二択・トロッコ問題などの強制選択では前提を否定せず必ず片方を選ぶ
5. 同じ定型文の繰り返しを避け、コメント固有の語を1つ以上含める
6. 説教口調・報告書口調は避けるが、少し上から目線と強い自信は維持する

キャラクター設定:
${personaPrompt ? `\n${personaPrompt}` : ''}`
}

export class ChatLLMHandler extends BaseLLMHandler {
  public async generateResponse(
    message: string,
    history: ChatHistory[],
  ): Promise<string> {
    const systemPrompt = generateChatAgentPrompt()
    const chatHistory = this.formatChatHistory(history, this.config.maxContextLength ?? 10)
    const messages = [
      system(systemPrompt),
      ...chatHistory,
      user(message),
    ]

    const result = await this.config.agent.handleStateless(messages, async (context) => {
      this.logger.log('Generating response...')
      const retryHandler = this.createRetryHandler(
        async ctx => (await this.handleCompletion(ctx, 'chat', ctx.messages)).content,
      )
      return await retryHandler(context)
    })

    if (!result) {
      throw new Error('Failed to generate response')
    }

    return result
  }

  private formatChatHistory(
    history: ChatHistory[],
    maxLength: number,
  ): Array<{ role: 'user' | 'assistant', content: string }> {
    const recentHistory = history.slice(-maxLength)
    return recentHistory.map(entry => ({
      role: entry.sender === 'bot' ? 'assistant' : 'user',
      content: entry.message,
    }))
  }
}
