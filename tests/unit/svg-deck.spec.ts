import { describe, expect, it } from 'vitest'
import { PptError } from '../../src/errors.ts'
import {
  SVG_MIN_FONT_PX,
  parseSvgDeck,
  type SvgDeckIR,
  type SvgDeckOptions,
  type SvgImageElement,
  type SvgShapeElement,
  type SvgTextElement,
} from '../../src/svg-deck.ts'
import { createTextMetrics, estimateTextWidth, type TextMetrics } from '../../src/text-metrics.ts'
import { XmlParseError, parseXml } from '../../src/svg-xml.ts'

const ROOT_ATTRIBUTES = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"'

/** Deterministic metrics: 0.5em per character, 0.8em ascent, 0.2em descent. */
function stubMetrics(): TextMetrics {
  return {
    async measure(request) {
      return {
        width: request.text.length * request.sizePx * 0.5,
        ascent: request.sizePx * 0.8,
        descent: request.sizePx * 0.2,
        measured: true,
      }
    },
    hasFamily: () => true,
    async preload() {},
  }
}

const options: SvgDeckOptions = { metrics: stubMetrics(), fonts: ['MiSans', 'Inter'] }

function document(inner: string, attributes = ROOT_ATTRIBUTES): string {
  return `<svg ${attributes}>${inner}</svg>`
}

function page(content: string, number = 1, attributes = ''): string {
  return `<g data-page="${number}"${attributes}>${content}</g>`
}

async function rejection(source: string, parser: SvgDeckOptions = options): Promise<PptError> {
  try {
    await parseSvgDeck(source, parser)
  } catch (error) {
    if (error instanceof PptError) return error
    throw error
  }
  throw new Error(`expected the deck to be rejected: ${source}`)
}

function shapeAt(result: SvgDeckIR, index: number): SvgShapeElement {
  const element = result.pages[0]?.elements[index]
  if (element === undefined || element.kind !== 'shape') throw new Error(`expected a shape at index ${index}`)
  return element
}

function textAt(result: SvgDeckIR, index: number): SvgTextElement {
  const element = result.pages[0]?.elements[index]
  if (element === undefined || element.kind !== 'text') throw new Error(`expected text at index ${index}`)
  return element
}

function imageAt(result: SvgDeckIR, index: number): SvgImageElement {
  const element = result.pages[0]?.elements[index]
  if (element === undefined || element.kind !== 'image') throw new Error(`expected an image at index ${index}`)
  return element
}

function contrastWarnings(result: SvgDeckIR): number {
  return result.findings.filter(finding => finding.code === 'SVG_TEXT_CONTRAST').length
}

describe('svg deck pages', () => {
  it('parses one page and turns a rect into a preset shape with a stable id', async () => {
    const result = await parseSvgDeck(document(page('<rect x="72" y="64" width="500" height="240" fill="#0B1B33"/>')), options)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]?.page).toBe(1)
    expect(result.pages[0]?.background).toBeUndefined()
    const shape = shapeAt(result, 0)
    expect(shape.id).toBe('page1-shape-1')
    expect(shape.spec.id).toBe(shape.id)
    expect(shape.spec.name).toBe('rect')
    expect(shape.spec.geometry).toEqual({ kind: 'preset', preset: 'rect', box: { x: 72, y: 64, w: 500, h: 240 } })
    expect(shape.spec.fill).toEqual({ type: 'solid', color: '0B1B33' })
    expect(shape.spec.stroke).toBeUndefined()
  })

  it('numbers ids in document order across shapes, text and images', async () => {
    const content = [
      '<rect x="0" y="0" width="10" height="10" fill="#000000"/>',
      '<text x="0" y="40" font-family="MiSans" font-size="20" fill="#111111">A</text>',
      '<image href="assets/a.png" x="0" y="0" width="10" height="10"/>',
    ].join('')
    const result = await parseSvgDeck(document(page(content)), options)
    expect(result.pages[0]?.elements.map(element => element.id)).toEqual(['page1-shape-1', 'page1-text-2', 'page1-image-3'])
  })

  it('keeps multiple pages in order and reads data-background', async () => {
    const source = document(
      `${page('<rect x="0" y="0" width="10" height="10"/>', 1, ' data-background="#081120"')}${page('<rect x="0" y="0" width="10" height="10"/>', 2)}`,
    )
    const result = await parseSvgDeck(source, options)
    expect(result.pages).toHaveLength(2)
    expect(result.pages[0]?.background).toBe('081120')
    expect(result.pages[1]?.background).toBeUndefined()
    expect(result.pages[1]?.page).toBe(2)
  })

  it('rejects pages that are out of order', async () => {
    const error = await rejection(document(page('<rect x="0" y="0" width="10" height="10"/>', 2)))
    expect(error.code).toBe('SVG_DECK_INVALID')
    expect(error.message).toContain('expected 1, found 2')
  })

  it('rejects duplicate data-page numbers', async () => {
    const error = await rejection(
      document(`${page('<rect x="0" y="0" width="10" height="10"/>', 1)}${page('<rect x="0" y="0" width="10" height="10"/>', 1)}`),
    )
    expect(error.message).toContain('duplicate data-page="1"')
  })

  it('rejects a deck without page groups and a wrong viewBox', async () => {
    const noPages = await rejection(document(''))
    expect(noPages.message).toContain('at least one')
    const badViewBox = await rejection(document(page('<rect x="0" y="0" width="10" height="10"/>'), 'viewBox="0 0 1920 1080"'))
    expect(badViewBox.message).toContain('viewBox must be')
    expect((badViewBox.details?.issues as string[]).length).toBeGreaterThan(0)
  })

  it('rejects an invalid data-background', async () => {
    const error = await rejection(document(page('<rect x="0" y="0" width="10" height="10"/>', 1, ' data-background="url(#g)"')))
    expect(error.message).toContain('data-background')
  })

  it('rejects a top-level <g> without data-page', async () => {
    const error = await rejection(document('<g><rect x="0" y="0" width="10" height="10"/></g>'))
    expect(error.message).toContain('must declare data-page')
  })
})

