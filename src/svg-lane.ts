import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PptError, throwIfAborted } from './errors.ts'
import { FONT_REGISTRY } from './fonts.ts'
import { isPathInside, resolveWorkspacePath, workspaceRelative } from './paths.ts'
import { validatePptOutline, type PptOutline } from './outline.ts'
import type { DeckIR, ElementIR, ElementStyleIR, SlideIR, TextRunIR } from './ir.ts'
import { writeDeckPptx, type PptCreateResult } from './pptx.ts'
import { parseSvgDeck, type SvgTextElement, type SvgTextLine } from './svg-deck.ts'
import type { ShapeSpec } from './svg-ooxml.ts'
import { loadSystemTextMetrics } from './text-metrics.ts'
import type { SlideTransitionPlan } from './transitions.ts'
import type { AnimationPlan } from './animation.ts'

/**
 * The SVG lane: one constrained SVG document in, native PPTX out.
 *
 * The other two lanes start from content (deterministic layout) or from HTML
 * (browser-measured boxes). This lane starts from vector art: freeform paths,
 * in-shape gradients, dashes and arrowheads land in the deck as real DrawingML
 * shapes, which is what diagram-heavy decks need and what a box-only writer
 * cannot express. Validation happens on the SVG itself, so the lane runs with
 * no browser and no renderer.
 */

const MAX_SVG_BYTES = 2 * 1024 * 1024
/** Text boxes get a little slack so renderer rounding never clips a measured line. */
const TEXT_WIDTH_HEADROOM = 1.06
const TEXT_WIDTH_SLACK_PX = 2

export interface SvgLaneSummary {
  pages: number
  shape_count: number
  text_count: number
  image_count: number
  warnings: string[]
}

export interface SvgCreateResult extends PptCreateResult {
  svg: SvgLaneSummary
}

function baseStyle(): ElementStyleIR {
  return {
    fontFamily: 'MiSans',
    fontSizePx: 24,
    fontWeight: 400,
    fontStyle: 'normal',
    color: 'rgb(0, 0, 0)',
    backgroundColor: 'transparent',
    backgroundImage: 'none',
    borderColor: 'transparent',
    borderWidthPx: 0,
    borderStyle: 'none',
    borderRadius: '0px',
    textAlign: 'left',
    verticalAlign: 'top',
    lineHeightPx: 28,
    letterSpacingPx: 0,
    textTransform: 'none',
    rotationDeg: 0,
    opacity: 1,
    objectFit: 'contain',
    objectPosition: 'center',
  }
}

