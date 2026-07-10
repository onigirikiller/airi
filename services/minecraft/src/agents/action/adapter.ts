import type { Agent } from 'neuri'
import type { Message } from 'neuri/openai'

import type { Mineflayer } from '../../libs/mineflayer'
import type { PlanStep } from '../planning/adapter'

import { agent } from 'neuri'
import { system, user } from 'neuri/openai'

import { BaseLLMHandler } from '../../libs/llm-agent/handler'
import { useLogger } from '../../utils/logger'
import { actionsList } from './tools'

export async function createActionNeuriAgent(mineflayer: Mineflayer): Promise<Agent> {
  const logger = useLogger()
  logger.log('Initializing action agent')
  let actionAgent = agent('action')

  Object.values(actionsList).forEach((action) => {
    actionAgent = actionAgent.tool(
      action.name,
      action.schema,
      async ({ parameters }) => {
        logger.withFields({ name: action.name, parameters }).log('Calling action')
        mineflayer.memory.pushAction(action)
        const fn = action.perform(mineflayer)
        return await fn(...Object.values(parameters))
      },
      { description: action.description },
    )
  })

  return actionAgent.build()
}

/**
 * Execute a plan step directly by looking up the tool and calling it,
 * bypassing LLM tool calling entirely. This is required for models
 * that do not support the OpenAI tool calling protocol (e.g. LFM2.5-1.2B).
 */
export async function executeStepDirectly(
  step: PlanStep,
  mineflayer: Mineflayer,
): Promise<string> {
  const logger = useLogger()
  const toolName = step.tool?.trim()

  if (!toolName) {
    logger.withFields({ step }).warn('Plan step has no tool specified; skipping')
    return `Skipped: no tool specified for "${step.description}"`
  }

  const action = actionsList.find(a => a.name === toolName)
  if (!action) {
    logger.withFields({ toolName }).warn('Unknown tool in plan step')
    return `Unknown tool: ${toolName}`
  }

  logger.withFields({ toolName, params: step.params }).log('Executing step directly')

  try {
    mineflayer.memory.pushAction(action)
    const fn = action.perform(mineflayer)
    const paramValues = Object.values(step.params ?? {})
    const result = await fn(...paramValues)
    logger.withFields({ toolName, result }).log('Direct step execution succeeded')
    return typeof result === 'string' ? result : String(result)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.withFields({ toolName, error: message }).warn('Direct step execution failed')
    return `Failed: ${toolName} - ${message}`
  }
}

export class ActionLLMHandler extends BaseLLMHandler {
  private mineflayer: Mineflayer | undefined

  public setMineflayer(mf: Mineflayer): void {
    this.mineflayer = mf
  }

  public async executeStep(step: PlanStep): Promise<string> {
    // Direct execution: bypass LLM tool calling for models that don't support it
    if (this.mineflayer) {
      return executeStepDirectly(step, this.mineflayer)
    }

    // Fallback to LLM-based execution (for models with tool calling support)
    const systemPrompt = this.generateActionSystemPrompt()
    const userPrompt = this.generateActionUserPrompt(step)
    const messages = [system(systemPrompt), user(userPrompt)]

    const result = await this.handleAction(messages)
    return result
  }

  private generateActionSystemPrompt(): string {
    return `あなたはMinecraftボットのアクション実行エージェントです。
与えられたステップを、利用可能なツールだけで安全に実行してください。

ルール:
- 不要な説明や雑談は避ける
- 指定された tool と params を優先し、必要最小限の判断で実行する
- 失敗時は状況を簡潔に返す
- 日本語で短く明確に返答する`
  }

  private generateActionUserPrompt(step: PlanStep): string {
    return `次のステップを実行してください: ${step.description}

指定ツール: ${step.tool}
パラメータ: ${JSON.stringify(step.params)}

指定ツールとパラメータを優先して実行してください。`
  }

  public async handleAction(messages: Message[]): Promise<string> {
    const result = await this.config.agent.handleStateless(messages, async (context) => {
      this.logger.log('Processing action...')
      const retryHandler = this.createRetryHandler(
        async ctx => (await this.handleCompletion(ctx, 'action', ctx.messages)).content,
      )
      return await retryHandler(context)
    })

    if (!result) {
      throw new Error('Failed to process action')
    }

    return result
  }
}
