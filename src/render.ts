import {
  intersectHalfspaces,
  lerp,
  normalize,
  scale,
  sub,
  vec,
  worldBoundsFromHalfspaces,
} from './geometry'
import type { Halfspace, Vec2 } from './geometry'
import type { ConstraintDiagnostic } from './qp'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Mapper {
  worldToCanvas: (point: Vec2) => Vec2
  center: Vec2
  worldRadius: number
}

export interface SceneRenderInput {
  halfspaces: Halfspace[]
  step0: Vec2
  projectedStep: Vec2
  gradient: Vec2
  queueRawSeries: number[]
  queueSafeSeries: number[]
  overloadThreshold: number
  transitionProgress: number
  clockMs: number
  constraintDiagnostics: ConstraintDiagnostic[]
  activeSetIds: string[]
}

const RAW_COLOR = '#df5b77'
const SAFE_COLOR = '#2f77ea'
const WARN_COLOR = '#e7944d'
const PANEL_STROKE = 'rgba(123, 151, 186, 0.55)'
const GRID_STROKE = 'rgba(128, 156, 192, 0.2)'
const FEASIBLE_COLOR = 'rgba(56, 151, 113, 0.15)'

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max)
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
  const c1 = 1.70158
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
  const clean = hex.replace('#', '')
  const parsed = Number.parseInt(clean, 16)
  const r = (parsed >> 16) & 255
  const g = (parsed >> 8) & 255
  const b = parsed & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function shortLabel(text: string): string {
  const first = text.trim().split(' ')[0] ?? ''
  return first.length > 8 ? `${first.slice(0, 7)}.` : first
}

