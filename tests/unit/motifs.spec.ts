import { describe, expect, it } from 'vitest'
import { findMotif, MOTIF_IDS, MOTIFS, motifSvgFinding, renderMotif } from '../../src/motifs.ts'
import { PPT_THEMES } from '../../src/themes.ts'

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
})
