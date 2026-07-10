import type { Neuri } from 'neuri'

import type { CanonicalInventorySnapshot } from '../../libs/inventory/policy'
import type { Mineflayer } from '../../libs/mineflayer'
import type { Action } from '../../libs/mineflayer/action'
import type { ActionAgent, AgentConfig, MemoryAgent, Plan, PlanningAgent } from '../../libs/mineflayer/base-agent'
import type { PlanStep } from './adapter'

import recipeKnowledge from '../../autonomy/knowledge/recipes.json'

import { AbstractAgent } from '../../libs/mineflayer/base-agent'
import { emitFallbackMonitor, monitorBus } from '../../libs/monitor-event-bus'
import { getActualItemCount, getCanonicalInventorySnapshot } from '../../skills/actions/inventory'
import { getLastCraftRecipeDiagnostic, getLastPlacedCraftingTableRecord } from '../../skills/crafting'
import { isFoodItemName } from '../../skills/food'
import { getInventoryCounts, getNearestBlock, getNearestBlocks } from '../../skills/world'
import { ActionAgentImpl } from '../action'
import { PlanningLLMHandler } from './adapter'

interface PlanContext {
  goal: string
  currentStep: number
  startTime: number
  lastUpdate: number
  retryCount: number
  failureCounts: Record<string, number>
  isGenerating: boolean
  pendingSteps: PlanStep[]
  blockedSteps: BlockedPlanStep[]
  lastCapabilityHash?: string
  lastStateKey?: string
}

interface BlockedPlanStep {
  fingerprint: string
  stepFingerprint: string
  goalKey: string
  capabilityHash: string
  failureClass: string
  stateKey: string
  blockedAt: number
  reason: string
}

interface StructuredRecipeDefinition {
  ingredients: Record<string, number>
  requires_table?: boolean
  output_count?: number
  note?: string
}

type StructuredRecipeBook = Record<string, StructuredRecipeDefinition>

interface StructuredInventoryShadow {
  log: number
  oak_planks: number
  stick: number
  cobblestone: number
  raw_iron: number
  iron_ingot: number
  coal: number
  crafting_table: number
  furnace: number
  torch: number
  food: number
  sword: number
  wooden_pickaxe: number
  stone_pickaxe: number
  iron_pickaxe: number
  wooden_axe: number
  stone_axe: number
  iron_axe: number
  shield: number
  [key: string]: number
}

const STRUCTURED_RECIPES = recipeKnowledge as StructuredRecipeBook
const PLACED_WORKSTATION_INTERACTION_DISTANCE = 4.25
const REACHABLE_WORKSTATION_SCAN_DISTANCE = 64
const REACHABLE_WORKSTATION_VERTICAL_DISTANCE = 3
const SURFACE_RECOVERY_CUE_QUERIES = [
  'grass_block',
  'dirt',
  'coarse_dirt',
  'podzol',
  'mycelium',
  'sand',
  'red_sand',
  'mud',
  'snow_block',
  'snow',
  'moss_block',
  'log',
  'leaves',
]
const GOAL_VERIFICATION_CRAFT_SYNC_TTL_MS = 15_000

export interface PlanningAgentConfig extends AgentConfig {
  bot?: Mineflayer
  llm: {
    agent: Neuri
    model?: string
  }
}

export class PlanningAgentImpl extends AbstractAgent implements PlanningAgent {
  public readonly type = 'planning' as const
  private currentPlan: Plan | null = null
  private context: PlanContext | null = null
  private actionAgent: ActionAgent | null = null
  private memoryAgent: MemoryAgent | null = null
  private llmHandler: PlanningLLMHandler
  private readonly bot?: Mineflayer

  constructor(config: PlanningAgentConfig) {
    super(config)
    this.bot = config.bot
    this.llmHandler = new PlanningLLMHandler(config.bot)
  }

  protected async initializeAgent(): Promise<void> {
    this.logger.log('Initializing planning agent')

    // Create action agent directly
    this.actionAgent = new ActionAgentImpl({
      id: 'action',
      type: 'action',
      bot: this.bot,
    })
    await this.actionAgent.init()

    // Set event listener
    this.on('message', async ({ sender, message }) => {
      await this.handleAgentMessage(sender, message)
    })

    this.on('interrupt', () => {
      this.handleInterrupt()
    })
  }

  protected async destroyAgent(): Promise<void> {
    this.currentPlan = null
    this.context = null
    this.actionAgent = null
    this.memoryAgent = null
    this.removeAllListeners()
  }

  private static normalizeRuntimeErrorMessage(feedback: string): string {
    return feedback
      .toLowerCase()
      .replace(/\b\d+\b/g, '#')
      .replace(/"[^"]+"/g, '"#"')
      .replace(/\([^)]*\)/g, '(#)')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private getBridgeCapabilityHash(): string {
    const bridgeState = this.bot?.getBridgeDebugState?.() as Record<string, unknown> | null | undefined
    const capabilitySnapshot = bridgeState?.capabilitySnapshot as { capabilityHash?: string } | undefined
    return capabilitySnapshot?.capabilityHash?.trim() || 'capability:unknown'
  }

  private getPlannerStateKey(): string {
    const inventory = (() => {
      try {
        return this.bot ? getInventoryCounts(this.bot as any) : {}
      }
      catch {
        return {}
      }
    })()
    const inventoryKey = Object.entries(inventory)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 12)
      .map(([itemName, count]) => `${itemName}:${Math.min(64, count)}`)
      .join('|') || 'inventory:none'

    const position = this.bot?.bot?.entity?.position
    const positionKey = position
      ? `${Math.floor(position.x / 8)},${Math.floor(position.y / 8)},${Math.floor(position.z / 8)}`
      : 'position:unknown'

