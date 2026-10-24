import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { PptError } from '../../src/errors.ts'
import {
  paintXml,
  replaceSlideShape,
  rewritePptxSlideShapes,
  shapeXml,
  strokeXml,
  type ShapeSpec,
} from '../../src/svg-ooxml.ts'
import type { Box, SubPath } from '../../src/svg-geometry.ts'

const SLIDE_NAMESPACE = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const DRAWING_NAMESPACE = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

function thrownBy(run: () => unknown): PptError {
  let failure: unknown
  try {
    run()
  } catch (error) {
    failure = error
  }
  if (failure instanceof PptError) return failure
  throw new Error(`expected a PptError, received ${failure === undefined ? 'no error' : String(failure)}`)
}

function placeholder(shapeId: number, name: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + '<p:spPr/></p:sp>'
}

function slideXml(...shapes: string[]): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<p:sld ${SLIDE_NAMESPACE} ${DRAWING_NAMESPACE}><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld>`
    + '<p:clrMapOvr/></p:sld>'
}

function fakePackage(entries: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, xml]) => [name, strToU8(xml)])))
}

function gradient(angleDeg: number): string {
  return paintXml({
    type: 'linear',
    angleDeg,
    stops: [{ offset: 0, color: 'FF0000' }, { offset: 1, color: '0000FF' }],
  })
}

function angleOf(angleDeg: number): string {
  const match = /<a:lin ang="(\d+)" scaled="1"\/>/u.exec(gradient(angleDeg))
  if (match === null) throw new Error(`no a:lin element in ${gradient(angleDeg)}`)
  return match[1]!
}

interface XmlNode {
  nodeName: string
  children: { length: number; item(index: number): XmlNode | null }
}

interface XmlDocument {
  documentElement: XmlNode | null
}

/**
 * Parses real XML (a `parsererror` element is produced for malformed input) and
 * returns the child element names at `path`, so a schema order can be asserted
 * on the tree instead of on a substring index.
 */
async function childNames(xml: string, path: readonly number[] = []): Promise<string[]> {
  const { Window } = await import('happy-dom')
  const domWindow = new Window()
  const Parser = (domWindow as unknown as {
    DOMParser: new () => { parseFromString(text: string, type: string): unknown }
  }).DOMParser
  const document = new Parser().parseFromString(xml, 'text/xml') as unknown as XmlDocument
  domWindow.close()
  const root = document.documentElement
  if (root === null) throw new Error('XML did not parse into a root element')
  let node: XmlNode = root
  for (const index of path) {
    const next: XmlNode | null = node.children.item(index)
    if (next === null) throw new Error(`XML node ${node.nodeName} has no child at ${index}`)
    node = next
  }
  const names: string[] = []
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children.item(index)
    if (child !== null) names.push(child.nodeName)
  }
  return names
}

/** Wraps one generated shape in a namespaced root so the XML parser can bind p:/a:. */
function wrapped(shape: string): string {
  return `<root ${SLIDE_NAMESPACE} ${DRAWING_NAMESPACE}>${shape}</root>`
}

describe('paint XML', () => {
  it('emits noFill for an absent paint', () => {
    expect(paintXml({ type: 'none' })).toBe('<a:noFill/>')
  })

  it('emits an opaque solid fill', () => {
    expect(paintXml({ type: 'solid', color: '112233' })).toBe(
      '<a:solidFill><a:srgbClr val="112233"/></a:solidFill>',
    )
  })

  it('carries the shape opacity as a 1/100000 alpha', () => {
    expect(paintXml({ type: 'solid', color: '112233' }, 0.42)).toBe(
      '<a:solidFill><a:srgbClr val="112233"><a:alpha val="42000"/></a:srgbClr></a:solidFill>',
    )
    expect(paintXml({ type: 'solid', color: '112233' }, 1)).toBe(
      '<a:solidFill><a:srgbClr val="112233"/></a:solidFill>',
    )
  })

  it('normalizes a short hex spelling to an uppercase RGB value', () => {
    expect(paintXml({ type: 'solid', color: '#a1b2c3' })).toBe(
      '<a:solidFill><a:srgbClr val="A1B2C3"/></a:solidFill>',
    )
  })

  it('emits a linear gradient with sorted, rounded stop positions', () => {
    expect(paintXml({
      type: 'linear',
      angleDeg: 90,
      stops: [
        { offset: 1, color: '0000FF' },
        { offset: 0.123456, color: '00FF00' },
        { offset: 0, color: 'FF0000' },
      ],
    })).toBe(
      '<a:gradFill rotWithShape="1"><a:gsLst>'
        + '<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>'
        + '<a:gs pos="12346"><a:srgbClr val="00FF00"/></a:gs>'
        + '<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs>'
        + '</a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill>',
    )
  })

  it('clamps stop offsets into 0..100000', () => {
    const xml = paintXml({
      type: 'linear',
      angleDeg: 0,
      stops: [{ offset: -0.5, color: 'FF0000' }, { offset: 1.5, color: '00FF00' }],
    })

    expect(xml).toContain('<a:gs pos="0">')
    expect(xml).toContain('<a:gs pos="100000">')
  })

  it('maps SVG-style angles into 60000ths of a degree', () => {
    expect(angleOf(0)).toBe('0')
    expect(angleOf(90)).toBe('5400000')
    expect(angleOf(135)).toBe('8100000')
    expect(angleOf(315)).toBe('18900000')
    expect(angleOf(-45)).toBe('18900000')
    expect(angleOf(360)).toBe('0')
    expect(angleOf(450)).toBe('5400000')
  })

  it('applies the shape opacity to every gradient stop', () => {
    const xml = paintXml({
      type: 'linear',
      angleDeg: 0,
      stops: [{ offset: 0, color: 'FF0000' }, { offset: 1, color: '00FF00' }],
    }, 0.3)

    expect(xml).toContain('<a:gs pos="0"><a:srgbClr val="FF0000"><a:alpha val="30000"/></a:srgbClr></a:gs>')
    expect(xml).toContain('<a:gs pos="100000"><a:srgbClr val="00FF00"><a:alpha val="30000"/></a:srgbClr></a:gs>')
  })

  it('emits a radial gradient as fillToRect around the focus point', () => {
    expect(paintXml({
      type: 'radial',
      focusX: 0.25,
      focusY: 0.5,
      stops: [{ offset: 0, color: 'FFFFFF' }, { offset: 1, color: '000000' }],
    })).toBe(
      '<a:gradFill><a:gsLst>'
        + '<a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs>'
        + '<a:gs pos="100000"><a:srgbClr val="000000"/></a:gs>'
        + '</a:gsLst><a:path path="circle"><a:fillToRect l="25000" t="50000" r="75000" b="50000"/>'
        + '</a:path></a:gradFill>',
    )
  })

  it('rejects stop lists outside the 2..8 range DrawingML can render', () => {
    const tooFew = thrownBy(() => paintXml({
      type: 'linear',
      angleDeg: 0,
      stops: [{ offset: 0, color: 'FF0000' }],
    }))
    expect(tooFew.code).toBe('SVG_GEOMETRY_INVALID')
    expect(tooFew.message).toContain('2')

    const nineStops = Array.from({ length: 9 }, (_unused, index) => ({ offset: index / 8, color: 'FF0000' }))
    const tooMany = thrownBy(() => paintXml({ type: 'radial', focusX: 0.5, focusY: 0.5, stops: nineStops }))
    expect(tooMany.code).toBe('SVG_GEOMETRY_INVALID')
    expect(tooMany.message).toContain('8')
  })

  it('rejects a colour that is not six hex digits', () => {
    const failure = thrownBy(() => paintXml({ type: 'solid', color: 'red' }))

    expect(failure.code).toBe('SVG_GEOMETRY_INVALID')
    expect(failure.message).toContain('red')
  })
})

describe('stroke XML', () => {
  const solid = { type: 'solid', color: '112233' } as const

  it('emits the width in EMU with the mapped cap', () => {
    expect(strokeXml({ paint: solid, widthPx: 2, cap: 'round' })).toBe(
      '<a:ln w="19050" cap="rnd"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:ln>',
    )
    expect(strokeXml({ paint: solid, widthPx: 2, cap: 'square' })).toContain(' cap="sq"')
    expect(strokeXml({ paint: solid, widthPx: 2, cap: 'butt' })).toContain(' cap="flat"')
    expect(strokeXml({ paint: solid, widthPx: 2 })).toContain('<a:ln w="19050">')
  })

  it('applies the shape opacity to the stroke paint', () => {
    expect(strokeXml({ paint: solid, widthPx: 1 }, 0.5)).toBe(
      '<a:ln w="9525"><a:solidFill><a:srgbClr val="112233"><a:alpha val="50000"/></a:srgbClr>'
        + '</a:solidFill></a:ln>',
    )
  })

  it('emits a preset dash', () => {
    expect(strokeXml({ paint: solid, widthPx: 1, dash: { preset: 'dash' } })).toBe(
      '<a:ln w="9525"><a:solidFill><a:srgbClr val="112233"/></a:solidFill>'
        + '<a:prstDash val="dash"/></a:ln>',
    )
  })

  it('emits a custom dash pair as 1000ths of a percent of the line width', () => {
    expect(strokeXml({ paint: solid, widthPx: 1, dash: { custom: { d: 300, sp: 150 } } })).toBe(
      '<a:ln w="9525"><a:solidFill><a:srgbClr val="112233"/></a:solidFill>'
        + '<a:custDash><a:ds d="300000" sp="150000"/></a:custDash></a:ln>',
    )
  })

  it('emits each join as its own element', () => {
    expect(strokeXml({ paint: solid, widthPx: 1, join: 'round' })).toContain('<a:round/></a:ln>')
    expect(strokeXml({ paint: solid, widthPx: 1, join: 'bevel' })).toContain('<a:bevel/></a:ln>')
    expect(strokeXml({ paint: solid, widthPx: 1, join: 'miter' })).toContain('<a:miter lim="800000"/></a:ln>')
  })

  it('writes children in the DrawingML schema order', () => {
    const xml = strokeXml({
      paint: solid,
      widthPx: 1,
      cap: 'square',
      dash: { preset: 'dot' },
      join: 'miter',
      headEnd: 'triangle',
      tailEnd: 'stealth',
    })

    expect(xml).toBe(
      '<a:ln w="9525" cap="sq"><a:solidFill><a:srgbClr val="112233"/></a:solidFill>'
        + '<a:prstDash val="dot"/><a:miter lim="800000"/>'
        + '<a:headEnd type="triangle" w="med" len="med"/>'
        + '<a:tailEnd type="stealth" w="med" len="med"/></a:ln>',
    )
    expect(xml.indexOf('<a:solidFill>')).toBeLessThan(xml.indexOf('<a:prstDash'))
    expect(xml.indexOf('<a:prstDash')).toBeLessThan(xml.indexOf('<a:miter'))
    expect(xml.indexOf('<a:miter')).toBeLessThan(xml.indexOf('<a:headEnd'))
    expect(xml.indexOf('<a:headEnd')).toBeLessThan(xml.indexOf('<a:tailEnd'))
  })

  it('omits a line end of type none', () => {
    expect(strokeXml({ paint: solid, widthPx: 1, headEnd: 'none', tailEnd: 'none' })).not.toContain('headEnd')
  })

  it('drops to noFill for a non-positive width or a none paint', () => {
    expect(strokeXml({ paint: solid, widthPx: 0 })).toBe('<a:ln><a:noFill/></a:ln>')
    expect(strokeXml({ paint: solid, widthPx: -4 })).toBe('<a:ln><a:noFill/></a:ln>')
    expect(strokeXml({ paint: { type: 'none' }, widthPx: 4, cap: 'round' })).toBe('<a:ln><a:noFill/></a:ln>')
  })
})

describe('shape XML', () => {
  const rectSpec: ShapeSpec = {
    id: 'rect-1',
    name: 'Rect',
    geometry: { kind: 'preset', preset: 'rect', box: { x: 10, y: 20, w: 100, h: 40 } },
    fill: { type: 'solid', color: 'FF8800' },
    opacity: 0.5,
    stroke: { paint: { type: 'solid', color: '112233' }, widthPx: 2, cap: 'round', join: 'round' },
  }

  it('builds the full p:sp wrapper for a preset rectangle', () => {
    expect(shapeXml(rectSpec, 3)).toBe(
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="rect-1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        + '<p:spPr><a:xfrm><a:off x="95250" y="190500"/><a:ext cx="952500" cy="381000"/></a:xfrm>'
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
        + '<a:solidFill><a:srgbClr val="FF8800"><a:alpha val="50000"/></a:srgbClr></a:solidFill>'
        + '<a:ln w="19050" cap="rnd"><a:solidFill><a:srgbClr val="112233">'
        + '<a:alpha val="50000"/></a:srgbClr></a:solidFill><a:round/></a:ln>'
        + '</p:spPr></p:sp>',
    )
  })

  it('keeps the CT_Shape child order and the CT_ShapeProperties child order', async () => {
    const xml = wrapped(shapeXml(rectSpec, 3))

    expect(await childNames(xml)).toEqual(['p:sp'])
    expect(await childNames(xml, [0])).toEqual(['p:nvSpPr', 'p:spPr'])
    expect(await childNames(xml, [0, 1])).toEqual(['a:xfrm', 'a:prstGeom', 'a:solidFill', 'a:ln'])
  })

  it('adds the roundRect adjustment as a fraction of the short side', () => {
    const roundRect = (radiusPx: number): string => shapeXml({
      id: 'r',
      name: 'R',
      geometry: { kind: 'preset', preset: 'roundRect', box: { x: 0, y: 0, w: 100, h: 40 }, radiusPx },
      fill: { type: 'none' },
    }, 2)

    expect(roundRect(12)).toContain('<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 30000"/></a:avLst></a:prstGeom>')
    expect(roundRect(50)).toContain('fmla="val 50000"')
  })

  it('emits an ellipse preset with an empty adjustment list', () => {
    const xml = shapeXml({
      id: 'oval',
      name: 'Oval',
      geometry: { kind: 'preset', preset: 'ellipse', box: { x: 0, y: 0, w: 32, h: 32 } },
      fill: { type: 'solid', color: '00AAFF' },
    }, 9)

    expect(xml).toContain('<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>')
    expect(xml).toContain('<a:ln><a:noFill/></a:ln>')
    expect(xml).toContain('<a:ext cx="304800" cy="304800"/>')
  })

  it('keeps flipH and flipV on a line preset, and never emits a zero extent', () => {
    const xml = shapeXml({
      id: 'line-1',
      name: 'Line',
      geometry: { kind: 'preset', preset: 'line', box: { x: 0, y: 0, w: 80, h: 0 }, flipH: true, flipV: true },
      fill: { type: 'none' },
      stroke: { paint: { type: 'solid', color: '000000' }, widthPx: 1, headEnd: 'triangle', tailEnd: 'oval' },
    }, 4)

    expect(xml).toContain('<a:xfrm flipH="1" flipV="1"><a:off x="0" y="0"/><a:ext cx="762000" cy="1"/></a:xfrm>')
    expect(xml).toContain('<a:prstGeom prst="line"><a:avLst/></a:prstGeom>')
    expect(xml).toContain('<a:headEnd type="triangle" w="med" len="med"/>')
    expect(xml).toContain('<a:tailEnd type="oval" w="med" len="med"/>')
  })

  it('wraps path geometry in custGeom and delegates the path list', () => {
    const box: Box = { x: 0, y: 0, w: 10, h: 10 }
    const open: SubPath[] = [{
      start: { x: 0, y: 0 },
      segments: [
        { type: 'move', to: { x: 0, y: 0 } },
        { type: 'line', to: { x: 10, y: 10 } },
      ],
      closed: false,
    }]

    const strokedOnly = shapeXml({
      id: 'free-1',
      name: 'Free',
      geometry: { kind: 'path', subpaths: open, box, fillable: false },
      fill: { type: 'none' },
      stroke: { paint: { type: 'solid', color: '000000' }, widthPx: 1 },
    }, 7)

    expect(strokedOnly).toContain(
      '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst>',
    )
    expect(strokedOnly).toContain('<a:path w="95250" h="95250" fill="none"')
    expect(strokedOnly).toContain('<a:moveTo><a:pt x="0" y="0"/></a:moveTo>')
    expect(strokedOnly).toContain('<a:lnTo><a:pt x="95250" y="95250"/></a:lnTo>')
    expect(strokedOnly).toContain('<a:ext cx="95250" cy="95250"/>')

    const closedCurve: SubPath[] = [{
      start: { x: 0, y: 0 },
      segments: [
        { type: 'move', to: { x: 0, y: 0 } },
        { type: 'cubic', c1: { x: 2, y: 0 }, c2: { x: 8, y: 10 }, to: { x: 10, y: 10 } },
        { type: 'close' },
      ],
      closed: true,
    }]
    const fillable = shapeXml({
      id: 'free-2',
      name: 'Free',
      geometry: { kind: 'path', subpaths: closedCurve, box, fillable: true },
      fill: { type: 'solid', color: '445566' },
    }, 8)

    expect(fillable).toContain('fill="norm"')
    expect(fillable).toContain('<a:cubicBezTo>')
    expect(fillable).toContain('<a:close/>')
  })

  it('produces well-formed path geometry', async () => {
    const xml = shapeXml({
      id: 'free-3',
      name: 'Free',
      geometry: {
        kind: 'path',
        subpaths: [{
          start: { x: 0, y: 0 },
          segments: [
            { type: 'move', to: { x: 0, y: 0 } },
            { type: 'line', to: { x: 10, y: 10 } },
            { type: 'close' },
          ],
          closed: true,
        }],
        box: { x: 0, y: 0, w: 10, h: 10 },
        fillable: true,
      },
      fill: { type: 'solid', color: '445566' },
    }, 11)
    const wrappedXml = wrapped(xml)

    expect(await childNames(wrappedXml, [0, 1])).toEqual(['a:xfrm', 'a:custGeom', 'a:solidFill', 'a:ln'])
    expect(await childNames(wrappedXml, [0, 1, 1])).toEqual([
      'a:avLst',
      'a:gdLst',
      'a:ahLst',
      'a:cxnLst',
      'a:rect',
      'a:pathLst',
    ])
  })

  it('escapes the name attribute', () => {
    const xml = shapeXml({
      id: 'a&b<c>"d"\'e',
      name: 'Escaped',
      geometry: { kind: 'preset', preset: 'rect', box: { x: 0, y: 0, w: 1, h: 1 } },
      fill: { type: 'none' },
    }, 2)

    expect(xml).toContain('name="a&amp;b&lt;c&gt;&quot;d&quot;&apos;e"')
  })
})

describe('slide shape replacement', () => {
  const replacement = '<p:sp><p:nvSpPr><p:cNvPr id="3" name="b"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
    + '<p:spPr><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></p:spPr></p:sp>'

  it('replaces only the named shape and keeps its siblings byte-identical', () => {
    const first = placeholder(2, 'a')
    const third = placeholder(4, 'c')
    const slide = slideXml(first, placeholder(3, 'b'), third)
    const replaced = replaceSlideShape(slide, 'b', replacement)

    expect(replaced).toBe(slideXml(first, replacement, third))
    expect(replaced).toContain(first)
    expect(replaced).toContain(third)
    expect(replaced.match(/<p:cNvPr\b/gu)).toHaveLength(3)
    expect(replaced.match(/<p:sp[\s>]/gu)).toHaveLength(3)
    expect(replaced.match(/<\/p:sp>/gu)).toHaveLength(3)
  })

  it('finds a shape nested in a group shape', () => {
    const group = `<p:grpSp>${placeholder(5, 'inner')}</p:grpSp>`
    const replaced = replaceSlideShape(slideXml(group), 'inner', replacement)

    expect(replaced).toBe(slideXml(`<p:grpSp>${replacement}</p:grpSp>`))
  })

  it('matches an escaped name', () => {
    const slide = slideXml(placeholder(2, 'a&amp;b'))
    const replaced = replaceSlideShape(slide, 'a&b', replacement)

    expect(replaced).toContain(replacement)
    expect(replaced).not.toContain('name="a&amp;b"')
  })

  it('throws when no shape carries the name', () => {
    const failure = thrownBy(() => replaceSlideShape(slideXml(placeholder(2, 'a')), 'missing', replacement))

    expect(failure.code).toBe('PPT_CREATE_INVALID_PACKAGE')
    expect(failure.message).toContain('no shape named missing')
  })

  it('throws when the shape element is unterminated', () => {
    const slide = `<p:sld ${SLIDE_NAMESPACE}><p:cSld><p:spTree>`
      + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="a"/></p:nvSpPr></p:spTree></p:cSld></p:sld>`
    const failure = thrownBy(() => replaceSlideShape(slide, 'a', replacement))

    expect(failure.code).toBe('PPT_CREATE_INVALID_PACKAGE')
    expect(failure.message).toContain('unterminated p:sp')
  })
})

