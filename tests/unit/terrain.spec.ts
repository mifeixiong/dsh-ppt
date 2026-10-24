import { describe, expect, it } from 'vitest'
import { chainSegments, contourSegments, simplifyPolyline, terrainLines } from '../../src/terrain.ts'

/**
 * The contour motif replaced a sine-ring drawing with a real noise field. These
 * tests pin the two properties that matter for a decoration: the same seed must
 * produce the same SVG (motif contract), and the point count must stay small
 * enough that the motif still ships inside a tool response.
 */

const CANVAS = { width: 760, height: 380 }

describe('terrain contours', () => {
  it('is deterministic and seed-sensitive', () => {
    const first = terrainLines(CANVAS)
    const second = terrainLines(CANVAS)
    expect(second).toEqual(first)
    expect(terrainLines({ ...CANVAS, seed: 1 })).not.toEqual(first)
  })

  it('keeps every point on the canvas and uses most iso levels', () => {
    const lines = terrainLines(CANVAS)
    expect(lines.length).toBeGreaterThan(10)
    expect(new Set(lines.map(line => line.level)).size).toBeGreaterThanOrEqual(6)
    for (const line of lines) {
      expect(line.points.length).toBeGreaterThanOrEqual(2)
      for (const point of line.points) {
        expect(point.x).toBeGreaterThanOrEqual(0)
        expect(point.x).toBeLessThanOrEqual(CANVAS.width)
        expect(point.y).toBeGreaterThanOrEqual(0)
        expect(point.y).toBeLessThanOrEqual(CANVAS.height)
      }
    }
  })

  it('stays inside the motif point and line budget', () => {
    const lines = terrainLines(CANVAS)
    const points = lines.reduce((total, line) => total + line.points.length, 0)
    expect(lines.length).toBeLessThanOrEqual(200)
    expect(points).toBeLessThan(2000)
  })

  it('stitches collinear segments into one polyline', () => {
    const segments = [
      { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
      { a: { x: 10, y: 0 }, b: { x: 20, y: 0 } },
      { a: { x: 30, y: 0 }, b: { x: 40, y: 0 } },
    ]
    const lines = chainSegments(segments)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }])
    expect(lines[0]!.length).toBeCloseTo(20, 6)
  })

  it('simplifies a staircase without moving the endpoints', () => {
    const points = [
      { x: 0, y: 0 }, { x: 1, y: 0.2 }, { x: 2, y: 0 }, { x: 3, y: 0.2 }, { x: 4, y: 0 },
    ]
    const simplified = simplifyPolyline(points, 0.5)
    expect(simplified).toHaveLength(2)
    expect(simplified[0]).toEqual({ x: 0, y: 0 })
    expect(simplified[1]).toEqual({ x: 4, y: 0 })
  })

  it('extracts one crossing per cell for a linear field', () => {
    // Three columns, three rows: the level 0.5 crossing sits at x = 5 in both
    // cell rows, so each row contributes one vertical segment.
    const field = new Float32Array([0, 1, 2, 0, 1, 2, 0, 1, 2])
    const segments = contourSegments(field, 3, 3, 20, 10, 0.5)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.a.x).toBeCloseTo(5, 6)
    expect(segments[0]!.a.y).toBeCloseTo(0, 6)
    expect(segments[0]!.b.y).toBeCloseTo(5, 6)
    expect(segments[1]!.a.y).toBeCloseTo(5, 6)
  })

  it('rejects a degenerate canvas or grid', () => {
    expect(() => terrainLines({ width: 0, height: 10 })).toThrow(/positive canvas/u)
    expect(() => terrainLines({ width: 10, height: 10, step: 0 })).toThrow(/step/u)
    expect(() => terrainLines({ width: 10, height: 10, levels: 0 })).toThrow(/level/u)
  })
})
