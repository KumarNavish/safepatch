export interface Vec2 {
  x: number
  y: number
}

export interface Halfspace {
  id: string
  label: string
  normal: Vec2
  bound: number
  active: boolean
}

export interface Polygon {
  vertices: Vec2[]
  isEmpty: boolean
}

const FEASIBILITY_TOL = 1e-8

export function vec(x: number, y: number): Vec2 {
  return { x, y }
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s }
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
}

export function squaredNorm(a: Vec2): number {
  return dot(a, a)
}

export function norm(a: Vec2): number {
  return Math.sqrt(squaredNorm(a))
}

export function normalize(a: Vec2): Vec2 {
  const length = norm(a)
  if (length <= FEASIBILITY_TOL) {
    return { x: 0, y: 0 }
  }
  return { x: a.x / length, y: a.y / length }
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }
}

export function isStepFeasible(step: Vec2, halfspaces: Halfspace[], tol = FEASIBILITY_TOL): boolean {
  return halfspaces
    .filter((halfspace) => halfspace.active)
    .every((halfspace) => dot(halfspace.normal, step) <= halfspace.bound + tol)
}

export function maxConstraintViolation(step: Vec2, halfspaces: Halfspace[]): number {
  return halfspaces
    .filter((halfspace) => halfspace.active)
    .reduce((worst, halfspace) => {
      const violation = dot(halfspace.normal, step) - halfspace.bound
      return Math.max(worst, violation)
    }, -Infinity)
}

export function worldBoundsFromHalfspaces(halfspaces: Halfspace[]): number {
  const activeBounds = halfspaces.filter((halfspace) => halfspace.active).map((halfspace) => Math.abs(halfspace.bound))
  const maxBound = activeBounds.length > 0 ? Math.max(...activeBounds) : 1
  return Math.max(1.2, maxBound * 1.9)
}

function clipPolygonWithHalfspace(vertices: Vec2[], halfspace: Halfspace): Vec2[] {
  if (vertices.length === 0) {
    return []
  }

  const output: Vec2[] = []
  const n = halfspace.normal
  const b = halfspace.bound

  for (let i = 0; i < vertices.length; i += 1) {
    const current = vertices[i]
    const next = vertices[(i + 1) % vertices.length]

    const currentValue = dot(n, current) - b
    const nextValue = dot(n, next) - b

    const currentInside = currentValue <= FEASIBILITY_TOL
    const nextInside = nextValue <= FEASIBILITY_TOL

    if (currentInside && nextInside) {
      output.push(next)
      continue
    }

    if (currentInside && !nextInside) {
      const t = currentValue / (currentValue - nextValue)
      output.push(lerp(current, next, t))
      continue
    }

    if (!currentInside && nextInside) {
      const t = currentValue / (currentValue - nextValue)
      output.push(lerp(current, next, t))
      output.push(next)
    }
  }

  return output
}

export function intersectHalfspaces(halfspaces: Halfspace[], worldRadius: number): Polygon {
  let polygon: Vec2[] = [
    vec(-worldRadius, -worldRadius),
    vec(worldRadius, -worldRadius),
    vec(worldRadius, worldRadius),
    vec(-worldRadius, worldRadius),
  ]

  for (const halfspace of halfspaces) {
    if (!halfspace.active) {
      continue
    }
    polygon = clipPolygonWithHalfspace(polygon, halfspace)
    if (polygon.length === 0) {
      return { vertices: [], isEmpty: true }
    }
  }

  return {
    vertices: polygon,
    isEmpty: polygon.length < 3,
  }
}
