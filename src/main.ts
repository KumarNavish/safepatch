import 'katex/dist/katex.min.css'

import { normalize, scale, vec, worldBoundsFromHalfspaces } from './geometry'
import type { Halfspace, Vec2 } from './geometry'
import { computeProjectedStep } from './qp'
import type { ProjectionResult } from './qp'
import { SceneRenderer } from './render'
import { UIController } from './ui'
import type { DetailFrameUi, ForceBarUi, MathTermUi, OutcomeFrameUi, PresetId, SceneMode } from './ui'

const ETA = 1
const PROJECTION_TOLERANCE = 1e-6
const UPDATE_ANIMATION_MS = 320
const DRAG_ANIMATION_MS = 90
const MODE_ANIMATION_MS = 220
const TEACHING_ANIMATION_MS = 3400
const MAX_RAW_RADIUS_FACTOR = 1.25

const CONSTRAINT_PALETTE = ['#ef6f8f', '#4f8dff', '#18a28c', '#f0a941', '#7b5dde', '#2ea5a2']

interface PresetConfig {
  id: PresetId
  pressure: number
  note: string
}

const PRESETS: Record<PresetId, PresetConfig> = {
  normal: {
    id: 'normal',
    pressure: 0.24,
    note: 'Normal traffic: most proposals can ship with modest correction.',
  },
  spike: {
    id: 'spike',
    pressure: 0.56,
    note: 'Traffic spike: guardrails push harder and unsafe components are trimmed more aggressively.',
  },
  incident: {
    id: 'incident',
    pressure: 0.9,
    note: 'Live incident: only tightly certified movement should ship.',
  },
}

const BASE_HALFSPACES: Halfspace[] = [
  {
    id: 'g1',
    label: 'abuse leakage',
    normal: normalize(vec(0.94, 0.34)),
    bound: 0.72,
    active: true,
  },
  {
    id: 'g2',
    label: 'on-call alert rate',
    normal: normalize(vec(0.26, 1)),
    bound: 0.66,
    active: true,
  },
  {
    id: 'g3',
    label: 'sla latency risk',
    normal: normalize(vec(-0.89, 0.46)),
    bound: 0.73,
    active: true,
  },
  {
    id: 'g4',
    label: 'false-positive impact',
    normal: normalize(vec(0.73, -0.68)),
    bound: 0.64,
    active: true,
  },
]

const BASE_BOUNDS = new Map<string, number>(BASE_HALFSPACES.map((halfspace) => [halfspace.id, halfspace.bound]))

const TIGHTNESS_SENSITIVITY: Record<string, number> = {
  g1: 0.86,
  g2: 1.08,
  g3: 0.74,
  g4: 1.2,
}

const PRESSURE_PENALTY: Record<string, number> = {
  g1: 0.11,
  g2: 0.16,
  g3: 0.1,
  g4: 0.13,
}

interface InteractiveState {
  presetId: PresetId
  pressure: number
  tightness: number
  mode: SceneMode
  rawStep: Vec2
}

interface Evaluation {
  state: InteractiveState
  halfspaces: Halfspace[]
  projection: ProjectionResult
  rawViolationCount: number
  safeViolationCount: number
  activeCheckCount: number
  checksRawPassed: number
  checksSafePassed: number
  rawRisk: number
  safeRisk: number
  queueRawPeak: number
  queueSafePeak: number
  retainedGain: number
  correctionNorm: number
  correctionNormRatio: number
  queuePeakDelta: number
  riskDropPct: number
  dominantConstraintLabel: string | null
  decisionTone: 'ship' | 'hold'
  decisionTitle: string
  decisionDetail: string
  readiness: number
  whyItems: string[]
  actionItems: string[]
  memoText: string
}

interface RetargetOptions {
  stopTeaching?: boolean
  durationMs?: number
  immediate?: boolean
}

