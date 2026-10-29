import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { beforeEach, describe, expect, it } from 'vitest'
import { apply as applyTools } from '../../src/tools.ts'
import { createPptxFromOutline } from '../../src/pptx.ts'
import { writePptOutline } from '../../src/outline.ts'
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts'

const DECK = [
  {
    page: 1, type: 'cover', title: 'Quarterly review',
    content: [{ kind: 'point', text: 'Board deck' }],
    style: { layout: 'cover', background: 'dark', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Cover' },
  },
  {
    page: 2, type: 'content', title: 'Revenue',
    content: [{ kind: 'point', text: 'ARR grew 18%' }, { kind: 'note', purpose: 'speaker', text: 'Mention renewals' }],
    style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Body' },
  },
  {
    page: 3, type: 'content', title: 'Next steps',
    content: [{ kind: 'point', text: 'Hire two engineers' }],
    style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Body' },
  },
]

/**
 * Capture the tool definitions `apply` registers, with just enough of the
 * services the PPT tools touch. The audit path is inert here (schemas() is
 * empty), so this fixture cannot hide a bad deny list — the contract suite owns
 * that.
 */
function captureTools() {
  const definitions = new Map<string, { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }>()
  const ctx = {
    tools: {
      register(definition: { name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
      schemas: () => [],
      restrict() { throw new Error('the fixture registered no inherited tools, so no restriction is expected') },
    },
    on: () => () => undefined,
    effect(factory: () => Generator<() => void>) {
      const iterator = factory()
      const first = iterator.next()
      return () => (first.done ? undefined : first.value())
    },
    logger: { warn() {} },
    pptRuntime: {
      recordToolSurface() {},
      canReviewImages: async () => false,
      quality: { evaluateStructural: async () => ({}) },
      options: { fontDirs: [] },
    },
  }
  applyTools(ctx as never)
  return definitions
}

describe('ppt_update: per-page patch', () => {
  let workspace: TestWorkspace
  let dirRel: string
  let artifactDir: string
  let deckPath: string
  let outlinePath: string
  let tools: ReturnType<typeof captureTools>
  let exec: unknown

  const deckArg = () => `${dirRel}/deck.pptx`
  const outlineArg = () => `${dirRel}/outline.json`

  beforeEach(async () => {
    workspace = await createTestWorkspace('dsh-ppt-patch-')
    const outline = await writePptOutline(workspace.root, 'Patch deck', DECK as never)
    dirRel = outline.artifact_dir
    artifactDir = join(workspace.root, dirRel)
    deckPath = join(artifactDir, 'deck.pptx')
    outlinePath = join(artifactDir, 'outline.json')
    await createPptxFromOutline(workspace.root, outlineArg(), deckArg())
    tools = captureTools()
    exec = { agent: { id: 'patch-agent', session: { header: { cwd: workspace.root } } } }
  })

  async function editPage(page: number, title: string, point?: string) {
    const outline = JSON.parse(await readFile(outlinePath, 'utf8')) as Array<{ title: string; content: Array<Record<string, unknown>> }>
    const slide = outline[page - 1]!
    slide.title = title
    if (point !== undefined) {
      const target = slide.content.find(item => item.kind === 'point')
      if (target !== undefined) target.text = point
    }
    await writeFile(outlinePath, JSON.stringify(outline, null, 2))
  }

  function slides(bytes: Uint8Array): Map<string, string> {
    const files = unzipSync(bytes)
    const parts = new Map<string, string>()
    for (const [name, value] of Object.entries(files)) {
      if (/^ppt\/slides\/slide\d+\.xml$/u.test(name)) parts.set(name, strFromU8(value))
    }
    return parts
  }

  it('replaces only the named page and leaves every other page byte-identical', async () => {
    const before = await readFile(deckPath)
    const beforeParts = slides(new Uint8Array(before))

    await editPage(2, 'Revenue revised', 'ARR grew 22% after renewals')
    const update = tools.get('ppt_update')!
    const result = await update.execute({
      pptx_path: deckArg(), outline_path: outlineArg(), pages: [2],
    }, exec) as {
      mode: string; updated_pages: number[]; unchanged_pages: number[]; warnings: string[]
      report_status: string; patch_report_path: string; pptx_path: string
      media: { added: string[]; reused: number; pruned: string[] }
    }

    expect(result.mode).toBe('patch')
    expect(result.updated_pages).toEqual([2])
    expect(result.unchanged_pages).toEqual([1, 3])
    expect(result.warnings).toEqual([])
    expect(result.report_status).toBe('stale')
    expect(result.pptx_path).toBe(`${dirRel}/deck.pptx`)

    const afterParts = slides(new Uint8Array(await readFile(deckPath)))
    expect(afterParts.get('ppt/slides/slide1.xml')).toBe(beforeParts.get('ppt/slides/slide1.xml'))
    expect(afterParts.get('ppt/slides/slide3.xml')).toBe(beforeParts.get('ppt/slides/slide3.xml'))
    expect(afterParts.get('ppt/slides/slide2.xml')).not.toBe(beforeParts.get('ppt/slides/slide2.xml'))
    expect(afterParts.get('ppt/slides/slide2.xml')).toContain('Revenue revised')
    expect(afterParts.get('ppt/slides/slide2.xml')).toContain('22%')

    const record = JSON.parse(await readFile(join(artifactDir, 'deck-patch.json'), 'utf8')) as {
      mode: string; updated_pages: number[]; slide_digests: Array<{ page: number; before: string; after: string }>
    }
    expect(record.mode).toBe('patch')
    expect(record.updated_pages).toEqual([2])
    expect(record.slide_digests).toHaveLength(1)
    expect(record.slide_digests[0]!.before).not.toBe(record.slide_digests[0]!.after)
  })

  it('rebuilds the whole deck when the outline no longer matches the page count', async () => {
    const outline = JSON.parse(await readFile(outlinePath, 'utf8')) as unknown[]
    outline.push({
      page: 4, type: 'content', title: 'Appendix',
      content: [{ kind: 'point', text: 'Extra page' }],
      style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Body' },
    })
    await writeFile(outlinePath, JSON.stringify(outline, null, 2))

    const update = tools.get('ppt_update')!
    const result = await update.execute({
      pptx_path: deckArg(), outline_path: outlineArg(), pages: [4],
    }, exec) as { mode: string; page_count: number; warnings: string[]; report_status: string }

    expect(result.mode).toBe('full')
    expect(result.page_count).toBe(4)
    expect(result.warnings.join(' | ')).toContain('page(s)')
    expect(result.report_status).toBe('recomputed')
    expect(slides(new Uint8Array(await readFile(deckPath))).size).toBe(4)
  })

  it('rejects a page outside the deck instead of silently doing nothing', async () => {
    await editPage(2, 'Revenue revised')
    const update = tools.get('ppt_update')!
    await expect(update.execute({
      pptx_path: deckArg(), outline_path: outlineArg(), pages: [7],
    }, exec)).rejects.toMatchObject({ code: 'PPT_UPDATE_INPUT_INVALID' })
  })

  it('refuses svg_path without source=svg', async () => {
    const update = tools.get('ppt_update')!
    await expect(update.execute({
      pptx_path: deckArg(), outline_path: outlineArg(), pages: [1], svg_path: `${dirRel}/deck.svg`,
    }, exec)).rejects.toMatchObject({ code: 'PPT_UPDATE_INPUT_INVALID' })
  })
})
