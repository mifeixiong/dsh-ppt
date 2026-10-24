import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createTextMetrics, estimateMeasurement, estimateTextWidth, loadSystemTextMetrics } from '../../src/text-metrics.ts'
import type { DiscoveredFont } from '../../src/fonts.ts'

/**
 * The SVG lane has no browser to ask how wide a string is, so measurement is a
 * correctness surface: a wrong advance width moves every anchored label. These
 * tests pin the estimate fallback exactly and the real-font path structurally
 * (a font file is machine-specific, so its numbers cannot be asserted).
 */

function latinFontFile(): string | undefined {
  const candidates = [
    'C:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
  ]
  return candidates.find(candidate => existsSync(candidate))
}

function syntheticFont(): DiscoveredFont | undefined {
  const file = latinFontFile()
  if (file === undefined) return undefined
  const codePoints = new Set<number>()
  for (let code = 0x20; code <= 0x7e; code += 1) codePoints.add(code)
  return {
    name: 'Arial',
    file,
    sha256: '0'.repeat(64),
    familyName: 'Arial',
    postscriptName: 'ArialMT',
    weight: 'Regular',
    glyphCount: codePoints.size,
    supportsLatin: true,
    supportsCjk: false,
    codePoints,
  }
}

describe('text metrics', () => {
  it('estimates CJK at a full em and Latin below it', () => {
    expect(estimateTextWidth('中', 100)).toBeCloseTo(100, 5)
    expect(estimateTextWidth('ii', 100)).toBeLessThan(estimateTextWidth('mm', 100))
    expect(estimateTextWidth('ab', 100)).toBeCloseTo(estimateTextWidth('ab', 50) * 2, 5)
  })

  it('falls back to the estimate when the family is unknown', () => {
    const metrics = createTextMetrics([])
    expect(metrics.hasFamily('Arial')).toBe(false)
    const measured = estimateMeasurement('Hello', 32)
    expect(measured.measured).toBe(false)
    expect(measured.ascent + measured.descent).toBeCloseTo(32, 5)
  })

  it('measures a real face when one is available', async () => {
    const font = syntheticFont()
    if (font === undefined) return
    const metrics = createTextMetrics([font])
    expect(metrics.hasFamily('arial')).toBe(true)
    await metrics.preload(['Arial'])
    const wide = await metrics.measure({ family: 'Arial', weight: 400, italic: false, sizePx: 100, text: 'Hello' })
    const narrow = await metrics.measure({ family: 'Arial', weight: 400, italic: false, sizePx: 100, text: 'Hi' })
    expect(wide.measured).toBe(true)
    expect(wide.width).toBeGreaterThan(narrow.width)
    // 100 px type: five Latin letters land far below one em each.
    expect(wide.width).toBeGreaterThan(150)
    expect(wide.width).toBeLessThan(400)
    expect(wide.ascent).toBeGreaterThan(50)
    expect(wide.descent).toBeGreaterThan(0)
  })

  it('scales linearly with the requested size', async () => {
    const font = syntheticFont()
    if (font === undefined) return
    const metrics = createTextMetrics([font])
    const small = await metrics.measure({ family: 'Arial', weight: 400, italic: false, sizePx: 20, text: 'Deck' })
    const large = await metrics.measure({ family: 'Arial', weight: 400, italic: false, sizePx: 40, text: 'Deck' })
    expect(large.width).toBeCloseTo(small.width * 2, 0)
  })

  it('exposes the process-wide system provider', async () => {
    const metrics = await loadSystemTextMetrics()
    expect(typeof metrics.measure).toBe('function')
  })
})
