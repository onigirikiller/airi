import { describe, expect, it, vi } from 'vitest'

import { __resetMonitorFallbackThrottleStateForTests, monitorBus } from '../monitor-event-bus'
import { handleLLMCompletion } from './completion'

function createLoggerStub() {
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withFields: vi.fn(),
    withError: vi.fn(),
  }
  logger.withFields.mockReturnValue(logger)
  logger.withError.mockReturnValue(logger)
  return logger
}

describe('handleLLMCompletion', () => {
  it('returns a safe fallback when tool call chain is broken', async () => {
    __resetMonitorFallbackThrottleStateForTests()
    const handler = vi.fn()
    monitorBus.onMonitor(handler)
    const context = {
      messages: [],
      reroute: vi.fn(async () => {
        throw new Error('An assistant message with \'tool_calls\' must be followed by tool messages responding to each \'tool_call_id\'')
      }),
    } as any

    const chatHistory: any[] = []
    const bot = {
      memory: {
        chatHistory,
        pushChatMessage: (msg: any) => { chatHistory.push(msg) },
      },
    } as any
    const logger = createLoggerStub() as any

    const result = await handleLLMCompletion(context, bot, logger)
    monitorBus.offMonitor(handler)

    expect(result).toContain('復帰')
    expect(JSON.stringify(bot.memory.chatHistory)).toContain('復帰')
  })
})
