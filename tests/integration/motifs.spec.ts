import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserRuntime } from '../../src/browser.ts'
import { discoverBrowserExecutable } from '../../src/browser-discovery.ts'
import { createHtmlDeck } from '../../src/html.ts'
import { renderMotif } from '../../src/motifs.ts'
import { writePptOutline } from '../../src/outline.ts'
import { createPptx } from '../../src/pptx.ts'
import { SessionResourceRegistry } from '../../src/session-resources.ts'
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts'

const owner = { agentId: 'motif-agent', sessionId: 'motif-session' }

describe('generative motif through the deck pipeline', () => {
  let workspace: TestWorkspace
  let resources: SessionResourceRegistry
  let browser: BrowserRuntime

  beforeEach(async () => {
    workspace = await createTestWorkspace('dsh-ppt-motif-')
    resources = new SessionResourceRegistry()
    const found = await discoverBrowserExecutable()
    if (found.executable === undefined) throw new Error('Chrome/Chromium is required')
    browser = new BrowserRuntime(resources, found.executable)
  })

  afterEach(async () => {
    await browser.dispose()
    await resources.dispose()
    await workspace.cleanup()
  })

  it('accepts a theme motif SVG as a leaf and exports it as a picture', async () => {
    const outline = await writePptOutline(workspace.root, 'Motif deck', [{
      page: 1, type: 'content', title: 'Motif', content: [{ kind: 'point', text: 'Generated decoration' }],
      style: { layout: 'title-content', background: 'light', accent: '#0B57D0', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Generated motif' },
    }])
    const motif = renderMotif('square-grid', { ink: '#111827', accent: '#0B57D0' })
      .replace('<svg ', '<svg data-ppt-id="motif" data-ppt-kind="svg" style="position:absolute;left:0;top:360px;width:640px;height:360px" ')
    const source = `<!doctype html><html><head><style>
      html,body{margin:0}.ppt-slide{width:1280px;height:720px;position:relative;overflow:hidden;font-family:Liter;background:#fff;color:#111}
      .title{position:absolute;left:80px;top:80px;width:800px;height:90px;margin:0;font-size:52px;line-height:1.1}
      </style></head><body><section class="ppt-slide" data-page="1">
      ${motif}
      <h1 class="title" data-ppt-id="title" data-ppt-kind="text">Motif</h1>
      </section></body></html>`
    const created = await createHtmlDeck(browser, owner, workspace.root, outline.outline_path, source)
    expect(created.preview_paths).toHaveLength(1)
    const result = await createPptx(browser, owner, workspace.root, created.html_path, outline.outline_path, `${outline.artifact_dir}/deck.pptx`, 'reject')
    expect(result).toMatchObject({ page_count: 1, native_element_count: 2, structural_status: 'passed' })
    const files = unzipSync(new Uint8Array(await readFile(join(workspace.root, result.pptx_path))))
    const slideXml = strFromU8(files['ppt/slides/slide1.xml']!)
    expect(slideXml).toContain('<p:pic>')
    expect(Object.keys(files).some(name => name.startsWith('ppt/media/'))).toBe(true)
  })
})
