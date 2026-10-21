/**
 * Fast lane: `outline.json` (+ `design-plan.json`) -> `DeckIR`.
 *
 * The HTML lane exists so a model can art-direct a deck no template would have
 * produced. That freedom costs a full authoring pass: a 1280x720 static HTML
 * document, a browser render per page, and an iteration loop on the `RUI_*`
 * findings. When the brief is "give me the deck, fast", that cost buys nothing
 * the content model does not already carry.
 *
 * This module is the deterministic alternative. It reads the same validated
 * outline and the same Art Direction plan the HTML lane reads and lays the
 * pages out with code: one type scale, one spacing rhythm, the palette and
 * typography from the plan (or each slide's own accent), and a fixed set of
 * page families covering every layout the outline schema allows. No DOM, no
 * browser, no model round trip.
 *
 * It is deliberately not a second design system: the colours, families and type
 * scale are the ones the plugin already documents, so a fast-lane deck and an
 * HTML-lane deck of the same brief read as the same product.
 */
import { PptError } from './errors.ts'
import { isPathInside, resolveWorkspacePath } from './paths.ts'
import type { ArtDirection } from './art-direction.ts'
import type { PptOutline } from './outline.ts'
import {
  SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX,
  type DeckIR, type ElementBox, type ElementIR, type ElementStyleIR, type SlideIR,
} from './ir.ts'

/** Canvas geometry, documented once here because every page family uses it. */
export const MARGIN_X = 72
export const MARGIN_Y = 64
export const CONTENT_W = SLIDE_WIDTH_PX - MARGIN_X * 2
export const CONTENT_H = SLIDE_HEIGHT_PX - MARGIN_Y * 2
export const BOTTOM = SLIDE_HEIGHT_PX - MARGIN_Y
/** Group separation must always exceed intra-group separation. */
const GAP_ITEM = 26

/** The documented type scale. Each entry is px on the 1280x720 canvas. */
export const TYPE_SCALE = {
  poster: 72,
  section: 56,
  title: 44,
  lead: 26,
  body: 24,
  bodySmall: 21,
  small: 16,
  metric: 88,
} as const

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/u

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export interface Rgb { r: number; g: number; b: number }

export function parseHex(value: string): Rgb {
  const match = /^#([0-9A-Fa-f]{6})$/u.exec(value.trim())
  if (match === null) return { r: 17, g: 19, b: 24 }
  const digits = match[1]!
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  }
}

/** Parse either `#RRGGBB` or the `rgb(r, g, b)` form the IR carries. */
export function parseColor(value: string): Rgb {
  const css = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/iu.exec(value.trim())
  if (css === null) return parseHex(value)
  return { r: Number(css[1]), g: Number(css[2]), b: Number(css[3]) }
}

export function toCssColor(color: Rgb): string {
  return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`
}

export function relativeLuminance(color: Rgb): number {
  const channel = (value: number): number => {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** Linear blend: `ratio` 0 -> `from`, 1 -> `to`. */
export function mix(from: Rgb, to: Rgb, ratio: number): Rgb {
  const t = Math.min(1, Math.max(0, ratio))
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
  }
}

/** Push `color` toward white or black until it clears `target` contrast on `field`. */
export function ensureContrast(color: Rgb, field: Rgb, target: number): Rgb {
  if (contrastRatio(color, field) >= target) return color
  const toward = relativeLuminance(field) > 0.4 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
  let candidate = color
  for (let step = 1; step <= 20; step += 1) {
    candidate = mix(color, toward, step / 20)
    if (contrastRatio(candidate, field) >= target) return candidate
  }
  return candidate
}

export interface PagePalette {
  background: string
  ink: string
  muted: string
  rule: string
  accent: string
  surface: string
  isDark: boolean
}

const DEFAULT_LIGHT = '#F7F5F0'
const DEFAULT_DARK = '#111318'

function pickInk(background: Rgb, candidates: readonly string[]): Rgb {
  const darkest: Rgb = { r: 17, g: 19, b: 24 }
  const lightest: Rgb = { r: 255, g: 255, b: 255 }
  const usable = candidates.map(parseHex).sort((a, b) => contrastRatio(b, background) - contrastRatio(a, background))
  const best = usable[0]
  if (best !== undefined && contrastRatio(best, background) >= 7) return best
  return contrastRatio(darkest, background) >= contrastRatio(lightest, background) ? darkest : lightest
}

export function paletteFor(
  backgroundRole: 'light' | 'dark' | 'accent' | 'image',
  accentValue: string,
  plan: ArtDirection | undefined,
): PagePalette {
  const palette = plan?.palette
  const backgrounds = palette?.background ?? [DEFAULT_LIGHT, DEFAULT_DARK]
  const surfaces = palette?.surface ?? ['#FFFFFF']
  const texts = palette?.text ?? ['#111318', '#FFFFFF']
  const planAccent = palette?.accent ?? accentValue
  const backgroundHex = backgroundRole === 'light'
    ? backgrounds[0] ?? DEFAULT_LIGHT
    : backgroundRole === 'dark' || backgroundRole === 'image'
      ? backgrounds[1] ?? backgrounds[0] ?? DEFAULT_DARK
      : planAccent
  const background = parseHex(backgroundHex)
  const declaredAccent = parseHex(accentValue)
  // The outline's per-slide accent is what the deck declares for that page; the
  // plan accent is the deck-wide default. Either must stay legible on this field.
  const accent = ensureContrast(contrastRatio(declaredAccent, background) >= 3 ? declaredAccent : parseHex(planAccent), background, 3)
  // A saturated accent field rarely offers 7:1 to any ink; 4.5:1 is the floor
  // that matters there, and white or near-black is chosen by contrast anyway.
  const inkSource = backgroundRole === 'accent'
    ? ensureContrast(pickInk(background, texts), background, 4.5)
    : pickInk(background, texts)
  // Secondary copy keeps its own floor so a quote lead on an accent page is
  // still readable instead of fading into the field.
  const mutedSource = ensureContrast(mix(inkSource, background, 0.35), background, 3)
  const surfaceHex = surfaces.find(candidate => contrastRatio(parseHex(candidate), background) > 1.03)
  const surface = surfaceHex === undefined
    ? mix(background, relativeLuminance(background) > 0.4 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }, 0.05)
    : parseHex(surfaceHex)
  return {
    background: toCssColor(background),
    ink: toCssColor(inkSource),
    muted: toCssColor(mutedSource),
    rule: toCssColor(mix(inkSource, background, 0.78)),
    accent: toCssColor(accent),
    surface: toCssColor(surface),
    isDark: relativeLuminance(background) <= 0.4,
  }
}

// ---------------------------------------------------------------------------
// Text metrics
// ---------------------------------------------------------------------------

/** Average advance width of one character, in em. Deliberately generous. */
function advance(char: string): number {
  if (CJK.test(char)) return 1
  if (char === ' ') return 0.3
  if ('iljI.,;:\'!|`'.includes(char)) return 0.3
  if ('mwMW@%'.includes(char)) return 0.9
  if (/[0-9]/u.test(char)) return 0.58
  return 0.56
}

