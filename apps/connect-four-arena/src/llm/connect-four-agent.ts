import type { Message } from '@xsai/shared-chat'

import type { Board, PlayerId } from '../domain/connect-four'
import type { AgentDecision, ConnectionSettings, MatchEvent, PersonaConfig } from '../types'

import { generateText } from '@xsai/generate-text'

import { getAvailableColumns, serializeBoard } from '../domain/connect-four'
import { InvalidMoveResponseError, parseMoveResponse } from './move-response'

const moveResponseFormat = {
  json_schema: {
    name: 'connect_four_move',
    schema: {
      additionalProperties: false,
      properties: {
        column: { maximum: 7, minimum: 1, type: 'integer' },
        line: { type: 'string' },
        strategy: { type: 'string' },
      },
      required: ['column', 'strategy', 'line'],
      type: 'object',
    },
    strict: true,
  },
  type: 'json_schema',
} as const

interface ChooseMoveOptions {
  board: Board
  events: MatchEvent[]
  persona: PersonaConfig
  player: PlayerId
  settings: ConnectionSettings
  signal: AbortSignal
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

function buildSystemPrompt(persona: PersonaConfig): string {
  return `あなたは「${persona.name}」として振る舞います。

人格設定:
${persona.personality}

あなたはいまコネクトフォーを対戦しています。人格を保ちながら、合法手の中から勝つための1手を選んでください。
長い内的推論は出力せず、公開してよい短い作戦要約だけを書いてください。
必ず次のJSONだけを返してください。Markdownや前後の説明は禁止です。
{"column": 1から7の整数, "strategy": "短い作戦要約", "line": "人格らしい一言"}`
}

function buildTurnPrompt(options: ChooseMoveOptions): string {
  const symbol = options.player === 'red' ? 'R' : 'Y'
  const available = getAvailableColumns(options.board).map(column => column + 1)
  const recentMoves = options.events.slice(-12).map(event =>
    `${event.move}. ${event.playerName}: 列${event.column + 1}`,
  )

  return `あなたは ${symbol} です。次の1手を選んでください。

列番号:  1 2 3 4 5 6 7
盤面（上段から下段、. は空き）:
${serializeBoard(options.board)}

合法な列: ${available.join(', ')}
直近の着手:
${recentMoves.length > 0 ? recentMoves.join('\n') : 'まだ着手はありません。'}

JSONのみを返してください。`
}

/**
 * LM Studio exposes some reasoning-model structured outputs through `reasoning_content`. The JSON
 * schema above keeps that fallback limited to the public decision fields instead of free-form chain
 * of thought.
 */
export function selectStructuredResponse(text?: string, reasoningText?: string): string {
  return text?.trim() || reasoningText?.trim() || ''
}

export function formatAgentError(error: unknown): string {
  if (error instanceof TypeError && String(error.message).toLowerCase().includes('fetch'))
    return 'LLMへ接続できませんでした。URL、サーバー起動状態、ブラウザからのCORS許可を確認してください。'

  if (error instanceof Error)
    return error.message

  return 'LLMの応答中に不明なエラーが発生しました。'
}

/**
 * Creates one match-scoped session. Each persona owns an isolated history; only the canonical board
 * and public move log cross the boundary between the two agents.
 */
export function createConnectFourAgentSession() {
  const historyByPlayer: Record<PlayerId, Message[]> = {
    red: [],
    yellow: [],
  }

  async function chooseMove(options: ChooseMoveOptions): Promise<AgentDecision> {
    const userMessage: Message = { role: 'user', content: buildTurnPrompt(options) }
    const history = historyByPlayer[options.player]
    const messages: Message[] = [
      { role: 'system', content: buildSystemPrompt(options.persona) },
      ...history.slice(-6),
      userMessage,
    ]
    const availableColumns = getAvailableColumns(options.board)

    let correction = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await generateText({
        abortSignal: options.signal,
        apiKey: options.settings.apiKey || undefined,
        baseURL: normalizeBaseUrl(options.settings.baseUrl),
        max_tokens: 220,
        messages: correction
          ? [...messages, { role: 'user', content: correction }]
          : messages,
        model: options.settings.model,
        responseFormat: moveResponseFormat,
        temperature: options.settings.temperature,
      })
      const responseText = selectStructuredResponse(response.text, response.reasoningText)

      try {
        const decision = parseMoveResponse(responseText, availableColumns)
        history.push(userMessage, { role: 'assistant', content: responseText })
        return decision
      }
      catch (error) {
        if (!(error instanceof InvalidMoveResponseError) || attempt === 1)
          throw error

        correction = `前の応答は無効でした: ${error.message}\n合法な列は ${availableColumns.map(column => column + 1).join(', ')} です。指定形式のJSONだけを返してください。`
      }
    }

    throw new InvalidMoveResponseError('LLM could not provide a legal move.')
  }

  return { chooseMove }
}