const DEFAULT_STATE: InteractiveState = {
  presetId: 'spike',
  pressure: PRESETS.spike.pressure,
  tightness: 0.62,
  mode: 'geometry',
  rawStep: vec(1.05, 0.62),
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max)
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function easeOutCubic(value: number): number {
  const t = clamp(value)
  return 1 - (1 - t) ** 3
}

function cloneState(state: InteractiveState): InteractiveState {
  return {
    presetId: state.presetId,
    pressure: state.pressure,
    tightness: state.tightness,
    mode: state.mode,
    rawStep: { ...state.rawStep },
  }
}

function lerpState(from: InteractiveState, to: InteractiveState, progress: number): InteractiveState {
  return {
    presetId: to.presetId,
    pressure: from.pressure + (to.pressure - from.pressure) * progress,
    tightness: from.tightness + (to.tightness - from.tightness) * progress,
    mode: to.mode,
    rawStep: {
      x: from.rawStep.x + (to.rawStep.x - from.rawStep.x) * progress,
      y: from.rawStep.y + (to.rawStep.y - from.rawStep.y) * progress,
    },
  }
}

function copyHalfspaces(halfspaces: Halfspace[]): Halfspace[] {
  return halfspaces.map((halfspace) => ({
    ...halfspace,
    normal: { ...halfspace.normal },
  }))
}

function buildHalfspaces(pressure: number, tightness: number): Halfspace[] {
  const strictness = clamp01(tightness)
  const pressureClamped = clamp01(pressure)
  const strictnessScale = 1.24 - strictness * 0.9

  return BASE_HALFSPACES.map((halfspace) => {
    const baseBound = BASE_BOUNDS.get(halfspace.id) ?? halfspace.bound
    const sensitivity = TIGHTNESS_SENSITIVITY[halfspace.id] ?? 0.8
    const pressurePenalty = PRESSURE_PENALTY[halfspace.id] ?? 0.1

    const strictnessShift = 1 + sensitivity * (strictnessScale - 1)
    const adjusted = baseBound * strictnessShift - pressureClamped * pressurePenalty

    return {
      ...halfspace,
      normal: { ...halfspace.normal },
      bound: Math.max(0.16, adjusted),
      active: true,
    }
  })
}

