import { vec, worldBoundsFromHalfspaces } from './geometry'
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
  hit: number
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
  toY: (v: number) => number
}

const RAW_COLOR = '#f05570'
const SAFE_COLOR = '#2c6cf5'
const WARN_COLOR = '#f4a037'
const SHIP_COLOR = '#119a7a'
const HOLD_COLOR = '#9a5e2f'
const INK = '#173858'
const MUTED = '#4d6f92'

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

function easeOutBack(value: number): number {
  const t = clamp(value)
  const c1 = 1.2
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

    const pad = this.interactionRect
    const margin = 10
    if (
      point.x < pad.x - margin ||
      point.x > pad.x + pad.width + margin ||
      point.y < pad.y - margin ||
      point.y > pad.y + pad.height + margin
    ) {
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

    const chartRect: Rect = {
      x: frame.x + 16,
      y: frame.y + 16,
      width: frame.width - 32,
      height: frame.height * 0.58,
    }

    const bottomRect: Rect = {
      x: frame.x + 16,
      y: chartRect.y + chartRect.height + 12,
      width: frame.width - 32,
      height: frame.y + frame.height - (chartRect.y + chartRect.height + 12) - 16,
    }

    const padSize = Math.min(176, chartRect.height * 0.6)
    const controlRect: Rect = {
      x: chartRect.x + chartRect.width - padSize - 14,
      y: chartRect.y + 14,
      width: padSize,
      height: padSize,
    }

    const activeHalfspaces = input.halfspaces.filter((halfspace) => halfspace.active)
    const worldRadius = worldBoundsFromHalfspaces(activeHalfspaces) * 1.2
    const mapper = this.createMapper(controlRect, worldRadius)

    this.mapper = mapper
    this.interactionRect = controlRect

    const beats = this.resolveTeachingBeats(input.teachingProgress)
    const teachingMode = input.teachingProgress < 0.999
    const seconds = input.clockMs / 1000

    const rawBlocked = input.projection.diagnostics.some(
      (diagnostic) => diagnostic.active && diagnostic.violationStep0 > 1e-6,
    )
    const stage = this.resolveStage(input.mode, rawBlocked, teachingMode, beats)

    const highlightedId = this.resolveHighlightedConstraintId(input)

    this.drawForecastChart({
      rect: chartRect,
      input,
      stage,
      beats,
      rawBlocked,
      teachingMode,
      seconds,
    })

    this.drawControlPad({
      rect: controlRect,
      mapper,
      input,
      rawBlocked,
      teachingMode,
      beats,
      highlightedId,
      seconds,
    })

    this.drawOutcomeBoard({
      rect: bottomRect,
      input,
      beats,
      rawBlocked,
      teachingMode,
      seconds,
    })
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
      return { raw: 1, hit: 1, correction: 1, safe: 1 }
    }

    const t = clamp(progress)
    return {
      raw: easeOutCubic(phaseWindow(t, 0, 0.3)),
      hit: easeOutCubic(phaseWindow(t, 0.3, 0.48)),
      correction: easeOutCubic(phaseWindow(t, 0.48, 0.76)),
      safe: easeOutCubic(phaseWindow(t, 0.76, 1)),
    }
  }

  private resolveStage(mode: SceneMode, rawBlocked: boolean, teachingMode: boolean, beats: TeachingBeats): StageState {
    if (mode === 'forces') {
      return { index: 2, progress: 0.78 }
    }

    if (!teachingMode) {
      return { index: 3, progress: 1 }
    }

    if (beats.raw < 1) {
      return { index: 0, progress: beats.raw * 0.3 }
    }

    if (rawBlocked && beats.hit < 1) {
      return { index: 1, progress: 0.3 + beats.hit * 0.18 }
    }

    if (rawBlocked && beats.correction < 1) {
      return { index: 2, progress: 0.48 + beats.correction * 0.3 }
    }

    return { index: 3, progress: 0.78 + beats.safe * 0.22 }
  }

  private createMapper(rect: Rect, worldRadius: number): Mapper {
    const pad = 20
    const usableWidth = Math.max(20, rect.width - pad * 2)
    const usableHeight = Math.max(20, rect.height - pad * 2)
    const scale = Math.min(usableWidth / (worldRadius * 2), usableHeight / (worldRadius * 2))
    const center = vec(rect.x + rect.width * 0.5, rect.y + rect.height * 0.5)

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

    const glow = this.ctx.createRadialGradient(width * 0.12, 0, 14, width * 0.12, 0, width * 0.72)
    glow.addColorStop(0, 'rgba(44, 108, 245, 0.1)')
    glow.addColorStop(1, 'rgba(44, 108, 245, 0)')
    this.ctx.fillStyle = glow
    this.ctx.fillRect(0, 0, width, height)
  }

  private drawForecastChart(params: {
    rect: Rect
    input: SceneRenderInput
    stage: StageState
    beats: TeachingBeats
    rawBlocked: boolean
    teachingMode: boolean
    seconds: number
  }): void {
    const { rect, input, stage, beats, rawBlocked, teachingMode, seconds } = params

    this.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 14)
    this.ctx.fillStyle = '#fbfdff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d7e5f5', 0.95)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const chartInner: Rect = {
      x: rect.x + 16,
      y: rect.y + 46,
      width: rect.width - 208,
      height: rect.height - 62,
    }

    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#4a6789', 0.92)
    this.ctx.fillText('INCIDENT FORECAST (NEXT 60 MIN)', rect.x + 16, rect.y + 20)

    const diff = Math.max(0.2, Math.abs(input.stats.incidentRaw - input.stats.incidentSafe))
    const incidentLow = Math.max(0, Math.min(input.stats.incidentSafe, input.stats.incidentRaw) - diff * 0.35)
    const limit = input.stats.incidentSafe + diff * 0.52 + 0.45

    const rawCurve = (t: number): number => {
      const spike = Math.exp(-(((t - 0.45) / 0.2) ** 2))
      const slope = 0.28 * (1 - t)
      const direction = input.stats.incidentRaw >= input.stats.incidentSafe ? 1 : -1
      return input.stats.incidentSafe + direction * diff * (0.56 * spike + slope) + diff * 0.22
    }

    const safeCurve = (t: number): number => {
      const mild = Math.exp(-(((t - 0.43) / 0.24) ** 2))
      return input.stats.incidentSafe + diff * 0.08 * mild
    }

    let chartMax = limit
    for (let i = 0; i <= 80; i += 1) {
      const t = i / 80
      chartMax = Math.max(chartMax, rawCurve(t), safeCurve(t))
    }
    chartMax += 0.5

    const scale: ChartScale = {
      minV: incidentLow,
      maxV: chartMax,
      toX: (t) => chartInner.x + chartInner.width * clamp(t),
      toY: (v) => chartInner.y + chartInner.height * (1 - clamp((v - incidentLow) / Math.max(chartMax - incidentLow, 0.1))),
    }

    this.drawChartGrid(chartInner, scale)

    const rawVisible = teachingMode ? beats.raw : 1
    const safeVisible = teachingMode ? (rawBlocked ? beats.safe : beats.raw) : 1

    this.drawThresholdLine(chartInner, scale, limit, teachingMode ? Math.max(beats.hit, beats.safe) : 1)
    this.drawCurve(scale, rawCurve, RAW_COLOR, rawVisible, false)

    if (rawBlocked && (teachingMode ? beats.hit > 0.05 : true)) {
      const breachT = this.firstCrossing(rawCurve, limit)
      const bx = scale.toX(breachT)
      const by = scale.toY(rawCurve(breachT))
      this.drawPulse(vec(bx, by), WARN_COLOR, 12 + (teachingMode ? beats.hit * 12 : 8))
    }

    this.drawCurve(scale, safeCurve, SAFE_COLOR, safeVisible, true)

    if (safeVisible > 0.08) {
      this.fillCurveGap(scale, rawCurve, safeCurve, Math.min(rawVisible, safeVisible))
    }

    const playT = teachingMode ? clamp(rawVisible * 0.42 + safeVisible * 0.58) : (seconds * 0.23) % 1
    const px = scale.toX(playT)
    const pyRaw = scale.toY(rawCurve(playT))
    const pySafe = scale.toY(safeCurve(playT))

    this.drawPlayhead(chartInner, px)
    this.drawToken(vec(px, pyRaw), RAW_COLOR, 4.2)
    this.drawToken(vec(px, pySafe), SAFE_COLOR, 4.2)

    const prevented = Math.max(0, input.stats.incidentRaw - input.stats.incidentSafe)
    const chipX = chartInner.x
    const chipY = rect.y + 24
    const chipW = 190

    this.drawRoundedRect(chipX, chipY, chipW, 18, 9)
    this.ctx.fillStyle = withAlpha(prevented > 0 ? SHIP_COLOR : WARN_COLOR, 0.12)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(prevented > 0 ? SHIP_COLOR : WARN_COLOR, 0.35)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "600 9px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(prevented > 0 ? SHIP_COLOR : WARN_COLOR, 0.94)
    const chipText = prevented > 0 ? `${prevented.toFixed(1)} incidents/hr prevented` : 'No incident reduction from correction'
    this.ctx.fillText(chipText, chipX + 10, chipY + 12)

    this.drawStatusPill({
      rect,
      blocked: rawBlocked,
      decisionTone: input.stats.decisionTone,
      dragActive: input.dragActive,
    })
    this.drawTimeline(rect, stage)
  }

  private drawControlPad(params: {
    rect: Rect
    mapper: Mapper
    input: SceneRenderInput
    rawBlocked: boolean
    teachingMode: boolean
    beats: TeachingBeats
    highlightedId: string | null
    seconds: number
  }): void {
    const { rect, mapper, input, rawBlocked, teachingMode, beats, highlightedId, seconds } = params

    this.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 12)
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d9e6f5', 0.95)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "600 9px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#496788', 0.9)
    this.ctx.fillText('PATCH INTENT (DRAG)', rect.x + 10, rect.y + 14)

    const center = mapper.center
    const radius = Math.min(rect.width, rect.height) * 0.34

    this.ctx.beginPath()
    this.ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha('#bfd2ea', 0.7)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.beginPath()
    this.ctx.moveTo(center.x - radius, center.y)
    this.ctx.lineTo(center.x + radius, center.y)
    this.ctx.moveTo(center.x, center.y - radius)
    this.ctx.lineTo(center.x, center.y + radius)
    this.ctx.strokeStyle = withAlpha('#d0def0', 0.7)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const rawTip = mapper.worldToCanvas(input.projection.step0)
    const safeTip = mapper.worldToCanvas(input.projection.projectedStep)
    this.rawHandleCanvas = rawTip

    const rawVisible = teachingMode ? beats.raw : 1
    const safeVisible = teachingMode ? (rawBlocked ? beats.safe : beats.raw) : 1

    this.drawArrow(center, vecLerp(center, rawTip, rawVisible), RAW_COLOR, 2)
    this.drawArrow(center, vecLerp(center, safeTip, easeOutBack(safeVisible)), SAFE_COLOR, 2)

    if (rawBlocked) {
      const correctionVisible = teachingMode ? beats.correction : 1
      if (correctionVisible > 0.05) {
        this.drawArrow(rawTip, vecLerp(rawTip, safeTip, correctionVisible), WARN_COLOR, 1.8, true)
      }
    }

    if (input.mode === 'forces') {
      this.drawForceVectors(mapper, input.projection, input.visibleCorrectionIds, highlightedId)
    }

    this.drawHandle(rawTip, RAW_COLOR, 6)
    this.drawHandle(safeTip, SAFE_COLOR, 5)

    if (!teachingMode) {
      const cycle = (seconds * 0.8) % 1
      const packet = rawBlocked ? (cycle < 0.5 ? vecLerp(center, rawTip, cycle / 0.5) : vecLerp(rawTip, safeTip, (cycle - 0.5) / 0.5)) : vecLerp(center, safeTip, cycle)
      this.drawToken(packet, rawBlocked && cycle < 0.5 ? RAW_COLOR : SAFE_COLOR, 3.6)
    }
  }

  private drawOutcomeBoard(params: {
    rect: Rect
    input: SceneRenderInput
    beats: TeachingBeats
    rawBlocked: boolean
    teachingMode: boolean
    seconds: number
  }): void {
    const { rect, input, beats, rawBlocked, teachingMode, seconds } = params

    this.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 14)
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d8e6f5', 0.95)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const revealRaw = teachingMode ? clamp(beats.raw + beats.hit * 0.25) : 1
    const revealSafe = teachingMode ? clamp(beats.safe + beats.correction * 0.25) : 1

    const colW = (rect.width - 44) / 3
    const x0 = rect.x + 14
    const y0 = rect.y + 14

    this.drawOutcomeTile({
      x: x0,
      y: y0,
      width: colW,
      title: 'Raw Outcome',
      tone: RAW_COLOR,
      line1: `${input.stats.incidentRaw.toFixed(1)} incidents/hr`,
      line2: `${input.stats.checksRawPassed}/${input.stats.checksTotal} checks`,
      alpha: revealRaw,
    })

    this.drawOutcomeTile({
      x: x0 + colW + 8,
      y: y0,
      width: colW,
      title: 'Safe Outcome',
      tone: input.stats.decisionTone === 'ship' ? SHIP_COLOR : SAFE_COLOR,
      line1: `${input.stats.incidentSafe.toFixed(1)} incidents/hr`,
      line2: `${input.stats.checksSafePassed}/${input.stats.checksTotal} checks`,
      alpha: revealSafe,
    })

    const prevented = Math.round((input.stats.incidentRaw - input.stats.incidentSafe) * 10) / 10
    const checksDelta = input.stats.checksSafePassed - input.stats.checksRawPassed

    this.drawOutcomeTile({
      x: x0 + (colW + 8) * 2,
      y: y0,
      width: colW,
      title: input.stats.decisionTone === 'ship' ? 'Recommendation: SHIP' : 'Recommendation: HOLD',
      tone: input.stats.decisionTone === 'ship' ? SHIP_COLOR : HOLD_COLOR,
      line1: prevented >= 0 ? `${prevented.toFixed(1)}/hr prevented` : `${Math.abs(prevented).toFixed(1)}/hr added`,
      line2: `Value kept ${input.stats.retainedPct}%`,
      alpha: Math.max(revealSafe, 0.16),
    })

    const bridgeY = y0 + 68
    const start = vec(x0 + colW + 4, bridgeY)
    const end = vec(x0 + colW + 8, bridgeY)
    const end2 = vec(x0 + (colW + 8) * 2, bridgeY)

    this.drawArrow(start, end, withAlpha(SAFE_COLOR, 0.65), 1.6)
    this.drawArrow(vec(x0 + (colW + 8) * 2 - 4, bridgeY), end2, withAlpha(SAFE_COLOR, 0.65), 1.6)

    const runner = vecLerp(start, end2, teachingMode ? clamp(revealSafe) : (seconds * 0.65) % 1)
    this.drawToken(runner, SAFE_COLOR, 3.2)

    const reason = rawBlocked ? 'Unsafe rollout pressure corrected before release.' : 'Raw rollout already inside policy limits.'

    this.ctx.font = "600 10px 'Manrope'"
    this.ctx.fillStyle = withAlpha(MUTED, 0.95)
    this.ctx.fillText(reason, rect.x + 14, rect.y + rect.height - 18)

    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(checksDelta >= 0 ? SHIP_COLOR : WARN_COLOR, 0.92)
    this.ctx.textAlign = 'right'
    this.ctx.fillText(`Checks ${checksDelta >= 0 ? '+' : ''}${checksDelta}`, rect.x + rect.width - 14, rect.y + rect.height - 18)
    this.ctx.textAlign = 'left'
  }

  private drawOutcomeTile(input: {
    x: number
    y: number
    width: number
    title: string
    tone: string
    line1: string
    line2: string
    alpha: number
  }): void {
    const { x, y, width, title, tone, line1, line2, alpha } = input
    if (alpha <= 0.02) {
      return
    }

    this.ctx.save()
    this.ctx.globalAlpha = alpha

    this.drawRoundedRect(x, y, width, 84, 11)
    this.ctx.fillStyle = '#f9fcff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(tone, 0.3)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "600 9px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(tone, 0.95)
    this.ctx.fillText(title.toUpperCase(), x + 10, y + 14)

    this.ctx.font = "700 12px 'Manrope'"
    this.ctx.fillStyle = INK
    this.ctx.fillText(line1, x + 10, y + 36)

    this.ctx.font = "600 11px 'Manrope'"
    this.ctx.fillStyle = withAlpha(MUTED, 0.95)
    this.ctx.fillText(line2, x + 10, y + 56)

    this.ctx.restore()
  }

  private drawForceVectors(mapper: Mapper, projection: ProjectionResult, visibleIds: string[], highlightedId: string | null): void {
    const visible = new Set(visibleIds)
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

      const active = (visible.size === 0 || visible.has(id)) && (!highlightedId || highlightedId === id)
      this.drawArrow(
        mapper.worldToCanvas(cursor),
        mapper.worldToCanvas(next),
        withAlpha(this.colorForConstraint(id), active ? 0.9 : 0.28),
        active ? 2.2 : 1.4,
        true,
      )

      cursor = next
    }
  }

  private drawChartGrid(rect: Rect, scale: ChartScale): void {
    const rows = 5
    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()

    for (let i = 0; i <= rows; i += 1) {
      const y = rect.y + (rect.height / rows) * i
      this.ctx.beginPath()
      this.ctx.moveTo(rect.x, y)
      this.ctx.lineTo(rect.x + rect.width, y)
      this.ctx.strokeStyle = withAlpha('#dce8f8', i === rows ? 0.9 : 0.6)
      this.ctx.lineWidth = 1
      this.ctx.stroke()

      if (i < rows) {
        const value = numberLerp(scale.maxV, scale.minV, i / rows)
        this.ctx.font = "600 9px 'IBM Plex Mono'"
        this.ctx.fillStyle = withAlpha('#6a86a5', 0.9)
        this.ctx.fillText(value.toFixed(1), rect.x + 4, y - 3)
      }
    }

    this.ctx.restore()
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
    this.ctx.strokeStyle = withAlpha(WARN_COLOR, 0.7)
    this.ctx.lineWidth = 1.2
    this.ctx.stroke()
    this.ctx.restore()

    this.ctx.font = "600 9px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(WARN_COLOR, 0.95)
    this.ctx.fillText('On-call limit', rect.x + rect.width - 88, y - 6)
  }

  private drawCurve(scale: ChartScale, fn: (t: number) => number, color: string, visible: number, glow: boolean): void {
    const tMax = clamp(visible)
    if (tMax <= 0.01) {
      return
    }

    const steps = 96
    const toStep = Math.max(2, Math.round(steps * tMax))

    if (glow) {
      this.ctx.beginPath()
      for (let i = 0; i <= toStep; i += 1) {
        const t = i / steps
        const x = scale.toX(t)
        const y = scale.toY(fn(t))
        if (i === 0) {
          this.ctx.moveTo(x, y)
        } else {
          this.ctx.lineTo(x, y)
        }
      }
      this.ctx.strokeStyle = withAlpha(color, 0.2)
      this.ctx.lineWidth = 6
      this.ctx.lineCap = 'round'
      this.ctx.stroke()
    }

    this.ctx.beginPath()
    for (let i = 0; i <= toStep; i += 1) {
      const t = i / steps
      const x = scale.toX(t)
      const y = scale.toY(fn(t))
      if (i === 0) {
        this.ctx.moveTo(x, y)
      } else {
        this.ctx.lineTo(x, y)
      }
    }
    this.ctx.strokeStyle = color
    this.ctx.lineWidth = 2.4
    this.ctx.lineCap = 'round'
    this.ctx.stroke()
  }

  private fillCurveGap(scale: ChartScale, rawFn: (t: number) => number, safeFn: (t: number) => number, visible: number): void {
    const tMax = clamp(visible)
    if (tMax <= 0.04) {
      return
    }

    const steps = 80
    const toStep = Math.max(2, Math.round(steps * tMax))

    this.ctx.beginPath()
    for (let i = 0; i <= toStep; i += 1) {
      const t = i / steps
      const x = scale.toX(t)
      const y = scale.toY(rawFn(t))
      if (i === 0) {
        this.ctx.moveTo(x, y)
      } else {
        this.ctx.lineTo(x, y)
      }
    }
    for (let i = toStep; i >= 0; i -= 1) {
      const t = i / steps
      const x = scale.toX(t)
      const y = scale.toY(safeFn(t))
      this.ctx.lineTo(x, y)
    }
    this.ctx.closePath()
    this.ctx.fillStyle = withAlpha(SAFE_COLOR, 0.12)
    this.ctx.fill()
  }

  private firstCrossing(fn: (t: number) => number, limit: number): number {
    let prev = fn(0) - limit
    for (let i = 1; i <= 90; i += 1) {
      const t = i / 90
      const next = fn(t) - limit
      if (prev <= 0 && next > 0) {
        return t
      }
      prev = next
    }
    return 0.45
  }

  private drawPlayhead(rect: Rect, x: number): void {
    this.ctx.beginPath()
    this.ctx.moveTo(x, rect.y)
    this.ctx.lineTo(x, rect.y + rect.height)
    this.ctx.strokeStyle = withAlpha(SAFE_COLOR, 0.22)
    this.ctx.lineWidth = 1.2
    this.ctx.stroke()
  }

  private drawArrow(from: Vec2, to: Vec2, color: string, width: number, dashed = false): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    if (distance < 1.2) {
      return
    }

    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = Math.min(10, Math.max(6, width * 3.2))

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
    this.ctx.arc(point.x, point.y, radius + 3.4, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.14)
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    this.ctx.fillStyle = color
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, Math.max(1.2, radius - 2.1), 0, Math.PI * 2)
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fill()
  }

  private drawToken(point: Vec2, color: string, radius: number): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius + 2.7, 0, Math.PI * 2)
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
    this.ctx.strokeStyle = withAlpha(color, 0.3)
    this.ctx.lineWidth = 1.8
    this.ctx.stroke()
  }

  private drawStatusPill(input: {
    rect: Rect
    blocked: boolean
    decisionTone: 'ship' | 'hold'
    dragActive: boolean
  }): void {
    const { rect, blocked, decisionTone, dragActive } = input

    const x = rect.x + 12
    const y = rect.y + 12
    const w = 174
    const h = 28

    this.drawRoundedRect(x, y, w, h, 14)
    const tone = dragActive ? SAFE_COLOR : blocked ? WARN_COLOR : decisionTone === 'ship' ? SHIP_COLOR : HOLD_COLOR
    this.ctx.fillStyle = withAlpha(tone, 0.12)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(tone, 0.35)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(tone, 0.96)

    let text = 'RELEASE IMPACT RUNNING'
    if (dragActive) {
      text = 'LIVE PATCH TEST'
    } else if (blocked) {
      text = 'RAW RISK DETECTED'
    } else if (decisionTone === 'ship') {
      text = 'RAW PATCH SAFE'
    }

    this.ctx.fillText(text, x + 12, y + 18)
  }

  private drawTimeline(rect: Rect, stage: { index: 0 | 1 | 2 | 3; progress: number }): void {
    const width = Math.min(252, rect.width - 24)
    const x = rect.x + rect.width - width - 12
    const y = rect.y + 12

    this.drawRoundedRect(x, y, width, 28, 14)
    this.ctx.fillStyle = withAlpha('#ffffff', 0.92)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d6e5f5', 0.92)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const railX0 = x + 18
    const railX1 = x + width - 18
    const railY = y + 14

    this.ctx.beginPath()
    this.ctx.moveTo(railX0, railY)
    this.ctx.lineTo(railX1, railY)
    this.ctx.strokeStyle = '#e2ecf9'
    this.ctx.lineWidth = 4
    this.ctx.lineCap = 'round'
    this.ctx.stroke()

    const fillX = numberLerp(railX0, railX1, clamp(stage.progress))
    this.ctx.beginPath()
    this.ctx.moveTo(railX0, railY)
    this.ctx.lineTo(fillX, railY)
    this.ctx.strokeStyle = withAlpha(SAFE_COLOR, 0.9)
    this.ctx.lineWidth = 4
    this.ctx.lineCap = 'round'
    this.ctx.stroke()

    for (let i = 0; i < 4; i += 1) {
      const t = i / 3
      const cx = numberLerp(railX0, railX1, t)

      this.ctx.beginPath()
      this.ctx.arc(cx, railY, i === stage.index ? 5.2 : 3.8, 0, Math.PI * 2)
      this.ctx.fillStyle = i <= stage.index ? withAlpha(SAFE_COLOR, 0.95) : '#edf4ff'
      this.ctx.fill()
    }
  }

  private colorForConstraint(id: string): string {
    if (id.startsWith('g1')) return '#ef6f8f'
    if (id.startsWith('g2')) return '#4f8dff'
    if (id.startsWith('g3')) return '#18a28c'
    if (id.startsWith('g4')) return '#f0a941'
    return '#7b5dde'
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
