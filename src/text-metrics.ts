import * as fontkit from 'fontkit'
import { discoverRegisteredFonts, type DiscoveredFont } from './fonts.ts'

/**
 * Text measurement without a browser.
 *
 * Both authoring lanes need to know how wide a string is before the slide
 * exists: the SVG lane positions `<text>` by its anchor and has to turn a
 * baseline + anchor into a left/top box. The HTML lane measures the live DOM
 * instead; this module is the lane that has no DOM.
 *
 * Widths come from the font's own advance tables through fontkit. Text is split
 * into maximal runs so kerning inside a run survives, and a character the Latin
 * face cannot cover (CJK in a Latin face, for instance) is measured with a face
 * that actually has the glyph. When no face is available the module falls back
 * to a conservative estimate, so a missing system font degrades into a slightly
 * wide box rather than a crash — and the caller can see `measured: false`.
 */

export interface TextMeasureRequest {
  family: string
  /** Numeric CSS weight; the closest installed subfamily is used. */
  weight: number
  italic: boolean
  sizePx: number
  text: string
}

export interface TextMeasurement {
  /** Advance width in px. */
  width: number
  /** Distance from the text baseline up to the top of the em box, in px. */
  ascent: number
  /** Distance from the baseline down to the bottom of the em box, in px (positive). */
  descent: number
  /** True when a real font face measured the string. */
  measured: boolean
}

export interface TextMetrics {
  measure(request: TextMeasureRequest): Promise<TextMeasurement>
  /** True when at least one real face is available for this family. */
  hasFamily(family: string): boolean
  /** Open every face of these families now; `measure` does it lazily otherwise. */
  preload(families: readonly string[]): Promise<void>
}

interface FontkitGlyphRun {
  advanceWidth: number
}

interface FontkitLayoutFace {
  unitsPerEm: number
  ascent: number
  descent: number
  layout(text: string): FontkitGlyphRun
}

interface FontkitOpenedFace extends FontkitLayoutFace {
  fonts?: FontkitOpenedFace[]
}

interface FaceEntry {
  font: DiscoveredFont
  bold: boolean
  italic: boolean
}

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0x9fff],
  [0xf900, 0xfaff],
  [0x3000, 0x303f],
  [0xff00, 0xffef],
]

function isCjk(codePoint: number): boolean {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint >= start && codePoint <= end) return true
  }
  return false
}

/**
 * Deterministic fallback: Latin at 0.52 em, CJK at 1 em, spaces at 0.26 em.
 * Deliberately slightly wide, so an estimated box never claims a fit the real
 * font would not have.
 */
