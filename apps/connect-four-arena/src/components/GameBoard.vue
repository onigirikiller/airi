<script setup lang="ts">
import type { Board, BoardPosition, PlayerId } from '../domain/connect-four'

const props = defineProps<{
  board: Board
  currentPlayer: PlayerId
  lastMove: BoardPosition | null
  thinking: boolean
  winningLine: BoardPosition[]
}>()

function isWinningCell(row: number, column: number) {
  return props.winningLine.some(position => position.row === row && position.column === column)
}

function isLastMove(row: number, column: number) {
  return props.lastMove?.row === row && props.lastMove.column === column
}
</script>

<template>
  <section
    :class="[
      'relative w-full max-w-2xl',
      'rounded-[2rem] border border-white/10 bg-slate-950/80 p-3 shadow-2xl sm:p-5',
    ]"
    aria-label="コネクトフォー盤面"
  >
    <div :class="['mb-3 grid grid-cols-7 gap-1.5 px-1 text-center text-xs text-slate-500 sm:gap-2.5']">
      <span v-for="column in 7" :key="column">{{ column }}</span>
    </div>

    <div
      :class="[
        'board-shell grid grid-cols-7 gap-1.5 rounded-[1.4rem] p-2 sm:gap-2.5 sm:p-3',
        thinking ? `is-thinking-${currentPlayer}` : '',
      ]"
    >
      <template v-for="(row, rowIndex) in board" :key="rowIndex">
        <div
          v-for="(cell, columnIndex) in row"
          :key="`${rowIndex}-${columnIndex}`"
          :class="[
            'board-cell relative aspect-square rounded-full',
            isWinningCell(rowIndex, columnIndex) ? 'is-winning' : '',
          ]"
        >
          <div
            v-if="cell"
            :class="[
              'disc absolute inset-[9%] rounded-full',
              `disc-${cell}`,
              isLastMove(rowIndex, columnIndex) ? 'is-last-move' : '',
            ]"
          />
        </div>
      </template>
    </div>

    <div class="mt-3 flex items-center justify-center gap-2 text-xs text-slate-500">
      <span :class="['size-2 rounded-full', currentPlayer === 'red' ? 'bg-rose-400' : 'bg-amber-300']" />
      <span>{{ thinking ? 'LLMが着手を生成中' : '盤面は上から下の順でLLMへ共有されます' }}</span>
    </div>
  </section>
</template>

<style scoped>
.board-shell {
  background:
    linear-gradient(145deg, rgb(44 66 181 / 94%), rgb(20 39 125 / 98%)),
    radial-gradient(circle at 20% 10%, rgb(129 140 248 / 40%), transparent 45%);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 18%),
    inset 0 -14px 28px rgb(3 7 18 / 28%),
    0 20px 60px rgb(15 23 42 / 45%);
}

.board-cell {
  background: rgb(3 7 18 / 82%);
  box-shadow:
    inset 0 5px 10px rgb(0 0 0 / 70%),
    0 1px 0 rgb(255 255 255 / 13%);
}

.disc {
  box-shadow:
    inset 0 4px 9px rgb(255 255 255 / 38%),
    inset 0 -8px 12px rgb(0 0 0 / 24%),
    0 5px 14px rgb(0 0 0 / 36%);
}

.disc-red {
  background: radial-gradient(circle at 36% 30%, #fff1f2 0 4%, #fb7185 25%, #e11d48 74%);
}

.disc-yellow {
  background: radial-gradient(circle at 36% 30%, #fffbeb 0 4%, #fde047 25%, #f59e0b 74%);
}

.is-last-move {
  animation: drop-disc 480ms cubic-bezier(0.22, 0.85, 0.32, 1.18);
}

.is-winning {
  animation: winning-cell 900ms ease-in-out infinite alternate;
}

.is-thinking-red {
  box-shadow: 0 0 42px rgb(244 63 94 / 20%);
}

.is-thinking-yellow {
  box-shadow: 0 0 42px rgb(250 204 21 / 20%);
}

@keyframes drop-disc {
  from { transform: translateY(-620%) scale(0.92); }
  72% { transform: translateY(8%) scale(1.03); }
  to { transform: translateY(0) scale(1); }
}

@keyframes winning-cell {
  from { box-shadow: inset 0 5px 10px rgb(0 0 0 / 70%), 0 0 0 2px rgb(255 255 255 / 25%); }
  to { box-shadow: inset 0 5px 10px rgb(0 0 0 / 70%), 0 0 24px 5px rgb(255 255 255 / 55%); }
}

@media (prefers-reduced-motion: reduce) {
  .is-last-move,
  .is-winning {
    animation: none;
  }
}
</style>
