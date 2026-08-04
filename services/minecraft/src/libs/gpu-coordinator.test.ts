import { describe, expect, it } from 'vitest'

import { withSerializedGpuTask } from './gpu-coordinator'

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('withSerializedGpuTask', () => {
  it('lets a high-priority task run before queued low-priority tasks', async () => {
    const order: string[] = []

    const first = withSerializedGpuTask('test:gpu:first', undefined, async () => {
      order.push('first:start')
      await sleep(40)
      order.push('first:end')
    }, { priority: 'normal' })

    await sleep(5)

    const low = withSerializedGpuTask('ollama:public-speak', undefined, async () => {
      order.push('low:start')
      await sleep(10)
      order.push('low:end')
    })

    const high = withSerializedGpuTask('local-tts:reply.irodori', undefined, async () => {
      order.push('high:start')
      await sleep(10)
      order.push('high:end')
    }, { priority: 'high' })

    await Promise.all([first, low, high])

    expect(order).toEqual([
      'first:start',
      'first:end',
      'high:start',
      'high:end',
      'low:start',
      'low:end',
    ])
  })
})
