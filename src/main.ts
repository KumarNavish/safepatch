import 'katex/dist/katex.min.css'

import { normalize, scale, vec, worldBoundsFromHalfspaces } from './geometry'
import type { Halfspace, Vec2 } from './geometry'
import { computeProjectedStep } from './qp'
import type { ProjectionResult } from './qp'
import { SceneRenderer } from './render'
import { UIController } from './ui'
import type { DetailFrameUi, ForceBarUi, OutcomeFrameUi, PresetId, SceneMode } from './ui'

const ETA = 1
const PROJECTION_TOLERANCE = 1e-6
const UPDATE_ANIMATION_MS = 320
const TEACHING_ANIMATION_MS = 2100
const MAX_RAW_RADIUS_FACTOR = 1.25

const CONSTRAINT_PALETTE = ['#eb5f82', '#56a7ff', '#5fcf8b', '#f0ad63', '#8f7bea', '#53c6bc']

interface PresetConfig {
  id: PresetId
  pressure: number
  note: string
}

const PRESETS: Record<PresetId, PresetConfig> = {
  normal: {
    id: 'normal',
    pressure: 0.24,
    note: 'Normal traffic: lower external pressure, wider room for feasible motion.',
  },
  spike: {
    id: 'spike',
    pressure: 0.56,
    note: 'Spike traffic: moderate pressure where projection gives visible safety gains.',
  },
  incident: {
    id: 'incident',
    pressure: 0.9,
    note: 'Incident traffic: high pressure, unsafe raw steps can escalate quickly.',
  },
}

