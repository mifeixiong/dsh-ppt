import { PptError, describeIssues } from './errors.ts'
import type { TextMetrics, TextMeasurement } from './text-metrics.ts'
import {
  IDENTITY_MATRIX,
  dashFromArray,
  parsePathData,
  parsePoints,
  parseTransform,
  pathBounds,
  polylineToSubPaths,
  transformSubPaths,
  type Box,
  type Matrix,
  type SubPath,
} from './svg-geometry.ts'
import type { ArrowEnd, GradientStop, Paint, ShapeGeometry, ShapeSpec, StrokeSpec } from './svg-ooxml.ts'
import { attributeOf, parseXml, XmlParseError, type XmlElement, type XmlNode } from './svg-xml.ts'

/**
 * The SVG deck contract and parser.
 *
 * A deck is one SVG document whose pages are top-level `<g data-page="N">`
 * groups on a 1280x720 viewBox. The accepted subset is intentionally narrow:
 * vector primitives that have an exact DrawingML equivalent, text with explicit
 * anchors, and local images. Everything that would need a rasteriser or a
 * filter pipeline (mask, clipPath, filter, pattern, use, marker, foreignObject)
 * is rejected with a finding instead of silently dropped, so an authored page
 * never diverges from its export.
 */

export const SVG_CANVAS_WIDTH = 1280
export const SVG_CANVAS_HEIGHT = 720
export const SVG_MIN_FONT_PX = 12
export const SVG_MAX_ELEMENTS_PER_PAGE = 400
export const SVG_MAX_PAGES = 60

export interface SvgFinding {
  code: string
  severity: 'error' | 'warning'
  page?: number
  element?: string
  message: string
}

export interface SvgTextStyle {
  fontFamily: string
  fontSizePx: number
  fontWeight: number
  italic: boolean
  /** `RRGGBB` */
  color: string
  letterSpacingPx: number
  lineHeightPx: number
  anchor: 'start' | 'middle' | 'end'
}

export interface SvgTextRun {
  text: string
  fontFamily: string
  fontSizePx: number
  fontWeight: number
  italic: boolean
  color: string
}

export interface SvgTextLine {
  /** SVG baseline position, in canvas px. */
  baselineY: number
  runs: SvgTextRun[]
  /** Measured advance width of the line, in px. */
  width: number
  /** Measured ascent/descent of the first run's face, in px. */
  ascent: number
  descent: number
}

export interface SvgTextElement {
  kind: 'text'
  id: string
  style: SvgTextStyle
  /** Box already anchored: `box.x` is the left edge implied by `style.anchor`. */
  box: Box
  lines: SvgTextLine[]
}

export interface SvgShapeElement {
  kind: 'shape'
  id: string
  spec: ShapeSpec
}

export interface SvgImageElement {
  kind: 'image'
  id: string
  box: Box
  /** Workspace-relative image path exactly as authored. */
  href: string
  opacity: number
}

export type SvgElement = SvgShapeElement | SvgTextElement | SvgImageElement

export interface SvgPageIR {
  page: number
  /** `RRGGBB` page background declared with `data-background`. */
  background?: string
  elements: SvgElement[]
}

export interface SvgDeckIR {
  pages: SvgPageIR[]
  /** Non-blocking findings; blocking problems throw before this is returned. */
  findings: SvgFinding[]
}

export interface SvgDeckOptions {
  metrics: TextMetrics
  /** Approved font family names; a page may only reference these. */
  fonts: readonly string[]
}

/* -------------------------------------------------------------------------- */
/* Contract tables                                                            */
/* -------------------------------------------------------------------------- */

const MAX_ATTRIBUTES_PER_ELEMENT = 64
const MAX_NESTING_DEPTH = 4
const MAX_TEXT_RUN_LENGTH = 2000

const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'image',
  'title',
  'desc',
])

const KNOWN_UNSUPPORTED_ELEMENTS: ReadonlySet<string> = new Set([
  'filter',
  'mask',
  'clipPath',
  'pattern',
  'use',
  'symbol',
  'marker',
  'foreignObject',
  'style',
  'script',
])

const PAINT_ATTRIBUTES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
] as const

const TEXT_ATTRIBUTES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'dx',
  'dy',
] as const

const COMMON_ATTRIBUTES = ['id', 'data-name'] as const

function attributeSet(...names: readonly string[]): ReadonlySet<string> {
  return new Set<string>([...COMMON_ATTRIBUTES, ...names])
}

const ATTRIBUTES_BY_ELEMENT: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ['svg', attributeSet('width', 'height', 'viewBox')],
  ['g', attributeSet('data-page', 'data-background')],
  ['defs', attributeSet()],
  ['linearGradient', attributeSet('gradientUnits', 'x1', 'y1', 'x2', 'y2')],
  ['radialGradient', attributeSet('gradientUnits', 'cx', 'cy', 'fx', 'fy', 'r')],
  ['stop', attributeSet('offset', 'stop-color', 'stop-opacity')],
  ['rect', attributeSet('x', 'y', 'width', 'height', 'rx', 'ry', 'transform', ...PAINT_ATTRIBUTES)],
  ['circle', attributeSet('cx', 'cy', 'r', 'transform', ...PAINT_ATTRIBUTES)],
  ['ellipse', attributeSet('cx', 'cy', 'rx', 'ry', 'transform', ...PAINT_ATTRIBUTES)],
  ['line', attributeSet('x1', 'y1', 'x2', 'y2', 'data-head', 'data-tail', 'transform', ...PAINT_ATTRIBUTES)],
  ['polyline', attributeSet('points', 'data-head', 'data-tail', 'transform', ...PAINT_ATTRIBUTES)],
  ['polygon', attributeSet('points', 'data-head', 'data-tail', 'transform', ...PAINT_ATTRIBUTES)],
  ['path', attributeSet('d', 'data-head', 'data-tail', 'transform', ...PAINT_ATTRIBUTES)],
  ['text', attributeSet('x', 'y', ...TEXT_ATTRIBUTES, 'fill', 'fill-opacity', 'opacity', 'transform')],
  ['tspan', attributeSet('x', 'y', ...TEXT_ATTRIBUTES, 'fill', 'fill-opacity', 'opacity')],
  ['image', attributeSet('x', 'y', 'width', 'height', 'href', 'xlink:href', 'opacity', 'transform')],
  ['title', attributeSet()],
  ['desc', attributeSet()],
])

const ARROW_ENDS: ReadonlySet<string> = new Set<ArrowEnd>(['none', 'triangle', 'stealth', 'diamond', 'oval', 'arrow'])
const ARROW_CAPABLE_ELEMENTS: ReadonlySet<string> = new Set(['line', 'polyline', 'path'])
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'])

/* -------------------------------------------------------------------------- */
/* Parser state types                                                         */
/* -------------------------------------------------------------------------- */

type TextAnchor = 'start' | 'middle' | 'end'

interface ElementLocation {
  page?: number
  element?: string
}

interface PageState {
  page: number
  index: number
  /** Flattened `RRGGBB`; paints are composited against this. */
  background: string
  names: Set<string>
}

interface RawStop {
  offset: number
  color: string
  alpha: number
}

interface GradientDefinition {
  kind: 'linear' | 'radial'
  x1: number
  y1: number
  x2: number
  y2: number
  cx: number
  cy: number
  fx: number
  fy: number
  stops: RawStop[]
}

interface TextStyleState {
  fontFamily: string
  fontSizePx: number
  fontWeight: number
  italic: boolean
  /** Unflattened fill colour plus its alpha, so overrides can compose. */
  fillHex: string
  fillAlpha: number
  letterSpacingPx: number
  anchor: TextAnchor
}

interface RawTextRun {
  text: string
  style: TextStyleState
}

interface RawTextLine {
  baselineY: number
  runs: RawTextRun[]
}

interface CollectedText {
  lines: RawTextLine[]
  anchorX: number
}

interface ShapePaints {
  fill: Paint
  stroke?: StrokeSpec
  opacity?: number
}

