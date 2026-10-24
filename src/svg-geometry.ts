import { PptError } from './errors.ts'

/**
 * SVG geometry for the native slide lane.
 *
 * The lane accepts a deliberately small SVG subset and turns it into DrawingML
 * custom geometry. This module owns the pure math: path-data parsing, absolute
 * normalization (all curves become cubics), affine transforms, bounding boxes
 * and the `<a:pathLst>` serialization. It has no DOM, no I/O and no knowledge
 * of paints, so every rule can be tested with plain numbers.
 */

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A normalized path segment: absolute, curves are cubic, pen state is explicit.
 *
 * Every subpath's `segments` opens with a `move` segment whose `to` equals
 * `start`; a `close` segment is always last and always matches `closed: true`.
 */
export type PathSegment =
  | { type: 'move'; to: Point }
  | { type: 'line'; to: Point }
  | { type: 'cubic'; c1: Point; c2: Point; to: Point }
  | { type: 'close' }

export interface SubPath {
  start: Point
  segments: PathSegment[]
  closed: boolean
}

/** `[a, b, c, d, e, f]` exactly as in SVG's `matrix()`: x' = a·x + c·y + e. */
export type Matrix = readonly [number, number, number, number, number, number]

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0]

/** 96 CSS px per inch, 914400 EMU per inch. */
export const EMU_PER_PX = 9525
/** DrawingML angles are 60,000ths of a degree. */
export const ANGLE_UNIT = 60_000

export function pxToEmu(px: number): number {
  return Math.round(px * EMU_PER_PX)
}

export function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = left
  const [a2, b2, c2, d2, e2, f2] = right
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

export function applyMatrix(matrix: Matrix, point: Point): Point {
  const [a, b, c, d, e, f] = matrix
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f }
}

/* -------------------------------------------------------------------------- */
/* Tokenizer                                                                   */
/* -------------------------------------------------------------------------- */

type TokenKind = 'command' | 'number'

/** One lexical unit of path data or a `points` list, with its source offset. */
interface GeometryToken {
  readonly kind: TokenKind
  readonly raw: string
  readonly offset: number
}

/** SVG number: optional sign, digits with optional fraction, optional exponent. */
const NUMBER_SOURCE = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?'
const NUMBER_PATTERN = new RegExp(`^${NUMBER_SOURCE}$`)
const NUMBER_SCAN_RE = new RegExp(NUMBER_SOURCE, 'g')

const PATH_COMMAND_CHARS = 'MmLlHhVvCcSsQqTtAaZz'
const PATH_TOKEN_RE = new RegExp(`([${PATH_COMMAND_CHARS}])|(${NUMBER_SOURCE})`, 'g')

/** Whitespace with at most one comma: the only legal gap between two tokens. */
const GAP_SEPARATOR_RE = /^[ \t\r\n]*(?:,[ \t\r\n]*)?$/
const WHITESPACE_RE = /^[ \t\r\n]*$/
/** Transform arguments need a real separator, so `10-20` stays invalid. */
const ARG_SEPARATOR_RE = /^[ \t\r\n]*,?[ \t\r\n]*$/
const TRANSFORM_FUNCTION_RE = /([A-Za-z][A-Za-z0-9]*)[ \t\r\n]*\(([^()]*)\)/g
const TRANSFORM_GAP_RE = /^[ \t\r\n]*(?:,[ \t\r\n]*)?$/

function invalid(message: string): never {
  throw new PptError('SVG_GEOMETRY_INVALID', message)
}

/**
 * Scan every token of one geometry value while asserting that the gaps carry
 * nothing but separators. A comma therefore only survives between two numbers:
 * `M,1` and `M 1,L 2` are rejected, `M1.5.5` splits into `1.5` and `.5`.
 */