describe('svg deck shape geometry', () => {
  it('maps rect rx to a roundRect with a radius', async () => {
    const result = await parseSvgDeck(document(page('<rect x="10" y="20" width="100" height="50" rx="12"/>')), options)
    expect(shapeAt(result, 0).spec.geometry).toEqual({
      kind: 'preset',
      preset: 'roundRect',
      box: { x: 10, y: 20, w: 100, h: 50 },
      radiusPx: 12,
    })
  })

  it('maps circle and ellipse to the ellipse preset', async () => {
    const result = await parseSvgDeck(
      document(page('<circle cx="100" cy="100" r="50"/><ellipse cx="200" cy="100" rx="60" ry="30"/>')),
      options,
    )
    expect(shapeAt(result, 0).spec.geometry).toEqual({ kind: 'preset', preset: 'ellipse', box: { x: 50, y: 50, w: 100, h: 100 } })
    expect(shapeAt(result, 1).spec.geometry).toEqual({ kind: 'preset', preset: 'ellipse', box: { x: 140, y: 70, w: 120, h: 60 } })
  })

  it('derives line boxes and flip flags from endpoint order', async () => {
    const reversed = await parseSvgDeck(
      document(page('<line x1="300" y1="200" x2="100" y2="50" fill="none" stroke="#7FB2FF" stroke-width="2" data-head="triangle" data-tail="stealth"/>')),
      options,
    )
    const reversedShape = shapeAt(reversed, 0)
    expect(reversedShape.spec.geometry).toEqual({
      kind: 'preset',
      preset: 'line',
      box: { x: 100, y: 50, w: 200, h: 150 },
      flipH: true,
      flipV: true,
    })
    expect(reversedShape.spec.stroke?.headEnd).toBe('triangle')
    expect(reversedShape.spec.stroke?.tailEnd).toBe('stealth')
    expect(reversedShape.spec.stroke?.widthPx).toBe(2)
    expect(reversedShape.spec.stroke?.paint).toEqual({ type: 'solid', color: '7FB2FF' })

    const forward = await parseSvgDeck(document(page('<line x1="100" y1="50" x2="300" y2="200" fill="none" stroke="#000000"/>')), options)
    const geometry = shapeAt(forward, 0).spec.geometry
    expect(geometry.kind).toBe('preset')
    if (geometry.kind === 'preset') {
      expect(geometry.flipH).toBe(false)
      expect(geometry.flipV).toBe(false)
    }
  })

  it('converts a translated polygon into path geometry', async () => {
    const result = await parseSvgDeck(
      document(page('<polygon points="0,0 100,0 100,50" fill="#FF0000" transform="translate(10,20)"/>')),
      options,
    )
    const geometry = shapeAt(result, 0).spec.geometry
    expect(geometry.kind).toBe('path')
    if (geometry.kind === 'path') {
      expect(geometry.box).toEqual({ x: 10, y: 20, w: 100, h: 50 })
      expect(geometry.fillable).toBe(true)
      expect(geometry.subpaths.length).toBeGreaterThan(0)
    }
  })

  it('converts a translated, unfilled path into a stroke-only path', async () => {
    const result = await parseSvgDeck(
      document(page('<path d="M 0 0 L 100 0 L 100 50 Z" fill="none" stroke="#7FB2FF" stroke-width="2" transform="translate(5,5)"/>')),
      options,
    )
    const geometry = shapeAt(result, 0).spec.geometry
    expect(geometry.kind).toBe('path')
    if (geometry.kind === 'path') {
      expect(geometry.box).toEqual({ x: 5, y: 5, w: 100, h: 50 })
      expect(geometry.fillable).toBe(false)
    }
    expect(shapeAt(result, 0).spec.stroke?.widthPx).toBe(2)
  })

  it('rejects rotate transforms on preset geometry', async () => {
    const error = await rejection(document(page('<rect x="0" y="0" width="10" height="10" transform="rotate(45)"/>')))
    expect(error.message).toContain('rotate')
  })

  it('carries dash, cap and join into the stroke spec', async () => {
    const result = await parseSvgDeck(
      document(
        page('<rect x="0" y="0" width="100" height="50" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-dasharray="4 2" stroke-linecap="round" stroke-linejoin="bevel"/>'),
      ),
      options,
    )
    const stroke = shapeAt(result, 0).spec.stroke
    expect(stroke?.widthPx).toBe(2)
    expect(stroke?.cap).toBe('round')
    expect(stroke?.join).toBe('bevel')
    expect(stroke?.dash).toBeDefined()
  })
})

