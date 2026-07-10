import EventEmitter from 'eventemitter3'

export type MonitorEventType
  = | 'orchestrator:tick'
    | 'orchestrator:goalSelected'
    | 'orchestrator:goalBlocked'
    | 'orchestrator:goalCompleted'
    | 'orchestrator:goalDeferred'
    | 'orchestrator:goalFailed'
    | 'orchestrator:stallDetected'
    | 'orchestrator:precondViolation'
    | 'orchestrator:recoveryQueued'
    | 'fallback:used'
    | 'planning:started'
    | 'planning:fallback'
    | 'planning:llmGenerated'
    | 'planning:blockedStepSuppressed'
    | 'planning:stepExecuting'
    | 'planning:stepCompleted'
    | 'planning:stepFailed'
    | 'planning:completed'
    | 'planning:adjusting'
    | 'action:started'
    | 'action:completed'
    | 'action:failed'
    | 'action:interrupted'
    | 'action:timeout'
    | 'llm:requestSent'
    | 'llm:responseReceived'
    | 'tokenBudget:state'
    | 'reflex:triggered'
    | 'reflex:resolved'

export interface MonitorEvent {
  type: MonitorEventType
  timestamp: number
  data: Record<string, unknown>
}

export interface MonitorFallbackPayload {
  scope: string
  reason: string
  detail?: string
  from?: string
  to?: string
  goal?: string
  recoverable?: boolean
}

class MonitorEventBus extends EventEmitter {
  emitMonitor(type: MonitorEventType, data: Record<string, unknown> = {}): boolean {
    return super.emit('monitor', { type, timestamp: Date.now(), data } satisfies MonitorEvent)
  }

  onMonitor(handler: (event: MonitorEvent) => void): void {
    this.on('monitor', handler)
  }

  offMonitor(handler: (event: MonitorEvent) => void): void {
    this.off('monitor', handler)
  }
}

export const monitorBus = new MonitorEventBus()

const fallbackThrottleMap = new Map<string, number>()

export function emitFallbackMonitor(
  payload: MonitorFallbackPayload,
  options?: { throttleKey?: string, throttleMs?: number },
): boolean {
  const throttleMs = options?.throttleMs ?? 0
  if (throttleMs > 0) {
    const throttleKey = options?.throttleKey
      ?? [payload.scope, payload.reason, payload.from || '', payload.to || '', payload.goal || ''].join('|')
    const lastAt = fallbackThrottleMap.get(throttleKey) ?? 0
    const now = Date.now()
    if (now - lastAt < throttleMs) {
      return false
    }
    fallbackThrottleMap.set(throttleKey, now)
  }

  return monitorBus.emitMonitor('fallback:used', { ...payload })
}

export function __resetMonitorFallbackThrottleStateForTests(): void {
  fallbackThrottleMap.clear()
}