function scenarioEvaluation(state: InteractiveState): Evaluation {
  const normalizedState: InteractiveState = {
    ...state,
    pressure: clamp01(state.pressure),
    tightness: clamp01(state.tightness),
    rawStep: { ...state.rawStep },
  }

  const halfspaces = buildHalfspaces(normalizedState.pressure, normalizedState.tightness)
  const gradient = scale(normalizedState.rawStep, -1 / ETA)

  const projection = computeProjectedStep({
    gradient,
    eta: ETA,
    halfspaces,
    tolerance: PROJECTION_TOLERANCE,
  })

  const activeCheckCount = halfspaces.filter((halfspace) => halfspace.active).length

  const rawViolationCount = projection.diagnostics.filter(
    (diagnostic) => diagnostic.active && diagnostic.violationStep0 > PROJECTION_TOLERANCE,
  ).length

  const safeViolationCount = projection.diagnostics.filter(
    (diagnostic) => diagnostic.active && diagnostic.violationProjected > PROJECTION_TOLERANCE,
  ).length

  const checksRawPassed = Math.max(0, activeCheckCount - rawViolationCount)
  const checksSafePassed = Math.max(0, activeCheckCount - safeViolationCount)

  const maxBound = Math.max(0.12, ...halfspaces.map((halfspace) => Math.abs(halfspace.bound)))
  const rawRisk = clampRange(Math.max(0, projection.maxViolationStep0) / maxBound, 0, 2)
  const safeRisk = clampRange(Math.max(0, projection.maxViolationProjected) / maxBound, 0, 2)
  const retainedGain = clampRange(projection.descentRetainedRatio, 0, 1.2)

  const correctionVector = {
    x: projection.step0.x - projection.projectedStep.x,
    y: projection.step0.y - projection.projectedStep.y,
  }
  const correctionNorm = Math.hypot(correctionVector.x, correctionVector.y)
  const rawNorm = Math.max(1e-6, Math.hypot(projection.step0.x, projection.step0.y))
  const correctionNormRatio = clampRange(correctionNorm / rawNorm, 0, 2)

  const baseQueue = 160 + normalizedState.pressure * 340 + normalizedState.tightness * 52
  const queueRawPeak = Math.round(clampRange(baseQueue + rawRisk * 360 + (1 - retainedGain) * 42, 80, 3800))
  const queueSafePeak = Math.round(clampRange(baseQueue + safeRisk * 180 + (1 - retainedGain) * 62 - 54, 60, 3800))
  const queuePeakDelta = queueRawPeak - queueSafePeak
  const riskDropPct = clampRange(((rawRisk - safeRisk) / Math.max(rawRisk, 0.05)) * 100, -200, 100)

  let decisionTone: 'ship' | 'hold' = 'ship'
  let decisionTitle = 'Ship: certified patch is ready for canary'
  let decisionDetail = 'All active checks pass while preserving meaningful product value.'

  if (!projection.ship) {
    decisionTone = 'hold'
    decisionTitle = 'Hold: no certifiable direction in current envelope'
    decisionDetail = projection.reason ?? 'No feasible patch exists under active guardrails.'
  } else if (safeViolationCount > 0) {
    decisionTone = 'hold'
    decisionTitle = 'Hold: projected patch still violates guardrails'
    decisionDetail = `Projected direction still fails ${safeViolationCount} active check${safeViolationCount > 1 ? 's' : ''}.`
  } else if (retainedGain < 0.34) {
    decisionTone = 'hold'
    decisionTitle = 'Hold: correction removes too much useful impact'
    decisionDetail = `Only ${Math.round(retainedGain * 100)}% of intended gain remains after correction.`
  }

  const queueImprovementRatio = clampRange((queueRawPeak - queueSafePeak) / Math.max(queueRawPeak, 1), -0.4, 1)
  const queueScore = clamp01((queueImprovementRatio + 0.4) / 1.4)
  const riskScore = clamp01(1 - safeRisk)
  const retentionScore = clamp01(retainedGain)

  let readiness = 100 * (0.42 * riskScore + 0.33 * retentionScore + 0.25 * queueScore)
  if (decisionTone === 'hold') {
    readiness *= 0.74
  }
  readiness = Math.round(clampRange(readiness, 0, 100))

  const activeLabels = projection.activeSetIds
    .map((id) => halfspaces.find((halfspace) => halfspace.id === id)?.label)
    .filter((value): value is string => typeof value === 'string')

  const dominantConstraintId = projection.activeSetIds
    .slice()
    .sort((a, b) => (projection.lambdaById[b] ?? 0) - (projection.lambdaById[a] ?? 0))[0]

  const dominantConstraintLabel = dominantConstraintId
    ? halfspaces.find((halfspace) => halfspace.id === dominantConstraintId)?.label ?? dominantConstraintId
    : null

  const whyItems: string[] = [
    `Checks improved from ${checksRawPassed}/${activeCheckCount} to ${checksSafePassed}/${activeCheckCount}.`,
    activeLabels.length > 0
      ? `Most correction pressure came from ${activeLabels.join(', ')}.`
      : 'No correction pressure: the proposal was already inside guardrails.',
    `Projected patch keeps ${Math.round(retainedGain * 100)}% intended gain after trimming ${Math.round(correctionNormRatio * 100)}%.`,
    `Incident forecast moved ${queueRawPeak.toLocaleString()} -> ${queueSafePeak.toLocaleString()}.`,
  ]

  const actionItems: string[] =
    decisionTone === 'ship'
      ? [
          'Ship with staged canary and monitor first 15 minutes.',
          'Watch top pressure guardrail during rollout.',
          'Keep automated rollback armed until stability confirms.',
        ]
      : [
          'Do not ship this patch direction yet.',
          dominantConstraintLabel
            ? `Drag away from "${dominantConstraintLabel}" pressure until trim decreases.`
            : 'Drag proposal back toward the feasible zone and retry.',
          'Use Forces view to inspect which guardrail pushes hardest.',
        ]

  const memoText = [
    `SafePatch decision: ${decisionTone.toUpperCase()}.`,
    `Scenario: ${normalizedState.presetId}. Tightness: ${Math.round(normalizedState.tightness * 100)}%.`,
    `Checks: ${checksRawPassed}/${activeCheckCount} -> ${checksSafePassed}/${activeCheckCount}.`,
    `Queue forecast: ${queueRawPeak} -> ${queueSafePeak}.`,
    `Gain retained: ${Math.round(retainedGain * 100)}%.`,
    `Detail: ${decisionDetail}`,
  ].join(' ')

  return {
    state: normalizedState,
    halfspaces,
    projection,
    rawViolationCount,
    safeViolationCount,
    activeCheckCount,
    checksRawPassed,
    checksSafePassed,
    rawRisk,
    safeRisk,
    queueRawPeak,
    queueSafePeak,
    retainedGain,
    correctionNorm,
    correctionNormRatio,
    queuePeakDelta,
    riskDropPct,
    dominantConstraintLabel,
    decisionTone,
    decisionTitle,
    decisionDetail,
    readiness,
    whyItems,
    actionItems,
    memoText,
  }
}

