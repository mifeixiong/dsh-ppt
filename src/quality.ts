import { copyFile, readFile } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { strFromU8, unzipSync } from 'fflate'
import sharp from 'sharp'
import { z } from 'zod'
import { atomicWriteJson } from './atomic.ts'
import { artDirectionFindings, artDirectionReviewChecklist, type DesignFinding, validateArtDirection } from './art-direction.ts'
import { PptError, throwIfAborted } from './errors.ts'
import { DEFAULT_LIMITS, boundedInteger } from './limits.ts'
import { inspectPptxPackage } from './pptx.ts'
import { PptImageRuntime, pptxPageCount } from './ppt-image.ts'
import { resolveWorkspacePath, workspaceRelative } from './paths.ts'
import type { SessionOwner } from './session-resources.ts'
import { SessionResourceRegistry } from './session-resources.ts'
export { fontconfigDocument } from './ppt-image.ts'

export type QualityLayerStatus = 'passed' | 'failed' | 'not_available' | 'not_performed'
export type OverallQualityStatus = 'verified' | 'failed' | 'unverified'

export interface QualityFinding {
  code: string
  severity: 'warning' | 'error'
  message: string
  page?: number
}

export interface PptQualityReport {
  version: 1
  machine_owned: true
  generated_at: string
  pptx_path: string
  structural_status: QualityLayerStatus
  render_status: QualityLayerStatus
  automatic_visual_status: QualityLayerStatus
  model_visual_status: QualityLayerStatus
  overall_status: OverallQualityStatus
  layers: {
    structural: { status: QualityLayerStatus; findings: QualityFinding[] }
    render: { status: QualityLayerStatus; name?: string; version?: string; findings: QualityFinding[] }
    automatic_visual: {
      status: QualityLayerStatus
      findings: QualityFinding[]
      pages: Array<Record<string, unknown>>
      html_comparison_pages: Array<Record<string, unknown>>
      design_fidelity: {
        mode: 'directed' | 'legacy'
        checks: string[]
        pages: Array<Record<string, unknown>>
        findings: DesignFinding[]
      }
    }
    model_visual: { status: QualityLayerStatus; findings: QualityFinding[] }
  }
  artifacts: {
    html_previews: string[]
    pptx_previews: string[]
    contact_sheets: string[]
    high_risk_previews: string[]
    visual_review: string
  }
  conversion?: Record<string, unknown>
}

export interface VisualReviewDocument {
  version: 1
  status: 'not_performed' | 'passed' | 'failed' | 'not_available'
  checklist: string[]
  reviewed_assets: string[]
  findings: Array<{ page?: number; severity: 'warning' | 'error'; message: string }>
  completed_at?: string
}

const visualReviewSchema = z.object({
  version: z.literal(1),
  status: z.enum(['not_performed', 'passed', 'failed', 'not_available']),
  checklist: z.array(z.string().min(1).max(500)).max(30),
  reviewed_assets: z.array(z.string().min(1).max(500)).max(200),
  findings: z.array(z.object({
    page: z.number().int().positive().optional(),
    severity: z.enum(['warning', 'error']),
    message: z.string().min(1).max(1_000),
  }).strict()).max(500),
  completed_at: z.iso.datetime({ offset: true }).optional(),
}).strict()

export function computeOverallStatus(report: Pick<PptQualityReport,
  'structural_status' | 'render_status' | 'automatic_visual_status' | 'model_visual_status'
>): OverallQualityStatus {
  const statuses = [report.structural_status, report.render_status, report.automatic_visual_status, report.model_visual_status]
  if (statuses.includes('failed')) return 'failed'
  return statuses.every(status => status === 'passed') ? 'verified' : 'unverified'
}

function synchronizeStatuses(report: PptQualityReport): void {
  report.structural_status = report.layers.structural.status
  report.render_status = report.layers.render.status
  report.automatic_visual_status = report.layers.automatic_visual.status
  report.model_visual_status = report.layers.model_visual.status
  report.overall_status = computeOverallStatus(report)
}

