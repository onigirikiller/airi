import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handleChatMessage } from './chat'
import { createAgentContainer } from './container'
import { LLMAgent } from './index'
import { handleInputTextEvent } from './voice'

vi.mock('../../composables/config', () => ({
  config: {
    openai: {
      model: 'test-model',
    },
    speechLlm: {
      model: 'test-model',
      reasoningModel: 'test-reasoning-model',
    },
    autonomy: {
      enabled: false,
      mode: 'runner',
    },
  },
}))

vi.mock('./chat', () => ({
  handleChatMessage: vi.fn(async () => undefined),
}))

vi.mock('./voice', () => ({
  handleInputTextEvent: vi.fn(async () => undefined),
}))

vi.mock('./prompt', () => ({
  generateActionAgentPrompt: vi.fn(() => 'test prompt'),
}))

vi.mock('./container', () => ({
  createAgentContainer: vi.fn(),
}))

function createAgentStub() {
  return {
    init: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  }
}

describe('llm agent plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers chat and text input handlers', async () => {
    const actionAgent = createAgentStub()
    const planningAgent = createAgentStub()
    const chatAgent = createAgentStub()

    vi.mocked(createAgentContainer).mockReturnValue({
      resolve(name: string) {
        switch (name) {
          case 'actionAgent':
            return actionAgent
          case 'planningAgent':
            return planningAgent
          case 'chatAgent':
            return chatAgent
          default:
            throw new Error(`Unknown dependency: ${name}`)
        }
      },
    } as any)

    const registeredAiriEvents = new Map<string, (event: any) => Promise<void> | void>()

    const airiClient = {
      onEvent: vi.fn((eventName: string, callback: (event: any) => Promise<void> | void) => {
        registeredAiriEvents.set(eventName, callback)
      }),
    }

    const botEvents = new Map<string, (username: string, message: string) => void>()

    const bot = {
      username: 'airi-bot',
      memory: {
        chatHistory: [] as any[],
        pushChatMessage(msg: any) { this.chatHistory.push(msg) },
      },
      bot: {
        on: vi.fn((eventName: string, callback: (username: string, message: string) => void) => {
          botEvents.set(eventName, callback)
        }),
        removeAllListeners: vi.fn(),
      },
    } as any

    const neuriAgent = {} as any

    const plugin = LLMAgent({
      agent: neuriAgent,
      airiClient: airiClient as any,
    })

    await plugin.created?.(bot)

    expect(actionAgent.init).toHaveBeenCalledOnce()
    expect(planningAgent.init).toHaveBeenCalledOnce()
    expect(chatAgent.init).toHaveBeenCalledOnce()

    expect(airiClient.onEvent).toHaveBeenCalledWith('input:text', expect.any(Function))
    expect(airiClient.onEvent).toHaveBeenCalledWith('input:text:voice', expect.any(Function))
    expect(airiClient.onEvent).toHaveBeenCalledWith('spark:command', expect.any(Function))
    expect(bot.bot.on).toHaveBeenCalledWith('chat', expect.any(Function))

    await registeredAiriEvents.get('input:text')?.({ data: { text: 'hello' } })
    await registeredAiriEvents.get('input:text:voice')?.({ data: { transcription: 'follow me' } })
    botEvents.get('chat')?.('player-one', 'hi airi')

    expect(handleInputTextEvent).toHaveBeenCalledTimes(2)
    expect(handleChatMessage).toHaveBeenCalledWith('player-one', 'hi airi', bot, neuriAgent, expect.anything(), airiClient)
  })
})
