import type { Neuri } from 'neuri'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handleLLMCompletion } from './completion'
import { __resetInteractivePlanStateForTests } from './interactive-plan'
import { generateStatusPrompt } from './prompt'
import { handleInputTextEvent, handleVoiceInput } from './voice'

vi.mock('./completion', () => ({
  handleLLMCompletion: vi.fn(async () => 'On it'),
}))

vi.mock('./prompt', () => ({
  generateStatusPrompt: vi.fn(async () => 'status prompt'),
}))

function createLoggerStub() {
  const logger = {
    log: vi.fn(),
    error: vi.fn(),
    withFields: vi.fn(),
    withError: vi.fn(),
  }
  logger.withFields.mockReturnValue(logger)
  logger.withError.mockReturnValue(logger)
  return logger
}

function createBotStub() {
  const plan = { goal: 'collect wood', steps: [] }

  return {
    plan,
    bot: {
      chat: vi.fn(),
    },
    memory: {
      chatHistory: [] as any[],
      pushChatMessage(msg: any) { this.chatHistory.push(msg) },
    },
    planning: {
      createPlan: vi.fn(async () => plan),
      executePlan: vi.fn(async () => undefined),
    },
  }
}

function createAgentStub() {
  const agent = {
    handleStateless: vi.fn(async (_messages, callback) => {
      return await callback({ messages: [] as any[] } as any)
    }),
  }
  return agent as unknown as Neuri
}

describe('handleInputTextEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetInteractivePlanStateForTests()
  })

  it('processes text input event and sends response to chat', async () => {
    const bot = createBotStub()
    const agent = createAgentStub()
    const logger = createLoggerStub()

    await handleInputTextEvent(
      {
        data: {
          text: 'Collect wood nearby',
          discord: {
            guildMember: {
              displayName: 'Alice',
            },
          },
        },
      },
      bot as any,
      agent,
      logger as any,
    )

    // Interactive plan execution is scheduled in background.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(generateStatusPrompt).toHaveBeenCalledOnce()
    expect(bot.planning.createPlan).toHaveBeenCalledWith('Collect wood nearby')
    expect(bot.planning.executePlan).toHaveBeenCalledWith(bot.plan)
    expect(handleLLMCompletion).toHaveBeenCalledOnce()
    expect(bot.bot.chat).toHaveBeenCalledWith('On it')

    const serializedHistory = JSON.stringify(bot.memory.chatHistory)
    expect(serializedHistory).toContain('Alice: Collect wood nearby')
  })

  it('processes voice input via compatibility wrapper', async () => {
    const bot = createBotStub()
    const agent = createAgentStub()
    const logger = createLoggerStub()

    await handleVoiceInput(
      {
        data: {
          transcription: 'Follow me',
        },
      },
      bot as any,
      agent,
      logger as any,
    )

    // Interactive plan execution is scheduled in background.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(bot.planning.createPlan).toHaveBeenCalledWith('Follow me')
    expect(bot.bot.chat).toHaveBeenCalledWith('On it')
  })

  it('skips empty input events', async () => {
    const bot = createBotStub()
    const agent = createAgentStub()
    const logger = createLoggerStub()

    await handleInputTextEvent(
      {
        data: {
          text: '   ',
        },
      },
      bot as any,
      agent,
      logger as any,
    )

    expect(bot.planning.createPlan).not.toHaveBeenCalled()
    expect(bot.bot.chat).not.toHaveBeenCalled()
    expect(handleLLMCompletion).not.toHaveBeenCalled()
  })
})
