import type { DesignFinding } from './art-direction.ts'

/**
 * Refactoring UI laws, checked against rendered slides.
 *
 * The theme recipes and the Art Direction schema decide what a deck *looks*
 * like; this module decides what the rendered result must *obey*. It encodes
 * the machine-checkable half of the rulebook the plugin's design guidance is
 * drawn from — the hierarchy, colour, measure and spacing invariants — so a
 * violation comes back as a named finding instead of a matter of taste.
 *
 * The browser pass in `browser.ts` measures every text leaf (computed type,
 * colour and the solid field behind it) and hands the numbers over as
 * `DesignPageSample`s. This module is pure: no DOM, no clock, no I/O. That is
 * what makes the thresholds auditable and testable without launching Chromium.
 *
 * What is deliberately *not* machine-checked here — the ranking of emphasis,
 * whether space around a group exceeds space inside it, colour-only signalling —
 * needs a rendered judgement and lives in the model visual-review checklist.
 */

/** A rendered colour channel triple, 0..255 per channel. */
export interface RgbColor {
  r: number
  g: number
  b: number
}

/** One text leaf as measured on a rendered slide. */
export interface DesignTextSample {
  /** `data-ppt-id` of the leaf, so a finding names the element to fix. */
  id: string
  /** `data-art-role`, when the deck declares one. */
  role?: string
  /** Trimmed text content, capped by the collector. */
  text: string
  /** Primary font family as computed, e.g. `DengXian`. */
  fontFamily: string
  /** Computed font size in px. */
  fontSize: number
  /** Computed font weight, 100..900. */
  fontWeight: number
  /** Effective foreground colour, already composited over its field when known. */
  color: RgbColor
  /** Computed element opacity, 0..1. */
  opacity: number
  /** Computed line-height in px; omitted when the browser reports `normal`. */
  lineHeightPx?: number
  /** Computed letter-spacing in px (negative tightens). */
  letterSpacingPx: number
  /** Computed `text-transform`. */
  textTransform: string
  /** Number of line boxes the text occupies. */
  lines: number
  /** True when the leaf carries a pure rotate transform. */
  rotated: boolean
  /** Solid field behind the text; omitted when a gradient, image or unknown layer sits behind it. */
  background?: RgbColor
}

/** Everything one slide contributed to the audit. */
export interface DesignPageSample {
  page: number
  texts: DesignTextSample[]
}

/** One documented, machine-checked design law. */
export interface DesignRule {
  id: string
  /** Reference section in the rulebook the law comes from, e.g. `§2.2.a`. */
  law: string
  title: string
  /** The invariant in one line, for docs and review checklists. */
  invariant: string
}

/**
 * The rule catalogue. `docs/design-rules.md` and the README quote these IDs, so
 * adding a rule means adding it here first, then it appears wherever the
 * findings are surfaced.
 */
export const DESIGN_RULES: readonly DesignRule[] = [
  {
    id: 'RUI_TEXT_COLOR_EXCESS',
    law: '§2.2.a',
    title: 'Three text colours',
    invariant: 'At most three text colours carry the hierarchy of a page.',
  },
  {
    id: 'RUI_GREY_ON_COLOR',
    law: '§2.3',
    title: 'No grey on a coloured field',
    invariant: 'De-emphasised text on a coloured field is hand-picked at the field hue, never grey or white at reduced opacity.',
  },
  {
    id: 'RUI_CONTRAST_LOW',
    law: '§5.6',
    title: 'Contrast floor',
    invariant: 'Normal text clears 4.5:1 against its field; large text (≥24px, or ≥18.66px bold) clears 3:1.',
  },
  {
    id: 'RUI_MEASURE_TOO_WIDE',
    law: '§4.3',
    title: 'Measure',
    invariant: 'Body copy reads at 45–75 Latin characters (20–35em) per line; the audit alerts above 90 Latin / 50 CJK characters, the widened machine threshold.',
  },
  {
    id: 'RUI_LINE_HEIGHT_TIGHT',
    law: '§4.5',
    title: 'Line-height',
    invariant: 'Multi-line body copy sets line-height at 1.3× the font size or more.',
  },
  {
    id: 'RUI_WEIGHT_TOO_LIGHT',
    law: '§2.2.b',
    title: 'Weight floor',
    invariant: 'UI text at 26px or below never goes below weight 400.',
  },
  {
    id: 'RUI_TYPE_SIZE_SCATTER',
    law: '§4.1 (cap: plugin convention)',
    title: 'One type scale',
    invariant: 'A page draws from one type scale; the plugin caps a page at six distinct sizes.',
  },
  {
    id: 'RUI_FONT_FAMILY_EXCESS',
    law: '§4.2 (cap: plugin convention)',
    title: 'Two font families',
    invariant: 'A page uses at most two font families; a third only adds noise.',
  },
  {
    id: 'RUI_LABEL_TRACKING_MISSING',
    law: '§4.8.2',
    title: 'All-caps tracking',
    invariant: 'Uppercase text at 20px or below carries at least 0.02em of letter-spacing.',
  },
]

