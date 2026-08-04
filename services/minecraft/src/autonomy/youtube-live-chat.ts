import type { Logger } from '../utils/logger'
import type { YouTubeChatMessage } from './types'

interface YouTubeLiveChatBridgeOptions {
  enabled: boolean
  apiKey: string
  liveChatId: string
  liveVideoId: string
  liveUrl: string
  oauthAccessToken: string
  pollIntervalMs: number
  quotaBackoffMs: number
  maxResults: number
  maxPendingMessages: number
  replyEnabled: boolean
  maxDailyReplies: number
  onMessagesQueued?: (count: number) => void
  logger: Logger
}

interface YouTubeListResponse {
  nextPageToken?: string
  pollingIntervalMillis?: number
  items?: Array<{
    id?: string
    snippet?: {
      type?: string
      displayMessage?: string
      publishedAt?: string
    }
    authorDetails?: {
      displayName?: string
    }
  }>
}

interface YouTubeVideoDetailsResponse {
  items?: Array<{
    id?: string
    liveStreamingDetails?: {
      activeLiveChatId?: string
    }
  }>
}

interface YouTubeErrorResponse {
  error?: {
    message?: string
    errors?: Array<{
      reason?: string
      message?: string
    }>
  }
}

const LIVE_CHAT_RESOLVE_RETRY_MS = 5 * 60_000
const MAX_TRANSIENT_BACKOFF_MS = 15 * 60_000
const MAX_ADAPTIVE_INTERVAL_MS = 120_000
const FORBIDDEN_BACKOFF_MS = 30 * 60_000
const MAX_CONSECUTIVE_FORBIDDEN_FAILURES = 3
const QUOTA_UNITS_PER_POLL = 5
const QUOTA_DAILY_HIGH_WATERMARK = 8_000
const QUOTA_DAILY_LOW_WATERMARK = 5_000

class YouTubePollingError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
    public readonly suppressRetryWarning: boolean = false,
  ) {
    super(message)
    this.name = 'YouTubePollingError'
  }
}

export class YouTubeLiveChatBridge {
  private queue: YouTubeChatMessage[] = []
  private seen = new Set<string>()
  private pageToken: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private primed = false
  private activeLiveChatId: string
  private quotaBackoffUntil = 0
  private transientBackoffMs = 0
  private lastResolveAttemptAt = 0
  private pollCount = 0
  private pollCountStartedAt = 0
  private adaptiveIntervalMs = 0
  private repliesSentToday = 0
  private replyCountResetDate = ''
  private consecutiveForbiddenFailures = 0

  constructor(
    private readonly options: YouTubeLiveChatBridgeOptions,
  ) {
    this.activeLiveChatId = options.liveChatId.trim()
    this.adaptiveIntervalMs = options.pollIntervalMs
  }

  public get enabled(): boolean {
    const canResolveLiveChatId = this.activeLiveChatId.length > 0
      || this.options.liveVideoId.trim().length > 0
      || this.options.liveUrl.trim().length > 0
    return this.options.enabled
      && this.options.apiKey.length > 0
      && canResolveLiveChatId
  }

  public start(): void {
    if (!this.enabled) {
      this.options.logger.log('YouTube bridge disabled (missing apiKey and liveChatId/liveVideoId/liveUrl, or disabled flag)')
      return
    }

    if (this.running)
      return

    this.running = true
    this.schedulePoll(0)
  }

  public stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  public drain(maxMessages: number): YouTubeChatMessage[] {
    if (maxMessages <= 0)
      return []

    return this.queue.splice(0, maxMessages)
  }

