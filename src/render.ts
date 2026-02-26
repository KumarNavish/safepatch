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

const RAW_COLOR = '#e5484d'
const SAFE_COLOR = '#1d4ed8'
const PUSH_COLOR = '#f59f0b'
const FEASIBLE_FILL = 'rgba(22, 163, 74, 0.10)'
const FEASIBLE_STROKE = 'rgba(22, 163, 74, 0.54)'
const LABEL_BG = 'rgba(255, 255, 255, 0.96)'
const LABEL_BORDER = 'rgba(173, 188, 209, 0.62)'

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

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

export class SceneRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly colorById = new Map<string, string>()
  private readonly palette = ['#0f8f74', '#2b67f6', '#e44f73', '#ea9a2d', '#7c52d8', '#0ea5a4']

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
    this.drawBackdrop(width, height, input.clockMs)

    const frame: Rect = {
      x: 10,
      y: 10,
      width: width - 20,
      height: height - 20,
    }

    this.drawRoundedRect(frame.x, frame.y, frame.width, frame.height, 12)
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.94)'
    this.ctx.fill()
    this.ctx.strokeStyle = 'rgba(194, 207, 226, 0.92)'
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
    this.labelBoxes = []

    const beats = this.resolveTeachingBeats(input.teachingProgress)
    const teachingMode = input.teachingProgress < 0.999
    const activeSet = new Set(input.projection.activeSetIds)
    const visibleSet = new Set(input.visibleCorrectionIds)
    const primaryDiagnostic = this.primaryViolatedDiagnostic(input.projection)

    this.drawStageSurface(plotRect, input.clockMs)
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

    if (input.dragActive && input.mode === 'geometry') {
      this.drawTrails(mapper, input.rawTrail, RAW_COLOR)
      this.drawTrails(mapper, input.safeTrail, SAFE_COLOR)
    }

    if (input.mode === 'geometry') {
      this.drawGeometryMode({
        projection: input.projection,
        mapper,
        beats,
        dragActive: input.dragActive,
        teachingMode,
        primaryDiagnostic,
        pulse: 0.5 + 0.5 * Math.sin(input.clockMs * 0.0052),
      })
    } else {
      this.drawForcesMode({
        projection: input.projection,
        mapper,
        visibleSet,
        highlightedConstraintId: input.highlightedConstraintId,
      })
    }

    this.drawLegend(plotRect, input.mode)
  }

  private drawTrails(mapper: Mapper, points: Vec2[], color: string): void {
    if (points.length < 2) {
      return
    }

    const start = Math.max(0, points.length - 10)
    for (let i = start + 1; i < points.length; i += 1) {
      const alpha = (i - start) / Math.max(1, points.length - start)
      const from = mapper.worldToCanvas(points[i - 1])
      const to = mapper.worldToCanvas(points[i])
      this.ctx.beginPath()
      this.ctx.moveTo(from.x, from.y)
      this.ctx.lineTo(to.x, to.y)
      this.ctx.strokeStyle = withAlpha(color, 0.04 + alpha * 0.1)
      this.ctx.lineWidth = 0.8 + alpha * 0.8
      this.ctx.lineCap = 'round'
      this.ctx.stroke()
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

  private drawBackdrop(width: number, height: number, clockMs: number): void {
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, '#ffffff')
    gradient.addColorStop(1, '#f9fbff')
    this.ctx.fillStyle = gradient
    this.ctx.fillRect(0, 0, width, height)

    const focusX = width * (0.18 + 0.04 * Math.sin(clockMs * 0.00055))
    const focusY = height * (0.12 + 0.02 * Math.cos(clockMs * 0.0006))
    const glow = this.ctx.createRadialGradient(focusX, focusY, 10, focusX, focusY, width * 0.42)
    glow.addColorStop(0, 'rgba(29, 78, 216, 0.08)')
    glow.addColorStop(1, 'rgba(29, 78, 216, 0)')
    this.ctx.fillStyle = glow
    this.ctx.fillRect(0, 0, width, height)
  }

  private createMapper(rect: Rect, halfspaces: Halfspace[]): Mapper {
    const worldRadius = worldBoundsFromHalfspaces(halfspaces)
    const pad = 26
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

  private drawStageSurface(rect: Rect, clockMs: number): void {
    const gradient = this.ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height)
    gradient.addColorStop(0, '#ffffff')
    gradient.addColorStop(1, '#fbfdff')
    this.ctx.fillStyle = gradient
    this.ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

    const sweep = ((clockMs * 0.04) % (rect.width + 160)) - 80
    const beamX = rect.x + sweep
    const beam = this.ctx.createLinearGradient(beamX - 120, rect.y, beamX + 120, rect.y)
    beam.addColorStop(0, 'rgba(29, 78, 216, 0)')
    beam.addColorStop(0.5, 'rgba(29, 78, 216, 0.06)')
    beam.addColorStop(1, 'rgba(29, 78, 216, 0)')
    this.ctx.fillStyle = beam
    this.ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.strokeStyle = 'rgba(190, 205, 226, 0.86)'
    this.ctx.lineWidth = 1
    this.ctx.stroke()
  }

  private drawLegend(rect: Rect, mode: SceneMode): void {
    const items =
      mode === 'geometry'
        ? [
            { label: 'Proposed patch', color: RAW_COLOR },
            { label: 'Certified patch', color: SAFE_COLOR },
            { label: 'Policy push-back', color: PUSH_COLOR },
          ]
        : [
            { label: 'Proposed patch', color: RAW_COLOR },
            { label: 'Total policy correction', color: PUSH_COLOR },
            { label: 'Certified patch', color: SAFE_COLOR },
          ]

    let cursorX = rect.x + 10
    const y = rect.y + 12

    for (const item of items) {
      this.ctx.beginPath()
      this.ctx.arc(cursorX, y, 3.2, 0, Math.PI * 2)
      this.ctx.fillStyle = item.color
      this.ctx.fill()

      this.ctx.font = '600 10px "IBM Plex Mono", monospace'
      this.ctx.fillStyle = '#415c7e'
      this.ctx.fillText(item.label, cursorX + 8, y + 3.5)

      cursorX += this.ctx.measureText(item.label).width + 28
    }
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
    this.ctx.lineWidth = 1.5
    this.ctx.stroke()

    const anchor = mapper.worldToCanvas(vec(0.02 * mapper.worldRadius, -0.08 * mapper.worldRadius))
    this.drawLabel({
      anchor,
      text: 'ship-safe zone',
      color: '#0f8f74',
      preferredDx: 10,
      preferredDy: 10,
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
    const span = input.mapper.worldRadius * 1.85

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

      let stroke = 'rgba(147, 164, 188, 0.34)'
      let width = 1.1

      if (input.mode === 'forces') {
        if (isActive && input.visibleSet.has(halfspace.id)) {
          stroke = withAlpha(baseColor, 0.78)
          width = 2
        } else if (isActive) {
          stroke = withAlpha(baseColor, 0.18)
          width = 1
        }
      } else if (isPrimary) {
        stroke = withAlpha(PUSH_COLOR, 0.5 + input.hitBeat * 0.42)
        width = 1.3 + input.hitBeat * 1
      } else if (input.mode === 'geometry') {
        stroke = 'rgba(143, 161, 186, 0.2)'
        width = 0.95
      }

      if (isHighlighted) {
        stroke = withAlpha(baseColor, 0.94)
        width = 2.1
      }

      this.ctx.beginPath()
      this.ctx.moveTo(p0.x, p0.y)
      this.ctx.lineTo(p1.x, p1.y)
      this.ctx.strokeStyle = stroke
      this.ctx.lineWidth = width
      this.ctx.stroke()

      if (input.mode === 'forces' && input.highlightedConstraintId === halfspace.id) {
        const labelAnchor = input.mapper.worldToCanvas(add(anchor, scale(normal, 0.06 * input.mapper.worldRadius)))
        this.drawLabel({
          anchor: labelAnchor,
          text: halfspace.label,
          color: baseColor,
          preferredDx: 10,
          preferredDy: -18,
        })
      }
    })
  }

  private drawGeometryMode(input: {
    projection: ProjectionResult
    mapper: Mapper
    beats: TeachingBeats
    dragActive: boolean
    teachingMode: boolean
    primaryDiagnostic: ConstraintDiagnostic | null
    pulse: number
  }): void {
    const originWorld = vec(0, 0)
    const rawWorld = input.projection.step0
    const safeWorld = input.projection.projectedStep

    const origin = input.mapper.worldToCanvas(originWorld)
    const rawVisibleWorld = lerp(originWorld, rawWorld, input.beats.raw)
    const rawVisible = input.mapper.worldToCanvas(rawVisibleWorld)

    this.drawArrow(origin, rawVisible, RAW_COLOR, 2.5, false, true)
    this.drawNode(origin, '#7292b8', 3.8)
    this.drawNode(rawVisible, RAW_COLOR, 4)

    let hitCanvas: Vec2 | null = null

    if (input.primaryDiagnostic && input.beats.hit > 0.02) {
      const boundaryHit = this.boundaryHitPoint(rawWorld, input.primaryDiagnostic)
      if (boundaryHit) {
        hitCanvas = input.mapper.worldToCanvas(boundaryHit)

        if (input.teachingMode) {
          this.drawImpactBurst(hitCanvas, input.beats.hit, input.pulse, PUSH_COLOR)
          this.drawLabel({
            anchor: hitCanvas,
            text: 'policy wall',
            color: PUSH_COLOR,
            preferredDx: 10,
            preferredDy: -30,
          })
        }
      }
    }

    if (input.beats.correction > 0.02) {
      const correctionVisible = lerp(rawWorld, safeWorld, input.beats.correction)
      this.drawArrow(
        input.mapper.worldToCanvas(rawWorld),
        input.mapper.worldToCanvas(correctionVisible),
        PUSH_COLOR,
        input.teachingMode ? 1.9 : 1.5,
        false,
        input.teachingMode,
      )

    }

    if (input.beats.safe > 0.02) {
      const safeVisibleWorld = lerp(originWorld, safeWorld, easeOutBack(input.beats.safe))
      const safeVisible = input.mapper.worldToCanvas(safeVisibleWorld)
      this.drawArrow(origin, safeVisible, SAFE_COLOR, 2.6, false, true)
      this.drawNode(safeVisible, SAFE_COLOR, 4)
      if (input.teachingMode && input.beats.safe > 0.8) {
        this.drawApprovalBadge(safeVisible, (input.beats.safe - 0.8) / 0.2)
      }
    }

    this.drawLabel({
      anchor: input.mapper.worldToCanvas(rawWorld),
      text: 'proposed patch',
      color: RAW_COLOR,
      preferredDx: 10,
      preferredDy: 10,
    })

    this.drawLabel({
      anchor: input.mapper.worldToCanvas(safeWorld),
      text: 'certified patch',
      color: SAFE_COLOR,
      preferredDx: 10,
      preferredDy: -18,
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

    this.drawArrow(origin, rawTip, RAW_COLOR, 2.3, false, true)
    this.drawNode(origin, '#7292b8', 3.8)
    this.drawNode(rawTip, RAW_COLOR, 4)
    this.drawArrow(rawTip, safeTip, PUSH_COLOR, 2, false, true)
    this.drawArrow(origin, safeTip, SAFE_COLOR, 2.6, false, true)
    this.drawNode(safeTip, SAFE_COLOR, 4)

    const selectedId = input.highlightedConstraintId
    if (selectedId && input.visibleSet.has(selectedId)) {
      const lambda = input.projection.lambdaById[selectedId] ?? 0
      const color = this.colorForConstraint(selectedId)
      if (lambda > 1e-6) {
        this.drawLabel({
          anchor: lerp(rawTip, safeTip, 0.5),
          text: `selected policy pressure ${lambda.toFixed(3)}`,
          color,
          preferredDx: 8,
          preferredDy: -20,
        })
      }
    }

    this.drawLabel({
      anchor: rawTip,
      text: 'proposed patch',
      color: RAW_COLOR,
      preferredDx: 10,
      preferredDy: -18,
    })

    this.drawLabel({
      anchor: safeTip,
      text: 'certified patch',
      color: SAFE_COLOR,
      preferredDx: 10,
      preferredDy: 8,
    })
  }

  private drawImpactBurst(center: Vec2, hitBeat: number, pulse: number, color: string): void {
    const intensity = easeOutCubic(hitBeat)
    const maxRadius = 8 + intensity * 12 + pulse * 2

    for (let i = 0; i < 3; i += 1) {
      const phase = i / 3
      const radius = maxRadius * (0.55 + phase * 0.45)
      this.ctx.beginPath()
      this.ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
      this.ctx.strokeStyle = withAlpha(color, 0.24 - phase * 0.08)
      this.ctx.lineWidth = 1.2 - phase * 0.3
      this.ctx.stroke()
    }

    const rayLength = 8 + intensity * 9
    for (let ray = 0; ray < 6; ray += 1) {
      const angle = (Math.PI * 2 * ray) / 6 + pulse * 0.15
      this.ctx.beginPath()
      this.ctx.moveTo(center.x + Math.cos(angle) * 4, center.y + Math.sin(angle) * 4)
      this.ctx.lineTo(center.x + Math.cos(angle) * rayLength, center.y + Math.sin(angle) * rayLength)
      this.ctx.strokeStyle = withAlpha(color, 0.2)
      this.ctx.lineWidth = 1
      this.ctx.stroke()
    }
  }

  private drawApprovalBadge(anchor: Vec2, alpha: number): void {
    const opacity = clamp(alpha)
    if (opacity <= 0.01) {
      return
    }

    const x = anchor.x + 18
    const y = anchor.y - 18
    this.drawRoundedRect(x - 11, y - 9, 22, 18, 6)
    this.ctx.fillStyle = `rgba(15, 143, 116, ${0.16 * opacity})`
    this.ctx.fill()
    this.ctx.strokeStyle = `rgba(15, 143, 116, ${0.6 * opacity})`
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.save()
    this.ctx.strokeStyle = `rgba(15, 143, 116, ${0.92 * opacity})`
    this.ctx.lineWidth = 1.8
    this.ctx.lineCap = 'round'
    this.ctx.beginPath()
    this.ctx.moveTo(x - 4.5, y + 0.5)
    this.ctx.lineTo(x - 1, y + 4)
    this.ctx.lineTo(x + 5, y - 3)
    this.ctx.stroke()
    this.ctx.restore()
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
      this.ctx.strokeStyle = withAlpha(color, 0.14)
      this.ctx.lineWidth = width + 3.2
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
    this.ctx.arc(point.x, point.y, radius + 3.5, 0, Math.PI * 2)
    this.ctx.strokeStyle = withAlpha(color, 0.24)
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

    this.drawRoundedRect(chosen.x, chosen.y, chosen.width, chosen.height, 5)
    this.ctx.fillStyle = LABEL_BG
    this.ctx.fill()
    this.ctx.strokeStyle = LABEL_BORDER
    this.ctx.lineWidth = 0.8
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