function scanTokens(value: string, literal: string, withCommands: boolean): GeometryToken[] {
  if (value.trim() === '') invalid(`${literal} must not be empty`)
  const pattern = withCommands ? PATH_TOKEN_RE : NUMBER_SCAN_RE
  const tokens: GeometryToken[] = []
  let cursor = 0
  let previousKind: TokenKind | undefined

  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    const command = withCommands ? match[1] : undefined
    const kind: TokenKind = command === undefined ? 'number' : 'command'
    const raw = command ?? (withCommands ? match[2] : match[0]) ?? ''
    if (raw === '') invalid(`${literal} contains unsupported syntax at offset ${index}`)

    const gap = value.slice(cursor, index)
    if (!GAP_SEPARATOR_RE.test(gap)) {
      invalid(`${literal} contains unsupported syntax at offset ${cursor}: ${JSON.stringify(gap)}`)
    }
    if (gap.includes(',') && (previousKind === undefined || previousKind === 'command' || kind === 'command')) {
      invalid(`${literal} has a misplaced comma at offset ${cursor}`)
    }

    tokens.push({ kind, raw, offset: index })
    previousKind = kind
    cursor = index + raw.length
  }

  const trailing = value.slice(cursor)
  if (!WHITESPACE_RE.test(trailing)) {
    invalid(`${literal} contains unsupported trailing syntax at offset ${cursor}: ${JSON.stringify(trailing)}`)
  }
  if (tokens.length === 0) invalid(`${literal} must contain at least one number`)
  return tokens
}

function finiteTokenValue(token: GeometryToken, literal: string): number {
  const value = Number(token.raw)
  if (!Number.isFinite(value)) {
    invalid(`${literal} contains a non-finite number ${JSON.stringify(token.raw)} at offset ${token.offset}`)
  }
  return value
}

/* -------------------------------------------------------------------------- */
/* Transform list                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Parse one transform value into the local-to-parent matrix.
 *
 * Transforms compose in document order with the leftmost applied last, so the
 * accumulator is multiplied on the right: `translate(10,20) scale(2)` yields
 * `[2,0,0,2,10,20]` and maps (1,1) to (12,22).
 */
export function parseTransform(value: string): Matrix {
  const text = value.trim()
  if (text === '') return IDENTITY_MATRIX

  let result: Matrix = IDENTITY_MATRIX
  let cursor = 0

  for (const match of text.matchAll(TRANSFORM_FUNCTION_RE)) {
    const index = match.index ?? 0
    const gap = text.slice(cursor, index)
    if (!TRANSFORM_GAP_RE.test(gap) || (cursor === 0 && gap.includes(','))) {
      invalid(`SVG transform list has unsupported syntax at offset ${cursor}: ${JSON.stringify(gap)}`)
    }

    const name = match[1] ?? ''
    const rawArguments = match[2] ?? ''
    const source = `${name}(${rawArguments})`
    const args = parseTransformArguments(rawArguments, source)
    result = multiplyMatrix(result, transformMatrix(name, args, source))
    cursor = index + (match[0]?.length ?? source.length)
  }

  const trailing = text.slice(cursor)
  if (!WHITESPACE_RE.test(trailing)) {
    invalid(`SVG transform list has unsupported trailing syntax at offset ${cursor}: ${JSON.stringify(trailing)}`)
  }
  return result
}

function parseTransformArguments(raw: string, source: string): number[] {
  const text = raw.trim()
  if (text === '') return []

  const values: number[] = []
  let cursor = 0
  for (const match of text.matchAll(NUMBER_SCAN_RE)) {
    const index = match.index ?? 0
    const token = match[0] ?? ''
    const gap = text.slice(cursor, index)
    if (values.length === 0) {
      if (gap !== '') invalid(`${source} has unsupported syntax at offset ${index}`)
    } else if (gap === '' || !ARG_SEPARATOR_RE.test(gap)) {
      invalid(`${source} has unsupported syntax at offset ${cursor}: ${JSON.stringify(gap)}`)
    }
    values.push(finiteTokenValue({ kind: 'number', raw: token, offset: index }, source))
    cursor = index + token.length
  }

  const trailing = text.slice(cursor)
  if (!WHITESPACE_RE.test(trailing)) {
    invalid(`${source} has unsupported trailing syntax at offset ${cursor}: ${JSON.stringify(trailing)}`)
  }
  return values
}