/** Model-review items for the laws no measurement can settle. */
export const DESIGN_REVIEW_PROBES: readonly string[] = [
  'Rank each page: one element should be visibly primary; secondary and tertiary content must be de-emphasised by size, weight or colour rather than competing for attention.',
  'Check group spacing: the space around a content group must exceed the space inside it, and the space between a heading and its body must be smaller than the space that separates it from the next group.',
  'Check colour-only signalling: status, increase/decrease, sequence and category must also be carried by text, icon, position or shape, never by colour alone.',
]

/**
 * Decorative ghost layers are allowed to be illegible on purpose. Two forms are
 * excluded from every rule: element opacity below 0.2, and the themes' poster
 * device of a very large near-field text (a 200px numeral at 4–10% ink) that is
 * rendered as a pale opaque colour rather than lowered opacity.
 */
const GHOST_OPACITY = 0.2
const GHOST_MIN_FONT_PX = 48
const GHOST_MAX_CONTRAST = 1.5
const MAX_TEXT_COLORS = 3
const MAX_TYPE_SIZES = 6
const MAX_FONT_FAMILIES = 2
const MIN_BODY_WEIGHT = 400
const MIN_BODY_LINE_HEIGHT = 1.3
const MAX_LATIN_MEASURE = 90
const MAX_CJK_MEASURE = 50
const MIN_LABEL_TRACKING_EM = 0.02
/** Saturation at or below this reads as grey to the eye. */
const GREY_SATURATION = 0.2
/**
 * A mid-tone grey is the anti-pattern; near-white and near-black are not. White
 * text on a dark coloured field is legitimate, and the book's own complaint is
 * about mid-grey de-emphasis (§2.3) and white-at-reduced-opacity (§2.3.a), whose
 * composite keeps the field's hue rather than becoming grey.
 */
const GREY_MIN_LIGHTNESS = 0.25
const GREY_MAX_LIGHTNESS = 0.88
/** Saturation at or above this reads as a coloured field. */
const COLOURED_FIELD_SATURATION = 0.25
/**
 * A coloured field is a mid-tone panel. HSL saturation explodes near white
 * (#FFFDFC is 100% saturated, 99% light) and near black, so paper tints and
 * near-black grounds must not be read as coloured panels — grey text on tinted
 * paper is just grey text on a light page.
 */
const COLOURED_FIELD_MIN_LIGHTNESS = 0.15
const COLOURED_FIELD_MAX_LIGHTNESS = 0.85
/** Role-less text at or below this size is body copy; the documented display tiers start at 32px. */
const ROLELESS_BODY_MAX_PX = 26
/** WCAG "large text" thresholds, in CSS px. */
const LARGE_TEXT_PX = 24
const LARGE_BOLD_TEXT_PX = 18.66
const CJK = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/gu

