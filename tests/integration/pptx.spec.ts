import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserRuntime } from '../../src/browser.ts'
import { discoverBrowserExecutable } from '../../src/browser-discovery.ts'
import { createHtmlDeck } from '../../src/html.ts'
import { writePptOutline } from '../../src/outline.ts'
import { createPptx, inspectPptxPackage } from '../../src/pptx.ts'
import { SessionResourceRegistry } from '../../src/session-resources.ts'
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts'

const owner = { agentId: 'pptx-agent', sessionId: 'pptx-session' }

describe('editable PPTX generation', () => {
  let workspace: TestWorkspace
  let resources: SessionResourceRegistry
  let browser: BrowserRuntime

  beforeEach(async () => {
    workspace = await createTestWorkspace('dsh-ppt-pptx-')
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

  async function makeOutline(title: string) {
    return writePptOutline(workspace.root, title, [{
      page: 1, type: 'content', title, content: [
        { kind: 'point', text: 'Editable native objects' },
        { kind: 'note', purpose: 'speaker', text: 'Speaker note survives' },
        { kind: 'note', purpose: 'production', text: 'Production note must stay internal' },
      ],
      style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Layered objects' },
    }])
  }

  it('extracts deterministic IR and writes editable text, shape, image, SVG, table, crop, z-order, and speaker notes', async () => {
    const outline = await makeOutline('Editable deck')
    const root = join(workspace.root, outline.artifact_dir)
    const imagePath = join(root, 'assets', 'images', 'photo.png')
    await writeFile(imagePath, await sharp({ create: { width: 320, height: 180, channels: 4, background: '#6699CC' } }).png().toBuffer())
    const source = `<!doctype html><html><head><style>
      html,body{margin:0;padding:0}.ppt-slide{width:1280px;height:720px;position:relative;overflow:hidden;font-family:Liter;background:#FFFFFF;color:#111111}
      .title{position:absolute;left:60px;top:40px;width:900px;height:70px;margin:0;font-size:48px;line-height:1.1}
      .shape{position:absolute;left:60px;top:150px;width:180px;height:90px;background:#2563EB;border-radius:18px}
      .photo{position:absolute;left:280px;top:140px;width:300px;height:190px;object-fit:cover;object-position:center}
      .icon{position:absolute;left:620px;top:150px;width:120px;height:120px}
      .table{position:absolute;left:60px;top:380px;width:680px;height:180px;font-size:20px;line-height:1.2;border:1px solid #999999;background:#FFFFFF;color:#111111}
      td{padding:6px;border:1px solid #999999}</style></head><body><section class="ppt-slide" data-page="1">
      <h1 class="title" data-ppt-id="title" data-ppt-kind="text" data-ppt-z="1">Editable <span style="font-weight:700">Native</span></h1>
      <div class="shape" data-ppt-id="accent-shape" data-ppt-kind="shape" data-ppt-z="2"></div>
      <img class="photo" data-ppt-id="photo" data-ppt-kind="image" data-ppt-z="3" src="assets/images/photo.png">
      <svg class="icon" data-ppt-id="icon" data-ppt-kind="svg" data-ppt-z="4" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#F97316"/></svg>
      <table class="table" data-ppt-id="data-table" data-ppt-kind="table" data-ppt-z="5"><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>
      </section></body></html>`
    await createHtmlDeck(browser, owner, workspace.root, outline.outline_path, source)
    const ir = await browser.extractDeckIr(owner, workspace.root, `${outline.artifact_dir}/deck.html`, 1)
    expect(ir.slides[0]?.elements.map(item => [item.id, item.box.x, item.box.y])).toEqual([
      ['title', 60, 40], ['accent-shape', 60, 150], ['photo', 280, 140], ['icon', 620, 150], ['data-table', 60, 380],
    ])
    const result = await createPptx(
      browser, owner, workspace.root, `${outline.artifact_dir}/deck.html`, outline.outline_path, `${outline.artifact_dir}/deck.pptx`, 'reject',
    )
    expect(result).toMatchObject({ page_count: 1, native_element_count: 5, rasterized_elements: [], structural_status: 'passed' })
    const bytes = new Uint8Array(await readFile(join(workspace.root, result.pptx_path)))
    expect(inspectPptxPackage(bytes, 1)).toMatchObject({ pageCount: 1, widthEmu: 12_192_000, heightEmu: 6_858_000 })
    const files = unzipSync(bytes)
    const slideXml = strFromU8(files['ppt/slides/slide1.xml']!)
    expect(slideXml).toContain('<a:tbl>')
    expect(slideXml).toContain('<p:pic>')
    expect(slideXml).toContain('<a:srcRect')
    expect(slideXml).toContain('<a:off x="571500" y="381000"/>')
    expect(slideXml.indexOf('title')).toBeLessThan(slideXml.indexOf('accent-shape'))
    expect(slideXml.indexOf('accent-shape')).toBeLessThan(slideXml.indexOf('photo'))
    const allXml = Object.entries(files).filter(([name]) => name.endsWith('.xml')).map(([, data]) => strFromU8(data)).join('\n')
    expect(allXml).toContain('Speaker note survives')
    expect(allXml).not.toContain('Production note must stay internal')
  })

  it('rejects unsupported leaves by default and rasterizes only the authorized element', async () => {
    const outline = await makeOutline('Fallback deck')
    const source = `<!doctype html><html><head><style>html,body{margin:0}.ppt-slide{width:1280px;height:720px;position:relative;overflow:hidden;font-family:Liter}.complex{position:absolute;left:100px;top:100px;width:240px;height:180px}</style></head><body>
      <section class="ppt-slide" data-page="1"><svg class="complex" data-ppt-id="complex" data-ppt-kind="svg" viewBox="0 0 100 100"><filter id="blur"><feGaussianBlur stdDeviation="3"/></filter><rect width="100" height="100" fill="#2563EB" filter="url(#blur)"/></svg></section>
      </body></html>`
    await createHtmlDeck(browser, owner, workspace.root, outline.outline_path, source)
    const output = `${outline.artifact_dir}/deck.pptx`
    await expect(createPptx(browser, owner, workspace.root, `${outline.artifact_dir}/deck.html`, outline.outline_path, output, 'reject'))
      .rejects.toMatchObject({ code: 'PPT_CREATE_UNSUPPORTED_ELEMENT' })
    await expect(access(join(workspace.root, output))).rejects.toBeTruthy()
    const result = await createPptx(browser, owner, workspace.root, `${outline.artifact_dir}/deck.html`, outline.outline_path, output, 'rasterize-element')
    expect(result.rasterized_elements).toEqual([expect.objectContaining({ page: 1, element_id: 'complex', reason: 'complex SVG feature' })])
  })

  it('rejects missing assets and leaves no PPTX on cancellation', async () => {
    const outline = await makeOutline('Missing asset')
    const root = join(workspace.root, outline.artifact_dir)
    const imagePath = join(root, 'assets', 'images', 'soon-missing.png')
    await writeFile(imagePath, await sharp({ create: { width: 10, height: 10, channels: 4, background: '#000' } }).png().toBuffer())
    const source = `<!doctype html><html><head><style>html,body{margin:0}.ppt-slide{width:1280px;height:720px;position:relative;overflow:hidden;font-family:Liter}.i{position:absolute;left:0;top:0;width:100px;height:100px;object-fit:contain}</style></head><body><section class="ppt-slide" data-page="1"><img class="i" src="assets/images/soon-missing.png" data-ppt-id="i" data-ppt-kind="image"></section></body></html>`
    await createHtmlDeck(browser, owner, workspace.root, outline.outline_path, source)
    await rm(imagePath)
    const output = `${outline.artifact_dir}/deck.pptx`
    await expect(createPptx(browser, owner, workspace.root, `${outline.artifact_dir}/deck.html`, outline.outline_path, output))
      .rejects.toMatchObject({ code: 'PPT_CREATE_ASSET_MISSING' })
    const controller = new AbortController(); controller.abort('user cancelled')
    await expect(createPptx(browser, owner, workspace.root, `${outline.artifact_dir}/deck.html`, outline.outline_path, output, 'reject', controller.signal))
      .rejects.toMatchObject({ code: 'PPT_CREATE_ABORTED' })
    await expect(access(join(workspace.root, output))).rejects.toBeTruthy()
  })
})
