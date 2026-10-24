import { describe, expect, it } from 'vitest'
import { BARCODE_PAYLOAD, code39Bars, findMotif, MOTIF_IDS, MOTIFS, motifSvgFinding, renderMotif } from '../../src/motifs.ts'
import { PPT_THEMES } from '../../src/themes.ts'

/** Independent copy of the standard table, used only to decode the motif. */
const CODE39_DECODE = new Map(Object.entries({
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001',
  '5': '100110000', '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100',
  'A': '100001001', 'B': '001001001', 'C': '101001000', 'D': '000011001', 'E': '100011000',
  'F': '001011000', 'G': '000001101', 'H': '100001100', 'I': '001001100', 'J': '000011100',
  'K': '100000011', 'L': '001000011', 'M': '101000010', 'N': '000010011', 'O': '100010010',
  'P': '001010010', 'Q': '000000111', 'R': '100000110', 'S': '001000110', 'T': '000010110',
  'U': '110000001', 'V': '011000001', 'W': '111000000', 'X': '010010001', 'Y': '110010000',
  'Z': '011010000', '-': '010000101', '.': '110000100', ' ': '011000100', '$': '010101000',
  '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100',
}).map(([char, pattern]) => [pattern, char]))

interface DecodedBarcode {
  text: string
  narrow: number
  wide: number
  leftQuiet: number
  rightQuiet: number
}

/** Decode a rendered barcode motif from its bar rectangles, the way a scanner reads a scanline. */
function decodeBarcode(svg: string, canvasWidth: number): DecodedBarcode {
  const rects = [...svg.matchAll(/<rect x="(\d+)" y="\d+" width="(\d+)" height="\d+"/gu)]
    .map(match => ({ x: Number(match[1]), width: Number(match[2]) }))
    .sort((left, right) => left.x - right.x)
  const widths = rects.map(rect => rect.width)
  const narrow = Math.min(...widths)
  const wide = Math.max(...widths)
  const threshold = (narrow + wide) / 2
  const elements: number[] = []
  rects.forEach((rect, index) => {
    elements.push(rect.width)
    const next = rects[index + 1]
    if (next !== undefined) elements.push(next.x - (rect.x + rect.width))
  })
  const chars: string[] = []
  for (let index = 0; index + 9 <= elements.length; index += 10) {
    const pattern = elements.slice(index, index + 9).map(width => (width > threshold ? '1' : '0')).join('')
    chars.push(CODE39_DECODE.get(pattern) ?? '?')
  }
  const last = rects[rects.length - 1]
  return {
    text: chars.join(''),
    narrow,
    wide,
    leftQuiet: rects[0]?.x ?? 0,
    rightQuiet: canvasWidth - ((last?.x ?? 0) + (last?.width ?? 0)),
  }
}

describe('generative motif library', () => {
  it('ships the fifteen requested pattern families with unique ids', () => {
    expect(MOTIFS).toHaveLength(15)
    expect(new Set(MOTIF_IDS).size).toBe(MOTIF_IDS.length)
    for (const id of [
      'concentric-circles', 'halftone-dots', 'hud-lines', 'tick-circle', 'barcode', 'wave-texture',
      'repeat-lines', 'dot-matrix', 'polygon-mesh', 'contour-lines', 'common-shapes', 'nested-polygons',
      'wireframe-globe', 'square-grid', 'radial-rays',
    ]) {
      expect(MOTIF_IDS).toContain(id)
    }
  })

  it('renders deterministic, whitelist-safe SVG in the supplied palette', () => {
    for (const motif of MOTIFS) {
      const first = renderMotif(motif.id, { ink: '#111827', accent: '#0B57D0' })
      const second = renderMotif(motif.id, { ink: '#111827', accent: '#0B57D0' })
      expect(second).toBe(first)
      expect(first.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
      expect(first).toContain(`width="${motif.width}"`)
      expect(first).toContain(`height="${motif.height}"`)
      expect(first).toContain('#111827')
      expect(first).toContain('#0B57D0')
      expect(motifSvgFinding(first)).toBeUndefined()
    }
  })

  it('keeps every motif small enough to ship inside a tool response', () => {
    for (const motif of MOTIFS) {
      expect(renderMotif(motif.id, { ink: '#111827', accent: '#0B57D0' }).length).toBeLessThan(32 * 1024)
    }
  })

  it('rejects an unknown motif instead of rendering an empty image', () => {
    expect(findMotif('not-a-motif')).toBeUndefined()
    expect(() => renderMotif('not-a-motif', { ink: '#111827', accent: '#0B57D0' })).toThrow(/unknown motif/u)
  })

  it('gives every theme at least one real motif', () => {
    for (const theme of PPT_THEMES) {
      for (const id of theme.motifs) expect(findMotif(id), `${theme.id} ${id}`).toBeDefined()
    }
  })

  it('flags blocked SVG features and external references', () => {
    expect(motifSvgFinding('<svg><filter id="x"/></svg>')).toContain('blocked')
    expect(motifSvgFinding('<svg><image href="x.png"/></svg>')).toContain('blocked')
    expect(motifSvgFinding('<svg><rect style="fill:url(#x)"/></svg>')).toContain('external')
  })

  it('draws the barcode as a real Code 39 pattern that decodes back to its payload', () => {
    const svg = renderMotif('barcode', { ink: '#111827', accent: '#0B57D0' })
    const decoded = decodeBarcode(svg, 520)
    expect(decoded.text).toBe(`*${BARCODE_PAYLOAD}*`)
    // Integer module grid: exactly two bar widths, in the allowed 2:1–3:1 band.
    expect(decoded.narrow).toBe(3)
    expect(decoded.wide).toBe(7)
    expect(decoded.wide / decoded.narrow).toBeGreaterThanOrEqual(2)
    expect(decoded.wide / decoded.narrow).toBeLessThanOrEqual(3)
    // Ten narrow modules of quiet zone on both sides of the pattern.
    expect(decoded.leftQuiet).toBeGreaterThanOrEqual(40)
    expect(decoded.rightQuiet).toBeGreaterThanOrEqual(40)
  })

  it('encodes only the Code 39 character set and rejects everything else', () => {
    expect(code39Bars('abc', { module: 3 }).bars).toEqual(code39Bars('ABC', { module: 3 }).bars)
    expect(() => code39Bars('中文', { module: 3 })).toThrow(/cannot encode/u)
    expect(() => code39Bars('A', { module: 2.5 })).toThrow(/integer module/u)
    const { bars, width } = code39Bars('A', { module: 4 })
    expect(bars).toHaveLength(15)
    // Three characters (`*A*`): ten quiet modules, nine elements each, two gaps.
    expect(width).toBe(2 * 10 * 4 + 3 * (6 * 4 + 3 * 9) + 2 * 4)
  })
})