function structuralFindings(data: Uint8Array, expectedPages: number): QualityFinding[] {
  inspectPptxPackage(data, expectedPages)
  const files = unzipSync(data)
  const findings: QualityFinding[] = []
  for (let page = 1; page <= expectedPages; page += 1) {
    const xml = strFromU8(files[`ppt/slides/slide${page}.xml`]!)
    for (const block of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)) {
      if (!/<p:txBody\b/u.test(block[0]) || !/\btxBox="1"/u.test(block[0])) continue
      const text = [...block[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map(match => match[1]!.replace(/<[^>]+>/gu, '')).join('').trim()
      if (text.length === 0) findings.push({ code: 'EMPTY_TEXT_BOX', severity: 'error', message: 'slide contains an empty text box', page })
    }
    const pictures = [...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/gu)]
    const textCount = [...xml.matchAll(/<a:t>\s*[^<\s][\s\S]*?<\/a:t>/gu)].length
    if (pictures.length === 1 && textCount === 0 && /<a:off x="0" y="0"\/>[\s\S]*?<a:ext cx="12192000" cy="6858000"\/>/u.test(pictures[0]![0])) {
      findings.push({ code: 'FULL_PAGE_RASTER', severity: 'error', message: 'slide degraded to a single full-page image', page })
    }
  }
  const allXml = Object.entries(files).filter(([name]) => name.endsWith('.xml')).map(([, bytes]) => strFromU8(bytes)).join('\n')
  const visibleText = [...allXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map(match => match[1]!).join('\n')
  if (/(?:�|\bTODO\b|\bTBD\b|\bPLACEHOLDER\b|待补(?:充|数据)?)/iu.test(visibleText)) {
    findings.push({ code: 'PLACEHOLDER_TEXT', severity: 'error', message: 'placeholder or replacement text remains in the PPTX' })
  }
  const sizes = [...allXml.matchAll(/<(?:a:rPr|a:defRPr)\b[^>]*\bsz="(\d+)"/gu)].map(match => Number(match[1]) / 100)
  if (sizes.some(size => size > 0 && size < 10)) findings.push({ code: 'SMALL_FONT', severity: 'warning', message: `minimum detected font size is ${Math.min(...sizes).toFixed(1)}pt` })
  return findings
}

async function imageQualityFindings(data: Uint8Array, expectedPages: number, signal?: AbortSignal): Promise<QualityFinding[]> {
  const files = unzipSync(data)
  const findings: QualityFinding[] = []
  for (let page = 1; page <= expectedPages; page += 1) {
    throwIfAborted(signal)
    const slide = strFromU8(files[`ppt/slides/slide${page}.xml`]!)
    const relName = `ppt/slides/_rels/slide${page}.xml.rels`
    const rels = files[relName] === undefined ? '' : strFromU8(files[relName]!)
    const targets = new Map<string, string>()
    for (const match of rels.matchAll(/<Relationship\b([^>]*)>/giu)) {
      const id = /\bId="([^"]+)"/iu.exec(match[1]!)?.[1]
      const target = /\bTarget="([^"]+)"/iu.exec(match[1]!)?.[1]
      if (id !== undefined && target !== undefined) targets.set(id, posix.normalize(posix.join('ppt/slides', target)))
    }
    for (const match of slide.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/gu)) {
      const block = match[0]
      const relationId = /<a:blip\b[^>]*\br:embed="([^"]+)"/iu.exec(block)?.[1]
      const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/iu.exec(block)
      const target = relationId === undefined ? undefined : targets.get(relationId)
      if (extent === null || target === undefined || files[target] === undefined || target.endsWith('.svg')) continue
      let metadata
      try { metadata = await sharp(files[target]!).metadata() } catch { continue }
      if (metadata.width === undefined || metadata.height === undefined) continue
      const displayWidth = Number(extent[1]) / 914_400 * 96
      const displayHeight = Number(extent[2]) / 914_400 * 96
      if (metadata.width + 1 < displayWidth || metadata.height + 1 < displayHeight) {
        findings.push({ code: 'LOW_RES_IMAGE', severity: 'warning', message: `${basename(target)} is ${metadata.width}x${metadata.height} but displayed near ${Math.round(displayWidth)}x${Math.round(displayHeight)}`, page })
      }
      const sourceRatio = metadata.width / metadata.height
      const displayRatio = displayWidth / displayHeight
      if (!/<a:srcRect\b/u.test(block) && Math.abs(sourceRatio / displayRatio - 1) > 0.15) {
        findings.push({ code: 'STRETCHED_IMAGE', severity: 'error', message: `${basename(target)} aspect ratio does not match its uncropped display box`, page })
      }
    }
  }
  return findings
}

