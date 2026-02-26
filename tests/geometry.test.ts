import { describe, expect, test } from 'vitest'
import { add, vec } from '../src/geometry'
import type { Halfspace } from '../src/geometry'
import { computeProjectedStep, correctionConsistencyError } from '../src/qp'

function halfspace(id: string, nx: number, ny: number, bound: number): Halfspace {
  return {
    id,
    label: id,
    normal: vec(nx, ny),
    bound,
    active: true,
  }
}

describe('computeProjectedStep', () => {
  test('returns unconstrained step when already feasible', () => {
    const constraints = [
      halfspace('h1', 1, 0, 1),
      halfspace('h2', -1, 0, 1),
      halfspace('h3', 0, 1, 1),
      halfspace('h4', 0, -1, 1),
    ]

    const result = computeProjectedStep({
      gradient: vec(0.2, 0.1),
      eta: 1,
      halfspaces: constraints,
    })

    expect(result.ship).toBe(true)
    expect(result.projectedStep.x).toBeCloseTo(-0.2, 8)
    expect(result.projectedStep.y).toBeCloseTo(-0.1, 8)
    expect(result.activeSetIds).toHaveLength(0)
    expect(result.maxViolationProjected).toBeLessThanOrEqual(1e-9)
    expect(result.stationarityResidual).toBeLessThanOrEqual(1e-9)
    expect(correctionConsistencyError(result)).toBeLessThanOrEqual(1e-9)
  })

  test('projects to a single violated halfspace boundary', () => {
    const constraints = [halfspace('h1', 1, 0, 0.5)]

    const result = computeProjectedStep({
      gradient: vec(-1, 0),
      eta: 1,
      halfspaces: constraints,
    })

    expect(result.ship).toBe(true)
    expect(result.projectedStep.x).toBeCloseTo(0.5, 8)
    expect(result.projectedStep.y).toBeCloseTo(0, 8)
    expect(result.lambdaById.h1).toBeCloseTo(0.5, 7)
    expect(result.activeSetIds).toEqual(['h1'])
    expect(result.stationarityResidual).toBeLessThan(1e-7)
  })

  test('projects onto intersection of two active constraints and dual correction reconstructs step', () => {
    const constraints = [halfspace('h1', 1, 0, 0.4), halfspace('h2', 0, 1, 0.3)]

    const result = computeProjectedStep({
      gradient: vec(-1, -1),
      eta: 1,
      halfspaces: constraints,
    })

    expect(result.ship).toBe(true)
    expect(result.projectedStep.x).toBeCloseTo(0.4, 8)
    expect(result.projectedStep.y).toBeCloseTo(0.3, 8)
    expect(result.lambdaById.h1).toBeCloseTo(0.6, 7)
    expect(result.lambdaById.h2).toBeCloseTo(0.7, 7)

    const correctionSum = add(result.correctionById.h1, result.correctionById.h2)
    expect(result.step0.x + correctionSum.x).toBeCloseTo(result.projectedStep.x, 7)
    expect(result.step0.y + correctionSum.y).toBeCloseTo(result.projectedStep.y, 7)
    expect(correctionConsistencyError(result)).toBeLessThan(1e-7)
  })

  test('returns HOLD when guardrail intersection is empty', () => {
    const constraints = [halfspace('h1', 1, 0, -0.2), halfspace('h2', -1, 0, -0.2)]

    const result = computeProjectedStep({
      gradient: vec(-1, 0),
      eta: 0.7,
      halfspaces: constraints,
    })

    expect(result.ship).toBe(false)
    expect(result.reason?.toLowerCase()).toContain('empty')
    expect(result.maxViolationProjected).toBeGreaterThan(0)
  })
})