function tokens(text: string): string[] {
  return text.match(/[A-Za-z0-9@#$%&*_+=<>~^|\\/.,;:'"()[\]{}-]+|\s+|./gsu) ?? []
}

/**
 * Greedy wrap used only to *size* a text box: PowerPoint re-wraps on its own,
 * so the estimate errs wide (7%) to guarantee the box is tall enough.
 */
export function wrapText(text: string, fontPx: number, widthPx: number): string[] {
  const limit = Math.max(1, widthPx * 0.93)
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/u)) {
    let line = ''
    let width = 0
    for (const token of tokens(paragraph)) {
      const tokenWidth = [...token].reduce((total, char) => total + advance(char) * fontPx, 0)
      if (/^\s+$/u.test(token) && line.length === 0) continue
      if (line.length > 0 && width + tokenWidth > limit) {
        lines.push(line.trimEnd())
        line = ''
        width = 0
        if (/^\s+$/u.test(token)) continue
      }
      if (tokenWidth > limit && line.length === 0) {
        // A single unbreakable token: hard-split so the estimate stays honest.
        let buffer = ''
        let bufferWidth = 0
        for (const char of token) {
          const charWidth = advance(char) * fontPx
          if (bufferWidth + charWidth > limit && buffer.length > 0) {
            lines.push(buffer)
            buffer = ''
            bufferWidth = 0
          }
          buffer += char
          bufferWidth += charWidth
        }
        line = buffer
        width = bufferWidth
        continue
      }
      line += token
      width += tokenWidth
    }
    lines.push(line.trimEnd())
  }
  const kept = lines.filter(line => line.length > 0)
  return kept.length > 0 ? kept : ['']
}

export function measureText(text: string, fontPx: number, widthPx: number, lineHeight: number): number {
  const lines = Math.max(1, wrapText(text, fontPx, widthPx).length)
  return Math.ceil(lines * fontPx * lineHeight) + 4
}

/** Step a display size down when the longest unbreakable run would not fit. */
export function fitDisplay(text: string, base: number, widthPx: number, min: number): number {
  const longest = tokens(text).reduce((total, token) => {
    if (/^\s+$/u.test(token)) return total
    return total + [...token].reduce((sum, char) => sum + advance(char), 0)
  }, 0)
  if (longest <= 0 || longest * base <= widthPx * 0.93) return base
  return Math.max(min, Math.min(base, Math.floor((widthPx * 0.93) / longest)))
}

// ---------------------------------------------------------------------------
// Element factory
// ---------------------------------------------------------------------------

interface TextStyleOptions {
  font: string
  size: number
  weight: number
  color: string
  lineHeight: number
  /** Tracking in em; negative tightens display type. */
  tracking?: number
  align?: 'left' | 'center' | 'right' | 'justify'
  valign?: 'top' | 'middle' | 'bottom'
  opacity?: number
}

