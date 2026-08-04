<script setup lang="ts">
import type { ConnectionSettings, PersonaConfig } from '../types'

import { Button, Checkbox, FieldInput, FieldTextArea } from '@proj-airi/ui'

defineEmits<{
  close: []
  importAiri: []
}>()

const settings = defineModel<ConnectionSettings>('settings', { required: true })
const personas = defineModel<PersonaConfig[]>('personas', { required: true })
</script>

<template>
  <section :class="['rounded-3xl border border-white/10 bg-slate-950/90 p-5 shadow-2xl backdrop-blur-xl sm:p-7']">
    <div class="mb-6 flex items-start justify-between gap-4">
      <div>
        <div class="mb-1 text-[0.65rem] text-indigo-300 font-bold tracking-[0.2em] uppercase">
          arena setup
        </div>
        <h2 class="text-xl text-white font-semibold">
          LLMと人格を設定
        </h2>
        <p class="mt-1 text-sm text-slate-400">
          2人格は同じモデルを使い、履歴だけを分離します。
        </p>
      </div>
      <Button variant="ghost" size="sm" @click="$emit('close')">
        閉じる
      </Button>
    </div>

    <div class="grid gap-5 lg:grid-cols-3">
      <div :class="['space-y-5 rounded-2xl border border-white/8 bg-white/[0.025] p-4']">
        <div class="flex items-center gap-2 text-sm text-white font-semibold">
          <span class="size-2 rounded-full bg-indigo-400" />
          OpenAI互換接続
        </div>
        <FieldInput
          v-model="settings.baseUrl"
          label="Base URL"
          description="末尾の / は自動補完されます"
          placeholder="http://localhost:1234/v1/"
          required
        />
        <FieldInput
          v-model="settings.model"
          label="モデル"
          placeholder="agents-a1-4b"
          required
        />
        <FieldInput
          v-model="settings.apiKey"
          label="APIキー"
          description="ローカルLLMでは空欄でも構いません"
          placeholder="sk-..."
          type="password"
        />
        <div class="grid grid-cols-2 gap-3">
          <FieldInput
            v-model="settings.temperature"
            label="温度"
            type="number"
          />
          <FieldInput
            v-model="settings.moveDelayMs"
            label="手の間隔 (ms)"
            type="number"
          />
        </div>
        <label class="flex items-center justify-between gap-4 border border-white/8 rounded-xl p-3">
          <span>
            <span class="block text-sm text-white font-medium">自動で最後まで</span>
            <span class="block text-xs text-slate-500">OFFなら一手ずつ実行</span>
          </span>
          <Checkbox v-model="settings.autoPlay" />
        </label>
        <Button block variant="secondary-muted" size="sm" @click="$emit('importAiri')">
          AIRIの現在設定を読み込む
        </Button>
      </div>

      <div
        v-for="(persona, index) in personas"
        :key="persona.id"
        :class="[
          'space-y-5 rounded-2xl border p-4',
          persona.id === 'red' ? 'border-rose-400/20 bg-rose-400/[0.035]' : 'border-amber-300/20 bg-amber-300/[0.035]',
        ]"
      >
        <div class="flex items-center gap-2 text-sm text-white font-semibold">
          <span :class="['size-2 rounded-full', persona.id === 'red' ? 'bg-rose-400' : 'bg-amber-300']" />
          {{ persona.id === 'red' ? '先手人格' : '後手人格' }}
        </div>
        <FieldInput
          v-model="personas[index]!.name"
          label="表示名"
          placeholder="キャラクター名"
          required
        />
        <FieldTextArea
          v-model="personas[index]!.personality"
          label="人格プロンプト"
          description="口調・価値観・勝負スタイルを記述します"
          :rows="9"
          required
        />
      </div>
    </div>

    <p class="mt-5 text-xs text-slate-500 leading-relaxed">
      設定はこのブラウザ内に保存されます。公開環境ではAPIキーをクライアントへ置かず、サーバープロキシを使用してください。
    </p>
  </section>
</template>
