import { intersectHalfspaces, vec, worldBoundsFromHalfspaces } from './geometry'
import type { Halfspace, Vec2 } from './geometry'
import type { ProjectionResult } from './qp'

export type SceneMode = 'geometry' | 'forces'

export interface SceneRenderInput {
  halfspaces: Halfspace[]
  projection: ProjectionResult
  mode: SceneMode
  teachingProgress: number
  clockMs: number
  highlightedConstraintId: string | null
  visibleCorrectionIds: string[]
  dragActive: boolean
  stats: {
    checksRawPassed: number
    checksSafePassed: number
    checksTotal: number
    incidentRaw: number
    incidentSafe: number
    retainedPct: number
    decisionTone: 'ship' | 'hold'
  }
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Mapper {
  worldRadius: number
  center: Vec2
  scale: number
  worldToCanvas: (point: Vec2) => Vec2
  canvasToWorld: (point: Vec2) => Vec2
}

interface TeachingBeats {
  raw: number
  breach: number
  correction: number
  safe: number
}

interface StageState {
  index: 0 | 1 | 2 | 3
  progress: number
}

interface ChartScale {
  minV: number
  maxV: number
  toX: (t: number) => number
  toY: (value: number) => number
}

interface LabelBox {
  x: number
  y: number
  width: number
  height: number
}

const RAW = '#e2536e'
const SAFE = '#2a67ea'
const WARN = '#e99a3a'
const SHIP = '#0f9a78'
const HOLD = '#9b5f33'
const INK = '#193452'
const MUTED = '#4d6f92'

const CURVE_STEPS = 100

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max)
}

function numberLerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function vecLerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return {
    x: numberLerp(a.x, b.x, t),
    y: numberLerp(a.y, b.y, t),
  }
}

function easeOutCubic(value: number): number {
  const t = clamp(value)
  return 1 - (1 - t) ** 3
}

function easeInOutCubic(value: number): number {
  const t = clamp(value)
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2
}

function easeOutBack(value: number): number {
  const t = clamp(value)
  const c1 = 1.08
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}

function phaseWindow(progress: number, start: number, end: number): number {
  if (end <= start) {
    return progress >= end ? 1 : 0
  }
  return clamp((progress - start) / (end - start))
}

function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#')) {
    return hex
  }

  const normalized = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
  const parsed = Number.parseInt(normalized.slice(1), 16)
  const r = (parsed >> 16) & 255
  const g = (parsed >> 8) & 255
  const b = parsed & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function colorForConstraint(id: string): string {
  if (id.startsWith('g1')) return '#ef6f8f'
  if (id.startsWith('g2')) return '#4f8dff'
  if (id.startsWith('g3')) return '#18a28c'
  if (id.startsWith('g4')) return '#f0a941'
  return '#7b5dde'
}

function maxOrFallback(values: number[], fallback: number): number {
  if (values.length === 0) {
    return fallback
  }
  return Math.max(...values)
}

