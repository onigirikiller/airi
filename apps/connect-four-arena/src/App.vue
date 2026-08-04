<script setup lang="ts">
import type { BoardPosition, PlayerId } from './domain/connect-four'
import type { AgentDecision, MatchEvent } from './types'

import { Button } from '@proj-airi/ui'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import GameBoard from './components/GameBoard.vue'
import MatchLog from './components/MatchLog.vue'
import PlayerCard from './components/PlayerCard.vue'
import SettingsPanel from './components/SettingsPanel.vue'

import {
  createBoard,
  dropDisc,
  getWinner,
  getWinningLine,
  isBoardFull,
  otherPlayer,
} from './domain/connect-four'
import { createConnectFourAgentSession, formatAgentError } from './llm/connect-four-agent'
import { loadSetup, migrateLegacyDefaults, readAiriConnection, saveSetup } from './persistence/settings'

type MatchPhase = 'error' | 'finished' | 'idle' | 'paused' | 'ready' | 'thinking'

const initialSetup = loadSetup(window.localStorage)
const settings = reactive(initialSetup.settings)
const personas = reactive(initialSetup.personas)
const board = ref(createBoard())
const currentPlayer = ref<PlayerId>('red')
const phase = ref<MatchPhase>('idle')
const events = ref<MatchEvent[]>([])
const lastMove = ref<BoardPosition | null>(null)
const decisions = reactive<Partial<Record<PlayerId, AgentDecision>>>({})
const scores = reactive<Record<PlayerId | 'draw', number>>({ draw: 0, red: 0, yellow: 0 })
const errorMessage = ref('')
const notice = ref(initialSetup.source === 'airi' ? 'AIRIの接続設定を読み込みました。' : '')
const showSettings = ref(initialSetup.source === 'default')

let abortController: AbortController | null = null
let runId = 0
let session = createConnectFourAgentSession()

const winner = computed(() => getWinner(board.value))
const winningLine = computed(() => getWinningLine(board.value))
const activePersona = computed(() => personas.find(persona => persona.id === currentPlayer.value)!)
const isThinking = computed(() => phase.value === 'thinking')
const hasStarted = computed(() => events.value.length > 0 || phase.value !== 'idle')

const statusLabel = computed(() => {
  if (phase.value === 'thinking')
    return `${activePersona.value.name} が次の一手を生成中`
  if (phase.value === 'paused')
    return '対局を一時停止しました'
  if (phase.value === 'error')
    return 'LLMの応答を確認できませんでした'
  if (winner.value)
    return `${personas.find(persona => persona.id === winner.value)?.name ?? '勝者'} の勝利`
  if (phase.value === 'finished')
    return '引き分けです'
  if (phase.value === 'ready')
    return `${activePersona.value.name} の手番`
  return '2つの人格を盤上へ'
})

const primaryActionLabel = computed(() => {
  if (!hasStarted.value || phase.value === 'finished' || phase.value === 'error')
    return settings.autoPlay ? '新しい対局を開始' : '新しい対局を一手進める'
  if (phase.value === 'paused')
    return settings.autoPlay ? '対局を再開' : '次の一手'
  if (phase.value === 'ready')
    return settings.autoPlay ? '自動対局を続ける' : '次の一手'
  return '対局中'
})

watch([settings, personas], () => {
  saveSetup(window.localStorage, settings, personas)
}, { deep: true })

function validateSetup(): string | null {
  // NOTICE: Persist one-time migrations here because Vite HMR may preserve stale reactive state.
  Object.assign(settings, migrateLegacyDefaults({ ...settings }))

  if (!settings.baseUrl.trim())
    return 'Base URLを入力してください。'
  try {
    const url = new URL(settings.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol))
      return 'Base URLはhttpまたはhttpsで指定してください。'
  }
  catch {
    return 'Base URLの形式が正しくありません。'
  }

  if (!settings.model.trim())
    return 'モデル名を入力してください。'
  if (personas.some(persona => !persona.name.trim() || !persona.personality.trim()))
    return '両方の人格名と人格プロンプトを入力してください。'

  settings.temperature = Math.min(2, Math.max(0, Number(settings.temperature) || 0))
  settings.moveDelayMs = Math.min(10_000, Math.max(0, Number(settings.moveDelayMs) || 0))
  return null
}

function cancelCurrentRun() {
  runId += 1
  abortController?.abort()
  abortController = null
}

function resetMatch() {
  board.value = createBoard()
  currentPlayer.value = 'red'
  events.value = []
  lastMove.value = null
  delete decisions.red
  delete decisions.yellow
  errorMessage.value = ''
  session = createConnectFourAgentSession()
  phase.value = 'ready'
}