export class SceneRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D

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

  render(input: SceneRenderInput): void {
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    if (width <= 0 || height <= 0) {
      return
    }

    const timeline = clamp(input.transitionProgress)
    const phaseRaw = easeOutCubic(phaseWindow(timeline, 0, 0.24))
    const phaseHit = easeOutCubic(phaseWindow(timeline, 0.24, 0.48))
    const phaseSnap = easeOutCubic(phaseWindow(timeline, 0.48, 0.76))
    const phaseBars = easeOutCubic(phaseWindow(timeline, 0.68, 0.9))
    const phaseQueue = easeInOutCubic(phaseWindow(timeline, 0.76, 1))
    const pulse = 0.5 + 0.5 * Math.sin(input.clockMs * 0.0019)

    this.ctx.clearRect(0, 0, width, height)
    this.drawBackdrop(width, height)

    const frame: Rect = {
      x: 16,
      y: 16,
      width: width - 32,
      height: height - 32,
    }

    this.drawFrameChrome(frame)

    const content: Rect = {
      x: frame.x + 12,
      y: frame.y + 52,
      width: frame.width - 24,
      height: frame.height - 64,
    }

    let geometryRect: Rect
    let barsRect: Rect
    let queueRect: Rect

    if (content.width < 920) {
      const geomHeight = Math.max(180, Math.round(content.height * 0.6))
      geometryRect = {
        x: content.x,
        y: content.y,
        width: content.width,
        height: geomHeight,
      }
      const lowerRect: Rect = {
        x: content.x,
        y: geometryRect.y + geometryRect.height + 10,
        width: content.width,
        height: content.height - geomHeight - 10,
      }
      const barsHeight = Math.max(84, Math.round(lowerRect.height * 0.44))
      barsRect = {
        x: lowerRect.x,
        y: lowerRect.y,
        width: lowerRect.width,
        height: barsHeight,
      }
      queueRect = {
        x: lowerRect.x,
        y: barsRect.y + barsRect.height + 10,
        width: lowerRect.width,
        height: lowerRect.height - barsHeight - 10,
      }
    } else {
      const geomWidth = Math.round(content.width * 0.7)
      geometryRect = {
        x: content.x,
        y: content.y,
        width: geomWidth,
        height: content.height,
      }
      const sideRect: Rect = {
        x: geometryRect.x + geometryRect.width + 10,
        y: content.y,
        width: content.width - geomWidth - 10,
        height: content.height,
      }
      const barsHeight = Math.max(120, Math.round(sideRect.height * 0.38))
      barsRect = {
        x: sideRect.x,
        y: sideRect.y,
        width: sideRect.width,
        height: barsHeight,
      }
      queueRect = {
        x: sideRect.x,
        y: barsRect.y + barsRect.height + 10,
        width: sideRect.width,
        height: sideRect.height - barsHeight - 10,
      }
    }

    const queueLength = Math.min(input.queueRawSeries.length, input.queueSafeSeries.length)
    const rawSeries = input.queueRawSeries.slice(0, queueLength)
    const safeSeries = input.queueSafeSeries.slice(0, queueLength)

    this.drawGeometryStage(
      geometryRect,
      input.halfspaces,
      input.step0,
      input.projectedStep,
      input.gradient,
      input.constraintDiagnostics,
      phaseRaw,
      phaseHit,
      phaseSnap,
      pulse,
    )

    this.drawPressureWidget(barsRect, input.constraintDiagnostics, input.activeSetIds, phaseBars)
    this.drawQueueWidget(queueRect, rawSeries, safeSeries, input.overloadThreshold, phaseQueue, pulse)
  }

  private drawBackdrop(width: number, height: number): void {
    const ctx = this.ctx
    ctx.fillStyle = '#0f1a2d'
    ctx.fillRect(0, 0, width, height)

    ctx.fillStyle = 'rgba(59, 109, 185, 0.12)'
    ctx.beginPath()
    ctx.ellipse(width * 0.22, height * 0.12, width * 0.35, height * 0.25, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  private drawFrameChrome(frame: Rect): void {
    const ctx = this.ctx

    this.drawRoundedRect(frame.x, frame.y, frame.width, frame.height, 12)
    ctx.fillStyle = 'rgba(12, 22, 35, 0.78)'
    ctx.fill()
    ctx.strokeStyle = PANEL_STROKE
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = 'rgba(91, 145, 229, 0.28)'
    ctx.fillRect(frame.x + 12, frame.y + 10, Math.min(220, frame.width * 0.32), 2)

    ctx.font = '700 10px "IBM Plex Mono", monospace'
    ctx.fillStyle = '#8fb4e3'
    ctx.fillText('PROJECTION STAGE', frame.x + 12, frame.y + 24)

    ctx.font = '600 10px "Sora", sans-serif'
    ctx.fillStyle = '#6f8db2'
    ctx.fillText('raw step -> boundary hit -> push-back -> safe step', frame.x + 12, frame.y + 39)
  }

  private drawGeometryStage(
    rect: Rect,
    halfspaces: Halfspace[],
    step0: Vec2,
    projectedStep: Vec2,
    gradient: Vec2,
    diagnostics: ConstraintDiagnostic[],
    phaseRaw: number,
    phaseHit: number,
    phaseSnap: number,
    pulse: number,
  ): void {
    this.drawSubframe(rect)
    this.drawGrid(rect, 5, 5)

    const active = halfspaces.filter((halfspace) => halfspace.active)
    const mapper = this.createMapper(rect, active)

    const zone = intersectHalfspaces(active, mapper.worldRadius)
    if (!zone.isEmpty) {
      this.ctx.beginPath()
      zone.vertices.forEach((vertex, index) => {
        const point = mapper.worldToCanvas(vertex)
        if (index === 0) {
          this.ctx.moveTo(point.x, point.y)
        } else {
          this.ctx.lineTo(point.x, point.y)
        }
      })
      this.ctx.closePath()
      this.ctx.fillStyle = FEASIBLE_COLOR
      this.ctx.fill()
      this.ctx.strokeStyle = 'rgba(80, 170, 130, 0.78)'
      this.ctx.lineWidth = 1
      this.ctx.stroke()
    }

    const violationById = new Map(diagnostics.map((item) => [item.id, item]))
    this.drawBoundaryLines(mapper, active, violationById, phaseHit, pulse)

    const origin = mapper.worldToCanvas(vec(0, 0))
    const rawTarget = mapper.worldToCanvas(step0)

    const rawVisible = mapper.worldToCanvas(lerp(vec(0, 0), step0, clamp(phaseRaw, 0.02, 1)))
    this.drawArrow(origin, rawVisible, RAW_COLOR, 2.1)

    const primaryViolation = diagnostics
      .filter((item) => item.active && item.violationStep0 > 1e-6)
      .sort((a, b) => b.violationStep0 - a.violationStep0)[0]

    if (primaryViolation && phaseHit > 0.03) {
      this.drawViolationPulse(mapper, primaryViolation, phaseHit, pulse)
      this.drawTag(rawTarget, 'Check violated', WARN_COLOR)
    }

    if (phaseSnap > 0.02) {
      const snapProgress = clamp(easeOutBack(phaseSnap), 0, 1.05)
      const safeVisible = mapper.worldToCanvas(lerp(step0, projectedStep, snapProgress))
      this.drawArrow(origin, safeVisible, SAFE_COLOR, 2.5)
      this.drawArrow(rawTarget, safeVisible, WARN_COLOR, 1.4, true)
      this.drawTag(safeVisible, 'Safe step', SAFE_COLOR)
      this.drawTag(rawTarget, 'Raw step', RAW_COLOR, -18)
    }

    this.drawArrow(origin, mapper.worldToCanvas(scale(normalize(gradient), -mapper.worldRadius * 0.62)), '#f1c46f', 1.1, true)

    this.drawNode(origin, '#8eb4e4', 3.6)
    this.drawNode(rawVisible, RAW_COLOR, 3.6)
    if (phaseSnap > 0.02) {
      const snapProgress = clamp(easeOutBack(phaseSnap), 0, 1)
      this.drawNode(mapper.worldToCanvas(lerp(step0, projectedStep, snapProgress)), SAFE_COLOR, 3.8)
    }

    const caption =
      phaseSnap < 0.06
        ? 'Raw step is evaluated first.'
        : phaseSnap < 0.95
          ? 'Only the unsafe part is corrected.'
          : 'Projected step is feasible under active checks.'

    this.drawCaption(rect, caption)
  }

  private drawPressureWidget(rect: Rect, diagnostics: ConstraintDiagnostic[], activeSetIds: string[], phaseBars: number): void {
    this.drawSubframe(rect)

    const ctx = this.ctx
    ctx.font = '700 9px "IBM Plex Mono", monospace'
    ctx.fillStyle = '#90b7e6'
    ctx.fillText('ACTIVE CHECK PRESSURE', rect.x + 8, rect.y + 14)

    const activeSet = new Set(activeSetIds)
    const items = diagnostics
      .filter((item) => item.active)
      .sort((a, b) => {
        const aActive = activeSet.has(a.id) ? 1 : 0
        const bActive = activeSet.has(b.id) ? 1 : 0
        if (aActive !== bActive) {
          return bActive - aActive
        }
        return Math.max(b.lambda, b.violationStep0) - Math.max(a.lambda, a.violationStep0)
      })
      .slice(0, 4)

    const maxLoad = Math.max(
      0.001,
      ...items.map((item) => (activeSet.has(item.id) ? Math.max(item.lambda, item.violationStep0) : item.violationStep0 * 0.22)),
    )

    items.forEach((item, index) => {
      const y = rect.y + 24 + index * 18
      const active = activeSet.has(item.id)
      const load = active ? Math.max(item.lambda, item.violationStep0) : item.violationStep0 * 0.22
      const normalized = clamp(load / maxLoad)
      const fillRatio = clamp((active ? 0.18 + normalized * 0.82 : normalized * 0.18) * phaseBars)

      ctx.font = '600 8px "Sora", sans-serif'
      ctx.fillStyle = active ? '#c2e4ff' : '#7f97ba'
      ctx.fillText(shortLabel(item.label), rect.x + 8, y + 8)

      const barX = rect.x + 62
      const barY = y + 2
      const barWidth = rect.width - 70

      this.drawRoundedRect(barX, barY, barWidth, 7, 3)
      ctx.fillStyle = 'rgba(115, 146, 187, 0.2)'
      ctx.fill()

      this.drawRoundedRect(barX, barY, barWidth * fillRatio, 7, 3)
      ctx.fillStyle = active ? withAlpha(SAFE_COLOR, 0.84) : withAlpha('#7f97ba', 0.36)
      ctx.fill()
    })
  }

  private drawQueueWidget(rect: Rect, rawSeries: number[], safeSeries: number[], threshold: number, phaseQueue: number, pulse: number): void {
    this.drawSubframe(rect)
    if (rawSeries.length === 0 || safeSeries.length === 0) {
      return
    }

    const chart: Rect = {
      x: rect.x + 8,
      y: rect.y + 18,
      width: rect.width - 16,
      height: rect.height - 28,
    }

    this.drawGrid(chart, 3, 3)

    const maxValue = Math.max(...rawSeries, ...safeSeries, threshold, 1)
    const upper = maxValue * 1.08
    const mapX = (index: number, length: number): number => chart.x + (index / Math.max(1, length - 1)) * chart.width
    const mapY = (value: number): number => chart.y + chart.height - (value / upper) * chart.height

    const reveal = clamp(phaseQueue)
    const thresholdY = mapY(threshold)

    this.ctx.save()
    this.ctx.setLineDash([5, 4])
    this.ctx.beginPath()
    this.ctx.moveTo(chart.x, thresholdY)
    this.ctx.lineTo(chart.x + chart.width, thresholdY)
    this.ctx.strokeStyle = withAlpha(RAW_COLOR, 0.72)
    this.ctx.lineWidth = 1
    this.ctx.stroke()
    this.ctx.restore()

    this.drawClipped(chart, reveal, () => {
      this.drawSmoothSeries(rawSeries, mapX, mapY, RAW_COLOR, 1.9)
      this.drawSmoothSeries(safeSeries, mapX, mapY, SAFE_COLOR, 2.4)
      const x = chart.x + chart.width * reveal
      const gradient = this.ctx.createLinearGradient(x - 20, chart.y, x + 20, chart.y)
      gradient.addColorStop(0, 'rgba(47, 119, 234, 0)')
      gradient.addColorStop(0.5, `rgba(47, 119, 234, ${0.1 + pulse * 0.08})`)
      gradient.addColorStop(1, 'rgba(47, 119, 234, 0)')
      this.ctx.fillStyle = gradient
      this.ctx.fillRect(x - 20, chart.y, 40, chart.height)
    })

    const delta = Math.max(0, Math.round(rawSeries[rawSeries.length - 1] - safeSeries[safeSeries.length - 1]))
    this.ctx.font = '700 9px "IBM Plex Mono", monospace'
    this.ctx.fillStyle = '#92b9ea'
    this.ctx.fillText(reveal < 0.2 ? 'REPLAYING...' : `${Math.round(delta * reveal)} fewer queued`, rect.x + 8, rect.y + 12)
  }

  private drawBoundaryLines(
    mapper: Mapper,
    halfspaces: Halfspace[],
    diagnosticsById: Map<string, ConstraintDiagnostic>,
    phaseHit: number,
    pulse: number,
  ): void {
    const span = mapper.worldRadius * 1.8

    halfspaces.forEach((halfspace, index) => {
      const normal = normalize(halfspace.normal)
      const tangent = vec(-normal.y, normal.x)
      const anchor = scale(normal, halfspace.bound)
      const p0 = mapper.worldToCanvas(sub(anchor, scale(tangent, span)))
      const p1 = mapper.worldToCanvas(sub(anchor, scale(tangent, -span)))

      const violated = (diagnosticsById.get(halfspace.id)?.violationStep0 ?? 0) > 1e-6

      this.ctx.beginPath()
      this.ctx.moveTo(p0.x, p0.y)
      this.ctx.lineTo(p1.x, p1.y)
      this.ctx.strokeStyle = withAlpha(index % 2 === 0 ? '#7eaee3' : '#76c6a7', violated ? 0.44 : 0.34)
      this.ctx.lineWidth = 1
      this.ctx.stroke()

      if (violated && phaseHit > 0.02) {
        this.ctx.beginPath()
        this.ctx.moveTo(p0.x, p0.y)
        this.ctx.lineTo(p1.x, p1.y)
        this.ctx.strokeStyle = withAlpha(WARN_COLOR, 0.2 + phaseHit * 0.38 + pulse * 0.06)
        this.ctx.lineWidth = 1
        this.ctx.stroke()
      }
    })
  }

  private drawViolationPulse(mapper: Mapper, diagnostic: ConstraintDiagnostic, phaseHit: number, pulse: number): void {
    const normal = normalize(diagnostic.normal)
    const anchor = scale(normal, diagnostic.bound)
    const point = mapper.worldToCanvas(anchor)
    const radius = 7 + phaseHit * 4 + pulse * 1.2

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(WARN_COLOR, 0.28 + phaseHit * 0.34)
    this.ctx.lineWidth = 1
    this.ctx.stroke()
  }

  private drawSubframe(rect: Rect): void {
    this.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 10)
    this.ctx.fillStyle = 'rgba(14, 24, 38, 0.78)'
    this.ctx.fill()
    this.ctx.strokeStyle = 'rgba(80, 113, 155, 0.62)'
    this.ctx.lineWidth = 1
    this.ctx.stroke()
  }

  private drawGrid(rect: Rect, vertical: number, horizontal: number): void {
    for (let i = 0; i <= vertical; i += 1) {
      const x = rect.x + (i / vertical) * rect.width
      this.ctx.beginPath()
      this.ctx.moveTo(x, rect.y)
      this.ctx.lineTo(x, rect.y + rect.height)
      this.ctx.strokeStyle = GRID_STROKE
      this.ctx.lineWidth = 1
      this.ctx.stroke()
    }

    for (let i = 0; i <= horizontal; i += 1) {
      const y = rect.y + (i / horizontal) * rect.height
      this.ctx.beginPath()
      this.ctx.moveTo(rect.x, y)
      this.ctx.lineTo(rect.x + rect.width, y)
      this.ctx.strokeStyle = GRID_STROKE
      this.ctx.lineWidth = 1
      this.ctx.stroke()
    }
  }

  private createMapper(rect: Rect, halfspaces: Halfspace[]): Mapper {
    const radius = worldBoundsFromHalfspaces(halfspaces)
    const pad = 12
    const usableWidth = rect.width - pad * 2
    const usableHeight = rect.height - pad * 2
    const scaleFactor = Math.min(usableWidth / (radius * 2), usableHeight / (radius * 2))
    const center = vec(rect.x + rect.width / 2, rect.y + rect.height / 2)

    return {
      worldRadius: radius,
      center,
      worldToCanvas: (point: Vec2) => vec(center.x + point.x * scaleFactor, center.y - point.y * scaleFactor),
    }
  }

  private drawArrow(from: Vec2, to: Vec2, color: string, width: number, dashed = false): void {
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = 8

    this.ctx.save()
    if (dashed) {
      this.ctx.setLineDash([5, 4])
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
    this.ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6))
    this.ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6))
    this.ctx.closePath()
    this.ctx.fillStyle = color
    this.ctx.fill()
  }

  private drawNode(point: Vec2, color: string, radius: number): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    this.ctx.fillStyle = color
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius + 4.8, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(color, 0.35)
    this.ctx.lineWidth = 1
    this.ctx.stroke()
  }

  private drawTag(point: Vec2, text: string, color: string, dy = -12): void {
    this.ctx.font = '600 9px "Sora", sans-serif'
    const width = this.ctx.measureText(text).width + 12
    const x = clamp(point.x + 8, 8, this.canvas.clientWidth - width - 8)
    const y = clamp(point.y + dy, 8, this.canvas.clientHeight - 22)

    this.drawRoundedRect(x, y, width, 16, 6)
    this.ctx.fillStyle = 'rgba(12, 22, 35, 0.88)'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(color, 0.5)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.fillStyle = withAlpha(color, 0.95)
    this.ctx.fillText(text, x + 6, y + 11)
  }

  private drawCaption(rect: Rect, text: string): void {
    this.ctx.font = '600 10px "Sora", sans-serif'
    this.ctx.fillStyle = '#96b9e8'
    this.ctx.fillText(text, rect.x + 8, rect.y + rect.height - 10)
  }

  private drawClipped(chart: Rect, reveal: number, draw: () => void): void {
    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(chart.x, chart.y, chart.width * reveal, chart.height)
    this.ctx.clip()
    draw()
    this.ctx.restore()
  }

  private drawSmoothSeries(
    series: number[],
    mapX: (index: number, length: number) => number,
    mapY: (value: number) => number,
    color: string,
    width: number,
  ): void {
    if (series.length < 2) {
      return
    }

    const points = series.map((value, index) => vec(mapX(index, series.length), mapY(value)))

    this.ctx.beginPath()
    this.ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length - 1; i += 1) {
      const current = points[i]
      const next = points[i + 1]
      const midX = (current.x + next.x) / 2
      const midY = (current.y + next.y) / 2
      this.ctx.quadraticCurveTo(current.x, current.y, midX, midY)
    }
    this.ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y)

    this.ctx.strokeStyle = color
    this.ctx.lineWidth = width
    this.ctx.lineCap = 'round'
    this.ctx.lineJoin = 'round'
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
