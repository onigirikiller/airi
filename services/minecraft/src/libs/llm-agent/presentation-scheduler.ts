import process from 'node:process'

import { useLogger } from '../../utils/logger'

/**
 * Presentation timeline for broadcast-delay synchronization.
 *
 * The game video shown to viewers is delayed by a fixed amount (OBS render
 * delay / browser-side buffering). Everything the character "says" about a
 * game event must therefore be released when the viewer actually sees that
 * event: `eventAt + delay`. Speech that is generated faster than the delay
 * waits; speech that finishes late plays immediately (perceived latency is
 * compressed by the full delay). Hopelessly late low-priority lines are
 * dropped instead of narrating the past.
 *
 * With `STREAM_VIDEO_DELAY_MS=0` (default) everything passes through
 * immediately, so non-streaming setups are unaffected.
 */

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export interface ScheduleOptions {
  /**
   * Drop the task when it would play later than `eventAt + delay + maxLatenessMs`.
   * Use for commentary whose value decays; keep undefined for must-deliver
   * speech such as social replies.
   */
  maxLatenessMs?: number
  /** Label used for logging/monitoring when the task is dropped. */
  label?: string
}

export class PresentationScheduler {
  private readonly logger = useLogger()
  private readonly pending = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly delayMs: number) {}

  public get videoDelayMs(): number {
    return this.delayMs
  }

  /**
   * Runs `task` when the viewer sees the moment `eventAt` on the delayed
   * video. Returns false when the task was dropped for staleness.
   */
  public schedule(eventAt: number, task: () => void, options: ScheduleOptions = {}): boolean {
    const releaseAt = eventAt + this.delayMs
    const now = Date.now()

    if (options.maxLatenessMs !== undefined && now > releaseAt + options.maxLatenessMs) {
      this.logger.withFields({
        label: options.label ?? '',
        lateMs: now - releaseAt,
      }).log('Presentation task dropped as stale')
      return false
    }

    const wait = releaseAt - now
    if (wait <= 0) {
      task()
      return true
    }

    const handle = setTimeout(() => {
      this.pending.delete(handle)
      try {
        task()
      }
      catch (error) {
        this.logger.withError(error).warn('Presentation task failed')
      }
    }, wait)
    handle.unref?.()
    this.pending.add(handle)
    return true
  }

  /** Cancels all pending releases (shutdown only; tasks are not flushed). */
  public clear(): void {
    for (const handle of this.pending) {
      clearTimeout(handle)
    }
    this.pending.clear()
  }
}

let sharedScheduler: PresentationScheduler | undefined

export function getPresentationScheduler(): PresentationScheduler {
  if (!sharedScheduler) {
    sharedScheduler = new PresentationScheduler(
      parseNonNegativeInt(process.env.STREAM_VIDEO_DELAY_MS, 0),
    )
  }
  return sharedScheduler
}

export function __resetPresentationSchedulerForTests(delayMs?: number): void {
  sharedScheduler?.clear()
  sharedScheduler = delayMs === undefined ? undefined : new PresentationScheduler(delayMs)
}
