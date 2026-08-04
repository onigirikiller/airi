import Vue from '@vitejs/plugin-vue'
import Unocss from 'unocss/vite'

import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    Vue(),
    Unocss({ configFile: '../../uno.config.ts' }),
  ],
})