export function estimateTextWidth(text: string, sizePx: number): number {
  let width = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0)!
    if (isCjk(codePoint)) width += 1
    else if (character === ' ') width += 0.26
    else if (/[iIlj.,;:'!|]/u.test(character)) width += 0.28
    else if (/[A-Z@#%&mwMW]/u.test(character)) width += 0.66
    else width += 0.52
  }
  return width * sizePx
}

export function estimateMeasurement(text: string, sizePx: number): TextMeasurement {
  return {
    width: estimateTextWidth(text, sizePx),
    ascent: sizePx * 0.8,
    descent: sizePx * 0.2,
    measured: false,
  }
}

function faceScore(entry: FaceEntry, weight: number, italic: boolean): number {
  const wantsBold = weight >= 600
  let score = 0
  if (entry.bold === wantsBold) score += 4
  if (entry.italic === italic) score += 2
  return score
}

/** Split text into maximal runs that one face can measure with real glyphs. */
function splitRuns(text: string, primary: DiscoveredFont, fallback: DiscoveredFont | undefined): Array<{ font: DiscoveredFont; text: string }> {
  const runs: Array<{ font: DiscoveredFont; text: string }> = []
  let current = ''
  let currentFont = primary
  for (const character of text) {
    const codePoint = character.codePointAt(0)!
    let font = primary
    if (!primary.codePoints.has(codePoint) && fallback !== undefined && fallback.codePoints.has(codePoint)) font = fallback
    if (font !== currentFont && current.length > 0) {
      runs.push({ font: currentFont, text: current })
      current = ''
    }
    currentFont = font
    current += character
  }
  if (current.length > 0) runs.push({ font: currentFont, text: current })
  return runs
}

/** Builds a provider over the faces discovery already found. */
export function createTextMetrics(fonts: readonly DiscoveredFont[]): TextMetrics {
  const byFamily = new Map<string, FaceEntry[]>()
  const byFile = new Map<string, DiscoveredFont>()
  for (const font of fonts) {
    const key = font.name.toLocaleLowerCase()
    const entries = byFamily.get(key) ?? []
    const subfamily = font.weight.toLocaleLowerCase()
    entries.push({ font, bold: /bold|black|heavy|semibold|demi/u.test(subfamily), italic: /italic|oblique/u.test(subfamily) })
    byFamily.set(key, entries)
    byFile.set(font.file, font)
  }
  const opened = new Map<string, Promise<FontkitLayoutFace | undefined>>()
  const openFace = (font: DiscoveredFont): Promise<FontkitLayoutFace | undefined> => {
    const cached = opened.get(font.file)
    if (cached !== undefined) return cached
    const pending = (async () => {
      try {
        const face = await fontkit.open(font.file) as unknown as FontkitOpenedFace
        if (Array.isArray(face.fonts) && face.fonts.length > 0) return face.fonts[0]!
        return face
      } catch {
        return undefined
      }
    })()
    opened.set(font.file, pending)
    return pending
  }
  const cjkFallback = fonts.find(font => font.supportsCjk && !/bold|black|heavy/u.test(font.weight.toLocaleLowerCase()))
    ?? fonts.find(font => font.supportsCjk)

  return {
    hasFamily(family: string): boolean {
      return byFamily.has(family.toLocaleLowerCase())
    },
    async preload(families: readonly string[]): Promise<void> {
      const faces = families.flatMap(family => byFamily.get(family.toLocaleLowerCase()) ?? [])
      await Promise.all(faces.map(entry => openFace(entry.font)))
    },
    async measure(request: TextMeasureRequest): Promise<TextMeasurement> {
      const entries = byFamily.get(request.family.toLocaleLowerCase())
      if (entries === undefined || entries.length === 0) return estimateMeasurement(request.text, request.sizePx)
      const primary = [...entries].sort((left, right) => faceScore(right, request.weight, request.italic) - faceScore(left, request.weight, request.italic))[0]!
      const face = await openFace(primary.font)
      if (face === undefined || face.unitsPerEm <= 0) return estimateMeasurement(request.text, request.sizePx)
      let units = 0
      let ascentUnits = Math.max(0, face.ascent)
      let descentUnits = Math.abs(Math.min(0, face.descent))
      try {
        for (const run of splitRuns(request.text, primary.font, cjkFallback)) {
          const runFont = byFile.get(run.font.file) ?? run.font
          const runFace: FontkitLayoutFace | undefined = runFont.file === primary.font.file ? face : await openFace(runFont)
          if (runFace === undefined) return estimateMeasurement(request.text, request.sizePx)
          units += runFace.layout(run.text).advanceWidth
          if (runFace !== face) {
            ascentUnits = Math.max(ascentUnits, Math.max(0, runFace.ascent))
            descentUnits = Math.max(descentUnits, Math.abs(Math.min(0, runFace.descent)))
          }
        }
      } catch {
        return estimateMeasurement(request.text, request.sizePx)
      }
      const scale = request.sizePx / face.unitsPerEm
      return { width: units * scale, ascent: ascentUnits * scale, descent: descentUnits * scale, measured: true }
    },
  }
}

let systemMetrics: Promise<TextMetrics> | undefined

/** Discovery is process-wide and lazy: one font-directory scan per session. */
export function loadSystemTextMetrics(): Promise<TextMetrics> {
  systemMetrics ??= (async () => {
    try {
      return createTextMetrics(await discoverRegisteredFonts())
    } catch {
      return createTextMetrics([])
    }
  })()
  return systemMetrics
}