function forceColor(constraintId: string): string {
  const index = BASE_HALFSPACES.findIndex((halfspace) => halfspace.id === constraintId)
  if (index < 0) {
    return CONSTRAINT_PALETTE[0]
  }
  return CONSTRAINT_PALETTE[index % CONSTRAINT_PALETTE.length]
}

function constraintMathIndex(constraintId: string): number {
  const index = BASE_HALFSPACES.findIndex((halfspace) => halfspace.id === constraintId)
  return index >= 0 ? index + 1 : 0
}

function buildForceBars(evaluation: Evaluation, visibleIds: Set<string>): ForceBarUi[] {
  return evaluation.projection.diagnostics
    .filter((diagnostic) => diagnostic.active && diagnostic.lambda > PROJECTION_TOLERANCE)
    .sort((a, b) => b.lambda - a.lambda)
    .map((diagnostic) => ({
      id: diagnostic.id,
      label: diagnostic.label,
      lambda: diagnostic.lambda,
      color: forceColor(diagnostic.id),
      isVisible: visibleIds.has(diagnostic.id),
    }))
}

function buildMathTerms(evaluation: Evaluation): MathTermUi[] {
  return evaluation.projection.diagnostics
    .filter((diagnostic) => diagnostic.active && diagnostic.lambda > PROJECTION_TOLERANCE)
    .sort((a, b) => b.lambda - a.lambda)
    .slice(0, 5)
    .map((diagnostic) => {
      const correction = evaluation.projection.correctionById[diagnostic.id] ?? vec(0, 0)
      const mathIndex = constraintMathIndex(diagnostic.id)
      const suffix = mathIndex > 0 ? `${mathIndex}` : diagnostic.id
      return {
        id: diagnostic.id,
        label: diagnostic.label,
        lambdaTex: String.raw`\lambda_{${suffix}}=${diagnostic.lambda.toFixed(3)}`,
        vectorTex: String.raw`-\eta\,\lambda_{${suffix}}\,n_{${suffix}}=\left(${correction.x.toFixed(3)},\;${correction.y.toFixed(
          3,
        )}\right)`,
        color: forceColor(diagnostic.id),
        active: evaluation.projection.activeSetIds.includes(diagnostic.id),
      }
    })
}

function incidentRawPerHour(evaluation: Evaluation): number {
  return Math.max(0, Math.round((evaluation.queueRawPeak / 13) * 10) / 10)
}

function incidentSafePerHour(evaluation: Evaluation): number {
  return Math.max(0, Math.round((evaluation.queueSafePeak / 13) * 10) / 10)
}