async function analyzePage(path: string, page: number, signal?: AbortSignal): Promise<{ metrics: Record<string, unknown>; findings: QualityFinding[] }> {
  throwIfAborted(signal)
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  throwIfAborted(signal)
  if (info.width !== 1280 || info.height !== 720) {
    return { metrics: { page, width: info.width, height: info.height }, findings: [{ code: 'RENDER_SIZE', severity: 'error', message: `rendered page is ${info.width}x${info.height}, expected 1280x720`, page }] }
  }
  const channels = info.channels
  const background = [data[0]!, data[1]!, data[2]!]
  let sum = 0; let sumSquares = 0; let changed = 0; let black = 0; let edgeChanged = 0; let edgePixels = 0
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * channels
      const r = data[offset]!; const g = data[offset + 1]!; const b = data[offset + 2]!
      const luminance = (r + g + b) / 3
      sum += luminance; sumSquares += luminance * luminance
      const differs = Math.abs(r - background[0]!) + Math.abs(g - background[1]!) + Math.abs(b - background[2]!) > 45
      if (differs) changed += 1
      if (luminance < 5) black += 1
      if (x < 4 || y < 4 || x >= info.width - 4 || y >= info.height - 4) { edgePixels += 1; if (differs) edgeChanged += 1 }
    }
  }
  const pixels = info.width * info.height
  const mean = sum / pixels
  const stdev = Math.sqrt(Math.max(0, sumSquares / pixels - mean * mean))
  const coverage = changed / pixels
  const blackRatio = black / pixels
  const edgeRatio = edgeChanged / edgePixels
  const findings: QualityFinding[] = []
  if (coverage < 0.005 || stdev < 1) findings.push({ code: 'BLANK_PAGE', severity: 'error', message: 'rendered page is blank or nearly uniform', page })
  if (blackRatio > 0.98) findings.push({ code: 'BLACK_PAGE', severity: 'error', message: 'rendered page is almost entirely black', page })
  if (edgeRatio > 0.12) findings.push({ code: 'EDGE_CONTENT', severity: 'warning', message: 'significant content touches the slide boundary', page })
  return { metrics: { page, width: info.width, height: info.height, mean, stdev, content_coverage: coverage, black_ratio: blackRatio, edge_ratio: edgeRatio }, findings }
}

async function compareImages(htmlPath: string, pptxPath: string, page: number, signal?: AbortSignal): Promise<{ metrics: Record<string, unknown>; findings: QualityFinding[] }> {
  throwIfAborted(signal)
  const left = await sharp(htmlPath).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const right = await sharp(pptxPath).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  throwIfAborted(signal)
  if (left.info.width !== right.info.width || left.info.height !== right.info.height || left.info.channels !== right.info.channels) {
    return { metrics: { page }, findings: [{ code: 'PREVIEW_DIMENSION_MISMATCH', severity: 'error', message: 'HTML and PPTX preview dimensions differ', page }] }
  }
  let total = 0; let gross = 0
  for (let index = 0; index < left.data.length; index += 1) {
    const delta = Math.abs(left.data[index]! - right.data[index]!)
    total += delta
    if (delta > 64) gross += 1
  }
  const meanAbsoluteDifference = total / left.data.length
  const grossDifferenceRatio = gross / left.data.length
  const findings: QualityFinding[] = []
  if (meanAbsoluteDifference > 45 || grossDifferenceRatio > 0.35) {
    findings.push({ code: 'LAYOUT_DRIFT', severity: 'error', message: `HTML/PPTX render drift is too large (MAD ${meanAbsoluteDifference.toFixed(1)}, gross ${(grossDifferenceRatio * 100).toFixed(1)}%)`, page })
  } else if (meanAbsoluteDifference > 25 || grossDifferenceRatio > 0.18) {
    findings.push({ code: 'LAYOUT_DRIFT_WARNING', severity: 'warning', message: 'HTML/PPTX render difference is elevated', page })
  }
  return { metrics: { page, mean_absolute_difference: meanAbsoluteDifference, gross_difference_ratio: grossDifferenceRatio }, findings }
}

