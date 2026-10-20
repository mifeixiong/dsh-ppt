import { describe, expect, it } from 'vitest'
import {
  DESIGN_REVIEW_PROBES,
  DESIGN_RULES,
  contrastRatioRgb,
  designRuleFindings,
  rgbToHsl,
  type DesignPageSample,
  type DesignTextSample,
} from '../../src/design-rules.ts'

const WHITE = { r: 255, g: 255, b: 255 }
const INK = { r: 17, g: 19, b: 24 }
const BLUE = { r: 37, g: 99, b: 235 }
const MID_GREY = { r: 138, g: 138, b: 138 }
const COOL_GREY = { r: 156, g: 163, b: 175 }

function text(overrides: Partial<DesignTextSample> = {}): DesignTextSample {
  return {
    id: 'body-1',
    text: 'A short supporting sentence for the slide.',
    fontFamily: 'Liter',
    fontSize: 24,
    fontWeight: 400,
    color: INK,
    opacity: 1,
    lineHeightPx: 38.4,
    letterSpacingPx: 0,
    textTransform: 'none',
    lines: 1,
    rotated: false,
    background: WHITE,
    ...overrides,
  }
}

function page(...texts: DesignTextSample[]): DesignPageSample {
  return { page: 1, texts }
}

function codes(pages: readonly DesignPageSample[]): string[] {
  return designRuleFindings(pages).map(finding => finding.code)
}

describe('Refactoring UI colour math', () => {
  it('matches the WCAG extremes and identity pairs', () => {
    expect(contrastRatioRgb(WHITE, { r: 0, g: 0, b: 0 })).toBeCloseTo(21, 5)
    expect(contrastRatioRgb(WHITE, WHITE)).toBeCloseTo(1, 5)
    expect(rgbToHsl(WHITE).s).toBe(0)
    expect(rgbToHsl({ r: 0, g: 0, b: 0 }).l).toBe(0)
  })
})

