import type { Agent, Neuri } from 'neuri'

import type { Mineflayer } from '../libs/mineflayer'

import { neuri } from 'neuri'

import { createActionNeuriAgent } from '../agents/action/adapter'
import { createChatNeuriAgent } from '../agents/chat/llm'
import { createPlanningNeuriAgent } from '../agents/planning/adapter'
import { createTokenBudgetedFetch, isOfficialOpenAIBaseUrl } from '../libs/llm-usage/token-budget'
import { useLogger } from '../utils/logger'
import { config } from './config'

let neuriAgent: Neuri | undefined
const agents = new Set<Agent | Promise<Agent>>()

function resolveProviderApiKey(): string {
  const apiKey = config.speechLlm.apiKey.trim()
  if (apiKey.length > 0) {
    return apiKey
  }

  const baseUrl = config.speechLlm.baseUrl.trim().toLowerCase()
  const localBase = baseUrl.includes('127.0.0.1')
    || baseUrl.includes('localhost')
    || baseUrl.includes('0.0.0.0')

  return localBase ? 'local-dev' : ''
}

export async function createNeuriAgent(mineflayer: Mineflayer): Promise<Neuri> {
  useLogger().log('Initializing neuri agent')
  const officialOpenAI = isOfficialOpenAIBaseUrl(config.speechLlm.baseUrl)
  let n = neuri()

  agents.add(createPlanningNeuriAgent())
  agents.add(createActionNeuriAgent(mineflayer))
  agents.add(createChatNeuriAgent())

  agents.forEach(agent => n = n.agent(agent))

  neuriAgent = await n.build({
    provider: {
      apiKey: resolveProviderApiKey(),
      baseURL: config.speechLlm.baseUrl,
      fetch: officialOpenAI
        ? createTokenBudgetedFetch(config.speechLlm.baseUrl, 'neuri')
        : undefined,
    },
  })

  return neuriAgent
}

export function useNeuriAgent(): Neuri {
  if (!neuriAgent) {
    throw new Error('Agent not initialized')
  }
  return neuriAgent
}
