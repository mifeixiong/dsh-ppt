import { strFromU8, strToU8 } from 'fflate'
import { PptError } from './errors.ts'
import { EMU_PER_PX, pathListXml, pxToEmu } from './svg-geometry.ts'
import type { Box, DashSpec, SubPath } from './svg-geometry.ts'
import { rewriteZip } from './zip.ts'

/**
 * DrawingML for the SVG lane.
 *
 * The HTML lane expresses its leaves through pptxgenjs, which covers rectangles,
 * text, pictures and tables — but not custom geometry, gradients inside a shape,
 * dash patterns or arrowheads. This module serializes one `<p:sp>` per SVG leaf
 * so the finished package can carry real freeform geometry, and it rewrites the
 * slide parts of an already-written package, mirroring the transition,
 * background and animation rewrites.
 *
 * Three schema facts drive the shape of this code:
 *
 * - `<a:ln>` is a sequence, not a bag of attributes: fill, `prstDash`, join,
 *   `headEnd`, `tailEnd`. PowerPoint rejects (or silently drops) children that
 *   arrive in another order, so every child here is emitted positionally.
 * - PowerPoint ignores `headEnd`/`tailEnd` on custom geometry. A line that has
 *   arrows therefore has to be a preset `prst="line"` shape whose endpoints are
 *   restored with `flipH`/`flipV`, not a `custGeom`.
 * - `a:ext` must be at least 1 EMU on both axes: a horizontal or vertical line
 *   is one EMU thick, not zero.
 */

export type ArrowEnd = 'none' | 'triangle' | 'stealth' | 'diamond' | 'oval' | 'arrow'

export interface GradientStop {
  /** 0..1 */
  offset: number
  /** `RRGGBB` */
  color: string
}

export interface SolidPaint {
  type: 'solid'
  /** `RRGGBB` */
  color: string
}

export interface LinearGradientPaint {
  type: 'linear'
  /** SVG-style angle in degrees: 0 = to the right, 90 = down. */
  angleDeg: number
  stops: readonly GradientStop[]
}

export interface RadialGradientPaint {
  type: 'radial'
  stops: readonly GradientStop[]
  /** Focus point in object-bounding-box units, 0..1. */
  focusX: number
  focusY: number
}

export interface NoPaint {
  type: 'none'
}

export type Paint = SolidPaint | LinearGradientPaint | RadialGradientPaint | NoPaint

export interface StrokeSpec {
  paint: Paint
  widthPx: number
  dash?: DashSpec
  cap?: 'butt' | 'round' | 'square'
  join?: 'miter' | 'round' | 'bevel'
  headEnd?: ArrowEnd
  tailEnd?: ArrowEnd
}

export type ShapeGeometry =
  | { kind: 'preset'; preset: 'rect' | 'roundRect' | 'ellipse' | 'line'; box: Box; radiusPx?: number; flipH?: boolean; flipV?: boolean }
  | { kind: 'path'; subpaths: readonly SubPath[]; box: Box; fillable: boolean }

export interface ShapeSpec {
  /** Matches the placeholder shape's `objectName`, which becomes `p:cNvPr/@name`. */
  id: string
  /** Human-readable name shown in PowerPoint's selection pane. */
  name: string
  geometry: ShapeGeometry
  fill: Paint
  /** Element opacity 0..1; multiplied into every paint alpha of this shape. */
  opacity?: number
  stroke?: StrokeSpec
}

/** DrawingML angles are 60,000ths of a degree. */
const ANGLE_UNITS_PER_DEGREE = 60_000
/** DrawingML percentages (alpha, gradient stop offsets, adjustments) are 100,000ths. */
const PERCENT_UNITS = 100_000
/** `<a:ds>` holds a percentage of the line width as 1,000ths of a percent. */
const DASH_UNITS_PER_PERCENT = 1_000
const MIN_GRADIENT_STOPS = 2
/** PowerPoint's gradient UI, and its renderer, stop being reliable past 8 stops. */
const MAX_GRADIENT_STOPS = 8
/** DrawingML's default miter limit; matches the reference converter. */
const MITER_LIMIT = 800_000
const DEFAULT_FLAT_CAP = 'flat'

const CAP_VALUE: Readonly<Record<'butt' | 'round' | 'square', string>> = {
  butt: DEFAULT_FLAT_CAP,
  round: 'rnd',
  square: 'sq',
}

