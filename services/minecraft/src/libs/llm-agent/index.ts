import type { MineflayerPlugin } from '../mineflayer'
import type { LLMAgentOptions, MineflayerWithAgents } from './types'

import { system } from 'neuri/openai'

import { config } from '../../composables/config'
import { createNeuriAgent } from '../../composables/neuri'
import { useLogger } from '../../utils/logger'
import { ChatMessageHandler } from '../mineflayer'
import { handleChatMessage } from './chat'
import { createAgentContainer } from './container'
import { generateActionAgentPrompt } from './prompt'
import { handleSparkCommandEvent } from './spark-command'
import { handleInputTextEvent } from './voice'

export function LLMAgent(options: LLMAgentOptions): MineflayerPlugin {
  return {
    async created(bot) {
      const logger = useLogger()
      const agent = options.agent
        || await options.createAgent?.(bot)
        || await createNeuriAgent(bot)

      // Create container and get required services
      const container = createAgentContainer({
        neuri: agent,
        bot,
        model: config.speechLlm.model,
        reasoningModel: config.speechLlm.reasoningModel || config.speechLlm.model,
      })

      const actionAgent = container.resolve('actionAgent')
      const planningAgent = container.resolve('planningAgent')
      const chatAgent = container.resolve('chatAgent')

      // Initialize agents
      await actionAgent.init()
      await planningAgent.init()
      await chatAgent.init()

      // Type conversion
      const botWithAgents = bot as unknown as MineflayerWithAgents
      botWithAgents.action = actionAgent
      botWithAgents.planning = planningAgent
      botWithAgents.chat = chatAgent

      // Initialize system prompt
      bot.memory.pushChatMessage(system(generateActionAgentPrompt(bot)))

      // Set message handling
      const onChat = new ChatMessageHandler(bot.username).handleChat((username, message) =>
        handleChatMessage(username, message, botWithAgents, agent, logger, options.airiClient))

      const onInputText = (event: any) => {
        logger.withFields({
          eventType: 'input:text',
          hasText: Boolean(event?.data?.text),
        }).log('AIRI input event received')
        return handleInputTextEvent(event, botWithAgents, agent, logger, options.airiClient)
      }

      const onInputTextVoice = (event: any) => {
        logger.withFields({
          eventType: 'input:text:voice',
          hasTranscription: Boolean(event?.data?.transcription),
        }).log('AIRI input event received')
        return handleInputTextEvent(event, botWithAgents, agent, logger, options.airiClient)
      }

      const onSparkCommand = async (event: any) => {
        if (config.autonomy?.enabled && config.autonomy?.mode === 'stream') {
          return
        }

        logger.withFields({
          eventType: 'spark:command',
          intent: event?.data?.intent,
          destinations: event?.data?.destinations,
        }).log('AIRI spark command received')

        await handleSparkCommandEvent(event, botWithAgents, logger, options.airiClient)
      }

      ;(botWithAgents as any).__llmAgent = {
        agent,
        onChat,
        onInputText,
        onInputTextVoice,
        onSparkCommand,
      }

      options.airiClient.onEvent('input:text', onInputText)
      options.airiClient.onEvent('input:text:voice', onInputTextVoice)
      options.airiClient.onEvent('spark:command', onSparkCommand)

      bot.bot.on('chat', onChat)
    },

    async beforeCleanup(bot) {
      const botWithAgents = bot as unknown as MineflayerWithAgents
      const pluginState = (botWithAgents as any).__llmAgent as {
        onChat?: (username: string, message: string) => void
        onInputText?: (event: any) => void | Promise<void>
        onInputTextVoice?: (event: any) => void | Promise<void>
        onSparkCommand?: (event: any) => void | Promise<void>
      } | undefined

      if (pluginState?.onChat) {
        bot.bot.off?.('chat', pluginState.onChat)
      }
      if (pluginState?.onInputText) {
        options.airiClient.offEvent('input:text', pluginState.onInputText)
      }
      if (pluginState?.onInputTextVoice) {
        options.airiClient.offEvent('input:text:voice', pluginState.onInputTextVoice)
      }
      if (pluginState?.onSparkCommand) {
        options.airiClient.offEvent('spark:command', pluginState.onSparkCommand)
      }

      await botWithAgents.action?.destroy()
      await botWithAgents.planning?.destroy()
      await botWithAgents.chat?.destroy()
      delete (botWithAgents as any).__llmAgent
    },
  }
}