interface TextRegion {
  page: number
  x: number
  y: number
  width: number
  height: number
}

function cjkTextRegions(data: Uint8Array, expectedPages: number): TextRegion[] {
  const files = unzipSync(data)
  const regions: TextRegion[] = []
  for (let page = 1; page <= expectedPages; page += 1) {
    const xml = strFromU8(files[`ppt/slides/slide${page}.xml`]!)
    for (const match of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)) {
      const block = match[0]
      const text = [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map(item => item[1]!).join('')
      if (!/[\u3400-\u9FFF\uF900-\uFAFF]/u.test(text)) continue
      const transform = /<a:xfrm\b[^>]*>[\s\S]*?<a:off\b[^>]*\bx="(\d+)"[^>]*\by="(\d+)"[^>]*\/>[\s\S]*?<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"[^>]*\/>/u.exec(block)
      if (transform === null) continue
      regions.push({
        page,
        x: Number(transform[1]) / 9_525,
        y: Number(transform[2]) / 9_525,
        width: Number(transform[3]) / 9_525,
        height: Number(transform[4]) / 9_525,
      })
    }
  }
  return regions
}

async function regionEdgeCount(path: string, region: TextRegion): Promise<number> {
  const left = Math.max(0, Math.min(1_279, Math.floor(region.x)))
  const top = Math.max(0, Math.min(719, Math.floor(region.y)))
  const width = Math.max(1, Math.min(1_280 - left, Math.ceil(region.width)))
  const height = Math.max(1, Math.min(720 - top, Math.ceil(region.height)))
  const { data, info } = await sharp(path).extract({ left, top, width, height }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let edges = 0
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const current = (y * width + x) * info.channels
      const right = current + info.channels
      const down = current + width * info.channels
      let delta = 0
      for (let channel = 0; channel < Math.min(3, info.channels); channel += 1) {
        delta += Math.abs(data[current + channel]! - data[right + channel]!)
        delta += Math.abs(data[current + channel]! - data[down + channel]!)
      }
      if (delta > 80) edges += 1
    }
  }
  return edges
}

async function cjkRenderFindings(
  pptx: Uint8Array,
  htmlPreviews: string[],
  pptxPreviews: string[],
  expectedPages: number,
  signal?: AbortSignal,
): Promise<QualityFinding[]> {
  const byPage = new Map<number, TextRegion[]>()
  for (const region of cjkTextRegions(pptx, expectedPages)) byPage.set(region.page, [...(byPage.get(region.page) ?? []), region])
  const findings: QualityFinding[] = []
  for (const [page, regions] of byPage) {
    throwIfAborted(signal)
    let htmlEdges = 0
    let renderedEdges = 0
    for (const region of regions) {
      htmlEdges += await regionEdgeCount(htmlPreviews[page - 1]!, region)
      renderedEdges += await regionEdgeCount(pptxPreviews[page - 1]!, region)
    }
    if (htmlEdges < 100) continue
    const ratio = renderedEdges / htmlEdges
    if (ratio < 0.45) {
      findings.push({ code: 'CJK_GLYPHS_MISSING', severity: 'error', message: `rendered CJK text edge coverage is only ${(ratio * 100).toFixed(1)}% of the HTML preview`, page })
    } else if (ratio < 0.65) {
      findings.push({ code: 'CJK_FONT_SUBSTITUTION', severity: 'warning', message: `rendered CJK text edge coverage is reduced to ${(ratio * 100).toFixed(1)}% of the HTML preview`, page })
    }
  }
  return findings
}

export class QualityRuntime {
  private readonly pptImage: PptImageRuntime

  constructor(
    subprocess: SubprocessRuntime | undefined,
    sandbox: SandboxProvider | undefined,
    resources: SessionResourceRegistry,
    executables: { soffice?: readonly string[]; pdftoppm?: readonly string[] } = {},
    fontDirs: readonly string[] = [],
    pptImage?: PptImageRuntime,
  ) {
    this.pptImage = pptImage ?? new PptImageRuntime(subprocess, sandbox, resources, executables, fontDirs)
  }