function transformMatrix(name: string, args: readonly number[], source: string): Matrix {
  switch (name) {
    case 'matrix': {
      if (args.length !== 6) invalid(`${source} requires 6 numbers`)
      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = args
      return [a, b, c, d, e, f]
    }
    case 'translate': {
      if (args.length !== 1 && args.length !== 2) invalid(`${source} requires 1 or 2 numbers`)
      const [tx = 0, ty = 0] = args
      return [1, 0, 0, 1, tx, ty]
    }
    case 'scale': {
      if (args.length !== 1 && args.length !== 2) invalid(`${source} requires 1 or 2 numbers`)
      const [sx = 1, sy = sx] = args
      return [sx, 0, 0, sy, 0, 0]
    }
    case 'rotate': {
      if (args.length !== 1 && args.length !== 3) invalid(`${source} requires 1 or 3 numbers`)
      const [degrees = 0, cx = 0, cy = 0] = args
      const radians = degrees * Math.PI / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)
      const rotation: Matrix = [cos, sin, -sin, cos, 0, 0]
      if (args.length === 1) return rotation
      // Rotation about a centre is that centre's translation wrapped around it.
      const toCentre: Matrix = [1, 0, 0, 1, cx, cy]
      const fromCentre: Matrix = [1, 0, 0, 1, -cx, -cy]
      return multiplyMatrix(multiplyMatrix(toCentre, rotation), fromCentre)
    }
    case 'skewX': {
      if (args.length !== 1) invalid(`${source} requires 1 number`)
      const [degrees = 0] = args
      return [1, 0, Math.tan(degrees * Math.PI / 180), 1, 0, 0]
    }
    case 'skewY': {
      if (args.length !== 1) invalid(`${source} requires 1 number`)
      const [degrees = 0] = args
      return [1, Math.tan(degrees * Math.PI / 180), 0, 1, 0, 0]
    }
    default:
      invalid(`unsupported SVG transform ${source}`)
  }
}

/* -------------------------------------------------------------------------- */
/* Path data                                                                   */
/* -------------------------------------------------------------------------- */

const PATH_ARG_COUNTS: Readonly<Record<string, number>> = {
  M: 2, m: 2, L: 2, l: 2,
  H: 1, h: 1, V: 1, v: 1,
  C: 6, c: 6, S: 4, s: 4,
  Q: 4, q: 4, T: 2, t: 2,
  A: 7, a: 7, Z: 0, z: 0,
}

interface PathCommand {
  readonly cmd: string
  readonly args: readonly number[]
}

type CubicSegment = Extract<PathSegment, { type: 'cubic' }>
type LineSegment = Extract<PathSegment, { type: 'line' }>

/**
 * Split compact arc flags without loosening the numeric grammar: `a5 5 0 0110 10`
 * carries one token `0110` that stands for the large-arc flag `0`, the sweep flag
 * `1` and the x coordinate `10`.
 */
function expandArcArguments(tokens: readonly GeometryToken[], command: string): GeometryToken[] {
  const argumentCount = PATH_ARG_COUNTS[command]
  if (argumentCount === undefined) invalid(`path command ${command} is not supported`)

  const pending = [...tokens]
  const expanded: GeometryToken[] = []
  let argumentIndex = 0

  while (pending.length > 0) {
    const token = pending.shift()
    if (token === undefined) break
    const position = argumentIndex % argumentCount

    if (position === 3 || position === 4) {
      const flag = token.raw[0]
      if (flag !== '0' && flag !== '1') {
        invalid(`path arc flag at offset ${token.offset} must be exactly 0 or 1; got ${JSON.stringify(token.raw)}`)
      }
      expanded.push({ kind: 'number', raw: flag, offset: token.offset })

      const remainder = token.raw.slice(1)
      if (remainder !== '') {
        const nextPosition = (position + 1) % argumentCount
        const nextIsFlag = nextPosition === 3 || nextPosition === 4
        const remainderOk = nextIsFlag
          ? remainder[0] === '0' || remainder[0] === '1'
          : NUMBER_PATTERN.test(remainder)
        if (!remainderOk) {
          invalid(`path arc flag at offset ${token.offset} must be exactly 0 or 1; got ${JSON.stringify(token.raw)}`)
        }
        pending.unshift({ kind: 'number', raw: remainder, offset: token.offset + 1 })
      }
    } else {
      expanded.push(token)
    }
    argumentIndex += 1
  }

  return expanded
}