function delay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, duration)
    signal.addEventListener('abort', () => {
      window.clearTimeout(timeout)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

async function playTurn(expectedRunId: number): Promise<boolean> {
  if (expectedRunId !== runId || winner.value || isBoardFull(board.value))
    return false

  const player = currentPlayer.value
  const persona = personas.find(candidate => candidate.id === player)!
  abortController = new AbortController()
  phase.value = 'thinking'
  errorMessage.value = ''

  try {
    const decision = await session.chooseMove({
      board: board.value,
      events: events.value,
      persona,
      player,
      settings,
      signal: abortController.signal,
    })

    if (expectedRunId !== runId)
      return false

    const result = dropDisc(board.value, decision.column, player)
    board.value = result.board
    lastMove.value = result.position
    decisions[player] = decision
    events.value.push({
      ...decision,
      move: events.value.length + 1,
      player,
      playerName: persona.name,
    })

    const resolvedWinner = getWinner(board.value)
    if (resolvedWinner) {
      scores[resolvedWinner] += 1
      phase.value = 'finished'
      return false
    }
    if (isBoardFull(board.value)) {
      scores.draw += 1
      phase.value = 'finished'
      return false
    }

    currentPlayer.value = otherPlayer(player)
    phase.value = 'ready'
    return true
  }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      return false

    errorMessage.value = formatAgentError(error)
    phase.value = 'error'
    showSettings.value = true
    return false
  }
  finally {
    abortController = null
  }
}

async function runTurns(expectedRunId: number) {
  do {
    const canContinue = await playTurn(expectedRunId)
    if (!canContinue || !settings.autoPlay || expectedRunId !== runId)
      return

    const pauseController = new AbortController()
    abortController = pauseController
    try {
      await delay(settings.moveDelayMs, pauseController.signal)
    }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'AbortError')
        throw error
      return
    }
    finally {
      if (abortController === pauseController)
        abortController = null
    }
    if (expectedRunId !== runId)
      return
  } while (true)
}

async function startNewMatch() {
  const validationError = validateSetup()
  if (validationError) {
    errorMessage.value = validationError
    phase.value = 'error'
    showSettings.value = true
    return
  }

  cancelCurrentRun()
  resetMatch()
  showSettings.value = false
  notice.value = ''
  await runTurns(runId)
}

async function continueMatch() {
  const validationError = validateSetup()
  if (validationError) {
    errorMessage.value = validationError
    phase.value = 'error'
    showSettings.value = true
    return
  }

  if (!hasStarted.value || phase.value === 'finished' || phase.value === 'error') {
    await startNewMatch()
    return
  }

  cancelCurrentRun()
  phase.value = 'ready'
  await runTurns(runId)
}

function pauseMatch() {
  cancelCurrentRun()
  phase.value = 'paused'
}

function importAiriSettings() {
  const airiSettings = readAiriConnection(window.localStorage)
  if (!airiSettings) {
    notice.value = '同じブラウザ領域にAIRIの有効なLLM設定が見つかりませんでした。'
    return
  }

  Object.assign(settings, migrateLegacyDefaults({ ...settings, ...airiSettings }))
  notice.value = 'AIRIの接続設定を読み込みました。'
}

onBeforeUnmount(cancelCurrentRun)
</script>

