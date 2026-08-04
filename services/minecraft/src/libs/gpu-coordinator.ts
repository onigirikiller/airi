import type { Logger } from '../utils/logger'

export type GpuTaskPriority = 'high' | 'normal' | 'low'

interface QueuedGpuTask {
  scope: string
  logger?: Logger
  priority: GpuTaskPriority
  enqueuedAt: number
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

let sharedGpuBusy = false
const sharedGpuQueues: Record<GpuTaskPriority, QueuedGpuTask[]> = {
  high: [],
  normal: [],
  low: [],
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function isLikelyOllamaBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()
  return normalized.includes('127.0.0.1:11434')
    || normalized.includes('localhost:11434')
    || normalized.includes('ollama')
}

function resolveGpuTaskPriority(scope: string, explicitPriority?: GpuTaskPriority): GpuTaskPriority {
  if (explicitPriority) {
    return explicitPriority
  }

  if (
    scope.startsWith('ollama:public-speak')
    || scope.startsWith('local-tts:commentary')
    || scope.startsWith('local-tts:keepalive')
    || scope.startsWith('local-tts:ambient')
  ) {
    return 'low'
  }

  if (
    scope.startsWith('ollama:planning')
    || scope.startsWith('ollama:completion')
    || scope.startsWith('ollama:chat-agent')
    || scope.startsWith('ollama:autonomy.decision')
    || scope.startsWith('local-tts:reply')
    || scope.startsWith('local-tts:social')
  ) {
    return 'high'
  }

  return 'normal'
}

function dequeueNextGpuTask(): QueuedGpuTask | undefined {
  if (sharedGpuQueues.high.length > 0) {
    return sharedGpuQueues.high.shift()
  }

  if (sharedGpuQueues.normal.length > 0) {
    return sharedGpuQueues.normal.shift()
  }

  if (sharedGpuQueues.low.length > 0) {
    return sharedGpuQueues.low.shift()
  }

  return undefined
}

function runNextGpuTask(): void {
  if (sharedGpuBusy) {
    return
  }

  const nextTask = dequeueNextGpuTask()
  if (!nextTask) {
    return
  }

  sharedGpuBusy = true
  const waitedMs = Date.now() - nextTask.enqueuedAt
  if (waitedMs >= 100) {
    nextTask.logger?.withFields({
      scope: nextTask.scope,
      waitedMs,
      priority: nextTask.priority,
    }).log('Waited for shared GPU slot')
  }

  void (async () => {
    try {
      nextTask.resolve(await nextTask.run())
    }
    catch (error) {
      nextTask.reject(error)
    }
    finally {
      sharedGpuBusy = false
      runNextGpuTask()
    }
  })()
}

export async function withSerializedGpuTask<T>(
  scope: string,
  logger: Logger | undefined,
  task: () => Promise<T>,
  options?: { priority?: GpuTaskPriority },
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const priority = resolveGpuTaskPriority(scope, options?.priority)
    sharedGpuQueues[priority].push({
      scope,
      logger,
      priority,
      enqueuedAt: Date.now(),
      run: async () => await task(),
      resolve: value => resolve(value as T),
      reject,
    })
    runNextGpuTask()
  })
}

export async function unloadOllamaModel(
  baseUrl: string,
  model: string,
  logger?: Logger,
): Promise<void> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const trimmedModel = model.trim()
  if (!trimmedModel || !isLikelyOllamaBaseUrl(normalizedBaseUrl)) {
    return
  }

  const ollamaBaseUrl = normalizedBaseUrl.replace(/\/v1\/?$/i, '')
  const abortController = new AbortController()
  const abortTimer = setTimeout(() => abortController.abort(), 10_000)

  try {
    const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      signal: abortController.signal,
      body: JSON.stringify({
        model: trimmedModel,
        keep_alive: 0,
        stream: false,
      }),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      logger?.withFields({
        model: trimmedModel,
        status: response.status,
        body: detail.replace(/\s+/g, ' ').trim().slice(0, 200),
      }).warn('Failed to unload Ollama model after request')
    }
  }
  catch (error) {
    logger?.withFields({
      model: trimmedModel,
      error: error instanceof Error ? error.message : String(error),
    }).warn('Failed to unload Ollama model after request')
  }
  finally {
    clearTimeout(abortTimer)
  }
}
