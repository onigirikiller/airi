import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { Mineflayer } from '../../libs/mineflayer/core'
import { ActionAgentImpl } from './index'

const inventorySnapshots: Array<Record<string, number>> = []
const { accurateNearestBlockMock } = vi.hoisted(() => ({
  accurateNearestBlockMock: vi.fn(async () => null as any),
}))
const { lastPlacedBlockRecordMock } = vi.hoisted(() => ({
  lastPlacedBlockRecordMock: vi.fn(() => null as any),
}))
const { pickupNearbyItemsMock } = vi.hoisted(() => ({
  pickupNearbyItemsMock: vi.fn(async () => true),
}))
const { buildWorldStateSnapshotMock } = vi.hoisted(() => ({
  buildWorldStateSnapshotMock: vi.fn(async () => ({
    terrainContext: 'surface_forest',
    surfaceEscapeNeeded: false,
  }) as any),
}))
const {
  inventoryPreflightMock,
  inventoryPostflightMock,
  inventoryRecoveryMock,
  stabilizeInventoryMock,
} = vi.hoisted(() => ({
  inventoryPreflightMock: vi.fn(async () => ({
    ok: true,
    task: { actionKind: 'generic' },
    snapshot: { freeSlotCount: 4, invariants: { desyncSuspected: false } },
    actions: [],
    facts: [],
  }) as any),
  inventoryPostflightMock: vi.fn(async () => ({
    ok: true,
    task: { actionKind: 'generic' },
    snapshot: { freeSlotCount: 4, invariants: { desyncSuspected: false } },
    actions: [],
    facts: [],
  }) as any),
  inventoryRecoveryMock: vi.fn(async (_mineflayer: unknown, _step: unknown, failureClass: string) => ({
    recovered: true,
    failureClass,
    actions: ['refreshInventory'],
    snapshot: { freeSlotCount: 4, invariants: { desyncSuspected: false } },
  })),
  stabilizeInventoryMock: vi.fn(async () => ({
    freeSlotCount: 4,
    invariants: { desyncSuspected: false },
  })),
}))

vi.mock('../../skills/world', () => ({
  getInventoryCounts: vi.fn(() => inventorySnapshots.shift() ?? {}),
}))

vi.mock('../../libs/llm-agent/world-state', () => ({
  buildWorldStateSnapshot: buildWorldStateSnapshotMock,
}))

vi.mock('../../skills/block-access', () => ({
  getNearestBlockAccurate: accurateNearestBlockMock,
}))

vi.mock('../../skills/actions/world-interactions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../skills/actions/world-interactions')>()
  return {
    ...actual,
    getLastPlacedBlockRecord: lastPlacedBlockRecordMock,
    pickupNearbyItems: pickupNearbyItemsMock,
  }
})

vi.mock('../../skills/actions/inventory', () => ({
  preflightInventoryForAction: inventoryPreflightMock,
  verifyInventoryPostflight: inventoryPostflightMock,
  recoverInventoryFailure: inventoryRecoveryMock,
  stabilizeInventoryAfterAction: stabilizeInventoryMock,
}))

function withActionAbort<T extends object>(mineflayer: T): T {
  const target = mineflayer as Record<string, any>
  const currentSignalGetter = Object.getOwnPropertyDescriptor(Mineflayer.prototype, 'currentActionSignal')?.get
  target.logger = target.logger ?? { withFields: vi.fn(() => ({ log: vi.fn() })) }
  target.beginAction = Mineflayer.prototype.beginAction.bind(target)
  target.abortCurrentAction = Mineflayer.prototype.abortCurrentAction.bind(target)
  target.completeAction = Mineflayer.prototype.completeAction.bind(target)
  Object.defineProperty(target, 'currentActionSignal', {
    configurable: true,
    get: () => currentSignalGetter?.call(target),
  })
  return mineflayer
}

