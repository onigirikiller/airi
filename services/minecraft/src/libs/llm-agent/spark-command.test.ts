import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../composables/config', () => ({
  config: {
    airi: {
      clientName: 'minecraft-bot',
    },
  },
}))

vi.mock('./plan-lock', () => ({
  withSharedPlanLock: vi.fn(async (_username: string, _source: string, _logger: any, run: () => Promise<void>) => {
    await run()
  }),
}))

const {
  buildGoalFromSparkCommand,
  handleSparkCommandEvent,
  isSparkCommandForMinecraft,
} = await import('./spark-command')

describe('spark command handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('recognizes minecraft-targeted destinations', () => {
    const bot = {
      username: 'AIRI',
      bot: {},
    } as any

    expect(isSparkCommandForMinecraft({
      destinations: ['minecraft'],
    }, bot)).toBe(true)

    expect(isSparkCommandForMinecraft({
      destinations: ['discord'],
    }, bot)).toBe(false)
  })

  it('builds an executable goal from ack and guidance steps', () => {
    const goal = buildGoalFromSparkCommand({
      ack: 'Craft a wooden pickaxe',
      guidance: {
        options: [{
          label: 'Bootstrap tools',
          steps: [
            'collect logs nearby',
            'craft planks and sticks',
            'craft a wooden pickaxe',
          ],
        }],
      },
      contexts: [{
        headline: 'Inventory',
        note: 'No pickaxe yet',
      }],
    })

    expect(goal).toContain('Craft a wooden pickaxe')
    expect(goal).toContain('collect logs nearby')
    expect(goal).toContain('craft a wooden pickaxe')
    expect(goal).toContain('No pickaxe yet')
  })

  it('pauses the runner, executes a plan, then resumes it', async () => {
    const createPlan = vi.fn(async (goal: string) => ({ goal, steps: [] }))
    const executePlan = vi.fn(async () => undefined)
    const pause = vi.fn()
    const resume = vi.fn()
    const send = vi.fn()

    const bot = {
      username: 'AIRI',
      planning: {
        createPlan,
        executePlan,
      },
      __gameRunner: {
        pause,
        resume,
        getDebugState: () => ({ paused: false }),
      },
      bot: {
        __gameRunner: {
          pause,
          resume,
          getDebugState: () => ({ paused: false }),
        },
      },
    } as any

    const logger = {
      withError: vi.fn(() => ({ warn: vi.fn() })),
    } as any

    const handled = await handleSparkCommandEvent({
      data: {
        id: 'spark-1',
        commandId: 'cmd-1',
        eventId: 'evt-1',
        intent: 'action',
        destinations: ['minecraft'],
        ack: 'Craft a wooden pickaxe',
        guidance: {
          options: [{
            steps: ['collect logs', 'craft planks', 'craft a wooden pickaxe'],
          }],
        },
      },
    }, bot, logger, { send } as any)

    expect(handled).toBe(true)
    expect(pause).toHaveBeenCalledOnce()
    expect(createPlan).toHaveBeenCalledWith(expect.stringContaining('Craft a wooden pickaxe'))
    expect(executePlan).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spark:emit',
    }))
  })

  it('handles pause and resume intents without planning', async () => {
    const pause = vi.fn()
    const resume = vi.fn()
    const send = vi.fn()
    const bot = {
      username: 'AIRI',
      planning: {
        createPlan: vi.fn(),
        executePlan: vi.fn(),
      },
      __gameRunner: {
        pause,
        resume,
        getDebugState: () => ({ paused: false }),
      },
      bot: {},
    } as any
    const logger = {} as any

    await handleSparkCommandEvent({
      data: {
        intent: 'pause',
        destinations: ['minecraft'],
      },
    }, bot, logger, { send } as any)

    await handleSparkCommandEvent({
      data: {
        intent: 'resume',
        destinations: ['minecraft'],
      },
    }, bot, logger, { send } as any)

    expect(pause).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
  })
})
