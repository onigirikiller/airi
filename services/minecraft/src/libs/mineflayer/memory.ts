import type { Message } from 'neuri/openai'

import type { Action } from './action'

const MAX_CHAT_HISTORY = 80
const MAX_ACTIONS = 100
const MAX_ACTIVE_GOALS = 4
const MAX_RECENT_SUBGOALS = 8
const MAX_DISCOVERIES = 6
const MAX_RESOURCE_EVENTS = 6
const MAX_RECENT_MOTIF_FAMILIES = 12
const MAX_UNRESOLVED_NEEDS = 6
const MAX_FAILURE_ENTRIES = 6

export type ActionOutcomeResult = 'verified' | 'failed' | 'timeout' | 'verification_failed'

export interface StructuredActionOutcome {
  actionName: string
  result: ActionOutcomeResult
  failureClass?: string
  goalId?: string
  subgoalId?: string
  currentMilestone?: string
  gainedResources?: string[]
  lostResources?: string[]
}

export interface StructuredProgressionRecord {
  currentMilestone?: string
  unresolvedNeeds?: string[]
  nextGoals?: string[]
}

export interface StructuredNarrationRecord {
  motifFamily: string
  templateFamily?: string
  speechIntent: string
  groundingSource: string
  isKeepalive: boolean
}

export interface StructuredMemorySnapshot {
  activeGoals: string[]
  recentSubgoals: string[]
  lastActionOutcome: string
  lastFailureClass: string
  repeatedFailures: string[]
  discoveries: string[]
  unresolvedNeeds: string[]
  activeMilestone: string
  abandonedPlan: string
  gainedResources: string[]
  lostResources: string[]
  recentMotifFamilies: string[]
}

export interface StructuredMemoryContext {
  snapshot: StructuredMemorySnapshot
  plannerFacts: string[]
  narrationFacts: string[]
}

interface FailureEntry {
  key: string
  failureClass: string
  count: number
  subject: string
  at: number
}

function normalizeLabel(value: string | undefined): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function pushUniqueRecent(list: string[], rawValue: string | undefined, maxItems: number): void {
  const value = normalizeLabel(rawValue)
  if (!value) {
    return
  }

  const existingIndex = list.findIndex(entry => entry.toLowerCase() === value.toLowerCase())
  if (existingIndex >= 0) {
    list.splice(existingIndex, 1)
  }
  list.push(value)
  if (list.length > maxItems) {
    list.splice(0, list.length - maxItems)
  }
}

function compactList(list: string[], maxItems: number): string {
  if (list.length === 0) {
    return 'none'
  }

  return list.slice(-maxItems).join(', ')
}

export class Memory {
  public chatHistory: Message[]
  public actions: Action[]
  private readonly repeatedFailureEntries: Map<string, FailureEntry>
  private structuredSnapshot: StructuredMemorySnapshot

  constructor() {
    this.chatHistory = []
    this.actions = []
    this.repeatedFailureEntries = new Map()
    this.structuredSnapshot = {
      activeGoals: [],
      recentSubgoals: [],
      lastActionOutcome: '',
      lastFailureClass: '',
      repeatedFailures: [],
      discoveries: [],
      unresolvedNeeds: [],
      activeMilestone: '',
      abandonedPlan: '',
      gainedResources: [],
      lostResources: [],
      recentMotifFamilies: [],
    }
  }

