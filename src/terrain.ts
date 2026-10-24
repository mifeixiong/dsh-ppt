/**
 * Deterministic terrain for the contour motif.
 *
 * The motif needs a field that has peaks, saddles and islands — a few sine
 * rings around one centre read as a fingerprint, not a map. This module samples
 * fractal Perlin noise (fixed seed, so the same SVG on every call) and extracts
 * iso-lines with marching squares, then stitches the segments into long
 * polylines and simplifies them. Everything is pure arithmetic: no random
 * state, no canvas, no files, and the result is small enough to ship inside a
 * tool response.
 */

export interface TerrainPoint {
  x: number
  y: number
}

export interface TerrainLine {
  /** Zero-based iso level index; the caller decides which levels to accent. */
  level: number
  points: TerrainPoint[]
  /** Polyline length in canvas px, used to drop specks and to budget the output. */
  length: number
}

export interface TerrainOptions {
  width: number
  height: number
  /** Grid spacing in px; smaller finds finer detail and multiplies the point count. */
  step?: number
  /** Noise wavelength in px per axis; larger values make broader landforms. */
  scaleX?: number
  scaleY?: number
  octaves?: number
  levels?: number
  /** Douglas–Peucker tolerance in px. */
  epsilon?: number
  /** Lines shorter than this (px) are dropped as noise specks. */
  minLength?: number
  /** Hard cap; beyond this the shortest lines are dropped, deterministically. */
  maxLines?: number
  seed?: number
}

/** Fixed seed: the motif contract is "same recipe, same SVG". */
export const TERRAIN_SEED = 0x707074

const DEFAULTS = {
  step: 6,
  scaleX: 52,
  scaleY: 48,
  octaves: 3,
  levels: 10,
  epsilon: 1.2,
  minLength: 14,
  maxLines: 200,
} as const

/* ------------------------------------------------------------------ noise */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function permutation(seed: number): Uint8Array {
  const random = mulberry32(seed)
  const order = [...Array(256).keys()]
  for (let index = 255; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const held = order[index]!
    order[index] = order[swap]!
    order[swap] = held
  }
  const table = new Uint8Array(512)
  for (let index = 0; index < 512; index += 1) table[index] = order[index & 255]!
  return table
}

const fade = (value: number): number => value * value * value * (value * (value * 6 - 15) + 10)
const lerp = (from: number, to: number, ratio: number): number => from + (to - from) * ratio

function gradient(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0: return x + y
    case 1: return -x + y
    case 2: return x - y
    case 3: return -x - y
    case 4: return x
    case 5: return -x
    case 6: return y
    default: return -y
  }
}

/** Improved Perlin noise, range roughly −1..1. */
export function perlin2(table: Uint8Array, x: number, y: number): number {
  const cellX = Math.floor(x) & 255
  const cellY = Math.floor(y) & 255
  const localX = x - Math.floor(x)
  const localY = y - Math.floor(y)
  const smoothX = fade(localX)
  const smoothY = fade(localY)
  const topLeft = table[table[cellX]! + cellY]!
  const topRight = table[table[cellX + 1]! + cellY]!
  const bottomLeft = table[table[cellX]! + cellY + 1]!
  const bottomRight = table[table[cellX + 1]! + cellY + 1]!
  const upper = lerp(
    gradient(topLeft, localX, localY),
    gradient(topRight, localX - 1, localY),
    smoothX,
  )
  const lower = lerp(
    gradient(bottomLeft, localX, localY - 1),
    gradient(bottomRight, localX - 1, localY - 1),
    smoothX,
  )
  return lerp(upper, lower, smoothY)
}

/** Fractal Brownian motion: three octaves is enough terrain without gridding. */
export function fbm(table: Uint8Array, x: number, y: number, octaves: number): number {
  let amplitude = 1
  let frequency = 1
  let sum = 0
  let norm = 0
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += amplitude * perlin2(table, x * frequency, y * frequency)
    norm += amplitude
    amplitude *= 0.5
    frequency *= 2
  }
  return sum / norm
}

/* ------------------------------------------------------- marching squares */

interface Segment {
  a: TerrainPoint
  b: TerrainPoint
}