describe('svg deck gradients', () => {
  const defs = [
    '<defs>',
    '<linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">',
    '<stop offset="0" stop-color="#0B1B33"/>',
    '<stop offset="1" stop-color="#1E4B8F"/>',
    '</linearGradient>',
    '<radialGradient id="g2" cx="0.5" cy="0.5">',
    '<stop offset="0" stop-color="#FFFFFF"/>',
    '<stop offset="1" stop-color="#000000"/>',
    '</radialGradient>',
    '</defs>',
  ].join('')

  it('resolves a linear gradient and its stops', async () => {
    const result = await parseSvgDeck(
      document(`${defs}${page('<rect x="0" y="0" width="100" height="100" fill="url(#g1)"/>')}`),
      options,
    )
    const fill = shapeAt(result, 0).spec.fill
    expect(fill.type).toBe('linear')
    if (fill.type === 'linear') {
      expect(fill.angleDeg).toBeCloseTo(45, 5)
      expect(fill.stops).toEqual([
        { offset: 0, color: '0B1B33' },
        { offset: 1, color: '1E4B8F' },
      ])
    }
  })

  it('resolves a radial gradient with an object-bounding-box focus', async () => {
    const result = await parseSvgDeck(
      document(`${defs}${page('<rect x="0" y="0" width="100" height="100" fill="url(#g2)"/>')}`),
      options,
    )
    const fill = shapeAt(result, 0).spec.fill
    expect(fill.type).toBe('radial')
    if (fill.type === 'radial') {
      expect(fill.focusX).toBe(0.5)
      expect(fill.focusY).toBe(0.5)
      expect(fill.stops).toHaveLength(2)
    }
  })

  it('rejects a url() that does not resolve to a gradient', async () => {
    const error = await rejection(document(page('<rect x="0" y="0" width="100" height="100" fill="url(#missing)"/>')))
    expect(error.message).toContain('not defined in <defs>')
  })

  it('rejects userSpaceOnUse gradients', async () => {
    const source = document(
      `${page('')}<defs><linearGradient id="u" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient></defs>`,
    )
    const error = await rejection(source)
    expect(error.message).toContain('userSpaceOnUse')
  })

  it('requires at least two stops with offsets', async () => {
    const single = await rejection(
      document(`<defs><linearGradient id="one"><stop offset="0" stop-color="#000000"/></linearGradient></defs>${page('<rect x="0" y="0" width="10" height="10" fill="url(#one)"/>')}`),
    )
    expect(single.message).toContain('at least two')
    const missingOffset = await rejection(
      document(`<defs><linearGradient id="two"><stop stop-color="#000000"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient></defs>${page('')}`),
    )
    expect(missingOffset.message).toContain('requires offset')
  })
})

