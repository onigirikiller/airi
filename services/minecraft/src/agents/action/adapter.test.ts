import type { Neuri } from 'neuri'

import { describe, expect, it, vi } from 'vitest'

import { ActionLLMHandler } from './adapter'

describe('action llm handler', () => {
  it('builds action prompt and returns model result', async () => {
    const mockHandleStateless = vi.fn(async (_messages: unknown[]) => 'Moving to target')
    const mockAgent = {
      handleStateless: mockHandleStateless,
    } as unknown as Neuri

    const handler = new ActionLLMHandler({
      agent: mockAgent,
      model: 'test-model',
    })

    const result = await handler.executeStep({
      description: 'Move to village',
      tool: 'goToCoordinates',
      params: { x: 10, y: 70, z: -3, closeness: 2 },
    })

    expect(result).toBe('Moving to target')
    expect(mockHandleStateless).toHaveBeenCalledOnce()

    const serializedMessages = JSON.stringify(mockHandleStateless.mock.calls[0][0])
    expect(serializedMessages).toContain('Move to village')
    expect(serializedMessages).toContain('goToCoordinates')
    expect(serializedMessages).toContain('closeness')
  })

  it('throws when model returns empty content', async () => {
    const mockAgent = {
      handleStateless: vi.fn(async () => ''),
    } as unknown as Neuri

    const handler = new ActionLLMHandler({
      agent: mockAgent,
      model: 'test-model',
    })

    await expect(handler.handleAction([])).rejects.toThrow('Failed to process action')
  })
})