  public async sendMessage(message: string): Promise<boolean> {
    if (!this.options.replyEnabled) {
      return false
    }
    if (!this.options.oauthAccessToken) {
      this.options.logger.log('YouTube live chat reply skipped (missing oauthAccessToken)')
      return false
    }
    if (!this.activeLiveChatId) {
      this.options.logger.log('YouTube live chat reply skipped (missing liveChatId)')
      return false
    }

    // Reply budget guard
    const todayDate = new Date().toISOString().slice(0, 10)
    if (this.replyCountResetDate !== todayDate) {
      this.replyCountResetDate = todayDate
      this.repliesSentToday = 0
    }
    if (this.repliesSentToday >= this.options.maxDailyReplies) {
      this.options.logger.withFields({
        repliesSentToday: this.repliesSentToday,
        maxDailyReplies: this.options.maxDailyReplies,
      }).warn('YouTube daily reply budget exhausted; skipping reply')
      return false
    }

    const response = await fetch('https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.options.oauthAccessToken}`,
      },
      body: JSON.stringify({
        snippet: {
          liveChatId: this.activeLiveChatId,
          type: 'textMessageEvent',
          textMessageDetails: {
            messageText: message,
          },
        },
      }),
    })

    if (!response.ok) {
      this.options.logger.withFields({
        status: response.status,
        statusText: response.statusText,
      }).warn('YouTube live chat reply failed')
      return false
    }

    this.repliesSentToday++
    return true
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running)
      return

    this.timer = setTimeout(async () => {
      try {
        const suggestedNextDelay = await this.pollOnce()
        this.transientBackoffMs = 0
        this.schedulePoll(suggestedNextDelay)
      }
      catch (error) {
        const pollingError = error instanceof YouTubePollingError
          ? error
          : new YouTubePollingError((error as Error)?.message || String(error))
        const nextDelay = this.resolveRetryDelayFromError(pollingError)
        if (!pollingError.suppressRetryWarning) {
          this.options.logger.withFields({
            nextDelayMs: nextDelay,
          }).withError(error).warn('YouTube polling failed; retrying later')
        }
        this.schedulePoll(nextDelay)
      }
    }, Math.max(0, delayMs))
  }

  private async pollOnce(): Promise<number> {
    await this.ensureLiveChatId()

    const now = Date.now()
    if (now < this.quotaBackoffUntil) {
      return Math.max(this.options.pollIntervalMs, this.quotaBackoffUntil - now)
    }

    const params = new URLSearchParams({
      part: 'snippet,authorDetails',
      liveChatId: this.activeLiveChatId,
      maxResults: String(this.options.maxResults),
      key: this.options.apiKey,
    })

    if (this.pageToken) {
      params.set('pageToken', this.pageToken)
    }

    const url = `https://www.googleapis.com/youtube/v3/liveChat/messages?${params.toString()}`
    const response = await fetch(url)
    if (!response.ok) {
      const errorPayload = await this.safeReadErrorPayload(response)
      if (this.isQuotaExceeded(errorPayload)) {
        this.consecutiveForbiddenFailures = 0
        const msTilMidnight = this.computeMsTilMidnightPacific()
        const quotaBackoffMs = Math.max(this.options.pollIntervalMs, this.options.quotaBackoffMs, msTilMidnight)
        this.quotaBackoffUntil = Date.now() + quotaBackoffMs
        this.options.logger.withFields({
          backoffMs: quotaBackoffMs,
          msTilMidnightPacific: msTilMidnight,
        }).warn('YouTube quota exceeded; backing off until daily reset')
        throw new YouTubePollingError(
          `YouTube quota exceeded: ${response.status} ${response.statusText}`,
          quotaBackoffMs,
          true,
        )
      }
      if (response.status === 403) {
        const forbiddenBackoff = this.registerForbiddenFailure('live chat polling')
        throw new YouTubePollingError(
          `YouTube live chat API forbidden: ${response.status} ${response.statusText}`,
          forbiddenBackoff,
          true,
        )
      }
      throw new YouTubePollingError(`YouTube live chat API error: ${response.status} ${response.statusText}`)
    }
    this.consecutiveForbiddenFailures = 0

    // Track poll count for adaptive interval
    if (this.pollCountStartedAt === 0) {
      this.pollCountStartedAt = Date.now()
    }
    this.pollCount++

    const payload = await response.json() as YouTubeListResponse
    this.pageToken = payload.nextPageToken || this.pageToken

    const messages: YouTubeChatMessage[] = (payload.items || [])
      .filter(item => item.snippet?.type === 'textMessageEvent')
      .map((item) => {
        const id = item.id || `${item.authorDetails?.displayName || 'anon'}:${item.snippet?.publishedAt || Date.now()}`
        return {
          id,
          author: item.authorDetails?.displayName || 'anonymous',
          text: item.snippet?.displayMessage || '',
          publishedAt: item.snippet?.publishedAt || new Date().toISOString(),
        }
      })
      .filter(item => item.text.trim().length > 0)
      .filter((item) => {
        if (this.seen.has(item.id))
          return false
        this.seen.add(item.id)
        return true
      })

    if (this.seen.size > 2000) {
      // Keep memory bounded; this is only for de-dup in current runtime.
      const kept = new Set<string>()
      for (const message of this.queue) {
        kept.add(message.id)
      }
      this.seen = kept
    }

    if (this.primed) {
      if (messages.length > 0) {
        this.queue.push(...messages)
        if (this.queue.length > this.options.maxPendingMessages) {
          this.queue = this.queue.slice(-this.options.maxPendingMessages)
        }
        this.options.logger.withFields({
          queued: messages.length,
          pending: this.queue.length,
        }).log('YouTube live chat messages queued')
        this.options.onMessagesQueued?.(messages.length)
      }
    }
    else {
      this.primed = true
      this.options.logger.log('YouTube live chat bridge primed')
    }

    // Adaptive quota-aware interval adjustment
    this.adjustAdaptiveInterval()

    const apiSuggestedMs = payload.pollingIntervalMillis || this.adaptiveIntervalMs
    return Math.max(this.adaptiveIntervalMs, apiSuggestedMs)
  }

  private resolveRetryDelayFromError(error: YouTubePollingError): number {
    if (typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0) {
      return Math.max(this.options.pollIntervalMs, error.retryAfterMs)
    }

    this.transientBackoffMs = this.transientBackoffMs <= 0
      ? this.options.pollIntervalMs
      : Math.min(MAX_TRANSIENT_BACKOFF_MS, this.transientBackoffMs * 2)
    return Math.max(this.options.pollIntervalMs, this.transientBackoffMs)
  }

  private async ensureLiveChatId(): Promise<void> {
    if (this.activeLiveChatId.length > 0) {
      return
    }

    const now = Date.now()
    if (now - this.lastResolveAttemptAt < LIVE_CHAT_RESOLVE_RETRY_MS) {
      throw new YouTubePollingError('YouTube live chat id is not resolved yet', LIVE_CHAT_RESOLVE_RETRY_MS)
    }
    this.lastResolveAttemptAt = now

    const videoId = this.resolveVideoId()
    if (!videoId) {
      throw new YouTubePollingError('YouTube live chat id resolution skipped (missing video id / live url)', LIVE_CHAT_RESOLVE_RETRY_MS)
    }

    const params = new URLSearchParams({
      part: 'liveStreamingDetails',
      id: videoId,
      key: this.options.apiKey,
    })
    const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`
    const response = await fetch(url)
    if (!response.ok) {
      const errorPayload = await this.safeReadErrorPayload(response)
      if (this.isQuotaExceeded(errorPayload)) {
        this.consecutiveForbiddenFailures = 0
        const msTilMidnight = this.computeMsTilMidnightPacific()
        const quotaBackoffMs = Math.max(this.options.pollIntervalMs, this.options.quotaBackoffMs, msTilMidnight)
        this.quotaBackoffUntil = Date.now() + quotaBackoffMs
        throw new YouTubePollingError(
          `YouTube quota exceeded during liveChatId resolution: ${response.status} ${response.statusText}`,
          quotaBackoffMs,
          true,
        )
      }
      if (response.status === 403) {
        const forbiddenBackoff = this.registerForbiddenFailure('liveChatId resolution')
        throw new YouTubePollingError(
          `YouTube liveChatId resolution forbidden: ${response.status} ${response.statusText}`,
          forbiddenBackoff,
          true,
        )
      }
      throw new YouTubePollingError(
        `Failed to resolve liveChatId from video id (${videoId}): ${response.status} ${response.statusText}`,
        LIVE_CHAT_RESOLVE_RETRY_MS,
      )
    }
    this.consecutiveForbiddenFailures = 0

    const payload = await response.json() as YouTubeVideoDetailsResponse
    const resolved = payload.items?.[0]?.liveStreamingDetails?.activeLiveChatId?.trim() || ''
    if (!resolved) {
      throw new YouTubePollingError(
        `activeLiveChatId is unavailable for video (${videoId}). Is the stream live?`,
        LIVE_CHAT_RESOLVE_RETRY_MS,
      )
    }

    this.activeLiveChatId = resolved
    this.pageToken = null
    this.primed = false
    this.options.logger.withFields({
      videoId,
      liveChatId: this.maskForLog(resolved),
    }).log('YouTube liveChatId resolved from video')
  }

  private resolveVideoId(): string {
    const direct = this.options.liveVideoId.trim()
    if (direct.length > 0) {
      return direct
    }

    const raw = this.options.liveUrl.trim()
    if (!raw) {
      return ''
    }

    const idLike = raw.match(/^[\w-]{8,}$/)?.[0]
    if (idLike) {
      return idLike
    }

    try {
      const parsed = new URL(raw)
      const hostname = parsed.hostname.toLowerCase()
      if (hostname.includes('youtu.be')) {
        return parsed.pathname.replace(/^\/+/, '').split('/')[0] || ''
      }
      if (hostname.includes('youtube.com')) {
        const byQuery = parsed.searchParams.get('v')
        if (byQuery) {
          return byQuery
        }
        const pathParts = parsed.pathname.split('/').filter(Boolean)
        if (pathParts[0] === 'live' && pathParts[1]) {
          return pathParts[1]
        }
      }
    }
    catch {
      return ''
    }

    return ''
  }

  private async safeReadErrorPayload(response: Response): Promise<YouTubeErrorResponse | null> {
    try {
      return await response.json() as YouTubeErrorResponse
    }
    catch {
      return null
    }
  }

  private isQuotaExceeded(payload: YouTubeErrorResponse | null): boolean {
    const errors = payload?.error?.errors || []
    return errors.some(error => (error.reason || '').toLowerCase() === 'quotaexceeded')
  }

  private registerForbiddenFailure(scope: 'live chat polling' | 'liveChatId resolution'): number {
    this.consecutiveForbiddenFailures++
    const failureCount = this.consecutiveForbiddenFailures
    if (failureCount < MAX_CONSECUTIVE_FORBIDDEN_FAILURES) {
      this.options.logger.withFields({
        scope,
        failureCount,
        threshold: MAX_CONSECUTIVE_FORBIDDEN_FAILURES,
      }).warn('YouTube API returned forbidden; retrying with backoff')
      return Math.max(this.options.pollIntervalMs, this.options.quotaBackoffMs)
    }

    const forbiddenBackoffMs = Math.max(
      this.options.pollIntervalMs,
      this.options.quotaBackoffMs,
      FORBIDDEN_BACKOFF_MS,
    )
    this.quotaBackoffUntil = Date.now() + forbiddenBackoffMs
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.options.logger.withFields({
      scope,
      failureCount,
      backoffMs: forbiddenBackoffMs,
    }).error('Stopping YouTube polling after repeated forbidden API responses')
    return forbiddenBackoffMs
  }

  private adjustAdaptiveInterval(): void {
    const elapsedHours = (Date.now() - this.pollCountStartedAt) / 3_600_000
    const projectedDailyPolls = (this.pollCount / Math.max(elapsedHours, 0.1)) * 24
    const projectedDailyQuota = projectedDailyPolls * QUOTA_UNITS_PER_POLL

    if (projectedDailyQuota > QUOTA_DAILY_HIGH_WATERMARK) {
      const previous = this.adaptiveIntervalMs
      this.adaptiveIntervalMs = Math.min(this.adaptiveIntervalMs * 2, MAX_ADAPTIVE_INTERVAL_MS)
      this.options.logger.withFields({
        projectedDailyQuota: Math.round(projectedDailyQuota),
        previousIntervalMs: previous,
        newIntervalMs: this.adaptiveIntervalMs,
      }).warn('YouTube adaptive throttle: increasing poll interval to stay within quota')
    }
    else if (projectedDailyQuota < QUOTA_DAILY_LOW_WATERMARK && this.adaptiveIntervalMs > this.options.pollIntervalMs) {
      const previous = this.adaptiveIntervalMs
      this.adaptiveIntervalMs = Math.max(
        Math.floor(this.adaptiveIntervalMs * 0.75),
        this.options.pollIntervalMs,
      )
      this.options.logger.withFields({
        projectedDailyQuota: Math.round(projectedDailyQuota),
        previousIntervalMs: previous,
        newIntervalMs: this.adaptiveIntervalMs,
      }).log('YouTube adaptive throttle: reducing poll interval (quota headroom available)')
    }
  }

  private computeMsTilMidnightPacific(): number {
    // YouTube API quota resets at midnight Pacific Time (America/Los_Angeles)
    const now = new Date()
    // Build a formatter to get the current Pacific date components
    const pacificParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(now)

    const get = (type: string) => pacificParts.find(p => p.type === type)?.value || '0'
    const hour = Number(get('hour'))
    const minute = Number(get('minute'))
    const second = Number(get('second'))

    // Seconds remaining until midnight Pacific
    const secondsUntilMidnight = (24 - hour - 1) * 3600 + (60 - minute - 1) * 60 + (60 - second)
    // Add a 5-minute buffer past midnight to be safe
    return Math.max(0, secondsUntilMidnight * 1000 + 5 * 60_000)
  }

  private maskForLog(value: string): string {
    if (value.length <= 8) {
      return '***'
    }
    return `${value.slice(0, 4)}...${value.slice(-4)}`
  }
}