  public pushChatMessage(message: Message): void {
    this.chatHistory.push(message)
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory = this.chatHistory.slice(-MAX_CHAT_HISTORY)
    }
  }

  public pushAction(action: Action): void {
    this.actions.push(action)
    if (this.actions.length > MAX_ACTIONS) {
      this.actions = this.actions.slice(-MAX_ACTIONS)
    }
  }

  public activateGoal(goal: string, currentMilestone?: string): void {
    pushUniqueRecent(this.structuredSnapshot.activeGoals, goal, MAX_ACTIVE_GOALS)
    if (currentMilestone) {
      this.structuredSnapshot.activeMilestone = normalizeLabel(currentMilestone)
    }
  }

  public completeGoal(goal: string, options: { success: boolean, reason?: string } = { success: true }): void {
    const normalizedGoal = normalizeLabel(goal)
    this.structuredSnapshot.activeGoals = this.structuredSnapshot.activeGoals
      .filter(entry => entry.toLowerCase() !== normalizedGoal.toLowerCase())

    if (!options.success) {
      const reason = normalizeLabel(options.reason)
      this.structuredSnapshot.abandonedPlan = reason
        ? `${normalizedGoal} (${reason})`
        : normalizedGoal
    }
  }

  public updateProgression(record: StructuredProgressionRecord): void {
    const milestone = normalizeLabel(record.currentMilestone)
    if (milestone) {
      this.structuredSnapshot.activeMilestone = milestone
    }

    const unresolvedNeeds = (record.unresolvedNeeds || [])
      .map(item => normalizeLabel(item))
      .filter(Boolean)
    this.structuredSnapshot.unresolvedNeeds = unresolvedNeeds.slice(0, MAX_UNRESOLVED_NEEDS)

    for (const goal of record.nextGoals || []) {
      pushUniqueRecent(this.structuredSnapshot.activeGoals, goal, MAX_ACTIVE_GOALS)
    }
  }

  public recordActionOutcome(outcome: StructuredActionOutcome): void {
    const actionName = normalizeLabel(outcome.actionName)
    const subgoalLabel = normalizeLabel(outcome.subgoalId || outcome.goalId || actionName)
    const currentMilestone = normalizeLabel(outcome.currentMilestone)

    this.structuredSnapshot.lastActionOutcome = normalizeLabel(
      `${actionName}:${outcome.result}${outcome.failureClass ? `:${outcome.failureClass}` : ''}`,
    )
    if (outcome.failureClass) {
      this.structuredSnapshot.lastFailureClass = normalizeLabel(outcome.failureClass)
    }
    else {
      this.structuredSnapshot.lastFailureClass = ''
    }

    pushUniqueRecent(this.structuredSnapshot.recentSubgoals, subgoalLabel, MAX_RECENT_SUBGOALS)

    if (currentMilestone) {
      this.structuredSnapshot.activeMilestone = currentMilestone
    }

    if (outcome.failureClass) {
      const key = `${subgoalLabel}::${normalizeLabel(outcome.failureClass)}`
      const existing = this.repeatedFailureEntries.get(key)
      this.repeatedFailureEntries.set(key, {
        key,
        failureClass: normalizeLabel(outcome.failureClass),
        count: (existing?.count ?? 0) + 1,
        subject: subgoalLabel,
        at: Date.now(),
      })
    }
    else {
      for (const key of this.repeatedFailureEntries.keys()) {
        if (key.startsWith(`${subgoalLabel}::`)) {
          this.repeatedFailureEntries.delete(key)
        }
      }
    }

    const repeatedFailures = [...this.repeatedFailureEntries.values()]
      .sort((left, right) => right.at - left.at || right.count - left.count)
      .slice(0, MAX_FAILURE_ENTRIES)
      .map(entry => `${entry.failureClass} x${entry.count} @ ${entry.subject}`)
    this.structuredSnapshot.repeatedFailures = repeatedFailures

    for (const resource of outcome.gainedResources || []) {
      pushUniqueRecent(this.structuredSnapshot.gainedResources, resource, MAX_RESOURCE_EVENTS)
      pushUniqueRecent(this.structuredSnapshot.discoveries, resource, MAX_DISCOVERIES)
    }
    for (const resource of outcome.lostResources || []) {
      pushUniqueRecent(this.structuredSnapshot.lostResources, resource, MAX_RESOURCE_EVENTS)
    }
  }

  public recordNarrationDecision(record: StructuredNarrationRecord): void {
    pushUniqueRecent(this.structuredSnapshot.recentMotifFamilies, record.motifFamily, MAX_RECENT_MOTIF_FAMILIES)
  }

  public getStructuredSnapshot(): StructuredMemorySnapshot {
    return {
      ...this.structuredSnapshot,
      activeGoals: [...this.structuredSnapshot.activeGoals],
      recentSubgoals: [...this.structuredSnapshot.recentSubgoals],
      repeatedFailures: [...this.structuredSnapshot.repeatedFailures],
      discoveries: [...this.structuredSnapshot.discoveries],
      unresolvedNeeds: [...this.structuredSnapshot.unresolvedNeeds],
      gainedResources: [...this.structuredSnapshot.gainedResources],
      lostResources: [...this.structuredSnapshot.lostResources],
      recentMotifFamilies: [...this.structuredSnapshot.recentMotifFamilies],
    }
  }

  public buildPlannerFacts(maxItems = 4): string[] {
    const snapshot = this.getStructuredSnapshot()

    return [
      `memory_active_goals: ${compactList(snapshot.activeGoals, maxItems)}`,
      `memory_recent_subgoals: ${compactList(snapshot.recentSubgoals, maxItems)}`,
      `memory_last_action: ${snapshot.lastActionOutcome || 'none'}`,
      `memory_repeated_failures: ${compactList(snapshot.repeatedFailures, maxItems)}`,
      `memory_active_milestone: ${snapshot.activeMilestone || 'unknown'}`,
      `memory_unresolved_needs: ${compactList(snapshot.unresolvedNeeds, maxItems)}`,
      `memory_recent_gains: ${compactList(snapshot.gainedResources, maxItems)}`,
      `memory_recent_losses: ${compactList(snapshot.lostResources, maxItems)}`,
      snapshot.abandonedPlan ? `memory_abandoned_plan: ${snapshot.abandonedPlan}` : '',
    ].filter(Boolean)
  }

  public buildNarrationFacts(maxItems = 3): string[] {
    const snapshot = this.getStructuredSnapshot()

    return [
      snapshot.activeMilestone ? `milestone=${snapshot.activeMilestone}` : '',
      snapshot.lastActionOutcome ? `last_action=${snapshot.lastActionOutcome}` : '',
      snapshot.lastFailureClass ? `last_failure=${snapshot.lastFailureClass}` : '',
      snapshot.unresolvedNeeds.length > 0 ? `needs=${compactList(snapshot.unresolvedNeeds, maxItems)}` : '',
      snapshot.discoveries.length > 0 ? `discoveries=${compactList(snapshot.discoveries, maxItems)}` : '',
      snapshot.recentMotifFamilies.length > 0 ? `motifs=${compactList(snapshot.recentMotifFamilies, maxItems)}` : '',
    ].filter(Boolean)
  }

  public getStructuredContext(): StructuredMemoryContext {
    return {
      snapshot: this.getStructuredSnapshot(),
      plannerFacts: this.buildPlannerFacts(),
      narrationFacts: this.buildNarrationFacts(),
    }
  }
}
