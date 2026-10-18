import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { PptError } from '../../src/errors.ts'
import { injectTextOpacity, rewritePptxTextOpacity } from '../../src/text-effects.ts'

const NAMESPACE = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

function shape(name: string, color: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${name}</a:t></a:r></a:p></p:txBody></p:sp>`
}

function slideXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ${NAMESPACE}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
}

function fakePackage(entries: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, xml]) => [name, strToU8(xml)])))
}

describe('text opacity injection', () => {
  it('adds run alpha to the named shape only', () => {
    const xml = slideXml(shape('ghost', '111827') + shape('foreground', '111827'))
    const output = injectTextOpacity(xml, [{ id: 'ghost', opacity: 0.12 }])
    expect(output).toContain('<a:srgbClr val="111827"><a:alpha val="12000"/></a:srgbClr>')
    expect(output.match(/<a:alpha val="12000"\/>/gu)).toHaveLength(1)
    // The foreground shape keeps its opaque run colour.
    expect(output.split('name="foreground"')[1]).not.toContain('a:alpha')
  })

  it('clamps alpha to the 0..100000 range', () => {
    const xml = slideXml(shape('ghost', '111827'))
    expect(injectTextOpacity(xml, [{ id: 'ghost', opacity: 1.4 }])).toContain('<a:alpha val="100000"/>')
    expect(injectTextOpacity(xml, [{ id: 'ghost', opacity: -1 }])).toContain('<a:alpha val="0"/>')
  })

  it('leaves a shape without a run colour untouched', () => {
    const xml = slideXml('<p:sp><p:nvSpPr><p:cNvPr id="2" name="ghost"/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/></p:txBody></p:sp>')
    expect(injectTextOpacity(xml, [{ id: 'ghost', opacity: 0.2 }])).toBe(xml)
  })

  it('throws when the planned shape is missing', () => {
    const xml = slideXml(shape('other', '111827'))
    expect(() => injectTextOpacity(xml, [{ id: 'ghost', opacity: 0.2 }])).toThrow(PptError)
  })

  it('rewrites only the planned slide parts', () => {
    const packageBytes = fakePackage({
      '[Content_Types].xml': '<Types/>',
      'ppt/slides/slide1.xml': slideXml(shape('ghost', '111827')),
      'ppt/slides/slide2.xml': slideXml(shape('other', '111827')),
    })
    const output = rewritePptxTextOpacity(packageBytes, new Map([[1, [{ id: 'ghost', opacity: 0.12 }]]]))
    expect(output.byteLength).toBeGreaterThan(0)
    const files = unzipSync(output)
    expect(strFromU8(files['ppt/slides/slide1.xml']!)).toContain('<a:alpha val="12000"/>')
    expect(strFromU8(files['ppt/slides/slide2.xml']!)).not.toContain('a:alpha')
    // Empty plan is byte-identical.
    expect(rewritePptxTextOpacity(packageBytes, new Map())).toBe(packageBytes)
  })

  it('rejects an invalid page and a page with no slide part', () => {
    const packageBytes = fakePackage({ 'ppt/slides/slide1.xml': slideXml(shape('ghost', '111827')) })
    expect(() => rewritePptxTextOpacity(packageBytes, new Map([[0, [{ id: 'ghost', opacity: 0.2 }]]]))).toThrow(PptError)
    expect(() => rewritePptxTextOpacity(packageBytes, new Map([[2, [{ id: 'ghost', opacity: 0.2 }]]]))).toThrow(PptError)
  })
})