describe('PPTX slide shape rewrite', () => {
  const ellipseSpec: ShapeSpec = {
    id: 'shape-a',
    name: 'A',
    geometry: { kind: 'preset', preset: 'ellipse', box: { x: 0, y: 0, w: 100, h: 50 } },
    fill: { type: 'solid', color: 'FF8800' },
  }

  const entries = {
    '[Content_Types].xml': '<Types/>',
    'ppt/slides/slide1.xml': slideXml(placeholder(5, 'shape-a')),
    'ppt/slides/slide2.xml': slideXml(placeholder(6, 'shape-b')),
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships/>',
  }

  it('rewrites only planned slides, reusing the placeholder id', () => {
    const before = unzipSync(fakePackage(entries))
    const rewritten = rewritePptxSlideShapes(fakePackage(entries), new Map([[1, [ellipseSpec]]]))
    const after = unzipSync(rewritten)
    const slide1 = strFromU8(after['ppt/slides/slide1.xml']!)

    expect(Object.keys(after)).toEqual(Object.keys(before))
    expect(slide1).toContain('<p:cNvPr id="5" name="shape-a"/>')
    expect(slide1).toContain('<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>')
    expect(slide1).not.toContain('<p:spPr/>')
    expect(strFromU8(after['ppt/slides/slide2.xml']!)).toBe(entries['ppt/slides/slide2.xml'])
    expect(after['ppt/slides/_rels/slide1.xml.rels']).toEqual(before['ppt/slides/_rels/slide1.xml.rels'])
  })

  it('applies every spec of a page in order', () => {
    const page = {
      ...entries,
      'ppt/slides/slide1.xml': slideXml(placeholder(5, 'shape-a'), placeholder(6, 'shape-b')),
    }
    const second: ShapeSpec = {
      id: 'shape-b',
      name: 'B',
      geometry: { kind: 'preset', preset: 'roundRect', box: { x: 0, y: 0, w: 60, h: 60 }, radiusPx: 6 },
      fill: { type: 'none' },
    }
    const after = unzipSync(rewritePptxSlideShapes(fakePackage(page), new Map([[1, [ellipseSpec, second]]])))
    const slide1 = strFromU8(after['ppt/slides/slide1.xml']!)

    expect(slide1).toContain('name="shape-a"')
    expect(slide1).toContain('name="shape-b"')
    expect(slide1).toContain('prst="ellipse"')
    expect(slide1).toContain('<a:gd name="adj" fmla="val 10000"/>')
    expect(slide1.match(/<p:sp[\s>]/gu)).toHaveLength(2)
  })

  it('returns the input bytes unchanged for an empty plan', () => {
    const bytes = fakePackage(entries)

    expect(rewritePptxSlideShapes(bytes, new Map())).toBe(bytes)
  })

  it('fails when a planned page has no slide part', () => {
    const failure = thrownBy(() => rewritePptxSlideShapes(fakePackage(entries), new Map([[9, [ellipseSpec]]])))

    expect(failure.code).toBe('PPT_CREATE_INPUT_INVALID')
    expect(failure.message).toContain('9')
  })

  it('fails when the placeholder is missing from the slide', () => {
    const failure = thrownBy(() => rewritePptxSlideShapes(
      fakePackage(entries),
      new Map([[1, [{ ...ellipseSpec, id: 'shape-z' }]]]),
    ))

    expect(failure.code).toBe('PPT_CREATE_INVALID_PACKAGE')
    expect(failure.message).toContain('shape-z')
  })
})
