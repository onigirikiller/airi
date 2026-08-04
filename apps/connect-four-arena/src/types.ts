import type { PlayerId } from './domain/connect-four'

export interface ConnectionSettings {
  apiKey: string
  autoPlay: boolean
  baseUrl: string
  moveDelayMs: number
  model: string
  temperature: number
}

export interface PersonaConfig {
  id: PlayerId
  name: string
  personality: string
}

export interface AgentDecision {
  column: number
  line: string
  strategy: string
}

export interface MatchEvent extends AgentDecision {
  move: number
  player: PlayerId
  playerName: string
}