function parsePathCommands(tokens: readonly GeometryToken[]): PathCommand[] {
  const first = tokens[0]
  if (first === undefined || first.kind !== 'command' || (first.raw !== 'M' && first.raw !== 'm')) {
    invalid('path d must begin with M or m')
  }

  const commands: PathCommand[] = []
  let index = 0

  while (index < tokens.length) {
    const commandToken = tokens[index]
    if (commandToken === undefined) break
    if (commandToken.kind !== 'command') {
      invalid(`path d requires a command at offset ${commandToken.offset}`)
    }

    const command = commandToken.raw
    index += 1
    if (command === 'Z' || command === 'z') {
      commands.push({ cmd: 'Z', args: [] })
      continue
    }

    const argumentTokens: GeometryToken[] = []
    while (index < tokens.length) {
      const next = tokens[index]
      if (next === undefined || next.kind !== 'number') break
      argumentTokens.push(next)
      index += 1
    }

    const argumentCount = PATH_ARG_COUNTS[command]
    if (argumentCount === undefined) invalid(`path command ${command} is not supported`)

    const expanded = command === 'A' || command === 'a'
      ? expandArcArguments(argumentTokens, command)
      : argumentTokens
    if (expanded.length === 0) {
      invalid(`path command ${command} at offset ${commandToken.offset} requires ${argumentCount} argument(s)`)
    }
    if (expanded.length % argumentCount !== 0) {
      invalid(
        `path command ${command} at offset ${commandToken.offset} has ${expanded.length} argument(s); `
        + `expected a multiple of ${argumentCount}`,
      )
    }

    for (let groupIndex = 0; groupIndex < expanded.length; groupIndex += argumentCount) {
      const group = expanded.slice(groupIndex, groupIndex + argumentCount)
      const values = group.map(token => finiteTokenValue(token, 'path d'))
      if (command === 'A' || command === 'a') {
        const [rx = 0, ry = 0] = values
        if (rx < 0 || ry < 0) invalid('path arc radii must be non-negative')
      }

      // Only the first coordinate pair of an M/m is a move; the rest draw.
      let emitted = command
      if (groupIndex > 0 && command === 'M') emitted = 'L'
      else if (groupIndex > 0 && command === 'm') emitted = 'l'
      commands.push({ cmd: emitted, args: values })
    }
  }

  return commands
}

/** Resolve every relative command against the pen and the subpath start. */
function toAbsolute(commands: readonly PathCommand[]): PathCommand[] {
  const result: PathCommand[] = []
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0

  for (const command of commands) {
    const [a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0] = command.args

    switch (command.cmd) {
      case 'M':
        cx = a0; cy = a1; sx = cx; sy = cy
        result.push({ cmd: 'M', args: [cx, cy] })
        break
      case 'm':
        cx += a0; cy += a1; sx = cx; sy = cy
        result.push({ cmd: 'M', args: [cx, cy] })
        break
      case 'L':
        cx = a0; cy = a1
        result.push({ cmd: 'L', args: [cx, cy] })
        break
      case 'l':
        cx += a0; cy += a1
        result.push({ cmd: 'L', args: [cx, cy] })
        break
      case 'H':
        cx = a0
        result.push({ cmd: 'L', args: [cx, cy] })
        break
      case 'h':
        cx += a0
        result.push({ cmd: 'L', args: [cx, cy] })
        break
      case 'V':
        cy = a0
        result.push({ cmd: 'L', args: [cx, cy] })
        break
      case 'v':
        cy += a0
        result.push({ cmd: 'L', args: [cx, cy] })
        break
      case 'C':
        result.push({ cmd: 'C', args: [a0, a1, a2, a3, a4, a5] })
        cx = a4; cy = a5
        break
      case 'c': {
        const absolute = [cx + a0, cy + a1, cx + a2, cy + a3, cx + a4, cy + a5] as const
        result.push({ cmd: 'C', args: absolute })
        cx = absolute[4]; cy = absolute[5]
        break
      }
      case 'S':
        result.push({ cmd: 'S', args: [a0, a1, a2, a3] })
        cx = a2; cy = a3
        break
      case 's': {
        const absolute = [cx + a0, cy + a1, cx + a2, cy + a3] as const
        result.push({ cmd: 'S', args: absolute })
        cx = absolute[2]; cy = absolute[3]
        break
      }
      case 'Q':
        result.push({ cmd: 'Q', args: [a0, a1, a2, a3] })
        cx = a2; cy = a3
        break
      case 'q': {
        const absolute = [cx + a0, cy + a1, cx + a2, cy + a3] as const
        result.push({ cmd: 'Q', args: absolute })
        cx = absolute[2]; cy = absolute[3]
        break
      }
      case 'T':
        result.push({ cmd: 'T', args: [a0, a1] })
        cx = a0; cy = a1
        break
      case 't': {
        const absolute = [cx + a0, cy + a1] as const
        result.push({ cmd: 'T', args: absolute })
        cx = absolute[0]; cy = absolute[1]
        break
      }
      case 'A':
        result.push({ cmd: 'A', args: [a0, a1, a2, a3, a4, a5, a6] })
        cx = a5; cy = a6
        break
      case 'a': {
        const absolute = [a0, a1, a2, a3, a4, cx + a5, cy + a6] as const
        result.push({ cmd: 'A', args: absolute })
        cx = absolute[5]; cy = absolute[6]
        break
      }
      case 'Z':
        result.push({ cmd: 'Z', args: [] })
        cx = sx; cy = sy
        break
      default:
        invalid(`path command ${command.cmd} is not supported`)
    }
  }

  return result
}

