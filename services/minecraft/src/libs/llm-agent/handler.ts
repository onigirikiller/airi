import type { NeuriContext } from 'neuri'
import type { ChatCompletion, Message } from 'neuri/openai'

import type { Logger } from '../../utils/logger'
import type { LLMConfig, LLMResponse } from './types'

import { withRetry } from '@moeru/std'

import { config } from '../../composables/config'
import { useLogger } from '../../utils/logger'
import { isLikelyOllamaBaseUrl, unloadOllamaModel, withSerializedGpuTask } from '../gpu-coordinator'
import { assertOpenAITokenBudget } from '../llm-usage/token-budget'

export abstract class BaseLLMHandler {
  protected logger: Logger

  constructor(protected config: LLMConfig) {
    this.logger = useLogger()
  }

  protected async handleCompletion(
    context: NeuriContext,
    route: string,
    messages: Message[],
  ): Promise<LLMResponse> {
    const speechBaseUrl = config.speechLlm.baseUrl
    const speechModel = config.speechLlm.model
    const completionOptions: any = {
      model: this.config.model ?? speechModel,
    }

    if (route === 'planning') {
      completionOptions.max_tokens = 900
      completionOptions.temperature = 0.2
    }
    else if (route === 'chat') {
      completionOptions.max_tokens = 256
      completionOptions.temperature = 0.6
    }
    else if (route === 'action') {
      completionOptions.max_tokens = 192
      completionOptions.temperature = 0.2
    }

    const reroute = async () => {
      const model = String(completionOptions.model || speechModel)
      assertOpenAITokenBudget(speechBaseUrl, `neuri.${route}`, model)
      return await context.reroute(route, messages, completionOptions) as ChatCompletion | ChatCompletion & { error: { message: string } }
    }
    const completion = isLikelyOllamaBaseUrl(speechBaseUrl)
      ? await withSerializedGpuTask(`ollama:handler.${route}`, this.logger, async () => {
          try {
            return await reroute()
          }
          finally {
            await unloadOllamaModel(speechBaseUrl, String(completionOptions.model || speechModel), this.logger)
          }
        })
      : await reroute()

    if (!completion || 'error' in completion) {
      this.logger.withFields(context).error('Completion failed')
      throw new Error((completion as any)?.error?.message ?? 'Unknown error')
    }

    const content = await completion.firstContent()
    this.logger.withFields({ usage: completion.usage, content }).log('Generated content')

    return {
      content,
      usage: completion.usage,
    }
  }

  protected createRetryHandler<T>(handler: (context: NeuriContext) => Promise<T>) {
    return withRetry<NeuriContext, T>(handler, {
      retry: this.config.retryLimit ?? 3,
      retryDelay: this.config.delayInterval ?? 1000,
    })
  }
}