    return `cap=${this.getBridgeCapabilityHash()}|pos=${positionKey}|inv=${inventoryKey}`
  }

  private initializeContext(goal: string): PlanContext {
    return {
      goal,
      currentStep: 0,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: 0,
      failureCounts: {},
      isGenerating: false,
      pendingSteps: [],
      blockedSteps: this.context?.blockedSteps ?? [],
      lastCapabilityHash: this.getBridgeCapabilityHash(),
      lastStateKey: this.getPlannerStateKey(),
    }
  }

  private getBlockedPlanStep(step: PlanStep, stateKey = this.getPlannerStateKey()): BlockedPlanStep | null {
    if (!this.context?.blockedSteps?.length) {
      return null
    }

    const stepFingerprint = this.planStepSuppressionFingerprint(step)
    const goalKey = this.normalizeGoalKey(this.context.goal)
    const capabilityHash = this.getBridgeCapabilityHash()
    return this.context.blockedSteps.find(entry =>
      entry.stepFingerprint === stepFingerprint
      && entry.goalKey === goalKey
      && entry.capabilityHash === capabilityHash
      && entry.stateKey === stateKey,
    ) ?? null
  }

  private rememberBlockedStep(step: PlanStep, failureClass: string, reason: string): void {
    if (!this.context) {
      return
    }

    const stateKey = this.getPlannerStateKey()
    const stepFingerprint = this.planStepSuppressionFingerprint(step)
    const goalKey = this.normalizeGoalKey(this.context.goal)
    const capabilityHash = this.getBridgeCapabilityHash()
    const fingerprint = `${stepFingerprint}|${failureClass}|${capabilityHash}|${goalKey}|${stateKey}`
    const existing = this.context.blockedSteps.find(entry => entry.fingerprint === fingerprint)
    const blockedAt = Date.now()
    if (existing) {
      existing.reason = reason
      existing.blockedAt = blockedAt
      existing.failureClass = failureClass
      existing.stateKey = stateKey
      existing.goalKey = goalKey
      existing.capabilityHash = capabilityHash
    }
    else {
      this.context.blockedSteps = [
        ...this.context.blockedSteps.filter(entry => blockedAt - entry.blockedAt <= 10 * 60_000),
        {
          fingerprint,
          stepFingerprint,
          goalKey,
          capabilityHash,
          failureClass,
          stateKey,
          blockedAt,
          reason,
        },
      ].slice(-24)
    }

    this.context.lastCapabilityHash = this.getBridgeCapabilityHash()
    this.context.lastStateKey = stateKey
  }

  private filterBlockedSteps(
    goal: string,
    steps: PlanStep[],
    plannerSource: NonNullable<NonNullable<PlanStep['meta']>['plannerSource']>,
  ): PlanStep[] {
    const stateKey = this.getPlannerStateKey()
    let plannedStateMayChange = false
    let blockedWoodPrerequisite = false
    const filtered = steps.flatMap((step) => {
      if (
        blockedWoodPrerequisite
        && this.isWoodBootstrapCraftStep(step)
        && !this.hasInventoryWoodBootstrapInputForStep(step)
      ) {
        this.logger.withFields({
          goal,
          action_name: step.tool,
          normalized_params: JSON.stringify(step.params),
          planner_source: plannerSource,
          prerequisite: 'collectBlocks(log)',
          capability_snapshot_hash: this.getBridgeCapabilityHash(),
        }).warn('Suppressing craft step because prerequisite wood collection is blocked in the current state')
        return []
      }

      const blockedCandidate = this.getBlockedPlanStep(step, stateKey)
      const blocked = blockedCandidate
        && plannedStateMayChange
        && this.canRetryBlockedStepAfterPlannedStateChange(step, blockedCandidate)
        ? null
        : blockedCandidate
      if (!blocked) {
        plannedStateMayChange = plannedStateMayChange || this.canStepChangePlannerState(step)
        return [{
          ...step,
          meta: {
            ...step.meta,
            plannerSource,
          },
        }]
      }

      this.logger.withFields({
        goal,
        action_name: step.tool,
        normalized_params: JSON.stringify(step.params),
        failure_class: blocked.failureClass,
        blocked_step_reason: blocked.reason,
        planner_source: plannerSource,
        fast_path_suppressed_reason: blocked.reason,
        capability_snapshot_hash: this.getBridgeCapabilityHash(),
      }).warn('Suppressing blocked plan step until world, inventory, or capability state changes')
      if (
        step.tool === 'collectBlocks'
        && this.normalizeBlockTargetFamily(step.params.type) === 'log'
      ) {
        blockedWoodPrerequisite = true
      }
      return []
    })

    if (filtered.length < steps.length) {
      monitorBus.emitMonitor('planning:blockedStepSuppressed', {
        goal,
        plannerSource,
        suppressedCount: steps.length - filtered.length,
        stateKey,
      })
    }

    return filtered
  }

  private canStepChangePlannerState(step: PlanStep): boolean {
    return [
      'moveAway',
      'goToCoordinates',
      'recoverTowardSurface',
      'searchForBlock',
      'searchForEntity',
      'collectBlocks',
      'attack',
      'craftRecipe',
      'placeHere',
      'smeltItem',
      'consume',
      'equip',
      'discard',
    ].includes(step.tool)
  }

  private isWoodBootstrapCraftStep(step: PlanStep): boolean {
    if (step.tool !== 'craftRecipe' || typeof step.params.recipe_name !== 'string') {
      return false
    }

    const recipeName = this.normalizeCraftRecipeAlias(step.params.recipe_name)
    return recipeName === 'crafting_table'
      || recipeName === 'stick'
      || recipeName.endsWith('_planks')
      || recipeName === 'wooden_pickaxe'
      || recipeName === 'wooden_axe'
      || recipeName === 'wooden_shovel'
      || recipeName === 'wooden_sword'
      || recipeName === 'wooden_hoe'
  }

  private hasInventoryWoodBootstrapInputForStep(step: PlanStep): boolean {
    const recipeName = step.tool === 'craftRecipe' && typeof step.params.recipe_name === 'string'
      ? this.normalizeCraftRecipeAlias(step.params.recipe_name)
      : ''
    const inventory = this.getInventorySnapshot()

    if (recipeName.endsWith('_planks') || recipeName === 'crafting_table') {
      return inventory.logs > 0 || inventory.planks > 0
    }

    if (recipeName === 'stick') {
      return inventory.planks > 0
    }

    if (recipeName.startsWith('wooden_')) {
      return inventory.planks > 0 || inventory.sticks > 0
    }

    return true
  }

  private canRetryBlockedStepAfterPlannedStateChange(step: PlanStep, blocked: BlockedPlanStep): boolean {
    const failureClass = blocked.failureClass.toLowerCase()
    const reason = blocked.reason.toLowerCase()

    if (
      step.tool === 'collectBlocks'
      && this.normalizeBlockTargetFamily(step.params.type) === 'log'
      && (failureClass.includes('wood-search-or-collect') || reason.includes('collectblocks failed: log'))
    ) {
      return true
    }

    if (
      step.tool === 'collectBlocks'
      && (
        failureClass.includes('inventory_unchanged')
        || failureClass.includes('verification')
        || reason.includes('inventory_unchanged')
        || reason.includes('action verification failed')
        || (reason.includes('collectblocks') && reason.includes('failed'))
      )
    ) {
      return true
    }

    if (
      step.tool === 'craftRecipe'
      && (failureClass.includes('ingredient') || failureClass.includes('inventory preflight') || reason.includes('ingredient_missing'))
    ) {
      return true
    }

    return false
  }

  public async createPlan(goal: string): Promise<Plan> {
    if (!this.initialized) {
      throw new Error('Planning agent not initialized')
    }

    this.logger.withField('goal', goal).log('Creating plan')
    monitorBus.emitMonitor('planning:started', { goal })

    try {
      if (await this.isGoalAlreadySatisfiedWithoutAdditionalActions(goal)) {
        this.logger.withField('goal', goal).log('Goal already satisfied before planning; returning completed no-op plan')
        return {
          goal,
          steps: [],
          status: 'completed',
          requiresAction: false,
        }
      }

      const availableActions = this.actionAgent?.getAvailableActions() ?? []
      const availableActionNames = new Set(availableActions.map(action => action.name))
      const visibleWorkstationSteps = this.buildVisibleWorkstationApproachPlan(goal, availableActionNames)
      if (visibleWorkstationSteps.length > 0) {
        const immediateHostileDisengageStep = this.buildImmediateHostileDisengageStep(availableActionNames)
        const steps = immediateHostileDisengageStep
          ? [immediateHostileDisengageStep, ...visibleWorkstationSteps]
          : visibleWorkstationSteps
        const plan: Plan = {
          goal,
          steps,
          status: 'pending',
          requiresAction: true,
        }
        this.logger.withFields({
          goal,
          stepCount: steps.length,
          planner_source: 'deterministic-workstation-approach',
          capability_snapshot_hash: this.getBridgeCapabilityHash(),
        }).log('Using visible workstation approach plan')
        this.currentPlan = plan
        this.context = this.initializeContext(goal)
        return plan
      }

      const unsafeCoalCoordinateFallbackSteps = this.filterBlockedSteps(
        goal,
        this.buildStructuredCoalViaCharcoalPlan(goal, availableActionNames, {
          requireUnsafeSubsurfaceCoordinate: true,
        }),
        'deterministic-coal-charcoal-fallback',
      )
      if (unsafeCoalCoordinateFallbackSteps.length > 0) {
        const immediateHostileDisengageStep = this.buildImmediateHostileDisengageStep(availableActionNames)
        const steps = immediateHostileDisengageStep
          ? [immediateHostileDisengageStep, ...unsafeCoalCoordinateFallbackSteps]
          : unsafeCoalCoordinateFallbackSteps
        const plan: Plan = {
          goal,
          steps,
          status: 'pending',
          requiresAction: true,
        }
        this.logger.withFields({
          goal,
          stepCount: steps.length,
          planner_source: 'deterministic-coal-charcoal-fallback',
          capability_snapshot_hash: this.getBridgeCapabilityHash(),
        }).log('Using charcoal fallback instead of unsafe subsurface coal coordinate')
        this.currentPlan = plan
        this.context = this.initializeContext(goal)
        return plan
      }

      const surfaceTorchCoalFallbackSteps = this.filterBlockedSteps(
        goal,
        this.buildStructuredCoalViaCharcoalPlan(goal, availableActionNames, {
          requireTorchGoal: true,
        }),
        'deterministic-coal-charcoal-fallback',
      )
      if (surfaceTorchCoalFallbackSteps.length > 0) {
        const immediateHostileDisengageStep = this.buildImmediateHostileDisengageStep(availableActionNames)
        const steps = immediateHostileDisengageStep
          ? [immediateHostileDisengageStep, ...surfaceTorchCoalFallbackSteps]
          : surfaceTorchCoalFallbackSteps
        const plan: Plan = {
          goal,
          steps,
          status: 'pending',
          requiresAction: true,
        }
        this.logger.withFields({
          goal,
          stepCount: steps.length,
          planner_source: 'deterministic-coal-charcoal-fallback',
          capability_snapshot_hash: this.getBridgeCapabilityHash(),
        }).log('Using charcoal fallback for surface coal-and-torch goal')
        this.currentPlan = plan
        this.context = this.initializeContext(goal)
        return plan
      }

      // Check memory for existing plan
      const cachedPlan = await this.loadCachedPlan(goal)
      if (cachedPlan) {
        const filteredCachedSteps = this.filterBlockedSteps(
          goal,
          this.ensureActionableSteps(goal, cachedPlan.steps),
          'cache',
        )
        if (filteredCachedSteps.length > 0 || !cachedPlan.requiresAction) {
          this.logger.log('Using cached plan')
          cachedPlan.steps = filteredCachedSteps
          this.currentPlan = cachedPlan
          this.context = this.initializeContext(goal)
          return cachedPlan
        }
        this.logger.withField('goal', goal).warn('Discarding cached plan because all cached steps are blocked in the current state')
      }

      // Check if the goal requires actions
      const requirements = this.parseGoalRequirements(goal)
      const requiresAction = this.doesGoalRequireAction(requirements)
      let steps: PlanStep[] = []

      if (!requiresAction) {
        if (this.shouldUseFallbackForGoal(goal)) {
          this.logger.withField('goal', goal).warn('Goal looked non-actionable, forcing fallback plan')
          monitorBus.emitMonitor('planning:fallback', { goal, reason: 'non-actionable' })
          emitFallbackMonitor({
            scope: 'planning.createPlan',
            reason: 'non-actionable-goal',
            goal,
            detail: 'Goal looked non-actionable, forcing fallback plan.',
            recoverable: true,
          })
          steps = this.ensureActionableSteps(goal, [])
        }
        else {
          this.logger.log('Goal does not require actions')
          return {
            goal,
            steps: [],
            status: 'completed',
            requiresAction: false,
          }
        }
      }

      if (steps.length === 0) {
        const structuredSteps = this.filterBlockedSteps(
          goal,
          this.buildStructuredExecutionPlan(goal, availableActionNames),
          'deterministic-fast-path',
        )
        if (structuredSteps.length > 0) {
          steps = structuredSteps
          this.logger.withFields({
            goal,
            stepCount: steps.length,
            planner_source: 'deterministic-fast-path',
            capability_snapshot_hash: this.getBridgeCapabilityHash(),
          }).log('Using structured low-vram execution plan')
        }
      }

      if (steps.length === 0) {
        // Create plan steps based on available actions and goal
        const generatedSteps = await this.generatePlanSteps(goal, availableActions, 'system')
        steps = this.filterBlockedSteps(
          goal,
          this.ensureActionableSteps(goal, generatedSteps),
          'llm',
        )
        if (steps.length > 0) {
          monitorBus.emitMonitor('planning:llmGenerated', { goal, stepCount: steps.length })
        }
      }

      if (steps.length === 0) {
        this.logger.withField('goal', goal).warn('No actionable steps generated for goal')
        return {
          goal,
          steps: [],
          status: 'completed',
          requiresAction: false,
        }
      }

      // Create new plan
      const plan: Plan = {
        goal,
        steps,
        status: 'pending',
        requiresAction: true,
      }

      // Cache the plan
      await this.cachePlan(plan)

      this.currentPlan = plan
      this.context = this.initializeContext(goal)

      return plan
    }
    catch (error) {
      this.logger.withError(error).error('Failed to create plan')
      throw error
    }
  }

  public async executePlan(plan: Plan): Promise<void> {
    if (!this.initialized) {
      throw new Error('Planning agent not initialized')
    }

    if (!plan.requiresAction) {
      this.logger.log('Plan does not require actions, skipping execution')
      return
    }

    if (!this.actionAgent) {
      throw new Error('Action agent not available')
    }

    this.logger.withField('plan', plan).log('Executing plan')

    try {
      const availableActionNames = new Set((this.actionAgent?.getAvailableActions() ?? []).map(a => a.name))
      let activePlan = plan

      while (true) {
        activePlan.status = 'in_progress'
        this.currentPlan = activePlan
        let adjustedPlan: Plan | null = null

        for (let stepIndex = 0; stepIndex < activePlan.steps.length; stepIndex++) {
          const step = activePlan.steps[stepIndex]
          if (!step.tool || !availableActionNames.has(step.tool)) {
            this.logger.withFields({ step: step.description, tool: step.tool }).warn('Skipping step with invalid/unknown tool')
            continue
          }
          try {
            const stepWithMeta: PlanStep = {
              ...step,
              meta: {
                goalId: activePlan.goal,
                subgoalId: `${step.tool}:${stepIndex}`,
                currentMilestone: activePlan.goal,
                retryBudget: Math.max(0, 3 - (this.context?.retryCount ?? 0)),
                ...step.meta,
              },
            }
            this.logger.withField('step', step).log('Executing step')
            monitorBus.emitMonitor('planning:stepExecuting', { step: { tool: step.tool, description: step.description }, index: stepIndex })
            await this.actionAgent.performAction(stepWithMeta)
            monitorBus.emitMonitor('planning:stepCompleted', { step: { tool: step.tool, description: step.description }, index: stepIndex })
            if (this.context) {
              this.context.currentStep = stepIndex + 1
              this.context.lastUpdate = Date.now()
            }
          }
          catch (stepError) {
            const errorMessage = stepError instanceof Error ? stepError.message : String(stepError)
            const failureClass = this.classifyStepFailureClass(errorMessage)
            monitorBus.emitMonitor('planning:stepFailed', { step: { tool: step.tool, description: step.description }, index: stepIndex, error: errorMessage })
            this.logger.withError(stepError).error('Failed to execute step')

            if (this.context) {
              this.context.currentStep = stepIndex
            }

            const repeatedStepFailureKey = `${step.tool}:${failureClass}:${this.planStepSuppressionFingerprint(step)}`
            const repeatedStepFailures = (this.context?.failureCounts[repeatedStepFailureKey] ?? 0) + 1
            if (this.context) {
              this.context.failureCounts[repeatedStepFailureKey] = repeatedStepFailures
            }
            this.rememberBlockedStep(step, failureClass, errorMessage)

            if (repeatedStepFailures >= 3) {
              this.logger.withFields({
                goal: activePlan.goal,
                tool: step.tool,
                repeatedStepFailures,
                failure_class: failureClass,
              }).warn('Aborting repeated failing step before another blind retry loop')
              throw new Error(`Repeated failing action aborted: ${step.tool}`)
            }

            if (this.context && this.context.retryCount < 3) {
              this.context.retryCount++
              adjustedPlan = await this.adjustPlan(activePlan, errorMessage, 'system')
              if (this.context) {
                this.context.currentStep = 0
                this.context.lastUpdate = Date.now()
              }
              break
            }

            throw stepError
          }
        }

        if (!adjustedPlan) {
          plan = activePlan
          break
        }

        activePlan = adjustedPlan
      }

      // Verify goal completion before marking as completed
      const verified = await this.verifyGoalCompletion(plan.goal, plan)
      if (!verified) {
        throw new Error(`Goal verification failed: ${plan.goal}`)
      }
      plan.status = 'completed'
      monitorBus.emitMonitor('planning:completed', { goal: plan.goal, status: plan.status })
    }
    catch (error) {
      plan.status = 'failed'
      monitorBus.emitMonitor('planning:completed', { goal: plan.goal, status: 'failed', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    finally {
      this.context = null
    }
  }

  private async verifyGoalCompletion(goal: string, plan: Plan): Promise<boolean> {
    const requirements = this.parseGoalRequirements(goal)
    if (!requirements.needsItems && !requirements.needsCrafting) {
      return true
    }

    let inventory: Record<string, number>
    let snapshot: CanonicalInventorySnapshot | null = null
    try {
      if (!this.bot) {
        this.logger.warn('Bot unavailable for goal verification, treating goal as incomplete')
        return false
      }
      inventory = getInventoryCounts(this.bot as any)
      snapshot = getCanonicalInventorySnapshot(this.bot as any, 'planning-goal-verification')
    }
    catch {
      this.logger.warn('Could not access bot inventory for goal verification, treating goal as incomplete')
      return false
    }

    let targetRequirements = this.extractGoalTargetRequirements(goal)
    if (targetRequirements.length === 0) {
      if (!requirements.needsCrafting) {
        this.logger.withField('goal', goal).log('Goal verification passed: no concrete item target was required')
        return true
      }
      return false
    }

    if (targetRequirements.some(target => this.isFoodGoalTarget(target.item))) {
      const foodVerificationState = await this.consumeFoodForVerificationIfNeeded(goal, inventory, snapshot)
      inventory = foodVerificationState.inventory
      snapshot = foodVerificationState.snapshot

      if (this.canVerifyFoodGoalByStability(goal) && this.isFoodRecoveryStable(goal)) {
        targetRequirements = targetRequirements.filter(target => !this.isFoodGoalTarget(target.item))
        if (targetRequirements.length === 0) {
          this.logger.withFields({
            goal,
            food: this.getCurrentFoodLevel(),
            health: this.getCurrentHealthLevel(),
          }).log('Goal verification passed: food recovery reached a stable hunger state')
          return true
        }
      }
      else if (
        this.shouldConsumeFoodDuringGoal(goal)
        && this.countFoodItemsInInventory(inventory) > 0
      ) {
        this.logger.withFields({
          goal,
          food: this.getCurrentFoodLevel(),
          health: this.getCurrentHealthLevel(),
        }).warn('Goal verification held open: edible food remains but hunger is still below the safe threshold')
        return false
      }
    }

    await this.refreshGoalTargetWorldVisibility(targetRequirements)
    const missingDeficits = this.getMissingGoalItemDeficits(inventory, targetRequirements, plan, snapshot)
    if (missingDeficits.length === 0) {
      this.logger.withField('goal', goal).log('Goal verification passed: all target items found in inventory')
      return true
    }
    const missingItems = this.formatGoalItemDeficits(missingDeficits)

    this.logger.withFields({
      goal,
      missingItems,
      inventory: Object.fromEntries(Object.entries(inventory).filter(([_, count]) => count > 0)),
    }).log('Goal verification detected missing items, requesting LLM for additional steps')

    const inventorySummary = Object.entries(inventory)
      .filter(([_, count]) => count > 0)
      .map(([name, count]) => `${name}x${count}`)
      .join(', ')

    const feedback = `前回のステップ実行後のインベントリ: ${inventorySummary || '(空)'}. ゴール「${goal}」を実行したが、${missingItems.join(', ')}がインベントリにない。完了か失敗か判定し、追加ステップが必要なら提案して。`

    try {
      const availableActions = this.actionAgent?.getAvailableActions() ?? []
      const verificationGoal = this.buildVerificationGoalFromDeficits(missingDeficits) ?? goal
      const availableActionNames = new Set(availableActions.map(action => action.name))
      const structuredVerificationSteps = this.buildStructuredExecutionPlan(goal, availableActionNames)
      const additionalSteps = structuredVerificationSteps.length > 0
        ? structuredVerificationSteps
        : await this.generatePlanSteps(verificationGoal, availableActions, 'system', feedback)
      const actionable = this.ensureActionableSteps(goal, additionalSteps)
      const canPerformActions = typeof (this.actionAgent as ActionAgent | null)?.performAction === 'function'

      if (actionable.length === 0 || !canPerformActions) {
        this.logger.withField('goal', goal).warn('LLM returned no additional verification steps while goal is still missing required items')
        return false
      }

      this.logger.withFields({ goal, additionalSteps: actionable.length }).log('Executing additional verification steps')

      for (const step of actionable) {
        try {
          await this.actionAgent?.performAction(step)
        }
        catch (stepError) {
          this.logger.withFields({
            goal,
            action_name: step.tool,
            normalized_params: JSON.stringify(step.params),
          }).withError(stepError).warn('Additional verification step failed, aborting remaining verification steps')
          return false
        }
      }

      const refreshedInventory = getInventoryCounts(this.bot as any)
      await this.refreshGoalTargetWorldVisibility(targetRequirements)
      const refreshedSnapshot = this.bot
        ? getCanonicalInventorySnapshot(this.bot as any, 'planning-goal-verification:refresh')
        : null
      const remainingMissingDeficits = this.getMissingGoalItemDeficits(
        refreshedInventory,
        targetRequirements,
        plan,
        refreshedSnapshot,
      )
      if (remainingMissingDeficits.length === 0) {
        return true
      }

      this.logger.withFields({
        goal,
        remainingMissingItems: this.formatGoalItemDeficits(remainingMissingDeficits),
      }).warn('Goal verification still missing items after additional verification steps')
      return false
    }
    catch (error) {
      this.logger.withError(error).warn('Goal verification LLM call failed')
      return false
    }
  }

  private async isGoalAlreadySatisfiedWithoutAdditionalActions(goal: string): Promise<boolean> {
    const requirements = this.parseGoalRequirements(goal)
    if (!requirements.needsItems && !requirements.needsCrafting) {
      return false
    }

    const targetRequirements = this.extractGoalTargetRequirements(goal)
    if (targetRequirements.length === 0 || !this.bot) {
      return false
    }

    if (typeof (this.bot as any)?.bot?.inventory?.items !== 'function') {
      return false
    }

    try {
      await this.refreshGoalTargetWorldVisibility(targetRequirements)
      const inventory = getInventoryCounts(this.bot as any)
      const snapshot = getCanonicalInventorySnapshot(this.bot as any, 'planning-preflight-goal-satisfaction')
      const preflightPlan: Plan = {
        goal,
        steps: [],
        status: 'pending',
        requiresAction: true,
      }
      return this.getMissingGoalItemDeficits(inventory, targetRequirements, preflightPlan, snapshot).length === 0
    }
    catch (error) {
      this.logger.withField('goal', goal).withError(error).warn('Goal preflight satisfaction check failed; continuing with normal planning')
      return false
    }
  }

  private buildVisibleWorkstationApproachPlan(goal: string, availableActionNames: Set<string>): PlanStep[] {
    const targetRequirements = this.extractGoalTargetRequirements(goal)
      .map(target => ({
        ...target,
        item: this.normalizeCraftRecipeAlias(target.item),
      }))

    if (targetRequirements.length !== 1) {
      return []
    }

    const [target] = targetRequirements
    const item = target.item
    if ((item !== 'crafting_table' && item !== 'furnace') || target.minCount > 1) {
      return []
    }

    if (
      (item === 'crafting_table' && this.hasNearbyCraftingTableAccess())
      || (item === 'furnace' && this.hasNearbyFurnaceAccess())
    ) {
      return []
    }

    const workstation = this.getNearestVisibleWorkstationBlock(item, 24)
    if (!workstation?.position) {
      return []
    }

    const label = item.replace(/_/g, ' ')
    if (availableActionNames.has('searchForBlock')) {
      return [{
        description: `Move to the visible ${label} instead of recreating it`,
        tool: 'searchForBlock',
        params: { type: item, search_range: 24 },
      }]
    }

    if (availableActionNames.has('goToCoordinates')) {
      return [{
        description: `Move to the visible ${label} instead of recreating it`,
        tool: 'goToCoordinates',
        params: {
          x: workstation.position.x,
          y: workstation.position.y,
          z: workstation.position.z,
          closeness: 3,
        },
      }]
    }

    return []
  }

  private getNearestVisibleWorkstationBlock(
    item: 'crafting_table' | 'furnace',
    distance: number,
  ): { position?: { x: number, y: number, z: number } } | null {
    if (!this.bot) {
      return null
    }

    try {
      return getNearestBlock(this.bot as any, item, distance)
    }
    catch {
      return null
    }
  }

  private getCurrentFoodLevel(): number {
    const food = Number((this.bot as any)?.bot?.food ?? 20)
    return Number.isFinite(food) ? food : 20
  }

  private async refreshGoalTargetWorldVisibility(
    targetRequirements: Array<{ item: string }>,
  ): Promise<void> {
    if (!this.bot) {
      return
    }

    const blockTypes = [...new Set(targetRequirements
      .map(target => this.normalizeCraftRecipeAlias(target.item))
      .filter(item => item === 'crafting_table' || item === 'furnace'))]
    if (blockTypes.length === 0) {
      return
    }

    const scanNearbyBlocks = (this.bot as any)?.bot?.scanNearbyBlocks
    if (typeof scanNearbyBlocks !== 'function') {
      return
    }

    try {
      await scanNearbyBlocks.call((this.bot as any).bot, 8, blockTypes)
    }
    catch {
      // best-effort visibility refresh only
    }
  }

  private getCurrentHealthLevel(): number {
    const health = Number((this.bot as any)?.bot?.health ?? 20)
    return Number.isFinite(health) ? health : 20
  }

  private isFoodGoalTarget(itemName: string): boolean {
    return this.normalizeCraftRecipeAlias(itemName) === 'food'
  }

  private isImmediateFoodRecoveryGoalText(goal: string): boolean {
    const normalized = goal.toLowerCase()
    return [
      'consume',
      'eat',
      'hunger',
      'hungry',
      'recover',
      'heal',
      'survival',
      'stable',
      'stabilize',
      'secure food',
    ].some(keyword => normalized.includes(keyword))
    || [
      '食べ',
      '空腹',
      '回復',
      '生存',
      '安定',
      '食料を確保',
    ].some(keyword => goal.includes(keyword))
  }

  private getFoodRecoveryFoodThreshold(goal: string): number {
    const normalized = goal.toLowerCase()
    const needsRegeneration = this.getCurrentHealthLevel() <= 12
      || normalized.includes('heal')
      || normalized.includes('recover')
      || goal.includes('回復')
    if (needsRegeneration) {
      return 18
    }

    return this.isImmediateFoodRecoveryGoalText(goal) ? 14 : 11
  }

  private shouldConsumeFoodDuringGoal(goal: string): boolean {
    const currentFood = this.getCurrentFoodLevel()
    const currentHealth = this.getCurrentHealthLevel()
    const canBenefitFromEating = currentFood < 20 || currentHealth < 20
    if (!canBenefitFromEating) {
      return false
    }

    const belowFoodThreshold = currentFood < this.getFoodRecoveryFoodThreshold(goal)
    return belowFoodThreshold || this.isImmediateFoodRecoveryGoalText(goal) || currentHealth <= 12
  }

  private isFoodRecoveryStable(goal: string): boolean {
    return this.getCurrentFoodLevel() >= this.getFoodRecoveryFoodThreshold(goal)
  }

  private canVerifyFoodGoalByStability(goal: string): boolean {
    return this.isImmediateFoodRecoveryGoalText(goal)
  }

  private countFoodItemsInInventory(inventory: Record<string, number>): number {
    return Object.entries(inventory)
      .filter(([itemName, count]) => count > 0 && isFoodItemName(itemName))
      .reduce((sum, [, count]) => sum + count, 0)
  }

  private async consumeFoodForVerificationIfNeeded(
    goal: string,
    inventory: Record<string, number>,
    snapshot: CanonicalInventorySnapshot | null,
  ): Promise<{ inventory: Record<string, number>, snapshot: CanonicalInventorySnapshot | null }> {
    if (!this.bot || !this.shouldConsumeFoodDuringGoal(goal) || this.isFoodRecoveryStable(goal)) {
      return { inventory, snapshot }
    }

    const canPerformActions = typeof (this.actionAgent as ActionAgent | null)?.performAction === 'function'
    if (!canPerformActions) {
      return { inventory, snapshot }
    }

    let refreshedInventory = inventory
    let refreshedSnapshot = snapshot
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.isFoodRecoveryStable(goal) || this.countFoodItemsInInventory(refreshedInventory) <= 0) {
        break
      }

      try {
        await this.actionAgent?.performAction({
          description: 'Eat available food before verifying survival food recovery',
          tool: 'consume',
          params: { item_name: 'food' },
        })
      }
      catch (error) {
        this.logger.withError(error).warn('Food recovery verification consume step failed')
        break
      }

      refreshedInventory = getInventoryCounts(this.bot as any)
      refreshedSnapshot = getCanonicalInventorySnapshot(this.bot as any, 'planning-goal-verification:food-refresh')
    }

    return {
      inventory: refreshedInventory,
      snapshot: refreshedSnapshot,
    }
  }

  private buildStructuredExecutionPlan(goal: string, availableActionNames: Set<string>): PlanStep[] {
    const immediateHostileDisengageStep = this.buildImmediateHostileDisengageStep(availableActionNames)
    const surfaceRecoverySteps = this.buildStructuredSurfaceRecoveryPlan(goal, availableActionNames)
    if (surfaceRecoverySteps.length > 0) {
      if (immediateHostileDisengageStep) {
        return [
          immediateHostileDisengageStep,
          ...surfaceRecoverySteps,
        ]
      }
      return surfaceRecoverySteps
    }

    const smeltSteps = this.buildStructuredSmeltPlan(goal, availableActionNames)
    if (smeltSteps.length > 0) {
      if (immediateHostileDisengageStep) {
        return [
          immediateHostileDisengageStep,
          ...smeltSteps,
        ]
      }
      return smeltSteps
    }

    const shelterSteps = this.buildStructuredShelterPlan(goal, availableActionNames)
    if (shelterSteps.length > 0) {
      return shelterSteps
    }

    const targetRequirements = this.extractGoalTargetRequirements(goal)
      .map(target => ({
        ...target,
        item: this.normalizeCraftRecipeAlias(target.item),
      }))
    const placementTargets = this.extractPlacementTargetsFromText(goal)
      .map(target => this.normalizeCraftRecipeAlias(target))
    const isStructuredCraftTarget = (target: { item: string }): boolean =>
      Boolean(STRUCTURED_RECIPES[target.item]) || target.item === 'sword'
    const craftTargets = targetRequirements
      .filter(target => isStructuredCraftTarget(target))
      .sort((left, right) => this.getStructuredCraftPriority(left.item) - this.getStructuredCraftPriority(right.item))
    const gatherTargets = targetRequirements
      .filter(target => !isStructuredCraftTarget(target))

    if (craftTargets.length === 0 && gatherTargets.length === 0 && placementTargets.length === 0) {
      return []
    }

    const shadow = this.getStructuredInventoryShadow()
    const steps: PlanStep[] = []
    const resolving = new Set<string>()
    let surfaceRecoveryForWoodInserted = false
    let foodRecoverySatisfiedByConsume = false

    if (immediateHostileDisengageStep) {
      steps.push(immediateHostileDisengageStep)
    }

    const appendStep = (step: PlanStep): void => {
      if (step.tool === 'searchForBlock') {
        const existingSearchStep = steps.find(existingStep =>
          existingStep.tool === 'searchForBlock'
          && this.normalizeBlockTargetFamily(existingStep.params.type)
          === this.normalizeBlockTargetFamily(step.params.type),
        )
        if (existingSearchStep) {
          const currentRange = Number(existingSearchStep.params.search_range ?? 0)
          const nextRange = Number(step.params.search_range ?? 0)
          existingSearchStep.params = {
            ...existingSearchStep.params,
            ...step.params,
            search_range: Math.max(currentRange, nextRange),
          }
          return
        }
      }

      steps.push(step)
    }

    const appendFoodConsumeStep = (description: string): boolean => {
      if (!availableActionNames.has('consume') || !this.shouldConsumeFoodDuringGoal(goal)) {
        return false
      }

      appendStep({
        description,
        tool: 'consume',
        params: { item_name: 'food' },
      })
      this.consumeStructuredShadowItem(shadow, 'food', 1)
      foodRecoverySatisfiedByConsume = true
      return true
    }

    if (
      targetRequirements.some(target => this.isFoodGoalTarget(target.item))
      && this.countStructuredShadowItem(shadow, 'food') > 0
    ) {
      appendFoodConsumeStep('Eat available food before continuing survival work')
    }

    const appendGatherSteps = (itemName: string, requiredCount: number): boolean => {
      if (requiredCount <= 0) {
        return true
      }

      const normalized = this.normalizeCraftRecipeAlias(itemName)
      switch (normalized) {
        case 'oak_log':
        case 'log': {
          if (!availableActionNames.has('collectBlocks')) {
            return false
          }
          if (!surfaceRecoveryForWoodInserted) {
            const surfaceFirstWoodSteps = this.buildSurfaceFirstWoodRecoverySteps(availableActionNames)
            if (surfaceFirstWoodSteps.length > 0) {
              for (const step of surfaceFirstWoodSteps) {
                appendStep(step)
              }
              surfaceRecoveryForWoodInserted = true
            }
          }
          const targetLogCount = Math.max(
            1,
            this.countStructuredShadowItem(shadow, 'log') + requiredCount,
          )
          appendStep({
            description: `Collect logs until carrying ${targetLogCount} for crafting`,
            tool: 'collectBlocks',
            params: { type: 'log', num: targetLogCount },
          })
          this.addStructuredShadowItem(shadow, 'log', requiredCount)
          return true
        }
        case 'cobblestone': {
          if (!availableActionNames.has('collectBlocks')) {
            return false
          }
          // NOTICE: collectBlocks(stone) already performs exposed-stone, direct
          // probe, and shallow-cover recovery. A blocking pre-search can fail in
          // water or cramped terrain before the more robust collector runs.
          appendStep({
            description: `Mine ${Math.max(1, requiredCount)} stone for cobblestone`,
            tool: 'collectBlocks',
            params: { type: 'stone', num: Math.max(1, requiredCount) },
          })
          this.addStructuredShadowItem(shadow, 'cobblestone', requiredCount)
          return true
        }
        case 'coal': {
          if (availableActionNames.has('searchForBlock')) {
            appendStep({
              description: 'Search for coal ore needed for light and smelting',
              tool: 'searchForBlock',
              params: { type: 'coal_ore', search_range: 64 },
            })
          }
          if (!availableActionNames.has('collectBlocks')) {
            return false
          }
          appendStep({
            description: `Collect ${Math.max(1, requiredCount)} coal`,
            tool: 'collectBlocks',
            params: { type: 'coal_ore', num: Math.max(1, requiredCount) },
          })
          this.addStructuredShadowItem(shadow, 'coal', requiredCount)
          return true
        }
        case 'food': {
          if (this.shouldPrepareSwordBeforeFoodHunt(availableActionNames, shadow)) {
            appendStep({
              description: 'Craft a sword for close-range survival before hunting',
              tool: 'craftRecipe',
              params: {
                recipe_name: 'sword',
                num: 1,
              },
            })
            this.addStructuredShadowItem(shadow, 'sword', 1)
          }
          const surfaceFirstFoodSteps = this.buildSurfaceFirstFoodRecoverySteps(availableActionNames)
          if (surfaceFirstFoodSteps.length > 0) {
            for (const step of surfaceFirstFoodSteps) {
              appendStep(step)
            }
            this.addStructuredShadowItem(shadow, 'food', requiredCount)
            appendFoodConsumeStep('Eat food found after returning to the surface')
            return true
          }
          if (availableActionNames.has('moveAway') && this.getCurrentHealthLevel() >= 8) {
            appendStep({
              description: 'Move toward a different area with better food access',
              tool: 'moveAway',
              params: { distance: 24 },
            })
          }
          if (availableActionNames.has('searchForEntity')) {
            appendStep({
              description: 'Search for nearby animals that can provide food',
              tool: 'searchForEntity',
              params: { type: 'animal', search_range: 96 },
            })
          }
          if (!availableActionNames.has('attack')) {
            return false
          }
          appendStep({
            description: 'Hunt a nearby animal for food',
            tool: 'attack',
            params: { type: 'animal' },
          })
          this.addStructuredShadowItem(shadow, 'food', requiredCount)
          appendFoodConsumeStep('Eat newly gathered food before continuing survival work')
          return true
        }
        default:
          return false
      }
    }

    const ensureBatchedWoodenBootstrapTool = (itemName: string, minimumCount: number): boolean => {
      if (!availableActionNames.has('craftRecipe')) {
        return false
      }

      const normalizedItem = this.normalizeCraftRecipeAlias(itemName)
      if (!['wooden_pickaxe', 'wooden_axe', 'wooden_sword'].includes(normalizedItem)) {
        return false
      }

      const recipe = STRUCTURED_RECIPES[normalizedItem]
      if (!recipe) {
        return false
      }

      const missingCount = Math.max(0, minimumCount - this.countStructuredShadowItem(shadow, normalizedItem))
      if (missingCount <= 0) {
        return true
      }

      const tablePlanks = recipe.requires_table && this.countStructuredShadowItem(shadow, 'crafting_table') <= 0 ? 4 : 0
      const directToolPlanks = Number(recipe.ingredients?.oak_planks ?? 0) * missingCount
      const requiredSticks = Number(recipe.ingredients?.stick ?? 0) * missingCount
      const stickCraftIterations = Math.ceil(
        Math.max(0, requiredSticks - this.countStructuredShadowItem(shadow, 'stick')) / 4,
      )
      const stickCraftPlanks = stickCraftIterations * 2
      const requiredPlanks = tablePlanks + directToolPlanks + stickCraftPlanks
      const plankCraftIterations = Math.ceil(
        Math.max(0, requiredPlanks - this.countStructuredShadowItem(shadow, 'oak_planks')) / 4,
      )
      const missingLogs = Math.max(0, plankCraftIterations - this.countStructuredShadowItem(shadow, 'log'))

      if (missingLogs > 0 && !appendGatherSteps('log', missingLogs)) {
        return false
      }

      if (plankCraftIterations > 0) {
        this.consumeStructuredShadowItem(shadow, 'log', plankCraftIterations)
        this.addStructuredShadowItem(shadow, 'oak_planks', plankCraftIterations * 4)
        appendStep({
          description: `Craft ${plankCraftIterations * 4} planks for ${normalizedItem.replace(/_/g, ' ')}`,
          tool: 'craftRecipe',
          params: {
            recipe_name: 'oak_planks',
            num: plankCraftIterations,
          },
        })
      }

      if (tablePlanks > 0) {
        this.consumeStructuredShadowItem(shadow, 'oak_planks', 4)
        this.addStructuredShadowItem(shadow, 'crafting_table', 1)
        appendStep({
          description: 'Craft crafting table',
          tool: 'craftRecipe',
          params: {
            recipe_name: 'crafting_table',
            num: 1,
          },
        })
      }

      if (stickCraftIterations > 0) {
        this.consumeStructuredShadowItem(shadow, 'oak_planks', stickCraftPlanks)
        this.addStructuredShadowItem(shadow, 'stick', stickCraftIterations * 4)
        appendStep({
          description: 'Craft sticks for wooden tool',
          tool: 'craftRecipe',
          params: {
            recipe_name: 'stick',
            num: stickCraftIterations,
          },
        })
      }

      this.consumeStructuredShadowItem(shadow, 'oak_planks', directToolPlanks)
      this.consumeStructuredShadowItem(shadow, 'stick', requiredSticks)
      this.addStructuredShadowItem(shadow, normalizedItem, missingCount)
      appendStep({
        description: `Craft ${normalizedItem.replace(/_/g, ' ')}`,
        tool: 'craftRecipe',
        params: {
          recipe_name: normalizedItem,
          num: missingCount,
        },
      })
      return true
    }

    const ensureItem = (itemName: string, minimumCount: number): boolean => {
      const normalizedItem = this.normalizeCraftRecipeAlias(itemName)
      if (this.countStructuredShadowItem(shadow, normalizedItem) >= minimumCount) {
        return true
      }

      if (resolving.has(normalizedItem)) {
        return false
      }

      const recipe = STRUCTURED_RECIPES[normalizedItem]
      if (['wooden_pickaxe', 'wooden_axe', 'wooden_sword'].includes(normalizedItem)) {
        return ensureBatchedWoodenBootstrapTool(normalizedItem, minimumCount)
      }

      if (normalizedItem === 'sword') {
        if (!availableActionNames.has('craftRecipe')) {
          return false
        }
        const missingCount = Math.max(0, minimumCount - this.countStructuredShadowItem(shadow, normalizedItem))
        if (missingCount <= 0) {
          return true
        }

        const stepCountBeforeWoodenSwordExpansion = steps.length
        const shadowBeforeWoodenSwordExpansion: StructuredInventoryShadow = { ...shadow }
        const expandedWoodenSword = ensureItem('wooden_sword', missingCount)
        if (expandedWoodenSword) {
          this.addStructuredShadowItem(shadow, 'sword', missingCount)
          return true
        }

        steps.splice(stepCountBeforeWoodenSwordExpansion)
        Object.keys(shadow).forEach((key) => {
          shadow[key] = 0
        })
        Object.assign(shadow, shadowBeforeWoodenSwordExpansion)
        appendStep({
          description: 'Craft a sword for close-range survival',
          tool: 'craftRecipe',
          params: {
            recipe_name: 'sword',
            num: missingCount,
          },
        })
        this.addStructuredShadowItem(shadow, 'sword', missingCount)
        return true
      }
      if (!recipe) {
        const missingCount = minimumCount - this.countStructuredShadowItem(shadow, normalizedItem)
        return appendGatherSteps(normalizedItem, missingCount)
      }

      resolving.add(normalizedItem)
      try {
        if (
          recipe.requires_table
          && normalizedItem !== 'crafting_table'
          && this.countStructuredShadowItem(shadow, 'crafting_table') <= 0
        ) {
          const ensuredTable = ensureItem('crafting_table', 1)
          if (!ensuredTable) {
            return false
          }
        }

        const outputCount = Math.max(1, Number(recipe.output_count ?? 1))
        const currentCount = this.countStructuredShadowItem(shadow, normalizedItem)
        const missingCount = Math.max(0, minimumCount - currentCount)
        if (missingCount <= 0) {
          return true
        }

        const craftIterations = Math.ceil(missingCount / outputCount)
        for (const [ingredientName, ingredientCount] of Object.entries(recipe.ingredients ?? {})) {
          const requiredCount = ingredientCount * craftIterations
          const ensured = ensureItem(ingredientName, requiredCount)
          if (!ensured) {
            return false
          }

          // NOTICE: Reserve each ensured ingredient immediately so later sibling ingredients
          // cannot double-spend the same shadow resources (for example planks consumed both
          // directly and indirectly via sticks inside the same parent tool recipe).
          this.consumeStructuredShadowItem(shadow, ingredientName, requiredCount)
        }
        this.addStructuredShadowItem(shadow, normalizedItem, outputCount * craftIterations)
        appendStep({
          description: `Craft ${normalizedItem.replace(/_/g, ' ')}`,
          tool: 'craftRecipe',
          params: {
            recipe_name: normalizedItem,
            num: craftIterations,
          },
        })
        return true
      }
      finally {
        resolving.delete(normalizedItem)
      }
    }

    const ensurePlacementTarget = (itemName: string): boolean => {
      const normalizedItem = this.normalizeCraftRecipeAlias(itemName)
      if (!availableActionNames.has('placeHere')) {
        return false
      }

      if (this.hasNearbyPlacementAccess(normalizedItem)) {
        return true
      }

      const ensured = ensureItem(normalizedItem, 1)
      if (!ensured) {
        return false
      }

      appendStep({
        description: `Place ${normalizedItem.replace(/_/g, ' ')}`,
        tool: 'placeHere',
        params: {
          type: normalizedItem,
        },
      })
      this.consumeStructuredShadowItem(shadow, normalizedItem, 1)
      return true
    }

    for (const placementTarget of placementTargets) {
      const ensured = ensurePlacementTarget(placementTarget)
      if (!ensured) {
        return []
      }
    }

    for (const target of craftTargets) {
      const ensured = ensureItem(target.item, target.minCount)
      if (!ensured) {
        return []
      }
    }

    for (const target of gatherTargets) {
      if (this.isFoodGoalTarget(target.item) && foodRecoverySatisfiedByConsume) {
        continue
      }

      const ensured = ensureItem(target.item, target.minCount)
      if (!ensured) {
        return []
      }
    }

    return steps
  }

  private buildStructuredCoalViaCharcoalPlan(
    goal: string,
    availableActionNames: Set<string>,
    options: {
      forceCoalTarget?: boolean
      requireTorchGoal?: boolean
      requireUnsafeSubsurfaceCoordinate?: boolean
    } = {},
  ): PlanStep[] {
    const normalizedGoal = goal.toLowerCase()
    const wantsTorchGoal = /\b(?:craft|make|create)?\s*(?:a |an )?torches?\b/u.test(normalizedGoal)
      || goal.includes('松明')
    if (options.requireTorchGoal && !wantsTorchGoal) {
      return []
    }

    const targetRequirements = this.extractGoalTargetRequirements(goal)
      .map(target => this.normalizeCraftRecipeAlias(target.item))
    const wantsCoalTarget = Boolean(options.forceCoalTarget)
      || targetRequirements.some(item => item === 'coal' || item === 'coal_ore')
      || /\bcoal(?:_ore| ore)?\b/u.test(normalizedGoal)
      || goal.includes('石炭')
    if (!wantsCoalTarget) {
      return []
    }

    if (options.requireUnsafeSubsurfaceCoordinate && !this.hasUnsafeSubsurfaceCoordinateTarget(goal)) {
      return []
    }

    if (this.isLikelyUndergroundSurfaceRecoveryContext()) {
      return []
    }

    const shadow = this.getStructuredInventoryShadow()
    const hasFurnacePath = (shadow.furnace ?? 0) > 0
      || this.hasNearbyFurnaceAccess()
      || Boolean(this.getNearestVisibleWorkstationBlock('furnace', 24)?.position)
    if (!hasFurnacePath) {
      return []
    }

    const charcoalGoal = wantsTorchGoal
      ? 'Smelt charcoal using logs for torch and furnace fuel'
      : 'Smelt charcoal using logs for furnace fuel'

    return this.buildStructuredSmeltPlan(charcoalGoal, availableActionNames)
  }

  private hasUnsafeSubsurfaceCoordinateTarget(goal: string): boolean {
    const targetCoordinates = this.extractTargetCoordinatesFromGoal(goal)
    const position = this.bot?.bot?.entity?.position
    if (!targetCoordinates || !position) {
      return false
    }

    return targetCoordinates.y < position.y - 6
  }

  private extractTargetCoordinatesFromGoal(goal: string): { x: number, y: number, z: number } | null {
    const match = goal.match(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/u)
    if (!match) {
      return null
    }

    const [, x, y, z] = match
    const coordinates = {
      x: Number(x),
      y: Number(y),
      z: Number(z),
    }
    return Object.values(coordinates).every(Number.isFinite) ? coordinates : null
  }

  private buildImmediateHostileDisengageStep(availableActionNames: Set<string>): PlanStep | null {
    if (!availableActionNames.has('moveAway')) {
      return null
    }

    const health = this.getCurrentHealthLevel()
    if (health > 8) {
      return null
    }

    const nearbyHostiles = this.countNearbyHostileEntities(18)
    if (nearbyHostiles <= 0) {
      return null
    }

    return {
      description: 'Retreat from nearby hostiles before continuing low-health work',
      tool: 'moveAway',
      params: { distance: 24 },
    }
  }

  private countNearbyHostileEntities(maxDistance: number): number {
    const bot = (this.bot as any)?.bot
    const position = bot?.entity?.position
    const entities = bot?.entities
    if (!position || !entities) {
      return 0
    }

    const hostileTypes = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'drowned', 'phantom']
    let count = 0
    for (const entity of Object.values(entities) as any[]) {
      const name = String(entity?.name ?? entity?.type ?? '').toLowerCase()
      const entityPosition = entity?.position
      if (!entityPosition || !hostileTypes.some(type => name.includes(type))) {
        continue
      }

      const distance = Math.hypot(
        Number(entityPosition.x) - Number(position.x),
        Number(entityPosition.y) - Number(position.y),
        Number(entityPosition.z) - Number(position.z),
      )
      if (Number.isFinite(distance) && distance <= maxDistance) {
        count++
      }
    }
    return count
  }

  private buildStructuredSurfaceRecoveryPlan(goal: string, availableActionNames: Set<string>): PlanStep[] {
    if (!this.isSurfaceRecoveryGoalText(goal)) {
      return []
    }

    const wantsWoodAfterRecovery = /wood|log|tree/i.test(goal) || /木|原木/.test(goal)
    const shouldLeadWithLocalCueProbe = this.hasNearbySurfaceRecoveryCue() && availableActionNames.has('searchForBlock')
    const steps: PlanStep[] = []

    if (shouldLeadWithLocalCueProbe) {
      steps.push({
        description: 'Confirm the nearby surface-facing terrain cue before committing to a longer escape climb',
        tool: 'searchForBlock',
        params: { type: 'grass_block', search_range: 64 },
      })
    }

    if (
      shouldLeadWithLocalCueProbe
      && !availableActionNames.has('recoverTowardSurface')
      && availableActionNames.has('moveAway')
    ) {
      steps.push({
        description: 'Reorient away from the cramped cave wall after locking onto the local surface cue',
        tool: 'moveAway',
        params: { distance: 24 },
      })
    }

    if (availableActionNames.has('recoverTowardSurface')) {
      steps.push({
        description: 'Recover toward the surface using the strongest available escape routine',
        tool: 'recoverTowardSurface',
        params: { reason: 'surface_recovery_goal' },
      })

      if (wantsWoodAfterRecovery && availableActionNames.has('collectBlocks')) {
        steps.push({
          description: 'Collect nearby logs after resurfacing',
          tool: 'collectBlocks',
          params: { type: 'log', num: 4 },
        })
      }
      else if (wantsWoodAfterRecovery && availableActionNames.has('searchForBlock')) {
        steps.push({
          description: 'Search for nearby logs after resurfacing',
          tool: 'searchForBlock',
          params: { type: 'log', search_range: 64 },
        })
      }

      return steps
    }

    if (!shouldLeadWithLocalCueProbe && availableActionNames.has('searchForBlock')) {
      steps.push({
        description: 'Search for grass blocks or open terrain to climb toward the surface',
        tool: 'searchForBlock',
        params: { type: 'grass_block', search_range: 96 },
      })
    }

    if (!shouldLeadWithLocalCueProbe && availableActionNames.has('moveAway')) {
      steps.push({
        description: 'Move away from the cave interior to look for a surface exit',
        tool: 'moveAway',
        params: { distance: 32 },
      })
    }

    const position = this.bot?.bot?.entity?.position
    if (position && availableActionNames.has('goToCoordinates')) {
      steps.push({
        description: 'Climb toward a higher local elevation in the current shaft if direct surface cues stay blocked',
        tool: 'goToCoordinates',
        params: {
          x: Math.floor(position.x),
          y: Math.min(320, Math.floor(position.y) + 12),
          z: Math.floor(position.z),
          closeness: 1,
        },
      })
    }

    return steps
  }

  private buildStructuredSmeltPlan(goal: string, availableActionNames: Set<string>): PlanStep[] {
    const normalizedGoal = goal.toLowerCase()
    const wantsIronSmelting = (normalizedGoal.includes('smelt') && normalizedGoal.includes('iron'))
      || goal.includes('鉄インゴット')
      || goal.includes('精錬')
    const wantsTorchGoal = /\b(?:craft|make|create) (?:a |an )?torches?\b/u.test(normalizedGoal)
      || /\b(?:torch|torches)\b/u.test(normalizedGoal)
      || goal.includes('松明')
    const wantsCharcoalSmelting = (normalizedGoal.includes('smelt') && normalizedGoal.includes('charcoal'))
      || goal.includes('木炭')
      || (wantsTorchGoal && normalizedGoal.includes('smelt'))

    if ((!wantsIronSmelting && !wantsCharcoalSmelting) || !availableActionNames.has('smeltItem')) {
      return []
    }

    const shadow = this.getStructuredInventoryShadow()
    const steps: PlanStep[] = []
    const estimateFuelSmeltCapacity = (): number => Math.max(
      0,
      Math.floor(
        ((shadow.coal ?? 0) * 8)
        + ((shadow.log ?? 0) * 1.5)
        + ((shadow.oak_planks ?? 0) * 1.5)
        + ((shadow.stick ?? 0) * 0.5),
      ),
    )
    const ensureAccessibleFurnace = (): boolean => {
      if (this.hasNearbyFurnaceAccess()) {
        return true
      }

      if ((shadow.furnace ?? 0) <= 0 || !availableActionNames.has('placeHere')) {
        if (availableActionNames.has('searchForBlock')) {
          const visibleFurnace = this.getNearestVisibleWorkstationBlock('furnace', 24)
          if (visibleFurnace?.position) {
            steps.push({
              description: 'Move to the visible furnace before smelting',
              tool: 'searchForBlock',
              params: { type: 'furnace', search_range: 24 },
            })
            return true
          }
        }

        return false
      }

      steps.push({
        description: 'Place the furnace before smelting',
        tool: 'placeHere',
        params: { type: 'furnace' },
      })
      shadow.furnace = Math.max(0, (shadow.furnace ?? 0) - 1)
      return true
    }

    if (wantsIronSmelting) {
      const smeltableCount = Math.min(
        shadow.raw_iron ?? 0,
        estimateFuelSmeltCapacity(),
      )

      if (smeltableCount <= 0) {
        return []
      }

      if (!ensureAccessibleFurnace()) {
        return []
      }

      steps.push({
        description: 'Smelt raw iron into iron ingots',
        tool: 'smeltItem',
        params: {
          item_name: 'raw_iron',
          num: Math.max(1, smeltableCount),
        },
      })

      return steps
    }

    const preferredLogSource = this.extractPreferredLogSource(goal)
    const selectedLogSource = this.selectInventoryLogSource(preferredLogSource)
    const preferredPlankRecipe = this.logSourceToPlankRecipe(selectedLogSource ?? preferredLogSource)
    const missingLogs = Math.max(0, 1 - (shadow.log ?? 0))
    if (missingLogs > 0) {
      if (!availableActionNames.has('collectBlocks')) {
        return []
      }
      const surfaceFirstWoodSteps = this.buildSurfaceFirstWoodRecoverySteps(availableActionNames)
      if (surfaceFirstWoodSteps.length > 0) {
        steps.push(...surfaceFirstWoodSteps)
      }
      if (availableActionNames.has('searchForBlock')) {
        steps.push({
          description: 'Search for logs needed to make charcoal',
          tool: 'searchForBlock',
          params: { type: 'log', search_range: 64 },
        })
      }
      steps.push({
        description: `Collect ${Math.max(1, missingLogs)} log for charcoal`,
        tool: 'collectBlocks',
        params: { type: 'log', num: Math.max(1, missingLogs) },
      })
      shadow.log = (shadow.log ?? 0) + missingLogs
    }

    const dedicatedCharcoalFuelAvailable = (shadow.coal ?? 0) > 0
      || (shadow.oak_planks ?? 0) > 0
      || (shadow.stick ?? 0) > 0
    if (!dedicatedCharcoalFuelAvailable) {
      if ((shadow.log ?? 0) <= 1 || !availableActionNames.has('craftRecipe')) {
        return []
      }
      steps.push({
        description: 'Craft planks from spare logs for furnace fuel',
        tool: 'craftRecipe',
        params: { recipe_name: preferredPlankRecipe, num: 1 },
      })
      shadow.log = Math.max(0, (shadow.log ?? 0) - 1)
      shadow.oak_planks = (shadow.oak_planks ?? 0) + 4
    }

    const logSourceForSmelting = selectedLogSource ?? preferredLogSource ?? 'log'
    if (!logSourceForSmelting) {
      return []
    }

    if (!ensureAccessibleFurnace()) {
      return []
    }

    steps.push({
      description: 'Smelt a log into charcoal for early light and fuel',
      tool: 'smeltItem',
      params: {
        item_name: logSourceForSmelting,
        num: 1,
      },
    })
    shadow.log = Math.max(0, (shadow.log ?? 0) - 1)
    shadow.coal = (shadow.coal ?? 0) + 1

    if (!wantsTorchGoal) {
      return steps
    }

    if (!availableActionNames.has('craftRecipe')) {
      return []
    }

    if ((shadow.stick ?? 0) <= 0) {
      if ((shadow.oak_planks ?? 0) <= 0) {
        if ((shadow.log ?? 0) <= 0) {
          return []
        }
        steps.push({
          description: 'Craft planks from spare logs for torch handles',
          tool: 'craftRecipe',
          params: { recipe_name: preferredPlankRecipe, num: 1 },
        })
        shadow.log = Math.max(0, (shadow.log ?? 0) - 1)
        shadow.oak_planks = (shadow.oak_planks ?? 0) + 4
      }

      steps.push({
        description: 'Craft sticks before making torches',
        tool: 'craftRecipe',
        params: { recipe_name: 'stick', num: 1 },
      })
      shadow.oak_planks = Math.max(0, (shadow.oak_planks ?? 0) - 2)
      shadow.stick = (shadow.stick ?? 0) + 4
    }

    steps.push({
      description: 'Craft torches from the new charcoal',
      tool: 'craftRecipe',
      params: { recipe_name: 'torch', num: 1 },
    })

    return steps
  }

  private buildStructuredShelterPlan(goal: string, availableActionNames: Set<string>): PlanStep[] {
    if (!this.isShelterGoalText(goal)) {
      return []
    }

    const canMoveAway = availableActionNames.has('moveAway')
    const canPlace = availableActionNames.has('placeHere')
    if (!canMoveAway && !canPlace) {
      return []
    }

    const shadow = this.getStructuredInventoryShadow()
    const solidBlock = this.selectShelterSolidBlock(shadow)
    const hasTorch = (shadow.torch ?? 0) > 0
    const steps: PlanStep[] = []

    if (canMoveAway) {
      steps.push({
        description: 'Retreat to a clearer patch before shelter placement',
        tool: 'moveAway',
        params: { distance: 12 },
      })
    }

    if (canPlace && solidBlock) {
      steps.push({
        description: 'Place a solid block to start a temporary shelter wall',
        tool: 'placeHere',
        params: { type: solidBlock },
      })
    }

    if (canPlace && hasTorch) {
      steps.push({
        description: 'Place a carried light source for a temporary shelter anchor',
        tool: 'placeHere',
        params: { type: 'torch' },
      })
    }

    return steps
  }

  private selectShelterSolidBlock(shadow: StructuredInventoryShadow): string | null {
    const blockCandidates = [
      'cobblestone',
      'dirt',
      'oak_planks',
      'spruce_planks',
      'birch_planks',
      'jungle_planks',
      'acacia_planks',
      'dark_oak_planks',
      'mangrove_planks',
      'cherry_planks',
      'oak_log',
      'spruce_log',
      'birch_log',
      'jungle_log',
      'acacia_log',
      'dark_oak_log',
      'mangrove_log',
      'cherry_log',
    ]

    return blockCandidates.find(itemName => (shadow[itemName] ?? 0) > 0) ?? null
  }

  private getStructuredInventoryShadow(): StructuredInventoryShadow {
    const inventory = this.bot ? getInventoryCounts(this.bot as any) : {}
    const countMatching = (predicate: (itemName: string) => boolean): number =>
      Object.entries(inventory)
        .filter(([itemName, count]) => count > 0 && predicate(itemName))
        .reduce((sum, [, count]) => sum + count, 0)

    return {
      ...inventory,
      log: countMatching(itemName => /_log$|_wood$|_stem$|_hyphae$/u.test(itemName)),
      oak_planks: countMatching(itemName => itemName === 'planks' || itemName.endsWith('_planks')),
      stick: inventory.stick ?? 0,
      cobblestone: inventory.cobblestone ?? 0,
      raw_iron: (inventory.raw_iron ?? 0) + (inventory.iron_ore ?? 0) + (inventory.deepslate_iron_ore ?? 0),
      iron_ingot: inventory.iron_ingot ?? 0,
      coal: (inventory.coal ?? 0) + (inventory.charcoal ?? 0),
      crafting_table: (inventory.crafting_table ?? 0) + (this.hasReachableCraftingTable() ? 1 : 0),
      furnace: inventory.furnace ?? 0,
      torch: inventory.torch ?? 0,
      food: countMatching(itemName => isFoodItemName(itemName)),
      sword: countMatching(itemName => itemName.endsWith('_sword')),
      wooden_pickaxe: inventory.wooden_pickaxe ?? 0,
      stone_pickaxe: inventory.stone_pickaxe ?? 0,
      iron_pickaxe: inventory.iron_pickaxe ?? 0,
      wooden_axe: inventory.wooden_axe ?? 0,
      stone_axe: inventory.stone_axe ?? 0,
      iron_axe: inventory.iron_axe ?? 0,
      shield: inventory.shield ?? 0,
    }
  }

  private hasNearbyCraftingTableAccess(): boolean {
    if (!this.bot) {
      return false
    }

    try {
      const recentCraftingTable = getLastPlacedCraftingTableRecord(this.bot as any)
      if (
        recentCraftingTable
        && this.isPositionWithinInteractionDistance(recentCraftingTable, PLACED_WORKSTATION_INTERACTION_DISTANCE)
      ) {
        return true
      }

      const craftingTable = getNearestBlock(this.bot as any, 'crafting_table', 6)
      return this.isPlacedBlockWithinInteractionDistance(craftingTable, PLACED_WORKSTATION_INTERACTION_DISTANCE)
    }
    catch {
      return false
    }
  }

  private hasReachableCraftingTable(): boolean {
    if (this.hasNearbyCraftingTableAccess()) {
      return true
    }

    const block = this.getNearestVisibleWorkstationBlock('crafting_table', REACHABLE_WORKSTATION_SCAN_DISTANCE)
    if (!block?.position || !this.bot?.bot?.entity?.position) {
      return false
    }

    const verticalDistance = Math.abs(block.position.y - this.bot.bot.entity.position.y)
    return verticalDistance <= REACHABLE_WORKSTATION_VERTICAL_DISTANCE
  }

  private isPlacedBlockWithinInteractionDistance(
    block: { position?: { x: number, y: number, z: number } } | null | undefined,
    maxDistance: number,
  ): boolean {
    const playerPosition = this.bot?.bot?.entity?.position
    const blockPosition = block?.position
    if (!playerPosition || !blockPosition) {
      return false
    }

    return this.isPositionWithinInteractionDistance(blockPosition, maxDistance)
  }

  private isPositionWithinInteractionDistance(
    blockPosition: { x: number, y: number, z: number },
    maxDistance: number,
  ): boolean {
    const playerPosition = this.bot?.bot?.entity?.position
    if (!playerPosition) {
      return false
    }

    const dx = playerPosition.x - blockPosition.x
    const dy = playerPosition.y - blockPosition.y
    const dz = playerPosition.z - blockPosition.z
    return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz)) <= maxDistance
  }

  private buildSurfaceFirstFoodRecoverySteps(availableActionNames: Set<string>): PlanStep[] {
    if (!this.isLikelyUndergroundSurfaceRecoveryContext()) {
      return []
    }

    const steps = this.buildStructuredSurfaceRecoveryPlan('Escape to the surface', availableActionNames)
    if (steps.length === 0) {
      return []
    }

    if (availableActionNames.has('searchForEntity')) {
      steps.push({
        description: 'Search for nearby animals once the bot reaches open terrain',
        tool: 'searchForEntity',
        params: { type: 'animal', search_range: 96 },
      })
    }

    if (availableActionNames.has('attack')) {
      steps.push({
        description: 'Hunt a nearby animal after breaking back onto the surface',
        tool: 'attack',
        params: { type: 'animal' },
      })
    }

    return steps
  }

  private buildSurfaceFirstWoodRecoverySteps(availableActionNames: Set<string>): PlanStep[] {
    if (!this.isLikelyUndergroundSurfaceRecoveryContext()) {
      return []
    }

    const steps = this.buildStructuredSurfaceRecoveryPlan('Escape to the surface', availableActionNames)
    return steps
  }

  private shouldPrepareSwordBeforeFoodHunt(
    availableActionNames: Set<string>,
    shadow: StructuredInventoryShadow,
  ): boolean {
    if (!availableActionNames.has('craftRecipe')) {
      return false
    }

    if (this.countStructuredShadowItem(shadow, 'sword') > 0 || this.hasToolInInventory('sword')) {
      return false
    }

    const hasCraftingAccess = this.hasNearbyCraftingTableAccess()
      || this.countStructuredShadowItem(shadow, 'crafting_table') > 0
    const hasWoodInputs = this.countStructuredShadowItem(shadow, 'log') > 0
      || this.countStructuredShadowItem(shadow, 'oak_planks') > 0
    const hasStoneInputs = hasCraftingAccess
      && this.countStructuredShadowItem(shadow, 'cobblestone') >= 2
      && this.countStructuredShadowItem(shadow, 'stick') >= 1

    return hasWoodInputs || hasStoneInputs
  }

  private hasNearbyFurnaceAccess(): boolean {
    if (!this.bot) {
      return false
    }

    try {
      const furnace = getNearestBlock(this.bot as any, 'furnace', 6)
      return this.isPlacedBlockWithinInteractionDistance(furnace, PLACED_WORKSTATION_INTERACTION_DISTANCE)
    }
    catch {
      return false
    }
  }

  private extractPreferredLogSource(goal: string): string | null {
    const normalizedGoal = goal.toLowerCase()
    if (/\boak logs?\b/u.test(normalizedGoal)) {
      return 'oak_log'
    }
    if (/\bbirch logs?\b/u.test(normalizedGoal)) {
      return 'birch_log'
    }
    if (/\bspruce logs?\b/u.test(normalizedGoal)) {
      return 'spruce_log'
    }
    if (/\bjungle logs?\b/u.test(normalizedGoal)) {
      return 'jungle_log'
    }
    if (/\bacacia logs?\b/u.test(normalizedGoal)) {
      return 'acacia_log'
    }
    if (/\bdark oak logs?\b/u.test(normalizedGoal)) {
      return 'dark_oak_log'
    }
    if (/\bmangrove logs?\b/u.test(normalizedGoal)) {
      return 'mangrove_log'
    }
    if (/\bcherry logs?\b/u.test(normalizedGoal)) {
      return 'cherry_log'
    }

    return null
  }

  private logSourceToPlankRecipe(logSource: string | null): string {
    if (!logSource) {
      return 'oak_planks'
    }

    const normalized = this.normalizeCraftRecipeAlias(logSource)
    if (normalized.endsWith('_log')) {
      return normalized.replace(/_log$/u, '_planks')
    }
    if (normalized.endsWith('_wood')) {
      return normalized.replace(/_wood$/u, '_planks')
    }
    if (normalized.endsWith('_stem')) {
      return normalized.replace(/_stem$/u, '_planks')
    }
    if (normalized.endsWith('_hyphae')) {
      return normalized.replace(/_hyphae$/u, '_planks')
    }
    return 'oak_planks'
  }

  private selectInventoryLogSource(preferredItem: string | null): string | null {
    const inventory = this.bot ? getInventoryCounts(this.bot as any) : {}
    if (preferredItem && (inventory[preferredItem] ?? 0) > 0) {
      return preferredItem
    }

    return Object.entries(inventory)
      .filter(([itemName, count]) => count > 0 && /_log$|_wood$|_stem$|_hyphae$/u.test(itemName))
      .sort((left, right) => right[1] - left[1])
      .map(([itemName]) => itemName)[0] ?? null
  }

  private isCharcoalSourceItemName(itemName: string): boolean {
    const normalized = this.normalizeCraftRecipeAlias(itemName)
    return normalized === 'log'
      || /_log$|_wood$|_stem$|_hyphae$/u.test(normalized)
  }

  private countStructuredShadowItem(shadow: StructuredInventoryShadow, itemName: string): number {
    const normalized = this.normalizeCraftRecipeAlias(itemName)
    switch (normalized) {
      case 'oak_log':
      case 'log':
        return shadow.log ?? 0
      case 'oak_planks':
      case 'planks':
        return shadow.oak_planks ?? 0
      case 'coal':
        return shadow.coal ?? 0
      case 'food':
        return shadow.food ?? 0
      case 'sword':
        return shadow.sword ?? 0
      default:
        return shadow[normalized] ?? 0
    }
  }

  private addStructuredShadowItem(shadow: StructuredInventoryShadow, itemName: string, amount: number): void {
    if (amount <= 0) {
      return
    }

    const normalized = this.normalizeCraftRecipeAlias(itemName)
    switch (normalized) {
      case 'oak_log':
      case 'log':
        shadow.log = (shadow.log ?? 0) + amount
        return
      case 'oak_planks':
      case 'planks':
        shadow.oak_planks = (shadow.oak_planks ?? 0) + amount
        return
      case 'coal':
        shadow.coal = (shadow.coal ?? 0) + amount
        return
      default:
        shadow[normalized] = (shadow[normalized] ?? 0) + amount
    }
  }

  private consumeStructuredShadowItem(shadow: StructuredInventoryShadow, itemName: string, amount: number): void {
    if (amount <= 0) {
      return
    }

    const normalized = this.normalizeCraftRecipeAlias(itemName)
    switch (normalized) {
      case 'oak_log':
      case 'log':
        shadow.log = Math.max(0, (shadow.log ?? 0) - amount)
        return
      case 'oak_planks':
      case 'planks':
        shadow.oak_planks = Math.max(0, (shadow.oak_planks ?? 0) - amount)
        return
      case 'coal':
        shadow.coal = Math.max(0, (shadow.coal ?? 0) - amount)
        return
      default:
        shadow[normalized] = Math.max(0, (shadow[normalized] ?? 0) - amount)
    }
  }

  private getMissingGoalItemDeficits(
    inventory: Record<string, number>,
    targetItems: Array<{ item: string, minCount: number }>,
    plan?: Plan,
    snapshot?: CanonicalInventorySnapshot | null,
  ): Array<{ item: string, minCount: number, currentCount: number, missingCount: number }> {
    return targetItems
      .map((target) => {
        const observedCount = this.countInventoryForGoalTarget(inventory, target.item, plan, snapshot)
        const currentCount = observedCount < target.minCount && this.hasRecentCraftSyncMismatchForGoalTarget(target.item)
          ? target.minCount
          : observedCount
        return {
          item: target.item,
          minCount: target.minCount,
          currentCount,
          missingCount: Math.max(0, target.minCount - currentCount),
        }
      })
      .filter(target => target.missingCount > 0)
  }

  private formatGoalItemDeficits(
    deficits: Array<{ item: string, missingCount: number }>,
  ): string[] {
    return deficits.map(target => target.missingCount > 1 ? `${target.item} x${target.missingCount}` : target.item)
  }

  private buildVerificationGoalFromDeficits(
    deficits: Array<{ item: string, missingCount: number }>,
  ): string | null {
    if (deficits.length === 0) {
      return null
    }

    const phrases = deficits
      .map(({ item, missingCount }) => {
        switch (item) {
          case 'crafting_table':
            return 'Craft a crafting table'
          case 'wooden_pickaxe':
            return `Craft ${Math.max(1, missingCount)} wooden pickaxe`
          case 'stone_pickaxe':
            return `Craft ${Math.max(1, missingCount)} stone pickaxe`
          case 'iron_pickaxe':
            return `Craft ${Math.max(1, missingCount)} iron pickaxe`
          case 'diamond_pickaxe':
            return `Craft ${Math.max(1, missingCount)} diamond pickaxe`
          case 'wooden_axe':
            return `Craft ${Math.max(1, missingCount)} wooden axe`
          case 'furnace':
            return `Craft ${Math.max(1, missingCount)} furnace`
          case 'shield':
            return `Craft ${Math.max(1, missingCount)} shield`
          case 'wooden_sword':
            return `Craft ${Math.max(1, missingCount)} wooden sword`
          case 'stone_sword':
            return `Craft ${Math.max(1, missingCount)} stone sword`
          case 'iron_sword':
            return `Craft ${Math.max(1, missingCount)} iron sword`
          case 'diamond_helmet':
            return `Craft ${Math.max(1, missingCount)} diamond helmet`
          case 'diamond_chestplate':
            return `Craft ${Math.max(1, missingCount)} diamond chestplate`
          case 'diamond_leggings':
            return `Craft ${Math.max(1, missingCount)} diamond leggings`
          case 'diamond_boots':
            return `Craft ${Math.max(1, missingCount)} diamond boots`
          case 'sword':
            return `Craft ${Math.max(1, missingCount)} sword`
          case 'stick':
            return `Craft ${Math.max(1, missingCount)} sticks`
          case 'torch':
            return `Craft ${Math.max(1, missingCount)} torches`
          case 'iron_ingot':
            return `Smelt ${Math.max(1, missingCount)} iron ingot`
          case 'cobblestone':
            return `Mine ${Math.max(1, missingCount)} cobblestone`
          case 'iron_ore':
            return `Mine ${Math.max(1, missingCount)} iron ore`
          case 'coal_ore':
            return `Mine ${Math.max(1, missingCount)} coal ore`
          case 'food':
            return 'Collect nearby food'
          case 'log':
            return `Collect ${Math.max(1, missingCount)} logs`
          default:
            if (item.endsWith('_log')) {
              return `Collect ${Math.max(1, missingCount)} ${item.replace(/_/g, ' ')}`
            }
            return `Get ${Math.max(1, missingCount)} ${item.replace(/_/g, ' ')}`
        }
      })
      .filter(Boolean)

    return phrases.length > 0 ? phrases.join(' and ') : null
  }

  private countInventoryForGoalTarget(
    inventory: Record<string, number>,
    targetItem: string,
    plan?: Plan,
    snapshot?: CanonicalInventorySnapshot | null,
  ): number {
    const sumMatching = (predicate: (itemName: string) => boolean): number =>
      Object.entries(inventory)
        .filter(([itemName, count]) => count > 0 && predicate(itemName))
        .reduce((sum, [, count]) => sum + count, 0)
    const countSnapshotMatching = (predicate: (itemName: string) => boolean): number =>
      snapshot
        ? Object.values(snapshot.groupedStacks)
            .filter(group => group.totalCount > 0 && predicate(group.itemName))
            .reduce((sum, group) => sum + group.totalCount, 0)
        : 0
    const groupedSnapshotCount = (itemName: string): number =>
      snapshot?.groupedStacks[this.normalizeCraftRecipeAlias(itemName)]?.totalCount ?? 0
    const actualCount = (itemName: string): number =>
      this.bot ? getActualItemCount(this.bot as any, itemName) : 0
    const armorEquipped = (itemName: string): number =>
      snapshot?.armor.some(slot => slot.itemName === itemName) ? 1 : 0
    const offhandEquipped = (itemName: string): number =>
      snapshot?.offhand?.itemName === itemName ? 1 : 0

    switch (targetItem) {
      case 'food':
        return Math.max(
          sumMatching(itemName => isFoodItemName(itemName)),
          countSnapshotMatching(itemName => isFoodItemName(itemName)),
        )
      case 'sword':
        return Math.max(
          sumMatching(itemName => itemName.endsWith('_sword')),
          countSnapshotMatching(itemName => itemName.endsWith('_sword')),
          actualCount('sword'),
        )
      case 'iron_ore':
        return Math.max(
          (inventory.iron_ore ?? 0)
          + (inventory.deepslate_iron_ore ?? 0)
          + (inventory.raw_iron ?? 0)
          + (inventory.iron_ingot ?? 0),
          countSnapshotMatching(itemName =>
            itemName === 'iron_ore'
            || itemName === 'deepslate_iron_ore'
            || itemName === 'raw_iron'
            || itemName === 'iron_ingot',
          ),
        )
      case 'coal_ore':
        return Math.max(
          (inventory.coal_ore ?? 0)
          + (inventory.deepslate_coal_ore ?? 0)
          + (inventory.coal ?? 0)
          + (inventory.charcoal ?? 0),
          countSnapshotMatching(itemName =>
            itemName === 'coal_ore'
            || itemName === 'deepslate_coal_ore'
            || itemName === 'coal'
            || itemName === 'charcoal',
          ),
        )
      case 'log':
        return Math.max(
          sumMatching(itemName => /_log$|_wood$|_stem$|_hyphae$/u.test(itemName)),
          countSnapshotMatching(itemName => /_log$|_wood$|_stem$|_hyphae$/u.test(itemName)),
        )
      case 'crafting_table':
        return Math.max(
          inventory.crafting_table ?? 0,
          groupedSnapshotCount('crafting_table'),
          actualCount('crafting_table'),
          this.hasNearbyCraftingTableAccess() ? 1 : 0,
        )
      case 'furnace':
        return Math.max(
          inventory.furnace ?? 0,
          groupedSnapshotCount('furnace'),
          actualCount('furnace'),
          this.hasNearbyFurnaceAccess() ? 1 : 0,
        )
      case 'shield':
        return Math.max(
          inventory.shield ?? 0,
          groupedSnapshotCount('shield'),
          actualCount('shield'),
          offhandEquipped('shield'),
        )
      case 'diamond_helmet':
      case 'diamond_chestplate':
      case 'diamond_leggings':
      case 'diamond_boots':
        return Math.max(
          inventory[targetItem] ?? 0,
          groupedSnapshotCount(targetItem),
          armorEquipped(targetItem),
        )
      default:
        if (targetItem.endsWith('_log') && this.planCollectsGenericLogs(plan)) {
          return Math.max(
            sumMatching(itemName => /_log$|_wood$|_stem$|_hyphae$/u.test(itemName)),
            countSnapshotMatching(itemName => /_log$|_wood$|_stem$|_hyphae$/u.test(itemName)),
          )
        }
        return Math.max(
          inventory[targetItem] ?? 0,
          groupedSnapshotCount(targetItem),
          actualCount(targetItem),
        )
    }
  }

  private hasRecentCraftSyncMismatchForGoalTarget(targetItem: string): boolean {
    if (!this.bot) {
      return false
    }

    const diagnostic = getLastCraftRecipeDiagnostic(this.bot as any)
    if (!diagnostic || diagnostic.kind !== 'inventory_sync_mismatch') {
      return false
    }

    if (Date.now() - diagnostic.at > GOAL_VERIFICATION_CRAFT_SYNC_TTL_MS) {
      return false
    }

    const normalizedTarget = this.normalizeCraftRecipeAlias(targetItem)
    const normalizedDiagnostic = this.normalizeCraftRecipeAlias(diagnostic.itemName)
    if (normalizedTarget === normalizedDiagnostic) {
      return true
    }

    if (normalizedTarget === 'sword') {
      return normalizedDiagnostic.endsWith('_sword')
    }

    if (normalizedTarget === 'shield') {
      return normalizedDiagnostic === 'shield'
    }

    return false
  }

  private planCollectsGenericLogs(plan?: Plan): boolean {
    return Boolean(plan?.steps.some(step =>
      (step.tool === 'collectBlocks' || step.tool === 'searchForBlock')
      && String(step.params.type || '').trim().toLowerCase() === 'log',
    ))
  }

  private extractGoalTargetRequirements(goal: string): Array<{ item: string, minCount: number }> {
    const normalizedGoal = goal.toLowerCase()
    const normalizedGoalText = normalizedGoal.replace(/_/g, ' ')
    const targets: Array<{ item: string, minCount: number }> = []
    const includesWord = (word: string): boolean => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`\\b${escaped}\\b`, 'u').test(normalizedGoalText)
    }
    const mentionsVerbAndToken = (verbs: string[], token: string): boolean =>
      verbs.some(verb => includesWord(verb))
      && normalizedGoalText.includes(token)
    const compactGoal = goal.replace(/\s+/g, '')
    const mentionsExplicitJapaneseWoodResource = goal.includes('木材')
      || goal.includes('原木')
      || goal.includes('丸太')
      || goal.includes('伐採')
      || /(?:近くの|周囲の|付近の)?木(?!材|製|の(?:道具|ツルハシ|斧|剣))[をがの]?(?:入手|集め|取る|採る|伐採|切る|切って|確保|回収)/u.test(compactGoal)
      || (
        /(?:近くの|周囲の|付近の)木(?!材|製|の(?:道具|ツルハシ|斧|剣))/u.test(compactGoal)
        && /入手|集め|取る|採る|伐採|切る|切って|確保|回収/u.test(compactGoal)
      )
    const push = (item: string, minCount = 1): void => {
      const normalizedItem = item.trim()
      if (!normalizedItem) {
        return
      }

      const existing = targets.find(target => target.item === normalizedItem)
      if (existing) {
        existing.minCount = Math.max(existing.minCount, Math.max(1, minCount))
        return
      }

      targets.push({
        item: normalizedItem,
        minCount: Math.max(1, minCount),
      })
    }
    const extractCount = (pattern: RegExp): number => {
      const match = normalizedGoalText.match(pattern)
      const parsed = Number.parseInt(match?.[1] || '', 10)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
    }
    if (/\bcraft (?:a |an )?(?:basic )?wooden tool(?: |_)?set\b/u.test(normalizedGoalText) || /\bcraft wooden tools\b/u.test(normalizedGoalText)) {
      push('wooden_pickaxe')
      push('wooden_axe')
    }
    if (
      goal.includes('木製ツール')
      || goal.includes('木製のツール')
      || goal.includes('木製の道具')
      || goal.includes('木の道具')
      || goal.includes('基本ツール')
      || goal.includes('基本的なツール')
    ) {
      push('wooden_pickaxe')
      push('wooden_axe')
    }

    if (/\bcraft (?:a |an )?crafting table\b/u.test(normalizedGoalText) || goal.includes('作業台')) {
      push('crafting_table')
    }
    if (/\bcraft (?:a |an )?wooden pickaxe\b/u.test(normalizedGoalText) || goal.includes('木のツルハシ')) {
      push('wooden_pickaxe')
    }
    if (
      !/\b(?:wooden|stone|iron|gold(?:en)?|diamond|netherite) pickaxe\b/u.test(normalizedGoalText)
      && /\b(?:craft|make|create|prepare) (?:a |an )?(?:basic )?pickaxe\b/u.test(normalizedGoalText)
    ) {
      push('wooden_pickaxe')
    }
    if (/\bcraft (?:a |an )?stone pickaxe\b/u.test(normalizedGoalText) || goal.includes('石のツルハシ')) {
      push('stone_pickaxe')
    }
    if (/\bcraft (?:a |an )?iron pickaxe\b/u.test(normalizedGoalText) || goal.includes('鉄のツルハシ')) {
      push('iron_pickaxe')
    }
    if (/\bcraft (?:a |an )?diamond pickaxe\b/u.test(normalizedGoalText) || goal.includes('ダイヤのツルハシ')) {
      push('diamond_pickaxe')
    }
    if (/\bcraft (?:a |an )?diamond helmet\b/u.test(normalizedGoalText) || goal.includes('ダイヤのヘルメット')) {
      push('diamond_helmet')
    }
    if (/\bcraft (?:a |an )?diamond chestplate\b/u.test(normalizedGoalText) || goal.includes('ダイヤのチェストプレート')) {
      push('diamond_chestplate')
    }
    if (/\bcraft (?:a |an )?diamond leggings\b/u.test(normalizedGoalText) || goal.includes('ダイヤのレギンス')) {
      push('diamond_leggings')
    }
    if (/\bcraft (?:a |an )?diamond boots\b/u.test(normalizedGoalText) || goal.includes('ダイヤのブーツ')) {
      push('diamond_boots')
    }
    if (/\bfull diamond armor\b/u.test(normalizedGoalText) || /\bdiamond armor set\b/u.test(normalizedGoalText) || goal.includes('ダイヤフル装備') || goal.includes('ダイヤ防具一式')) {
      push('diamond_chestplate')
      push('diamond_leggings')
      push('diamond_helmet')
      push('diamond_boots')
    }
    if (/\bcraft (?:a |an )?wooden axe\b/u.test(normalizedGoalText) || goal.includes('木の斧')) {
      push('wooden_axe')
    }
    const mentionsSpecificSwordGoal = [
      { item: 'wooden_sword', pattern: /\b(?:craft|make|create|prepare) (?:a |an )?wooden swords?\b/u, japanese: ['木の剣'] },
      { item: 'stone_sword', pattern: /\b(?:craft|make|create|prepare) (?:a |an )?stone swords?\b/u, japanese: ['石の剣'] },
      { item: 'iron_sword', pattern: /\b(?:craft|make|create|prepare) (?:a |an )?iron swords?\b/u, japanese: ['鉄の剣'] },
    ].some(({ item, pattern, japanese }) => {
      if (pattern.test(normalizedGoalText) || japanese.some(token => goal.includes(token))) {
        push(item)
        return true
      }
      return false
    })

    const isPrepareSuppliesGoal = /\bprepare supplies\b/u.test(normalizedGoalText)
      || /\bprepare .*supplies\b/u.test(normalizedGoalText)
      || goal.includes('物資')
      || goal.includes('準備')

    if (
      !mentionsSpecificSwordGoal
      && (
        /\b(?:craft|make|create|prepare) (?:a |an )?swords?\b/u.test(normalizedGoalText)
        || (isPrepareSuppliesGoal && /\bswords?\b/u.test(normalizedGoalText))
        || goal.includes('剣')
      )
    ) {
      push('sword')
    }
    const furnaceIndex = normalizedGoalText.indexOf('furnace')
    const placeFurnaceGoal = /\bplace (?:a |an |the )?furnace\b/u.test(normalizedGoalText)
    const craftVerbBeforeFurnace = furnaceIndex >= 0
      && /\b(?:craft|make|create|build|prepare)\b/u.test(normalizedGoalText.slice(0, furnaceIndex))
    if (
      (craftVerbBeforeFurnace && !placeFurnaceGoal)
      || /\b(?:craft|make|create|build|prepare) (?:a |an |the )?furnace\b/u.test(normalizedGoalText)
      || goal.includes('かまどを作')
    ) {
      push('furnace')
    }
    if (/\bcraft (?:a |an )?shield\b/u.test(normalizedGoalText) || goal.includes('盾')) {
      push('shield')
    }
    if (/\b(?:craft|make|create) (?:a |an )?sticks?\b/u.test(normalizedGoalText) || goal.includes('棒')) {
      push('stick', extractCount(/(\d+)\s+sticks?/u))
    }
    if (
      /\b(?:craft|make|create) (?:a |an )?torches?\b/u.test(normalizedGoalText)
      || (isPrepareSuppliesGoal && /\btorches?\b/u.test(normalizedGoalText))
      || goal.includes('松明')
    ) {
      push('torch', extractCount(/(\d+)\s+torches?/u))
    }
    const activeSmeltIronGoal = /\bsmelt(?:ing)?\s+(?:the\s+)?(?:raw\s+)?iron\b/u.test(normalizedGoalText)
      && !/\bprepare\s+(?:for|to)\s+smelt(?:ing)?\s+(?:the\s+)?(?:raw\s+)?iron\b/u.test(normalizedGoalText)
    if (activeSmeltIronGoal || /\biron ingots?\b/u.test(normalizedGoalText) || goal.includes('鉄インゴット')) {
      push('iron_ingot')
    }
    if (mentionsVerbAndToken(['mine', 'collect', 'get', 'gather'], 'cobblestone')) {
      push('cobblestone', extractCount(/(\d+)\s+cobblestone/u))
    }
    if (mentionsVerbAndToken(['mine', 'collect', 'get', 'gather'], 'iron ore') || goal.includes('鉄鉱石')) {
      push('iron_ore', extractCount(/(\d+)\s+iron ore/u))
    }
    if (mentionsVerbAndToken(['mine', 'collect', 'get', 'gather'], 'coal ore') || goal.includes('石炭')) {
      push('coal_ore', extractCount(/(\d+)\s+coal ore/u))
    }
    if (
      mentionsVerbAndToken(['collect', 'get', 'gather', 'find', 'prepare', 'secure', 'consume', 'eat'], 'food')
      || normalizedGoal.includes('nearby food')
      || normalizedGoal.includes('available food')
      || normalizedGoal.includes('food,')
      || normalizedGoal.includes('food)')
      || normalizedGoal.includes('hunger')
      || goal.includes('食料')
      || goal.includes('食べ')
      || goal.includes('空腹')
    ) {
      push('food')
    }
    if (/\bbirch logs?\b/u.test(normalizedGoalText)) {
      push('birch_log', extractCount(/(\d+)\s+birch logs?/u))
    }
    else if (/\boak logs?\b/u.test(normalizedGoalText)) {
      push('oak_log', extractCount(/(\d+)\s+oak logs?/u))
    }
    else if (/\bspruce logs?\b/u.test(normalizedGoalText)) {
      push('spruce_log', extractCount(/(\d+)\s+spruce logs?/u))
    }
    else if (
      mentionsVerbAndToken(['collect', 'get', 'gather', 'find', 'chop', 'harvest'], 'log')
      || mentionsVerbAndToken(['collect', 'get', 'gather', 'find', 'chop', 'harvest'], 'wood')
      || mentionsExplicitJapaneseWoodResource
    ) {
      push('log', extractCount(/(\d+)\s+(?:logs?|wood)/u))
    }

    const hasCraftOutcome = targets.some(target => [
      'crafting_table',
      'wooden_pickaxe',
      'stone_pickaxe',
      'iron_pickaxe',
      'diamond_pickaxe',
      'wooden_axe',
      'wooden_sword',
      'stone_sword',
      'iron_sword',
      'diamond_helmet',
      'diamond_chestplate',
      'diamond_leggings',
      'diamond_boots',
      'sword',
      'stick',
      'furnace',
      'shield',
      'torch',
      'iron_ingot',
    ].includes(target.item))

    return hasCraftOutcome && !mentionsExplicitJapaneseWoodResource
      ? targets.filter(target => target.item !== 'log' && !target.item.endsWith('_log'))
      : targets
  }

  // private async generateStepsStream(
  //   goal: string,
  //   availableActions: Action[],
  //   sender: string,
  // ): Promise<void> {
  //   if (!this.context) {
  //     return
  //   }

  //   try {
  //     // Generate all steps at once
  //     const steps = await this.llmHandler.generatePlan(goal, availableActions, sender)
  //     if (!this.context.isGenerating) {
  //       return
  //     }

  //     // Add all steps to pending queue
  //     this.context.pendingSteps.push(...steps)
  //     this.logger.withField('steps', steps).log('Generated steps')
  //   }
  //   catch (error) {
  //     this.logger.withError(error).error('Failed to generate steps')
  //     throw error
  //   }
  //   finally {
  //     this.context.isGenerating = false
  //   }
  // }

  // private async executeStepsStream(): Promise<void> {
  //   if (!this.context || !this.actionAgent) {
  //     return
  //   }

  //   try {
  //     while (this.context.isGenerating || this.context.pendingSteps.length > 0) {
  //       // Wait for steps to be available
  //       if (this.context.pendingSteps.length === 0) {
  //         await new Promise(resolve => setTimeout(resolve, 100))
  //         continue
  //       }

  //       // Execute next step
  //       const step = this.context.pendingSteps.shift()
  //       if (!step) {
  //         continue
  //       }

  //       try {
  //         this.logger.withField('step', step).log('Executing step')
  //         await this.actionAgent.performAction(step)
  //         this.context.lastUpdate = Date.now()
  //         this.context.currentStep++
  //       }
  //       catch (stepError) {
  //         this.logger.withError(stepError).error('Failed to execute step')

  //         // Attempt to adjust plan and retry
  //         if (this.context.retryCount < 3) {
  //           this.context.retryCount++
  //           // Stop current generation
  //           this.context.isGenerating = false
  //           this.context.pendingSteps = []
  //           // Adjust plan and restart
  //           const adjustedPlan = await this.adjustPlan(
  //             this.currentPlan!,
  //             stepError instanceof Error ? stepError.message : 'Unknown error',
  //             'system',
  //           )
  //           await this.executePlan(adjustedPlan)
  //           return
  //         }

  //         throw stepError
  //       }
  //     }
  //   }
  //   catch (error) {
  //     this.logger.withError(error).error('Failed to execute steps')
  //     throw error
  //   }
  // }

  // private async *createStepGenerator(
  //   goal: string,
  //   availableActions: Action[],
  // ): AsyncGenerator<PlanStep[], void, unknown> {
  //   // Use LLM to generate plan in chunks
  //   this.logger.log('Generating plan using LLM')
  //   const chunkSize = 3 // Generate 3 steps at a time
  //   let currentChunk = 1

  //   while (true) {
  //     const steps = await this.llmHandler.generatePlan(
  //       goal,
  //       availableActions,
  //       `Generate steps ${currentChunk * chunkSize - 2} to ${currentChunk * chunkSize}`,
  //     )

  //     if (steps.length === 0) {
  //       break
  //     }

  //     yield steps
  //     currentChunk++

  //     // Check if we've generated enough steps or if the goal is achieved
  //     if (steps.length < chunkSize || await this.isGoalAchieved(goal)) {
  //       break
  //     }
  //   }
  // }

  // private async isGoalAchieved(goal: string): Promise<boolean> {
  //   if (!this.context || !this.actionAgent) {
  //     return false
  //   }

  //   const requirements = this.parseGoalRequirements(goal)

  //   // Check inventory for required items
  //   if (requirements.needsItems && requirements.items) {
  //     const inventorySteps = this.generateGatheringSteps(requirements.items)
  //     if (inventorySteps.length > 0) {
  //       this.context.pendingSteps.push(...inventorySteps)
  //       return false
  //     }
  //   }

  //   // Check location requirements
  //   if (requirements.needsMovement && requirements.location) {
  //     const movementSteps = this.generateMovementSteps(requirements.location)
  //     if (movementSteps.length > 0) {
  //       this.context.pendingSteps.push(...movementSteps)
  //       return false
  //     }
  //   }

  //   // Check interaction requirements
  //   if (requirements.needsInteraction && requirements.target) {
  //     const interactionSteps = this.generateInteractionSteps(requirements.target)
  //     if (interactionSteps.length > 0) {
  //       this.context.pendingSteps.push(...interactionSteps)
  //       return false
  //     }
  //   }

  //   return true
  // }

  public async adjustPlan(plan: Plan, feedback: string, sender: string): Promise<Plan> {
    if (!this.initialized) {
      throw new Error('Planning agent not initialized')
    }

    this.logger.withFields({ plan, feedback }).log('Adjusting plan')
    monitorBus.emitMonitor('planning:adjusting', { goal: plan.goal, feedback })

    try {
      // If there's a current context, use it to adjust the plan
      if (this.context) {
        const currentStep = this.context.currentStep
        const feedbackKey = this.normalizeFailureFeedback(feedback)
        const repeatedFailures = (this.context.failureCounts[feedbackKey] ?? 0) + 1
        this.context.failureCounts[feedbackKey] = repeatedFailures
        const failedStep = plan.steps[currentStep]

        // Generate recovery steps based on feedback
        const recoverySteps = this.generateRecoverySteps(feedback, repeatedFailures, failedStep, plan.goal)
        const resumedSteps = this.buildResumedSteps(plan, currentStep, recoverySteps)

        if (this.shouldUseDeterministicRecovery(feedback, recoverySteps, repeatedFailures)) {
          return {
            goal: plan.goal,
            steps: this.filterBlockedSteps(plan.goal, resumedSteps, 'recovery'),
            status: 'pending',
            requiresAction: true,
          }
        }

        const availableActions = this.actionAgent?.getAvailableActions() ?? []

        // Generate new steps from the current point
        const newSteps = await this.generatePlanSteps(plan.goal, availableActions, sender, feedback)
        const actionableNewSteps = this.ensureActionableSteps(plan.goal, newSteps)

        // Create adjusted plan
        const adjustedPlan: Plan = {
          goal: plan.goal,
          steps: this.filterBlockedSteps(plan.goal, [
            ...resumedSteps,
            ...actionableNewSteps,
          ], 'llm'),
          status: 'pending',
          requiresAction: true,
        }

        return adjustedPlan
      }

      // If no context, create a new plan
      return this.createPlan(plan.goal)
    }
    catch (error) {
      this.logger.withError(error).error('Failed to adjust plan')
      throw error
    }
  }

  // private generateGatheringSteps(items: string[]): PlanStep[] {
  //   const steps: PlanStep[] = []

  //   for (const item of items) {
  //     steps.push(
  //       {
  //         description: `Search for ${item} in the surrounding area`,
  //         tool: 'searchForBlock',
  //         params: {
  //           blockType: item,
  //           range: 64,
  //         },
  //       },
  //       {
  //         description: `Collect ${item} from the found location`,
  //         tool: 'collectBlocks',
  //         params: {
  //           blockType: item,
  //           count: 1,
  //         },
  //       },
  //     )
  //   }

  //   return steps
  // }

  // private generateMovementSteps(location: { x?: number, y?: number, z?: number }): PlanStep[] {
  //   if (location.x !== undefined && location.y !== undefined && location.z !== undefined) {
  //     return [{
  //       description: `Move to coordinates (${location.x}, ${location.y}, ${location.z})`,
  //       tool: 'goToCoordinates',
  //       params: {
  //         x: location.x,
  //         y: location.y,
  //         z: location.z,
  //       },
  //     }]
  //   }
  //   return []
  // }

  // private generateInteractionSteps(target: string): PlanStep[] {
  //   return [{
  //     description: `Interact with ${target}`,
  //     tool: 'activate',
  //     params: {
  //       target,
  //     },
  //   }]
  // }

  private getUnsupportedCapabilityFallbackTarget(failedStep?: PlanStep): string | null {
    if (failedStep?.tool === 'craftRecipe' && typeof failedStep.params.recipe_name === 'string') {
      const recipeName = this.normalizeCraftRecipeAlias(failedStep.params.recipe_name)
      if (recipeName === 'crafting_table' || recipeName === 'wooden_pickaxe' || recipeName === 'stick') {
        return 'log'
      }
      if (recipeName === 'stone_pickaxe' || recipeName === 'furnace') {
        return 'cobblestone'
      }
      if (recipeName === 'torch') {
        return 'coal_ore'
      }
    }

    if (failedStep?.tool === 'smeltItem') {
      return 'coal_ore'
    }

    return null
  }

  private generateRecoverySteps(feedback: string, repeatedFailures = 1, failedStep?: PlanStep, goal = ''): PlanStep[] {
    const steps: PlanStep[] = []
    const normalizedFeedback = feedback.toLowerCase()
    const normalizedFailureKind = this.normalizeFailureFeedback(feedback)
    const moveDistance = repeatedFailures >= 4 ? 160 : repeatedFailures >= 3 ? 96 : repeatedFailures >= 2 ? 48 : 24
    const searchRange = repeatedFailures >= 4 ? 320 : repeatedFailures >= 3 ? 256 : repeatedFailures >= 2 ? 160 : 96
    const failedSearchTarget = typeof failedStep?.params.type === 'string'
      ? String(failedStep.params.type)
      : 'log'
    const failedSearchLabel = failedSearchTarget.replace(/_/g, ' ')

    if (normalizedFeedback.includes('ingredient_missing') && failedStep?.tool === 'craftRecipe') {
      return this.generateCraftIngredientRecoverySteps(
        this.normalizeCraftRecipeAlias(String(failedStep.params.recipe_name ?? '')),
        moveDistance,
        searchRange,
        repeatedFailures,
      )
    }

    if (
      normalizedFailureKind === 'failure:crafting-table-bootstrap'
      || (
        failedStep?.tool === 'craftRecipe'
        && typeof failedStep.params.recipe_name === 'string'
        && this.normalizeCraftRecipeAlias(failedStep.params.recipe_name) === 'crafting_table'
      )
    ) {
      return this.generateCraftingTableBootstrapSteps(moveDistance, searchRange, repeatedFailures)
    }

    if (
      normalizedFailureKind === 'failure:tool-bootstrap'
      || normalizedFeedback.includes('ensurepickaxe(')
      || normalizedFeedback.includes('ensureaxe(')
      || normalizedFeedback.includes('ensureshovel(')
    ) {
      return this.generateToolBootstrapSteps(moveDistance, searchRange, failedStep, repeatedFailures)
    }

    if (normalizedFailureKind === 'failure:unsupported_capability') {
      steps.push({
        description: 'Move to open ground before switching away from the blocked bridge capability path',
        tool: 'moveAway',
        params: {
          distance: Math.max(12, Math.floor(moveDistance / 2)),
        },
      })
      const fallbackTarget = this.getUnsupportedCapabilityFallbackTarget(failedStep)
      if (fallbackTarget) {
        steps.push(
          {
            description: `Search for ${failedSearchLabel === 'log' ? fallbackTarget.replace(/_/g, ' ') : fallbackTarget.replace(/_/g, ' ')} while the blocked command stays disabled`,
            tool: 'searchForBlock',
            params: {
              type: fallbackTarget,
              search_range: searchRange,
            },
          },
          {
            description: `Collect a small amount of ${fallbackTarget.replace(/_/g, ' ')} instead of retrying the blocked step`,
            tool: 'collectBlocks',
            params: {
              type: fallbackTarget,
              num: 1,
            },
          },
        )
      }
      return steps
    }

    if (normalizedFeedback.includes('searchforentity(') && normalizedFeedback.includes('failed')) {
      const surfaceFirstFoodRecoverySteps = this.buildSurfaceFirstFoodRecoverySteps(
        new Set((this.actionAgent?.getAvailableActions() ?? []).map(action => action.name)),
      )
      if (surfaceFirstFoodRecoverySteps.length > 0) {
        return surfaceFirstFoodRecoverySteps
      }
      steps.push({
        description: repeatedFailures >= 2
          ? 'Move to a meaningfully different area before re-evaluating food search'
          : 'Move a bit to re-scan mob spawn area',
        tool: 'moveAway',
        params: {
          distance: repeatedFailures >= 2 ? Math.max(32, moveDistance) : moveDistance,
        },
      })
      if (repeatedFailures < 2) {
        steps.push({
          description: 'Fallback to generic animal search',
          tool: 'searchForEntity',
          params: {
            type: 'animal',
            search_range: searchRange,
          },
        })
      }
      return steps
    }

    if (
      normalizedFailureKind === 'failure:placement-blocked'
      || (normalizedFeedback.includes('placehere(') && normalizedFeedback.includes('failed'))
    ) {
      steps.push({
        description: 'Move to a clearer patch before retrying placement',
        tool: 'moveAway',
        params: {
          distance: Math.max(8, Math.floor(moveDistance / 2)),
        },
      })
      return steps
    }

    if (
      normalizedFeedback.includes('smeltitem(')
      && (normalizedFeedback.includes('furnace screen did not open') || normalizedFeedback.includes('failed'))
    ) {
      const failedSmeltItem = typeof failedStep?.params.item_name === 'string'
        ? String(failedStep.params.item_name)
        : 'raw_iron'
      const failedSmeltCount = Math.max(1, Number(failedStep?.params.num ?? 1))
      const portableFurnaceCount = (() => {
        try {
          return this.bot ? (getInventoryCounts(this.bot as any).furnace ?? 0) : 0
        }
        catch {
          return 0
        }
      })()

      if (portableFurnaceCount > 0) {
        steps.push(
          {
            description: 'Move to a clearer patch before placing a fresh furnace',
            tool: 'moveAway',
            params: {
              distance: Math.max(12, Math.floor(moveDistance / 2)),
            },
          },
          {
            description: 'Place a fresh furnace before retrying smelting',
            tool: 'placeHere',
            params: {
              type: 'furnace',
            },
          },
          {
            description: 'Retry smelting with the freshly placed furnace',
            tool: 'smeltItem',
            params: {
              item_name: failedSmeltItem,
              num: failedSmeltCount,
            },
          },
        )
        return steps
      }

      steps.push({
        description: 'Refresh the nearby furnace target before retrying smelting',
        tool: 'searchForBlock',
        params: {
          type: 'furnace',
          search_range: 8,
        },
      })
      return steps
    }

    if (normalizedFeedback.includes('searchforblock(') && normalizedFeedback.includes('failed')) {
      steps.push(
        {
          description: 'Move away from blocked terrain and retry',
          tool: 'moveAway',
          params: {
            distance: moveDistance,
          },
        },
        {
          description: `Retry searching ${failedSearchLabel} in a wider area`,
          tool: 'searchForBlock',
          params: {
            type: failedSearchTarget,
            search_range: searchRange,
          },
        },
      )
      return steps
    }

    if (normalizedFeedback.includes('collectblocks') && normalizedFeedback.includes('failed')) {
      const failedCollectType = String(failedStep?.params.type ?? 'log')
      if (failedStep?.tool === 'collectBlocks' && failedStep.params.type === 'log') {
        return this.generateWoodRecoverySteps(moveDistance, searchRange, repeatedFailures)
      }
      if (
        failedStep?.tool === 'collectBlocks'
        && this.normalizeBlockTargetFamily(failedCollectType) === 'coal_ore'
      ) {
        const availableActionNames = new Set(
          (this.actionAgent?.getAvailableActions() ?? []).map(action => action.name),
        )
        const charcoalFallbackSteps = this.buildStructuredCoalViaCharcoalPlan(goal || 'coal_ore recovery', availableActionNames, {
          forceCoalTarget: true,
        })
        if (charcoalFallbackSteps.length > 0) {
          return charcoalFallbackSteps
        }
      }
      if (
        failedStep?.tool === 'collectBlocks'
        && this.requiresPickaxeBootstrap(failedCollectType)
        && !this.hasInventoryPickaxeForBlock(failedCollectType)
      ) {
        return this.generateToolBootstrapSteps(moveDistance, searchRange, failedStep, repeatedFailures)
      }

      if (failedStep?.tool === 'collectBlocks' && this.requiresPickaxeBootstrap(failedCollectType)) {
        steps.push({
          description: 'Reposition before retrying the stalled mining target',
          tool: 'moveAway',
          params: {
            distance: Math.max(16, Math.floor(moveDistance / 2)),
          },
        })
      }

      if (failedStep?.tool === 'collectBlocks' && this.normalizeBlockTargetFamily(failedCollectType) === 'stone') {
        steps.push({
          description: 'Retry a small stone mining probe without a blocking search',
          tool: 'collectBlocks',
          params: {
            type: failedCollectType,
            num: Math.max(1, Math.min(2, Number(failedStep?.params.num ?? 4))),
          },
        })
        return steps
      }

      steps.push(
        {
          description: 'Search blocks before collecting again',
          tool: 'searchForBlock',
          params: {
            type: failedCollectType,
            search_range: searchRange,
          },
        },
        {
          description: 'Collect a small amount first as a recovery probe',
          tool: 'collectBlocks',
          params: {
            type: failedCollectType,
            num: Math.max(1, Math.min(2, Number(failedStep?.params.num ?? 4))),
          },
        },
      )
      return steps
    }

    if (normalizedFeedback.includes('timed out')) {
      if (failedStep?.tool === 'collectBlocks' && failedStep.params.type === 'log') {
        return this.generateWoodRecoverySteps(moveDistance, searchRange, repeatedFailures)
      }
      if (
        failedStep?.tool === 'collectBlocks'
        && this.requiresPickaxeBootstrap(String(failedStep.params.type ?? ''))
        && !this.hasInventoryPickaxeForBlock(String(failedStep.params.type ?? ''))
      ) {
        return this.generateToolBootstrapSteps(moveDistance, searchRange, failedStep, repeatedFailures)
      }
    }

    if (feedback.includes('not found')) {
      steps.push({
        description: `Search for ${failedSearchLabel} in a wider area`,
        tool: 'searchForBlock',
        params: {
          type: failedSearchTarget,
          search_range: searchRange,
        },
      })
    }

    if (feedback.includes('inventory full')) {
      steps.push({
        description: 'Clear inventory space',
        tool: 'discard',
        params: {
          item_name: 'dirt',
          num: 1,
        },
      })
    }

    if (feedback.includes('blocked') || feedback.includes('cannot reach')) {
      steps.push({
        description: 'Move away from obstacles',
        tool: 'moveAway',
        params: {
          distance: moveDistance,
        },
      })
    }

    if (feedback.includes('too far')) {
      steps.push({
        description: 'Move closer to target',
        tool: 'moveAway',
        params: {
          distance: moveDistance,
        },
      })
    }

    if (feedback.includes('need tool')) {
      steps.push(
        {
          description: 'Craft a wooden pickaxe',
          tool: 'craftRecipe',
          params: {
            recipe_name: 'wooden_pickaxe',
            num: 1,
          },
        },
        {
          description: 'Equip the wooden pickaxe',
          tool: 'equip',
          params: {
            item_name: 'wooden_pickaxe',
          },
        },
      )
    }

    if (normalizedFeedback.includes('timeout') || normalizedFeedback.includes('took to long') || normalizedFeedback.includes('path was stopped')) {
      // On pathfinding failures, do a safe survey first then try a shorter move
      steps.push(
        {
          description: 'Survey nearby blocks to reset navigation state',
          tool: 'nearbyBlocks',
          params: {},
        },
        {
          description: 'Short reposition to clear pathfinding deadlock',
          tool: 'moveAway',
          params: {
            distance: Math.max(8, Math.floor(moveDistance / 2)),
          },
        },
      )
    }

    return steps
  }

  private shouldUseDeterministicRecovery(feedback: string, recoverySteps: PlanStep[], repeatedFailures = 1): boolean {
    if (recoverySteps.length === 0) {
      return false
    }

    const normalized = feedback.toLowerCase()
    const normalizedFailureKind = this.normalizeFailureFeedback(feedback)
    if (
      normalizedFailureKind === 'failure:crafting-table-bootstrap'
      || normalizedFailureKind === 'failure:tool-bootstrap'
      || normalized.includes('ensurepickaxe(')
      || normalized.includes('ensureaxe(')
      || normalized.includes('ensureshovel(')
      || normalized.includes('ensurecraftingtable')
    ) {
      return true
    }
    if (normalizedFailureKind === 'failure:unsupported_capability' || normalized.includes('unknown command')) {
      return true
    }
    if (normalizedFailureKind === 'failure:placement-blocked' || normalized.includes('placehere(')) {
      return true
    }
    if (normalized.includes('smeltitem(') && normalized.includes('furnace screen did not open')) {
      return true
    }
    if (normalized.includes('ingredient_missing')) {
      return true
    }
    if (repeatedFailures >= 2) {
      return true
    }
    if (normalized.includes('timeout') || normalized.includes('took to long')) {
      return true
    }
    if (normalized.includes('not found')) {
      return true
    }
    if (normalized.includes('failed') && (normalized.includes('searchfor') || normalized.includes('collectblocks') || normalized.includes('attack('))) {
      return true
    }

    return false
  }

  private normalizeFailureFeedback(feedback: string): string {
    const normalized = PlanningAgentImpl.normalizeRuntimeErrorMessage(feedback)

    if (
      normalized.includes('unknown command')
      || normalized.includes('unsupported_capability')
      || normalized.includes('bridge command unsupported')
      || normalized.includes('bridge capability blocked')
    ) {
      return 'failure:unsupported_capability'
    }

    if (
      normalized.includes('ensurecraftingtable')
    ) {
      return 'failure:crafting-table-bootstrap'
    }

    if (
      normalized.includes('ensurepickaxe(')
      || normalized.includes('ensureaxe(')
      || normalized.includes('ensureshovel(')
      || (normalized.includes('craftrecipe(') && (
        normalized.includes('wooden_pickaxe')
        || normalized.includes('stick')
        || normalized.includes('planks')
        || normalized.includes('crafting_table')
      ))
    ) {
      return 'failure:tool-bootstrap'
    }

    if (normalized.includes('collectblocks failed: log') || (normalized.includes('searchforblock(') && normalized.includes('log'))) {
      return 'failure:wood-search-or-collect'
    }

    if (
      normalized.includes('collectblocks failed: coal_ore')
      || normalized.includes('collectblocks failed: iron_ore')
      || normalized.includes('collectblocks failed: cobblestone')
      || normalized.includes('collectblocks failed: stone')
      || (normalized.includes('craftrecipe(') && (
        normalized.includes('stone_pickaxe')
        || normalized.includes('torch')
        || normalized.includes('furnace')
      ))
    ) {
      return 'failure:resource-bootstrap'
    }

    if (
      normalized.includes('searchforentity(')
      || normalized.includes('attack(')
      || normalized.includes('attackplayer(')
      || normalized.includes('combat progress')
    ) {
      return 'failure:combat-engagement'
    }

    if (
      normalized.includes('placehere(')
      || normalized.includes('failed to place')
      || normalized.includes('nothing to place on')
      || normalized.includes('block in the way')
    ) {
      return 'failure:placement-blocked'
    }

    if (normalized.includes('gotobed') || normalized.includes('sleep') || normalized.includes('bed')) {
      return 'failure:sleep-blocked'
    }

    if (
      normalized.includes('movement_stall')
      || normalized.includes('coordinate_stall')
      || normalized.includes('stuck-recovery')
      || normalized.includes('coordinates unchanged')
    ) {
      return 'failure:coordinate_stall'
    }

    if (normalized.includes('timed out') || normalized.includes('timeout') || normalized.includes('path was stopped')) {
      return 'failure:navigation-timeout'
    }

    return normalized
  }

  private classifyStepFailureClass(feedback: string): string {
    const normalized = this.normalizeFailureFeedback(feedback)
    return normalized.startsWith('failure:')
      ? normalized.slice('failure:'.length)
      : normalized
  }

  private buildResumedSteps(plan: Plan, currentStep: number, recoverySteps: PlanStep[]): PlanStep[] {
    const failedStep = plan.steps[currentStep]
    const remainingSteps = plan.steps
      .slice(currentStep + 1)
      .filter(step => !this.isStepInvalidatedByFailure(failedStep, step))

    if (!failedStep) {
      return [...recoverySteps, ...remainingSteps]
    }

    const recoveryFingerprints = new Set(recoverySteps.map(step => this.planStepFingerprint(step)))
    const failedFingerprint = this.planStepFingerprint(failedStep)
    const shouldKeepFailedStep = !recoveryFingerprints.has(failedFingerprint)
      && !this.isStepSupersededByRecovery(failedStep, recoverySteps)

    return shouldKeepFailedStep
      ? [...recoverySteps, failedStep, ...remainingSteps]
      : [...recoverySteps, ...remainingSteps]
  }

  private planStepFingerprint(step: PlanStep): string {
    const sortedEntries = Object.entries(step.params)
      .sort(([left], [right]) => left.localeCompare(right))
    return `${step.tool}:${JSON.stringify(sortedEntries)}`
  }

  private normalizeGoalKey(goal: string): string {
    return goal.trim().toLowerCase().replace(/\s+/g, ' ')
  }

  private normalizeEntityTargetFamily(rawType: unknown): string {
    const normalized = String(rawType ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
    if (!normalized) {
      return 'unknown'
    }

    if (['animal', 'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'cod', 'salmon', 'tropical_fish'].includes(normalized)) {
      return 'food-animal'
    }

    if (['villager', 'trader_llama', 'iron_golem'].includes(normalized)) {
      return 'villager'
    }

    return normalized
  }

  private normalizeBlockTargetFamily(rawType: unknown): string {
    const normalized = String(rawType ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
    if (!normalized) {
      return 'unknown'
    }

    if (['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'log'].includes(normalized)) {
      return 'log'
    }
    if (['stone', 'cobblestone', 'cobbled_deepslate'].includes(normalized)) {
      return 'stone'
    }
    if (['iron_ore', 'deepslate_iron_ore'].includes(normalized)) {
      return 'iron_ore'
    }
    if (['coal_ore', 'deepslate_coal_ore'].includes(normalized)) {
      return 'coal_ore'
    }
    return normalized
  }

  private planStepSuppressionFingerprint(step: PlanStep): string {
    const tool = step.tool.trim()
    const params = { ...step.params }

    if (tool === 'searchForEntity' || tool === 'attack') {
      return `${tool}:type=${this.normalizeEntityTargetFamily(params.type)}`
    }

    if (tool === 'searchForBlock' || tool === 'collectBlocks' || tool === 'placeHere') {
      return `${tool}:type=${this.normalizeBlockTargetFamily(params.type)}`
    }

    if (tool === 'craftRecipe' && typeof params.recipe_name === 'string') {
      return `${tool}:recipe=${this.normalizeCraftRecipeAlias(params.recipe_name)}`
    }

    if (tool === 'smeltItem' && typeof params.item_name === 'string') {
      return `${tool}:item=${this.normalizeCraftRecipeAlias(params.item_name)}`
    }

    if (tool === 'moveAway') {
      const distance = Number(params.distance)
      const bucket = Number.isFinite(distance)
        ? distance >= 96
          ? 'far'
          : distance >= 48
            ? 'medium'
            : 'short'
        : 'default'
      return `${tool}:distance=${bucket}`
    }

    return this.planStepFingerprint(step)
  }

  private isStepSupersededByRecovery(step: PlanStep, recoverySteps: PlanStep[]): boolean {
    if (step.tool === 'craftRecipe' && typeof step.params.recipe_name === 'string') {
      return recoverySteps.some(recoveryStep =>
        recoveryStep.tool === 'craftRecipe'
        && this.planStepSuppressionFingerprint(recoveryStep) === this.planStepSuppressionFingerprint(step),
      )
    }

    if (step.tool === 'collectBlocks' && typeof step.params.type === 'string') {
      if (this.normalizeBlockTargetFamily(step.params.type) === 'coal_ore') {
        return recoverySteps.some(recoveryStep =>
          (recoveryStep.tool === 'smeltItem' && this.isCharcoalSourceItemName(String(recoveryStep.params.item_name ?? '')))
          || (recoveryStep.tool === 'craftRecipe' && this.normalizeCraftRecipeAlias(String(recoveryStep.params.recipe_name ?? '')) === 'torch'),
        )
      }

      return recoverySteps.some(recoveryStep =>
        recoveryStep.tool === 'collectBlocks'
        && this.planStepSuppressionFingerprint(recoveryStep) === this.planStepSuppressionFingerprint(step),
      )
    }

    if ((step.tool === 'searchForBlock' || step.tool === 'searchForEntity') && typeof step.params.type === 'string') {
      return recoverySteps.some(recoveryStep =>
        recoveryStep.tool === step.tool
        && this.planStepSuppressionFingerprint(recoveryStep) === this.planStepSuppressionFingerprint(step),
      )
    }

    return false
  }

  private isStepInvalidatedByFailure(failedStep: PlanStep | undefined, candidateStep: PlanStep): boolean {
    if (!failedStep) {
      return false
    }

    if (
      failedStep.tool === 'searchForEntity'
      && (candidateStep.tool === 'searchForEntity' || candidateStep.tool === 'attack')
    ) {
      return this.planStepSuppressionFingerprint(failedStep) === this.planStepSuppressionFingerprint({
        ...candidateStep,
        tool: 'searchForEntity',
      })
    }

    if (
      failedStep.tool === 'searchForBlock'
      && (candidateStep.tool === 'searchForBlock' || candidateStep.tool === 'collectBlocks')
    ) {
      return this.planStepSuppressionFingerprint(failedStep) === this.planStepSuppressionFingerprint({
        ...candidateStep,
        tool: 'searchForBlock',
      })
    }

    return false
  }

  private requiresPickaxeBootstrap(blockType: string): boolean {
    const normalized = blockType.trim().toLowerCase()
    return normalized.includes('ore') || normalized === 'stone' || normalized === 'cobblestone'
  }

  private getPickaxeTier(itemName: string): number {
    const normalized = itemName.trim().toLowerCase()
    if (normalized.includes('netherite_pickaxe'))
      return 5
    if (normalized.includes('diamond_pickaxe'))
      return 4
    if (normalized.includes('iron_pickaxe'))
      return 3
    if (normalized.includes('stone_pickaxe'))
      return 2
    if (normalized.includes('wooden_pickaxe') || normalized.includes('golden_pickaxe'))
      return 1
    return 0
  }

  private requiredPickaxeTierForBlockType(blockType: string): number {
    const normalized = blockType.trim().toLowerCase()
    if (normalized === 'obsidian') {
      return 4
    }
    if (
      normalized.includes('diamond_ore')
      || normalized.includes('emerald_ore')
      || normalized.includes('redstone_ore')
      || normalized.includes('gold_ore')
    ) {
      return 3
    }
    if (
      normalized.includes('iron_ore')
      || normalized.includes('lapis_ore')
      || normalized.includes('copper_ore')
      || normalized.includes('deepslate')
    ) {
      return 2
    }
    if (normalized === 'stone' || normalized === 'cobblestone' || normalized.includes('coal_ore')) {
      return 1
    }
    return 0
  }

  private hasInventoryPickaxeForBlock(blockType: string): boolean {
    if (!this.bot) {
      return false
    }

    const requiredTier = this.requiredPickaxeTierForBlockType(blockType)
    if (requiredTier <= 0) {
      return false
    }

    const inventory = getInventoryCounts(this.bot as any)
    const bestTier = Object.entries(inventory).reduce((best, [itemName, count]) => {
      if (count <= 0 || !itemName.endsWith('_pickaxe')) {
        return best
      }
      return Math.max(best, this.getPickaxeTier(itemName))
    }, 0)

    return bestTier >= requiredTier
  }

  private buildLowHealthFoodRecoverySteps(availableActionNames: Set<string>): PlanStep[] {
    if (this.getCurrentHealthLevel() >= 12) {
      return []
    }

    const steps: PlanStep[] = []
    const inventory = this.bot ? getInventoryCounts(this.bot as any) : {}
    const foodItemCount = this.countFoodItemsInInventory(inventory)
    if (foodItemCount > 0 && availableActionNames.has('consume')) {
      return [{
        description: 'Eat available food before resuming risky gathering',
        tool: 'consume',
        params: { item_name: 'food' },
      }]
    }

    const surfaceFirstFoodSteps = this.buildSurfaceFirstFoodRecoverySteps(availableActionNames)
    if (surfaceFirstFoodSteps.length > 0) {
      if (availableActionNames.has('consume')) {
        surfaceFirstFoodSteps.push({
          description: 'Eat newly gathered food before resuming risky gathering',
          tool: 'consume',
          params: { item_name: 'food' },
        })
      }
      return surfaceFirstFoodSteps
    }

    if (availableActionNames.has('searchForEntity')) {
      steps.push({
        description: 'Search for nearby animals before resuming low-health gathering',
        tool: 'searchForEntity',
        params: { type: 'animal', search_range: 96 },
      })
    }

    if (availableActionNames.has('attack')) {
      steps.push({
        description: 'Hunt a nearby animal for emergency food',
        tool: 'attack',
        params: { type: 'animal' },
      })
    }

    if (steps.length > 0 && availableActionNames.has('consume')) {
      steps.push({
        description: 'Eat newly gathered food before resuming risky gathering',
        tool: 'consume',
        params: { item_name: 'food' },
      })
    }

    return steps
  }

  private generateWoodRecoverySteps(moveDistance: number, searchRange: number, repeatedFailures = 1): PlanStep[] {
    const availableActionNames = new Set((this.actionAgent?.getAvailableActions() ?? []).map(action => action.name))
    const lowHealthFoodRecoverySteps = this.buildLowHealthFoodRecoverySteps(availableActionNames)
    if (lowHealthFoodRecoverySteps.length > 0) {
      return lowHealthFoodRecoverySteps
    }

    const currentY = Number(this.bot?.bot?.entity?.position?.y ?? Number.NaN)
    const shouldTrySurfaceFirstRecovery = repeatedFailures < 2
      || (Number.isFinite(currentY) && currentY < 62)
    const surfaceFirstWoodSteps = shouldTrySurfaceFirstRecovery
      ? this.buildSurfaceFirstWoodRecoverySteps(availableActionNames)
      : []
    if (surfaceFirstWoodSteps.length > 0) {
      const steps = [...surfaceFirstWoodSteps]
      if (availableActionNames.has('collectBlocks')) {
        steps.push({
          description: 'Collect a minimal set of surface logs for crafting recovery',
          tool: 'collectBlocks',
          params: {
            type: 'log',
            num: 4,
          },
        })
      }
      else if (availableActionNames.has('searchForBlock')) {
        steps.push({
          description: 'Search for logs after recovering out of the cave pocket',
          tool: 'searchForBlock',
          params: {
            type: 'log',
            search_range: searchRange,
          },
        })
      }
      return steps
    }

    const steps: PlanStep[] = [
      {
        description: 'Move to a new area with more trees',
        tool: 'moveAway',
        params: {
          distance: moveDistance,
        },
      },
    ]

    if (repeatedFailures >= 3) {
      steps.push({
        description: 'Relocate further before collecting logs again',
        tool: 'moveAway',
        params: {
          distance: Math.max(48, Math.floor(moveDistance / 2)),
        },
      })
    }

    if (availableActionNames.has('collectBlocks')) {
      steps.push({
        description: 'Collect a minimal set of logs for crafting recovery',
        tool: 'collectBlocks',
        params: {
          type: 'log',
          num: 4,
        },
      })
    }
    else if (availableActionNames.has('searchForBlock')) {
      steps.push({
        description: 'Search for logs in a wider radius',
        tool: 'searchForBlock',
        params: {
          type: 'log',
          search_range: searchRange,
        },
      })
    }

    return steps
  }

  private generateCraftingTableBootstrapSteps(moveDistance: number, searchRange: number, repeatedFailures = 1): PlanStep[] {
    const inventory = this.getInventorySnapshot()
    const steps: PlanStep[] = []
    const preferredPlankRecipe = this.logSourceToPlankRecipe(this.selectInventoryLogSource(null))

    if (inventory.logs <= 0 && inventory.planks <= 0) {
      steps.push(...this.generateWoodRecoverySteps(moveDistance, searchRange, repeatedFailures))
    }

    if (inventory.planks <= 0) {
      steps.push({
        description: 'Craft planks before retrying the crafting table',
        tool: 'craftRecipe',
        params: {
          recipe_name: preferredPlankRecipe,
          num: 1,
        },
      })
    }

    steps.push({
      description: 'Retry crafting the crafting table after recovering wood inputs',
      tool: 'craftRecipe',
      params: {
        recipe_name: 'crafting_table',
        num: 1,
      },
    })

    return steps
  }

  private generateCraftIngredientRecoverySteps(
    recipeName: string,
    moveDistance: number,
    searchRange: number,
    repeatedFailures = 1,
  ): PlanStep[] {
    const normalizedRecipe = this.normalizeCraftRecipeAlias(recipeName)
    if (normalizedRecipe === 'crafting_table') {
      return this.generateCraftingTableBootstrapSteps(moveDistance, searchRange, repeatedFailures)
    }

    if (normalizedRecipe === 'torch') {
      return this.generateTorchIngredientRecoverySteps(moveDistance, searchRange, repeatedFailures)
    }

    if (
      normalizedRecipe === 'wooden_pickaxe'
      || normalizedRecipe === 'wooden_axe'
      || normalizedRecipe === 'wooden_shovel'
      || normalizedRecipe === 'wooden_sword'
      || normalizedRecipe === 'wooden_hoe'
      || normalizedRecipe === 'stone_pickaxe'
      || normalizedRecipe === 'stick'
    ) {
      return this.generateToolBootstrapSteps(moveDistance, searchRange, {
        description: `Recover ingredients for ${normalizedRecipe.replace(/_/g, ' ')}`,
        tool: 'craftRecipe',
        params: { recipe_name: normalizedRecipe, num: 1 },
      }, repeatedFailures)
    }

    if (normalizedRecipe.endsWith('_planks') || normalizedRecipe === 'planks') {
      const inventory = this.getInventorySnapshot()
      const steps: PlanStep[] = []
      const preferredPlankRecipe = this.logSourceToPlankRecipe(this.selectInventoryLogSource(null))

      if (inventory.logs <= 0 && inventory.planks <= 0) {
        steps.push(...this.generateWoodRecoverySteps(moveDistance, searchRange, repeatedFailures))
      }

      if (inventory.planks <= 0) {
        steps.push({
          description: 'Craft planks from recovered logs',
          tool: 'craftRecipe',
          params: {
            recipe_name: normalizedRecipe === 'planks' ? preferredPlankRecipe : normalizedRecipe,
            num: 1,
          },
        })
      }

      return steps
    }

    return this.generateToolBootstrapSteps(moveDistance, searchRange, undefined, repeatedFailures)
  }

  private generateTorchIngredientRecoverySteps(moveDistance: number, searchRange: number, repeatedFailures = 1): PlanStep[] {
    const inventory = this.getInventorySnapshot()
    const inventoryCounts = this.bot ? getInventoryCounts(this.bot as any) : {}
    const availableActionNames = new Set((this.actionAgent?.getAvailableActions() ?? []).map(action => action.name))
    const steps: PlanStep[] = []
    const preferredPlankRecipe = this.logSourceToPlankRecipe(this.selectInventoryLogSource(null))
    const coalFuelCount = (inventoryCounts.coal ?? 0) + (inventoryCounts.charcoal ?? 0)

    if (inventory.sticks <= 0) {
      if (inventory.logs <= 0 && inventory.planks <= 0) {
        steps.push(...this.generateWoodRecoverySteps(moveDistance, searchRange, repeatedFailures))
      }

      if (inventory.planks <= 0) {
        steps.push({
          description: 'Craft planks for torch handles',
          tool: 'craftRecipe',
          params: {
            recipe_name: preferredPlankRecipe,
            num: 1,
          },
        })
      }

      steps.push({
        description: 'Craft sticks before retrying torches',
        tool: 'craftRecipe',
        params: {
          recipe_name: 'stick',
          num: 1,
        },
      })
    }

    if (coalFuelCount <= 0) {
      if (availableActionNames.has('moveAway') && repeatedFailures >= 2) {
        steps.push({
          description: 'Reposition before retrying coal recovery for torches',
          tool: 'moveAway',
          params: {
            distance: Math.max(16, Math.floor(moveDistance / 2)),
          },
        })
      }

      if (availableActionNames.has('searchForBlock')) {
        steps.push({
          description: 'Search for coal ore before retrying torches',
          tool: 'searchForBlock',
          params: {
            type: 'coal_ore',
            search_range: searchRange,
          },
        })
      }

      if (availableActionNames.has('collectBlocks')) {
        steps.push({
          description: 'Collect coal for torches',
          tool: 'collectBlocks',
          params: {
            type: 'coal_ore',
            num: 1,
          },
        })
      }
    }

    steps.push({
      description: 'Retry crafting torches after recovering ingredients',
      tool: 'craftRecipe',
      params: {
        recipe_name: 'torch',
        num: 1,
      },
    })

    return steps
  }

  private generateToolBootstrapSteps(moveDistance: number, searchRange: number, failedStep?: PlanStep, repeatedFailures = 1): PlanStep[] {
    const inventory = this.getInventorySnapshot()
    const steps: PlanStep[] = []
    const preferredPlankRecipe = this.logSourceToPlankRecipe(this.selectInventoryLogSource(null))

    if (inventory.logs <= 0 && inventory.planks <= 0) {
      steps.push(...this.generateWoodRecoverySteps(moveDistance, searchRange, repeatedFailures))
    }

    if (inventory.planks <= 0) {
      steps.push({
        description: 'Craft planks from recovered logs',
        tool: 'craftRecipe',
        params: {
          recipe_name: preferredPlankRecipe,
          num: 1,
        },
      })
    }

    if (inventory.sticks <= 0) {
      steps.push({
        description: 'Craft sticks for tool recovery',
        tool: 'craftRecipe',
        params: {
          recipe_name: 'stick',
          num: 1,
        },
      })
    }

    steps.push({
      description: 'Craft a wooden pickaxe to unblock mining progression',
      tool: 'craftRecipe',
      params: {
        recipe_name: 'wooden_pickaxe',
        num: 1,
      },
    })

    if (failedStep?.tool === 'craftRecipe' && failedStep.params.recipe_name === 'stone_pickaxe') {
      steps.push({
        description: 'Retry the intended stone pickaxe after wooden recovery',
        tool: 'craftRecipe',
        params: {
          recipe_name: 'stone_pickaxe',
          num: 1,
        },
      })
    }

    return steps
  }

  private getInventorySnapshot(): { logs: number, planks: number, sticks: number } {
    if (!this.bot) {
      return {
        logs: 0,
        planks: 0,
        sticks: 0,
      }
    }

    const inventory = getInventoryCounts(this.bot as any)
    return {
      logs: Object.entries(inventory)
        .filter(([name]) => name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_stem'))
        .reduce((sum, [, count]) => sum + count, 0),
      planks: Object.entries(inventory)
        .filter(([name]) => name === 'planks' || name.endsWith('_planks'))
        .reduce((sum, [, count]) => sum + count, 0),
      sticks: inventory.stick ?? 0,
    }
  }

  private async loadCachedPlan(goal: string): Promise<Plan | null> {
    if (!this.memoryAgent)
      return null

    const cachedPlan = this.memoryAgent.recall<Plan>(`plan:${goal}`)
    if (cachedPlan && this.isPlanValid(cachedPlan)) {
      return cachedPlan
    }
    return null
  }

  private async cachePlan(plan: Plan): Promise<void> {
    if (!this.memoryAgent)
      return

    this.memoryAgent.remember(`plan:${plan.goal}`, plan)
  }

  private isPlanValid(_plan: Plan): boolean {
    // Add validation logic here
    return true
  }

  private async handleAgentMessage(sender: string, message: string): Promise<void> {
    if (sender === 'system') {
      if (message.includes('interrupt')) {
        this.handleInterrupt()
      }
    }
    else {
      // Process message and potentially adjust plan
      this.logger.withFields({ sender, message }).log('Processing agent message')

      // If there's a current plan, try to adjust it based on the message
      if (this.currentPlan) {
        await this.adjustPlan(this.currentPlan, message, sender)
      }
    }
  }

  private handleInterrupt(): void {
    if (this.currentPlan) {
      this.currentPlan.status = 'failed'
      this.context = null
    }
  }

  private doesGoalRequireAction(requirements: ReturnType<typeof this.parseGoalRequirements>): boolean {
    // Check if any requirement indicates need for action
    return requirements.needsItems
      || requirements.needsMovement
      || requirements.needsInteraction
      || requirements.needsCrafting
      || requirements.needsCombat
  }

  private isSmallTalkGoal(goal: string): boolean {
    const normalized = goal.trim().toLowerCase()
    if (!normalized)
      return true

    const exactEnglish = new Set([
      'hi',
      'hello',
      'hey',
      'thanks',
      'thank you',
      'good morning',
      'good afternoon',
      'good evening',
      'what is your name',
      'who are you',
    ])

    if (exactEnglish.has(normalized))
      return true

    if (
      normalized.includes('how are you')
      || normalized.includes('what are you doing')
      || normalized.includes('nice to meet you')
    ) {
      return true
    }

    const smallTalkJa = [
      '\u3053\u3093\u306B\u3061\u306F',
      '\u3053\u3093\u3070\u3093\u306F',
      '\u304A\u306F\u3088\u3046',
      '\u3042\u308A\u304C\u3068\u3046',
      '\u3042\u308A\u304C\u3068',
      '\u5143\u6C17',
      '\u8ABF\u5B50',
      '\u96D1\u8AC7',
      '\u81EA\u5DF1\u7D39\u4ECB',
      '\u306A\u306B\u3057\u3066\u308B',
      '\u4F55\u3057\u3066\u308B',
      '\u4ECA\u3069\u3053',
      '\u4F55\u304C\u898B\u3048',
      '\u898B\u3048\u3066\u308B',
    ]
    return smallTalkJa.some(keyword => goal.includes(keyword))
  }

  private isQuestionLikeGoal(goal: string): boolean {
    const normalized = goal.trim().toLowerCase()
    if (!normalized) {
      return true
    }

    if (normalized.includes('?') || normalized.includes('？')) {
      return true
    }

    if (
      normalized.endsWith('か')
      || normalized.endsWith('ですか')
      || normalized.endsWith('ますか')
    ) {
      return true
    }

    const questionHints = [
      'what',
      'where',
      'when',
      'who',
      'why',
      'how',
      '\u4F55',
      '\u306A\u306B',
      '\u3069\u3053',
      '\u3069\u3046',
      '\u306A\u305C',
      '\u3060\u308C',
      '\u3044\u3064',
      '\u6559\u3048\u3066',
      '\u898B\u3048\u3066',
      '\u3057\u3066\u308B',
    ]
    return questionHints.some(keyword => goal.includes(keyword))
  }

  private shouldUseFallbackForGoal(goal: string): boolean {
    const trimmed = goal.trim()
    if (!trimmed)
      return false
    if (this.isSmallTalkGoal(trimmed))
      return false
    if (this.isQuestionLikeGoal(trimmed))
      return false

    const lower = trimmed.toLowerCase()
    const imperativeEn = [
      'start',
      'continue',
      'do something',
      'do whatever',
      'keep going',
      'move',
      'dig',
      'escape',
      'climb',
      'ascend',
      'follow',
      'explore',
      'search',
      'gather',
      'help',
      'assist',
      'support',
    ].some(keyword => lower.includes(keyword))

    const imperativeJa = [
      '\u3057\u3066\u3066',
      '\u3057\u3066',
      '\u3084\u3063\u3066',
      '\u884C\u3063\u3066',
      '\u52D5\u3044\u3066',
      '\u6398\u3063\u3066',
      '\u6398\u308A\u9032\u3081',
      '\u8131\u51FA',
      '\u767B\u3063\u3066',
      '\u63A2\u3057\u3066',
      '\u624B\u4F1D\u3063\u3066',
      '\u904A\u3093\u3067',
      '\u7D9A\u3051\u3066',
      '\u597D\u304D\u306A\u3053\u3068',
      '\u81EA\u7531\u306B',
      '\u9069\u5F53\u306B',
      '\u4EFB\u305B\u308B',
      '\u304A\u9858\u3044',
    ].some(keyword => trimmed.includes(keyword))

    const hasJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/u.test(trimmed)
    return imperativeEn || imperativeJa || (hasJapanese && !this.isQuestionLikeGoal(trimmed))
  }

  private normalizeCraftRecipeAlias(recipeName: string): string {
    const normalized = recipeName
      .toLowerCase()
      .replace(/\s+/g, '_')
      .trim()

    switch (normalized) {
      case 'pick_axe':
        return 'pickaxe'
      case 'plank':
      case 'planks':
        return 'oak_planks'
      case 'sticks':
        return 'stick'
      case 'diamond_armor':
      case 'diamond_armor_set':
      case 'full_diamond_armor':
      case 'diamond_loadout':
        return 'diamond_armor_set'
      case 'wooden_tools':
      case 'wooden_tool_set':
      case 'wooden_tools_set':
      case 'basic_wooden_tool_set':
        return 'wooden_tools_set'
      default:
        return normalized
    }
  }

  private getStructuredCraftPriority(itemName: string): number {
    const normalized = this.normalizeCraftRecipeAlias(itemName)
    if (normalized.endsWith('_sword') || normalized === 'sword') {
      return 0
    }
    if (normalized === 'shield') {
      return 1
    }
    if (normalized.endsWith('_pickaxe')) {
      return 2
    }
    if (normalized === 'torch') {
      return 3
    }
    return 10
  }

  private expandCraftRecipeNames(recipeName: string): string[] {
    const normalized = this.normalizeCraftRecipeAlias(recipeName)
    if (normalized === 'wooden_tools_set') {
      return ['wooden_pickaxe', 'wooden_axe']
    }
    if (normalized === 'diamond_armor_set') {
      return ['diamond_chestplate', 'diamond_leggings', 'diamond_helmet', 'diamond_boots']
    }

    return [normalized]
  }

  private extractCraftRecipesFromText(text: string): string[] {
    const normalized = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    const recipes: string[] = []
    const push = (recipe: string): void => {
      if (!recipes.includes(recipe)) {
        recipes.push(recipe)
      }
    }

    if (/\b(?:basic )?wooden tool set\b/u.test(normalized) || /\bwooden tools\b/u.test(normalized)) {
      push('wooden_pickaxe')
      push('wooden_axe')
    }
    if (/\bwooden pickaxe\b/u.test(normalized) || text.includes('木のツルハシ')) {
      push('wooden_pickaxe')
    }
    if (/\bstone pickaxe\b/u.test(normalized) || text.includes('石のツルハシ')) {
      push('stone_pickaxe')
    }
    if (/\biron pickaxe\b/u.test(normalized) || text.includes('鉄のツルハシ')) {
      push('iron_pickaxe')
    }
    if (/\bdiamond pickaxe\b/u.test(normalized) || text.includes('ダイヤのツルハシ')) {
      push('diamond_pickaxe')
    }
    if (/\bdiamond helmet\b/u.test(normalized) || text.includes('ダイヤのヘルメット')) {
      push('diamond_helmet')
    }
    if (/\bdiamond chestplate\b/u.test(normalized) || text.includes('ダイヤのチェストプレート')) {
      push('diamond_chestplate')
    }
    if (/\bdiamond leggings\b/u.test(normalized) || text.includes('ダイヤのレギンス')) {
      push('diamond_leggings')
    }
    if (/\bdiamond boots\b/u.test(normalized) || text.includes('ダイヤのブーツ')) {
      push('diamond_boots')
    }
    if (/\bfull diamond armor\b/u.test(normalized) || /\bdiamond armor set\b/u.test(normalized) || text.includes('ダイヤフル装備') || text.includes('ダイヤ防具一式')) {
      push('diamond_chestplate')
      push('diamond_leggings')
      push('diamond_helmet')
      push('diamond_boots')
    }
    if (/\bwooden axe\b/u.test(normalized) || text.includes('木の斧')) {
      push('wooden_axe')
    }
    if (/\bswords?\b/u.test(normalized) || text.includes('剣')) {
      push('sword')
    }
    if (/\btorches?\b/u.test(normalized) || text.includes('松明')) {
      push('torch')
    }
    if (/\bshield\b/u.test(normalized) || text.includes('盾')) {
      push('shield')
    }
    if ((
      normalized.includes('craft a crafting table')
      || normalized.includes('craft the crafting table')
      || normalized.includes('build a crafting table')
      || normalized.includes('make a crafting table')
      || normalized.includes('make crafting table')
      || text.includes('作業台を作')
    ) && !normalized.startsWith('go to the nearby crafting table')) {
      push('crafting_table')
    }
    if (/\b(?:craft|make|create|build|prepare)\b/u.test(normalized) && /\bfurnace\b/u.test(normalized)) {
      push('furnace')
    }
    if (/\bplanks\b/u.test(normalized) || text.includes('板材')) {
      push('oak_planks')
    }
    if (/\bsticks?\b/u.test(normalized) || text.includes('棒')) {
      push('stick')
    }

    return recipes
  }

  private extractPlacementTargetsFromText(text: string): string[] {
    const normalized = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    const placements: string[] = []
    const push = (item: string): void => {
      if (!placements.includes(item)) {
        placements.push(item)
      }
    }

    if (/\bplace (?:a |an )?furnace\b/u.test(normalized) || text.includes('かまどを置') || text.includes('かまどを設置')) {
      push('furnace')
    }

    if (/\bplace (?:a |an )?crafting table\b/u.test(normalized) || text.includes('作業台を置') || text.includes('作業台を設置')) {
      push('crafting_table')
    }

    return placements
  }

  private hasNearbyPlacementAccess(itemName: string): boolean {
    const normalized = this.normalizeCraftRecipeAlias(itemName)
    if (normalized === 'furnace') {
      return this.hasNearbyFurnaceAccess()
    }

    if (normalized === 'crafting_table') {
      return this.hasNearbyCraftingTableAccess()
    }

    if (!this.bot) {
      return false
    }

    try {
      return Boolean(getNearestBlock(this.bot as any, normalized, 4))
    }
    catch {
      return false
    }
  }

  private hasNearbySurfaceRecoveryCue(): boolean {
    if (!this.bot?.bot?.entity?.position) {
      return false
    }

    try {
      const position = this.bot.bot.entity.position
      const nearbyCueBlocks = getNearestBlocks(this.bot as any, SURFACE_RECOVERY_CUE_QUERIES, 24, 12)
      return nearbyCueBlocks.some((block) => {
        const horizontalDistance = Math.hypot(
          block.position.x - position.x,
          block.position.z - position.z,
        )
        const verticalDelta = block.position.y - position.y
        return horizontalDistance <= 12 && verticalDelta >= -3 && verticalDelta <= 8
      })
    }
    catch {
      return false
    }
  }

  private isNaturalSurfaceCoverBlock(blockName: string): boolean {
    return /_leaves|_log$|_wood$|_stem$|_hyphae$|vine$|vines$|mangrove_roots|bamboo/u.test(blockName)
  }

  private isNaturalSurfaceGroundBlock(blockName: string): boolean {
    return [
      'grass_block',
      'dirt',
      'coarse_dirt',
      'podzol',
      'mycelium',
      'sand',
      'red_sand',
      'mud',
      'snow_block',
      'snow',
      'moss_block',
    ].includes(blockName)
  }

  private isSurfacePassableBlock(blockName: string): boolean {
    return this.isOpenAirLikeBlock(blockName)
      || [
        'short_grass',
        'tall_grass',
        'grass',
        'fern',
        'large_fern',
        'dead_bush',
        'dandelion',
        'poppy',
        'blue_orchid',
        'allium',
        'azure_bluet',
        'oxeye_daisy',
        'cornflower',
        'lily_of_the_valley',
        'pink_petals',
      ].includes(blockName)
  }

  private hasNearbySurfaceSkyWindow(): boolean {
    const position = this.bot?.bot?.entity?.position
    const blockAt = this.bot?.bot?.blockAt
    if (!position || typeof blockAt !== 'function') {
      return false
    }

    try {
      const x = Math.floor(position.x)
      const y = Math.floor(position.y)
      const z = Math.floor(position.z)
      const readBlockName = (dx: number, dy: number, dz: number): string => String(
        blockAt({ x: x + dx, y: y + dy, z: z + dz } as any)?.name ?? 'unknown',
      ).toLowerCase()
      const columnOffsets: Array<[number, number]> = [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ]

      return columnOffsets.some(([dx, dz]) => {
        let openBlocks = 0
        let canopyBlocks = 0

        for (let dy = 2; dy <= 12; dy++) {
          const blockName = readBlockName(dx, dy, dz)
          if (this.isOpenAirLikeBlock(blockName)) {
            openBlocks++
            continue
          }

          if (this.isNaturalSurfaceCoverBlock(blockName)) {
            canopyBlocks++
            continue
          }

          return false
        }

        return openBlocks >= 5 || (canopyBlocks > 0 && openBlocks >= 3)
      })
    }
    catch {
      return false
    }
  }

  private isLikelyUndergroundSurfaceRecoveryContext(): boolean {
    const position = this.bot?.bot?.entity?.position
    const blockAt = this.bot?.bot?.blockAt
    if (!position || typeof blockAt !== 'function') {
      return false
    }

    try {
      const x = Math.floor(position.x)
      const y = Math.floor(position.y)
      const z = Math.floor(position.z)
      const readBlockName = (dx: number, dy: number, dz: number): string => String(
        blockAt({ x: x + dx, y: y + dy, z: z + dz } as any)?.name ?? 'unknown',
      ).toLowerCase()

      const ceiling = readBlockName(0, 2, 0)
      const feet = readBlockName(0, 0, 0)
      const head = readBlockName(0, 1, 0)
      const under = readBlockName(0, -1, 0)
      const lateralFeet = [
        readBlockName(1, 0, 0),
        readBlockName(-1, 0, 0),
        readBlockName(0, 0, 1),
        readBlockName(0, 0, -1),
      ]
      const lateralSolidCount = [
        ...lateralFeet,
        readBlockName(1, 1, 0),
        readBlockName(-1, 1, 0),
        readBlockName(0, 1, 1),
        readBlockName(0, 1, -1),
      ].filter(name => !this.isOpenAirLikeBlock(name)).length
      const lateralPassableCount = lateralFeet.filter(name => this.isSurfacePassableBlock(name)).length
      const nearbySurfaceCue = this.hasNearbySurfaceRecoveryCue()
      const nearbySurfaceSkyWindow = this.hasNearbySurfaceSkyWindow()

      if (
        y >= 62
        && nearbySurfaceCue
        && this.isNaturalSurfaceGroundBlock(under)
        && this.isSurfacePassableBlock(feet)
        && this.isSurfacePassableBlock(head)
        && (lateralPassableCount >= 2 || lateralSolidCount <= 2)
      ) {
        return false
      }

      if (y >= 62 && nearbySurfaceCue && nearbySurfaceSkyWindow) {
        return false
      }

      return !this.isOpenAirLikeBlock(ceiling)
        && !nearbySurfaceSkyWindow
        && (lateralSolidCount >= 3 || nearbySurfaceCue || y < 58)
    }
    catch {
      return !this.hasNearbySurfaceSkyWindow()
        && (this.hasNearbySurfaceRecoveryCue() || position.y < 58)
    }
  }

  private isOpenAirLikeBlock(blockName: string): boolean {
    return ['air', 'cave_air', 'void_air'].includes(blockName)
  }

  private ensureActionableSteps(goal: string, steps: PlanStep[]): PlanStep[] {
    const availableActionNames = new Set(
      (this.actionAgent?.getAvailableActions() ?? []).map(action => action.name),
    )
    const goalLower = goal.toLowerCase()
    const isFoodGoal = goalLower.includes('collect food')
      || goalLower.includes('survival')
      || goalLower.includes('available food')
      || goalLower.includes('hunger')
      || goalLower.includes('eat')
      || goalLower.includes('consume')
      || goal.includes('食料')
      || goal.includes('食べ')
      || goal.includes('空腹')
      || goal.includes('生存')

    const stripCommentSuffix = (value: string): string => value
      .replace(/\s+(?:#|\/\/).*$/, '')
      .replace(/\s*[（(][^()（）]{0,120}[)）]\s*$/, '')
      .replace(/\\"/g, '"')
      .replace(/^["'`]+/, '')
      .replace(/["'`]+$/, '')
      .trim()

    const normalizeTypeParam = (raw: unknown): string => {
      if (typeof raw !== 'string') {
        return ''
      }
      return stripCommentSuffix(raw)
        .toLowerCase()
        .replace(/\s+/g, '_')
    }

    const normalizeRecipeNameParam = (raw: unknown): string => {
      if (typeof raw !== 'string') {
        return ''
      }

      return this.normalizeCraftRecipeAlias(stripCommentSuffix(raw))
    }

    const clampRange = (raw: unknown, fallback = 64): number => {
      const parsed = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(parsed)) {
        return fallback
      }
      return Math.min(256, Math.max(32, Math.trunc(parsed)))
    }

    const clampCount = (raw: unknown, fallback = 4): number => {
      const parsed = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(parsed)) {
        return fallback
      }
      return Math.min(64, Math.max(1, Math.trunc(parsed)))
    }

    const sanitizeStep = (step: PlanStep): PlanStep => {
      const tool = step.tool.trim()
      const params = { ...step.params }

      if (tool === 'searchForBlock' || tool === 'searchForEntity') {
        params.search_range = clampRange(params.search_range, isFoodGoal ? 96 : 64)
      }

      if (tool === 'collectBlocks') {
        params.num = clampCount(params.num, 4)
      }

      if (tool === 'searchForBlock' || tool === 'collectBlocks' || tool === 'placeHere') {
        const type = normalizeTypeParam(params.type)
        if (type) {
          let normalizedType = type
          if (['food', 'food_item', '食料', '食料品', '食べ物'].includes(normalizedType)) {
            normalizedType = isFoodGoal ? 'wheat' : ''
          }
          if (isFoodGoal && ['grass', 'short_grass', 'tall_grass'].includes(normalizedType)) {
            normalizedType = 'wheat'
          }
          if (normalizedType) {
            params.type = normalizedType
          }
        }
      }

      if (tool === 'searchForEntity' || tool === 'attack') {
        let type = normalizeTypeParam(params.type)
        if (['food', 'food_item', 'meat', 'cooked_meat'].includes(type)) {
          type = 'animal'
        }
        if (type === 'village') {
          type = 'villager'
        }
        if (type) {
          params.type = type
        }
      }

      if (tool === 'consume' && typeof params.item_name === 'string') {
        const itemName = stripCommentSuffix(params.item_name).toLowerCase()
        const looksLikeItemId = /^[a-z0-9_]+$/.test(itemName)
        const genericFoodRequest = itemName === 'food'
        if (
          !itemName
          || !looksLikeItemId
          || itemName.includes('food_item')
          || itemName === 'item'
          || itemName === 'unknown'
          || itemName === '食料'
          || itemName === '食料品'
          || itemName === '食べ物'
        ) {
          params.item_name = ''
        }
        else if (genericFoodRequest) {
          params.item_name = isFoodGoal ? 'food' : ''
        }
        else {
          params.item_name = itemName
        }
      }

      if (tool === 'craftRecipe' && typeof params.recipe_name === 'string') {
        params.recipe_name = normalizeRecipeNameParam(params.recipe_name)
      }

      return {
        ...step,
        tool,
        params,
      }
    }

    let normalized = steps
      .map(sanitizeStep)
      .filter(step =>
        step.tool
        && availableActionNames.has(step.tool)
        && typeof step.description === 'string'
        && step.description.trim().length > 0
        && (
          step.tool !== 'consume'
          || (typeof step.params.item_name === 'string' && step.params.item_name.trim().length > 0)
        ),
      )

    if (isFoodGoal && normalized.length > 0) {
      const hasFoodConsume = normalized.some(step =>
        step.tool === 'consume'
        && typeof step.params.item_name === 'string'
        && step.params.item_name === 'food',
      )
      if (hasFoodConsume) {
        return this.insertPreconditionSteps(normalized)
      }

      const hasMobilityStep = normalized.some(step => step.tool === 'moveAway')
      const hasFoodSeek = normalized.some(step => step.tool === 'searchForEntity')
      const hasFoodCombat = normalized.some(step => step.tool === 'attack')
      if (!hasMobilityStep && availableActionNames.has('moveAway')) {
        normalized = [
          {
            description: '周辺の地形を移動して食料候補を探す',
            tool: 'moveAway',
            params: { distance: 24 },
          },
          ...normalized,
        ]
      }
      if (!hasFoodSeek) {
        normalized = [
          ...normalized,
          {
            description: '近くの動物を探す',
            tool: 'searchForEntity',
            params: { type: 'animal', search_range: 64 },
          },
        ]
      }
      if (!hasFoodCombat) {
        normalized = [
          ...normalized,
          {
            description: '近くの動物を攻撃して食料を得る',
            tool: 'attack',
            params: { type: 'animal' },
          },
        ]
      }
    }

    if (normalized.length > 0) {
      normalized = normalized.flatMap((step) => {
        if (step.tool !== 'craftRecipe' || typeof step.params.recipe_name !== 'string') {
          return [step]
        }

        return this.expandCraftRecipeNames(step.params.recipe_name).map(recipeName => ({
          ...step,
          params: {
            ...step.params,
            recipe_name: recipeName,
          },
        }))
      })

      const craftRecipesPresent = new Set(
        normalized
          .filter(step => step.tool === 'craftRecipe' && typeof step.params.recipe_name === 'string')
          .map(step => String(step.params.recipe_name)),
      )
      const augmented: PlanStep[] = []

      for (const step of normalized) {
        augmented.push(step)
        if (step.tool === 'craftRecipe') {
          continue
        }

        for (const recipeName of this.extractCraftRecipesFromText(step.description)) {
          if (craftRecipesPresent.has(recipeName)) {
            continue
          }

          augmented.push({
            description: `Craft ${recipeName.replace(/_/g, ' ')}`,
            tool: 'craftRecipe',
            params: {
              recipe_name: recipeName,
              num: 1,
            },
          })
          craftRecipesPresent.add(recipeName)
        }
      }

      for (const recipeName of this.extractCraftRecipesFromText(goal)) {
        if (craftRecipesPresent.has(recipeName)) {
          continue
        }

        augmented.push({
          description: `Craft ${recipeName.replace(/_/g, ' ')} for the active goal`,
          tool: 'craftRecipe',
          params: {
            recipe_name: recipeName,
            num: 1,
          },
        })
        craftRecipesPresent.add(recipeName)
      }

      normalized = augmented
      return this.insertPreconditionSteps(normalized)
    }

    this.logger.withField('goal', goal).warn('Generated plan was empty or non-actionable, using fallback steps')
    emitFallbackMonitor({
      scope: 'planning.normalizePlan',
      reason: 'generated-plan-empty',
      goal,
      detail: 'Generated plan was empty or non-actionable, using fallback steps.',
      from: 'generated-plan',
      to: 'fallback-steps',
      recoverable: true,
    }, { throttleMs: 5_000 })
    return this.generateFallbackSteps(goal).filter(step =>
      step.tool
      && availableActionNames.has(step.tool)
      && typeof step.description === 'string'
      && step.description.trim().length > 0,
    )
  }

  /**
   * Block types that require a pickaxe to harvest.
   */
  private static readonly PICKAXE_BLOCKS = new Set([
    'stone',
    'cobblestone',
    'andesite',
    'diorite',
    'granite',
    'deepslate',
    'cobbled_deepslate',
    'tuff',
    'basalt',
    'blackstone',
    'coal_ore',
    'deepslate_coal_ore',
    'iron_ore',
    'deepslate_iron_ore',
    'gold_ore',
    'deepslate_gold_ore',
    'diamond_ore',
    'deepslate_diamond_ore',
    'emerald_ore',
    'deepslate_emerald_ore',
    'lapis_ore',
    'deepslate_lapis_ore',
    'redstone_ore',
    'deepslate_redstone_ore',
    'copper_ore',
    'deepslate_copper_ore',
    'nether_gold_ore',
    'nether_quartz_ore',
    'obsidian',
    'netherrack',
    'end_stone',
    'sandstone',
    'red_sandstone',
    'bricks',
    'stone_bricks',
    'mossy_stone_bricks',
    'cracked_stone_bricks',
    'nether_bricks',
    'red_nether_bricks',
    'prismarine',
    'dark_prismarine',
    'terracotta',
    'concrete',
    'ice',
    'packed_ice',
    'blue_ice',
  ])

  /**
   * Block types that require a shovel.
   */
  private static readonly SHOVEL_BLOCKS = new Set([
    'dirt',
    'grass_block',
    'sand',
    'red_sand',
    'gravel',
    'clay',
    'soul_sand',
    'soul_soil',
    'snow',
    'snow_block',
    'mycelium',
    'podzol',
    'coarse_dirt',
    'rooted_dirt',
    'mud',
  ])

  /**
   * Block types that require an axe.
   */
  private static readonly AXE_BLOCKS = new Set([
    'oak_planks',
    'spruce_planks',
    'birch_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'mangrove_planks',
    'cherry_planks',
    'bookshelf',
    'chest',
    'crafting_table',
    'note_block',
    'jukebox',
    'pumpkin',
    'melon',
  ])

  /**
   * Resolve which tool category a block type requires, or undefined if none/hand is fine.
   */
  private resolveToolForBlock(blockType: string): 'pickaxe' | 'axe' | 'shovel' | undefined {
    const normalized = blockType.toLowerCase().replace(/\s+/g, '_')

    // Direct match
    if (PlanningAgentImpl.PICKAXE_BLOCKS.has(normalized))
      return 'pickaxe'
    if (PlanningAgentImpl.SHOVEL_BLOCKS.has(normalized))
      return 'shovel'
    if (PlanningAgentImpl.AXE_BLOCKS.has(normalized))
      return 'axe'

    // Suffix/contains heuristics
    if (normalized.includes('ore'))
      return 'pickaxe'
    if (normalized.includes('stone') && !normalized.includes('sand'))
      return 'pickaxe'
    if (normalized.includes('brick'))
      return 'pickaxe'
    if (normalized.includes('concrete'))
      return 'pickaxe'
    if (normalized.includes('terracotta'))
      return 'pickaxe'

    return undefined
  }

  /**
   * Check if the bot's inventory contains any tool of the given category.
   */
  private hasToolInInventory(toolCategory: 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword'): boolean {
    if (!this.bot)
      return false
    try {
      const inventory = getInventoryCounts(this.bot as any)
      const suffix = `_${toolCategory}`
      return Object.keys(inventory).some(item => item.endsWith(suffix) && inventory[item] > 0)
    }
    catch {
      return false
    }
  }

  /**
   * Check if the bot's inventory contains a specific item.
   */
  private hasItemInInventory(itemName: string): boolean {
    if (!this.bot)
      return false
    try {
      const inventory = getInventoryCounts(this.bot as any)
      return (inventory[itemName] ?? 0) > 0
    }
    catch {
      return false
    }
  }

  /**
   * Generate preparation steps to ensure a tool is available.
   */
  private generateToolPreparationSteps(toolCategory: 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword'): PlanStep[] {
    const recipeName = `wooden_${toolCategory}`
    return [{
      description: `Ensure ${toolCategory} is available before proceeding`,
      tool: 'craftRecipe',
      params: { recipe_name: recipeName, num: 1 },
    }]
  }

  /**
   * Scan plan steps for precondition violations and auto-insert preparation steps.
   * This is the "C" approach: validate the generated plan before execution.
   */
  private insertPreconditionSteps(steps: PlanStep[]): PlanStep[] {
    const actions = this.actionAgent?.getAvailableActions() ?? []
    const actionMap = new Map(actions.map(a => [a.name, a]))
    const availableActionNames = new Set(actions.map(a => a.name))
    const result: PlanStep[] = []

    // Track tools we've already decided to prepare (avoid duplicate inserts)
    const toolsPrepared = new Set<string>()

    for (const step of steps) {
      const action = actionMap.get(step.tool)
      if (!action?.preconditions) {
        result.push(step)
        continue
      }

      const preconds = action.preconditions

      // Check tool requirements
      if (preconds.requiresTool) {
        let neededTool: 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword' | undefined

        if (preconds.requiresTool === 'for-block') {
          // Resolve based on the block type parameter
          const blockType = String(step.params.type || '')
          neededTool = this.resolveToolForBlock(blockType)
        }
        else {
          neededTool = preconds.requiresTool
        }

        if (neededTool && !toolsPrepared.has(neededTool) && !this.hasToolInInventory(neededTool)) {
          // Need to prepare this tool — insert crafting steps before this action
          if (availableActionNames.has('craftRecipe')) {
            const prepSteps = this.generateToolPreparationSteps(neededTool)
            this.logger.withFields({ tool: neededTool, beforeAction: step.tool }).log('Inserting tool preparation steps')

            // Before crafting a tool, we may need wood. Insert wood gathering if needed.
            if (!this.hasItemInInventory('oak_log') && !this.hasItemInInventory('birch_log')
              && !this.hasItemInInventory('spruce_log') && !this.hasItemInInventory('jungle_log')
              && !this.hasItemInInventory('acacia_log') && !this.hasItemInInventory('dark_oak_log')
              && !this.hasItemInInventory('oak_planks') && !this.hasItemInInventory('stick')) {
              if (availableActionNames.has('collectBlocks')) {
                result.push({
                  description: 'Collect logs for crafting tools',
                  tool: 'collectBlocks',
                  params: { type: 'log', num: 4 },
                })
              }
            }

            result.push(...prepSteps)
            toolsPrepared.add(neededTool)
          }
        }
      }

      result.push(step)
    }

    return result
  }

  private generateFallbackSteps(goal: string): PlanStep[] {
    const goalLower = goal.toLowerCase()
    const availableActions = this.actionAgent?.getAvailableActions() ?? []
    const availableActionNames = new Set(availableActions.map(action => action.name))
    const likelyPlayerName = this.extractLikelyPlayerName(goal)
    const socialGoalHint = [
      '\u4E00\u7DD2',
      '\u5354\u529B',
      '\u624B\u4F1D',
      '\u652F\u63F4',
      '\u540C\u884C',
      '\u3064\u3044\u3066',
    ].some(keyword => goal.includes(keyword))

    const socialGoal = [
      'support',
      'assist',
      'help',
      'coordinate',
      'follow',
      'team',
      'together',
      'with',
    ].some(keyword => goalLower.includes(keyword)) || socialGoalHint

    if (socialGoal && likelyPlayerName) {
      return [{
        description: `Follow ${likelyPlayerName} and support their activity`,
        tool: 'followPlayer',
        params: {
          player_name: likelyPlayerName,
          follow_dist: 4,
        },
      }]
    }

    if (this.isShelterGoalText(goal)) {
      const shelterSteps = this.buildStructuredShelterPlan(goal, availableActionNames)
      if (shelterSteps.length > 0) {
        return shelterSteps
      }
    }

    return [
      {
        description: 'Scan nearby blocks for context',
        tool: 'nearbyBlocks',
        params: {},
      },
      {
        description: 'Search for nearby logs',
        tool: 'searchForBlock',
        params: {
          type: 'log',
          search_range: 64,
        },
      },
      {
        description: 'Collect some logs',
        tool: 'collectBlocks',
        params: {
          type: 'log',
          num: 4,
        },
      },
      {
        description: 'Explore nearby area',
        tool: 'moveAway',
        params: {
          distance: 16,
        },
      },
    ]
  }

  private extractLikelyPlayerName(goal: string): string | undefined {
    const candidates = goal.match(/\b\w{3,16}\b/g) ?? []
    const stopwords = new Set([
      'coordinate',
      'support',
      'nearby',
      'objective',
      'with',
      'and',
      'the',
      'goal',
      'autonomy',
      'player',
      'minecraft',
    ])

    return candidates.find(candidate => !stopwords.has(candidate.toLowerCase()))
  }

  private async generatePlanSteps(
    goal: string,
    availableActions: Action[],
    sender: string,
    feedback?: string,
  ): Promise<PlanStep[]> {
    this.logger.log('Generating plan using LLM')
    return await this.llmHandler.generatePlan(goal, availableActions, sender, feedback)
  }

  private parseGoalRequirements(goal: string): {
    needsItems: boolean
    items?: string[]
    needsMovement: boolean
    location?: { x?: number, y?: number, z?: number }
    needsInteraction: boolean
    target?: string
    needsCrafting: boolean
    needsCombat: boolean
  } {
    const requirements = {
      needsItems: false,
      items: [] as string[],
      needsMovement: false,
      location: undefined as { x?: number, y?: number, z?: number } | undefined,
      needsInteraction: false,
      target: undefined as string | undefined,
      needsCrafting: false,
      needsCombat: false,
    }

    const goalLower = goal.toLowerCase()
    const hasAny = (keywords: string[]) => keywords.some((keyword) => {
      const normalizedKeyword = keyword.toLowerCase().trim()
      if (!normalizedKeyword) {
        return false
      }

      if (normalizedKeyword.includes(' ')) {
        return goalLower.includes(normalizedKeyword)
      }

      const escapedKeyword = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^a-z0-9_-])${escapedKeyword}($|[^a-z0-9_-])`, 'u').test(goalLower)
    })
    const targetRequirements = this.extractGoalTargetRequirements(goal)
    if (targetRequirements.length > 0) {
      requirements.needsItems = true
      requirements.items = targetRequirements.map(target => target.item)
    }

    const locationMatches = goalLower.match(/(go to|move to|at) (\d+)[, ]+(\d+)[, ]+(\d+)/g)
    if (locationMatches) {
      requirements.needsMovement = true
      const [x, y, z] = locationMatches[0].split(/[, ]+/).slice(-3).map(Number)
      requirements.location = { x, y, z }
    }

    const targetMatches = goalLower.match(/(interact with|use|open|activate) (\w+)/g)
    if (targetMatches) {
      requirements.needsInteraction = true
      requirements.target = targetMatches[0].split(' ').pop()
    }

    if (
      hasAny(['collect', 'get', 'find', 'gather', 'mine', 'chop', 'harvest', 'loot'])
      || [
        '\u96C6\u3081',
        '\u63A1\u53D6',
        '\u6398',
        '\u4F10\u63A1',
        '\u53D6\u3063\u3066',
        '\u63A2\u7D22\u3057\u3066',
      ].some(keyword => goal.includes(keyword))
    ) {
      requirements.needsItems = true
      requirements.needsMovement = true
    }

    if (
      hasAny(['go to', 'move to', 'follow', 'explore', 'search', 'scout', 'patrol', 'travel', 'coordinate', 'support', 'assist', 'help', 'join', 'accompany', 'cooperate', 'together'])
      || [
        '\u79FB\u52D5',
        '\u5411\u304B',
        '\u3064\u3044\u3066',
        '\u63A2\u7D22',
        '\u6563\u7B56',
        '\u5DE1\u56DE',
        '\u4E00\u7DD2',
        '\u540C\u884C',
        '\u5354\u529B',
        '\u624B\u4F1D',
        '\u652F\u63F4',
      ].some(keyword => goal.includes(keyword))
    ) {
      requirements.needsMovement = true
    }

    const surfaceRecoveryGoal = (
      hasAny(['dig up', 'dig upwards', 'dig upward', 'climb', 'ascend', 'escape', 'surface', 'cave exit', 'open terrain'])
      || [
        '\u5730\u4E0A',
        '\u8131\u51FA',
        '\u51FA\u53E3',
        '\u4E0A\u3078',
        '\u6398\u308A\u9032\u3081',
        '\u767B',
      ].some(keyword => goal.includes(keyword))
    )
    && (
      hasAny(['dig', 'up', 'upward', 'upwards', 'reach', 'escape', 'climb', 'ascend', 'surface'])
      || [
        '\u6398',
        '\u4E0A',
        '\u5730\u4E0A',
        '\u8131\u51FA',
        '\u51FA\u53E3',
        '\u767B',
      ].some(keyword => goal.includes(keyword))
    )

    if (surfaceRecoveryGoal) {
      requirements.needsMovement = true
      requirements.needsInteraction = true
    }

    const shelterGoal = hasAny([
      'shelter',
      'survive the night',
      'night combat',
      'fortify',
      'house',
      'base',
      'bed',
      'safe retreat',
      'safe home',
    ])
    || [
      '\u62E0\u70B9',
      '\u5BB6',
      '\u591C',
      '\u907F\u96E3',
      '\u5BDD',
      '\u30B7\u30A7\u30EB\u30BF\u30FC',
    ].some(keyword => goal.includes(keyword))
    if (shelterGoal) {
      requirements.needsMovement = true
      requirements.needsInteraction = true
      requirements.needsItems = true
    }

    if (
      hasAny(['interact', 'use', 'open', 'place', 'repair', 'secure', 'fortify', 'coordinate', 'support', 'assist', 'help', 'chat', 'talk'])
      || [
        '\u4F1A\u8A71',
        '\u8A71\u3057\u3066',
        '\u4EA4\u6D41',
        '\u624B\u4F1D',
        '\u5354\u529B',
        '\u30B5\u30DD\u30FC\u30C8',
        '\u5B88\u3063\u3066',
      ].some(keyword => goal.includes(keyword))
    ) {
      requirements.needsInteraction = true
    }

    if (
      hasAny(['craft', 'make', 'build', 'smelt', 'cook'])
      || [
        '\u4F5C\u3063\u3066',
        '\u5EFA\u3066',
        '\u30AF\u30E9\u30D5\u30C8',
        '\u7CBE\u932C',
        '\u6599\u7406',
      ].some(keyword => goal.includes(keyword))
    ) {
      requirements.needsCrafting = true
      requirements.needsItems = true
    }

    if (
      hasAny(['attack', 'fight', 'kill', 'defend', 'protect', 'hunt'])
      || [
        '\u653B\u6483',
        '\u5012',
        '\u9632\u885B',
        '\u5B88\u308B',
        '\u72E9\u308A',
      ].some(keyword => goal.includes(keyword))
    ) {
      requirements.needsCombat = true
      requirements.needsMovement = true
    }

    if (hasAny(['improve', 'safety', 'survival', 'stability', 'base'])) {
      requirements.needsMovement = true
      requirements.needsInteraction = true
    }

    if (!this.doesGoalRequireAction(requirements)) {
      if (this.isQuestionLikeGoal(goal)) {
        return requirements
      }

      const likelyImperativeEn = hasAny([
        'do ',
        'start',
        'continue',
        'go',
        'move',
        'follow',
        'explore',
        'search',
        'gather',
        'support',
        'assist',
      ])
      const likelyImperativeJa = [
        '\u3057\u3066\u3066',
        '\u3057\u3066',
        '\u3084\u3063\u3066',
        '\u884C\u3063\u3066',
        '\u52D5\u3044\u3066',
        '\u63A2\u3057\u3066',
        '\u624B\u4F1D\u3063\u3066',
        '\u904A\u3093\u3067',
        '\u7D9A\u3051\u3066',
      ].some(keyword => goal.includes(keyword))

      const likelyImperative = likelyImperativeEn || likelyImperativeJa

      if (likelyImperative) {
        requirements.needsMovement = true
        requirements.needsInteraction = true
      }
    }

    return requirements
  }

  private isSurfaceRecoveryGoalText(goal: string): boolean {
    const normalized = goal.toLowerCase()
    const hasSurfaceSignal = [
      'dig up',
      'dig upwards',
      'dig upward',
      'reach the surface',
      'surface escape',
      'escape to the surface',
      'cave exit',
      'open terrain',
      'ascend',
      'climb upward',
    ].some(keyword => normalized.includes(keyword))
    const hasJapaneseSignal = ['地上', '脱出', '出口', '上へ', '登'].some(keyword => goal.includes(keyword))
    return hasSurfaceSignal || hasJapaneseSignal
  }

  private isShelterGoalText(goal: string): boolean {
    const normalized = goal.toLowerCase()
    return [
      'shelter',
      'night combat',
      'safe retreat',
      'temporary shelter',
    ].some(keyword => normalized.includes(keyword))
    || ['避難', 'シェルター', '夜'].some(keyword => goal.includes(keyword))
  }
}