/** Mirror a control point through the current point: `c' = 2·p - c`. */
function reflectControlPoint(control: Point, current: Point): Point {
  return { x: 2 * current.x - control.x, y: 2 * current.y - control.y }
}

/**
 * Exact quadratic-to-cubic elevation: both cubic controls sit on the legs of the
 * quadratic at two thirds of their length, which preserves the curve exactly.
 */
function quadToCubic(control: Point, from: Point, to: Point): { c1: Point; c2: Point } {
  const ratio = 2 / 3
  return {
    c1: { x: from.x + ratio * (control.x - from.x), y: from.y + ratio * (control.y - from.y) },
    c2: { x: to.x + ratio * (control.x - to.x), y: to.y + ratio * (control.y - to.y) },
  }
}

/**
 * Convert an endpoint-parameterized arc to cubic segments of at most 90 degrees.
 *
 * This is the SVG spec's F.6.5 centre conversion followed by the standard
 * `4/3·tan(Δ/4)` handle length per sub-segment, so a half circle costs two
 * cubics and a full circle four.
 */
function arcToCubics(
  fromX: number,
  fromY: number,
  radiusX: number,
  radiusY: number,
  rotationDegrees: number,
  largeArc: number,
  sweep: number,
  toX: number,
  toY: number,
): Array<CubicSegment | LineSegment> {
  if (Math.abs(fromX - toX) < 1e-10 && Math.abs(fromY - toY) < 1e-10) return []

  let rx = Math.abs(radiusX)
  let ry = Math.abs(radiusY)
  if (rx < 1e-10 || ry < 1e-10) return [{ type: 'line', to: { x: toX, y: toY } }]

  const phi = rotationDegrees * Math.PI / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)

  const dx = (fromX - toX) / 2
  const dy = (fromY - toY) / 2
  const x1p = cosPhi * dx + sinPhi * dy
  const y1p = -sinPhi * dx + cosPhi * dy
  const x1p2 = x1p * x1p
  const y1p2 = y1p * y1p

  let rx2 = rx * rx
  let ry2 = ry * ry
  const lambda = x1p2 / rx2 + y1p2 / ry2
  if (lambda > 1) {
    const growth = Math.sqrt(lambda)
    rx *= growth
    ry *= growth
    rx2 = rx * rx
    ry2 = ry * ry
  }

  const numerator = Math.max(rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2, 0)
  const denominator = rx2 * y1p2 + ry2 * x1p2
  let sq = denominator > 1e-10 ? Math.sqrt(numerator / denominator) : 0
  if (largeArc === sweep) sq = -sq

  const cxp = sq * rx * y1p / ry
  const cyp = -sq * ry * x1p / rx
  const centerX = cosPhi * cxp - sinPhi * cyp + (fromX + toX) / 2
  const centerY = sinPhi * cxp + cosPhi * cyp + (fromY + toY) / 2

  const angleBetween = (ux: number, uy: number, vx: number, vy: number): number => {
    const magnitude = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
    if (magnitude < 1e-10) return 0
    const cosine = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / magnitude))
    const angle = Math.acos(cosine)
    return ux * vy - uy * vx < 0 ? -angle : angle
  }

  const theta1 = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let deltaTheta = angleBetween(
    (x1p - cxp) / rx, (y1p - cyp) / ry,
    (-x1p - cxp) / rx, (-y1p - cyp) / ry,
  )
  if (sweep === 0 && deltaTheta > 0) deltaTheta -= 2 * Math.PI
  else if (sweep === 1 && deltaTheta < 0) deltaTheta += 2 * Math.PI

  const segmentCount = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)))
  const segmentAngle = deltaTheta / segmentCount
  const handle = (4 / 3) * Math.tan(segmentAngle / 4)

  const project = (unitX: number, unitY: number): Point => {
    const x = rx * unitX
    const y = ry * unitY
    return { x: cosPhi * x - sinPhi * y + centerX, y: sinPhi * x + cosPhi * y + centerY }
  }

  const pieces: Array<CubicSegment | LineSegment> = []
  for (let index = 0; index < segmentCount; index += 1) {
    const t1 = theta1 + index * segmentAngle
    const t2 = theta1 + (index + 1) * segmentAngle
    const cosT1 = Math.cos(t1)
    const sinT1 = Math.sin(t1)
    const cosT2 = Math.cos(t2)
    const sinT2 = Math.sin(t2)

    pieces.push({
      type: 'cubic',
      c1: project(cosT1 - handle * sinT1, sinT1 + handle * cosT1),
      c2: project(cosT2 + handle * sinT2, sinT2 - handle * cosT2),
      to: project(cosT2, sinT2),
    })
  }
  return pieces
}

