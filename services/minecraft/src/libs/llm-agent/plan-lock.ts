import type { Logger } from '../../utils/logger'

type PlanLockSource = 'autonomy' | 'interactive' | 'autonomy-recovery'

const PLAN_LOCK_ACQUIRE_TIMEOUT_MS = 90_000
// NOTICE: FabricBridge pathfinding + Baritone mining can legitimately take a bit over
// two minutes when the bot has to walk first and then mine a target block cluster.
// Releasing the shared plan lock at 120s caused live runs to start a second autonomy
// goal while the first collectBlocks action was still mining, which in turn created
// overlapping plans and stale-state churn. Keep the lock timeout comfortably above the
// observed long-running bootstrap path, while still preserving a hard recovery ceiling
// for truly wedged executions.
const PLAN_LOCK_HOLD_TIMEOUT_MS = 300_000

interface Waiter {
  source: PlanLockSource
  queuedAt: number
  resolve: () => void
  reject: (error: Error) => void
}

interface PlanLockState {
  locked: boolean
  owner: PlanLockSource | null
  acquiredAt: number
  leaseId: number
  holdTimer: ReturnType<typeof setTimeout> | null
  waiters: Waiter[]
}

const planLocks = new Map<string, PlanLockState>()

function getOrCreatePlanLockState(botName: string): PlanLockState {
  const existing = planLocks.get(botName)
  if (existing) {
    return existing
  }

  const created: PlanLockState = {
    locked: false,
    owner: null,
    acquiredAt: 0,
    leaseId: 0,
    holdTimer: null,
    waiters: [],
  }
  planLocks.set(botName, created)
  return created
}

function startHoldTimer(botName: string, state: PlanLockState, logger?: Logger): void {
  clearHoldTimer(state)
  state.holdTimer = setTimeout(() => {
    logger?.withFields?.({
      botName,
      owner: state.owner,
      heldForMs: Date.now() - state.acquiredAt,
    }).warn?.('Plan lock hold timeout exceeded; force-releasing')
    releasePlanLock(botName, logger)
  }, PLAN_LOCK_HOLD_TIMEOUT_MS)
}

function clearHoldTimer(state: PlanLockState): void {
  if (state.holdTimer) {
    clearTimeout(state.holdTimer)
    state.holdTimer = null
  }
}

async function acquirePlanLock(
  botName: string,
  source: PlanLockSource,
  logger?: Logger,
): Promise<() => void> {
  const state = getOrCreatePlanLockState(botName)

  if (!state.locked) {
    state.locked = true
    state.owner = source
    state.acquiredAt = Date.now()
    state.leaseId += 1
    const acquiredLeaseId = state.leaseId
    startHoldTimer(botName, state, logger)
    logger?.withFields?.({ botName, source }).log?.('Plan lock acquired')
    return () => releasePlanLock(botName, logger, acquiredLeaseId)
  }

  const queuedAt = Date.now()
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { source, queuedAt, resolve, reject }
    state.waiters.push(waiter)

    const timer = setTimeout(() => {
      const index = state.waiters.indexOf(waiter)
      if (index !== -1) {
        state.waiters.splice(index, 1)
        reject(new Error(`Plan lock acquire timeout after ${PLAN_LOCK_ACQUIRE_TIMEOUT_MS}ms (owner=${state.owner}, source=${source})`))
      }
    }, PLAN_LOCK_ACQUIRE_TIMEOUT_MS)

    const originalResolve = waiter.resolve
    waiter.resolve = () => {
      clearTimeout(timer)
      originalResolve()
    }
    const originalReject = waiter.reject
    waiter.reject = (error: Error) => {
      clearTimeout(timer)
      originalReject(error)
    }
  })

  state.locked = true
  state.owner = source
  state.acquiredAt = Date.now()
  state.leaseId += 1
  const acquiredLeaseId = state.leaseId
  startHoldTimer(botName, state, logger)
  logger?.withFields?.({
    botName,
    source,
    waitMs: Date.now() - queuedAt,
  }).log?.('Plan lock acquired after wait')

  return () => releasePlanLock(botName, logger, acquiredLeaseId)
}

function releasePlanLock(botName: string, logger?: Logger, expectedLeaseId?: number): void {
  const state = planLocks.get(botName)
  if (!state) {
    return
  }
  if (typeof expectedLeaseId === 'number' && state.leaseId !== expectedLeaseId) {
    logger?.withFields?.({
      botName,
      expectedLeaseId,
      activeLeaseId: state.leaseId,
      owner: state.owner,
    }).log?.('Ignoring stale plan lock release')
    return
  }

  clearHoldTimer(state)

  const next = state.waiters.shift()
  if (!next) {
    state.locked = false
    state.owner = null
    state.acquiredAt = 0
    logger?.withField?.('botName', botName).log?.('Plan lock released')
    return
  }

  state.owner = next.source
  next.resolve()
}

export async function withSharedPlanLock<T>(
  botName: string,
  source: PlanLockSource,
  logger: Logger | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const release = await acquirePlanLock(botName, source, logger)
  try {
    return await task()
  }
  finally {
    release()
  }
}

export function forceReleaseSharedPlanLock(
  botName: string,
  logger?: Logger,
): void {
  releasePlanLock(botName, logger)
}

export function __resetPlanLocksForTests(): void {
  for (const state of planLocks.values()) {
    clearHoldTimer(state)
  }
  planLocks.clear()
}
