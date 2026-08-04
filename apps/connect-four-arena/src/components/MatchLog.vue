<script setup lang="ts">
import type { MatchEvent } from '../types'

defineProps<{
  events: MatchEvent[]
}>()
</script>

<template>
  <section :class="['rounded-3xl border border-white/8 bg-slate-950/55 p-5 backdrop-blur-lg']">
    <div class="mb-4 flex items-center justify-between">
      <div>
        <div class="text-[0.65rem] text-slate-500 font-bold tracking-[0.18em] uppercase">
          match feed
        </div>
        <h2 class="mt-1 text-base text-white font-semibold">
          着手ログ
        </h2>
      </div>
      <span class="rounded-full bg-white/5 px-3 py-1 text-xs text-slate-400">{{ events.length }} / 42</span>
    </div>

    <div v-if="events.length" class="log-list max-h-72 overflow-y-auto pr-1 space-y-2">
      <div
        v-for="event in [...events].reverse()"
        :key="event.move"
        :class="['flex items-start gap-3 rounded-xl bg-white/[0.025] p-3']"
      >
        <span
          :class="[
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-slate-950',
            event.player === 'red' ? 'bg-rose-400' : 'bg-amber-300',
          ]"
        >
          {{ event.move }}
        </span>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-x-2 text-sm">
            <strong class="text-slate-200">{{ event.playerName }}</strong>
            <span class="text-slate-500">列 {{ event.column + 1 }}</span>
          </div>
          <p class="mt-1 truncate text-xs text-slate-500">
            {{ event.line }}
          </p>
        </div>
      </div>
    </div>
    <div v-else class="h-28 flex items-center justify-center border border-white/8 rounded-2xl border-dashed text-sm text-slate-600">
      まだ着手はありません
    </div>
  </section>
</template>

<style scoped>
.log-list {
  scrollbar-color: rgb(100 116 139 / 55%) transparent;
  scrollbar-width: thin;
}
</style>