describe('svg deck text', () => {
  function textMarkup(anchor: string): string {
    return `<text x="100" y="100" font-family="MiSans" font-size="40" text-anchor="${anchor}" fill="#111111">AB</text>`
  }

  it('anchors the text box for start, middle and end', async () => {
    const start = textAt(await parseSvgDeck(document(page(textMarkup('start'))), options), 0)
    expect(start.box).toEqual({ x: 100, y: 68, w: 40, h: 40 })
    const middle = textAt(await parseSvgDeck(document(page(textMarkup('middle'))), options), 0)
    expect(middle.box.x).toBe(80)
    const end = textAt(await parseSvgDeck(document(page(textMarkup('end'))), options), 0)
    expect(end.box.x).toBe(60)
    expect(end.style.anchor).toBe('end')
    expect(end.lines).toHaveLength(1)
    expect(end.lines[0]?.baselineY).toBe(100)
  })

  it('splits lines on tspan y and keeps every baseline', async () => {
    const markup =
      '<text x="100" font-family="MiSans" font-size="40" fill="#111111"><tspan y="100">AB</tspan><tspan y="140">CD</tspan></text>'
    const text = textAt(await parseSvgDeck(document(page(markup)), options), 0)
    expect(text.lines).toHaveLength(2)
    expect(text.lines[0]?.baselineY).toBe(100)
    expect(text.lines[1]?.baselineY).toBe(140)
    expect(text.lines[0]?.width).toBe(40)
    expect(text.box.y).toBe(68)
    expect(text.box.h).toBe(80)
    expect(text.style.lineHeightPx).toBe(40)
  })

  it('applies tspan overrides and keeps the widest run', async () => {
    const markup =
      '<text x="10" y="50" font-family="MiSans" font-size="40" fill="#FFFFFF">A<tspan fill="#FF0000" font-size="20" font-weight="bold">B</tspan></text>'
    const text = textAt(await parseSvgDeck(document(page(markup)), options), 0)
    expect(text.lines[0]?.runs).toHaveLength(2)
    expect(text.lines[0]?.runs[1]?.fontSizePx).toBe(20)
    expect(text.lines[0]?.runs[1]?.fontWeight).toBe(700)
    expect(text.lines[0]?.runs[1]?.color).toBe('FF0000')
    expect(text.lines[0]?.width).toBe(30)
  })

  it('adds runs from a tspan without y to the current line', async () => {
    const text = textAt(
      await parseSvgDeck(document(page('<text x="10" y="50" font-family="MiSans" font-size="20" fill="#111111">A<tspan>B</tspan></text>')), options),
      0,
    )
    expect(text.lines).toHaveLength(1)
    expect(text.lines[0]?.runs.map(run => run.text)).toEqual(['A', 'B'])
    expect(text.box.w).toBe(20)
  })

  it('counts letter-spacing between characters', async () => {
    const text = textAt(
      await parseSvgDeck(document(page('<text x="0" y="100" font-family="MiSans" font-size="20" letter-spacing="5" fill="#111111">AB</text>')), options),
      0,
    )
    expect(text.style.letterSpacingPx).toBe(5)
    expect(text.box.w).toBe(25)
  })

  it('rejects fonts outside the approved registry and font sizes below the minimum', async () => {
    const unknownFont = await rejection(document(page('<text x="10" y="50" font-family="Comic Sans" font-size="20">A</text>')))
    expect(unknownFont.message).toContain('approved font registry')
    const smallFont = await rejection(document(page('<text x="10" y="50" font-family="MiSans" font-size="8">A</text>')))
    expect(smallFont.message).toContain('below the minimum')
    expect(SVG_MIN_FONT_PX).toBe(12)
  })

  it('warns about low contrast against the page background and accepts high contrast', async () => {
    const lowContrast = await parseSvgDeck(
      document(page('<text x="0" y="100" font-family="MiSans" font-size="20" fill="#EDEDED">AB</text>')),
      options,
    )
    expect(contrastWarnings(lowContrast)).toBe(1)
    const highContrast = await parseSvgDeck(
      document(page('<text x="0" y="100" font-family="MiSans" font-size="20" fill="#FFFFFF">AB</text>', 1, ' data-background="#000000"')),
      options,
    )
    expect(contrastWarnings(highContrast)).toBe(0)
  })

  it('composites text opacity into the run colour', async () => {
    const text = textAt(
      await parseSvgDeck(
        document(page('<text x="0" y="100" font-family="MiSans" font-size="20" fill="#000000" opacity="0.5">AB</text>')),
        options,
      ),
      0,
    )
    expect(text.lines[0]?.runs[0]?.color).toBe('808080')
  })

  it('rejects a tspan x that disagrees with the text anchor', async () => {
    const error = await rejection(
      document(page('<text x="10" y="50" font-family="MiSans" font-size="20"><tspan x="40" y="80">A</tspan></text>')),
    )
    expect(error.message).toContain('per-line x')
  })
})

