import { Vec3 } from 'vec3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let now = 0

vi.mock('@moeru/std', () => ({
  sleep: vi.fn(async (duration = 0) => {
    now += duration
  }),
}))

vi.mock('../libs/mineflayer/action-abort', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../libs/mineflayer/action-abort')>()
  return {
    ...actual,
    abortableSleep: vi.fn(async (duration = 0) => {
      now += duration
    }),
  }
})

const { goToBed } = await import('./movement')

describe('goToBed', () => {
  beforeEach(() => {
    now = 0
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })

  it('returns false when sleep state never resolves', async () => {
    const bedPosition = new Vec3(1, 64, 1)
    const mineflayer = {
      bot: {
        chat: vi.fn(),
        findBlocks: vi.fn(() => [bedPosition]),
        blockAt: vi.fn(() => ({ name: 'red_bed', position: bedPosition })),
        sleep: vi.fn(async () => {}),
        wake: vi.fn(async () => {}),
        isSleeping: true,
        entity: {
          position: new Vec3(0, 64, 0),
        },
        pathfinder: {
          goto: vi.fn(async () => {}),
        },
      },
      allowCheats: false,
    } as any

    const success = await goToBed(mineflayer)

    expect(success).toBe(false)
    expect(mineflayer.bot.wake).toHaveBeenCalledOnce()
  })
})