describe('Refactoring UI laws on rendered slides', () => {
  it('passes a clean page', () => {
    expect(designRuleFindings([
      page(
        text({ id: 'title-1', role: 'title', fontSize: 44, lineHeightPx: 52.8 }),
        text({ id: 'body-1', role: 'body', lineHeightPx: 38.4 }),
      ),
    ])).toEqual([])
  })

  it('applies the 4.5:1 body floor and the 3:1 large-text floor', () => {
    const normal = designRuleFindings([page(text({ color: MID_GREY, fontSize: 20, lineHeightPx: 30 }))])
    expect(normal).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RUI_CONTRAST_LOW', page: 1 })]))
    expect(normal[0]!.message).toContain('4.5:1')
    expect(normal[0]!.message).toContain('body-1')

    const large = designRuleFindings([page(text({ color: MID_GREY, fontSize: 32, lineHeightPx: 35 }))])
    expect(large).toEqual([])
  })

  it('does not flag contrast or grey text when the field is unknown', () => {
    expect(designRuleFindings([page(text({ color: MID_GREY, background: undefined }))])).toEqual([])
  })

  it('flags mid-grey text on a coloured field but not white or near-black', () => {
    const flagged = designRuleFindings([page(text({ color: COOL_GREY, background: BLUE, fontSize: 20, lineHeightPx: 30 }))])
    expect(flagged).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RUI_GREY_ON_COLOR', page: 1 })]))
    expect(designRuleFindings([page(text({ color: WHITE, background: BLUE, fontSize: 20, lineHeightPx: 30 }))])).toEqual([])
    const dark = designRuleFindings([page(text({ color: { r: 17, g: 19, b: 24 }, background: BLUE, fontSize: 20, lineHeightPx: 30 }))])
    expect(dark.map(finding => finding.code)).not.toContain('RUI_GREY_ON_COLOR')
  })

  it('allows three text colours and flags the fourth', () => {
    const two = page(
      text({ id: 'a', color: { r: 17, g: 24, b: 39 } }),
      text({ id: 'b', color: { r: 55, g: 65, b: 81 } }),
    )
    expect(codes([two])).not.toContain('RUI_TEXT_COLOR_EXCESS')
    const four = page(
      text({ id: 'a', color: { r: 17, g: 24, b: 39 } }),
      text({ id: 'b', color: { r: 55, g: 65, b: 81 } }),
      text({ id: 'c', color: { r: 75, g: 85, b: 99 } }),
      text({ id: 'd', color: { r: 31, g: 41, b: 55 } }),
    )
    expect(codes([four])).toContain('RUI_TEXT_COLOR_EXCESS')
  })

  it('flags over-wide body copy in both Latin and CJK, and leaves titles alone', () => {
    const wideLatin = page(text({ role: 'body', text: 'a'.repeat(200), lines: 2 }))
    expect(codes([wideLatin])).toContain('RUI_MEASURE_TOO_WIDE')

    const wideCjk = page(text({ role: 'body', text: '中'.repeat(120), lines: 2 }))
    expect(codes([wideCjk])).toContain('RUI_MEASURE_TOO_WIDE')

    const narrow = page(text({ role: 'body', text: 'a'.repeat(60), lines: 2 }))
    expect(codes([narrow])).not.toContain('RUI_MEASURE_TOO_WIDE')

    const title = page(text({ role: 'title', text: 'x'.repeat(300), lines: 2, fontSize: 44, lineHeightPx: 52.8 }))
    expect(codes([title])).toEqual([])
  })

  it('flags tight body leading but allows tight display leading', () => {
    const tightBody = page(text({ role: 'body', text: 'a'.repeat(60), lines: 2, lineHeightPx: 26 }))
    expect(codes([tightBody])).toContain('RUI_LINE_HEIGHT_TIGHT')

    const tightDisplay = page(text({ id: 'title-1', role: 'title', fontSize: 44, lineHeightPx: 30, text: 'a'.repeat(40), lines: 2 }))
    expect(codes([tightDisplay])).toEqual([])
  })

  it('enforces the weight floor for UI text only', () => {
    expect(codes([page(text({ fontSize: 16, fontWeight: 300, lineHeightPx: 24 }))])).toContain('RUI_WEIGHT_TOO_LIGHT')
    expect(codes([page(text({ fontSize: 64, fontWeight: 300, lineHeightPx: 64 }))])).not.toContain('RUI_WEIGHT_TOO_LIGHT')
  })

  it('does not read near-white paper tints or near-black grounds as coloured fields', () => {
    // #FFFDFC is 100% saturated in HSL but visually paper; grey text on it is
    // just grey text on a light page, not the §2.3 anti-pattern.
    const onPaper = page(text({ color: COOL_GREY, background: { r: 255, g: 253, b: 252 }, fontSize: 20, lineHeightPx: 30 }))
    expect(codes([onPaper])).not.toContain('RUI_GREY_ON_COLOR')

    const onInk = page(text({ color: { r: 120, g: 130, b: 140 }, background: { r: 11, g: 27, b: 42 }, fontSize: 20, lineHeightPx: 30 }))
    expect(codes([onInk])).not.toContain('RUI_GREY_ON_COLOR')
  })

  it('excludes huge pale ghost numerals from every rule', () => {
    // Theme poster device: a 200px numeral at 4-10% ink, opaque rather than
    // opacity-dimmed. It is decorative, so it is not a contrast failure, does
    // not add a text colour and does not add a type step.
    const ghostNumeral = page(
      text({ id: 'ghost', fontSize: 200, lineHeightPx: 200, color: { r: 241, g: 245, b: 250 }, background: WHITE, text: '07' }),
      text({ id: 'title-1', role: 'title', fontSize: 44, lineHeightPx: 52.8 }),
    )
    expect(designRuleFindings([ghostNumeral])).toEqual([])
  })

  it('treats role-less 32px section headings as display type, not body copy', () => {
    // The documented scale sets 小节标题 32px/1.25: tight leading is correct there.
    const section = page(text({ id: 'section-1', fontSize: 32, lineHeightPx: 40, text: 'a'.repeat(50), lines: 2 }))
    expect(codes([section])).toEqual([])
  })

  it('flags scattered type sizes and a third font family', () => {
    const sizes = page(...[16, 17, 20, 24, 26, 32, 44].map((fontSize, index) => text({
      id: `t-${index}`, fontSize, lineHeightPx: fontSize * 1.4,
    })))
    expect(codes([sizes])).toContain('RUI_TYPE_SIZE_SCATTER')

    const families = page(
      text({ id: 'a', fontFamily: 'Liter' }),
      text({ id: 'b', fontFamily: 'Segoe UI' }),
      text({ id: 'c', fontFamily: 'DejaVu Sans' }),
    )
    expect(codes([families])).toContain('RUI_FONT_FAMILY_EXCESS')
  })

  it('flags untracked uppercase labels and accepts tracked ones', () => {
    const untracked = page(text({ id: 'eyebrow-1', fontSize: 16, lineHeightPx: 24, textTransform: 'uppercase' }))
    expect(codes([untracked])).toContain('RUI_LABEL_TRACKING_MISSING')

    const tracked = page(text({ id: 'eyebrow-1', fontSize: 16, lineHeightPx: 24, textTransform: 'uppercase', letterSpacingPx: 0.5 }))
    expect(codes([tracked])).not.toContain('RUI_LABEL_TRACKING_MISSING')

    const sentence = page(text({ id: 'label-1', fontSize: 16, lineHeightPx: 24 }))
    expect(codes([sentence])).not.toContain('RUI_LABEL_TRACKING_MISSING')

    // Typed capitals without `text-transform` are still all-caps labels.
    const typed = page(text({ id: 'label-2', fontSize: 16, lineHeightPx: 24, text: 'OVERVIEW' }))
    expect(codes([typed])).toContain('RUI_LABEL_TRACKING_MISSING')
  })

  it('ignores decorative ghost layers', () => {
    expect(designRuleFindings([page(text({ opacity: 0.1, color: MID_GREY, fontSize: 20, lineHeightPx: 30 }))])).toEqual([])
  })

  it('reports one finding per rule per page and keeps every offender', () => {
    const two = designRuleFindings([page(
      text({ id: 'body-1', color: MID_GREY, fontSize: 20, lineHeightPx: 30 }),
      text({ id: 'body-2', color: MID_GREY, fontSize: 20, lineHeightPx: 30 }),
    )])
    const contrast = two.filter(finding => finding.code === 'RUI_CONTRAST_LOW')
    expect(contrast).toHaveLength(1)
    expect(contrast[0]!.message).toContain('body-1')
    expect(contrast[0]!.message).toContain('body-2')
  })

  it('keeps page numbers and tolerates empty decks', () => {
    const findings = designRuleFindings([{ page: 3, texts: [text({ color: MID_GREY, fontSize: 20, lineHeightPx: 30 })] }])
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ page: 3 })]))
    expect(designRuleFindings([])).toEqual([])
    expect(designRuleFindings([{ page: 1, texts: [] }])).toEqual([])
    expect(designRuleFindings([page(text({ text: '   ' }))])).toEqual([])
  })
})

describe('refactoring UI rule catalogue', () => {
  it('lists every rule with an id, a law citation and an invariant', () => {
    expect(DESIGN_RULES).toHaveLength(9)
    expect(new Set(DESIGN_RULES.map(rule => rule.id)).size).toBe(DESIGN_RULES.length)
    for (const rule of DESIGN_RULES) {
      expect(rule.id).toMatch(/^RUI_[A-Z_]+$/u)
      expect(rule.law).toMatch(/^§\d/u)
      expect(rule.invariant.length).toBeGreaterThan(20)
    }
  })

  it('keeps the review probes for the laws a machine cannot judge', () => {
    expect(DESIGN_REVIEW_PROBES.length).toBeGreaterThanOrEqual(2)
    expect(DESIGN_REVIEW_PROBES.join(' ')).toMatch(/primary/u)
    expect(DESIGN_REVIEW_PROBES.join(' ')).toMatch(/group spacing/u)
  })
})
