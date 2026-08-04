<script setup lang="ts">
import type { AgentDecision, PersonaConfig } from '../types'

defineProps<{
  active: boolean
  decision?: AgentDecision
  persona: PersonaConfig
  score: number
  thinking: boolean
}>()
</script>

<template>
  <article
    :class="[
      'player-card relative overflow-hidden rounded-3xl border p-5 transition-all duration-300',
      'bg-slate-950/70 backdrop-blur-xl',
      persona.id === 'red' ? 'player-red' : 'player-yellow',
      active ? 'is-active translate-y-[-2px]' : 'border-white/8 opacity-75',
    ]"
  >
    <div :class="['relative z-1 flex items-start justify-between gap-4']">
      <div class="min-w-0">
        <div class="mb-2 flex items-center gap-2">
          <span :class="['size-3 rounded-full', persona.id === 'red' ? 'bg-rose-400' : 'bg-amber-300']" />
          <span class="text-[0.65rem] text-slate-500 font-bold tracking-[0.22em] uppercase">
            {{ persona.id === 'red' ? 'PLAYER R' : 'PLAYER Y' }}
          </span>
        </div>
        <h2 class="truncate text-2xl text-white font-semibold">
          {{ persona.name }}
        </h2>
      </div>

      <div class="text-right">
        <div class="text-3xl text-white font-semibold tabular-nums">
          {{ score }}
        </div>
        <div class="text-[0.65rem] text-slate-500 tracking-[0.18em] uppercase">
          wins
        </div>
      </div>
    </div>

    <div :class="['relative z-1 mt-6 min-h-36 rounded-2xl bg-black/20 p-4']">
      <div v-if="thinking" class="h-full min-h-28 flex flex-col items-center justify-center gap-3 text-sm text-slate-300">
        <div class="thinking-orbit" />
        <span>盤面を読んでいます…</span>
      </div>
      <template v-else-if="decision">
        <p class="text-base text-slate-100 leading-relaxed">
          “{{ decision.line }}”
        </p>
        <div class="mt-4 border-t border-white/8 pt-3">
          <div class="mb-1 text-[0.65rem] text-slate-500 font-bold tracking-[0.16em] uppercase">
            strategy note
          </div>
          <p class="text-xs text-slate-400 leading-relaxed">
            {{ decision.strategy }}
          </p>
        </div>
      </template>
      <p v-else class="min-h-28 flex items-center text-sm text-slate-500 leading-relaxed">
        対局が始まると、ここに人格を保った発言と公開用の作戦メモが表示されます。
      </p>
    </div>
  </article>
</template>

<style scoped>
.player-card::before {
  position: absolute;
  inset: 0;
  pointer-events: none;
  content: '';
  opacity: 0;
  transition: opacity 300ms ease;
}

.player-red::before {
  background: radial-gradient(circle at 0 0, rgb(244 63 94 / 18%), transparent 52%);
}

.player-yellow::before {
  background: radial-gradient(circle at 100% 0, rgb(250 204 21 / 16%), transparent 52%);
}

.player-card.is-active::before {
  opacity: 1;
}

.player-red.is-active {
  border-color: rgb(251 113 133 / 38%);
  box-shadow: 0 18px 50px rgb(136 19 55 / 18%);
}

.player-yellow.is-active {
  border-color: rgb(253 224 71 / 32%);
  box-shadow: 0 18px 50px rgb(113 63 18 / 16%);
}

.thinking-orbit {
  width: 2.25rem;
  height: 2.25rem;
  border: 2px solid rgb(148 163 184 / 16%);
  border-top-color: currentColor;
  border-radius: 9999px;
  animation: orbit 800ms linear infinite;
}

@keyframes orbit {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .thinking-orbit { animation-duration: 1800ms; }
}
</style>