describe('action agent cleanup', () => {
  beforeEach(() => {
    inventoryPreflightMock.mockClear()
    inventoryPreflightMock.mockResolvedValue({
      ok: true,
      task: { actionKind: 'generic' },
      snapshot: { freeSlotCount: 4, invariants: { desyncSuspected: false } },
      actions: [],
      facts: [],
    } as any)
    inventoryPostflightMock.mockClear()
    inventoryPostflightMock.mockResolvedValue({
      ok: true,
      task: { actionKind: 'generic' },
      snapshot: { freeSlotCount: 4, invariants: { desyncSuspected: false } },
      actions: [],
      facts: [],
    } as any)
    inventoryRecoveryMock.mockClear()
    inventoryRecoveryMock.mockImplementation(async (_mineflayer: unknown, _step: unknown, failureClass: string) => ({
      recovered: true,
      failureClass,
      actions: ['refreshInventory'],
      snapshot: { freeSlotCount: 4, invariants: { desyncSuspected: false } },
    }))
    stabilizeInventoryMock.mockClear()
    stabilizeInventoryMock.mockResolvedValue({
      freeSlotCount: 4,
      invariants: { desyncSuspected: false },
    })
    buildWorldStateSnapshotMock.mockClear()
    buildWorldStateSnapshotMock.mockResolvedValue({
      terrainContext: 'surface_forest',
      surfaceEscapeNeeded: false,
    } as any)
  })

  it('emits interrupt when an action fails so action-specific cleanup can run', async () => {
    const mineflayer = {
      emit: vi.fn(),
      bot: {
        pathfinder: {
          stop: vi.fn(),
        },
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['failingAction', {
        name: 'failingAction',
        description: '',
        schema: z.object({}),
        perform: () => async () => {
          throw new Error('boom')
        },
      }],
    ])

    await expect(agent.performAction({
      tool: 'failingAction',
      description: 'fail',
      params: {},
    })).rejects.toThrow('boom')

    expect(mineflayer.emit).toHaveBeenCalledWith('interrupt')
    expect(mineflayer.bot.pathfinder.stop).toHaveBeenCalled()
  })

  it('downgrades recoverable search failures to warnings', async () => {
    const mineflayer = {
      emit: vi.fn(),
      bot: {
        pathfinder: {
          stop: vi.fn(),
        },
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-recoverable-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['searchForEntity', {
        name: 'searchForEntity',
        description: '',
        schema: z.object({}),
        perform: () => async () => {
          throw new Error('searchForEntity(animal) failed')
        },
      }],
    ])

    const warnMock = vi.fn()
    vi.spyOn(agent.logger, 'withError').mockReturnValue({
      warn: warnMock,
      error: vi.fn(),
    } as any)
    const errorSpy = vi.spyOn(agent.logger, 'error')

    await expect(agent.performAction({
      tool: 'searchForEntity',
      description: 'search for food',
      params: { type: 'animal' },
    })).rejects.toThrow('searchForEntity(animal) failed')

    expect(warnMock).toHaveBeenCalledWith('Action failed (recoverable)')
    expect(errorSpy).not.toHaveBeenCalledWith('Action failed')
  })

  it('uses the extended timeout for collectBlocks so gather recovery can finish', async () => {
    vi.useFakeTimers()

    try {
      const mineflayer = {
        emit: vi.fn(),
        bot: {
          pathfinder: {
            stop: vi.fn(),
          },
        },
      } as any

      const agent = new ActionAgentImpl({
        id: 'action-timeout-test',
        type: 'action',
        bot: withActionAbort(mineflayer),
      }) as any

      agent.initialized = true
      agent.actions = new Map([
        ['collectBlocks', {
          name: 'collectBlocks',
          description: '',
          schema: z.object({}),
          perform: () => async () => await new Promise(() => {}),
        }],
      ])

      const handledPromise = agent.performAction({
        tool: 'collectBlocks',
        description: 'collect logs',
        params: {},
      }).catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(299_999)
      await Promise.resolve()
      const pendingState = await Promise.race([
        handledPromise.then(() => 'settled'),
        Promise.resolve('pending'),
      ])
      expect(pendingState).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      await expect(handledPromise).resolves.toMatchObject({
        message: 'Action "collectBlocks" timed out after 300s',
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('uses the extended timeout for bootstrap craft recipes that can gather wood internally', async () => {
    vi.useFakeTimers()

    try {
      const mineflayer = {
        emit: vi.fn(),
        bot: {
          pathfinder: {
            stop: vi.fn(),
          },
        },
      } as any

      const agent = new ActionAgentImpl({
        id: 'action-timeout-craft-test',
        type: 'action',
        bot: withActionAbort(mineflayer),
      }) as any

      agent.initialized = true
      agent.actions = new Map([
        ['craftRecipe', {
          name: 'craftRecipe',
          description: '',
          schema: z.object({}),
          perform: () => async () => await new Promise(() => {}),
        }],
      ])

      const handledPromise = agent.performAction({
        tool: 'craftRecipe',
        description: 'craft wooden pickaxe',
        params: { recipe_name: 'wooden_pickaxe', num: 1 },
      }).catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(299_999)
      await Promise.resolve()
      const pendingState = await Promise.race([
        handledPromise.then(() => 'settled'),
        Promise.resolve('pending'),
      ])
      expect(pendingState).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      await expect(handledPromise).resolves.toMatchObject({
        message: 'Action "craftRecipe" timed out after 300s',
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps the default timeout for non-collection actions', async () => {
    vi.useFakeTimers()

    try {
      const mineflayer = {
        emit: vi.fn(),
        bot: {
          pathfinder: {
            stop: vi.fn(),
          },
        },
      } as any

      const agent = new ActionAgentImpl({
        id: 'action-timeout-default-test',
        type: 'action',
        bot: withActionAbort(mineflayer),
      }) as any

      agent.initialized = true
      agent.actions = new Map([
        ['moveAway', {
          name: 'moveAway',
          description: '',
          schema: z.object({}),
          perform: () => async () => await new Promise(() => {}),
        }],
      ])

      const handledPromise = agent.performAction({
        tool: 'moveAway',
        description: 'move',
        params: {},
      }).catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(89_999)
      await Promise.resolve()
      const pendingState = await Promise.race([
        handledPromise.then(() => 'settled'),
        Promise.resolve('pending'),
      ])
      expect(pendingState).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      await expect(handledPromise).resolves.toMatchObject({
        message: 'Action "moveAway" timed out after 90s',
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('accepts short recovery moveAway steps when the bot meaningfully repositions', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, {}, {})

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-moveaway-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['moveAway', {
        name: 'moveAway',
        description: '',
        schema: z.object({}),
        perform: () => async () => {
          mineflayer.bot.entity.position = { x: 1.4, y: 64, z: 0.3 }
          return 'ok'
        },
      }],
    ])

    await expect(agent.performAction({
      tool: 'moveAway',
      description: 'reposition slightly before retrying placement',
      params: { distance: 12 },
    })).resolves.toBe('ok')
  })

  it('does not verify nearbyBlocks when the scan returns no actionable blocks', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, {}, {})

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
      memory: {
        recordActionOutcome: vi.fn(),
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-nearby-blocks-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['nearbyBlocks', {
        name: 'nearbyBlocks',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'NEARBY_BLOCKS: none',
      }],
    ])

    await expect(agent.performAction({
      tool: 'nearbyBlocks',
      description: 'refresh nearby blocks before a recovery move',
      params: {},
      meta: { subgoalId: 'recovery-nearby-blocks' },
    })).rejects.toThrow('Action verification failed (nearbyBlocks): observation_empty')

    expect(mineflayer.memory.recordActionOutcome).toHaveBeenCalledWith(expect.objectContaining({
      actionName: 'nearbyBlocks',
      result: 'verification_failed',
      failureClass: 'observation_empty',
    }))
  })

  it('accepts goToCoordinates when the bot is already within the requested closeness', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, {}, {})

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: -358.6, y: 59, z: 257.5 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-goto-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['goToCoordinates', {
        name: 'goToCoordinates',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'arrived',
      }],
    ])

    await expect(agent.performAction({
      tool: 'goToCoordinates',
      description: 'approach the nearby ore vein',
      params: { x: -360, y: 56, z: 256, closeness: 4 },
    })).resolves.toBe('arrived')
  })

  it('accepts recoverTowardSurface when the bot climbs upward out of a shaft', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, {}, {})

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 12, y: 41, z: -6 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-surface-recovery-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['recoverTowardSurface', {
        name: 'recoverTowardSurface',
        description: '',
        schema: z.object({}),
        perform: () => async () => {
          mineflayer.bot.entity.position = { x: 12.2, y: 42.4, z: -5.9 }
          return 'surfaced'
        },
      }],
    ])

    await expect(agent.performAction({
      tool: 'recoverTowardSurface',
      description: 'escape the cramped cave shaft',
      params: { reason: 'surface-stall' },
    })).resolves.toBe('surfaced')
  })

  it('accepts recoverTowardSurface when surface recovery is already satisfied before movement', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, {}, {})

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 12, y: 68, z: -6 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-surface-recovery-satisfied-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['recoverTowardSurface', {
        name: 'recoverTowardSurface',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'already surfaced',
      }],
    ])

    await expect(agent.performAction({
      tool: 'recoverTowardSurface',
      description: 'confirm the surface recovery state',
      params: { reason: 'surface-recheck' },
    })).resolves.toBe('already surfaced')
    expect(buildWorldStateSnapshotMock).toHaveBeenCalledWith(mineflayer)
  })

  it('extends smeltItem timeout based on the requested batch size', async () => {
    vi.useFakeTimers()

    try {
      const mineflayer = {
        emit: vi.fn(),
        bot: {
          pathfinder: {
            stop: vi.fn(),
          },
        },
      } as any

      const agent = new ActionAgentImpl({
        id: 'action-timeout-smelt-test',
        type: 'action',
        bot: withActionAbort(mineflayer),
      }) as any

      agent.initialized = true
      agent.actions = new Map([
        ['smeltItem', {
          name: 'smeltItem',
          description: '',
          schema: z.object({}),
          perform: () => async () => await new Promise(() => {}),
        }],
      ])

      const handledPromise = agent.performAction({
        tool: 'smeltItem',
        description: 'smelt iron',
        params: { item_name: 'raw_iron', num: 9 },
      }).catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(152_999)
      await Promise.resolve()
      const pendingState = await Promise.race([
        handledPromise.then(() => 'settled'),
        Promise.resolve('pending'),
      ])
      expect(pendingState).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      await expect(handledPromise).resolves.toMatchObject({
        message: 'Action "smeltItem" timed out after 153s',
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('treats collectBlocks as failed when inventory does not change after execution', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, { oak_log: 0 }, { oak_log: 0 })
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)
    pickupNearbyItemsMock.mockReset()
    pickupNearbyItemsMock.mockResolvedValue(true)

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['collectBlocks', {
        name: 'collectBlocks',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'ok',
      }],
    ])

    await expect(agent.performAction({
      tool: 'collectBlocks',
      description: 'collect logs',
      params: { type: 'log', num: 4 },
    })).rejects.toThrow('inventory_unchanged')
  })

  it('recovers collectBlocks by picking up newly dropped items before failing verification', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, { coal: 0 }, { coal: 0 }, { coal: 2 })
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)
    pickupNearbyItemsMock.mockReset()

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    pickupNearbyItemsMock.mockImplementation(async () => {
      mineflayer.bot.entities = {}
      return true
    })

    const agent = new ActionAgentImpl({
      id: 'action-verify-pickup-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['collectBlocks', {
        name: 'collectBlocks',
        description: '',
        schema: z.object({}),
        perform: () => async () => {
          mineflayer.bot.entities = {
            coal1: { name: 'coal' },
            coal2: { name: 'coal' },
          }
          return 'ok'
        },
      }],
    ])

    await expect(agent.performAction({
      tool: 'collectBlocks',
      description: 'collect coal',
      params: { type: 'coal_ore', num: 2 },
    })).resolves.toBe('ok')
    expect(pickupNearbyItemsMock).toHaveBeenCalledWith(mineflayer, 6)
  })

  it('accepts iron ore collection when mining yields raw iron instead of ore blocks', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, { raw_iron: 0 }, { raw_iron: 1 })
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)
    pickupNearbyItemsMock.mockReset()

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-verify-raw-iron-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['collectBlocks', {
        name: 'collectBlocks',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'ok',
      }],
    ])

    await expect(agent.performAction({
      tool: 'collectBlocks',
      description: 'collect iron ore',
      params: { type: 'iron_ore', num: 1 },
    })).resolves.toBe('ok')
    expect(pickupNearbyItemsMock).not.toHaveBeenCalled()
  })

  it('accepts collectBlocks when the requested count was already satisfied before the action', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, { birch_log: 5 }, { birch_log: 5 })
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)
    pickupNearbyItemsMock.mockReset()

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-verify-already-have-blocks-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['collectBlocks', {
        name: 'collectBlocks',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'already have enough logs',
      }],
    ])

    await expect(agent.performAction({
      tool: 'collectBlocks',
      description: 'collect a log if needed',
      params: { type: 'log', num: 1 },
    })).resolves.toBe('already have enough logs')
    expect(pickupNearbyItemsMock).toHaveBeenCalledWith(mineflayer, 6)
  })

  it('treats localized nearby food animals as satisfying generic searchForEntity verification', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, {}, {})
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)
    pickupNearbyItemsMock.mockReset()

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {
          salmon: {
            id: 7,
            name: 'サケ',
            type: 'minecraft:salmon',
            position: { x: 2, y: 63, z: 2 },
          },
        },
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-verify-localized-entity-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([[
      'searchForEntity',
      {
        name: 'searchForEntity',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'ok',
      },
    ]])

    await expect(agent.performAction({
      tool: 'searchForEntity',
      description: 'search for nearby food',
      params: { type: 'animal', search_range: 64 },
    })).resolves.toBe('ok')
  })

  it('recovers collectBlocks when matching drops were already nearby from the previous attempt', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, { coal: 0 }, { coal: 0 }, { coal: 1 })
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)
    pickupNearbyItemsMock.mockReset()

    const coalEntities = {
      coal1: { name: 'coal' },
    }

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: coalEntities,
      },
    } as any

    pickupNearbyItemsMock.mockImplementation(async () => {
      mineflayer.bot.entities = {}
      return true
    })

    const agent = new ActionAgentImpl({
      id: 'action-verify-persistent-pickup-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([[
      'collectBlocks',
      {
        name: 'collectBlocks',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'ok',
      },
    ]])

    await expect(agent.performAction({
      tool: 'collectBlocks',
      description: 'collect coal',
      params: { type: 'coal_ore', num: 1 },
    })).resolves.toBe('ok')
    expect(pickupNearbyItemsMock).toHaveBeenCalledWith(mineflayer, 6)
  })

  it('accepts placeHere when the placed block is visible nearby even if inventory remains stale', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, { furnace: 1 }, { furnace: 1 })
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue({
      type: 'furnace',
      position: { x: 0, y: 64, z: 0 },
      at: Date.now(),
    })

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
        scanNearbyBlocks: vi.fn(async () => {}),
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-place-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['placeHere', {
        name: 'placeHere',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'placed',
      }],
    ])

    await expect(agent.performAction({
      tool: 'placeHere',
      description: 'place furnace',
      params: { type: 'furnace' },
    })).resolves.toBe('placed')
    expect(mineflayer.bot.scanNearbyBlocks).toHaveBeenCalled()
    expect(lastPlacedBlockRecordMock).toHaveBeenCalled()
  })

  it('accepts searchForBlock when the target block is visible nearby even if the movement delta stays small', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, {}, {})
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue({
      name: 'oak_log',
      position: { x: 2, y: 66, z: 1 },
    })
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)

    const position = { x: 0, y: 64, z: 0 }
    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position,
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
        scanNearbyBlocks: vi.fn(async () => {}),
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-search-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['searchForBlock', {
        name: 'searchForBlock',
        description: '',
        schema: z.object({}),
        perform: () => async () => {
          mineflayer.bot.entity.position = { x: 1.2, y: 64, z: 0.8 }
          return 'found'
        },
      }],
    ])

    await expect(agent.performAction({
      tool: 'searchForBlock',
      description: 'search for oak logs nearby',
      params: { type: 'oak_log', search_range: 16 },
    })).resolves.toBe('found')
    expect(mineflayer.bot.scanNearbyBlocks).toHaveBeenCalledWith(16, ['oak_log'])
    expect(accurateNearestBlockMock).toHaveBeenCalledWith(mineflayer, 'oak_log', 16)
  })

  it('accepts an explicitly deferred wood search so collection can run the trunk-aware fallback', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, {}, {})
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)

    const position = { x: 0, y: 64, z: 0 }
    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position,
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
        scanNearbyBlocks: vi.fn(async () => {}),
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-search-wood-deferred-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['searchForBlock', {
        name: 'searchForBlock',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'Wood search deferred to trunk-aware collection.',
      }],
    ])

    await expect(agent.performAction({
      tool: 'searchForBlock',
      description: 'search for logs nearby',
      params: { type: 'log', search_range: 64 },
    })).resolves.toBe('Wood search deferred to trunk-aware collection.')
    expect(accurateNearestBlockMock).toHaveBeenCalledWith(mineflayer, 'log', 64)
  })

  it('accepts craftRecipe(crafting_table) when a nearby table is already available after ensureCraftingTable', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, {}, {})
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue({
      name: 'crafting_table',
      position: { x: 1, y: 64, z: 0 },
    })
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
        scanNearbyBlocks: vi.fn(async () => {}),
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-crafting-table-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['craftRecipe', {
        name: 'craftRecipe',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'Crafting table is ready.',
      }],
    ])

    await expect(agent.performAction({
      tool: 'craftRecipe',
      description: 'ensure crafting table access',
      params: { recipe_name: 'crafting_table', num: 1 },
    })).resolves.toBe('Crafting table is ready.')
    expect(mineflayer.bot.scanNearbyBlocks).toHaveBeenCalledWith(6, ['crafting_table'])
    expect(accurateNearestBlockMock).toHaveBeenCalledWith(mineflayer, 'crafting_table', 6)
  })

  it('accepts craftRecipe(wooden_pickaxe) when a stronger pickaxe is already available', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, { stone_pickaxe: 1 }, { stone_pickaxe: 1 })
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: { name: 'cobblestone' },
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-pickaxe-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['craftRecipe', {
        name: 'craftRecipe',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'Pickaxe crafted/prepared.',
      }],
    ])

    await expect(agent.performAction({
      tool: 'craftRecipe',
      description: 'ensure pickaxe for mining coal ore',
      params: { recipe_name: 'wooden_pickaxe', num: 1 },
    })).resolves.toBe('Pickaxe crafted/prepared.')
  })

  it('accepts generic oak plank bootstrap crafts when another plank family was produced', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, { birch_log: 6 }, { birch_log: 5, birch_planks: 4 })
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-plank-family-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['craftRecipe', {
        name: 'craftRecipe',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'Planks crafted.',
      }],
    ])

    await expect(agent.performAction({
      tool: 'craftRecipe',
      description: 'craft bootstrap planks',
      params: { recipe_name: 'oak_planks', num: 1 },
    })).resolves.toBe('Planks crafted.')
  })

  it('verifies charcoal smelting against charcoal output instead of the source log item', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, { oak_log: 8 }, { oak_log: 7, charcoal: 1 })
    accurateNearestBlockMock.mockReset()
    accurateNearestBlockMock.mockResolvedValue(null)
    lastPlacedBlockRecordMock.mockReset()
    lastPlacedBlockRecordMock.mockReturnValue(null)

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: null,
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-charcoal-verify-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([
      ['smeltItem', {
        name: 'smeltItem',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'Charcoal ready.',
      }],
    ])

    await expect(agent.performAction({
      tool: 'smeltItem',
      description: 'smelt charcoal from oak logs',
      params: { item_name: 'oak_log', num: 1 },
    })).resolves.toBe('Charcoal ready.')
  })

  it('runs inventory preflight and stabilization for equip-dependent actions', async () => {
    inventorySnapshots.splice(0, inventorySnapshots.length, { stone: 0 }, { stone: 1 })

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        entity: {
          position: { x: 0, y: 64, z: 0 },
        },
        inventory: {
          selectedSlot: 0,
        },
        heldItem: { name: 'iron_pickaxe' },
        pathfinder: {
          stop: vi.fn(),
        },
        entities: {},
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-inventory-preflight-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([[
      'collectBlocks',
      {
        name: 'collectBlocks',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'ok',
      },
    ]])

    await expect(agent.performAction({
      tool: 'collectBlocks',
      description: 'collect stone',
      params: { type: 'stone', num: 1 },
    })).resolves.toBe('ok')

    expect(inventoryPreflightMock).toHaveBeenCalledWith(mineflayer, expect.objectContaining({ tool: 'collectBlocks' }))
    expect(inventoryPostflightMock).toHaveBeenCalled()
    expect(stabilizeInventoryMock).toHaveBeenCalled()
  })

  it('aborts after the same inventory failure repeats three times for one subgoal', async () => {
    inventoryPreflightMock.mockResolvedValue({
      ok: false,
      failureClass: 'selected_slot_mismatch',
      task: { actionKind: 'mine' },
      snapshot: { freeSlotCount: 1, invariants: { desyncSuspected: false } },
      actions: ['select:0'],
      facts: ['inventory_desync: clear'],
    } as any)

    const mineflayer = {
      emit: vi.fn(),
      bot: {
        pathfinder: {
          stop: vi.fn(),
        },
      },
    } as any

    const agent = new ActionAgentImpl({
      id: 'action-repeated-inventory-failure-test',
      type: 'action',
      bot: withActionAbort(mineflayer),
    }) as any

    agent.initialized = true
    agent.actions = new Map([[
      'collectBlocks',
      {
        name: 'collectBlocks',
        description: '',
        schema: z.object({}),
        perform: () => async () => 'should-not-run',
      },
    ]])

    const step = {
      tool: 'collectBlocks',
      description: 'collect stone',
      params: { type: 'stone', num: 1 },
      meta: { subgoalId: 'mine-stone' },
    }

    await expect(agent.performAction(step)).rejects.toThrow('Inventory preflight failed (selected_slot_mismatch)')
    await expect(agent.performAction(step)).rejects.toThrow('Inventory preflight failed (selected_slot_mismatch)')
    await expect(agent.performAction(step)).rejects.toThrow('Repeated failing action aborted (selected_slot_mismatch)')

    expect(inventoryRecoveryMock).toHaveBeenCalledTimes(3)
  })
})
