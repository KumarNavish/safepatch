import { add, intersectHalfspaces, lerp, normalize, scale, vec, worldBoundsFromHalfspaces } from './geometry'
import type { Halfspace, Vec2 } from './geometry'
import type { ConstraintDiagnostic, ProjectionResult } from './qp'

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
  worldToCanvas: (point: Vec2) => Vec2
  canvasToWorld: (point: Vec2) => Vec2
}

interface LabelBox {
  x: number
  y: number
  width: number
  height: number
}

interface TeachingBeats {
  raw: number
  hit: number
  correction: number
  safe: number
}

const RAW_COLOR = '#f05570'
const SAFE_COLOR = '#2c6cf5'
const CORRECTION_COLOR = '#f4a037'
const FEASIBLE_FILL = 'rgba(22, 150, 126, 0.11)'
const FEASIBLE_STROKE = 'rgba(22, 150, 126, 0.42)'

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max)
}

function easeOutCubic(value: number): number {
  const t = clamp(value)
  return 1 - (1 - t) ** 3
}

function easeOutBack(value: number): number {
  const t = clamp(value)
  const c1 = 1.35
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

  const clean = hex.replace('#', '')
  const parsed = Number.parseInt(clean, 16)
  const r = (parsed >> 16) & 255
  const g = (parsed >> 8) & 255
  const b = parsed & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export class SceneRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly colorById = new Map<string, string>()
  private readonly palette = ['#ef6f8f', '#4f8dff', '#18a28c', '#f0a941', '#7b5dde', '#2ea5a2']

  private mapper: Mapper | null = null

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
    if (!this.mapper) {
      return null
    }

    const rect = this.canvas.getBoundingClientRect()
    const point = vec(clientX - rect.left, clientY - rect.top)
    return this.mapper.canvasToWorld(point)
  }

  isNearRawHandle(clientX: number, clientY: number, rawStep: Vec2, radius = 16): boolean {
    if (!this.mapper) {
      return false
    }

    const rect = this.canvas.getBoundingClientRect()
    const pointer = vec(clientX - rect.left, clientY - rect.top)
    const tip = this.mapper.worldToCanvas(rawStep)
    return Math.hypot(pointer.x - tip.x, pointer.y - tip.y) <= radius
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

    this.drawRoundedRect(frame.x, frame.y, frame.width, frame.height, 12)
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.98)'
    this.ctx.fill()
    this.ctx.strokeStyle = 'rgba(196, 211, 231, 0.85)'
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const plotRect: Rect = {
      x: frame.x + 14,
      y: frame.y + 14,
      width: frame.width - 28,
      height: frame.height - 28,
    }

    const activeHalfspaces = input.halfspaces.filter((halfspace) => halfspace.active)
    const mapper = this.createMapper(plotRect, activeHalfspaces)
    this.mapper = mapper

    const teachingMode = input.teachingProgress < 0.999
    const beats = this.resolveTeachingBeats(input.teachingProgress)

    this.drawPlotSurface(plotRect)
    this.drawFeasibleRegion(activeHalfspaces, mapper)

    const primaryDiagnostic = this.primaryViolatedDiagnostic(input.projection)

    this.drawBoundaries({
      halfspaces: activeHalfspaces,
      mapper,
      mode: input.mode,
      primaryDiagnostic,
      highlightedConstraintId: input.highlightedConstraintId,
      hitBeat: beats.hit,
    })

    if (input.mode === 'geometry') {
      this.drawGeometryMode({
        projection: input.projection,
        mapper,
        beats,
        teachingMode,
        dragActive: input.dragActive,
        primaryDiagnostic,
      })
    } else {
      this.drawForcesMode({
        projection: input.projection,
        mapper,
        highlightedConstraintId: input.highlightedConstraintId,
      })
    }

    this.drawOutcomeCards({
      stats: input.stats,
      beats,
      teachingMode,
      mode: input.mode,
      canvasWidth: width,
      canvasHeight: height,
    })
  }

  private resolveTeachingBeats(progress: number): TeachingBeats {
    if (progress >= 1) {
      return { raw: 1, hit: 1, correction: 1, safe: 1 }
    }

    const t = clamp(progress)
    return {
      raw: easeOutCubic(phaseWindow(t, 0, 0.28)),
      hit: easeOutCubic(phaseWindow(t, 0.28, 0.46)),
      correction: easeOutCubic(phaseWindow(t, 0.46, 0.72)),
      safe: easeOutCubic(phaseWindow(t, 0.72, 1)),
    }
  }

  private drawBackdrop(width: number, height: number): void {
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, '#ffffff')
    gradient.addColorStop(1, '#f7fbff')
    this.ctx.fillStyle = gradient
    this.ctx.fillRect(0, 0, width, height)

    const glow = this.ctx.createRadialGradient(width * 0.17, height * 0.1, 10, width * 0.17, height * 0.1, width * 0.58)
    glow.addColorStop(0, 'rgba(44, 108, 245, 0.08)')
    glow.addColorStop(1, 'rgba(44, 108, 245, 0)')
    this.ctx.fillStyle = glow
    this.ctx.fillRect(0, 0, width, height)
  }

  private createMapper(rect: Rect, halfspaces: Halfspace[]): Mapper {
    const worldRadius = worldBoundsFromHalfspaces(halfspaces)
    const pad = 24
    const usableWidth = rect.width - pad * 2
    const usableHeight = rect.height - pad * 2
    const scaleFactor = Math.min(usableWidth / (worldRadius * 2), usableHeight / (worldRadius * 2))
    const center = vec(rect.x + rect.width / 2, rect.y + rect.height / 2)

    return {
      worldRadius,
      center,
      worldToCanvas: (point: Vec2) => vec(center.x + point.x * scaleFactor, center.y - point.y * scaleFactor),
      canvasToWorld: (point: Vec2) => vec((point.x - center.x) / scaleFactor, (center.y - point.y) / scaleFactor),
    }
  }

  private drawPlotSurface(rect: Rect): void {
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.strokeStyle = 'rgba(190, 206, 226, 0.82)'
    this.ctx.lineWidth = 1
    this.ctx.stroke()
  }

  private drawFeasibleRegion(halfspaces: Halfspace[], mapper: Mapper): void {
    const zone = intersectHalfspaces(halfspaces, mapper.worldRadius)
    if (zone.isEmpty || zone.vertices.length < 3) {
      return
    }

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
    this.ctx.fillStyle = FEASIBLE_FILL
    this.ctx.fill()
    this.ctx.strokeStyle = FEASIBLE_STROKE
    this.ctx.lineWidth = 1.3
    this.ctx.stroke()
  }

  private drawBoundaries(input: {
    halfspaces: Halfspace[]
    mapper: Mapper
    mode: SceneMode
    primaryDiagnostic: ConstraintDiagnostic | null
    highlightedConstraintId: string | null
    hitBeat: number
  }): void {
    const span = input.mapper.worldRadius * 1.9

    input.halfspaces.forEach((halfspace, index) => {
      const normal = normalize(halfspace.normal)
      const tangent = vec(-normal.y, normal.x)
      const anchor = scale(normal, halfspace.bound)
      const p0 = input.mapper.worldToCanvas(add(anchor, scale(tangent, -span)))
      const p1 = input.mapper.worldToCanvas(add(anchor, scale(tangent, span)))

      const baseColor = this.colorForConstraint(halfspace.id, index)
      const isPrimary = input.primaryDiagnostic?.id === halfspace.id
      const isHighlighted = input.highlightedConstraintId === halfspace.id

      let stroke = 'rgba(146, 166, 190, 0.15)'
      let width = 1

      if (input.mode === 'geometry' && isPrimary) {
        stroke = withAlpha(CORRECTION_COLOR, 0.54 + input.hitBeat * 0.28)
        width = 1.3 + input.hitBeat * 0.9
      }
      if (input.mode === 'geometry' && !isPrimary) {
        return
      }

      if (input.mode === 'forces') {
        stroke = withAlpha(baseColor, isHighlighted ? 0.94 : 0.17)
        width = isHighlighted ? 2.2 : 1
      }

      this.ctx.beginPath()
      this.ctx.moveTo(p0.x, p0.y)
      this.ctx.lineTo(p1.x, p1.y)
      this.ctx.strokeStyle = stroke
      this.ctx.lineWidth = width
      this.ctx.stroke()
    })
  }

  private drawGeometryMode(input: {
    projection: ProjectionResult
    mapper: Mapper
    beats: TeachingBeats
    teachingMode: boolean
    dragActive: boolean
    primaryDiagnostic: ConstraintDiagnostic | null
  }): void {
    const originWorld = vec(0, 0)
    const rawWorld = input.projection.step0
    const safeWorld = input.projection.projectedStep

    const origin = input.mapper.worldToCanvas(originWorld)
    const rawVisibleWorld = input.teachingMode ? lerp(originWorld, rawWorld, input.beats.raw) : rawWorld
    const rawVisible = input.mapper.worldToCanvas(rawVisibleWorld)

    this.drawArrow(origin, rawVisible, RAW_COLOR, 2.8, true)
    this.drawNode(origin, '#6d88ac', 4)
    this.drawNode(rawVisible, RAW_COLOR, 4.1)

    if (input.primaryDiagnostic && input.beats.hit > 0.05) {
      const boundaryHit = this.boundaryHitPoint(rawWorld, input.primaryDiagnostic)
      if (boundaryHit) {
        const hitCanvas = input.mapper.worldToCanvas(boundaryHit)
        this.drawPulse(hitCanvas, CORRECTION_COLOR, input.beats.hit)
      }
    }

    if (!input.teachingMode || input.beats.correction > 0.03) {
      const correctionWorld = input.teachingMode ? lerp(rawWorld, safeWorld, input.beats.correction) : safeWorld
      this.drawArrow(input.mapper.worldToCanvas(rawWorld), input.mapper.worldToCanvas(correctionWorld), CORRECTION_COLOR, 2.1, false)
    }

    if (!input.teachingMode || input.beats.safe > 0.03) {
      const safeVisibleWorld = input.teachingMode ? lerp(originWorld, safeWorld, easeOutBack(input.beats.safe)) : safeWorld
      const safeVisible = input.mapper.worldToCanvas(safeVisibleWorld)
      this.drawArrow(origin, safeVisible, SAFE_COLOR, 2.8, true)
      this.drawNode(safeVisible, SAFE_COLOR, 4.1)
    }

    const occupied: LabelBox[] = []
    this.drawLabel(input.mapper.worldToCanvas(rawWorld), 'Raw patch', RAW_COLOR, occupied)
    this.drawLabel(input.mapper.worldToCanvas(safeWorld), 'Certified patch', SAFE_COLOR, occupied)

    if (!input.dragActive) {
      this.drawHandleHint(input.mapper.worldToCanvas(rawWorld))
    }
  }

  private drawOutcomeCards(input: {
    stats: SceneRenderInput['stats']
    beats: TeachingBeats
    teachingMode: boolean
    mode: SceneMode
    canvasWidth: number
    canvasHeight: number
  }): void {
    const { stats, beats, teachingMode, mode, canvasWidth, canvasHeight } = input
    const cardWidth = Math.min(250, Math.max(180, canvasWidth * 0.24))
    const cardHeight = 104
    const gap = 10
    const y = canvasHeight - cardHeight - 24
    const xRaw = 22
    const xSafe = xRaw + cardWidth + gap

    const maxIncident = Math.max(stats.incidentRaw, stats.incidentSafe, 1)
    const rawRatio = clamp(stats.incidentRaw / maxIncident)
    const safeRatio = clamp(stats.incidentSafe / maxIncident)

    const rawVisibility = teachingMode ? clamp(beats.raw + beats.hit * 0.45) : 1
    const safeVisibility = mode === 'forces' ? 1 : teachingMode ? clamp(beats.safe + beats.correction * 0.5) : 1

    this.drawMetricCard({
      x: xRaw,
      y,
      width: cardWidth,
      height: cardHeight,
      title: 'If Shipped Raw',
      tone: RAW_COLOR,
      checksText: `${stats.checksRawPassed}/${stats.checksTotal} checks`,
      incidentsText: `${stats.incidentRaw.toFixed(1)} incidents/hr`,
      barRatio: rawRatio,
      valueText: null,
      alpha: rawVisibility,
    })

    this.drawMetricCard({
      x: xSafe,
      y,
      width: cardWidth,
      height: cardHeight,
      title: 'After SafePatch',
      tone: stats.decisionTone === 'ship' ? '#16967e' : SAFE_COLOR,
      checksText: `${stats.checksSafePassed}/${stats.checksTotal} checks`,
      incidentsText: `${stats.incidentSafe.toFixed(1)} incidents/hr`,
      barRatio: safeRatio,
      valueText: `${stats.retainedPct}% value kept`,
      alpha: safeVisibility,
    })

    if (safeVisibility > 0.1) {
      const from = vec(xRaw + cardWidth + 4, y + cardHeight / 2)
      const to = vec(xSafe - 8, y + cardHeight / 2)
      this.drawArrow(from, to, withAlpha(SAFE_COLOR, 0.9), 1.7, false)
    }
  }

  private drawMetricCard(input: {
    x: number
    y: number
    width: number
    height: number
    title: string
    tone: string
    checksText: string
    incidentsText: string
    barRatio: number
    valueText: string | null
    alpha: number
  }): void {
    const { x, y, width, height, title, tone, checksText, incidentsText, barRatio, valueText, alpha } = input
    if (alpha <= 0.02) {
      return
    }

    this.ctx.save()
    this.ctx.globalAlpha = alpha

    this.drawRoundedRect(x, y, width, height, 11)
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(tone, 0.35)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(tone, 0.85)
    this.ctx.fillText(title.toUpperCase(), x + 10, y + 15)

    this.ctx.font = "600 12px 'Manrope'"
    this.ctx.fillStyle = '#183353'
    this.ctx.fillText(checksText, x + 10, y + 36)

    this.ctx.font = "600 13px 'Manrope'"
    this.ctx.fillStyle = withAlpha(tone, 0.95)
    this.ctx.fillText(incidentsText, x + 10, y + 56)

    this.drawRoundedRect(x + 10, y + 66, width - 20, 8, 5)
    this.ctx.fillStyle = '#e4edf9'
    this.ctx.fill()

    const fillW = Math.max(6, (width - 20) * barRatio)
    this.drawRoundedRect(x + 10, y + 66, fillW, 8, 5)
    this.ctx.fillStyle = withAlpha(tone, 0.88)
    this.ctx.fill()

    if (valueText) {
      this.ctx.font = "600 11px 'Manrope'"
      this.ctx.fillStyle = '#2c5e9f'
      this.ctx.fillText(valueText, x + 10, y + 90)
    }

    this.ctx.restore()
  }

  private drawForcesMode(input: {
    projection: ProjectionResult
    mapper: Mapper
    highlightedConstraintId: string | null
  }): void {
    const origin = input.mapper.worldToCanvas(vec(0, 0))
    const rawTip = input.mapper.worldToCanvas(input.projection.step0)
    const safeTip = input.mapper.worldToCanvas(input.projection.projectedStep)

    this.drawArrow(origin, rawTip, RAW_COLOR, 2.6, true)
    this.drawArrow(origin, safeTip, SAFE_COLOR, 2.8, true)

    const dominantId = input.projection.activeSetIds
      .slice()
      .sort((a, b) => (input.projection.lambdaById[b] ?? 0) - (input.projection.lambdaById[a] ?? 0))[0]

    const selectedId = input.highlightedConstraintId ?? dominantId
    if (selectedId) {
      const correction = input.projection.correctionById[selectedId]
      const lambda = input.projection.lambdaById[selectedId] ?? 0
      if (correction && lambda > 1e-6) {
        const tip = input.mapper.worldToCanvas(add(input.projection.step0, correction))
        this.drawArrow(rawTip, tip, this.colorForConstraint(selectedId), 2.2, false)
      }
    }

    this.drawNode(origin, '#6d88ac', 4)
    this.drawNode(rawTip, RAW_COLOR, 4.1)
    this.drawNode(safeTip, SAFE_COLOR, 4.1)

    const occupied: LabelBox[] = []
    this.drawLabel(rawTip, 'Raw patch', RAW_COLOR, occupied)
    this.drawLabel(safeTip, 'Certified patch', SAFE_COLOR, occupied)
  }

  private drawLabel(anchor: Vec2, text: string, color: string, occupied: LabelBox[]): void {
    this.ctx.save()
    this.ctx.font = "600 11px 'Manrope'"

    const textWidth = this.ctx.measureText(text).width
    const boxWidth = textWidth + 16
    const boxHeight = 22

    const candidates: Array<{ x: number; y: number }> = [
      { x: anchor.x + 10, y: anchor.y - 24 },
      { x: anchor.x + 10, y: anchor.y + 8 },
      { x: anchor.x - boxWidth - 10, y: anchor.y - 24 },
      { x: anchor.x - boxWidth - 10, y: anchor.y + 8 },
    ]

    let selected = candidates[0]

    for (const candidate of candidates) {
      const box: LabelBox = { x: candidate.x, y: candidate.y, width: boxWidth, height: boxHeight }
      const overlaps = occupied.some((other) => this.overlaps(box, other))
      if (!overlaps) {
        selected = candidate
        occupied.push(box)
        break
      }
    }

    this.drawRoundedRect(selected.x, selected.y, boxWidth, boxHeight, 8)
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(color, 0.36)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.fillStyle = withAlpha(color, 0.95)
    this.ctx.textBaseline = 'middle'
    this.ctx.fillText(text, selected.x + 8, selected.y + boxHeight / 2)
    this.ctx.restore()
  }

  private overlaps(a: LabelBox, b: LabelBox): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  }

  private drawPulse(center: Vec2, color: string, progress: number): void {
    const t = easeOutCubic(progress)
    const radius = 9 + t * 12

    this.ctx.beginPath()
    this.ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(color, 0.33 - t * 0.17)
    this.ctx.lineWidth = 1.4
    this.ctx.stroke()

    this.ctx.beginPath()
    this.ctx.arc(center.x, center.y, 4.2, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.24)
    this.ctx.fill()
  }

  private drawHandleHint(point: Vec2): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, 11, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(RAW_COLOR, 0.22)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, 16, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(RAW_COLOR, 0.12)
    this.ctx.lineWidth = 1
    this.ctx.stroke()
  }

  private drawArrow(from: Vec2, to: Vec2, color: string, width: number, glow: boolean): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    if (distance < 1.2) {
      return
    }

    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = Math.min(9, Math.max(6, width * 3.5))

    if (glow) {
      this.ctx.beginPath()
      this.ctx.moveTo(from.x, from.y)
      this.ctx.lineTo(to.x, to.y)
      this.ctx.strokeStyle = withAlpha(color, 0.14)
      this.ctx.lineWidth = width + 3
      this.ctx.lineCap = 'round'
      this.ctx.stroke()
    }

    this.ctx.beginPath()
    this.ctx.moveTo(from.x, from.y)
    this.ctx.lineTo(to.x, to.y)
    this.ctx.strokeStyle = color
    this.ctx.lineWidth = width
    this.ctx.lineCap = 'round'
    this.ctx.stroke()

    this.ctx.beginPath()
    this.ctx.moveTo(to.x, to.y)
    this.ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7))
    this.ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7))
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
    this.ctx.arc(point.x, point.y, radius + 3, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(color, 0.2)
    this.ctx.lineWidth = 1
    this.ctx.stroke()
  }

  private primaryViolatedDiagnostic(projection: ProjectionResult): ConstraintDiagnostic | null {
    const violated = projection.diagnostics
      .filter((diagnostic) => diagnostic.active && diagnostic.violationStep0 > 1e-6)
      .sort((a, b) => b.violationStep0 - a.violationStep0)
    return violated[0] ?? null
  }

  private boundaryHitPoint(rawStep: Vec2, diagnostic: ConstraintDiagnostic): Vec2 | null {
    const denominator = diagnostic.normal.x * rawStep.x + diagnostic.normal.y * rawStep.y
    if (Math.abs(denominator) < 1e-8) {
      return null
    }

    const t = clamp(diagnostic.bound / denominator, 0, 1)
    return scale(rawStep, t)
  }

  private colorForConstraint(id: string, fallbackIndex?: number): string {
    const existing = this.colorById.get(id)
    if (existing) {
      return existing
    }

    const index = fallbackIndex ?? this.colorById.size
    const color = this.palette[index % this.palette.length]
    this.colorById.set(id, color)
    return color
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