describe('svg deck images', () => {
  it('keeps a relative image href, its box and opacity', async () => {
    const result = await parseSvgDeck(document(page('<image href="assets/photo.png" x="700" y="80" width="480" height="300"/>')), options)
    const image = imageAt(result, 0)
    expect(image.id).toBe('page1-image-1')
    expect(image.href).toBe('assets/photo.png')
    expect(image.box).toEqual({ x: 700, y: 80, w: 480, h: 300 })
    expect(image.opacity).toBe(1)
  })

  it('accepts xlink:href and reads opacity', async () => {
    const result = await parseSvgDeck(
      document(page('<image xlink:href="assets/b.jpg" x="0" y="0" width="10" height="10" opacity="0.5"/>')),
      options,
    )
    expect(imageAt(result, 0).href).toBe('assets/b.jpg')
    expect(imageAt(result, 0).opacity).toBe(0.5)
  })

  it('rejects remote, escaping, absolute and unsupported image hrefs', async () => {
    const cases = ['../secret.png', 'https://example.com/a.png', '/assets/a.png', 'assets/a.bmp', 'assets/a.png?v=2']
    for (const href of cases) {
      const error = await rejection(document(page(`<image href="${href}" x="0" y="0" width="10" height="10"/>`)))
      expect(error.message).toContain('href')
    }
  })
})

describe('svg deck contract rejections', () => {
  it('rejects rasteriser-dependent elements', async () => {
    const filter = await rejection(document(page('<filter id="blur"/>')))
    expect(filter.message).toContain('<filter> is not supported')
    const use = await rejection(document(page('<use href="#a"/>')))
    expect(use.message).toContain('<use> is not supported')
    const mask = await rejection(document(page('<mask id="m"/>')))
    expect(mask.message).toContain('<mask> is not supported')
  })

  it('rejects inline style and unlisted presentation attributes', async () => {
    const style = await rejection(document(page('<rect x="0" y="0" width="10" height="10" style="fill:red"/>')))
    expect(style.message).toContain('inline style is ambiguous')
    const fillRule = await rejection(document(page('<rect x="0" y="0" width="10" height="10" fill-rule="evenodd"/>')))
    expect(fillRule.message).toContain('attribute "fill-rule" is not supported')
  })

  it('rejects prefixed element names and currentColor', async () => {
    const prefixed = await rejection(document(page('<svg:rect x="0" y="0" width="10" height="10"/>')))
    expect(prefixed.message).toContain('unprefixed')
    const currentColor = await rejection(document(page('<rect x="0" y="0" width="10" height="10" fill="currentColor"/>')))
    expect(currentColor.message).toContain('no inherited paint context')
  })

  it('rejects mismatched rect radii and duplicate data-name values', async () => {
    const radius = await rejection(document(page('<rect x="0" y="0" width="10" height="10" rx="4" ry="12"/>')))
    expect(radius.message).toContain('rx and ry must match')
    const duplicate = await rejection(
      document(page('<rect x="0" y="0" width="10" height="10" data-name="logo"/><rect x="0" y="0" width="10" height="10" data-name="logo"/>')),
    )
    expect(duplicate.message).toContain('duplicate data-name')
  })

  it('lets data-name override the shape name', async () => {
    const result = await parseSvgDeck(document(page('<rect x="0" y="0" width="10" height="10" data-name="Cover wash"/>')), options)
    expect(shapeAt(result, 0).spec.name).toBe('Cover wash')
  })
})