function buildOutcomeFrame(
  evaluation: Evaluation,
  mode: SceneMode,
  teachingProgress: number,
  dragging: boolean,
): OutcomeFrameUi {
  const progress = clamp(teachingProgress)
  const duringStory = mode === 'geometry' && progress < 1

  const incidentRaw = incidentRawPerHour(evaluation)
  const incidentSafe = incidentSafePerHour(evaluation)
  const incidentDelta = Math.round((incidentRaw - incidentSafe) * 10) / 10

  const dominantActiveId = evaluation.projection.activeSetIds
    .slice()
    .sort((a, b) => (evaluation.projection.lambdaById[b] ?? 0) - (evaluation.projection.lambdaById[a] ?? 0))[0]

  const dominantLabel = dominantActiveId
    ? evaluation.halfspaces.find((halfspace) => halfspace.id === dominantActiveId)?.label ?? dominantActiveId
    : null

  let storyStep = 3
  let stageCaption = 'Red is raw proposal. Blue is certified patch.'

  let nowTitle = 'Live decision'
  let nowBody = 'SafePatch is continuously certifying the proposal against active guardrails.'

  let impactLine =
    incidentDelta >= 0
      ? `${incidentDelta.toFixed(1)} incidents/hr avoided after certification.`
      : `${Math.abs(incidentDelta).toFixed(1)} incidents/hr added even after certification.`
  nowBody = `${nowBody} Decision: ${evaluation.decisionTone.toUpperCase()}.`

  if (duringStory) {
    if (progress < 0.28) {
      storyStep = 0
      nowTitle = 'Intake raw proposal'
      nowBody = 'The system reads your candidate fix direction before any safety correction.'
      stageCaption = 'Step 1: intake raw proposal.'
      impactLine = `Raw forecast: ${incidentRaw.toFixed(1)} incidents/hr if shipped directly.`
    } else if (progress < 0.46) {
      storyStep = 1
      nowTitle = 'Detect guardrail risk'
      nowBody = dominantLabel
        ? `Raw proposal crosses guardrail "${dominantLabel}".`
        : 'Raw proposal crosses at least one active guardrail.'
      stageCaption = 'Step 2: violation detected and highlighted.'
      impactLine = dominantLabel
        ? `Blocker identified: ${dominantLabel}.`
        : 'Blocker identified from active guardrails.'
    } else if (progress < 0.72) {
      storyStep = 2
      nowTitle = 'Project certified patch'
      nowBody = 'SafePatch removes only the unsafe component while preserving useful movement.'
      stageCaption = 'Step 3: unsafe component is removed.'
      impactLine = `Certification keeps ${Math.round(evaluation.retainedGain * 100)}% useful gain.`
    } else {
      storyStep = 3
      nowTitle = 'Recommend release action'
      nowBody = 'Certified patch is scored for policy compliance and operational impact.'
      stageCaption = 'Step 4: certified patch and recommendation.'
      impactLine =
        incidentDelta >= 0
          ? `${incidentDelta.toFixed(1)} incidents/hr prevented versus raw ship.`
          : `${Math.abs(incidentDelta).toFixed(1)} incidents/hr higher even after correction.`
    }
  } else if (mode === 'forces') {
    storyStep = 2
    nowTitle = 'Inspect correction forces'
    nowBody = 'Each active guardrail contributes a correction component.'
    stageCaption = 'Forces view: inspect how each guardrail bends the proposal.'
    impactLine = dominantLabel
      ? `Click bars to isolate ${dominantLabel} contribution.`
      : 'No active forces. Proposal is already safe.'
  } else if (dragging) {
    storyStep = 3
    nowTitle = 'Live interactive certification'
    nowBody = 'As you drag, SafePatch continuously recomputes a certifiable patch.'
    stageCaption = `Live update: trim ${Math.round(evaluation.correctionNormRatio * 100)}% while dragging.`
    impactLine =
      incidentDelta >= 0
        ? `${Math.abs(incidentDelta).toFixed(1)} incidents/hr lower than raw.`
        : `${Math.abs(incidentDelta).toFixed(1)} incidents/hr higher than raw.`
  }

  return {
    decisionTone: evaluation.decisionTone,
    decisionTitle: evaluation.decisionTitle,
    decisionDetail: evaluation.decisionDetail,
    readinessText: `Release confidence: ${evaluation.readiness}/100`,
    nowTitle,
    nowBody,
    checksText: `${evaluation.checksSafePassed}/${evaluation.activeCheckCount}`,
    incidentText: `${incidentSafe}/hr (raw ${incidentRaw}/hr)`,
    retainedText: `${Math.round(evaluation.retainedGain * 100)}%`,
    impactLine,
    stageCaption,
    storyStep,
  }
}

