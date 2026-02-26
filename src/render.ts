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
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface LabelBox {
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

const RAW_COLOR = '#eb5f82'
const SAFE_COLOR = '#2f79eb'
const WARN_COLOR = '#da8b45'
const AXIS_COLOR = 'rgba(146, 172, 208, 0.34)'
const GRID_COLOR = 'rgba(132, 159, 195, 0.15)'
const FEASIBLE_FILL = 'rgba(63, 164, 122, 0.16)'
const FEASIBLE_STROKE = 'rgba(105, 205, 160, 0.62)'
const LABEL_BG = 'rgba(10, 18, 31, 0.9)'

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max)
}

function easeOutCubic(value: number): number {
  const t = clamp(value)
  return 1 - (1 - t) ** 3
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

function shortLabel(label: string): string {
  return label
    .split(' ')
    .slice(0, 2)
    .join(' ')
    .trim()
}

function vectorLength(vector: Vec2): number {
  return Math.hypot(vector.x, vector.y)
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

export class SceneRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly colorById = new Map<string, string>()
  private readonly palette = ['#eb5f82', '#56a7ff', '#5fcf8b', '#f0ad63', '#8f7bea', '#53c6bc']

  private mapper: Mapper | null = null
  private labelBoxes: LabelBox[] = []

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
      x: 12,
      y: 12,
      width: width - 24,
      height: height - 24,
    }

    this.drawRoundedRect(frame.x, frame.y, frame.width, frame.height, 12)
    this.ctx.fillStyle = 'rgba(9, 17, 29, 0.72)'
    this.ctx.fill()
    this.ctx.strokeStyle = 'rgba(109, 138, 176, 0.68)'
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const plotRect: Rect = {
      x: frame.x + 16,
      y: frame.y + 16,
      width: frame.width - 32,
      height: frame.height - 32,
    }

    const activeHalfspaces = input.halfspaces.filter((halfspace) => halfspace.active)
    const mapper = this.createMapper(plotRect, activeHalfspaces)
    this.mapper = mapper
    this.labelBoxes = []

    const beats = this.resolveTeachingBeats(input.teachingProgress)
    const activeSet = new Set(input.projection.activeSetIds)
    const visibleSet = new Set(input.visibleCorrectionIds)
    const primaryDiagnostic = this.primaryViolatedDiagnostic(input.projection)

    this.drawGrid(plotRect, 6, 6)
    this.drawAxes(plotRect, mapper)
    this.drawFeasibleRegion(activeHalfspaces, mapper)

    this.drawBoundaries({
      halfspaces: activeHalfspaces,
      mapper,
      mode: input.mode,
      activeSet,
      visibleSet,
      highlightedConstraintId: input.highlightedConstraintId,
      primaryDiagnostic,
      hitBeat: beats.hit,
    })

    if (input.mode === 'geometry') {
      this.drawGeometryMode({
        projection: input.projection,
        mapper,
        beats,
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

    this.ctx.font = '600 10px "Sora", sans-serif'
    this.ctx.fillStyle = '#8eaed8'
    this.ctx.fillText(
      input.mode === 'geometry'
        ? 'Geometry: raw step, violated check, projected safe step.'
        : 'Forces: each visible arrow is one correction term in Δ* = Δ0 + Σ(−η λ n).',
      frame.x + 10,
      frame.y + frame.height - 8,
    )
  }

  private resolveTeachingBeats(progress: number): TeachingBeats {
    if (progress >= 1) {
      return { raw: 1, hit: 1, correction: 1, safe: 1 }
    }

    const t = clamp(progress)
    return {
      raw: easeOutCubic(phaseWindow(t, 0, 0.32)),
      hit: easeOutCubic(phaseWindow(t, 0.32, 0.5)),
      correction: easeOutCubic(phaseWindow(t, 0.5, 0.74)),
      safe: easeOutCubic(phaseWindow(t, 0.74, 1)),
    }
  }

  private drawBackdrop(width: number, height: number): void {
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, '#0f1a2d')
    gradient.addColorStop(1, '#0d1725')
    this.ctx.fillStyle = gradient
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

  private drawGrid(rect: Rect, vertical: number, horizontal: number): void {
    for (let i = 0; i <= vertical; i += 1) {
      const x = rect.x + (i / vertical) * rect.width
      this.ctx.beginPath()
      this.ctx.moveTo(x, rect.y)
      this.ctx.lineTo(x, rect.y + rect.height)
      this.ctx.strokeStyle = GRID_COLOR
      this.ctx.lineWidth = 1
      this.ctx.stroke()
    }

    for (let i = 0; i <= horizontal; i += 1) {
      const y = rect.y + (i / horizontal) * rect.height
      this.ctx.beginPath()
      this.ctx.moveTo(rect.x, y)
      this.ctx.lineTo(rect.x + rect.width, y)
      this.ctx.strokeStyle = GRID_COLOR
      this.ctx.lineWidth = 1
      this.ctx.stroke()
    }
  }

  private drawAxes(rect: Rect, mapper: Mapper): void {
    const x0 = mapper.worldToCanvas(vec(-mapper.worldRadius, 0))
    const x1 = mapper.worldToCanvas(vec(mapper.worldRadius, 0))
    const y0 = mapper.worldToCanvas(vec(0, -mapper.worldRadius))
    const y1 = mapper.worldToCanvas(vec(0, mapper.worldRadius))

    this.ctx.beginPath()
    this.ctx.moveTo(x0.x, x0.y)
    this.ctx.lineTo(x1.x, x1.y)
    this.ctx.strokeStyle = AXIS_COLOR
    this.ctx.lineWidth = 1.2
    this.ctx.stroke()

    this.ctx.beginPath()
    this.ctx.moveTo(y0.x, y0.y)
    this.ctx.lineTo(y1.x, y1.y)
    this.ctx.strokeStyle = AXIS_COLOR
    this.ctx.lineWidth = 1.2
    this.ctx.stroke()

    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.strokeStyle = 'rgba(84, 113, 146, 0.74)'
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

    const centroid = this.computeCentroid(zone.vertices)
    const centroidCanvas = mapper.worldToCanvas(centroid)
    this.drawLabel({
      anchor: centroidCanvas,
      text: 'feasible region',
      color: '#67c99e',
      preferredDx: -34,
      preferredDy: -10,
    })
  }

  private drawBoundaries(input: {
    halfspaces: Halfspace[]
    mapper: Mapper
    mode: SceneMode
    activeSet: Set<string>
    visibleSet: Set<string>
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

      let alpha = 0.34
      let width = 1.3

      if (input.mode === 'forces') {
        if (isActive && input.visibleSet.has(halfspace.id)) {
          alpha = 0.82
          width = 2
        } else if (isActive) {
          alpha = 0.22
          width = 1.1
        }
      } else if (isPrimary) {
        alpha = 0.48 + input.hitBeat * 0.44
        width = 1.8 + input.hitBeat * 0.8
      }

      if (input.highlightedConstraintId === halfspace.id) {
        alpha = Math.max(alpha, 0.86)
        width = Math.max(width, 2.2)
      }

      this.ctx.beginPath()
      this.ctx.moveTo(p0.x, p0.y)
      this.ctx.lineTo(p1.x, p1.y)
      this.ctx.strokeStyle = withAlpha(baseColor, alpha)
      this.ctx.lineWidth = width
      this.ctx.stroke()

      const labelAnchor = input.mapper.worldToCanvas(add(anchor, scale(normal, 0.08 * input.mapper.worldRadius)))
      this.drawLabel({
        anchor: labelAnchor,
        text: shortLabel(halfspace.label),
        color: baseColor,
        preferredDx: 8,
        preferredDy: -18,
      })
    })
  }

  private drawGeometryMode(input: {
    projection: ProjectionResult
    mapper: Mapper
    beats: TeachingBeats
    dragActive: boolean
    primaryDiagnostic: ConstraintDiagnostic | null
  }): void {
    const originWorld = vec(0, 0)
    const rawWorld = input.projection.step0
    const safeWorld = input.projection.projectedStep

    const origin = input.mapper.worldToCanvas(originWorld)
    const rawVisibleWorld = lerp(originWorld, rawWorld, input.beats.raw)
    const rawVisible = input.mapper.worldToCanvas(rawVisibleWorld)

    this.drawArrow(origin, rawVisible, RAW_COLOR, 2.35)
    this.drawNode(origin, '#8daedb', 4)
    this.drawNode(rawVisible, RAW_COLOR, 4)

    if (input.primaryDiagnostic && input.beats.hit > 0.02) {
      const boundaryHit = this.boundaryHitPoint(rawWorld, input.primaryDiagnostic)
      if (boundaryHit) {
        const hitCanvas = input.mapper.worldToCanvas(boundaryHit)

        this.ctx.beginPath()
        this.ctx.arc(hitCanvas.x, hitCanvas.y, 6 + input.beats.hit * 6, 0, Math.PI * 2)
        this.ctx.strokeStyle = withAlpha(WARN_COLOR, 0.38 + input.beats.hit * 0.34)
        this.ctx.lineWidth = 1.3
        this.ctx.stroke()

        const normalTip = add(boundaryHit, scale(normalize(input.primaryDiagnostic.normal), 0.25 * input.mapper.worldRadius * 0.14))
        this.drawArrow(hitCanvas, input.mapper.worldToCanvas(normalTip), WARN_COLOR, 1.4, true)

        this.drawLabel({
          anchor: hitCanvas,
          text: 'boundary hit',
          color: WARN_COLOR,
          preferredDx: 8,
          preferredDy: -28,
        })
      }
    }

    if (input.beats.correction > 0.02) {
      const correctionVisible = lerp(rawWorld, safeWorld, input.beats.correction)
      this.drawArrow(input.mapper.worldToCanvas(rawWorld), input.mapper.worldToCanvas(correctionVisible), WARN_COLOR, 1.8)

      this.drawLabel({
        anchor: input.mapper.worldToCanvas(lerp(rawWorld, correctionVisible, 0.5)),
        text: 'push-back',
        color: WARN_COLOR,
        preferredDx: 8,
        preferredDy: -18,
      })
    }

    if (input.beats.safe > 0.02) {
      const safeVisibleWorld = lerp(originWorld, safeWorld, input.beats.safe)
      const safeVisible = input.mapper.worldToCanvas(safeVisibleWorld)
      this.drawArrow(origin, safeVisible, SAFE_COLOR, 2.5)
      this.drawNode(safeVisible, SAFE_COLOR, 4)
    }

    this.drawLabel({
      anchor: input.mapper.worldToCanvas(rawWorld),
      text: input.dragActive ? 'Δ0 dragging' : 'Δ0 raw patch',
      color: RAW_COLOR,
      preferredDx: 10,
      preferredDy: 8,
    })

    this.drawLabel({
      anchor: input.mapper.worldToCanvas(safeWorld),
      text: 'Δ* safe patch',
      color: SAFE_COLOR,
      preferredDx: 10,
      preferredDy: -14,
    })
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

    this.drawArrow(origin, rawTip, RAW_COLOR, 2.25)
    this.drawNode(origin, '#8daedb', 4)
    this.drawNode(rawTip, RAW_COLOR, 4)

    const activeIds = input.projection.activeSetIds
      .slice()
      .sort((a, b) => (input.projection.lambdaById[b] ?? 0) - (input.projection.lambdaById[a] ?? 0))

    let cursor = input.projection.step0
    let hiddenCorrection = vec(0, 0)

    for (const id of activeIds) {
      const correction = input.projection.correctionById[id] ?? vec(0, 0)
      const lambda = input.projection.lambdaById[id] ?? 0
      if (lambda <= 1e-6 || vectorLength(correction) <= 1e-4) {
        continue
      }

      const next = add(cursor, correction)
      if (input.visibleSet.has(id)) {
        const color = this.colorForConstraint(id)
        const isHighlighted = input.highlightedConstraintId === id

        this.drawArrow(
          input.mapper.worldToCanvas(cursor),
          input.mapper.worldToCanvas(next),
          withAlpha(color, isHighlighted ? 1 : 0.9),
          isHighlighted ? 2.2 : 1.9,
        )

        this.drawLabel({
          anchor: input.mapper.worldToCanvas(lerp(cursor, next, 0.5)),
          text: `-${lambda.toFixed(2)} n`,
          color,
          preferredDx: 8,
          preferredDy: -20,
        })
      } else {
        hiddenCorrection = add(hiddenCorrection, correction)
      }

      cursor = next
    }

    if (vectorLength(hiddenCorrection) > 1e-4) {
      const hiddenEnd = add(input.projection.step0, hiddenCorrection)
      this.drawArrow(rawTip, input.mapper.worldToCanvas(hiddenEnd), withAlpha('#8ba4c4', 0.7), 1.3, true)
    }

    this.drawArrow(origin, safeTip, SAFE_COLOR, 2.5)
    this.drawNode(safeTip, SAFE_COLOR, 4)

    this.drawArrow(rawTip, safeTip, withAlpha(SAFE_COLOR, 0.45), 1.2, true)

    this.drawLabel({
      anchor: rawTip,
      text: 'Δ0',
      color: RAW_COLOR,
      preferredDx: 8,
      preferredDy: -20,
    })

    this.drawLabel({
      anchor: safeTip,
      text: 'Δ*',
      color: SAFE_COLOR,
      preferredDx: 8,
      preferredDy: 8,
    })
  }

  private drawArrow(from: Vec2, to: Vec2, color: string, width: number, dashed = false): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    if (distance < 1.2) {
      return
    }

    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = Math.min(9, Math.max(6, width * 3.6))

    this.ctx.save()
    if (dashed) {
      this.ctx.setLineDash([6, 4])
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
    this.ctx.arc(point.x, point.y, radius + 4.6, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(color, 0.35)
    this.ctx.lineWidth = 1
    this.ctx.stroke()
  }

  private drawLabel(input: {
    anchor: Vec2
    text: string
    color: string
    preferredDx: number
    preferredDy: number
  }): void {
    this.ctx.font = '600 10px "Sora", sans-serif'
    const textWidth = this.ctx.measureText(input.text).width
    const width = Math.ceil(textWidth + 12)
    const height = 18

    const candidates = [
      { dx: input.preferredDx, dy: input.preferredDy },
      { dx: input.preferredDx, dy: input.preferredDy - 18 },
      { dx: input.preferredDx, dy: input.preferredDy + 18 },
      { dx: input.preferredDx + 18, dy: input.preferredDy },
      { dx: input.preferredDx - 18, dy: input.preferredDy },
      { dx: input.preferredDx + 24, dy: input.preferredDy - 14 },
      { dx: input.preferredDx - 24, dy: input.preferredDy + 14 },
    ]

    let chosen: LabelBox | null = null

    for (const candidate of candidates) {
      const x = clamp(input.anchor.x + candidate.dx, 6, this.canvas.clientWidth - width - 6)
      const y = clamp(input.anchor.y + candidate.dy, 6, this.canvas.clientHeight - height - 6)
      const box: LabelBox = { x, y, width, height }

      const intersects = this.labelBoxes.some((existing) => boxesOverlap(existing, box))
      if (!intersects) {
        chosen = box
        break
      }

      if (!chosen) {
        chosen = box
      }
    }

    if (!chosen) {
      return
    }

    this.labelBoxes.push(chosen)

    this.drawRoundedRect(chosen.x, chosen.y, chosen.width, chosen.height, 6)
    this.ctx.fillStyle = LABEL_BG
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(input.color, 0.56)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.fillStyle = withAlpha(input.color, 0.95)
    this.ctx.fillText(input.text, chosen.x + 6, chosen.y + 12)
  }

  private primaryViolatedDiagnostic(projection: ProjectionResult): ConstraintDiagnostic | null {
    const violated = projection.diagnostics
      .filter((diagnostic) => diagnostic.active && diagnostic.violationStep0 > 1e-6)
      .sort((a, b) => b.violationStep0 - a.violationStep0)
    return violated[0] ?? null
  }

  private boundaryHitPoint(rawStep: Vec2, diagnostic: ConstraintDiagnostic): Vec2 | null {
    const numerator = diagnostic.bound
    const denominator = diagnostic.normal.x * rawStep.x + diagnostic.normal.y * rawStep.y
    if (Math.abs(denominator) < 1e-8) {
      return null
    }

    const t = numerator / denominator
    if (!Number.isFinite(t)) {
      return null
    }

    const clamped = clamp(t, 0, 1)
    return scale(rawStep, clamped)
  }

  private computeCentroid(points: Vec2[]): Vec2 {
    if (points.length === 0) {
      return vec(0, 0)
    }

    const sum = points.reduce((acc, point) => add(acc, point), vec(0, 0))
    return scale(sum, 1 / points.length)
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
