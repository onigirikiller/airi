import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { AssistantMessage, CommonContentPart, UserMessage } from '@xsai/shared-chat'

import type { ChatStreamEvent, ContextMessage } from '../../../types/chat'

import { isStageTamagotchi, isStageWeb } from '@proj-airi/stage-shared'
import { useBroadcastChannel } from '@vueuse/core'
import { Mutex } from 'es-toolkit'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw, watch } from 'vue'

import { useCharacterStore } from '../../character'
import { useChatOrchestratorStore } from '../../chat'
import { CHAT_STREAM_CHANNEL_NAME, CONTEXT_CHANNEL_NAME } from '../../chat/constants'
import { useChatContextStore } from '../../chat/context-store'
import { useChatSessionStore } from '../../chat/session-store'
import { useChatStreamStore } from '../../chat/stream-store'
import { useConsciousnessStore } from '../../modules/consciousness'
import { useProvidersStore } from '../../providers'
import { useModsServerChannelStore } from './channel-server'

function extractAssistantMessageText(message: AssistantMessage): string {
  if (!message)
    return ''

  if (typeof message.content === 'string')
    return message.content.trim()

  if (!Array.isArray(message.content))
    return ''

  return message.content
    .map((part) => {
      const contentPart = part as CommonContentPart & { text?: string }
      return contentPart.type === 'text' && typeof contentPart.text === 'string'
        ? contentPart.text
        : ''
    })
    .join('')
    .trim()
}

interface RemoteVoicePayload {
  provider?: string
  model?: string
  mimeType?: string
  audio?: string
}

interface RemoteVoicePlaybackEvent {
  type: 'play-remote-voice'
  id: string
  text?: string
  voice: RemoteVoicePayload
}

const activeRemoteVoicePlayers = new Set<HTMLAudioElement>()

function extractRemoteVoicePayload(data: unknown): RemoteVoicePayload | null {
  if (!data || typeof data !== 'object')
    return null

  const voice = (data as { voice?: RemoteVoicePayload }).voice
  if (!voice || typeof voice !== 'object')
    return null

  if (typeof voice.audio !== 'string' || voice.audio.trim().length === 0)
    return null

  if (typeof voice.mimeType !== 'string' || voice.mimeType.trim().length === 0)
    return null

  return {
    provider: voice.provider,
    model: voice.model,
    mimeType: voice.mimeType.trim(),
    audio: voice.audio.trim(),
  }
}

async function tryPlayRemoteVoicePayload(voice: RemoteVoicePayload): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Audio === 'undefined')
    return false

  const mimeType = voice.mimeType
  const audioBase64 = voice.audio
  if (!mimeType || !audioBase64)
    return false

  const binary = window.atob(audioBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  const blob = new Blob([bytes], { type: mimeType })
  const objectUrl = URL.createObjectURL(blob)
  const audio = new Audio(objectUrl)
  audio.preload = 'auto'
  activeRemoteVoicePlayers.add(audio)

  const cleanup = () => {
    if (activeRemoteVoicePlayers.has(audio))
      activeRemoteVoicePlayers.delete(audio)
    URL.revokeObjectURL(objectUrl)
  }

  audio.addEventListener('ended', cleanup, { once: true })
  audio.addEventListener('error', cleanup, { once: true })

  try {
    await audio.play()
    return true
  }
  catch (error) {
    cleanup()
    throw error
  }
}

