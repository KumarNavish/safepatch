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
const MUTED = '#5f7896'

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

    const narrow = width < 860
    const mapRect: Rect = narrow
      ? {
          x: surface.x + 18,
          y: surface.y + 18,
          width: surface.width - 36,
          height: surface.height * 0.64,
        }
      : {
          x: surface.x + 20,
          y: surface.y + 20,
          width: surface.width * 0.63,
          height: surface.height - 40,
        }

    const storyRect: Rect = narrow
      ? {
          x: mapRect.x,
          y: mapRect.y + mapRect.height + 12,
          width: mapRect.width,
          height: surface.y + surface.height - (mapRect.y + mapRect.height + 12) - 14,
        }
      : {
          x: mapRect.x + mapRect.width + 16,
          y: mapRect.y,
          width: surface.x + surface.width - (mapRect.x + mapRect.width + 16) - 14,
          height: mapRect.height,
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

    this.drawMapPanel({
      mapRect,
      mapper,
      input,
      beats,
      teachingMode,
      rawBlocked,
      highlightedConstraintId,
    })

    this.drawStoryPanel({
      storyRect,
      mode: input.mode,
      stats: input.stats,
      rawBlocked,
      teachingMode,
      beats,
      projection: input.projection,
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

  private createMapper(rect: Rect, worldRadius: number): Mapper {
    const padding = 30
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

    const glow = this.ctx.createRadialGradient(width * 0.2, 0, 20, width * 0.2, 0, width * 0.72)
    glow.addColorStop(0, 'rgba(44, 108, 245, 0.08)')
    glow.addColorStop(1, 'rgba(44, 108, 245, 0)')
    this.ctx.fillStyle = glow
    this.ctx.fillRect(0, 0, width, height)
  }

  private drawMapPanel(params: {
    mapRect: Rect
    mapper: Mapper
    input: SceneRenderInput
    beats: TeachingBeats
    teachingMode: boolean
    rawBlocked: boolean
    highlightedConstraintId: string | null
  }): void {
    const { mapRect, mapper, input, beats, teachingMode, rawBlocked, highlightedConstraintId } = params

    this.drawRoundedRect(mapRect.x, mapRect.y, mapRect.width, mapRect.height, 18)
    this.ctx.fillStyle = '#fbfdff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d6e4f4', 0.95)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.drawGrid(mapRect)

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
      this.ctx.strokeStyle = withAlpha(SAFE_COLOR, 0.26)
      this.ctx.lineWidth = 1.3
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
      const color = isHighlighted ? this.colorForConstraint(halfspace.id) : '#9ab2cf'

      this.ctx.beginPath()
      this.ctx.moveTo(a.x, a.y)
      this.ctx.lineTo(b.x, b.y)
      this.ctx.strokeStyle = withAlpha(color, isHighlighted ? 0.8 : 0.4)
      this.ctx.lineWidth = isHighlighted ? 2 : 1.2
      this.ctx.stroke()
    }

    const origin = mapper.worldToCanvas(vec(0, 0))
    const rawTip = mapper.worldToCanvas(input.projection.step0)
    const safeTip = mapper.worldToCanvas(input.projection.projectedStep)
    this.rawHandleCanvas = rawTip

    const rawVectorProgress = teachingMode ? beats.raw : 1
    const rawDrawTip = vecLerp(origin, rawTip, rawVectorProgress)

    this.drawArrow(origin, rawDrawTip, RAW_COLOR, 2.8)
    if (rawVectorProgress > 0.85) {
      this.drawHandle(rawTip, RAW_COLOR, 7)
    }

    if (rawBlocked) {
      const hitPulse = teachingMode ? beats.hit : 1
      if (hitPulse > 0.03) {
        this.drawPulse(rawTip, WARN_COLOR, 10 + 16 * hitPulse)
      }

      const correctionProgress = teachingMode ? beats.correction : 1
      if (correctionProgress > 0.03) {
        const correctionTip = vecLerp(rawTip, safeTip, correctionProgress)
        this.drawArrow(rawTip, correctionTip, WARN_COLOR, 2.1, true)
      }
    }

    if (input.mode === 'geometry') {
      const safeVectorProgress = teachingMode ? (rawBlocked ? beats.safe : beats.raw) : 1
      const safeDrawTip = vecLerp(origin, safeTip, safeVectorProgress)
      this.drawArrow(origin, safeDrawTip, SAFE_COLOR, 2.8)
      if (safeVectorProgress > 0.86) {
        this.drawHandle(safeTip, SAFE_COLOR, 6)
      }
    } else {
      this.drawArrow(origin, safeTip, withAlpha(SAFE_COLOR, 0.35), 2)
      this.drawHandle(safeTip, SAFE_COLOR, 6)
      this.drawForceDecomposition({ mapper, projection: input.projection, visibleIds: input.visibleCorrectionIds })
    }

    this.drawOrigin(origin)
    this.drawMapLegend(mapRect)

    const labels: LabelSpec[] = [
      {
        text: 'Raw patch',
        anchor: rawTip,
        color: RAW_COLOR,
      },
      {
        text: 'Certified patch',
        anchor: safeTip,
        color: SAFE_COLOR,
      },
      {
        text: 'Policy envelope',
        anchor: vec(mapRect.x + 20, mapRect.y + 24),
        color: '#3e67bb',
      },
    ]

    this.drawLabels(labels, mapRect)

    if (input.dragActive) {
      this.ctx.font = "600 11px 'IBM Plex Mono'"
      this.ctx.fillStyle = withAlpha('#214d9b', 0.9)
      this.ctx.fillText('Dragging proposal...', mapRect.x + 16, mapRect.y + mapRect.height - 16)
    }
  }

  private drawForceDecomposition(params: {
    mapper: Mapper
    projection: ProjectionResult
    visibleIds: string[]
  }): void {
    const { mapper, projection, visibleIds } = params

    const activeIds = visibleIds.filter((id) => (projection.lambdaById[id] ?? 0) > 1e-6)
    const forceIds = activeIds.length > 0 ? activeIds : projection.activeSetIds

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

      this.drawArrow(
        mapper.worldToCanvas(cursor),
        mapper.worldToCanvas(next),
        this.colorForConstraint(id),
        2,
        true,
      )

      cursor = next
    }

    if (Math.hypot(cursor.x - projection.projectedStep.x, cursor.y - projection.projectedStep.y) > 1e-4) {
      this.drawArrow(
        mapper.worldToCanvas(cursor),
        mapper.worldToCanvas(projection.projectedStep),
        withAlpha(SAFE_COLOR, 0.6),
        1.8,
        true,
      )
    }
  }

  private drawStoryPanel(params: {
    storyRect: Rect
    mode: SceneMode
    stats: SceneRenderInput['stats']
    rawBlocked: boolean
    teachingMode: boolean
    beats: TeachingBeats
    projection: ProjectionResult
  }): void {
    const { storyRect, mode, stats, rawBlocked, teachingMode, beats, projection } = params

    this.drawRoundedRect(storyRect.x, storyRect.y, storyRect.width, storyRect.height, 16)
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d6e4f4', 0.95)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const stage = this.resolveStageCopy(mode, rawBlocked, teachingMode, beats)

    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#4e6787', 0.9)
    this.ctx.fillText('LIVE PIPELINE', storyRect.x + 14, storyRect.y + 20)

    this.drawProgress(storyRect.x + 14, storyRect.y + 28, storyRect.width - 28, stage.progress)

    this.ctx.font = "700 18px 'Manrope'"
    this.ctx.fillStyle = INK
    this.wrapText(stage.title, storyRect.x + 14, storyRect.y + 54, storyRect.width - 28, 22, 2)

    this.ctx.font = "500 13px 'Manrope'"
    this.ctx.fillStyle = MUTED
    this.wrapText(stage.body, storyRect.x + 14, storyRect.y + 104, storyRect.width - 28, 20, 3)

    const rowY = storyRect.y + Math.max(138, storyRect.height * 0.36)
    const rowW = storyRect.width - 28
    this.drawMetricRow({
      x: storyRect.x + 14,
      y: rowY,
      width: rowW,
      title: 'If shipped raw',
      incidentsText: `${stats.incidentRaw.toFixed(1)} incidents/hr`,
      checksText: `${stats.checksRawPassed}/${stats.checksTotal} checks`,
      tone: RAW_COLOR,
    })

    this.drawMetricRow({
      x: storyRect.x + 14,
      y: rowY + 76,
      width: rowW,
      title: 'After SafePatch',
      incidentsText: `${stats.incidentSafe.toFixed(1)} incidents/hr`,
      checksText: `${stats.checksSafePassed}/${stats.checksTotal} checks`,
      tone: stats.decisionTone === 'ship' ? GOOD_COLOR : SAFE_COLOR,
      valueText: `${stats.retainedPct}% value retained`,
    })

    const pillY = storyRect.y + storyRect.height - 46
    const pillTone = stats.decisionTone === 'ship' ? GOOD_COLOR : '#995d30'
    const pillText = stats.decisionTone === 'ship' ? 'SHIP' : 'HOLD'

    this.drawRoundedRect(storyRect.x + 14, pillY, 72, 30, 15)
    this.ctx.fillStyle = withAlpha(pillTone, 0.12)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(pillTone, 0.34)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "700 11px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(pillTone, 0.95)
    this.ctx.fillText(pillText, storyRect.x + 30, pillY + 19)

    const dominantId = [...projection.activeSetIds].sort((a, b) => (projection.lambdaById[b] ?? 0) - (projection.lambdaById[a] ?? 0))[0]
    const lambda = dominantId ? projection.lambdaById[dominantId] ?? 0 : 0
    const pressureText = dominantId && lambda > 1e-6 ? `Main pressure: ${dominantId.toUpperCase()} (λ ${lambda.toFixed(2)})` : 'No active pressure. Raw patch is already feasible.'

    this.ctx.font = "600 11px 'Manrope'"
    this.ctx.fillStyle = withAlpha('#446282', 0.95)
    this.wrapText(pressureText, storyRect.x + 96, pillY + 12, storyRect.width - 110, 16, 2)
  }

  private resolveStageCopy(mode: SceneMode, rawBlocked: boolean, teachingMode: boolean, beats: TeachingBeats): {
    title: string
    body: string
    progress: number
  } {
    if (mode === 'forces') {
      return {
        title: 'Inspect correction forces',
        body: 'Each active guardrail adds one correction vector. Click a force bar to isolate that push-back.',
        progress: 0.76,
      }
    }

    if (!teachingMode) {
      return {
        title: rawBlocked ? 'Certified patch computed' : 'Raw patch already safe',
        body: rawBlocked
          ? 'Unsafe component is removed while preserving useful movement.'
          : 'SafePatch confirms this proposal can ship without correction.',
        progress: 1,
      }
    }

    if (beats.raw < 1) {
      return {
        title: 'Reading raw patch direction',
        body: 'The red vector is the proposed hotfix before policy checks.',
        progress: beats.raw * 0.26,
      }
    }

    if (rawBlocked && beats.hit < 1) {
      return {
        title: 'Policy violation detected',
        body: 'The proposal crosses the envelope, so raw rollout is blocked.',
        progress: 0.26 + beats.hit * 0.18,
      }
    }

    if (rawBlocked && beats.correction < 1) {
      return {
        title: 'Applying push-back',
        body: 'SafePatch removes only the unsafe component using active guardrail forces.',
        progress: 0.44 + beats.correction * 0.28,
      }
    }

    return {
      title: 'Certified patch ready',
      body: 'The blue vector is the closest safe rollout direction to the original intent.',
      progress: 0.72 + beats.safe * 0.28,
    }
  }

  private drawMetricRow(input: {
    x: number
    y: number
    width: number
    title: string
    incidentsText: string
    checksText: string
    tone: string
    valueText?: string
  }): void {
    const { x, y, width, title, incidentsText, checksText, tone, valueText } = input

    this.drawRoundedRect(x, y, width, 66, 12)
    this.ctx.fillStyle = withAlpha('#f9fbff', 0.98)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(tone, 0.26)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "600 9px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(tone, 0.92)
    this.ctx.fillText(title.toUpperCase(), x + 10, y + 15)

    this.ctx.font = "700 13px 'Manrope'"
    this.ctx.fillStyle = INK
    this.ctx.fillText(incidentsText, x + 10, y + 34)

    this.ctx.font = "600 11px 'Manrope'"
    this.ctx.fillStyle = MUTED
    this.ctx.fillText(checksText, x + 10, y + 52)

    if (valueText) {
      this.ctx.fillStyle = withAlpha('#2c5e9f', 0.96)
      this.ctx.textAlign = 'right'
      this.ctx.fillText(valueText, x + width - 10, y + 52)
      this.ctx.textAlign = 'left'
    }
  }

  private drawProgress(x: number, y: number, width: number, progress: number): void {
    this.drawRoundedRect(x, y, width, 6, 4)
    this.ctx.fillStyle = '#e5eef9'
    this.ctx.fill()

    this.drawRoundedRect(x, y, Math.max(10, width * clamp(progress)), 6, 4)
    this.ctx.fillStyle = withAlpha(SAFE_COLOR, 0.82)
    this.ctx.fill()
  }

  private drawGrid(rect: Rect): void {
    const columns = 6
    const rows = 5

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2)
    this.ctx.clip()

    this.ctx.strokeStyle = withAlpha('#dce8f8', 0.7)
    this.ctx.lineWidth = 1

    for (let c = 1; c < columns; c += 1) {
      const x = rect.x + (rect.width / columns) * c
      this.ctx.beginPath()
      this.ctx.moveTo(x, rect.y)
      this.ctx.lineTo(x, rect.y + rect.height)
      this.ctx.stroke()
    }

    for (let r = 1; r < rows; r += 1) {
      const y = rect.y + (rect.height / rows) * r
      this.ctx.beginPath()
      this.ctx.moveTo(rect.x, y)
      this.ctx.lineTo(rect.x + rect.width, y)
      this.ctx.stroke()
    }

    this.ctx.restore()
  }

  private drawOrigin(point: Vec2): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2)
    this.ctx.fillStyle = '#1b3f68'
    this.ctx.fill()

    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#4f6988', 0.94)
    this.ctx.fillText('Origin', point.x + 8, point.y - 8)
  }

  private drawMapLegend(mapRect: Rect): void {
    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#4a6384', 0.9)
    this.ctx.fillText('DRAG RED HANDLE TO PROPOSE PATCH', mapRect.x + 14, mapRect.y + mapRect.height - 14)
  }

  private drawArrow(from: Vec2, to: Vec2, color: string, width: number, dashed = false): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    if (distance < 1.2) {
      return
    }

    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = Math.min(11, Math.max(7, width * 3.4))

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
    this.ctx.arc(point.x, point.y, radius + 4, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.13)
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
    this.ctx.strokeStyle = withAlpha(color, 0.26)
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
        { x: -width * 0.5, y: -24 },
        { x: -width * 0.5, y: 16 },
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
