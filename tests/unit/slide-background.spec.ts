import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { PptError } from '../../src/errors.ts'
import {
  cssColorToHex,
  injectSlideBackground,
  parseLinearGradient,
  planSlideBackground,
  rewritePptxSlideBackgrounds,
  slideBackgroundXml,
  type SlideBackgroundPlan,
} from '../../src/slide-background.ts'

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

function slideXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ${SLIDE_NAMESPACE} ${DRAWING_NAMESPACE}><p:cSld>${body}</p:cSld><p:clrMapOvr/></p:sld>`
}

function fakePackage(entries: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, xml]) => [name, strToU8(xml)])))
}

describe('linear-gradient parsing', () => {
  it('maps keyword, corner, and degree directions', () => {
    const angle = (direction: string) => parseLinearGradient(`linear-gradient(${direction}, #000000, #FFFFFF)`)?.angleDeg

    expect(angle('to top')).toBe(0)
    expect(angle('to right')).toBe(90)
    expect(angle('to bottom')).toBe(180)
    expect(angle('to left')).toBe(270)
    expect(angle('to top right')).toBe(45)
    expect(angle('to bottom right')).toBe(135)
    expect(angle('to bottom left')).toBe(225)
    expect(angle('to top left')).toBe(315)
    expect(angle('to right top')).toBe(45)
    expect(angle('160deg')).toBe(160)
    expect(angle('12.5deg')).toBe(12.5)
    expect(angle('-30deg')).toBe(330)
    expect(angle('400deg')).toBe(40)
  })

  it('keeps explicit positions and distributes omitted positions between anchors', () => {
    const positions = (image: string) => parseLinearGradient(image)?.stops.map(stop => stop.position)

    expect(positions('linear-gradient(to bottom, #000, #fff)')).toEqual([0, 100])
    expect(positions('linear-gradient(to bottom, #000, #111, #222)')).toEqual([0, 50, 100])
    expect(positions('linear-gradient(#000 10%, #111, #222 90%)')).toEqual([10, 50, 90])
    expect(positions('linear-gradient(#000, #111, #222 50%, #333)')).toEqual([0, 25, 50, 100])
    expect(positions('linear-gradient(#000 20%, #111, #222, #333 80%, #444)')).toEqual([20, 40, 60, 80, 100])
    expect(positions('linear-gradient(#000 25%, #111 25%, #222 75%, #333 75%)')).toEqual([25, 25, 75, 75])
  })

  it('normalizes hex, rgb, and fully opaque rgba stops', () => {
    const gradient = parseLinearGradient('linear-gradient(#abc, rgb(1, 2, 3), rgba(255, 255, 255, 1))')

    expect(gradient?.stops).toEqual([
      { color: 'AABBCC', position: 0 },
      { color: '010203', position: 50 },
      { color: 'FFFFFF', position: 100 },
    ])
    expect(cssColorToHex('#abc')).toBe('AABBCC')
    expect(cssColorToHex('#A1B2C3')).toBe('A1B2C3')
    expect(cssColorToHex('rgb(8, 17, 32)')).toBe('081120')
    expect(cssColorToHex('rgba(8, 17, 32, 1)')).toBe('081120')
  })

  it('rejects translucent alpha because native PPTX gradient stops are opaque', () => {
    expect(parseLinearGradient('linear-gradient(#000, rgba(255, 255, 255, 0.5))')).toBeUndefined()
    expect(parseLinearGradient('linear-gradient(#000, rgba(255, 255, 255, 0))')).toBeUndefined()
    expect(cssColorToHex('rgba(8, 17, 32, 0.5)')).toBeUndefined()
    expect(cssColorToHex('rgba(8, 17, 32, 2)')).toBeUndefined()
    expect(cssColorToHex('transparent')).toBeUndefined()
  })

  it('rejects unsupported background-image forms without throwing', () => {
    const rejected = [
      'none',
      'url(hero.png)',
      'radial-gradient(#000, #fff)',
      'repeating-linear-gradient(180deg, #000, #fff)',
      'linear-gradient(#000, #fff), linear-gradient(#111, #222)',
      'linear-gradient(#000, #fff) no-repeat',
      'linear-gradient(#000)',
      'linear-gradient(#000, #fff, #000, #fff, #000, #fff, #000)',
      'linear-gradient(45rad, #000, #fff)',
      'linear-gradient(0.5turn, #000, #fff)',
      'linear-gradient(to center, #000, #fff)',
      'linear-gradient(to top bottom, #000, #fff)',
      'linear-gradient(#000, #fff',
      'linear-gradient(#000, 10%, #fff)',
      'linear-gradient(#000 -10%, #fff 110%)',
    ]

    for (const image of rejected) expect(parseLinearGradient(image)).toBeUndefined()
  })
})