interface ArrowSpec {
  head: ArrowEnd
  tail: ArrowEnd
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u
const LENGTH_PATTERN = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(px)?$/u

function parseNumber(raw: string): number | undefined {
  const value = raw.trim()
  if (!NUMBER_PATTERN.test(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Canvas-level length: a plain number, optionally suffixed with `px`. */
function parseLength(raw: string): number | undefined {
  const match = LENGTH_PATTERN.exec(raw.trim())
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Gradient coordinates are object-bounding-box fractions and may be written as a percentage. */
function parseFraction(raw: string): number | undefined {
  const value = raw.trim()
  if (value.endsWith('%')) {
    const percent = parseNumber(value.slice(0, -1))
    return percent === undefined ? undefined : percent / 100
  }
  return parseNumber(value)
}

function parseHexColor(raw: string): string | undefined {
  const value = raw.trim()
  if (/^#[0-9a-fA-F]{6}$/u.test(value)) return value.slice(1).toUpperCase()
  if (/^#[0-9a-fA-F]{3}$/u.test(value)) {
    const digits = value.slice(1).toUpperCase()
    const red = digits[0] ?? ''
    const green = digits[1] ?? ''
    const blue = digits[2] ?? ''
    return `${red}${red}${green}${green}${blue}${blue}`
  }
  return undefined
}

function hexChannels(hex: string): [number, number, number] {
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)]
}

function byteToHex(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)))
  return clamped.toString(16).toUpperCase().padStart(2, '0')
}

interface ColorValue {
  hex: string
  alpha: number
}

function parseColorValue(raw: string): ColorValue | undefined {
  const value = raw.trim()
  const hex = parseHexColor(value)
  if (hex !== undefined) return { hex, alpha: 1 }
  const match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/iu.exec(value)
  if (match === null) return undefined
  const red = match[1]
  const green = match[2]
  const blue = match[3]
  const alpha = match[4]
  if (red === undefined || green === undefined || blue === undefined) return undefined
  const channels = [Number(red), Number(green), Number(blue)]
  if (channels.some(channel => channel > 255)) return undefined
  const opacity = alpha === undefined ? 1 : Number(alpha)
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return undefined
  return {
    hex: `${byteToHex(channels[0] ?? 0)}${byteToHex(channels[1] ?? 0)}${byteToHex(channels[2] ?? 0)}`,
    alpha: opacity,
  }
}

/**
 * Composite a translucent paint over the page background. DrawingML carries one
 * alpha per paint while `fill-opacity`, `stop-opacity` and `rgba()` alphas are
 * per colour, so translucent colours are flattened against the page: the
 * rendered colour stays exact on that page and the shape stays self-contained.
 */
function flattenColor(color: ColorValue, background: string): string {
  const alpha = Math.max(0, Math.min(1, color.alpha))
  if (alpha >= 1) return color.hex
  const foreground = hexChannels(color.hex)
  const back = hexChannels(background)
  const mix = (index: 0 | 1 | 2): number => {
    const front = foreground[index]
    const behind = back[index]
    return front * alpha + behind * (1 - alpha)
  }
  return `${byteToHex(mix(0))}${byteToHex(mix(1))}${byteToHex(mix(2))}`
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = hexChannels(hex)
  const linear = (channel: number): number => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/** WCAG large text: 24px, or 18.67px when bold. */
function isLargeText(sizePx: number, weight: number): boolean {
  return sizePx >= 24 || (weight >= 700 && sizePx >= 18.67)
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

function snippet(value: string): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  return collapsed.length > 24 ? `${collapsed.slice(0, 21)}...` : collapsed
}

function translationOf(matrix: Matrix): { dx: number; dy: number } | undefined {
  const [a, b, c, d, e, f] = matrix
  const epsilon = 1e-9
  if (Math.abs(a - 1) > epsilon || Math.abs(d - 1) > epsilon || Math.abs(b) > epsilon || Math.abs(c) > epsilon) return undefined
  return { dx: e, dy: f }
}

function translateBox(box: Box, dx: number, dy: number): Box {
  return { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }
}

function viewBoxMatches(value: string): boolean {
  const parts = value.trim().split(/[\s,]+/u).filter(part => part !== '')
  if (parts.length !== 4) return false
  const numbers = parts.map(part => parseNumber(part))
  const [minX, minY, width, height] = numbers
  if (minX !== 0 || minY !== 0) return false
  if (width === undefined || height === undefined) return false
  return Math.abs(width - SVG_CANVAS_WIDTH) < 1e-6 && Math.abs(height - SVG_CANVAS_HEIGHT) < 1e-6
}

function parseUrlReference(value: string): string | undefined {
  const match = /^url\(\s*['"]?#([A-Za-z_][\w.:-]*)['"]?\s*\)$/u.exec(value.trim())
  return match?.[1]
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

class SvgDeckParser {
  private readonly findings: SvgFinding[] = []
  private readonly gradients = new Map<string, GradientDefinition>()
  private readonly metrics: TextMetrics
  private readonly fonts: readonly string[]

  constructor(options: SvgDeckOptions) {
    this.metrics = options.metrics
    this.fonts = options.fonts
  }

  async run(source: string): Promise<SvgDeckIR> {
    const root = this.parseDocument(source)
    const groups = this.readRoot(root)
    const pages: SvgPageIR[] = []
    if (groups !== undefined) {
      if (groups.length === 0) {
        this.error('SVG_PAGE_MISSING', 'the deck must contain at least one <g data-page="N"> page group', {})
      }
      if (groups.length > SVG_MAX_PAGES) {
        this.error('SVG_PAGE_LIMIT', `the deck has ${groups.length} pages; the maximum is ${SVG_MAX_PAGES}`, {})
      }
      for (let position = 0; position < groups.length; position += 1) {
        const group = groups[position]
        if (group === undefined) continue
        pages.push(await this.readPage(group, position + 1))
      }
    }
    this.throwIfErrors()
    return { pages, findings: this.findings.filter(finding => finding.severity === 'warning') }
  }

  /* ------------------------------ reporting ------------------------------ */

  private error(code: string, message: string, where: ElementLocation): void {
    this.findings.push({ code, severity: 'error', ...where, message })
  }

  private warn(code: string, message: string, where: ElementLocation): void {
    this.findings.push({ code, severity: 'warning', ...where, message })
  }

  private static formatFinding(finding: SvgFinding): string {
    const parts: string[] = []
    if (finding.page !== undefined) parts.push(`page ${finding.page}`)
    if (finding.element !== undefined) parts.push(finding.element)
    return parts.length === 0 ? finding.message : `${parts.join(' ')}: ${finding.message}`
  }

  private throwIfErrors(): void {
    const issues = this.findings
      .filter(finding => finding.severity === 'error')
      .map(finding => SvgDeckParser.formatFinding(finding))
    if (issues.length === 0) return
    throw new PptError('SVG_DECK_INVALID', describeIssues(issues, 8), { details: { issues } })
  }

  /* ------------------------------ structure ------------------------------ */

  private parseDocument(source: string): XmlElement {
    try {
      return parseXml(source)
    } catch (caught) {
      if (caught instanceof XmlParseError) {
        const message = `invalid XML: ${caught.message}`
        throw new PptError('SVG_DECK_INVALID', message, { details: { issues: [message] } })
      }
      throw caught
    }
  }

  private readRoot(root: XmlElement): XmlElement[] | undefined {
    if (root.name !== 'svg') {
      if (root.name.includes(':')) {
        this.error('SVG_ELEMENT_PREFIXED', `element names must be unprefixed; found <${root.name}>`, { element: `<${root.name}>` })
      }
      this.error('SVG_ROOT_INVALID', `the root element must be <svg>, found <${root.name}>`, { element: `<${root.name}>` })
      return undefined
    }
    const rootWhere: ElementLocation = { element: '<svg>' }
    this.checkAttributes(root, rootWhere)
    const viewBox = attributeOf(root, 'viewBox')
    if (viewBox === undefined) {
      this.error('SVG_VIEWBOX_INVALID', 'the root <svg> must declare viewBox="0 0 1280 720"', rootWhere)
    } else if (!viewBoxMatches(viewBox)) {
      this.error('SVG_VIEWBOX_INVALID', `viewBox must be "0 0 1280 720", found "${viewBox}"`, rootWhere)
    }
    this.checkCanvasLength(root, 'width', SVG_CANVAS_WIDTH, rootWhere)
    this.checkCanvasLength(root, 'height', SVG_CANVAS_HEIGHT, rootWhere)

    const groups: XmlElement[] = []
    const seen = new Set<number>()
    for (const node of root.children) {
      if (node.kind === 'text') {
        if (node.value.trim() !== '') {
          this.error('SVG_CONTENT_INVALID', `text is only allowed inside <text>, found "${snippet(node.value)}"`, rootWhere)
        }
        continue
      }
      const name = node.name
      if (name.includes(':')) {
        this.rejectPrefixedElement(node)
        continue
      }
      if (name === 'defs') {
        this.collectGradients(node)
        continue
      }
      if (name === 'title' || name === 'desc') continue
      if (name === 'linearGradient' || name === 'radialGradient' || name === 'stop') {
        this.error('SVG_GRADIENT_LOCATION', 'gradient definitions must live inside <defs>', { element: `<${name}>` })
        continue
      }
      if (name === 'g') {
        const groupWhere: ElementLocation = { element: '<g>' }
        this.checkAttributes(node, groupWhere)
        const pageAttribute = attributeOf(node, 'data-page')
        if (pageAttribute === undefined) {
          this.error('SVG_PAGE_INVALID', 'a top-level <g> must declare data-page="N"', groupWhere)
          continue
        }
        const pageNumber = this.readPageNumber(pageAttribute, groupWhere)
        if (pageNumber === undefined) continue
        const expected = groups.length + 1
        if (seen.has(pageNumber)) {
          this.error('SVG_PAGE_DUPLICATE', `duplicate data-page="${pageNumber}"`, groupWhere)
        } else if (pageNumber !== expected) {
          this.error('SVG_PAGE_ORDER', `pages must be numbered sequentially from 1; expected ${expected}, found ${pageNumber}`, groupWhere)
        }
        seen.add(pageNumber)
        groups.push(node)
        continue
      }
      if (!ALLOWED_ELEMENTS.has(name)) {
        this.rejectElement(node, { element: `<${name}>` })
        continue
      }
      this.error('SVG_PAGE_INVALID', `<${name}> is not inside a page group; wrap content in <g data-page="N">`, { element: `<${name}>` })
    }
    return groups
  }

  private readPageNumber(raw: string, where: ElementLocation): number | undefined {
    const value = parseNumber(raw)
    if (value === undefined || !Number.isInteger(value) || value < 1) {
      this.error('SVG_PAGE_INVALID', `data-page must be a positive integer, found "${raw}"`, where)
      return undefined
    }
    return value
  }

  private checkCanvasLength(root: XmlElement, name: string, expected: number, where: ElementLocation): void {
    const raw = attributeOf(root, name)
    if (raw === undefined) return
    const value = parseLength(raw)
    if (value === undefined) {
      this.error('SVG_VIEWBOX_INVALID', `${name} must be a number in px, found "${raw}"`, where)
      return
    }
    if (Math.abs(value - expected) > 1e-6) {
      this.error('SVG_VIEWBOX_INVALID', `${name} must be ${expected}, found ${raw}`, where)
    }
  }

  private rejectPrefixedElement(element: XmlElement): void {
    this.error('SVG_ELEMENT_PREFIXED', `element names must be unprefixed; found <${element.name}>`, { element: `<${element.name}>` })
  }

  private rejectElement(element: XmlElement, where: ElementLocation): void {
    const name = element.name
    if (name.startsWith('animate')) {
      this.error('SVG_ELEMENT_FORBIDDEN', `<${name}> is not supported: the deck contract has no animation`, where)
      return
    }
    if (KNOWN_UNSUPPORTED_ELEMENTS.has(name)) {
      this.error('SVG_ELEMENT_FORBIDDEN', `<${name}> is not supported: it needs a rasteriser or reference resolution that the exporter does not perform`, where)
      return
    }
    this.error('SVG_ELEMENT_FORBIDDEN', `<${name}> is not part of the SVG deck subset`, where)
  }

  private checkAttributes(element: XmlElement, where: ElementLocation): void {
    if (element.attributes.length > MAX_ATTRIBUTES_PER_ELEMENT) {
      this.error(
        'SVG_ATTRIBUTE_LIMIT',
        `<${element.name}> declares ${element.attributes.length} attributes; the maximum is ${MAX_ATTRIBUTES_PER_ELEMENT}`,
        where,
      )
    }
    const allowed = ATTRIBUTES_BY_ELEMENT.get(element.name)
    for (const attribute of element.attributes) {
      const name = attribute.name
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue
      if (name === 'style') {
        this.error('SVG_STYLE_ATTRIBUTE', 'the style attribute is not supported: inline style is ambiguous, use presentation attributes', where)
        continue
      }
      if (name === 'class') {
        this.error('SVG_ATTRIBUTE_FORBIDDEN', 'the class attribute is not supported: the deck has no stylesheet', where)
        continue
      }
      if (name.includes(':') && name !== 'xlink:href') {
        this.error('SVG_ATTRIBUTE_NAMESPACE', `namespaced attribute "${name}" is not supported`, where)
        continue
      }
      if (allowed === undefined || !allowed.has(name)) {
        this.error('SVG_ATTRIBUTE_FORBIDDEN', `attribute "${name}" is not supported on <${element.name}>`, where)
      }
    }
  }

  /* ------------------------------- pages -------------------------------- */

  private async readPage(group: XmlElement, pageNumber: number): Promise<SvgPageIR> {
    const where: ElementLocation = { page: pageNumber, element: `<g data-page="${pageNumber}">` }
    const backgroundAttribute = attributeOf(group, 'data-background')
    let background: string | undefined
    if (backgroundAttribute !== undefined) {
      const parsed = parseHexColor(backgroundAttribute)
      if (parsed === undefined) {
        this.error('SVG_BACKGROUND_INVALID', `data-background must be a solid #RRGGBB colour, found "${backgroundAttribute}"`, where)
      } else {
        background = parsed
      }
    }
    const state: PageState = {
      page: pageNumber,
      index: 0,
      background: background ?? 'FFFFFF',
      names: new Set<string>(),
    }
    this.readDataName(group, state, where)
    const elements: SvgElement[] = []
    await this.emitChildren(group.children, state, elements, 2)
    if (elements.length === 0) {
      this.warn('SVG_PAGE_EMPTY', 'the page has no drawable elements', where)
    }
    if (elements.length > SVG_MAX_ELEMENTS_PER_PAGE) {
      this.error('SVG_ELEMENT_LIMIT', `the page has ${elements.length} elements; the maximum is ${SVG_MAX_ELEMENTS_PER_PAGE}`, where)
    }
    return { page: pageNumber, ...(background === undefined ? {} : { background }), elements }
  }

  private async emitChildren(nodes: readonly XmlNode[], state: PageState, out: SvgElement[], depth: number): Promise<void> {
    for (const node of nodes) {
      if (node.kind === 'text') {
        if (node.value.trim() !== '') {
          this.error('SVG_CONTENT_INVALID', `text is only allowed inside <text>, found "${snippet(node.value)}"`, { page: state.page })
        }
        continue
      }
      await this.emitElement(node, state, out, depth)
    }
  }

  private async emitElement(node: XmlElement, state: PageState, out: SvgElement[], depth: number): Promise<void> {
    const name = node.name
    const where: ElementLocation = { page: state.page, element: `<${name}>` }
    if (name.includes(':')) {
      this.rejectPrefixedElement(node)
      return
    }
    if (name === 'defs') {
      this.collectGradients(node)
      return
    }
    if (name === 'title' || name === 'desc') return
    if (name === 'linearGradient' || name === 'radialGradient' || name === 'stop') {
      this.error('SVG_GRADIENT_LOCATION', '<stop> and gradients must live inside <defs>', where)
      return
    }
    if (name === 'g') {
      if (depth > MAX_NESTING_DEPTH) {
        this.error('SVG_DEPTH_LIMIT', `element nesting deeper than ${MAX_NESTING_DEPTH} levels is not supported`, where)
        return
      }
      this.checkAttributes(node, where)
      if (attributeOf(node, 'data-page') !== undefined) {
        this.error('SVG_PAGE_NESTED', 'page groups cannot be nested', where)
        return
      }
      if (attributeOf(node, 'data-background') !== undefined) {
        this.error('SVG_ATTRIBUTE_FORBIDDEN', 'data-background is only supported on a page group', where)
      }
      await this.emitChildren(node.children, state, out, depth + 1)
      return
    }
    if (name === 'svg') {
      this.error('SVG_ELEMENT_FORBIDDEN', 'nested <svg> elements are not supported', where)
      return
    }
    if (name === 'tspan') {
      this.error('SVG_CONTENT_INVALID', '<tspan> is only allowed inside <text>', where)
      return
    }
    if (!ALLOWED_ELEMENTS.has(name)) {
      this.rejectElement(node, where)
      return
    }
    if (depth > MAX_NESTING_DEPTH) {
      this.error('SVG_DEPTH_LIMIT', `element nesting deeper than ${MAX_NESTING_DEPTH} levels is not supported`, where)
      return
    }
    this.checkAttributes(node, where)
    switch (name) {
      case 'rect':
      case 'circle':
      case 'ellipse':
      case 'line':
      case 'polyline':
      case 'polygon':
      case 'path':
        this.readShape(node, state, out, where)
        return
      case 'text':
        await this.readText(node, state, out, where)
        return
      case 'image':
        this.readImage(node, state, out, where)
        return
      default:
        this.error('SVG_ELEMENT_FORBIDDEN', `<${name}> is not drawable`, where)
    }
  }

  /* ------------------------------ gradients ------------------------------ */

  private collectGradients(container: XmlElement): void {
    const where: ElementLocation = { element: `<${container.name}>` }
    this.checkAttributes(container, where)
    for (const node of container.children) {
      if (node.kind === 'text') {
        if (node.value.trim() !== '') {
          this.error('SVG_DEFS_INVALID', `<${container.name}> may only contain gradient definitions`, where)
        }
        continue
      }
      if (node.name === 'title' || node.name === 'desc') continue
      if (node.name === 'linearGradient' || node.name === 'radialGradient') {
        this.collectGradient(node)
        continue
      }
      this.error('SVG_DEFS_INVALID', `<${node.name}> is not allowed inside <${container.name}>; only gradients are supported`, {
        element: `<${node.name}>`,
      })
    }
  }

  private collectGradient(node: XmlElement): void {
    const where: ElementLocation = { element: `<${node.name}>` }
    this.checkAttributes(node, where)
    const id = attributeOf(node, 'id')?.trim()
    if (id === undefined || id === '') {
      this.error('SVG_GRADIENT_INVALID', `<${node.name}> requires an id`, where)
      return
    }
    if (this.gradients.has(id)) {
      this.error('SVG_GRADIENT_INVALID', `duplicate gradient id "${id}"`, where)
      return
    }
    const units = attributeOf(node, 'gradientUnits')
    if (units !== undefined) {
      const value = units.trim()
      if (value === 'userSpaceOnUse') {
        this.error('SVG_GRADIENT_UNITS', 'gradientUnits="userSpaceOnUse" is not supported; gradients use objectBoundingBox units', where)
      } else if (value !== 'objectBoundingBox') {
        this.error('SVG_GRADIENT_UNITS', `gradientUnits must be objectBoundingBox, found "${units}"`, where)
      }
    }

    const coordinate = (name: string, fallback: number): number => {
      const raw = attributeOf(node, name)
      if (raw === undefined) return fallback
      const value = parseFraction(raw)
      if (value === undefined) {
        this.error('SVG_GRADIENT_INVALID', `${name} must be a number between 0 and 1, found "${raw}"`, where)
        return fallback
      }
      if (value < 0 || value > 1) {
        this.error('SVG_GRADIENT_INVALID', `${name} must be between 0 and 1; userSpaceOnUse coordinates are not supported`, where)
        return fallback
      }
      return value
    }

    const stops: RawStop[] = []
    for (const child of node.children) {
      if (child.kind === 'text') {
        if (child.value.trim() !== '') {
          this.error('SVG_GRADIENT_STOPS', `<${node.name}> may only contain <stop> children`, where)
        }
        continue
      }
      if (child.name === 'title' || child.name === 'desc') continue
      if (child.name !== 'stop') {
        this.error('SVG_GRADIENT_STOPS', `<${child.name}> is not allowed inside <${node.name}>`, where)
        continue
      }
      const stop = this.readStop(child, stops[stops.length - 1])
      if (stop !== undefined) stops.push(stop)
    }
    if (stops.length < 2) {
      this.error('SVG_GRADIENT_STOPS', `<${node.name}> requires at least two <stop> children`, where)
    }
    // DrawingML accepts at most eight stops per gradient; catching it here names
    // the gradient instead of failing later inside the XML writer.
    if (stops.length > 8) {
      this.error('SVG_GRADIENT_STOPS', `<${node.name}> allows at most eight <stop> children, found ${String(stops.length)}`, where)
    }

    if (node.name === 'linearGradient') {
      this.gradients.set(id, {
        kind: 'linear',
        x1: coordinate('x1', 0),
        y1: coordinate('y1', 0),
        x2: coordinate('x2', 1),
        y2: coordinate('y2', 0),
        cx: 0.5,
        cy: 0.5,
        fx: 0.5,
        fy: 0.5,
        stops,
      })
      return
    }
    const cx = coordinate('cx', 0.5)
    const cy = coordinate('cy', 0.5)
    const radius = attributeOf(node, 'r')
    if (radius !== undefined) {
      const parsed = parseFraction(radius)
      if (parsed === undefined || Math.abs(parsed - 0.5) > 1e-6) {
        this.error('SVG_GRADIENT_INVALID', 'radialGradient r is not supported; the exporter uses a half-box radius', where)
      }
    }
    this.gradients.set(id, {
      kind: 'radial',
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 0,
      cx,
      cy,
      fx: coordinate('fx', cx),
      fy: coordinate('fy', cy),
      stops,
    })
  }

  private readStop(node: XmlElement, previous: RawStop | undefined): RawStop | undefined {
    const where: ElementLocation = { element: '<stop>' }
    this.checkAttributes(node, where)
    const offsetRaw = attributeOf(node, 'offset')
    if (offsetRaw === undefined) {
      this.error('SVG_GRADIENT_STOP_INVALID', '<stop> requires offset', where)
      return undefined
    }
    const offset = parseFraction(offsetRaw)
    if (offset === undefined || offset < 0 || offset > 1) {
      this.error('SVG_GRADIENT_STOP_INVALID', `stop offset must be between 0 and 1, found "${offsetRaw}"`, where)
      return undefined
    }
    if (previous !== undefined && offset < previous.offset - 1e-9) {
      this.error('SVG_GRADIENT_STOP_INVALID', 'stop offsets must not decrease', where)
      return undefined
    }
    const colorRaw = attributeOf(node, 'stop-color')
    let color: ColorValue = { hex: '000000', alpha: 1 }
    if (colorRaw !== undefined) {
      const parsed = parseColorValue(colorRaw)
      if (parsed === undefined) {
        this.error('SVG_GRADIENT_STOP_INVALID', `unsupported stop-color "${colorRaw}"`, where)
        return undefined
      }
      color = parsed
    }
    const opacityRaw = attributeOf(node, 'stop-opacity')
    if (opacityRaw !== undefined) {
      const opacity = parseNumber(opacityRaw)
      if (opacity === undefined || opacity < 0 || opacity > 1) {
        this.error('SVG_GRADIENT_STOP_INVALID', `stop-opacity must be between 0 and 1, found "${opacityRaw}"`, where)
        return undefined
      }
      color = { hex: color.hex, alpha: color.alpha * opacity }
    }
    return { offset, color: color.hex, alpha: color.alpha }
  }

  private buildGradientPaint(id: string, state: PageState, where: ElementLocation): Paint | undefined {
    const definition = this.gradients.get(id)
    if (definition === undefined) {
      this.error('SVG_GRADIENT_MISSING', `gradient "#${id}" is not defined in <defs>`, where)
      return undefined
    }
    if (definition.stops.length < 2) return undefined
    const stops: GradientStop[] = definition.stops.map(stop => ({
      offset: stop.offset,
      color: flattenColor({ hex: stop.color, alpha: stop.alpha }, state.background),
    }))
    if (definition.kind === 'linear') {
      const dx = definition.x2 - definition.x1
      const dy = definition.y2 - definition.y1
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
        this.error('SVG_GRADIENT_INVALID', 'the linear gradient has no direction', where)
        return undefined
      }
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI
      return { type: 'linear', angleDeg: (angle + 360) % 360, stops }
    }
    return { type: 'radial', stops, focusX: definition.fx, focusY: definition.fy }
  }

  /* -------------------------------- paints ------------------------------- */

  private readPaint(node: XmlElement, name: string, state: PageState, where: ElementLocation, fallback: ColorValue | 'none'): Paint {
    const raw = attributeOf(node, name)
    if (raw === undefined) {
      if (fallback === 'none') return { type: 'none' }
      return { type: 'solid', color: flattenColor(fallback, state.background) }
    }
    const value = raw.trim()
    const lower = value.toLowerCase()
    if (lower === 'none' || lower === 'transparent') return { type: 'none' }
    if (lower === 'currentcolor' || lower === 'context-fill' || lower === 'context-stroke') {
      this.error('SVG_PAINT_UNSUPPORTED', `${name}="${raw}" is not supported: the deck has no inherited paint context`, where)
      return { type: 'none' }
    }
    if (lower.startsWith('url(')) {
      const id = parseUrlReference(value)
      if (id === undefined) {
        this.error('SVG_PAINT_INVALID', `unsupported ${name} value "${raw}"; use url(#gradientId)`, where)
        return { type: 'none' }
      }
      return this.buildGradientPaint(id, state, where) ?? { type: 'none' }
    }
    const color = parseColorValue(value)
    if (color === undefined) {
      this.error(
        'SVG_PAINT_INVALID',
        `unsupported ${name} value "${raw}"; use none, transparent, #rgb, #rrggbb, rgb()/rgba() or url(#gradient)`,
        where,
      )
      return { type: 'none' }
    }
    return { type: 'solid', color: flattenColor(color, state.background) }
  }

  private readOpacity(node: XmlElement, where: ElementLocation): number | undefined {
    const raw = attributeOf(node, 'opacity')
    if (raw === undefined) return undefined
    const value = parseNumber(raw)
    if (value === undefined) {
      this.error('SVG_ATTRIBUTE_VALUE', `opacity must be a number, found "${raw}"`, where)
      return undefined
    }
    if (value < 0 || value > 1) {
      this.error('SVG_ATTRIBUTE_VALUE', `opacity must be between 0 and 1, found "${raw}"`, where)
      return undefined
    }
    return value === 1 ? undefined : value
  }

  private readArrows(node: XmlElement, fill: Paint, where: ElementLocation): ArrowSpec {
    const head = this.readArrowEnd(node, 'data-head', where) ?? 'none'
    const tail = this.readArrowEnd(node, 'data-tail', where) ?? 'none'
    const hasEnds = head !== 'none' || tail !== 'none'
    if (hasEnds && !ARROW_CAPABLE_ELEMENTS.has(node.name)) {
      this.error('SVG_ARROW_UNSUPPORTED', 'line ends are only supported on <line>, <polyline> and <path>', where)
    } else if (hasEnds && fill.type !== 'none') {
      this.error('SVG_ARROW_FILLED', 'line ends require fill="none"; PowerPoint ignores line ends on filled geometry', where)
    }
    return { head, tail }
  }

  private readArrowEnd(node: XmlElement, name: string, where: ElementLocation): ArrowEnd | undefined {
    const raw = attributeOf(node, name)
    if (raw === undefined) return undefined
    const value = raw.trim()
    if (!ARROW_ENDS.has(value)) {
      this.error('SVG_ARROW_INVALID', `${name} must be one of none | triangle | stealth | diamond | oval | arrow, found "${raw}"`, where)
      return undefined
    }
    return value as ArrowEnd
  }

  private readStroke(node: XmlElement, state: PageState, where: ElementLocation, arrows: ArrowSpec): StrokeSpec | undefined {
    const paint = this.readPaint(node, 'stroke', state, where, 'none')
    const hasEnds = arrows.head !== 'none' || arrows.tail !== 'none'
    if (paint.type === 'none') {
      if (hasEnds) this.error('SVG_ARROW_NO_STROKE', 'line ends require a visible stroke', where)
      return undefined
    }
    const width = this.optionalNumber(node, 'stroke-width', where) ?? 1
    if (width < 0) {
      this.error('SVG_ATTRIBUTE_VALUE', 'stroke-width must not be negative', where)
      return undefined
    }
    if (width === 0) {
      if (hasEnds) this.error('SVG_ARROW_NO_STROKE', 'line ends require a visible stroke', where)
      return undefined
    }
    let dash: ReturnType<typeof dashFromArray>
    const dashRaw = attributeOf(node, 'stroke-dasharray')
    if (dashRaw !== undefined) {
      try {
        dash = dashFromArray(dashRaw, width)
      } catch (caught) {
        this.error('SVG_DASH_INVALID', `invalid stroke-dasharray "${dashRaw}": ${errorMessage(caught)}`, where)
      }
    }
    const cap = this.readKeyword(node, 'stroke-linecap', where, ['butt', 'round', 'square'])
    const join = this.readKeyword(node, 'stroke-linejoin', where, ['miter', 'round', 'bevel'])
    return {
      paint,
      widthPx: width,
      ...(dash === undefined ? {} : { dash }),
      ...(cap === undefined ? {} : { cap }),
      ...(join === undefined ? {} : { join }),
      ...(arrows.head === 'none' ? {} : { headEnd: arrows.head }),
      ...(arrows.tail === 'none' ? {} : { tailEnd: arrows.tail }),
    }
  }

  private readKeyword<T extends string>(node: XmlElement, name: string, where: ElementLocation, allowed: readonly T[]): T | undefined {
    const raw = attributeOf(node, name)
    if (raw === undefined) return undefined
    const value = raw.trim()
    const match = allowed.find(candidate => candidate === value)
    if (match === undefined) {
      this.error('SVG_ATTRIBUTE_VALUE', `${name} must be one of ${allowed.join(' | ')}, found "${raw}"`, where)
      return undefined
    }
    return match
  }

  /* ------------------------------- shapes -------------------------------- */

  private readShape(node: XmlElement, state: PageState, out: SvgElement[], where: ElementLocation): void {
    const fill = this.readPaint(node, 'fill', state, where, { hex: '000000', alpha: 1 })
    const arrows = this.readArrows(node, fill, where)
    const stroke = this.readStroke(node, state, where, arrows)
    const opacity = this.readOpacity(node, where)
    const paints: ShapePaints = { fill, ...(stroke === undefined ? {} : { stroke }), ...(opacity === undefined ? {} : { opacity }) }
    if (node.name === 'rect' || node.name === 'circle' || node.name === 'ellipse' || node.name === 'line') {
      const geometry = this.readPresetGeometry(node, where)
      if (geometry === undefined) return
      this.pushShape(node, state, out, where, geometry, paints)
      return
    }
    const geometry = this.readPathGeometry(node, where, fill.type !== 'none')
    if (geometry === undefined) return
    this.pushShape(node, state, out, where, geometry, paints)
  }

  private readPresetGeometry(node: XmlElement, where: ElementLocation): ShapeGeometry | undefined {
    const matrix = this.readMatrix(node, where)
    if (matrix === undefined) return undefined
    const translation = translationOf(matrix)
    if (translation === undefined) {
      this.error('SVG_TRANSFORM_UNSUPPORTED', `transform on <${node.name}> supports translate only; rotate, scale and skew are not supported`, where)
      return undefined
    }
    const { dx, dy } = translation
    if (node.name === 'rect') {
      const x = this.optionalNumber(node, 'x', where) ?? 0
      const y = this.optionalNumber(node, 'y', where) ?? 0
      const width = this.requireNumber(node, 'width', where)
      const height = this.requireNumber(node, 'height', where)
      const rx = this.optionalNumber(node, 'rx', where)
      const ry = this.optionalNumber(node, 'ry', where)
      if (width === undefined || height === undefined) return undefined
      if (width < 0 || height < 0) {
        this.error('SVG_GEOMETRY_INVALID', '<rect> width and height must not be negative', where)
        return undefined
      }
      let radius = 0
      if (rx !== undefined || ry !== undefined) {
        const horizontal = rx ?? ry ?? 0
        const vertical = ry ?? rx ?? 0
        if (horizontal < 0 || vertical < 0) {
          this.error('SVG_GEOMETRY_INVALID', '<rect> rx and ry must not be negative', where)
          return undefined
        }
        if (Math.abs(horizontal - vertical) > 1e-6) {
          this.error('SVG_GEOMETRY_UNSUPPORTED', '<rect> rx and ry must match; roundRect has a single corner radius', where)
          return undefined
        }
        radius = horizontal
      }
      const box = translateBox({ x, y, w: width, h: height }, dx, dy)
      if (radius > 0) return { kind: 'preset', preset: 'roundRect', box, radiusPx: radius }
      return { kind: 'preset', preset: 'rect', box }
    }
    if (node.name === 'circle') {
      const cx = this.optionalNumber(node, 'cx', where) ?? 0
      const cy = this.optionalNumber(node, 'cy', where) ?? 0
      const r = this.requireNumber(node, 'r', where)
      if (r === undefined) return undefined
      if (r <= 0) {
        this.error('SVG_GEOMETRY_INVALID', '<circle> r must be positive', where)
        return undefined
      }
      const box = translateBox({ x: cx - r, y: cy - r, w: r * 2, h: r * 2 }, dx, dy)
      return { kind: 'preset', preset: 'ellipse', box }
    }
    if (node.name === 'ellipse') {
      const cx = this.optionalNumber(node, 'cx', where) ?? 0
      const cy = this.optionalNumber(node, 'cy', where) ?? 0
      const rx = this.requireNumber(node, 'rx', where)
      const ry = this.requireNumber(node, 'ry', where)
      if (rx === undefined || ry === undefined) return undefined
      if (rx <= 0 || ry <= 0) {
        this.error('SVG_GEOMETRY_INVALID', '<ellipse> rx and ry must be positive', where)
        return undefined
      }
      const box = translateBox({ x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 }, dx, dy)
      return { kind: 'preset', preset: 'ellipse', box }
    }
    // <line>
    const x1 = this.optionalNumber(node, 'x1', where) ?? 0
    const y1 = this.optionalNumber(node, 'y1', where) ?? 0
    const x2 = this.optionalNumber(node, 'x2', where) ?? 0
    const y2 = this.optionalNumber(node, 'y2', where) ?? 0
    const left = Math.min(x1, x2)
    const top = Math.min(y1, y2)
    const width = Math.abs(x2 - x1)
    const height = Math.abs(y2 - y1)
    if (width === 0 && height === 0) {
      this.error('SVG_GEOMETRY_INVALID', '<line> has zero length', where)
      return undefined
    }
    const box = translateBox({ x: left, y: top, w: width, h: height }, dx, dy)
    return { kind: 'preset', preset: 'line', box, flipH: x2 < x1, flipV: y2 < y1 }
  }

  private readPathGeometry(node: XmlElement, where: ElementLocation, fillable: boolean): ShapeGeometry | undefined {
    let subpaths: SubPath[]
    if (node.name === 'path') {
      const data = attributeOf(node, 'd')
      if (data === undefined) {
        this.error('SVG_ATTRIBUTE_MISSING', '<path> requires d', where)
        return undefined
      }
      try {
        subpaths = parsePathData(data)
      } catch (caught) {
        this.error('SVG_PATH_INVALID', `invalid path data: ${errorMessage(caught)}`, where)
        return undefined
      }
    } else {
      const pointsRaw = attributeOf(node, 'points')
      if (pointsRaw === undefined) {
        this.error('SVG_ATTRIBUTE_MISSING', `<${node.name}> requires points`, where)
        return undefined
      }
      let points
      try {
        points = parsePoints(pointsRaw)
      } catch (caught) {
        this.error('SVG_PATH_INVALID', `invalid points: ${errorMessage(caught)}`, where)
        return undefined
      }
      if (points.length < 2) {
        this.error('SVG_PATH_INVALID', `<${node.name}> requires at least two points`, where)
        return undefined
      }
      try {
        subpaths = polylineToSubPaths(points, node.name === 'polygon')
      } catch (caught) {
        this.error('SVG_PATH_INVALID', `invalid points: ${errorMessage(caught)}`, where)
        return undefined
      }
    }
    const matrix = this.readMatrix(node, where)
    if (matrix === undefined) return undefined
    try {
      const transformed = transformSubPaths(subpaths, matrix)
      const box = pathBounds(transformed)
      if (box === undefined) {
        this.error('SVG_GEOMETRY_INVALID', `<${node.name}> has no drawable bounds`, where)
        return undefined
      }
      return { kind: 'path', subpaths: transformed, box, fillable }
    } catch (caught) {
      this.error('SVG_PATH_INVALID', `invalid geometry: ${errorMessage(caught)}`, where)
      return undefined
    }
  }

  private pushShape(
    node: XmlElement,
    state: PageState,
    out: SvgElement[],
    where: ElementLocation,
    geometry: ShapeGeometry,
    paints: ShapePaints,
  ): void {
    const dataName = this.readDataName(node, state, where)
    state.index += 1
    const id = `page${state.page}-shape-${state.index}`
    const spec: ShapeSpec = {
      id,
      name: dataName ?? node.name,
      geometry,
      fill: paints.fill,
      ...(paints.opacity === undefined ? {} : { opacity: paints.opacity }),
      ...(paints.stroke === undefined ? {} : { stroke: paints.stroke }),
    }
    out.push({ kind: 'shape', id, spec })
    this.warnOutside(geometry.box, where)
  }

  /* -------------------------------- images ------------------------------- */

  private readImage(node: XmlElement, state: PageState, out: SvgElement[], where: ElementLocation): void {
    this.readDataName(node, state, where)
    const href = this.readHref(node, where)
    if (href === undefined) return
    const translation = this.readTranslation(node, where)
    if (translation === undefined) return
    const x = this.optionalNumber(node, 'x', where) ?? 0
    const y = this.optionalNumber(node, 'y', where) ?? 0
    const width = this.requireNumber(node, 'width', where)
    const height = this.requireNumber(node, 'height', where)
    if (width === undefined || height === undefined) return
    if (width <= 0 || height <= 0) {
      this.error('SVG_GEOMETRY_INVALID', '<image> width and height must be positive', where)
      return
    }
    const opacity = this.readOpacity(node, where) ?? 1
    state.index += 1
    const id = `page${state.page}-image-${state.index}`
    const box: Box = { x: x + translation.dx, y: y + translation.dy, w: width, h: height }
    out.push({ kind: 'image', id, box, href, opacity })
    this.warnOutside(box, where)
  }

  private readHref(node: XmlElement, where: ElementLocation): string | undefined {
    const primary = attributeOf(node, 'href')
    const legacy = attributeOf(node, 'xlink:href')
    if (primary !== undefined && legacy !== undefined && primary.trim() !== legacy.trim()) {
      this.error('SVG_IMAGE_INVALID', 'href and xlink:href must agree when both are present', where)
      return undefined
    }
    const raw = primary ?? legacy
    if (raw === undefined) {
      this.error('SVG_ATTRIBUTE_MISSING', '<image> requires href', where)
      return undefined
    }
    const value = raw.trim().replace(/\\/gu, '/')
    if (value === '') {
      this.error('SVG_IMAGE_INVALID', '<image> href must not be empty', where)
      return undefined
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
      this.error('SVG_IMAGE_INVALID', `href must be a relative workspace path, found "${raw}"`, where)
      return undefined
    }
    if (value.startsWith('/')) {
      this.error('SVG_IMAGE_INVALID', `href must be relative to the workspace, found "${raw}"`, where)
      return undefined
    }
    if (value.includes('?') || value.includes('#')) {
      this.error('SVG_IMAGE_INVALID', `href must not carry a query or fragment, found "${raw}"`, where)
      return undefined
    }
    const segments = value.split('/')
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
      this.error('SVG_IMAGE_INVALID', `href must not contain empty, "." or ".." segments, found "${raw}"`, where)
      return undefined
    }
    const dot = value.lastIndexOf('.')
    const extension = dot < 0 ? '' : value.slice(dot + 1).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(extension)) {
      this.error('SVG_IMAGE_INVALID', `href must point to ${[...IMAGE_EXTENSIONS].join(', ')}, found "${raw}"`, where)
      return undefined
    }
    return value
  }

  /* --------------------------------- text -------------------------------- */

  private async readText(node: XmlElement, state: PageState, out: SvgElement[], where: ElementLocation): Promise<void> {
    this.readDataName(node, state, where)
    const translation = this.readTranslation(node, where)
    if (translation === undefined) return
    const base = this.readTextStyle(node, state, undefined)
    const collected = this.collectTextRuns(node, base, state, where, translation)
    if (collected === undefined) return

    const lines: SvgTextLine[] = []
    let unmeasured = false
    for (const rawLine of collected.lines) {
      if (rawLine.runs.length === 0) continue
      const runs: SvgTextRun[] = []
      let width = 0
      let ascent = 0
      let descent = 0
      for (const raw of rawLine.runs) {
        const style = raw.style
        const measurement = await measureTextRun(
          this.metrics,
          { fontFamily: style.fontFamily, fontWeight: style.fontWeight, italic: style.italic, text: raw.text },
          style.fontSizePx,
        )
        const characters = [...raw.text].length
        width += measurement.width + style.letterSpacingPx * Math.max(0, characters - 1)
        ascent = Math.max(ascent, measurement.ascent)
        descent = Math.max(descent, measurement.descent)
        if (!measurement.measured) unmeasured = true
        runs.push({
          text: raw.text,
          fontFamily: style.fontFamily,
          fontSizePx: style.fontSizePx,
          fontWeight: style.fontWeight,
          italic: style.italic,
          color: flattenColor({ hex: style.fillHex, alpha: style.fillAlpha }, state.background),
        })
      }
      lines.push({ baselineY: rawLine.baselineY, runs, width, ascent, descent })
    }
    if (lines.length === 0) {
      this.error('SVG_TEXT_EMPTY', '<text> has no measurable content', where)
      return
    }

    const first = lines[0]
    const last = lines[lines.length - 1]
    if (first === undefined || last === undefined) return
    const maxWidth = lines.reduce((widest, line) => Math.max(widest, line.width), 0)
    const top = first.baselineY - first.ascent
    const bottom = last.baselineY + last.descent
    const anchor = base.anchor
    const box: Box = {
      x: anchor === 'start' ? collected.anchorX : anchor === 'middle' ? collected.anchorX - maxWidth / 2 : collected.anchorX - maxWidth,
      y: top,
      w: maxWidth,
      h: Math.max(0, bottom - top),
    }
    let lineHeightPx = first.ascent + first.descent
    for (let position = 1; position < lines.length; position += 1) {
      const previous = lines[position - 1]
      const line = lines[position]
      if (previous !== undefined && line !== undefined) {
        lineHeightPx = Math.max(lineHeightPx, Math.abs(line.baselineY - previous.baselineY))
      }
    }
    const style: SvgTextStyle = {
      fontFamily: base.fontFamily,
      fontSizePx: base.fontSizePx,
      fontWeight: base.fontWeight,
      italic: base.italic,
      color: flattenColor({ hex: base.fillHex, alpha: base.fillAlpha }, state.background),
      letterSpacingPx: base.letterSpacingPx,
      lineHeightPx,
      anchor,
    }
    state.index += 1
    const id = `page${state.page}-text-${state.index}`
    out.push({ kind: 'text', id, style, box, lines })
    this.warnOutside(box, where)
    if (unmeasured) {
      this.warn('SVG_FONT_NOT_MEASURED', `font "${base.fontFamily}" was not measured by the provider; the text box is an estimate`, where)
    }
    this.warnContrast(lines, state, where)
  }

  private warnContrast(lines: readonly SvgTextLine[], state: PageState, where: ElementLocation): void {
    let worst: { ratio: number; threshold: number; size: number; weight: number } | undefined
    for (const line of lines) {
      for (const run of line.runs) {
        const threshold = isLargeText(run.fontSizePx, run.fontWeight) ? 3 : 4.5
        const ratio = contrastRatio(run.color, state.background)
        if (ratio >= threshold - 1e-9) continue
        if (worst === undefined || ratio < worst.ratio) {
          worst = { ratio, threshold, size: run.fontSizePx, weight: run.fontWeight }
        }
      }
    }
    if (worst === undefined) return
    this.warn(
      'SVG_TEXT_CONTRAST',
      `text contrast ${worst.ratio.toFixed(2)}:1 is below ${worst.threshold}:1 for ${worst.size}px weight ${worst.weight} text`,
      where,
    )
  }

  private readTextStyle(element: XmlElement, state: PageState, inherited: TextStyleState | undefined): TextStyleState {
    const where: ElementLocation = { page: state.page, element: `<${element.name}>` }
    const isTextRoot = element.name === 'text'
    let fontFamily = inherited?.fontFamily
    const familyRaw = attributeOf(element, 'font-family')
    if (familyRaw !== undefined) {
      const resolved = this.resolveFontFamily(familyRaw, where)
      if (resolved !== undefined) fontFamily = resolved
    }
    if (fontFamily === undefined) {
      this.error('SVG_FONT_UNKNOWN', '<text> requires an approved font-family', where)
      fontFamily = this.fonts[0] ?? ''
    }

    let fontSizePx = inherited?.fontSizePx
    const sizeRaw = attributeOf(element, 'font-size')
    if (sizeRaw !== undefined) {
      const size = parseNumber(sizeRaw)
      if (size === undefined) {
        this.error('SVG_FONT_SIZE_INVALID', `font-size must be a unitless number in px, found "${sizeRaw}"`, where)
      } else {
        if (size < SVG_MIN_FONT_PX) {
          this.error('SVG_FONT_SIZE_SMALL', `font-size ${size}px is below the minimum of ${SVG_MIN_FONT_PX}px`, where)
        }
        fontSizePx = size
      }
    }
    if (fontSizePx === undefined) {
      this.error('SVG_FONT_SIZE_INVALID', isTextRoot ? '<text> requires font-size' : '<tspan> requires font-size', where)
      fontSizePx = SVG_MIN_FONT_PX
    }

    let fontWeight = inherited?.fontWeight ?? 400
    const weightRaw = attributeOf(element, 'font-weight')
    if (weightRaw !== undefined) {
      const value = weightRaw.trim()
      const lower = value.toLowerCase()
      if (lower === 'normal') {
        fontWeight = 400
      } else if (lower === 'bold') {
        fontWeight = 700
      } else {
        const numeric = parseNumber(value)
        if (numeric === undefined || !Number.isInteger(numeric) || numeric < 1 || numeric > 1000) {
          this.error('SVG_FONT_WEIGHT_INVALID', `font-weight must be a number or normal | bold, found "${weightRaw}"`, where)
        } else {
          fontWeight = numeric
        }
      }
    }

    let italic = inherited?.italic ?? false
    const fontStyleRaw = attributeOf(element, 'font-style')
    if (fontStyleRaw !== undefined) {
      const value = fontStyleRaw.trim().toLowerCase()
      if (value === 'normal') italic = false
      else if (value === 'italic' || value === 'oblique') italic = true
      else this.error('SVG_FONT_STYLE_INVALID', `font-style must be normal, italic or oblique, found "${fontStyleRaw}"`, where)
    }

    let letterSpacingPx = inherited?.letterSpacingPx ?? 0
    const spacingRaw = attributeOf(element, 'letter-spacing')
    if (spacingRaw !== undefined) {
      const value = spacingRaw.trim()
      if (value === 'normal') {
        letterSpacingPx = 0
      } else {
        const parsed = parseNumber(value)
        if (parsed === undefined) {
          this.error('SVG_TEXT_SPACING', `letter-spacing must be a px number or normal, found "${spacingRaw}"`, where)
        } else {
          letterSpacingPx = parsed
        }
      }
    }

    let fillHex = inherited?.fillHex ?? '000000'
    let fillAlpha = inherited?.fillAlpha ?? 1
    const fillRaw = attributeOf(element, 'fill')
    if (fillRaw !== undefined) {
      const value = fillRaw.trim()
      const lower = value.toLowerCase()
      if (lower === 'none' || lower === 'transparent') {
        fillHex = state.background
        fillAlpha = 1
      } else if (lower.startsWith('url(') || lower === 'currentcolor' || lower.startsWith('context-')) {
        this.error('SVG_PAINT_UNSUPPORTED', `text fill "${fillRaw}" is not supported; use a solid colour`, where)
      } else {
        const parsed = parseColorValue(value)
        if (parsed === undefined) {
          this.error('SVG_PAINT_INVALID', `unsupported fill value "${fillRaw}"`, where)
        } else {
          fillHex = parsed.hex
          fillAlpha = parsed.alpha
        }
      }
    }
    const fillOpacityRaw = attributeOf(element, 'fill-opacity')
    if (fillOpacityRaw !== undefined) {
      const opacity = parseNumber(fillOpacityRaw)
      if (opacity === undefined || opacity < 0 || opacity > 1) {
        this.error('SVG_ATTRIBUTE_VALUE', `fill-opacity must be between 0 and 1, found "${fillOpacityRaw}"`, where)
      } else {
        fillAlpha *= opacity
      }
    }

    // Text has no stroke and no ShapeSpec to carry opacity, so element opacity is
    // composited into the fill colour exactly as fill-opacity is.
    const opacityRaw = attributeOf(element, 'opacity')
    if (opacityRaw !== undefined) {
      const opacity = parseNumber(opacityRaw)
      if (opacity === undefined || opacity < 0 || opacity > 1) {
        this.error('SVG_ATTRIBUTE_VALUE', `opacity must be between 0 and 1, found "${opacityRaw}"`, where)
      } else {
        fillAlpha *= opacity
      }
    }

    let anchor = inherited?.anchor ?? 'start'
    const anchorRaw = attributeOf(element, 'text-anchor')
    if (anchorRaw !== undefined) {
      const value = anchorRaw.trim()
      if (value === 'start' || value === 'middle' || value === 'end') anchor = value
      else this.error('SVG_TEXT_ANCHOR', `text-anchor must be start, middle or end, found "${anchorRaw}"`, where)
    }

    return { fontFamily, fontSizePx, fontWeight, italic, fillHex, fillAlpha, letterSpacingPx, anchor }
  }

  private resolveFontFamily(raw: string, where: ElementLocation): string | undefined {
    const value = raw.trim()
    if (value.includes(',')) {
      this.error('SVG_FONT_UNKNOWN', `font-family must name one approved family, found "${raw}"`, where)
      return undefined
    }
    const exact = this.fonts.find(font => font === value)
    if (exact !== undefined) return exact
    const lower = value.toLowerCase()
    const folded = this.fonts.find(font => font.toLowerCase() === lower)
    if (folded !== undefined) return folded
    const registry = this.fonts.length === 0 ? 'the registry is empty' : this.fonts.join(', ')
    this.error('SVG_FONT_UNKNOWN', `font "${value}" is not in the approved font registry (${registry})`, where)
    return undefined
  }

  private collectTextRuns(
    root: XmlElement,
    base: TextStyleState,
    state: PageState,
    where: ElementLocation,
    translation: { dx: number; dy: number },
  ): CollectedText | undefined {
    const lines: RawTextLine[] = []
    let current: RawTextLine | undefined
    let pendingSpace = false
    const textX = this.optionalNumber(root, 'x', where)
    const textY = this.optionalNumber(root, 'y', where)
    const textDx = this.optionalNumber(root, 'dx', where)
    const textDy = this.optionalNumber(root, 'dy', where)
    if (textDx !== undefined && textX === undefined) this.error('SVG_TEXT_POSITION', 'dx requires x on <text>', where)
    let anchorX = textX === undefined ? undefined : textX + (textDx ?? 0) + translation.dx
    const firstBaseline = textY === undefined ? undefined : textY + (textDy ?? 0) + translation.dy

    const closeLine = (): void => {
      const line = current
      current = undefined
      pendingSpace = false
      if (line === undefined) return
      const last = line.runs[line.runs.length - 1]
      if (last !== undefined) {
        last.text = last.text.replace(/ +$/gu, '')
        if (last.text === '') line.runs.pop()
      }
      if (line.runs.length > 0) lines.push(line)
    }

    const startLine = (baselineY: number): RawTextLine => {
      const line: RawTextLine = { baselineY, runs: [] }
      current = line
      pendingSpace = false
      return line
    }

    const ensureLine = (): RawTextLine | undefined => {
      if (current !== undefined) return current
      if (firstBaseline === undefined) {
        this.error('SVG_TEXT_POSITION', '<text> requires y, or a y on its first line-starting <tspan>', where)
        return undefined
      }
      return startLine(firstBaseline)
    }

    const pushText = (raw: string, style: TextStyleState, elementWhere: ElementLocation): void => {
      const collapsed = raw.replace(/\s+/gu, ' ')
      if (collapsed === '') return
      if (collapsed === ' ') {
        if (current !== undefined && current.runs.length > 0) pendingSpace = true
        return
      }
      const line = ensureLine()
      if (line === undefined) return
      let value = collapsed
      if (pendingSpace && !value.startsWith(' ')) value = ` ${value}`
      pendingSpace = false
      if (value.length > MAX_TEXT_RUN_LENGTH) {
        this.error('SVG_TEXT_LIMIT', `text runs are limited to ${MAX_TEXT_RUN_LENGTH} characters`, elementWhere)
        value = value.slice(0, MAX_TEXT_RUN_LENGTH)
      }
      line.runs.push({ text: value, style })
    }

    const walk = (element: XmlElement, inherited: TextStyleState, isRoot: boolean): void => {
      const elementWhere: ElementLocation = { page: state.page, element: `<${element.name}>` }
      const style = isRoot ? inherited : this.readTextStyle(element, state, inherited)
      if (!isRoot) {
        const anchorRaw = attributeOf(element, 'text-anchor')
        if (anchorRaw !== undefined && anchorRaw.trim() !== base.anchor) {
          this.error('SVG_TEXT_ANCHOR', 'text-anchor must be declared on <text>; per-run anchors are not supported', elementWhere)
        }
        const spacingRaw = attributeOf(element, 'letter-spacing')
        if (spacingRaw !== undefined && Math.abs(style.letterSpacingPx - base.letterSpacingPx) > 1e-9) {
          this.error('SVG_TEXT_SPACING', 'letter-spacing must be declared on <text>; per-run spacing is not supported', elementWhere)
        }
        const x = this.optionalNumber(element, 'x', elementWhere)
        const y = this.optionalNumber(element, 'y', elementWhere)
        const dx = this.optionalNumber(element, 'dx', elementWhere)
        const dy = this.optionalNumber(element, 'dy', elementWhere)
        if (dx !== undefined) this.error('SVG_TEXT_POSITION', 'dx is only supported on <text>', elementWhere)
        if (x !== undefined) {
          const lineX = x + translation.dx
          if (anchorX === undefined) {
            anchorX = lineX
          } else if (Math.abs(anchorX - lineX) > 1e-6) {
            this.error('SVG_TEXT_POSITION', 'per-line x is not supported; every line shares the <text> x', elementWhere)
          }
        }
        if (y !== undefined) {
          closeLine()
          startLine(y + (dy ?? 0) + translation.dy)
        } else if (dy !== undefined) {
          this.error('SVG_TEXT_POSITION', 'dy is only supported on <text> or a line-starting <tspan>', elementWhere)
        }
      }
      for (const child of element.children) {
        if (child.kind === 'text') {
          pushText(child.value, style, elementWhere)
          continue
        }
        if (child.name === 'tspan') {
          walk(child, style, false)
          continue
        }
        if (child.name === 'title' || child.name === 'desc') continue
        this.error('SVG_CONTENT_INVALID', `<${child.name}> is not allowed inside <${element.name}>`, {
          page: state.page,
          element: `<${child.name}>`,
        })
      }
    }

    walk(root, base, true)
    closeLine()

    if (lines.length === 0) {
      this.error('SVG_TEXT_EMPTY', '<text> has no text content', where)
      return undefined
    }
    if (anchorX === undefined) {
      this.error('SVG_TEXT_POSITION', '<text> requires x, or an x on its first line-starting <tspan>', where)
      return undefined
    }
    return { lines, anchorX }
  }

  /* ------------------------------- naming -------------------------------- */

  private readDataName(node: XmlElement, state: PageState, where: ElementLocation): string | undefined {
    const raw = attributeOf(node, 'data-name')
    if (raw === undefined) return undefined
    const name = raw.trim()
    if (name === '') {
      this.error('SVG_NAME_INVALID', 'data-name must not be empty', where)
      return undefined
    }
    if (state.names.has(name)) {
      this.error('SVG_NAME_DUPLICATE', `duplicate data-name "${name}" on this page`, where)
      return undefined
    }
    state.names.add(name)
    return name
  }

  /* ------------------------------ transforms ----------------------------- */

  private readMatrix(node: XmlElement, where: ElementLocation): Matrix | undefined {
    const raw = attributeOf(node, 'transform')
    if (raw === undefined) return IDENTITY_MATRIX
    try {
      return parseTransform(raw)
    } catch (caught) {
      this.error('SVG_TRANSFORM_INVALID', `invalid transform "${raw}": ${errorMessage(caught)}`, where)
      return undefined
    }
  }

  private readTranslation(node: XmlElement, where: ElementLocation): { dx: number; dy: number } | undefined {
    const matrix = this.readMatrix(node, where)
    if (matrix === undefined) return undefined
    const translation = translationOf(matrix)
    if (translation === undefined) {
      this.error('SVG_TRANSFORM_UNSUPPORTED', `transform on <${node.name}> supports translate only; rotate, scale and skew are not supported`, where)
      return undefined
    }
    return translation
  }

  /* -------------------------------- numbers ------------------------------ */

  private optionalNumber(node: XmlElement, name: string, where: ElementLocation): number | undefined {
    const raw = attributeOf(node, name)
    if (raw === undefined) return undefined
    const value = parseNumber(raw)
    if (value === undefined) {
      this.error('SVG_ATTRIBUTE_VALUE', `${name} must be a unitless number, found "${raw}"`, where)
      return undefined
    }
    return value
  }

  private requireNumber(node: XmlElement, name: string, where: ElementLocation): number | undefined {
    const raw = attributeOf(node, name)
    if (raw === undefined) {
      this.error('SVG_ATTRIBUTE_MISSING', `<${node.name}> requires ${name}`, where)
      return undefined
    }
    return this.optionalNumber(node, name, where)
  }

  /* ------------------------------- warnings ------------------------------ */

  private warnOutside(box: Box, where: ElementLocation): void {
    if (box.x < -1 || box.y < -1 || box.x + box.w > SVG_CANVAS_WIDTH + 1 || box.y + box.h > SVG_CANVAS_HEIGHT + 1) {
      this.warn('SVG_OUT_OF_CANVAS', 'the element box extends outside the 1280x720 canvas', where)
    }
  }
}

/**
 * Parse and validate one deck. Throws `PptError('SVG_DECK_INVALID')` carrying
 * every blocking finding in `details.issues`; warnings are returned on the IR.
 */
export async function parseSvgDeck(source: string, options: SvgDeckOptions): Promise<SvgDeckIR> {
  return new SvgDeckParser(options).run(source)
}

/** Measurement helper shared by the parser and its tests. */
export async function measureTextRun(
  metrics: TextMetrics,
  run: Pick<SvgTextRun, 'fontFamily' | 'fontWeight' | 'italic' | 'text'>,
  sizePx: number,
): Promise<TextMeasurement> {
  return metrics.measure({ family: run.fontFamily, weight: run.fontWeight, italic: run.italic, sizePx, text: run.text })
}
