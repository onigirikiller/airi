import type { AgentDecision } from '../types'

export class InvalidMoveResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMoveResponseError'
  }
}

function extractJsonObject(content: string): string {
  const withoutFence = content
    .replace(/^\s*```(?:json|JSON)?\s*/, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')

  if (start === -1 || end < start)
    throw new InvalidMoveResponseError('LLM response did not contain a JSON object.')

  return withoutFence.slice(start, end + 1)
}

/** Validates the model boundary before a response is allowed to mutate the shared game board. */
export function parseMoveResponse(content: string, availableColumns: number[]): AgentDecision {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonObject(content))
  }
  catch (error) {
    if (error instanceof InvalidMoveResponseError)
      throw error
    throw new InvalidMoveResponseError('LLM response was not valid JSON.')
  }

  if (!parsed || typeof parsed !== 'object')
    throw new InvalidMoveResponseError('LLM response must be an object.')

  const candidate = parsed as Record<string, unknown>
  const oneBasedColumn = candidate.column
  if (!Number.isInteger(oneBasedColumn))
    throw new InvalidMoveResponseError('The selected column must be an integer.')

  const column = Number(oneBasedColumn) - 1
  if (!availableColumns.includes(column))
    throw new InvalidMoveResponseError(`Column ${String(oneBasedColumn)} is not currently legal.`)

  const strategy = typeof candidate.strategy === 'string' ? candidate.strategy.trim() : ''
  const line = typeof candidate.line === 'string' ? candidate.line.trim() : ''

  return {
    column,
    line: line || `列${oneBasedColumn}で勝負します。`,
    strategy: strategy || '盤面から最善と思う手を選びました。',
  }
}
