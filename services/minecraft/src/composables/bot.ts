import type { FabricBridgeOptions } from '../libs/fabric-bridge'
import type { MineflayerOptions } from '../libs/mineflayer'

import { FabricBridge } from '../libs/fabric-bridge'
import { Mineflayer } from '../libs/mineflayer'

/**
 * BotInstance is the union type of both backends.
 * Both provide the same public interface (username, bot, health, status, etc.)
 */
export type BotInstance = Mineflayer | FabricBridge

// Singleton instance
let botInstance: BotInstance | null = null

/**
 * Initialize a new Mineflayer bot instance (original headless bot).
 * Follows singleton pattern to ensure only one bot exists at a time.
 */
export async function initBot(options: MineflayerOptions): Promise<{ bot: Mineflayer }> {
  if (botInstance) {
    throw new Error('Bot already initialized')
  }

  botInstance = await Mineflayer.asyncBuild(options)
  return { bot: botInstance }
}

/**
 * Initialize a new FabricBridge instance (real Minecraft client).
 * Follows singleton pattern to ensure only one bot exists at a time.
 */
export async function initFabricBridge(options: FabricBridgeOptions): Promise<{ bot: FabricBridge }> {
  if (botInstance) {
    throw new Error('Bot already initialized')
  }

  botInstance = await FabricBridge.asyncBuild(options)
  return { bot: botInstance }
}

/**
 * Reset the bot singleton so that `initBot()` or `initFabricBridge()` can be called again.
 * Used by the auto-restart logic to tear down a dead session.
 */
export async function resetBot(): Promise<void> {
  const instance = botInstance
  if (!instance) {
    return
  }

  botInstance = null

  try {
    await instance.stop()
  }
  catch {
    // Best-effort cleanup; the bot may already be disconnected or partially torn down.
    try {
      if (instance instanceof Mineflayer) {
        instance.bot.removeAllListeners()
        instance.removeAllListeners()
        ;(instance.bot as any).end?.()
      }
      else {
        instance.removeAllListeners()
      }
    }
    catch {
      // noop
    }
  }
}

/**
 * Get the current bot instance.
 * Throws if bot is not initialized.
 */
export function useBot(): { bot: BotInstance } {
  if (!botInstance) {
    throw new Error('Bot not initialized')
  }

  return {
    bot: botInstance,
  }
}
