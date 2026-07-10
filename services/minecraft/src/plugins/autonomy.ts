import type { Client } from '@proj-airi/server-sdk'

import type { MineflayerWithAgents } from '../libs/llm-agent/types'
import type { Mineflayer } from '../libs/mineflayer'
import type { MineflayerPlugin } from '../libs/mineflayer/plugin'

import { EmotionEngine, setActiveEmotionEngine } from '../autonomy/emotion'
import { AutonomousStreamOrchestrator } from '../autonomy/orchestrator'
import { QuestTracker } from '../autonomy/quest-tracker'
import { ReflexController } from '../autonomy/reflex'
import { VoiceBank } from '../libs/llm-agent/voice-bank'

export function AutonomyPlugin(airiClient: Client): MineflayerPlugin {
  let orchestrator: AutonomousStreamOrchestrator | null = null
  let reflex: ReflexController | null = null
  let voiceBank: VoiceBank | null = null
  let questTracker: QuestTracker | null = null
  let deathReactionHandler: (() => void) | null = null

  let spawnFallbackMineflayer: Mineflayer | null = null

  const handleSpawnFallback = (): void => {
    reflex?.start()
    orchestrator?.start()
    questTracker?.start()
    void voiceBank?.prepare()
  }

  return {
    async created(mineflayer) {
      spawnFallbackMineflayer = mineflayer as Mineflayer
      spawnFallbackMineflayer.bot.on('spawn', handleSpawnFallback)

      reflex = new ReflexController(mineflayer as Mineflayer)
      voiceBank = new VoiceBank(airiClient)
      const emotion = new EmotionEngine()
      setActiveEmotionEngine(emotion)

      // First scream of the two-tier reaction: instant pre-rendered voice at
      // the reflex moment; the considered LLM commentary follows on its own.
      reflex.on('reflex', (event) => {
        emotion.impulse(event.kind === 'combat-defense' ? 'combat' : 'danger')
        voiceBank?.play(event.kind, event.at)
      })
      deathReactionHandler = () => {
        emotion.impulse('death')
        voiceBank?.play('death')
      }
      ;(mineflayer as Mineflayer).bot.on('death', deathReactionHandler)

      orchestrator = new AutonomousStreamOrchestrator(
        mineflayer as unknown as MineflayerWithAgents,
        airiClient,
        reflex,
      )
      questTracker = new QuestTracker(mineflayer as Mineflayer, voiceBank)

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
      questTracker?.stop()
      questTracker = null
      voiceBank = null
      setActiveEmotionEngine(undefined)
    },
  }
}