<template>
  <main :class="['app-shell min-h-full overflow-x-hidden bg-[#080b16] text-slate-200']">
    <div class="ambient ambient-red" />
    <div class="ambient ambient-blue" />

    <div :class="['relative z-1 mx-auto max-w-[1540px] px-4 py-5 sm:px-6 lg:px-8']">
      <header :class="['mb-6 flex flex-wrap items-center justify-between gap-4']">
        <div class="flex items-center gap-3">
          <div :class="['brand-mark flex size-11 items-center justify-center rounded-2xl text-sm font-black text-white']">
            C4
          </div>
          <div>
            <div class="flex items-baseline gap-2">
              <h1 class="text-lg text-white font-semibold tracking-tight sm:text-xl">
                PERSONA FOUR
              </h1>
              <span class="text-[0.6rem] text-indigo-300 font-bold tracking-[0.2em] uppercase hidden sm:inline">AIRI LLM ARENA</span>
            </div>
            <p class="text-xs text-slate-500">
              isolated minds, shared board
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <div :class="['hidden max-w-72 truncate rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-slate-400 md:block']">
            {{ settings.model || 'モデル未設定' }}
          </div>
          <Button variant="secondary-muted" size="sm" @click="showSettings = !showSettings">
            {{ showSettings ? '設定を閉じる' : 'LLM・人格設定' }}
          </Button>
        </div>
      </header>

      <Transition name="settings">
        <SettingsPanel
          v-if="showSettings"
          v-model:personas="personas"
          v-model:settings="settings"
          class="mb-6"
          @close="showSettings = false"
          @import-airi="importAiriSettings"
        />
      </Transition>

      <div v-if="notice" :class="['mb-5 rounded-2xl border border-indigo-400/20 bg-indigo-400/8 px-4 py-3 text-sm text-indigo-100']">
        {{ notice }}
      </div>

      <div v-if="errorMessage" :class="['mb-5 rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-100']">
        {{ errorMessage }}
      </div>

      <section :class="['arena-grid grid items-start gap-5 xl:grid-cols-[minmax(220px,0.72fr)_minmax(500px,1.6fr)_minmax(220px,0.72fr)]']">
        <PlayerCard
          :active="currentPlayer === 'red' && phase !== 'finished'"
          :decision="decisions.red"
          :persona="personas[0]!"
          :score="scores.red"
          :thinking="isThinking && currentPlayer === 'red'"
        />

        <div class="board-area min-w-0 flex flex-col items-center">
          <div :class="['mb-4 flex min-h-14 w-full flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/8 bg-slate-950/50 px-4 py-3 backdrop-blur-lg']">
            <div>
              <div class="text-[0.62rem] text-slate-500 font-bold tracking-[0.18em] uppercase">
                match status
              </div>
              <div class="mt-0.5 text-white font-medium">
                {{ statusLabel }}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <Button
                v-if="phase === 'thinking'"
                variant="secondary"
                size="sm"
                @click="pauseMatch"
              >
                停止
              </Button>
              <Button
                v-else
                size="sm"
                @click="continueMatch"
              >
                {{ primaryActionLabel }}
              </Button>
              <Button
                v-if="hasStarted && phase !== 'thinking'"
                variant="ghost"
                size="sm"
                @click="startNewMatch"
              >
                盤面リセット
              </Button>
            </div>
          </div>

          <GameBoard
            :board="board"
            :current-player="currentPlayer"
            :last-move="lastMove"
            :thinking="isThinking"
            :winning-line="winningLine"
          />
        </div>

        <PlayerCard
          :active="currentPlayer === 'yellow' && phase !== 'finished'"
          :decision="decisions.yellow"
          :persona="personas[1]!"
          :score="scores.yellow"
          :thinking="isThinking && currentPlayer === 'yellow'"
        />
      </section>

      <div class="grid mt-5 gap-5 xl:grid-cols-[1fr_2fr_1fr]">
        <div :class="['rounded-3xl border border-white/8 bg-slate-950/45 p-5 text-sm text-slate-400']">
          <div class="text-[0.65rem] text-slate-500 font-bold tracking-[0.18em] uppercase">
            context isolation
          </div>
          <p class="mt-3 leading-relaxed">
            各人格は自分の過去応答だけを保持します。相手とは盤面と公開着手ログだけを共有します。
          </p>
        </div>
        <MatchLog :events="events" />
        <div :class="['rounded-3xl border border-white/8 bg-slate-950/45 p-5']">
          <div class="text-[0.65rem] text-slate-500 font-bold tracking-[0.18em] uppercase">
            scoreboard
          </div>
          <div class="grid grid-cols-3 mt-4 gap-2 text-center">
            <div class="rounded-2xl bg-rose-400/8 p-3">
              <div class="text-2xl text-rose-300 font-semibold">
                {{ scores.red }}
              </div>
              <div class="mt-1 truncate text-xs text-slate-500">
                {{ personas[0]!.name }}
              </div>
            </div>
            <div class="rounded-2xl bg-white/[0.035] p-3">
              <div class="text-2xl text-slate-300 font-semibold">
                {{ scores.draw }}
              </div>
              <div class="mt-1 text-xs text-slate-500">
                DRAW
              </div>
            </div>
            <div class="rounded-2xl bg-amber-300/8 p-3">
              <div class="text-2xl text-amber-200 font-semibold">
                {{ scores.yellow }}
              </div>
              <div class="mt-1 truncate text-xs text-slate-500">
                {{ personas[1]!.name }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.app-shell {
  position: relative;
  isolation: isolate;
  background-image:
    linear-gradient(rgb(255 255 255 / 1.8%) 1px, transparent 1px),
    linear-gradient(90deg, rgb(255 255 255 / 1.8%) 1px, transparent 1px);
  background-size: 42px 42px;
}

.brand-mark {
  background: linear-gradient(145deg, #6366f1, #a855f7 62%, #ec4899);
  box-shadow: 0 10px 28px rgb(99 102 241 / 30%);
}

.ambient {
  position: fixed;
  z-index: -1;
  width: 42rem;
  height: 42rem;
  pointer-events: none;
  filter: blur(120px);
  border-radius: 9999px;
  opacity: 0.13;
}

.ambient-red {
  top: -18rem;
  left: -16rem;
  background: #e11d48;
}

.ambient-blue {
  right: -18rem;
  bottom: -20rem;
  background: #4f46e5;
}

.settings-enter-active,
.settings-leave-active {
  overflow: hidden;
  transition: opacity 220ms ease, transform 220ms ease;
}

.settings-enter-from,
.settings-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

@media (max-width: 1279px) {
  .arena-grid {
    grid-template-areas:
      'board board'
      'red yellow';
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .arena-grid > :nth-child(1) { grid-area: red; }
  .arena-grid > :nth-child(2) { grid-area: board; }
  .arena-grid > :nth-child(3) { grid-area: yellow; }
}

@media (max-width: 720px) {
  .arena-grid {
    grid-template-areas:
      'board'
      'red'
      'yellow';
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
