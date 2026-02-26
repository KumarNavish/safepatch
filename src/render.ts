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
  rawTrail: Vec2[]
  safeTrail: Vec2[]
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

interface TeachingBeats {
  raw: number
  hit: number
  correction: number
  safe: number
}

const RAW_COLOR = '#d64556'
const SAFE_COLOR = '#1d4ed8'
const PUSH_COLOR = '#f09b26'
const FEASIBLE_FILL = 'rgba(15, 143, 116, 0.11)'
const FEASIBLE_STROKE = 'rgba(15, 143, 116, 0.5)'

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max)
}

function easeOutCubic(value: number): number {
  const t = clamp(value)
  return 1 - (1 - t) ** 3
}

function easeOutBack(value: number): number {
  const t = clamp(value)
  const c1 = 1.4
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
  private readonly palette = ['#ec6b8e', '#3f8bff', '#15a392', '#f4a236', '#7657da', '#0ea5a4']

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
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.96)'
    this.ctx.fill()
    this.ctx.strokeStyle = 'rgba(198, 211, 229, 0.9)'
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

    const beats = this.resolveTeachingBeats(input.teachingProgress)
    const teachingMode = input.teachingProgress < 0.999
    const activeSet = new Set(input.projection.activeSetIds)
    const visibleSet = new Set(input.visibleCorrectionIds)
    const primaryDiagnostic = this.primaryViolatedDiagnostic(input.projection)

    this.drawStageSurface(plotRect, mapper)
    this.drawFeasibleRegion(activeHalfspaces, mapper)

    this.drawBoundaries({
      halfspaces: activeHalfspaces,
      mapper,
      mode: input.mode,
      activeSet,
      highlightedConstraintId: input.highlightedConstraintId,
      primaryDiagnostic,
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
        visibleSet,
        highlightedConstraintId: input.highlightedConstraintId,
      })
    }
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
    gradient.addColorStop(1, '#f8fbff')
    this.ctx.fillStyle = gradient
    this.ctx.fillRect(0, 0, width, height)

    const glow = this.ctx.createRadialGradient(width * 0.14, height * 0.08, 10, width * 0.14, height * 0.08, width * 0.5)
    glow.addColorStop(0, 'rgba(29, 78, 216, 0.08)')
    glow.addColorStop(1, 'rgba(29, 78, 216, 0)')
    this.ctx.fillStyle = glow
    this.ctx.fillRect(0, 0, width, height)
  }

  private createMapper(rect: Rect, halfspaces: Halfspace[]): Mapper {
    const worldRadius = worldBoundsFromHalfspaces(halfspaces)
    const pad = 28
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

  private drawStageSurface(rect: Rect, mapper: Mapper): void {
    const gradient = this.ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height)
    gradient.addColorStop(0, '#ffffff')
    gradient.addColorStop(1, '#fbfdff')
    this.ctx.fillStyle = gradient
    this.ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

    const center = mapper.center
    this.ctx.beginPath()
    this.ctx.moveTo(rect.x, center.y)
    this.ctx.lineTo(rect.x + rect.width, center.y)
    this.ctx.moveTo(center.x, rect.y)
    this.ctx.lineTo(center.x, rect.y + rect.height)
    this.ctx.strokeStyle = 'rgba(181, 197, 219, 0.34)'
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.strokeStyle = 'rgba(190, 205, 226, 0.86)'
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
    this.ctx.lineWidth = 1.4
    this.ctx.stroke()
  }

  private drawBoundaries(input: {
    halfspaces: Halfspace[]
    mapper: Mapper
    mode: SceneMode
    activeSet: Set<string>
    highlightedConstraintId: string | null
    primaryDiagnostic: ConstraintDiagnostic | null
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
      const isActive = input.activeSet.has(halfspace.id)
      const isPrimary = input.primaryDiagnostic?.id === halfspace.id
      const isHighlighted = input.highlightedConstraintId === halfspace.id

      if (input.mode === 'geometry' && !isPrimary && !isHighlighted) {
        return
      }

      if (input.mode === 'forces' && !isHighlighted) {
        return
      }

      let stroke = 'rgba(147, 164, 188, 0.22)'
      let width = 1

      if (input.mode === 'forces') {
        stroke = withAlpha(baseColor, 0.94)
        width = 2
      }

      if (isActive) {
        stroke = withAlpha(baseColor, input.mode === 'forces' ? 0.2 : 0.24)
      }

      if (isPrimary && input.mode === 'geometry') {
        stroke = withAlpha(PUSH_COLOR, 0.5 + input.hitBeat * 0.4)
        width = 1.3 + input.hitBeat * 0.8
      }

      if (isHighlighted) {
        stroke = withAlpha(baseColor, 0.95)
        width = 2.2
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
    const rawVisible = input.mapper.worldToCanvas(lerp(originWorld, rawWorld, input.beats.raw))

    this.drawArrow(origin, rawVisible, RAW_COLOR, 2.5, false, true)
    this.drawNode(origin, '#6f89ad', 3.8)
    this.drawNode(rawVisible, RAW_COLOR, 4)

    if (input.primaryDiagnostic && input.beats.hit > 0.04) {
      const boundaryHit = this.boundaryHitPoint(rawWorld, input.primaryDiagnostic)
      if (boundaryHit) {
        const hitCanvas = input.mapper.worldToCanvas(boundaryHit)
        this.drawPulseRing(hitCanvas, PUSH_COLOR, input.beats.hit)
      }
    }

    if (input.beats.correction > 0.02) {
      const correctionVisible = input.mapper.worldToCanvas(lerp(rawWorld, safeWorld, input.beats.correction))
      this.drawArrow(input.mapper.worldToCanvas(rawWorld), correctionVisible, PUSH_COLOR, 1.8, false, false)
    }

    if (input.beats.safe > 0.02) {
      const safeVisible = input.mapper.worldToCanvas(lerp(originWorld, safeWorld, easeOutBack(input.beats.safe)))
      this.drawArrow(origin, safeVisible, SAFE_COLOR, 2.6, false, true)
      this.drawNode(safeVisible, SAFE_COLOR, 4)
    }

    const rawTip = input.mapper.worldToCanvas(rawWorld)

    if (!input.dragActive) {
      this.drawHandleHint(rawTip)
    }
  }

  private drawForcesMode(input: {
    projection: ProjectionResult
    mapper: Mapper
    visibleSet: Set<string>
    highlightedConstraintId: string | null
  }): void {
    const origin = input.mapper.worldToCanvas(vec(0, 0))
    const rawTip = input.mapper.worldToCanvas(input.projection.step0)
    const safeTip = input.mapper.worldToCanvas(input.projection.projectedStep)

    this.drawArrow(origin, rawTip, RAW_COLOR, 2.3, false, true)
    this.drawArrow(rawTip, safeTip, PUSH_COLOR, 1.9, false, false)
    this.drawArrow(origin, safeTip, SAFE_COLOR, 2.6, false, true)

    this.drawNode(origin, '#6f89ad', 3.8)
    this.drawNode(rawTip, RAW_COLOR, 4)
    this.drawNode(safeTip, SAFE_COLOR, 4)

    const selectedId = input.highlightedConstraintId
    if (selectedId && input.visibleSet.has(selectedId)) {
      const lambda = input.projection.lambdaById[selectedId] ?? 0
      const correction = input.projection.correctionById[selectedId]
      if (lambda > 1e-6 && correction) {
        const selectedColor = this.colorForConstraint(selectedId)
        const correctionTip = input.mapper.worldToCanvas(add(input.projection.step0, correction))
        this.drawArrow(rawTip, correctionTip, selectedColor, 2.2, false, false)
      }
    }
  }

  private drawPulseRing(center: Vec2, color: string, progress: number): void {
    const intensity = easeOutCubic(progress)
    const radius = 9 + intensity * 11

    this.ctx.beginPath()
    this.ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(color, 0.33 - intensity * 0.14)
    this.ctx.lineWidth = 1.5
    this.ctx.stroke()

    this.ctx.beginPath()
    this.ctx.arc(center.x, center.y, 4.2, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.25)
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

  private drawArrow(from: Vec2, to: Vec2, color: string, width: number, dashed: boolean, glow: boolean): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    if (distance < 1.2) {
      return
    }

    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = Math.min(9, Math.max(6, width * 3.6))

    this.ctx.save()
    if (dashed) {
      this.ctx.setLineDash([5, 4])
    }

    if (glow) {
      this.ctx.beginPath()
      this.ctx.moveTo(from.x, from.y)
      this.ctx.lineTo(to.x, to.y)
      this.ctx.strokeStyle = withAlpha(color, 0.15)
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
    this.ctx.restore()

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
    this.ctx.arc(point.x, point.y, radius + 3.2, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(color, 0.22)
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