/**
 * One iso-level through the sampled grid. Cases 5 and 10 are the ambiguous
 * saddles: the cell average decides which pair of corners is connected, which
 * keeps neighbouring cells consistent instead of leaving crossing segments.
 */
export function contourSegments(
  field: Float32Array,
  columns: number,
  rows: number,
  width: number,
  height: number,
  level: number,
): Segment[] {
  const segments: Segment[] = []
  const cellX = width / (columns - 1)
  const cellY = height / (rows - 1)
  const at = (column: number, row: number): number => field[row * columns + column]!
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const topLeft = at(column, row)
      const topRight = at(column + 1, row)
      const bottomRight = at(column + 1, row + 1)
      const bottomLeft = at(column, row + 1)
      const index = (topLeft > level ? 8 : 0) | (topRight > level ? 4 : 0)
        | (bottomRight > level ? 2 : 0) | (bottomLeft > level ? 1 : 0)
      if (index === 0 || index === 15) continue
      const originX = column * cellX
      const originY = row * cellY
      const top = (): TerrainPoint => ({ x: originX + cellX * (level - topLeft) / (topRight - topLeft), y: originY })
      const right = (): TerrainPoint => ({ x: originX + cellX, y: originY + cellY * (level - topRight) / (bottomRight - topRight) })
      const bottom = (): TerrainPoint => ({ x: originX + cellX * (level - bottomLeft) / (bottomRight - bottomLeft), y: originY + cellY })
      const left = (): TerrainPoint => ({ x: originX, y: originY + cellY * (level - topLeft) / (bottomLeft - topLeft) })
      const push = (a: TerrainPoint, b: TerrainPoint): void => { segments.push({ a, b }) }
      switch (index) {
        case 1: push(left(), bottom()); break
        case 2: push(bottom(), right()); break
        case 3: push(left(), right()); break
        case 4: push(top(), right()); break
        case 5: {
          if ((topLeft + topRight + bottomRight + bottomLeft) / 4 > level) { push(left(), top()); push(bottom(), right()) }
          else { push(left(), bottom()); push(top(), right()) }
          break
        }
        case 6: push(top(), bottom()); break
        case 7: push(left(), top()); break
        case 8: push(left(), top()); break
        case 9: push(top(), bottom()); break
        case 10: {
          if ((topLeft + topRight + bottomRight + bottomLeft) / 4 > level) { push(left(), bottom()); push(top(), right()) }
          else { push(left(), top()); push(bottom(), right()) }
          break
        }
        case 11: push(top(), right()); break
        case 12: push(left(), right()); break
        case 13: push(bottom(), right()); break
        case 14: push(left(), bottom()); break
        default: break
      }
    }
  }
  return segments
}

/* ------------------------------------------------------------ polylines */

/** Two segments meet when their endpoints quantise to the same half pixel. */
function endpointKey(point: TerrainPoint): string {
  return `${Math.round(point.x * 2)},${Math.round(point.y * 2)}`
}

/**
 * Stitch segments into polylines. Without this every cell edge becomes its own
 * `M…L…` pair and the SVG grows by an order of magnitude; a stitched line also
 * draws as one continuous hairline in PowerPoint.
 */
export function chainSegments(segments: readonly Segment[]): Array<{ points: TerrainPoint[]; length: number }> {
  const byEndpoint = new Map<string, Segment[]>()
  for (const segment of segments) {
    for (const end of ['a', 'b'] as const) {
      const key = endpointKey(segment[end])
      const bucket = byEndpoint.get(key)
      if (bucket === undefined) byEndpoint.set(key, [segment])
      else bucket.push(segment)
    }
  }
  const used = new Set<Segment>()
  const lines: Array<{ points: TerrainPoint[]; length: number }> = []
  for (const first of segments) {
    if (used.has(first)) continue
    used.add(first)
    const points = [first.a, first.b]
    let length = Math.hypot(first.b.x - first.a.x, first.b.y - first.a.y)
    for (const direction of ['forward', 'backward'] as const) {
      for (;;) {
        const end = direction === 'forward' ? points[points.length - 1]! : points[0]!
        const next = (byEndpoint.get(endpointKey(end)) ?? []).find(candidate => !used.has(candidate))
        if (next === undefined) break
        used.add(next)
        const other = endpointKey(next.a) === endpointKey(end) ? next.b : next.a
        length += Math.hypot(other.x - end.x, other.y - end.y)
        if (direction === 'forward') points.push(other)
        else points.unshift(other)
      }
    }
    lines.push({ points, length })
  }
  return lines
}

