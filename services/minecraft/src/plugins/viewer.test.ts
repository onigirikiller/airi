import { createServer } from 'node:net'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewerPlugin } from './viewer'

const { logger, mineflayerViewer } = vi.hoisted(() => {
  const loggerStub = {
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    withField: vi.fn(),
    withError: vi.fn(),
    withFields: vi.fn(),
  }
  loggerStub.withField.mockReturnValue(loggerStub)
  loggerStub.withError.mockReturnValue(loggerStub)
  loggerStub.withFields.mockReturnValue(loggerStub)
  return {
    logger: loggerStub,
    mineflayerViewer: vi.fn(),
  }
})

vi.mock('prismarine-viewer', () => ({
  mineflayer: mineflayerViewer,
}))

vi.mock('../utils/logger', () => ({
  useLogger: () => logger,
}))

describe('viewer plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when disabled', async () => {
    const plugin = ViewerPlugin({ enabled: false })

    await plugin.spawned?.({
      bot: {},
    } as any)

    expect(mineflayerViewer).not.toHaveBeenCalled()
  })

  it('starts prismarine viewer with configured options', async () => {
    const plugin = ViewerPlugin({
      enabled: true,
      port: 0,
      firstPerson: true,
      viewDistance: 10,
      prefix: '/ai',
    })
    const botStub = { username: 'aira' }

    await plugin.spawned?.({
      bot: botStub,
    } as any)

    expect(mineflayerViewer).toHaveBeenCalledOnce()
    expect(mineflayerViewer).toHaveBeenCalledWith(botStub, {
      firstPerson: true,
      port: 0,
      prefix: '/ai',
      viewDistance: 10,
    })
  })

  it('skips startup when port is already in use', async () => {
    const busyPort = 31337
    const occupied = createServer()
    await new Promise<void>((resolve) => {
      occupied.listen(busyPort, resolve)
    })

    try {
      const plugin = ViewerPlugin({
        enabled: true,
        port: busyPort,
      })

      await plugin.spawned?.({
        bot: {},
      } as any)

      expect(mineflayerViewer).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledOnce()
    }
    finally {
      await new Promise<void>(resolve => occupied.close(() => resolve()))
    }
  })
})
