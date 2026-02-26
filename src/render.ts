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

const RAW_COLOR = '#ff6b88'
const SAFE_COLOR = '#59d4ff'
const ZONE_COLOR = '#43d2a0'
const BRIDGE_COLOR = '#ffd27a'
const VIOLATION_COLOR = '#ff8ea4'
const GRID_STROKE = 'rgba(134, 168, 208, 0.2)'

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
  const head = text.trim().split(' ')[0] ?? ''
  return head.length > 8 ? `${head.slice(0, 7)}.` : head
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
    const phaseRaw = easeOutCubic(phaseWindow(timeline, 0, 0.26))
    const phaseViolation = easeOutCubic(phaseWindow(timeline, 0.2, 0.44))
    const phaseProject = easeInOutCubic(phaseWindow(timeline, 0.36, 0.72))
    const phaseQueue = easeInOutCubic(phaseWindow(timeline, 0.66, 1))
    const pulse = 0.5 + 0.5 * Math.sin(input.clockMs * 0.002)

    this.ctx.clearRect(0, 0, width, height)
    this.drawBackdrop(width, height, input.clockMs, phaseQueue)

    const margin = 16
    const gap = 12
    const stacked = width < 980

    let geometryPanel: Rect
    let queuePanel: Rect

    if (stacked) {
      const topHeight = Math.max(225, Math.round((height - margin * 2 - gap) * 0.47))
      geometryPanel = {
        x: margin,
        y: margin,
        width: width - margin * 2,
        height: topHeight,
      }
      queuePanel = {
        x: margin,
        y: geometryPanel.y + geometryPanel.height + gap,
        width: width - margin * 2,
        height: height - margin * 2 - topHeight - gap,
      }
    } else {
      const leftWidth = Math.round((width - margin * 2 - gap) * 0.48)
      geometryPanel = {
        x: margin,
        y: margin,
        width: leftWidth,
        height: height - margin * 2,
      }
      queuePanel = {
        x: margin + leftWidth + gap,
        y: margin,
        width: width - margin * 2 - leftWidth - gap,
        height: height - margin * 2,
      }
    }

    const queueLength = Math.min(input.queueRawSeries.length, input.queueSafeSeries.length)
    const rawSeries = input.queueRawSeries.slice(0, queueLength)
    const safeTarget = input.queueSafeSeries.slice(0, queueLength)
    const safeAnimated = rawSeries.map((value, index) => value + (safeTarget[index] - value) * phaseQueue)

    const geometrySubtitle =
      phaseProject < 0.1
        ? '1) raw step'
        : phaseProject < 0.95
          ? '2) projection to nearest feasible step'
          : '3) safe step'

    const queueSubtitle = phaseQueue < 0.12 ? 'queue replay queued' : 'queue replay under identical traffic'

    this.drawPanelChrome(geometryPanel, 'PATCH SPACE', geometrySubtitle, phaseProject)
    this.drawPanelChrome(queuePanel, 'QUEUE IMPACT', queueSubtitle, phaseQueue)

    this.drawGeometryPanel(
      geometryPanel,
      input.halfspaces,
      input.step0,
      input.projectedStep,
      input.gradient,
      input.constraintDiagnostics,
      input.activeSetIds,
      phaseRaw,
      phaseViolation,
      phaseProject,
      pulse,
    )

    this.drawQueuePanel(queuePanel, rawSeries, safeAnimated, input.overloadThreshold, phaseQueue, pulse)
  }

  private drawBackdrop(width: number, height: number, clockMs: number, phaseQueue: number): void {
    const ctx = this.ctx

    const base = ctx.createLinearGradient(0, 0, 0, height)
    base.addColorStop(0, '#111d30')
    base.addColorStop(1, '#0a1220')
    ctx.fillStyle = base
    ctx.fillRect(0, 0, width, height)

    const topGlowX = width * 0.2 + Math.sin(clockMs * 0.00035) * 22
    const topGlowY = height * 0.1 + Math.cos(clockMs * 0.00028) * 10
    const topGlow = ctx.createRadialGradient(topGlowX, topGlowY, 18, topGlowX, topGlowY, width * 0.62)
    topGlow.addColorStop(0, 'rgba(86, 148, 233, 0.24)')
    topGlow.addColorStop(1, 'rgba(86, 148, 233, 0)')
    ctx.fillStyle = topGlow
    ctx.fillRect(0, 0, width, height)

    const lowerGlow = ctx.createRadialGradient(width * 0.84, height * 0.86, 18, width * 0.84, height * 0.86, width * 0.52)
    lowerGlow.addColorStop(0, `rgba(89, 212, 255, ${0.12 + phaseQueue * 0.12})`)
    lowerGlow.addColorStop(1, 'rgba(89, 212, 255, 0)')
    ctx.fillStyle = lowerGlow
    ctx.fillRect(0, 0, width, height)
  }

  private drawPanelChrome(panel: Rect, title: string, subtitle: string, accentProgress: number): void {
    const ctx = this.ctx

    this.drawRoundedRect(panel.x, panel.y, panel.width, panel.height, 12)
    ctx.fillStyle = 'rgba(15, 25, 40, 0.8)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(63, 95, 138, 0.7)'
    ctx.lineWidth = 1
    ctx.stroke()

    const accent = ctx.createLinearGradient(panel.x + 12, panel.y, panel.x + panel.width * 0.74, panel.y)
    accent.addColorStop(0, `rgba(89, 156, 247, ${0.34 + accentProgress * 0.3})`)
    accent.addColorStop(1, 'rgba(89, 156, 247, 0)')
    ctx.fillStyle = accent
    ctx.fillRect(panel.x + 12, panel.y + 10, Math.max(120, panel.width * 0.48), 2)

    ctx.font = '700 10px "IBM Plex Mono", monospace'
    ctx.fillStyle = '#8eb3e1'
    ctx.fillText(title, panel.x + 12, panel.y + 24)

    ctx.font = '600 10px "Sora", sans-serif'
    ctx.fillStyle = '#6f8cb1'
    ctx.fillText(subtitle, panel.x + 12, panel.y + 39)
  }

  private drawGeometryPanel(
    panel: Rect,
    halfspaces: Halfspace[],
    step0: Vec2,
    projectedStep: Vec2,
    gradient: Vec2,
    diagnostics: ConstraintDiagnostic[],
    activeSetIds: string[],
    phaseRaw: number,
    phaseViolation: number,
    phaseProject: number,
    pulse: number,
  ): void {
    const ctx = this.ctx
    const chart: Rect = {
      x: panel.x + 12,
      y: panel.y + 56,
      width: panel.width - 24,
      height: panel.height - 74,
    }

    this.drawGrid(chart, 4, 4)

    const active = halfspaces.filter((halfspace) => halfspace.active)
    const mapper = this.createMapper(chart, active)
    const zone = intersectHalfspaces(active, mapper.worldRadius)

    if (!zone.isEmpty) {
      ctx.beginPath()
      zone.vertices.forEach((vertex, index) => {
        const mapped = mapper.worldToCanvas(vertex)
        if (index === 0) {
          ctx.moveTo(mapped.x, mapped.y)
        } else {
          ctx.lineTo(mapped.x, mapped.y)
        }
      })
      ctx.closePath()

      const zoneFill = ctx.createLinearGradient(chart.x, chart.y, chart.x + chart.width, chart.y + chart.height)
      zoneFill.addColorStop(0, withAlpha(ZONE_COLOR, 0.14 + pulse * 0.05))
      zoneFill.addColorStop(1, withAlpha(ZONE_COLOR, 0.05))
      ctx.fillStyle = zoneFill
      ctx.fill()
      ctx.strokeStyle = withAlpha(ZONE_COLOR, 0.74)
      ctx.lineWidth = 1.2
      ctx.stroke()
    }

    const diagnosticsById = new Map(diagnostics.map((item) => [item.id, item]))
    this.drawConstraintBoundaries(mapper, active, diagnosticsById, phaseViolation, pulse)

    const origin = mapper.worldToCanvas(vec(0, 0))
    const rawTarget = mapper.worldToCanvas(step0)
    const rawVisible = mapper.worldToCanvas(scale(step0, clamp(phaseRaw, 0.02, 1)))
    const safeTarget = mapper.worldToCanvas(projectedStep)
    const safeVisible = mapper.worldToCanvas(lerp(step0, projectedStep, phaseProject))

    this.drawArrow(origin, rawVisible, withAlpha(RAW_COLOR, 0.9), 2.2, false)

    if (phaseViolation > 0.05) {
      this.drawViolationMarkers(mapper, diagnostics, phaseViolation, pulse)
    }

    if (phaseProject > 0.03) {
      this.drawArrow(origin, safeVisible, withAlpha(SAFE_COLOR, 0.82 + phaseProject * 0.16), 2.8, false)
      this.drawPushbackVector(rawVisible, safeVisible, phaseProject)
      this.drawProjectionBridge(rawTarget, safeTarget, phaseProject, pulse)
    }

    this.drawDirectionHint(mapper, gradient)

    this.drawNode(origin, '#87abd9', 3.8, 0)
    this.drawNode(rawVisible, RAW_COLOR, 3.5, 7.8)
    if (phaseProject > 0.03) {
      this.drawNode(safeVisible, SAFE_COLOR, 3.8, 8)
    }

    this.drawConstraintBars(chart, diagnostics, activeSetIds, phaseProject)

    const caption =
      phaseProject < 0.08
        ? 'Raw step is applied first.'
        : phaseProject < 0.95
          ? 'Projection removes only the unsafe component.'
          : 'Safe step is feasible under active checks.'

    this.drawPanelCaption(chart, caption)
  }

  private drawQueuePanel(
    panel: Rect,
    rawSeries: number[],
    safeSeries: number[],
    threshold: number,
    phaseQueue: number,
    pulse: number,
  ): void {
    const chart: Rect = {
      x: panel.x + 12,
      y: panel.y + 56,
      width: panel.width - 24,
      height: panel.height - 74,
    }

    if (rawSeries.length === 0 || safeSeries.length === 0) {
      return
    }

    const maxValue = Math.max(...rawSeries, ...safeSeries, threshold, 1)
    const upper = maxValue * 1.08

    const mapX = (index: number, length: number): number => chart.x + (index / Math.max(1, length - 1)) * chart.width
    const mapY = (value: number): number => chart.y + chart.height - (value / upper) * chart.height

    const reveal = clamp(phaseQueue * 1.08)
    const thresholdY = mapY(threshold)

    this.drawGrid(chart, 4, 4)
    this.drawThresholdZone(chart, thresholdY)

    this.drawClipped(chart, reveal, () => {
      this.drawSeriesFill(rawSeries, mapX, mapY, withAlpha(RAW_COLOR, 0.08))
      this.drawSeriesFill(safeSeries, mapX, mapY, withAlpha(SAFE_COLOR, 0.12))
      this.drawDeltaBand(rawSeries, safeSeries, mapX, mapY)
      this.drawSmoothSeries(rawSeries, mapX, mapY, RAW_COLOR, 2.2)
      this.drawSmoothSeries(safeSeries, mapX, mapY, SAFE_COLOR, 2.9)
      this.drawRevealSweep(chart, reveal, pulse)
    })

    const rawCursor = this.valueAtProgress(rawSeries, reveal)
    const safeCursor = this.valueAtProgress(safeSeries, reveal)
    const xCursor = mapX(reveal * Math.max(1, rawSeries.length - 1), rawSeries.length)

    this.drawCursor(xCursor, mapY(rawCursor), RAW_COLOR)
    this.drawCursor(xCursor, mapY(safeCursor), SAFE_COLOR)

    const finalDelta = Math.max(0, Math.round(rawSeries[rawSeries.length - 1] - safeSeries[safeSeries.length - 1]))
    const deltaAtReveal = Math.round(finalDelta * reveal)
    this.drawQueueBadge(chart, reveal < 0.2 ? 'REPLAYING' : `${deltaAtReveal} lower queue at horizon`)

    const caption =
      reveal < 0.2
        ? 'Queue replay is starting.'
        : 'Safe step reduces expected queue pressure under the same traffic pulse.'
    this.drawPanelCaption(chart, caption)
  }

  private drawGrid(rect: Rect, vertical: number, horizontal: number): void {
    const ctx = this.ctx

    for (let i = 0; i <= vertical; i += 1) {
      const x = rect.x + (i / vertical) * rect.width
      ctx.beginPath()
      ctx.moveTo(x, rect.y)
      ctx.lineTo(x, rect.y + rect.height)
      ctx.strokeStyle = GRID_STROKE
      ctx.lineWidth = 1
      ctx.stroke()
    }

    for (let i = 0; i <= horizontal; i += 1) {
      const y = rect.y + (i / horizontal) * rect.height
      ctx.beginPath()
      ctx.moveTo(rect.x, y)
      ctx.lineTo(rect.x + rect.width, y)
      ctx.strokeStyle = GRID_STROKE
      ctx.lineWidth = 1
      ctx.stroke()
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

  private drawConstraintBoundaries(
    mapper: Mapper,
    halfspaces: Halfspace[],
    diagnosticsById: Map<string, ConstraintDiagnostic>,
    phaseViolation: number,
    pulse: number,
  ): void {
    const ctx = this.ctx
    const span = mapper.worldRadius * 1.7

    halfspaces.forEach((halfspace, index) => {
      const normal = normalize(halfspace.normal)
      const tangent = vec(-normal.y, normal.x)
      const anchor = scale(normal, halfspace.bound)
      const p0 = mapper.worldToCanvas(sub(anchor, scale(tangent, span)))
      const p1 = mapper.worldToCanvas(sub(anchor, scale(tangent, -span)))

      const diagnostic = diagnosticsById.get(halfspace.id)
      const violated = (diagnostic?.violationStep0 ?? 0) > 1e-6

      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y)
      ctx.lineTo(p1.x, p1.y)
      ctx.strokeStyle = withAlpha(index % 2 === 0 ? '#7eb6eb' : '#6fc9a8', violated ? 0.35 + phaseViolation * 0.2 : 0.4)
      ctx.lineWidth = violated ? 1 + phaseViolation * 0.6 : 0.95
      ctx.stroke()

      if (violated && phaseViolation > 0.02) {
        ctx.beginPath()
        ctx.moveTo(p0.x, p0.y)
        ctx.lineTo(p1.x, p1.y)
        ctx.strokeStyle = withAlpha(VIOLATION_COLOR, 0.24 + phaseViolation * 0.28 + pulse * 0.08)
        ctx.lineWidth = 1.2 + phaseViolation * 0.7
        ctx.stroke()
      }
    })
  }

  private drawViolationMarkers(mapper: Mapper, diagnostics: ConstraintDiagnostic[], phaseViolation: number, pulse: number): void {
    for (const diagnostic of diagnostics) {
      if (!diagnostic.active || diagnostic.violationStep0 <= 1e-6) {
        continue
      }

      const normal = normalize(diagnostic.normal)
      const anchor = scale(normal, diagnostic.bound)
      const marker = mapper.worldToCanvas(anchor)
      const radius = 6 + phaseViolation * 4 + pulse * 1.4

      this.ctx.beginPath()
      this.ctx.arc(marker.x, marker.y, radius, 0, Math.PI * 2)
      this.ctx.strokeStyle = withAlpha(VIOLATION_COLOR, 0.26 + phaseViolation * 0.34)
      this.ctx.lineWidth = 1.1
      this.ctx.stroke()
    }
  }

  private drawConstraintBars(
    chart: Rect,
    diagnostics: ConstraintDiagnostic[],
    activeSetIds: string[],
    phaseProject: number,
  ): void {
    if (diagnostics.length === 0) {
      return
    }

    const ctx = this.ctx
    const activeSet = new Set(activeSetIds)

    const items = diagnostics
      .filter((item) => item.active)
      .sort((a, b) => {
        const activeA = activeSet.has(a.id) ? 1 : 0
        const activeB = activeSet.has(b.id) ? 1 : 0
        if (activeA !== activeB) {
          return activeB - activeA
        }
        return b.lambda - a.lambda
      })
      .slice(0, 4)

    if (items.length === 0) {
      return
    }

    const panelWidth = Math.min(142, chart.width * 0.38)
    const panelHeight = 14 + items.length * 16
    const panelX = chart.x + chart.width - panelWidth - 8
    const panelY = chart.y + 8

    this.drawRoundedRect(panelX, panelY, panelWidth, panelHeight, 8)
    ctx.fillStyle = 'rgba(11, 21, 35, 0.84)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(105, 144, 196, 0.45)'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.font = '700 8px "IBM Plex Mono", monospace'
    ctx.fillStyle = '#90b7e7'
    ctx.fillText('ACTIVE CHECK PRESSURE', panelX + 8, panelY + 10)

    const maxLoad = Math.max(
      0.001,
      ...items.map((item) => (activeSet.has(item.id) ? Math.max(item.lambda, item.violationStep0) : item.violationStep0 * 0.25)),
    )

    items.forEach((item, index) => {
      const y = panelY + 14 + index * 16
      const active = activeSet.has(item.id)
      const load = active ? Math.max(item.lambda, item.violationStep0) : item.violationStep0 * 0.25
      const normalized = clamp(load / maxLoad)
      const fill = (active ? 0.2 + normalized * 0.8 : normalized * 0.12) * clamp(phaseProject * 1.1)

      ctx.font = '600 8px "Sora", sans-serif'
      ctx.fillStyle = active ? '#b9e6ff' : '#7f98bb'
      ctx.fillText(shortLabel(item.label), panelX + 8, y + 7)

      const barX = panelX + 54
      const barY = y + 1
      const barWidth = panelWidth - 62

      this.drawRoundedRect(barX, barY, barWidth, 6, 3)
      ctx.fillStyle = 'rgba(118, 151, 194, 0.18)'
      ctx.fill()

      this.drawRoundedRect(barX, barY, barWidth * fill, 6, 3)
      ctx.fillStyle = active ? withAlpha(SAFE_COLOR, 0.82) : withAlpha('#89a5c9', 0.34)
      ctx.fill()
    })
  }

  private drawDirectionHint(mapper: Mapper, gradient: Vec2): void {
    const origin = mapper.worldToCanvas(vec(0, 0))
    const direction = scale(normalize(gradient), mapper.worldRadius * 0.62)
    const target = mapper.worldToCanvas(scale(direction, -1))
    this.drawArrow(origin, target, withAlpha('#f2c16d', 0.54), 1.1, true)
  }

  private drawArrow(from: Vec2, to: Vec2, color: string, width: number, dashed: boolean): void {
    const ctx = this.ctx
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = 9

    ctx.save()
    if (dashed) {
      ctx.setLineDash([7, 5])
    }
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.stroke()
    ctx.restore()

    ctx.beginPath()
    ctx.moveTo(to.x, to.y)
    ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6))
    ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6))
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }

  private drawPushbackVector(rawPoint: Vec2, safePoint: Vec2, phaseProject: number): void {
    const end = lerp(rawPoint, safePoint, clamp(phaseProject * 0.95))
    this.drawArrow(rawPoint, end, withAlpha(BRIDGE_COLOR, 0.78), 1.4, true)
  }

  private drawProjectionBridge(rawPoint: Vec2, safePoint: Vec2, phaseProject: number, pulse: number): void {
    const ctx = this.ctx
    const end = lerp(rawPoint, safePoint, clamp(phaseProject))

    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(rawPoint.x, rawPoint.y)
    ctx.lineTo(end.x, end.y)
    ctx.strokeStyle = withAlpha(BRIDGE_COLOR, 0.74)
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.restore()

    this.drawNode(end, BRIDGE_COLOR, 2.9 + pulse * 0.8, 5.8 + pulse * 1.1)
  }

  private drawNode(point: Vec2, color: string, innerRadius: number, outerRadius: number): void {
    const ctx = this.ctx

    ctx.beginPath()
    ctx.arc(point.x, point.y, innerRadius, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()

    if (outerRadius > 0) {
      ctx.beginPath()
      ctx.arc(point.x, point.y, outerRadius, 0, Math.PI * 2)
      ctx.strokeStyle = withAlpha(color, 0.4)
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  private drawThresholdZone(chart: Rect, thresholdY: number): void {
    const ctx = this.ctx

    ctx.fillStyle = withAlpha(RAW_COLOR, 0.09)
    ctx.fillRect(chart.x, chart.y, chart.width, Math.max(0, thresholdY - chart.y))

    ctx.save()
    ctx.setLineDash([6, 5])
    ctx.beginPath()
    ctx.moveTo(chart.x, thresholdY)
    ctx.lineTo(chart.x + chart.width, thresholdY)
    ctx.strokeStyle = withAlpha(RAW_COLOR, 0.8)
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.restore()

    ctx.font = '600 10px "IBM Plex Mono", monospace'
    ctx.fillStyle = '#ff9fb2'
    const labelY = clamp(thresholdY - 6, chart.y + 12, chart.y + chart.height - 8)
    ctx.fillText('threshold', chart.x + chart.width - 62, labelY)
  }

  private drawClipped(chart: Rect, reveal: number, draw: () => void): void {
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(chart.x, chart.y, chart.width * reveal, chart.height)
    ctx.clip()
    draw()
    ctx.restore()
  }

  private drawSeriesFill(
    series: number[],
    mapX: (index: number, length: number) => number,
    mapY: (value: number) => number,
    color: string,
  ): void {
    if (series.length < 2) {
      return
    }

    const ctx = this.ctx
    const baseline = mapY(0)

    ctx.beginPath()
    ctx.moveTo(mapX(0, series.length), baseline)
    for (let i = 0; i < series.length; i += 1) {
      ctx.lineTo(mapX(i, series.length), mapY(series[i]))
    }
    ctx.lineTo(mapX(series.length - 1, series.length), baseline)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }

  private drawDeltaBand(
    rawSeries: number[],
    safeSeries: number[],
    mapX: (index: number, length: number) => number,
    mapY: (value: number) => number,
  ): void {
    if (rawSeries.length < 2 || safeSeries.length < 2) {
      return
    }

    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(mapX(0, rawSeries.length), mapY(rawSeries[0]))
    for (let i = 1; i < rawSeries.length; i += 1) {
      ctx.lineTo(mapX(i, rawSeries.length), mapY(rawSeries[i]))
    }
    for (let i = safeSeries.length - 1; i >= 0; i -= 1) {
      ctx.lineTo(mapX(i, safeSeries.length), mapY(safeSeries[i]))
    }
    ctx.closePath()

    ctx.fillStyle = withAlpha(SAFE_COLOR, 0.12)
    ctx.fill()
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

    const ctx = this.ctx
    const points = series.map((value, index) => vec(mapX(index, series.length), mapY(value)))

    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length - 1; i += 1) {
      const current = points[i]
      const next = points[i + 1]
      const midX = (current.x + next.x) / 2
      const midY = (current.y + next.y) / 2
      ctx.quadraticCurveTo(current.x, current.y, midX, midY)
    }
    const last = points[points.length - 1]
    ctx.lineTo(last.x, last.y)

    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
  }

  private drawRevealSweep(chart: Rect, reveal: number, pulse: number): void {
    const ctx = this.ctx
    const x = chart.x + chart.width * reveal
    const gradient = ctx.createLinearGradient(x - 28, chart.y, x + 28, chart.y)
    gradient.addColorStop(0, 'rgba(89, 212, 255, 0)')
    gradient.addColorStop(0.5, `rgba(89, 212, 255, ${0.08 + pulse * 0.08})`)
    gradient.addColorStop(1, 'rgba(89, 212, 255, 0)')

    ctx.fillStyle = gradient
    ctx.fillRect(x - 28, chart.y, 56, chart.height)
  }

  private drawCursor(x: number, y: number, color: string): void {
    const ctx = this.ctx

    ctx.beginPath()
    ctx.arc(x, y, 4.2, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()

    ctx.beginPath()
    ctx.arc(x, y, 8.8, 0, Math.PI * 2)
    ctx.strokeStyle = withAlpha(color, 0.4)
    ctx.lineWidth = 1
    ctx.stroke()
  }

  private drawQueueBadge(chart: Rect, text: string): void {
    const ctx = this.ctx
    ctx.font = '700 10px "IBM Plex Mono", monospace'

    const width = ctx.measureText(text).width + 14
    const x = chart.x + chart.width - width - 8
    const y = chart.y + 8

    this.drawRoundedRect(x, y, width, 18, 7)
    ctx.fillStyle = 'rgba(14, 24, 39, 0.92)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(119, 160, 212, 0.52)'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = '#95bfef'
    ctx.fillText(text, x + 7, y + 12)
  }

  private valueAtProgress(series: number[], progress: number): number {
    if (series.length === 0) {
      return 0
    }
    if (series.length === 1) {
      return series[0]
    }

    const capped = clamp(progress)
    const position = capped * (series.length - 1)
    const i0 = Math.floor(position)
    const i1 = Math.min(series.length - 1, i0 + 1)
    const t = position - i0

    return series[i0] + (series[i1] - series[i0]) * t
  }

  private drawPanelCaption(chart: Rect, text: string): void {
    const ctx = this.ctx
    const x = chart.x + 8
    const y = chart.y + chart.height - 12

    ctx.font = '600 10px "Sora", sans-serif'
    ctx.fillStyle = '#93b6df'
    ctx.fillText(text, x, y)
  }

  private drawRoundedRect(x: number, y: number, width: number, height: number, radius: number): void {
    const ctx = this.ctx
    const r = Math.min(radius, width / 2, height / 2)

    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + width, y, x + width, y + height, r)
    ctx.arcTo(x + width, y + height, x, y + height, r)
    ctx.arcTo(x, y + height, x, y, r)
    ctx.arcTo(x, y, x + width, y, r)
    ctx.closePath()
  }
}