/** Douglas–Peucker; keeps the shape and drops the per-cell staircase points. */
export function simplifyPolyline(points: readonly TerrainPoint[], epsilon: number): TerrainPoint[] {
  if (points.length <= 2) return [...points]
  const squaredDistance = (left: TerrainPoint, right: TerrainPoint): number => (left.x - right.x) ** 2 + (left.y - right.y) ** 2
  const squaredSegmentDistance = (point: TerrainPoint, start: TerrainPoint, end: TerrainPoint): number => {
    let x = start.x
    let y = start.y
    const dx = end.x - x
    const dy = end.y - y
    if (dx !== 0 || dy !== 0) {
      const ratio = ((point.x - x) * dx + (point.y - y) * dy) / (dx * dx + dy * dy)
      if (ratio > 1) { x = end.x; y = end.y }
      else if (ratio > 0) { x += dx * ratio; y += dy * ratio }
    }
    return squaredDistance(point, { x, y })
  }
  const reduce = (slice: readonly TerrainPoint[]): TerrainPoint[] => {
    let worst = 0
    let pivot = 0
    for (let index = 1; index < slice.length - 1; index += 1) {
      const distance = squaredSegmentDistance(slice[index]!, slice[0]!, slice[slice.length - 1]!)
      if (distance > worst) { worst = distance; pivot = index }
    }
    if (worst <= epsilon * epsilon) return [slice[0]!, slice[slice.length - 1]!]
    const head = reduce(slice.slice(0, pivot + 1))
    const tail = reduce(slice.slice(pivot))
    return head.slice(0, -1).concat(tail)
  }
  return reduce(points)
}

/* --------------------------------------------------------------- terrain */

/**
 * Sample the field, extract every level, stitch and simplify. Lines are ordered
 * by level so the caller can style index contours; within a level the order is
 * the deterministic scan order.
 */
export function terrainLines(options: TerrainOptions): TerrainLine[] {
  const step = options.step ?? DEFAULTS.step
  const octaves = options.octaves ?? DEFAULTS.octaves
  const levels = options.levels ?? DEFAULTS.levels
  const epsilon = options.epsilon ?? DEFAULTS.epsilon
  const minLength = options.minLength ?? DEFAULTS.minLength
  const maxLines = options.maxLines ?? DEFAULTS.maxLines
  const scaleX = options.scaleX ?? DEFAULTS.scaleX
  const scaleY = options.scaleY ?? DEFAULTS.scaleY
  const width = options.width
  const height = options.height
  if (width <= 0 || height <= 0) throw new Error(`terrain needs a positive canvas, got ${width}x${height}`)
  if (!Number.isFinite(step) || step <= 0) throw new Error(`terrain step must be positive, got ${step}`)
  if (levels < 1) throw new Error(`terrain needs at least one level, got ${levels}`)

  const columns = Math.max(2, Math.round(width / step) + 1)
  const rows = Math.max(2, Math.round(height / step) + 1)
  const table = permutation(options.seed ?? TERRAIN_SEED)
  const field = new Float32Array(columns * rows)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const value = fbm(table, column / scaleX, row / scaleY, octaves)
      field[row * columns + column] = value
      if (value < min) min = value
      if (value > max) max = value
    }
  }

  const lines: TerrainLine[] = []
  for (let level = 0; level < levels; level += 1) {
    const iso = min + (max - min) * ((level + 0.5) / levels)
    for (const line of chainSegments(contourSegments(field, columns, rows, width, height, iso))) {
      if (line.length < minLength) continue
      const points = simplifyPolyline(line.points, epsilon)
      if (points.length < 2) continue
      lines.push({ level, points, length: line.length })
    }
  }
  if (lines.length <= maxLines) return lines
  // Deterministic budget: keep the longest lines, then restore level order.
  return [...lines]
    .sort((left, right) => right.length - left.length)
    .slice(0, maxLines)
    .sort((left, right) => left.level - right.level)
}