/** Turn the absolute command stream into subpaths of move/line/cubic/close. */
function normalizeCommands(commands: readonly PathCommand[]): SubPath[] {
  const subpaths: SubPath[] = []
  let current: SubPath | undefined
  let penX = 0
  let penY = 0
  let startX = 0
  let startY = 0
  let lastControl: Point = { x: 0, y: 0 }
  let previousCommand = ''

  const openSubPath = (x: number, y: number): SubPath => {
    const subpath: SubPath = {
      start: { x, y },
      segments: [{ type: 'move', to: { x, y } }],
      closed: false,
    }
    subpaths.push(subpath)
    return subpath
  }

  const requireOpen = (command: string): SubPath => {
    if (current === undefined) {
      invalid(`path command ${command} must follow a move command: a close ends its subpath`)
    }
    return current
  }

  for (const command of commands) {
    const [a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0] = command.args

    switch (command.cmd) {
      case 'M':
        penX = a0; penY = a1
        startX = penX; startY = penY
        current = openSubPath(penX, penY)
        lastControl = { x: penX, y: penY }
        break
      case 'L': {
        const subpath = requireOpen('L')
        penX = a0; penY = a1
        subpath.segments.push({ type: 'line', to: { x: penX, y: penY } })
        lastControl = { x: penX, y: penY }
        break
      }
      case 'C': {
        const subpath = requireOpen('C')
        const c1 = { x: a0, y: a1 }
        const c2 = { x: a2, y: a3 }
        const to = { x: a4, y: a5 }
        subpath.segments.push({ type: 'cubic', c1, c2, to })
        penX = to.x; penY = to.y
        lastControl = c2
        break
      }
      case 'S': {
        const subpath = requireOpen('S')
        // Only a preceding cubic family owns a control point worth mirroring.
        const fromCurve = previousCommand === 'C' || previousCommand === 'S'
        const c1 = fromCurve ? reflectControlPoint(lastControl, { x: penX, y: penY }) : { x: penX, y: penY }
        const c2 = { x: a0, y: a1 }
        const to = { x: a2, y: a3 }
        subpath.segments.push({ type: 'cubic', c1, c2, to })
        penX = to.x; penY = to.y
        lastControl = c2
        break
      }
      case 'Q': {
        const subpath = requireOpen('Q')
        const control = { x: a0, y: a1 }
        const to = { x: a2, y: a3 }
        const { c1, c2 } = quadToCubic(control, { x: penX, y: penY }, to)
        subpath.segments.push({ type: 'cubic', c1, c2, to })
        penX = to.x; penY = to.y
        lastControl = control
        break
      }
      case 'T': {
        const subpath = requireOpen('T')
        const fromQuad = previousCommand === 'Q' || previousCommand === 'T'
        const control = fromQuad ? reflectControlPoint(lastControl, { x: penX, y: penY }) : { x: penX, y: penY }
        const to = { x: a0, y: a1 }
        const { c1, c2 } = quadToCubic(control, { x: penX, y: penY }, to)
        subpath.segments.push({ type: 'cubic', c1, c2, to })
        penX = to.x; penY = to.y
        lastControl = control
        break
      }
      case 'A': {
        const subpath = requireOpen('A')
        const pieces = arcToCubics(penX, penY, a0, a1, a2, a3, a4, a5, a6)
        for (const piece of pieces) subpath.segments.push(piece)
        penX = a5; penY = a6
        lastControl = { x: penX, y: penY }
        break
      }
      case 'Z': {
        const subpath = requireOpen('Z')
        subpath.segments.push({ type: 'close' })
        subpath.closed = true
        // A closed subpath returns the pen to its start point, then ends.
        penX = startX; penY = startY
        lastControl = { x: penX, y: penY }
        current = undefined
        break
      }
      default:
        invalid(`path command ${command.cmd} is not supported`)
    }

    previousCommand = command.cmd
  }

  return subpaths
}

