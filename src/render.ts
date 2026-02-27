import { dot, intersectHalfspaces, vec, worldBoundsFromHalfspaces } from './geometry'
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
  x: number
  y: number
  width: number
  height: number
  color: string
}

const RAW_COLOR = '#f05570'
const SAFE_COLOR = '#2c6cf5'
const WARN_COLOR = '#f4a037'
const SHIP_COLOR = '#119a7a'
const HOLD_COLOR = '#9a5e2f'

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max)
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

function placementCollision(a: LabelPlacement, b: LabelPlacement): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  )
}

function hitRatioOnRay(step0: Vec2, halfspaces: Halfspace[]): number {
  let ratio = 1

  for (const halfspace of halfspaces) {
    if (!halfspace.active) {
      continue
    }

    const projected = dot(halfspace.normal, step0)
    if (projected > halfspace.bound + 1e-7 && Math.abs(projected) > 1e-7) {
      ratio = Math.min(ratio, halfspace.bound / projected)
    }
  }

  return clamp(ratio, 0, 1)
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
    const margin = 8
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
    this.drawBackground(width, height)

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

    const narrow = frame.width < 980
    const flowWidth = narrow ? frame.width - 32 : Math.min(300, frame.width * 0.28)

    const geoRect: Rect = narrow
      ? {
          x: frame.x + 16,
          y: frame.y + 16,
          width: frame.width - 32,
          height: frame.height - 190,
        }
      : {
          x: frame.x + 16,
          y: frame.y + 16,
          width: frame.width - flowWidth - 30,
          height: frame.height - 32,
        }

    const flowRect: Rect = narrow
      ? {
          x: geoRect.x,
          y: geoRect.y + geoRect.height + 10,
          width: geoRect.width,
          height: frame.y + frame.height - (geoRect.y + geoRect.height + 10) - 16,
        }
      : {
          x: geoRect.x + geoRect.width + 14,
          y: geoRect.y,
          width: flowWidth,
          height: geoRect.height,
        }

    const activeHalfspaces = input.halfspaces.filter((halfspace) => halfspace.active)
    const worldRadius = worldBoundsFromHalfspaces(activeHalfspaces) * 1.2
    const mapper = this.createMapper(geoRect, worldRadius)

    this.mapper = mapper
    this.interactionRect = geoRect

    const beats = this.resolveTeachingBeats(input.teachingProgress)
    const teachingMode = input.teachingProgress < 0.999

    const rawBlocked = input.projection.diagnostics.some(
      (diagnostic) => diagnostic.active && diagnostic.violationStep0 > 1e-6,
    )

    const highlightedId = this.resolveHighlightedConstraintId(input)
    const stage = this.resolveStage(input.mode, rawBlocked, teachingMode, beats)

    this.drawGeometryScene({
      rect: geoRect,
      mapper,
      input,
      beats,
      stage,
      rawBlocked,
      highlightedId,
      teachingMode,
    })

    this.drawFlowScene({
      rect: flowRect,
      input,
      stage,
      beats,
      rawBlocked,
      teachingMode,
    })
  }

  private resolveTeachingBeats(progress: number): TeachingBeats {
    if (progress >= 1) {
      return { raw: 1, hit: 1, correction: 1, safe: 1 }
    }

    const t = clamp(progress)
    return {
      raw: easeOutCubic(phaseWindow(t, 0, 0.32)),
      hit: easeOutCubic(phaseWindow(t, 0.32, 0.48)),
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
      return { index: 0, progress: beats.raw * 0.28 }
    }

    if (rawBlocked && beats.hit < 1) {
      return { index: 1, progress: 0.28 + beats.hit * 0.2 }
    }

    if (rawBlocked && beats.correction < 1) {
      return { index: 2, progress: 0.48 + beats.correction * 0.3 }
    }

    return { index: 3, progress: 0.78 + beats.safe * 0.22 }
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

  private createMapper(rect: Rect, worldRadius: number): Mapper {
    const pad = 46
    const usableWidth = Math.max(20, rect.width - pad * 2)
    const usableHeight = Math.max(20, rect.height - pad * 2)
    const scale = Math.min(usableWidth / (worldRadius * 2), usableHeight / (worldRadius * 2))
    const center = vec(rect.x + rect.width * 0.5, rect.y + rect.height * 0.53)

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

    const glow = this.ctx.createRadialGradient(width * 0.15, 0, 16, width * 0.15, 0, width * 0.78)
    glow.addColorStop(0, 'rgba(44, 108, 245, 0.12)')
    glow.addColorStop(1, 'rgba(44, 108, 245, 0)')
    this.ctx.fillStyle = glow
    this.ctx.fillRect(0, 0, width, height)
  }

  private drawGeometryScene(params: {
    rect: Rect
    mapper: Mapper
    input: SceneRenderInput
    beats: TeachingBeats
    stage: StageState
    rawBlocked: boolean
    highlightedId: string | null
    teachingMode: boolean
  }): void {
    const { rect, mapper, input, beats, stage, rawBlocked, highlightedId, teachingMode } = params

    this.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 14)
    this.ctx.fillStyle = '#fbfdff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d9e6f5', 0.96)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.drawGrid(rect)

    const zone = intersectHalfspaces(input.halfspaces.filter((halfspace) => halfspace.active), mapper.worldRadius)
    if (!zone.isEmpty) {
      this.ctx.beginPath()
      zone.vertices.forEach((vertex, index) => {
        const p = mapper.worldToCanvas(vertex)
        if (index === 0) {
          this.ctx.moveTo(p.x, p.y)
        } else {
          this.ctx.lineTo(p.x, p.y)
        }
      })
      this.ctx.closePath()
      this.ctx.fillStyle = withAlpha(SAFE_COLOR, 0.08)
      this.ctx.fill()
      this.ctx.strokeStyle = withAlpha(SAFE_COLOR, 0.25)
      this.ctx.lineWidth = 1.4
      this.ctx.stroke()
    }

    for (const halfspace of input.halfspaces) {
      if (!halfspace.active) {
        continue
      }

      const seg = this.constraintSegment(halfspace, mapper.worldRadius)
      if (!seg) {
        continue
      }

      const a = mapper.worldToCanvas(seg[0])
      const b = mapper.worldToCanvas(seg[1])
      const highlighted = halfspace.id === highlightedId

      this.ctx.beginPath()
      this.ctx.moveTo(a.x, a.y)
      this.ctx.lineTo(b.x, b.y)
      this.ctx.strokeStyle = withAlpha(highlighted ? this.colorForConstraint(halfspace.id) : '#98afcb', highlighted ? 0.86 : 0.35)
      this.ctx.lineWidth = highlighted ? 2.2 : 1.1
      this.ctx.stroke()
    }

    const origin = mapper.worldToCanvas(vec(0, 0))
    const rawTip = mapper.worldToCanvas(input.projection.step0)
    const safeTip = mapper.worldToCanvas(input.projection.projectedStep)
    this.rawHandleCanvas = rawTip

    const hitRatio = hitRatioOnRay(input.projection.step0, input.halfspaces)
    const hitWorld = {
      x: input.projection.step0.x * hitRatio,
      y: input.projection.step0.y * hitRatio,
    }
    const hitCanvas = mapper.worldToCanvas(hitWorld)

    const rawProgress = teachingMode ? beats.raw : 1
    const rawDrawTip = rawBlocked ? vecLerp(origin, hitCanvas, rawProgress) : vecLerp(origin, rawTip, rawProgress)

    this.drawArrow(origin, rawDrawTip, RAW_COLOR, 3)
    this.drawToken(rawDrawTip, RAW_COLOR, 5.5)

    if (rawProgress > 0.88) {
      this.drawHandle(rawTip, RAW_COLOR, 7)
    }

    if (rawBlocked) {
      const pulse = teachingMode ? beats.hit : 1
      if (pulse > 0.02) {
        this.drawPulse(hitCanvas, WARN_COLOR, 12 + pulse * 20)
      }

      const correctionProgress = teachingMode ? beats.correction : 1
      if (correctionProgress > 0.03) {
        const correctionTip = vecLerp(hitCanvas, safeTip, correctionProgress)
        this.drawArrow(hitCanvas, correctionTip, WARN_COLOR, 2.2, true)
        this.drawToken(correctionTip, WARN_COLOR, 4.7)
      }
    }

    const safeProgress = input.mode === 'forces' ? 1 : teachingMode ? (rawBlocked ? beats.safe : beats.raw) : 1
    const safeDrawTip = vecLerp(origin, safeTip, easeOutBack(safeProgress))

    this.drawArrow(origin, safeDrawTip, SAFE_COLOR, 3)
    this.drawToken(safeDrawTip, SAFE_COLOR, 5)

    if (safeProgress > 0.86) {
      this.drawHandle(safeTip, SAFE_COLOR, 6.2)
    }

    if (input.mode === 'forces') {
      this.drawForceVectors(mapper, input.projection, input.visibleCorrectionIds)
    }

    this.drawOrigin(origin)

    this.drawStatusPill({
      rect,
      blocked: rawBlocked,
      decisionTone: input.stats.decisionTone,
      dragActive: input.dragActive,
    })

    this.drawTimeline(rect, stage)

    const labels: LabelSpec[] = [
      { text: 'Raw', anchor: rawTip, color: RAW_COLOR },
      { text: 'Safe', anchor: safeTip, color: SAFE_COLOR },
    ]
    this.drawLabels(labels, rect)
  }

  private drawFlowScene(params: {
    rect: Rect
    input: SceneRenderInput
    stage: StageState
    beats: TeachingBeats
    rawBlocked: boolean
    teachingMode: boolean
  }): void {
    const { rect, input, stage, beats, rawBlocked, teachingMode } = params

    this.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 14)
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d8e6f5', 0.95)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#4f698a', 0.9)
    this.ctx.fillText('RELEASE PIPELINE', rect.x + 14, rect.y + 18)

    const nodeX = rect.x + rect.width * 0.5
    const y0 = rect.y + 56
    const y1 = rect.y + rect.height * 0.46
    const y2 = rect.y + rect.height - 72

    this.drawNode(vec(nodeX, y0), 'Proposal', RAW_COLOR)
    this.drawNode(vec(nodeX, y1), 'Policy', rawBlocked ? WARN_COLOR : SHIP_COLOR)
    this.drawNode(vec(nodeX, y2), input.stats.decisionTone === 'ship' ? 'Deploy' : 'Hold', input.stats.decisionTone === 'ship' ? SHIP_COLOR : HOLD_COLOR)

    this.drawPipelineConnector(vec(nodeX, y0 + 16), vec(nodeX, y1 - 16), stage.index >= 1 || !teachingMode)
    this.drawPipelineConnector(vec(nodeX, y1 + 16), vec(nodeX, y2 - 16), stage.index >= 3 || !teachingMode)

    const tokenStart = vec(nodeX, y0)
    const tokenMid = vec(nodeX, y1)
    const tokenEnd = vec(nodeX, y2)

    if (rawBlocked) {
      const toPolicy = teachingMode ? clamp(beats.raw + beats.hit * 0.6) : 1
      const policyToken = vecLerp(tokenStart, tokenMid, toPolicy)
      this.drawToken(policyToken, RAW_COLOR, 4.5)

      const toDecision = teachingMode ? beats.safe : 1
      if (toDecision > 0.02) {
        const outToken = vecLerp(tokenMid, tokenEnd, toDecision)
        this.drawToken(outToken, input.stats.decisionTone === 'ship' ? SAFE_COLOR : WARN_COLOR, 4.8)
      }
    } else {
      const direct = teachingMode ? clamp(beats.raw * 0.45 + beats.safe * 0.55) : 1
      const token = vecLerp(tokenStart, tokenEnd, direct)
      this.drawToken(token, SAFE_COLOR, 4.8)
    }

    const incidentMax = Math.max(input.stats.incidentRaw, input.stats.incidentSafe, 1)
    const rawRatio = clamp(input.stats.incidentRaw / incidentMax)
    const safeRatio = clamp(input.stats.incidentSafe / incidentMax)

    const barsY = rect.y + rect.height - 138
    this.drawMiniBar(rect.x + 14, barsY, rect.width - 28, rawRatio, RAW_COLOR, `Raw ${input.stats.incidentRaw.toFixed(1)}/hr`)
    this.drawMiniBar(rect.x + 14, barsY + 26, rect.width - 28, safeRatio, SAFE_COLOR, `Safe ${input.stats.incidentSafe.toFixed(1)}/hr`)

    const chipY = rect.y + rect.height - 44
    this.drawRoundedRect(rect.x + 14, chipY, rect.width - 28, 28, 12)
    this.ctx.fillStyle = withAlpha(input.stats.decisionTone === 'ship' ? SHIP_COLOR : HOLD_COLOR, 0.12)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(input.stats.decisionTone === 'ship' ? SHIP_COLOR : HOLD_COLOR, 0.35)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "700 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(input.stats.decisionTone === 'ship' ? SHIP_COLOR : HOLD_COLOR, 0.96)
    this.ctx.fillText(
      `${input.stats.decisionTone === 'ship' ? 'SHIP' : 'HOLD'}  |  ${input.stats.retainedPct}% value kept`,
      rect.x + 24,
      chipY + 18,
    )
  }

  private drawForceVectors(mapper: Mapper, projection: ProjectionResult, visibleIds: string[]): void {
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

      const selected = visible.size === 0 || visible.has(id)
      this.drawArrow(
        mapper.worldToCanvas(cursor),
        mapper.worldToCanvas(next),
        withAlpha(this.colorForConstraint(id), selected ? 0.9 : 0.32),
        selected ? 2.3 : 1.6,
        true,
      )

      cursor = next
    }
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
    const w = 170
    const h = 30

    this.drawRoundedRect(x, y, w, h, 15)
    const tone = dragActive ? SAFE_COLOR : blocked ? WARN_COLOR : decisionTone === 'ship' ? SHIP_COLOR : HOLD_COLOR
    this.ctx.fillStyle = withAlpha(tone, 0.11)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(tone, 0.35)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha(tone, 0.96)

    let text = 'RAW PATCH UNDER REVIEW'
    if (dragActive) {
      text = 'LIVE CERTIFICATION'
    } else if (blocked) {
      text = 'RAW PATCH BLOCKED'
    } else if (decisionTone === 'ship') {
      text = 'RAW PATCH SAFE'
    }

    this.ctx.fillText(text, x + 16, y + 19)
  }

  private drawTimeline(rect: Rect, stage: StageState): void {
    const width = Math.min(260, rect.width - 24)
    const x = rect.x + rect.width - width - 12
    const y = rect.y + 12

    this.drawRoundedRect(x, y, width, 30, 15)
    this.ctx.fillStyle = withAlpha('#ffffff', 0.92)
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha('#d5e4f4', 0.92)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const railX0 = x + 18
    const railX1 = x + width - 18
    const railY = y + 15

    this.ctx.beginPath()
    this.ctx.moveTo(railX0, railY)
    this.ctx.lineTo(railX1, railY)
    this.ctx.strokeStyle = '#e0ebf9'
    this.ctx.lineWidth = 4
    this.ctx.lineCap = 'round'
    this.ctx.stroke()

    const fillX = numberLerp(railX0, railX1, stage.progress)
    this.ctx.beginPath()
    this.ctx.moveTo(railX0, railY)
    this.ctx.lineTo(fillX, railY)
    this.ctx.strokeStyle = withAlpha(SAFE_COLOR, 0.88)
    this.ctx.lineWidth = 4
    this.ctx.lineCap = 'round'
    this.ctx.stroke()

    for (let i = 0; i < 4; i += 1) {
      const t = i / 3
      const cx = numberLerp(railX0, railX1, t)

      this.ctx.beginPath()
      this.ctx.arc(cx, railY, i === stage.index ? 5.4 : 4, 0, Math.PI * 2)
      this.ctx.fillStyle = i <= stage.index ? withAlpha(SAFE_COLOR, 0.95) : '#edf4ff'
      this.ctx.fill()
    }
  }

  private drawGrid(rect: Rect): void {
    const cols = 6
    const rows = 6

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2)
    this.ctx.clip()

    this.ctx.strokeStyle = withAlpha('#dbe7f6', 0.7)
    this.ctx.lineWidth = 1

    for (let c = 1; c < cols; c += 1) {
      const x = rect.x + (rect.width / cols) * c
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

  private drawNode(point: Vec2, label: string, color: string): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, 12, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.14)
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, 6.2, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.96)
    this.ctx.fill()

    this.ctx.font = "600 10px 'IBM Plex Mono'"
    this.ctx.fillStyle = withAlpha('#4f6b8c', 0.96)
    this.ctx.textAlign = 'center'
    this.ctx.fillText(label, point.x, point.y + 24)
    this.ctx.textAlign = 'left'
  }

  private drawPipelineConnector(from: Vec2, to: Vec2, active: boolean): void {
    this.ctx.beginPath()
    this.ctx.moveTo(from.x, from.y)
    this.ctx.lineTo(to.x, to.y)
    this.ctx.strokeStyle = active ? withAlpha(SAFE_COLOR, 0.65) : '#dfeaf9'
    this.ctx.lineWidth = 3
    this.ctx.lineCap = 'round'
    this.ctx.stroke()
  }

  private drawMiniBar(x: number, y: number, width: number, ratio: number, color: string, text: string): void {
    this.drawRoundedRect(x, y, width, 18, 9)
    this.ctx.fillStyle = '#f5f9ff'
    this.ctx.fill()
    this.ctx.strokeStyle = withAlpha(color, 0.24)
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    this.drawRoundedRect(x + 2, y + 2, Math.max(10, (width - 4) * ratio), 14, 7)
    this.ctx.fillStyle = withAlpha(color, 0.84)
    this.ctx.fill()

    this.ctx.font = "600 9px 'IBM Plex Mono'"
    this.ctx.fillStyle = '#224f90'
    this.ctx.fillText(text, x + 8, y + 12)
  }

  private drawArrow(from: Vec2, to: Vec2, color: string, width: number, dashed = false): void {
    const dist = Math.hypot(to.x - from.x, to.y - from.y)
    if (dist < 1.2) {
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
    this.ctx.arc(point.x, point.y, radius + 4, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.14)
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    this.ctx.fillStyle = color
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius - 2.2, 0, Math.PI * 2)
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fill()

    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius - 3.8, 0, Math.PI * 2)
    this.ctx.fillStyle = color
    this.ctx.fill()
  }

  private drawToken(point: Vec2, color: string, radius: number): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, radius + 3.4, 0, Math.PI * 2)
    this.ctx.fillStyle = withAlpha(color, 0.16)
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

  private drawOrigin(point: Vec2): void {
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, 4.6, 0, Math.PI * 2)
    this.ctx.fillStyle = '#19406a'
    this.ctx.fill()
  }

  private drawLabels(labels: LabelSpec[], bounds: Rect): void {
    const placements: LabelPlacement[] = []

    for (const label of labels) {
      const width = Math.ceil(this.ctx.measureText(label.text).width) + 14
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
          x,
          y,
          width,
          height,
          color: label.color,
        }

        const overlaps = placements.some((existing) => placementCollision(existing, placement))
        if (!overlaps) {
          chosen = placement
          break
        }
      }

      if (!chosen) {
        chosen = {
          text: label.text,
          x: clamp(label.anchor.x + 10, bounds.x + 8, bounds.x + bounds.width - width - 8),
          y: clamp(label.anchor.y - 12, bounds.y + 8, bounds.y + bounds.height - height - 8),
          width,
          height,
          color: label.color,
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
      this.ctx.fillStyle = withAlpha(placement.color, 0.94)
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
      const exists = unique.some((entry) => Math.hypot(entry.x - point.x, entry.y - point.y) < 1e-5)
      if (!exists) {
        unique.push(point)
      }
    }

    if (unique.length < 2) {
      return null
    }

    let best: [Vec2, Vec2] = [unique[0], unique[1]]
    let maxDistance = 0

    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const distance = Math.hypot(unique[i].x - unique[j].x, unique[i].y - unique[j].y)
        if (distance > maxDistance) {
          maxDistance = distance
          best = [unique[i], unique[j]]
        }
      }
    }

    return best
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
