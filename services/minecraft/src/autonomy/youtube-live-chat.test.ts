import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { YouTubeLiveChatBridge } from './youtube-live-chat'

function createLoggerStub() {
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withError: vi.fn(),
    withFields: vi.fn(),
  }
  logger.withError.mockReturnValue(logger)
  logger.withFields.mockReturnValue(logger)
  return logger
}

function createBridge(options: Partial<ConstructorParameters<typeof YouTubeLiveChatBridge>[0]> = {}) {
  return new YouTubeLiveChatBridge({
    enabled: true,
    apiKey: 'youtube-api-key',
    liveChatId: 'live-chat-id',
    liveVideoId: '',
    liveUrl: '',
    oauthAccessToken: '',
    pollIntervalMs: 1000,
    quotaBackoffMs: 60_000,
    maxResults: 20,
    maxPendingMessages: 50,
    replyEnabled: false,
    maxDailyReplies: 20,
    logger: createLoggerStub() as any,
    ...options,
  })
}

describe('youtube live chat bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('primes first poll and queues new messages from later polls', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nextPageToken: 'p1',
        pollingIntervalMillis: 1200,
        items: [{
          id: 'm1',
          snippet: {
            type: 'textMessageEvent',
            displayMessage: 'hello',
            publishedAt: '2026-02-17T00:00:00.000Z',
          },
          authorDetails: {
            displayName: 'alice',
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nextPageToken: 'p2',
        items: [{
          id: 'm1',
          snippet: {
            type: 'textMessageEvent',
            displayMessage: 'hello again',
            publishedAt: '2026-02-17T00:01:00.000Z',
          },
          authorDetails: {
            displayName: 'alice',
          },
        }, {
          id: 'm2',
          snippet: {
            type: 'textMessageEvent',
            displayMessage: 'second message',
            publishedAt: '2026-02-17T00:02:00.000Z',
          },
          authorDetails: {
            displayName: 'bob',
          },
        }],
      }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    const bridge = createBridge()
    await (bridge as any).pollOnce()
    expect(bridge.drain(10)).toHaveLength(0)

    await (bridge as any).pollOnce()
    const messages = bridge.drain(10)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'm2',
      author: 'bob',
      text: 'second message',
    })
  })

  it('invokes queue callback when new messages are appended after priming', async () => {
    const onMessagesQueued = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nextPageToken: 'p1',
        items: [{
          id: 'm1',
          snippet: {
            type: 'textMessageEvent',
            displayMessage: 'first',
            publishedAt: '2026-02-17T00:00:00.000Z',
          },
          authorDetails: {
            displayName: 'alice',
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nextPageToken: 'p2',
        items: [{
          id: 'm2',
          snippet: {
            type: 'textMessageEvent',
            displayMessage: 'second',
            publishedAt: '2026-02-17T00:01:00.000Z',
          },
          authorDetails: {
            displayName: 'bob',
          },
        }],
      }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    const bridge = createBridge({ onMessagesQueued })
    await (bridge as any).pollOnce()
    await (bridge as any).pollOnce()

    expect(onMessagesQueued).toHaveBeenCalledTimes(1)
    expect(onMessagesQueued).toHaveBeenCalledWith(1)
  })

  it('returns false when reply posting is disabled', async () => {
    const bridge = createBridge({
      replyEnabled: false,
      oauthAccessToken: 'oauth-token',
    })

    await expect(bridge.sendMessage('hello')).resolves.toBe(false)
  })

  it('posts reply with OAuth token when enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const bridge = createBridge({
      replyEnabled: true,
      oauthAccessToken: 'oauth-token',
    })

    await expect(bridge.sendMessage('hello world')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.authorization).toContain('oauth-token')
  })

  it('resolves liveChatId once from live video id and reuses it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: 'video-1',
          liveStreamingDetails: {
            activeLiveChatId: 'resolved-chat-id',
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nextPageToken: 'p1',
        items: [],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nextPageToken: 'p2',
        items: [],
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const bridge = createBridge({
      liveChatId: '',
      liveVideoId: 'video-1',
    })

    await (bridge as any).pollOnce()
    await (bridge as any).pollOnce()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toContain('/youtube/v3/videos?')
    expect(fetchMock.mock.calls[1][0]).toContain('liveChatId=resolved-chat-id')
    expect(fetchMock.mock.calls[2][0]).toContain('liveChatId=resolved-chat-id')
  })

  it('applies quota backoff when API returns quotaExceeded', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response(JSON.stringify({
        error: {
          errors: [{ reason: 'quotaExceeded' }],
          message: 'quota exceeded',
        },
      }), { status: 403, statusText: 'Forbidden' }))
    vi.stubGlobal('fetch', fetchMock)

    const bridge = createBridge({
      quotaBackoffMs: 90_000,
    })

    // Keep the test deterministic: actual Pacific midnight depends on wall clock time.
    vi.spyOn(bridge as any, 'computeMsTilMidnightPacific').mockReturnValue(0)

    await expect((bridge as any).pollOnce()).rejects.toMatchObject({
      name: 'YouTubePollingError',
      retryAfterMs: 90_000,
    })
  })

  it('stops polling after repeated forbidden responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response(JSON.stringify({
        error: {
          errors: [{ reason: 'forbidden' }],
          message: 'forbidden',
        },
      }), { status: 403, statusText: 'Forbidden' }))
    vi.stubGlobal('fetch', fetchMock)

    const bridge = createBridge({
      quotaBackoffMs: 120_000,
    })

    await expect((bridge as any).pollOnce()).rejects.toMatchObject({ name: 'YouTubePollingError' })
    await expect((bridge as any).pollOnce()).rejects.toMatchObject({ name: 'YouTubePollingError' })
    await expect((bridge as any).pollOnce()).rejects.toMatchObject({
      name: 'YouTubePollingError',
      retryAfterMs: 30 * 60_000,
    })

    expect((bridge as any).running).toBe(false)
  })

  it('suppresses the duplicate retry warning when forbidden was already logged', async () => {
    vi.useFakeTimers()

    const logger = createLoggerStub()
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response(JSON.stringify({
        error: {
          errors: [{ reason: 'forbidden' }],
          message: 'forbidden',
        },
      }), { status: 403, statusText: 'Forbidden' }))
    vi.stubGlobal('fetch', fetchMock)

    const bridge = new YouTubeLiveChatBridge({
      enabled: true,
      apiKey: 'youtube-api-key',
      liveChatId: 'live-chat-id',
      liveVideoId: '',
      liveUrl: '',
      oauthAccessToken: '',
      pollIntervalMs: 1000,
      quotaBackoffMs: 60_000,
      maxResults: 20,
      maxPendingMessages: 50,
      replyEnabled: false,
      maxDailyReplies: 20,
      logger: logger as any,
    })

    bridge.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('YouTube API returned forbidden; retrying with backoff')
    bridge.stop()
  })
})
