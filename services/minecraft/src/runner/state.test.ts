import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GameStateManager } from './state'

describe('game state manager', () => {
  afterEach(() => {
    rmSync(join(tmpdir(), 'airi-minecraft-state'), { recursive: true, force: true })
  })

  it('recreates the temp save directory before saving state', () => {
    const username = `state-test-${Date.now()}`
    const manager = new GameStateManager(username)
    const stateDir = join(tmpdir(), 'airi-minecraft-state')
    const savePath = join(stateDir, `${username}-progress.json`)

    rmSync(stateDir, { recursive: true, force: true })
    manager.recordStuck()

    expect(existsSync(savePath)).toBe(true)
  })
})
