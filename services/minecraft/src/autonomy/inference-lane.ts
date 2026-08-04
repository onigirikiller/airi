import type { Logger } from '../utils/logger'

export type InferenceLanePriority = 'critical' | 'background'

interface InferenceLaneOptions {
  priority?: InferenceLanePriority
  coalesceKey?: string
  dropIfBusy?: boolean
}

interface QueuedInferenceTask<T> {
  label: string
  priority: InferenceLanePriority
  coalesceKey?: string
  enqueuedAt: number
  logger?: Logger
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

let laneBusy = false
const criticalQueue: Array<QueuedInferenceTask<unknown>> = []
const backgroundQueue: Array<QueuedInferenceTask<unknown>> = []
const queuedCoalesceKeys = new Set<string>()

function dequeueNextTask(): QueuedInferenceTask<unknown> | undefined {
  if (criticalQueue.length > 0) {
    return criticalQueue.shift()
  }

  if (backgroundQueue.length > 0) {
    return backgroundQueue.shift()
  }

  return undefined
}

function resolveQueue(priority: InferenceLanePriority): Array<QueuedInferenceTask<unknown>> {
  return priority === 'critical' ? criticalQueue : backgroundQueue
}

function finishTask(task: QueuedInferenceTask<unknown>): void {
  if (task.coalesceKey) {
    queuedCoalesceKeys.delete(task.coalesceKey)
  }
}

function pumpLane(): void {
  if (laneBusy) {
    return
  }

  const next = dequeueNextTask()
  if (!next) {
    return
  }

  laneBusy = true
  const waitedMs = Date.now() - next.enqueuedAt
  if (waitedMs >= 100) {
    next.logger?.withFields({
      label: next.label,
      waitedMs,
      priority: next.priority,
    }).log('Waited for inference lane')
  }

  void (async () => {
    try {
      next.resolve(await next.run())
    }
    catch (error) {
      next.reject(error)
    }
    finally {
      laneBusy = false
      finishTask(next)
      pumpLane()
    }
  })()
}

export async function runInInferenceLane<T>(
  label: string,
  logger: Logger | undefined,
  task: () => Promise<T>,
  options: InferenceLaneOptions = {},
): Promise<T> {
  const priority = options.priority ?? 'background'
  const coalesceKey = options.coalesceKey?.trim() || undefined

  if (options.dropIfBusy && laneBusy && priority === 'background') {
    logger?.withFields({ label, coalesceKey: coalesceKey || '' }).log('Dropped stale background inference request')
    throw new Error(`Inference lane busy: dropped ${label}`)
  }

  if (coalesceKey && queuedCoalesceKeys.has(coalesceKey)) {
    logger?.withFields({ label, coalesceKey }).log('Coalesced duplicate inference request')
    throw new Error(`Inference lane coalesced duplicate request: ${label}`)
  }

  return await new Promise<T>((resolve, reject) => {
    const queue = resolveQueue(priority)
    const queuedTask: QueuedInferenceTask<T> = {
      label,
      priority,
      coalesceKey,
      enqueuedAt: Date.now(),
      logger,
      run: task,
      resolve,
      reject,
    }

    queue.push(queuedTask as QueuedInferenceTask<unknown>)
    if (coalesceKey) {
      queuedCoalesceKeys.add(coalesceKey)
    }
    pumpLane()
  })
}

export function resetInferenceLaneForTests(): void {
  laneBusy = false
  criticalQueue.length = 0
  backgroundQueue.length = 0
  queuedCoalesceKeys.clear()
}