function styleOf(options: TextStyleOptions): ElementStyleIR {
  return {
    fontFamily: options.font,
    fontSizePx: options.size,
    fontWeight: options.weight,
    fontStyle: 'normal',
    color: options.color,
    backgroundColor: 'transparent',
    backgroundImage: 'none',
    borderColor: 'transparent',
    borderWidthPx: 0,
    borderStyle: 'none',
    borderRadius: '0px',
    textAlign: options.align ?? 'left',
    verticalAlign: options.valign ?? 'top',
    lineHeightPx: options.size * options.lineHeight,
    letterSpacingPx: options.size * (options.tracking ?? 0),
    textTransform: 'none',
    rotationDeg: 0,
    opacity: options.opacity ?? 1,
    objectFit: 'cover',
    objectPosition: 'center center',
  }
}

interface Builder {
  page: number
  elements: ElementIR[]
  counter: number
}

function nextId(builder: Builder, role: string): string {
  builder.counter += 1
  return `p${builder.page}-${role}-${String(builder.counter).padStart(2, '0')}`
}

function pushText(builder: Builder, role: string, box: ElementBox, text: string, options: TextStyleOptions): number {
  const height = Math.max(box.h, measureText(text, options.size, box.w, options.lineHeight))
  builder.elements.push({
    id: nextId(builder, role),
    kind: 'text',
    z: builder.elements.length,
    domOrder: builder.elements.length,
    box: { x: box.x, y: box.y, w: box.w, h: height },
    style: styleOf(options),
    text,
  })
  return height
}

function pushRect(builder: Builder, role: string, box: ElementBox, fill: string, opacity = 1): void {
  builder.elements.push({
    id: nextId(builder, role),
    kind: 'shape',
    z: builder.elements.length,
    domOrder: builder.elements.length,
    box,
    style: {
      ...styleOf({ font: 'Arial', size: 12, weight: 400, color: fill, lineHeight: 1 }),
      backgroundColor: fill,
      opacity,
    },
  })
}

