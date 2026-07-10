import type { Client } from '@proj-airi/server-sdk'

import type { MineflayerWithAgents } from '../libs/llm-agent/types'
import type { Mineflayer } from '../libs/mineflayer'
import type { MineflayerPlugin } from '../libs/mineflayer/plugin'

import { AutonomousStreamOrchestrator } from '../autonomy/orchestrator'
import { ReflexController } from '../autonomy/reflex'

export function AutonomyPlugin(airiClient: Client): MineflayerPlugin {
  let orchestrator: AutonomousStreamOrchestrator | null = null
  let reflex: ReflexController | null = null
  let spawnFallbackMineflayer: Mineflayer | null = null

  const handleSpawnFallback = (): void => {
    reflex?.start()
    orchestrator?.start()
  }

  return {
    async created(mineflayer) {
      spawnFallbackMineflayer = mineflayer as Mineflayer
      spawnFallbackMineflayer.bot.on('spawn', handleSpawnFallback)

      reflex = new ReflexController(mineflayer as Mineflayer)
      orchestrator = new AutonomousStreamOrchestrator(
        mineflayer as unknown as MineflayerWithAgents,
        airiClient,
        reflex,
      )

      if ((mineflayer as Mineflayer & { ready?: boolean }).ready) {
        handleSpawnFallback()
      }
    },
    async spawned() {
      handleSpawnFallback()
    },
    async beforeCleanup() {
      if (spawnFallbackMineflayer) {
        spawnFallbackMineflayer.bot.off?.('spawn', handleSpawnFallback)
      }
      spawnFallbackMineflayer = null
      orchestrator?.stop()
      orchestrator = null
      reflex?.stop()
      reflex = null
    },
  }
}
