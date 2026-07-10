import process from 'node:process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TOKEN_BUDGET_EXIT_CODE } from '../libs/llm-usage/token-budget'
import { AutonomousStreamOrchestrator } from './orchestrator'

vi.mock('../libs/llm-agent/output', () => ({
  publishAssistantMessageToAiri: vi.fn(),
}))

const previousExitCode = process.exitCode

afterEach(() => {
  process.exitCode = previousExitCode
})

describe('autonomous stream orchestrator token budget stop', () => {
  it('interrupts active movement and requests a dedicated process shutdown', () => {
    const stopPathfinder = vi.fn()
    const emit = vi.fn()
    const orchestrator = new AutonomousStreamOrchestrator({
      username: 'AIra',
      ready: true,
      bot: {
        on: vi.fn(),
        off: vi.fn(),
        chat: vi.fn(),
        pathfinder: { stop: stopPathfinder },
        players: {},
      },
      emit,
      memory: {
        actions: [],
        chatHistory: [],
      },
      status: {
        toOneLiner: () => 'ok',
      },
    } as any, {
      onEvent: vi.fn(),
      offEvent: vi.fn(),
      send: vi.fn(),
    } as any) as any

    orchestrator.handleTokenBudgetBlocked()

    expect(stopPathfinder).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith('interrupt')
    expect(process.exitCode).toBe(TOKEN_BUDGET_EXIT_CODE)
  })
})
