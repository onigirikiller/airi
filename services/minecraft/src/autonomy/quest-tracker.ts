import type { VoiceBank } from '../libs/llm-agent/voice-bank'
import type { Mineflayer } from '../libs/mineflayer'
import type { ProgressionSnapshot, ProgressMilestone } from './progress'

import process from 'node:process'

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { monitorBus } from '../libs/monitor-event-bus'
import { useLogger } from '../utils/logger'
import { getActiveEmotionEngine } from './emotion'
import { collectWorldFacts } from './preconditions'
import { buildProgressionSnapshot } from './progress'

/**
 * Viewer-facing quest state: keeps the current objective, milestone
 * progression, death and day counters legible on stream. Progress becomes a
 * story the audience can follow even during slow mining segments.
 */

const MILESTONE_LABELS_JA: Record<ProgressMilestone, string> = {
  'wood': '木材集め',
  'crafting-table': '作業台',
  'stone-tools': '石ツール',
  'food-stable': '食料確保',
  'shelter': '拠点準備',
  'furnace': 'かまど',
  'light-source': '松明・光源',
  'iron-acquisition': '鉄の入手',
  'iron-smelting': '鉄の精錬',
  'iron-pickaxe': '鉄ピッケル',
  'diamond-acquisition': 'ダイヤ発見',
  'diamond-loadout': 'ダイヤ装備',
  'obsidian-collection': '黒曜石集め',
  'nether-access': 'ネザー突入',
  'blaze-rods': 'ブレイズ狩り',
  'ender-pearls': 'エンダーパール',
  'eyes-of-ender': 'エンダーアイ',
}

const MILESTONE_ORDER = Object.keys(MILESTONE_LABELS_JA) as ProgressMilestone[]

const DEFAULT_POLL_INTERVAL_MS = 5_000

export interface QuestState {
  currentMilestone: ProgressMilestone
  milestoneIndex: number
  milestoneCount: number
  nextGoal: string
  deathCount: number
  gameDay: number
  score: number
}

export class QuestTracker {
  private readonly logger = useLogger()
  private readonly overlayPath: string
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private deathHandler: (() => void) | null = null
  private started = false
  private deathCount = 0
  private lastMilestone: ProgressMilestone | null = null
  private lastOverlayText = ''

  constructor(
    private readonly mineflayer: Mineflayer,
    private readonly voiceBank?: VoiceBank | null,
    options: { overlayPath?: string, pollIntervalMs?: number } = {},
  ) {
    this.overlayPath = options.overlayPath ?? (process.env.QUEST_OVERLAY_FILE ?? '').trim()
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  private readonly pollIntervalMs: number

  public start(): void {
    if (this.started) {
      return
    }
    this.started = true
    this.deathHandler = () => {
      this.deathCount++
    }
    this.mineflayer.bot.on('death', this.deathHandler)
    this.pollTimer = setInterval(() => {
      void this.refresh()
    }, this.pollIntervalMs)
    this.pollTimer.unref?.()
    void this.refresh()
    this.logger.log('Quest tracker started')
  }

  public stop(): void {
    if (!this.started) {
      return
    }
    this.started = false
    if (this.deathHandler) {
      this.mineflayer.bot.off?.('death', this.deathHandler)
      this.deathHandler = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private refreshQueue: Promise<QuestState | null> = Promise.resolve(null)

  /** Serialized so overlapping timer/manual refreshes cannot write stale overlays. */
  public refresh(): Promise<QuestState | null> {
    this.refreshQueue = this.refreshQueue.then(
      () => this.refreshImpl(),
      () => this.refreshImpl(),
    )
    return this.refreshQueue
  }

  private async refreshImpl(): Promise<QuestState | null> {
    let snapshot: ProgressionSnapshot
    let gameDay = 0
    try {
      const facts = collectWorldFacts(this.mineflayer)
      snapshot = buildProgressionSnapshot(facts)
      gameDay = Math.floor(Number((this.mineflayer.bot as any)?.time?.age ?? 0) / 24_000)
    }
    catch {
      return null
    }

    const state: QuestState = {
      currentMilestone: snapshot.currentMilestone,
      milestoneIndex: Math.max(0, MILESTONE_ORDER.indexOf(snapshot.currentMilestone)),
      milestoneCount: MILESTONE_ORDER.length,
      nextGoal: snapshot.nextGoals[0] ?? '',
      deathCount: this.deathCount,
      gameDay,
      score: snapshot.score,
    }

    this.handleMilestoneTransition(snapshot.currentMilestone)
    await this.writeOverlay(state)
    return state
  }

  private handleMilestoneTransition(milestone: ProgressMilestone): void {
    if (this.lastMilestone === null) {
      this.lastMilestone = milestone
      return
    }
    if (milestone === this.lastMilestone) {
      return
    }

    const previousIndex = MILESTONE_ORDER.indexOf(this.lastMilestone)
    const currentIndex = MILESTONE_ORDER.indexOf(milestone)
    const advanced = currentIndex > previousIndex
    this.lastMilestone = milestone

    if (!advanced) {
      return
    }

    // Chapter break: celebrate on voice bank + emotion, and let the monitor
    // (and any recap commentary listeners) know.
    this.voiceBank?.play('milestone')
    getActiveEmotionEngine()?.impulse('milestone')
    monitorBus.emitMonitor('quest:state', {
      transition: true,
      milestone,
      label: MILESTONE_LABELS_JA[milestone],
    })
    this.logger.withFields({ milestone }).log('Quest milestone advanced')
  }

  private async writeOverlay(state: QuestState): Promise<void> {
    if (!this.overlayPath) {
      monitorBus.emitMonitor('quest:state', { ...state })
      return
    }

    const label = MILESTONE_LABELS_JA[state.currentMilestone]
    const checklist = `${state.milestoneIndex + 1}/${state.milestoneCount}`
    const lines = [
      `🎯 いまの目標: ${state.nextGoal || label}`,
      `📊 エンドラへの道: ${label} (${checklist})`,
      `💀 死亡 ${state.deathCount}回　☀️ ${state.gameDay}日目`,
    ]
    const text = lines.join('\n')
    if (text === this.lastOverlayText) {
      return
    }
    this.lastOverlayText = text

    try {
      await mkdir(dirname(this.overlayPath), { recursive: true })
      await writeFile(this.overlayPath, `${text}\n`, 'utf8')
    }
    catch (error) {
      this.logger.withError(error).warn('Failed to write quest overlay file')
    }
    monitorBus.emitMonitor('quest:state', { ...state })
  }
}
