import { describe, expect, it } from 'vitest'
import { PptError } from '../../src/errors.ts'
import {
  applyMatrix,
  dashFromArray,
  pathBounds,
  pathListXml,
  parsePathData,
  parsePoints,
  parseTransform,
  polylineToSubPaths,
  transformSubPaths,
  type PathSegment,
  type Point,
  type SubPath,
} from '../../src/svg-geometry.ts'

function geometryError(run: () => unknown): PptError {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(PptError)
  if (!(caught instanceof PptError)) throw new Error('unreachable: expected a PptError')
  return caught
}

function firstSubPath(subpaths: readonly SubPath[]): SubPath {
  const subpath = subpaths[0]
  if (subpath === undefined) throw new Error('expected at least one subpath')
  return subpath
}

function segmentAt(subpath: SubPath | undefined, index: number): PathSegment {
  if (subpath === undefined) throw new Error('expected a subpath')
  const segment = subpath.segments[index]
  if (segment === undefined) throw new Error(`missing segment ${index}`)
  return segment
}

function cubicAt(subpath: SubPath | undefined, index: number): { c1: Point; c2: Point; to: Point } {
  const segment = segmentAt(subpath, index)
  if (segment.type !== 'cubic') throw new Error(`segment ${index} is ${segment.type}, expected cubic`)
  return segment
}

function lineAt(subpath: SubPath | undefined, index: number): Point {
  const segment = segmentAt(subpath, index)
  if (segment.type !== 'line') throw new Error(`segment ${index} is ${segment.type}, expected line`)
  return segment.to
}

function expectPoint(actual: Point, x: number, y: number, precision = 9): void {
  expect(actual.x).toBeCloseTo(x, precision)
  expect(actual.y).toBeCloseTo(y, precision)
}

function cubicCount(subpaths: readonly SubPath[]): number {
  return subpaths.reduce(
    (total, subpath) => total + subpath.segments.filter(segment => segment.type === 'cubic').length,
    0,
  )
}

/** Every `<a:pt>` pair emitted for one path list, in document order. */
function emittedPoints(xml: string): Point[] {
  return [...xml.matchAll(/<a:pt x="(-?\d+)" y="(-?\d+)"\/>/gu)].map(match => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }))
}

function pathSpace(xml: string): { w: number; h: number } {
  const match = /<a:path w="(\d+)" h="(\d+)"/u.exec(xml)
  if (match === null) throw new Error('path space missing from pathListXml output')
  return { w: Number(match[1]), h: Number(match[2]) }
}