function pushImage(builder: Builder, role: string, box: ElementBox, imagePath: string): void {
  builder.elements.push({
    id: nextId(builder, role),
    kind: 'image',
    z: builder.elements.length,
    domOrder: builder.elements.length,
    box,
    style: { ...styleOf({ font: 'Arial', size: 12, weight: 400, color: '#000000', lineHeight: 1 }), objectFit: 'cover' },
    imagePath,
  })
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

type Slide = PptOutline[number]
type OutlineItem = Slide['content'][number]
type VisibleItem = Exclude<OutlineItem, { kind: 'note' }>
type PointItem = Extract<VisibleItem, { kind: 'point' }>
type DataItem = Extract<VisibleItem, { kind: 'data' }>
type ImageItem = Extract<VisibleItem, { kind: 'image' }>

function visibleItems(slide: Slide): VisibleItem[] {
  return slide.content.filter((item): item is VisibleItem => item.kind !== 'note')
}

function speakerNotes(slide: Slide): string[] {
  return slide.content.flatMap(item => item.kind === 'note' && item.purpose === 'speaker' ? [item.text] : [])
}

function pointsOf(slide: Slide): PointItem[] {
  return visibleItems(slide).filter((item): item is PointItem => item.kind === 'point')
}

function dataOf(slide: Slide): DataItem[] {
  return visibleItems(slide).filter((item): item is DataItem => item.kind === 'data')
}

function imageOf(slide: Slide): ImageItem | undefined {
  return visibleItems(slide).find((item): item is ImageItem => item.kind === 'image' && item.role !== 'background')
}

/** One line of displayable copy for any content item, used by the text stacks. */
function itemText(item: VisibleItem): string {
  switch (item.kind) {
    case 'point': return item.text
    case 'data': return `${item.label} ${item.value}${item.unit === undefined ? '' : item.unit}`
    case 'image': return item.caption ?? item.intent
    case 'chart': return `${item.subject} — ${item.takeaway}`
    default: return ''
  }
}

function itemLabel(item: VisibleItem): string | undefined {
  if (item.kind === 'point' && item.label !== undefined) return item.label
  if (item.kind === 'data' && item.note !== undefined) return item.note
  return undefined
}

// ---------------------------------------------------------------------------
// Page families
// ---------------------------------------------------------------------------

interface PageFonts { display: string; body: string; latin: string }

interface PageContext {
  builder: Builder
  slide: Slide
  palette: PagePalette
  fonts: PageFonts
  page: number
  total: number
}

function footer(context: PageContext): void {
  const { builder, palette, fonts } = context
  // Sits inside the bottom margin so a one-line folio never reaches the canvas
  // edge: y + the measured line box stays above BOTTOM.
  pushText(builder, 'folio', { x: MARGIN_X + CONTENT_W - 120, y: BOTTOM - 26, w: 120, h: 16 },
    `${String(context.page).padStart(2, '0')} / ${String(context.total).padStart(2, '0')}`,
    { font: fonts.latin, size: TYPE_SCALE.small - 2, weight: 500, color: palette.muted, lineHeight: 1.2, align: 'right' })
}

function eyebrow(context: PageContext, label: string): void {
  const { builder, palette, fonts } = context
  pushText(builder, 'eyebrow', { x: MARGIN_X, y: MARGIN_Y, w: 640, h: 18 }, label.toUpperCase(),
    { font: fonts.latin, size: TYPE_SCALE.small, weight: 600, color: palette.accent, lineHeight: 1.3, tracking: 0.08 })
}

/** Title block for every non-poster page: eyebrow, display title, hairline rule. */
function pageHeader(context: PageContext, label: string): number {
  const { builder, slide, palette, fonts } = context
  eyebrow(context, label)
  const size = fitDisplay(slide.title, TYPE_SCALE.title, CONTENT_W - 160, 30)
  const titleY = MARGIN_Y + 34
  const titleHeight = pushText(builder, 'title', { x: MARGIN_X, y: titleY, w: CONTENT_W - 160, h: 0 }, slide.title,
    { font: fonts.display, size, weight: 700, color: palette.ink, lineHeight: 1.2, tracking: -0.02 })
  const ruleY = titleY + titleHeight + 22
  pushRect(builder, 'rule', { x: MARGIN_X, y: ruleY, w: CONTENT_W, h: 2 }, palette.rule)
  return ruleY + 30
}

/**
 * Short pages otherwise leave their copy hanging under the header with a hole
 * below it. Nudge the body band down by a fraction of the free space so the
 * page reads as a composition instead of a paragraph pinned to the top. The
 * shift never pushes anything past the bottom margin.
 */
/** Divider rules are drawn to the band they separate, never to a fixed guess. */
function isDivider(element: ElementIR): boolean {
  return element.id.includes('-divider-')
}

function contentBottom(builder: Builder, fromIndex: number): number {
  const content = builder.elements.slice(fromIndex).filter(element => !isDivider(element))
  if (content.length === 0) return builder.elements[fromIndex - 1]?.box.y ?? MARGIN_Y
  return Math.max(...content.map(element => element.box.y + element.box.h))
}

function recenterBody(builder: Builder, fromIndex: number, bias = 0.4): void {
  const band = builder.elements.slice(fromIndex)
  if (band.length === 0) return
  const free = BOTTOM - 26 - contentBottom(builder, fromIndex)
  if (free <= 12) return
  const delta = Math.round(Math.min(free * bias, free))
  if (delta <= 0) return
  for (const element of band) element.box.y += delta
}

function slideResult(context: PageContext, background: string): SlideIR {
  return {
    page: context.page,
    elements: context.builder.elements,
    speakerNotes: speakerNotes(context.slide),
    background: { color: background, image: 'none' },
  }
}

function posterPage(context: PageContext): SlideIR {
  const { builder, slide, palette, fonts } = context
  const points = pointsOf(slide)
  const isSection = slide.type === 'section'
  const isQuote = slide.type === 'quote'
  const titleWidth = CONTENT_W - 120
  const titleSize = fitDisplay(slide.title, isSection ? TYPE_SCALE.section : TYPE_SCALE.poster, titleWidth, 36)
  const titleLineHeight = 1.12
  const titleLines = wrapText(slide.title, titleSize, titleWidth)
  const titleHeight = Math.ceil(titleLines.length * titleSize * titleLineHeight) + 4
  // A lead that only repeats the title is noise, not support.
  const firstPoint = points[0]?.text.trim()
  const lead = firstPoint === undefined || firstPoint === slide.title.trim() ? undefined : firstPoint
  const leadWidth = CONTENT_W - 260
  const leadHeight = lead === undefined ? 0 : measureText(lead, TYPE_SCALE.lead, leadWidth, 1.5)
  const indexBlock = isSection ? 96 : 0
  const blockHeight = indexBlock + 26 + titleHeight + (leadHeight > 0 ? 30 + leadHeight : 0)
  const startY = Math.max(MARGIN_Y + 56, Math.round((SLIDE_HEIGHT_PX - blockHeight) / 2) - 16)
  let y = startY
  if (isSection) {
    pushText(builder, 'index', { x: MARGIN_X, y, w: 220, h: 88 }, String(context.page).padStart(2, '0'),
      { font: fonts.latin, size: TYPE_SCALE.metric - 8, weight: 700, color: palette.accent, lineHeight: 1 })
    y += indexBlock
  }
  pushRect(builder, 'accent-rule', { x: MARGIN_X, y: y - (isSection ? 40 : 26), w: 96, h: 6 }, palette.accent)
  pushText(builder, 'title', { x: MARGIN_X, y, w: titleWidth, h: titleHeight }, slide.title,
    { font: fonts.display, size: titleSize, weight: 700, color: palette.ink, lineHeight: titleLineHeight, tracking: -0.025 })
  y += titleHeight
  if (lead !== undefined) {
    y += 30
    pushText(builder, 'lead', { x: MARGIN_X, y, w: leadWidth, h: leadHeight }, lead,
      { font: fonts.body, size: TYPE_SCALE.lead, weight: 400, color: palette.muted, lineHeight: 1.5 })
    y += leadHeight
  }
  if (isQuote && points.length > 1) {
    pushText(builder, 'attribution', { x: MARGIN_X, y: y + 26, w: leadWidth, h: 24 }, points[1]!.text,
      { font: fonts.body, size: TYPE_SCALE.small + 2, weight: 500, color: palette.accent, lineHeight: 1.4 })
  }
  footer(context)
  return slideResult(context, palette.background)
}

interface StackOptions {
  size: number
  gap: number
  labelSize: number
  width: number
  emphasisSize?: number
}

/** Stack content items vertically inside a band; returns the y after the last one. */
function stackItems(context: PageContext, items: readonly VisibleItem[], x: number, y: number, limit: number, options: StackOptions): number {
  const { builder, palette, fonts } = context
  let cursor = y
  for (const item of items) {
    if (cursor > limit) break
    const label = itemLabel(item)
    const emphasis = item.kind === 'point' && item.emphasis
    if (label !== undefined) {
      cursor += pushText(builder, 'label', { x, y: cursor, w: options.width, h: 16 }, label.toUpperCase(),
        { font: fonts.latin, size: options.labelSize, weight: 600, color: palette.accent, lineHeight: 1.3, tracking: 0.06 }) + 8
    }
    const text = itemText(item)
    if (text.length === 0) continue
    const size = emphasis && options.emphasisSize !== undefined ? options.emphasisSize : options.size
    // Authored copy is the page's message and stays at full ink; derived items
    // (data, captions, chart takeaways) are supporting and step back to muted.
    const primary = item.kind === 'point'
    cursor += pushText(builder, 'body', { x, y: cursor, w: options.width, h: 0 }, text,
      { font: fonts.body, size, weight: emphasis ? 600 : 400, color: primary || emphasis ? palette.ink : palette.muted, lineHeight: 1.55 }) + options.gap
  }
  return cursor
}

function statementPage(context: PageContext): SlideIR {
  const { builder, slide, palette } = context
  const items = visibleItems(slide)
  const top = pageHeader(context, slide.type === 'summary' ? 'Summary' : 'Key points')
  const bodyStart = builder.elements.length
  const area = BOTTOM - top
  const columns = items.length > 4 ? 2 : 1
  const width = columns === 1 ? CONTENT_W - 200 : (CONTENT_W - 64) / 2
  const size = items.length <= 2 ? TYPE_SCALE.lead + 2 : columns === 1 ? TYPE_SCALE.body : TYPE_SCALE.bodySmall
  const limit = top + area
  if (columns === 1) {
    stackItems(context, items, MARGIN_X, top, limit, {
      size, gap: GAP_ITEM, labelSize: TYPE_SCALE.small, width, emphasisSize: TYPE_SCALE.lead + 4,
    })
  } else {
    const half = Math.ceil(items.length / 2)
    stackItems(context, items.slice(0, half), MARGIN_X, top, limit, { size, gap: GAP_ITEM - 4, labelSize: TYPE_SCALE.small, width })
    stackItems(context, items.slice(half), MARGIN_X + width + 64, top, limit, { size, gap: GAP_ITEM - 4, labelSize: TYPE_SCALE.small, width })
  }
  if (columns > 1) {
    const ruleHeight = Math.max(0, contentBottom(builder, bodyStart) - top)
    pushRect(builder, 'divider', { x: MARGIN_X + width + 31, y: top, w: 2, h: Math.max(0, Math.min(area, ruleHeight)) }, palette.rule)
  }
  recenterBody(builder, bodyStart)
  footer(context)
  return slideResult(context, palette.background)
}

function columnsPage(context: PageContext): SlideIR {
  const { builder, slide, palette, fonts } = context
  const items = visibleItems(slide)
  const top = pageHeader(context, slide.type === 'agenda' ? 'Agenda' : slide.type === 'comparison' ? 'Comparison' : 'Detail')
  const groups = new Map<string, VisibleItem[]>()
  for (const item of items) {
    const key = 'group' in item && item.group !== undefined ? item.group : ''
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  let columns = Math.max(2, Math.min(3, groups.size > 1 ? groups.size : slide.style.layout === 'three-column' ? 3 : 2))
  if (items.length <= 3) columns = Math.max(2, Math.min(columns, items.length))
  const gap = 56
  const width = (CONTENT_W - gap * (columns - 1)) / columns
  // A comparison declares its groups; the group name is that column's heading,
  // so it belongs on the page instead of only in the bucketing logic.
  const named = groups.size > 1 && groups.size <= 3
  const buckets: Array<{ name?: string; items: VisibleItem[] }> = named
    ? [...groups.entries()].map(([name, bucket]) => ({ ...(name.length === 0 ? {} : { name }), items: bucket }))
    : Array.from({ length: columns }, (_, index) => ({
      items: items.slice(Math.floor((items.length * index) / columns), Math.floor((items.length * (index + 1)) / columns)),
    }))
  const bodyStart = builder.elements.length
  // Sparse columns earn a larger body size; dense ones step down. The page then
  // fills its band instead of leaving a hole under three short lines.
  const perColumn = Math.max(1, buckets.reduce((most, bucket) => Math.max(most, bucket.items.length), 1))
  const bodySize = perColumn <= 2 ? TYPE_SCALE.lead : perColumn <= 4 ? TYPE_SCALE.body : TYPE_SCALE.bodySmall
  buckets.forEach((bucket, index) => {
    const x = MARGIN_X + index * (width + gap)
    let columnTop = top
    if (bucket.name !== undefined) {
      columnTop += pushText(builder, 'group', { x, y: top, w: width, h: 16 }, bucket.name.toUpperCase(),
        { font: fonts.latin, size: TYPE_SCALE.small, weight: 600, color: palette.ink, lineHeight: 1.3, tracking: 0.06 }) + 14
    }
    stackItems(context, bucket.items, x, columnTop, BOTTOM - 24, { size: bodySize, gap: bodySize <= TYPE_SCALE.body ? GAP_ITEM : GAP_ITEM + 6, labelSize: TYPE_SCALE.small, width })
  })
  const ruleHeight = Math.max(0, Math.min(BOTTOM - 24 - top, contentBottom(builder, bodyStart) - top))
  for (let index = 1; index < buckets.length; index += 1) {
    pushRect(builder, 'divider', { x: MARGIN_X + index * (width + gap) - gap / 2 - 1, y: top, w: 2, h: ruleHeight }, palette.rule)
  }
  recenterBody(builder, bodyStart)
  footer(context)
  return slideResult(context, palette.background)
}

function sequencedPage(context: PageContext): SlideIR {
  const { builder, slide, palette, fonts } = context
  const items = visibleItems(slide)
  const top = pageHeader(context, 'Steps')
  const bodyStart = builder.elements.length
  if (slide.style.layout.endsWith('horizontal')) {
    const count = Math.max(1, items.length)
    const gap = 32
    const width = (CONTENT_W - gap * (count - 1)) / count
    pushRect(builder, 'rail', { x: MARGIN_X, y: top + 30, w: CONTENT_W, h: 2 }, palette.rule)
    items.forEach((item, index) => {
      const x = MARGIN_X + index * (width + gap)
      pushRect(builder, 'node', { x, y: top + 24, w: 14, h: 14 }, palette.accent)
      pushText(builder, 'step', { x, y: top + 52, w: width, h: 24 }, String(index + 1).padStart(2, '0'),
        { font: fonts.latin, size: TYPE_SCALE.lead - 2, weight: 700, color: palette.accent, lineHeight: 1.1 })
      const label = itemLabel(item)
      let bodyY = top + 84
      if (label !== undefined) {
        bodyY += pushText(builder, 'label', { x, y: bodyY, w: width, h: 16 }, label.toUpperCase(),
          { font: fonts.latin, size: TYPE_SCALE.small - 1, weight: 600, color: palette.muted, lineHeight: 1.3, tracking: 0.06 }) + 8
      }
      const text = itemText(item)
      if (text.length > 0) {
        pushText(builder, 'body', { x, y: bodyY, w: width, h: 0 }, text,
          { font: fonts.body, size: TYPE_SCALE.small + 3, weight: 400, color: palette.ink, lineHeight: 1.5 })
      }
    })
  } else {
    const railX = MARGIN_X + 26
    pushRect(builder, 'rail', { x: railX, y: top + 8, w: 2, h: Math.min(BOTTOM - top - 24, 26 + items.length * 84) }, palette.rule)
    let y = top
    items.forEach((item, index) => {
      pushRect(builder, 'node', { x: railX - 6, y: y + 12, w: 14, h: 14 }, palette.accent)
      pushText(builder, 'step', { x: MARGIN_X + 72, y, w: 56, h: 30 }, String(index + 1).padStart(2, '0'),
        { font: fonts.latin, size: TYPE_SCALE.lead, weight: 700, color: palette.accent, lineHeight: 1.1 })
      const textX = MARGIN_X + 144
      const textWidth = CONTENT_W - 144
      let row = y
      const label = itemLabel(item)
      if (label !== undefined) {
        row += pushText(builder, 'label', { x: textX, y: row, w: textWidth, h: 16 }, label.toUpperCase(),
          { font: fonts.latin, size: TYPE_SCALE.small - 1, weight: 600, color: palette.muted, lineHeight: 1.3, tracking: 0.06 }) + 6
      }
      const text = itemText(item)
      if (text.length > 0) {
        row += pushText(builder, 'body', { x: textX, y: row, w: textWidth, h: 0 }, text,
          { font: fonts.body, size: TYPE_SCALE.bodySmall, weight: 400, color: palette.ink, lineHeight: 1.5 })
      }
      y = Math.max(row, y + 62) + 18
    })
  }
  recenterBody(builder, bodyStart)
  footer(context)
  return slideResult(context, palette.background)
}

function numeric(value: number | string): number | undefined {
  if (typeof value === 'number') return value
  const parsed = Number.parseFloat(value.replace(/[^0-9.-]/gu, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function metricsPage(context: PageContext): SlideIR {
  const { builder, slide, palette, fonts } = context
  const data = dataOf(slide)
  const chart = visibleItems(slide).find(item => item.kind === 'chart')
  const top = pageHeader(context, 'Data')
  const series = data.map(item => ({
    label: item.label, value: item.value, unit: item.unit, note: item.note, number: numeric(item.value),
  }))
  const plottable = series.filter((entry): entry is typeof entry & { number: number } =>
    entry.number !== undefined && entry.number >= 0)
  if (chart !== undefined && plottable.length >= 3) {
    // A bar row is honest: it shows relative magnitude of the data the outline
    // carries and never invents a series that was not authored. The takeaway
    // sits above the evidence — claim first, then the bars — which also keeps
    // it clear of the axis labels and the folio.
    const takeaway = chart.kind === 'chart' ? chart.takeaway : ''
    const takeawayHeight = takeaway.length === 0 ? 0 : measureText(takeaway, TYPE_SCALE.small + 4, CONTENT_W, 1.4)
    if (takeaway.length > 0) {
      pushText(builder, 'takeaway', { x: MARGIN_X, y: top, w: CONTENT_W, h: takeawayHeight }, takeaway,
        { font: fonts.body, size: TYPE_SCALE.small + 4, weight: 500, color: palette.accent, lineHeight: 1.4 })
    }
    const chartTop = top + (takeawayHeight === 0 ? 0 : takeawayHeight + 28)
    const chartHeight = Math.max(120, Math.min(280, BOTTOM - 44 - chartTop))
    const max = Math.max(...plottable.map(entry => entry.number))
    const gap = 28
    const width = (CONTENT_W - gap * (plottable.length - 1)) / plottable.length
    const baseline = chartTop + chartHeight
    pushRect(builder, 'axis', { x: MARGIN_X, y: baseline, w: CONTENT_W, h: 2 }, palette.rule)
    plottable.forEach((entry, index) => {
      const column = MARGIN_X + index * (width + gap)
      const x = column + Math.round(width * 0.18)
      const barWidth = Math.round(width * 0.64)
      const height = max === 0 ? 0 : Math.max(6, Math.round((entry.number / max) * (chartHeight - 56)))
      if (height > 0) pushRect(builder, 'bar', { x, y: baseline - height, w: barWidth, h: height }, palette.accent, 0.9)
      pushText(builder, 'value', { x, y: Math.max(chartTop, baseline - height - 32), w: Math.max(barWidth, 64), h: 26 }, `${entry.value}${entry.unit ?? ''}`,
        { font: fonts.latin, size: TYPE_SCALE.body, weight: 700, color: palette.ink, lineHeight: 1.1 })
      pushText(builder, 'label', { x: column, y: baseline + 12, w: width, h: 16 }, entry.label.toUpperCase(),
        { font: fonts.latin, size: TYPE_SCALE.small - 2, weight: 600, color: palette.muted, lineHeight: 1.3, tracking: 0.05 })
    })
  } else {
    const columns = Math.min(3, Math.max(1, series.length))
    const rows = Math.max(1, Math.ceil(series.length / columns))
    const rowHeight = Math.min(200, (BOTTOM - top) / rows)
    const gap = 40
    const width = (CONTENT_W - gap * (columns - 1)) / columns
    series.forEach((entry, index) => {
      const x = MARGIN_X + (index % columns) * (width + gap)
      const y = top + Math.floor(index / columns) * rowHeight
      pushText(builder, 'label', { x, y, w: width, h: 16 }, entry.label.toUpperCase(),
        { font: fonts.latin, size: TYPE_SCALE.small - 1, weight: 600, color: palette.muted, lineHeight: 1.3, tracking: 0.06 })
      const valueText = String(entry.value)
      const valueSize = fitDisplay(valueText, Math.min(TYPE_SCALE.metric, Math.max(40, rowHeight - 64)), Math.max(80, width - 90), 36)
      const valueHeight = pushText(builder, 'metric', { x, y: y + 22, w: Math.max(80, width - 70), h: 40 }, valueText,
        { font: fonts.latin, size: valueSize, weight: 700, color: palette.ink, lineHeight: 1, tracking: -0.02 })
      if (entry.unit !== undefined) {
        pushText(builder, 'unit', { x: x + width - 66, y: y + 22 + Math.max(0, valueHeight - 32), w: 66, h: 22 }, entry.unit,
          { font: fonts.body, size: TYPE_SCALE.body, weight: 500, color: palette.muted, lineHeight: 1.2 })
      }
      if (entry.note !== undefined) {
        pushText(builder, 'note', { x, y: y + 22 + valueHeight + 6, w: width, h: 18 }, entry.note,
          { font: fonts.body, size: TYPE_SCALE.small, weight: 400, color: palette.muted, lineHeight: 1.4 })
      }
    })
  }
  footer(context)
  return slideResult(context, palette.background)
}

function mediaPage(context: PageContext, imagePath: string | undefined): SlideIR {
  const { builder, slide, palette, fonts } = context
  const points = pointsOf(slide)
  const imageLeft = slide.style.layout !== 'image-right'
  const mediaWidth = Math.round(CONTENT_W * 0.44)
  const textWidth = CONTENT_W - mediaWidth - 56
  const image = imageOf(slide)
  eyebrow(context, 'Visual')
  const mediaBox: ElementBox = imageLeft
    ? { x: MARGIN_X, y: MARGIN_Y, w: mediaWidth, h: CONTENT_H }
    : { x: MARGIN_X + CONTENT_W - mediaWidth, y: MARGIN_Y, w: mediaWidth, h: CONTENT_H }
  if (imagePath === undefined) pushRect(builder, 'media', mediaBox, palette.surface)
  else pushImage(builder, 'media', mediaBox, imagePath)
  if (imagePath === undefined && image?.caption !== undefined) {
    pushText(builder, 'caption', { x: mediaBox.x + 24, y: mediaBox.y + mediaBox.h - 52, w: mediaBox.w - 48, h: 22 }, image.caption,
      { font: fonts.body, size: TYPE_SCALE.small, weight: 400, color: palette.muted, lineHeight: 1.4 })
  }
  const textX = imageLeft ? MARGIN_X + mediaWidth + 56 : MARGIN_X
  const size = fitDisplay(slide.title, TYPE_SCALE.title - 4, textWidth, 26)
  const titleY = MARGIN_Y + 36
  const titleHeight = pushText(builder, 'title', { x: textX, y: titleY, w: textWidth, h: 0 }, slide.title,
    { font: fonts.display, size, weight: 700, color: palette.ink, lineHeight: 1.2, tracking: -0.02 })
  const ruleY = titleY + titleHeight + 20
  pushRect(builder, 'rule', { x: textX, y: ruleY, w: Math.min(textWidth, 240), h: 2 }, palette.accent)
  stackItems(context, points, textX, ruleY + 26, BOTTOM - 16, {
    size: TYPE_SCALE.bodySmall, gap: GAP_ITEM - 6, labelSize: TYPE_SCALE.small, width: textWidth,
  })
  footer(context)
  return slideResult(context, palette.background)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface QuickLayoutOptions {
  /** Workspace root; asset paths in the outline are workspace-relative. */
  workspace: string
  /** The artifact directory that owns this deck, i.e. `dirname(outline.json)`. */
  artifactRoot: string
  /** The Art Direction plan written next to the outline, when the deck has one. */
  designPlan?: ArtDirection
}

function fontRoles(slide: Slide, plan: ArtDirection | undefined): PageFonts {
  return {
    display: slide.style.title_font,
    body: slide.style.body_font,
    latin: plan?.typography.latin.family ?? slide.style.body_font,
  }
}

export function familyFor(slide: Slide): 'poster' | 'statement' | 'columns' | 'sequenced' | 'metrics' | 'media' {
  switch (slide.style.layout) {
    case 'cover':
    case 'center':
    case 'full-bleed':
    case 'closing':
    case 'quote-focus':
      return 'poster'
    case 'two-column':
    case 'three-column':
    case 'grid':
    case 'split':
      return 'columns'
    case 'timeline-horizontal':
    case 'timeline-vertical':
    case 'process-horizontal':
    case 'process-vertical':
      return 'sequenced'
    case 'chart-focus':
      return 'metrics'
    case 'hero-image':
    case 'image-left':
    case 'image-right':
      return 'media'
    default:
      return 'statement'
  }
}

async function resolveAsset(options: QuickLayoutOptions, slide: Slide, asset: string): Promise<string> {
  let absolute: string
  try {
    absolute = await resolveWorkspacePath(options.workspace, asset, { mustExist: true, kind: 'file' })
  } catch (error) {
    throw new PptError('PPT_CREATE_ASSET_MISSING', `page ${slide.page}: image asset is missing or unreadable: ${asset}`, { cause: error })
  }
  if (!isPathInside(options.artifactRoot, absolute)) {
    throw new PptError('PPT_CREATE_ASSET_MISSING', `page ${slide.page}: image is outside the artifact directory: ${asset}`)
  }
  return absolute
}

/**
 * Build the slide tree for an entire deck. The only asynchronous part is
 * resolving frozen image assets; every page is laid out by pure arithmetic, so
 * the same outline always produces the same PPTX.
 */
export async function buildOutlineDeckIr(outline: PptOutline, options: QuickLayoutOptions): Promise<DeckIR> {
  const slides: SlideIR[] = []
  for (const [index, slide] of outline.entries()) {
    const palette = paletteFor(slide.style.background, slide.style.accent, options.designPlan)
    const builder: Builder = { page: index + 1, elements: [], counter: 0 }
    const context: PageContext = {
      builder, slide, palette, page: index + 1, total: outline.length, fonts: fontRoles(slide, options.designPlan),
    }
    switch (familyFor(slide)) {
      case 'poster': slides.push(posterPage(context)); break
      case 'columns': slides.push(columnsPage(context)); break
      case 'sequenced': slides.push(sequencedPage(context)); break
      case 'metrics': slides.push(metricsPage(context)); break
      case 'media': {
        const image = imageOf(slide)
        slides.push(mediaPage(context, image?.asset === undefined ? undefined : await resolveAsset(options, slide, image.asset)))
        break
      }
      default: slides.push(statementPage(context))
    }
  }
  return { widthPx: SLIDE_WIDTH_PX, heightPx: SLIDE_HEIGHT_PX, slides }
}