function dominantConstraintId(evaluation: Evaluation): string | null {
  const ranked = evaluation.projection.activeSetIds
    .filter((id) => (evaluation.projection.lambdaById[id] ?? 0) > PROJECTION_TOLERANCE)
    .sort((a, b) => (evaluation.projection.lambdaById[b] ?? 0) - (evaluation.projection.lambdaById[a] ?? 0))
  return ranked[0] ?? null
}

function buildDetailFrame(evaluation: Evaluation): DetailFrameUi {
  const presetNote = PRESETS[evaluation.state.presetId].note
  const mathSummaryTex = String.raw`\Delta_0=(${evaluation.projection.step0.x.toFixed(3)}, ${evaluation.projection.step0.y.toFixed(
    3,
  )}),\quad \Delta^\star=(${evaluation.projection.projectedStep.x.toFixed(3)}, ${evaluation.projection.projectedStep.y.toFixed(
    3,
  )}),\quad \|\Delta^\star-\Delta_0\|_2=${evaluation.correctionNorm.toFixed(3)}`

  return {
    presetNote,
    whyItems: evaluation.whyItems,
    actionItems: evaluation.actionItems,
    memoText: evaluation.memoText,
    mathSummaryTex,
    mathTerms: buildMathTerms(evaluation),
  }
}

function clampRawStep(step: Vec2, halfspaces: Halfspace[]): Vec2 {
  const radius = worldBoundsFromHalfspaces(halfspaces) * MAX_RAW_RADIUS_FACTOR
  const magnitude = Math.hypot(step.x, step.y)
  if (magnitude <= radius || magnitude < PROJECTION_TOLERANCE) {
    return step
  }
  const ratio = radius / magnitude
  return scale(step, ratio)
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
      // Continue to DOM fallback.
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

  let success = false
  try {
    success = document.execCommand('copy')
  } catch {
    success = false
  }

  document.body.removeChild(helper)
  return success
}

function buildDecisionPayload(evaluation: Evaluation): Record<string, unknown> {
  return {
    generated_at: new Date().toISOString(),
    controls: {
      preset: evaluation.state.presetId,
      pressure: Number(evaluation.state.pressure.toFixed(4)),
      tightness: Number(evaluation.state.tightness.toFixed(4)),
      raw_step: {
        x: Number(evaluation.state.rawStep.x.toFixed(4)),
        y: Number(evaluation.state.rawStep.y.toFixed(4)),
      },
      mode: evaluation.state.mode,
    },
    decision: {
      value: evaluation.decisionTone,
      title: evaluation.decisionTitle,
      detail: evaluation.decisionDetail,
      readiness: evaluation.readiness,
    },
    metrics: {
      checks_raw_passed: evaluation.checksRawPassed,
      checks_safe_passed: evaluation.checksSafePassed,
      checks_total: evaluation.activeCheckCount,
      queue_peak_raw: evaluation.queueRawPeak,
      queue_peak_safe: evaluation.queueSafePeak,
      queue_peak_delta: evaluation.queuePeakDelta,
      retained_gain_ratio: Number(evaluation.retainedGain.toFixed(4)),
      correction_norm: Number(evaluation.correctionNorm.toFixed(4)),
      correction_norm_ratio: Number(evaluation.correctionNormRatio.toFixed(4)),
      raw_risk_ratio: Number(evaluation.rawRisk.toFixed(4)),
      safe_risk_ratio: Number(evaluation.safeRisk.toFixed(4)),
      risk_drop_pct: Number(evaluation.riskDropPct.toFixed(3)),
    },
    active_constraints: evaluation.projection.activeSetIds,
    lambdas: evaluation.projection.lambdaById,
    rationale: evaluation.whyItems,
    actions: evaluation.actionItems,
  }
}