export const useContextBridgeStore = defineStore('mods:api:context-bridge', () => {
  const mutex = new Mutex()

  const chatOrchestrator = useChatOrchestratorStore()
  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const serverChannelStore = useModsServerChannelStore()
  const characterStore = useCharacterStore()
  const consciousnessStore = useConsciousnessStore()
  const providersStore = useProvidersStore()
  const { activeProvider, activeModel } = storeToRefs(consciousnessStore)

  const { post: broadcastContext, data: incomingContext } = useBroadcastChannel<ContextMessage, ContextMessage>({ name: CONTEXT_CHANNEL_NAME })
  const { post: broadcastStreamEvent, data: incomingStreamEvent } = useBroadcastChannel<ChatStreamEvent, ChatStreamEvent>({ name: CHAT_STREAM_CHANNEL_NAME })
  const { post: postRemoteVoicePlayback } = useBroadcastChannel<RemoteVoicePlaybackEvent, RemoteVoicePlaybackEvent>({ name: 'airi-remote-voice-playback' })

  const disposeHookFns = ref<Array<() => void>>([])
  let remoteStreamGuard: { sessionId: string, generation: number } | null = null

  function appendRemoteAssistantMessageToSession(text: string) {
    const messageText = text.trim()
    if (!messageText)
      return

    const targetSessionId = chatSession.activeSessionId
    if (!targetSessionId)
      return

    const sessionMessages = chatSession.getSessionMessages(targetSessionId)
    sessionMessages.push({
      role: 'assistant',
      content: messageText,
      slices: [],
      tool_results: [],
      id: nanoid(),
      createdAt: Date.now(),
    })
    chatSession.persistSessionMessages(targetSessionId)
  }

  async function initialize() {
    await mutex.acquire()

    try {
      let isProcessingRemoteStream = false

      const { stop } = watch(incomingContext, (event) => {
        if (event)
          chatContext.ingestContextMessage(event)
      })
      disposeHookFns.value.push(stop)

      disposeHookFns.value.push(serverChannelStore.onContextUpdate((event) => {
        const contextMessage: ContextMessage = {
          ...event.data,
          metadata: event.metadata,
          createdAt: Date.now(),
        }
        chatContext.ingestContextMessage(contextMessage)
        broadcastContext(toRaw(contextMessage))
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('input:text', async (event) => {
        const {
          text,
          textRaw,
          overrides,
          contextUpdates,
        } = event.data

        const normalizedContextUpdates = contextUpdates?.map((update) => {
          const id = update.id ?? nanoid()
          const contextId = update.contextId ?? id
          return {
            ...update,
            id,
            contextId,
          }
        })

        if (normalizedContextUpdates?.length) {
          const createdAt = Date.now()
          for (const update of normalizedContextUpdates) {
            chatContext.ingestContextMessage({
              ...update,
              metadata: event.metadata,
              createdAt,
            })
          }
        }

        if (activeProvider.value && activeModel.value) {
          const chatProvider = await providersStore.getProviderInstance<ChatProvider>(activeProvider.value)

          let messageText = text
          const targetSessionId = overrides?.sessionId

          if (overrides?.messagePrefix) {
            messageText = `${overrides.messagePrefix}${text}`
          }

          // TODO(@nekomeowww): This only guard for input:text events handling and doesn't cover the entire ingestion
          // process. Another critical path of spark:notify is affected too, I think for better future development
          // experience, we should discover and find either a leader election or distributed lock solution to
          // coordinate the modules that handles context bridge ingestion across multiple windows/tabs.
          //
          // Background behind this, as server-sdk is in fact integrated in every Stage Web window/tab, each
          // window/tab has its own connection & chat orchestrator instance, when multiple windows/tabs are open,
          // each of them will receive the same input:text event and process ingestion independently, causing
          // duplicated messages handling and output:* events emission.
          //
          // We don't have ability to control how many windows/tabs the user will open (sometimes) user will forget
          // to close the extra windows/tabs, so we need a way to coordinate the ingestion processing to
          // ensure only one window/tab is handling the ingestion at a time.
          //
          // SharedWorker solution was considered but it's completely disabled in Chromium based Android browsers
          // (which is a big portion of mobile Stage Web users as stage-ui serves as the unified / universal
          // api wrapper for most of the shared logic across Web, Pocket, and Tamagotchi).
          //
          // Read more here:
          // - https://chromestatus.com/feature/6265472244514816
          // - https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker
          // - https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
          navigator.locks.request('context-bridge:event:input:text', async () => {
            try {
              await chatOrchestrator.ingest(messageText, {
                model: activeModel.value,
                chatProvider,
                input: {
                  type: 'input:text',
                  data: {
                    ...event.data,
                    text,
                    textRaw,
                    overrides,
                    contextUpdates: normalizedContextUpdates,
                  },
                },
              }, targetSessionId)
            }
            catch (err) {
              console.error('Error ingesting text input via context bridge:', err)
            }
          })
        }
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('output:gen-ai:chat:message', async (event) => {
        const sourcePluginId = event.metadata?.source?.plugin?.id ?? ''
        const sourceIsStageClient = sourcePluginId.includes('stage-web')
          || sourcePluginId.includes('stage-tamagotchi')

        if (sourceIsStageClient || event.data['stage-web'] || event.data['stage-tamagotchi']) {
          return
        }

        const remoteVoice = extractRemoteVoicePayload(event.data)
        const text = extractAssistantMessageText(event.data.message)
        if (!remoteVoice && !text)
          return

        navigator.locks.request('context-bridge:event:output:gen-ai:chat:message', async () => {
          try {
            if (text) {
              appendRemoteAssistantMessageToSession(text)
            }

            if (remoteVoice) {
              let dispatchedToStage = false
              try {
                postRemoteVoicePlayback({
                  type: 'play-remote-voice',
                  id: nanoid(),
                  text,
                  voice: remoteVoice,
                })
                dispatchedToStage = true
              }
              catch (err) {
                console.error('Error dispatching remote voice payload to stage playback channel:', err)
              }

              if (dispatchedToStage) {
                return
              }

              try {
                const played = await tryPlayRemoteVoicePayload(remoteVoice)
                if (played) {
                  return
                }
              }
              catch (err) {
                console.error('Error playing remote voice payload:', err)
              }
            }

            if (text) {
              await characterStore.emitTextOutput(text)
            }
          }
          catch (err) {
            console.error('Error emitting assistant output as speech:', err)
          }
        })
      }))

      disposeHookFns.value.push(
        chatOrchestrator.onBeforeMessageComposed(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'before-compose', message, sessionId: chatSession.activeSessionId, context: structuredClone(toRaw(context)) })
        }),
        chatOrchestrator.onAfterMessageComposed(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'after-compose', message, sessionId: chatSession.activeSessionId, context: structuredClone(toRaw(context)) })
        }),
        chatOrchestrator.onBeforeSend(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'before-send', message, sessionId: chatSession.activeSessionId, context: structuredClone(toRaw(context)) })
        }),
        chatOrchestrator.onAfterSend(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'after-send', message, sessionId: chatSession.activeSessionId, context: structuredClone(toRaw(context)) })
        }),
        chatOrchestrator.onTokenLiteral(async (literal, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'token-literal', literal, sessionId: chatSession.activeSessionId, context: structuredClone(toRaw(context)) })
        }),
        chatOrchestrator.onTokenSpecial(async (special, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'token-special', special, sessionId: chatSession.activeSessionId, context: structuredClone(toRaw(context)) })
        }),
        chatOrchestrator.onStreamEnd(async (context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'stream-end', sessionId: chatSession.activeSessionId, context: structuredClone(toRaw(context)) })
        }),
        chatOrchestrator.onAssistantResponseEnd(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'assistant-end', message, sessionId: chatSession.activeSessionId, context: structuredClone(toRaw(context)) })
        }),

        chatOrchestrator.onAssistantMessage(async (message, _messageText, context) => {
          serverChannelStore.send({
            type: 'output:gen-ai:chat:message',
            data: {
              ...context.input?.data,
              message,
              'stage-web': isStageWeb(),
              'stage-tamagotchi': isStageTamagotchi(),
              'gen-ai:chat': {
                message: context.message as UserMessage,
                composedMessage: context.composedMessage,
                contexts: context.contexts,
                input: context.input,
              },
            },
          })
        }),

        chatOrchestrator.onChatTurnComplete(async (chat, context) => {
          serverChannelStore.send({
            type: 'output:gen-ai:chat:complete',
            data: {
              ...context.input?.data,
              'message': chat.output,
              // TODO: tool calls should be captured properly
              'toolCalls': [],
              'stage-web': isStageWeb(),
              'stage-tamagotchi': isStageTamagotchi(),
              // TODO: Properly calculate usage data
              'usage': {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                source: 'estimate-based',
              },
              'gen-ai:chat': {
                message: context.message as UserMessage,
                composedMessage: context.composedMessage,
                contexts: context.contexts,
                input: context.input,
              },
            },
          })
        }),
      )

      const { stop: stopIncomingStreamWatch } = watch(incomingStreamEvent, async (event) => {
        if (!event)
          return

        isProcessingRemoteStream = true

        try {
          // Use the receiver's active session to avoid clobbering chat state when events come from other windows/devtools.
          switch (event.type) {
            case 'before-compose':
              await chatOrchestrator.emitBeforeMessageComposedHooks(event.message, event.context)
              break
            case 'after-compose':
              await chatOrchestrator.emitAfterMessageComposedHooks(event.message, event.context)
              break
            case 'before-send':
              await chatOrchestrator.emitBeforeSendHooks(event.message, event.context)
              remoteStreamGuard = {
                sessionId: chatSession.activeSessionId,
                generation: chatSession.getSessionGenerationValue(),
              }
              chatOrchestrator.sending = true
              chatStream.beginStream()
              break
            case 'after-send':
              await chatOrchestrator.emitAfterSendHooks(event.message, event.context)
              break
            case 'token-literal':
              if (!remoteStreamGuard)
                return
              if (remoteStreamGuard.sessionId !== chatSession.activeSessionId)
                return
              if (chatSession.getSessionGenerationValue(remoteStreamGuard.sessionId) !== remoteStreamGuard.generation)
                return
              chatStream.appendStreamLiteral(event.literal)
              await chatOrchestrator.emitTokenLiteralHooks(event.literal, event.context)
              break
            case 'token-special':
              await chatOrchestrator.emitTokenSpecialHooks(event.special, event.context)
              break
            case 'stream-end':
              if (!remoteStreamGuard)
                break
              if (remoteStreamGuard.sessionId !== chatSession.activeSessionId)
                break
              if (chatSession.getSessionGenerationValue(remoteStreamGuard.sessionId) !== remoteStreamGuard.generation)
                break
              await chatOrchestrator.emitStreamEndHooks(event.context)
              chatStream.finalizeStream()
              chatOrchestrator.sending = false
              remoteStreamGuard = null
              break
            case 'assistant-end':
              if (!remoteStreamGuard)
                break
              if (remoteStreamGuard.sessionId !== chatSession.activeSessionId)
                break
              if (chatSession.getSessionGenerationValue(remoteStreamGuard.sessionId) !== remoteStreamGuard.generation)
                break
              await chatOrchestrator.emitAssistantResponseEndHooks(event.message, event.context)
              chatStream.finalizeStream(event.message)
              chatOrchestrator.sending = false
              remoteStreamGuard = null
              break
          }
        }
        finally {
          isProcessingRemoteStream = false
        }
      })
      disposeHookFns.value.push(stopIncomingStreamWatch)
    }
    finally {
      mutex.release()
    }
  }

  async function dispose() {
    await mutex.acquire()

    try {
      for (const fn of disposeHookFns.value) {
        fn()
      }
    }
    finally {
      mutex.release()
    }

    disposeHookFns.value = []
  }

  return {
    initialize,
    dispose,
  }
})
