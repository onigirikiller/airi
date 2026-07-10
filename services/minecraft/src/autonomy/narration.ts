export type NarrationIntent
  = | 'plan'
    | 'reaction'
    | 'discovery'
    | 'danger'
    | 'failure'
    | 'recovery'
    | 'resolve'
    | 'status'
    | 'viewer-address'
    | 'keepalive'

export type GroundingSource
  = | 'state-delta'
    | 'plan-delta'
    | 'failure'
    | 'recovery'
    | 'discovery'
    | 'danger'
    | 'viewer-input'
    | 'explicit-keepalive'

export interface NarrationBasis {
  goalLabel: string
  actionLabel: string
  obstacle: string
  milestone: string
  unresolvedNeeds: string[]
  blockers: string[]
  danger: string[]
  changedParts: string[]
  reason?: string
  allowKeepalive: boolean
  recentFamilies: string[]
  consecutiveKeepalives: number
  maxConsecutiveKeepalives: number
  viewerInput?: string
  lastFailureClass?: string
  lastActionOutcome?: string
}

export interface NarrationDecision {
  text: string
  speechIntent: NarrationIntent
  groundingSource: GroundingSource
  motifFamily: string
  templateFamily: string
  repetitionCooldownHit: boolean
  suppressedReason?: string
  isKeepalive: boolean
  noveltyScore: number
}

function sanitizeLabel(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized || fallback
}

const NEED_LABELS: Record<string, string> = {
  'logs': '原木',
  'crafting-table': '作業台',
  'stone-pickaxe': '石のツルハシ',
  'food-buffer': '食料の蓄え',
  'night-survival': '夜越えの足場',
  'furnace': 'かまど',
  'torches': '松明',
  'iron-ore': '鉄鉱石',
  'iron-ingots': '鉄インゴット',
  'obsidian': '黒曜石',
  'flint-and-steel': '火打石と打ち金',
  'nether-portal': 'ネザーゲート',
  'blaze-rods': 'ブレイズロッド',
  'ender-pearls': 'エンダーパール',
  'eyes-of-ender': 'エンダーアイ',
  'stronghold': '要塞',
  'diamond-loadout': 'ダイヤ装備一式',
}

