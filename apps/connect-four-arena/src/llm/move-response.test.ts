import { describe, expect, it } from 'vitest'

import { selectStructuredResponse } from './connect-four-agent'
import { InvalidMoveResponseError, parseMoveResponse } from './move-response'

describe('parseMoveResponse', () => {
  it('accepts fenced JSON and converts the public column number to a zero-based index', () => {
    expect(parseMoveResponse(`\`\`\`json
{"column": 4, "strategy": "中央を取る", "line": "ここから組み立てます"}
\`\`\``, [0, 1, 2, 3, 4, 5, 6])).toEqual({
      column: 3,
      line: 'ここから組み立てます',
      strategy: '中央を取る',
    })
  })

  it('rejects full columns and malformed output', () => {
    expect(() => parseMoveResponse('{"column": 4}', [0, 1, 2])).toThrow(InvalidMoveResponseError)
    expect(() => parseMoveResponse('column four', [0, 1, 2])).toThrow(InvalidMoveResponseError)
    expect(() => parseMoveResponse('{"column": 2.5}', [0, 1, 2])).toThrow('integer')
  })

  it('uses LM Studio reasoning content only when regular content is empty', () => {
    const structuredReasoning = '{"column":4,"strategy":"中央","line":"行きます"}'

    expect(selectStructuredResponse('', structuredReasoning)).toBe(structuredReasoning)
    expect(selectStructuredResponse('{"column":3}', structuredReasoning)).toBe('{"column":3}')
  })
})
