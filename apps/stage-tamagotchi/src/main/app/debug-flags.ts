import { env } from 'node:process'

import { is } from '@electron-toolkit/utils'

function isEnabled(value: string | undefined) {
  return /^true$/i.test(value || '')
}

export function shouldEnableAutoDebug() {
  return isEnabled(env.APP_AUTO_DEBUG)
}

export function shouldEnableRemoteDebugging() {
  return shouldEnableAutoDebug() && isEnabled(env.APP_REMOTE_DEBUG)
}

export function shouldAutoOpenDevTools() {
  return shouldEnableAutoDebug() && (is.dev || isEnabled(env.MAIN_APP_DEBUG) || isEnabled(env.APP_DEBUG))
}