describe('svg deck arrows', () => {
  it('allows line ends on an unfilled stroke', async () => {
    const result = await parseSvgDeck(
      document(page('<line x1="0" y1="0" x2="100" y2="100" fill="none" stroke="#FFFFFF" data-head="triangle"/>')),
      options,
    )
    expect(shapeAt(result, 0).spec.stroke?.headEnd).toBe('triangle')
    expect(shapeAt(result, 0).spec.stroke?.tailEnd).toBeUndefined()
  })

  it('rejects line ends on filled geometry and on non-line elements', async () => {
    const filled = await rejection(document(page('<line x1="0" y1="0" x2="100" y2="100" stroke="#FFFFFF" data-head="triangle"/>')))
    expect(filled.message).toContain('fill="none"')
    const rect = await rejection(
      document(page('<rect x="0" y="0" width="10" height="10" fill="none" stroke="#FFFFFF" data-head="triangle"/>')),
    )
    expect(rect.message).toContain('only supported on')
  })

  it('rejects unknown arrow names', async () => {
    const error = await rejection(
      document(page('<line x1="0" y1="0" x2="100" y2="100" fill="none" stroke="#FFFFFF" data-head="spike"/>')),
    )
    expect(error.message).toContain('data-head must be one of')
  })
})

describe('svg deck warnings', () => {
  it('warns when an element leaves the canvas and when a page is empty', async () => {
    const outside = await parseSvgDeck(document(page('<rect x="-50" y="0" width="100" height="100"/>')), options)
    expect(outside.findings.some(finding => finding.code === 'SVG_OUT_OF_CANVAS')).toBe(true)
    const empty = await parseSvgDeck(document(page('')), options)
    expect(empty.findings.some(finding => finding.code === 'SVG_PAGE_EMPTY')).toBe(true)
    expect(empty.pages[0]?.elements).toHaveLength(0)
  })

  it('warns when the font provider only estimated the box', async () => {
    const metrics = createTextMetrics([])
    const result = await parseSvgDeck(
      document(page('<text x="0" y="100" font-family="MiSans" font-size="20" fill="#111111">AB</text>')),
      { metrics, fonts: ['MiSans'] },
    )
    expect(result.findings.some(finding => finding.code === 'SVG_FONT_NOT_MEASURED')).toBe(true)
    expect(textAt(result, 0).box.w).toBeCloseTo(estimateTextWidth('AB', 20), 6)
  })
})

describe('svg xml parser', () => {
  it('reads elements, attributes, comments and CDATA inside text', () => {
    const root = parseXml('<?xml version="1.0"?><!-- lead --><svg a="1"><text>hi<![CDATA[a & b]]></text></svg>')
    expect(root.name).toBe('svg')
    expect(root.attributes).toHaveLength(1)
    expect(root.attributes[0]?.value).toBe('1')
    const text = root.children[0]
    expect(text?.kind).toBe('element')
    if (text?.kind === 'element') {
      expect(text.children).toHaveLength(2)
      expect(text.children[0]?.kind).toBe('text')
      const cdata = text.children[1]
      expect(cdata?.kind).toBe('text')
      if (cdata?.kind === 'text') {
        expect(cdata.cdata).toBe(true)
        expect(cdata.value).toBe('a & b')
      }
    }
  })

  it('decodes the five entities and numeric references', () => {
    const root = parseXml('<svg t="&amp;&lt;&gt;&quot;&apos;&#65;&#x42;"/>')
    expect(root.attributes[0]?.value).toBe('&<>"\'AB')
  })

  function xmlError(source: string): XmlParseError {
    try {
      parseXml(source)
    } catch (error) {
      if (error instanceof XmlParseError) return error
      throw error
    }
    throw new Error(`expected the XML parser to reject: ${source}`)
  }

  it('rejects unquoted attributes with a position', () => {
    const error = xmlError('<svg x=1/>')
    expect(error.message).toContain('must be quoted')
    expect(error.line).toBe(1)
    expect(error.column).toBeGreaterThan(0)
  })

  it('rejects unknown entities', () => {
    const error = xmlError('<svg title="a&nbsp;b"/>')
    expect(error.message).toContain('unknown entity')
  })

  it('rejects duplicate attributes', () => {
    const error = xmlError('<svg id="a" id="b"/>')
    expect(error.message).toContain('duplicate attribute "id"')
  })

  it('rejects mismatched closing tags', () => {
    const error = xmlError('<svg><g></svg>')
    expect(error.message).toContain('mismatched closing tag')
  })

  it('rejects CDATA outside text', () => {
    const error = xmlError('<svg><g><![CDATA[x]]></g></svg>')
    expect(error.message).toContain('CDATA is only allowed inside <text>')
  })

  it('surfaces XML errors as SVG_DECK_INVALID findings', async () => {
    const error = await rejection('<svg viewBox="0 0 1280 720"><g data-page="1"><rect x=1/></g></svg>')
    expect(error.code).toBe('SVG_DECK_INVALID')
    expect(error.message).toContain('invalid XML')
  })
})
