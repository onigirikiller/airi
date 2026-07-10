import { setTimeout as delay } from 'node:timers/promises'

import EventEmitter from 'eventemitter3'

export interface TickContext {
  delta: number
  nextTick: () => Promise<void>
}

export interface TickEventHandlers {
  tick: (ctx: TickContext) => void
}

export type TickEvents = keyof TickEventHandlers
export type TickEventsHandler<K extends TickEvents> = TickEventHandlers[K]

// This update loop is intentionally resilient: tick handlers may be sync or async.
// The ticker must also be stoppable because the minecraft-bot process can restart
// the bot instance in-process (auto-restart) without killing Node.
export class Ticker extends EventEmitter<TickEventHandlers> {
  private readonly interval: number
  private readonly abort = new AbortController()
  private started = false
  private lastTickAt = Date.now()

  constructor(options?: { interval?: number }) {
    super()
    this.interval = options?.interval ?? 300

    this.start()
  }

  stop(): void {
    if (this.abort.signal.aborted) {
      return
    }

    this.abort.abort()
    this.removeAllListeners()
  }

  private start(): void {
    if (this.started) {
      return
    }

    this.started = true
    void this.runLoop()
  }

  private async runLoop(): Promise<void> {
    const signal = this.abort.signal

    // Preserve the previous behaviour: wait one interval before the first tick.
    try {
      await delay(this.interval, undefined, { signal })
    }
    catch {
      return
    }

    while (!signal.aborted) {
      const start = Date.now()
      const nextTickPromise = new Promise<void>(resolve => setImmediate(resolve))

      const callbacks = this.listeners('tick')
      const callbackPromises = callbacks.map(cb =>
        Promise.resolve().then(() => cb({
          delta: start - this.lastTickAt,
          nextTick: () => nextTickPromise,
        })),
      )

      try {
        await Promise.race([
          Promise.all(callbackPromises),
          delay(this.interval, undefined, { signal }),
        ])
      }
      catch {
        // Aborted or a tick handler rejected; we'll re-check the signal below.
      }

      const remaining = this.interval - (Date.now() - start)
      this.lastTickAt = start

      if (remaining > 0) {
        try {
          await delay(remaining, undefined, { signal })
        }
        catch {
          return
        }
      }
    }
  }

  on<K extends TickEvents>(event: K, cb: TickEventsHandler<K>) {
    return super.on(event, cb)
  }
}