  async refresh(
    owner: SessionOwner,
    workspace: string,
    pptxPathInput: string,
    modelReviewAvailable: boolean,
    signal?: AbortSignal,
    nativeAutomationApproved = false,
  ): Promise<PptQualityReport | undefined> {
    throwIfAborted(signal)
    const pptxPath = await resolveWorkspacePath(workspace, pptxPathInput, { mustExist: true, kind: 'file' })
    const artifactRoot = dirname(pptxPath)
    const reportPath = join(artifactRoot, 'report.json')
    const visualReviewPath = join(artifactRoot, 'visual-review.json')
    let existing: PptQualityReport
    try {
      existing = JSON.parse(await readFile(reportPath, 'utf8')) as PptQualityReport
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (existing.version !== 1 || existing.machine_owned !== true || existing.pptx_path !== workspaceRelative(workspace, pptxPath)) {
      throw new PptError('PPT_QUALITY_FAILED', 'existing report.json is not the machine report for this PPTX')
    }
    const expectedPages = pptxPageCount(new Uint8Array(await readFile(pptxPath)))
    const htmlPreviews = Array.from({ length: expectedPages }, (_, index) =>
      workspaceRelative(workspace, join(artifactRoot, 'preview', `page-${String(index + 1).padStart(3, '0')}.png`)))
    await Promise.all(htmlPreviews.map(path => resolveWorkspacePath(workspace, path, { mustExist: true, kind: 'file' })))
    return this.evaluate(
      owner, workspace, workspaceRelative(workspace, pptxPath), htmlPreviews,
      workspaceRelative(workspace, reportPath), workspaceRelative(workspace, visualReviewPath),
      expectedPages, modelReviewAvailable, existing.conversion, signal, nativeAutomationApproved,
    )
  }

  async evaluate(
    owner: SessionOwner,
    workspace: string,
    pptxPathInput: string,
    htmlPreviewInputs: string[],
    reportPathInput: string,
    visualReviewPathInput: string,
    expectedPages: number,
    modelReviewAvailable: boolean,
    conversion?: Record<string, unknown>,
    signal?: AbortSignal,
    nativeAutomationApproved = false,
  ): Promise<PptQualityReport> {
    throwIfAborted(signal)
    expectedPages = boundedInteger(expectedPages, 'expectedPages', 1, DEFAULT_LIMITS.maxSlides)
    const pptxPath = await resolveWorkspacePath(workspace, pptxPathInput, { mustExist: true, kind: 'file' })
    const reportPath = await resolveWorkspacePath(workspace, reportPathInput)
    const visualReviewPath = await resolveWorkspacePath(workspace, visualReviewPathInput)
    const artifactRoot = dirname(pptxPath)
    let designPlan: ReturnType<typeof validateArtDirection> | undefined
    try {
      designPlan = validateArtDirection(JSON.parse(await readFile(join(artifactRoot, 'design-plan.json'), 'utf8')), expectedPages)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let htmlDesignValidation: { checks?: string[]; pages?: Array<Record<string, unknown>>; findings?: DesignFinding[] } = {}
    try {
      htmlDesignValidation = JSON.parse(await readFile(join(artifactRoot, 'design-validation.json'), 'utf8')) as typeof htmlDesignValidation
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const designFindings = [...(designPlan === undefined ? [] : artDirectionFindings(designPlan)), ...(htmlDesignValidation.findings ?? [])]
      .filter((finding, index, all) => all.findIndex(other => other.code === finding.code && other.page === finding.page) === index)
    const htmlPreviews = await Promise.all(htmlPreviewInputs.map(async path => workspaceRelative(workspace, await resolveWorkspacePath(workspace, path, { mustExist: true, kind: 'file' }))))
    const report: PptQualityReport = {
      version: 1, machine_owned: true, generated_at: new Date().toISOString(), pptx_path: workspaceRelative(workspace, pptxPath),
      structural_status: 'not_performed', render_status: 'not_performed', automatic_visual_status: 'not_performed',
      model_visual_status: modelReviewAvailable ? 'not_performed' : 'not_available', overall_status: 'unverified',
      layers: {
        structural: { status: 'not_performed', findings: [] }, render: { status: 'not_performed', findings: [] },
        automatic_visual: {
          status: 'not_performed', findings: [], pages: [], html_comparison_pages: [],
          design_fidelity: {
            mode: designPlan === undefined ? 'legacy' : 'directed',
            checks: designPlan === undefined ? [] : [
              'art-direction-schema', 'page-sequence', 'composition-rhythm', 'frame-budget', 'review-checklist',
              ...(htmlDesignValidation.checks ?? []),
            ],
            pages: htmlDesignValidation.pages ?? designPlan?.slides.map(slide => ({
              page: slide.page, composition: slide.composition, density: slide.density,
              background_role: slide.background_role, visual_anchor: slide.visual_anchor.kind, frame_policy: slide.frame_policy,
            })) ?? [],
            findings: designFindings,
          },
        },
        model_visual: { status: modelReviewAvailable ? 'not_performed' : 'not_available', findings: [] },
      },
      artifacts: { html_previews: htmlPreviews, pptx_previews: [], contact_sheets: [], high_risk_previews: [], visual_review: workspaceRelative(workspace, visualReviewPath) },
      ...(conversion === undefined ? {} : { conversion }),
    }
    try {
      const bytes = new Uint8Array(await readFile(pptxPath))
      report.layers.structural.findings = [
        ...structuralFindings(bytes, expectedPages),
        ...await imageQualityFindings(bytes, expectedPages, signal),
      ]
      report.layers.structural.status = report.layers.structural.findings.some(item => item.severity === 'error') ? 'failed' : 'passed'
    } catch (error) {
      report.layers.structural.status = 'failed'
      report.layers.structural.findings.push({ code: 'STRUCTURE_INVALID', severity: 'error', message: error instanceof Error ? error.message : String(error) })
    }

    const review: VisualReviewDocument = {
      version: 1, status: modelReviewAvailable ? 'not_performed' : 'not_available',
      checklist: [
        'Inspect every contact sheet for consistency and blank, black, duplicated, or missing pages.',
        'Inspect cover, agenda, data/chart, comparison, ending, and every machine-flagged page at full resolution.',
        'Check text clipping, overlap, hierarchy, alignment, contrast, image quality, stretched images, and font substitution.',
        'Record reviewed asset paths and page-specific findings; do not edit report.json directly.',
        ...(designPlan === undefined ? ['This deck has no design-plan.json; record that Art Direction fidelity could not be verified.'] : artDirectionReviewChecklist(designPlan).slice(0, 26)),
      ],
      reviewed_assets: [], findings: [],
    }

    const rendered = await this.pptImage.render(owner, workspace, workspaceRelative(workspace, pptxPath), {
      backend: 'auto', nativeAutomationApproved,
    }, signal)
    if (rendered.status === 'not_available') {
      report.layers.render.status = 'not_available'
      report.layers.render.findings.push({ code: 'RENDERER_NOT_AVAILABLE', severity: 'warning', message: rendered.attempts.map(attempt => `${attempt.backend}: ${attempt.message}`).join('; ') || 'no supported PPTX renderer was found' })
      report.layers.automatic_visual.status = 'not_available'
    } else if (rendered.status === 'failed') {
      report.layers.render.status = 'failed'
      report.layers.render.findings.push({ code: 'RENDER_FAILED', severity: 'error', message: rendered.attempts.map(attempt => `${attempt.backend}: ${attempt.message}`).join('; ') })
      report.layers.automatic_visual.status = 'not_performed'
    } else {
      report.layers.render.status = 'passed'
      report.layers.render.name = rendered.backend
      report.layers.render.version = rendered.backend_version
      report.artifacts.pptx_previews = rendered.image_paths
      report.artifacts.contact_sheets = rendered.contact_sheet_paths
      try {
        const analyses = await Promise.all(report.artifacts.pptx_previews.map((path, index) => analyzePage(join(workspace, path), index + 1, signal)))
        report.layers.automatic_visual.pages = analyses.map(item => item.metrics)
        const comparisons = await Promise.all(report.artifacts.pptx_previews.map((path, index) => compareImages(join(workspace, htmlPreviews[index]!), join(workspace, path), index + 1, signal)))
        const cjkFindings = await cjkRenderFindings(
          new Uint8Array(await readFile(pptxPath)),
          htmlPreviews.map(path => join(workspace, path)),
          report.artifacts.pptx_previews.map(path => join(workspace, path)),
          expectedPages,
          signal,
        )
        report.layers.automatic_visual.html_comparison_pages = comparisons.map(item => item.metrics)
        report.layers.automatic_visual.findings = [
          ...designFindings,
          ...analyses.flatMap(item => item.findings),
          ...comparisons.flatMap(item => item.findings),
          ...cjkFindings,
        ]
        report.layers.automatic_visual.status = report.layers.automatic_visual.findings.some(item => item.severity === 'error') ? 'failed' : 'passed'
        const risky = new Set<number>([
          ...report.layers.structural.findings.flatMap(item => item.page === undefined ? [] : [item.page]),
          ...report.layers.automatic_visual.findings.flatMap(item => item.page === undefined ? [] : [item.page]),
        ])
        for (const page of [...risky].sort((a, b) => a - b)) {
          throwIfAborted(signal)
          const source = join(workspace, report.artifacts.pptx_previews[page - 1]!)
          const target = join(artifactRoot, 'preview', `high-risk-page-${String(page).padStart(3, '0')}.png`)
          await copyFile(source, target)
          report.artifacts.high_risk_previews.push(workspaceRelative(workspace, target))
        }
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal)
        report.layers.automatic_visual.status = 'failed'
        report.layers.automatic_visual.findings.push({ code: 'AUTOMATIC_VISUAL_FAILED', severity: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
    synchronizeStatuses(report)
    await atomicWriteJson(visualReviewPath, review, { overwrite: true })
    await atomicWriteJson(reportPath, report, { overwrite: true })
    return report
  }
}

export async function applyVisualReview(workspace: string, reportPathInput: string, reviewPathInput: string): Promise<PptQualityReport> {
  const reportPath = await resolveWorkspacePath(workspace, reportPathInput, { mustExist: true, kind: 'file' })
  const reviewPath = await resolveWorkspacePath(workspace, reviewPathInput, { mustExist: true, kind: 'file' })
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as PptQualityReport
  const parsed = visualReviewSchema.safeParse(JSON.parse(await readFile(reviewPath, 'utf8')))
  if (!parsed.success) throw new PptError('PPT_QUALITY_FAILED', 'visual-review.json does not match the required schema', { details: parsed.error.flatten() })
  const review: VisualReviewDocument = parsed.data
  if (review.version !== 1 || !['passed', 'failed', 'not_available'].includes(review.status)) {
    throw new PptError('PPT_QUALITY_FAILED', 'visual-review.json has not been completed with a valid status')
  }
  if (review.status === 'passed' && review.reviewed_assets.length === 0) {
    throw new PptError('PPT_QUALITY_FAILED', 'a passed visual review must record reviewed asset paths')
  }
  if (review.status === 'passed' && review.findings.some(item => item.severity === 'error')) {
    throw new PptError('PPT_QUALITY_FAILED', 'a passed visual review cannot contain error findings')
  }
  const reviewedAssets = new Set<string>()
  for (const asset of review.reviewed_assets) {
    reviewedAssets.add(workspaceRelative(workspace, await resolveWorkspacePath(workspace, asset, { mustExist: true, kind: 'file' })))
  }
  if (review.status === 'passed') {
    const requiredAssets = [...report.artifacts.contact_sheets, ...report.artifacts.high_risk_previews]
    const missing = requiredAssets.filter(asset => !reviewedAssets.has(asset))
    if (missing.length > 0) {
      throw new PptError('PPT_QUALITY_FAILED', 'a passed visual review must cover every contact sheet and high-risk preview', { details: { missing } })
    }
  }
  report.layers.model_visual = {
    status: review.status === 'passed' ? 'passed' : review.status === 'failed' ? 'failed' : 'not_available',
    findings: review.findings.map(item => ({ code: 'MODEL_VISUAL_REVIEW', severity: item.severity, message: item.message, ...(item.page === undefined ? {} : { page: item.page }) })),
  }
  synchronizeStatuses(report)
  await atomicWriteJson(reportPath, report, { overwrite: true })
  return report
}