/** Parse one path `d` value and normalize to absolute move/line/cubic/close. */
export function parsePathData(d: string): SubPath[] {
  return normalizeCommands(toAbsolute(parsePathCommands(scanTokens(d, 'path d', true))))
}

/** Parse a `points` value into coordinate pairs. */
export function parsePoints(value: string): Point[] {
  const tokens = scanTokens(value, 'points', false)
  if (tokens.length % 2 !== 0) {
    invalid(`points has ${tokens.length} numeric value(s); expected coordinate pairs`)
  }
  const count = tokens.length / 2
  if (count < 2) invalid(`points requires at least 2 coordinate pair(s); got ${count}`)

  const points: Point[] = []
  for (let index = 0; index < tokens.length; index += 2) {
    const xToken = tokens[index]
    const yToken = tokens[index + 1]
    if (xToken === undefined || yToken === undefined) invalid('points is missing a coordinate')
    points.push({ x: finiteTokenValue(xToken, 'points'), y: finiteTokenValue(yToken, 'points') })
  }
  return points
}

/** Turn a point list into one subpath (polyline open, polygon closed). */
export function polylineToSubPaths(points: readonly Point[], closed: boolean): SubPath[] {
  const first = points[0]
  if (first === undefined) return []

  const segments: PathSegment[] = [{ type: 'move', to: { x: first.x, y: first.y } }]
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]
    if (point === undefined) continue
    segments.push({ type: 'line', to: { x: point.x, y: point.y } })
  }
  if (closed) segments.push({ type: 'close' })

  return [{ start: { x: first.x, y: first.y }, segments, closed }]
}

/** Apply an affine matrix to every coordinate of every subpath. */
export function transformSubPaths(subpaths: readonly SubPath[], matrix: Matrix): SubPath[] {
  return subpaths.map(subpath => {
    const segments = subpath.segments.map((segment): PathSegment => {
      switch (segment.type) {
        case 'move':
          return { type: 'move', to: applyMatrix(matrix, segment.to) }
        case 'line':
          return { type: 'line', to: applyMatrix(matrix, segment.to) }
        case 'cubic':
          return {
            type: 'cubic',
            c1: applyMatrix(matrix, segment.c1),
            c2: applyMatrix(matrix, segment.c2),
            to: applyMatrix(matrix, segment.to),
          }
        case 'close':
          return { type: 'close' }
      }
    })
    return { start: applyMatrix(matrix, subpath.start), segments, closed: subpath.closed }
  })
}

/**
 * Control-point bounding box, the same convention the reference converter uses:
 * curve extremes are not solved exactly, so the box can be slightly larger than
 * the painted curve, never smaller. Coordinates are in the caller's space (px).
 */
