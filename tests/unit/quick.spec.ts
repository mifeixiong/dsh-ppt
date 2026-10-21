import { describe, expect, it } from 'vitest'
import {
  BOTTOM, CONTENT_W, MARGIN_X, MARGIN_Y, TYPE_SCALE,
  buildOutlineDeckIr, contrastRatio, ensureContrast, familyFor, fitDisplay, paletteFor, parseColor, wrapText,
} from '../../src/quick.ts'
import { validatePptOutline } from '../../src/outline.ts'
import type { ElementIR } from '../../src/ir.ts'

/** A deck that exercises every page family the fast lane can pick. */
const DECK = [
  {
    page: 1, type: 'cover', title: 'Fast lane',
    content: [{ kind: 'point', text: 'Outline in, deck out' }],
    style: { layout: 'cover', background: 'dark', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Bold cover' },
  },
  {
    page: 2, type: 'section', title: 'Why it is faster',
    content: [{ kind: 'point', text: 'Two calls instead of six' }],
    style: { layout: 'center', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Section break' },
  },
  {
    page: 3, type: 'content', title: 'The old pipeline',
    content: [
      { kind: 'point', text: 'Author a full 1280x720 HTML deck by hand', label: 'Step one' },
      { kind: 'point', text: 'Render every page in a browser to measure it' },
      { kind: 'point', text: 'Iterate until the RUI findings are clear' },
      { kind: 'point', text: 'Only then convert to PPTX' },
    ],
    style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Quiet body page' },
  },
  {
    page: 4, type: 'agenda', title: 'Today',
    content: [
      { kind: 'point', text: 'Content model', group: 'Input' },
      { kind: 'point', text: 'Design plan', group: 'Input' },
      { kind: 'point', text: 'Deterministic layout', group: 'Engine' },
      { kind: 'point', text: 'Native PPTX writer', group: 'Engine' },
    ],
    style: { layout: 'two-column', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Two columns' },
  },
  {
    page: 5, type: 'timeline', title: 'Rollout',
    content: [
      { kind: 'point', text: 'Draft', label: 'Week 1' },
      { kind: 'point', text: 'Pilot', label: 'Week 3' },
      { kind: 'point', text: 'Ship', label: 'Week 6' },
    ],
    style: { layout: 'timeline-horizontal', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Timeline' },
  },
  {
    page: 6, type: 'process', title: 'How a page is built',
    content: [
      { kind: 'point', text: 'Pick a page family from the layout', label: 'Classify' },
      { kind: 'point', text: 'Measure the copy against the column', label: 'Measure' },
      { kind: 'point', text: 'Emit native text, rules and metrics', label: 'Emit' },
    ],
    style: { layout: 'process-vertical', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Vertical process' },
  },
  {
    page: 7, type: 'data', title: 'What it saves',
    content: [
      { kind: 'data', label: 'Calls', value: 2, unit: 'calls' },
      { kind: 'data', label: 'HTML lines', value: 0, unit: 'lines' },
      { kind: 'data', label: 'Browser runs', value: 0, unit: 'runs' },
      { kind: 'data', label: 'Seconds', value: 3, unit: 'sec' },
      { kind: 'chart', chart_type: 'bar', subject: 'Work removed', takeaway: 'Six authoring steps collapse into one layout pass' },
    ],
    style: { layout: 'chart-focus', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Chart focus' },
  },
  {
    page: 8, type: 'comparison', title: 'Before and after',
    content: [
      { kind: 'point', text: 'Six tool calls', group: 'Before' },
      { kind: 'point', text: 'Browser render per page', group: 'Before' },
      { kind: 'point', text: 'Two tool calls', group: 'After' },
      { kind: 'point', text: 'No render, no HTML', group: 'After' },
    ],
    style: { layout: 'split', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Split comparison' },
  },
  {
    page: 9, type: 'quote', title: 'Make the boring path',
    content: [
      { kind: 'point', text: 'Make the boring path the fast path' },
      { kind: 'point', text: 'Design note' },
    ],
    style: { layout: 'quote-focus', background: 'accent', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Pull quote' },
  },
  {
    page: 10, type: 'ending', title: 'Thank you',
    content: [],
    style: { layout: 'closing', background: 'dark', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Closing' },
  },
]

const outline = validatePptOutline(DECK)

function texts(elements: readonly ElementIR[]): ElementIR[] {
  return elements.filter(element => element.kind === 'text')
}

function overlaps(a: ElementIR, b: ElementIR): boolean {
  const width = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x)
  const height = Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y)
  return width > 2 && height > 2
}

describe('fast lane layout', () => {
  it('wraps copy without losing characters and honours CJK width', () => {
    const latin = wrapText('Deterministic layout keeps every character it was given', 20, 240)
    expect(latin.length).toBeGreaterThan(1)
    expect(latin.join(' ').replace(/\s+/gu, ' ')).toBe('Deterministic layout keeps every character it was given')
    const cjk = wrapText('确定性排版把每一个字都保留下来', 20, 200)
    expect(cjk.length).toBeGreaterThan(1)
    expect(cjk.join('')).toBe('确定性排版把每一个字都保留下来')
  })

  it('keeps one unbreakable token inside its box', () => {
    const lines = wrapText('supercalifragilisticexpialidocious-supercalifragilistic', 40, 200)
    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines) expect([...line].length).toBeLessThan(12)
    expect(lines.join('')).toBe('supercalifragilisticexpialidocious-supercalifragilistic')
  })

  it('picks display sizes that only shrink when a word cannot fit', () => {
    expect(fitDisplay('Short', 72, 900, 36)).toBe(72)
    expect(fitDisplay('A very long single display headline that will not fit at all', 72, 400, 36)).toBeLessThan(72)
    expect(fitDisplay('A very long single display headline that will not fit at all', 72, 400, 36)).toBeGreaterThanOrEqual(36)
  })

  it('derives a palette whose ink and accent clear the contrast floor', () => {
    for (const role of ['light', 'dark', 'accent'] as const) {
      const palette = paletteFor(role, '#2563EB', undefined)
      const background = parseColor(palette.background)
      // A saturated accent field cannot offer 7:1 to any ink; 4.5:1 is its floor.
      const inkFloor = role === 'accent' ? 4.5 : 7
      expect(contrastRatio(parseColor(palette.ink), background)).toBeGreaterThanOrEqual(inkFloor)
      expect(contrastRatio(parseColor(palette.accent), background)).toBeGreaterThanOrEqual(2.9)
      expect(contrastRatio(parseColor(palette.muted), background)).toBeGreaterThanOrEqual(3)
    }
  })

  it('lifts a dull accent until it reads on a dark field instead of dropping it', () => {
    const dark = { r: 17, g: 19, b: 24 }
    const lifted = ensureContrast({ r: 37, g: 99, b: 235 }, dark, 3)
    expect(contrastRatio(lifted, dark)).toBeGreaterThanOrEqual(3)
  })

  it('maps every outline layout to a page family', () => {
    expect(familyFor(outline[0]!)).toBe('poster')
    expect(familyFor(outline[2]!)).toBe('statement')
    expect(familyFor(outline[3]!)).toBe('columns')
    expect(familyFor(outline[4]!)).toBe('sequenced')
    expect(familyFor(outline[6]!)).toBe('metrics')
    expect(familyFor(outline[8]!)).toBe('poster')
  })

  it('lays out every page inside the canvas with readable, non-empty copy', async () => {
    const deck = await buildOutlineDeckIr(outline, { workspace: process.cwd(), artifactRoot: process.cwd() })
    expect(deck.slides).toHaveLength(outline.length)
    for (const slide of deck.slides) {
      expect(slide.elements.length).toBeGreaterThan(0)
      const ids = new Set<string>()
      for (const element of slide.elements) {
        expect(element.box.x).toBeGreaterThanOrEqual(MARGIN_X - 1)
        expect(element.box.y).toBeGreaterThanOrEqual(MARGIN_Y - 1)
        expect(element.box.x + element.box.w).toBeLessThanOrEqual(MARGIN_X + CONTENT_W + 1)
        expect(element.box.y + element.box.h).toBeLessThanOrEqual(BOTTOM + 1)
        expect(ids.has(element.id)).toBe(false)
        ids.add(element.id)
        if (element.kind !== 'text') continue
        expect(element.text ?? '').not.toBe('')
        expect(element.style.fontSizePx).toBeGreaterThanOrEqual(12)
        expect(element.style.fontSizePx).toBeLessThanOrEqual(TYPE_SCALE.metric)
      }
    }
  })

  it('does not stack text boxes on top of each other', async () => {
    const deck = await buildOutlineDeckIr(outline, { workspace: process.cwd(), artifactRoot: process.cwd() })
    for (const slide of deck.slides) {
      const boxes = texts(slide.elements)
      for (let first = 0; first < boxes.length; first += 1) {
        for (let second = first + 1; second < boxes.length; second += 1) {
          expect(
            overlaps(boxes[first]!, boxes[second]!),
            `page ${slide.page}: ${boxes[first]!.id} overlaps ${boxes[second]!.id}`,
          ).toBe(false)
        }
      }
    }
  })

  it('carries speaker notes and keeps production notes out of the deck', async () => {
    const withNotes = validatePptOutline([{
      page: 1, type: 'content', title: 'Notes',
      content: [
        { kind: 'point', text: 'Visible' },
        { kind: 'note', purpose: 'speaker', text: 'Say this out loud' },
        { kind: 'note', purpose: 'production', text: 'Internal only' },
      ],
      style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Plain' },
    }])
    const deck = await buildOutlineDeckIr(withNotes, { workspace: process.cwd(), artifactRoot: process.cwd() })
    expect(deck.slides[0]!.speakerNotes).toEqual(['Say this out loud'])
    const copy = deck.slides[0]!.elements.map(element => element.text ?? '').join(' ')
    expect(copy).not.toContain('Internal only')
  })

  it('is deterministic: the same outline produces the same page', async () => {
    const first = await buildOutlineDeckIr(outline, { workspace: process.cwd(), artifactRoot: process.cwd() })
    const second = await buildOutlineDeckIr(outline, { workspace: process.cwd(), artifactRoot: process.cwd() })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
