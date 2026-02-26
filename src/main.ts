import 'katex/dist/katex.min.css'

import { normalize, scale, vec } from './geometry'
import type { Halfspace, Vec2 } from './geometry'
import { computeProjectedStep } from './qp'
import { SceneRenderer } from './render'
import { UIController } from './ui'
import type { ProofFrameUi } from './ui'

const TRANSITION_MS = 4200
const PROJECTION_TOLERANCE = 1e-6
const OVERLOAD_THRESHOLD = 520

type StrategyId = 'raw' | 'safe' | 'hold'
type QueueMode = 'raw' | 'safe'

const DEFAULT_CONTROLS: ControlSnapshot = {
  pressure: 0.56,
  urgency: 0.58,
  strictness: 0.62,
}

const baseHalfspaces: Halfspace[] = [
  {
    id: 'g1',
    label: 'toxicity budget',
    normal: normalize(vec(0.94, 0.34)),
    bound: 0.44,
    active: true,
  },
  {
    id: 'g2',
    label: 'hallucination budget',
    normal: normalize(vec(0.24, 1)),
    bound: 0.39,
    active: true,
  },
  {
    id: 'g3',
    label: 'privacy guardrail',
    normal: normalize(vec(-0.92, 0.38)),
    bound: 0.54,
    active: true,
  },
  {
    id: 'g4',
    label: 'style drift guardrail',
    normal: normalize(vec(0.76, -0.65)),
    bound: 0.42,
    active: true,
  },
]

const BASE_BOUNDS = new Map<string, number>(baseHalfspaces.map((halfspace) => [halfspace.id, halfspace.bound]))

const STRICTNESS_SENSITIVITY: Record<string, number> = {
  g1: 0.9,
  g2: 1.1,
  g3: 0.75,
  g4: 1.4,
}

interface QueueOutcome {
  series: number[]
  peak: number
  breachMinutes: number
  escalations: number
}

interface ControlSnapshot {
  pressure: number
  urgency: number
  strictness: number
}

interface ScenarioSignals {
  eta: number
  gradient: Vec2
  strictnessScale: number
}

interface DeploymentDecision {
  ship: boolean
  reason: string
}

interface ScenarioEvaluation {
  controls: ControlSnapshot
  scenarioLabel: string
  halfspaces: Halfspace[]
  scenarioSignals: ScenarioSignals
  projectedStep: ReturnType<typeof computeProjectedStep>
  rawQueue: QueueOutcome
  safeQueue: QueueOutcome
  deployment: DeploymentDecision
  violatedRaw: number
  violatedSafe: number
  retainedValueRatio: number
  rawRiskRatio: number
  safeRiskRatio: number
  safeReadiness: number
}

interface StrategyAssessment {
  id: StrategyId
  label: string
  guardrailViolations: number
  queue: QueueOutcome
  retainedGainPct: number
  shippable: boolean
  status: string
  reason: string
  score: number
}

interface StrategyPack {
  strategies: StrategyAssessment[]
  recommendedId: StrategyId
  caption: string
  whyItems: string[]
  gateItems: string[]
  decisionTone: 'ship' | 'hold'
  decisionTitle: string
  decisionDetail: string
  readinessScore: number
  readinessNote: string
}

