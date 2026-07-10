import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const publishPrerenderedVoiceMock = vi.hoisted(() => vi.fn())
const generateLocalVoiceMock = vi.hoisted(() => vi.fn(async (text: string) => ({
  provider: 'local-tts' as const,
  model: 'style-bert-vits2:0:0',
  mimeType: 'audio/wav',
  audio: Buffer.from(text).toString('base64'),
})))

vi.mock('./output', () => ({
  generateLocalVoice: generateLocalVoiceMock,
  publishPrerenderedVoiceToAiri: publishPrerenderedVoiceMock,
}))

vi.mock('../../composables/config', () => ({
  config: {
    localTts: {
      enabled: true,
      provider: 'style-bert-vits2',
      baseUrl: 'http://localhost:5000',
      styleBertVits2ModelId: 0,
      styleBertVits2SpeakerId: 0,
      speaker: 0,
    },
  },
}))

const { REACTION_PHRASES, VoiceBank } = await import('./voice-bank')

describe('voiceBank', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airi-voice-bank-test-'))
    path = join(dir, 'voice-bank.json')
    publishPrerenderedVoiceMock.mockClear()
    generateLocalVoiceMock.mockClear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('synthesizes all phrases once and plays with the event timestamp', async () => {
    const bank = new VoiceBank(undefined, path)
    await bank.prepare()

    const totalPhrases = Object.values(REACTION_PHRASES).flat().length
    expect(generateLocalVoiceMock).toHaveBeenCalledTimes(totalPhrases)
    expect(bank.isReady).toBe(true)

    const eventAt = Date.now() - 1_000
    expect(bank.play('creeper-flee', eventAt)).toBe(true)
    expect(publishPrerenderedVoiceMock).toHaveBeenCalledTimes(1)
    const [, text, voice, , options] = publishPrerenderedVoiceMock.mock.calls[0]
    expect(REACTION_PHRASES['creeper-flee']).toContain(text)
    expect(voice.audio.length).toBeGreaterThan(0)
    expect(options.eventAt).toBe(eventAt)
  })

  it('respects the per-kind cooldown', async () => {
    const bank = new VoiceBank(undefined, path)
    await bank.prepare()

    expect(bank.play('death')).toBe(true)
    expect(bank.play('death')).toBe(false)
    expect(publishPrerenderedVoiceMock).toHaveBeenCalledTimes(1)
  })

  it('reuses the persisted cache instead of re-synthesizing', async () => {
    const first = new VoiceBank(undefined, path)
    await first.prepare()
    const synthesizedFirst = generateLocalVoiceMock.mock.calls.length

    generateLocalVoiceMock.mockClear()
    const second = new VoiceBank(undefined, path)
    await second.prepare()

    expect(synthesizedFirst).toBeGreaterThan(0)
    expect(generateLocalVoiceMock).not.toHaveBeenCalled()
    expect(second.isReady).toBe(true)
  })

  it('is a silent no-op when nothing could be synthesized', async () => {
    generateLocalVoiceMock.mockResolvedValue(undefined as any)
    const bank = new VoiceBank(undefined, path)
    await bank.prepare()

    expect(bank.isReady).toBe(false)
    expect(bank.play('creeper-flee')).toBe(false)
    expect(publishPrerenderedVoiceMock).not.toHaveBeenCalled()
  })
})