function start(): void {
  const canvasNode = document.getElementById('scene-canvas') as HTMLCanvasElement | null
  if (!canvasNode) {
    throw new Error('Missing canvas #scene-canvas')
  }
  const canvas = canvasNode

  const renderer = new SceneRenderer(canvas)
  const ui = new UIController()

  let targetState = cloneState(DEFAULT_STATE)
  let tweenFrom = cloneState(DEFAULT_STATE)
  let tweenTo = cloneState(DEFAULT_STATE)
  let tweenStart = performance.now()
  let tweenDurationMs = UPDATE_ANIMATION_MS

  let targetEvaluation = scenarioEvaluation(targetState)
  let highlightedConstraintId: string | null = dominantConstraintId(targetEvaluation)
  const visibleCorrectionIds = new Set<string>(highlightedConstraintId ? [highlightedConstraintId] : [])

  let teachingStart = performance.now()
  let teachingActive = true

  let dragging = false
  let dragPointerId: number | null = null

  let latestDecision = buildDecisionPayload(targetEvaluation)

  function sampleState(now: number): InteractiveState {
    const progress = clamp((now - tweenStart) / Math.max(1, tweenDurationMs))
    return lerpState(tweenFrom, tweenTo, easeOutCubic(progress))
  }

  function syncVisibleCorrections(evaluation: Evaluation): void {
    const activeIds = evaluation.projection.activeSetIds.filter(
      (id) => (evaluation.projection.lambdaById[id] ?? 0) > PROJECTION_TOLERANCE,
    )
    const activeSet = new Set(activeIds)

    const fallback = dominantConstraintId(evaluation)
    const nextHighlighted = highlightedConstraintId && activeSet.has(highlightedConstraintId) ? highlightedConstraintId : fallback

    highlightedConstraintId = nextHighlighted
    visibleCorrectionIds.clear()
    if (nextHighlighted) {
      visibleCorrectionIds.add(nextHighlighted)
    }
  }

  function syncPanels(): void {
    ui.renderDetails(buildDetailFrame(targetEvaluation))
    ui.renderForceBars(buildForceBars(targetEvaluation, visibleCorrectionIds))
    ui.toggleForcePanel(targetState.mode === 'forces')
    latestDecision = buildDecisionPayload(targetEvaluation)
  }

  function retarget(next: Partial<InteractiveState>, options: RetargetOptions = {}): void {
    const stopTeaching = options.stopTeaching ?? true
    const durationMs = Math.max(1, options.durationMs ?? UPDATE_ANIMATION_MS)
    const immediate = options.immediate ?? false

    const now = performance.now()
    const current = sampleState(now)

    const merged: InteractiveState = {
      ...targetState,
      ...next,
      rawStep: next.rawStep ? { ...next.rawStep } : { ...targetState.rawStep },
    }

    targetState = merged
    targetEvaluation = scenarioEvaluation(targetState)
    syncVisibleCorrections(targetEvaluation)

    if (immediate) {
      tweenFrom = cloneState(targetState)
      tweenTo = cloneState(targetState)
      tweenDurationMs = 1
      tweenStart = now
    } else {
      tweenFrom = current
      tweenTo = cloneState(targetState)
      tweenDurationMs = durationMs
      tweenStart = now
    }

    if (stopTeaching) {
      teachingActive = false
    }

    syncPanels()
  }

  function onDragStart(event: PointerEvent): void {
    if (event.button !== 0) {
      return
    }

    const world = renderer.clientToWorld(event.clientX, event.clientY)
    if (!world) {
      return
    }

    dragging = true
    dragPointerId = event.pointerId
    canvas.setPointerCapture(event.pointerId)
    canvas.classList.add('dragging')
    ui.setDragActive(true)

    const nearHandle = renderer.isNearRawHandle(event.clientX, event.clientY, targetEvaluation.projection.step0)
    if (!nearHandle) {
      const clampedStep = clampRawStep(world, targetEvaluation.halfspaces)
      retarget({ rawStep: clampedStep }, { stopTeaching: true, durationMs: DRAG_ANIMATION_MS })
    }

    event.preventDefault()
  }

  function onDragMove(event: PointerEvent): void {
    if (!dragging || dragPointerId !== event.pointerId) {
      return
    }

    const world = renderer.clientToWorld(event.clientX, event.clientY)
    if (!world) {
      return
    }

    const clampedStep = clampRawStep(world, targetEvaluation.halfspaces)
    retarget({ rawStep: clampedStep }, { stopTeaching: true, durationMs: DRAG_ANIMATION_MS })
  }

  function onDragEnd(event: PointerEvent): void {
    if (!dragging || dragPointerId !== event.pointerId) {
      return
    }

    dragging = false
    dragPointerId = null
    canvas.classList.remove('dragging')
    ui.setDragActive(false)

    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
  }

  function frame(now: number): void {
    const displayedState = sampleState(now)
    const displayedEvaluation = scenarioEvaluation(displayedState)

    const teachingProgress = teachingActive ? clamp((now - teachingStart) / TEACHING_ANIMATION_MS) : 1
    if (teachingActive && teachingProgress >= 1) {
      teachingActive = false
    }

    renderer.render({
      halfspaces: copyHalfspaces(displayedEvaluation.halfspaces),
      projection: displayedEvaluation.projection,
      mode: displayedState.mode,
      teachingProgress,
      clockMs: now,
      highlightedConstraintId,
      visibleCorrectionIds: [...visibleCorrectionIds],
      dragActive: dragging,
    })

    ui.renderOutcome(buildOutcomeFrame(displayedEvaluation, displayedState.mode, teachingProgress, dragging))

    requestAnimationFrame(frame)
  }

  ui.onPresetChange((controls) => {
    const preset = PRESETS[controls.presetId]
    retarget(
      {
        presetId: preset.id,
        pressure: preset.pressure,
      },
      { durationMs: UPDATE_ANIMATION_MS },
    )
  })

  ui.onTightnessChange((controls) => {
    retarget({ tightness: controls.tightness }, { durationMs: UPDATE_ANIMATION_MS })
  })

  ui.onModeChange((mode) => {
    retarget({ mode }, { stopTeaching: false, durationMs: MODE_ANIMATION_MS })
  })

  ui.onReplay(() => {
    teachingActive = true
    teachingStart = performance.now()
  })

  ui.onForceToggle((constraintId) => {
    highlightedConstraintId = constraintId
    visibleCorrectionIds.clear()
    visibleCorrectionIds.add(constraintId)
    ui.renderForceBars(buildForceBars(targetEvaluation, visibleCorrectionIds))
  })

  ui.onCopyMemo((memoText) => copyToClipboard(memoText))
  ui.onExport(() => {
    exportDecision(latestDecision)
  })

  canvas.addEventListener('pointerdown', onDragStart)
  canvas.addEventListener('pointermove', onDragMove)
  canvas.addEventListener('pointerup', onDragEnd)
  canvas.addEventListener('pointercancel', onDragEnd)

  window.addEventListener('resize', () => {
    renderer.resize()
  })

  renderer.resize()
  syncPanels()
  requestAnimationFrame(frame)
}

start()
