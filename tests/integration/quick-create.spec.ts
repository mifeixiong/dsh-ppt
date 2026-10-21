import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QualityRuntime } from '../../src/quality.ts'
import { writePptOutline } from '../../src/outline.ts'
import { createPptxFromOutline, inspectPptxPackage } from '../../src/pptx.ts'
import { SessionResourceRegistry } from '../../src/session-resources.ts'
import { PptError } from '../../src/errors.ts'
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts'

const DECK = [
  {
    page: 1, type: 'cover', title: 'Fast lane',
    content: [{ kind: 'point', text: 'Outline in, deck out' }],
    style: { layout: 'cover', background: 'dark', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Cover' },
  },
  {
    page: 2, type: 'content', title: 'Two calls',
    content: [
      { kind: 'point', text: 'ppt_outline writes the content model' },
      { kind: 'point', text: 'ppt_create lays it out and writes the PPTX' },
      { kind: 'point', text: 'Speaker note survives', label: 'Note' },
      { kind: 'note', purpose: 'speaker', text: 'Say this out loud' },
    ],
    style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Body' },
  },
  {
    page: 3, type: 'data', title: 'Cost',
    content: [
      { kind: 'data', label: 'Calls', value: 2, unit: 'calls' },
      { kind: 'data', label: 'Renders', value: 0, unit: 'runs' },
      { kind: 'data', label: 'Seconds', value: 1, unit: 'sec' },
    ],
    style: { layout: 'grid', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Data' },
  },
]

describe('fast lane: outline to PPTX', () => {
  let workspace: TestWorkspace
  let resources: SessionResourceRegistry

  beforeEach(async () => {
    workspace = await createTestWorkspace('dsh-ppt-quick-')
    resources = new SessionResourceRegistry()
  })

  afterEach(async () => {
    await resources.dispose()
    await workspace.cleanup()
  })

  it('writes a valid, editable PPTX straight from outline.json without HTML or a browser', async () => {
    const outline = await writePptOutline(workspace.root, 'fast lane', DECK)
    const output = join(outline.artifact_dir, 'deck.pptx')
    const result = await createPptxFromOutline(workspace.root, outline.outline_path, output)
    expect(result.page_count).toBe(DECK.length)
    expect(result.rasterized_elements).toEqual([])
    expect(result.native_element_count).toBeGreaterThan(10)
    const bytes = new Uint8Array(await readFile(join(workspace.root, output)))
    const packageInspection = inspectPptxPackage(bytes, DECK.length)
    expect(packageInspection.pageCount).toBe(DECK.length)
    expect(packageInspection.entries).toContain('ppt/slides/slide3.xml')
    // Every page survives as native shapes: no full-page raster fallback.
    expect(packageInspection.entries.filter(name => name.startsWith('ppt/media/') && !name.endsWith('/'))).toEqual([])
  })

  it('records structural quality and leaves the render layers unverified', async () => {
    const outline = await writePptOutline(workspace.root, 'fast lane', DECK)
    const output = join(outline.artifact_dir, 'deck.pptx')
    const result = await createPptxFromOutline(workspace.root, outline.outline_path, output)
    const quality = new QualityRuntime(undefined, undefined, resources)
    const report = await quality.evaluateStructural(
      workspace.root, result.pptx_path, join(outline.artifact_dir, 'report.json'),
      join(outline.artifact_dir, 'visual-review.json'), result.page_count, true,
      { page_count: result.page_count, source: 'outline-fast-lane' },
    )
    expect(report.structural_status).toBe('passed')
    expect(report.render_status).toBe('not_performed')
    expect(report.overall_status).toBe('unverified')
    expect(report.artifacts.html_previews).toEqual([])
    expect(report.layers.structural.findings.filter(item => item.severity === 'error')).toEqual([])
    const saved = JSON.parse(await readFile(join(workspace.root, outline.artifact_dir, 'report.json'), 'utf8')) as { overall_status: string }
    expect(saved.overall_status).toBe('unverified')
  })

  it('refuses a page whose frozen image asset is not there', async () => {
    const outline = await writePptOutline(workspace.root, 'missing asset', [{
      page: 1, type: 'content', title: 'Hero',
      content: [{ kind: 'image', role: 'supporting', intent: 'A missing photo', asset: 'assets/images/missing.png' }],
      style: { layout: 'image-right', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Media' },
    }])
    await expect(createPptxFromOutline(workspace.root, outline.outline_path, join(outline.artifact_dir, 'deck.pptx')))
      .rejects.toBeInstanceOf(PptError)
    await expect(createPptxFromOutline(workspace.root, outline.outline_path, join(outline.artifact_dir, 'deck.pptx')))
      .rejects.toMatchObject({ code: 'PPT_CREATE_ASSET_MISSING' })
  })

  it('keeps the artifact directory contract: the deck lands next to its outline', async () => {
    const outline = await writePptOutline(workspace.root, 'artifact contract', DECK, 'ppt-output')
    await expect(createPptxFromOutline(workspace.root, outline.outline_path, 'elsewhere/deck.pptx'))
      .rejects.toMatchObject({ code: 'PPT_CREATE_INPUT_INVALID' })
  })
})