export class SceneRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D

  private mapper: Mapper | null = null
  private interactionRect: Rect | null = null
  private rawHandleCanvas: Vec2 | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Canvas 2D context not available')
    }
    this.ctx = context
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    const ratio = window.devicePixelRatio || 1
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio))
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio))
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  clientToWorld(clientX: number, clientY: number): Vec2 | null {
    if (!this.mapper || !this.interactionRect) {
      return null
    }

    const rect = this.canvas.getBoundingClientRect()
    const point = vec(clientX - rect.left, clientY - rect.top)

    const panel = this.interactionRect
    const margin = 10
    const withinX = point.x >= panel.x - margin && point.x <= panel.x + panel.width + margin
    const withinY = point.y >= panel.y - margin && point.y <= panel.y + panel.height + margin

    if (!withinX || !withinY) {
      return null
    }

    return this.mapper.canvasToWorld(point)
  }

  isNearRawHandle(clientX: number, clientY: number, rawStep: Vec2, radius = 18): boolean {
    const rect = this.canvas.getBoundingClientRect()
    const pointer = vec(clientX - rect.left, clientY - rect.top)
    const handle = this.rawHandleCanvas ?? this.mapper?.worldToCanvas(rawStep)
    if (!handle) {
      return false
    }
    return Math.hypot(pointer.x - handle.x, pointer.y - handle.y) <= radius
  }

  render(input: SceneRenderInput): void {
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    if (width <= 0 || height <= 0) {
      return
    }

    this.ctx.clearRect(0, 0, width, height)
    this.drawBackdrop(width, height)

    const frame: Rect = {
      x: 10,
      y: 10,
      width: width - 20,
      height: height - 20,
    }

    this.drawRoundedRect(frame.x, frame.y, frame.width, frame.height, 18)
    this.ctx.fillStyle = withAlpha('#ffffff', 0.98)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d2e1f2', 0.9)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const headerH = 48
    const footerH = 94
    const gap = 14

    const mainRect: Rect = {
      x: frame.x + 16,
      y: frame.y + headerH,
      width: frame.width - 32,
      height: frame.height - headerH - footerH - gap,
    }

    const patchWidth = Math.max(280, Math.round(mainRect.width * 0.56))
    const patchRect: Rect = {
      x: mainRect.x,
      y: mainRect.y,
      width: Math.min(patchWidth, mainRect.width - 210),
      height: mainRect.height,
    }

    const impactRect: Rect = {
      x: patchRect.x + patchRect.width + 12,
      y: mainRect.y,
      width: mainRect.width - patchRect.width - 12,
      height: mainRect.height,
    }

    const footerRect: Rect = {
      x: frame.x + 16,
      y: mainRect.y + mainRect.height + gap,
      width: frame.width - 32,
      height: footerH - 16,
    }

    const worldRect: Rect = {
      x: patchRect.x + 18,
      y: patchRect.y + 42,
      width: patchRect.width - 36,
      height: patchRect.height - 58,
    }

    const activeHalfspaces = input.halfspaces.filter((halfspace) => halfspace.active)
    const worldRadius = worldBoundsFromHalfspaces(activeHalfspaces) * 1.18
    const mapper = this.createMapper(worldRect, worldRadius)

    this.mapper = mapper
    this.interactionRect = worldRect

    const beats = this.resolveTeachingBeats(input.teachingProgress)
    const teachingMode = input.teachingProgress < 0.999
    const rawBlocked = input.projection.diagnostics.some(
      (diagnostic) => diagnostic.active && diagnostic.violationStep0 > 1e-6,
    )

    const stage = this.resolveStage(input.mode, rawBlocked, teachingMode, beats)
    const highlightedId = this.resolveHighlightedConstraintId(input)

    this.drawHeader(frame, input, stage, rawBlocked)

    this.drawPatchPanel({
      rect: patchRect,
      worldRect,
      mapper,
      input,
      beats,
      stage,
      rawBlocked,
      highlightedId,
      teachingMode,
    })

    this.drawImpactPanel({
      rect: impactRect,
      input,
      beats,
      stage,
      rawBlocked,
      teachingMode,
      seconds: input.clockMs / 1000,
    })

    this.drawPipelineFooter(footerRect, input, stage)
  }

  private resolveHighlightedConstraintId(input: SceneRenderInput): string | null {
    if (input.highlightedConstraintId) {
      return input.highlightedConstraintId
    }

    const ranked = [...input.projection.activeSetIds].sort(
      (a, b) => (input.projection.lambdaById[b] ?? 0) - (input.projection.lambdaById[a] ?? 0),
    )
    return ranked[0] ?? null
  }

  private resolveTeachingBeats(progress: number): TeachingBeats {
    if (progress >= 1) {
      return { raw: 1, breach: 1, correction: 1, safe: 1 }
    }

    const t = clamp(progress)
    return {
      raw: easeOutCubic(phaseWindow(t, 0, 0.3)),
      breach: easeOutCubic(phaseWindow(t, 0.28, 0.5)),
      correction: easeOutCubic(phaseWindow(t, 0.46, 0.76)),
      safe: easeOutCubic(phaseWindow(t, 0.72, 1)),
    }
  }

  private resolveStage(mode: SceneMode, rawBlocked: boolean, teachingMode: boolean, beats: TeachingBeats): StageState {
    if (mode === 'forces') {
      return { index: 2, progress: 0.72 }
    }

    if (!teachingMode) {
      return { index: 3, progress: 1 }
    }

    if (beats.raw < 1) {
      return { index: 0, progress: beats.raw * 0.28 }
    }

    if (rawBlocked && beats.breach < 1) {
      return { index: 1, progress: 0.28 + beats.breach * 0.24 }
    }

    if (rawBlocked && beats.correction < 1) {
      return { index: 2, progress: 0.52 + beats.correction * 0.26 }
    }

    return { index: 3, progress: 0.78 + beats.safe * 0.22 }
  }

  private createMapper(rect: Rect, worldRadius: number): Mapper {
    const pad = 8
    const usableWidth = Math.max(24, rect.width - pad * 2)
    const usableHeight = Math.max(24, rect.height - pad * 2)
    const scale = Math.min(usableWidth / (worldRadius * 2), usableHeight / (worldRadius * 2))
    const center = vec(rect.x + rect.width * 0.5, rect.y + rect.height * 0.54)

    return {
      worldRadius,
      center,
      scale,
      worldToCanvas: (point: Vec2) => vec(center.x + point.x * scale, center.y - point.y * scale),
      canvasToWorld: (point: Vec2) => vec((point.x - center.x) / scale, (center.y - point.y) / scale),
    }
  }

  private drawBackdrop(width: number, height: number): void {
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fillRect(0, 0, width, height)

    const glow = this.ctx.createRadialGradient(width * 0.14, 0, 20, width * 0.14, 0, width * 0.76)
    glow.addColorStop(0, 'rgba(42, 103, 234, 0.08)')
    glow.addColorStop(1, 'rgba(42, 103, 234, 0)')
    this.ctx.fillStyle = glow
    this.ctx.fillRect(0, 0, width, height)
  }

  private drawHeader(frame: Rect, input: SceneRenderInput, stage: StageState, rawBlocked: boolean): void {
    const y = frame.y + 16

    this.ctx.font = "700 15px 'Manrope'"
    this.ctx.fillStyle = withAlpha(INK, 0.96)
    this.ctx.fillText('Live Release Decision', frame.x + 18, y)

    const storyline = this.storyline(stage, rawBlocked, input.mode, input.stats.decisionTone)
    this.ctx.font = "600 11px 'Manrope'"
    this.ctx.fillStyle = withAlpha(MUTED, 0.95)
    this.ctx.fillText(storyline, frame.x + 18, y + 18)

    const badgeW = 106
    const badgeH = 28
    const badgeX = frame.x + frame.width - badgeW - 16
    const badgeY = frame.y + 12

    this.drawRoundedRect(badgeX, badgeY, badgeW, badgeH, 14)
    const tone = input.stats.decisionTone === 'ship' ? SHIP : HOLD
    this.ctx.fillStyle = withAlpha(tone, 0.14)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(tone, 0.35)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "700 11px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(tone, 0.96)
    this.ctx.textAlign = 'center'
    this.ctx.fillText(input.stats.decisionTone === 'ship' ? 'SHIP READY' : 'HOLD PATCH', badgeX + badgeW * 0.5, badgeY + 18)
    this.ctx.textAlign = 'left'
  }

  private storyline(stage: StageState, rawBlocked: boolean, mode: SceneMode, decisionTone: 'ship' | 'hold'): string {
    if (mode === 'forces') {
      return 'Inspecting which guardrails produced the correction.'
    }

    if (stage.index === 0) {
      return 'Testing the proposed patch against live guardrails.'
    }
    if (stage.index === 1 && rawBlocked) {
      return 'Risk found: raw patch crosses at least one active guardrail.'
    }
    if (stage.index === 2 && rawBlocked) {
      return 'SafePatch removes only the unsafe component of the change.'
    }

    return decisionTone === 'ship'
      ? 'Certified patch stays inside policy and preserves useful impact.'
      : 'Certified patch still misses release criteria under current guardrails.'
  }

  private drawPatchPanel(params: {
    rect: Rect
    worldRect: Rect
    mapper: Mapper
    input: SceneRenderInput
    beats: TeachingBeats
    stage: StageState
    rawBlocked: boolean
    highlightedId: string | null
    teachingMode: boolean
  }): void {
    const { rect, worldRect, mapper, input, beats, stage, rawBlocked, highlightedId, teachingMode } = params

    this.drawPanel(rect)
    this.ctx.font = "700 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#496788', 0.92)
    this.ctx.fillText('PATCH TRANSFORMATION', rect.x + 14, rect.y + 18)

    this.drawRoundedRect(worldRect.x, worldRect.y, worldRect.width, worldRect.height, 12)
    this.ctx.fillStyle = '#fbfdff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d7e5f5', 0.9)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const polygon = intersectHalfspaces(input.halfspaces.filter((halfspace) => halfspace.active), mapper.worldRadius)

    if (!polygon.isEmpty) {
      this.ctx.beginPath()
      polygon.vertices.forEach((vertex, index) => {
        const point = mapper.worldToCanvas(vertex)
        if (index === 0) {
          this.ctx.moveTo(point.x, point.y)
        } else {
          this.ctx.lineTo(point.x, point.y)
        }
      })
      this.ctx.closePath()
      this.ctx.fillStyle = withAlpha(SAFE, 0.1)
      this.ctx.fill()
      this.ctx.strokeStyle = withAlpha(SAFE, 0.22)
      this.ctx.lineWidth = 1
      this.ctx.stroke()
    }

    this.drawReferenceAxes(worldRect, mapper)

    const rawTipFinal = mapper.worldToCanvas(input.projection.step0)
    const safeTipFinal = mapper.worldToCanvas(input.projection.projectedStep)

    const rawVisible = teachingMode ? beats.raw : 1
    const safeVisible = teachingMode ? (rawBlocked ? beats.safe : beats.raw) : 1
    const correctionVisible = teachingMode ? beats.correction : 1

    const rawTip = vecLerp(mapper.center, rawTipFinal, easeOutCubic(rawVisible))
    const safeTip = vecLerp(mapper.center, safeTipFinal, rawBlocked ? easeOutBack(safeVisible) : easeOutCubic(safeVisible))

    this.rawHandleCanvas = rawTipFinal

    const dominantDiagnostic = highlightedId
      ? input.projection.diagnostics.find((diagnostic) => diagnostic.id === highlightedId && diagnostic.active)
      : null

    if (dominantDiagnostic) {
      this.drawConstraintBoundary(mapper, dominantDiagnostic.normal, dominantDiagnostic.bound, {
        emphasize: rawBlocked && dominantDiagnostic.violationStep0 > 1e-6,
        pulse: teachingMode ? beats.breach : 1,
        color: colorForConstraint(dominantDiagnostic.id),
      })
    }

    this.drawArrow(mapper.center, rawTip, RAW, 2.4)
    this.drawArrow(mapper.center, safeTip, SAFE, 2.8)

    if (rawBlocked && correctionVisible > 0.04) {
      const correctionTip = vecLerp(rawTipFinal, safeTipFinal, easeInOutCubic(correctionVisible))
      this.drawArrow(rawTipFinal, correctionTip, WARN, 2, true)

      if (teachingMode && beats.breach > 0.12) {
        this.drawPulse(rawTipFinal, WARN, 14 + beats.breach * 12)
      }
    }

    if (input.mode === 'forces') {
      this.drawForceDecomposition(mapper, input.projection, input.visibleCorrectionIds, highlightedId)
    }

    this.drawHandle(rawTipFinal, RAW, 6.4)
    this.drawHandle(safeTipFinal, SAFE, 5.4)

    const labels: LabelBox[] = []
    this.drawSmartLabel(
      {
        text: 'Proposed patch',
        anchor: rawTipFinal,
        color: RAW,
        bounds: worldRect,
      },
      labels,
    )

    this.drawSmartLabel(
      {
        text: 'Certified patch',
        anchor: safeTipFinal,
        color: SAFE,
        bounds: worldRect,
      },
      labels,
    )

    if (rawBlocked && stage.index >= 1) {
      this.drawSmartLabel(
        {
          text: 'Unsafe component removed',
          anchor: vecLerp(rawTipFinal, safeTipFinal, 0.5),
          color: WARN,
          bounds: worldRect,
        },
        labels,
      )
    }

    if (dominantDiagnostic && stage.index >= 1) {
      const boundaryAnchor = this.boundaryLabelAnchor(mapper, dominantDiagnostic.normal, dominantDiagnostic.bound)
      this.drawSmartLabel(
        {
          text: `${dominantDiagnostic.label} limit`,
          anchor: boundaryAnchor,
          color: colorForConstraint(dominantDiagnostic.id),
          bounds: worldRect,
        },
        labels,
      )
    }
  }

  private drawImpactPanel(params: {
    rect: Rect
    input: SceneRenderInput
    beats: TeachingBeats
    stage: StageState
    rawBlocked: boolean
    teachingMode: boolean
    seconds: number
  }): void {
    const { rect, input, beats, stage, rawBlocked, teachingMode, seconds } = params

    this.drawPanel(rect)

    const prevented = Math.round((input.stats.incidentRaw - input.stats.incidentSafe) * 10) / 10

    this.ctx.font = "700 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#496788', 0.92)
    this.ctx.fillText(input.mode === 'forces' ? 'CORRECTION BREAKDOWN' : 'EXPECTED ON-CALL IMPACT', rect.x + 14, rect.y + 18)

    if (input.mode === 'forces') {
      this.drawForcesPanel(rect, input)
      return
    }

    const chartRect: Rect = {
      x: rect.x + 14,
      y: rect.y + 74,
      width: rect.width - 28,
      height: rect.height - 148,
    }

    this.ctx.font = "700 22px 'Manrope'"
    this.ctx.fillStyle = withAlpha(prevented >= 0 ? SHIP : HOLD, 0.94)
    const headline = prevented >= 0 ? `${prevented.toFixed(1)} fewer incidents/hr` : `${Math.abs(prevented).toFixed(1)} extra incidents/hr`
    this.ctx.fillText(headline, rect.x + 14, rect.y + 46)

    this.ctx.font = "600 11px 'Manrope'"
    this.ctx.fillStyle = withAlpha(MUTED, 0.94)
    this.ctx.fillText(`Raw ${input.stats.incidentRaw.toFixed(1)}/hr -> Safe ${input.stats.incidentSafe.toFixed(1)}/hr`, rect.x + 14, rect.y + 62)

    this.drawRoundedRect(chartRect.x, chartRect.y, chartRect.width, chartRect.height, 10)
    this.ctx.fillStyle = '#fbfdff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#dae8f7', 0.9)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const diff = Math.max(0.2, Math.abs(input.stats.incidentRaw - input.stats.incidentSafe))
    const low = Math.max(0, Math.min(input.stats.incidentRaw, input.stats.incidentSafe) - diff * 0.3)
    const limit = input.stats.incidentSafe + diff * 0.5 + 0.45

    const rawCurve = (t: number): number => {
      const spike = Math.exp(-(((t - 0.46) / 0.2) ** 2))
      const decay = 0.26 * (1 - t)
      const direction = input.stats.incidentRaw >= input.stats.incidentSafe ? 1 : -1
      return input.stats.incidentSafe + direction * diff * (0.56 * spike + decay) + diff * 0.24
    }

    const safeCurve = (t: number): number => {
      const mild = Math.exp(-(((t - 0.43) / 0.24) ** 2))
      return input.stats.incidentSafe + diff * 0.09 * mild
    }

    let maxValue = limit
    for (let i = 0; i <= CURVE_STEPS; i += 1) {
      const t = i / CURVE_STEPS
      maxValue = Math.max(maxValue, rawCurve(t), safeCurve(t))
    }
    maxValue += 0.45

    const scale: ChartScale = {
      minV: low,
      maxV: maxValue,
      toX: (t) => chartRect.x + chartRect.width * clamp(t),
      toY: (value) => {
        const ratio = (value - low) / Math.max(maxValue - low, 0.1)
        return chartRect.y + chartRect.height * (1 - clamp(ratio))
      },
    }

    this.drawChartGrid(chartRect, scale)

    const rawVisible = teachingMode ? beats.raw : 1
    const safeVisible = teachingMode ? (rawBlocked ? beats.safe : beats.raw) : 1
    const breachVisible = teachingMode ? Math.max(beats.breach, beats.safe) : 1

    this.drawThresholdLine(chartRect, scale, limit, breachVisible)
    this.drawCurve(scale, rawCurve, RAW, rawVisible, false)
    this.drawCurve(scale, safeCurve, SAFE, safeVisible, true)

    if (Math.min(rawVisible, safeVisible) > 0.05) {
      this.fillCurveGap(scale, rawCurve, safeCurve, Math.min(rawVisible, safeVisible))
    }

    if (rawBlocked && breachVisible > 0.12) {
      const breachT = this.firstCrossing(rawCurve, limit)
      const breachPoint = vec(scale.toX(breachT), scale.toY(rawCurve(breachT)))
      this.drawPulse(breachPoint, WARN, 10 + breachVisible * 10)
    }

    const playT = teachingMode ? clamp(rawVisible * 0.45 + safeVisible * 0.55) : (seconds * 0.22) % 1
    const playX = scale.toX(playT)
    this.drawPlayhead(chartRect, playX)

    this.drawToken(vec(playX, scale.toY(rawCurve(playT))), RAW, 3.8)
    this.drawToken(vec(playX, scale.toY(safeCurve(playT))), SAFE, 3.8)

    const summary = this.impactSummary(stage, rawBlocked, input.stats)
    this.ctx.font = "600 11px 'Manrope'"
    this.ctx.fillStyle = withAlpha(INK, 0.9)
    this.ctx.fillText(summary, rect.x + 14, rect.y + rect.height - 20)
  }

  private drawForcesPanel(rect: Rect, input: SceneRenderInput): void {
    const items = input.projection.diagnostics
      .filter((diagnostic) => diagnostic.active && diagnostic.lambda > 1e-6)
      .sort((a, b) => b.lambda - a.lambda)

    this.ctx.font = "600 12px 'Manrope'"
    this.ctx.fillStyle = withAlpha(INK, 0.94)
    this.ctx.fillText('Each bar shows how strongly a guardrail pushed back the proposal.', rect.x + 14, rect.y + 42)

    if (items.length === 0) {
      this.ctx.font = "600 11px 'Manrope'"
      this.ctx.fillStyle = withAlpha(MUTED, 0.92)
      this.ctx.fillText('No correction force needed. Raw patch is already inside limits.', rect.x + 14, rect.y + 70)
      return
    }

    const barsRect: Rect = {
      x: rect.x + 14,
      y: rect.y + 64,
      width: rect.width - 28,
      height: rect.height - 106,
    }

    const maxLambda = maxOrFallback(items.map((item) => item.lambda), 1)
    const visibleIds = new Set(input.visibleCorrectionIds)

    let cursorY = barsRect.y
    const rowHeight = 54

    for (const item of items.slice(0, 4)) {
      const color = colorForConstraint(item.id)
      const active = visibleIds.size === 0 || visibleIds.has(item.id)
      const alpha = active ? 1 : 0.36

      this.drawRoundedRect(barsRect.x, cursorY, barsRect.width, rowHeight - 8, 10)
      this.ctx.fillStyle = withAlpha('#f9fbff', 0.95)
      this.ctx.fill()
      this.ctx.strokeStyle = withAlpha(color, active ? 0.35 : 0.2)
      this.ctx.lineWidth = 1
      this.ctx.stroke()

      this.ctx.font = "700 11px 'Manrope'"
      this.ctx.fillStyle = withAlpha(INK, alpha)
      this.ctx.fillText(item.label, barsRect.x + 10, cursorY + 18)

      this.ctx.font = "600 10px 'IBM Plex Mono'"
      this.ctx.fillStyle = withAlpha(color, Math.min(1, alpha + 0.08))
      this.ctx.textAlign = 'right'
      this.ctx.fillText(`pressure ${item.lambda.toFixed(3)}`, barsRect.x + barsRect.width - 10, cursorY + 18)
      this.ctx.textAlign = 'left'

      const railX = barsRect.x + 10
      const railY = cursorY + 30
      const railW = barsRect.width - 20

      this.drawRoundedRect(railX, railY, railW, 10, 5)
      this.ctx.fillStyle = withAlpha('#dde8f8', 0.85)
      this.ctx.fill()

      const fillW = Math.max(8, (item.lambda / maxLambda) * railW)
      this.drawRoundedRect(railX, railY, fillW, 10, 5)
      this.ctx.fillStyle = withAlpha(color, active ? 0.9 : 0.35)
      this.ctx.fill()

      cursorY += rowHeight
    }
  }

  private impactSummary(
    stage: StageState,
    rawBlocked: boolean,
    stats: {
      checksRawPassed: number
      checksSafePassed: number
      checksTotal: number
      retainedPct: number
      decisionTone: 'ship' | 'hold'
    },
  ): string {
    if (stage.index === 0) {
      return `Raw checks: ${stats.checksRawPassed}/${stats.checksTotal}.`
    }

    if (stage.index === 1 && rawBlocked) {
      return 'Breach detected. Correction step is being computed.'
    }

    if (stage.index === 2 && rawBlocked) {
      return `Correction keeps ${stats.retainedPct}% of intended product gain.`
    }

    if (stats.decisionTone === 'ship') {
      return `Result: safe patch passes ${stats.checksSafePassed}/${stats.checksTotal} checks.`
    }

    return `Result: ${stats.checksSafePassed}/${stats.checksTotal} checks pass after correction.`
  }

  private drawPipelineFooter(rect: Rect, input: SceneRenderInput, stage: StageState): void {
    this.drawPanel(rect)

    const prevented = Math.round((input.stats.incidentRaw - input.stats.incidentSafe) * 10) / 10
    const tileGap = 8
    const tileW = (rect.width - tileGap * 2 - 16) / 3
    const tileY = rect.y + 10

    this.drawFooterTile({
      x: rect.x + 8,
      y: tileY,
      width: tileW,
      title: 'If shipped raw',
      value: `${input.stats.incidentRaw.toFixed(1)}/hr incidents`,
      sub: `${input.stats.checksRawPassed}/${input.stats.checksTotal} checks`,
      tone: RAW,
      active: stage.index >= 0,
    })

    this.drawFooterTile({
      x: rect.x + 8 + tileW + tileGap,
      y: tileY,
      width: tileW,
      title: 'After safeguard',
      value: `${input.stats.incidentSafe.toFixed(1)}/hr incidents`,
      sub: `${input.stats.checksSafePassed}/${input.stats.checksTotal} checks`,
      tone: SAFE,
      active: stage.index >= 2,
    })

    const decisionTone = input.stats.decisionTone === 'ship' ? SHIP : HOLD
    this.drawFooterTile({
      x: rect.x + 8 + (tileW + tileGap) * 2,
      y: tileY,
      width: tileW,
      title: input.stats.decisionTone === 'ship' ? 'Recommendation: ship' : 'Recommendation: hold',
      value: prevented >= 0 ? `${prevented.toFixed(1)}/hr prevented` : `${Math.abs(prevented).toFixed(1)}/hr added`,
      sub: `Value kept ${input.stats.retainedPct}%`,
      tone: decisionTone,
      active: stage.index >= 3,
    })
  }

  private drawFooterTile(input: {
    x: number
    y: number
    width: number
    title: string
    value: string
    sub: string
    tone: string
    active: boolean
  }): void {
    const { x, y, width, title, value, sub, tone, active } = input

    this.drawRoundedRect(x, y, width, 58, 10)
    this.ctx.fillStyle = '#f9fcff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(tone, active ? 0.35 : 0.2)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "700 9px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(tone, active ? 0.96 : 0.45)
    this.ctx.fillText(title.toUpperCase(), x + 8, y + 13)

    this.ctx.font = "700 12px 'Manrope'"
    this.ctx.fillStyle = withAlpha(INK, active ? 0.95 : 0.6)
    this.ctx.fillText(value, x + 8, y + 32)

    this.ctx.font = "600 10px 'Manrope'"
    this.ctx.fillStyle = withAlpha(MUTED, active ? 0.95 : 0.62)
    this.ctx.fillText(sub, x + 8, y + 48)
  }

  private drawReferenceAxes(worldRect: Rect, mapper: Mapper): void {
    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(worldRect.x, worldRect.y, worldRect.width, worldRect.height)
    this.ctx.clip()

    this.ctx.beginPath()
    this.ctx.moveTo(worldRect.x, mapper.center.y)
    this.ctx.lineTo(worldRect.x + worldRect.width, mapper.center.y)
    this.ctx.moveTo(mapper.center.x, worldRect.y)
    this.ctx.lineTo(mapper.center.x, worldRect.y + worldRect.height)
    this.ctx.strokeStyle = withAlpha('#d8e5f5', 0.9)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.restore()
  }

  private drawConstraintBoundary(
    mapper: Mapper,
    normal: Vec2,
    bound: number,
    config: {
      emphasize: boolean
      pulse: number
      color: string
    },
  ): void {
    const p0 = {
      x: normal.x * bound,
      y: normal.y * bound,
    }

    const tangent = {
      x: -normal.y,
      y: normal.x,
    }

    const span = mapper.worldRadius * 1.6
    const a = mapper.worldToCanvas({ x: p0.x + tangent.x * span, y: p0.y + tangent.y * span })
    const b = mapper.worldToCanvas({ x: p0.x - tangent.x * span, y: p0.y - tangent.y * span })

    this.ctx.beginPath()
    this.ctx.moveTo(a.x, a.y)
    this.ctx.lineTo(b.x, b.y)
    this.ctx.strokeStyle = withAlpha(config.color, config.emphasize ? 0.78 : 0.36)
    this.ctx.lineWidth = config.emphasize ? 2.2 : 1.2
    this.ctx.stroke()

    if (config.emphasize) {
      const pulse = 8 + clamp(config.pulse) * 8
      this.drawPulse(mapper.worldToCanvas(p0), config.color, pulse)
    }
  }

  private boundaryLabelAnchor(mapper: Mapper, normal: Vec2, bound: number): Vec2 {
    const p0 = {
      x: normal.x * bound,
      y: normal.y * bound,
    }
    const tangent = {
      x: -normal.y,
      y: normal.x,
    }

    const point = {
      x: p0.x + tangent.x * mapper.worldRadius * 0.34,
      y: p0.y + tangent.y * mapper.worldRadius * 0.34,
    }
    return mapper.worldToCanvas(point)
  }

  private drawForceDecomposition(
    mapper: Mapper,
    projection: ProjectionResult,
    visibleCorrectionIds: string[],
    highlightedId: string | null,
  ): void {
    const visible = new Set(visibleCorrectionIds)
    const ids = projection.activeSetIds.filter((id) => (projection.lambdaById[id] ?? 0) > 1e-6)

    let cursor = { ...projection.step0 }
    for (const id of ids) {
      const correction = projection.correctionById[id]
      const lambda = projection.lambdaById[id] ?? 0
      if (!correction || lambda <= 1e-6) {
        continue
      }

      const next = {
        x: cursor.x + correction.x,
        y: cursor.y + correction.y,
      }

      const isHighlighted = (!highlightedId || highlightedId === id) && (visible.size === 0 || visible.has(id))
      const color = colorForConstraint(id)

      this.drawArrow(
        mapper.worldToCanvas(cursor),
        mapper.worldToCanvas(next),
        withAlpha(color, isHighlighted ? 0.92 : 0.28),
        isHighlighted ? 2.4 : 1.6,
        true,
      )

      cursor = next
    }
  }

  private drawSmartLabel(
    input: {
      text: string
      anchor: Vec2
      color: string
      bounds: Rect
    },
    occupied: LabelBox[],
  ): void {
    const { text, anchor, color, bounds } = input

    this.ctx.font = "600 10px 'Manrope'"
    const textWidth = this.ctx.measureText(text).width
    const boxWidth = textWidth + 14
    const boxHeight = 20

    const candidates: Vec2[] = [
      vec(anchor.x + 10, anchor.y - 24),
      vec(anchor.x + 10, anchor.y + 6),
      vec(anchor.x - boxWidth - 10, anchor.y - 24),
      vec(anchor.x - boxWidth - 10, anchor.y + 6),
      vec(anchor.x - boxWidth * 0.5, anchor.y - 34),
      vec(anchor.x - boxWidth * 0.5, anchor.y + 12),
    ]

    const padding = 3
    let selected: LabelBox | null = null

    for (const candidate of candidates) {
      const x = clamp(candidate.x, bounds.x + padding, bounds.x + bounds.width - boxWidth - padding)
      const y = clamp(candidate.y, bounds.y + padding, bounds.y + bounds.height - boxHeight - padding)
      const box: LabelBox = { x, y, width: boxWidth, height: boxHeight }

      const intersects = occupied.some((other) => this.overlaps(box, other))
      if (!intersects) {
        selected = box
        break
      }
    }

    if (!selected) {
      selected = {
        x: clamp(anchor.x + 10, bounds.x + padding, bounds.x + bounds.width - boxWidth - padding),
        y: clamp(anchor.y - 24, bounds.y + padding, bounds.y + bounds.height - boxHeight - padding),
        width: boxWidth,
        height: boxHeight,
      }
    }

    occupied.push(selected)

    this.drawRoundedRect(selected.x, selected.y, selected.width, selected.height, 8)
    this.ctx.fillStyle = withAlpha('#ffffff', 0.95)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(color, 0.38)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "600 10px 'Manrope'"
    this.ctx.fillStyle = withAlpha(color, 0.96)
    this.ctx.fillText(text, selected.x + 7, selected.y + 13)
  }

  private overlaps(a: LabelBox, b: LabelBox): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  }

  private drawPanel(rect: Rect): void {
    this.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 14)
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d8e6f5', 0.95)
    this.ctx.lineWidth = 1
    this.ctx.stroke()
  }

  private drawChartGrid(rect: Rect, scale: ChartScale): void {
    const rows = 4

    for (let i = 0; i <= rows; i += 1) {
      const y = rect.y + (rect.height / rows) * i

      this.ctx.beginPath()
      this.ctx.moveTo(rect.x, y)
      this.ctx.lineTo(rect.x + rect.width, y)
      this.ctx.strokeStyle = withAlpha('#dfeaf9', i === rows ? 0.86 : 0.55)
      this.ctx.lineWidth = 1
      this.ctx.stroke()

      if (i < rows) {
        const value = numberLerp(scale.maxV, scale.minV, i / rows)
        this.ctx.font = "600 9px 'IBM Plex Mono'"
        this.ctx.fillStyle = withAlpha('#6c87a6', 0.9)
        this.ctx.fillText(value.toFixed(1), rect.x + 4, y - 3)
      }
    }
  }

  private drawThresholdLine(rect: Rect, scale: ChartScale, limit: number, alpha: number): void {
    if (alpha <= 0.02) {
      return
    }

    const y = scale.toY(limit)

    this.ctx.save()
    this.ctx.globalAlpha = clamp(alpha)
    this.ctx.setLineDash([6, 6])
    this.ctx.beginPath()
    this.ctx.moveTo(rect.x, y)
    this.ctx.lineTo(rect.x + rect.width, y)
    this.ctx.strokeStyle = withAlpha(WARN, 0.75)
    this.ctx.lineWidth = 1.2
    this.ctx.stroke()
    this.ctx.restore()

    this.ctx.font = "600 9px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(WARN, 0.95)
    this.ctx.fillText('on-call limit', rect.x + rect.width - 82, y - 5)
  }

  private drawCurve(scale: ChartScale, curve: (t: number) => number, color: string, visible: number, glow: boolean): void {
    const tMax = clamp(visible)
    if (tMax <= 0.02) {
      return
    }

    const toStep = Math.max(2, Math.round(CURVE_STEPS * tMax))

    if (glow) {
      this.ctx.beginPath()
      for (let i = 0; i <= toStep; i += 1) {
        const t = i / CURVE_STEPS
        const point = vec(scale.toX(t), scale.toY(curve(t)))
        if (i === 0) {
          this.ctx.moveTo(point.x, point.y)
        } else {
          this.ctx.lineTo(point.x, point.y)
        }
      }
      this.ctx.strokeStyle = withAlpha(color, 0.2)
      this.ctx.lineWidth = 6
      this.ctx.lineCap = 'round'
      this.ctx.stroke()
    }

    this.ctx.beginPath()
    for (let i = 0; i <= toStep; i += 1) {
      const t = i / CURVE_STEPS
      const point = vec(scale.toX(t), scale.toY(curve(t)))
      if (i === 0) {
        this.ctx.moveTo(point.x, point.y)
      } else {
        this.ctx.lineTo(point.x, point.y)
      }
    }
    this.ctx.strokeStyle = color
    this.ctx.lineWidth = 2.6
    this.ctx.lineCap = 'round'
    this.ctx.stroke()
  }

  private fillCurveGap(scale: ChartScale, rawCurve: (t: number) => number, safeCurve: (t: number) => number, visible: number): void {
    const tMax = clamp(visible)
    if (tMax <= 0.05) {
      return
    }

    const toStep = Math.max(3, Math.round(CURVE_STEPS * tMax))

    this.ctx.beginPath()
    for (let i = 0; i <= toStep; i += 1) {
      const t = i / CURVE_STEPS
      const x = scale.toX(t)
      const y = scale.toY(rawCurve(t))
      if (i === 0) {
        this.ctx.moveTo(x, y)
      } else {
        this.ctx.lineTo(x, y)
      }
    }

    for (let i = toStep; i >= 0; i -= 1) {
      const t = i / CURVE_STEPS
      this.ctx.lineTo(scale.toX(t), scale.toY(safeCurve(t)))
    }

    this.ctx.closePath()
    this.ctx.fillStyle = withAlpha(SAFE, 0.14)
    this.ctx.fill()
  }

  private firstCrossing(curve: (t: number) => number, limit: number): number {
    let previous = curve(0) - limit
    for (let i = 1; i <= CURVE_STEPS; i += 1) {
      const t = i / CURVE_STEPS
      const current = curve(t) - limit
      if (previous <= 0 && current > 0) {
        return t
      }
      previous = current
    }
    return 0.45
  }

  private drawPlayhead(rect: Rect, x: number): void {
    this.ctx.beginPath()
    this.ctx.moveTo(x, rect.y)
    this.ctx.lineTo(x, rect.y + rect.height)
    this.ctx.strokeStyle = withAlpha(SAFE, 0.24)
    this.ctx.lineWidth = 1.2
    this.ctx.stroke()
  }

  private drawArrow(from: Vec2, to: Vec2, color: string, width: number, dashed = false): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    if (distance < 1.2) {
      return
    }

    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = Math.min(10, Math.max(6, width * 3.1))

    this.ctx.save()
    if (dashed) {
      this.ctx.setLineDash([7, 5])
    }

    this.ctx.beginPath()
    this.ctx.moveTo(from.x, from.y)
    this.ctx.lineTo(to.x, to.y)
    this.ctx.strokeStyle = color
    this.ctx.lineWidth = width
    this.ctx.lineCap = 'round'
    this.ctx.stroke()
    this.ctx.restore()

    this.ctx.beginPath()
    this.ctx.moveTo(to.x, to.y)
    this.ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7))
    this.ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7))
    this.ctx.closePath()
    this.ctx.fillStyle = color
    this.ctx.fill()
  }

  private drawHandle(point: Vec2, color: string, radius: number): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius + 3.2, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.14)
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    this.ctx.fillStyle = color
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, Math.max(1.4, radius - 2), 0, Math.PI * 2)
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fill()
  }

  private drawToken(point: Vec2, color: string, radius: number): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius + 2.2, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.18)
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    this.ctx.fillStyle = color
    this.ctx.fill()
  }

  private drawPulse(point: Vec2, color: string, radius: number): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(color, 0.34)
    this.ctx.lineWidth = 1.6
    this.ctx.stroke()
  }

  private drawRoundedRect(x: number, y: number, width: number, height: number, radius: number): void {
    const r = Math.min(radius, width / 2, height / 2)

    this.ctx.beginPath()
    this.ctx.moveTo(x + r, y)
    this.ctx.arcTo(x + width, y, x + width, y + height, r)
    this.ctx.arcTo(x + width, y + height, x, y + height, r)
    this.ctx.arcTo(x, y + height, x, y, r)
    this.ctx.arcTo(x, y, x + width, y, r)
    this.ctx.closePath()
  }
}