function humanizeNeed(raw: string): string {
  const normalized = sanitizeLabel(raw, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
  return NEED_LABELS[normalized] || sanitizeLabel(raw, '次の一手')
}

function choosePrimaryNeed(needs: string[]): string {
  return humanizeNeed(needs[0] || '')
}

function chooseIntent(basis: NarrationBasis): { speechIntent: NarrationIntent, groundingSource: GroundingSource } {
  const reason = (basis.reason || '').toLowerCase()
  const changed = basis.changedParts.join(' ').toLowerCase()

  if (sanitizeLabel(basis.viewerInput || '', '').length > 0) {
    return { speechIntent: 'viewer-address', groundingSource: 'viewer-input' }
  }
  if (basis.danger.length > 0) {
    return { speechIntent: 'danger', groundingSource: 'danger' }
  }
  if (reason.includes('goal-result-failed') || reason.includes('stuck') || reason.includes('failed') || basis.blockers.length > 0) {
    return { speechIntent: reason.includes('recovery') || reason.includes('stuck') ? 'recovery' : 'failure', groundingSource: reason.includes('recovery') || reason.includes('stuck') ? 'recovery' : 'failure' }
  }
  if (reason.includes('goal-result-success')) {
    return { speechIntent: 'resolve', groundingSource: 'plan-delta' }
  }
  if (changed.includes('action:') || changed.includes('position moved')) {
    return { speechIntent: 'discovery', groundingSource: 'state-delta' }
  }
  if (reason.includes('goal-announcement') || reason.includes('periodic-progress')) {
    return { speechIntent: 'plan', groundingSource: 'plan-delta' }
  }
  if (reason.includes('periodic-idle') || reason.includes('voiced-keepalive')) {
    return { speechIntent: 'keepalive', groundingSource: 'explicit-keepalive' }
  }
  return { speechIntent: 'status', groundingSource: 'state-delta' }
}

function buildMotifFamily(intent: NarrationIntent, basis: NarrationBasis): string {
  const failureAnchor = intent === 'failure' || intent === 'recovery'
    ? sanitizeLabel(basis.lastFailureClass || basis.obstacle, '')
    : ''
  const primary = failureAnchor || basis.milestone || basis.actionLabel || basis.goalLabel
  return `${intent}:${sanitizeLabel(primary, 'default').toLowerCase()}`
}

function buildTemplateFamily(intent: NarrationIntent, groundingSource: GroundingSource, basis: NarrationBasis): string {
  if (intent === 'failure' || intent === 'recovery') {
    return `${intent}:${sanitizeLabel(basis.lastFailureClass || basis.obstacle, 'general').toLowerCase()}`
  }

  if (intent === 'viewer-address') {
    return 'viewer-address:viewer-input'
  }

  return `${intent}:${groundingSource}`
}

function isRepeatedFamily(basis: NarrationBasis, family: string): boolean {
  const recent = basis.recentFamilies.slice(-6)
  return recent.filter(entry => entry === family).length >= 2
}

function trimSpeech(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function shouldAvoidResolveNeedEcho(goal: string, need: string): boolean {
  const normalizedGoal = sanitizeLabel(goal, '')
    .toLowerCase()
    .replace(/\s+/g, '')
  const normalizedNeed = sanitizeLabel(need, '')
    .toLowerCase()
    .replace(/\s+/g, '')

  if (!normalizedGoal || !normalizedNeed) {
    return false
  }

  return normalizedGoal.includes(normalizedNeed) || normalizedNeed.includes(normalizedGoal)
}

function buildGroundedLine(
  basis: NarrationBasis,
  intent: NarrationIntent,
): string {
  const goal = sanitizeLabel(basis.goalLabel, '現在の目標')
  const action = sanitizeLabel(basis.actionLabel, '行動')
  const obstacle = sanitizeLabel(basis.obstacle, '障害')
  const need = choosePrimaryNeed(basis.unresolvedNeeds)
  const blocker = sanitizeLabel(basis.blockers[0] || '', '足場')
  const viewerInput = sanitizeLabel(basis.viewerInput || '', '')
  const failureClass = sanitizeLabel(basis.lastFailureClass || '', '')

  switch (intent) {
    case 'danger':
      return trimSpeech(`危険域だ。${need}より先に体勢を立て直す、この局面は無茶な術式を切らない。`)
    case 'failure':
      return trimSpeech(`${failureClass || obstacle}で術式が止まったか。だが${goal}の因果は捨てん、失敗を切り分けてやり直す。`)
    case 'recovery':
      return trimSpeech(`${failureClass || blocker}を見切った。${action}を引きずらず、${need}へ手順を切り替える。ここから立て直す。`)
    case 'resolve':
      if (shouldAvoidResolveNeedEcho(goal, need)) {
        return trimSpeech(`${goal}は通した。この成果を足場にして、次の工程へ切り替える。`)
      }
      return trimSpeech(`${goal}は通した。次は${need}だ、進行の術式はまだ止めない。`)
    case 'discovery':
      return trimSpeech(`${action}の流れが変わった。${goal}へ寄せながら${need}を回収する、今のうちに押し込む。`)
    case 'plan':
      return trimSpeech(`ここからは${goal}だ。${action}で道を開き、${need}を実務で揃える。`)
    case 'viewer-address':
      return trimSpeech(`${viewerInput || 'その声'}は拾った。だが今は${goal}を通しつつ、${need}まで実務で押し切る。`)
    case 'keepalive':
      return trimSpeech(`まだ${goal}の途中だ。${action}を切らさず、${obstacle}だけ潰して前へ出る。`)
    case 'status':
      return trimSpeech(`${goal}へ寄せ続ける。今は${action}を維持しつつ、${need}を外さない。`)
    default:
      return trimSpeech(`${goal}へ進む。${action}で状況を崩さず、次の${need}を拾う。`)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function buildNoveltyScore(
  basis: NarrationBasis,
  isKeepalive: boolean,
  repeatedFamily: boolean,
): number {
  let score = 1

  if (repeatedFamily) {
    score -= 0.35
  }
  if (isKeepalive) {
    score -= 0.2
  }
  if (basis.changedParts.length === 0) {
    score -= 0.1
  }
  if (sanitizeLabel(basis.viewerInput || '', '').length > 0) {
    score += 0.1
  }
  if (sanitizeLabel(basis.lastFailureClass || '', '').length > 0) {
    score += 0.05
  }

  return Number(clamp(score, 0, 1).toFixed(2))
}

export function buildDeterministicNarration(basis: NarrationBasis): NarrationDecision {
  const { speechIntent, groundingSource } = chooseIntent(basis)
  const motifFamily = buildMotifFamily(speechIntent, basis)
  const templateFamily = buildTemplateFamily(speechIntent, groundingSource, basis)
  const repeatedFamily = isRepeatedFamily(basis, motifFamily)
  const isKeepalive = speechIntent === 'keepalive'
  const noveltyScore = buildNoveltyScore(basis, isKeepalive, repeatedFamily)

  if (isKeepalive && !basis.allowKeepalive) {
    return {
      text: '',
      speechIntent,
      groundingSource,
      motifFamily,
      templateFamily,
      repetitionCooldownHit: true,
      suppressedReason: 'keepalive-not-allowed',
      isKeepalive,
      noveltyScore: 0,
    }
  }

  if (isKeepalive && basis.consecutiveKeepalives >= basis.maxConsecutiveKeepalives) {
    return {
      text: '',
      speechIntent,
      groundingSource,
      motifFamily,
      templateFamily,
      repetitionCooldownHit: true,
      suppressedReason: 'keepalive-limit',
      isKeepalive,
      noveltyScore: 0,
    }
  }

  if (repeatedFamily && isKeepalive) {
    return {
      text: '',
      speechIntent,
      groundingSource,
      motifFamily,
      templateFamily,
      repetitionCooldownHit: true,
      suppressedReason: 'keepalive-family-cooldown',
      isKeepalive,
      noveltyScore: 0,
    }
  }

  return {
    text: buildGroundedLine(basis, speechIntent),
    speechIntent,
    groundingSource,
    motifFamily,
    templateFamily,
    repetitionCooldownHit: repeatedFamily,
    isKeepalive,
    noveltyScore,
  }
}