function channel(value: number): number {
  const normalized = Math.max(0, Math.min(255, value)) / 255
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.1 relative luminance of a composited colour. */
export function relativeLuminanceRgb(color: RgbColor): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** WCAG 2.1 contrast ratio between two composited colours, from 1 to 21. */
export function contrastRatioRgb(a: RgbColor, b: RgbColor): number {
  const first = relativeLuminanceRgb(a)
  const second = relativeLuminanceRgb(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** HSL of a colour, with saturation and lightness in 0..1. */
export function rgbToHsl(color: RgbColor): { h: number; s: number; l: number } {
  const r = Math.max(0, Math.min(255, color.r)) / 255
  const g = Math.max(0, Math.min(255, color.g)) / 255
  const b = Math.max(0, Math.min(255, color.b)) / 255
  const maximum = Math.max(r, g, b)
  const minimum = Math.min(r, g, b)
  const lightness = (maximum + minimum) / 2
  if (maximum === minimum) return { h: 0, s: 0, l: lightness }
  const delta = maximum - minimum
  const saturation = lightness > 0.5 ? delta / (2 - maximum - minimum) : delta / (maximum + minimum)
  let hue: number
  if (maximum === r) hue = (g - b) / delta + (g < b ? 6 : 0)
  else if (maximum === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  return { h: hue * 60, s: saturation, l: lightness }
}

function hex(color: RgbColor): string {
  return `#${[color.r, color.g, color.b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

function characters(value: string): number {
  return [...value].length
}

function cjkShare(value: string): number {
  const total = characters(value)
  if (total === 0) return 0
  return (value.match(CJK)?.length ?? 0) / total
}

/** Body copy: prose that has to be read line after line, not a label or a headline. */
function isBodyCopy(sample: DesignTextSample): boolean {
  if (sample.rotated) return false
  if (sample.role === 'body' || sample.role === 'supporting') return true
  if (sample.role !== undefined) return false
  return sample.fontSize <= ROLELESS_BODY_MAX_PX
}

/** Decorative text: excluded from every rule because it is illegible on purpose. */
function isDecorative(sample: DesignTextSample): boolean {
  if (sample.opacity < GHOST_OPACITY) return true
  if (sample.background === undefined || sample.fontSize < GHOST_MIN_FONT_PX) return false
  return contrastRatioRgb(sample.color, sample.background) < GHOST_MAX_CONTRAST
}

/** Uppercase via `text-transform` or typed capitals; CJK and digits alone are not labels. */
function isUppercaseText(sample: DesignTextSample): boolean {
  if (sample.textTransform === 'uppercase') return true
  const letters = sample.text.replace(/[^A-Za-z]/gu, '')
  return letters.length > 1 && letters === letters.toUpperCase()
}

export function designRuleFindings(pages: readonly DesignPageSample[]): DesignFinding[] {
  const findings: DesignFinding[] = []
  for (const page of pages) {
    if (page.texts.length === 0) continue
    // Ghost layers are decorative; they are allowed to be illegible on purpose.
    const readable = page.texts.filter(sample => sample.text.trim().length > 0 && !isDecorative(sample))

    // §5.6 — contrast. Only solids are audited: over a gradient or an image the
    // effective field is not one colour, so a ratio would be a guess. Theme-level
    // gradient contrast is enforced separately in `themes.ts`.
    const lowContrast = readable.flatMap(sample => {
      const background = sample.background
      if (background === undefined) return []
      const ratio = contrastRatioRgb(sample.color, background)
      const large = sample.fontSize >= LARGE_TEXT_PX || (sample.fontSize >= LARGE_BOLD_TEXT_PX && sample.fontWeight >= 700)
      const minimum = large ? 3 : 4.5
      // Compare the value as displayed: a 4.4996 ratio must not print as
      // "4.50:1 is below 4.5:1".
      const rounded = Math.round(ratio * 100) / 100
      if (rounded >= minimum) return []
      return [{
        page: page.page,
        message: `${sample.id} contrast ${rounded.toFixed(2)}:1 is below ${minimum}:1 for ${large ? 'large' : 'normal'} text (${hex(sample.color)} on ${hex(background)})`,
        label: sample.id,
      }]
    })
    if (lowContrast.length > 0) {
      findings.push({
        code: 'RUI_CONTRAST_LOW', severity: 'warning', page: page.page,
        message: `${lowContrast.length} text element${lowContrast.length === 1 ? '' : 's'} fail WCAG AA: ${lowContrast.map(item => item.message).join('; ')}`,
      })
    }

    // §2.3 — grey text on a coloured field.
    const greyOnColour = readable.flatMap(sample => {
      const background = sample.background
      if (background === undefined) return []
      const foreground = rgbToHsl(sample.color)
      const field = rgbToHsl(background)
      if (foreground.s > GREY_SATURATION || field.s < COLOURED_FIELD_SATURATION) return []
      if (field.l < COLOURED_FIELD_MIN_LIGHTNESS || field.l > COLOURED_FIELD_MAX_LIGHTNESS) return []
      if (foreground.l < GREY_MIN_LIGHTNESS || foreground.l > GREY_MAX_LIGHTNESS) return []
      return [{
        page: page.page,
        message: `${sample.id} is grey text on a coloured field (text ${(foreground.s * 100).toFixed(0)}% saturation, field ${(field.s * 100).toFixed(0)}%); pick a colour at the field hue instead`,
        label: sample.id,
      }]
    })
    if (greyOnColour.length > 0) {
      findings.push({
        code: 'RUI_GREY_ON_COLOR', severity: 'warning', page: page.page,
        message: `${greyOnColour.length} grey-on-colour element${greyOnColour.length === 1 ? '' : 's'}: ${greyOnColour.map(item => item.message).join('; ')}`,
      })
    }

    // §2.2.a — three text colours.
    const colors = [...new Set(readable.map(sample => hex(sample.color)))]
    if (colors.length > MAX_TEXT_COLORS) {
      findings.push({
        code: 'RUI_TEXT_COLOR_EXCESS', severity: 'warning', page: page.page,
        message: `${colors.length} text colours on one page (${colors.join(', ')}); pick three and de-emphasise with weight instead`,
      })
    }

    // §4.3 — measure. Single-line statements are display type, not reading text.
    const wideMeasure = readable.filter(sample => sample.lines >= 2 && isBodyCopy(sample)).flatMap(sample => {
      const total = characters(sample.text)
      const perLine = total / sample.lines
      const maximum = cjkShare(sample.text) >= 0.3 ? MAX_CJK_MEASURE : MAX_LATIN_MEASURE
      if (perLine <= maximum) return []
      return [{
        page: page.page,
        message: `${sample.id} runs about ${perLine.toFixed(0)} characters per line over ${sample.lines} lines, above the ${maximum}-character measure for its script`,
        label: sample.id,
      }]
    })
    if (wideMeasure.length > 0) {
      findings.push({
        code: 'RUI_MEASURE_TOO_WIDE', severity: 'warning', page: page.page,
        message: `${wideMeasure.length} body block${wideMeasure.length === 1 ? '' : 's'} exceed the reading measure: ${wideMeasure.map(item => item.message).join('; ')}`,
      })
    }

    // §4.5 — line-height on multi-line body copy.
    const tightLeading = readable.filter(sample => sample.lines >= 2 && isBodyCopy(sample) && sample.lineHeightPx !== undefined).flatMap(sample => {
      const ratio = sample.lineHeightPx! / sample.fontSize
      if (ratio >= MIN_BODY_LINE_HEIGHT) return []
      return [{
        page: page.page,
        message: `${sample.id} sets line-height to ${ratio.toFixed(2)}× its ${sample.fontSize}px type`,
        label: sample.id,
      }]
    })
    if (tightLeading.length > 0) {
      findings.push({
        code: 'RUI_LINE_HEIGHT_TIGHT', severity: 'warning', page: page.page,
        message: `${tightLeading.length} body block${tightLeading.length === 1 ? '' : 's'} below the 1.3× line-height floor: ${tightLeading.map(item => item.message).join('; ')}`,
      })
    }

    // §2.2.b — weight floor for UI text.
    const lightWeight = readable.filter(sample => sample.fontSize <= 26 && sample.fontWeight < MIN_BODY_WEIGHT)
    if (lightWeight.length > 0) {
      findings.push({
        code: 'RUI_WEIGHT_TOO_LIGHT', severity: 'warning', page: page.page,
        message: `${lightWeight.length} text element${lightWeight.length === 1 ? '' : 's'} below weight ${MIN_BODY_WEIGHT}: ${lightWeight.map(sample => `${sample.id} uses ${sample.fontWeight}`).join('; ')}`,
      })
    }

    // §4.1 — one type scale, few steps.
    const sizes = [...new Set(readable.map(sample => Math.round(sample.fontSize * 10) / 10))].sort((a, b) => a - b)
    if (sizes.length > MAX_TYPE_SIZES) {
      findings.push({
        code: 'RUI_TYPE_SIZE_SCATTER', severity: 'warning', page: page.page,
        message: `${sizes.length} distinct font sizes on one page (${sizes.join('/')}px); draw every size from one type scale of at most ${MAX_TYPE_SIZES} steps`,
      })
    }

    // §4.2 — font-family restraint.
    const families = [...new Set(readable.map(sample => sample.fontFamily).filter(family => family.length > 0))]
    if (families.length > MAX_FONT_FAMILIES) {
      findings.push({
        code: 'RUI_FONT_FAMILY_EXCESS', severity: 'warning', page: page.page,
        message: `${families.length} font families on one page (${families.join(', ')}); two is the ceiling`,
      })
    }

    // §4.8.2 — all-caps text needs tracking.
    const untrackedCaps = readable.filter(sample =>
      isUppercaseText(sample)
      && sample.fontSize <= 20
      && sample.letterSpacingPx < sample.fontSize * MIN_LABEL_TRACKING_EM)
    if (untrackedCaps.length > 0) {
      findings.push({
        code: 'RUI_LABEL_TRACKING_MISSING', severity: 'warning', page: page.page,
        message: `${untrackedCaps.length} uppercase label${untrackedCaps.length === 1 ? '' : 's'} at or below 20px lack letter-spacing: ${untrackedCaps.map(sample => `${sample.id} (${sample.letterSpacingPx.toFixed(1)}px)`).join('; ')}; all-caps needs at least ${MIN_LABEL_TRACKING_EM}em`,
      })
    }
  }
  return findings
}
