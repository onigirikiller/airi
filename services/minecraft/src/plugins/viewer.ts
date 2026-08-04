import type { MineflayerPlugin } from '../libs/mineflayer/plugin'

import { createServer } from 'node:net'

import { config } from '../composables/config'
import { useLogger } from '../utils/logger'

interface ViewerOptions {
  enabled?: boolean
  port?: number
  firstPerson?: boolean
  viewDistance?: number
  prefix?: string
}

function resolveViewerModule(moduleValue: unknown): ((...args: any[]) => void) | null {
  const moduleAny = moduleValue as any
  const fromNamespace = moduleAny?.mineflayer
  if (typeof fromNamespace === 'function')
    return fromNamespace

  const fromDefault = moduleAny?.default?.mineflayer
  if (typeof fromDefault === 'function')
    return fromDefault

  return null
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => {
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => {
        resolve(true)
      })
    })
    server.listen(port)
  })
}

export function ViewerPlugin(overrides?: ViewerOptions): MineflayerPlugin {
  const logger = useLogger()

  return {
    async spawned(mineflayer) {
      const settings = {
        ...config.viewer,
        ...overrides,
      }

      if (!settings.enabled)
        return

      try {
        const portAvailable = await isPortAvailable(settings.port)
        if (!portAvailable) {
          logger.withField('port', settings.port).warn('AI viewer port already in use, skipping viewer startup')
          return
        }

        const moduleValue = await import('prismarine-viewer')
        const mineflayerViewer = resolveViewerModule(moduleValue)

        if (!mineflayerViewer) {
          throw new Error('Failed to resolve prismarine-viewer mineflayer export')
        }

        mineflayerViewer(mineflayer.bot, {
          port: settings.port,
          firstPerson: settings.firstPerson,
          viewDistance: settings.viewDistance,
          prefix: settings.prefix || undefined,
        })

        logger.withFields({
          port: settings.port,
          firstPerson: settings.firstPerson,
          viewDistance: settings.viewDistance,
          prefix: settings.prefix || '/',
        }).log('AI viewer started')
      }
      catch (error) {
        logger.withError(error).error('Failed to start AI viewer')
      }
    },
  }
}
