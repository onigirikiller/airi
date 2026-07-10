import type { Client } from '@proj-airi/server-sdk'

import type { Logger } from '../../utils/logger'
import type { OutputVoicePayload } from './output'

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { config } from '../../composables/config'
import { useLogger } from '../../utils/logger'
import { generateLocalVoice, publishPrerenderedVoiceToAiri } from './output'

/**
 * Instant-reaction voice bank: short interjections pre-synthesized with the
 * local TTS voice before the stream starts. Reflex events trigger playback
 * with zero generation latency and zero LLM tokens — the first scream of a
 * two-tier reaction (the considered LLM comment follows separately).
 */

export type ReactionKind
  = | 'creeper-flee'
    | 'combat-defense'
    | 'emergency-retreat'
    | 'lava-escape'
    | 'death'
    | 'diamond'
    | 'milestone'

export const REACTION_PHRASES: Record<ReactionKind, string[]> = {
  'creeper-flee': [
    'うわっ、クリーパー！？',
    'ちょっ、爆発する爆発する！',
    'クリーパーさんこっち来ないで～！',
    '逃げるが勝ちー！',
  ],
  'combat-defense': [
    '敵！？やるしかない！',
    'いったーい！反撃するもん！',
    'こっち来ないで！えいっ！',
    'もう、邪魔しないでよ！',
  ],
  'emergency-retreat': [
    'やばいやばい、体力やばい！',
    '一旦逃げる！ごめん逃げる！',
    '死んじゃう死んじゃう！！',
  ],
  'lava-escape': [
    'あっつ！！マグマ！？',
    '燃えてる燃えてる！！',
    '熱い熱い熱い！！',
  ],
  'death': [
    'あ……死んだ……',
    'うそでしょ……リスポーンします……',
    'やられた～……次は勝つもん……',
  ],
  'diamond': [
    'ダイヤ！！きたーーー！！',
    'うそ！ダイヤある！！やった！！',
  ],
  'milestone': [
    'よし、目標達成！',
    '一歩前進！えらい！',
    'ミッションコンプリート！',
  ],
}

interface CachedClip {
  textHash: string
  voice: OutputVoicePayload
}

interface PersistedVoiceBank {
  version: 1
  ttsSignature: string
  clips: Record<string, CachedClip>
}

const PLAY_COOLDOWN_PER_KIND_MS = 8_000

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function currentTtsSignature(): string {
  return [
    config.localTts.provider,
    config.localTts.baseUrl,
    config.localTts.styleBertVits2ModelId,
    config.localTts.styleBertVits2SpeakerId,
    config.localTts.speaker,
  ].join('::')
}

export class VoiceBank {
  private readonly logger: Logger = useLogger()
  private readonly persistencePath: string
  private clips = new Map<string, OutputVoicePayload>()
  private lastPlayedIndex = new Map<ReactionKind, number>()
  private lastPlayedAt = new Map<ReactionKind, number>()
  private prepared = false
  private preparing: Promise<void> | null = null

  constructor(
    private readonly airiClient: Client | undefined,
    persistencePath?: string,
  ) {
    this.persistencePath = persistencePath
      ?? join(tmpdir(), 'airi-minecraft-state', 'voice-bank.json')
  }

  /** Synthesizes and caches every phrase. Safe to call repeatedly. */
  public prepare(): Promise<void> {
    if (this.preparing) {
      return this.preparing
    }
    this.preparing = this.prepareInternal().finally(() => {
      this.preparing = null
    })
    return this.preparing
  }

  private async prepareInternal(): Promise<void> {
    if (!config.localTts.enabled) {
      this.logger.log('Voice bank disabled: local TTS is not enabled')
      return
    }

    const signature = currentTtsSignature()
    this.loadCache(signature)

    let synthesized = 0
    let failed = 0
    for (const phrases of Object.values(REACTION_PHRASES)) {
      for (const text of phrases) {
        const key = hashText(text)
        if (this.clips.has(key)) {
          continue
        }
        try {
          const voice = await generateLocalVoice(text, this.logger, 'low')
          if (voice) {
            this.clips.set(key, voice)
            synthesized++
          }
          else {
            failed++
          }
        }
        catch (error) {
          failed++
          this.logger.withError(error).warn('Voice bank synthesis failed for a phrase')
        }
      }
    }

    if (synthesized > 0) {
      this.saveCache(signature)
    }
    this.prepared = this.clips.size > 0
    this.logger.withFields({
      cached: this.clips.size,
      synthesized,
      failed,
    }).log('Voice bank prepared')
  }

  public get isReady(): boolean {
    return this.prepared
  }

  /**
   * Plays a random non-repeating variation for the reaction, released on the
   * presentation clock at the event's on-screen moment. Returns false when
   * no clip is available or the kind is cooling down.
   */
  public play(kind: ReactionKind, eventAt = Date.now()): boolean {
    const now = Date.now()
    const lastAt = this.lastPlayedAt.get(kind) ?? 0
    if (now - lastAt < PLAY_COOLDOWN_PER_KIND_MS) {
      return false
    }

    const phrases = REACTION_PHRASES[kind]
    const available = phrases
      .map((text, index) => ({ text, index, voice: this.clips.get(hashText(text)) }))
      .filter(entry => entry.voice)
    if (available.length === 0) {
      return false
    }

    const lastIndex = this.lastPlayedIndex.get(kind)
    const candidates = available.length > 1
      ? available.filter(entry => entry.index !== lastIndex)
      : available
    const chosen = candidates[Math.floor(Math.random() * candidates.length)]

    this.lastPlayedIndex.set(kind, chosen.index)
    this.lastPlayedAt.set(kind, now)
    publishPrerenderedVoiceToAiri(this.airiClient, chosen.text, chosen.voice!, this.logger, {
      eventAt,
    })
    this.logger.withFields({ kind, text: chosen.text }).log('Voice bank reaction played')
    return true
  }

  private loadCache(signature: string): void {
    try {
      if (!existsSync(this.persistencePath)) {
        return
      }
      const parsed = JSON.parse(readFileSync(this.persistencePath, 'utf8')) as PersistedVoiceBank
      if (parsed?.version !== 1 || parsed.ttsSignature !== signature) {
        return
      }
      for (const [key, clip] of Object.entries(parsed.clips ?? {})) {
        if (clip?.voice?.audio) {
          this.clips.set(key, clip.voice)
        }
      }
    }
    catch (error) {
      this.logger.withError(error).warn('Failed to load voice bank cache; re-synthesizing')
    }
  }

  private saveCache(signature: string): void {
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      const clips: Record<string, CachedClip> = {}
      for (const [key, voice] of this.clips) {
        clips[key] = { textHash: key, voice }
      }
      const payload: PersistedVoiceBank = { version: 1, ttsSignature: signature, clips }
      writeFileSync(this.persistencePath, JSON.stringify(payload), 'utf8')
    }
    catch (error) {
      this.logger.withError(error).warn('Failed to persist voice bank cache')
    }
  }
}
