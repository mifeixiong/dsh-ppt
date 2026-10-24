import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writePptOutline } from '../../src/outline.ts'
import { createPptxFromSvg } from '../../src/svg-lane.ts'
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts'

/**
 * The SVG lane is end-to-end testable without a browser: the deck is validated
 * statically, the PPTX is written by the shared writer, and the only thing that
 * has to be inspected afterwards is the slide XML that landed in the package.
 * These tests are therefore the contract for "did the vector art survive as
 * native shapes", which is the whole point of the lane.
 */

const SLIDES = [
  {
    page: 1, type: 'content' as const, title: '矢量图元',
    content: [{ kind: 'point' as const, text: '路径与渐变都成为原生形状' }],
    style: { layout: 'title-content' as const, background: 'dark' as const, accent: '#2F6BFF', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Vector' },
  },
  {
    page: 2, type: 'content' as const, title: '第二页',
    content: [{ kind: 'point' as const, text: 'image 与文本' }],
    style: { layout: 'title-content' as const, background: 'light' as const, accent: '#2F6BFF', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Vector' },
  },
]

function deckSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="hero" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B1B33"/>
      <stop offset="1" stop-color="#1E4B8F"/>
    </linearGradient>
  </defs>
  <g data-page="1" data-background="#081120">
    <rect x="72" y="64" width="520" height="300" rx="12" fill="url(#hero)"/>
    <circle cx="900" cy="200" r="64" fill="none" stroke="#7FB2FF" stroke-width="3"/>
    <path d="M 760 420 L 900 480 L 1040 420" fill="none" stroke="#FFFFFF" stroke-width="4" data-tail="triangle"/>
    <text x="72" y="470" font-family="Liter" font-size="44" font-weight="700" fill="#FFFFFF">矢量标题</text>
    <image href="assets/vector-tile.png" x="980" y="480" width="160" height="90"/>
  </g>
  <g data-page="2" data-background="#FFFFFF">
    <polygon points="120,600 220,420 320,600" fill="#2F6BFF" stroke="#0B1B33" stroke-width="2"/>
    <text x="640" y="480" font-family="Liter" font-size="28" fill="#0B1B33" text-anchor="middle">第一段<tspan font-weight="700" fill="#2F6BFF">强调</tspan></text>
  </g>
</svg>`
}

describe('SVG lane', () => {
  let workspace: TestWorkspace

  beforeEach(async () => {
    workspace = await createTestWorkspace('dsh-ppt-svg-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('writes native custom geometry, gradients and line ends into the package', async () => {
    const outline = await writePptOutline(workspace.root, 'svg lane', SLIDES)
    // `artifact_dir` is workspace-relative; the filesystem needs the absolute twin.
    const artifact = outline.artifact_dir
    const absolute = join(workspace.root, artifact)
    await mkdir(join(absolute, 'assets'), { recursive: true })
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 47, g: 107, b: 255 } } })
      .png().toFile(join(absolute, 'assets', 'vector-tile.png'))
    await writeFile(join(absolute, 'deck.svg'), deckSvg(), 'utf8')

    const result = await createPptxFromSvg({
      workspace: workspace.root,
      svg_path: join(artifact, 'deck.svg'),
      outline_path: outline.outline_path,
      output_path: join(artifact, 'deck.pptx'),
    })

    expect(result.page_count).toBe(2)
    expect(result.svg.pages).toBe(2)
    expect(result.svg.shape_count).toBeGreaterThanOrEqual(4)
    expect(result.structural_status).toBe('passed')

    const files = unzipSync(new Uint8Array(await readFile(join(absolute, 'deck.pptx'))))
    const slide1 = strFromU8(files['ppt/slides/slide1.xml']!)
    // The path is a real DrawingML freeform, not a picture of one.
    expect(slide1).toContain('<a:custGeom>')
    expect(slide1).toContain('<a:pathLst>')
    expect(slide1).toContain('<a:lnTo>')
    // The gradient lives inside the shape, so PowerPoint can still edit it.
    expect(slide1).toContain('<a:gradFill')
    expect(slide1).toContain('<a:srgbClr val="0B1B33"/>')
    expect(slide1).toContain('<a:srgbClr val="1E4B8F"/>')
    // Preset shapes stay preset: an ellipse is cheaper and more editable than a path.
    expect(slide1).toContain('prst="ellipse"')
    // A stroked polyline keeps its arrowhead.
    expect(slide1).toMatch(/<a:tailEnd type="(?:triangle|stealth|arrow)"/u)
    // The page background is a native slide background.
    expect(slide1).toContain('<a:srgbClr val="081120"/>')
    // Text is real text, positioned from its authored baseline, not wrapped.
    expect(slide1).toContain('<a:t>矢量标题</a:t>')
    expect(slide1).toContain('wrap="none"')
    // The image is a package picture part.
    expect(slide1).toContain('<p:pic>')

    const slide2 = strFromU8(files['ppt/slides/slide2.xml']!)
    expect(slide2).toContain('<a:custGeom>')
    expect(slide2).toContain('<a:t>第一段</a:t>')
    expect(slide2).toContain('<a:t>强调</a:t>')
  })

  it('rejects a page count that disagrees with the outline', async () => {
    const outline = await writePptOutline(workspace.root, 'svg mismatch', SLIDES.slice(0, 1))
    const artifact = outline.artifact_dir
    await writeFile(join(workspace.root, artifact, 'deck.svg'), deckSvg(), 'utf8')
    await expect(createPptxFromSvg({
      workspace: workspace.root,
      svg_path: join(artifact, 'deck.svg'),
      outline_path: outline.outline_path,
      output_path: join(artifact, 'deck.pptx'),
    })).rejects.toMatchObject({ code: 'SVG_DECK_INVALID' })
  })

  it('rejects a deck that uses a forbidden element', async () => {
    const outline = await writePptOutline(workspace.root, 'svg forbidden', SLIDES.slice(0, 1).map(slide => ({ ...slide, page: 1 })))
    const artifact = outline.artifact_dir
    await writeFile(join(workspace.root, artifact, 'deck.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <g data-page="1">
    <rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" filter="url(#blur)"/>
  </g>
</svg>`, 'utf8')
    await expect(createPptxFromSvg({
      workspace: workspace.root,
      svg_path: join(artifact, 'deck.svg'),
      outline_path: outline.outline_path,
      output_path: join(artifact, 'deck.pptx'),
    })).rejects.toMatchObject({ code: 'SVG_DECK_INVALID' })
  })
})
