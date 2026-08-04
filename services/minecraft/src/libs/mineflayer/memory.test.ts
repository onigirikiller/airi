import { describe, expect, it } from 'vitest'

import { Memory } from './memory'

describe('mineflayer structured memory', () => {
  it('tracks active goals, progression, and verified action outcomes as compact planner facts', () => {
    const memory = new Memory()

    memory.activateGoal('Craft a furnace', 'furnace')
    memory.updateProgression({
      currentMilestone: 'furnace',
      unresolvedNeeds: ['furnace', 'food-buffer'],
      nextGoals: ['Craft a furnace'],
    })
    memory.recordActionOutcome({
      actionName: 'collectBlocks',
      result: 'verified',
      subgoalId: 'Mine 8 cobblestone',
      currentMilestone: 'furnace',
      gainedResources: ['cobblestone x8'],
      lostResources: ['stone_pickaxe x1'],
    })

    const context = memory.getStructuredContext()

    expect(context.snapshot.activeMilestone).toBe('furnace')
    expect(context.snapshot.lastActionOutcome).toBe('collectBlocks:verified')
    expect(context.snapshot.unresolvedNeeds).toEqual(['furnace', 'food-buffer'])
    expect(context.plannerFacts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('memory_active_goals: Craft a furnace'),
        expect.stringContaining('memory_last_action: collectBlocks:verified'),
        expect.stringContaining('memory_recent_gains: cobblestone x8'),
      ]),
    )
  })

  it('aggregates repeated failures and narration motifs without growing unbounded raw history', () => {
    const memory = new Memory()

    memory.recordActionOutcome({
      actionName: 'goToCoordinates',
      result: 'failed',
      failureClass: 'movement_stall',
      subgoalId: 'Reach cave mouth',
      currentMilestone: 'iron-acquisition',
    })
    memory.recordActionOutcome({
      actionName: 'goToCoordinates',
      result: 'failed',
      failureClass: 'movement_stall',
      subgoalId: 'Reach cave mouth',
      currentMilestone: 'iron-acquisition',
    })
    memory.recordNarrationDecision({
      motifFamily: 'failure:movement_stall',
      templateFamily: 'failure:movement_stall',
      speechIntent: 'failure',
      groundingSource: 'failure',
      isKeepalive: false,
    })

    const snapshot = memory.getStructuredSnapshot()
    const narrationFacts = memory.buildNarrationFacts()

    expect(snapshot.repeatedFailures).toContain('movement_stall x2 @ Reach cave mouth')
    expect(snapshot.recentMotifFamilies).toContain('failure:movement_stall')
    expect(narrationFacts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('last_failure=movement_stall'),
        expect.stringContaining('motifs=failure:movement_stall'),
      ]),
    )
  })
})