describe('slide background planning', () => {
  it('keeps an opaque solid color when no gradient is present', () => {
    expect(planSlideBackground({ color: 'rgb(17, 34, 51)', image: 'none' })).toEqual({ solid: '112233' })
    expect(planSlideBackground({ color: '#112233', image: 'none' })).toEqual({ solid: '112233' })
  })

  it('prefers a parseable gradient and keeps its first stop as the solid fallback', () => {
    expect(planSlideBackground({
      color: 'rgb(1, 2, 3)',
      image: 'linear-gradient(160deg, #081120 0%, #10294D 55%, #0B3A6B 100%)',
    })).toEqual({
      solid: '081120',
      gradient: {
        angleDeg: 160,
        stops: [
          { color: '081120', position: 0 },
          { color: '10294D', position: 55 },
          { color: '0B3A6B', position: 100 },
        ],
      },
    })
  })

  it('returns undefined when neither the color nor the gradient is usable', () => {
    expect(planSlideBackground(undefined)).toBeUndefined()
    expect(planSlideBackground({ color: 'transparent', image: 'none' })).toBeUndefined()
    expect(planSlideBackground({ color: 'rgba(17, 34, 51, 0.5)', image: 'none' })).toBeUndefined()
    expect(planSlideBackground({ color: '', image: 'url(hero.png)' })).toBeUndefined()
  })
})

describe('slide background XML', () => {
  it('emits an opaque solid fill', () => {
    expect(slideBackgroundXml({ solid: '112233' })).toBe(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>',
    )
  })

  it('emits a native gradient with the 1/60000 degree angle and 1/1000 stop positions', () => {
    const plan: SlideBackgroundPlan = {
      solid: '081120',
      gradient: {
        angleDeg: 160,
        stops: [
          { color: '081120', position: 0 },
          { color: '10294D', position: 55 },
          { color: '0B3A6B', position: 100 },
        ],
      },
    }

    expect(slideBackgroundXml(plan)).toBe(
      '<p:bg><p:bgPr><a:gradFill rotWithShape="1"><a:gsLst>'
        + '<a:gs pos="0"><a:srgbClr val="081120"/></a:gs>'
        + '<a:gs pos="55000"><a:srgbClr val="10294D"/></a:gs>'
        + '<a:gs pos="100000"><a:srgbClr val="0B3A6B"/></a:gs>'
        + '</a:gsLst><a:lin ang="4200000" scaled="0"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>',
    )
  })
})

describe('slide background injection', () => {
  const solid = '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="445566"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'

  it('inserts the background as the first child of p:cSld', () => {
    const injected = injectSlideBackground(slideXml('<p:spTree/>'), { solid: '445566' })

    expect(injected).toBe(slideXml(`${solid}<p:spTree/>`))
    expect(injected.indexOf('<p:bg>')).toBe(injected.indexOf('<p:cSld>') + '<p:cSld>'.length)
  })

  it('replaces an existing p:bg element including its nested fill', () => {
    const existing = slideXml('<p:bg><p:bgPr><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs></a:gsLst></a:gradFill></p:bgPr></p:bg><p:spTree/>')
    const injected = injectSlideBackground(existing, { solid: '445566' })

    expect(injected).toBe(slideXml(`${solid}<p:spTree/>`))
    expect(injected.match(/<p:bg\b/gu)).toHaveLength(1)
  })

  it('replaces a self-closing p:bg element', () => {
    const injected = injectSlideBackground(slideXml('<p:bg/><p:spTree/>'), { solid: '445566' })

    expect(injected).toBe(slideXml(`${solid}<p:spTree/>`))
  })

  it('expands a self-closing p:cSld container', () => {
    expect(injectSlideBackground('<p:sld><p:cSld/></p:sld>', { solid: '445566' }))
      .toBe(`<p:sld><p:cSld>${solid}</p:cSld></p:sld>`)
  })

  it('throws when the slide XML has no p:cSld element', () => {
    const failure = thrownBy(() => injectSlideBackground('<p:sld><p:spTree/></p:sld>', { solid: '445566' }))

    expect(failure.code).toBe('PPT_CREATE_INVALID_PACKAGE')
    expect(failure.message).toContain('p:cSld')
  })
})

describe('PPTX slide background rewrite', () => {
  const slide1 = slideXml('<p:spTree/>')
  const slide2 = slideXml('<p:spTree/>')
  const entries = {
    '[Content_Types].xml': '<Types/>',
    'ppt/slides/slide1.xml': slide1,
    'ppt/slides/slide2.xml': slide2,
    'docProps/core.xml': '<coreProperties/>',
  }

  it('rewrites only planned slide parts and preserves every other entry', () => {
    const bytes = fakePackage(entries)
    const before = unzipSync(bytes)
    const rewritten = rewritePptxSlideBackgrounds(bytes, new Map([[1, { solid: '112233' }]]))
    const after = unzipSync(rewritten)

    expect(Object.keys(after)).toEqual(Object.keys(before))
    expect(strFromU8(after['ppt/slides/slide1.xml']!)).toContain(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>',
    )
    expect(strFromU8(after['ppt/slides/slide2.xml']!)).toBe(slide2)
    expect(after['docProps/core.xml']).toEqual(before['docProps/core.xml'])
    expect(after['[Content_Types].xml']).toEqual(before['[Content_Types].xml'])
  })

  it('returns the input unchanged for an empty plan', () => {
    const bytes = fakePackage(entries)

    expect(rewritePptxSlideBackgrounds(bytes, new Map())).toBe(bytes)
  })

  it('fails when a planned page has no slide part', () => {
    const bytes = fakePackage(entries)
    const failure = thrownBy(() => rewritePptxSlideBackgrounds(bytes, new Map([[9, { solid: '112233' }]])))

    expect(failure.code).toBe('PPT_CREATE_INPUT_INVALID')
    expect(failure.message).toContain('9')
  })
})
