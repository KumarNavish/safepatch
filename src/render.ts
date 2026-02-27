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
  hit: number
  correction: number
  safe: number
}

interface StageState {
  index: 0 | 1 | 2 | 3
  progress: number
}

interface LabelSpec {
  text: string
  anchor: Vec2
  color: string
}

interface LabelPlacement {
  text: string
  color: string
  x: number
  y: number
  width: number
  height: number
}

const RAW_COLOR = '#f05570'
const SAFE_COLOR = '#2c6cf5'
const WARN_COLOR = '#f4a037'
const GOOD_COLOR = '#119a7a'
const INK = '#132f4a'

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max)
}

function easeOutCubic(value: number): number {
  const t = clamp(value)
  return 1 - (1 - t) ** 3
}

function easeOutBack(value: number): number {
  const t = clamp(value)
  const c1 = 1.25
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}

function phaseWindow(progress: number, start: number, end: number): number {
  if (end <= start) {
    return progress >= end ? 1 : 0
  }
  return clamp((progress - start) / (end - start))
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

function collision(a: LabelPlacement, b: LabelPlacement): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  )
}

export class SceneRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D

  private mapper: Mapper | null = null
  private mapRect: Rect | null = null
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
    if (!this.mapper || !this.mapRect) {
      return null
    }

    const rect = this.canvas.getBoundingClientRect()
    const point = vec(clientX - rect.left, clientY - rect.top)
    const bounds = this.mapRect
    const margin = 8

    if (
      point.x < bounds.x - margin ||
      point.x > bounds.x + bounds.width + margin ||
      point.y < bounds.y - margin ||
      point.y > bounds.y + bounds.height + margin
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
    this.drawBackground(width, height)

    const surface: Rect = {
      x: 10,
      y: 10,
      width: width - 20,
      height: height - 20,
    }

    this.drawRoundedRect(surface.x, surface.y, surface.width, surface.height, 22)
    this.ctx.fillStyle = withAlpha('#ffffff', 0.98)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#cbdbee', 0.9)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const mapRect: Rect = {
      x: surface.x + 18,
      y: surface.y + 18,
      width: surface.width - 36,
      height: surface.height - 36,
    }

    const activeHalfspaces = input.halfspaces.filter((halfspace) => halfspace.active)
    const worldRadius = worldBoundsFromHalfspaces(activeHalfspaces) * 1.15
    const mapper = this.createMapper(mapRect, worldRadius)

    this.mapRect = mapRect
    this.mapper = mapper

    const beats = this.resolveTeachingBeats(input.teachingProgress)
    const teachingMode = input.teachingProgress < 0.999

    const rawBlocked = input.projection.diagnostics.some(
      (diagnostic) => diagnostic.active && diagnostic.violationStep0 > 1e-6,
    )

    const highlightedConstraintId = this.resolveHighlightedConstraintId(input)
    const stage = this.resolveStage(input.mode, rawBlocked, teachingMode, beats)

    this.drawMapPanel({
      mapRect,
      mapper,
      input,
      beats,
      stage,
      teachingMode,
      rawBlocked,
      highlightedConstraintId,
    })
  }

  private resolveHighlightedConstraintId(input: SceneRenderInput): string | null {
    if (input.highlightedConstraintId) {
      return input.highlightedConstraintId
    }

    const byLambda = [...input.projection.activeSetIds].sort(
      (a, b) => (input.projection.lambdaById[b] ?? 0) - (input.projection.lambdaById[a] ?? 0),
    )
    return byLambda[0] ?? null
  }

  private resolveTeachingBeats(progress: number): TeachingBeats {
    if (progress >= 1) {
      return { raw: 1, hit: 1, correction: 1, safe: 1 }
    }

    const t = clamp(progress)
    return {
      raw: easeOutCubic(phaseWindow(t, 0, 0.35)),
      hit: easeOutCubic(phaseWindow(t, 0.35, 0.52)),
      correction: easeOutCubic(phaseWindow(t, 0.52, 0.78)),
      safe: easeOutCubic(phaseWindow(t, 0.78, 1)),
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
      return { index: 2, progress: 0.48 + beats.correction * 0.28 }
    }

    return { index: 3, progress: 0.76 + beats.safe * 0.24 }
  }

  private createMapper(rect: Rect, worldRadius: number): Mapper {
    const padding = 44
    const usableWidth = Math.max(20, rect.width - padding * 2)
    const usableHeight = Math.max(20, rect.height - padding * 2)
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

  private drawBackground(width: number, height: number): void {
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fillRect(0, 0, width, height)

    const glow = this.ctx.createRadialGradient(width * 0.15, height * 0.02, 10, width * 0.15, height * 0.02, width * 0.8)
    glow.addColorStop(0, 'rgba(44, 108, 245, 0.1)')
    glow.addColorStop(1, 'rgba(44, 108, 245, 0)')
    this.ctx.fillStyle = glow
    this.ctx.fillRect(0, 0, width, height)
  }

  private drawMapPanel(params: {
    mapRect: Rect
    mapper: Mapper
    input: SceneRenderInput
    beats: TeachingBeats
    stage: StageState
    teachingMode: boolean
    rawBlocked: boolean
    highlightedConstraintId: string | null
  }): void {
    const { mapRect, mapper, input, beats, stage, teachingMode, rawBlocked, highlightedConstraintId } = params

    this.drawRoundedRect(mapRect.x, mapRect.y, mapRect.width, mapRect.height, 18)
    this.ctx.fillStyle = '#fbfdff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d6e4f4', 0.95)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.drawPanelAtmosphere(mapRect)

    const zone = intersectHalfspaces(input.halfspaces.filter((halfspace) => halfspace.active), mapper.worldRadius)
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
      this.ctx.fillStyle = withAlpha(SAFE_COLOR, 0.09)
      this.ctx.fill()
      this.ctx.strokeStyle = withAlpha(SAFE_COLOR, 0.28)
      this.ctx.lineWidth = 1.5
      this.ctx.stroke()
    }

    for (const halfspace of input.halfspaces) {
      if (!halfspace.active) {
        continue
      }

      const segment = this.constraintSegment(halfspace, mapper.worldRadius)
      if (!segment) {
        continue
      }

      const a = mapper.worldToCanvas(segment[0])
      const b = mapper.worldToCanvas(segment[1])
      const isHighlighted = highlightedConstraintId === halfspace.id
      const baseColor = isHighlighted ? this.colorForConstraint(halfspace.id) : '#9ab2cf'

      this.ctx.beginPath()
      this.ctx.moveTo(a.x, a.y)
      this.ctx.lineTo(b.x, b.y)
      this.ctx.strokeStyle = withAlpha(baseColor, isHighlighted ? 0.84 : 0.28)
      this.ctx.lineWidth = isHighlighted ? 2.3 : 1.1
      this.ctx.stroke()
    }

    const origin = mapper.worldToCanvas(vec(0, 0))
    const rawTip = mapper.worldToCanvas(input.projection.step0)
    const safeTip = mapper.worldToCanvas(input.projection.projectedStep)
    this.rawHandleCanvas = rawTip

    const rawProgress = teachingMode ? beats.raw : 1
    const rawDrawTip = vecLerp(origin, rawTip, rawProgress)
    this.drawArrow(origin, rawDrawTip, RAW_COLOR, 3)

    if (rawProgress > 0.9) {
      this.drawHandle(rawTip, RAW_COLOR, 7)
    }

    if (rawBlocked) {
      const pulseStrength = teachingMode ? beats.hit : 1
      if (pulseStrength > 0.03) {
        this.drawPulse(rawTip, WARN_COLOR, 12 + pulseStrength * 22)
      }

      const correctionProgress = teachingMode ? beats.correction : 1
      if (correctionProgress > 0.03) {
        const correctionTip = vecLerp(rawTip, safeTip, correctionProgress)
        this.drawArrow(rawTip, correctionTip, WARN_COLOR, 2.3, true)
      }
    }

    const safeProgress = input.mode === 'forces' ? 1 : teachingMode ? (rawBlocked ? beats.safe : beats.raw) : 1
    const safeDrawTip = vecLerp(origin, safeTip, easeOutBack(safeProgress))
    this.drawArrow(origin, safeDrawTip, SAFE_COLOR, 3)

    if (safeProgress > 0.86) {
      this.drawHandle(safeTip, SAFE_COLOR, 6.6)
    }

    if (input.mode === 'forces') {
      this.drawForceDecomposition({ mapper, projection: input.projection, visibleIds: input.visibleCorrectionIds })
    }

    this.drawOrigin(origin)

    const labels: LabelSpec[] = [
      { text: 'Raw patch (drag)', anchor: rawTip, color: RAW_COLOR },
      { text: 'Certified patch', anchor: safeTip, color: SAFE_COLOR },
    ]
    this.drawLabels(labels, mapRect)

    this.drawLegend(mapRect)
    this.drawValueChips(mapRect, input.stats, rawBlocked)
    this.drawTimeline(mapRect, stage)

    if (input.dragActive) {
      this.drawDragToast(mapRect)
    }
  }

  private drawPanelAtmosphere(rect: Rect): void {
    const g = this.ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(1, '#f8fbff')

    this.drawRoundedRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2, 17)
    this.ctx.fillStyle = g
    this.ctx.fill()
  }

  private drawForceDecomposition(params: {
    mapper: Mapper
    projection: ProjectionResult
    visibleIds: string[]
  }): void {
    const { mapper, projection, visibleIds } = params

    const visibleSet = new Set(visibleIds)
    const forceIds = projection.activeSetIds.filter((id) => (projection.lambdaById[id] ?? 0) > 1e-6)

    let cursor = { ...projection.step0 }
    for (const id of forceIds) {
      const correction = projection.correctionById[id]
      const lambda = projection.lambdaById[id] ?? 0
      if (!correction || lambda <= 1e-6) {
        continue
      }

      const next = {
        x: cursor.x + correction.x,
        y: cursor.y + correction.y,
      }

      const selected = visibleSet.size === 0 || visibleSet.has(id)
      this.drawArrow(
        mapper.worldToCanvas(cursor),
        mapper.worldToCanvas(next),
        withAlpha(this.colorForConstraint(id), selected ? 0.9 : 0.35),
        selected ? 2.4 : 1.6,
        true,
      )

      cursor = next
    }
  }

  private drawLegend(mapRect: Rect): void {
    const x = mapRect.x + 14
    const y = mapRect.y + 14

    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#446282', 0.94)
    this.ctx.fillText('SAFEPATCH LIVE STAGE', x, y)

    const items = [
      { color: RAW_COLOR, label: 'Raw proposal' },
      { color: WARN_COLOR, label: 'Unsafe component removed' },
      { color: SAFE_COLOR, label: 'Certified proposal' },
    ]

    let cursorX = x
    const rowY = y + 16

    for (const item of items) {
      this.ctx.beginPath()
      this.ctx.arc(cursorX + 5, rowY - 3, 3.5, 0, Math.PI * 2)
      this.ctx.fillStyle = item.color
      this.ctx.fill()

      this.ctx.fillStyle = withAlpha('#50708f', 0.95)
      this.ctx.fillText(item.label, cursorX + 12, rowY)
      cursorX += this.ctx.measureText(item.label).width + 42
    }
  }

  private drawValueChips(mapRect: Rect, stats: SceneRenderInput['stats'], rawBlocked: boolean): void {
    const incidentDelta = Math.round((stats.incidentRaw - stats.incidentSafe) * 10) / 10
    const chips = [
      {
        title: 'Problem',
        value: rawBlocked
          ? `${stats.checksRawPassed}/${stats.checksTotal} checks pass in raw`
          : 'Raw patch already inside policy envelope',
        tone: rawBlocked ? WARN_COLOR : GOOD_COLOR,
      },
      {
        title: 'Fix',
        value: `${stats.checksSafePassed}/${stats.checksTotal} checks pass after projection`,
        tone: SAFE_COLOR,
      },
      {
        title: 'Value',
        value: incidentDelta >= 0 ? `${incidentDelta.toFixed(1)}/hr incidents prevented` : `${Math.abs(incidentDelta).toFixed(1)}/hr incidents added`,
        tone: incidentDelta >= 0 ? GOOD_COLOR : WARN_COLOR,
      },
    ]

    const maxWidth = Math.min(320, mapRect.width * 0.46)
    const chipW = maxWidth
    const chipH = 46
    const gap = 8
    const startX = mapRect.x + mapRect.width - chipW - 14
    const startY = mapRect.y + 14

    for (let i = 0; i < chips.length; i += 1) {
      const chip = chips[i]
      const y = startY + i * (chipH + gap)

      this.drawRoundedRect(startX, y, chipW, chipH, 11)
      this.ctx.fillStyle = withAlpha('#ffffff', 0.95)
      this.ctx.fill()
      this.ctx.strokeStyle = withAlpha(chip.tone, 0.34)
      this.ctx.lineWidth = 1
      this.ctx.stroke()

      this.ctx.font = "600 9px 'IBM Plex Mono'"
      this.ctx.fillStyle = withAlpha(chip.tone, 0.95)
      this.ctx.fillText(chip.title.toUpperCase(), startX + 10, y + 14)

      this.ctx.font = "600 12px 'Manrope'"
      this.ctx.fillStyle = INK
      this.wrapText(chip.value, startX + 10, y + 31, chipW - 20, 14, 1)
    }
  }

  private drawTimeline(mapRect: Rect, stage: StageState): void {
    const x = mapRect.x + 14
    const y = mapRect.y + mapRect.height - 36
    const width = mapRect.width - 28

    this.drawRoundedRect(x, y, width, 22, 11)
    this.ctx.fillStyle = withAlpha('#ffffff', 0.92)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d4e3f5', 0.92)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const railX0 = x + 14
    const railX1 = x + width - 14
    const railY = y + 11

    this.ctx.beginPath()
    this.ctx.moveTo(railX0, railY)
    this.ctx.lineTo(railX1, railY)
    this.ctx.strokeStyle = '#deebfa'
    this.ctx.lineWidth = 4
    this.ctx.lineCap = 'round'
    this.ctx.stroke()

    const fillX = numberLerp(railX0, railX1, clamp(stage.progress))
    this.ctx.beginPath()
    this.ctx.moveTo(railX0, railY)
    this.ctx.lineTo(fillX, railY)
    this.ctx.strokeStyle = withAlpha(SAFE_COLOR, 0.86)
    this.ctx.lineWidth = 4
    this.ctx.lineCap = 'round'
    this.ctx.stroke()

    const steps = [0, 1, 2, 3] as const
    for (const step of steps) {
      const t = step / 3
      const cx = numberLerp(railX0, railX1, t)

      this.ctx.beginPath()
      this.ctx.arc(cx, railY, step === stage.index ? 5.6 : 4.2, 0, Math.PI * 2)
      this.ctx.fillStyle = step <= stage.index ? withAlpha(SAFE_COLOR, 0.95) : '#e9f1fd'
      this.ctx.fill()

      if (step === stage.index) {
        this.ctx.beginPath()
        this.ctx.arc(cx, railY, 8.8, 0, Math.PI * 2)
        this.ctx.strokeStyle = withAlpha(SAFE_COLOR, 0.28)
        this.ctx.lineWidth = 1
        this.ctx.stroke()
      }
    }
  }

  private drawDragToast(mapRect: Rect): void {
    const width = 204
    const height = 28
    const x = mapRect.x + mapRect.width * 0.5 - width * 0.5
    const y = mapRect.y + 16

    this.drawRoundedRect(x, y, width, height, 14)
    this.ctx.fillStyle = withAlpha('#ffffff', 0.92)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(SAFE_COLOR, 0.35)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "600 11px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#2a57ad', 0.95)
    this.ctx.fillText('LIVE DRAG: certifying...', x + 20, y + 18)
  }

  private drawOrigin(point: Vec2): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, 4.8, 0, Math.PI * 2)
    this.ctx.fillStyle = '#1a3f68'
    this.ctx.fill()
  }

  private drawArrow(from: Vec2, to: Vec2, color: string, width: number, dashed = false): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    if (distance < 1.2) {
      return
    }

    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = Math.min(11, Math.max(7, width * 3.2))

    this.ctx.save()
    if (dashed) {
      this.ctx.setLineDash([8, 6])
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
    this.ctx.arc(point.x, point.y, radius + 4.2, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.14)
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    this.ctx.fillStyle = color
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius - 2.3, 0, Math.PI * 2)
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius - 3.9, 0, Math.PI * 2)
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

  private drawLabels(labels: LabelSpec[], bounds: Rect): void {
    const placements: LabelPlacement[] = []

    for (const label of labels) {
      const metrics = this.ctx.measureText(label.text)
      const width = Math.ceil(metrics.width) + 14
      const height = 22
      const candidates = [
        { x: 12, y: -14 },
        { x: 12, y: 12 },
        { x: -width - 12, y: -14 },
        { x: -width - 12, y: 12 },
      ]

      let chosen: LabelPlacement | null = null

      for (const candidate of candidates) {
        const x = clamp(label.anchor.x + candidate.x, bounds.x + 8, bounds.x + bounds.width - width - 8)
        const y = clamp(label.anchor.y + candidate.y, bounds.y + 8, bounds.y + bounds.height - height - 8)

        const placement: LabelPlacement = {
          text: label.text,
          color: label.color,
          x,
          y,
          width,
          height,
        }

        const overlaps = placements.some((existing) => collision(existing, placement))
        if (!overlaps) {
          chosen = placement
          break
        }
      }

      if (!chosen) {
        chosen = {
          text: label.text,
          color: label.color,
          x: clamp(label.anchor.x + 10, bounds.x + 8, bounds.x + bounds.width - width - 8),
          y: clamp(label.anchor.y - 12, bounds.y + 8, bounds.y + bounds.height - height - 8),
          width,
          height,
        }
      }

      placements.push(chosen)
    }

    for (const placement of placements) {
      this.drawRoundedRect(placement.x, placement.y, placement.width, placement.height, 11)
      this.ctx.fillStyle = withAlpha('#ffffff', 0.93)
      this.ctx.fill()
      this.ctx.strokeStyle = withAlpha(placement.color, 0.36)
      this.ctx.lineWidth = 1
      this.ctx.stroke()

      this.ctx.font = "600 10px 'IBM Plex Mono'"
      this.ctx.fillStyle = withAlpha(placement.color, 0.92)
      this.ctx.fillText(placement.text, placement.x + 7, placement.y + 14)
    }
  }

  private constraintSegment(halfspace: Halfspace, radius: number): [Vec2, Vec2] | null {
    const points: Vec2[] = []
    const { normal, bound } = halfspace
    const eps = 1e-8

    if (Math.abs(normal.y) > eps) {
      const yLeft = (bound - normal.x * -radius) / normal.y
      if (Math.abs(yLeft) <= radius) {
        points.push(vec(-radius, yLeft))
      }

      const yRight = (bound - normal.x * radius) / normal.y
      if (Math.abs(yRight) <= radius) {
        points.push(vec(radius, yRight))
      }
    }

    if (Math.abs(normal.x) > eps) {
      const xBottom = (bound - normal.y * -radius) / normal.x
      if (Math.abs(xBottom) <= radius) {
        points.push(vec(xBottom, -radius))
      }

      const xTop = (bound - normal.y * radius) / normal.x
      if (Math.abs(xTop) <= radius) {
        points.push(vec(xTop, radius))
      }
    }

    const unique: Vec2[] = []
    for (const point of points) {
      const found = unique.some((existing) => Math.hypot(existing.x - point.x, existing.y - point.y) < 1e-5)
      if (!found) {
        unique.push(point)
      }
    }

    if (unique.length < 2) {
      return null
    }

    let bestPair: [Vec2, Vec2] = [unique[0], unique[1]]
    let maxDistance = 0

    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const d = Math.hypot(unique[i].x - unique[j].x, unique[i].y - unique[j].y)
        if (d > maxDistance) {
          maxDistance = d
          bestPair = [unique[i], unique[j]]
        }
      }
    }

    return bestPair
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

  private wrapText(text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number): void {
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      return
    }

    let line = ''
    let lines = 0

    for (let i = 0; i < words.length; i += 1) {
      const candidate = line ? `${line} ${words[i]}` : words[i]
      const tooWide = this.ctx.measureText(candidate).width > maxWidth

      if (tooWide && line) {
        this.ctx.fillText(line, x, y + lines * lineHeight)
        lines += 1
        line = words[i]

        if (lines >= maxLines) {
          return
        }
      } else {
        line = candidate
      }
    }

    if (line && lines < maxLines) {
      this.ctx.fillText(line, x, y + lines * lineHeight)
    }
  }
}