const BASE_HALFSPACES: Halfspace[] = [
  {
    id: 'g1',
    label: 'toxicity budget',
    normal: normalize(vec(0.94, 0.34)),
    bound: 0.72,
    active: true,
  },
  {
    id: 'g2',
    label: 'hallucination budget',
    normal: normalize(vec(0.26, 1)),
    bound: 0.66,
    active: true,
  },
  {
    id: 'g3',
    label: 'privacy guardrail',
    normal: normalize(vec(-0.89, 0.46)),
    bound: 0.73,
    active: true,
  },
  {
    id: 'g4',
    label: 'style drift guardrail',
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
  decisionTone: 'ship' | 'hold'
  decisionTitle: string
  decisionDetail: string
  readiness: number
  whyItems: string[]
  actionItems: string[]
  memoText: string
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

function clamp01(value: number): number {
  return clamp(value, 0, 1)
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

  const baseQueue = 190 + normalizedState.pressure * 320 + normalizedState.tightness * 38
  const queueRawPeak = Math.round(clampRange(baseQueue + rawRisk * 330 + (1 - retainedGain) * 35, 80, 3800))
  const queueSafePeak = Math.round(clampRange(baseQueue + safeRisk * 190 + (1 - retainedGain) * 60 - 46, 60, 3800))

  let decisionTone: 'ship' | 'hold' = 'ship'
  let decisionTitle = 'Ship projected patch'
  let decisionDetail = 'Projected step is feasible and keeps practical value.'

  if (!projection.ship) {
    decisionTone = 'hold'
    decisionTitle = 'Hold deployment'
    decisionDetail = projection.reason ?? 'No feasible projected patch under current constraints.'
  } else if (safeViolationCount > 0) {
    decisionTone = 'hold'
    decisionTitle = 'Hold deployment'
    decisionDetail = `Projected patch still violates ${safeViolationCount} check${safeViolationCount > 1 ? 's' : ''}.`
  } else if (retainedGain < 0.34) {
    decisionTone = 'hold'
    decisionTitle = 'Hold deployment'
    decisionDetail = `Safe projection keeps only ${Math.round(retainedGain * 100)}% of intended gain.`
  } else if (queueSafePeak > queueRawPeak + 20) {
    decisionTone = 'hold'
    decisionTitle = 'Hold deployment'
    decisionDetail = 'Projection is safe but queue pressure is not improving enough.'
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

  const whyItems: string[] = [
    `Raw checks passed: ${checksRawPassed}/${activeCheckCount}; projected checks passed: ${checksSafePassed}/${activeCheckCount}.`,
    activeLabels.length > 0
      ? `Active correction set: ${activeLabels.join(', ')}.`
      : 'No active correction force: raw patch is already inside all active checks.',
    `Expected queue peak: ${queueRawPeak.toLocaleString()} -> ${queueSafePeak.toLocaleString()}; retained gain ${Math.round(
      retainedGain * 100,
    )}%.`,
  ]

  const actionItems: string[] =
    decisionTone === 'ship'
      ? [
          'Ship projected patch through staged canary rollout.',
          'Monitor active checks and queue for the first 15 minutes.',
          'Keep rollback hook armed if queue rises above threshold.',
        ]
      : [
          'Do not ship yet in this operating point.',
          'Drag Δ0 toward the feasible region or reduce policy tightness.',
          'Replay the teaching sequence to inspect the dominant correction force.',
        ]

  const memoText = [
    `SafePatch decision: ${decisionTone.toUpperCase()}.`,
    `Preset: ${normalizedState.presetId}. Tightness: ${Math.round(normalizedState.tightness * 100)}%.`,
    `Checks: ${checksRawPassed}/${activeCheckCount} -> ${checksSafePassed}/${activeCheckCount}.`,
      `Queue peak: ${queueRawPeak} -> ${queueSafePeak}.`,
    `Retained gain: ${Math.round(retainedGain * 100)}%.`,
    `Decision detail: ${decisionDetail}`,
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

function buildOutcomeFrame(
  evaluation: Evaluation,
  mode: SceneMode,
  teachingProgress: number,
  dragging: boolean,
): OutcomeFrameUi {
  const dominantActiveId = evaluation.projection.activeSetIds
    .slice()
    .sort((a, b) => (evaluation.projection.lambdaById[b] ?? 0) - (evaluation.projection.lambdaById[a] ?? 0))[0]

  const dominantLabel = dominantActiveId
    ? evaluation.halfspaces.find((halfspace) => halfspace.id === dominantActiveId)?.label ?? dominantActiveId
    : null

  const dominantLambda = dominantActiveId ? evaluation.projection.lambdaById[dominantActiveId] ?? 0 : 0

  let stageCaption: string
  if (mode === 'forces') {
    stageCaption = 'Forces view: Δ* = Δ0 + Σ(−η λ n). Click λ bars to isolate each correction term.'
  } else if (teachingProgress < 0.28) {
    stageCaption = 'Step 1: Raw patch Δ0 grows from the origin.'
  } else if (teachingProgress < 0.46) {
    stageCaption = 'Step 2: Δ0 crosses a guardrail boundary (collision).'
  } else if (teachingProgress < 0.72) {
    stageCaption = 'Step 3: Active constraint applies push-back correction.'
  } else if (teachingProgress < 1) {
    stageCaption = 'Step 4: Corrected patch Δ* lands inside the feasible region.'
  } else if (dragging) {
    stageCaption = 'Dragging Δ0: projection updates continuously as you move the raw patch.'
  } else if (dominantLabel && dominantLambda > PROJECTION_TOLERANCE) {
    stageCaption = `Dominant correction: ${dominantLabel} (λ=${dominantLambda.toFixed(3)}).`
  } else {
    stageCaption = 'Geometry view: Δ0 is already feasible, so Δ* matches it with no correction force.'
  }

  return {
    decisionTone: evaluation.decisionTone,
    decisionTitle: evaluation.decisionTitle,
    decisionDetail: evaluation.decisionDetail,
    checksText: `${evaluation.checksRawPassed}/${evaluation.activeCheckCount} -> ${evaluation.checksSafePassed}/${
      evaluation.activeCheckCount
    }`,
    queueText: `${evaluation.queueRawPeak.toLocaleString()} -> ${evaluation.queueSafePeak.toLocaleString()}`,
    retainedText: `${Math.round(evaluation.retainedGain * 100)}%`,
    readinessText: `Readiness: ${evaluation.readiness}/100`,
    stageCaption,
  }
}

function buildDetailFrame(evaluation: Evaluation): DetailFrameUi {
  const presetNote = PRESETS[evaluation.state.presetId].note
  return {
    presetNote,
    whyItems: evaluation.whyItems,
    actionItems: evaluation.actionItems,
    memoText: evaluation.memoText,
  }
}

function clampRawStep(step: Vec2, halfspaces: Halfspace[]): Vec2 {
  const radius = worldBoundsFromHalfspaces(halfspaces) * MAX_RAW_RADIUS_FACTOR
  const mag = Math.hypot(step.x, step.y)
  if (mag <= radius || mag < PROJECTION_TOLERANCE) {
    return step
  }
  const ratio = radius / mag
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
      retained_gain_ratio: Number(evaluation.retainedGain.toFixed(4)),
      raw_risk_ratio: Number(evaluation.rawRisk.toFixed(4)),
      safe_risk_ratio: Number(evaluation.safeRisk.toFixed(4)),
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

  let targetEvaluation = scenarioEvaluation(targetState)
  const visibleCorrectionIds = new Set<string>(
    targetEvaluation.projection.activeSetIds.filter((id) => (targetEvaluation.projection.lambdaById[id] ?? 0) > PROJECTION_TOLERANCE),
  )
  let highlightedConstraintId: string | null = [...visibleCorrectionIds][0] ?? null

  let teachingStart = performance.now()
  let teachingActive = true
  let dragging = false
  let dragPointerId: number | null = null

  let latestDecision = buildDecisionPayload(targetEvaluation)

  function sampleState(now: number): InteractiveState {
    const progress = clamp((now - tweenStart) / UPDATE_ANIMATION_MS)
    return lerpState(tweenFrom, tweenTo, easeOutCubic(progress))
  }

  function syncVisibleCorrections(evaluation: Evaluation): void {
    const activeIds = evaluation.projection.activeSetIds.filter(
      (id) => (evaluation.projection.lambdaById[id] ?? 0) > PROJECTION_TOLERANCE,
    )

    const activeSet = new Set(activeIds)

    for (const id of Array.from(visibleCorrectionIds)) {
      if (!activeSet.has(id)) {
        visibleCorrectionIds.delete(id)
      }
    }

    for (const id of activeIds) {
      if (!visibleCorrectionIds.has(id)) {
        visibleCorrectionIds.add(id)
      }
    }

    if (highlightedConstraintId && !visibleCorrectionIds.has(highlightedConstraintId)) {
      highlightedConstraintId = null
    }

    if (!highlightedConstraintId) {
      highlightedConstraintId = activeIds[0] ?? null
    }
  }

  function syncStaticPanels(): void {
    ui.renderDetails(buildDetailFrame(targetEvaluation))
    ui.renderForceBars(buildForceBars(targetEvaluation, visibleCorrectionIds))
    ui.toggleForcePanel(targetState.mode === 'forces')
    latestDecision = buildDecisionPayload(targetEvaluation)
  }

  function retarget(next: Partial<InteractiveState>, stopTeaching = true): void {
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

    tweenFrom = current
    tweenTo = cloneState(targetState)
    tweenStart = now

    if (stopTeaching) {
      teachingActive = false
    }

    syncStaticPanels()
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
      retarget({ rawStep: clampedStep }, true)
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
    retarget({ rawStep: clampedStep }, true)
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
    retarget({
      presetId: preset.id,
      pressure: preset.pressure,
    })
  })

  ui.onTightnessChange((controls) => {
    retarget({ tightness: controls.tightness })
  })

  ui.onModeChange((mode) => {
    retarget({ mode }, false)
  })

  ui.onReplay(() => {
    teachingActive = true
    teachingStart = performance.now()
  })

  ui.onForceToggle((constraintId) => {
    if (visibleCorrectionIds.has(constraintId)) {
      visibleCorrectionIds.delete(constraintId)
      if (highlightedConstraintId === constraintId) {
        highlightedConstraintId = null
      }
    } else {
      visibleCorrectionIds.add(constraintId)
      highlightedConstraintId = constraintId
    }

    const visibleList = Array.from(visibleCorrectionIds)
    if (!highlightedConstraintId && visibleList.length > 0) {
      highlightedConstraintId = visibleList[visibleList.length - 1]
    }

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
  syncStaticPanels()
  requestAnimationFrame(frame)
}

start()
