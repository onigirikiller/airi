import type { Client } from '@proj-airi/server-sdk'

import type { MineflayerWithAgents } from '../libs/llm-agent/types'
import type { Mineflayer } from '../libs/mineflayer'
import type { MineflayerPlugin } from '../libs/mineflayer/plugin'

import { AutonomousStreamOrchestrator } from '../autonomy/orchestrator'
import { ReflexController } from '../autonomy/reflex'
import { VoiceBank } from '../libs/llm-agent/voice-bank'

export function AutonomyPlugin(airiClient: Client): MineflayerPlugin {
  let orchestrator: AutonomousStreamOrchestrator | null = null
  let reflex: ReflexController | null = null
  let voiceBank: VoiceBank | null = null
  let deathReactionHandler: (() => void) | null = null

  let spawnFallbackMineflayer: Mineflayer | null = null

  const handleSpawnFallback = (): void => {
    reflex?.start()
    orchestrator?.start()
    void voiceBank?.prepare()
  }

  return {
    async created(mineflayer) {
      spawnFallbackMineflayer = mineflayer as Mineflayer
      spawnFallbackMineflayer.bot.on('spawn', handleSpawnFallback)

      reflex = new ReflexController(mineflayer as Mineflayer)
      voiceBank = new VoiceBank(airiClient)

      // First scream of the two-tier reaction: instant pre-rendered voice at
      // the reflex moment; the considered LLM commentary follows on its own.
      reflex.on('reflex', (event) => {
        voiceBank?.play(event.kind, event.at)
      })
      deathReactionHandler = () => {
        voiceBank?.play('death')
      }
      ;(mineflayer as Mineflayer).bot.on('death', deathReactionHandler)

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
        if (deathReactionHandler) {
          spawnFallbackMineflayer.bot.off?.('death', deathReactionHandler)
        }
      }
      spawnFallbackMineflayer = null
      deathReactionHandler = null
      orchestrator?.stop()
      orchestrator = null
      reflex?.removeAllListeners?.()
      reflex?.stop()
      reflex = null
      voiceBank = null
    },
  }
}
