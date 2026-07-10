import { Vec3 } from 'vec3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ReflexController } from './reflex'

function createFakeMineflayer(options: {
  health?: number
  entities?: Record<string, any>
  feetBlock?: string
} = {}) {
  const abortCurrentAction = vi.fn()
  const completeAction = vi.fn()
  const controllers: AbortController[] = []
  const listeners = new Map<string, Array<(...args: any[]) => void>>()

  const bot = {
    health: options.health ?? 20,
    food: 20,
    entity: {
      position: new Vec3(0, 64, 0),
      onFire: false,
    },
    entities: options.entities ?? {},
    blockAt: vi.fn(() => ({ name: options.feetBlock ?? 'grass_block' })),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const existing = listeners.get(event) ?? []
      existing.push(handler)
      listeners.set(event, existing)
    }),
    off: vi.fn(),
  }

  const mineflayer = {
    bot,
    username: 'AIra',
    beginAction: vi.fn((label: string) => {
      const controller = new AbortController()
      controllers.push(controller)
      void label
      return controller.signal
    }),
    abortCurrentAction,
    completeAction,
  } as any

  return {
    mineflayer,
    bot,
    emitHealth: () => {
      for (const handler of listeners.get('health') ?? []) {
        handler()
      }
    },
  }
}

function hostileEntity(name: string, position: Vec3) {
  return {
    id: Math.floor(Math.random() * 100000),
    name,
    type: 'hostile',
    position,
  }
}

describe('reflexController', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('flees when a creeper is within danger distance, preempting the current action', async () => {
    const creeper = hostileEntity('creeper', new Vec3(3, 64, 0))
    const { mineflayer } = createFakeMineflayer({ entities: { 1: creeper } })
    const flee = vi.fn(async () => true)

    const reflex = new ReflexController(mineflayer, {
      skills: { flee, defend: vi.fn(async () => true), eat: vi.fn(async () => true), escape: vi.fn(async () => true) },
    })

    const events: string[] = []
    reflex.on('reflex', event => events.push(event.kind))

    await (reflex as any).evaluate('scan')

    expect(flee).not.toHaveBeenCalled()

    ;(reflex as any).started = true
    await (reflex as any).evaluate('scan')

    expect(flee).toHaveBeenCalledTimes(1)
    expect(mineflayer.beginAction).toHaveBeenCalledWith('reflex:creeper-flee')
    expect(mineflayer.completeAction).toHaveBeenCalled()
    expect(events).toEqual(['creeper-flee'])
    expect(reflex.isEngaged()).toBe(false)
  })

  it('defends itself when damaged with a hostile nearby', async () => {
    const zombie = hostileEntity('zombie', new Vec3(5, 64, 0))
    const { mineflayer, bot, emitHealth } = createFakeMineflayer({ entities: { 1: zombie } })
    const defend = vi.fn(async () => true)

    const reflex = new ReflexController(mineflayer, {
      skills: { flee: vi.fn(async () => true), defend, eat: vi.fn(async () => true), escape: vi.fn(async () => true) },
    })
    reflex.start()

    try {
      // First health event just records the baseline; the drop triggers the reflex.
      emitHealth()
      bot.health = 14
      emitHealth()
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(defend).toHaveBeenCalledTimes(1)
      expect(mineflayer.beginAction).toHaveBeenCalledWith('reflex:combat-defense')
    }
    finally {
      reflex.stop()
    }
  })

  it('retreats and eats at critical health with hostiles nearby', async () => {
    const skeleton = hostileEntity('skeleton', new Vec3(7, 64, 0))
    const { mineflayer } = createFakeMineflayer({ health: 6, entities: { 1: skeleton } })
    const flee = vi.fn(async () => true)
    const eat = vi.fn(async () => true)

    const reflex = new ReflexController(mineflayer, {
      skills: { flee, defend: vi.fn(async () => true), eat, escape: vi.fn(async () => true) },
    })
    ;(reflex as any).started = true

    await (reflex as any).evaluate('scan')

    expect(flee).toHaveBeenCalledTimes(1)
    expect(eat).toHaveBeenCalledTimes(1)
    expect(mineflayer.beginAction).toHaveBeenCalledWith('reflex:emergency-retreat')
  })

  it('escapes lava before considering combat', async () => {
    const zombie = hostileEntity('zombie', new Vec3(2, 64, 0))
    const { mineflayer } = createFakeMineflayer({ entities: { 1: zombie }, feetBlock: 'lava' })
    const escape = vi.fn(async () => true)
    const defend = vi.fn(async () => true)

    const reflex = new ReflexController(mineflayer, {
      skills: { flee: vi.fn(async () => true), defend, eat: vi.fn(async () => true), escape },
    })
    ;(reflex as any).started = true

    await (reflex as any).evaluate('scan')

    expect(escape).toHaveBeenCalledTimes(1)
    expect(defend).not.toHaveBeenCalled()
  })

  it('respects the cooldown between responses and does not re-enter while engaged', async () => {
    const creeper = hostileEntity('creeper', new Vec3(3, 64, 0))
    const { mineflayer } = createFakeMineflayer({ entities: { 1: creeper } })

    let resolveFlee: (() => void) | undefined
    const flee = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveFlee = () => resolve(true)
    }))

    const reflex = new ReflexController(mineflayer, {
      skills: { flee: flee as any, defend: vi.fn(async () => true), eat: vi.fn(async () => true), escape: vi.fn(async () => true) },
    })
    ;(reflex as any).started = true

    const first = (reflex as any).evaluate('scan')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(reflex.isEngaged()).toBe(true)

    // Re-entrancy guard: a second evaluation while engaged must not double-trigger.
    await (reflex as any).evaluate('scan')
    expect(flee).toHaveBeenCalledTimes(1)

    resolveFlee?.()
    await first

    // Cooldown guard: immediately after resolving, the danger is still there
    // but the reflex must wait before re-triggering.
    await (reflex as any).evaluate('scan')
    expect(flee).toHaveBeenCalledTimes(1)
  })
})
