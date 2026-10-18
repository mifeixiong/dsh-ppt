import { strFromU8, strToU8 } from 'fflate'
import { PptError } from './errors.ts'
import type { SlideBackgroundIR } from './ir.ts'
import { rewriteZip } from './zip.ts'

/**
 * A CSS slide background has to become a native PresentationML background:
 * pptxgenjs can fill a whole slide with a solid color, but it has no API for a
 * per-slide gradient. The finished package is therefore rewritten so only
 * `ppt/slides/slideN.xml` changes, mirroring the transition and animation
 * rewrites. Everything here is pure and DOM-free so the parser can be tested
 * without a browser.
 */

export interface ParsedGradientStop {
  color: string
  position: number
}

export interface ParsedLinearGradient {
  angleDeg: number
  stops: ParsedGradientStop[]
}

export interface SlideBackgroundPlan {
  solid: string
  gradient?: ParsedLinearGradient
}

const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/u
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu
const RGB_COLOR = /^rgb(?:a)?\(([^)]*)\)$/iu
const STOP = /^(#(?:[0-9a-f]{3}|[0-9a-f]{6})|rgba?\([^)]*\))(?:\s+(-?(?:\d+(?:\.\d*)?|\.\d+)%))?$/iu
const ANGLE = /^-?(?:\d+(?:\.\d*)?|\.\d+)deg$/iu
const COMMA_COMPONENTS = /^(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?$/u
const SPACE_COMPONENTS = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/u
const MIN_STOPS = 2
const MAX_STOPS = 6
const DEFAULT_ANGLE_DEG = 180

function parseColorComponents(body: string): [string, string, string, string?] | undefined {
  const comma = COMMA_COMPONENTS.exec(body)
  if (comma !== null) return [comma[1]!, comma[2]!, comma[3]!, comma[4]]
  const space = SPACE_COMPONENTS.exec(body)
  if (space !== null) return [space[1]!, space[2]!, space[3]!, space[4]]
  return undefined
}

/** Normalizes `#rgb`, `#rrggbb`, `rgb(...)`, and fully opaque `rgba(...)` to uppercase hex. */
function parseColorToken(value: string): string | undefined {
  const trimmed = value.trim()
  const hex = HEX_COLOR.exec(trimmed)
  if (hex !== null) {
    const digits = hex[1]!
    return (digits.length === 3 ? digits.split('').map(digit => `${digit}${digit}`).join('') : digits).toUpperCase()
  }
  const rgb = RGB_COLOR.exec(trimmed)
  if (rgb === null) return undefined
  const components = parseColorComponents(rgb[1]!.trim())
  if (components === undefined) return undefined
  const [red, green, blue, alphaText] = components
  const channels = [red, green, blue].map(channel => Number(channel))
  if (channels.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 255)) return undefined
  if (alphaText !== undefined) {
    const alpha = Number(alphaText)
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return undefined
    // Native PPTX gradient stops are opaque; a translucent CSS stop falls back to solid.
    if (alpha !== 1) return undefined
  }
  return channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('').toUpperCase()
}

export function cssColorToHex(value: string): string | undefined {
  return parseColorToken(value)
}

function splitTopLevel(value: string): string[] | undefined {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth < 0) return undefined
    } else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  if (depth !== 0) return undefined
  parts.push(value.slice(start).trim())
  return parts
}

const CARDINAL_ANGLES: Readonly<Record<string, number>> = { top: 0, right: 90, bottom: 180, left: 270 }
const CORNER_ANGLES: Readonly<Record<string, number>> = {
  'top-right': 45,
  'bottom-right': 135,
  'bottom-left': 225,
  'top-left': 315,
}

function parseDirection(token: string): number | undefined {
  const normalized = token.trim().replace(/\s+/gu, ' ').toLowerCase()
  if (ANGLE.test(normalized)) {
    const value = Number.parseFloat(normalized)
    return Number.isFinite(value) ? ((value % 360) + 360) % 360 : undefined
  }
  if (!normalized.startsWith('to ')) return undefined
  const words = normalized.slice(3).split(' ').filter(Boolean)
  if (words.length === 1) return CARDINAL_ANGLES[words[0]!]
  if (words.length !== 2) return undefined
  const [first, second] = words as [string, string]
  const validSide = (word: string): boolean => word === 'top' || word === 'right' || word === 'bottom' || word === 'left'
  if (!validSide(first) || !validSide(second)) return undefined
  const vertical = first === 'top' || first === 'bottom' ? first : second
  const horizontal = first === 'left' || first === 'right' ? first : second
  if ((vertical === 'top' || vertical === 'bottom') && (horizontal === 'left' || horizontal === 'right')) {
    return CORNER_ANGLES[`${vertical}-${horizontal}`]
  }
  return undefined
}

/** Fills omitted stop positions from the nearest positioned neighbours, defaulting to 0 and 100. */
function resolveStopPositions(stops: Array<{ color: string; position?: number }>): ParsedGradientStop[] {
  const positions = stops.map(stop => stop.position)
  if (positions[0] === undefined) positions[0] = 0
  if (positions[positions.length - 1] === undefined) positions[positions.length - 1] = 100
  let lastPositioned = positions[0]!
  for (let index = 1; index < positions.length; index += 1) {
    const current = positions[index]
    if (current === undefined) continue
    if (current < lastPositioned) positions[index] = lastPositioned
    else lastPositioned = current
  }
  for (let index = 0; index < positions.length; index += 1) {
    if (positions[index] !== undefined) continue
    let previous = index - 1
    while (positions[previous] === undefined) previous -= 1
    let next = index + 1
    while (positions[next] === undefined) next += 1
    const previousPosition = positions[previous]!
    const nextPosition = positions[next]!
    positions[index] = previousPosition + ((nextPosition - previousPosition) * (index - previous)) / (next - previous)
  }
  return stops.map((stop, index) => ({ color: stop.color, position: positions[index]! }))
}

