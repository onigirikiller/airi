import type { StructuredMemoryContext } from '../libs/mineflayer/memory'
import type { WorldFacts } from './preconditions'

export interface AutonomySignal {
  id: string
  source: 'player' | 'youtube' | 'system'
  author: string
  text: string
  importance: number
  timestamp: number
  metadata?: Record<string, string>
}

export interface AutonomyDecisionContext {
  nowIso: string
  botName: string
  activeGoal: string | null
  activeGoalElapsedMs: number
  status: string
  worldState: string
  nearbyPlayers: string[]
  recentActions: string[]
  candidateSelfGoals: string[]
  recentSignals: AutonomySignal[]
  socialWeights: {
    selfGoal: number
    social: number
    comment: number
  }
  conversationContext: {
    recentViewerMessages: string[]
    recentAssistantMessages: string[]
    suggestedAdjustments: string[]
  }
  worldStateVersion?: number
  knowledgeSnippet?: string
  worldFacts?: WorldFacts
  structuredMemory?: StructuredMemoryContext
}

export interface AutonomyIntent {
  goal?: string
  speak?: string
  focus: 'self' | 'co-op' | 'community'
  confidence: number
  reason?: string
  replyToSignalId?: string
}

export interface AutonomyDecisionProvider {
  decide: (context: AutonomyDecisionContext) => Promise<AutonomyIntent>
}

export interface YouTubeChatMessage {
  id: string
  author: string
  text: string
  publishedAt: string
}
