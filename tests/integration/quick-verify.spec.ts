import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QualityRuntime, applyVisualReview } from '../../src/quality.ts'
import { writePptOutline } from '../../src/outline.ts'
import { createPptxFromOutline } from '../../src/pptx.ts'
import { SessionResourceRegistry } from '../../src/session-resources.ts'
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts'

const DECK = [
  {
    page: 1, type: 'cover', title: 'Verifiable',
    content: [{ kind: 'point', text: 'Fast lane decks still verify' }],
    style: { layout: 'cover', background: 'dark', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Cover' },
  },
  {
    page: 2, type: 'content', title: 'Two layers',
    content: [
      { kind: 'point', text: 'Structure is checked without a renderer' },
      { kind: 'point', text: 'Rendering is checked when asked for' },
      { kind: 'point', text: 'The model review closes the loop' },
    ],
    style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Body' },
  },
]

/** A renderer stub: the real one needs PowerPoint or LibreOffice on the host. */
function fakeRenderer(root: string, workspaceRoot: string) {
  // The report stores workspace-relative paths; the runtime rejoins them.
  const rel = (path: string): string => relative(workspaceRoot, path).split(sep).join('/')
  return {
    async render() {
      const previewDir = join(root, 'preview', 'pptx')
      await mkdir(previewDir, { recursive: true })
      const imagePaths: string[] = []
      for (const index of [1, 2]) {
        const path = join(previewDir, `slide-${String(index).padStart(3, '0')}.png`)
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
          <rect width="1280" height="720" fill="#F7F5F0"/>
          <rect x="72" y="80" width="420" height="44" fill="#111318"/>
          <rect x="72" y="180" width="900" height="18" fill="#111318"/>
          <rect x="72" y="220" width="820" height="18" fill="#111318"/>
          <rect x="72" y="260" width="600" height="18" fill="#111318"/>
          <rect x="72" y="320" width="120" height="6" fill="#2563EB"/>
        </svg>`
        await writeFile(path, await sharp(Buffer.from(svg)).png().toBuffer())
        imagePaths.push(rel(path))
      }
      const sheetPath = join(root, 'preview', 'contact-sheet-001.png')
      await writeFile(sheetPath, await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="360">
        <rect width="1280" height="360" fill="#F7F5F0"/>
        <rect x="40" y="40" width="560" height="280" fill="#111318"/>
        <rect x="680" y="40" width="560" height="280" fill="#111318"/>
      </svg>`)).png().toBuffer())
      return {
        status: 'passed' as const, backend: 'stub', backend_version: '1',
        image_paths: imagePaths, contact_sheet_paths: [rel(sheetPath)], attempts: [],
      }
    },
  }
}

describe('fast lane: verification is opt-in, not blocked', () => {
  let workspace: TestWorkspace
  let resources: SessionResourceRegistry

  beforeEach(async () => {
    workspace = await createTestWorkspace('dsh-ppt-quick-verify-')
    resources = new SessionResourceRegistry()
  })

  afterEach(async () => {
    await resources.dispose()
    await workspace.cleanup()
  })

  it('refreshes a fast-lane report without HTML previews and can still reach verified', async () => {
    const outline = await writePptOutline(workspace.root, 'verifiable', DECK)
    const root = join(workspace.root, outline.artifact_dir)
    const deck = await createPptxFromOutline(workspace.root, outline.outline_path, join(outline.artifact_dir, 'deck.pptx'))
    const stub = fakeRenderer(root, workspace.root) as unknown as ConstructorParameters<typeof QualityRuntime>[5]
    const quality = new QualityRuntime(undefined, undefined, resources, {}, [], stub)

    const structural = await quality.evaluateStructural(
      workspace.root, deck.pptx_path, join(outline.artifact_dir, 'report.json'),
      join(outline.artifact_dir, 'visual-review.json'), deck.page_count, true,
    )
    expect(structural.overall_status).toBe('unverified')

    // The refresh must not fail on the missing page-for-page HTML previews.
    const refreshed = await quality.refresh({ agentId: 'verify-agent', sessionId: 'verify-session' }, workspace.root, deck.pptx_path, true)
    expect(refreshed?.render_status).toBe('passed')
    expect(refreshed?.automatic_visual_status).toBe('passed')
    expect(refreshed?.artifacts.html_previews).toEqual([])
    expect(refreshed?.artifacts.contact_sheets).toHaveLength(1)
    expect(refreshed?.overall_status).toBe('unverified')

    const review = {
      version: 1,
      status: 'passed',
      checklist: ['contact sheet reviewed'],
      reviewed_assets: refreshed!.artifacts.contact_sheets,
      findings: [],
    }
    await writeFile(join(root, 'visual-review.json'), JSON.stringify(review))
    const final = await applyVisualReview(workspace.root, join(root, 'report.json'), join(root, 'visual-review.json'))
    expect(final.model_visual_status).toBe('passed')
    expect(final.overall_status).toBe('verified')
    const saved = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as { overall_status: string }
    expect(saved.overall_status).toBe('verified')
  })
})