function cssColor(hex: string): string {
  const value = hex.replace(/^#/u, '')
  return `rgb(${Number.parseInt(value.slice(0, 2), 16)}, ${Number.parseInt(value.slice(2, 4), 16)}, ${Number.parseInt(value.slice(4, 6), 16)})`
}

function textRuns(line: SvgTextLine): TextRunIR[] {
  return line.runs.map(run => ({
    text: run.text,
    fontFamily: run.fontFamily,
    fontSizePx: run.fontSizePx,
    fontWeight: run.fontWeight,
    fontStyle: run.italic ? 'italic' : 'normal',
    color: cssColor(run.color),
    textDecoration: 'none',
  }))
}

/** One IR text element per SVG line: a line is the unit a renderer cannot split. */
function textElements(element: SvgTextElement, startIndex: number): ElementIR[] {
  const anchor = element.style.anchor
  const blockLeft = element.box.x
  const blockRight = element.box.x + element.box.w
  return element.lines.map((line, index) => {
    const width = Math.max(line.width, 1) * TEXT_WIDTH_HEADROOM + TEXT_WIDTH_SLACK_PX
    const x = anchor === 'middle' ? (blockLeft + blockRight) / 2 - width / 2
      : anchor === 'end' ? blockRight - width
        : blockLeft
    const size = line.runs[0]?.fontSizePx ?? element.style.fontSizePx
    // PowerPoint draws a line in a 1.2em box and puts the baseline at
    // ascent/(ascent+descent) of it, not at the SVG y coordinate. Solving for
    // the frame top is what keeps an authored baseline where the author put it.
    const ratio = line.ascent + line.descent > 0 ? line.ascent / (line.ascent + line.descent) : 0.8
    const natural = size * 1.2
    const style: ElementStyleIR = {
      ...baseStyle(),
      fontFamily: line.runs[0]?.fontFamily ?? element.style.fontFamily,
      fontSizePx: size,
      fontWeight: line.runs[0]?.fontWeight ?? element.style.fontWeight,
      fontStyle: line.runs[0]?.italic === true ? 'italic' : 'normal',
      color: cssColor(line.runs[0]?.color ?? element.style.color),
      lineHeightPx: natural,
      letterSpacingPx: element.style.letterSpacingPx,
    }
    return {
      id: `${element.id}-line${index + 1}`,
      kind: 'text' as const,
      z: startIndex + index,
      domOrder: startIndex + index,
      box: { x, y: line.baselineY - natural * ratio, w: width, h: natural },
      style,
      text: line.runs.map(run => run.text).join(''),
      runs: textRuns(line),
      noWrap: true,
    }
  })
}

function shapeElement(spec: ShapeSpec, index: number): ElementIR {
  const fill = spec.fill.type === 'solid' ? cssColor(spec.fill.color)
    : spec.fill.type === 'none' ? 'transparent'
      : cssColor(spec.fill.stops[0]?.color ?? '000000')
  const stroke = spec.stroke?.paint.type === 'solid' ? cssColor(spec.stroke.paint.color) : 'transparent'
  return {
    id: spec.id,
    kind: 'shape',
    z: index,
    domOrder: index,
    box: spec.geometry.box,
    style: {
      ...baseStyle(),
      backgroundColor: fill,
      borderColor: stroke,
      borderWidthPx: spec.stroke?.widthPx ?? 0,
      borderStyle: spec.stroke === undefined ? 'none' : 'solid',
    },
    nativeShape: spec,
  }
}

export interface SvgLaneInput {
  workspace: string
  svg_path: string
  outline_path: string
  output_path: string
  signal?: AbortSignal
  transitions?: SlideTransitionPlan
  animations?: AnimationPlan
}

export async function createPptxFromSvg(input: SvgLaneInput): Promise<SvgCreateResult> {
  const { workspace, signal } = input
  throwIfAborted(signal, 'PPT_CREATE_ABORTED')
  const [svgPath, outlinePath, outputPath] = await Promise.all([
    resolveWorkspacePath(workspace, input.svg_path, { mustExist: true, kind: 'file' }),
    resolveWorkspacePath(workspace, input.outline_path, { mustExist: true, kind: 'file' }),
    resolveWorkspacePath(workspace, input.output_path),
  ])
  const artifactRoot = dirname(outlinePath)
  if (dirname(svgPath) !== artifactRoot || dirname(outputPath) !== artifactRoot) {
    throw new PptError('PPT_CREATE_INPUT_INVALID', 'SVG, outline, and PPTX output must share one artifact directory')
  }
  const size = (await stat(svgPath)).size
  if (size > MAX_SVG_BYTES) {
    throw new PptError('PPT_RESOURCE_LIMIT', `SVG deck exceeds ${String(MAX_SVG_BYTES)} bytes`)
  }
  const outline = validatePptOutline(JSON.parse(await readFile(outlinePath, 'utf8')))
  if (outline.length > 60) throw new PptError('PPT_CREATE_INPUT_INVALID', 'a deck cannot exceed 60 pages')
  const metrics = await loadSystemTextMetrics()
  const deck = await parseSvgDeck(await readFile(svgPath, 'utf8'), {
    metrics,
    fonts: FONT_REGISTRY.map(font => font.name),
  })
  if (deck.pages.length !== outline.length) {
    throw new PptError('SVG_DECK_INVALID', `outline has ${String(outline.length)} pages but the SVG deck has ${String(deck.pages.length)}`)
  }

  const nativeShapes = new Map<number, ShapeSpec[]>()
  const slides: SlideIR[] = []
  let shapeCount = 0
  let textCount = 0
  let imageCount = 0
  for (const page of deck.pages) {
    const elements: ElementIR[] = []
    const shapes: ShapeSpec[] = []
    for (const element of page.elements) {
      if (element.kind === 'shape') {
        elements.push(shapeElement(element.spec, elements.length))
        shapes.push(element.spec)
        shapeCount += 1
        continue
      }
      if (element.kind === 'text') {
        const text = textElements(element, elements.length)
        elements.push(...text)
        textCount += text.length
        continue
      }
      // The author writes `assets/…` relative to the artifact directory, the
      // same convention the HTML lane uses for its images.
      const imagePath = await resolveWorkspacePath(workspace, join(artifactRoot, element.href), { mustExist: true, kind: 'file' })
      if (!isPathInside(workspace, imagePath) || !isPathInside(artifactRoot, imagePath)) {
        throw new PptError('SVG_DECK_INVALID', `image is outside the artifact directory: ${element.href}`)
      }
      elements.push({
        id: element.id,
        kind: 'image',
        z: elements.length,
        domOrder: elements.length,
        box: element.box,
        style: { ...baseStyle(), opacity: element.opacity },
        imagePath,
      })
      imageCount += 1
    }
    if (shapes.length > 0) nativeShapes.set(page.page, shapes)
    const speakerNotes = outline[page.page - 1]?.content
      .flatMap(item => item.kind === 'note' && item.purpose === 'speaker' ? [item.text] : []) ?? []
    slides.push({
      page: page.page,
      elements,
      speakerNotes,
      ...(page.background === undefined ? {} : { background: { color: `#${page.background}`, image: 'none' } }),
    })
  }

  const ir: DeckIR = { widthPx: 1280, heightPx: 720, slides }
  const written = await writeDeckPptx({
    ir, outline, workspace, artifactRoot, outputPath, signal,
    ...(input.transitions === undefined ? {} : { transitions: input.transitions }),
    ...(input.animations === undefined ? {} : { animations: input.animations }),
    ...(nativeShapes.size === 0 ? {} : { nativeShapes }),
    subject: 'Editable PPTX generated from a constrained SVG deck',
  })
  return {
    ...written,
    svg: {
      pages: deck.pages.length,
      shape_count: shapeCount,
      text_count: textCount,
      image_count: imageCount,
      warnings: deck.findings.filter(finding => finding.severity === 'warning').map(finding => {
        const where = finding.page === undefined ? '' : `page ${String(finding.page)}${finding.element === undefined ? '' : ` ${finding.element}`}: `
        return `${where}${finding.message}`
      }),
    },
  }
}
