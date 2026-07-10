import type { Bot } from 'mineflayer'

export class ActionAbortedError extends Error {
  public readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'ActionAbortedError'
    this.reason = reason
  }
}

function getAbortError(signal: AbortSignal): ActionAbortedError {
  if (signal.reason instanceof ActionAbortedError) {
    return signal.reason
  }
  if (signal.reason instanceof Error) {
    return new ActionAbortedError(signal.reason.message)
  }
  return new ActionAbortedError(typeof signal.reason === 'string' ? signal.reason : 'Action aborted')
}

/** Throws the canonical action interruption error when the active signal was aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw getAbortError(signal)
  }
}

/** Sleeps without leaving a timer alive after action interruption. */
export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)
  if (!signal) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  return new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeoutHandle)
      reject(getAbortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Rejects promptly on interruption while retaining the original operation result. */
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal)
  if (!signal) {
    return promise
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(getAbortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Stops all Mineflayer primitives that can continue mutating the world after interruption. */
export function stopActiveBotAction(bot: Bot): void {
  const pathfinder = (bot as any).pathfinder
  try {
    pathfinder?.setGoal?.(null)
  }
  catch {
    // best-effort physical stop
  }
  try {
    pathfinder?.stop?.()
  }
  catch {
    // best-effort physical stop
  }
  try {
    const stopDigging = (bot as any).stopDigging?.()
    if (stopDigging && typeof stopDigging.catch === 'function') {
      void stopDigging.catch(() => {})
    }
  }
  catch {
    // best-effort physical stop
  }
  try {
    bot.clearControlStates()
  }
  catch {
    // best-effort physical stop
  }
  try {
    const cancellation = (bot as any).collectBlock?.cancelTask?.()
    if (cancellation && typeof cancellation.catch === 'function') {
      void cancellation.catch(() => {})
    }
  }
  catch {
    // best-effort physical stop
  }
}