export function pathBounds(subpaths: readonly SubPath[]): Box | undefined {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let seen = false

  const include = (point: Point): void => {
    seen = true
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }

  for (const subpath of subpaths) {
    include(subpath.start)
    for (const segment of subpath.segments) {
      switch (segment.type) {
        case 'move':
        case 'line':
          include(segment.to)
          break
        case 'cubic':
          include(segment.c1)
          include(segment.c2)
          include(segment.to)
          break
        case 'close':
          break
      }
    }
  }

  if (!seen) return undefined
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export interface PathListOptions {
  /** Emit `fill="norm"` (filled shape) or `fill="none"` (stroke-only open path). */
  fill: boolean
  /** Multiplier applied to box units before the px→EMU conversion; defaults to 1. */
  scale?: number
}

/**
 * Serialize subpaths as `<a:pathLst>`, with every point translated to the box
 * origin and scaled to EMU. The returned `<a:path w="…" h="…">` covers the box,
 * so the shape's `a:ext` and the path space agree and PowerPoint does not
 * rescale the geometry.
 */
export function pathListXml(subpaths: readonly SubPath[], box: Box, options: PathListOptions): string {
  const scale = options.scale ?? 1
  const width = Math.round(box.w * scale * EMU_PER_PX)
  const height = Math.round(box.h * scale * EMU_PER_PX)

  // Rounding can push a point one EMU past the declared path space; clamp so the
  // emitted coordinates always satisfy 0 <= x <= w and 0 <= y <= h.
  const clamp = (value: number, limit: number): number => Math.min(Math.max(value, 0), Math.max(limit, 0))
  const xOf = (point: Point): number => clamp(Math.round((point.x - box.x) * scale * EMU_PER_PX), width)
  const yOf = (point: Point): number => clamp(Math.round((point.y - box.y) * scale * EMU_PER_PX), height)
  const pt = (point: Point): string => `<a:pt x="${xOf(point)}" y="${yOf(point)}"/>`

  const parts: string[] = []
  for (const subpath of subpaths) {
    for (const segment of subpath.segments) {
      switch (segment.type) {
        case 'move':
          parts.push(`<a:moveTo>${pt(segment.to)}</a:moveTo>`)
          break
        case 'line':
          parts.push(`<a:lnTo>${pt(segment.to)}</a:lnTo>`)
          break
        case 'cubic':
          parts.push(`<a:cubicBezTo>${pt(segment.c1)}${pt(segment.c2)}${pt(segment.to)}</a:cubicBezTo>`)
          break
        case 'close':
          parts.push('<a:close/>')
          break
      }
    }
  }

  const fill = options.fill ? 'norm' : 'none'
  return `<a:pathLst><a:path w="${width}" h="${height}" fill="${fill}" stroke="1">${parts.join('')}</a:path></a:pathLst>`
}

export interface DashSpec {
  preset?: 'solid' | 'dot' | 'dash' | 'lgDash' | 'dashDot' | 'lgDashDot' | 'lgDashDotDot' | 'sysDot' | 'sysDash'
  custom?: { d: number; sp: number }
}

type DashPreset = NonNullable<DashSpec['preset']>

/** Dash families whose DrawingML preset reproduces the SVG rhythm. */
const DASH_PRESET_FAMILIES: ReadonlyArray<{ readonly values: readonly number[]; readonly preset: DashPreset }> = [
  { values: [1, 1], preset: 'sysDot' },
  { values: [2, 2], preset: 'sysDot' },
  { values: [4, 4], preset: 'dash' },
  { values: [6, 6], preset: 'dash' },
  { values: [6, 3], preset: 'dash' },
  { values: [8, 8], preset: 'dash' },
  { values: [4, 2, 1, 2], preset: 'dashDot' },
  { values: [8, 2, 1, 2], preset: 'lgDashDot' },
]

/**
 * Map `stroke-dasharray` to a DrawingML preset when the pattern is one of the
 * named families, otherwise to a single custom dash/gap pair expressed in
 * percent of line width (DrawingML has no multi-length dash pattern).
 */
export function dashFromArray(value: string, strokeWidthPx: number): DashSpec | undefined {
  const text = value.trim()
  if (text === '') return undefined
  if (text.toLowerCase() === 'none') return { preset: 'solid' }

  const values: number[] = []
  for (const token of text.split(/[\s,]+/u)) {
    if (token === '') continue
    if (!NUMBER_PATTERN.test(token)) return undefined
    const parsed = Number(token)
    if (!Number.isFinite(parsed) || parsed < 0) return undefined
    values.push(parsed)
  }
  if (values.length === 0) return undefined

  // An odd list repeats once, so `4` means `4 4` and `4 2 1` means `4 2 1 4 2 1`.
  const pattern = values.length % 2 === 0 ? values : [...values, ...values]
  if (pattern.every(entry => entry === 0)) return { preset: 'solid' }

  for (const family of DASH_PRESET_FAMILIES) {
    if (family.values.length !== pattern.length) continue
    if (family.values.every((entry, index) => entry === pattern[index])) return { preset: family.preset }
  }

  const [dash = 0, gap = 0] = pattern
  if (pattern.length === 2 && (dash === 12 || dash === 16)) return { preset: 'lgDash' }
  if (pattern.length === 2 && dash === gap && dash <= 2) return { preset: 'sysDot' }

  const strokeWidth = Number.isFinite(strokeWidthPx) && strokeWidthPx > 0 ? strokeWidthPx : 0.001
  return {
    custom: {
      d: Math.max(1, Math.round(dash / strokeWidth * 100000)),
      sp: Math.max(1, Math.round(gap / strokeWidth * 100000)),
    },
  }
}