describe('parseTransform', () => {
  it('composes left-to-right with the leftmost transform applied last', () => {
    const matrix = parseTransform('translate(10,20) scale(2)')
    expect(matrix).toEqual([2, 0, 0, 2, 10, 20])
    expectPoint(applyMatrix(matrix, { x: 1, y: 1 }), 12, 22)
  })

  it('product order fails if the operands are swapped', () => {
    const composed = parseTransform('translate(10,20) scale(2)')
    const reversed = parseTransform('scale(2) translate(10,20)')
    expect(reversed).toEqual([2, 0, 0, 2, 20, 40])
    expect(composed).not.toEqual(reversed)
  })

  it('handles matrix, single-argument forms, commas between functions and empty input', () => {
    expect(parseTransform('matrix(1,2,3,4,5,6)')).toEqual([1, 2, 3, 4, 5, 6])
    expect(parseTransform('translate(5)')).toEqual([1, 0, 0, 1, 5, 0])
    expect(parseTransform('scale(3)')).toEqual([3, 0, 0, 3, 0, 0])
    expect(parseTransform('translate(1,2),scale(2)')).toEqual([2, 0, 0, 2, 1, 2])
    expect(parseTransform('')).toEqual([1, 0, 0, 1, 0, 0])
    expect(parseTransform('   ')).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('rotates about the origin or about an explicit centre', () => {
    expectPoint(applyMatrix(parseTransform('rotate(90)'), { x: 1, y: 0 }), 0, 1, 12)
    expectPoint(applyMatrix(parseTransform('rotate(90, 10, 10)'), { x: 10, y: 10 }), 10, 10, 12)
    expectPoint(applyMatrix(parseTransform('rotate(180 5 5)'), { x: 0, y: 0 }), 10, 10, 12)
  })

  it('skews along one axis only', () => {
    expectPoint(applyMatrix(parseTransform('skewX(45)'), { x: 0, y: 1 }), 1, 1, 12)
    expectPoint(applyMatrix(parseTransform('skewY(45)'), { x: 1, y: 0 }), 1, 1, 12)
  })

  it('rejects unsupported or malformed transform syntax with the offending text', () => {
    const unsupported = geometryError(() => parseTransform('blur(2)'))
    expect(unsupported.code).toBe('SVG_GEOMETRY_INVALID')
    expect(unsupported.message).toContain('blur(2)')

    const wrongArity = geometryError(() => parseTransform('translate(1,2,3)'))
    expect(wrongArity.message).toContain('translate(1,2,3)')

    geometryError(() => parseTransform('translate(1e999)'))
    geometryError(() => parseTransform('translate(10-20)'))
  })
})

describe('parsePathData', () => {
  it('mixes relative and absolute commands, H/V and a closing segment', () => {
    const subpaths = parsePathData('M10 10 l5 5 H20 V30 c1 1 2 2 3 3 Z')
    expect(subpaths).toHaveLength(1)

    const subpath = firstSubPath(subpaths)
    expect(subpath.closed).toBe(true)
    expect(subpath.segments).toHaveLength(6)
    expectPoint(subpath.start, 10, 10)
    expectPoint(lineAt(subpath, 1), 15, 15)
    expectPoint(lineAt(subpath, 2), 20, 15)
    expectPoint(lineAt(subpath, 3), 20, 30)

    const cubic = cubicAt(subpath, 4)
    expectPoint(cubic.c1, 21, 31)
    expectPoint(cubic.c2, 22, 32)
    expectPoint(cubic.to, 23, 33)
    expect(segmentAt(subpath, 5).type).toBe('close')
  })

  it('repeats a command for extra coordinate groups and turns extra M pairs into lines', () => {
    const subpath = firstSubPath(parsePathData('M0 0 10 10 20 0'))
    expect(subpath.segments).toHaveLength(3)
    expectPoint(lineAt(subpath, 1), 10, 10)
    expectPoint(lineAt(subpath, 2), 20, 0)

    const relative = firstSubPath(parsePathData('m0 0 10 10'))
    expect(relative.segments).toHaveLength(2)
    expectPoint(lineAt(relative, 1), 10, 10)

    const repeatedRelativeLine = firstSubPath(parsePathData('M0 0 l1 1 2 2'))
    expect(repeatedRelativeLine.segments).toHaveLength(3)
    expectPoint(lineAt(repeatedRelativeLine, 1), 1, 1)
    expectPoint(lineAt(repeatedRelativeLine, 2), 3, 3)
  })

  it('splits a `Z` into separate subpaths and restarts the pen at the subpath start', () => {
    const subpaths = parsePathData('M0 0 L10 0 Z M20 20 L30 20 Z')
    expect(subpaths).toHaveLength(2)
    for (const subpath of subpaths) {
      expect(subpath.closed).toBe(true)
      expect(segmentAt(subpath, subpath.segments.length - 1).type).toBe('close')
    }
    expectPoint(firstSubPath(subpaths).start, 0, 0)
    expectPoint(firstSubPath(subpaths.slice(1)).start, 20, 20)
  })

  it('accepts compact arc flags such as `a5 5 0 0110 10`', () => {
    const subpath = firstSubPath(parsePathData('M0 0a5 5 0 0110 10'))
    expect(subpath.closed).toBe(false)
    expect(cubicCount([subpath])).toBe(2)
    const last = cubicAt(subpath, subpath.segments.length - 1)
    expectPoint(last.to, 10, 10, 6)
  })

  it('approximates a half circle with two cubics and a full circle with four', () => {
    const half = firstSubPath(parsePathData('M0 0 A10 10 0 0 1 20 0'))
    expect(cubicCount([half])).toBe(2)
    // Every on-curve endpoint of the arc stays on the circle centred at (10,0).
    for (const segment of half.segments) {
      if (segment.type !== 'cubic') continue
      const distance = Math.hypot(segment.to.x - 10, segment.to.y - 0)
      expect(distance).toBeCloseTo(10, 6)
    }
    expectPoint(cubicAt(half, half.segments.length - 1).to, 20, 0, 6)

    const full = firstSubPath(parsePathData('M0 0 A10 10 0 0 1 20 0 A10 10 0 0 1 0 0'))
    expect(cubicCount([full])).toBe(4)
    expectPoint(cubicAt(full, full.segments.length - 1).to, 0, 0, 6)
  })

  it('uses one cubic for a quarter turn and a line for degenerate radii', () => {
    const quarter = firstSubPath(parsePathData('M0 0 A10 10 0 0 1 10 10'))
    expect(cubicCount([quarter])).toBe(1)

    const degenerate = firstSubPath(parsePathData('M0 0 A0 5 0 0 1 10 0'))
    expect(segmentAt(degenerate, 1).type).toBe('line')
    expectPoint(lineAt(degenerate, 1), 10, 0)
  })

  it('reflects the S control point only after a cubic family command', () => {
    const afterCubic = firstSubPath(parsePathData('M0 0 C0 10 10 10 10 0 S20 -10 20 0'))
    const reflected = cubicAt(afterCubic, 2)
    expectPoint(reflected.c1, 10, -10)
    expectPoint(reflected.c2, 20, -10)
    expectPoint(reflected.to, 20, 0)

    const afterMove = firstSubPath(parsePathData('M0 0 S10 10 20 0'))
    const notReflected = cubicAt(afterMove, 1)
    expectPoint(notReflected.c1, 0, 0)
    expectPoint(notReflected.to, 20, 0)
  })

  it('reflects the T control point only after a quadratic family command', () => {
    const afterQuad = firstSubPath(parsePathData('M0 0 Q5 10 10 0 T20 0'))
    const quad = cubicAt(afterQuad, 1)
    expectPoint(quad.c1, 10 / 3, 20 / 3, 6)
    expectPoint(quad.c2, 20 / 3, 20 / 3, 6)
    expectPoint(quad.to, 10, 0)

    const smooth = cubicAt(afterQuad, 2)
    expectPoint(smooth.c1, 40 / 3, -20 / 3, 6)
    expectPoint(smooth.c2, 50 / 3, -20 / 3, 6)
    expectPoint(smooth.to, 20, 0)

    const afterMove = firstSubPath(parsePathData('M0 0 T10 0'))
    const notReflected = cubicAt(afterMove, 1)
    expectPoint(notReflected.c1, 0, 0)
    expectPoint(notReflected.c2, 10 / 3, 0, 6)
    expectPoint(notReflected.to, 10, 0)
  })

  it('elevates a quadratic onto the two-thirds control points', () => {
    const subpath = firstSubPath(parsePathData('M0 0 Q10 10 20 0'))
    const cubic = cubicAt(subpath, 1)
    expectPoint(cubic.c1, 20 / 3, 20 / 3, 6)
    expectPoint(cubic.c2, 40 / 3, 20 / 3, 6)
    expectPoint(cubic.to, 20, 0)
  })

  it('rejects empty data, missing moves, misplaced commas and a close that does not end', () => {
    expect(geometryError(() => parsePathData('')).code).toBe('SVG_GEOMETRY_INVALID')
    geometryError(() => parsePathData('   '))
    geometryError(() => parsePathData('L10 10'))
    geometryError(() => parsePathData('M,0 0'))
    geometryError(() => parsePathData('M0 0 L10 10,L20 20'))
    geometryError(() => parsePathData('M0 0 L10 0 Z L20 20'))
    geometryError(() => parsePathData('M0 0 L10 0 5'))
  })

  it('rejects bad arc flags, non-finite numbers and negative radii', () => {
    const badFlag = geometryError(() => parsePathData('M0 0 A5 5 0 2 1 10 10'))
    expect(badFlag.message).toContain('arc flag')
    geometryError(() => parsePathData('M0 0 A5 5 0 0 1 10 10 5'))
    geometryError(() => parsePathData('M0 0 L1e999 0'))
    expect(geometryError(() => parsePathData('M0 0 A-5 5 0 0 1 10 10')).message).toContain('radii')
  })
})

describe('points and polylines', () => {
  it('parses coordinate pairs separated by spaces or commas', () => {
    expect(parsePoints('0,0 10,0 10,10')).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
    expect(parsePoints(' 0 0\n 10 0 ')).toHaveLength(2)
    geometryError(() => parsePoints('0 0 10'))
    geometryError(() => parsePoints(''))
    geometryError(() => parsePoints(',0 0'))
  })

  it('builds one subpath from a point list, closed only when asked', () => {
    const points = parsePoints('0 0 10 0 10 10')
    const open = polylineToSubPaths(points, false)
    expect(open).toHaveLength(1)
    expect(firstSubPath(open).closed).toBe(false)
    expect(firstSubPath(open).segments).toHaveLength(3)
    expectPoint(lineAt(firstSubPath(open), 2), 10, 10)

    const closed = firstSubPath(polylineToSubPaths(points, true))
    expect(closed.closed).toBe(true)
    expect(segmentAt(closed, closed.segments.length - 1).type).toBe('close')
    expect(polylineToSubPaths([], false)).toEqual([])
  })
})

describe('transformSubPaths', () => {
  it('moves the start point, every line end and every cubic control point', () => {
    const transformed = transformSubPaths(parsePathData('M0 0 C1 1 2 2 3 3'), [2, 0, 0, 2, 1, 1])
    const subpath = firstSubPath(transformed)
    expect(subpath.start).toEqual({ x: 1, y: 1 })
    expect(segmentAt(subpath, 0)).toEqual({ type: 'move', to: { x: 1, y: 1 } })

    const cubic = cubicAt(subpath, 1)
    expect(cubic.c1).toEqual({ x: 3, y: 3 })
    expect(cubic.c2).toEqual({ x: 5, y: 5 })
    expect(cubic.to).toEqual({ x: 7, y: 7 })
    expect(subpath.closed).toBe(false)
  })

  it('keeps the closing flag and close segment through a rotation', () => {
    const transformed = transformSubPaths(parsePathData('M0 0 L10 0 Z'), [0, 1, -1, 0, 0, 0])
    const subpath = firstSubPath(transformed)
    expect(subpath.closed).toBe(true)
    expectPoint(lineAt(subpath, 1), 0, 10, 12)
  })
})

describe('pathBounds', () => {
  it('includes cubic control points that exceed the on-curve endpoints', () => {
    const box = pathBounds(parsePathData('M0 0 C0 100 100 100 100 0'))
    expect(box).toEqual({ x: 0, y: 0, w: 100, h: 100 })
  })

  it('keeps a zero extent when the geometry is flat, and is undefined when empty', () => {
    expect(pathBounds(parsePathData('M0 0 L10 0'))).toEqual({ x: 0, y: 0, w: 10, h: 0 })
    expect(pathBounds(parsePathData('M5 5 L5 5'))).toEqual({ x: 5, y: 5, w: 0, h: 0 })
    expect(pathBounds([])).toBeUndefined()
  })
})

describe('pathListXml', () => {
  it('emits an exact path list for a closed triangle', () => {
    const subpaths = parsePathData('M0 0 L10 0 L0 10 Z')
    const box = pathBounds(subpaths)
    if (box === undefined) throw new Error('expected a box')
    expect(box).toEqual({ x: 0, y: 0, w: 10, h: 10 })

    expect(pathListXml(subpaths, box, { fill: true })).toBe(
      '<a:pathLst><a:path w="95250" h="95250" fill="norm" stroke="1">'
      + '<a:moveTo><a:pt x="0" y="0"/></a:moveTo>'
      + '<a:lnTo><a:pt x="95250" y="0"/></a:lnTo>'
      + '<a:lnTo><a:pt x="0" y="95250"/></a:lnTo>'
      + '<a:close/>'
      + '</a:path></a:pathLst>',
    )
  })

  it('emits three control points per cubic inside the path space', () => {
    const subpaths = parsePathData('M0 0 C0 10 10 10 10 0')
    const box = pathBounds(subpaths)
    if (box === undefined) throw new Error('expected a box')
    const xml = pathListXml(subpaths, box, { fill: false })

    expect(xml).toBe(
      '<a:pathLst><a:path w="95250" h="95250" fill="none" stroke="1">'
      + '<a:moveTo><a:pt x="0" y="0"/></a:moveTo>'
      + '<a:cubicBezTo><a:pt x="0" y="95250"/><a:pt x="95250" y="95250"/><a:pt x="95250" y="0"/></a:cubicBezTo>'
      + '</a:path></a:pathLst>',
    )
    expect(pathSpace(xml)).toEqual({ w: 95250, h: 95250 })
    expect(emittedPoints(xml)).toHaveLength(4)
  })

  it('rounds EMU, translates by the box origin and honours the scale option', () => {
    const subpaths = parsePathData('M0 0 L0.5 0')
    const box = pathBounds(subpaths)
    if (box === undefined) throw new Error('expected a box')

    const scaledOnce = pathListXml(subpaths, box, { fill: false })
    // 0.5 px * 9525 EMU/px = 4762.5, rounded away from the fraction.
    expect(pathSpace(scaledOnce)).toEqual({ w: 4763, h: 0 })
    expect(emittedPoints(scaledOnce)[1]).toEqual({ x: 4763, y: 0 })

    const doubled = pathListXml(subpaths, box, { fill: false, scale: 2 })
    expect(pathSpace(doubled)).toEqual({ w: 9525, h: 0 })
    expect(emittedPoints(doubled)[1]).toEqual({ x: 9525, y: 0 })

    const offsetPath = parsePathData('M10 10 L11 10')
    const offset = pathListXml(offsetPath, { x: 10, y: 10, w: 1, h: 0 }, { fill: false })
    expect(emittedPoints(offset)).toEqual([{ x: 0, y: 0 }, { x: 9525, y: 0 }])
  })

  it('keeps every emitted point inside the declared path space', () => {
    const subpaths = parsePathData('M0.3 0.7 C0.31 0.72 0.69 0.72 0.7 0.7')
    const box = pathBounds(subpaths)
    if (box === undefined) throw new Error('expected a box')
    const xml = pathListXml(subpaths, box, { fill: true, scale: 1.7 })
    const space = pathSpace(xml)

    expect(space.w).toBe(6477)
    expect(space.h).toBe(324)
    for (const point of emittedPoints(xml)) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(space.w)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(space.h)
    }
  })

  it('starts every subpath with its own moveTo', () => {
    const subpaths = parsePathData('M0 0 L10 0 Z M20 20 L30 20 Z')
    const box = pathBounds(subpaths)
    if (box === undefined) throw new Error('expected a box')
    const xml = pathListXml(subpaths, box, { fill: true })
    expect([...xml.matchAll(/<a:moveTo>/gu)]).toHaveLength(2)
    expect([...xml.matchAll(/<a:close\/>/gu)]).toHaveLength(2)
  })
})

describe('dashFromArray', () => {
  it('maps named families to presets', () => {
    expect(dashFromArray('1 1', 1)).toEqual({ preset: 'sysDot' })
    expect(dashFromArray('2,2', 1)).toEqual({ preset: 'sysDot' })
    expect(dashFromArray('2', 1)).toEqual({ preset: 'sysDot' })
    expect(dashFromArray('4 4', 1)).toEqual({ preset: 'dash' })
    expect(dashFromArray('6,6', 1)).toEqual({ preset: 'dash' })
    expect(dashFromArray('8 8', 1)).toEqual({ preset: 'dash' })
    expect(dashFromArray('12 4', 1)).toEqual({ preset: 'lgDash' })
    expect(dashFromArray('16 8', 1)).toEqual({ preset: 'lgDash' })
    expect(dashFromArray('4 2 1 2', 1)).toEqual({ preset: 'dashDot' })
    expect(dashFromArray('8 2 1 2', 1)).toEqual({ preset: 'lgDashDot' })
  })

  it('treats none and all-zero patterns as a solid line', () => {
    expect(dashFromArray('none', 1)).toEqual({ preset: 'solid' })
    expect(dashFromArray('0 0', 1)).toEqual({ preset: 'solid' })
    expect(dashFromArray('0', 1)).toEqual({ preset: 'solid' })
  })

  it('falls back to a custom pair expressed in 1/1000 of a percent of the stroke width', () => {
    expect(dashFromArray('5 3', 1)).toEqual({ custom: { d: 500000, sp: 300000 } })
    expect(dashFromArray('10 5', 2)).toEqual({ custom: { d: 500000, sp: 250000 } })
    expect(dashFromArray('3,1', 3)).toEqual({ custom: { d: 100000, sp: 33333 } })
    expect(dashFromArray('0.5 0.25', 10)).toEqual({ custom: { d: 5000, sp: 2500 } })
  })

  it('returns undefined for absent or unparsable values', () => {
    expect(dashFromArray('', 1)).toBeUndefined()
    expect(dashFromArray('   ', 1)).toBeUndefined()
    expect(dashFromArray('junk', 1)).toBeUndefined()
    expect(dashFromArray('4px 2px', 1)).toBeUndefined()
    expect(dashFromArray('4 1e999', 1)).toBeUndefined()
  })
})