interface GuidanceBundle {
  recommendedControlsText: string
  actionItems: string[]
  memoText: string
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function copyHalfspaces(halfspaces: Halfspace[]): Halfspace[] {
  return halfspaces.map((halfspace) => ({
    ...halfspace,
    normal: { ...halfspace.normal },
  }))
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180
}

function percent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`
}

function scenarioFromControls(controls: ControlSnapshot): ScenarioSignals {
  const pressure = clamp01(controls.pressure)
  const urgency = clamp01(controls.urgency)
  const strictness = clamp01(controls.strictness)

  const eta = 0.45 + 2.35 * urgency + 0.78 * pressure
  const strictnessScale = 1.42 - 1.08 * strictness
  const angle = degreesToRadians(206 + pressure * 122 + urgency * 30 - strictness * 20)
  const magnitude = 0.84 + pressure * 1.65 + urgency * 1.12
  const gradient = scale(normalize(vec(Math.cos(angle), Math.sin(angle))), magnitude)

  return { eta, strictnessScale, gradient }
}

function boundScaleForStrictness(id: string, strictnessScale: number): number {
  const sensitivity = STRICTNESS_SENSITIVITY[id] ?? 0.7
  return clampRange(1 + sensitivity * (strictnessScale - 1), 0.24, 1.95)
}

function scenarioName(pressure: number): string {
  if (pressure < 0.38) {
    return 'normal traffic'
  }
  if (pressure < 0.75) {
    return 'spike traffic'
  }
  return 'incident traffic'
}

function simulateQueueOutcome(
  controls: ControlSnapshot,
  riskRatio: number,
  retainedValueRatio: number,
  mode: QueueMode,
): QueueOutcome {
  const minutes = 18
  const pressure = clamp01(controls.pressure)
  const urgency = clamp01(controls.urgency)
  const initialQueue = Math.round(185 + pressure * 132 + urgency * 42)
  const series: number[] = [initialQueue]

  for (let minute = 1; minute < minutes; minute += 1) {
    const pulse = 34 * Math.exp(-((minute - 8) ** 2) / 9)
    const arrivals = 318 + pressure * 176 + urgency * 58 + pulse

    const capacity =
      mode === 'raw'
        ? 392 + retainedValueRatio * 86 - riskRatio * 238 - pressure * 21
        : 392 + retainedValueRatio * 73 - riskRatio * 88 - pressure * 14

    const previous = series[minute - 1]
    series.push(Math.max(mode === 'raw' ? 66 : 58, previous + arrivals - capacity))
  }

  const peak = Math.round(Math.max(...series))
  const breachMinutes = series.filter((value) => value > OVERLOAD_THRESHOLD).length
  const overflow = series.reduce((sum, value) => sum + Math.max(0, value - OVERLOAD_THRESHOLD), 0)

  return {
    series,
    peak,
    breachMinutes,
    escalations: Math.round(breachMinutes * 16 + overflow / 34),
  }
}

function exportDecision(payload: Record<string, unknown>): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  link.href = url
  link.download = `safepatch-decision-${stamp}.json`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function deploymentDecision(
  projectedShipPossible: boolean,
  projectedReason: string | null,
  rawQueue: QueueOutcome,
  safeQueue: QueueOutcome,
  retainedValueRatio: number,
): DeploymentDecision {
  if (!projectedShipPossible) {
    return {
      ship: false,
      reason: projectedReason ?? 'No safe correction exists under the current policy limits.',
    }
  }

  if (retainedValueRatio < 0.42) {
    return {
      ship: false,
      reason: `Correction keeps only ${Math.round(retainedValueRatio * 100)}% of intended gain, so value is too low.`,
    }
  }

  if (safeQueue.breachMinutes >= rawQueue.breachMinutes && safeQueue.escalations >= rawQueue.escalations) {
    return {
      ship: false,
      reason: 'Correction is safe but does not lower production risk enough.',
    }
  }

  return {
    ship: true,
    reason: 'Safe correction keeps value and lowers expected incident pressure.',
  }
}

function scoreSafeReadiness(
  deployment: DeploymentDecision,
  rawQueue: QueueOutcome,
  safeQueue: QueueOutcome,
  safeRiskRatio: number,
  retainedValueRatio: number,
  violatedSafe: number,
): number {
  const escalationDropRatio = (rawQueue.escalations - safeQueue.escalations) / Math.max(rawQueue.escalations, 1)
  const breachDropRatio = (rawQueue.breachMinutes - safeQueue.breachMinutes) / Math.max(rawQueue.breachMinutes, 1)
  const peakDropRatio = (rawQueue.peak - safeQueue.peak) / Math.max(rawQueue.peak, 1)

  const riskClearance = clamp01(1 - safeRiskRatio * 2.2)
  const retentionScore = clamp01(retainedValueRatio)

  let score =
    100 *
    (0.34 * riskClearance +
      0.24 * clampRange(escalationDropRatio, 0, 1) +
      0.14 * clampRange(breachDropRatio, 0, 1) +
      0.08 * clampRange(peakDropRatio, 0, 1) +
      0.2 * retentionScore)

  if (!deployment.ship) {
    score *= 0.72
  }

  if (violatedSafe > 0) {
    score = Math.min(score, 44)
  }

  return Math.round(clampRange(score, 0, 100))
}

function evaluateScenario(controls: ControlSnapshot): ScenarioEvaluation {
  const normalizedControls: ControlSnapshot = {
    pressure: clamp01(controls.pressure),
    urgency: clamp01(controls.urgency),
    strictness: clamp01(controls.strictness),
  }

  const scenarioSignals = scenarioFromControls(normalizedControls)
  const halfspaces = copyHalfspaces(baseHalfspaces)

  for (const halfspace of halfspaces) {
    const baseBound = BASE_BOUNDS.get(halfspace.id)
    if (baseBound === undefined) {
      continue
    }

    const scaledBound = baseBound * boundScaleForStrictness(halfspace.id, scenarioSignals.strictnessScale)
    const pressurePenalty =
      normalizedControls.pressure * normalizedControls.strictness * (halfspace.id === 'g2' ? 0.24 : 0.2)

    halfspace.bound = scaledBound - pressurePenalty
    halfspace.active = true
  }

  const projectedStep = computeProjectedStep({
    gradient: scenarioSignals.gradient,
    eta: scenarioSignals.eta,
    halfspaces,
    tolerance: PROJECTION_TOLERANCE,
  })

  const largestBudget = Math.max(0.1, ...halfspaces.map((halfspace) => Math.abs(halfspace.bound)))
  const rawRiskRatio = Math.max(0, projectedStep.maxViolationStep0) / largestBudget
  const safeRiskRatio = Math.max(0, projectedStep.maxViolationProjected) / largestBudget
  const retainedValueRatio = clampRange(projectedStep.descentRetainedRatio, 0, 1.5)

  const rawQueue = simulateQueueOutcome(normalizedControls, rawRiskRatio, 1, 'raw')
  const safeQueue = simulateQueueOutcome(normalizedControls, safeRiskRatio, retainedValueRatio, 'safe')

  const deployment = deploymentDecision(projectedStep.ship, projectedStep.reason, rawQueue, safeQueue, retainedValueRatio)

  const violatedRaw = projectedStep.diagnostics.filter(
    (diagnostic) => diagnostic.active && diagnostic.violationStep0 > PROJECTION_TOLERANCE,
  ).length
  const violatedSafe = projectedStep.diagnostics.filter(
    (diagnostic) => diagnostic.active && diagnostic.violationProjected > PROJECTION_TOLERANCE,
  ).length

  const safeReadiness = scoreSafeReadiness(
    deployment,
    rawQueue,
    safeQueue,
    safeRiskRatio,
    retainedValueRatio,
    violatedSafe,
  )

  return {
    controls: normalizedControls,
    scenarioLabel: scenarioName(normalizedControls.pressure),
    halfspaces,
    scenarioSignals,
    projectedStep,
    rawQueue,
    safeQueue,
    deployment,
    violatedRaw,
    violatedSafe,
    retainedValueRatio,
    rawRiskRatio,
    safeRiskRatio,
    safeReadiness,
  }
}

function optimizationObjective(evaluation: ScenarioEvaluation): number {
  const escalationsSaved = evaluation.rawQueue.escalations - evaluation.safeQueue.escalations
  const breachSaved = evaluation.rawQueue.breachMinutes - evaluation.safeQueue.breachMinutes
  const peakSaved = evaluation.rawQueue.peak - evaluation.safeQueue.peak

  const shipBonus = evaluation.deployment.ship ? 16 : 0
  const violationPenalty = evaluation.violatedSafe > 0 ? 34 : 0
  const retentionPenalty = Math.max(0, 0.55 - evaluation.retainedValueRatio) * 45

  return (
    evaluation.safeReadiness +
    shipBonus +
    escalationsSaved * 0.12 +
    breachSaved * 1.4 +
    peakSaved * 0.03 -
    violationPenalty -
    retentionPenalty
  )
}

function findBestControls(pressure: number, current: ControlSnapshot): ScenarioEvaluation {
  let best = evaluateScenario(current)
  let bestScore = optimizationObjective(best)
  let bestDistance = Number.POSITIVE_INFINITY

  for (let urgencyStep = 24; urgencyStep <= 96; urgencyStep += 4) {
    for (let strictnessStep = 24; strictnessStep <= 96; strictnessStep += 4) {
      const candidateControls: ControlSnapshot = {
        pressure,
        urgency: urgencyStep / 100,
        strictness: strictnessStep / 100,
      }

      const candidate = evaluateScenario(candidateControls)
      const candidateScore = optimizationObjective(candidate)
      const candidateDistance =
        Math.abs(candidate.controls.urgency - current.urgency) +
        Math.abs(candidate.controls.strictness - current.strictness)

      const better = candidateScore > bestScore + 0.0001
      const tieBreak = Math.abs(candidateScore - bestScore) <= 0.0001 && candidateDistance < bestDistance

      if (better || tieBreak) {
        best = candidate
        bestScore = candidateScore
        bestDistance = candidateDistance
      }
    }
  }

  return best
}

function scoreStrategy(base: Omit<StrategyAssessment, 'score'>, controls: ControlSnapshot): number {
  let score = 100

  score -= base.guardrailViolations * 28
  score -= base.queue.breachMinutes * 2.15
  score -= base.queue.escalations * 0.09
  score += base.retainedGainPct * 0.18

  if (base.id === 'hold') {
    score -= controls.urgency * 24
  }

  if (base.id === 'raw' && base.guardrailViolations > 0) {
    score -= 42
  }

  if (base.id === 'safe' && !base.shippable) {
    score -= 20
  }

  return Math.round(clampRange(score, 0, 100))
}

function getStrategy(strategies: StrategyAssessment[], id: StrategyId): StrategyAssessment {
  const strategy = strategies.find((item) => item.id === id)
  if (!strategy) {
    throw new Error(`Missing strategy ${id}`)
  }
  return strategy
}

function selectRecommendedStrategy(strategies: StrategyAssessment[]): StrategyId {
  const raw = getStrategy(strategies, 'raw')
  const safe = getStrategy(strategies, 'safe')
  const hold = getStrategy(strategies, 'hold')

  let recommended = safe.shippable ? safe : hold

  if (hold.score >= recommended.score + 3) {
    recommended = hold
  }

  if (raw.shippable && raw.score >= Math.max(safe.score, hold.score) + 7) {
    recommended = raw
  }

  return recommended.id
}

function buildStrategyPack(evaluation: ScenarioEvaluation): StrategyPack {
  const holdQueue = simulateQueueOutcome(evaluation.controls, 0, 0, 'safe')

  const baseStrategies: Array<Omit<StrategyAssessment, 'score'>> = [
    {
      id: 'raw',
      label: 'Raw patch',
      guardrailViolations: evaluation.violatedRaw,
      queue: evaluation.rawQueue,
      retainedGainPct: 100,
      shippable: evaluation.violatedRaw === 0,
      status: evaluation.violatedRaw === 0 ? 'Shippable' : 'Unsafe',
      reason:
        evaluation.violatedRaw === 0
          ? 'Raw patch already stays inside policy limits.'
          : `Raw patch violates ${evaluation.violatedRaw} guardrail(s).`,
    },
    {
      id: 'safe',
      label: 'SafePatch projection',
      guardrailViolations: evaluation.violatedSafe,
      queue: evaluation.safeQueue,
      retainedGainPct: Math.round(clampRange(evaluation.retainedValueRatio, 0, 1.4) * 100),
      shippable: evaluation.deployment.ship && evaluation.violatedSafe === 0,
      status: evaluation.deployment.ship ? 'Preferred' : 'Needs tuning',
      reason: evaluation.deployment.reason,
    },
    {
      id: 'hold',
      label: 'Hold deployment',
      guardrailViolations: 0,
      queue: holdQueue,
      retainedGainPct: 0,
      shippable: false,
      status: 'No rollout',
      reason: 'No model change reaches production users.',
    },
  ]

  const strategies = baseStrategies.map((base) => ({
    ...base,
    score: scoreStrategy(base, evaluation.controls),
  }))

  const recommendedId = selectRecommendedStrategy(strategies)
  const recommended = getStrategy(strategies, recommendedId)
  const raw = getStrategy(strategies, 'raw')
  const safe = getStrategy(strategies, 'safe')

  const escalationDelta = raw.queue.escalations - recommended.queue.escalations
  const breachDelta = raw.queue.breachMinutes - recommended.queue.breachMinutes

  const caption = `Recommended: ${recommended.label}. Predicted escalations ${raw.queue.escalations} -> ${recommended.queue.escalations}.`

  const whyItems: string[] = []
  if (recommendedId === 'safe') {
    whyItems.push(`Guardrail violations drop ${evaluation.violatedRaw} -> ${evaluation.violatedSafe} with SafePatch.`)
    whyItems.push(`Expected escalations improve ${raw.queue.escalations} -> ${safe.queue.escalations} under identical traffic.`)
    whyItems.push(`Projected patch retains ${Math.round(evaluation.retainedValueRatio * 100)}% of intended fix value.`)
  } else if (recommendedId === 'hold') {
    whyItems.push(`Safe deployment is not yet defensible: ${safe.reason.toLowerCase()}`)
    whyItems.push(`Holding avoids shipping ${evaluation.violatedRaw} raw guardrail violation(s) under ${evaluation.scenarioLabel}.`)
    whyItems.push('Use Auto-tune to search a safer operating point before the next release window.')
  } else {
    whyItems.push('Raw patch already satisfies all active guardrails in this operating point.')
    whyItems.push(`Raw rollout has stronger queue improvement than projection for current settings.`)
    whyItems.push('SafePatch still provides an auditable fallback if traffic pressure increases.')
  }

  const gateItems: string[] = []
  if (recommendedId === 'hold') {
    gateItems.push('Gate 0: Do not deploy this patch. Keep current production model.')
    gateItems.push(
      `Gate 1: Re-evaluate only after predicted breach minutes drop below ${Math.max(2, safe.queue.breachMinutes - 2)}.`,
    )
    gateItems.push(
      `Gate 2: Require SafePatch readiness >= ${Math.max(70, safe.score)} and zero projected guardrail violations.`,
    )
  } else {
    const firstGate = recommendedId === 'raw' ? 15 : 10
    const secondGate = recommendedId === 'raw' ? 45 : 35
    gateItems.push(
      `Gate 1: ${firstGate}% canary for 3 minutes. Abort if queue exceeds ${OVERLOAD_THRESHOLD} for 2 consecutive minutes.`,
    )
    gateItems.push(`Gate 2: Raise to ${secondGate}% for 5 minutes if no guardrail alarms fire.`)
    gateItems.push('Gate 3: 100% rollout with on-call watch and rollback hook armed for 15 minutes.')
  }

  let decisionTone: 'ship' | 'hold' = 'ship'
  let decisionTitle = 'Ship recommended strategy'
  let decisionDetail = `Recommendation: ${recommended.label}.`

  if (recommendedId === 'hold') {
    decisionTone = 'hold'
    decisionTitle = 'Hold deployment'
    decisionDetail = `Do not ship now. ${safe.reason}`
  } else if (recommendedId === 'safe') {
    decisionTitle = 'Ship SafePatch projection'
    decisionDetail =
      escalationDelta > 0 || breachDelta > 0
        ? `Safe projection reduces incident pressure (${Math.max(escalationDelta, 0)} fewer escalations).`
        : safe.reason
  } else {
    decisionTitle = 'Ship raw patch (already safe)'
    decisionDetail = 'Raw patch is guardrail-safe in this operating point. Keep SafePatch as fallback.'
  }

  let readinessNote = 'Operational readiness is moderate.'
  if (recommendedId === 'hold') {
    readinessNote = 'Hold: current options do not clear risk and value thresholds simultaneously.'
  } else if (recommended.score >= 84) {
    readinessNote = 'High confidence: rollout can proceed through staged canary gates.'
  } else if (recommended.score >= 68) {
    readinessNote = 'Conditional ship: proceed with strict queue and policy monitoring.'
  } else {
    readinessNote = 'Borderline ship: proceed only if rollback triggers are fully staffed.'
  }

  return {
    strategies,
    recommendedId,
    caption,
    whyItems,
    gateItems,
    decisionTone,
    decisionTitle,
    decisionDetail,
    readinessScore: recommended.score,
    readinessNote,
  }
}

function buildGuidance(
  current: ScenarioEvaluation,
  recommendedControls: ScenarioEvaluation,
  strategyPack: StrategyPack,
): GuidanceBundle {
  const nearRecommendation =
    Math.abs(current.controls.urgency - recommendedControls.controls.urgency) < 0.02 &&
    Math.abs(current.controls.strictness - recommendedControls.controls.strictness) < 0.02

  const recommendedControlsText = nearRecommendation
    ? `Current settings are close to optimal for ${current.scenarioLabel}.`
    : `Suggested controls for ${current.scenarioLabel}: urgency ${percent(recommendedControls.controls.urgency)}, strictness ${percent(recommendedControls.controls.strictness)}.`

  const recommendedStrategy = getStrategy(strategyPack.strategies, strategyPack.recommendedId)

  const actionItems: string[] = []
  if (strategyPack.recommendedId === 'hold') {
    actionItems.push('Do not deploy this patch in the current incident window.')
    actionItems.push(
      `Apply suggested controls (urgency ${percent(recommendedControls.controls.urgency)}, strictness ${percent(recommendedControls.controls.strictness)}) and re-evaluate.`,
    )
    actionItems.push('Escalate to release manager with exported decision and hold rationale.')
  } else {
    actionItems.push(`Deploy ${recommendedStrategy.label.toLowerCase()} using staged canary gates.`)
    actionItems.push(`Primary rollback trigger: queue > ${OVERLOAD_THRESHOLD} for 2 consecutive minutes.`)
    actionItems.push('Post release memo and JSON decision artifact in the release ticket.')
  }

  const rowsText = strategyPack.strategies
    .map(
      (strategy) =>
        `${strategy.label}: guardrails ${strategy.guardrailViolations}, peak ${strategy.queue.peak}, breach ${strategy.queue.breachMinutes}, escalations ${strategy.queue.escalations}, readiness ${strategy.score}/100.`,
    )
    .join(' ')

  const memoText = [
    `SafePatch recommendation: ${strategyPack.decisionTone === 'ship' ? 'SHIP' : 'HOLD'}.`,
    `Chosen strategy: ${recommendedStrategy.label}.`,
    `Scenario: ${current.scenarioLabel}. Controls: urgency ${percent(current.controls.urgency)}, strictness ${percent(current.controls.strictness)}.`,
    rowsText,
    `Decision rationale: ${strategyPack.decisionDetail}`,
  ].join(' ')

  return {
    recommendedControlsText,
    actionItems,
    memoText,
  }
}

function toFrameUi(current: ScenarioEvaluation, strategyPack: StrategyPack, guidance: GuidanceBundle): ProofFrameUi {
  const activeChecks = current.halfspaces.filter((halfspace) => halfspace.active).length
  const rawPassed = Math.max(0, activeChecks - current.violatedRaw)
  const safePassed = Math.max(0, activeChecks - current.violatedSafe)
  const rawStrategy = getStrategy(strategyPack.strategies, 'raw')
  const chosenStrategy = getStrategy(strategyPack.strategies, strategyPack.recommendedId)

  const stageCaptionText =
    current.violatedRaw > 0
      ? `Raw step fails ${current.violatedRaw} check(s) -> projection reaches ${safePassed}/${activeChecks} checks passed.`
      : `Raw step is already feasible -> SafePatch confirms ${safePassed}/${activeChecks} checks passed.`

  return {
    decisionTone: strategyPack.decisionTone,
    decisionTitle: strategyPack.decisionTitle,
    decisionDetail: strategyPack.decisionDetail,
    readinessScoreText: strategyPack.readinessScore.toString(),
    readinessNote: strategyPack.readinessNote,
    checksPassedText: `${rawPassed}/${activeChecks} -> ${safePassed}/${activeChecks}`,
    queuePeakText: `${rawStrategy.queue.peak.toLocaleString()} -> ${chosenStrategy.queue.peak.toLocaleString()}`,
    recommendedControlsText: guidance.recommendedControlsText,
    retainedValueText: `${Math.round(clampRange(current.retainedValueRatio, 0, 1.4) * 100)}%`,
    stageCaptionText,
    whyItems: strategyPack.whyItems,
    gateItems: strategyPack.gateItems,
    actionItems: guidance.actionItems,
    memoText: guidance.memoText,
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  const normalized = text.trim()
  if (!normalized) {
    return false
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalized)
      return true
    } catch {
      // Continue to DOM copy fallback.
    }
  }

  const helper = document.createElement('textarea')
  helper.value = normalized
  helper.setAttribute('readonly', 'true')
  helper.style.position = 'fixed'
  helper.style.opacity = '0'
  document.body.appendChild(helper)
  helper.focus()
  helper.select()

  let succeeded = false
  try {
    succeeded = document.execCommand('copy')
  } catch {
    succeeded = false
  }

  document.body.removeChild(helper)
  return succeeded
}

function start(): void {
  const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement | null
  if (!canvas) {
    throw new Error('Missing canvas #scene-canvas')
  }

  const renderer = new SceneRenderer(canvas)
  const ui = new UIController()

  let currentEvaluation = evaluateScenario(DEFAULT_CONTROLS)
  let recommendedEvaluation = findBestControls(currentEvaluation.controls.pressure, currentEvaluation.controls)
  let strategyPack = buildStrategyPack(currentEvaluation)
  let guidance = buildGuidance(currentEvaluation, recommendedEvaluation, strategyPack)
  let transitionStart = performance.now()
  let latestDecision: Record<string, unknown> = {}
  let controlsPending = false

  function applyControls(): void {
    const controls = ui.readControlValues()
    currentEvaluation = evaluateScenario(controls)
    recommendedEvaluation = findBestControls(currentEvaluation.controls.pressure, currentEvaluation.controls)
    strategyPack = buildStrategyPack(currentEvaluation)
    guidance = buildGuidance(currentEvaluation, recommendedEvaluation, strategyPack)

    ui.renderFrame(toFrameUi(currentEvaluation, strategyPack, guidance))

    const strategyMatrix = Object.fromEntries(
      strategyPack.strategies.map((strategy) => [
        strategy.id,
        {
          label: strategy.label,
          guardrail_violations: strategy.guardrailViolations,
          peak_queue: strategy.queue.peak,
          breach_minutes: strategy.queue.breachMinutes,
          escalations: strategy.queue.escalations,
          retained_gain_pct: strategy.retainedGainPct,
          readiness_score: strategy.score,
          status: strategy.status,
        },
      ]),
    )

    latestDecision = {
      generated_at: new Date().toISOString(),
      scenario: currentEvaluation.scenarioLabel,
      controls: {
        pressure: Number(currentEvaluation.controls.pressure.toFixed(4)),
        urgency: Number(currentEvaluation.controls.urgency.toFixed(4)),
        strictness: Number(currentEvaluation.controls.strictness.toFixed(4)),
      },
      recommendation: {
        decision: strategyPack.decisionTone === 'ship' ? 'ship' : 'hold',
        strategy_id: strategyPack.recommendedId,
        title: strategyPack.decisionTitle,
        detail: strategyPack.decisionDetail,
        readiness_score: strategyPack.readinessScore,
      },
      strategy_matrix: strategyMatrix,
      why_recommended: strategyPack.whyItems,
      rollout_playbook: strategyPack.gateItems,
      actions: guidance.actionItems,
      suggested_controls: {
        urgency: Number(recommendedEvaluation.controls.urgency.toFixed(4)),
        strictness: Number(recommendedEvaluation.controls.strictness.toFixed(4)),
      },
      method_signals: {
        eta: Number(currentEvaluation.scenarioSignals.eta.toFixed(4)),
        strictness_scale: Number(currentEvaluation.scenarioSignals.strictnessScale.toFixed(4)),
        raw_risk_ratio: Number(currentEvaluation.rawRiskRatio.toFixed(4)),
        safe_risk_ratio: Number(currentEvaluation.safeRiskRatio.toFixed(4)),
        retained_gain_ratio: Number(currentEvaluation.retainedValueRatio.toFixed(4)),
        active_constraints: currentEvaluation.projectedStep.activeSetIds,
        max_violation_raw: Number(currentEvaluation.projectedStep.maxViolationStep0.toFixed(4)),
        max_violation_projected: Number(currentEvaluation.projectedStep.maxViolationProjected.toFixed(4)),
      },
    }

    transitionStart = performance.now()
    controlsPending = false
    ui.setRunPending(false)
  }

  function markControlsPending(): void {
    controlsPending = true
    ui.setRunPending(true)
  }

  function frame(now: number): void {
    const progress = clamp01((now - transitionStart) / TRANSITION_MS)

    const rawStrategy = getStrategy(strategyPack.strategies, 'raw')
    const targetStrategy = getStrategy(strategyPack.strategies, strategyPack.recommendedId)

    renderer.render({
      halfspaces: copyHalfspaces(currentEvaluation.halfspaces),
      step0: currentEvaluation.projectedStep.step0,
      projectedStep: currentEvaluation.projectedStep.projectedStep,
      gradient: currentEvaluation.scenarioSignals.gradient,
      queueRawSeries: rawStrategy.queue.series,
      queueSafeSeries: targetStrategy.queue.series,
      overloadThreshold: OVERLOAD_THRESHOLD,
      transitionProgress: progress,
      clockMs: now,
      constraintDiagnostics: currentEvaluation.projectedStep.diagnostics,
      activeSetIds: currentEvaluation.projectedStep.activeSetIds,
    })

    requestAnimationFrame(frame)
  }

  ui.onControlsChange(() => {
    markControlsPending()
  })

  ui.onRunCheck(() => {
    if (!controlsPending) {
      transitionStart = performance.now()
      return
    }
    applyControls()
  })

  ui.onAutoTune(() => {
    const tuned = findBestControls(currentEvaluation.controls.pressure, currentEvaluation.controls)
    ui.setControlValues({ urgency: tuned.controls.urgency, strictness: tuned.controls.strictness })
    markControlsPending()
  })

  ui.onReset(() => {
    ui.setControlValues(DEFAULT_CONTROLS)
    markControlsPending()
  })

  ui.onReplay(() => {
    transitionStart = performance.now()
  })

  ui.onCopyMemo((memoText) => copyToClipboard(memoText))

  ui.onExport(() => {
    exportDecision(latestDecision)
  })

  window.addEventListener('resize', () => {
    renderer.resize()
  })

  renderer.resize()
  ui.setControlValues(DEFAULT_CONTROLS)
  applyControls()
  requestAnimationFrame(frame)
}

start()