export function parseLinearGradient(image: string): ParsedLinearGradient | undefined {
  const trimmed = image.trim()
  const prefix = /^linear-gradient\(/iu.exec(trimmed)
  if (prefix === null) return undefined
  const open = prefix[0].length - 1
  let depth = 0
  let close = -1
  for (let index = open; index < trimmed.length; index += 1) {
    const character = trimmed[index]!
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
      if (depth < 0) return undefined
    }
  }
  // A trailing layer, image-set, or any other text means this is not one gradient.
  if (close !== trimmed.length - 1) return undefined
  const parts = splitTopLevel(trimmed.slice(open + 1, close))
  if (parts === undefined || parts.length < MIN_STOPS) return undefined

  let angleDeg = DEFAULT_ANGLE_DEG
  let firstStop = 0
  const direction = parts[0]!
  if (/^to\s/iu.test(direction) || ANGLE.test(direction)) {
    const parsedAngle = parseDirection(direction)
    if (parsedAngle === undefined) return undefined
    angleDeg = parsedAngle
    firstStop = 1
  }

  const stopTokens = parts.slice(firstStop)
  if (stopTokens.length < MIN_STOPS || stopTokens.length > MAX_STOPS) return undefined
  const stops: Array<{ color: string; position?: number }> = []
  for (const token of stopTokens) {
    const match = STOP.exec(token)
    if (match === null) return undefined
    const color = parseColorToken(match[1]!)
    if (color === undefined) return undefined
    const stop: { color: string; position?: number } = { color }
    if (match[2] !== undefined) {
      const position = Number.parseFloat(match[2])
      if (!Number.isFinite(position) || position < 0 || position > 100) return undefined
      stop.position = position
    }
    stops.push(stop)
  }
  return { angleDeg, stops: resolveStopPositions(stops) }
}

export function planSlideBackground(background: SlideBackgroundIR | undefined): SlideBackgroundPlan | undefined {
  if (background === undefined) return undefined
  const gradient = parseLinearGradient(background.image)
  if (gradient !== undefined) return { solid: gradient.stops[0]!.color, gradient }
  const solid = cssColorToHex(background.color)
  return solid === undefined ? undefined : { solid }
}

export function slideBackgroundXml(plan: SlideBackgroundPlan): string {
  const fill = plan.gradient === undefined
    ? `<a:solidFill><a:srgbClr val="${plan.solid}"/></a:solidFill>`
    : '<a:gradFill rotWithShape="1"><a:gsLst>'
      + plan.gradient.stops.map(stop => `<a:gs pos="${Math.round(stop.position * 1000)}"><a:srgbClr val="${stop.color}"/></a:gs>`).join('')
      + '</a:gsLst>'
      + `<a:lin ang="${Math.round(((plan.gradient.angleDeg - 90 + 360) % 360) * 60000)}" scaled="0"/>`
      + '</a:gradFill>'
  return `<p:bg><p:bgPr>${fill}<a:effectLst/></p:bgPr></p:bg>`
}

export function injectSlideBackground(xml: string, plan: SlideBackgroundPlan): string {
  const opening = /<p:cSld\b[^>]*>/u.exec(xml)
  if (opening === null) throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'slide XML has no p:cSld element')
  const contentStart = opening.index + opening[0].length
  const background = slideBackgroundXml(plan)
  if (opening[0].endsWith('/>')) {
    const expanded = `${opening[0].slice(0, -2).trimEnd()}>`
    return `${xml.slice(0, opening.index)}${expanded}${background}</p:cSld>${xml.slice(contentStart)}`
  }
  const contentEnd = xml.indexOf('</p:cSld>', contentStart)
  if (contentEnd < 0) throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'slide XML has an unterminated p:cSld element')
  const existing = /<p:bg\b[^>]*>/u.exec(xml.slice(contentStart, contentEnd))
  if (existing === null) return `${xml.slice(0, contentStart)}${background}${xml.slice(contentStart)}`

  const start = contentStart + existing.index
  const openingTag = existing[0]
  let end = start + openingTag.length
  if (!openingTag.endsWith('/>')) {
    const closing = xml.indexOf('</p:bg>', start + openingTag.length)
    if (closing < 0) throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'slide XML has an unterminated p:bg element')
    end = closing + '</p:bg>'.length
  }
  return `${xml.slice(0, start)}${background}${xml.slice(end)}`
}

export function rewritePptxSlideBackgrounds(data: Uint8Array, plans: ReadonlyMap<number, SlideBackgroundPlan>): Uint8Array {
  if (plans.size === 0) return data
  const targets = new Map<number, SlideBackgroundPlan>()
  for (const [page, plan] of plans) {
    if (!Number.isInteger(page) || page < 1) {
      throw new PptError('PPT_CREATE_INPUT_INVALID', `slide background page must be a positive integer: ${String(page)}`)
    }
    targets.set(page, plan)
  }
  const injected = new Set<number>()
  const output = rewriteZip(data, {
    transform: (name, read) => {
      const match = SLIDE_PART.exec(name)
      const page = match === null ? undefined : Number(match[1])
      const plan = page === undefined ? undefined : targets.get(page)
      if (page === undefined || plan === undefined) return undefined
      injected.add(page)
      return strToU8(injectSlideBackground(strFromU8(read()), plan))
    },
  })
  for (const page of targets.keys()) {
    if (!injected.has(page)) throw new PptError('PPT_CREATE_INPUT_INVALID', `no slide part matches background page ${page}`)
  }
  return output
}
