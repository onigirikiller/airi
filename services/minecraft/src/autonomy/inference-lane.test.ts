import { describe, expect, it } from 'vitest'

import { resetInferenceLaneForTests, runInInferenceLane } from './inference-lane'

function createLogger() {
  return {
    log: () => {},
    warn: () => {},
    withFields() {
      return this
    },
  } as any
}

describe('runInInferenceLane', () => {
  it('serializes critical work before background work', async () => {
    resetInferenceLaneForTests()
    const order: string[] = []
    const logger = createLogger()

    const first = runInInferenceLane('critical-1', logger, async () => {
      order.push('critical-start')
      await new Promise(resolve => setTimeout(resolve, 10))
      order.push('critical-end')
      return 'critical'
    }, { priority: 'critical' })

    const second = runInInferenceLane('background-1', logger, async () => {
      order.push('background-start')
      order.push('background-end')
      return 'background'
    }, { priority: 'background' })

    await expect(first).resolves.toBe('critical')
    await expect(second).resolves.toBe('background')
    expect(order).toEqual([
      'critical-start',
      'critical-end',
      'background-start',
      'background-end',
    ])
  })

  it('coalesces duplicate background work when the same key is already queued', async () => {
    resetInferenceLaneForTests()
    const logger = createLogger()

    const first = runInInferenceLane('speech-1', logger, async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return 'first'
    }, {
      priority: 'background',
      coalesceKey: 'speech:keepalive',
    })

    const second = runInInferenceLane('speech-2', logger, async () => 'second', {
      priority: 'background',
      coalesceKey: 'speech:keepalive',
    }).catch(error => error)

    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toMatchObject({
      message: expect.stringContaining('coalesced duplicate'),
    })
  })
})
