import EventEmitter from 'eventemitter3'
import pathfinder from 'mineflayer-pathfinder'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Vec3Simple } from './bot-proxy'
import { BaritonePathfinder } from './pathfinder'

const { goals } = pathfinder

class MockWsClient extends EventEmitter {
  connected = true
  request = vi.fn(async () => ({}))
  send = vi.fn()
}

describe('baritonePathfinder look assist', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('faces the current movement direction while moving', () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ;(pathfinder as any).moving = true
    ;(pathfinder as any).startMovementLookAssist({ x: 10, z: 0 })

    position.x = 1
    vi.advanceTimersByTime(160)

    expect(ws.send).toHaveBeenCalledWith('look', { yaw: -90, pitch: 0 })
  })

  it('stops sending look updates after stop', () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ;(pathfinder as any).moving = true
    ;(pathfinder as any).startMovementLookAssist({ x: 0, z: 10 })
    pathfinder.stop()

    position.z = 2
    vi.advanceTimersByTime(400)

    const lookCalls = ws.send.mock.calls.filter(([command]) => command === 'look')
    expect(lookCalls).toHaveLength(0)
  })

  it('smooths abrupt yaw changes instead of snapping instantly', () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ;(pathfinder as any).lastSentLook = { yaw: 0, pitch: 0 }
    ;(pathfinder as any).sendSmoothedLook(-90, 0)

    expect(ws.send).toHaveBeenCalledWith('look', { yaw: -24, pitch: 0 })
  })

  it('scales path timeout by goal distance and caps it', () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    expect((pathfinder as any).getPathTimeoutMs({ x: 0, y: 76, z: 0 })).toBe(45_000)
    expect((pathfinder as any).getPathTimeoutMs({ x: 10, z: 0 })).toBe(30000)
    expect((pathfinder as any).getPathTimeoutMs({ x: 80, z: 0 })).toBe(60000)
    expect((pathfinder as any).getPathTimeoutMs({ x: 500, z: 0 })).toBe(75000)
    expect((pathfinder as any).getPathTimeoutMs()).toBe(60000)
  })

  it('rejects goto when simple walk gives up without reaching the target', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'goto' || command === 'gotoNear') {
        throw new Error('baritone unavailable')
      }
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      return {}
    })

    const gotoPromise = pathfinder.goto({ x: 30, z: 0 })
    const assertion = expect(gotoPromise).rejects.toThrow('Failed to reach')
    await vi.runAllTimersAsync()

    await assertion
  }, 10000)

  it('resolves goto when simple walk reaches the target after websocket fallback', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'goto' || command === 'gotoNear') {
        throw new Error('baritone unavailable')
      }
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      return {}
    })
    ws.send.mockImplementation((command: string) => {
      if (command === 'look') {
        position.x = 4
        position.z = 0
      }
    })

    const gotoPromise = pathfinder.goto({ x: 4, z: 0, range: 1 })
    await vi.runAllTimersAsync()

    await expect(gotoPromise).resolves.toBeUndefined()
  }, 10000)

  it('rejects goto when simple walk is interrupted before reaching the target', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'goto' || command === 'gotoNear') {
        throw new Error('baritone unavailable')
      }
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      return {}
    })

    const gotoPromise = pathfinder.goto({ x: 20, z: 0 })
    const assertion = expect(gotoPromise).rejects.toThrow('Failed to reach')
    await vi.advanceTimersByTimeAsync(250)
    pathfinder.stop()
    await vi.runAllTimersAsync()

    await assertion
  }, 10000)

  it('uses remote walk fallback for regular ground movement when moveToward is available', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      const payload = (args[1] as Record<string, unknown> | undefined) ?? {}
      if (command === 'goto' || command === 'gotoNear') {
        throw new Error('baritone unavailable')
      }
      if (command === 'moveToward') {
        position.x = Number(payload.x ?? 0)
        position.y = Number(payload.y ?? 64)
        position.z = Number(payload.z ?? 0)
        return { status: 'moving' }
      }
      return {}
    })

    const gotoPromise = pathfinder.goto({ x: 6, y: 64, z: 0, range: 1 })
    await vi.runAllTimersAsync()

    await expect(gotoPromise).resolves.toBeUndefined()
    expect(ws.request).toHaveBeenCalledWith('moveToward', {
      x: 6,
      y: 64,
      z: 0,
      range: 1,
      movementMode: 'walk',
      timeoutMs: 60_000,
    }, 5000)
    expect(ws.send).toHaveBeenCalledWith('stopMovement', {})
  }, 10000)

  it('uses the goal timeout for the initial goto websocket request when one is provided', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'gotoNear') {
        return { status: 'ok' }
      }
      return {}
    })

    await expect(pathfinder.goto({ x: 0, y: 64, z: 0, range: 2, timeoutMs: 20_000 })).resolves.toBeUndefined()
    expect(ws.request).toHaveBeenCalledWith('gotoNear', { x: 0, y: 64, z: 0, range: 2 }, 20_000)
  })

  it('abandons remote walk when the bot jitters in place without closing distance', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)
    const originalSleep = (pathfinder as any).sleep.bind(pathfinder as any)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'goto' || command === 'gotoNear') {
        throw new Error('baritone unavailable')
      }
      if (command === 'moveToward') {
        return { status: 'moving' }
      }
      return {}
    })

    vi.spyOn(pathfinder as any, 'sleep').mockImplementation(async (...args: unknown[]) => {
      const ms = Number(args[0] ?? 0)
      position.x = position.x === 0 ? 0.06 : 0
      await originalSleep(ms)
    })

    const gotoPromise = pathfinder.goto({ x: 6, y: 64, z: 0, range: 1 })
    const assertion = expect(gotoPromise).rejects.toThrow('Failed to reach')
    await vi.runAllTimersAsync()

    await assertion
    expect(ws.request).toHaveBeenCalledWith('moveToward', {
      x: 6,
      y: 64,
      z: 0,
      range: 1,
      movementMode: 'walk',
      timeoutMs: 60_000,
    }, 5000)
    expect(ws.send).toHaveBeenCalledWith('stopMovement', {})
  }, 10000)

  it('falls back to the simple walk loop for regular movement when moveToward is unsupported', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)
    const simpleControlWalkToward = vi.spyOn(pathfinder as any, 'simpleControlWalkToward').mockImplementation(async () => {
      ;(pathfinder as any).moving = false
      ;(pathfinder as any).stopMovementLookAssist()
      return true
    })

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'goto' || command === 'gotoNear') {
        throw new Error('baritone unavailable')
      }
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      return {}
    })

    const gotoPromise = pathfinder.goto({ x: 6, y: 64, z: 0, range: 1 })
    await vi.runAllTimersAsync()

    await expect(gotoPromise).resolves.toBeUndefined()
    expect(ws.request).toHaveBeenCalledWith('moveToward', {
      x: 6,
      y: 64,
      z: 0,
      range: 1,
      movementMode: 'walk',
      timeoutMs: 60_000,
    }, 5000)
    expect(simpleControlWalkToward).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 6,
        y: 64,
        z: 0,
        range: 1,
        movementMode: 'walk',
      }),
      expect.objectContaining({
        targetX: 6,
        targetY: 64,
        targetZ: 0,
        range: 1,
        swimMode: false,
      }),
    )
  }, 10000)

  it('does not treat horizontal-only proximity as success when the goal requires a higher Y level', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 53, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'goto' || command === 'gotoNear') {
        throw new Error('baritone unavailable')
      }
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      return {}
    })
    ws.send.mockImplementation((command: string) => {
      if (command === 'look') {
        position.x = 0
        position.z = 0
      }
    })

    const gotoPromise = pathfinder.goto({ x: 0, y: 63, z: 0, range: 2 })
    const assertion = expect(gotoPromise).rejects.toThrow('Failed to reach')
    await vi.runAllTimersAsync()

    await assertion
    expect(ws.request).toHaveBeenCalledWith('baritone_status', {}, 3000)
    expect(ws.send).toHaveBeenCalledWith('setControlState', { control: 'jump', state: true })
  }, 10000)

  it('uses baritone for local vertical ascent when baritone is available', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 53, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'baritone_status') {
        return { available: true, isPathing: false, isActive: false }
      }
      if (command === 'gotoNear') {
        position.y = 63
        return { status: 'ok', method: 'baritone' }
      }
      return {}
    })

    await expect(pathfinder.goto({ x: 0, y: 63, z: 0, range: 2 })).resolves.toBeUndefined()
    expect(ws.request).toHaveBeenCalledWith('baritone_status', {}, 3000)
    expect(ws.request).toHaveBeenCalledWith('gotoNear', { x: 0, y: 63, z: 0, range: 2 }, 120000)
  })

  it('preserves the synthesized climb target when a GoalXZ cave escape falls back after baritone reports immediate success', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 57, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'baritone_status') {
        return { available: true, isPathing: false, isActive: false }
      }
      if (command === 'goto') {
        return { status: 'ok', method: 'baritone' }
      }
      if (command === 'moveToward') {
        position.y = 64
        return { status: 'moving' }
      }
      return {}
    })

    const gotoPromise = pathfinder.goto(new goals.GoalXZ(0, 0) as any)
    await vi.runAllTimersAsync()

    await expect(gotoPromise).resolves.toBeUndefined()
    expect(ws.request).toHaveBeenCalledWith('goto', { x: 0, y: 64, z: 0 }, 120000)
    expect(ws.request).toHaveBeenCalledWith('moveToward', {
      x: 0,
      y: 64,
      z: 0,
      range: 2,
      movementMode: 'walk',
      timeoutMs: 20_000,
    }, 5000)
  })

  it('retries close-range vertical ascent after partial progress instead of failing immediately', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'baritone_status') {
        return { available: true, isPathing: false, isActive: false }
      }
      if (command === 'gotoNear') {
        throw new Error('Pathfinding timed out (12000ms)')
      }
      return {}
    })

    vi.spyOn(pathfinder as any, 'tryRemoteWalkVerticalAscent').mockResolvedValue(false)
    vi.spyOn(pathfinder as any, 'simpleWalkToward')
      .mockImplementationOnce(async () => {
        position.x = 2.2
        position.y = 67
        return false
      })
      .mockImplementationOnce(async () => {
        position.x = 1
        position.y = 68
        return true
      })

    await expect(pathfinder.goto({ x: 1, y: 68, z: 0, range: 1 })).resolves.toBeUndefined()
    expect((pathfinder as any).simpleWalkToward).toHaveBeenCalledTimes(2)
    expect(position.y).toBe(68)
  })

  it('falls back to simple walk when gotoNear reports immediate success without reaching the goal', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'gotoNear') {
        return { status: 'ok', method: 'baritone' }
      }
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      return {}
    })
    ws.send.mockImplementation((command: string) => {
      if (command === 'look') {
        position.x = 4
      }
    })

    const gotoPromise = pathfinder.goto({ x: 4, z: 0, range: 1 })
    await vi.runAllTimersAsync()

    await expect(gotoPromise).resolves.toBeUndefined()
    expect(ws.send).toHaveBeenCalledWith('look', { yaw: -90, pitch: 0 })
  }, 10000)

  it('honors rangeSq from real mineflayer GoalNear objects during fallback movement', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'gotoNear') {
        return { status: 'ok', method: 'baritone' }
      }
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      return {}
    })
    ws.send.mockImplementation((command: string) => {
      if (command === 'look') {
        position.x = 2.2
        position.z = 0
      }
    })

    const gotoPromise = pathfinder.goto(new goals.GoalNear(4, 64, 0, 0.25) as any)
    const assertion = expect(gotoPromise).rejects.toThrow('Failed to reach')
    await vi.runAllTimersAsync()

    await assertion
    expect(ws.request).toHaveBeenCalledWith('gotoNear', {
      x: 4,
      y: 64,
      z: 0,
      range: 0.25,
    }, 120000)
  }, 10000)

  it('uses swim controls and extended tick budget for underwater fallback movement', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 53, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      const payload = (args[1] as Record<string, unknown> | undefined) ?? {}
      if (command === 'moveToward') {
        position.x = Number(payload.x)
        position.y = Number(payload.y ?? 53)
        position.z = Number(payload.z)
        return { status: 'moving' }
      }
      return {}
    })

    const gotoPromise = pathfinder.goto({ x: 4, z: 0, range: 1, movementMode: 'swim', timeoutMs: 180000 })
    await vi.runAllTimersAsync()

    await expect(gotoPromise).resolves.toBeUndefined()
    expect(ws.request).toHaveBeenCalledWith('moveToward', {
      x: 4,
      y: 57,
      z: 0,
      range: 1,
      movementMode: 'swim',
      timeoutMs: 180000,
    }, 5000)
    expect(ws.send).toHaveBeenCalledWith('stopMovement', {})
  }, 10000)

  it('falls back to the swim control loop with upward bias when moveToward is unsupported', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 53, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)
    const simpleControlWalkToward = vi.spyOn(pathfinder as any, 'simpleControlWalkToward').mockResolvedValue(true)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      if (command === 'baritone_status') {
        const probeError = new Error('baritone probe unavailable')
        probeError.message = ''
        throw probeError
      }
      return {}
    })

    const gotoPromise = pathfinder.goto({ x: 3, z: 0, range: 1, movementMode: 'swim', timeoutMs: 120000 })
    await vi.runAllTimersAsync()

    await expect(gotoPromise).resolves.toBeUndefined()
    expect(ws.request).toHaveBeenCalledWith('moveToward', {
      x: 3,
      y: 57,
      z: 0,
      range: 1,
      movementMode: 'swim',
      timeoutMs: 120000,
    }, 5000)
    expect(simpleControlWalkToward).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 3,
        z: 0,
        range: 1,
        movementMode: 'swim',
        timeoutMs: 120000,
      }),
      expect.objectContaining({
        targetX: 3,
        targetY: 57,
        targetZ: 0,
        range: 1,
        swimMode: true,
      }),
    )
  }, 10000)

  it('retries swim relocation through baritone when moveToward is unsupported', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 53, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)
    let baritoneStatusCalls = 0

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      if (command === 'gotoNear') {
        return { status: 'pathfinding', method: 'baritone' }
      }
      if (command === 'baritone_status') {
        baritoneStatusCalls++
        if (baritoneStatusCalls > 1) {
          position.x = 12
          position.y = 57
        }
        return { available: true, isPathing: false, isActive: false }
      }
      return {}
    })

    const gotoPromise = pathfinder.goto({ x: 12, z: 0, range: 2, movementMode: 'swim', timeoutMs: 120000 })
    await vi.runAllTimersAsync()

    await expect(gotoPromise).resolves.toBeUndefined()
    expect(ws.request).toHaveBeenCalledWith('gotoNear', {
      x: 12,
      y: 57,
      z: 0,
      range: 2,
    }, 10000)
  }, 10000)

  it('can proactively probe unsupported remote swim movement and missing baritone', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 53, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      if (command === 'baritone_status') {
        return { available: false, isPathing: false, isActive: false }
      }
      return {}
    })

    const debugState = await pathfinder.probeMovementCapabilities()

    expect(debugState.remoteMovementSupport).toBe('unsupported')
    expect(debugState.baritoneAvailability).toBe('unavailable')
    expect(debugState.lastSwimFallbackReason).toBe('Unknown command: moveToward')
    expect(ws.send).toHaveBeenCalledWith('stopMovement', {})
  })

  it('fails swim goto immediately when neither remote movement nor baritone is available', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 53, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'moveToward') {
        throw new Error('Unknown command: moveToward')
      }
      if (command === 'baritone_status') {
        return { available: false, isPathing: false, isActive: false }
      }
      return {}
    })

    await expect(pathfinder.goto({ x: 12, y: 61, z: 0, range: 2, movementMode: 'swim' }))
      .rejects
      .toThrow('Swim relocation unsupported')
    expect(ws.request).toHaveBeenCalledWith('baritone_status', {}, 3000)
  })

  it('tracks remote walk progress from a mutable bridge position object during local vertical ascent', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)
    let movementInterval: ReturnType<typeof setInterval> | undefined

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'baritone_status') {
        return { available: false, isPathing: false, isActive: false }
      }
      if (command === 'moveToward') {
        if (!movementInterval) {
          movementInterval = setInterval(() => {
            position.x = Math.min(position.x + 0.015, 2)
            position.y = Math.min(position.y + 0.04, 72)
          }, 100)
        }
        return { status: 'moving' }
      }
      return {}
    })

    try {
      const gotoPromise = pathfinder.goto({ x: 2, y: 72, z: 0, range: 1 })
      await vi.advanceTimersByTimeAsync(17_500)
      await expect(gotoPromise).resolves.toBeUndefined()
      expect(ws.request).toHaveBeenCalledWith('moveToward', {
        x: 2,
        y: 72,
        z: 0,
        range: 1,
        movementMode: 'walk',
        timeoutMs: 20_000,
      }, 5000)
    }
    finally {
      if (movementInterval) {
        clearInterval(movementInterval)
      }
    }
  }, 10000)

  it('rejects local vertical ascent when remote movement is interrupted before reaching the target', async () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 64, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    ws.request.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[0] ?? '')
      if (command === 'baritone_status') {
        return { available: false, isPathing: false, isActive: false }
      }
      if (command === 'moveToward') {
        return { status: 'moving' }
      }
      return {}
    })

    const gotoPromise = pathfinder.goto({ x: 2, y: 72, z: 0, range: 1 })
    const assertion = expect(gotoPromise).rejects.toThrow('Failed to reach')
    await vi.advanceTimersByTimeAsync(250)
    pathfinder.stop()
    await vi.runAllTimersAsync()

    await assertion
  }, 10000)

  it('allows longer baritone timeouts for close-range vertical cave ascents', () => {
    const ws = new MockWsClient()
    const position = new Vec3Simple(0, 65, 0)
    const pathfinder = new BaritonePathfinder(ws as any, () => position)

    expect((pathfinder as any).getPathTimeoutMs({ x: 2, y: 68, z: 0, range: 1 })).toBe(32_000)
    expect((pathfinder as any).getPathTimeoutMs({ x: 8, y: 68, z: 0, range: 1 })).toBe(30_000)
  })
})