const HEX_COLOR = /^[0-9a-f]{6}$/iu
const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/u
const SP_OPEN = '<p:sp'
const SP_CLOSE = '</p:sp>'
const CNV_PR = /<p:cNvPr\b[^>]*>/u
const NAME_ATTRIBUTE = /\sname="([^"]*)"/u
const ID_ATTRIBUTE = /\sid="(\d+)"/u
const ANY_CNV_PR = /<p:cNvPr\b[^>]*>/gu

function assertNever(value: never): never {
  throw new PptError('SVG_GEOMETRY_INVALID', `unsupported value: ${String(value)}`)
}

/** Rounds a 0..1 ratio into DrawingML's integer 100,000ths. */
function percentUnits(ratio: number): number {
  return Number.isFinite(ratio) ? Math.round(ratio * PERCENT_UNITS) : 0
}

/** `<a:alpha>`; DrawingML has no alpha at 100%, so an opaque paint stays bare. */
function alphaXml(opacity: number | undefined): string {
  if (opacity === undefined || !(opacity < 1)) return ''
  const value = Math.min(Math.max(percentUnits(opacity), 0), PERCENT_UNITS)
  return `<a:alpha val="${value}"/>`
}

function normalizeColor(color: string): string {
  const digits = color.trim().replace(/^#/u, '')
  if (!HEX_COLOR.test(digits)) {
    throw new PptError('SVG_GEOMETRY_INVALID', `paint color must be a six-digit hex RGB value: ${color}`)
  }
  return digits.toUpperCase()
}

function colorXml(color: string, opacity: number | undefined): string {
  const value = normalizeColor(color)
  const alpha = alphaXml(opacity)
  return alpha === '' ? `<a:srgbClr val="${value}"/>` : `<a:srgbClr val="${value}">${alpha}</a:srgbClr>`
}

function stopOffset(stop: GradientStop): number {
  return Number.isFinite(stop.offset) ? Math.min(Math.max(stop.offset, 0), 1) : 0
}

/**
 * `<a:gsLst>` content. DrawingML requires the stops in ascending `pos` order —
 * a list that arrives unsorted is reordered here, and out-of-range offsets are
 * clamped so the emitted `pos` stays inside 0..100000.
 */
function gradientStopsXml(stops: readonly GradientStop[], opacity: number | undefined): string {
  if (stops.length < MIN_GRADIENT_STOPS) {
    throw new PptError(
      'SVG_GEOMETRY_INVALID',
      `a gradient needs at least ${MIN_GRADIENT_STOPS} stops, received ${stops.length}`,
    )
  }
  if (stops.length > MAX_GRADIENT_STOPS) {
    throw new PptError(
      'SVG_GEOMETRY_INVALID',
      `a gradient supports at most ${MAX_GRADIENT_STOPS} stops, received ${stops.length}`,
    )
  }
  return [...stops]
    .sort((left, right) => stopOffset(left) - stopOffset(right))
    .map(stop => `<a:gs pos="${percentUnits(stopOffset(stop))}">${colorXml(stop.color, opacity)}</a:gs>`)
    .join('')
}

function angleUnits(angleDeg: number): number {
  const normalized = Number.isFinite(angleDeg) ? ((angleDeg % 360) + 360) % 360 : 0
  return Math.round(normalized * ANGLE_UNITS_PER_DEGREE)
}

/** `<a:solidFill>` / `<a:gradFill>` / `<a:noFill>` for a paint. */
export function paintXml(paint: Paint, opacity?: number): string {
  switch (paint.type) {
    case 'none':
      return '<a:noFill/>'
    case 'solid':
      return `<a:solidFill>${colorXml(paint.color, opacity)}</a:solidFill>`
    case 'linear':
      // `scaled="1"` keeps the angle relative to the shape box; `ang` is a
      // clockwise screen-space angle, the same orientation SVG uses.
      return '<a:gradFill rotWithShape="1">'
        + `<a:gsLst>${gradientStopsXml(paint.stops, opacity)}</a:gsLst>`
        + `<a:lin ang="${angleUnits(paint.angleDeg)}" scaled="1"/>`
        + '</a:gradFill>'
    case 'radial': {
      // `fillToRect` anchors the focus inside the bounding box: the focus point
      // is the offset from the left/top edge, and the opposite edges close it.
      // The caller supplies 0..1 focus values (the deck parser validates them).
      const left = percentUnits(paint.focusX)
      const top = percentUnits(paint.focusY)
      return '<a:gradFill>'
        + `<a:gsLst>${gradientStopsXml(paint.stops, opacity)}</a:gsLst>`
        + '<a:path path="circle">'
        + `<a:fillToRect l="${left}" t="${top}" r="${PERCENT_UNITS - left}" b="${PERCENT_UNITS - top}"/>`
        + '</a:path>'
        + '</a:gradFill>'
    }
    default:
      return assertNever(paint)
  }
}

/** Dash patterns: a custom pair wins over a preset, both are optional. */
function dashXml(dash: DashSpec | undefined): string {
  if (dash === undefined) return ''
  if (dash.custom !== undefined) {
    // DrawingML has no multi-length dash pattern, so a pair is all that survives.
    const d = Math.max(1, Math.round(dash.custom.d * DASH_UNITS_PER_PERCENT))
    const sp = Math.max(1, Math.round(dash.custom.sp * DASH_UNITS_PER_PERCENT))
    return `<a:custDash><a:ds d="${d}" sp="${sp}"/></a:custDash>`
  }
  return dash.preset === undefined ? '' : `<a:prstDash val="${dash.preset}"/>`
}

function joinXml(join: StrokeSpec['join']): string {
  if (join === 'round') return '<a:round/>'
  if (join === 'bevel') return '<a:bevel/>'
  if (join === 'miter') return `<a:miter lim="${MITER_LIMIT}"/>`
  return ''
}

/** `<a:headEnd>` / `<a:tailEnd>`; `none` is DrawingML's default, so it is omitted. */
function lineEndXml(tag: 'headEnd' | 'tailEnd', end: ArrowEnd | undefined): string {
  if (end === undefined || end === 'none') return ''
  return `<a:${tag} type="${end}" w="med" len="med"/>`
}

/** `<a:ln>` for a stroke, including dash, cap, join and line ends. */
export function strokeXml(stroke: StrokeSpec, opacity?: number): string {
  if (stroke.paint.type === 'none') return '<a:ln><a:noFill/></a:ln>'
  const width = Math.round(stroke.widthPx * EMU_PER_PX)
  // A sub-hairline stroke rounds to zero EMU, which DrawingML renders as an
  // invisible line but still reserves; emit an explicit noFill instead.
  if (!Number.isFinite(width) || width <= 0) return '<a:ln><a:noFill/></a:ln>'
  const cap = stroke.cap === undefined ? '' : ` cap="${CAP_VALUE[stroke.cap]}"`
  // Schema order: fill → dash → join → headEnd → tailEnd.
  return `<a:ln w="${width}"${cap}>`
    + paintXml(stroke.paint, opacity)
    + dashXml(stroke.dash)
    + joinXml(stroke.join)
    + lineEndXml('headEnd', stroke.headEnd)
    + lineEndXml('tailEnd', stroke.tailEnd)
    + '</a:ln>'
}

type PresetGeometry = Extract<ShapeGeometry, { kind: 'preset' }>
type PathGeometry = Extract<ShapeGeometry, { kind: 'path' }>

/**
 * The `roundRect` adjustment is the corner radius as a fraction of the short
 * side, capped at 0.5 (a stadium end). A radius supplied without a short side
 * means "as round as possible".
 */
function roundRectAdj(geometry: PresetGeometry): number {
  const shortSide = Math.min(geometry.box.w, geometry.box.h)
  const radiusPx = geometry.radiusPx ?? 0
  const ratio = shortSide > 0 ? radiusPx / shortSide : 0.5
  return percentUnits(Math.min(Math.max(ratio, 0), 0.5))
}

/**
 * `flipH`/`flipV` belong on `a:xfrm`. For a `prst="line"` shape the preset runs
 * from (0,0) to (w,h), so the flags are what puts the arrowheads on the SVG's
 * real endpoints.
 */
function flipAttributes(geometry: PresetGeometry): string {
  const horizontal = geometry.flipH === true ? ' flipH="1"' : ''
  const vertical = geometry.flipV === true ? ' flipV="1"' : ''
  return `${horizontal}${vertical}`
}

function presetGeometryXml(geometry: PresetGeometry): string {
  const adjustments = geometry.preset === 'roundRect'
    ? `<a:avLst><a:gd name="adj" fmla="val ${roundRectAdj(geometry)}"/></a:avLst>`
    : '<a:avLst/>'
  return `<a:prstGeom prst="${geometry.preset}">${adjustments}</a:prstGeom>`
}

function customGeometryXml(geometry: PathGeometry): string {
  // A degenerate axis is real geometry (a horizontal rule is 0 px tall), but a
  // zero-sized path space makes PowerPoint drop the shape. Grow that axis to a
  // pixel: the points still sit on the same line, and `shapeXml` grows `a:ext`
  // by the same box, so nothing is rescaled.
  const box = {
    x: geometry.box.x, y: geometry.box.y,
    w: Math.max(geometry.box.w, 1), h: Math.max(geometry.box.h, 1),
  }
  // `a:rect` names the text rectangle with the l/t/r/b tokens DrawingML uses
  // for "the same edge as the shape"; the path list itself is scaled per point.
  return '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/>'
    + pathListXml(geometry.subpaths, box, { fill: geometry.fillable })
    + '</a:custGeom>'
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** A complete `<p:sp>` for one SVG leaf. */
export function shapeXml(spec: ShapeSpec, shapeId: number): string {
  // Custom geometry grows a degenerate axis to one pixel (see customGeometryXml);
  // `a:ext` has to grow with it or PowerPoint would scale the path space.
  const box = spec.geometry.kind === 'path'
    ? {
        x: spec.geometry.box.x, y: spec.geometry.box.y,
        w: Math.max(spec.geometry.box.w, 1), h: Math.max(spec.geometry.box.h, 1),
      }
    : spec.geometry.box
  const flip = spec.geometry.kind === 'preset' ? flipAttributes(spec.geometry) : ''
  const geometry = spec.geometry.kind === 'preset'
    ? presetGeometryXml(spec.geometry)
    : customGeometryXml(spec.geometry)
  // A shape without a stroke still needs the element: an absent `a:ln` inherits
  // the theme line, which would paint an outline the SVG never asked for.
  const line = spec.stroke === undefined ? '<a:ln><a:noFill/></a:ln>' : strokeXml(spec.stroke, spec.opacity)
  // `name` repeats `spec.id` because it is the placeholder's `objectName`: the
  // rewrite pass finds shapes by that name, and a second pass over the same
  // package must find the shape it just wrote.
  return '<p:sp>'
    + `<p:nvSpPr><p:cNvPr id="${shapeId}" name="${escapeXmlAttribute(spec.id)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm${flip}><a:off x="${pxToEmu(box.x)}" y="${pxToEmu(box.y)}"/>`
    + `<a:ext cx="${Math.max(1, pxToEmu(box.w))}" cy="${Math.max(1, pxToEmu(box.h))}"/></a:xfrm>`
    + geometry
    + paintXml(spec.fill, spec.opacity)
    + line
    + '</p:spPr></p:sp>'
}

interface LocatedShape {
  /** Index of the opening `<p:sp`. */
  start: number
  /** Index just past the closing `</p:sp>`. */
  end: number
  /** `p:cNvPr/@id` of the located shape, when it carries one. */
  id?: number
}

/** Index of the `>` that closes a start tag, ignoring `>` inside attribute values. */
function findTagEnd(xml: string, from: number): number {
  let quote: string | undefined
  for (let index = from; index < xml.length; index += 1) {
    const character = xml[index]!
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') return index
  }
  return -1
}

function shapeStartAt(xml: string, index: number): boolean {
  const next = xml[index + SP_OPEN.length]
  return next !== undefined && (next === '>' || next === ' ' || next === '\t' || next === '\n' || next === '\r')
}

/** Counts opening `<p:sp>` tags, so a rewrite can prove it stayed balanced. */
function countShapeStarts(xml: string): number {
  let count = 0
  let cursor = xml.indexOf(SP_OPEN)
  while (cursor >= 0) {
    if (shapeStartAt(xml, cursor)) count += 1
    cursor = xml.indexOf(SP_OPEN, cursor + SP_OPEN.length)
  }
  return count
}

function countOccurrences(xml: string, needle: string): number {
  let count = 0
  let cursor = xml.indexOf(needle)
  while (cursor >= 0) {
    count += 1
    cursor = xml.indexOf(needle, cursor + needle.length)
  }
  return count
}

/**
 * Finds the `<p:sp>` whose `p:cNvPr/@name` equals `shapeName`. The scan is
 * element-aware rather than a flat regex because a slide nests shapes inside
 * `p:spTree` and `p:grpSp`, and a naive slice would cut at the wrong tag.
 */
function locateShape(xml: string, shapeName: string): LocatedShape | undefined {
  const escapedName = escapeXmlAttribute(shapeName)
  let cursor = xml.indexOf(SP_OPEN)
  while (cursor >= 0) {
    if (!shapeStartAt(xml, cursor)) {
      cursor = xml.indexOf(SP_OPEN, cursor + SP_OPEN.length)
      continue
    }
    const tagEnd = findTagEnd(xml, cursor + SP_OPEN.length)
    if (tagEnd < 0) {
      throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'slide XML has an unterminated p:sp start tag')
    }
    let end: number
    if (xml[tagEnd - 1] === '/') {
      // A self-closing p:sp has no identity, so it can never be the target.
      end = tagEnd + 1
    } else {
      let depth = 1
      let scan = tagEnd + 1
      for (;;) {
        const opening = xml.indexOf(SP_OPEN, scan)
        const closing = xml.indexOf(SP_CLOSE, scan)
        if (closing < 0) {
          throw new PptError(
            'PPT_CREATE_INVALID_PACKAGE',
            `slide XML has an unterminated p:sp element while looking for shape ${shapeName}`,
          )
        }
        if (opening >= 0 && opening < closing && shapeStartAt(xml, opening)) {
          depth += 1
          scan = opening + SP_OPEN.length
          continue
        }
        depth -= 1
        scan = closing + SP_CLOSE.length
        if (depth === 0) {
          end = scan
          break
        }
      }
    }
    const element = xml.slice(cursor, end)
    const identity = CNV_PR.exec(element)
    const name = identity === null ? null : NAME_ATTRIBUTE.exec(identity[0])
    if (identity !== null && name !== null && name[1] === escapedName) {
      const id = ID_ATTRIBUTE.exec(identity[0])
      return { start: cursor, end, ...(id === null ? {} : { id: Number(id[1]) }) }
    }
    cursor = xml.indexOf(SP_OPEN, end)
  }
  return undefined
}

/** Next free `p:cNvPr/@id`, used when the placeholder carried no id. */
function nextShapeId(xml: string): number {
  let highest = 1
  for (const match of xml.matchAll(ANY_CNV_PR)) {
    const id = ID_ATTRIBUTE.exec(match[0])
    if (id !== null) highest = Math.max(highest, Number(id[1]))
  }
  return highest + 1
}

/** Replace the `<p:sp>` named `shapeName` in one slide part; throws when absent. */
export function replaceSlideShape(slideXml: string, shapeName: string, replacementXml: string): string {
  const located = locateShape(slideXml, shapeName)
  if (located === undefined) {
    throw new PptError('PPT_CREATE_INVALID_PACKAGE', `no shape named ${shapeName} in slide XML`)
  }
  const replaced = `${slideXml.slice(0, located.start)}${replacementXml}${slideXml.slice(located.end)}`
  // A bad slice would corrupt every following element, so the result has to
  // prove it still holds exactly as many p:sp openings as closings.
  const openings = countShapeStarts(replaced)
  const closings = countOccurrences(replaced, SP_CLOSE)
  if (openings !== closings) {
    throw new PptError(
      'PPT_CREATE_INVALID_PACKAGE',
      `slide XML has unbalanced p:sp elements after rewriting shape ${shapeName}`
        + ` (${openings} open, ${closings} closed)`,
    )
  }
  return replaced
}

/** Rewrite every slide part named in `plans`; pages without plans stay untouched. */
export function rewritePptxSlideShapes(data: Uint8Array, plans: ReadonlyMap<number, readonly ShapeSpec[]>): Uint8Array {
  if (plans.size === 0) return data
  const targets = new Map<number, readonly ShapeSpec[]>()
  for (const [page, specs] of plans) {
    if (!Number.isInteger(page) || page < 1) {
      throw new PptError('PPT_CREATE_INPUT_INVALID', `slide shape page must be a positive integer: ${String(page)}`)
    }
    targets.set(page, specs)
  }
  const rewritten = new Set<number>()
  const output = rewriteZip(data, {
    transform: (name, read) => {
      const match = SLIDE_PART.exec(name)
      const page = match === null ? undefined : Number(match[1])
      const specs = page === undefined ? undefined : targets.get(page)
      if (page === undefined || specs === undefined) return undefined
      rewritten.add(page)
      let xml = strFromU8(read())
      for (const spec of specs) {
        // Reusing the placeholder's id keeps the slide's id space unchanged;
        // an unidentifiable placeholder gets a fresh id above the current max.
        const shapeId = locateShape(xml, spec.id)?.id ?? nextShapeId(xml)
        xml = replaceSlideShape(xml, spec.id, shapeXml(spec, shapeId))
      }
      return strToU8(xml)
    },
  })
  for (const page of targets.keys()) {
    if (!rewritten.has(page)) {
      throw new PptError('PPT_CREATE_INPUT_INVALID', `no slide part matches shape page ${page}`)
    }
  }
  return output
}
